/**
 * Regression test for issue #19 — orphan replies must be reachable in the UI.
 *
 * The Concord timeline is Slack-style: a THREAD reply (a NIP-22 kind-1111 comment
 * carrying an uppercase `E` root tag) is excluded from the top-level timeline
 * and surfaced only via `threadRepliesFor(rootId)` on its root's rendered row.
 * If the root is not in the loaded window (older than the 100-rumor window,
 * undecoded, or missing), the reply is an "orphan." Orphans are NOT degraded
 * to top-level rows — they stay bucketed under their root id and are
 * reachable from the Threads tab (which shows a tombstone for the missing
 * root). When the root eventually loads, the tombstone is replaced by the
 * real root and the thread panel shows it normally.
 *
 * A kind-9 `q` is a separate case: it's an INLINE reply, always top-level, so
 * it can never orphan. Both are asserted below.
 */

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { OpenedChat } from "@/concord/lib/chat";
import { buildConcordCommentTags } from "@/concord/lib/chat";
import { KIND_COMMENT, KIND_EDIT, KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import type { Channel, Community } from "@/concord/lib/types";

import { useTransport } from "./useTransport";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  folded: { messages: [] as unknown[], reactions: new Map(), zaps: new Map(), pollVotes: new Map(), calendarEvents: [], rsvps: new Map(), timerNotices: [], quarantined: new Set<string>(), paused: new Set<string>(), ruled: new Set<string>() },
  send: vi.fn(async (_args: Record<string, unknown>) => ({})),
}));

vi.mock("@/concord/hooks/useChannel", () => ({
  useChatModeration: () => ({
    banned: new Set(),
    canDelete: () => false,
    canMentionEveryone: () => false,
  }),
  useChannelTimeline: () => ({
    folded: h.folded,
    raw: [],
    isLoading: false,
    loadOlder: async () => 0,
    hasMore: false,
    isLoadingOlder: false,
  }),
  useSendMessage: () => ({ mutateAsync: h.send }),
  useMessageActions: () => ({ retry: () => {}, discard: () => {}, deleteMessage: () => {} }),
  useSendStatus: () => ({}),
  channelKey: (id: string | null) => ["concord", "channel", id] as const,
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: undefined }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CHANNEL_ID = "aa".repeat(32);

function chat(id: string, content: string, ms: number, tags: string[][] = [], kind = KIND_MESSAGE): OpenedChat {
  return {
    rumorId: id.padEnd(64, "0"),
    author: "b".repeat(64),
    kind,
    content,
    tags: [["channel", CHANNEL_ID], ["epoch", "0"], ...tags],
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

const community = { idHex: "cc".repeat(32), relays: [] } as unknown as Community;
const channel = { idHex: CHANNEL_ID } as unknown as Channel;

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useTransport — issue #19 (orphan replies are unreachable)", () => {
  it("keeps an orphan thread reply out of the top-level timeline but reachable via threadRepliesFor", () => {
    const PARENT_ID = ("11".repeat(32)).padEnd(64, "0"); // NOT in the decoded window (older history)
    const reply = chat(
      "22".repeat(32),
      "thread reply to an old message",
      2_000_000,
      buildConcordCommentTags({ id: PARENT_ID, kind: KIND_MESSAGE, pubkey: "e".repeat(64), tags: [] }),
      KIND_COMMENT,
    );
    const normal = chat("33".repeat(32), "ordinary top-level message", 3_000_000);
    h.folded = { messages: [reply, normal], reactions: new Map(), zaps: new Map(), pollVotes: new Map(), calendarEvents: [], rsvps: new Map(), timerNotices: [], quarantined: new Set<string>(), paused: new Set<string>(), ruled: new Set<string>() };

    const { result } = renderHook(() => useTransport(community, channel, true, false), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });
    const { transport } = result.current;

    // The ordinary message is in the top-level timeline.
    expect(transport.messages.map((m) => m.id)).toContain(normal.rumorId);
    // The orphan reply is NOT shown at the top level — it stays bucketed
    // under its root id so it doesn't clutter the channel with a reply
    // that has no visible parent.
    expect(transport.messages.map((m) => m.id)).not.toContain(reply.rumorId);
    // But it IS reachable via threadRepliesFor(rootId) — the Threads tab
    // uses this to show orphan threads with a tombstone root.
    expect(
      transport.threadRepliesFor?.(PARENT_ID) ?? [],
    ).toContainEqual(expect.objectContaining({ id: reply.rumorId }));
  });

  it("keeps a kind-9 `q` inline reply in the top-level timeline (never a thread)", () => {
    const parent = chat("44".repeat(32), "parent", 1_000_000);
    const inline = chat("55".repeat(32), "inline reply", 2_000_000, [
      ["q", parent.rumorId, "", "b".repeat(64)],
    ]);
    h.folded = { messages: [parent, inline], reactions: new Map(), zaps: new Map(), pollVotes: new Map(), calendarEvents: [], rsvps: new Map(), timerNotices: [], quarantined: new Set<string>(), paused: new Set<string>(), ruled: new Set<string>() };

    const { result } = renderHook(() => useTransport(community, channel, true, false), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });
    const { transport } = result.current;

    // The inline reply renders as a top-level row, not bucketed into a thread.
    expect(transport.messages.map((m) => m.id)).toContain(inline.rumorId);
    expect(transport.replyCountFor?.(parent.rumorId) ?? 0).toBe(0);
  });
});

describe("useTransport — an edit preserves the original's NIP-40 expiration (CORD-08 §2)", () => {
  function editFirstMessage(original: OpenedChat, newBody: string) {
    h.send.mockClear();
    h.folded = { messages: [original], reactions: new Map(), zaps: new Map(), pollVotes: new Map(), calendarEvents: [], rsvps: new Map(), timerNotices: [], quarantined: new Set<string>(), paused: new Set<string>(), ruled: new Set<string>() };
    const { result } = renderHook(() => useTransport(community, channel, true, false), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });
    const msg = result.current.transport.messages.find((m) => m.id === original.rumorId)!;
    return result.current.transport.editMessage!(msg, newBody);
  }

  it("carries the original's exact deadline, not one recomputed from the edit's clock", async () => {
    const deadline = 1_900_000_000; // the original's signed deadline, well in the future
    await editFirstMessage(chat("66".repeat(32), "typo", 1_000_000, [["expiration", String(deadline)]]), "fixed");

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ kind: KIND_EDIT, expiration: deadline }));
  });

  it("pins `null` when the original carried no expiration, so a timer turned on since can't make the edit disappear", async () => {
    await editFirstMessage(chat("77".repeat(32), "typo", 1_000_000), "fixed");

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ kind: KIND_EDIT, expiration: null }));
  });
});
