import { useCallback, useMemo, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIdleMemo } from "@/hooks/useIdleMemo";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { useChannelRules } from "@/concord/hooks/useChannelRules";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { foldTimeline, replyTargetOf, type OpenedChat } from "@/concord/lib/chat";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import type { Channel, Community } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";
import { concordThreadReadKey, useReadState } from "@/hooks/useReadState";

/** Whether the root is a tombstone placeholder for a not-yet-loaded root message. */
export function isTombstoneRoot(root: ChatMsg): boolean {
  return root.pubkey === TOMBSTONE_PUBKEY;
}

/** Synthetic pubkey used to mark a tombstone root (never a real one). */
const TOMBSTONE_PUBKEY = "\u0000tombstone";

/** A thread the current user has participated in, summarized for the tab. */
export interface ConcordThread {
  root: ChatMsg;
  channelIdHex: string;
  replyCount: number;
  /** Newest reply's `created_at` (unix SECONDS) — the sort/recency key. */
  lastReplyAt: number;
  /** Distinct repliers, newest-first (for an avatar stack). */
  participants: string[];
  /** A reply newer than the user last saw this thread (never self-authored). */
  hasNew: boolean;
}

/**
 * Threads the user participated in (authored the root or any reply), newest
 * reply first, derived purely from {@link useCommunityRumors}.
 *
 * "New" is per-thread via `c2t:<rootRumorId>` stamps in the shared read-state
 * map (synced via NIP-78). Reading a channel also advances its threads' stamps
 * (the open-channel effect in ConcordPage).
 */
export function useConcordThreads(community: Community | undefined, channels: Channel[], active = false): {
  threads: ConcordThread[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (rootId: string, timestamp: number) => void;
  markAllRead: () => void;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const { mutedPubkeys } = useMutedPubkeys();
  const { readState, markRead: sharedMarkRead } = useReadState();
  const communityIdHex = community?.idHex;
  // Required so the fold applies the Banlist and moderator deletes (CORD-04 §4);
  // without it banned authors' replies inflate counts and "new" dots.
  const moderation = useChatModeration(community);
  const rulesFor = useChannelRules(community, channels, active);

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { byChannel: rumorsByChannel, isLoading } = useCommunityRumors(communityIdHex, channelIds);

  // Pure computation over the shared scan; deferred off the render path since it
  // folds every channel's window.
  const scanned = useIdleMemo<ScannedThread[] | undefined>(communityIdHex ?? null, () => {
    // Withheld until the Banlist is folded (see `ChatModerationState.ready`).
    if (!moderation.ready) return undefined;
    const out: ScannedThread[] = [];

    for (const [idHex, rumors] of rumorsByChannel) {
      // Muted authors are dropped before folding; a muted ROOT degrades to a tombstone.
      const folded = foldTimeline(rumors, moderation, { ...(pubkey !== undefined ? { self: pubkey } : {}), ...rulesFor(idHex) });
      const messages = folded.messages.filter(
        (m) => !mutedPubkeys.has(m.author) && !folded.quarantined.has(m.rumorId),
      );
      const byId = new Map(messages.map((m) => [m.rumorId, m]));

      // Thread replies are NIP-22 kind-1111 (uppercase `E` root); a kind-9 `q` is
      // an inline reply, never a thread.
      const repliesByRoot = new Map<string, OpenedChat[]>();
      for (const m of messages) {
        const root = replyTargetOf(m);
        if (!root) continue;
        const list = repliesByRoot.get(root) ?? [];
        list.push(m);
        repliesByRoot.set(root, list);
      }

      for (const [rootId, replies] of repliesByRoot) {
        const rootMsg = byId.get(rootId);
        const authoredRoot = rootMsg?.author === pubkey;
        const authoredReply = replies.some((r) => r.author === pubkey);
        if (!authoredRoot && !authoredReply) continue;

        replies.sort((a, b) => a.ms - b.ms);
        const newest = replies[replies.length - 1];

        const participants: string[] = [];
        const seen = new Set<string>();
        for (let i = replies.length - 1; i >= 0; i--) {
          const a = replies[i].author;
          if (!seen.has(a)) {
            seen.add(a);
            participants.push(a);
          }
        }

        // Orphan root (outside the scan window / undecoded): a tombstone keeps the
        // thread listed; the real root replaces it once loaded.
        const rootChatMsg: ChatMsg = rootMsg
          ? openedToChatMsg(rootMsg)
          : makeTombstoneRoot(rootId);

        out.push({
          root: rootChatMsg,
          rootId,
          newestReplyAuthor: newest.author,
          channelIdHex: idHex,
          replyCount: replies.length,
          lastReplyAt: newest.createdAt,
          participants,
        });
      }
    }

    out.sort((a, b) => b.lastReplyAt - a.lastReplyAt);
    return out;
  }, [rumorsByChannel, pubkey, mutedPubkeys, moderation, rulesFor]);

  // Depends on these stamps only, not `readState` (a new object on every markRead).
  const readStateRef = useRef(readState);
  readStateRef.current = readState;
  const scannedList = scanned ?? NO_SCANNED;
  let threadReadSig = "";
  for (const t of scannedList) threadReadSig += `${readState[concordThreadReadKey(t.rootId)] ?? 0},`;
  const threads = useMemo<ConcordThread[]>(
    () => {
      void threadReadSig;
      return scannedList.map((t) => ({
        root: t.root,
        channelIdHex: t.channelIdHex,
        replyCount: t.replyCount,
        lastReplyAt: t.lastReplyAt,
        participants: t.participants,
        hasNew:
          t.newestReplyAuthor !== pubkey &&
          t.lastReplyAt > (readStateRef.current[concordThreadReadKey(t.rootId)] ?? 0),
      }));
    },
    [scannedList, threadReadSig, pubkey],
  );

  const markRead = useCallback(
    (rootId: string, timestamp: number) => {
      if (timestamp <= 0) return;
      sharedMarkRead(concordThreadReadKey(rootId), timestamp);
    },
    [sharedMarkRead],
  );

  const hasNew = useMemo(() => threads.some((t) => t.hasNew), [threads]);

  // Monotonic, like the single-thread `markRead`.
  const markAllRead = useCallback(() => {
    for (const t of threads) {
      if (t.hasNew) markRead(t.root.id, t.lastReplyAt);
    }
  }, [threads, markRead]);

  const loading = isLoading || scanned === undefined;
  return useMemo(
    () => ({ threads, isLoading: loading, hasNew, markRead, markAllRead }),
    [threads, loading, hasNew, markRead, markAllRead],
  );
}

interface ScannedThread {
  root: ChatMsg;
  rootId: string;
  newestReplyAuthor: string;
  channelIdHex: string;
  replyCount: number;
  lastReplyAt: number;
  participants: string[];
}

const NO_SCANNED: ScannedThread[] = [];

/** Placeholder root for a thread whose root isn't loaded (see {@link isTombstoneRoot}). */
function makeTombstoneRoot(rootId: string): ChatMsg {
  const ev: NostrEvent = {
    id: rootId,
    pubkey: TOMBSTONE_PUBKEY,
    created_at: 0,
    kind: 9,
    tags: [],
    content: "",
    sig: "",
  };
  return ev;
}
