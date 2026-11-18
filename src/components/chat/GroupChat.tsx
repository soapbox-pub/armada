import { Hash, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { useMediaHeld, useMessageRevealed } from "@/components/chat/mediaHold";
import { firstImageRef, getReplyToId } from "@/components/chat/messageHelpers";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { ThreadPanelSlot } from "@/components/chat/ThreadPanelSlot";
import LoginScreen from "@/components/auth/LoginScreen";
import SignupDialog from "@/components/auth/SignupDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useAppContext } from "@/hooks/useAppContext";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEvent } from "@/hooks/useEvent";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMessages } from "@/hooks/useGroupMessages";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { useDeleteOwnMessage, useEditMessage } from "@/hooks/useEditMessage";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useGroupReactions } from "@/hooks/useReactions";
import { useZapReceipts } from "@/hooks/useZapReceipts";
import { useGroupThreads, useSendThreadReply } from "@/hooks/useThread";
import { useRepublish } from "@/hooks/useNostrPublish";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { usePageCovered } from "@/lib/settingsOverlay";
import { useThreadPanel } from "@/hooks/useThreadPanel";
import { useTimelineFocus } from "@/hooks/useTimelineFocus";
import { toast } from "@/hooks/useToast";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useLegacyFocusParams } from "@/hooks/useLegacyFocusParams";
import { isNip29ThreadOnly } from "@/lib/nip29Threads";
import { withSignature } from "@/lib/publishOutbox";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import { type SlashAction } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import { threadSummary } from "@/components/chat/transport";
import type { ChatMsg, ChatTransport, MessageCalendar } from "@/components/chat/transport";
import { useChatEditing } from "@/components/chat/useChatEditing";
import type { CalendarTransport } from "@/lib/calendar";
import { FormattedMessage, t, useIntl } from "@/i18n";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const EMPTY_MESSAGES: NostrRumor[] = [];

/**
 * NIP-29 reply context. A parent already in the loaded window renders with its
 * row, so a fresh reply never paints first and gains its context a fetch later.
 */
function ReplyContext({
  eventId,
  parent,
  relayUrl,
  onJump,
}: {
  eventId: string;
  parent: ChatMsg | undefined;
  relayUrl: string;
  onJump: (id: string) => void;
}) {
  if (parent) return <ReplyContextFor event={parent} onJump={onJump} />;
  return <FetchedReplyContext eventId={eventId} relayUrl={relayUrl} onJump={onJump} />;
}

function FetchedReplyContext({ eventId, relayUrl, onJump }: { eventId: string; relayUrl: string; onJump: (id: string) => void }) {
  const { data: event } = useEvent(eventId, [relayUrl]);
  if (!event) return null;
  return <ReplyContextFor event={event} onJump={onJump} />;
}

function ReplyContextFor({ event, onJump }: { event: ChatMsg; onJump: (id: string) => void }) {
  const author = useAuthor(event.pubkey);
  const displayName = useScopedDisplayName(event.pubkey, author.data?.metadata);
  const image = firstImageRef(event);
  const revealed = useMessageRevealed(event.id);
  const held = useMediaHeld(event.pubkey) && !revealed;
  return (
    <ReplyContextLine
      name={displayName}
      pubkey={event.pubkey}
      preview={<ReplyPreview content={event.content} tags={event.tags} quotesBy={held ? undefined : event.pubkey} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(event.id)}
    />
  );
}

interface Nip29ChatMessageProps {
  event: ChatMsg;
  relayUrl: string;
  groupId: string;
  transport: ChatTransport;
  isEditing: boolean;
  highlight?: string;
  active?: boolean;
  onToggleActive?: (id: string) => void;
  continuation: boolean;
  onEdit: (event: ChatMsg) => void;
  onEditSubmit: (event: ChatMsg, content: string) => void;
  onEditCancel: () => void;
  onJumpToReply: (id: string) => void;
  onReply: (event: ChatMsg) => void;
  /** The inline-reply parent when it is in the loaded window. */
  replyParent?: ChatMsg;
}

/**
 * NIP-29 binding for one message. Reactions/reply counts are batched per room by
 * {@link GroupChat} and read from the transport.
 */
