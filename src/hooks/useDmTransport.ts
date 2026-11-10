import { useCallback, useMemo, useRef } from "react";

import { sameReactionTallies, toChatMsg } from "@/components/chat/transport";
import { KIND_DM, useDirectMessages } from "@/hooks/useDirectMessages";
import { useDm17Thread } from "@/hooks/useDm17";
import { useDmProtocolPref } from "@/hooks/useDmProtocolPref";
import { reactionContentKey } from "@/hooks/useReactions";
import { dmTimerSeconds, KIND_DM_CHAT } from "@/lib/nip17/protocol";
import { useCurrentUser } from "@/hooks/useCurrentUser";

import type { ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally, SendStatus } from "@/components/chat/transport";
import type { DecryptedDM } from "@/hooks/useDirectMessages";
import type { OpenedDm } from "@/lib/nip17/protocol";
import { t } from "@/i18n";

const EMPTY_TALLIES: ReactionTally[] = [];

/**
 * The merged timeline's skeleton gate. Paint whatever is ready: OR-ing both planes'
 * `isLoading` would let an empty kind-4 relay pull hide ready NIP-17 rows for up to 8s.
 * The one extra hold is NIP-17's first local paint (`dm17FirstPaintReady`, one KV read),
 * so a two-plane thread doesn't flash its synchronously seeded kind-4 half alone.
 */
export function shouldShowDmTimelineLoading(
  mergedMessageCount: number,
  kind4Loading: boolean,
  dm17Loading: boolean,
  dm17FirstPaintReady: boolean,
): boolean {
  if (!dm17FirstPaintReady) return true;
  if (mergedMessageCount > 0) return false;
  return kind4Loading || dm17Loading;
}

/**
 * Thrown by `send` when the peer isn't NIP-17-reachable and the caller hasn't opted into
 * the kind-4 downgrade; the DM page offers an explicit legacy-send affordance.
 */
/**
 * Sort-merge the kind-4 and NIP-17 planes, showing only the range both have
 * loaded: a plane still paging may hold messages older than its oldest row, so
 * the other plane's rows below that point would later have history appear
 * between them. `keepId` (a permalink target) is always shown. Rows sort by
 * `at` (a NIP-17 message's arrival, where its sender's clock was off); the
 * paging floor stays on `created_at`, which is what the planes page by.
 */
export function mergeDmPlanes<M extends { id: string; created_at: number }>(
  kind4: readonly M[],
  dm17: readonly M[],
  kind4Paging: boolean,
  dm17Paging: boolean,
  keepId?: string,
  at: (m: M) => number = (m) => m.created_at,
): M[] {
  if (dm17.length === 0) return kind4 as M[];
  if (kind4.length === 0) return dm17 as M[];
  const oldest = (rows: readonly M[]) => rows.reduce((min, m) => Math.min(min, m.created_at), Infinity);
  let floor = -Infinity;
  if (kind4Paging) floor = Math.max(floor, oldest(kind4));
  if (dm17Paging) floor = Math.max(floor, oldest(dm17));
  return [...kind4, ...dm17]
    .filter((m) => m.created_at >= floor || m.id === keepId)
    .sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : 1));
}

export class LegacyFallbackRequired extends Error {
  constructor() {
    super(t({ id: "useDmTransport.legacyFallbackRequired", defaultMessage: "This person can't receive private (NIP-17) messages yet." }));
    this.name = "LegacyFallbackRequired";
  }
}


/**
 * {@link ChatTransport} for a DM thread, merging legacy kind-4 (NIP-04) with NIP-17 rumors
 * (kind 14/15 plus in-band reactions, deletes, edits). Groups are NIP-17 only.
 * Sends prefer NIP-17; kind-4 leaks metadata, so it's never used silently — `send` throws
 * `LegacyFallbackRequired` unless `{ allowLegacy }`.
 */
