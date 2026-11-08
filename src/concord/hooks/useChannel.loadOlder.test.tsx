import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Channel, Community } from "@/concord/lib/types";
import type { ReactNode } from "react";

const CHANNEL_ID = "aa".repeat(32);

const h = vi.hoisted(() => ({
  hang: false,
  olderSignal: undefined as AbortSignal | undefined,
  fold: { roster: { roles: [], grants: [] }, ownerHex: "", banned: new Set<string>(), heads: new Map(), signals: new Map() },
}));

// The Guestbook (Timeouts, the writer judge's history) isn't under test here.
vi.mock("@/concord/hooks/useGuestbook", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useGuestbook")>()),
  useGuestbook: () => ({ data: [], timeouts: new Map(), nicknames: new Map(), coalesced: new Map(), history: undefined }),
}));
vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { relay: () => ({ query: async () => [] }) } }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.fold }),
  useDissolved: () => ({ data: null }),
  citationFor: () => undefined,
}));
vi.mock("@/concord/hooks/usePause", () => ({ useActivePause: () => undefined }));
vi.mock("@/concord/hooks/timelineSnapshot", () => ({
  persistTimelineSnapshot: async () => undefined,
  prewarmTimelineSnapshot: async () => undefined,
  takeSnapshotSeed: () => false,
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "b".repeat(64) } }) }));
vi.mock("@/concord/lib/channelSync", () => ({
  LOAD_OLDER_MAX_PAGES: 3,
  historyRelays: (c: { relays: string[] }) => c.relays,
  backfillStore: (_n: unknown, _r: unknown, _c: unknown, signal: AbortSignal, opts?: { maxPages?: number }) => {
    // Only loadOlder pages with LOAD_OLDER_MAX_PAGES.
    if (!h.hang || opts?.maxPages !== 3) return Promise.resolve({ events: [], exhausted: false });
    h.olderSignal = signal;
    return new Promise(() => {}); // a slow relay page
  },
  setChannelSyncContext: () => () => {},
}));
vi.mock("@/concord/lib/quarantineMemory", () => ({
  quarantineMemoryRevision: () => 0,
  recallQuarantined: () => undefined,
  rememberQuarantined: () => {},
  subscribeQuarantineMemory: () => () => {},
}));
vi.mock("@/sync/syncManager", () => ({ invalidateSyncTopic: () => {} }));
vi.mock("@/sync/useSyncTopic", () => ({ useSyncTopic: () => {} }));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => {} }));
vi.mock("@/concord/lib/rumorStore", () => ({
  ackPendingWraps: () => {},
  CHAT_ROW_KINDS: [9, 1068, 1111, 1740, 31922, 31923],
  clearStreamExhausted: async () => undefined,
  peekPendingWraps: async () => [],
  queryChannelFirstSeen: async () => new Map(),
  queryChannelFirstSeenCached: async () => new Map(),
  queryChannelPageBefore: async () => ({ events: [], full: false }),
  queryChannelRumors: async () => [],
  queryChannelRumorsByIds: async () => [],
  readStreamCursor: async () => undefined,
  scheduleExpiredSweep: () => () => undefined,
  updateStreamCursor: async () => undefined,
  writeRumors: () => true,
}));

import { useChannelTimeline } from "@/concord/hooks/useChannel";

const community = { idHex: "cc".repeat(32), relays: ["wss://r"] } as unknown as Community;
const channel = {
  idHex: CHANNEL_ID,
  streams: [{ epoch: 0n, group: { pk: "d".repeat(64) } }],
  current: { epoch: 0n, group: { pk: "d".repeat(64) } },
} as unknown as Channel;

describe("useChannelTimeline loadOlder", () => {
  it("aborts the relay backfill when the timeline unmounts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useChannelTimeline(community, channel, CHANNEL_ID), { wrapper });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    h.hang = true;
    act(() => { void result.current.loadOlder(); });
    await waitFor(() => expect(h.olderSignal).toBeDefined());
    expect(h.olderSignal!.aborted).toBe(false);

    unmount();
    expect(h.olderSignal!.aborted).toBe(true);
  });
});
