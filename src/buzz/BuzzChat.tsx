import { ArrowBigDown, ArrowBigUp, Bot as BotIcon, Copy, Hash, Link2, Loader2, MessagesSquare, MoreHorizontal, Search, Trash2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { BuzzDiffRow, BuzzHuddleRow, BuzzSystemRow, BuzzWorkflowDefinitionRow, BuzzWorkflowEventRow } from "@/buzz/BuzzRows";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_STARTED,
  KIND_JOB_ERROR,
  KIND_JOB_REQUEST,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  KIND_DELETE,
  KIND_WORKFLOW_DEFINITION,
  BUZZ_UNREAD_KINDS,
} from "@/buzz/kinds";
import { collectDeletedIds, resolveBuzzRootId, sentFromThreadRef, tallyForumVotes } from "@/buzz/protocol";
import { buzzMessagesKey, useBuzzMessages } from "@/buzz/useBuzzMessages";
import { useBuzzEditMessage, useBuzzTyping, useSendBuzzThreadReply } from "@/buzz/useBuzzActions";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { DisplayName } from "@/components/DisplayName";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useAppContext } from "@/hooks/useAppContext";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { useDeleteOwnMessage } from "@/hooks/useEditMessage";
import { useGroupReactions } from "@/hooks/useReactions";
import { useZapReceipts } from "@/hooks/useZapReceipts";
import { useNostrPublish, useRepublish } from "@/hooks/useNostrPublish";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { usePageCovered } from "@/lib/settingsOverlay";
import { toast } from "@/hooks/useToast";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { chatRoute, parseChatRoute, type ChatRoute } from "@/lib/routes";
import { useLegacyFocusParams } from "@/hooks/useLegacyFocusParams";
import { writeClipboardText } from "@/lib/clipboard";
import { shortTimeAgo } from "@/lib/formatTime";
import { withSignature } from "@/lib/publishOutbox";
import { type SlashAction } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";
import { FormattedMessage, t, useIntl } from "@/i18n";

import { threadSummary } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import { useChatEditing } from "@/components/chat/useChatEditing";
import type { NostrEvent } from "@nostrify/nostrify";
import { AvatarInitial } from "@/components/AvatarInitial";

/**
 * Kinds rendered through the shared ChatMessage row. Agent job events
 * (43001–43006) included: Buzz renders them as ordinary agent messages.
 */
function isChatRow(kind: number): boolean {
  return (
    kind === 9 ||
    kind === 40001 ||
    kind === KIND_STREAM_MESSAGE_V2 ||
    kind === KIND_FORUM_POST ||
    (kind >= KIND_JOB_REQUEST && kind <= KIND_JOB_ERROR)
  );
}

interface BuzzChatMessageProps {
  event: ChatMsg;
  transport: ChatTransport;
  isEditing: boolean;
  highlight?: string;
  active?: boolean;
  onToggleActive?: (id: string) => void;
  continuation: boolean;
  onEdit: (event: ChatMsg) => void;
  onEditSubmit: (event: ChatMsg, content: string) => void;
  onEditCancel: () => void;
  votes?: { up: number; down: number; mine?: "+" | "-" };
  onVote?: (event: ChatMsg, value: "+" | "-") => void;
  /** Author holds the `bot` role in this channel (agent badge). */
  isAgent?: boolean;
  permalink?: ChatRoute;
}

