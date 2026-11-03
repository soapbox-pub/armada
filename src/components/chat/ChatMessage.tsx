import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Braces, Copy, CornerDownRight, EyeOff, Flag, Forward, Link, Link2, MessagesSquare, Pencil, Pin, PinOff, Reply, Trash2, User, Zap } from "lucide-react";
import { nip19 } from "nostr-tools";
import { memo, useCallback, useContext, useMemo, useRef, useState } from "react";

import { ChatContent } from "@/components/chat/ChatContent";
import { emojify } from "@/components/chat/emojify";
import { MessageActionSheet } from "@/components/chat/MessageActionSheet";
import { MessageEditBox } from "@/components/chat/MessageEditBox";
import { MessageActionToolbar } from "@/components/chat/MessageActionToolbar";
import { MessageRow, type MessageIdentity } from "@/components/chat/MessageRow";
import { CalendarEventMessageCard } from "@/components/chat/CalendarEventCard";
import { PollCard } from "@/components/chat/PollCard";
import { PollView } from "@/components/chat/PollView";
import { ReactionBar } from "@/components/chat/ReactionBar";
import { ReportDialog } from "@/components/ReportDialog";
import { ZapDialog } from "@/components/chat/ZapDialog";
import { ZapPill } from "@/components/chat/ZapPill";
import { DisplayName } from "@/components/DisplayName";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { MessageMenuItems } from "@/components/chat/MessageMenuItems";
import { MenuReactionPicker, MenuReactionRow } from "@/components/chat/MenuReactions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LazyContextMenuContent, useLazyContextMenu } from "@/components/chat/LazyContextMenu";
import { EventJsonDialog } from "@/components/EventJsonDialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useChatScope } from "@/hooks/useChatScope";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useUserModeration } from "@/hooks/useUserModeration";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useOpenProfile } from "@/hooks/useOpenProfile";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useToast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { AppContext } from "@/contexts/AppContext";
import { isIosApp } from "@/lib/platform";
import { sendsOnEnter } from "@/lib/sendOnEnter";
import { getComposerCollisionPadding, useComposerBoundsRef } from "@/contexts/ComposerBoundsContext";
import { ChatImageMenuContext, contextActionsAt, keepSelectionOnRightPress, withImageActions, type ChatImageMenu } from "@/contexts/ChatImageMenuContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { buildEmojiMap } from "@/lib/customEmoji";
import { writeClipboardText } from "@/lib/clipboard";
import { chatUrl, type ChatRoute } from "@/lib/routes";
import { tryNpubEncode } from "@/lib/safeNip19";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { expirationOf, KIND_DM_CHAT } from "@/lib/nip17/protocol";
import { parseProxyTag } from "@/lib/nip48";
import { reportDestination, type ReportTarget } from "@/lib/report";
import { getActivePubkey } from "@/lib/activeAccount";
import { removeMessageFromDevice } from "@/lib/removeMessageFromDevice";
import { requestCommand } from "@/hooks/useCommandBus";
import { commandLine } from "@/lib/botCommands";
import { isMeAction, meActionText } from "@/lib/slashCommands";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ChatMsg, MessageCalendar, MessagePoll, MessageReactions, MessageZaps, OnchainZapAnnouncement, SendStatus, ZapPayment } from "@/components/chat/transport";
import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import type { ReactNode } from "react";

import { KIND_CALENDAR_DATE, KIND_CALENDAR_TIME } from "@/lib/calendar";
import { KIND_POLL } from "@/lib/polls";
import { AvatarInitial } from "@/components/AvatarInitial";
import { MotionImg } from "@/components/ui/MotionImg";

/** A `nostr:npub…`/`nostr:nprofile…`/bare-bech32 mention inside preview text. */
const REPLY_MENTION_RE =
  /(?:nostr:)?(npub1|nprofile1)([023456789acdefghjklmnpqrstuvwxyz]+)/gi;

function ReplyMentionName({ pubkey }: { pubkey: string }) {
  return <span className="text-primary">@<DisplayName pubkey={pubkey} /></span>;
}

function InvokedBotName({ pubkey }: { pubkey: string }) {
  return <span className="font-semibold not-italic text-primary"><DisplayName pubkey={pubkey} /></span>;
}

/**
 * One-line reply preview: mentions as `@name`, URLs as 📎 (dropped with
 * `hideMediaPlaceholder` when a thumbnail shows), NIP-30 emoji when `tags` given.
 */
