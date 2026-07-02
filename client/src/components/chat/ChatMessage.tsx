import { AlertCircle, Copy, Link2, MessagesSquare, Pencil, Pin, PinOff, Reply, Trash2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { ChatContent } from "@/components/chat/ChatContent";
import { LocationCard } from "@/components/chat/LocationCard";
import { MessageRow, type MessageIdentity } from "@/components/chat/MessageRow";
import { PollCard } from "@/components/chat/PollCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { dittoEventUrl } from "@/lib/dittoUrl";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { isLocationMessage, LOCATION_PREFIX, parseLocationEvent } from "@/lib/location";
import { isMeAction, meActionText } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import type { ChatMsg, MessageReactions, SendStatus } from "@/components/chat/transport";
import type { ReactNode } from "react";

/** NIP-88 poll kind. */
const KIND_POLL = 1068;

/** Extract the id of the message this event replies to (NIP-10 marked e tags). */
export function getReplyToId(event: ChatMsg): string | undefined {
  const replyTag = event.tags.find(([name, , , marker]) => name === "e" && marker === "reply");
  if (replyTag) return replyTag[1];
  const rootTag = event.tags.find(([name, , , marker]) => name === "e" && marker === "root");
  return rootTag?.[1];
}

/**
 * A one-line preview of a message's body for the reply-context line: URLs are
 * collapsed to 📎 (they'd blow out the line), and an all-URL/empty body falls
 * back to 📎. Shared so NIP-29 and Concord previews read identically.
 */
export function replyPreviewText(content: string): string {
  if (content.startsWith(LOCATION_PREFIX)) return "📍 Location";
  return content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";
}

/**
 * The compact "replying to …" context line shown above a reply message. Purely
 * presentational: the transport resolves WHO is replied to (and optionally a
 * content preview) — relay-fetched for NIP-29, the in-memory sealed author for
 * Concord — and hands the resolved `name`/`preview` here so the chrome (a
 * Discord-style quoted bar with the bold name + truncated preview) is defined
 * once. Renders nothing until a name is resolved (avoids a flash of an empty
 * line). When `onClick` is supplied the line jumps the timeline to the
 * replied-to message.
 */
export function ReplyContextLine({
  name,
  preview,
  onClick,
}: {
  name: string | undefined;
  preview?: string;
  onClick?: () => void;
}) {
  if (!name) return null;
  const content = (
    <>
      <span className="font-semibold shrink-0">{name}</span>
      {preview && <span className="truncate">{preview}</span>}
    </>
  );
  const className =
    "flex items-center gap-1.5 text-[11px] text-muted-foreground/80 mb-0.5 min-w-0 border-l-2 border-muted-foreground/30 pl-2";
  if (!onClick) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, "text-left hover:text-foreground hover:border-muted-foreground/60 transition-colors cursor-pointer")}
    >
      {content}
    </button>
  );
}

export interface ChatMessageProps {
  event: ChatMsg;
  canWrite: boolean;
  canModerate: boolean;
  /**
   * Explicit author identity for non-Nostr authors (Bluetooth mesh peers). When
   * set, the message header renders this name/color/suffix instead of resolving
   * a Nostr profile from `event.pubkey` (which is a mesh peer id, not a key).
   */
  identityOverride?: MessageIdentity;
  /**
   * Context for rendering/voting on NIP-88 polls in this message. Only NIP-29
   * group chat carries polls (kind 1068); transports without polls omit this
   * and a poll kind would never appear in their timeline.
   */
  pollContext?: { relayUrl: string; groupId: string };
  /** Resolved reaction tallies + toggle for this message. */
  reactions?: MessageReactions;
  /** Optimistic send status, if this message is locally-published & unconfirmed. */
  sendStatus?: SendStatus;
  /** Search term to highlight in the message body (search-results mode). */
  highlight?: string;
  /** Whether this message is currently being edited inline. */
  isEditing?: boolean;
  /** Whether this message is currently pinned (moderators only see the control). */
  isPinned?: boolean;
  /** Threaded-reply count, for the inline "N replies" badge. */
  replyCount?: number;
  /**
   * A rendered "replying to …" context line, shown above the body. The
   * transport owns resolving the referenced message (different per protocol),
   * so it's passed in as a node rather than computed here.
   */
  replyContext?: ReactNode;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Pin or unpin this message (moderators only; hidden when absent). */
  onTogglePin?: (event: ChatMsg) => void;
  /** Delete this message (hidden when absent). */
  onDelete?: (event: ChatMsg) => void;
  /** Begin a reply to this message (hidden when absent). */
  onReply?: (event: ChatMsg) => void;
  /** Open the threaded-replies side panel (hidden when absent). */
  onOpenThread?: (event: ChatMsg) => void;
  /** Begin editing this message (own, non-poll messages only; hidden when absent). */
  onEdit?: (event: ChatMsg) => void;
  /** Submit an inline edit with new content. */
  onEditSubmit?: (event: ChatMsg, content: string) => void;
  /** Cancel an in-progress inline edit. */
  onEditCancel?: () => void;
  /** Whether this message's tap-to-reveal toolbar is active (mobile only). */
  active?: boolean;
  /** Toggle this message's active state (mobile tap-to-reveal toolbar). */
  onToggleActive?: (id: string) => void;
  /** Render compactly as a continuation of the previous same-author message. */
  continuation?: boolean;
}