/** Buzz binding for one chat-like row; mirrors Nip29ChatMessage. */
function BuzzChatMessage({
  event,
  transport,
  isEditing,
  highlight,
  active,
  onToggleActive,
  continuation,
  onEdit,
  onEditSubmit,
  onEditCancel,
  votes,
  onVote,
  isAgent,
  permalink,
}: BuzzChatMessageProps) {
  const intl = useIntl();
  const { config } = useAppContext();
  const threadInfo = threadSummary(transport.threadRepliesFor?.(event.id) ?? []);
  // Buzz's "Send to channel": a top-level message naming the thread it came from.
  const sentFrom = sentFromThreadRef(event.tags);
  const openThread = transport.openThread;
  const sendStatus = transport.sendStatusFor?.(event.id);
  return (
    <div>
      <ChatMessage
        event={event}
        permalink={permalink}
        canWrite={transport.canWrite}
        canModerate={transport.canModerate}
        reactions={transport.reactionsFor?.(event.id)}
        zapEnabled={config.zapsEnabled && Boolean(transport.zapsFor)}
        zaps={transport.zapsFor?.(event.id)}
        sendStatus={sendStatus}
        highlight={highlight}
        isEditing={isEditing}
        replyCount={transport.replyCountFor?.(event.id) ?? 0}
        threadParticipants={threadInfo.participants}
        lastReplyAt={threadInfo.lastReplyAt}
        nameBadge={
          isAgent ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-px text-3xs font-medium text-primary align-middle">
              <BotIcon className="size-2.5" aria-hidden />
              <FormattedMessage id="buzzChat.agent" defaultMessage="Agent" />
            </span>
          ) : undefined
        }
        // Only failed rows get a closure, so ChatMessage's memo holds.
        onRetry={sendStatus === "failed" ? () => transport.retry?.(event) : undefined}
        onDiscard={sendStatus === "failed" ? () => transport.discard?.(event.id) : undefined}
        onDelete={transport.deleteMessage}
        onOpenThread={openThread ? (e) => openThread(e, true) : undefined}
        // No inline `onReply`: on Buzz, replying IS threading. Buzz renders a
        // `["broadcast","1"]` inline reply twice and drops it on reload.
        replyContext={
          sentFrom ? (
            <button
              type="button"
              className="mb-0.5 flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => openThread?.({ ...event, id: sentFrom.rootId }, false)}
            >
              <MessagesSquare className="size-3 shrink-0" aria-hidden />
              <span className="shrink-0">
                {sentFrom.excerpt ? (
                  <FormattedMessage id="buzzChat.sentFromThreadExcerpt" defaultMessage="Sent from thread:" />
                ) : (
                  <FormattedMessage id="buzzChat.sentFromThread" defaultMessage="Sent from thread" />
                )}
              </span>
              {sentFrom.excerpt && <span className="truncate">{sentFrom.excerpt}</span>}
            </button>
          ) : undefined
        }
        onEdit={onEdit}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        active={active}
        onToggleActive={onToggleActive}
        continuation={continuation}
      />
      {votes && onVote && (
        <div className="flex items-center gap-1 pl-14 pb-1 -mt-0.5">
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "buzzChat.upvote", defaultMessage: "Upvote" })}
            aria-pressed={votes.mine === "+"}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors",
              votes.mine === "+" ? "text-success bg-success/10" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onVote(event, "+")}
          >
            <ArrowBigUp className="size-4" />
            {votes.up > 0 && votes.up}
          </button>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "buzzChat.downvote", defaultMessage: "Downvote" })}
            aria-pressed={votes.mine === "-"}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors",
              votes.mine === "-" ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onVote(event, "-")}
          >
            <ArrowBigDown className="size-4" />
            {votes.down > 0 && votes.down}
          </button>
        </div>
      )}
    </div>
  );
}

interface BuzzForumPostProps {
  event: ChatMsg;
  transport: ChatTransport;
  votes?: { up: number; down: number; mine?: "+" | "-" };
  onVote?: (event: ChatMsg, value: "+" | "-") => void;
  /** Author holds the `bot` role in this channel (agent badge). */
  isAgent?: boolean;
}

