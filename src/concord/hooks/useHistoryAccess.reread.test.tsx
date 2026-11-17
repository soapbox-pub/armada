import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads: string[][] = [];
const nostr = {
  relay: () => ({
    query: async (filters: Array<{ authors: string[] }>) => {
      reads.push([...filters[0].authors].sort());
      return [];
    },
  }),
};

const GAPPED = "11".repeat(32);
const WHOLE = "22".repeat(32);
const folded = {
  rankedRoster: true,
  ownerHex: "owner",
  roster: {},
  banned: new Set<string>(),
  channels: new Map([GAPPED, WHOLE].map((id) => [id, { channelIdHex: id, isPrivate: true }])),
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "me", signer: {} } }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({ useControlFold: () => ({ data: folded }) }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunityEntry: () => undefined, useUpdateCommunityList: () => ({}) }));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => undefined }));
vi.mock("@/wire/watched", () => ({ setWatched: () => undefined }));
vi.mock("@/concord/lib/roles", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/roles")>()),
  channelPermissions: () => (1n << 64n) - 1n,
}));
vi.mock("@/concord/lib/delivery", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/delivery")>()),
  accessPlane: (_c: unknown, id: Uint8Array) => ({ pk: `plane-${id[0]}` }),
}));
vi.mock("@/concord/lib/history", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/history")>()),
  historyViewsReady: () => Promise.resolve(),
  heldHistoryViews: () => [],
  subscribeHistoryViews: () => () => undefined,
  historyViewsGeneration: () => 0,
}));

import { useHistoryAccess } from "@/concord/hooks/useChannelAccess";
import { OWED_WINDOW_MS } from "@/concord/hooks/useOwedReread";

// GAPPED is at epoch 3 with neither earlier epoch held; WHOLE is at epoch 1.
const communityAt = (gappedEpoch: bigint, priors: bigint[] = [], rootEpoch = 0n) =>
  ({
    idHex: "cc".repeat(32),
    rootEpoch,
    relays: ["wss://relay.example"],
    privateChannels: [
      { id: new Uint8Array(32).fill(0x11), epoch: gappedEpoch, priors: priors.map((epoch) => ({ key: new Uint8Array(32), epoch })) },
      { id: new Uint8Array(32).fill(0x22), epoch: 1n },
    ],
  }) as never;

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("useHistoryAccess rereads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reads.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("reads a gap held since mount once, then periodically, and on a key landing reads just the gapped Channel again", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { rerender } = renderHook((c) => useHistoryAccess(c), { wrapper, initialProps: communityAt(3n) });
    await advance(OWED_WINDOW_MS);
    expect(reads).toEqual([["plane-17", "plane-34"]]);

    reads.length = 0;
    rerender(communityAt(4n));
    await advance(OWED_WINDOW_MS);
    const gapReads = reads.filter((r) => r.length === 1);
    expect(gapReads.length).toBeGreaterThan(10);
    expect(gapReads.every((r) => r[0] === "plane-17")).toBe(true);

    reads.length = 0;
    await advance(OWED_WINDOW_MS);
    expect(reads.filter((r) => r.length === 1)).toEqual([]);
  });

  it("doesn't read again when a rotation only moves a held key into the priors", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    // Epoch 1 was never delivered, and never will be.
    const { rerender } = renderHook((c) => useHistoryAccess(c), { wrapper, initialProps: communityAt(3n, [2n]) });
    await advance(OWED_WINDOW_MS);
    reads.length = 0;

    rerender(communityAt(4n, [2n, 3n]));
    await advance(OWED_WINDOW_MS);
    expect(reads.filter((r) => r.length === 1)).toEqual([]);

    // A re-add past an epoch this member was out for owes that epoch: it reads again.
    rerender(communityAt(6n, [2n, 3n, 4n]));
    await advance(OWED_WINDOW_MS);
    expect(reads.filter((r) => r.length === 1).length).toBeGreaterThan(10);
  });

  it("doesn't read the same gap again after a root rekey, whatever windows ran before it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { rerender } = renderHook((c) => useHistoryAccess(c), { wrapper, initialProps: communityAt(3n) });
    await advance(OWED_WINDOW_MS);
    rerender(communityAt(4n));
    await advance(OWED_WINDOW_MS + 1);
    reads.length = 0;

    rerender(communityAt(4n, [], 1n));
    await advance(OWED_WINDOW_MS + 1);
    // Only the main read, following the planes to the new root epoch.
    expect(reads).toEqual([["plane-17", "plane-34"]]);
  });
});
