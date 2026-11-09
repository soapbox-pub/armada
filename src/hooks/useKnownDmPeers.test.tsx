/**
 * The known-vs-request predicate is the single line between the DM inbox and
 * the request tier, and it's consumed by four surfaces (the list, the request
 * list, the rail's unread dot, the thread's accept banner). If any of them
 * disagreed about a peer, a conversation would show in both lists or in
 * neither — and the rail could light for a row the list won't show.
 *
 * These pin the four ways in, and the fail-closed default.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";

const FOLLOWED = "a".repeat(64);
const ACCEPTED = "b".repeat(64);
const PINNED = "c".repeat(64);
const STRANGER = "d".repeat(64);
const INDEXED = "e".repeat(64);
const INDEXED_PASSIVE = "f".repeat(64);
const GROUP_PEER = "1".repeat(64);

const h = vi.hoisted(() => ({
  follows: [] as string[],
  followsLoading: false,
  followsWireReady: true,
  followsCached: true,
  accepted: [] as string[],
  pinned: [] as string[],
  indexed: [] as Array<{
    key: string;
    latest: { createdAt: number; id: string };
    mine: boolean;
  }>,
  indexReady: true,
  muted: new Set<string>(),
  mutesReady: true,
  mutesWireReady: true,
  mutesConfigReady: true,
  storedContactList: false,
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "9".repeat(64) } }) }));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => (h.storedContactList ? [{ id: "stored", kind: 3, tags: [] }] : []) }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

vi.mock("@/hooks/useFollowList", () => ({
  useFollowList: () => ({
    data: {
      pubkeys: h.follows,
      wireReady: h.followsWireReady,
      event: h.followsCached ? { id: "follow-cache" } : null,
    },
    isLoading: h.followsLoading,
  }),
}));
vi.mock("@/hooks/useAcceptedDms", () => ({
  useAcceptedDms: () => ({
    accepted: h.accepted,
    isAccepted: (p: string) => h.accepted.includes(p),
    accept: vi.fn(),
  }),
}));
vi.mock("@/hooks/usePinnedDms", () => ({
  usePinnedDms: () => ({
    pinned: h.pinned,
    isPinned: (p: string) => h.pinned.includes(p),
    pin: vi.fn(),
    unpin: vi.fn(),
    togglePin: vi.fn(),
  }),
}));
vi.mock("@/hooks/useDmConversationIndex", () => ({
  useDmConversationIndex: () => h.indexed,
  useDmConversationIndexReady: () => h.indexReady,
}));
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({
    mutedPubkeys: h.muted,
    ready: h.mutesReady,
    wireReady: h.mutesWireReady,
    configReady: h.mutesConfigReady,
  }),
}));

describe("useKnownDmPeers", () => {
  beforeEach(() => {
    h.follows = [FOLLOWED];
    h.followsLoading = false;
    h.followsWireReady = true;
    h.followsCached = true;
    h.accepted = [ACCEPTED];
    h.pinned = [PINNED];
    h.indexed = [];
    h.indexReady = true;
    h.muted = new Set();
    h.mutesReady = true;
    h.mutesWireReady = true;
    h.mutesConfigReady = true;
    h.storedContactList = false;
  });

  it("admits followed, accepted and pinned peers", () => {
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isKnown(FOLLOWED, false)).toBe(true);
    expect(result.current.isKnown(ACCEPTED, false)).toBe(true);
    expect(result.current.isKnown(PINNED, false)).toBe(true);
  });

  it("admits anyone the viewer has written to, whoever they are", () => {
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isKnown(STRANGER, true)).toBe(true);
  });

  it("classifies an unsolicited stranger as a request", () => {
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isKnown(STRANGER, false)).toBe(false);
  });

  it("fails closed while the follow list is still loading", () => {
    // An unresolved follow list must not promote strangers into the inbox;
    // callers gate on `isLoading` and paint the snapshot instead.
    h.follows = [];
    h.followsLoading = true;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isKnown(FOLLOWED, false)).toBe(false);
  });

  it("lets a display stop waiting on the relay read once the store holds no contact list, and only then", async () => {
    h.follows = [];
    h.followsLoading = true;
    h.followsCached = false;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    // Until the store answers, displays wait like everything else.
    expect(result.current.displayLoading).toBe(true);
    await waitFor(() => expect(result.current.displayLoading).toBe(false));
    // Recording and pruning still wait for the relays.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isKnown(FOLLOWED, false)).toBe(false);
  });

  it("keeps a display waiting while a stored contact list is still being seeded", async () => {
    h.follows = [];
    h.followsLoading = true;
    h.storedContactList = true;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.displayLoading).toBe(true);
    expect(result.current.isLoading).toBe(true);
  });

  it("keeps cache-seeded follows and mutes additive until both wire reads succeed", () => {
    h.followsWireReady = false;
    h.mutesWireReady = false;
    const { result, rerender } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.knownPeers).toContain(FOLLOWED);
    expect(result.current.authoritativeReady).toBe(false);

    h.followsWireReady = true;
    rerender();
    expect(result.current.authoritativeReady).toBe(false);

    h.mutesWireReady = true;
    rerender();
    expect(result.current.authoritativeReady).toBe(true);
  });

  it("uses distinguishable last-good follow and mute snapshots for config only", () => {
    h.followsWireReady = false;
    h.followsCached = true;
    h.mutesWireReady = false;
    h.mutesConfigReady = true;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });

    expect(result.current.configurationReady).toBe(true);
    expect(result.current.authoritativeReady).toBe(false);
  });

  it("does not treat failed empty follow/mute sources as config authority", () => {
    h.follows = [];
    h.followsWireReady = false;
    h.followsCached = false;
    h.mutesWireReady = false;
    h.mutesConfigReady = false;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });

    expect(result.current.configurationReady).toBe(false);
  });

  it("keeps a replied-to peer known after they are unfollowed", () => {
    // The accepted set is sticky by design — it must outlive a change in the
    // follow graph, exactly like a pin.
    h.follows = [];
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isKnown(ACCEPTED, false)).toBe(true);
  });

  it("restores peers from conversations this account wrote in", () => {
    h.indexed = [
      {
        key: INDEXED,
        latest: { createdAt: 10, id: "2".repeat(64) },
        mine: true,
      },
      {
        key: `${INDEXED_PASSIVE},${GROUP_PEER}`,
        latest: { createdAt: 9, id: "3".repeat(64) },
        mine: true,
      },
    ];
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.knownPeers).toContain(INDEXED);
    expect(result.current.isKnown(INDEXED, false)).toBe(true);
    expect(result.current.knownPeers).not.toContain(GROUP_PEER);
    expect(result.current.isKnown(INDEXED_PASSIVE, false)).toBe(false);
    expect(result.current.knownConversationKeys).toContain(`${INDEXED_PASSIVE},${GROUP_PEER}`);
  });

  it("waits for the encrypted roster before persisting a known-peer set", () => {
    h.indexReady = false;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });

  it("does not trust every member of a pinned group", () => {
    h.pinned = [`${PINNED},${STRANGER}`];
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.isKnown(PINNED, false)).toBe(false);
    expect(result.current.isKnown(STRANGER, false)).toBe(false);
    expect(result.current.knownConversationKeys).toEqual([`${PINNED},${STRANGER}`]);
  });

  it("keeps muted peers out of background fetch and notification rosters", () => {
    h.muted = new Set([FOLLOWED, INDEXED]);
    h.indexed = [{
      key: INDEXED,
      latest: { createdAt: 10, id: "4".repeat(64) },
      mine: true,
    }];
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.knownPeers).not.toContain(FOLLOWED);
    expect(result.current.knownPeers).not.toContain(INDEXED);
    expect(result.current.knownConversationKeys).not.toContain(INDEXED);
    expect(result.current.mutedPeers).toEqual([FOLLOWED, INDEXED].sort());
  });

  it("keeps a pinned group out of notification trust when any member is muted", () => {
    h.pinned = [`${PINNED},${STRANGER}`];
    h.muted = new Set([STRANGER]);
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.knownConversationKeys).toEqual([]);
  });

  it("fails closed while the mute list is unresolved", () => {
    h.mutesReady = false;
    const { result } = renderHook(() => useKnownDmPeers(), { wrapper });
    expect(result.current.knownPeers).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });
});
