/**
 * The first store read after a snapshot seed REPLACES the seed. A seeded row
 * the store doesn't hold was never stored — the optimistic copy of a send whose
 * signer never answered — and merging kept it forever, reading as sent.
 * Without a seed, the cache is still merged into (live rows, scrolled pages).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const CHANNEL_ID = "aa".repeat(32);
const CID = "cc".repeat(32);

const h = vi.hoisted(() => ({
  window: [] as unknown[],
  focus: [] as unknown[],
  /** What the snapshot seeds into the cache, and whether a seed is pending. */
  seed: [] as unknown[],
  seeded: false,
  fold: { roster: { roles: [], grants: [] }, ownerHex: "", banned: new Set<string>(), heads: new Map(), signals: new Map() },
}));

// The Guestbook (Timeouts, the writer judge's history) isn't under test here.
vi.mock("@/concord/hooks/useGuestbook", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useGuestbook")>()),
  useGuestbook: () => ({ data: [], timeouts: new Map(), nicknames: new Map(), coalesced: new Map(), history: undefined }),
}));
vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { relay: () => ({ query: async () => [] }) } }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.fold }),
  useDissolved: () => ({ data: null }),
  citationFor: () => undefined,
}));
vi.mock("@/concord/hooks/usePause", () => ({ useActivePause: () => undefined }));
vi.mock("@/concord/hooks/timelineSnapshot", () => ({
  persistTimelineSnapshot: async () => undefined,
  prewarmTimelineSnapshot: async (qc: QueryClient, _viewer: string, _channel: string, key: readonly unknown[]) => {
    if (h.seed.length === 0) return;
    qc.setQueryData(key, h.seed, { updatedAt: Date.now() - 60_000 });
    h.seeded = true;
  },
  takeSnapshotSeed: () => {
    const was = h.seeded;
    h.seeded = false;
    return was;
  },
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "b".repeat(64) } }) }));
vi.mock("@/concord/lib/channelSync", () => ({
  LOAD_OLDER_MAX_PAGES: 3,
  backfillStore: async () => ({ events: [], exhausted: true }),
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
  queryChannelRumors: async () => h.window,
  queryChannelRumorsByIds: async () => h.focus,
  readStreamCursor: async () => undefined,
  scheduleExpiredSweep: () => () => undefined,
  updateStreamCursor: async () => undefined,
  writeRumors: () => true,
}));

import { channelKey, useChannelTimeline } from "./useChannel";

function chat(id: string, ms: number): OpenedChat {
  return {
    rumorId: id.padEnd(64, "0"),
    author: "b".repeat(64),
    kind: KIND_MESSAGE,
    content: id,
    tags: [["channel", CHANNEL_ID], ["epoch", "0"]],
    ms,
    createdAt: Math.floor(ms / 1000),
    wrapId: "c".repeat(64),
    streamPk: "d".repeat(64),
    sealKind: KIND_SEAL_ENCRYPTED,
    seal: {} as NostrEvent,
    channelIdHex: CHANNEL_ID,
    epoch: 0n,
  };
}

const community = { idHex: CID, relays: [] } as unknown as Community;
const channel = {
  idHex: CHANNEL_ID,
  streams: [{ epoch: 0n, group: { pk: "d".repeat(64) } }],
  current: { epoch: 0n, group: { pk: "d".repeat(64) } },
} as unknown as Channel;

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  h.seed = [];
  h.seeded = false;
});

describe("useChannelTimeline after a snapshot seed", () => {
  it("drops a seeded row the store never held", async () => {
    const stored = [chat("01", 1_000_000), chat("02", 2_000_000)];
    const ghost = { ...chat("99", 3_000_000), wrapId: "" };
    h.window = stored;
    h.seed = [...stored, ghost];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useChannelTimeline(community, channel, CHANNEL_ID), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() =>
      expect(result.current.raw.map((m) => m.rumorId)).toEqual(stored.map((m) => m.rumorId)),
    );
  });

  it("still merges into a cache no snapshot seeded", async () => {
    const live = chat("50", 5_000_000);
    h.window = [chat("01", 1_000_000)];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(channelKey(CHANNEL_ID), [live]);
    const { result } = renderHook(() => useChannelTimeline(community, channel, CHANNEL_ID), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.raw).toHaveLength(2));
    expect(result.current.raw.map((m) => m.rumorId)).toContain(live.rumorId);
  });
});
