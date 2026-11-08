/**
 * A jump to a message older than the loaded present opens a DETACHED run around
 * it instead of paging the present down to it newest-first; reading forward
 * closes the gap and joins the two.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const CHANNEL_ID = "aa".repeat(32);
const CID = "cc".repeat(32);

const h = vi.hoisted(() => ({
  store: [] as unknown[],
  window: [] as unknown[],
  pagesBefore: [] as Array<{ until: number; limit: number }>,
  relayReads: 0,
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
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/concord/lib/channelSync", () => ({
  LOAD_OLDER_MAX_PAGES: 3,
  historyRelays: (c: { relays: string[] }) => c.relays,
  backfillStore: async () => {
    h.relayReads += 1;
    return { events: [], count: 0, pages: 1, reachedBottom: true, exhausted: true, failed: false };
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
vi.mock("@/concord/lib/rumorStore", () => {
  const rows = () => h.store as OpenedChat[];
  return {
    ackPendingWraps: () => {},
    CHAT_ROW_KINDS: [9, 1068, 1111, 1740, 31922, 31923],
    clearStreamExhausted: async () => undefined,
    peekPendingWraps: async () => [],
    queryChannelFirstSeen: async () => new Map(),
    queryChannelFirstSeenCached: async () => new Map(),
    queryChannelRumors: async () => h.window,
    queryChannelRumorsByIds: async (_c: string, _ch: string, ids: string[]) => rows().filter((m) => ids.includes(m.rumorId)),
    queryChannelPageBefore: async (_c: string, _ch: string, opts: { until: number; skip: Set<string>; limit: number }) => {
      h.pagesBefore.push({ until: opts.until, limit: opts.limit });
      const below = rows()
        .filter((m) => m.createdAt <= opts.until && !opts.skip.has(m.rumorId))
        .sort((a, b) => b.createdAt - a.createdAt);
      return { events: below.slice(0, opts.limit), full: below.length > opts.limit };
    },
    queryChannelWindow: async (_c: string, _ch: string, opts: { since: number; until: number; limit: number }) => {
      const inside = rows().filter((m) => m.createdAt >= opts.since && m.createdAt <= opts.until);
      return inside.length > opts.limit ? { events: [], complete: false } : { events: inside, complete: true };
    },
    // The store is whole from 100s to 10_000s, so forward reads never need relays.
    readStreamCursor: async () => ({ newest: 10_000, oldest: 100, exhausted: false }),
    scheduleExpiredSweep: () => () => undefined,
    updateStreamCursor: async () => undefined,
    writeRumors: () => Promise.resolve(true),
  };
});

import { useChannelTimeline } from "./useChannel";

function chat(n: number, secs: number): OpenedChat {
  return {
    rumorId: n.toString(16).padStart(64, "0"),
    author: "b".repeat(64),
    kind: KIND_MESSAGE,
    content: String(n),
    tags: [["channel", CHANNEL_ID], ["epoch", "0"]],
    ms: secs * 1000,
    createdAt: secs,
    wrapId: "c".repeat(64),
    streamPk: "d".repeat(64),
    sealKind: KIND_SEAL_ENCRYPTED,
    seal: {} as NostrEvent,
    channelIdHex: CHANNEL_ID,
    epoch: 0n,
  };
}

const community = { idHex: CID, relays: ["wss://r"] } as unknown as Community;
const channel = {
  idHex: CHANNEL_ID,
  streams: [{ epoch: 0n, group: { pk: "d".repeat(64) } }],
  current: { epoch: 0n, group: { pk: "d".repeat(64) } },
} as unknown as Channel;

const shownSecs = (rows: { createdAt: number }[], span: { from: number; to?: number } | undefined) =>
  rows
    .filter((m) => !span || (m.createdAt >= span.from && (span.to === undefined || m.createdAt <= span.to)))
    .map((m) => m.createdAt)
    .sort((a, b) => a - b);

describe("useChannelTimeline detached run", () => {
  it("opens a run around an old target, pages its own history, and joins the present when read forward", async () => {
    // One row a second from 1000s; the present's window is the newest ten.
    const all = Array.from({ length: 200 }, (_, i) => chat(i + 1, 1000 + i * 10));
    h.store = all;
    h.window = all.slice(-10);
    const target = all[20];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useChannelTimeline(community, channel, CHANNEL_ID, { messageId: target.rumorId }),
      { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> },
    );

    await waitFor(() => expect(result.current.hasNewer).toBe(true));
    expect(result.current.isLoading).toBe(false);
    // The run is the target and what precedes it, none of the present.
    const run = shownSecs(result.current.raw, result.current.span);
    expect(run[run.length - 1]).toBe(target.createdAt);
    expect(run).toContain(all[0].createdAt);
    expect(run.some((s) => s > target.createdAt)).toBe(false);

    // Scrolling up pages below the RUN, not below the present.
    const pages = h.pagesBefore.length;
    await act(async () => { await result.current.loadOlder(); });
    expect(h.pagesBefore.slice(pages).every((p) => p.until <= all[0].createdAt)).toBe(true);

    // Reading forward walks oldest-first, from the target, until the gap is closed —
    // from the store alone, since the sync cursor vouches for that region.
    h.relayReads = 0;
    for (let i = 0; i < 20 && result.current.hasNewer; i++) {
      await act(async () => { await result.current.loadNewer(); });
    }
    expect(result.current.hasNewer).toBe(false);
    expect(h.relayReads).toBe(0);
    // One continuous timeline from the oldest row to the newest, with no hole.
    expect(shownSecs(result.current.raw, result.current.span)).toEqual(all.map((m) => m.createdAt));
  });

  it("returns to the present on demand and stops showing the run", async () => {
    const all = Array.from({ length: 200 }, (_, i) => chat(i + 1, 1000 + i * 10));
    h.store = all;
    h.window = all.slice(-10);
    const target = all[20];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ messageId }: { messageId?: string }) => useChannelTimeline(community, channel, CHANNEL_ID, { messageId }),
      {
        initialProps: { messageId: target.rumorId as string | undefined },
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
      },
    );
    await waitFor(() => expect(result.current.hasNewer).toBe(true));

    act(() => result.current.returnToPresent());
    rerender({ messageId: undefined });
    expect(result.current.hasNewer).toBe(false);
    expect(shownSecs(result.current.raw, result.current.span)).toEqual(all.slice(-10).map((m) => m.createdAt));
  });
});
