/**
 * A Refounding's duties and a Severing Refounding's adoption, against CORD-04
 * §8/§10 and CORD-06 §3 at concord#25 and Vector v0.5.0-3: the hooks run against
 * a store of real sealed editions, and every event they publish is captured and
 * opened. `it.fails` marks what Armada still gets wrong.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { foldControlState, openControlEditions, type FoldedControl } from "@/concord/lib/control";
import { baseRekeyGroupKey, bytesToHex, controlGroupKey, controlSignerGroupKey, epochKeyCommitment, guestbookGroupKey, random32, syncLocator } from "@/concord/lib/derive";
import { buildNicknameRumor, buildTimeoutRumor } from "@/concord/lib/guestbook";
import type { InviteListEntry } from "@/concord/lib/invite";
import { KIND_NICKNAME, KIND_SEAL_ENCRYPTED, KIND_TIMEOUT } from "@/concord/lib/kinds";
import { buildRekeyRumors, bytesToBase64, encodeWrappedBaseKey, myLocator } from "@/concord/lib/rekey";
import { buildRumor, openWrap, sealRumor, wrapSeal, type OpenedEvent } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { heldCommunity, hexKey, sealedEdition, TestCommunity } from "@/test/concordEditions";

const env = vi.hoisted(() => ({
  folded: undefined as FoldedControl | undefined,
  user: undefined as unknown,
  relayEvents: [] as NostrEvent[],
  sent: [] as NostrEvent[],
  control: [] as OpenedEvent[],
  guestbook: [] as OpenedEvent[],
  newRoot: new Uint8Array(32) as Uint8Array,
  newControlRoot: new Uint8Array(32) as Uint8Array,
  entry: undefined as unknown,
  links: [] as InviteListEntry[],
  refreshed: [] as InviteListEntry[][],
  listWrites: [] as unknown[],
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async ([f]: Array<{ authors?: string[] }>) => env.relayEvents.filter((e) => !f.authors || f.authors.includes(e.pubkey)),
        event: async (e: NostrEvent) => {
          env.sent.push(e);
        },
      }),
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: env.user }) }));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: env.folded, isLoading: false, isFetching: false }),
  useDissolved: () => ({ data: undefined }),
}));
vi.mock("@/concord/hooks/useCommunityList", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useCommunityList")>()),
  useUpdateCommunityList: () => ({
    mutateAsync: async (a: unknown) => {
      env.listWrites.push(a);
    },
  }),
  useCommunityEntry: () => env.entry,
}));
vi.mock("@/concord/hooks/useInvites", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useInvites")>()),
  fetchInviteList: async () => ({ list: { entries: env.links, tombstones: [] } }),
}));
vi.mock("@/concord/lib/invite", async (orig) => {
  const real = await orig<typeof import("@/concord/lib/invite")>();
  return {
    ...real,
    buildRefreshedBundleEvents: async (_bundle: unknown, live: InviteListEntry[]) => {
      env.refreshed.push(live);
      return [];
    },
  };
});
vi.mock("@/concord/lib/planeSync", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/planeSync")>()),
  sweepControl: async (_n: unknown, _c: unknown, opts: { onReached?: () => void }) => {
    opts.onReached?.();
  },
}));
vi.mock("@/concord/lib/rumorStore", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rumorStore")>()),
  queryPlane: async (_id: string, plane: string) => (plane === "control" ? env.control : plane === "guestbook" ? env.guestbook : []),
  readControlSnapshot: async () => undefined,
  readStoredSeal: async () => undefined,
  queryRekeyRounds: async () => [],
  readStreamCursor: async () => undefined,
  updateStreamCursor: async () => undefined,
  writeOpened: () => undefined,
}));
vi.mock("@/concord/lib/rekey", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rekey")>()),
  mintOrReuseRotationKey: async (_id: string, scope: { kind: string }) => (scope.kind === "root" ? env.newRoot : random32()),
  mintOrReuseControlRoot: async () => env.newControlRoot,
}));

const { useRefound, useRekeyWatch } = await import("@/concord/hooks/useRekey");

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

function userOf(sk: Uint8Array) {
  return {
    pubkey: getPublicKey(sk),
    signer: {
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {
        encrypt: async (pk: string, plain: string) => nip44Encrypt(plain, getConversationKey(sk, pk)),
        decrypt: async (pk: string, payload: string) => nip44Decrypt(payload, getConversationKey(sk, pk)),
      },
    },
  };
}

function opened(rumor: { id: string; pubkey: string; kind: number; content: string; tags: string[][]; created_at: number }, ms: number): OpenedEvent {
  return { rumorId: rumor.id, author: rumor.pubkey, kind: rumor.kind, content: rumor.content, tags: rumor.tags, ms, createdAt: rumor.created_at };
}

beforeEach(() => {
  env.relayEvents = [];
  env.sent = [];
  env.refreshed = [];
  env.listWrites = [];
  env.links = [];
  env.newRoot = random32();
  env.newControlRoot = random32();
});

describe("a Refounding's duties", () => {
  /** The owner's Community: a Channel synced to a Category and then unsynced, a running Timeout, a Nickname the owner set. */
  function setup() {
    const ownerSk = generateSecretKey();
    const owner = getPublicKey(ownerSk);
    const c = new TestCommunity(owner);
    const member = getPublicKey(generateSecretKey());
    const ch = hexKey();
    const cat = hexKey();
    const everyone = sealedEdition(c, ownerSk, { vsk: "13", eid: c.everyoneHex, content: { permissions: "1" } });
    const channel = sealedEdition(c, ownerSk, { vsk: "2", eid: ch, content: { name: "general", private: false } });
    const category = sealedEdition(c, ownerSk, { vsk: "15", eid: cat, content: { name: "Text", position: "a" } });
    const syncEid = bytesToHex(syncLocator(c.id, hexToBytes(ch)));
    const sync1 = sealedEdition(c, ownerSk, { vsk: "17", eid: syncEid, content: { channel: ch, sync: cat } });
    const sync2 = sealedEdition(c, ownerSk, { vsk: "17", eid: syncEid, prev: sync1, content: { channel: ch } });
    env.control = [everyone, channel, category, sync1, sync2];
    env.folded = foldControlState(openControlEditions(env.control), c.id, owner);
    const now = Date.now();
    env.guestbook = [
      opened(buildTimeoutRumor(owner, member, Math.floor(now / 1000) + 3600, now - 60_000), now - 60_000),
      opened(buildNicknameRumor(owner, member, "Newbie", now - 120_000), now - 120_000),
    ];
    const community: Community = heldCommunity(c);
    env.entry = { added_at: 1, current: { root_epoch: 0, channels: [], relays: community.relays } };
    env.user = userOf(ownerSk);
    // The Guestbook as read: at the live epoch's address.
    const live = guestbookGroupKey(community.root, c.id, 0n).pk;
    env.guestbook = env.guestbook.map((e) => ({ ...e, streamPk: live }));
    return { c, community, member, syncEid, now, live };
  }

  async function refoundAndOpen(community: Community, c: TestCommunity, keep: string[] = [], exclude: string[] = []) {
    const { result } = renderHook(() => useRefound(community), { wrapper });
    await act(async () => {
      await result.current.refound({ keep, exclude });
    });
    const newControl = { pk: controlSignerGroupKey(env.newControlRoot, c.id, 1n).pk, convKey: controlGroupKey(env.newRoot, c.id, 1n).convKey };
    const newGuestbook = guestbookGroupKey(env.newRoot, c.id, 1n);
    const open = (pk: string, key: { pk: string; convKey: Uint8Array }) =>
      env.sent.filter((e) => e.pubkey === pk).flatMap((e) => {
        try {
          return [openWrap(e, key)];
        } catch {
          return [];
        }
      });
    return { control: open(newControl.pk, newControl), guestbook: open(newGuestbook.pk, newGuestbook) };
  }

  it("baseline: compaction carries every folded head", async () => {
    const { c, community, syncEid } = setup();
    const { control } = await refoundAndOpen(community, c);
    const carried = control.map((o) => `${o.tags.find((t) => t[0] === "eid")?.[1]}@${o.tags.find((t) => t[0] === "ev")?.[1]}`);
    expect(carried).toContain(`${syncEid}@2`);
  });

  it("carries a Channel sync's predecessor beside its head, which a reader needs to judge it (CORD-04 §8, CORD-06 §3)", async () => {
    const { c, community, syncEid } = setup();
    const { control } = await refoundAndOpen(community, c);
    const carried = control.map((o) => `${o.tags.find((t) => t[0] === "eid")?.[1]}@${o.tags.find((t) => t[0] === "ev")?.[1]}`);
    expect(carried).toContain(`${syncEid}@1`);
  });

  it("re-issues each running Timeout it could issue itself on the new Guestbook (CORD-04 §8)", async () => {
    const { c, community, member } = setup();
    const { guestbook } = await refoundAndOpen(community, c);
    expect(guestbook.some((o) => o.kind === KIND_TIMEOUT && o.tags.some((t) => t[0] === "p" && t[1] === member))).toBe(true);
  });

  it("re-issues each standing Nickname set for another member on the new Guestbook (CORD-04 §10)", async () => {
    const { c, community, member } = setup();
    const { guestbook } = await refoundAndOpen(community, c, [member]);
    expect(guestbook.some((o) => o.kind === KIND_NICKNAME && o.content === "Newbie" && o.tags.some((t) => t[0] === "p" && t[1] === member))).toBe(true);
  });

  it("dates a re-issued Nickname by the rumor that won, not by a newer one the fold refused", async () => {
    const { c, community, member, now, live } = setup();
    const stranger = getPublicKey(generateSecretKey());
    env.guestbook.push({ ...opened(buildNicknameRumor(stranger, member, "Spoofed", now - 30_000), now - 30_000), streamPk: live });
    const { guestbook } = await refoundAndOpen(community, c, [member]);
    const nick = guestbook.find((o) => o.kind === KIND_NICKNAME && o.tags.some((t) => t[0] === "p" && t[1] === member));
    expect(nick?.content).toBe("Newbie");
    expect(nick?.ms).toBe(now - 120_000);
  });

  it("re-issues no Timeout for a member the Refounding removes", async () => {
    const { c, community, member } = setup();
    const { guestbook } = await refoundAndOpen(community, c, [], [member]);
    expect(guestbook.some((o) => o.kind === KIND_TIMEOUT && o.tags.some((t) => t[0] === "p" && t[1] === member))).toBe(false);
  });
});

