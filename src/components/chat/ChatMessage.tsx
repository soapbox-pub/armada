import { AlertCircle, Braces, Copy, Link2, MessagesSquare, Pencil, Pin, PinOff, Reply, Trash2, Zap } from "lucide-react";
import { nip19 } from "nostr-tools";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { ChatContent } from "@/components/chat/ChatContent";
import { MessageRow, type MessageIdentity } from "@/components/chat/MessageRow";
import { PollCard } from "@/components/chat/PollCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import { ZapButton } from "@/components/chat/ZapButton";
import { ZapDialog } from "@/components/chat/ZapDialog";
import { ZapPill } from "@/components/chat/ZapPill";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
import { dittoEventUrl } from "@/lib/dittoUrl";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { isMeAction, meActionText } from "@/lib/slashCommands";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { ChatMsg, MessageReactions, MessageZaps, SendStatus, ZapPayment } from "@/components/chat/transport";
import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import type { ReactNode } from "react";

/** NIP-88 poll kind. */
const KIND_POLL = 1068;

/** A `nostr:npub…`/`nostr:nprofile…`/bare-bech32 mention inside preview text. */
const REPLY_MENTION_RE =
  /(?:nostr:)?(npub1|nprofile1)([023456789acdefghjklmnpqrstuvwxyz]+)/gi;

/** Resolve a single mention pubkey to `@displayname` for the preview line. */
function ReplyMentionName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <span className="text-primary">@{name}</span>;
}

/**
 * A one-line reply preview that renders `@mentions` as resolved display names
 * (via {@link ReplyMentionName}) instead of a raw `nostr:npub…`/hex string, and
 * collapses URLs to 📎 — matching how the message body shows them. Falls back to
 * 📎 for an all-URL/empty body. Used inside the reply-context line and the
 * composer's reply banner.
 *
 * `hideMediaPlaceholder` drops the 📎 placeholder (used when a {@link
 * ReplyThumbnail} already shows the image, so an image-only reply reads as just
 * the thumbnail, not "📎").
 */
export function ReplyPreview({ content, hideMediaPlaceholder = false }: { content: string; hideMediaPlaceholder?: boolean }) {
  // Collapse URLs first (they'd blow out the single line), then split on
  // mentions so each resolves to @name.
  const placeholder = hideMediaPlaceholder ? "" : "📎";
  const withoutUrls = content.replace(/https?:\/\/\S+/g, placeholder);
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let hasText = false;
  for (const m of withoutUrls.matchAll(REPLY_MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      const text = withoutUrls.slice(last, start);
      if (text.trim()) hasText = true;
      parts.push(<span key={key++}>{text}</span>);
    }
    try {
      const decoded = nip19.decode(`${m[1]}${m[2]}`);
      const pubkey = decoded.type === "npub" ? decoded.data : decoded.type === "nprofile" ? decoded.data.pubkey : undefined;
      if (pubkey) {
        hasText = true;
        parts.push(<ReplyMentionName key={key++} pubkey={pubkey} />);
      } else {
        parts.push(<span key={key++}>{m[0]}</span>);
        hasText = true;
      }
    } catch {
      parts.push(<span key={key++}>{m[0]}</span>);
      hasText = true;
    }
    last = start + m[0].length;
  }
  if (last < withoutUrls.length) {
    const text = withoutUrls.slice(last);
    if (text.trim()) hasText = true;
    parts.push(<span key={key++}>{text}</span>);
  }
  if (!hasText) return hideMediaPlaceholder ? null : <>📎</>;
  return <>{parts}</>;
}

/**
 * A small square image thumbnail for the reply preview. Resolves the media the
 * same way the message body does ({@link useResolvedMediaSrc}) so Concord's
 * encrypted attachments decrypt too; renders nothing until it's ready (so the
 * line never flashes a broken image).
 */
export function ReplyThumbnail({ image }: { image: EncryptedRef }) {
  const resolved = useResolvedMediaSrc(image);
  if (resolved.status !== "ready") return null;
  return (
    <img
      src={resolved.src}
      alt=""
      className="h-10 w-auto max-w-[6rem] shrink-0 rounded object-cover"
      loading="lazy"
    />
  );
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
  thumbnail,
  onClick,
}: {
  name: string | undefined;
  preview?: ReactNode;
  /** Optional media thumbnail shown before the preview (e.g. an image reply). */
  thumbnail?: ReactNode;
  onClick?: () => void;
}) {
  if (!name) return null;
  const content = (
    <>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="font-semibold shrink-0">{name}</span>
        {preview && <span className="truncate">{preview}</span>}
      </span>
      {thumbnail && <span className="mt-0.5">{thumbnail}</span>}
    </>
  );
  const className =
    "flex flex-col text-[11px] text-muted-foreground/80 mb-0.5 min-w-0 border-l-2 border-muted-foreground/30 pl-2";
  if (!onClick) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, "items-start text-left hover:text-foreground hover:border-muted-foreground/60 transition-colors cursor-pointer")}
    >
      {content}
    </button>
  );
}