function Nip29ChatMessage({
  event,
  relayUrl,
  groupId,
  transport,
  isEditing,
  highlight,
  active,
  onToggleActive,
  continuation,
  onEdit,
  onEditSubmit,
  onEditCancel,
  onJumpToReply,
  onReply,
  replyParent,
}: Nip29ChatMessageProps) {
  const { config } = useAppContext();
  // The transport is rebuilt on every message/page, so memoize derived props and
  // read it through a ref, or ChatMessage's memo breaks for the whole window.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const replies = transport.threadRepliesFor?.(event.id);
  const threadInfo = useMemo(() => threadSummary(replies ?? []), [replies]);
  const pollContext = useMemo(() => ({ relayUrl, groupId }), [relayUrl, groupId]);

  const handleRetry = useCallback(() => transportRef.current.retry?.(event), [event]);
  const handleDiscard = useCallback(() => transportRef.current.discard?.(event.id), [event]);

  const canOpenThread = Boolean(transport.openThread);
  const handleOpenThread = useMemo(
    () => (canOpenThread ? (e: ChatMsg) => transportRef.current.openThread!(e, true) : undefined),
    [canOpenThread],
  );

  const replyToId = getReplyToId(event);
  const replyContext = useMemo(
    () =>
      replyToId ? (
        <ReplyContext eventId={replyToId} parent={replyParent} relayUrl={relayUrl} onJump={onJumpToReply} />
      ) : undefined,
    [replyToId, replyParent, relayUrl, onJumpToReply],
  );
  // Timeline rows link to the room; ThreadPanel supplies thread-scoped links.
  const permalink = useMemo(
    () => ({ kind: "nip29", relayUrl, groupId }) as const,
    [relayUrl, groupId],
  );

  return (
    <ChatMessage
      event={event}
      permalink={permalink}
      canWrite={transport.canWrite}
      canModerate={transport.canModerate}
      pollContext={pollContext}
      calendar={transport.calendarFor?.(event.id)}
      reactions={transport.reactionsFor?.(event.id)}
      zapEnabled={config.zapsEnabled && Boolean(transport.zapsFor)}
      zaps={transport.zapsFor?.(event.id)}
      onSendZap={transport.sendZap}
      onSendOnchainZap={transport.sendOnchainZap}
      sendStatus={transport.sendStatusFor?.(event.id)}
      highlight={highlight}
      isEditing={isEditing}
      isPinned={transport.isPinned?.(event.id)}
      replyCount={transport.replyCountFor?.(event.id) ?? 0}
      threadParticipants={threadInfo.participants}
      lastReplyAt={threadInfo.lastReplyAt}
      replyContext={replyContext}
      onRetry={handleRetry}
      onDiscard={handleDiscard}
      onTogglePin={transport.togglePin}
      onDelete={transport.deleteMessage}
      onOpenThread={handleOpenThread}
      onReply={onReply}
      onEdit={onEdit}
      onEditSubmit={onEditSubmit}
      onEditCancel={onEditCancel}
      active={active}
      onToggleActive={onToggleActive}
      continuation={continuation}
    />
  );
}

/**
 * Composer-shaped placeholder while membership resolves, so members never see
 * the join prompt flash and the swap doesn't shift layout.
 */
