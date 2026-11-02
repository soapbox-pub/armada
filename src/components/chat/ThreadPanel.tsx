import { useQueryClient } from "@tanstack/react-query";
import { Braces, ChevronDown, Copy, EyeOff, Flag, Link2, Link as LinkIcon, Loader2, Maximize2, MessagesSquare, Minimize2, Pencil, Reply, Trash2, X, Zap } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { MessageActionSheet } from "@/components/chat/MessageActionSheet";
import { MessageActionToolbar } from "@/components/chat/MessageActionToolbar";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReactionBar } from "@/components/chat/ReactionBar";
import { flashRow } from "@/components/chat/rowFlash";
import {
  captureScrollAnchor,
  clampedScrollTop,
  distanceFromBottom,
  restoreScrollAnchor,
  type ScrollAnchor,
} from "@/components/chat/scrollAnchor";
import { ReportDialog } from "@/components/ReportDialog";
import { ZapDialog } from "@/components/chat/ZapDialog";
import { ZapPill } from "@/components/chat/ZapPill";
import { DisplayName } from "@/components/DisplayName";
import { StaffPill } from "@/components/StaffPill";
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
import { LazyContextMenuContent, useLazyContextMenu } from "@/components/chat/LazyContextMenu";
import { EventJsonDialog } from "@/components/EventJsonDialog";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useAppContext } from "@/hooks/useAppContext";
import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea";
import { useAuthor } from "@/hooks/useAuthor";
import { useChatScope } from "@/hooks/useChatScope";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useMutedWordFilter } from "@/hooks/useMutedWords";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useUserModeration } from "@/hooks/useUserModeration";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useLongPress } from "@/hooks/useLongPress";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { isTombstoneRoot } from "@/concord/hooks/useConcordThreads";
import { ComposerBoundsProvider, getComposerCollisionPadding, useComposerBoundsRef } from "@/contexts/ComposerBoundsContext";
import { contextActionsAt, keepSelectionOnRightPress, withImageActions } from "@/contexts/ChatImageMenuContext";
import { getAvatarShape } from "@/lib/avatarShape";
import { sendsOnEnter } from "@/lib/sendOnEnter";
import { fullDateTime, shortClockTime, shortTimeAgo } from "@/lib/formatTime";
import { writeClipboardText } from "@/lib/clipboard";
import { reportDestination, type ReportTarget } from "@/lib/report";
import { getActivePubkey } from "@/lib/activeAccount";
import { removeMessageFromDevice } from "@/lib/removeMessageFromDevice";
import { chatUrl, type ChatRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, useIntl } from "@/i18n";

import type { MessageActionItem } from "@/components/chat/messageActions";
import { useChatEditing } from "@/components/chat/useChatEditing";
import type { ChatMsg, ChatTransport, MessageReactions, MessageZaps, OnchainZapAnnouncement, ZapPayment } from "@/components/chat/transport";
import { AvatarInitial } from "@/components/AvatarInitial";
import { reducedMotion } from "@/lib/reducedMotion";

/** Continuation window; matches MessageTimeline's `CONTINUATION_WINDOW_SECONDS`. */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** Stable no-op so a zap-only pill row keeps a constant prop. */
const NOOP_REACT = () => {};

const AT_BOTTOM_PX = 60;

/**
 * `chat`: drawer row with clock time, collapsible, floated hover actions.
 * `comment`: forum comment with relative age, never collapsed (no day dividers).
 * `post`: forum post body at reading width with an always-visible action row.
 */
export type ThreadMessagePresentation = "chat" | "comment" | "post";

