/**
 * A send in a restricted Channel (CORD-03 §1, Vector `send_group`), driven through
 * `useSendMessage` over the Vector writers fixture: a writer's post goes out at the
 * live writer address carrying its epoch and certificate, a reaction stays at the
 * read address, and a member who isn't a writer is refused before anything is sent.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { openChatBatch } from "@/concord/lib/chat";
import { channelsView } from "@/concord/lib/community";
import { foldControlState, openControlWraps, type FoldedControl } from "@/concord/lib/control";
import { accessPlane, parseDelivery, type ParsedDelivery } from "@/concord/lib/delivery";
import { controlGroupKey, hex32 } from "@/concord/lib/derive";
import { KIND_REACTION } from "@/concord/lib/kinds";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { adoptWriterDeliveries, writerKeysReady } from "@/concord/lib/writerKeys";

import actors from "@/concord/lib/fixtures/cord25/writers.actors.json";
import fixture from "@/concord/lib/fixtures/cord25/writers.json";

const h = vi.hoisted(() => ({
  published: [] as NostrEvent[],
  user: undefined as unknown,
  folded: undefined as unknown,
  timeouts: new Map<string, unknown>(),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        event: async (ev: NostrEvent) => void h.published.push(ev),
        query: async () => [],
      }),
    },
  }),
}));
vi.mock("@/hooks/useAccountSecret", () => ({ useAccountSecret: () => undefined }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: h.folded }),
  useDissolved: () => ({ data: null }),
}));
vi.mock("@/concord/hooks/useGuestbook", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useGuestbook")>()),
  // As the real hook: nothing is read for an undefined community.
  useGuestbook: (cm: unknown) => ({ history: undefined, timeouts: cm ? h.timeouts : new Map(), nicknames: new Map(), coalesced: new Map(), data: [] }),
}));

const { useSendMessage } = await import("@/concord/hooks/useChannel");

const c = fixture.community;
const community = {
  id: hex32(c.id),
  idHex: c.id,
  owner: c.owner,
  root: hex32(c.root),
  rootEpoch: BigInt(c.root_epoch),
  heldRoots: [{ epoch: BigInt(c.root_epoch), key: hex32(c.root) }],
  privateChannels: [],
  relays: ["wss://r.test"],
  name: "",
  ownerSalt: new Uint8Array(32),
} as Community;
const events = fixture.events as unknown as NostrEvent[];
const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
const folded: FoldedControl = foldControlState(openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]), hex32(c.id), c.owner);
const general = channelsView(community, folded).find((ch) => ch.idHex === actors.general)!;
const writerPk = general.streams.find((st) => st.writer && st.writer.to === undefined)!.group.pk;

function userOf(sk: Uint8Array) {
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    method: "nsec",
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {
        encrypt: async (pk: string, p: string) => nip44Encrypt(p, getConversationKey(sk, pk)),
        decrypt: async (pk: string, p: string) => nip44Decrypt(p, getConversationKey(sk, pk)),
      },
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

beforeAll(async () => {
  h.folded = folded;
  await writerKeysReady();
  const memberSk = hex32(actors.member_secret);
  const plane = accessPlane(community, hex32(actors.general));
  const deliveries = events.filter((e) => e.pubkey === plane.pk).map((e) => parseDelivery(openWrap(e, plane))).filter((d): d is ParsedDelivery => d !== undefined);
  await adoptWriterDeliveries(deliveries, folded, community.id, actors.general, actors.member, async (pk, w) => nip44Decrypt(w, getConversationKey(memberSk, pk)));
});

describe("sending in a restricted Channel", () => {
  it("posts a writer's message at the live writer address, with its epoch and certificate", async () => {
    h.user = userOf(hex32(actors.member_secret));
    h.published = [];
    const { result } = renderHook(() => useSendMessage(community, general), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ content: "sent from Armada" });
    });
    const wrap = h.published.find((e) => e.kind === 1059)!;
    expect(wrap.pubkey).toBe(writerPk);
    const [opened] = await openChatBatch([wrap], general, { remember: false });
    expect(opened.content).toBe("sent from Armada");
    expect(opened.tags).toContainEqual(["wepoch", String(actors.writer_epoch)]);
    expect(opened.tags).toContainEqual(["wcert", actors.writer_cert]);
  });

  it("keeps a writer's reaction at the read address", async () => {
    h.user = userOf(hex32(actors.member_secret));
    h.published = [];
    const { result } = renderHook(() => useSendMessage(community, general), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ content: "+", kind: KIND_REACTION, target: "ab".repeat(32), targetPubkey: actors.owner });
    });
    expect(h.published.find((e) => e.kind === 1059)?.pubkey).toBe(general.current.group.pk);
  });

  it("refuses a member who isn't one of its writers, sending nothing (Send Messages first, as Vector checks)", async () => {
    h.user = userOf(generateSecretKey());
    h.published = [];
    const { result } = renderHook(() => useSendMessage(community, general), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ content: "not mine to post" })).rejects.toThrow(/can.t send messages/);
    });
    expect(h.published).toEqual([]);
  });
});

describe("sending while timed out (CORD-04 §8, Vector `refuse_while_timed_out`)", () => {
  it("refuses a message, a reaction and an edit before anything is sent, and lets a delete through", async () => {
    h.user = userOf(hex32(actors.member_secret));
    const nowSecs = Math.floor(Date.now() / 1000);
    h.timeouts = new Map([[actors.member, { by: c.owner, fromSecs: nowSecs - 60, until: nowSecs + 3600, ms: (nowSecs - 60) * 1000, rumorId: "ab".repeat(32) }]]);
    try {
      const { result } = renderHook(() => useSendMessage(community, general), { wrapper });
      for (const send of [
        { content: "still here" },
        { content: "+", kind: KIND_REACTION, target: "cd".repeat(32), targetPubkey: c.owner },
        { content: "edited", kind: 3302, target: "cd".repeat(32) },
      ]) {
        h.published = [];
        await act(async () => {
          await expect(result.current.mutateAsync(send)).rejects.toThrow(/timed out/);
        });
        expect(h.published, String(send.kind ?? 9)).toEqual([]);
      }
      h.published = [];
      await act(async () => {
        await result.current.mutateAsync({ content: "", kind: 5, target: "cd".repeat(32) });
      });
      expect(h.published.length).toBeGreaterThan(0);
    } finally {
      h.timeouts = new Map();
    }
  });

  it("refuses a timed-out member's message in a legacy-roster community too", async () => {
    h.user = userOf(hex32(actors.member_secret));
    const nowSecs = Math.floor(Date.now() / 1000);
    h.timeouts = new Map([[actors.member, { by: c.owner, fromSecs: nowSecs - 60, until: nowSecs + 3600, ms: (nowSecs - 60) * 1000, rumorId: "ab".repeat(32) }]]);
    const { rankedRoster: _ranked, ...legacy } = folded;
    h.folded = legacy;
    try {
      h.published = [];
      const { result } = renderHook(() => useSendMessage(community, general), { wrapper });
      let error: unknown;
      await act(async () => {
        await result.current.mutateAsync({ content: "still here" }).catch((e: unknown) => void (error = e));
      });
      expect(String(error)).toMatch(/timed out/);
      expect(h.published).toEqual([]);
    } finally {
      h.timeouts = new Map();
      h.folded = folded;
    }
  });
});