/** One reply participant's avatar in the thread badge's overlapping stack. */
function ThreadParticipantAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = useScopedDisplayName(pubkey, metadata);
  return (
    <Avatar shape={getAvatarShape(metadata)} className="size-5 ring-2 ring-background">
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/25 text-primary text-[9px] font-semibold">
        {name[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The prominent, Slack-style "thread" affordance shown under a message that has
 * replies: an overlapping avatar stack of the (distinct) repliers, the reply
 * count, "Last reply …" recency, and a chevron. Clicking opens the thread.
 */
function ThreadBadge({
  count,
  participants,
  lastReplyAt,
  onClick,
}: {
  count: number;
  participants: string[];
  lastReplyAt?: number;
  onClick: () => void;
}) {
  const shown = participants.slice(0, 4);
  const overflow = participants.length - shown.length;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-transparent bg-primary/[0.07] py-1 pl-1 pr-2.5 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.12]"
    >
      <span className="flex shrink-0 -space-x-1.5">
        {shown.map((pk) => (
          <ThreadParticipantAvatar key={pk} pubkey={pk} />
        ))}
        {overflow > 0 && (
          <span className="flex size-5 items-center justify-center rounded-full ring-2 ring-background bg-primary/25 text-primary text-[9px] font-semibold tabular-nums">
            +{overflow}
          </span>
        )}
      </span>
      <span className="text-[13px] font-semibold text-primary">
        {count} {count === 1 ? "reply" : "replies"}
      </span>
      {lastReplyAt ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {shortTimeAgo(lastReplyAt)}
        </span>
      ) : null}
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
  /** Whether this surface supports zaps (shows the ⚡ button on others' messages). */
  zapEnabled?: boolean;
  /** Aggregated zaps for this message (feeds the ⚡ total chip). */
  zaps?: MessageZaps;
  /**
   * CORD.md announcement publisher (Concord v2). Passed through to the zap
   * dialog; absent means the NIP-57 public-receipt flow.
   */
  onSendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /** Optimistic send status, if this message is locally-published & unconfirmed. */
  sendStatus?: SendStatus;
  /** Search term to highlight in the message body (search-results mode). */
  highlight?: string;
  /** Whether this message is currently being edited inline. */
  isEditing?: boolean;
  /** Whether this message is currently pinned (moderators only see the control). */
  isPinned?: boolean;
  /** Threaded-reply count, for the inline "N replies" thread badge. */
  replyCount?: number;
  /**
   * Distinct pubkeys that have replied in this message's thread (newest-first),
   * for the thread badge's avatar stack. Deduped by the transport.
   */
  threadParticipants?: string[];
  /** Timestamp (epoch seconds) of the latest reply, shown as "Last reply …". */
  lastReplyAt?: number;
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
  /** Open the threaded-replies side panel — the "reply in thread" action (hidden when absent). */
  onOpenThread?: (event: ChatMsg) => void;
  /**
   * Begin an inline reply to this message (Signal/Discord style — quoted in the
   * timeline, distinct from a thread reply). Hidden when absent.
   */
  onReply?: (event: ChatMsg) => void;
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
  /**
   * When set, this message is an unsigned rumor (e.g. a Concord V2 sealed chat
   * event) rather than a relay-addressable signed event. The context menu then
   * offers "View event JSON" (a dialog with this object, pretty-printed) instead
   * of the "Copy message ID" / "View on Ditto" off-ramps, which reference a
   * relay-addressable event id that doesn't exist for a rumor.
   */
  rumor?: unknown;
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
  zapEnabled,
  zaps,
  onSendZap,
  sendStatus,
  highlight,
  isEditing,
  isPinned,
  replyCount = 0,
  threadParticipants,
  lastReplyAt,
  replyContext,
  onRetry,
  onDiscard,
  onTogglePin,
  onDelete,
  onOpenThread,
  onReply,
  onEdit,
  onEditSubmit,
  onEditCancel,
  active = false,
  onToggleActive,
  continuation = false,
  rumor,
}: ChatMessageProps) {
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const author = useAuthor(identityOverride ? undefined : event.pubkey);
  const scopedName = useScopedDisplayName(identityOverride ? undefined : event.pubkey, author.data?.metadata);
  const displayName = identityOverride?.name ?? scopedName;
  // An inline reply renders a "replying to …" line above the body. The page
  // resolves it per-protocol (NIP-29 NIP-10 `e`, Concord NIP-C7 `q`) and passes
  // it as `replyContext`; its presence is the authoritative "this is a reply".
  const hasReplyContext = Boolean(replyContext);
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

  // Raw-event JSON viewer (rumor context menu).
  const [jsonOpen, setJsonOpen] = useState(false);

  // Zap dialog. The button shows on others' messages when the surface supports
  // zaps; it disables (with a hint) once the author's profile has loaded
  // without a lightning address. While the profile is still loading the button
  // stays enabled — the dialog re-checks and explains.
  const [zapOpen, setZapOpen] = useState(false);
  const authorMetadata = author.data?.metadata;
  const canZap = Boolean(zapEnabled && user && !isOwn && !identityOverride);
  const zapDisabled = Boolean(author.data && !authorMetadata?.lud16 && !authorMetadata?.lud06);
  const rumorJson = rumor === undefined ? null : JSON.stringify(rumor, null, 2);

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
      {canZap && !isEditing && <ZapButton disabled={zapDisabled} onOpen={() => setZapOpen(true)} />}
      {canWrite && !isEditing && onOpenThread && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reply"
              className="size-9 md:size-7 text-muted-foreground hover:text-primary"
              onClick={() => onOpenThread(event)}
            >
              <Reply className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reply</TooltipContent>
        </Tooltip>
      )}
      {canWrite && !isEditing && onReply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Quote"
              className="size-9 md:size-7 text-muted-foreground hover:text-primary"
              onClick={() => onReply(event)}
            >
              <MessagesSquare className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Quote</TooltipContent>
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
      ) : (
        <ChatContent event={event} className="text-[15px]" highlight={highlight} />
      )}
    </>
  );

  // The ⚡ total chip sits inline with the reaction pills (one row), as an
  // extra pill — not its own line.
  const zapPill =
    !isEditing && zaps && zaps.tally.count > 0 ? (
      <ZapPill tally={zaps.tally} canZap={canZap && !zapDisabled} onZap={() => setZapOpen(true)} />
    ) : null;

  const afterBody = (
    <>
      {!isEditing && reactions ? (
        <ReactionBar
          tallies={reactions.tallies}
          canReact={canWrite}
          onReact={reactions.react}
          leading={zapPill}
        />
      ) : (
        zapPill && <div className="flex flex-wrap items-center gap-1.5 mt-1.5">{zapPill}</div>
      )}
      {!isEditing && replyCount > 0 && onOpenThread && (
        <ThreadBadge
          count={replyCount}
          participants={threadParticipants ?? []}
          lastReplyAt={lastReplyAt}
          onClick={() => onOpenThread(event)}
        />
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
    <>
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <MessageRow
          pubkey={event.pubkey}
          identityOverride={identityOverride}
          createdAt={event.created_at}
          pending={isPending}
          edited={wasEdited && !isEditing}
          actions={toolbar}
          beforeBody={hasReplyContext ? replyContext : undefined}
          afterBody={afterBody}
          continuation={
            // Collapse into the previous message only for plain consecutive chats;
            // a reply line, edit field, pin or mention needs the full header.
            continuation && !hasReplyContext && !isEditing && !isPinned && !mentionsMe
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
        {canWrite && !isEditing && onOpenThread && (
          <ContextMenuItem onSelect={() => onOpenThread(event)}>
            <Reply className="mr-2 size-4" /> Reply
          </ContextMenuItem>
        )}
        {canWrite && !isEditing && onReply && (
          <ContextMenuItem onSelect={() => onReply(event)}>
            <MessagesSquare className="mr-2 size-4" /> Quote
          </ContextMenuItem>
        )}
        {canZap && !isEditing && !zapDisabled && (
          <ContextMenuItem onSelect={() => setZapOpen(true)}>
            <Zap className="mr-2 size-4" /> Zap message
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
        <ContextMenuItem onSelect={() => writeClipboardText(event.content).catch(() => undefined)}>
          <Copy className="mr-2 size-4" /> Copy text
        </ContextMenuItem>
        {!identityOverride && !rumor && (
          <ContextMenuItem
            onSelect={() => {
              try {
                writeClipboardText(
                  `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
                ).catch(() => undefined);
              } catch {
                writeClipboardText(event.id).catch(() => undefined);
              }
            }}
          >
            <Link2 className="mr-2 size-4" /> Copy message ID
          </ContextMenuItem>
        )}
        {!identityOverride && !rumor && dittoEventUrl(event) && (
          <ContextMenuItem
            onSelect={() => {
              const href = dittoEventUrl(event);
              if (href) window.open(href, "_blank", "noopener,noreferrer");
            }}
          >
            <DittoIcon className="mr-2 size-4" /> View on Ditto
          </ContextMenuItem>
        )}
        {rumorJson !== null && (
          <ContextMenuItem onSelect={() => setJsonOpen(true)}>
            <Braces className="mr-2 size-4" /> View event JSON
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
    {zapOpen && (
      <ZapDialog open={zapOpen} onOpenChange={setZapOpen} target={event} sendZap={onSendZap} />
    )}
    {rumorJson !== null && (
      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Event JSON</DialogTitle>
            <DialogDescription>
              The raw, unsigned rumor for this message.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {rumorJson}
          </pre>
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => writeClipboardText(rumorJson).catch(() => undefined)}
            >
              <Copy className="mr-2 size-4" /> Copy JSON
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  );
});
