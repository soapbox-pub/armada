/**
 * Regression test for issue #19 — orphan replies are unreachable in the UI.
 *
 * The V2 timeline is Slack-style: a THREAD reply (a NIP-22 kind-1111 comment
 * carrying an uppercase `E` root tag) is excluded from the top-level timeline
 * and surfaced only via `threadRepliesFor(rootId)` on its root's rendered row.
 * If the root is not in the loaded window (older than the 100-rumor window,
 * undecoded, or missing), the reply is bucketed under a row that never renders:
 * no message, no thread badge, no way to reach it. The user is notified (the
 * native service decrypts the wrap directly) but the client never shows the
 * message — at ANY traffic volume, on every platform, deterministically.
 *
 * A kind-9 `q` is a separate case: it's an INLINE reply, always top-level, so
 * it can never orphan. Both are asserted below.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OpenedChat } from "@/concord-v2/lib/chat";
import { buildV2CommentTags } from "@/concord-v2/lib/chat";
import { KIND_COMMENT, KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import { useTransport2 } from "./useTransport2";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  folded: { messages: [] as unknown[], reactions: new Map(), zaps: new Map() },
}));

vi.mock("@/concord-v2/hooks/useChannel2", () => ({
  useChannelTimeline2: () => ({
    folded: h.folded,
    isLoading: false,
    loadOlder: async () => 0,
    hasMore: false,
    isLoadingOlder: false,
  }),
  useSendMessage2: () => ({ mutateAsync: async () => ({}) }),
  useMessageActions2: () => ({ retry: () => {}, discard: () => {}, deleteMessage: () => {} }),
  useSendStatus2: () => ({}),
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

const community = { idHex: "cc".repeat(32), relays: [] } as unknown as CommunityV2;
const channel = { idHex: CHANNEL_ID } as unknown as ChannelV2;

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useTransport2 — issue #19 (orphan replies are unreachable)", () => {
  it("keeps every decoded message reachable from the rendered timeline, even a thread reply whose root is outside the window", () => {
    const PARENT_ID = ("11".repeat(32)).padEnd(64, "0"); // NOT in the decoded window (older history)
    const reply = chat(
      "22".repeat(32),
      "thread reply to an old message",
      2_000_000,
      buildV2CommentTags({ id: PARENT_ID, kind: KIND_MESSAGE, pubkey: "e".repeat(64), tags: [] }),
      KIND_COMMENT,
    );
    const normal = chat("33".repeat(32), "ordinary top-level message", 3_000_000);
    h.folded = { messages: [reply, normal], reactions: new Map(), zaps: new Map() };

    const { result } = renderHook(() => useTransport2(community, channel, true, false));
    const { transport } = result.current;

    // Everything the UI can possibly render: the top-level rows plus the
    // thread replies reachable from those rows.
    const reachable = new Set(transport.messages.map((m) => m.id));
    for (const m of transport.messages) {
      for (const r of transport.threadRepliesFor?.(m.id) ?? []) reachable.add(r.id);
    }

    expect(reachable.has(normal.rumorId)).toBe(true);
    // A thread reply whose root is outside the loaded window must still be
    // reachable — it degrades to a top-level row until its root materializes.
    expect(
      reachable.has(reply.rumorId),
      "a decoded thread reply whose root is outside the loaded window must still be reachable in the UI",
    ).toBe(true);
  });

  it("keeps a kind-9 `q` inline reply in the top-level timeline (never a thread)", () => {
    const parent = chat("44".repeat(32), "parent", 1_000_000);
    const inline = chat("55".repeat(32), "inline reply", 2_000_000, [
      ["q", parent.rumorId, "", "b".repeat(64)],
    ]);
    h.folded = { messages: [parent, inline], reactions: new Map(), zaps: new Map() };

    const { result } = renderHook(() => useTransport2(community, channel, true, false));
    const { transport } = result.current;

    // The inline reply renders as a top-level row, not bucketed into a thread.
    expect(transport.messages.map((m) => m.id)).toContain(inline.rumorId);
    expect(transport.replyCountFor?.(parent.rumorId) ?? 0).toBe(0);
  });
});