/**
 * Transport-agnostic presentational shell for a single chat message: the action
 * toolbar (react/reply/thread/edit/pin/delete), inline edit field, reaction bar,
 * reply-context line and send-status — all driven purely by props. NIP-29 group
 * chat and Concord communities both render through this component; the data and
 * mutations come from a {@link ChatTransport}, never from a relay hook here.
 *
 * Capabilities are presence-gated: a control renders only when its callback is
 * supplied (e.g. no `onTogglePin` ⇒ no pin button), so a transport that can't
 * do a thing shows no dead control for it.
 */
export function ChatMessage(props: ChatMessageProps) {
  return <ChatMessageInner {...props} />;
}

/**
 * Memoized to avoid re-rendering every message row when the timeline re-renders
 * (e.g. a new message or reaction arrives, or the channel polls). The transport
 * supplies stable `event`/`reactions`/callback identities for unchanged rows, so
 * `React.memo`'s shallow prop compare keeps untouched rows from re-tokenizing
 * content, rebuilding emoji maps, and re-running author queries.
 */
const ChatMessageInner = memo(function ChatMessageInner({
  event,
  canWrite,
  canModerate,
  identityOverride,
  pollContext,
  reactions,
  sendStatus,
  highlight,
  isEditing,
  isPinned,
  replyCount = 0,
  replyContext,
  onRetry,
  onDiscard,
  onTogglePin,
  onDelete,
  onReply,
  onOpenThread,
  onEdit,
  onEditSubmit,
  onEditCancel,
  active = false,
  onToggleActive,
  continuation = false,
}: ChatMessageProps) {
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const author = useAuthor(identityOverride ? undefined : event.pubkey);
  const scopedName = useScopedDisplayName(identityOverride ? undefined : event.pubkey, author.data?.metadata);
  const displayName = identityOverride?.name ?? scopedName;
  const replyToId = getReplyToId(event);
  const isPending = sendStatus === "pending";
  const isFailed = sendStatus === "failed";
  const isOwn = user?.pubkey === event.pubkey;
  // Highlight messages that mention you or reply to you: both add a `p` tag for
  // the current user (NIP-27 mention / NIP-10 reply). Not your own messages.
  const mentionsMe = Boolean(
    user && !isOwn && event.tags.some(([name, value]) => name === "p" && value === user.pubkey),
  );
  // Only plain chat messages are editable (polls carry structured tags).
  const canEdit = isOwn && event.kind === KIND_GROUP_CHAT && !isPending && !isFailed && Boolean(onEdit);
  // The author can delete their own confirmed message; moderators can delete
  // anyone's. The transport decides how (NIP-09 vs NIP-29 vs Concord delete).
  const canDelete = Boolean(onDelete) && ((isOwn && !isPending && !isFailed) || canModerate);
  // Moderators can pin any confirmed message.
  const canPin = Boolean(onTogglePin) && canModerate && !isPending && !isFailed;
  const wasEdited = event.tags.some(([name]) => name === "edited");
  const [editText, setEditText] = useState(event.content);
  // Two-step delete: the first click arms (highlights) the trash button, the
  // second click within the timeout actually deletes. Prevents fat-finger
  // deletes from a single misclick.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmDelete = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setDeleteArmed(false);
  }, []);

  const handleDeleteClick = useCallback(() => {
    if (deleteArmed) {
      disarmDelete();
      onDelete?.(event);
    } else {
      setDeleteArmed(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), 3000);
    }
  }, [deleteArmed, disarmDelete, onDelete, event]);

  // Clean up the disarm timer on unmount.
  useEffect(() => () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
  }, []);

  // Reset the draft whenever an edit (re)starts.
  useEffect(() => {
    if (isEditing) setEditText(event.content);
  }, [isEditing, event.content]);

  // Toggle the toolbar on tap (touch devices only — desktop reveals it on
  // hover, so a click must not highlight the row), but ignore taps that land on
  // interactive children (buttons, links, inputs, mention chips) so those still
  // act normally instead of being swallowed.
  const handleRowClick = useCallback((e: React.MouseEvent) => {
    if (!isTouch) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, [role='button']")) return;
    onToggleActive?.(event.id);
  }, [isTouch, onToggleActive, event.id]);

  const toolbar = (
    <>
      {canWrite && !isEditing && reactions && <ReactionPicker onReact={reactions.react} />}
      {canWrite && !isEditing && onReply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reply"
              className="size-9 md:size-7 text-muted-foreground hover:text-primary"
              onClick={() => onReply(event)}
            >
              <Reply className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reply</TooltipContent>
        </Tooltip>
      )}
      {canWrite && !isEditing && onOpenThread && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reply in thread"
              className="size-9 md:size-7 text-muted-foreground hover:text-primary"
              onClick={() => onOpenThread(event)}
            >
              <MessagesSquare className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reply in thread</TooltipContent>
        </Tooltip>
      )}
      {canEdit && !isEditing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit message"
              className="size-9 md:size-7 text-muted-foreground hover:text-primary"
              onClick={() => onEdit?.(event)}
            >
              <Pencil className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit message</TooltipContent>
        </Tooltip>
      )}
      {canPin && !isEditing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={isPinned ? "Unpin message" : "Pin message"}
              aria-pressed={isPinned}
              className={cn(
                "size-9 md:size-7",
                isPinned
                  ? "text-primary hover:text-primary"
                  : "text-muted-foreground hover:text-primary",
              )}
              onClick={() => onTogglePin?.(event)}
            >
              {isPinned ? <PinOff className="size-[18px] md:size-3.5" /> : <Pin className="size-[18px] md:size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isPinned ? "Unpin message" : "Pin message"}</TooltipContent>
        </Tooltip>
      )}
      {canDelete && !isEditing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={deleteArmed ? "Confirm delete message" : "Delete message"}
              aria-pressed={deleteArmed}
              className={cn(
                "size-9 md:size-7 transition-colors",
                deleteArmed
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "text-muted-foreground hover:text-destructive",
              )}
              onClick={handleDeleteClick}
            >
              <Trash2 className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{deleteArmed ? "Click again to delete" : "Delete message"}</TooltipContent>
        </Tooltip>
      )}
    </>
  );

  const body = (
    <>
      {isEditing ? (
        <div className="mt-0.5">
          <textarea
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onEditSubmit?.(event, editText);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onEditCancel?.();
              }
            }}
            rows={Math.min(6, Math.max(1, editText.split("\n").length))}
            className="w-full resize-none rounded-md bg-background border border-input px-2 py-1.5 text-[15px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            <button
              type="button"
              className="font-semibold text-primary hover:underline"
              onClick={() => onEditSubmit?.(event, editText)}
            >
              Save
            </button>
            <button type="button" className="hover:text-foreground" onClick={() => onEditCancel?.()}>
              Cancel
            </button>
            <span className="opacity-70">escape to cancel · enter to save</span>
          </div>
        </div>
      ) : event.kind === KIND_POLL ? (
        <>
          <ChatContent event={event} className="text-[15px]" highlight={highlight} />
          {pollContext && (
            <PollCard
              event={event}
              relayUrl={pollContext.relayUrl}
              groupId={pollContext.groupId}
              canVote={canWrite}
            />
          )}
        </>
      ) : isMeAction(event) ? (
        <div className="text-[15px] italic text-muted-foreground">
          <span className="font-semibold not-italic text-primary">{displayName}</span>{" "}
          <ChatContent
            event={event}
            contentOverride={meActionText(event)}
            className="inline italic"
            highlight={highlight}
            noMentionAtPrefix
          />
        </div>
      ) : isLocationMessage(event) ? (
        (() => {
          const point = parseLocationEvent(event);
          return point ? (
            <LocationCard point={point} />
          ) : (
            <ChatContent event={event} className="text-[15px]" highlight={highlight} />
          );
        })()
      ) : (
        <ChatContent event={event} className="text-[15px]" highlight={highlight} />
      )}
    </>
  );

  const afterBody = (
    <>
      {!isEditing && reactions && (
        <ReactionBar tallies={reactions.tallies} canReact={canWrite} onReact={reactions.react} />
      )}
      {!isEditing && replyCount > 0 && onOpenThread && (
        <button
          type="button"
          onClick={() => onOpenThread(event)}
          className="mt-0.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          <MessagesSquare className="size-3.5" />
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </button>
      )}
      {isFailed && (
        <div className="flex items-center gap-2 mt-1 text-[11px] text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>Failed to send.</span>
          {onRetry && (
            <button type="button" className="font-semibold underline hover:no-underline" onClick={onRetry}>
              Retry
            </button>
          )}
          {onDiscard && (
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onDiscard}>
              Discard
            </button>
          )}
        </div>
      )}
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <MessageRow
          pubkey={event.pubkey}
          identityOverride={identityOverride}
          createdAt={event.created_at}
          pending={isPending}
          edited={wasEdited && !isEditing}
          actions={toolbar}
          beforeBody={replyToId && replyContext}
          afterBody={afterBody}
          continuation={
            // Collapse into the previous message only for plain consecutive chats;
            // a reply line, edit field, pin or mention needs the full header.
            continuation && !replyToId && !isEditing && !isPinned && !mentionsMe
          }
          className={cn(
            active && "bg-secondary/40",
            isPinned && "bg-amber-500/5",
            mentionsMe && "bg-primary/10 hover:bg-primary/15 border-l-2 border-primary pl-2",
            isPending && "opacity-60",
            isFailed && "bg-destructive/5",
          )}
          containerProps={{
            onMouseLeave: disarmDelete,
            onClick: handleRowClick,
            "data-active": active || undefined,
            "data-event-id": event.id,
          } as React.HTMLAttributes<HTMLDivElement>}
        >
          {body}
        </MessageRow>
      </ContextMenuTrigger>
      {/* Discord-style right-click menu, mirroring the hover toolbar's
          capability gating. */}
      <ContextMenuContent className="w-52">
        {canWrite && !isEditing && onReply && (
          <ContextMenuItem onSelect={() => onReply(event)}>
            <Reply className="mr-2 size-4" /> Reply
          </ContextMenuItem>
        )}
        {canWrite && !isEditing && onOpenThread && (
          <ContextMenuItem onSelect={() => onOpenThread(event)}>
            <MessagesSquare className="mr-2 size-4" /> Reply in thread
          </ContextMenuItem>
        )}
        {canEdit && !isEditing && (
          <ContextMenuItem onSelect={() => onEdit?.(event)}>
            <Pencil className="mr-2 size-4" /> Edit message
          </ContextMenuItem>
        )}
        {canPin && !isEditing && (
          <ContextMenuItem onSelect={() => onTogglePin?.(event)}>
            {isPinned
              ? <><PinOff className="mr-2 size-4" /> Unpin message</>
              : <><Pin className="mr-2 size-4" /> Pin message</>}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => navigator.clipboard?.writeText(event.content)}>
          <Copy className="mr-2 size-4" /> Copy text
        </ContextMenuItem>
        {!identityOverride && (
          <ContextMenuItem
            onSelect={() => {
              try {
                navigator.clipboard?.writeText(
                  `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
                );
              } catch {
                navigator.clipboard?.writeText(event.id);
              }
            }}
          >
            <Link2 className="mr-2 size-4" /> Copy message ID
          </ContextMenuItem>
        )}
        {!identityOverride && dittoEventUrl(event) && (
          <ContextMenuItem
            onSelect={() => {
              const href = dittoEventUrl(event);
              if (href) window.open(href, "_blank", "noopener,noreferrer");
            }}
          >
            <DittoIcon className="mr-2 size-4" /> View on Ditto
          </ContextMenuItem>
        )}
        {canDelete && !isEditing && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete?.(event)}
            >
              <Trash2 className="mr-2 size-4" /> Delete message
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