export function ReplyPreview({ content, hideMediaPlaceholder = false, tags }: { content: string; hideMediaPlaceholder?: boolean; tags?: string[][] }) {
  const placeholder = hideMediaPlaceholder ? "" : "📎";
  const withoutUrls = content.replace(/https?:\/\/\S+/g, placeholder);
  const emojiMap = tags ? buildEmojiMap(tags) : undefined;
  const renderText = (text: string): ReactNode =>
    emojiMap && emojiMap.size > 0
      ? emojify(text, emojiMap, "inline h-[1.15em] w-[1.15em] object-contain align-text-bottom")
      : text;
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let hasText = false;
  for (const m of withoutUrls.matchAll(REPLY_MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      const text = withoutUrls.slice(last, start);
      if (text.trim()) hasText = true;
      parts.push(<span key={key++}>{renderText(text)}</span>);
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
    parts.push(<span key={key++}>{renderText(text)}</span>);
  }
  if (!hasText) return hideMediaPlaceholder ? null : <>📎</>;
  return <>{parts}</>;
}

/** Reply thumbnail, resolved like the body (decrypts Concord media); renders nothing until ready. */
export function ReplyThumbnail({ image }: { image: EncryptedRef }) {
  const { resolved, onError } = useMediaWithFallback(image);
  if (resolved.status !== "ready") return null;
  return (
    <MotionImg
      src={resolved.src}
      alt=""
      className="size-4 shrink-0 rounded-[3px] object-cover"
      loading="lazy"
      onError={onError}
    />
  );
}

/**
 * "Replying to …" line above a reply, tied to the row's avatar by a
 * `.chat-reply-connector` elbow; must sit directly above the avatar (see
 * MessageRow). Presentational: the transport resolves `name`/`preview`.
 */
export function ReplyContextLine({
  name,
  pubkey,
  preview,
  thumbnail,
  onClick,
}: {
  name: string | undefined;
  pubkey?: string;
  preview?: ReactNode;
  thumbnail?: ReactNode;
  onClick?: () => void;
}) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  if (!name) return null;
  const content = (
    <>
      <span aria-hidden className="chat-reply-connector" />
      {pubkey && (
        <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt="" />
          <AvatarFallback className="bg-primary/20 text-primary text-monogram">
            <AvatarInitial name={name} pubkey={pubkey} />
          </AvatarFallback>
        </Avatar>
      )}
      <span className="font-semibold shrink-0 text-primary group-hover/reply:underline">
        {pubkey ? <DisplayName pubkey={pubkey} name={name} /> : name}
      </span>
      {thumbnail}
      {preview && <span className="line-clamp-1 break-words min-w-0 text-muted-foreground/70">{preview}</span>}
    </>
  );
  if (!onClick) {
    return <div className={REPLY_LINE_CLASS}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(REPLY_LINE_CLASS, "text-left cursor-pointer")}
    >
      {content}
    </button>
  );
}

const REPLY_LINE_CLASS =
  "chat-reply group/reply relative flex items-center gap-1.5 min-w-0 max-w-full pl-[3.25rem] pr-2 pt-1.5 pb-1 mb-1 text-xs";

/**
 * {@link ReplyContextLine} for a parent that isn't loaded. Names no author: the
 * reply's own `q`/`p` tags would let its sender attribute the parent to anyone.
 */
export function ReplyContextUnavailable({ onClick }: { onClick: () => void }) {
  const intl = useIntl();
  return (
    <button
      type="button"
      onClick={onClick}
      title={intl.formatMessage({ id: "chatMessage.findOriginal", defaultMessage: "Find the original message" })}
      className={cn(REPLY_LINE_CLASS, "text-left cursor-pointer")}
    >
      <span aria-hidden className="chat-reply-connector" />
      <Reply aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
      <span className="line-clamp-1 min-w-0 italic text-muted-foreground/70 group-hover/reply:underline">
        <FormattedMessage id="chatMessage.originalNotLoaded" defaultMessage="Original message not loaded" />
      </span>
    </button>
  );
}

function ThreadParticipantAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = useScopedDisplayName(pubkey, metadata);
  return (
    <Avatar shape={getAvatarShape(metadata)} className="size-5 ring-2 ring-background">
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-primary/25 text-primary text-monogram font-semibold">
        <AvatarInitial name={name} pubkey={pubkey} />
      </AvatarFallback>
    </Avatar>
  );
}

