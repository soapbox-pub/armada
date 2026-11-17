import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads: number[] = [];
const nostr = {
  relay: () => ({
    query: async () => {
      reads.push(Date.now());
      return [];
    },
  }),
};

const X = "11".repeat(32);
const Y = "22".repeat(32);
let folded: object;
const foldWith = (ids: string[]) => ({
  rankedRoster: true,
  ownerHex: "owner",
  roster: {},
  banned: new Set<string>(),
  channels: new Map(ids.map((id) => [id, { channelIdHex: id, isPrivate: true }])),
  writers: new Map(ids.map((id) => [id, {}])),
});
// The writer epochs this member lacks, by Channel.
let writerOwed: Record<string, number> = {};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "me", signer: {} } }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({ useControlFold: () => ({ data: folded }) }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunityEntry: () => undefined, useUpdateCommunityList: () => ({}) }));
vi.mock("@/concord/hooks/useGuestbook", () => ({ useGuestbook: () => ({}) }));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => undefined }));
vi.mock("@/wire/watched", () => ({ setWatched: () => undefined }));
vi.mock("@/concord/lib/accessDuty", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/accessDuty")>()),
  authoritySig: () => "authority",
}));
vi.mock("@/concord/lib/roles", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/roles")>()),
  channelPermissions: () => (1n << 64n) - 1n,
}));
vi.mock("@/concord/lib/delivery", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/delivery")>()),
  accessPlane: (_c: unknown, id: Uint8Array) => ({ pk: `plane-${id[0]}` }),
}));
vi.mock("@/concord/lib/writerKeys", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/writerKeys")>()),
  writerKeysReady: () => Promise.resolve(),
  subscribeWriterKeys: () => () => undefined,
  writerNeeds: (_f: unknown, _c: unknown, id: string) =>
    writerOwed[id] === undefined ? undefined : { epoch: writerOwed[id], pk: `w-${id.slice(0, 2)}`, key: true, cert: false, certifier: false },
}));

import { useChannelAccess } from "@/concord/hooks/useChannelAccess";
import { OWED_WINDOW_MS } from "@/concord/hooks/useOwedReread";
import { useWriterAccess } from "@/concord/hooks/useWriterAccess";

// No Channel keys held, so every private Channel in the fold is owed.
const community = { idHex: "cc".repeat(32), id: new Uint8Array(32), rootEpoch: 0n, relays: ["wss://relay.example"], privateChannels: [] } as never;

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
};
/** Reads in (from, to] seconds after `start`. */
const readsBetween = (start: number, from: number, to: number) => reads.filter((t) => t - start > from * 1000 && t - start <= to * 1000).length;

describe("owed key rereads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reads.length = 0;
    writerOwed = {};
  });
  afterEach(() => vi.useRealTimers());

  it("Channel keys: a key owed since mount gets the 20 s backoff; one newly owed gets every 10 s after it", async () => {
    folded = foldWith([X]);
    const { rerender } = renderHook(() => useChannelAccess(community), { wrapper: wrapper() });
    const start = Date.now();
    await advance(OWED_WINDOW_MS);
    expect(readsBetween(start, 0, 20)).toBeGreaterThan(5);
    // Between the backoff's end and the periodic read, nothing.
    expect(readsBetween(start, 21, 59)).toBe(0);

    folded = foldWith([X, Y]);
    rerender();
    const changed = Date.now();
    await advance(OWED_WINDOW_MS);
    expect(readsBetween(changed, 21, 59)).toBeGreaterThan(2);
  });

  it("writer keys: one owed since mount gets the 20 s backoff; a newly owed epoch reads every 10 s", async () => {
    folded = foldWith([X]);
    writerOwed = { [X]: 1 };
    const { rerender } = renderHook(() => useWriterAccess(community), { wrapper: wrapper() });
    const start = Date.now();
    await advance(OWED_WINDOW_MS);
    expect(readsBetween(start, 0, 20)).toBeGreaterThan(5);
    expect(readsBetween(start, 21, 59)).toBe(0);

    // A rotation owes the next epoch under the same Channel id.
    writerOwed = { [X]: 2 };
    rerender();
    const changed = Date.now();
    await advance(OWED_WINDOW_MS);
    expect(readsBetween(changed, 21, 59)).toBeGreaterThan(2);
  });

  it("writer keys: the load backoff ends with what was owed at load, so a later epoch reads on the window alone", async () => {
    folded = foldWith([X]);
    writerOwed = { [X]: 1 };
    const { rerender } = renderHook(() => useWriterAccess(community), { wrapper: wrapper() });
    await advance(OWED_WINDOW_MS);
    writerOwed = {};
    rerender();
    await advance(OWED_WINDOW_MS);

    writerOwed = { [X]: 2 };
    rerender();
    const changed = Date.now();
    await advance(OWED_WINDOW_MS);
    // The window's first read and its 20 s backoff, once each.
    expect(readsBetween(changed, -1, 20)).toBeLessThanOrEqual(10);
  });
});
