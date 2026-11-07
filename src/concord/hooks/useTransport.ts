import { useCallback, useContext, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useChannelTimeline,
  useChatModeration,
  useMessageActions,
  useSendMessage,
  useSendStatus,
  type ChannelTimelineFocus,
} from "@/concord/hooks/useChannel";
import { AppContext } from "@/contexts/AppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { KIND_CALENDAR_RSVP, KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_ONCHAIN_ZAP, KIND_POLL, KIND_POLL_VOTE, KIND_REACTION, KIND_ZAP } from "@/concord/lib/kinds";
import { markReactionDeleted, type OpenedChat } from "@/concord/lib/chat";
import { expirationOf, timerNoticeSeconds } from "@/concord/lib/disappearing";
import { sendRefusal } from "@/concord/lib/sendRateLimit";
import { hasEveryoneMention } from "@/concord/lib/everyoneMention";
import { channelKey, type TimelineSpan } from "@/concord/hooks/useChannel";
import type { DmTimerTimelineEntry } from "@/components/chat/channelTimeline";
import { buildCalendarTags, type CalendarEvent, type CalendarEventInput, type CalendarTransport, parseCalendarEvents, type RsvpStatus, type RsvpTally, tallyRsvps } from "@/lib/calendar";
import { buildPollTags, parsePoll, tallyPollVotes, type PollTally, type PollVote } from "@/lib/polls";
import { zapRumorTags, type ZapTally } from "@/lib/zaps";
import type { Channel, Community } from "@/concord/lib/types";

import { sameReactionTallies, stableZapsFor, toChatMsg } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport, MessageCalendar, MessagePoll, MessageReactions, OnchainZapAnnouncement, PollDraft, ReactInput, ReactionTally, ZapPayment } from "@/components/chat/transport";
import { t } from "@/i18n";

/** Stable empties, so memoized rows keep constant props. */
const EMPTY_TALLIES: ReactionTally[] = [];

const EMPTY_REPLIES: ChatMsg[] = [];

const EMPTY_VOTES: PollVote[] = [];

/**
 * The thread-root rumor id (NIP-22 kind-1111 with uppercase `E`), or undefined.
 * A kind-9 `q` is an INLINE reply, not a thread.
 */
function replyRootOf(m: ChatMsg): string | undefined {
  return m.kind === KIND_COMMENT ? m.tags.find((t) => t[0] === "E")?.[1] : undefined;
}

/** Adapt a decrypted Concord chat event to the shared `ChatMsg` shape. */
export function openedToChatMsg(m: OpenedChat): ChatMsg {
  return toChatMsg({
    id: m.rumorId,
    pubkey: m.author,
    created_at: Math.floor(m.ms / 1000),
    kind: m.kind,
    tags: m.tags,
    content: m.content,
  });
}

/**
 * A {@link ChatTransport} for one Concord channel, binding Concord to the same
 * chat components NIP-29 and DMs use.
 */