function ComposerSkeleton() {
  return (
    <div
      className="relative shrink-0 pb-[var(--bottom-chrome-pad)] sidebar:pb-[var(--safe-area-pad-bottom-tight,0.25rem)]"
      aria-hidden
    >
      <div className="px-2 pt-1.5 sidebar:py-2">
        <div className="flex items-end gap-0.5 clip-corner-lg bg-secondary/60 px-1.5 py-1.5 touch:p-1">
          <Skeleton className="size-9 touch:size-11 shrink-0 rounded-full" />
          <div className="flex-1 min-w-0 px-1.5 py-2">
            <Skeleton className="h-5 w-40 max-w-full rounded" />
          </div>
          <Skeleton className="size-9 touch:size-11 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  );
}

interface GroupChatProps {
  relayUrl: string;
  groupId: string;
  canWrite: boolean;
  /** Membership still resolving (logged in): show a skeleton, not the join prompt. */
  membershipPending?: boolean;
  canModerate: boolean;
  /** NIP-52 calendar events + RSVPs, rendered inline as event cards. */
  calendar?: CalendarTransport;
  /** Non-empty: matching messages replace the timeline in place. */
  searchQuery?: string;
}

/**
 * Timeline + composer for a NIP-29 group (kind 9 / 1068 polls with `h`, host
 * relay only), assembled into a {@link ChatTransport} for the shared components.
 */
export function GroupChat({ relayUrl, groupId, canWrite, membershipPending = false, canModerate, calendar, searchQuery = "" }: GroupChatProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const location = useLocation();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { data: groupDetails } = useGroup(relayUrl, groupId);
  const channelName = groupDetails?.group?.name;
  const routeFocus = useMemo(() => {
    const route = parseChatRoute(location.pathname);
    if (
      route?.kind !== "nip29" ||
      route.relayUrl !== relayUrl ||
      route.groupId !== groupId
    ) return undefined;
    return { messageId: route.messageId, threadRoot: route.threadRoot };
  }, [location.pathname, relayUrl, groupId]);
  const {
    data: stored = EMPTY_MESSAGES,
    isLoading,
    status: sendStatus,
    insertOptimistic,
    markSent,
    markFailed,
    removeOptimistic,
    loadOlder,
    hasMore,
    isLoadingOlder,
  } = useGroupMessages(relayUrl, groupId, routeFocus);
  // Thread replies are kind 9 too, and arrive with the timeline; they render in their thread.
  const { messages, threadReplies } = useMemo(() => {
    const rows: NostrRumor[] = [];
    const replies: NostrRumor[] = [];
    for (const event of stored) (isNip29ThreadOnly(event) ? replies : rows).push(event);
    return { messages: replies.length === 0 ? stored : rows, threadReplies: replies };
  }, [stored]);
  const { deleteEvent, removeUser } = useGroupModeration(relayUrl, groupId);
  const { isPinned, pin, unpin } = usePinnedMessages(relayUrl, groupId);  const { mutateAsync: republish } = useRepublish();
  const { mutateAsync: editMessage } = useEditMessage(relayUrl, groupId);
  const { mutate: deleteOwnMessage } = useDeleteOwnMessage(relayUrl, groupId);
  const { markRead } = useReadState();
  const covered = usePageCovered();
  // Captured before markRead stamps the channel; frozen until the channel changes.
  const newDividerId = useNewMessagesDivider(
    channelReadKey(relayUrl, groupId),
    messages.map((message) => ({ id: message.id, createdAt: message.created_at, author: message.pubkey })),
    user?.pubkey,
  );
  const { results: searchResults, isLoading: searchLoading, active: searching } = useGroupSearch(
    relayUrl,
    groupId,
    searchQuery,
  );

  // Batched reactions + reply counts for all visible ids (mirrors `useConcordReactions`).
  const visibleIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) set.add(m.id);
    for (const m of searchResults) set.add(m.id);
    return [...set];
  }, [messages, searchResults]);
  const { replyCountFor, threadRepliesFor } = useGroupThreads(relayUrl, groupId, visibleIds, threadReplies);
  const sendThreadReply = useSendThreadReply(relayUrl, groupId);

  const room = useMemo(
    () => (relayUrl && groupId ? ({ kind: "nip29", relayUrl, groupId } as const) : undefined),
    [relayUrl, groupId],
  );
  const {
    threadRoot,
    lastThreadRoot,
    expanded: threadExpanded,
    setExpanded: setThreadExpanded,
    autoFocus: threadAutoFocus,
    chatColumnClass,
    openThread,
    closeThread,
  } = useThreadPanel({ room, messages });

  // Memoized: an inline object would defeat the thread rows' memo.
  const threadPermalink = useMemo(
    () => (lastThreadRoot ? ({ kind: "nip29", relayUrl, groupId, threadRoot: lastThreadRoot.id } as const) : undefined),
    [relayUrl, groupId, lastThreadRoot],
  );

  // Suppress redundant native notifications. roomKey shapes must match the
  // service: `h:<relayUrl>|<groupId>` and `h:<relayUrl>|<groupId>:t:<rootId>`.
  useActiveRoom(
    relayUrl && groupId ? `h:${relayUrl}|${groupId}` : undefined,
    relayUrl && groupId && threadRoot ? `h:${relayUrl}|${groupId}:t:${threadRoot.id}` : undefined,
  );

  // Legacy `?thread=`/`?m=` deep links from old notifications and copied links.
  useLegacyFocusParams(room);

  // Include open-thread replies (kind 1111), which aren't in the timeline.
  const tallyIds = useMemo(() => {
    if (!threadRoot) return visibleIds;
    const replyIds = (threadRepliesFor?.(threadRoot.id) ?? []).map((r) => r.id);
    if (replyIds.length === 0) return visibleIds;
    return [...new Set([...visibleIds, ...replyIds])];
  }, [visibleIds, threadRoot, threadRepliesFor]);

  const { reactionsFor } = useGroupReactions(relayUrl, groupId, tallyIds);
  // NIP-57 receipts are published to the app relays the 9734 lists.
  const { zapsFor } = useZapReceipts(
    relayUrl && groupId ? `nip29:${relayUrl}:${groupId}` : undefined,
    tallyIds,
  );
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [signupDialogOpen, setSignupDialogOpen] = useState(false);

  const {
    timelineRef,
    jumpToMessage: jumpToReply,
    pinToPresent,
    activeId,
    toggleActive,
  } = useTimelineFocus({
    messages,
    isLoading,
    hasMore,
    loadOlder,
    enabled: !searching,
  });

  useEffect(() => {
    if (!user || messages.length === 0 || covered) return;
    const latest = messages[messages.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;

    const stamp = () => {
      if (document.visibilityState === "visible") {
        markRead(channelReadKey(relayUrl, groupId), latest);
      }
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, messages, relayUrl, groupId, markRead, covered]);

  const handleSlashAction = useCallback(
    async (action: SlashAction) => {
      if (action.kind === "openThread") {
        const latest = messages[messages.length - 1];
        if (latest) openThread(latest, true);
        else {
          toast({
            title: t({ id: "groupChat.noMessageToThread", defaultMessage: "No message to thread" }),
            description: t({ id: "groupChat.sendFirst", defaultMessage: "Send a message first." }),
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
          title: t({ id: "groupChat.userRemoved", defaultMessage: "User removed" }),
          description: t({ id: "groupChat.userRemovedDescription", defaultMessage: "The user was removed from the channel." }),
        });
      }
    },
    [removeUser, messages, openThread],
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

  const handleTogglePin = useCallback(
    async (event: NostrEvent) => {
      const pinned = isPinned(event.id);
      try {
        if (pinned) await unpin(event.id);
        else await pin(event.id);
      } catch {
        toast({
          title: pinned
            ? t({ id: "groupChat.unpinFailed", defaultMessage: "Couldn't unpin" })
            : t({ id: "groupChat.pinFailed", defaultMessage: "Couldn't pin" }),
          description: t({ id: "groupChat.relayRejected", defaultMessage: "The relay rejected the change." }),
          variant: "destructive",
        });
      }
    },
    [isPinned, pin, unpin],
  );

  // Calendar events come from a separate query; merge them by created_at.
  const calendarEvents = calendar?.events;
  const calendarMsgs = useMemo<ChatMsg[]>(
    () => (calendarEvents ?? []).map((c) => c.event as ChatMsg),
    [calendarEvents],
  );
  const timelineMessages = useMemo<ChatMsg[]>(() => {
    if (calendarMsgs.length === 0) return messages;
    return [...messages, ...calendarMsgs].sort((a, b) =>
      a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
    );
  }, [messages, calendarMsgs]);

  const messagesById = useMemo(() => {
    const map = new Map<string, ChatMsg>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);
  const replyParentOf = (msg: ChatMsg) => {
    const id = getReplyToId(msg);
    return id ? messagesById.get(id) : undefined;
  };

  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: async (original, content) => {
      const edited = await editMessage({ original, content });
      if (edited && edited.id !== original.id) {
        removeOptimistic(original.id);
        insertOptimistic(edited);
        markSent(edited.id);
      }
    },
    messages: timelineMessages,
    isPending: (id) => sendStatus[id] !== undefined,
    self: user?.pubkey,
  });

  const calendarFor = useMemo(() => {
    if (!calendar) return undefined;
    const map = new Map<string, MessageCalendar>();
    for (const c of calendar.events) {
      map.set(c.event.id, {
        event: c,
        tally: calendar.rsvpsFor(c),
        canRsvp: calendar.canRsvp,
        isSettingRsvp: calendar.isSettingRsvp,
        setRsvp: (status) => calendar.setRsvp(c, status),
      });
    }
    return (id: string) => map.get(id);
  }, [calendar]);

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: timelineMessages,
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
      isPinned,
      togglePin: handleTogglePin,
      replyCountFor,
      reactionsFor,
      zapsFor,
      calendarFor,
      openThread,
      threadRepliesFor,
      sendThreadReply: async (root, content, tags) => {
        await sendThreadReply(root, content, tags);
      },
    }),
    [
      timelineMessages,
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
      isPinned,
      handleTogglePin,
      replyCountFor,
      reactionsFor,
      zapsFor,
      calendarFor,
      openThread,
      threadRepliesFor,
      sendThreadReply,
    ],
  );

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0">
      <ComposerBoundsProvider value={composerBoundsRef}>
      <div className={cn("relative flex flex-col flex-1 min-h-0 min-w-0", chatColumnClass)}>
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
                  <FormattedMessage id="groupChat.noResults" defaultMessage="No messages found" />
                </p>
              </div>
            ) : (
              <>
                <p className="px-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground/80">
                  <FormattedMessage
                    id="groupChat.resultCount"
                    defaultMessage="{count, plural, one {# result} other {# results}}"
                    values={{ count: searchResults.length }}
                  />
                </p>
                {[...searchResults]
                  .sort((a, b) => a.created_at - b.created_at)
                  .map((msg) => (
                    <Nip29ChatMessage
                      key={msg.id}
                      event={msg}
                      relayUrl={relayUrl}
                      groupId={groupId}
                      transport={transport}
                      isEditing={false}
                      highlight={searchQuery}
                      continuation={false}
                      onEdit={startEditing}
                      onEditSubmit={handleEditSubmit}
                      onEditCancel={cancelEditing}
                      onJumpToReply={jumpToReply}
                      onReply={setReplyTo}
                      replyParent={replyParentOf(msg)}
                    />
                  ))}
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
                  <FormattedMessage id="groupChat.empty" defaultMessage="No messages yet" />
                </p>
              </div>
            }
            renderMessage={(msg, continuation) => (
              <Nip29ChatMessage
                key={msg.id}
                event={msg}
                relayUrl={relayUrl}
                groupId={groupId}
                transport={transport}
                isEditing={editingId === msg.id}
                active={activeId === msg.id}
                onToggleActive={toggleActive}
                continuation={continuation}
                onEdit={startEditing}
                onEditSubmit={handleEditSubmit}
                onEditCancel={cancelEditing}
                onJumpToReply={jumpToReply}
                onReply={setReplyTo}
                replyParent={replyParentOf(msg)}
              />
            )}
          />
        )}

        {searching ? null : user && canWrite ? (
          <ChatComposer
            relayUrl={relayUrl}
            groupId={groupId}
            messages={messages}
            // Built from the group's identity (as `recordSent` does), not the location.
            shareRoute={chatRoute({ kind: "nip29", relayUrl, groupId })}
            replyTo={replyTo}
            placeholder={channelName
              ? intl.formatMessage({ id: "groupChat.placeholder", defaultMessage: "Message {channel}" }, { channel: channelName })
              : undefined}
            // Android Direct Share label; the publisher can't resolve NIP-29 metadata.
            shareLabel={channelName}
            shareIconUrl={groupDetails?.group?.picture}
            onCancelReply={() => setReplyTo(undefined)}
            onJumpToReply={jumpToReply}
            onSent={pinToPresent}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSent={markSent}
            onOptimisticFailed={markFailed}
            canModerate={canModerate}
            botCommands
            onSlashAction={handleSlashAction}
            onEditLast={editLast}
            // Not on touch, where it raises the keyboard.
            autoFocus={!isTouch}
          />
        ) : membershipPending ? (
          <ComposerSkeleton />
        ) : (
          <div className="border-t p-3 shrink-0 pb-safe">
            {user ? (
              <p className="text-xs text-muted-foreground text-center py-1">
                <FormattedMessage id="groupChat.joinToSend" defaultMessage="Join this channel to send messages." />
              </p>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-1 flex items-center justify-center gap-1.5 flex-wrap">
                <FormattedMessage
                  id="groupChat.joinPrompt"
                  defaultMessage="<join>Join</join> <text>to be a part of the chat</text>"
                  values={{
                    join: (chunks: ReactNode[]) => (
                      <Button
                        size="sm"
                        onClick={() => setJoinDialogOpen(true)}
                        className="clip-corner-lg h-7 touch:h-10 px-4"
                      >
                        {chunks}
                      </Button>
                    ),
                    text: (chunks: ReactNode[]) => <span>{chunks}</span>,
                  }}
                />
              </p>
            )}
          </div>
        )}

        <LoginScreen
          isOpen={joinDialogOpen}
          onClose={() => setJoinDialogOpen(false)}
          onLogin={() => setJoinDialogOpen(false)}
          onSignupClick={() => {
            setJoinDialogOpen(false);
            setSignupDialogOpen(true);
          }}
        />
        <SignupDialog
          isOpen={signupDialogOpen}
          onClose={() => setSignupDialogOpen(false)}
        />
      </div>
      </ComposerBoundsProvider>

      <ThreadPanelSlot open={Boolean(threadRoot)} expanded={threadExpanded}>
        {lastThreadRoot && (
          <ThreadPanel
            root={lastThreadRoot}
            transport={transport}
            relayUrl={relayUrl}
            groupId={groupId}
            canWrite={Boolean(user && canWrite)}
            botCommands
            autoFocus={threadAutoFocus}
            open={Boolean(threadRoot)}
            permalink={threadPermalink}
            onClose={closeThread}
            onExpandChange={setThreadExpanded}
          />
        )}
      </ThreadPanelSlot>
    </div>
  );
}