export function useDmTransport(
  conversation: string,
  peers: readonly string[],
  focusedRumorId?: string,
): {
  transport: ChatTransport;
  /** Chat rows plus timer-change notices, chronologically interleaved. */
  entries: ChannelTimelineEntry[];
  /** When the newest message counts as sent (its arrival, where recorded): what reading the thread stamps. */
  latestAt: number;
  /**
   * Catch-up still running over an EMPTY thread; separate from `transport.isLoading`
   * (local read only) so the timeline says "Catching up…".
   */
  syncing: boolean;
  /** Timer in seconds (0 = off); NIP-17 plane only. */
  disappearingTimer: number;
  /** The timer for something sent now, waiting for it rather than assuming off. */
  resolveDisappearingTimer: () => Promise<number>;
  setDisappearingTimer: (seconds: number) => void;
  encryptedIds: Set<string>;
  /** Ids of NIP-17 rumors (unsigned; the page passes the `rumor` menu prop). */
  dm17Ids: Set<string>;
  dm17Enabled: boolean;
  decryptVisible: (id: string) => void;
  decryptOne: (id: string) => void;
  decryptAll: () => void;
  decryptDeclined: boolean;
  hasEncrypted: boolean;
  canDm17: boolean;
  /** Deliberately pinned to NIP-04: sends skip the LegacyFallbackRequired opt-in. */
  legacyPinned: boolean;
  /** Resolves once rendered. Throws {@link LegacyFallbackRequired} unless `opts.allowLegacy`. */
  send: (text: string, tags?: string[][], opts?: { allowLegacy?: boolean }) => Promise<void>;
} {
  const { user } = useCurrentUser();
  // Undefined for a group, taking every kind-4 branch to its empty case.
  const legacyPeer = peers.length === 1 ? peers[0] : undefined;
  const {
    messages,
    isLoading,
    syncing,
    send: sendKind4,
    retry: retryKind4,
    loadOlder: loadOlderKind4,
    hasMore: hasMoreKind4,
    isLoadingOlder: isLoadingOlderKind4,
    decryptVisible,
    decryptOne,
    decryptAll,
    decryptDeclined,
    hasEncrypted,
  } = useDirectMessages(legacyPeer);

  const dm17 = useDm17Thread(conversation, focusedRumorId);
  const self = user?.pubkey;
  // A group is never "pinned to NIP-04".
  const { pref: peerPref } = useDmProtocolPref(legacyPeer ?? "");
  const pref = legacyPeer ? peerPref : "auto";

  // Preserve object identity for unchanged messages so React.memo on rows holds.
  const adaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const kind4Messages = useMemo<ChatMsg[]>(() => {
    const cache = adaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = messages.map((m: DecryptedDM) => {
      const sig = `${m.created_at}\u0000${m.content}\u0000${m.status ?? ""}\u0000${m.encrypted ? "1" : "0"}`;
      const hit = cache.get(m.id);
      const entry =
        hit && hit.sig === sig
          ? hit
          : {
              sig,
              msg: toChatMsg({
                id: m.id,
                renderKey: m.renderKey,
                pubkey: m.pubkey,
                created_at: m.created_at,
                kind: KIND_DM,
                content: m.content,
              }),
            };
      next.set(m.id, entry);
      return entry.msg;
    });
    adaptCache.current = next;
    return out;
  }, [messages]);

  const dm17AdaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const dm17Messages = useMemo<ChatMsg[]>(() => {
    const cache = dm17AdaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = dm17.messages.map((m: OpenedDm) => {
      const sig = `${m.createdAt}\u0000${m.content}`;
      const hit = cache.get(m.rumorId);
      const entry =
        hit && hit.sig === sig
          ? hit
          : {
              sig,
              msg: toChatMsg({
                id: m.rumorId,
                pubkey: m.author,
                created_at: m.createdAt,
                kind: m.kind,
                content: m.content,
                tags: m.tags,
              }),
            };
      next.set(m.rumorId, entry);
      return entry.msg;
    });
    dm17AdaptCache.current = next;
    return out;
  }, [dm17.messages]);

  const dm17Ids = useMemo(() => new Set(dm17Messages.map((m) => m.id)), [dm17Messages]);
  // Each message's time for order and read stamps: a NIP-17 one's arrival where recorded.
  const arrivedAt = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of dm17.messages) if (m.arrivedAt !== undefined) out.set(m.rumorId, m.arrivedAt);
    return out;
  }, [dm17.messages]);
  const atOf = useCallback((m: ChatMsg) => arrivedAt.get(m.id) ?? m.created_at, [arrivedAt]);
  // Via a ref: `dm17Ids` changes every history page, which would re-render every row.
  const dm17IdsRef = useRef(dm17Ids);
  dm17IdsRef.current = dm17Ids;
  const dm17KindById = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of dm17.messages) out.set(m.rumorId, m.kind);
    return out;
  }, [dm17.messages]);

  // Ids never collide across planes. A plane that can't page (no NIP-04 signer)
  // holds no floor, or the other plane's history would stay hidden for good.
  const kind4Paging = Boolean(legacyPeer && hasMoreKind4 && user?.signer.nip04);
  const chatMessages = useMemo<ChatMsg[]>(
    () => mergeDmPlanes(kind4Messages, dm17Messages, kind4Paging, dm17.hasMore, focusedRumorId, atOf),
    [kind4Messages, dm17Messages, kind4Paging, dm17.hasMore, focusedRumorId, atOf],
  );
  const latestAt = chatMessages.length > 0 ? atOf(chatMessages[chatMessages.length - 1]) : 0;

  const dm17TimerChanges = dm17.timerChanges;
  const entries = useMemo<ChannelTimelineEntry[]>(() => {
    const out: ChannelTimelineEntry[] = chatMessages.map((message) => ({
      type: "chat" as const,
      id: `chat:${message.id}`,
      createdAt: atOf(message),
      message,
    }));
    for (const change of dm17TimerChanges) {
      const seconds = dmTimerSeconds(change);
      // An unreadable timer rumor is skipped — never guess "off".
      if (seconds === undefined) continue;
      out.push({
        type: "dm-timer",
        id: `dm-timer:${change.rumorId}`,
        createdAt: change.createdAt,
        author: change.author,
        seconds,
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }, [chatMessages, dm17TimerChanges, atOf]);

  const encryptedIds = useMemo(
    () => new Set(messages.filter((m) => m.encrypted).map((m) => m.id)),
    [messages],
  );

  const kind4StatusById = useMemo(() => {
    const out = new Map<string, SendStatus>();
    for (const m of messages) {
      if (m.status === "sending") out.set(m.id, "pending");
      else if (m.status === "failed") out.set(m.id, "failed");
    }
    return out;
  }, [messages]);

  const dm17SendStatusFor = dm17.sendStatusFor;
  const sendStatusFor = useCallback(
    (id: string) => kind4StatusById.get(id) ?? dm17SendStatusFor(id),
    [kind4StatusById, dm17SendStatusFor],
  );

  const retryById = useCallback(
    (event: ChatMsg) => {
      if (dm17IdsRef.current.has(event.id)) dm17.retry(event.id);
      else retryKind4(event.id);
    },
    [dm17.retry, retryKind4], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const discard = useCallback(
    (id: string) => {
      if (dm17IdsRef.current.has(id)) dm17.discard(id);
    },
    [dm17.discard], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Reactions (NIP-17 only): one per (pubkey, key), latest wins.
  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    for (const [targetId, reactions] of dm17.reactionsByTarget) {
      const latest = new Map<string, OpenedDm>();
      for (const r of reactions) {
        const key = `${r.author}:${reactionContentKey(r.content)}`;
        const existing = latest.get(key);
        if (!existing || r.createdAt > existing.createdAt) latest.set(key, r);
      }
      const byKey = new Map<string, { url?: string; pubkeys: string[]; mineEventId?: string }>();
      for (const r of latest.values()) {
        const key = reactionContentKey(r.content);
        let entry = byKey.get(key);
        if (!entry) {
          byKey.set(key, (entry = { url: r.tags.find(([n]) => n === "emoji")?.[2], pubkeys: [] }));
        }
        entry.pubkeys.push(r.author);
        if (self && r.author === self) entry.mineEventId = r.rumorId;
      }
      const tallies: ReactionTally[] = [...byKey.entries()].map(([key, e]) => ({
        key,
        url: e.url,
        count: e.pubkeys.length,
        pubkeys: e.pubkeys,
        mine: e.mineEventId !== undefined,
        mineEventId: e.mineEventId,
      }));
      tallies.sort((a, b) => b.count - a.count);
      out.set(targetId, tallies);
    }
    return out;
  }, [dm17.reactionsByTarget, self]);

  const dm17React = dm17.react;
  const dm17RemoveReaction = dm17.removeReaction;
  // Caches outlive `talliesById` recomputes so rows keep a stable `reactions` prop.
  const reactDeps = useRef({ dm17React, dm17RemoveReaction, dm17KindById });
  reactDeps.current = { dm17React, dm17RemoveReaction, dm17KindById };
  const reactCache = useRef(new Map<string, (input: ReactInput) => void>());
  const reactionCache = useRef(new Map<string, MessageReactions>());
  const reactionsFor = useMemo(() => {
    // Reads collaborators through a ref, so it's stable per message id.
    const reactFor = (id: string) => {
      let fn = reactCache.current.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          const deps = reactDeps.current;
          if (input.mineEventId) deps.dm17RemoveReaction(input.mineEventId);
          else deps.dm17React(id, deps.dm17KindById.get(id) ?? KIND_DM_CHAT, input.content, input.emojiUrl);
        };
        reactCache.current.set(id, fn);
      }
      return fn;
    };
    return (id: string): MessageReactions => {
      const tallies = talliesById.get(id) ?? EMPTY_TALLIES;
      const hit = reactionCache.current.get(id);
      if (hit && sameReactionTallies(hit.tallies, tallies)) return hit;
      const value: MessageReactions = { tallies, react: reactFor(id) };
      reactionCache.current.set(id, value);
      return value;
    };
  }, [talliesById]);

  // Ref with `[]` deps: senders change identity with pending state.
  const dm17WritersRef = useRef({ deleteMessage: dm17.deleteMessage, editMessage: dm17.editMessage });
  dm17WritersRef.current = { deleteMessage: dm17.deleteMessage, editMessage: dm17.editMessage };
  const deleteMessage = useCallback((event: ChatMsg) => {
    if (dm17IdsRef.current.has(event.id)) dm17WritersRef.current.deleteMessage(event.id, event.kind);
  }, []);

  const editMessage = useCallback(async (original: ChatMsg, content: string) => {
    if (!dm17IdsRef.current.has(original.id) || original.kind !== KIND_DM_CHAT) {
      throw new Error(t({ id: "useDmTransport.onlyNip17Editable", defaultMessage: "Only NIP-17 chat messages can be edited" }));
    }
    await dm17WritersRef.current.editMessage(original.id, content);
  }, []);

  const dm17LoadOlder = dm17.loadOlder;
  const loadOlder = useCallback(async () => {
    const [a, b] = await Promise.all([loadOlderKind4(), dm17LoadOlder()]);
    return a + b;
  }, [loadOlderKind4, dm17LoadOlder]);
  const hasMore = kind4Paging || dm17.hasMore;
  const isLoadingOlder = isLoadingOlderKind4 || dm17.isLoadingOlder;

  const dm17Send = dm17.send;
  // When pinned to legacy, NIP-17 is treated as disabled so the UI reflects kind-4.
  const dm17Usable = dm17.canSend;
  const dm17Enabled = dm17Usable && pref !== "nip04";
  const sendText = useCallback(
    async (text: string, tags?: string[][], opts?: { allowLegacy?: boolean }) => {
      // A persisted pin to NIP-04: route kind-4 directly, no LegacyFallbackRequired.
      if (pref === "nip04" && legacyPeer) {
        await sendKind4(text);
        return;
      }
      if (dm17Usable) {
        // Drop `h` group tags and composer `p` mentions: under NIP-17 the `p` set IS the room.
        const extraTags = (tags ?? []).filter(([name]) => name !== "h" && name !== "p");
        await dm17Send(text, extraTags);
      } else if (opts?.allowLegacy && legacyPeer) {
        // Explicit user opt-in only (see LegacyFallbackRequired).
        await sendKind4(text);
      } else {
        throw new LegacyFallbackRequired();
      }
    },
    [pref, dm17Usable, dm17Send, sendKind4, legacyPeer],
  );

  const isLoadingMerged = shouldShowDmTimelineLoading(
    chatMessages.length,
    isLoading,
    dm17.isLoading,
    dm17.firstPaintReady,
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: chatMessages,
      isLoading: isLoadingMerged,
      canWrite: true,
      canModerate: false,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor,
      retry: retryById,
      discard,
      reactionsFor: dm17Enabled || talliesById.size > 0 ? reactionsFor : undefined,
      deleteMessage: dm17Enabled ? deleteMessage : undefined,
      editMessage: dm17Enabled ? editMessage : undefined,
    }),
    [chatMessages, isLoadingMerged, loadOlder, hasMore, isLoadingOlder, sendStatusFor, retryById, discard, reactionsFor, deleteMessage, editMessage, dm17Enabled, talliesById.size],
  );

  return {
    transport,
    entries,
    latestAt,
    syncing,
    disappearingTimer: dm17.timer ?? 0,
    resolveDisappearingTimer: dm17.resolveTimer,
    setDisappearingTimer: dm17.setTimer,
    encryptedIds,
    dm17Ids,
    dm17Enabled,
    decryptVisible,
    decryptOne,
    decryptAll,
    decryptDeclined,
    hasEncrypted,
    canDm17: dm17Enabled,
    legacyPinned: pref === "nip04",
    send: sendText,
  };
}