export function useTransport(
  community: Community | undefined,
  channel: Channel | undefined,
  canWrite: boolean,
  canModerate: boolean,
  /** The route's channel id, for the pre-fold snapshot seed (see useChannelTimeline). */
  routeChannelIdHex?: string | null,
  /** Exact message/thread targets parsed from the active route. */
  focus?: ChannelTimelineFocus,
): {
  transport: ChatTransport;
  /** The `created_at` range the timeline shows; `to` is set while a detached run is shown. */
  span: TimelineSpan | undefined;
  reactionsFor: (id: string) => MessageReactions;
  /** The full decoded message list (member enumeration, reply resolution). */
  allMessages: ChatMsg[];
  /** The channel's calendar events + RSVPs, for the shared events bar. */
  calendar: CalendarTransport;
  /**
   * Disappearing-messages timer notices (CORD-08 §4) as timeline entries; merged
   * via {@link mergeChannelTimeline}.
   */
  timerEntries: DmTimerTimelineEntry[];
  /** Opened rows by rumor id — the ONLY place the original seal (needed for pins) survives. */
  openedById: Map<string, OpenedChat>;
  /** The fold's earned-trust set (`FoldedTimeline.trusted`), for the media hold. */
  trustedAuthors: ReadonlySet<string>;
} {
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const queryClient = useQueryClient();
  const {
    folded,
    raw,
    isLoading,
    loadOlder,
    hasMore,
    isLoadingOlder,
    span,
    hasNewer,
    loadNewer,
    isLoadingNewer,
    returnToPresent,
  } = useChannelTimeline(
    community,
    channel,
    routeChannelIdHex,
    focus,
  );
  const { mutateAsync: send } = useSendMessage(community, channel);
  const moderation = useChatModeration(community);
  const { retry, discard, deleteMessage } = useMessageActions(community, channel);
  const sendStatus = useSendStatus(channel);

  // Unchanged rows keep their reference so React.memo skips them.
  const adaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const messages = useMemo<ChatMsg[]>(() => {
    const cache = adaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = folded.messages.map((m) => {
      const sig = `${m.kind}\u0000${m.ms}\u0000${m.content}`;
      const hit = cache.get(m.rumorId);
      const entry = hit && hit.sig === sig ? hit : { sig, msg: openedToChatMsg(m) };
      next.set(m.rumorId, entry);
      return entry.msg;
    });
    adaptCache.current = next;
    return out;
  }, [folded.messages]);

  // Thread replies (kind-1111 with `E`) are nested under their root, not shown
  // top-level; inline replies (kind-9 `q`) stay in the timeline. Orphan replies
  // stay bucketed (the Threads tab shows a tombstone root).
  const replyBucketCache = useRef(new Map<string, ChatMsg[]>());
  const { topLevel, repliesByRoot } = useMemo(() => {
    const topLevel: ChatMsg[] = [];
    const buckets = new Map<string, ChatMsg[]>();
    for (const m of messages) {
      const root = replyRootOf(m);
      if (root) {
        const list = buckets.get(root) ?? [];
        list.push(m);
        buckets.set(root, list);
      } else {
        topLevel.push(m);
      }
    }
    // Unchanged buckets keep their array identity: they're `replies` props on
    // memoized rows.
    const cache = replyBucketCache.current;
    const repliesByRoot = new Map<string, ChatMsg[]>();
    for (const [root, list] of buckets) {
      list.sort((a, b) => a.created_at - b.created_at);
      const prev = cache.get(root);
      const unchanged = prev && prev.length === list.length && prev.every((m, i) => m === list[i]);
      repliesByRoot.set(root, unchanged ? prev : list);
    }
    replyBucketCache.current = repliesByRoot;
    return { topLevel, repliesByRoot };
  }, [messages]);

  const replyCountFor = useCallback((id: string) => repliesByRoot.get(id)?.length ?? 0, [repliesByRoot]);
  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => repliesByRoot.get(rootId) ?? EMPTY_REPLIES,
    [repliesByRoot],
  );
  const sendThreadReply = useCallback(
    async (root: ChatMsg, content: string, tags: string[][]) => {
      // Sealed as NIP-22 kind-1111; `send` derives thread pointers from `root`. Drop
      // `h`/`e`/`q` (a `q` would be an inline quote), as the page's `handleSend` does.
      const extraTags = tags.filter(([name]) => name !== "h" && name !== "e" && name !== "q");
      await send({
        content,
        replyTo: { id: root.id, kind: root.kind, pubkey: root.pubkey, tags: root.tags },
        extraTags,
      });
    },
    [send],
  );

  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    for (const [targetId, byEmoji] of folded.reactions) {
      const tallies: ReactionTally[] = [];
      for (const [emoji, entry] of byEmoji) {
        const mine = Boolean(user && entry.reactors.has(user.pubkey));
        // Concord folds its own tallies, so apply the mute filter here; a tally emptied
        // by muting is dropped.
        const reactors = [...entry.reactors.keys()].filter((pk) => !mutedPubkeys.has(pk));
        if (reactors.length === 0) continue;
        tallies.push({
          key: emoji,
          url: entry.url,
          count: reactors.length,
          pubkeys: reactors,
          ...(entry.urls ? { urls: reactors.map((pk) => entry.urls!.get(pk)) } : {}),
          mine,
          mineEventId: mine ? entry.reactors.get(user!.pubkey) : undefined,
        });
      }
      tallies.sort((a, b) => b.count - a.count);
      out.set(targetId, tallies);
    }
    return out;
  }, [folded.reactions, user, mutedPubkeys]);

  const channelIdHex = channel?.idHex ?? null;

  // For the NIP-25 `p` tag on reactions; it lives inside the encrypted rumor.
  const authorById = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of messages) out.set(m.id, m.pubkey);
    return out;
  }, [messages]);

  // Both caches outlive a `talliesById` recompute (which rebuilds every array),
  // so memoized rows keep their `reactions` prop. The react fn reads through a ref.
  const reactDeps = useRef({ send, queryClient, channelIdHex, authorById });
  reactDeps.current = { send, queryClient, channelIdHex, authorById };
  const reactCacheRef = useRef(new Map<string, (input: ReactInput) => void>());
  const reactionCacheRef = useRef(new Map<string, MessageReactions>());
  const reactionsFor = useMemo(() => {
    const reactCache = reactCacheRef.current;
    const reactFor = (id: string) => {
      let fn = reactCache.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          const { send, queryClient, channelIdHex, authorById } = reactDeps.current;
          if (input.mineEventId) {
            // Optimistic removal: mark deleted now and strip from the query cache.
            markReactionDeleted(input.mineEventId);
            queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
              old.filter((m) => m.rumorId !== input.mineEventId),
            );
            // The kind-5 delete; the store's NIP-09 handling removes it durably.
            void send({
              content: "",
              kind: KIND_DELETE,
              target: input.mineEventId,
              targetKind: KIND_REACTION,
            }).catch(() => {});
          } else {
            void send({
              content: input.content,
              kind: KIND_REACTION,
              target: id,
              targetPubkey: authorById.get(id),
              extraTags: customEmojiReactionTags(input.content, input.emojiUrl),
            }).catch(() => {});
          }
        };
        reactCache.set(id, fn);
      }
      return fn;
    };
    const objCache = reactionCacheRef.current;
    return (id: string): MessageReactions => {
      const tallies = talliesById.get(id) ?? EMPTY_TALLIES;
      const hit = objCache.get(id);
      if (hit && sameReactionTallies(hit.tallies, tallies)) return hit;
      const value: MessageReactions = { tallies, react: reactFor(id) };
      objCache.set(id, value);
      return value;
    };
  }, [talliesById]);

  // CORD.md zap tallies (only VERIFIED zaps reach the fold).
  const zapTalliesById = useMemo(() => {
    const out = new Map<string, ZapTally>();
    for (const [targetId, entries] of folded.zaps) {
      if (entries.length === 0) continue;
      const zaps = [...entries].sort((a, b) => b.sats - a.sats);
      out.set(targetId, {
        totalSats: zaps.reduce((sum, z) => sum + z.sats, 0),
        count: zaps.length,
        mine: Boolean(user && zaps.some((z) => z.pubkey === user.pubkey)),
        zaps,
      });
    }
    return out;
  }, [folded.zaps, user]);

  const zapsFor = useMemo(() => stableZapsFor((id) => zapTalliesById.get(id)), [zapTalliesById]);

  // CORD.md zap announcement: a kind-9735 rumor with the payment proof, via `send`.
  const sendZap = useCallback(
    async (target: ChatMsg, payment: ZapPayment) => {
      if (!payment.preimage) throw new Error(t({ id: "useTransport.privateZapNeedsProof", defaultMessage: "A private zap needs its payment proof." }));
      await send({
        content: payment.comment,
        kind: KIND_ZAP,
        target: target.id,
        extraTags: zapRumorTags({
          targetId: target.id,
          targetKind: target.kind,
          recipient: target.pubkey,
          amountMsats: payment.amountMsats,
          bolt11: payment.bolt11,
          preimage: payment.preimage,
          omitTarget: true, // send() adds the e target itself
        }),
      });
    },
    [send],
  );

  // On-chain zap attribution (kind 8333) sealed in-channel: publishing it would
  // leak the target and community context.
  const sendOnchainZap = useCallback(
    async (target: ChatMsg, announcement: OnchainZapAnnouncement) => {
      const isAddressable = target.kind >= 30000 && target.kind < 40000;
      const tags: string[][] = [
        ["i", `bitcoin:tx:${announcement.txid}`],
        ["p", target.pubkey],
        ["amount", String(announcement.amountSats)],
      ];
      if (isAddressable) {
        const dTag = target.tags.find(([n]) => n === "d")?.[1] ?? "";
        tags.push(["a", `${target.kind}:${target.pubkey}:${dTag}`]);
      }
      tags.push(["k", String(target.kind)]);
      tags.push(["alt", `Bitcoin zap: ${announcement.amountSats.toLocaleString()} sats`]);
      await send({
        content: announcement.comment,
        kind: KIND_ONCHAIN_ZAP,
        target: target.id,
        extraTags: tags,
      });
    },
    [send],
  );

  // Each poll tallied against its own options + endsAt via {@link tallyPollVotes}.
  const pollTalliesById = useMemo(() => {
    const out = new Map<string, PollTally>();
    for (const m of messages) {
      if (m.kind !== KIND_POLL) continue;
      const { options, endsAt } = parsePoll(m);
      const votes = folded.pollVotes.get(m.id) ?? EMPTY_VOTES;
      out.set(m.id, tallyPollVotes(votes, options, endsAt, user?.pubkey));
    }
    return out;
  }, [messages, folded.pollVotes, user]);

  // A vote is a kind-1018 side event `e`-tagging the poll; latest per pubkey wins.
  const sendPollVote = useCallback(
    (pollId: string, optionIds: string[]) => {
      void send({
        content: "",
        kind: KIND_POLL_VOTE,
        target: pollId,
        extraTags: optionIds.map((id) => ["response", id]),
      }).catch(() => {});
    },
    [send],
  );

  const pollFor = useMemo(() => {
    const voteCache = new Map<string, (optionIds: string[]) => void>();
    const voteFor = (id: string) => {
      let fn = voteCache.get(id);
      if (!fn) voteCache.set(id, (fn = (optionIds) => sendPollVote(id, optionIds)));
      return fn;
    };
    const objCache = new Map<string, { tally: PollTally; value: MessagePoll }>();
    return (id: string): MessagePoll | undefined => {
      const tally = pollTalliesById.get(id);
      if (!tally) return undefined;
      const hit = objCache.get(id);
      if (hit && hit.tally === tally) return hit.value;
      const value: MessagePoll = { tally, vote: voteFor(id) };
      objCache.set(id, { tally, value });
      return value;
    };
  }, [pollTalliesById, sendPollVote]);

  // A new poll is a kind-1068 message; no NIP-88 `relay` tag (votes ride the sealed plane).
  const sendPoll = useCallback(
    async (draft: PollDraft) => {
      const question = draft.question.trim();
      await send({
        content: question,
        kind: KIND_POLL,
        extraTags: buildPollTags(question, draft.options, draft.pollType, draft.durationDays),
      });
    },
    [send],
  );

  // Calendar events (CORD.md), parsed/deduped by the helper NIP-29 uses.
  const calendarEvents = useMemo(
    () => parseCalendarEvents(folded.calendarEvents.map(openedToChatMsg)),
    [folded.calendarEvents],
  );
  const rsvpsFor = useCallback(
    (event: CalendarEvent): RsvpTally => tallyRsvps(folded.rsvps.get(event.event.id) ?? [], user?.pubkey),
    [folded.rsvps, user?.pubkey],
  );
  // A calendar event (kind 31922/31923); not a timeline message.
  const saveCalendar = useCallback(
    async (input: CalendarEventInput) => {
      await send({ content: input.description ?? "", kind: input.kind, extraTags: buildCalendarTags(input) });
    },
    [send],
  );
  const removeCalendar = useCallback(
    async (event: CalendarEvent) => {
      await send({ content: "", kind: KIND_DELETE, target: event.event.id, targetKind: event.kind });
    },
    [send],
  );
  // An RSVP (kind 31925) side event; latest per pubkey wins.
  const setRsvp = useCallback(
    (event: CalendarEvent, status: RsvpStatus) => {
      void send({
        content: "",
        kind: KIND_CALENDAR_RSVP,
        target: event.event.id,
        extraTags: [["status", status], ["k", String(event.kind)], ["p", event.event.pubkey]],
      }).catch(() => {});
    },
    [send],
  );
  const calendar = useMemo<CalendarTransport>(
    () => ({
      events: calendarEvents,
      canModerate,
      canRsvp: canWrite,
      isSaving: false,
      isSettingRsvp: false,
      save: saveCalendar,
      remove: removeCalendar,
      rsvpsFor,
      setRsvp,
    }),
    [calendarEvents, canModerate, canWrite, saveCalendar, removeCalendar, rsvpsFor, setRsvp],
  );

  // Calendar events also render inline, slotted by announcement time.
  const calendarMsgs = useMemo<ChatMsg[]>(() => calendarEvents.map((c) => c.event as ChatMsg), [calendarEvents]);
  // Clipped to the span the channel has loaded whole, so no row sits beside a
  // silent gap. Threads and member lists keep reading every loaded row.
  const timeline = useMemo<ChatMsg[]>(() => {
    const merged = calendarMsgs.length === 0
      ? topLevel
      : [...topLevel, ...calendarMsgs].sort((a, b) =>
          a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
        );
    if (!span) return merged;
    const shown = merged.filter((m) => m.created_at >= span.from && (span.to === undefined || m.created_at <= span.to));
    return shown.length === merged.length ? merged : shown;
  }, [topLevel, calendarMsgs, span]);

  // The first row of each epoch run gets a key-rotation divider. Epochs come from
  // the fold; ChatMsg deliberately doesn't carry them.
  const rotationDividerIds = useMemo<ReadonlySet<string> | undefined>(() => {
    const epochById = new Map<string, bigint>();
    for (const m of folded.messages) epochById.set(m.rumorId, m.epoch);
    for (const c of folded.calendarEvents) epochById.set(c.rumorId, c.epoch);
    let prev: bigint | undefined;
    let ids: Set<string> | undefined;
    for (const m of timeline) {
      const epoch = epochById.get(m.id);
      if (epoch === undefined) continue;
      if (prev !== undefined && epoch !== prev) (ids ??= new Set()).add(m.id);
      prev = epoch;
    }
    return ids;
  }, [timeline, folded.messages, folded.calendarEvents]);

  // From the fold, which saw thread replies too (so only ever `has()`, never
  // counted). `undefined` when empty.
  // With folding off, only a community pause still collapses rows.
  const foldSimilar = useContext(AppContext)?.config.foldSimilarMessages ?? true;
  const quarantinedIds = useMemo<ReadonlySet<string> | undefined>(() => {
    const ids = foldSimilar ? folded.quarantined : folded.paused;
    return ids.size > 0 ? ids : undefined;
  }, [foldSimilar, folded.quarantined, folded.paused]);
  // Which of those a community pause collapsed, so the row can say why (CORD-04 §8).
  const pausedIds = useMemo<ReadonlySet<string> | undefined>(
    () => (folded.paused.size > 0 ? folded.paused : undefined),
    [folded.paused],
  );

  // Identity-stable between changes so unchanged calendar rows keep their prop.
  const calendarMessages = useMemo(() => {
    const map = new Map<string, MessageCalendar>();
    for (const c of calendarEvents) {
      map.set(c.event.id, {
        event: c,
        tally: rsvpsFor(c),
        canRsvp: canWrite,
        isSettingRsvp: false,
        setRsvp: (status) => setRsvp(c, status),
      });
    }
    return map;
  }, [calendarEvents, rsvpsFor, canWrite, setRsvp]);
  const calendarFor = useCallback((id: string) => calendarMessages.get(id), [calendarMessages]);

  // A Concord edit is a kind-3302 rumor targeting the original's id; the fold
  // applies the latest author-matching one non-destructively.
  const editMessage = useCallback(
    async (original: ChatMsg, content: string) => {
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) return;
      await send({
        content: trimmed,
        kind: KIND_EDIT,
        target: original.id,
        targetKind: original.kind,
        // CORD-08 §2: keep the ORIGINAL's NIP-40 deadline verbatim (`null` = none),
        // or the edit could outlive or change the message's expiry.
        expiration: expirationOf(original.tags) ?? null,
      });
    },
    [send],
  );

  // Timer-change notices (CORD-08 §4), authority-gated by the fold.
  const timerEntries = useMemo<DmTimerTimelineEntry[]>(
    () =>
      folded.timerNotices.map((n) => ({
        type: "dm-timer" as const,
        id: `dm-timer:${n.rumorId}`,
        createdAt: Math.floor(n.ms / 1000),
        author: n.author,
        seconds: timerNoticeSeconds(n) ?? 0,
      })),
    [folded.timerNotices],
  );

  // Defined outside the transport memo so memoized rows get stable props.
  const sendStatusFor = useCallback((id: string) => sendStatus[id], [sendStatus]);
  // A refusal counts as a flooding attempt, so call once per user send, before
  // the composer resets (so a refusal keeps the draft).
  const canSend = useCallback(
    () => (community ? sendRefusal(community.idHex) : null),
    [community],
  );
  // Via a ref, so a channel switch doesn't re-render the leaving channel's rows.
  const actionsRef = useRef({ retry, deleteMessage });
  actionsRef.current = { retry, deleteMessage };
  const retryEvent = useCallback((event: ChatMsg) => actionsRef.current.retry(event.id), []);
  const deleteEvent = useCallback((event: ChatMsg) => actionsRef.current.deleteMessage(event.id), []);
  const mentionsEveryone = useCallback(
    (event: ChatMsg) => Boolean(
      channel
      && hasEveryoneMention(event.content)
      && moderation.canMentionEveryone?.(event.pubkey, channel.idHex)
    ),
    [channel, moderation],
  );
  const canMentionEveryone = Boolean(
    user && channel && moderation.canMentionEveryone?.(user.pubkey, channel.idHex)
  );
  const mentionRoles = useMemo(
    () => (user ? moderation.mentionRolesFor?.(user.pubkey) ?? [] : []),
    [user, moderation],
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: timeline,
      isLoading,
      canWrite,
      canModerate,
      canMentionEveryone,
      mentionRoles,
      mentionsEveryone,
      isRumor: true,
      rotationDividerIds,
      quarantinedIds,
      pausedIds,
      loadOlder,
      hasMore,
      isLoadingOlder,
      hasNewer,
      loadNewer,
      isLoadingNewer,
      returnToPresent,
      sendStatusFor,
      retry: retryEvent,
      discard,
      deleteMessage: deleteEvent,
      editMessage,
      replyCountFor,
      reactionsFor,
      zapsFor,
      sendZap,
      sendOnchainZap,
      pollFor,
      sendPoll,
      calendarFor,
      threadRepliesFor,
      sendThreadReply,
      canSend,
    }),
    [timeline, isLoading, canWrite, canModerate, canMentionEveryone, mentionRoles, mentionsEveryone, rotationDividerIds, quarantinedIds, pausedIds, loadOlder, hasMore, isLoadingOlder, hasNewer, loadNewer, isLoadingNewer, returnToPresent, sendStatusFor, retryEvent, discard, deleteEvent, editMessage, replyCountFor, reactionsFor, zapsFor, sendZap, sendOnchainZap, pollFor, sendPoll, calendarFor, threadRepliesFor, sendThreadReply, canSend],
  );

  // From RAW rows: pinning needs the original seal, and edit proofs the consumed Edit rumor.
  const openedById = useMemo(() => {
    const map = new Map<string, OpenedChat>();
    for (const m of raw ?? []) map.set(m.rumorId, m);
    return map;
  }, [raw]);

  return { transport, span, reactionsFor, allMessages: messages, calendar, timerEntries, openedById, trustedAuthors: folded.trusted };
}