/** Slack-style thread affordance: replier avatars, count, last-reply recency. */
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
      className="mt-1 inline-flex max-w-full items-center gap-2 clip-corner bg-primary/[0.07] py-1 pl-1 pr-2.5 touch:py-2 touch:pr-3.5 text-left transition-colors hover:bg-primary/[0.12]"
    >
      <span className="flex shrink-0 -space-x-1.5">
        {shown.map((pk) => (
          <ThreadParticipantAvatar key={pk} pubkey={pk} />
        ))}
        {overflow > 0 && (
          <span className="flex size-5 items-center justify-center rounded-full ring-2 ring-background bg-primary/25 text-primary text-monogram font-semibold tabular-nums">
            +{overflow}
          </span>
        )}
      </span>
      <span className="text-[13px] font-semibold text-primary">
        <FormattedMessage
          id="chatMessage.replyCount"
          defaultMessage="{count} {count, plural, one {reply} other {replies}}"
          values={{ count }}
        />
      </span>
      {lastReplyAt ? (
        <span className="truncate text-2xs text-muted-foreground">
          {shortTimeAgo(lastReplyAt)}
        </span>
      ) : null}
    </button>
  );
}

/** Keep focus where a menu action put it (e.g. Reply → composer) instead of restoring it. */
function keepActionFocus(e: Event) {
  const active = document.activeElement;
  if (active && active !== document.body) e.preventDefault();
}

export interface ChatMessageProps {
  event: ChatMsg;
  canWrite: boolean;
  canModerate: boolean;
  /** Non-Nostr author identity (mesh peers, whose `event.pubkey` is a peer id). */
  identityOverride?: MessageIdentity;
  /** NIP-88 poll context (kind 1068). Only NIP-29 carries polls this way. */
  pollContext?: { relayUrl: string; groupId: string };
  /** Poll tally + vote for transports that fold it themselves (Concord); NIP-29 uses {@link pollContext}. */
  poll?: MessagePoll;
  /** Calendar event (kind 31922/31923) + RSVP state; renders the inline event card. */
  calendar?: MessageCalendar;
  reactions?: MessageReactions;
  zapEnabled?: boolean;
  zaps?: MessageZaps;
  /** CORD.md announcement publisher (Concord); absent means the NIP-57 receipt flow. */
  onSendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /** CORD.md on-chain zap announcement publisher (Concord). */
  onSendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
  sendStatus?: SendStatus;
  highlight?: string;
  isEditing?: boolean;
  isPinned?: boolean;
  replyCount?: number;
  /** Distinct repliers (newest-first) for the thread badge. */
  threadParticipants?: string[];
  /** Epoch seconds. */
  lastReplyAt?: number;
  /** Rendered "replying to …" line; resolved by the transport per protocol. */
  replyContext?: ReactNode;
  /**
   * Heading above the body (Concord forum post subject, CORD-03 §3). Also
   * disables continuation collapsing.
   */
  heading?: ReactNode;
  onRetry?: () => void;
  onDiscard?: () => void;
  onTogglePin?: (event: ChatMsg) => void;
  onDelete?: (event: ChatMsg) => void;
  onOpenThread?: (event: ChatMsg) => void;
  /** Inline (quoted) reply, distinct from a thread reply. */
  onReply?: (event: ChatMsg) => void;
  /** Forward, Signal-style: re-sent as a NEW message by the forwarder, no attribution. */
  onForward?: (event: ChatMsg) => void;
  /** "Jump to message" for rows shown outside their timeline (search results). */
  onJump?: () => void;
  onEdit?: (event: ChatMsg) => void;
  onEditSubmit?: (event: ChatMsg, content: string) => void;
  onEditCancel?: () => void;
  active?: boolean;
  onToggleActive?: (id: string) => void;
  continuation?: boolean;
  /**
   * Highlight rows that p-tag the viewer. Off in DMs, where kind-14 rumors always
   * p-tag the recipient.
   */
  mentionHighlight?: boolean;
  everyoneMention?: boolean;
  /** Badge after the author's name, e.g. the DM page's "NIP-04" marker. */
  nameBadge?: ReactNode;
  /**
   * Room (+ thread) for "Copy message link" (`/m/<id>` appended, so a reply's link
   * opens its thread). Omit where rows aren't addressable.
   */
  permalink?: ChatRoute;
  /**
   * The unsigned rumor (Concord) for "View event JSON"; also suppresses "Copy
   * message ID" (no relay-addressable id).
   */
  rumor?: unknown;
  /**
   * Declared bot command names, so an untagged `/cmd` in a 1:1 DM renders as an
   * action line without promoting undeclared `/word` prose.
   */
  knownCommands?: ReadonlySet<string>;
}

