/**
 * The `/m/<id>` focus read and the channel's own window read race, and the
 * focus read is the one that wins: it is a by-ids lookup while the window read
 * pages `WINDOW_SIZE` rumors and folds them.
 *
 * That ordering must not be observable. `isLoading` is the caller's skeleton,
 * and dropping it early publishes a timeline holding ONE row — which
 * MessageTimeline pins to the bottom, satisfying the permalink against a
 * dataset that is about to be replaced. When the real window lands the reader
 * is at the newest message: exactly the jump the permalink exists to prevent.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const CHANNEL_ID = "aa".repeat(32);
const CID = "cc".repeat(32);

const h = vi.hoisted(() => ({
  /** Resolves the channel's window read, so the race can be run either way. */
  releaseWindow: () => {},
  window: [] as unknown[],
  focus: [] as unknown[],
  /** Overrides the by-ids read, e.g. to hold it pending. */
  focusRead: undefined as (() => Promise<unknown[]>) | undefined,
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
  prewarmTimelineSnapshot: async () => undefined,
  takeSnapshotSeed: () => false,
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
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
  queryChannelRumors: () =>
    new Promise((resolve) => {
      h.releaseWindow = () => resolve(h.window);
    }),
  queryChannelRumorsByIds: async () => (h.focusRead ? h.focusRead() : h.focus),
  readStreamCursor: async () => undefined,
  scheduleExpiredSweep: () => () => undefined,
  updateStreamCursor: async () => undefined,
  writeRumors: () => true,
}));

import { useChannelTimeline } from "./useChannel";

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

describe("useChannelTimeline focus hydration", () => {
  it("holds the skeleton until the window read lands, however the race falls", async () => {
    const target = chat("01", 1_000_000);
    h.focus = [target];
    h.window = [chat("02", 5_000_000), chat("03", 6_000_000), chat("04", 7_000_000)];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useChannelTimeline(community, channel, CHANNEL_ID, { messageId: target.rumorId }),
      { wrapper: wrapperFor(client) },
    );

    // The by-ids lookup resolves first — it reads one row while the window
    // read pages a hundred and folds them.
    await waitFor(() => expect(result.current.raw.map((m) => m.rumorId)).toContain(target.rumorId));

    // Publishing now would hand MessageTimeline a one-row timeline. The
    // channel's own read has not returned, so this is still loading.
    expect(result.current.isLoading).toBe(true);

    h.releaseWindow();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // …and when it does clear, the focused row is there beside the window.
    expect(result.current.raw).toHaveLength(4);
    expect(result.current.raw.map((m) => m.rumorId)).toContain(target.rumorId);
  });

  it("retains the visited row in the channel cache after `/m/` clears", async () => {
    const target = chat("11", 1_000_000);
    h.focus = [target];
    h.window = [chat("12", 5_000_000), chat("13", 6_000_000)];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ messageId }: { messageId?: string }) =>
        useChannelTimeline(community, channel, CHANNEL_ID, { messageId }),
      {
        initialProps: { messageId: target.rumorId as string | undefined },
        wrapper: wrapperFor(client),
      },
    );

    await waitFor(() => expect(result.current.raw.map((m) => m.rumorId)).toContain(target.rumorId));
    h.releaseWindow();
    await waitFor(() => expect(result.current.raw).toHaveLength(3));

    // Sending a message drops the segment. The row the reader is parked at
    // must not vanish with it — the focus query is keyed by id, so retention
    // is the channel cache's job.
    rerender({ messageId: undefined });
    expect(result.current.raw.map((m) => m.rumorId)).toContain(target.rumorId);
  });

  it("keeps the timeline up while focusing a row the window already holds", async () => {
    const root = chat("21", 5_000_000);
    h.focus = [];
    h.focusRead = undefined;
    h.window = [root, chat("22", 6_000_000)];

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ threadRoot }: { threadRoot?: string }) =>
        useChannelTimeline(community, channel, CHANNEL_ID, { threadRoot }),
      { initialProps: { threadRoot: undefined as string | undefined }, wrapper: wrapperFor(client) },
    );
    h.releaseWindow();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    h.focusRead = () => new Promise(() => {});
    rerender({ threadRoot: root.rumorId });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.raw).toHaveLength(2);
    h.focusRead = undefined;
  });
});
