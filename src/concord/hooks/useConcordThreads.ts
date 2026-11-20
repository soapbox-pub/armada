import { useCallback, useEffect, useMemo, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { useChannelRules } from "@/concord/hooks/useChannelRules";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { foldTimeline, replyTargetOf, type OpenedChat } from "@/concord/lib/chat";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import type { Channel, Community } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";
import { concordThreadReadKey, useReadStateActions, useReadStateSelect } from "@/hooks/useReadState";
import type { ReadStateMap } from "@/contexts/ReadStateContext";

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
  const { markRead: sharedMarkRead, getLastRead } = useReadStateActions();
  const communityIdHex = community?.idHex;
  // Required so the fold applies the Banlist and moderator deletes (CORD-04 §4);
  // without it banned authors' replies inflate counts and "new" dots.
  const moderation = useChatModeration(community);
  const rulesFor = useChannelRules(community, channels, active);

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { byChannel: rumorsByChannel, isLoading } = useCommunityRumors(communityIdHex, channelIds);

  // Pure computation over the shared scan, after paint and a channel at a time: it
  // folds every channel's window, which in one task blocked a phone for ~0.3 s on
  // every community switch. Channels whose inputs are unchanged reuse their scan.
  const [scan, setScan] = useState<{ key: string; value: ScannedThread[] | undefined }>();
  useEffect(() => {
    if (!communityIdHex) return;
    let cancelled = false;
    const run = async () => {
      // Withheld until the Banlist is folded (see `ChatModerationState.ready`).
      if (!moderation.ready) {
        setScan({ key: communityIdHex, value: undefined });
        return;
      }
      const out: ScannedThread[] = [];
      let sliceStart = performance.now();
      for (const [idHex, rumors] of rumorsByChannel) {
        if (performance.now() - sliceStart >= SCAN_SLICE_MS) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (cancelled) return;
          sliceStart = performance.now();
        }
        out.push(...scanChannelCached(idHex, rumors, moderation, rulesFor(idHex), pubkey, mutedPubkeys));
      }
      out.sort((a, b) => b.lastReplyAt - a.lastReplyAt);
      if (!cancelled) setScan({ key: communityIdHex, value: out });
    };
    const handle = setTimeout(() => void run(), 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [communityIdHex, rumorsByChannel, pubkey, mutedPubkeys, moderation, rulesFor]);
  const scanned = scan && scan.key === communityIdHex ? scan.value : undefined;

  // Subscribed to these stamps only: the read-state changes on every markRead anywhere.
  const scannedList = scanned ?? NO_SCANNED;
  const threadReadSig = useReadStateSelect(useCallback((map: ReadStateMap) => {
    let sig = "";
    for (const t of scannedList) sig += `${map[concordThreadReadKey(t.rootId)] ?? 0},`;
    return sig;
  }, [scannedList]));
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
          t.lastReplyAt > getLastRead(concordThreadReadKey(t.rootId)),
      }));
    },
    [scannedList, threadReadSig, pubkey, getLastRead],
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

/** Max unbroken scan time before yielding to the page. */
const SCAN_SLICE_MS = 8;

type Moderation = ReturnType<typeof useChatModeration>;
type Rules = ReturnType<ReturnType<typeof useChannelRules>>;

/** Each channel's scan by its rumor array, which stays the same object while the channel doesn't change. */
const scannedByRumors = new WeakMap<
  readonly OpenedChat[],
  { moderation: Moderation; rules: Rules; pubkey: string | undefined; muted: ReadonlySet<string>; threads: ScannedThread[] }
>();

function scanChannelCached(
  idHex: string,
  rumors: OpenedChat[],
  moderation: Moderation,
  rules: Rules,
  pubkey: string | undefined,
  muted: ReadonlySet<string>,
): ScannedThread[] {
  const hit = scannedByRumors.get(rumors);
  if (hit && hit.moderation === moderation && hit.rules === rules && hit.pubkey === pubkey && hit.muted === muted) return hit.threads;
  const threads = scanChannel(idHex, rumors, moderation, rules, pubkey, muted);
  scannedByRumors.set(rumors, { moderation, rules, pubkey, muted, threads });
  return threads;
}

/** The threads of one channel's window the viewer took part in. */
function scanChannel(
  idHex: string,
  rumors: OpenedChat[],
  moderation: Moderation,
  rules: Rules,
  pubkey: string | undefined,
  mutedPubkeys: ReadonlySet<string>,
): ScannedThread[] {
  const out: ScannedThread[] = [];
  // Muted authors are dropped before folding; a muted ROOT degrades to a tombstone.
  const folded = foldTimeline(rumors, moderation, { ...(pubkey !== undefined ? { self: pubkey } : {}), ...rules });
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
  return out;
}

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