describe("adopting a Severing Refounding (CORD-06 §3)", () => {
  async function setup(sever: boolean) {
    const ownerSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const owner = getPublicKey(ownerSk);
    const member = getPublicKey(memberSk);
    const c = new TestCommunity(owner);
    const everyone = sealedEdition(c, ownerSk, { vsk: "13", eid: c.everyoneHex, content: { permissions: "1" } });
    env.control = [everyone];
    env.folded = foldControlState(openControlEditions(env.control), c.id, owner);
    const community: Community = heldCommunity(c);
    env.entry = { added_at: 1, current: { root_epoch: 0, channels: [], relays: community.relays } };
    env.user = userOf(memberSk);
    // The member created a public link at epoch 0.
    env.links = [{ token: hexKey(), signer_sk: hexKey(), community_id: c.idHex, url: "", created_at: 1 }];
    const prevCommit = bytesToHex(epochKeyCommitment(0n, community.root));
    const controlPk = controlSignerGroupKey(env.newControlRoot, c.id, 1n).pk;
    const plain = bytesToBase64(encodeWrappedBaseKey(1n, env.newRoot, hexToBytes(controlPk)));
    const blobs = [{ locator: myLocator(owner, member, "0".repeat(64), 1n), wrapped: nip44Encrypt(plain, getConversationKey(ownerSk, member)) }];
    const address = baseRekeyGroupKey(community.root, c.id, 1n);
    const ownerUser = userOf(ownerSk);
    for (const r of buildRekeyRumors(owner, { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit }, blobs, Date.now())) {
      const rumor = sever ? buildRumor({ kind: r.kind, content: r.content, tags: [...r.tags, ["sever", "1"]], pubkey: r.pubkey, ms: null, createdAtSecs: r.created_at }) : r;
      env.relayEvents.push(await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, ownerUser.signer), address));
    }
    return { community };
  }

  it("baseline: adopting an ordinary Refounding refreshes the member's own links", async () => {
    const { community } = await setup(false);
    renderHook(() => useRekeyWatch(community), { wrapper });
    await waitFor(() => expect(env.refreshed.length).toBeGreaterThan(0));
    expect(env.refreshed[0]).toHaveLength(1);
  });

  it("never refreshes a link minted before the severed epoch into the new one", async () => {
    const { community } = await setup(true);
    renderHook(() => useRekeyWatch(community), { wrapper });
    await waitFor(() => expect(env.listWrites.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(env.refreshed.flat()).toEqual([]);
    // …and it SHOULD publish the condemned link's revocation tombstone.
    const signer = getPublicKey(hexToBytes(env.links[0].signer_sk));
    await waitFor(() => expect(env.sent.some((e) => e.pubkey === signer)).toBe(true));
  });
});
