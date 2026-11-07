/**
 * usePins' deletion duty (CORD-04 §7, Vector `run_pin_duty`): the affected author
 * drops an erased pin from the head at once, every other curator after a random wait.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToHex, channelGroupKey, pinsLocator, random32 } from "@/concord/lib/derive";
import { KIND_DELETE, KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildPinEntry, serializePublicPinList } from "@/concord/lib/pins";
import { buildRumor, openWrap, sealRumor, wrapSeal, type OpenedEvent } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";

import { usePins } from "./usePins";

const h = vi.hoisted(() => ({
  folded: undefined as unknown,
  user: undefined as { pubkey: string; signer: unknown } | undefined,
  published: [] as string[],
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: { content: string }) => {
    h.published.push(rumor.content);
  },
}));

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

const CHANNEL = random32();
const group = channelGroupKey(random32(), CHANNEL, 0);

async function setup(author: ReturnType<typeof signer>, viewer: ReturnType<typeof signer>) {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content: "pinned",
    tags: [["channel", bytesToHex(CHANNEL)], ["epoch", "0"]],
    pubkey: author.pubkey,
  });
  const opened = openWrap(await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, author), group), group);
  const entry = buildPinEntry(opened, group.convKey)!;
  const community = { id: random32(), idHex: "cc".repeat(32), relays: [] } as unknown as Community;
  const channel = {
    id: CHANNEL,
    idHex: bytesToHex(CHANNEL),
    isPrivate: false,
    streams: [{ epoch: 0, group }],
    current: { epoch: 0, group },
  } as unknown as Channel;
  const eid = bytesToHex(pinsLocator(community.id, channel.id));
  h.folded = {
    // The viewer owns the Community, so holds PIN_MESSAGES.
    ownerHex: viewer.pubkey,
    roster: { roles: [], grants: [] },
    pinLists: new Map([[eid, { content: serializePublicPinList([entry]) }]]),
    heads: new Map(),
    incomplete: [],
    banned: new Set<string>(),
  };
  h.user = { pubkey: viewer.pubkey, signer: viewer };
  const deletion = { kind: KIND_DELETE, author: author.pubkey, tags: [["e", opened.rumorId]], rumorId: "d".repeat(64), ms: Date.now(), content: "" };
  const rows = new Map<string, OpenedEvent>([[deletion.rumorId, deletion as unknown as OpenedEvent]]);
  return { community, channel, rows };
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("usePins deletion duty (CORD-04 §7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.published = [];
  });
  afterEach(() => vi.useRealTimers());

  it("drops the erased pin at once when this client wrote the message", async () => {
    const me = signer();
    const { community, channel, rows } = await setup(me, me);
    const { result } = renderHook(() => usePins(community, channel, rows), { wrapper });
    expect(result.current.deletedPins).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.published).toEqual([serializePublicPinList([])]);
  });

  it("waits a random interval when another member's message was erased", async () => {
    const { community, channel, rows } = await setup(signer(), signer());
    renderHook(() => usePins(community, channel, rows), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(h.published).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_001);
    });
    expect(h.published).toEqual([serializePublicPinList([])]);
  });
});