/** A forum post as a Reddit-style card; clicking the body opens the thread. */
function BuzzForumPost({ event, transport, votes, onVote, isAgent }: BuzzForumPostProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const replyCount = transport.replyCountFor?.(event.id) ?? 0;
  const up = votes?.up ?? 0;
  const down = votes?.down ?? 0;
  const score = up - down;
  const mine = votes?.mine;
  const isOwn = user?.pubkey === event.pubkey;
  const canDelete = Boolean(transport.deleteMessage) && (isOwn || transport.canModerate);

  const openThread = useCallback(
    (focusReply = false) => transport.openThread?.(event, focusReply),
    [transport, event],
  );

  // Clicks on links/buttons/media inside the body act normally.
  const handleBodyClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a, button, input, textarea, [role='button']")) return;
      openThread();
    },
    [openThread],
  );

  const copyId = useCallback(() => {
    try {
      writeClipboardText(`nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`).catch(
        () => undefined,
      );
    } catch {
      writeClipboardText(event.id).catch(() => undefined);
    }
  }, [event.id, event.pubkey]);

  return (
    <div className="px-2 py-1">
      <div className="flex overflow-hidden p-px clip-hairline-lg [--fill:var(--card)] [--fill-hover:var(--card)] [--edge:var(--border)/0.5] transition-colors hover:[--edge:var(--muted-foreground)/0.3]">
        <div className="flex shrink-0 flex-col items-center gap-0.5 bg-secondary/40 px-1 py-2">
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "buzzChat.upvote", defaultMessage: "Upvote" })}
            aria-pressed={mine === "+"}
            onClick={() => onVote?.(event, "+")}
            className={cn(
              "rounded p-1 transition-colors touch:p-1.5",
              mine === "+" ? "text-success" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            )}
          >
            <ArrowBigUp className="size-5" />
          </button>
          <span
            className={cn(
              "text-xs font-bold tabular-nums",
              mine === "+" ? "text-success" : mine === "-" ? "text-destructive" : "text-foreground",
            )}
          >
            {score}
          </span>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "buzzChat.downvote", defaultMessage: "Downvote" })}
            aria-pressed={mine === "-"}
            onClick={() => onVote?.(event, "-")}
            className={cn(
              "rounded p-1 transition-colors touch:p-1.5",
              mine === "-" ? "text-destructive" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            )}
          >
            <ArrowBigDown className="size-5" />
          </button>
        </div>

        <div className="min-w-0 flex-1 cursor-pointer px-3 py-2" onClick={handleBodyClick}>
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-monogram font-semibold">
                <AvatarInitial name={displayName} pubkey={event.pubkey} />
              </AvatarFallback>
            </Avatar>
            <span className="truncate font-medium text-foreground">
              <DisplayName pubkey={event.pubkey} name={displayName} />
            </span>
            {isAgent && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-px text-3xs font-medium text-primary">
                <BotIcon className="size-2.5" aria-hidden />
                <FormattedMessage id="buzzChat.agent" defaultMessage="Agent" />
              </span>
            )}
            <span aria-hidden>·</span>
            <span className="shrink-0">{shortTimeAgo(event.created_at)}</span>
            <div className="ml-auto shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={intl.formatMessage({ id: "buzzChat.postActions", defaultMessage: "Post actions" })}
                    className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground touch:p-1.5"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => writeClipboardText(event.content).catch(() => undefined)}>
                    <Copy className="mr-2 size-4" /> <FormattedMessage id="buzzChat.copyText" defaultMessage="Copy text" />
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={copyId}>
                    <Link2 className="size-4" /> <FormattedMessage id="buzzChat.copyPostId" defaultMessage="Copy post ID" />
                  </DropdownMenuItem>
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => transport.deleteMessage?.(event)}
                      >
                        <Trash2 className="mr-2 size-4" /> <FormattedMessage id="buzzChat.deletePost" defaultMessage="Delete post" />
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <ChatContent event={event} className="text-sm" />

          <div className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <button
              type="button"
              onClick={() => openThread(true)}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 transition-colors hover:bg-foreground/10 hover:text-foreground touch:py-2"
            >
              <MessagesSquare className="size-4" />
              {replyCount > 0 ? (
                <FormattedMessage
                  id="buzzChat.comments"
                  defaultMessage="{count, plural, one {# comment} other {# comments}}"
                  values={{ count: replyCount }}
                />
              ) : (
                <FormattedMessage id="buzzChat.comment" defaultMessage="Comment" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface BuzzChatProps {
  relayUrl: string;
  channelId: string;
  /** Forum channels swap the content kinds and add votes. */
  channelType?: "stream" | "forum" | "dm" | "workflow";
  canWrite: boolean;
  membershipPending?: boolean;
  canModerate: boolean;
  searchQuery?: string;
}

/**
 * Timeline + composer for a Buzz channel. Mirrors {@link GroupChat} with Buzz
 * semantics: extra row kinds, kind-40003 edits, NIP-10 kind-9 thread replies,
 * forum votes, and typing indicators (ephemeral kind 20002).
 */
export function BuzzChat({
  relayUrl,
  channelId,
  channelType = "stream",
  canWrite,
  membershipPending = false,
  canModerate,
  searchQuery = "",
}: BuzzChatProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { data: groupDetails } = useGroup(relayUrl, channelId);
  const channelName = groupDetails?.group?.name;
  const memberRoles = groupDetails?.memberRoles;
  const forum = channelType === "forum";
  const workflow = channelType === "workflow";

  const {
    timeline,
    raw,
    isLoading,
    status: sendStatus,
    insertOptimistic,
    markSent,
    markFailed,
    removeOptimistic,
    loadOlder,
    hasMore,
    isLoadingOlder,
    replyCountFor,
    threadRepliesFor: threadRepliesForRaw,
    fetchThread,
    mergeEvents,
  } = useBuzzMessages(relayUrl, channelId, { forum, workflow });

  const { deleteEvent, removeUser } = useGroupModeration(relayUrl, channelId);
  const { mutateAsync: republish } = useRepublish();
  const { mutateAsync: editMessage } = useBuzzEditMessage(relayUrl, channelId);
  const { mutate: deleteOwnMessage } = useDeleteOwnMessage(relayUrl, channelId);
  const { mutateAsync: publish } = useNostrPublish();
  const { markRead } = useReadState();
  const covered = usePageCovered();
  const { typers, publishTyping } = useBuzzTyping(relayUrl, channelId);

  const newDividerId = useNewMessagesDivider(
    channelReadKey(relayUrl, channelId),
    timeline.map((message) => ({ id: message.id, createdAt: message.created_at, author: message.pubkey })),
    user?.pubkey,
  );

  const { results: searchResults, isLoading: searchLoading, active: searching } = useGroupSearch(
    relayUrl,
    channelId,
    searchQuery,
    { kinds: [...BUZZ_UNREAD_KINDS], messagesKey: buzzMessagesKey(relayUrl, channelId) },
  );

  const visibleIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of timeline) set.add(m.id);
    for (const m of searchResults) set.add(m.id);
    return [...set];
  }, [timeline, searchResults]);

  const sendThreadReply = useSendBuzzThreadReply(
    relayUrl,
    channelId,
    forum ? KIND_FORUM_COMMENT : undefined,
  );

  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  // The open thread comes from the route, so it survives refresh and deep links.
  const location = useLocation();
  const navigate = useNavigate();
  const routeThreadRoot = useMemo(() => {
    const parsed = parseChatRoute(location.pathname);
    return parsed?.kind === "nip29" ? parsed.threadRoot : undefined;
  }, [location.pathname]);
  const threadRoot = useMemo(
    () => (routeThreadRoot ? timeline.find((m) => m.id === routeThreadRoot) : undefined),
    [routeThreadRoot, timeline],
  );

  useActiveRoom(
    relayUrl && channelId ? `h:${relayUrl}|${channelId}` : undefined,
    relayUrl && channelId && threadRoot ? `h:${relayUrl}|${channelId}:t:${threadRoot.id}` : undefined,
  );

  // Legacy `?thread=`/`?m=` deep links from old notifications and copied links.
  useLegacyFocusParams(
    useMemo(
      () =>
        relayUrl && channelId
          ? ({ kind: "nip29", relayUrl, groupId: channelId } as const)
          : undefined,
      [relayUrl, channelId],
    ),
  );

  const tallyIds = useMemo(() => {
    if (!threadRoot) return visibleIds;
    const replyIds = threadRepliesForRaw(threadRoot.id).map((r) => r.id);
    if (replyIds.length === 0) return visibleIds;
    return [...new Set([...visibleIds, ...replyIds])];
  }, [visibleIds, threadRoot, threadRepliesForRaw]);

  const { reactionsFor } = useGroupReactions(relayUrl, channelId, tallyIds, {
    messagesKey: buzzMessagesKey(relayUrl, channelId),
  });
  const { zapsFor } = useZapReceipts(
    relayUrl && channelId ? `buzz:${relayUrl}:${channelId}` : undefined,
    tallyIds,
  );

  // Forum votes (45002).
  const voteTallies = useMemo(() => {
    if (!forum) return undefined;
    const deleted = collectDeletedIds(raw);
    const votes = raw.filter((e) => e.kind === KIND_FORUM_VOTE && !deleted.has(e.id));
    return tallyForumVotes(votes, user?.pubkey);
  }, [forum, raw, user?.pubkey]);

  const handleVote = useCallback(
    async (target: ChatMsg, value: "+" | "-") => {
      const mine = voteTallies?.get(target.id)?.mine;
      try {
        if (mine && mine.value === value) {
          // Retract: NIP-09 delete of the prior vote.
          await publish({
            kind: KIND_DELETE,
            content: "",
            tags: [["e", mine.eventId], ["k", String(KIND_FORUM_VOTE)], ["h", channelId]],
            relay: relayUrl,
            onSigned: (ev) => mergeEvents([ev]),
          });
        } else {
          await publish({
            kind: KIND_FORUM_VOTE,
            content: value,
            tags: [["h", channelId], ["e", target.id], ["p", target.pubkey]],
            relay: relayUrl,
            onSigned: (ev) => mergeEvents([ev]),
          });
        }
      } catch {
        toast({
          title: t({ id: "buzzChat.voteFailed", defaultMessage: "Vote failed" }),
          description: t({ id: "buzzChat.voteRejected", defaultMessage: "The relay rejected the vote." }),
          variant: "destructive",
        });
      }
    },
    [voteTallies, publish, channelId, relayUrl, mergeEvents],
  );

  // Focus intent rides in history state so a shared link never steals focus.
  const threadAutoFocus = Boolean((location.state as { threadAutoFocus?: boolean } | null)?.threadAutoFocus);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: async (original, content) => {
      const edit = await editMessage({ original, content });
      // Fold the edit in immediately (the wire echo lands later).
      if (edit && edit.id !== original.id) mergeEvents([edit]);
    },
    messages: timeline,
    isPending: (id) => sendStatus[id] !== undefined,
    self: user?.pubkey,
  });
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  const channelRoute = useMemo(
    () => ({ kind: "nip29", relayUrl, groupId: channelId }) as const,
    [relayUrl, channelId],
  );
  // Memoized: an inline object would defeat the thread rows' memo.
  const threadPermalink = useMemo(
    () => (lastThreadRoot ? ({ kind: "nip29", relayUrl, groupId: channelId, threadRoot: lastThreadRoot.id } as const) : undefined),
    [relayUrl, channelId, lastThreadRoot],
  );
  const permalinkScroll = useCallback(
    (id: string) => timelineRef.current?.scrollToMessage(id, true) ?? false,
    [],
  );
  const clearMessageFocus = useMessagePermalink({
    messages: timeline,
    isLoading,
    hasMore,
    loadOlder,
    scrollTo: permalinkScroll,
    enabled: !searching,
  });

  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), 200);
    return () => clearTimeout(t);
  }, [threadRoot]);

  useEffect(() => {
    if (!user || timeline.length === 0 || covered) return;
    const latest = timeline[timeline.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") {
        markRead(channelReadKey(relayUrl, channelId), latest);
      }
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, timeline, relayUrl, channelId, markRead, covered]);

  // Sending follows the new message and drops any `/m/` focus, or a remount
  // would snap back to it.
  const handleSent = useCallback(() => {
    timelineRef.current?.pinToBottom();
    clearMessageFocus();
  }, [clearMessageFocus]);

  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    // A broadcast reply's thread is its ROOT's (replies are bucketed by root).
    const rootId = resolveBuzzRootId(event);
    navigate(chatRoute({ kind: "nip29", relayUrl, groupId: channelId, threadRoot: rootId }), {
      state: { threadAutoFocus: focusReply },
    });
    // Fetch by `#e`: the loaded `#h` window may not span an old thread's replies.
    void fetchThread(rootId);
  }, [fetchThread, navigate, relayUrl, channelId]);
  // No-op when no thread is routed, so a stray close can't stack history entries.
  const closeThread = useCallback(() => {
    if (!routeThreadRoot) return;
    setThreadExpanded(false);
    navigate(chatRoute({ kind: "nip29", relayUrl, groupId: channelId }));
  }, [routeThreadRoot, navigate, relayUrl, channelId]);

  const handleSlashAction = useCallback(
    async (action: SlashAction) => {
      if (action.kind === "openThread") {
        const latest = timeline[timeline.length - 1];
        if (latest) openThread(latest, true);
        else {
          toast({
            title: t({ id: "buzzChat.noMessageToThread", defaultMessage: "No message to thread" }),
            description: t({ id: "buzzChat.sendFirst", defaultMessage: "Send a message first." }),
          });
        }
        return;
      }
      if (action.kind === "kick" || action.kind === "ban") {
        await removeUser.mutateAsync({
          pubkey: action.pubkey,
          reason: action.kind === "ban" ? action.reason : undefined,
        });
        toast({
          title: t({ id: "buzzChat.userRemoved", defaultMessage: "User removed" }),
          description: t({ id: "buzzChat.userRemovedDescription", defaultMessage: "The user was removed from the channel." }),
        });
      }
    },
    [removeUser, timeline, openThread],
  );

  const handleRetry = useCallback(
    async (event: NostrEvent) => {
      markFailed(event.id);
      try {
        // The event store drops signatures; the outbox holds the signed copy.
        await republish({ event: await withSignature(event), relay: relayUrl });
        markSent(event.id);
      } catch {
        markFailed(event.id);
      }
    },
    [republish, relayUrl, markSent, markFailed],
  );

  const handleDelete = useCallback(
    (event: NostrEvent) => {
      if (user?.pubkey === event.pubkey) {
        deleteOwnMessage({ event });
      } else {
        deleteEvent.mutate({ eventId: event.id });
      }
    },
    [user?.pubkey, deleteOwnMessage, deleteEvent],
  );

  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => threadRepliesForRaw(rootId),
    [threadRepliesForRaw],
  );

  const huddleLifecycle = useMemo(
    () =>
      raw.filter(
        (e) =>
          e.kind === KIND_HUDDLE_PARTICIPANT_JOINED ||
          e.kind === KIND_HUDDLE_PARTICIPANT_LEFT ||
          e.kind === KIND_HUDDLE_ENDED,
      ),
    [raw],
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: timeline,
      isLoading,
      canWrite: Boolean(user && canWrite),
      canModerate,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor: (id) => sendStatus[id],
      retry: handleRetry,
      discard: removeOptimistic,
      deleteMessage: handleDelete,
      editMessage: async (original, content) => handleEditSubmit(original, content),
      replyCountFor,
      reactionsFor,
      zapsFor,
      openThread,
      threadRepliesFor,
      sendThreadReply: async (root, content, tags) => {
        await sendThreadReply(root, content, tags);
      },
    }),
    [
      timeline,
      isLoading,
      user,
      canWrite,
      canModerate,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatus,
      handleRetry,
      removeOptimistic,
      handleDelete,
      handleEditSubmit,
      replyCountFor,
      reactionsFor,
      zapsFor,
      openThread,
      threadRepliesFor,
      sendThreadReply,
    ],
  );

  const renderRow = useCallback(
    (msg: ChatMsg, continuation: boolean, highlight?: string) => {
      if (msg.kind === KIND_SYSTEM_MESSAGE) return <BuzzSystemRow key={msg.id} event={msg} />;
      if (msg.kind === KIND_STREAM_MESSAGE_DIFF) return <BuzzDiffRow key={msg.id} event={msg} />;
      if (msg.kind === KIND_HUDDLE_STARTED) {
        return <BuzzHuddleRow key={msg.id} event={msg} lifecycle={huddleLifecycle} />;
      }
      if (msg.kind === KIND_WORKFLOW_DEFINITION) {
        return <BuzzWorkflowDefinitionRow key={msg.id} event={msg} />;
      }
      if ((msg.kind >= 46001 && msg.kind <= 46012) || msg.kind === 46020) {
        return <BuzzWorkflowEventRow key={msg.id} event={msg} />;
      }
      if (!isChatRow(msg.kind)) return <BuzzSystemRow key={msg.id} event={msg} />;
      const votes = forum ? voteTallies?.get(msg.id) ?? { up: 0, down: 0 } : undefined;
      if (forum) {
        return (
          <BuzzForumPost
            key={msg.id}
            event={msg}
            transport={transport}
            isAgent={memberRoles?.[msg.pubkey] === "bot"}
            votes={votes ? { up: votes.up, down: votes.down, mine: votes.mine?.value } : undefined}
            onVote={handleVote}
          />
        );
      }
      return (
        <BuzzChatMessage
          key={msg.id}
          event={msg}
          transport={transport}
          isAgent={memberRoles?.[msg.pubkey] === "bot"}
          isEditing={editingId === msg.id}
          highlight={highlight}
          active={activeId === msg.id}
          onToggleActive={toggleActive}
          continuation={continuation}
          onEdit={startEditing}
          onEditSubmit={handleEditSubmit}
          onEditCancel={cancelEditing}
          votes={votes ? { up: votes.up, down: votes.down, mine: votes.mine?.value } : undefined}
          onVote={forum ? handleVote : undefined}
          permalink={channelRoute}
        />
      );
    },
    [
      huddleLifecycle,
      forum,
      voteTallies,
      transport,
      memberRoles,
      editingId,
      activeId,
      toggleActive,
      startEditing,
      cancelEditing,
      handleEditSubmit,
      handleVote,
      channelRoute,
    ],
  );

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0">
      <ComposerBoundsProvider value={composerBoundsRef}>
      <div className={cn(
        "relative flex flex-col flex-1 min-h-0 min-w-0",
        "thread:transition-[width,opacity] thread:duration-300 thread:ease-out",
        threadRoot && threadExpanded && "thread:flex-none thread:w-0 thread:opacity-0 thread:overflow-hidden thread:pointer-events-none",
      )}>
        {searching ? (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable px-3 py-4">
            {searchLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Search className="size-9 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage id="buzzChat.noResults" defaultMessage="No messages found" />
                </p>
              </div>
            ) : (
              <>
                <p className="px-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground/80">
                  <FormattedMessage
                    id="buzzChat.resultCount"
                    defaultMessage="{count, plural, one {# result} other {# results}}"
                    values={{ count: searchResults.length }}
                  />
                </p>
                {[...searchResults]
                  .sort((a, b) => a.created_at - b.created_at)
                  .map((msg) => renderRow(msg, false, searchQuery))}
              </>
            )}
          </div>
        ) : (
          <MessageTimeline
            transport={transport}
            handleRef={timelineRef}
            newDividerId={newDividerId}
            className="flex-1 min-h-0"
            emptyState={
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Hash className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage id="buzzChat.empty" defaultMessage="No messages yet" />
                </p>
              </div>
            }
            renderMessage={(msg, continuation) => renderRow(msg, continuation)}
          />
        )}

        {!searching && <TypingIndicator pubkeys={typers} />}

        {searching ? null : user && canWrite ? (
          <ChatComposer
            relayUrl={relayUrl}
            groupId={channelId}
            messages={timeline}
            shareRoute={chatRoute({ kind: "nip29", relayUrl, groupId: channelId })}
            // No `replyTo`: replies go through the thread panel, the only reply shape
            // Buzz's own client produces.
            messageKind={forum ? KIND_FORUM_POST : undefined}
            pollsEnabled={false}
            placeholder={
              channelName
                ? intl.formatMessage({ id: "buzzChat.placeholder", defaultMessage: "Message {channel}" }, { channel: channelName })
                : undefined
            }
            // Android Direct Share label; the publisher can't resolve NIP-29 metadata.
            shareLabel={channelName}
            shareIconUrl={groupDetails?.group?.picture}
            onSent={handleSent}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSent={markSent}
            onOptimisticFailed={markFailed}
            canModerate={canModerate}
            onTyping={publishTyping}
            onSlashAction={handleSlashAction}
            onEditLast={editLast}
            // Not on touch, where it raises the keyboard.
            autoFocus={!isTouch}
          />
        ) : membershipPending ? (
          <div className="p-2" aria-hidden>
            <div className="h-12 clip-corner-lg bg-secondary/60" />
          </div>
        ) : (
          <div className="border-t p-3 shrink-0 pb-safe">
            <p className="text-xs text-muted-foreground text-center py-1">
              {user ? (
                <FormattedMessage id="buzzChat.joinToSend" defaultMessage="Join this channel to send messages." />
              ) : (
                <FormattedMessage id="buzzChat.signInToJoin" defaultMessage="Sign in to join the conversation." />
              )}
            </p>
          </div>
        )}
      </div>
      </ComposerBoundsProvider>

      <div
        className={cn(
          "overflow-hidden",
          "absolute inset-0 z-20 thread:static thread:z-auto",
          "thread:transition-[width] thread:duration-200 thread:ease-out",
          threadRoot
            ? (threadExpanded ? "thread:flex-1 thread:w-full" : "thread:shrink-0 thread:w-[23rem]")
            : "thread:shrink-0 thread:w-0 pointer-events-none thread:pointer-events-auto",
        )}
      >
        <div
          className={cn(
            "relative h-full flex w-full transition-transform duration-200 ease-out",
            threadRoot ? "transform-none" : "translate-x-full",
            threadExpanded ? "thread:w-full" : "thread:w-[23rem]",
          )}
        >
          <div aria-hidden className="absolute inset-0 -z-10 bg-background thread:hidden" />
          {lastThreadRoot && (
            <ThreadPanel
              root={lastThreadRoot}
              transport={transport}
              relayUrl={relayUrl}
              groupId={channelId}
              canWrite={Boolean(user && canWrite)}
              autoFocus={threadAutoFocus}
              open={Boolean(threadRoot)}
              permalink={threadPermalink}
              onClose={closeThread}
              onExpandChange={setThreadExpanded}
            />
          )}
        </div>
      </div>
    </div>
  );
}