/**
 * Transport-agnostic chat message shell; data and mutations come from a
 * {@link ChatTransport}. Controls render only when their callback is supplied.
 * Memoized: transports keep identities stable for unchanged rows.
 */
const ChatMessageInner = memo(function ChatMessageInner({
  event,
  canWrite,
  canModerate,
  identityOverride,
  pollContext,
  poll,
  calendar,
  reactions,
  zapEnabled,
  zaps,
  onSendZap,
  onSendOnchainZap,
  sendStatus,
  highlight,
  isEditing,
  isPinned,
  replyCount = 0,
  threadParticipants,
  lastReplyAt,
  replyContext,
  heading,
  onRetry,
  onDiscard,
  onTogglePin,
  onDelete,
  onOpenThread,
  onReply,
  onForward,
  onJump,
  onEdit,
  onEditSubmit,
  onEditCancel,
  active = false,
  onToggleActive,
  continuation = false,
  mentionHighlight = true,
  everyoneMention = false,
  nameBadge,
  permalink,
  rumor,
  knownCommands,
}: ChatMessageProps) {
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  // `useContext`, not `useAppContext` (which throws): mountable bare in tests.
  const appConfig = useContext(AppContext)?.config;
  const sendOnEnter = sendsOnEnter(appConfig?.sendOnEnter, isTouch);
  const hoverActions = appConfig?.messageHoverActions ?? true;
  const replyGestures = appConfig?.replyGestures ?? "swipe";
  const composerBoundsRef = useComposerBoundsRef();
  // The author name is resolved by MessageRow, not here. A bot command reads as
  // an action line rather than raw arguments.
  const invocation = useMemo(
    () => commandLine(event.content, event.tags, knownCommands),
    [event.content, event.tags, knownCommands],
  );
  // Its presence is the authoritative "this is a reply".
  const hasReplyContext = Boolean(replyContext);
  const isPending = sendStatus === "pending";
  const isFailed = sendStatus === "failed";
  const isOwn = user?.pubkey === event.pubkey;
  // Mentions, replies to you, or authorized @everyone; never your own. Off in DMs.
  const mentionsMe = Boolean(
    mentionHighlight &&
      user && !isOwn && (
        everyoneMention
        || event.tags.some(([name, value]) => name === "p" && value === user.pubkey)
      ),
  );
  // Structured rows carry semantics an inline text field can't preserve.
  const canEdit =
    isOwn &&
    (event.kind === KIND_GROUP_CHAT || event.kind === KIND_DM_CHAT) &&
    !isPending &&
    !isFailed &&
    Boolean(onEdit);
  const canDelete = Boolean(onDelete) && ((isOwn && !isPending && !isFailed) || canModerate);
  const canPin = Boolean(onTogglePin) && canModerate && !isPending && !isFailed;
  const wasEdited = event.tags.some(([name]) => name === "edited");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Built on first long-press, not per row (it is the heaviest per-row mount).
  // Latched so closing still animates.
  const [sheetBuilt, setSheetBuilt] = useState(false);
  if (sheetOpen && !sheetBuilt) setSheetBuilt(true);
  // Image actions staged by a long-press/right-click on an image. Reset when the
  // next menu opens, not on close, so the closing menu keeps its rows.
  const [imageActions, setImageActions] = useState<MessageActionItem[] | null>(null);

  const [jsonOpen, setJsonOpen] = useState(false);

  // Report destination comes from the chat scope. `undefined`: moderators exist
  // but can't be reached privately (legacy Concord epoch), so no report.
  const [reportOpen, setReportOpen] = useState(false);
  // Built on first right-click (see useLazyContextMenu).
  const stageLinkActions = useCallback(
    (e: React.MouseEvent) => setImageActions(contextActionsAt(e.target, e.currentTarget)),
    [],
  );
  const contextMenu = useLazyContextMenu();
  const [menuPickerOpen, setMenuPickerOpen] = useState(false);
  // Opened once the menu has unmounted: its focus trap outlives the close and
  // would pull focus back out of the picker, which dismisses it.
  const menuPickerPending = useRef(false);
  const openMenuPicker = useCallback(() => {
    menuPickerPending.current = true;
  }, []);
  const closeMenuPicker = useCallback(() => setMenuPickerOpen(false), []);
  const onMenuCloseAutoFocus = useCallback((e: Event) => {
    keepActionFocus(e);
    if (!menuPickerPending.current) return;
    menuPickerPending.current = false;
    setMenuPickerOpen(true);
  }, []);
  const chatScope = useChatScope();
  const reportTo = reportDestination(chatScope);
  // Mesh/proxied identities aren't Nostr pubkeys.
  const canReport = Boolean(reportTo && user && !isOwn && !identityOverride);

  // A private list on the user's account, so offered in every room.
  const personModeration = useUserModeration(identityOverride ? undefined : event.pubkey, { report: false });

  // Suppressed for mesh/proxied rows (peer id, not a key).
  const openProfile = useOpenProfile();
  const { toast } = useToast();
  const intl = useIntl();

  // Viewer-local, unpublished and undoable, so offered in every room.
  const hiddenMessages = useHiddenMessages();

  // Never gated on a lightning address: the dialog defaults to Bitcoin (derived
  // from pubkey) and NIP-A3 targets.
  const [zapOpen, setZapOpen] = useState(false);
  const canZap = Boolean(zapEnabled && user && !isOwn && !identityOverride);
  const isRumor = rumor !== undefined;
  // A PUBLIC report (DM) names only the person: a rumor id nobody can fetch
  // proves nothing. Elsewhere the id resolves for the report's recipients.
  // Reporting can also remove the message from this device: stored copies, media, and any re-delivery.
  const queryClient = useQueryClient();
  const removeLocal = useCallback(() => {
    const viewer = getActivePubkey();
    if (viewer) void removeMessageFromDevice(viewer, event, { queryClient });
  }, [event, queryClient]);
  const reportTarget: ReportTarget =
    isRumor && reportTo?.kind === "network"
      ? { pubkey: event.pubkey }
      : { pubkey: event.pubkey, eventId: event.id };

  // The spurious dismiss from the opening gesture is refused in MessageActionSheet.
  const openSheet = useCallback(() => {
    setImageActions(null);
    setSheetOpen(true);
    if (!active) onToggleActive?.(event.id);
  }, [active, onToggleActive, event.id]);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open && active) onToggleActive?.(event.id);
  }, [active, onToggleActive, event.id]);

  // Images hand their actions up: touch opens the sheet with them; desktop stages
  // them for the context menu the same click opens.
  const openImageSheet = useCallback((acts: MessageActionItem[]) => {
    setImageActions(acts);
    setSheetOpen(true);
    if (!active) onToggleActive?.(event.id);
  }, [active, onToggleActive, event.id]);

  const imageMenu = useMemo<ChatImageMenu>(
    () => ({ isTouch, openSheet: openImageSheet, stage: setImageActions }),
    [isTouch, openImageSheet],
  );

  const copyMessageId = useCallback(() => {
    try {
      writeClipboardText(
        `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
      ).catch(() => undefined);
    } catch {
      writeClipboardText(event.id).catch(() => undefined);
    }
  }, [event.id, event.pubkey]);

  // One list drives the touch sheet, `⋯` overflow and right-click menu.
  const menuActions: MessageActionItem[] = [];
  if (onJump) {
    menuActions.push({ id: "jump", label: intl.formatMessage({ id: "chatMessage.jump", defaultMessage: "Jump to message" }), icon: CornerDownRight, onSelect: onJump });
  }
  if (canWrite && !isEditing && onReply) {
    menuActions.push({ id: "reply", label: intl.formatMessage(common.reply), icon: Reply, onSelect: () => onReply(event) });
  }
  if (canWrite && !isEditing && onOpenThread) {
    menuActions.push({
      id: "thread",
      label: intl.formatMessage({ id: "chatMessage.replyInThread", defaultMessage: "Reply in thread" }),
      icon: MessagesSquare,
      onSelect: () => onOpenThread(event),
    });
  }
  // Not gated on `canWrite` (composed in the destination). Not for polls or
  // structured rows, whose text alone would mislead.
  if (onForward && !isEditing && !poll && event.content.trim().length > 0) {
    menuActions.push({
      id: "forward",
      label: intl.formatMessage({ id: "chatMessage.forward", defaultMessage: "Forward message" }),
      icon: Forward,
      onSelect: () => onForward(event),
    });
  }
  if (canZap && !isEditing) {
    menuActions.push({ id: "zap", label: intl.formatMessage({ id: "chatMessage.zap", defaultMessage: "Zap message" }), icon: Zap, onSelect: () => setZapOpen(true) });
  }
  if (canEdit && !isEditing) {
    menuActions.push({
      id: "edit",
      label: intl.formatMessage({ id: "chatMessage.edit", defaultMessage: "Edit message" }),
      icon: Pencil,
      onSelect: () => onEdit?.(event),
    });
  }
  if (canPin && !isEditing) {
    menuActions.push({
      id: "pin",
      label: isPinned ? intl.formatMessage({ id: "chatMessage.unpin", defaultMessage: "Unpin message" }) : intl.formatMessage({ id: "chatMessage.pin", defaultMessage: "Pin message" }),
      icon: isPinned ? PinOff : Pin,
      onSelect: () => onTogglePin?.(event),
    });
  }
  menuActions.push({
    id: "copy-text",
    label: intl.formatMessage({ id: "chatMessage.copyText", defaultMessage: "Copy text" }),
    icon: Copy,
    groupStart: true,
    onSelect: () => writeClipboardText(event.content).catch(() => undefined),
  });
  if (!identityOverride && !rumor) {
    menuActions.push({
      id: "copy-id",
      label: intl.formatMessage({ id: "chatMessage.copyId", defaultMessage: "Copy message ID" }),
      icon: Link2,
      onSelect: copyMessageId,
    });
  }
  // An optimistic row's id can still change.
  if (permalink && !isPending && !isFailed) {
    menuActions.push({
      id: "copy-link",
      label: intl.formatMessage({ id: "chatMessage.copyLink", defaultMessage: "Copy message link" }),
      icon: Link,
      onSelect: () =>
        writeClipboardText(chatUrl({ ...permalink, messageId: event.id })).catch(() => undefined),
    });
  }
  menuActions.push({
    id: "json",
    label: intl.formatMessage({ id: "chatMessage.viewJson", defaultMessage: "View event JSON" }),
    icon: Braces,
    onSelect: () => setJsonOpen(true),
  });
  if (!identityOverride) {
    menuActions.push({
      id: "view-profile",
      label: intl.formatMessage({ id: "chatMessage.viewProfile", defaultMessage: "View profile" }),
      icon: User,
      groupStart: true,
      onSelect: () => openProfile(tryNpubEncode(event.pubkey) ?? event.pubkey),
    });
    menuActions.push({
      id: "copy-npub",
      label: intl.formatMessage({ id: "chatMessage.copyNpub", defaultMessage: "Copy npub" }),
      icon: Copy,
      onSelect: () => {
        const npub = tryNpubEncode(event.pubkey);
        if (!npub) return;
        writeClipboardText(npub).then(
          () => toast({ title: t({ id: "chatMessage.copiedNpub", defaultMessage: "Copied npub" }) }),
          () => toast({ title: t({ id: "chatMessage.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" }),
        );
      },
    });
  }
  const showHide = hiddenMessages.canHide && !isEditing && !isOwn;
  const showReport = canReport && !isEditing;
  if (showHide) {
    menuActions.push({
      id: "hide",
      label: intl.formatMessage({ id: "chatMessage.hide", defaultMessage: "Hide message" }),
      icon: EyeOff,
      moderation: true,
      onSelect: () => hiddenMessages.hide(event.id),
    });
  }
  if (showReport) {
    menuActions.push({
      id: "report",
      label: intl.formatMessage({ id: "chatMessage.report", defaultMessage: "Report message" }),
      icon: Flag,
      destructive: true,
      moderation: true,
      onSelect: () => setReportOpen(true),
    });
  }
  if (canDelete && !isEditing) {
    menuActions.push({
      id: "delete",
      label: intl.formatMessage({ id: "chatMessage.delete", defaultMessage: "Delete message" }),
      icon: Trash2,
      destructive: true,
      // Your own message is housekeeping; someone else's is moderation.
      groupStart: isOwn,
      moderation: !isOwn,
      onSelect: () => setConfirmDelete(true),
    });
  }

  // The person behind the message: the same actions as the member list and profile card.
  if (!isEditing) {
    for (const action of personModeration.actions) menuActions.push({ ...action, moderation: true });
  }

  const overflowActions = menuActions.filter(
    (a) => !["reply", "thread", "zap"].includes(a.id),
  );

  const toolbar = (
    <MessageActionToolbar
      reactions={canWrite && !isEditing ? reactions : undefined}
      zap={canZap && !isEditing ? { onOpen: () => setZapOpen(true) } : undefined}
      overflowActions={overflowActions}
    >
      {canWrite && !isEditing && onOpenThread && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "chatMessage.thread", defaultMessage: "Thread" })}
              className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
              onClick={() => onOpenThread(event)}
            >
              <MessagesSquare className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <FormattedMessage id="chatMessage.thread" defaultMessage="Thread" />
          </TooltipContent>
        </Tooltip>
      )}
      {canWrite && !isEditing && onReply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage(common.reply)}
              className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
              onClick={() => onReply(event)}
            >
              <Reply className="size-[18px] md:size-3.5" />
            </Button>
          </TooltipTrigger>
            <TooltipContent>
              <FormattedMessage {...common.reply} />
            </TooltipContent>
          </Tooltip>
      )}
    </MessageActionToolbar>
  );

  const body = (
    <>
      {heading}
      {isEditing ? (
        <MessageEditBox
          content={event.content}
          tags={event.tags}
          sendOnEnter={sendOnEnter}
          onSubmit={(text) => onEditSubmit?.(event, text)}
          onCancel={() => onEditCancel?.()}
        />
      ) : event.kind === KIND_POLL ? (
        <>
          <ChatContent event={event} className="text-chat" highlight={highlight} everyoneMention={everyoneMention} />
          {pollContext ? (
            <PollCard
              event={event}
              relayUrl={pollContext.relayUrl}
              groupId={pollContext.groupId}
              canVote={canWrite}
            />
          ) : poll ? (
            <PollView event={event} tally={poll.tally} canVote={canWrite} onVote={poll.vote} />
          ) : null}
        </>
      ) : event.kind === KIND_CALENDAR_TIME || event.kind === KIND_CALENDAR_DATE ? (
        calendar ? (
          <CalendarEventMessageCard
            event={calendar.event}
            tally={calendar.tally}
            canRsvp={calendar.canRsvp}
            isSettingRsvp={calendar.isSettingRsvp}
            onSetRsvp={calendar.setRsvp}
          />
        ) : null
      ) : invocation ? (
        // Arguments are omitted: they were for the bot, whose reply reports the outcome.
        <div className="text-chat italic text-muted-foreground">
          <span className="font-semibold not-italic text-primary">
            <DisplayName pubkey={identityOverride ? undefined : event.pubkey} name={identityOverride?.name} />
          </span>{" "}
          ran{" "}
          <button
            type="button"
            // Re-arms the command in the composer, already filtered.
            onClick={(e) => {
              e.stopPropagation();
              requestCommand(invocation.name);
            }}
            className="font-mono not-italic text-primary hover:underline cursor-pointer"
          >
            /{invocation.name}
          </button>
          {invocation.bot && (
            <>
              {" "}with <InvokedBotName pubkey={invocation.bot} />
            </>
          )}
        </div>
      ) : isMeAction(event) ? (
        <div className="text-chat italic text-muted-foreground">
          <span className="font-semibold not-italic text-primary">
            <DisplayName pubkey={identityOverride ? undefined : event.pubkey} name={identityOverride?.name} />
          </span>{" "}
          <ChatContent
            event={event}
            contentOverride={meActionText(event)}
            className="inline italic"
            highlight={highlight}
            noMentionAtPrefix
            everyoneMention={everyoneMention}
          />
        </div>
      ) : (
        <ChatContent event={event} className="text-chat" highlight={highlight} everyoneMention={everyoneMention} />
      )}
    </>
  );

  const zapPill =
    !isEditing && !isIosApp() && zaps && zaps.tally.count > 0 ? (
      <ZapPill tally={zaps.tally} canZap={canZap} onZap={() => setZapOpen(true)} />
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
        <div className="flex items-center gap-2 touch:gap-4 mt-1 text-2xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>
            <FormattedMessage id="chatMessage.failedToSend" defaultMessage="Failed to send." />
          </span>
          {onRetry && (
            <button type="button" className="font-semibold underline hover:no-underline touch:py-2" onClick={onRetry}>
              <FormattedMessage {...common.retry} />
            </button>
          )}
          {onDiscard && (
            <button type="button" className="text-muted-foreground hover:text-foreground touch:py-2" onClick={onDiscard}>
              <FormattedMessage id="chatMessage.discard" defaultMessage="Discard" />
            </button>
          )}
        </div>
      )}
    </>
  );

  const row = (
        <MessageRow
          pubkey={event.pubkey}
          identityOverride={identityOverride}
          createdAt={event.created_at}
          pending={isPending}
          edited={wasEdited && !isEditing}
          // NIP-40 `expiration` alone entitles a row to the disappearing clock.
          expiresAt={expirationOf(event.tags)}
          // NIP-48: bridged in from another network.
          proxy={parseProxyTag(event.tags)}
          nameBadge={nameBadge}
          // Touch uses the long-press sheet: the strip can't fit on a phone. Off,
          // desktop keeps the right-click menu, which carries the reactions too.
          actions={isTouch || !hoverActions ? undefined : toolbar}
          beforeBody={hasReplyContext ? replyContext : undefined}
          afterBody={afterBody}
          continuation={
            continuation && !hasReplyContext && !heading && !isEditing && !isPinned && !mentionsMe
          }
          className={cn(
            // Keyed on the open menus alone so the highlight can't linger without one.
            (sheetOpen || contextMenu.open || menuPickerOpen) && "bg-secondary/40",
            isPinned && "bg-amber-500/5",
            mentionsMe && "bg-primary/10 hover:bg-primary/15 border-l-2 border-primary pl-2",
            isFailed && "bg-destructive/5",
          )}
          containerProps={{
            "data-active": sheetOpen || undefined,
            "data-event-id": event.id,
          } as React.HTMLAttributes<HTMLDivElement>}
          onSwipeReply={isTouch && onReply && (replyGestures === "swipe" || replyGestures === "both") ? () => onReply(event) : undefined}
          onDoubleTapReply={isTouch && onReply && !isEditing && (replyGestures === "doubleTap" || replyGestures === "both") ? () => onReply(event) : undefined}
          onLongPress={isTouch && !isEditing && menuActions.length > 0 ? openSheet : undefined}
        >
          {body}
        </MessageRow>
  );

  return (
    <ChatImageMenuContext.Provider value={imageMenu}>
    {/* Touch: no right-click ContextMenu (one fewer Radix root per row). Desktop
        builds it on first right-click (useLazyContextMenu). */}
    {isTouch ? (
      row
    ) : (
      // Restaging in the capture phase (before an image restages) keeps a text
      // right-click from inheriting the last image's actions.
      <span
        className="block"
        onMouseDownCapture={keepSelectionOnRightPress}
        onContextMenuCapture={stageLinkActions}
        onContextMenu={contextMenu.onContextMenu}
      >
        {row}
      </span>
    )}
    {!isTouch && contextMenu.point && (
      <LazyContextMenuContent
        menu={contextMenu}
        className="w-52"
        onCloseAutoFocus={onMenuCloseAutoFocus}
        collisionPadding={contextMenu.open ? getComposerCollisionPadding(composerBoundsRef) : undefined}
      >
        {canWrite && !isEditing && reactions && (
          <MenuReactionRow reactions={reactions} onOpenPicker={openMenuPicker} />
        )}
        <MessageMenuItems actions={withImageActions(imageActions, menuActions)} />
      </LazyContextMenuContent>
    )}
    {menuPickerOpen && contextMenu.point && reactions && (
      <MenuReactionPicker point={contextMenu.point} reactions={reactions} onClose={closeMenuPicker} />
    )}
    {isTouch && (sheetOpen || sheetBuilt) && (
      <MessageActionSheet
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        actions={withImageActions(imageActions, menuActions)}
        reactions={canWrite && !isEditing && reactions ? reactions : undefined}
      />
    )}
    {/* Mounted only while open: a Radix dialog root per row is pure weight. */}
    {confirmDelete && (
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage id="chatMessage.deleteTitle" defaultMessage="Delete message?" />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="chatMessage.deleteDescription"
              defaultMessage="This can't be undone. Relays and clients that already have it may keep their copy."
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <FormattedMessage {...common.cancel} />
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onDelete?.(event)}
          >
            <FormattedMessage {...common.delete} />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    )}
    {zapOpen && (
      <ZapDialog open={zapOpen} onOpenChange={setZapOpen} target={event} sendZap={onSendZap} sendOnchainZap={onSendOnchainZap} />
    )}
    {reportOpen && reportTo && (
      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        destination={reportTo}
        target={reportTarget}
        onRemoveLocal={removeLocal}
      />
    )}
    {jsonOpen && (
      <EventJsonDialog
        open={jsonOpen}
        onOpenChange={setJsonOpen}
        source={rumor ?? event}
        description={
          isRumor
            ? intl.formatMessage({ id: "chatMessage.rawRumor", defaultMessage: "The raw, unsigned rumor for this message." })
            : intl.formatMessage({ id: "chatMessage.rawEvent", defaultMessage: "The raw signed event for this message." })
        }
      />
    )}
    {personModeration.dialogs}
    </ChatImageMenuContext.Provider>
  );
});

/** Exported directly: a wrapper would re-run for every row on every timeline render. */
export const ChatMessage = ChatMessageInner;