export function ThreadMessage({
  event,
  reactions,
  zaps,
  zapEnabled = false,
  onSendZap,
  onSendOnchainZap,
  canReact,
  canModerate = false,
  isRumor = false,
  continuation = false,
  everyoneMention = false,
  permalink,
  onDelete,
  isEditing = false,
  onEdit,
  onEditSubmit,
  onEditCancel,
  presentation = "chat",
  onReply,
  documentMarkdown = false,
}: {
  event: ChatMsg;
  presentation?: ThreadMessagePresentation;
  /** Long-form markdown (a NIP-34 issue/comment) rather than chat text; no note embeds. */
  documentMarkdown?: boolean;
  /** `comment` only: an always-visible in-place reply action. */
  onReply?: (event: ChatMsg) => void;
  /** This thread's route; rows append their own `/m/<id>` to it. */
  permalink?: ChatRoute;
  reactions?: MessageReactions;
  zaps?: MessageZaps;
  zapEnabled?: boolean;
  /** CORD.md announcement publisher (Concord); absent = NIP-57 public surface. */
  onSendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  onSendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
  canReact: boolean;
  canModerate?: boolean;
  /** Unsigned rumor (Concord): "View event JSON" wording, no "Copy message ID". */
  isRumor?: boolean;
  /** Compact continuation of the previous same-author reply. */
  continuation?: boolean;
  everyoneMention?: boolean;
  /** Own always; others' require moderation. Hidden when absent. */
  onDelete?: (event: ChatMsg) => void;
  isEditing?: boolean;
  onEdit?: (event: ChatMsg) => void;
  onEditSubmit?: (event: ChatMsg, content: string) => void;
  onEditCancel?: () => void;
}) {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const isTouch = useIsTouch();
  const composerBoundsRef = useComposerBoundsRef();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const intl = useIntl();
  const when = new Date(event.created_at * 1000);

  const [jsonOpen, setJsonOpen] = useState(false);
  const [zapOpen, setZapOpen] = useState(false);
  // Delete sits one tap away in the sheet/menu, so it confirms.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Mirrors ChatMessage's gating; the transport decides how.
  const isOwn = user?.pubkey === event.pubkey;
  const canDelete = Boolean(onDelete) && (isOwn || canModerate);
  // The transport only provides editMessage for kinds it can edit.
  const canEdit = isOwn && Boolean(onEdit);
  const [editText, setEditText] = useState(event.content);
  const editRef = useAutosizeTextarea(editText);
  useEffect(() => {
    if (isEditing) setEditText(event.content);
  }, [isEditing, event.content]);
  // Mirrors ChatMessage: never gated on a lightning address.
  const canZap = Boolean(zapEnabled && user && !isOwn);
  // Gated as in ChatMessage: the chat scope decides the destination (none for
  // legacy Concord epochs).
  const [reportOpen, setReportOpen] = useState(false);
  const [linkActions, setLinkActions] = useState<MessageActionItem[] | null>(null);
  // Built on the first right-click, beside the row (see useLazyContextMenu).
  const contextMenu = useLazyContextMenu();
  const [menuPickerOpen, setMenuPickerOpen] = useState(false);
  // Opened once the menu has unmounted: its focus trap would pull focus back out
  // of the picker, which dismisses it.
  const menuPickerPending = useRef(false);
  const openMenuPicker = useCallback(() => {
    menuPickerPending.current = true;
  }, []);
  const closeMenuPicker = useCallback(() => setMenuPickerOpen(false), []);
  const onMenuCloseAutoFocus = useCallback(() => {
    if (!menuPickerPending.current) return;
    menuPickerPending.current = false;
    setMenuPickerOpen(true);
  }, []);
  const chatScope = useChatScope();
  const reportTo = reportDestination(chatScope);
  const canReport = Boolean(reportTo && user && !isOwn);
  // Blocking needs no destination; hiding is viewer-local.
  const personModeration = useUserModeration(event.pubkey, { report: false });
  const hiddenMessages = useHiddenMessages();
  const queryClient = useQueryClient();
  const removeLocal = useCallback(() => {
    const viewer = getActivePubkey();
    if (viewer) void removeMessageFromDevice(viewer, event, { queryClient });
  }, [event, queryClient]);
  const reportTarget: ReportTarget =
    isRumor && reportTo?.kind === "network"
      ? { pubkey: event.pubkey }
      : { pubkey: event.pubkey, eventId: event.id };

  const copyMessageId = useCallback(() => {
    try {
      writeClipboardText(
        `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
      ).catch(() => undefined);
    } catch {
      writeClipboardText(event.id).catch(() => undefined);
    }
  }, [event.id, event.pubkey]);

  const openSheet = useCallback(() => setSheetOpen(true), []);
  // Not while editing: the sheet and `user-select:none` would fight the caret.
  const longPress = useLongPress(isTouch && !isEditing ? openSheet : undefined);

  // One action list drives the sheet, `⋯` overflow and right-click menu (as ChatMessage).
  const menuActions: MessageActionItem[] = [];
  if (canZap && !isEditing) {
    menuActions.push({ id: "zap", label: intl.formatMessage({ id: "threadPanel.action.zap", defaultMessage: "Zap message" }), icon: Zap, onSelect: () => setZapOpen(true) });
  }
  if (canEdit && !isEditing) {
    menuActions.push({ id: "edit", label: intl.formatMessage({ id: "threadPanel.action.edit", defaultMessage: "Edit message" }), icon: Pencil, onSelect: () => onEdit?.(event) });
  }
  menuActions.push({
    id: "copy-text",
    label: intl.formatMessage({ id: "threadPanel.action.copyText", defaultMessage: "Copy text" }),
    icon: Copy,
    groupStart: true,
    onSelect: () => writeClipboardText(event.content).catch(() => undefined),
  });
  if (!isRumor) {
    menuActions.push({ id: "copy-id", label: intl.formatMessage({ id: "threadPanel.action.copyId", defaultMessage: "Copy message ID" }), icon: Link2, onSelect: copyMessageId });
  }
  if (permalink) {
    menuActions.push({
      id: "copy-link",
      label: intl.formatMessage({ id: "threadPanel.action.copyLink", defaultMessage: "Copy message link" }),
      icon: LinkIcon,
      onSelect: () =>
        writeClipboardText(chatUrl({ ...permalink, messageId: event.id })).catch(() => undefined),
    });
  }
  menuActions.push({ id: "json", label: intl.formatMessage({ id: "threadPanel.action.viewJson", defaultMessage: "View event JSON" }), icon: Braces, onSelect: () => setJsonOpen(true) });
  const showHide = hiddenMessages.canHide && !isEditing && !isOwn;
  const showReport = canReport && !isEditing;
  if (showHide) {
    menuActions.push({
      id: "hide",
      label: intl.formatMessage({ id: "threadPanel.action.hide", defaultMessage: "Hide message" }),
      icon: EyeOff,
      moderation: true,
      onSelect: () => hiddenMessages.hide(event.id),
    });
  }
  if (showReport) {
    menuActions.push({
      id: "report",
      label: intl.formatMessage({ id: "threadPanel.action.report", defaultMessage: "Report message" }),
      icon: Flag,
      destructive: true,
      moderation: true,
      onSelect: () => setReportOpen(true),
    });
  }
  if (canDelete && !isEditing) {
    menuActions.push({
      id: "delete",
      label: intl.formatMessage({ id: "threadPanel.action.delete", defaultMessage: "Delete message" }),
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

  const overflowActions = menuActions.filter((a) => a.id !== "zap");
  const isPost = presentation === "post";
  const isComment = presentation === "comment";

  const body = isEditing ? (
    <div className="mt-0.5">
      <textarea
        ref={editRef}
        autoFocus
        value={editText}
        onChange={(e) => setEditText(e.target.value)}
        onKeyDown={(e) => {
          // Ignore Enter confirming an IME composition; with send-on-Enter off,
          // Ctrl/Cmd+Enter saves.
          const saveKey = sendsOnEnter(config.sendOnEnter, isTouch)
            ? e.key === "Enter" && !e.shiftKey
            : e.key === "Enter" && (e.ctrlKey || e.metaKey);
          if (saveKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEditSubmit?.(event, editText);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onEditCancel?.();
          }
        }}
        rows={1}
        className="block w-full resize-none rounded-md bg-background border border-input px-2 py-1.5 text-chat max-h-40 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2 touch:gap-4 mt-1 text-2xs text-muted-foreground">
        <button
          type="button"
          className="font-semibold text-primary hover:underline touch:py-2"
          onClick={() => onEditSubmit?.(event, editText)}
        >
          <FormattedMessage {...common.save} />
        </button>
        <button type="button" className="hover:text-foreground touch:py-2" onClick={() => onEditCancel?.()}>
          <FormattedMessage {...common.cancel} />
        </button>
        <span className="opacity-70">
          <FormattedMessage id="threadPanel.editHint" defaultMessage="escape to cancel · enter to save" />
        </span>
      </div>
    </div>
  ) : (
    <ChatContent event={event} className={isPost ? "text-chat leading-relaxed" : "text-chat"} everyoneMention={everyoneMention} documentMarkdown={documentMarkdown} disableNoteEmbeds={documentMarkdown} />
  );
  const reactionRow = ((zaps && zaps.tally.count > 0) || (reactions && reactions.tallies.length > 0)) ? (
    <ReactionBar
      tallies={reactions?.tallies ?? []}
      canReact={canReact}
      onReact={reactions?.react ?? NOOP_REACT}
      leading={
        zaps && zaps.tally.count > 0 ? (
          <ZapPill
            tally={zaps.tally}
            canZap={canZap}
            onZap={() => setZapOpen(true)}
          />
        ) : undefined
      }
    />
  ) : null;
  const toolbar = (
    <MessageActionToolbar
      reactions={canReact ? reactions : undefined}
      zap={canZap ? { onOpen: () => setZapOpen(true) } : undefined}
      overflowActions={overflowActions}
    />
  );

  return (
    <>
    {/* Touch: no right-click menu; long-press belongs to the action sheet. */}
    <div
      {...longPress}
      onMouseDownCapture={isTouch ? undefined : keepSelectionOnRightPress}
      onContextMenu={(e) => {
        longPress.onContextMenu(e);
        if (isTouch) return;
        setLinkActions(contextActionsAt(e.target, e.currentTarget));
        contextMenu.onContextMenu(e);
      }}
      className={cn(
        "group/threadmsg relative flex items-start gap-3 transition-colors hover:z-10 focus-within:z-10",
        isPost
          ? "px-0 py-0"
          : isComment
            ? "px-3 py-3 hover:bg-secondary/30"
            : cn("px-2.5 rounded hover:bg-secondary/40", continuation ? "py-0.5" : "pt-1.5 pb-0.5"),
        sheetOpen && "bg-secondary/40",
        // Native selection/callout would fire `pointercancel` and eat the long-press (see MessageRow).
        isTouch && !isEditing && "select-none [-webkit-user-select:none] [-webkit-touch-callout:none]",
      )}
    >
      {isPost ? (
        // A post: byline heading, body at reading width, actions on their own row.
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <ProfilePreviewCard pubkey={event.pubkey}>
              <button type="button" className="shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar shape={getAvatarShape(metadata)} className="size-10 cursor-pointer transition-opacity hover:opacity-90">
                  <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
                  <AvatarFallback className="bg-primary/20 text-primary text-sm">
                    <AvatarInitial name={displayName} />
                  </AvatarFallback>
                </Avatar>
              </button>
            </ProfilePreviewCard>
            <div className="min-w-0 flex flex-col justify-center">
              <div className="flex min-w-0 items-center gap-2">
                <ProfilePreviewCard pubkey={event.pubkey}>
                  <button type="button" className="text-chat font-name font-semibold text-primary truncate text-left hover:underline focus:outline-none">
                    <DisplayName pubkey={event.pubkey} name={displayName} />
                  </button>
                </ProfilePreviewCard>
                <StaffPill pubkey={event.pubkey} />
              </div>
              <span className="text-xs text-muted-foreground">{fullDateTime(event.created_at)}</span>
            </div>
          </div>
          <div className="mt-3">{body}</div>
          {reactionRow}
          {!isEditing && (
            <div className="mt-2 -mx-1 flex flex-wrap items-center gap-0.5">{toolbar}</div>
          )}
        </div>
      ) : (
      <>
      {continuation ? (
        <span className="shrink-0 w-9 self-stretch flex items-start justify-end pr-0.5 pt-0.5 text-3xs leading-none text-muted-foreground/60 opacity-0 group-hover/threadmsg:opacity-100 transition-opacity tabular-nums select-none">
          {shortClockTime(event.created_at)}
        </span>
      ) : (
        <ProfilePreviewCard pubkey={event.pubkey}>
          <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar shape={getAvatarShape(metadata)} className="size-9 cursor-pointer transition-opacity hover:opacity-90">
              <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-sm">
                <AvatarInitial name={displayName} />
              </AvatarFallback>
            </Avatar>
          </button>
        </ProfilePreviewCard>
      )}
      <div className="flex-1 min-w-0">
        {!continuation && (
          <div className="flex items-baseline gap-2">
            <ProfilePreviewCard pubkey={event.pubkey}>
              <button type="button" className="text-chat font-name font-semibold text-primary truncate hover:underline focus:outline-none">
                <DisplayName pubkey={event.pubkey} name={displayName} />
              </button>
            </ProfilePreviewCard>
            <StaffPill pubkey={event.pubkey} />
            {isComment ? (
              // No day dividers on a post page, so show the age with the date on hover.
              <span className="text-xs text-muted-foreground/80 shrink-0" title={fullDateTime(event.created_at)}>
                {shortTimeAgo(event.created_at)}
              </span>
            ) : (
              <span className="text-2xs text-muted-foreground/70 shrink-0" title={when.toLocaleString(intl.locale)}>
                {when.toLocaleTimeString(intl.locale, { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
        {body}
        {reactionRow}
        {isComment && onReply && !isEditing && (
          <div className="-ml-2 mt-0.5">
            <button
              type="button"
              onClick={() => onReply(event)}
              className="inline-flex items-center gap-1 clip-corner px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground touch:py-2"
            >
              <Reply className="size-3.5" />
              <FormattedMessage {...common.reply} />
            </button>
          </div>
        )}
      </div>
      {/* Floats over the row's right edge, so the narrow panel doesn't bound it. */}
      {!isTouch && !isEditing && config.messageHoverActions ? (
        // A comment row has its own padding, so the strip sits inside its top edge.
        <div className={cn(
          "absolute right-2.5 z-20 flex flex-wrap justify-end items-center max-w-[calc(100%-1.25rem)] gap-0.5 vessel [--vessel-cut:0.45rem] px-1 py-0.5 select-none opacity-0 group-hover/threadmsg:opacity-100 focus-within:opacity-100 transition-opacity",
          isComment ? "top-1" : continuation ? "-top-1" : "top-0",
        )}>
          {toolbar}
        </div>
      ) : null}
      </>
      )}
    </div>
    {!isTouch && contextMenu.point && (
      <LazyContextMenuContent
        menu={contextMenu}
        className="w-52"
        onCloseAutoFocus={onMenuCloseAutoFocus}
        collisionPadding={contextMenu.open ? getComposerCollisionPadding(composerBoundsRef) : undefined}
      >
        {canReact && !isEditing && reactions && (
          <MenuReactionRow reactions={reactions} onOpenPicker={openMenuPicker} />
        )}
        <MessageMenuItems actions={withImageActions(linkActions, menuActions)} />
      </LazyContextMenuContent>
    )}
    {menuPickerOpen && contextMenu.point && reactions && (
      <MenuReactionPicker point={contextMenu.point} reactions={reactions} onClose={closeMenuPicker} />
    )}
    {isTouch && (
      <MessageActionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        actions={menuActions}
        reactions={canReact && !isEditing && reactions ? reactions : undefined}
      />
    )}
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage id="threadPanel.deleteDialog.title" defaultMessage="Delete message?" />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="threadPanel.deleteDialog.description"
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
        source={event}
        description={
          isRumor
            ? intl.formatMessage({ id: "threadPanel.json.rumor", defaultMessage: "The raw, unsigned rumor for this message." })
            : intl.formatMessage({ id: "threadPanel.json.signed", defaultMessage: "The raw signed event for this message." })
        }
      />
    )}
    {personModeration.dialogs}
    </>
  );
}

interface ThreadPanelProps {
  root: ChatMsg;
  /** Titled post (Concord forum, CORD-03 §3): heading above the root, worded as post + comments. */
  rootTitle?: string;
  transport: ChatTransport;
  /** NIP-29 composer context; Concord sends via {@link ChatTransport.sendThreadReply} and passes placeholders. */
  relayUrl: string;
  botCommands?: boolean;
  conversationRelays?: string[];
  /**
   * Seal reply attachments (see ChatComposer). Sealed rooms (Concord, NIP-17)
   * must set it, or reply images reach Blossom in the clear.
   */
  encryptAttachments?: boolean;
  /** See ChatComposer's. */
  disappearingTimer?: () => Promise<number>;
  groupId: string;
  canWrite: boolean;
  /** Required for Concord (`relayUrl="dm"`); NIP-29 derives the roster itself. */
  mentionPubkeys?: string[];
  autoFocus?: boolean;
  /** This thread's route (`.../t/<root>`), enabling "Copy message link" for replies. */
  permalink?: ChatRoute;
  /** On screen (kept mounted through slide-out); a closed panel must not claim Android back. */
  open?: boolean;
  onClose: () => void;
  onExpandChange?: (expanded: boolean) => void;
  /** Header label in place of "Thread"/"Post". */
  title?: string;
  /** Rendered above the root in place of the `rootTitle` heading. */
  rootHeader?: ReactNode;
  /** The root offers no edit/delete (it isn't the transport's to change). */
  rootReadOnly?: boolean;
  /** See {@link ThreadMessage}'s `documentMarkdown`. */
  documentMarkdown?: boolean;
  placeholder?: string;
  /** Shown instead of the composer when `canWrite` is false. */
  readOnlyNotice?: string;
}

/**
 * Thread side panel: root, replies and a reply composer. Transport-driven
 * (`threadRepliesFor`/`sendThreadReply`); replies never appear in the main timeline.
 */
export function ThreadPanel({ root, rootTitle, transport, relayUrl, groupId, canWrite, mentionPubkeys, botCommands, conversationRelays, encryptAttachments = false, disappearingTimer, autoFocus = false, open = true, permalink, onClose, onExpandChange, title, rootHeader, rootReadOnly = false, documentMarkdown = false, placeholder, readOnlyNotice }: ThreadPanelProps) {
  const intl = useIntl();
  const isPost = Boolean(rootTitle);
  const threadRepliesFor = transport.threadRepliesFor;
  const isLoading = transport.threadLoading?.(root.id) ?? false;
  // Replies bypass MessageTimeline's filter, so drop muted authors here. The count
  // uses the filtered list, or an empty thread would read "1 reply".
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();
  const { hiddenIds } = useHiddenMessages();
  const mutedWord = useMutedWordFilter();
  const replies = useMemo(() => {
    const all = threadRepliesFor?.(root.id) ?? [];
    const dropMuted = mutesReady && mutedPubkeys.size > 0;
    if (!dropMuted && hiddenIds.size === 0 && !mutedWord) return all;
    return all.filter(
      (reply) => !hiddenIds.has(reply.id) && !mutedWord?.(reply)
        && (!dropMuted || !mutedPubkeys.has(reply.pubkey)),
    );
  }, [threadRepliesFor, root.id, mutedPubkeys, mutesReady, hiddenIds, mutedWord]);
  // Treat a muted root (reachable by permalink) like an unloadable one.
  const rootMuted = mutesReady && mutedPubkeys.has(root.pubkey);
  const { config } = useAppContext();
  const reactionsFor = transport.reactionsFor;
  const zapsFor = transport.zapsFor;
  const zapEnabled = config.zapsEnabled && Boolean(transport.zapsFor);
  const onSendZap = transport.sendZap;
  const onSendOnchainZap = transport.sendOnchainZap;
  const isRumor = transport.isRumor ?? false;
  const canModerate = transport.canModerate;
  const onDelete = transport.deleteMessage;
  const editMessage = transport.editMessage;
  const { user } = useCurrentUser();
  const composerBoundsRef = useRef<HTMLElement | null>(null);

  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: (original, content) => editMessage?.(original, content),
    messages: [root, ...replies],
    isPending: (id) => transport.sendStatusFor?.(id) !== undefined,
    self: user?.pubkey,
  });
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    onExpandChange?.(isExpanded);
  }, [isExpanded, onExpandChange]);

  // Handled here: SwipeReveal's handler would otherwise consume back and reveal
  // the list with the thread still open. Most-recently-mounted wins.
  useAndroidBack(() => {
    onClose();
    return true;
  }, open);

  // A plain scroller like the main timeline, with a row anchor preserving
  // position when replies grow (WebKit lacks CSS anchoring).
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const distanceRef = useRef(0);
  const readingAnchorRef = useRef<ScrollAnchor | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const captureReadingAnchor = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || distanceRef.current <= AT_BOTTOM_PX) {
      readingAnchorRef.current = null;
      return;
    }
    if (el.scrollTop !== clampedScrollTop(el)) return;
    readingAnchorRef.current = captureScrollAnchor(el, content, readingAnchorRef.current);
  }, []);

  const restoreReadingAnchor = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const anchor = readingAnchorRef.current;
    if (!el || !content || !anchor) return false;
    if (!restoreScrollAnchor(el, content, anchor)) {
      readingAnchorRef.current = null;
      return false;
    }
    distanceRef.current = distanceFromBottom(el);
    return true;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : behavior });
    distanceRef.current = 0;
    readingAnchorRef.current = null;
    setShowJumpToLatest(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    distanceRef.current = distanceFromBottom(el);
    if (el.scrollTop === clampedScrollTop(el)) captureReadingAnchor();
    setShowJumpToLatest(distanceRef.current > 120);
  }, [captureReadingAnchor]);

  useLayoutEffect(() => {
    scrollToBottom("auto");
  }, [root.id, scrollToBottom]);

  // `/t/<root>/m/<reply>`: replies are real DOM, so look up by id; unknown ids
  // are dropped on the first pass.
  const scrollToReply = useCallback((id: string) => {
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!row) return false;
    flashRow(row, true);
    // Record the distance like a real scroll, or the ResizeObserver would re-pin
    // to the bottom when an image resolves.
    const el = scrollRef.current;
    if (el) distanceRef.current = distanceFromBottom(el);
    captureReadingAnchor();
    setShowJumpToLatest(distanceRef.current > 120);
    return true;
  }, [captureReadingAnchor]);
  const clearReplyFocus = useMessagePermalink({
    // The root is addressable here too, as `/t/<root>/m/<root>`.
    messages: [root, ...replies],
    isLoading,
    scrollTo: scrollToReply,
    scope: "thread",
    // A closed (sliding-out) panel must not consume the location's focus.
    enabled: open,
  });

  // Unlike the main timeline, always snap to a newly-arrived reply.
  useLayoutEffect(() => {
    if (isLoading) return;
    scrollToBottom(distanceRef.current > AT_BOTTOM_PX ? "smooth" : "auto");
  }, [replies.length, isLoading, scrollToBottom]);

  // Hold the reader's distance from the newest reply across growth and resizes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (distanceRef.current > AT_BOTTOM_PX) {
        restoreReadingAnchor();
      } else {
        el.scrollTop = el.scrollHeight - el.clientHeight - distanceRef.current;
        readingAnchorRef.current = null;
      }
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [restoreReadingAnchor]);

  const listHeader = (
    <>
      {isTombstoneRoot(root) || rootMuted ? (
        <div data-scroll-anchor={`root:${root.id}`} className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground/70">
          <MessagesSquare className="size-4 shrink-0" />
          <span className="italic">
            {rootMuted
              ? intl.formatMessage({ id: "threadPanel.rootBlocked", defaultMessage: "You blocked the person who started this thread." })
              : intl.formatMessage({ id: "threadPanel.rootUnavailable", defaultMessage: "Original message not loaded. It may be older than the channel window." })}
          </span>
        </div>
      ) : (
        <div data-event-id={root.id} data-scroll-anchor={`root:${root.id}`}>
        {rootHeader ?? (rootTitle && (
          <h2 className="px-3 pb-1 text-lg font-semibold leading-snug break-words">
            {rootTitle}
          </h2>
        ))}
        <ThreadMessage event={root} permalink={permalink} reactions={reactionsFor?.(root.id)} zaps={zapsFor?.(root.id)} zapEnabled={zapEnabled} onSendZap={onSendZap} onSendOnchainZap={onSendOnchainZap} canReact={canWrite} canModerate={canModerate} isRumor={isRumor} everyoneMention={transport.mentionsEveryone?.(root)} onDelete={rootReadOnly ? undefined : onDelete} isEditing={editingId === root.id} onEdit={rootReadOnly ? undefined : startEditing} onEditSubmit={handleEditSubmit} onEditCancel={cancelEditing} documentMarkdown={documentMarkdown} />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1 mt-1">
        <div className="h-px flex-1 bg-border/60" />
        {!isLoading && (
          <span className="text-2xs text-muted-foreground/60 shrink-0">
            {replies.length === 0
              ? isPost
                ? intl.formatMessage({ id: "threadPanel.noComments", defaultMessage: "No comments yet" })
                : intl.formatMessage({ id: "threadPanel.noReplies", defaultMessage: "No replies yet" })
              : isPost
                ? intl.formatMessage(
                  { id: "threadPanel.commentCount", defaultMessage: "{count, plural, one {# comment} other {# comments}}" },
                  { count: replies.length },
                )
                : intl.formatMessage(
                  { id: "threadPanel.replyCount", defaultMessage: "{count, plural, one {# reply} other {# replies}}" },
                  { count: replies.length },
                )}
          </span>
        )}
        <div className="h-px flex-1 bg-border/60" />
      </div>
      {isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </>
  );

  return (
    <ComposerBoundsProvider value={composerBoundsRef}>
    <aside className={cn(
      // `thread:ml-0` drops the left gap only at ≥1200px (in-flow); below, it
      // overlays the chat and keeps the gutter.
      "flex flex-col min-h-0 flex-1 min-w-0 mt-stack mb-2 sidebar:mb-3 mx-gutter thread:ml-0 p-1.5 clip-corner-lg bg-chrome",
    )}>
      <div className="flex items-center justify-between px-2 py-1 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare className="size-4 text-muted-foreground shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
            {title ?? (isPost ? intl.formatMessage({ id: "threadPanel.post", defaultMessage: "Post" }) : intl.formatMessage({ id: "threadPanel.thread", defaultMessage: "Thread" }))}{replies.length > 0 ? ` · ${replies.length}` : ""}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label={isExpanded ? intl.formatMessage({ id: "threadPanel.collapse", defaultMessage: "Collapse thread" }) : intl.formatMessage({ id: "threadPanel.expand", defaultMessage: "Expand thread" })} className="size-6 touch:size-10 hidden md:inline-flex" onClick={() => setIsExpanded(v => !v)}>
            {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label={intl.formatMessage({ id: "threadPanel.close", defaultMessage: "Close thread" })} className="size-6 touch:size-10" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overflow-x-clip overscroll-contain [overflow-anchor:none] scrollbar-stable"
        >
          {/* Room for the root's floated toolbar above its row. */}
          <div ref={contentRef} className="relative pt-3">
            {listHeader}
            {!isLoading && replies.map((reply, index) => {
              // The root never continues into the first reply (the divider splits them).
              const prev = replies[index - 1];
              const continuation =
                !!prev &&
                prev.pubkey === reply.pubkey &&
                reply.created_at - prev.created_at < CONTINUATION_WINDOW_SECONDS;
              return (
                <div key={reply.id} data-event-id={reply.id} data-scroll-anchor={`reply:${reply.id}`} className="pt-1">
                  <ThreadMessage event={reply} permalink={permalink} reactions={reactionsFor?.(reply.id)} zaps={zapsFor?.(reply.id)} zapEnabled={zapEnabled} onSendZap={onSendZap} onSendOnchainZap={onSendOnchainZap} canReact={canWrite} canModerate={canModerate} isRumor={isRumor} continuation={continuation} everyoneMention={transport.mentionsEveryone?.(reply)} onDelete={onDelete} isEditing={editingId === reply.id} onEdit={startEditing} onEditSubmit={handleEditSubmit} onEditCancel={cancelEditing} documentMarkdown={documentMarkdown} />
                </div>
              );
            })}
          </div>
        </div>
        {showJumpToLatest && (
          <div className="absolute bottom-3 inset-x-0 z-10 flex justify-center pointer-events-none">
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="pointer-events-auto inline-flex items-center gap-1.5 clip-corner-lg bg-secondary/90 backdrop-blur px-4 py-2 text-xs font-medium text-foreground shadow-lg hover:bg-secondary transition-colors"
              aria-label={intl.formatMessage({ id: "threadPanel.jumpToLatestReplies", defaultMessage: "Jump to latest replies" })}
            >
              <ChevronDown className="size-4" />
              <FormattedMessage id="threadPanel.jumpToLatest" defaultMessage="Jump to latest" />
            </button>
          </div>
        )}
      </div>

      {canWrite ? (
        <ChatComposer
          relayUrl={relayUrl}
          botCommands={botCommands}
          conversationRelays={conversationRelays}
          encryptAttachments={encryptAttachments}
          disappearingTimer={disappearingTimer}
          groupId={groupId}
          messages={[]}
          mentionPubkeys={mentionPubkeys}
          canMentionEveryone={transport.canMentionEveryone}
          placeholder={placeholder ?? (isPost ? intl.formatMessage({ id: "threadPanel.placeholderComment", defaultMessage: "Add a comment…" }) : intl.formatMessage({ id: "threadPanel.placeholderReply", defaultMessage: "Reply in thread…" }))}
          draftScope={`thread:${root.id}`}
          // No `shareRoute`: the room's own composer is the share destination.
          autoFocus={autoFocus}
          canSend={transport.canSend}
          sendOverride={async (text, tags) => {
            await transport.sendThreadReply?.(root, text, tags);
            // Replying drops any `/m/` focus, since the panel snaps to the new reply.
            clearReplyFocus();
          }}
          onEditLast={editMessage ? editLast : undefined}
        />
      ) : (
        <div className="p-3 shrink-0 pb-safe">
          <p className="text-xs text-muted-foreground text-center py-1">
            {readOnlyNotice ?? intl.formatMessage({ id: "threadPanel.joinToReply", defaultMessage: "Join this channel to reply." })}
          </p>
        </div>
      )}
    </aside>
    </ComposerBoundsProvider>
  );
}
