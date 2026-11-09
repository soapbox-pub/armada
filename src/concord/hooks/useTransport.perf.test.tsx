import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { OpenedChat } from "@/concord/lib/chat";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import type { Channel, Community } from "@/concord/lib/types";

import { useTransport } from "./useTransport";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Perf evidence for the second half of the channel-switch cost: the transport
 * memos (useTransport.ts). After the fold, the page runs ~10 more O(N) passes
 * over the whole decoded set on every switch — message adaptation
 * (useTransport.ts:98), thread bucketing (:126), reaction/zap/poll tallies
 * (:178/:259/:331), rotation dividers (:459), and a final merge+sort (:447).
 * None are windowed to the rendered slice.
 *
 * This mirrors useTransport.test.tsx's harness (mock useChannel to feed a
 * prebuilt `folded`, mock useCurrentUser) and just scales the message count,
 * timing the hook render. `transport.messages.length === N` is the assertion
 * that every loaded message is adapted (un-windowed); the printed timing is the
 * cost signal.
 */

const h = vi.hoisted(() => ({
  folded: {
    messages: [] as unknown[],
    reactions: new Map(),
    zaps: new Map(),
    pollVotes: new Map(),
    calendarEvents: [],
    rsvps: new Map(),
    timerNotices: [],
    quarantined: new Set<string>(),
    paused: new Set<string>(),
    ruled: new Set<string>(),
  },
  // One object, as the real hook's useMemo returns: a fresh one per call would
  // bust the transport's memos on every re-render and skew the timing.
  moderation: { banned: new Set<string>(), canDelete: () => false, canMentionEveryone: () => false },
}));

vi.mock("@/concord/hooks/useChannel", () => ({
  useChatModeration: () => h.moderation,
  useChannelTimeline: () => ({
    folded: h.folded,
    raw: [],
    isLoading: false,
    loadOlder: async () => 0,
    hasMore: false,
    isLoadingOlder: false,
  }),
  useSendMessage: () => ({ mutateAsync: async () => ({}) }),
  useMessageActions: () => ({ retry: () => {}, discard: () => {}, deleteMessage: () => {} }),
  useSendStatus: () => ({}),
  channelKey: (id: string | null) => ["concord", "channel", id] as const,
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: undefined }),
}));

const CHANNEL_ID = "aa".repeat(32);
const community = { idHex: "cc".repeat(32), relays: [] } as unknown as Community;
const channel = { idHex: CHANNEL_ID } as unknown as Channel;

/** N plain top-level messages (no thread roots), so all N stay in the timeline. */
function messages(n: number): OpenedChat[] {
  return Array.from({ length: n }, (_, i) => ({
    rumorId: i.toString(16).padStart(64, "0"),
    author: AUTHORS[i % AUTHORS.length],
    kind: KIND_MESSAGE,
    content: `message body number ${i} with a little text`,
    tags: [["channel", CHANNEL_ID], ["epoch", "0"]],
    ms: 1_000_000 + i * 1000,
    createdAt: Math.floor((1_000_000 + i * 1000) / 1000),
    wrapId: "c".repeat(64),
    streamPk: "d".repeat(64),
    sealKind: KIND_SEAL_ENCRYPTED,
    seal: {} as NostrEvent,
    channelIdHex: CHANNEL_ID,
    epoch: 0n,
  }));
}
const AUTHORS = Array.from({ length: 24 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(64));

function renderTransport() {
  return renderHook(() => useTransport(community, channel, true, false), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    ),
  });
}

describe("useTransport channel-switch cost", () => {
  it(
    "[perf] adapts the entire loaded set on render (un-windowed)",
    () => {
      h.folded = { ...h.folded, messages: messages(100) };
      let t = performance.now();
      const r1 = renderTransport();
      const t100 = performance.now() - t;
      expect(r1.result.current.transport.messages).toHaveLength(100);
      r1.unmount();

      h.folded = { ...h.folded, messages: messages(500) };
      t = performance.now();
      const r2 = renderTransport();
      const t500 = performance.now() - t;
      expect(r2.result.current.transport.messages).toHaveLength(500);
      r2.unmount();

      console.log(
        `[perf] useTransport render: 100 msgs ${t100.toFixed(1)}ms · ` +
          `500 msgs ${t500.toFixed(1)}ms (${(t500 / Math.max(t100, 0.1)).toFixed(1)}× for 5× the set)`,
      );

      // Every loaded message is adapted — the passes are not windowed to the
      // rendered slice. Flips if the transport is ever windowed.
      expect(t500).toBeGreaterThan(0);
      expect(t500).toBeLessThan(5000);
    },
    30_000,
  );
});
