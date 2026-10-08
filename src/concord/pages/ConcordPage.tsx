import { AtSign, Ban, CalendarClock, CheckCheck, ChevronDown, Bell, BellOff, Crown, Folder, FolderGit2, Hash, Headphones, KeyRound, Loader2, Lock, LogOut, Megaphone, MessageSquareText, MessagesSquare, Pause, Phone, Pin, Play, Plus, RefreshCw, Rss, Search, Settings, Shield, ShieldOff, Timer, Trash2, UserMinus, UserPlus, X, type LucideIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

import { AppStageSlot } from "@/components/chat/AppStage";
import { MountWhenOpened } from "@/components/MountWhenOpened";
import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { ReplyContext } from "@/components/chat/ReplyContext";
import { useConcordReplyParents } from "@/concord/hooks/useReplyParents";
import { LoginArea } from "@/components/auth/LoginArea";
import { JoinButton } from "@/components/auth/JoinButton";
import { MemberList } from "@/components/chat/MemberList";
import type { RolePickerOption } from "@/components/chat/RolePickerItems";
import { ProfileRelayHints } from "@/components/ProfileRelayHints";
import { ChannelCategoryHeading } from "@/concord/components/ChannelCategoryHeading";
import { CategoryNameDialog } from "@/concord/components/CategoryNameDialog";
import { categoryKey, categoryNames, groupChannelsByCategory } from "@/concord/lib/channelCategory";
import {
  applyArrangement,
  arrangementChanges,
  arrangementSettled,
  pendingFromPlan,
  planChannelDrop,
  type PendingArrangement,
} from "@/concord/lib/channelArrangement";
import { useChannelDrag, type ChannelDrop, type ChannelDropSlot } from "@/concord/hooks/useChannelDrag";
import { DateSeparator, isSameDay, MessageTimeline } from "@/components/chat/MessageTimeline";
import { ThreadPanelSlot } from "@/components/chat/ThreadPanelSlot";
import { useThreadPanel } from "@/hooks/useThreadPanel";
import { useTimelineFocus } from "@/hooks/useTimelineFocus";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { CalendarEventsBar } from "@/components/chat/CalendarEventsBar";
import { PinnedBar } from "@/concord/components/PinnedBar";
import { CreateEventDialog } from "@/components/dialogs/CreateEventDialog";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { GitTimelineRow, TicketSidePanel } from "@/components/chat/GitTimeline";
import { isGitTimelineEntry, mergeChannelTimeline } from "@/components/chat/channelTimeline";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { VoiceParticipantList } from "@/components/VoicePresence";
import { CommunitySettingsView } from "@/concord/components/CommunitySettingsView";
import { AddChannelMembersDialog } from "@/concord/components/AddChannelMembersDialog";
import { ImageLightbox } from "@/concord/components/ImageLightbox";
import { InviteDialog } from "@/concord/components/InviteDialog";
import { ShareToDiscoverDialog } from "@/concord/components/ShareToDiscoverDialog";
import { ModerationView } from "@/concord/components/ModerationView";
import {
  MODERATION_TABS,
  firstModerationPane,
  isModerationPane,
  type ModerationAccess,
  type ModerationPane,
} from "@/concord/lib/moderationPanes";
import { reportInboxSecret } from "@/concord/lib/report";
import { isEveryoneMention } from "@/concord/lib/everyoneMention";
import { SuspiciousActivityBanner } from "@/concord/components/SuspiciousActivityBanner";
import { SuspiciousActivityView } from "@/concord/components/SuspiciousActivityView";
import { useSelfRemove } from "@/concord/hooks/useSelfRemove";
import { useLinkAuthorityWatch, useLinkFreshnessWatch, useRetireCommunityLinks, type RetirementOutcome } from "@/concord/hooks/useInvites";
import { dissolveMissToast } from "@/concord/components/dissolveMissToast";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import {
  ChatHeader,
  ChatHeaderAction,
  ChatHeaderActions,
  ChatHeaderAvatar,
  ChatHeaderBack,
  ChatHeaderMenuTrigger,
  ChatHeaderTitle,
  ChatHeaderViewItems,
} from "@/components/chat/ChatHeader";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { ChatShell } from "@/components/chat/ChatShell";
import { useChatEditing } from "@/components/chat/useChatEditing";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { MemberActionsContext, type MemberActionItem, type MemberActionsValue, type MemberRolePicker } from "@/contexts/MemberActionsContext";
import { MemberRolesContext, type MemberRolesValue } from "@/contexts/MemberRolesContext";
import type { AppScope } from "@/contexts/AppsContext";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { ConcordMediaHold } from "@/concord/components/ConcordMediaHold";
import { useAppContext } from "@/hooks/useAppContext";
import { usePerfMilestone } from "@/hooks/usePerfMilestone";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useMobileMembersOverlay } from "@/hooks/useMobileMembersOverlay";
import { useAuthor } from "@/hooks/useAuthor";
import { useChannelGitActivity } from "@/hooks/useChannelGitActivity";
import { useGitProjects } from "@/hooks/useGitProjects";
import { useGitWorkItemActions, type GitWorkItemRepository } from "@/hooks/useGitWorkItemActions";
import { NewChannelDialog, type NewTextChannelOptions, type WizardRepository } from "@/concord/components/NewChannelDialog";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { ForumFeed } from "@/concord/components/ForumFeed";
import { ForumPostPage } from "@/concord/components/ForumPostPage";
import { NewPostPane } from "@/concord/components/NewPostPane";
import { forumPosts, isTitledPost, subjectOf, subjectTags, type ForumPost, type ForumSort } from "@/concord/lib/forum";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { NewIssueDialog } from "@/components/projects/NewIssueDialog";
import { ProjectsView } from "@/components/projects/ProjectsView";
import type { ProjectWorkItem } from "@/components/projects/projectData";
import { useCommunityGitActivity } from "@/hooks/useCommunityGitActivity";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useSyncTasks } from "@/hooks/useSyncActivity";
import { useSyncTopicState } from "@/sync/useSyncTopic";
import { concordChannelMuteKey, useMutes } from "@/hooks/useMutes";
import { useNotifLevels, concordChannelScopeKey } from "@/hooks/useNotifLevels";
import { concordThreadReadKey, useReadState } from "@/hooks/useReadState";
import { usePageCovered } from "@/lib/settingsOverlay";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { toast } from "@/hooks/useToast";
import { CommunityNoAccess } from "@/concord/components/CommunityNoAccess";
import { useCommunity, useCommunityList, useIsExcluded } from "@/concord/hooks/useCommunityList";
import { channelDecodeDeadEnd } from "@/concord/lib/channelSync";
import { activateScope, concordScope } from "@/wire/activation";
import { useCommunityManagement, useStrandedRecovery } from "@/concord/hooks/useCommunityActions";
import { useChannels, useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { PAUSE_DURATIONS, useCommunityPause } from "@/concord/hooks/usePause";
import { CommunityPauseBanner } from "@/concord/components/CommunityPauseBanner";
import { PendingJoinNotice } from "@/concord/components/PendingJoinNotice";
import { usePendingGuestbookJoin } from "@/concord/hooks/usePendingGuestbookJoin";
import { usePins } from "@/concord/hooks/usePins";
import { BanMemberDialog } from "@/concord/components/BanMemberDialog";
import { KickMembersDialog } from "@/concord/components/KickMembersDialog";
import { RotateKeysDialog } from "@/concord/components/RotateKeysDialog";
import type { BanPhase } from "@/concord/hooks/useModeration";
import { hasForeignLiveLinks } from "@/concord/lib/control";
import { replyTargetOf } from "@/concord/lib/chat";
import { communityTimerNotice, messageExpirationOf } from "@/concord/lib/disappearing";
import { sweepExpiredCommunityRumors } from "@/concord/lib/rumorStore";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { useModeration, useReadCutRetry } from "@/concord/hooks/useModeration";
import { useChannelRekey, useChannelRekeyWatch, useLinkRefreshWatch, useRekeyWatch } from "@/concord/hooks/useRekey";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { channelsHingingOn, isEntitled } from "@/concord/lib/channelAccess";
import { bytesToHex } from "@/concord/lib/derive";
import { useRelayFollow } from "@/concord/hooks/useRelayFollow";
import { useMemberPanelScope } from "@/concord/hooks/useMemberPanelScope";
import { useRoleIntent } from "@/concord/hooks/useRoleIntent";
import { useRoles, useStaffKeyWatch } from "@/concord/hooks/useRoles";
import { useSendMessage } from "@/concord/hooks/useChannel";
import { useTransport } from "@/concord/hooks/useTransport";
import { useConcordUnread, type ConcordUnread } from "@/concord/hooks/useConcordUnread";
import { useCommunityFeed } from "@/concord/hooks/useCommunityFeed";
import { useConcordMentions } from "@/concord/hooks/useConcordMentions";
import { useConcordSearch } from "@/concord/hooks/useConcordSearch";
import { SearchFiltersPopover, SearchResultsView } from "@/concord/components/Search";
import { EMPTY_SEARCH_FILTERS, type SearchFilters } from "@/concord/lib/search";
import { useConcordThreads, type ConcordThread } from "@/concord/hooks/useConcordThreads";
import { useTyping, useTypingPublisher } from "@/concord/hooks/useTyping";
import { resolveVoiceBroker, useVoiceBroker, useVoicePresence } from "@/concord/hooks/useVoice";
import { communityAvBrokers } from "@/concord/lib/voice";
import { useRegisterChannelStreamKeys } from "@/concord/hooks/useStreamAuth";
import { completeMemberlist } from "@/concord/lib/guestbook";
import { badgeOf, byDisplayOrder, canActOnMember, canActOnPosition, isAuthorized, isAuthorizedIn, MAX_ROLES_PER_MEMBER, Permissions, stockTierOf, tierMoves } from "@/concord/lib/roles";
import { channelGitRepositoryAttachments, type Channel, type Community, type ImagePointer } from "@/concord/lib/types";
import { matchGitTicketRepository, parseGitRepositoryAddress, sortAndDedupeGitTimelineActivities, trustedGitStatusAuthors, type GitComment, type GitStatusKind, type GitTicket } from "@/lib/gitActivity";
import { tierChangeConfirm } from "@/lib/memberTierConfirm";
import { cn, pickDefaultChannel } from "@/lib/utils";
import { chatRoute, parseChatRoute, type ChatRoute, type Concord2Pane } from "@/lib/routes";
import { useLegacyFocusParams } from "@/hooks/useLegacyFocusParams";
import { useApps } from "@/hooks/useApps";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortTimeAgo } from "@/lib/formatTime";

import { authorsByRecency, threadSummary } from "@/components/chat/transport";
import type { ChatMsg, MessageCalendar, MessagePoll, MessageReactions, MessageZaps, OnchainZapAnnouncement, SendStatus, ZapPayment } from "@/components/chat/transport";

/** How long a channel must stay open before it becomes the remembered one. */
const LAST_CHANNEL_SETTLE_MS = 1500;

/** Stable empty replies array so a thread-less row keeps a constant prop. */
const EMPTY_REPLIES: ChatMsg[] = [];
const NO_MEMBER_ACTIONS: MemberActionItem[] = [];

/** Shared empty feed, so a chat-presented channel keeps a stable reference. */
const NO_POSTS: ForumPost[] = [];

/** Header names for community-wide panes that aren't moderation ones (those use `MODERATION_TABS`). */
const PANE_HEADERS: Record<
  Exclude<Concord2Pane, ModerationPane>,
  { icon: LucideIcon; label: string }
> = {
  all: { icon: Rss, label: "All messages" },
  mentions: { icon: AtSign, label: "Mentions" },
  threads: { icon: MessagesSquare, label: "Threads" },
  projects: { icon: FolderGit2, label: "Projects" },
  settings: { icon: Settings, label: "Community settings" },
  suspicious: { icon: Shield, label: "Suspicious activity" },
};

/** The community's decrypted icon for the channel-list title; nothing if none. */
function TitleIcon({ icon }: { icon: ImagePointer | undefined }) {
  const url = useDecryptedImage(icon);
  if (!url) return null;
  return <img src={url} alt="" className="size-6 rounded object-cover shrink-0" />;
}

function TitleAvatar({ icon, name }: { icon: ImagePointer | undefined; name: string | undefined }) {
  return <ChatHeaderAvatar src={useDecryptedImage(icon)} name={name} />;
}

function Banner({ banner }: { banner: ImagePointer | undefined }) {
  const url = useDecryptedImage(banner);
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <button
        type="button"
        className="size-full overflow-hidden cursor-zoom-in"
        aria-label="View banner"
        onClick={() => setOpen(true)}
      >
        <img src={url} alt="" className="size-full object-cover" />
      </button>
      {open && <ImageLightbox src={url} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Concord inline-reply context: resolve the parent from the in-memory decoded set
 * (rumors aren't relay-fetchable). Clicking jumps to the parent.
 */
interface ChatMessage2Props {
  /** Channel route for "Copy message link" (see ChatMessage.permalink). */
  permalink?: ChatRoute;
  event: ChatMsg;
  /** The post's subject when this is a titled post (CORD-03 §3), shown as a heading. */
  title: string | undefined;
  reactions: MessageReactions;
  zaps: MessageZaps | undefined;
  onSendZap: ((target: ChatMsg, payment: ZapPayment) => Promise<void>) | undefined;
  onSendOnchainZap: ((target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>) | undefined;
  /** Poll tally + vote callback when this message is a poll (kind 1068). */
  poll: MessagePoll | undefined;
  /** Calendar event + RSVP state when this message is a calendar event (31922/31923). */
  calendar: MessageCalendar | undefined;
  /** This message's thread replies (stable ref from the transport), for the badge. */
  replies: ChatMsg[];
  continuation: boolean;
  canWrite: boolean;
  canModerate: boolean;
  everyoneMention: boolean;
  sendStatus: SendStatus | undefined;
  active: boolean;
  onToggleActive: (id: string) => void;
  onOpenThread: ((event: ChatMsg) => void) | undefined;
  onReply: ((event: ChatMsg) => void) | undefined;
  /**
   * The inline reply's parent id and resolved message, as plain values — a fresh
   * element per render would defeat `memo` for every reply row.
   */
  replyToId: string | undefined;
  replyParent: ChatMsg | undefined;
  onJumpToReply: (id: string) => void;
  onDelete: ((event: ChatMsg) => void) | undefined;
  /** Pins (CORD-04 §7) — both present only for PIN_MESSAGES holders. */
  isPinned: boolean;
  onTogglePin: ((event: ChatMsg) => void) | undefined;
  onRetry: ((event: ChatMsg) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  isEditing: boolean;
  onEdit: ((event: ChatMsg) => void) | undefined;
  onEditSubmit: ((event: ChatMsg, content: string) => Promise<void>) | undefined;
  onEditCancel: () => void;
}

/** Memoized per-message binding. `onReply` quotes inline; `onOpenThread` opens the thread panel. */
const ConcordChatMessage = memo(function ConcordChatMessage({
  event,
  title,
  reactions,
  zaps,
  onSendZap,
  onSendOnchainZap,
  poll,
  calendar,
  replies,
  continuation,
  canWrite,
  canModerate,
  everyoneMention,
  sendStatus,
  active,
  onToggleActive,
  onOpenThread,
  onReply,
  replyToId,
  replyParent,
  onJumpToReply,
  onDelete,
  isPinned,
  onTogglePin,
  onRetry,
  onDiscard,
  isEditing,
  onEdit,
  onEditSubmit,
  onEditCancel,
  permalink,
}: ChatMessage2Props) {
  // Memoized: props of the memoized ChatMessage below.
  const threadInfo = useMemo(() => threadSummary(replies), [replies]);
  const replyContext = useMemo(
    () => (replyToId ? <ReplyContext parentId={replyToId} parent={replyParent} onJump={onJumpToReply} /> : undefined),
    [replyToId, replyParent, onJumpToReply],
  );
  // Concord messages are unsigned rumors with no relay-addressable id, so the
  // context menu offers "View event JSON" instead of ID/Ditto off-ramps.
  const rumor = event;
  // A titled post keeps its title in the timeline too.
  const heading = useMemo(
    () =>
      title ? (
        <div className="mb-0.5 flex items-start gap-1.5 text-chat font-semibold leading-snug">
          <MessageSquareText className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 break-words">{title}</span>
        </div>
      ) : undefined,
    [title],
  );
  return (
    <ChatMessage
      event={event}
      rumor={rumor}
      heading={heading}
      canWrite={canWrite}
      canModerate={canModerate}
      everyoneMention={everyoneMention}
      reactions={reactions}
      zapEnabled={Boolean(onSendZap)}
      zaps={zaps}
      onSendZap={onSendZap}
      onSendOnchainZap={onSendOnchainZap}
      poll={poll}
      calendar={calendar}
      sendStatus={sendStatus}
      continuation={continuation}
      active={active}
      onToggleActive={onToggleActive}
      replyCount={replies.length}
      threadParticipants={threadInfo.participants}
      lastReplyAt={threadInfo.lastReplyAt}
      onOpenThread={onOpenThread}
      onReply={onReply}
      replyContext={replyContext}
      onDelete={onDelete}
      isPinned={isPinned}
      onTogglePin={onTogglePin}
      // Only a failed row gets Retry/Discard closures (keeps ChatMessage's memo).
      onRetry={sendStatus === "failed" && onRetry ? () => onRetry(event) : undefined}
      onDiscard={sendStatus === "failed" && onDiscard ? () => onDiscard(event.id) : undefined}
      isEditing={isEditing}
      onEdit={onEdit}
      onEditSubmit={onEditSubmit}
      onEditCancel={onEditCancel}
      permalink={permalink}
    />
  );
});

/**
 * Pinned footer for the Concord channel sidebar: the voice call-bar portal slot
 * (per rendered instance) above the account area, mirroring NIP-29's ChannelSidebar.
 */
function SidebarFooter() {
  const { user } = useCurrentUser();
  const { registerCallBarSlot } = useCall();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);
  return (
    <>
      <div ref={ref} className="empty:hidden shrink-0 px-2 pb-2" />
      {/* pb-2 mirrors the composer's inner `p-2` so both end on the same line. */}
      <div className="px-3 pb-safe shrink-0">
        {user ? (
          <div className="pb-2">
            <LoginArea className="w-full flex" />
          </div>
        ) : (
          <div className="p-2 flex justify-center">
            <JoinButton className="w-full max-w-xs clip-corner-lg font-medium" />
          </div>
        )}
      </div>
    </>
  );
}

export const ChannelRow = memo(function ChannelRow({
  community,
  channel,
  active,
  inCall,
  speaking,
  muted: mutedVoice,
  unread,
  onSelect,
  onJoinVoice,
  categories,
  onSetCategory,
  onNewCategory,
}: {
  community: Community | undefined;
  channel: Channel;
  active: boolean;
  /** Whether the user's current call is THIS channel's voice room. */
  inCall: boolean;
  /** Live speaker set (only passed when `inCall`), for roster voice activity. */
  speaking?: ReadonlySet<string>;
  /** Live muted set (only passed when `inCall`), for the roster mute indicator. */
  muted?: ReadonlySet<string>;
  unread?: ConcordUnread;
  onSelect: (channelIdHex: string) => void;
  onJoinVoice: (channel: Channel, broker: string | null) => void;
  /** Category names already in use, offered so near-duplicates aren't retyped. */
  categories?: string[];
  /** Undefined for a member without MANAGE_CHANNELS: no filing menu at all. */
  onSetCategory?: (channelIdHex: string, category: string | undefined) => void;
  /** Opens the naming prompt — a context menu is a poor place for a text field. */
  onNewCategory?: (channel: Channel) => void;
}) {
  // Every Channel is callable (CORD-07); presence drives the nested roster. The
  // broker is NOT resolved per row (one query observer per channel on every page
  // switch); `handleJoinVoice` resolves it lazily.
  const fold = useVoicePresence(community, channel);
  const { voiceRoomPubkeys, streamingPubkeys } = useVoiceActivity();
  const { isConcordChannelMuted } = useMutes();
  const { concordChannelLevel, setLevel: setNotifLevel } = useNotifLevels();
  const notificationLevel = community
    ? concordChannelLevel("c2", community.idHex, channel.idHex)
    : "all";
  const muted = community
    ? isConcordChannelMuted("c2", community.idHex, channel.idHex)
    : false;
  const foldedParticipants = useMemo(() => fold.present.map((p) => p.author), [fold]);
  // Raised hands come off the presence fold, visible even when not joined.
  const raisedVoice = useMemo(
    () => new Set(fold.present.filter((p) => p.hand).map((p) => p.author)),
    [fold],
  );
  // While in this call, LiveKit's live roster is authoritative (presence lags).
  const participants = inCall && voiceRoomPubkeys ? voiceRoomPubkeys : foldedParticipants;

  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  const callable = channel.view !== "forum";
  const occupied = callable && participants.length > 0;
  // A live call swaps the row's glyph for a speaker.
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div>
          <div
            className={cn(
              "group/row relative flex w-full items-center",
              !active && "hover:bg-foreground/5 clip-corner-lg",
              active && "clip-corner-lg bg-primary text-primary-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => {
                onSelect(channel.idHex);
              }}
              className={cn(
                // Selected: filled primary with the house cut-corner chamfer (matches ChannelSidebar).
                "flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors text-left",
                !active && "text-muted-foreground group-hover/row:text-foreground",
                // Unread reads brighter + bold, except muted channels.
                !active && hasUnread && !muted && "text-foreground font-semibold",
                !active && muted && "opacity-60",
                active && "font-medium",
              )}
            >
              <ChannelGlyph
                isPrivate={channel.isPrivate}
                view={channel.view}
                occupied={occupied}
                className={cn("size-4 shrink-0", occupied && !active && "text-success")}
              />
              <span className="truncate flex-1 min-w-0">{channel.name}</span>
              {inCall && <Headphones className={cn("size-3.5 shrink-0", !active && "text-success")} />}
              {hasMention ? (
                <span
                  className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none"
                  aria-label="You were mentioned"
                >
                  @
                </span>
              ) : null}
            </button>
            {callable && !inCall && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onJoinVoice(channel, null);
                }}
                aria-label={occupied ? "Join call" : "Start call"}
                title={occupied ? "Join call" : "Start call"}
                className={cn(
                  "shrink-0 flex items-center justify-center size-7 mr-2 clip-corner transition-opacity",
                  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                  // No hover on touch: hidden unless a call is live.
                  !occupied && "touch:hidden",
                  occupied && "opacity-100",
                  active
                    ? "text-primary-foreground hover:bg-primary-foreground/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/10",
                  occupied && !active && "text-success",
                )}
              >
                <Phone className="size-3.5" />
              </button>
            )}
          </div>
          {occupied && (
            <VoiceParticipantList
              participants={participants}
              speaking={speaking}
              muted={mutedVoice}
              streaming={inCall ? streamingPubkeys : undefined}
              raised={raisedVoice}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {community && (
          <NotifLevelMenu
            label="Channel notifications"
            level={notificationLevel}
            onChange={(lvl) =>
              setNotifLevel(concordChannelScopeKey("c2", community.idHex, channel.idHex), lvl)
            }
          />
        )}
        {onSetCategory && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Folder className="size-4" />
              Move to category
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              {(categories ?? []).map((name) => (
                <ContextMenuItem
                  key={name}
                  disabled={categoryKey(name) === categoryKey(channel.category ?? "")}
                  onSelect={() => onSetCategory(channel.idHex, name)}
                >
                  <Folder className="mr-2 size-4" />
                  <span className="truncate">{name}</span>
                </ContextMenuItem>
              ))}
              {(categories ?? []).length > 0 && <ContextMenuSeparator />}
              <ContextMenuItem onSelect={() => onNewCategory?.(channel)}>
                <Plus className="mr-2 size-4" />
                New category…
              </ContextMenuItem>
              {channel.category && (
                <ContextMenuItem onSelect={() => onSetCategory(channel.idHex, undefined)}>
                  <X className="mr-2 size-4" />
                  Remove from category
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * Community-wide "@ Mentions" pane: cached messages p-tagging the user across
 * channels, newest first, grouped by channel; click jumps to the message. Read-only.
 */
function MentionsView({
  channels,
  mentions,
  isLoading,
  onJump,
  mentionsEveryone,
}: {
  channels: Channel[];
  mentions: ChatMsg[];
  isLoading: boolean;
  onJump: (channelIdHex: string, message: ChatMsg) => void;
  mentionsEveryone: (message: ChatMsg) => boolean;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  if (mentions.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        {isLoading ? "Loading mentions…" : "No mentions yet. When someone @-mentions you, it'll show up here."}
      </p>
    );
  }

  return (
    <div className="flex flex-col py-2 px-2">
      {mentions.map((msg) => {
        const channelIdHex = msg.tags.find((t) => t[0] === "channel")?.[1] ?? "";
        const ch = nameByChannel.get(channelIdHex);
        return (
          <div key={msg.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              <ChannelGlyph isPrivate={ch?.isPrivate} view={ch?.view} className="size-3 shrink-0" />
              <span className="truncate">{ch?.name ?? "unknown channel"}</span>
            </div>
            <AggregateMessage
              event={msg}
              everyoneMention={mentionsEveryone(msg)}
              onJump={ch ? () => onJump(channelIdHex, msg) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A read-only row in a community-wide pane (Mentions, All messages). The row
 * jumps to the message; inner ChatMessage controls stop propagation.
 */
const AggregateMessage = memo(function AggregateMessage({
  event,
  onJump,
  everyoneMention = false,
}: {
  event: ChatMsg;
  onJump?: () => void;
  everyoneMention?: boolean;
}) {
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
  // Hover tint is a clipped `::before`: clipping the wrapper would slice off
  // ChatMessage's toolbar, which floats above the row.
  return (
    <div
      role={onJump ? "button" : undefined}
      tabIndex={onJump ? 0 : undefined}
      onClick={onJump ? () => onJump() : undefined}
      onKeyDown={
        onJump
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump();
              }
            }
          : undefined
      }
      className={cn(
        "relative isolate",
        onJump &&
          "cursor-pointer before:absolute before:inset-0 before:-z-10 before:clip-corner-lg before:transition-colors before:content-[''] hover:before:bg-foreground/5",
      )}
      aria-label={onJump ? "Jump to this message" : undefined}
    >
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} everyoneMention={everyoneMention} />
    </div>
  );
});

/**
 * Community-wide "All messages" pane: every channel merged newest first, with day
 * dividers and a channel label on each change (restated after a day divider).
 * Rows jump to the message. `hasMore` is the completeness watermark (see
 * {@link useCommunityFeed}).
 */
function AllMessagesView({
  channels,
  messages,
  isLoading,
  hasMore,
  isLoadingOlder,
  onLoadOlder,
  onJump,
  mentionsEveryone,
}: {
  channels: Channel[];
  messages: ChatMsg[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  onJump: (channelIdHex: string, message: ChatMsg) => void;
  mentionsEveryone: (message: ChatMsg) => boolean;
}) {
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  const rows = useMemo(() => {
    let prevDay: number | undefined;
    let prevChannel: string | undefined;
    return messages.map((msg) => {
      const channelIdHex = msg.tags.find((t) => t[0] === "channel")?.[1] ?? "";
      const newDay = prevDay === undefined || !isSameDay(prevDay, msg.created_at);
      const newChannel = newDay || channelIdHex !== prevChannel;
      prevDay = msg.created_at;
      prevChannel = channelIdHex;
      return { msg, channelIdHex, newDay, newChannel };
    });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        {isLoading
          ? "Loading messages…"
          : "No messages yet. Every channel's messages will show up here together."}
      </p>
    );
  }

  return (
    <div className="flex flex-col py-2 px-2">
      {rows.map(({ msg, channelIdHex, newDay, newChannel }) => {
        const ch = channelById.get(channelIdHex);
        return (
          <div key={msg.id} className="pb-1">
            {newDay ? <DateSeparator ts={msg.created_at} /> : null}
            {newChannel ? (
              <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
                <ChannelGlyph isPrivate={ch?.isPrivate} view={ch?.view} className="size-3 shrink-0" />
                <span className="truncate">{ch?.name ?? "unknown channel"}</span>
              </div>
            ) : null}
            <AggregateMessage
              event={msg}
              everyoneMention={mentionsEveryone(msg)}
              onJump={ch ? () => onJump(channelIdHex, msg) : undefined}
            />
          </div>
        );
      })}
      {hasMore ? (
        <div className="flex justify-center py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
            className="text-muted-foreground"
          >
            {isLoadingOlder ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Loading…
              </>
            ) : (
              "Load older messages"
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Community-wide "Threads" pane: threads the user participated in, newest reply
 * first; clicking opens the thread panel. Unread rows light up.
 */
function ThreadsView({
  channels,
  threads,
  isLoading,
  onOpen,
  mentionsEveryone,
}: {
  channels: Channel[];
  threads: ConcordThread[];
  isLoading: boolean;
  onOpen: (thread: ConcordThread) => void;
  mentionsEveryone: (message: ChatMsg) => boolean;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  if (threads.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        {isLoading
          ? "Loading threads…"
          : "No threads yet. Threads you start or reply in will show up here."}
      </p>
    );
  }

  return (
    <div className="flex flex-col py-2 px-2">
      {threads.map((t) => {
        const ch = nameByChannel.get(t.channelIdHex);
        return (
          <div key={t.root.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              <ChannelGlyph isPrivate={ch?.isPrivate} view={ch?.view} className="size-3 shrink-0" />
              <span className="truncate">{ch?.name ?? "unknown channel"}</span>
              {t.hasNew ? (
                <span
                  className="ml-1 shrink-0 size-1.5 rounded-full bg-primary"
                  aria-label="New replies"
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onOpen(t)}
              className={cn(
                "block w-full text-left clip-corner-lg cursor-pointer hover:bg-foreground/5 transition-colors",
                t.hasNew && "bg-primary/5",
              )}
              aria-label="Open thread"
            >
              <ThreadRootPreview event={t.root} everyoneMention={mentionsEveryone(t.root)} />
              <div className="flex items-center gap-2 pl-[3.875rem] pr-3 pb-1.5 -mt-1">
                <ThreadReplyAvatars pubkeys={t.participants} />
                <span
                  className={cn(
                    "text-xs font-medium",
                    t.hasNew ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                </span>
                <span className="text-xs text-muted-foreground">· {shortTimeAgo(t.lastReplyAt)}</span>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The thread root message, read-only (its click is handled by the row wrapper). */
const ThreadRootPreview = memo(function ThreadRootPreview({ event, everyoneMention = false }: { event: ChatMsg; everyoneMention?: boolean }) {
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
  return (
    <div className="pointer-events-none">
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} everyoneMention={everyoneMention} />
    </div>
  );
});

/** A small newest-first avatar stack of the thread's repliers. */
function ThreadReplyAvatars({ pubkeys }: { pubkeys: string[] }) {
  const shown = pubkeys.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <div className="flex -space-x-1.5">
      {shown.map((pk) => (
        <ThreadReplyAvatar key={pk} pubkey={pk} />
      ))}
    </div>
  );
}

function ThreadReplyAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = metadata?.name ?? pubkey.slice(0, 8);
  return (
    <Avatar shape={getAvatarShape(metadata)} className="size-5 ring-2 ring-chrome" title={name}>
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-monogram font-semibold uppercase">
        {name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  );
}

/** A disappearing-messages timer change (CORD-08 §4), rendered as a centered notice. */
function TimerNotice({ author, seconds, self }: { author: string; seconds: number; self: string | undefined }) {
  const a = useAuthor(author);
  const name = a.data?.metadata?.name ?? author.slice(0, 8);
  return (
    <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 select-none" role="status">
      <Timer className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="text-2xs text-muted-foreground/80 text-center">
        {communityTimerNotice(seconds, author === self, name)}
      </span>
    </div>
  );
}

/**
 * A Concord community (CORD-01..06) at `/c/:communityId`, rehydrated from the
 * Community List and rendered through the same chat components as NIP-29/DMs.
 */
export function ConcordPage() {
  // Parsed via `parseChatRoute` (panes are static segments with no params), the
  // same parse the builder and notifications use.
  const location = useLocation();
  const { pathname } = location;
  const route = useMemo(() => {
    const parsed = parseChatRoute(pathname);
    return parsed?.kind === "concord" ? parsed : undefined;
  }, [pathname]);
  const communityId = route?.communityId;
  const routeChannelId = route?.channelId;
  const routePane = route?.pane;
  const { user } = useCurrentUser();
  // Stable across navigations: it's passed to every message row, and
  // `useNavigate` changes identity per location.
  const navigateTo = useStableNavigate();
  const isTouchDevice = useIsTouch();
  // Covered by Settings: read stamps below wait until it closes.
  const covered = usePageCovered();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { config, updateConfig } = useAppContext();
  const { mutedChannels, isCommunityMuted, toggleCommunityMute, toggleConcordChannelMute } = useMutes();
  const lastChannelKey = communityId ? `c2:${communityId}` : "";

  // Navigating in makes this community "live" for the session (see wire/activation).
  useEffect(() => {
    if (communityId) activateScope(concordScope(communityId));
  }, [communityId]);

  const baseCommunity = useCommunity(communityId);
  const { data: folded } = useControlFold(baseCommunity);
  // What `useSendMessage` stamps messages with, so their attachments can expire alongside.
  const messageTimer = messageExpirationOf(folded?.metadata);
  const resolveMessageTimer = useCallback(async () => messageTimer, [messageTimer]);
  const community = useMemo<Community | undefined>(() => {
    if (!baseCommunity) return undefined;
    if (!folded?.metadata) return baseCommunity;
    return { ...baseCommunity, name: folded.metadata.name || baseCommunity.name };
  }, [baseCommunity, folded]);
  const channels = useChannels(baseCommunity);
  // Serial gate before the timeline: rehydrate → fold control plane → Channel
  // exists. Each step gets a profiling milestone.
  usePerfMilestone("page.community resolved", Boolean(baseCommunity));
  usePerfMilestone("page.control folded", Boolean(folded));
  usePerfMilestone("page.channels resolved", channels.length > 0);
  // Channel skeletons only after a delay (cache hits would flash them), and until
  // the control fold resolves — before that the list holds only the bundle's
  // private channels.
  const showChannelSkeleton = useDelayedFlag(!community || !folded || channels.length === 0);

  /**
   * Optimistic arrangement from a drop the fold hasn't confirmed yet (one signed
   * edition per moved channel), re-sorted like `channelsView`. Dropped when the
   * fold agrees or the publish fails.
   */
  const [pendingArrangement, setPendingArrangement] = useState<PendingArrangement | null>(null);

  const arrangedChannels = useMemo(
    () => applyArrangement(channels, pendingArrangement),
    [channels, pendingArrangement],
  );

  // Release the overlay once the fold agrees, so it never masks later changes.
  useEffect(() => {
    if (pendingArrangement && arrangementSettled(channels, pendingArrangement)) {
      setPendingArrangement(null);
    }
  }, [channels, pendingArrangement]);

  // Categories derive from visible channels only (see channelCategory.ts).
  const { uncategorized: uncategorizedChannels, categories: channelCategories } = useMemo(
    () => groupChannelsByCategory(arrangedChannels, (c) => c.category),
    [arrangedChannels],
  );

  const categoryPicklist = useMemo(
    () => categoryNames(arrangedChannels, (c) => c.category),
    [arrangedChannels],
  );

  /**
   * The sidebar's rendered sequence, flattened. Drop indices index into THIS
   * (channelArrangement.ts).
   */
  const renderedChannels = useMemo(
    () => [...uncategorizedChannels, ...channelCategories.flatMap((group) => group.channels)],
    [uncategorizedChannels, channelCategories],
  );
  const renderedIndexOf = useMemo(
    () => new Map(renderedChannels.map((c, index) => [c.idHex, index])),
    [renderedChannels],
  );

  const collapsedCategories = useMemo(
    () => new Set(config.collapsedChannelCategories[community?.idHex ?? ""] ?? []),
    [config.collapsedChannelCategories, community?.idHex],
  );

  const toggleCategory = useCallback(
    (key: string) => {
      const idHex = community?.idHex;
      if (!idHex) return;
      updateConfig((current) => {
        const collapsed = new Set(current.collapsedChannelCategories[idHex] ?? []);
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        const next = { ...current.collapsedChannelCategories };
        if (collapsed.size > 0) next[idHex] = [...collapsed];
        else delete next[idHex];
        return { ...current, collapsedChannelCategories: next };
      });
    },
    [community?.idHex, updateConfig],
  );

  const gitAttachmentsByChannel = useMemo(() => new Map(channels.map((candidate) => [
    candidate.idHex,
    channelGitRepositoryAttachments(folded?.channels.get(candidate.idHex)?.metadata ?? { name: candidate.name, private: candidate.isPrivate }),
  ])), [channels, folded]);
  const communityGitActivity = useCommunityGitActivity(gitAttachmentsByChannel);
  const hasProjects = useMemo(
    () => [...gitAttachmentsByChannel.values()].some((list) => list.some((attachment) => attachment.detachedAt === undefined)),
    [gitAttachmentsByChannel],
  );
  // Per-channel unread badges from the local rumor cache. `active`: the open
  // community is the one mount that resolves moderation over the network.
  const { byChannel: unreadByChannel, markRead: markChannelRead } = useConcordUnread(community, channels, communityGitActivity.byChannel, true);

  // "Mark all as read" (stamps are monotonic, so read channels no-op).
  const markAllChannelsRead = useCallback(() => {
    for (const [idHex, unread] of Object.entries(unreadByChannel)) {
      markChannelRead(idHex, unread.latest);
    }
  }, [unreadByChannel, markChannelRead]);

  // "@ Mentions" from the local cache, with its OWN read state so opening the tab
  // clears it.
  const {
    mentions,
    isLoading: mentionsLoading,
    hasNew: hasUnreadMention,
    markRead: markMentionsRead,
    markAllRead: markAllMentionsRead,
  } = useConcordMentions(community, channels);

  // "All messages" reads the store only while open (see `useCommunityFeed`).
  const feed = useCommunityFeed(community, channels, routePane === "all");

  // "Threads" the user participated in; opening the pane marks them read.
  const {
    threads,
    isLoading: threadsLoading,
    hasNew: hasNewThreadReplies,
    markRead: markThreadRead,
    markAllRead: markAllThreadsRead,
  } = useConcordThreads(community, channels);

  // NIP-42 auth as per-channel stream keys (plane keys are registered in MainLayout).
  useRegisterChannelStreamKeys(communityId);

  // Base-rekey rotations. `stranded`: a stale invite left us on a superseded epoch.
  const { stranded } = useRekeyWatch(baseCommunity);
  // Per-private-channel rotations (CORD-06 §2).
  useChannelRekeyWatch(baseCommunity);
  // Adopt a staff write key delivered in my Grant (CORD-04 §3).
  useStaffKeyWatch(baseCommunity);
  // Keep our live invite links vending the current epoch (CORD-05 §2).
  useLinkRefreshWatch(baseCommunity);
  // Follow the fold's relay list (CORD-02 §6).
  useRelayFollow(baseCommunity);
  // Stripped CREATE_INVITE → tombstone my own live links (only my signer_sk can).
  useLinkAuthorityWatch(baseCommunity);
  // Keep my live links' bundles vending current metadata + epoch.
  useLinkFreshnessWatch(baseCommunity);
  // Durable read-cut: finish a rotating ban dropped by a relay outage. Mounted ONCE here.
  useReadCutRetry(baseCommunity);
  // Stranded self-heal: re-resolve our invite link until its bundle is refreshed.
  const { canRecover, checking: recoveryChecking, checkNow: recoveryCheckNow } = useStrandedRecovery(baseCommunity, stranded);

  // Kicked/banned: stays on the rail but read-only; clears if re-included.
  const excluded = useIsExcluded(communityId);

  // Fall back to the persisted last-open channel when the route doesn't name one:
  // knowing the id at first render lets the timeline snapshot paint before the
  // control fold resolves.
  const channelIdHex = routeChannelId ?? (lastChannelKey ? config.lastChannelByServer[lastChannelKey] ?? null : null);
  const view: "channel" | Concord2Pane = routePane ?? "channel";
  const paneHeader =
    view === "channel" ? null : isModerationPane(view) ? MODERATION_TABS[view] : PANE_HEADERS[view];
  const selectChannel = useCallback(
    (idHex: string) => {
      if (!communityId) return;
      navigateTo(chatRoute({ kind: "concord", communityId, channelId: idHex }));
    },
    [communityId, navigateTo],
  );
  const selectPane = useCallback(
    (pane: Concord2Pane) => {
      if (!communityId) return;
      navigateTo(chatRoute({ kind: "concord", communityId, pane }));
    },
    [communityId, navigateTo],
  );
  // Projects data loads lazily (tab opened, or a ticket conversation opens).
  const [projectsTouched, setProjectsTouched] = useState(false);
  const [openTicket, setOpenTicket] = useState<GitTicket | undefined>();
  const [ticketExpanded, setTicketExpanded] = useState(false);
  // The ticket and a chat thread share the right-hand slot; opening one closes the other.
  const closeThreadRef = useRef<() => void>(() => {});
  // Close the ticket panel on community/channel/pane change during render. Uses
  // the ROUTE's channel, since the persisted fallback lags a switch.
  const ticketContextKey = `${communityId ?? ""}|${routeChannelId ?? ""}|${view}`;
  const [ticketContext, setTicketContext] = useState(ticketContextKey);
  if (ticketContext !== ticketContextKey) {
    setTicketContext(ticketContextKey);
    setOpenTicket(undefined);
  }
  const channelNameById = useMemo(() => new Map(channels.map((c) => [c.idHex, c.name])), [channels]);
  const projects = useGitProjects(gitAttachmentsByChannel, channelNameById, projectsTouched || Boolean(openTicket));
  // Kind-1111 replies only render in a thread panel, hence `/t/<root>/m/<id>`.
  const jumpToMention = useCallback(
    (channelIdHex: string, message: ChatMsg) => {
      if (!communityId) return;
      navigateTo(chatRoute({
        kind: "concord",
        communityId,
        channelId: channelIdHex,
        threadRoot: replyTargetOf(message),
        messageId: message.id,
      }));
      setChannelsOpen(false);
    },
    [communityId, navigateTo],
  );
  // Opening a thread from the Threads tab marks it read and drops its highlight.
  const openThreadFromList = useCallback(
    (thread: ConcordThread) => {
      markThreadRead(thread.root.id, thread.lastReplyAt);
      setFreshThreadIds((prev) => {
        if (!prev.has(thread.root.id)) return prev;
        const next = new Set(prev);
        next.delete(thread.root.id);
        return next;
      });
      if (!communityId) return;
      navigateTo(
        chatRoute({
          kind: "concord",
          communityId,
          channelId: thread.channelIdHex,
          threadRoot: thread.root.id,
        }),
      );
      setChannelsOpen(false);
    },
    [communityId, navigateTo, markThreadRead],
  );

  // A visible Mentions pane counts as reading it (newest-first list), advancing
  // the stamp as mentions land. Visibility-gated.
  useEffect(() => {
    if (view !== "mentions" || !user || !hasUnreadMention || covered) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markAllMentionsRead();
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [view, user, hasUnreadMention, markAllMentionsRead, covered]);

  // A visible Threads pane marks its threads read; `freshThreadIds` keeps rows lit
  // for the visit. Visibility-gated.
  const [freshThreadIds, setFreshThreadIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (view !== "threads") {
      setFreshThreadIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    if (!user || !hasNewThreadReplies || covered) return;
    const stamp = () => {
      if (document.visibilityState !== "visible") return;
      setFreshThreadIds((prev) => {
        let next: Set<string> | undefined;
        for (const t of threads) {
          if (t.hasNew && !prev.has(t.root.id)) (next ??= new Set(prev)).add(t.root.id);
        }
        return next ?? prev;
      });
      markAllThreadsRead();
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [view, user, hasNewThreadReplies, threads, markAllThreadsRead, covered]);

  const displayedThreads = useMemo(
    () =>
      threads.map((t) =>
        !t.hasNew && freshThreadIds.has(t.root.id) ? { ...t, hasNew: true } : t,
      ),
    [threads, freshThreadIds],
  );
  const navChannels = useMemo(
    () => channels.map((c) => ({ name: c.name, go: () => selectChannel(c.idHex) })),
    [channels, selectChannel],
  );
  const channelNav = useChannelNavValue(navChannels);

  // Before the control fold, `channels` holds only the bundle's private channels,
  // so a miss means "not known yet": stay unresolved rather than fall back (and
  // persist or canonicalize the wrong id).
  const channel = useMemo(() => {
    if (channels.length === 0) return undefined;
    if (channelIdHex) {
      const named = channels.find((c) => c.idHex === channelIdHex);
      if (named || !folded) return named;
      return channels[0];
    }
    if (!folded) return undefined;
    return pickDefaultChannel(
      channels,
      config.lastChannelByServer[lastChannelKey],
      (c) => c.idHex,
      (c) => c.name,
    );
  }, [channels, channelIdHex, folded, config.lastChannelByServer, lastChannelKey]);

  // Chat scope for in-message app affordances and the app stage (like NIP-29).
  const appScope = useMemo<AppScope | undefined>(
    () => (community && channel ? { kind: "concord", community, channel } : undefined),
    [community, channel],
  );

  // Stable route object, or every message's memo breaks.
  const permalink = useMemo<ChatRoute | undefined>(
    () => (communityId && channel ? { kind: "concord", communityId, channelId: channel.idHex } : undefined),
    [communityId, channel],
  );

  // A Mini App captured this scope at launch; rotations swap keys under the same
  // id, so hand back the live one or it seals under a retired epoch.
  const { refreshScope } = useApps();
  useEffect(() => {
    if (appScope) refreshScope(appScope);
  }, [appScope, refreshScope]);

  // Channel/community mute items each reflect only their own scope (like GroupPage).
  const channelMuted = Boolean(
    community && channel &&
    mutedChannels.has(concordChannelMuteKey("c2", community.idHex, channel.idHex)),
  );
  const communityMuted = Boolean(community && isCommunityMuted(`c2:${community.idHex}`));

  // Remember the channel only once settled: config writes re-render most of the
  // app. Leaving the community flushes the pending write.
  const channelIdToRemember = channel?.idHex;
  const pendingLastChannel = useRef<((() => void) & { key?: string }) | undefined>(undefined);
  useEffect(() => {
    if (!lastChannelKey || !channelIdToRemember) return;
    if (pendingLastChannel.current && pendingLastChannel.current.key !== lastChannelKey) {
      pendingLastChannel.current();
    }
    const write = () => {
      pendingLastChannel.current = undefined;
      updateConfig((c) =>
        c.lastChannelByServer[lastChannelKey] === channelIdToRemember
          ? c
          : { ...c, lastChannelByServer: { ...c.lastChannelByServer, [lastChannelKey]: channelIdToRemember } },
      );
    };
    pendingLastChannel.current = Object.assign(write, { key: lastChannelKey });
    const timer = setTimeout(write, LAST_CHANNEL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [channelIdToRemember, lastChannelKey, updateConfig]);
  useEffect(() => () => pendingLastChannel.current?.(), []);

  // Canonicalize `/c/<id>` to name the resolved default channel, so the URL and
  // copied links are accurate. `replace` so Back doesn't bounce. Pane routes are
  // left alone.
  useEffect(() => {
    if (!communityId || routeChannelId || routePane || !channel) return;
    navigateTo(chatRoute({ kind: "concord", communityId, channelId: channel.idHex }), {
      replace: true,
    });
  }, [communityId, routeChannelId, routePane, channel, navigateTo]);

  const { setTier, setMemberRoles } = useRoles(community);
  const { sendDirectInvite } = useInviteActions(community);
  const { rekeyChannel, canRekeyChannel } = useChannelRekey(community);
  const { pause: communityPause, setPaused, clearPause } = useCommunityPause(community);
  const pendingJoin = usePendingGuestbookJoin(baseCommunity);
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const messageMentionsEveryone = useCallback(
    (message: ChatMsg) => {
      if (!folded) return false;
      const channelIdHex = message.tags.find(([name, value]) => name === "channel" && value)?.[1];
      return Boolean(
        channelIdHex
        && isEveryoneMention(
          message.content,
          folded.roster,
          folded.ownerHex,
          message.pubkey,
          channelIdHex,
        )
      );
    },
    [folded],
  );
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const roster = folded?.roster;
  const canManageRoles = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_ROLES));
  const canManageMetadata = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_METADATA));
  const canManageChannels = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS));
  // Community pause (CORD-04 §8): everyone drops the chat wire, so the composer is
  // disabled for all; a manager resumes it.
  const communityPaused = Boolean(communityPause);
  const canCreateInvite = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.CREATE_INVITE));
  // Only owner/admins may mint a shareable link; members invite one by one.
  const iAmAdminOrOwner = Boolean(user && (iAmOwner || (roster ? badgeOf(roster, user.pubkey) === "admin" : false)));
  const canKickAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.KICK));
  const canBanAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.BAN));
  // Reading reports = holding this epoch's Control Plane secret; none on legacy epochs.
  const canReadReports = Boolean(community && reportInboxSecret(community));
  // Channel-targeted authority honors role scope.
  const canModerateMessages = Boolean(
    user && folded && channel &&
    isAuthorizedIn(folded.roster, user.pubkey, ownerHex, channel.idHex, Permissions.MANAGE_MESSAGES),
  );
  // Dissolved, `excluded` (rotated out) and `stranded` communities stay readable
  // but write-dead; folded into `canWrite` to freeze every write path. Dissolved
  // offers a local "Remove": the owner can't edit members' self-encrypted lists.
  const { data: dissolved } = useDissolved(community);
  const canWrite = Boolean(user && channel && !dissolved && !excluded && !stranded);

  // Audit log and invite links are open to every member, so "Moderation" always shows.
  const moderationAccess: ModerationAccess = useMemo(
    () => ({
      members: canManageRoles || canKickAny || canBanAny || canCreateInvite,
      roles: canManageRoles && !dissolved,
      invites: true,
      banned: canBanAny,
      reports: canReadReports,
      audit: true,
    }),
    [canManageRoles, canKickAny, canBanAny, canCreateInvite, canReadReports, dissolved],
  );

  const { transport: baseTransport, reactionsFor, allMessages, calendar, timerEntries, openedById, trustedAuthors } = useTransport(
    community,
    channel,
    canWrite,
    canModerateMessages,
    channelIdHex,
    route,
  );

  // Purge expired disappearing messages (CORD-08 §3); hygiene, reads filter anyway.
  const sweepIdHex = community?.idHex;
  useEffect(() => {
    if (sweepIdHex) void sweepExpiredCommunityRumors(sweepIdHex);
  }, [sweepIdHex]);

  // Pins (CORD-04 §7) need the ORIGINAL seal, from the opened-rumor cache.
  const pins = usePins(community, channel, openedById);
  // Via a ref so this per-row toggle keeps a stable identity.
  const pinDeps = useRef({ pins, openedById });
  pinDeps.current = { pins, openedById };
  const togglePin = useCallback(
    (event: ChatMsg) => {
      const { pins, openedById } = pinDeps.current;
      const run = async () => {
        try {
          if (pins.isPinned(event.id)) {
            await pins.unpin({ rumorId: event.id });
            return;
          }
          const opened = openedById.get(event.id);
          if (!opened) throw new Error("That message isn't loaded anymore. Scroll to it and try again.");
          await pins.pin({ opened });
          toast({ title: "Pinned" });
        } catch (e) {
          toast({ title: "Couldn't update pins", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
        }
      };
      void run();
    },
    [],
  );
  // Git activity is its own domain; this only merges display order with chat.
  const gitAttachments = useMemo(
    () => channelGitRepositoryAttachments(folded?.channels.get(channel?.idHex ?? "")?.metadata ?? { name: channel?.name ?? "", private: Boolean(channel?.isPrivate) }),
    [folded, channel?.idHex, channel?.name, channel?.isPrivate],
  );
  const gitActivity = useChannelGitActivity(channel?.idHex, gitAttachments);
  const mixedEntries = useMemo(() => mergeChannelTimeline(baseTransport.messages, gitActivity.activities, timerEntries), [baseTransport.messages, gitActivity.activities, timerEntries]);
  // Memoized: rebuilding it allocates the full timeline.
  const dividerEntries = useMemo(
    () =>
      mixedEntries.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        author: entry.type === "chat" ? entry.message.pubkey : entry.type === "dm-timer" ? entry.author : entry.type === "git-ticket-opened" ? entry.activity.ticket.author : entry.type === "git-comment" ? entry.activity.comment.author : entry.type === "git-ci-run" ? entry.activity.run.author : entry.activity.status.author,
      })),
    [mixedEntries],
  );
  const newDividerId = useNewMessagesDivider(channel?.idHex ?? "", dividerEntries, user?.pubkey);
  const openProjectItem = useCallback((item: ProjectWorkItem) => {
    const ticket = projects.ticketsById.get(item.id);
    if (!ticket) return;
    closeThreadRef.current();
    setOpenTicket(ticket);
    void projects.refreshTicket(ticket);
  }, [projects]);
  // Stable identity (depends on `refreshTicket`, not the rebuilt result object).
  const refreshChannelTicket = gitActivity.refreshTicket;
  const openChannelTicket = useCallback((ticket: GitTicket) => {
    closeThreadRef.current();
    setOpenTicket(ticket);
    void refreshChannelTicket(ticket);
  }, [refreshChannelTicket]);
  // Merge channel activity with the Projects history so a ticket reads complete.
  const panelActivities = useMemo(
    () => projects.activities.length === 0
      ? gitActivity.activities
      : sortAndDedupeGitTimelineActivities([...gitActivity.activities, ...projects.activities]),
    [gitActivity.activities, projects.activities],
  );
  const gitActions = useGitWorkItemActions();
  // No first-tag fallback: `a` tag order is author-controlled, so guessing could
  // grant a fork owner status controls. Controls appear once projects data lands.
  const ticketRepository = useCallback((ticket: GitTicket): GitWorkItemRepository | undefined => {
    const held = new Set(projects.repos.map((repo) => repo.coord));
    const address = matchGitTicketRepository(ticket, held);
    if (!address) return undefined;
    const repo = projects.repos.find((candidate) => candidate.coord === address.coordinate);
    return { address, maintainers: repo?.contributors ?? [] };
  }, [projects.repos]);
  const canSetTicketStatus = useMemo(() => {
    if (!user?.pubkey || !openTicket) return false;
    const repository = ticketRepository(openTicket);
    if (!repository) return false;
    return trustedGitStatusAuthors(
      openTicket,
      { owner: repository.address.owner, maintainers: [...repository.maintainers] },
    ).has(user.pubkey);
  }, [user?.pubkey, openTicket, ticketRepository]);
  const ticketActions = useMemo(() => ({
    viewerPubkey: user?.pubkey,
    onComment: user
      ? async (ticket: GitTicket, content: string, tags?: readonly string[][]) => {
          await gitActions.commentOnTicket(ticket, content, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)), tags);
        }
      : undefined,
    onEditComment: user
      ? async (ticket: GitTicket, comment: GitComment, content: string) => {
          await gitActions.editTicketComment(ticket, comment, content, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)));
        }
      : undefined,
    onDeleteComment: user
      ? async (ticket: GitTicket, comment: GitComment) => {
          await gitActions.deleteTicketComment(ticket, comment, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)));
        }
      : undefined,
    onSetStatus: async (ticket: GitTicket, statusKind: GitStatusKind) => {
      const repository = ticketRepository(ticket);
      if (!repository) return;
      await gitActions.setTicketStatus(ticket, repository, statusKind, projects.relaysForCoordinates([repository.address.coordinate]));
    },
    canSetStatus: canSetTicketStatus,
  }), [user, gitActions, projects, ticketRepository, canSetTicketStatus]);
  const handleCreateIssue = useCallback(async (repoCoord: string, subject: string, body: string, media?: readonly string[][], labels?: readonly string[]) => {
    const address = parseGitRepositoryAddress(repoCoord);
    if (!address) throw new Error("Unknown repository.");
    const repo = projects.repos.find((candidate) => candidate.coord === repoCoord);
    await gitActions.openIssue({ address, maintainers: repo?.contributors ?? [] }, subject, body, projects.relaysForCoordinates([repoCoord]), media, labels);
  }, [gitActions, projects]);
  const { mutateAsync: send } = useSendMessage(community, channel);

  // Mark the open channel read while on screen (and on refocus), also advancing
  // mentions/threads stamps for what it shows. The stamp is the MAX of the newest
  // rendered row and the badge's `latest`: the render fold drops rows the badge
  // counts (mod deletes, banned, expired), and markRead is monotonic, so the
  // rendered row alone could leave the channel unread forever.
  const channelIdForRead = channel?.idHex;
  const readerPubkey = user?.pubkey;
  // Read in stamp() rather than as a dep, so read-state changes don't re-register the listener.
  const unreadByChannelRef = useRef(unreadByChannel);
  unreadByChannelRef.current = unreadByChannel;
  useEffect(() => {
    if (!readerPubkey || !channelIdForRead || covered) return;
    // Newest rendered row; may be 0 (badge `latest` still clears it; markChannelRead ignores <= 0).
    const latest = mixedEntries[mixedEntries.length - 1]?.createdAt ?? 0;

    // Newest visible mention of the user and newest reply per participated thread.
    let newestMention = 0;
    const followedRoots = new Set(threads.map((t) => t.root.id));
    const replyStamps = new Map<string, number>();
    for (const m of allMessages) {
      if (
        m.pubkey !== readerPubkey &&
        m.created_at > newestMention &&
        m.tags.some(([n, v]) => n === "p" && v === readerPubkey)
      ) {
        newestMention = m.created_at;
      }
      const root = replyTargetOf(m);
      if (root && followedRoots.has(root) && m.created_at > (replyStamps.get(root) ?? 0)) {
        replyStamps.set(root, m.created_at);
      }
    }

    const stamp = () => {
      if (document.visibilityState !== "visible") return;
      const badgeLatest = unreadByChannelRef.current[channelIdForRead]?.latest ?? 0;
      markChannelRead(channelIdForRead, Math.max(latest, badgeLatest));
      if (newestMention > 0) markMentionsRead(newestMention);
      for (const [root, ts] of replyStamps) markThreadRead(root, ts);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [readerPubkey, channelIdForRead, mixedEntries, allMessages, threads, markChannelRead, markMentionsRead, markThreadRead, covered]);

  const { leave, isLeaving, dissolve, createChannel, privatiseChannel, mintAccessRole, setChannelCategory, arrangeChannels } =
    useCommunityManagement(community);
  const retireLinks = useRetireCommunityLinks(community);
  /** Dissolve toast Retry: runs the retirement's own `retry` with what missed. */
  const showRetirementMiss = (outcome: RetirementOutcome) => {
    const retry = outcome.retry;
    if (!retry) return;
    toast(dissolveMissToast(outcome, () => {
      void retry().then(
        (next) => (next.retry ? showRetirementMiss(next) : toast({ title: "Invite links and listings taken down" })),
        () => showRetirementMiss(outcome),
      );
    }));
  };

  /** File one channel from the sidebar context menu (same edition as settings). */
  const fileChannel = useCallback(
    async (channelIdHex: string, category: string | undefined) => {
      try {
        await setChannelCategory({ channelIdHex, category });
      } catch (e) {
        toast({
          title: "Couldn't move the channel",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
      }
    },
    [setChannelCategory],
  );

  /** The column the drag pans by hand on touch (rows are `touch-action: none`). */
  const channelScrollRef = useRef<HTMLElement | null>(null);

  /** Measure drop points at pickup: each row's top and bottom edge; nearest-y wins. */
  const measureDropSlots = useCallback((): ChannelDropSlot[] => {
    const root = channelScrollRef.current;
    if (!root) return [];
    const out: ChannelDropSlot[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-ch-slot]")) {
      const index = Number(el.dataset.chIndex);
      if (!Number.isInteger(index)) continue;
      const category = el.dataset.chCategory || undefined;
      const rect = el.getBoundingClientRect();
      out.push({ index, category, y: rect.top });
      out.push({ index: index + 1, category, y: rect.bottom });
    }
    // Present only mid-drag (hence re-measured after the chrome mounts); index = row count.
    const zone = root.querySelector<HTMLElement>("[data-ch-newzone]");
    if (zone) {
      const rect = zone.getBoundingClientRect();
      out.push({
        index: out.length / 2,
        category: undefined,
        y: rect.top + rect.height / 2,
        newCategory: true,
      });
    }
    return out;
  }, []);

  const commitDrop = useCallback(
    (sourceIdHex: string, drop: ChannelDrop) => {
      const source = renderedChannels.find((c) => c.idHex === sourceIdHex);
      if (!source) return;
      // A new category needs a name: the drop opens the naming prompt.
      if (drop.newCategory) {
        setCategoryPrompt({ channels: [source], initial: "" });
        return;
      }
      const before = renderedChannels.map((c) => ({
        idHex: c.idHex,
        position: c.position,
        category: c.category,
      }));
      const plan = planChannelDrop(before, sourceIdHex, drop.index, drop.category);
      const changes = arrangementChanges(before, plan);
      if (changes.length === 0) return;
      // Show the whole planned arrangement (what the sidebar will read once landed).
      setPendingArrangement(pendingFromPlan(plan));
      void arrangeChannels(changes).catch((e: unknown) => {
        // Nothing published: restore the sidebar.
        setPendingArrangement(null);
        toast({
          title: "Couldn't rearrange the channels",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
      });
    },
    [renderedChannels, arrangeChannels],
  );

  const channelDrag = useChannelDrag({
    enabled: canManageChannels,
    columnRef: channelScrollRef,
    measure: measureDropSlots,
    onDrop: commitDrop,
  });

  /** What the floating ghost carries. */
  const draggedChannel = channelDrag.sourceIdHex
    ? (renderedChannels.find((c) => c.idHex === channelDrag.sourceIdHex) ?? null)
    : null;

  /**
   * Re-file every channel in a category (rename / ungroup). Sequential so a
   * rate-limited relay doesn't drop some; each is its own entity, so partial
   * failure is safe. Renaming onto an existing name merges.
   */
  const refileCategory = useCallback(
    async (members: readonly Channel[], category: string | undefined) => {
      let moved = 0;
      try {
        for (const member of members) {
          await setChannelCategory({ channelIdHex: member.idHex, category });
          moved += 1;
        }
      } catch (e) {
        toast({
          title: moved > 0 ? `Only moved ${moved} of ${members.length} channels` : "Couldn't move the channels",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
      }
    },
    [setChannelCategory],
  );
  const handleCreateRepositoryChannel = useCallback(async (name: string, repository: WizardRepository) => {
    const { channelIdHex: created } = await createChannel({
      name,
      repository: { address: repository.coordinate, relayHints: repository.relayHints },
    });
    selectChannel(created);
  }, [createChannel, selectChannel]);
  const connectedCoordinates = useMemo(
    () => new Set([...gitAttachmentsByChannel.values()].flatMap((list) => list.filter((a) => a.detachedAt === undefined).map((a) => a.address.coordinate))),
    [gitAttachmentsByChannel],
  );
  const { coalesced } = useGuestbook(community);

  // Voice (CORD-07): broker from config; channel rows subscribe to presence themselves.
  const { joinConcordCall, activeCall } = useCall();
  const { speakingPubkeys, mutedPubkeys } = useVoiceActivity();
  // Community brokers (CORD-02 §6) from the fold already held.
  const avBrokers = useMemo(() => communityAvBrokers(folded?.metadata), [folded?.metadata]);
  const { data: activeBroker } = useVoiceBroker(channel, avBrokers);
  const inThisVoice = Boolean(
    activeCall?.concord && channel && activeCall.concord.channel.idHex === channel.idHex,
  );

  const handleJoinVoice = useCallback(
    async (ch: Channel, broker: string | null) => {
      if (!community || !user) return;
      if (activeCall?.concord?.channel.idHex === ch.idHex) return; // already there
      let resolved = broker;
      if (!resolved) {
        // Broker may be loading or a cached `null`; re-run the rendezvous live.
        const roomHex = ch.voice.room.pk;
        resolved = roomHex ? await resolveVoiceBroker(roomHex, avBrokers) : null;
      }
      if (!resolved) {
        toast({
          title: "Voice unavailable",
          description: avBrokers.length > 0
            ? "None of this community's voice servers answered. Your own server isn't used here, because a community that sets voice servers uses only those."
            : "No reachable voice server. Add one to this community under Settings → Network, or set your own under Settings → Voice.",
          variant: "destructive",
        });
        return;
      }
      // Members on another broker are reported by the room (it knows the real origin).
      joinConcordCall({ community, channel: ch, broker: resolved });
    },
    [community, user, activeCall, joinConcordCall, avBrokers],
  );

  // Compliant self-removal (CORD-04 §4/§6): tear down locally and route home.
  useSelfRemove(baseCommunity, useCallback(() => navigateTo("/"), [navigateTo]));
  const [creatingChannel, setCreatingChannel] = useState(false);

  // Close the create-channel wizard on community switch (permissions differ).
  useEffect(() => {
    setCreatingChannel(false);
    setCommunityMenuOpen(false);
  }, [communityId]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [shareDiscoverOpen, setShareDiscoverOpen] = useState(false);
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [kickTarget, setKickTarget] = useState<string | null>(null);
  // Stable single-element arrays: a fresh `[target]` retriggers the dialog's
  // reset effect mid-mutation.
  const kickTargets = useMemo(() => (kickTarget ? [kickTarget] : null), [kickTarget]);
  const banTargets = useMemo(() => (banTarget ? [banTarget] : null), [banTarget]);
  const [rotateKeysOpen, setRotateKeysOpen] = useState(false);
  /** Pending "name a category" prompt: create (file one channel) or rename (re-file all). */
  const [categoryPrompt, setCategoryPrompt] = useState<
    { channels: Channel[]; initial: string } | null
  >(null);
  // Community-name header menu, expanding inline below the header.
  const [communityMenuOpen, setCommunityMenuOpen] = useState(false);
  /** Member roster pane (`memberListVisible`); defaults off on touch devices, remembered once toggled. */
  const membersVisible = config.memberListVisible ?? !isTouchDevice;
  const toggleMembersVisible = () =>
    updateConfig((c) => ({ ...c, memberListVisible: !(c.memberListVisible ?? !isTouchDevice) }));
  // Header search: community-wide results replace the timeline while active.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  // Mobile: the community root shows the channel list; a deep link opens chat.
  const [channelsOpen, setChannelsOpen] = useState(!routeChannelId);
  // The page is reused across communities, so reset the reveal during render (an
  // effect would flash the previous chat). Keyed on the COMMUNITY only: the root
  // redirect to a channel would otherwise re-close the list.
  const [navKey, setNavKey] = useState(communityId);
  if (navKey !== communityId) {
    setNavKey(communityId);
    setChannelsOpen(!routeChannelId);
  }
  // A permalink must show the chat pane, even within the already-open community.
  // Keyed per NAVIGATION (like `useMessagePermalink`), so tapping one notification
  // twice lands twice; the mount seeds rather than fires.
  const [focusNavKey, setFocusNavKey] = useState(location.key);
  if (focusNavKey !== location.key) {
    setFocusNavKey(location.key);
    if (route?.messageId) setChannelsOpen(false);
  }
  // The open channel's route (thread panel, message links, legacy query redirects).
  const channelRoute = useMemo(
    () =>
      communityId && channel
        ? ({ kind: "concord", communityId, channelId: channel.idHex } as const)
        : undefined,
    [communityId, channel],
  );
  const {
    threadRoot,
    lastThreadRoot,
    expanded: threadExpanded,
    setExpanded: setThreadExpanded,
    autoFocus: threadAutoFocus,
    chatColumnClass,
    openThread,
    onOpenThread: onOpenThreadCb,
    closeThread,
  } = useThreadPanel({ room: channelRoute, messages: allMessages, canWrite });
  closeThreadRef.current = closeThread;
  const [ticketThreadKey, setTicketThreadKey] = useState(threadRoot?.id);
  if (ticketThreadKey !== threadRoot?.id) {
    setTicketThreadKey(threadRoot?.id);
    if (threadRoot) setOpenTicket(undefined);
  }

  // Search survives channel switches, resets on community change.
  const [searchCommunityKey, setSearchCommunityKey] = useState(communityId);
  if (searchCommunityKey !== communityId) {
    setSearchCommunityKey(communityId);
    setSearchOpen(false);
    setSearchFilters(EMPTY_SEARCH_FILTERS);
  }
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);

  // Tell the native notification service what's on screen. roomKey shapes must
  // match the service: `c2:<channelIdHex>` and `c2:<channelIdHex>:t:<rootId>`.
  useActiveRoom(
    channel?.idHex ? `c2:${channel.idHex}` : undefined,
    channel?.idHex && threadRoot ? `c2:${channel.idHex}:t:${threadRoot.id}` : undefined,
  );

  // Member list: Guestbook ∪ observed authors ∪ roster, minus banned (CORD-02 §5).
  // Admin/Mod badges follow only the STOCK roles, never permission-bit inference.
  const memberAdmins = useMemo(() => {
    const out: Array<{ pubkey: string; roles: string[] }> = [];
    if (ownerHex) out.push({ pubkey: ownerHex, roles: ["owner"] });
    if (roster) {
      const stockAdmin = roster.roles.find((r) => r.name === "Admin" && r.scope.kind === "server")?.roleId;
      const stockModerator = roster.roles.find((r) => r.name === "Moderator" && r.scope.kind === "server")?.roleId;
      for (const g of roster.grants) {
        if (g.member === ownerHex) continue;
        const badge = stockAdmin && g.roleIds.includes(stockAdmin)
          ? "admin"
          : stockModerator && g.roleIds.includes(stockModerator)
            ? "moderator"
            : undefined;
        if (badge) out.push({ pubkey: g.member, roles: [badge] });
      }
    }
    return out;
  }, [roster, ownerHex]);

  // Per-member Roles picker in CORD-04 §3 order, each flagged by whether the viewer
  // outranks it (so un-assignable roles render disabled).
  const roleCatalog = useMemo(() => {
    if (!roster || !user) return undefined;
    return [...roster.roles]
      .sort(byDisplayOrder)
      .map((r): RolePickerOption => {
        const scoped = r.scope.kind === "channel" ? folded?.channels.get(r.scope.channelId) : undefined;
        return {
          id: r.roleId,
          name: r.name,
          color: r.color,
          // A deleted/unknown channel: keep the role listed, without a hint.
          channelName: r.scope.kind === "channel" ? (scoped && !scoped.deleted ? scoped.name : null) : undefined,
          assignable: canActOnPosition(roster, user.pubkey, ownerHex, r.position, Permissions.MANAGE_ROLES),
        };
      });
  }, [roster, user, ownerHex, folded]);

  // Per channel, its scoped Roles — the access list (CORD-04 §2).
  const channelRoleCatalog = useMemo(() => {
    const out = new Map<string, Array<{ id: string; name: string }>>();
    for (const r of roster?.roles ?? []) {
      if (r.scope.kind !== "channel") continue;
      const at = out.get(r.scope.channelId) ?? [];
      at.push({ id: r.roleId, name: r.name });
      out.set(r.scope.channelId, at);
    }
    return out;
  }, [roster]);

  const memberRoleIds = useMemo(
    () => Object.fromEntries((roster?.grants ?? []).map((g) => [g.member, g.roleIds])),
    [roster],
  );
  const roleIntent = useRoleIntent(memberRoleIds, setMemberRoles);
  const { rolesFor: intendedRolesFor, isPending: isRoleTogglePending } = roleIntent;

  const memberRolesValue = useMemo<MemberRolesValue>(() => {
    const byId = new Map((roster?.roles ?? []).map((r) => [r.roleId, r]));
    const cache = new Map<string, Array<{ id: string; name: string; color: number }>>();
    return {
      rolesOf: (pubkey: string) => {
        const cached = cache.get(pubkey);
        if (cached) return cached;
        const held = (roster?.grants ?? []).find((g) => g.member === pubkey)?.roleIds ?? [];
        const out = held
          .map((id) => byId.get(id))
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .sort(byDisplayOrder)
          .map((r) => ({ id: r.roleId, name: r.name, color: r.color }));
        cache.set(pubkey, out);
        return out;
      },
    };
  }, [roster]);

  const canEditMemberRoles = useCallback(
    (pubkey: string) => {
      if (!roster || !user) return false;
      // The owner may self-grant roles cosmetically; nobody else may target the owner.
      if (user.pubkey === ownerHex && pubkey === ownerHex) return true;
      return canActOnMember(roster, user.pubkey, ownerHex, pubkey, Permissions.MANAGE_ROLES);
    },
    [roster, user, ownerHex],
  );

  // EVERY live Private Channel, flagged by whether I hold its key: a revoke must see
  // channels I lack too, or it reports success while the target keeps reading
  // (`channelsHingingOn` splits the two).
  const privateChannelsHere = useMemo(() => {
    if (!community || !folded) return [] as Array<{ idHex: string; heldByMe: boolean }>;
    const heldIds = new Set(community.privateChannels.map((ch) => bytesToHex(ch.id)));
    const out: Array<{ idHex: string; heldByMe: boolean }> = [];
    for (const [idHex, def] of folded.channels) {
      if (def.deleted || !def.isPrivate) continue;
      out.push({ idHex, heldByMe: heldIds.has(idHex) });
    }
    return out;
  }, [community, folded]);

  const memberPubkeys = useMemo(() => {
    const banned = folded?.banned ?? new Set<string>();
    // Observed authors: newest ms each pubkey published (seconds scaled to ms to
    // match Guestbook kick/leave times), so stale chat doesn't resurrect a kicked member.
    const observed = new Map<string, number>();
    for (const m of allMessages) {
      const seenMs = m.created_at * 1000;
      const prev = observed.get(m.pubkey);
      if (prev === undefined || seenMs > prev) observed.set(m.pubkey, seenMs);
    }
    const set = completeMemberlist(coalesced, observed, banned, folded?.bannedAt);
    for (const g of roster?.grants ?? []) if (g.roleIds.length > 0 && !banned.has(g.member)) set.add(g.member);
    if (ownerHex) set.add(ownerHex);
    if (user && !banned.has(user.pubkey)) set.add(user.pubkey);
    return [...set];
  }, [coalesced, allMessages, roster, ownerHex, user, folded]);

  // One Set identity per member-list change, shared by memoized git rows and the ticket panel.
  const memberSet = useMemo(() => new Set(memberPubkeys), [memberPubkeys]);

  // Hoisted role sections (Role.display): position order, filed under the highest
  // hoisted role only (owner included).
  const roleSections = useMemo(() => {
    if (!roster) return undefined;
    const memberSet = new Set(memberPubkeys);
    const hoisted = roster.roles
      .filter((r) => r.display)
      .sort(byDisplayOrder);
    if (hoisted.length === 0) return undefined;
    const placed = new Set<string>();
    const sections = hoisted.map((role) => {
      const holders = roster.grants
        .filter((g) => g.roleIds.includes(role.roleId) && memberSet.has(g.member) && !placed.has(g.member))
        .map((g) => g.member)
        .sort();
      for (const m of holders) placed.add(m);
      return { id: role.roleId, name: role.name, color: role.color, members: holders };
    });
    return sections.filter((s) => s.members.length > 0);
  }, [roster, memberPubkeys]);

  // A private channel's member panel lists only those entitled to its key (CORD-03).
  const { panelChannel, entitledHere, addableChannelRoles, addMemberCandidates } = useMemberPanelScope({
    view,
    channel,
    roster,
    ownerHex,
    memberPubkeys,
    channelRoleCatalog,
    roleCatalog,
  });
  const panelMembers = useMemo(() => memberPubkeys.filter(entitledHere), [memberPubkeys, entitledHere]);
  const panelAdmins = useMemo(() => memberAdmins.filter((a) => entitledHere(a.pubkey)), [memberAdmins, entitledHere]);
  const panelSections = useMemo(
    () => roleSections?.map((s) => ({ ...s, members: s.members.filter(entitledHere) })).filter((s) => s.members.length > 0),
    [roleSections, entitledHere],
  );

  useEffect(() => setAddMembersOpen(false), [panelChannel?.idHex]);
  // The mobile member overlay closes on room/community switch, list reveal, or back.
  const [membersOpen, setMembersOpen] = useMobileMembersOverlay(
    `${communityId ?? ""}|${channel?.idHex ?? ""}`,
    channelsOpen,
  );

  const handleCreateTextChannel = useCallback(async (name: string, opts?: NewTextChannelOptions) => {
    const { channelIdHex: created } = await createChannel({
      name,
      isPrivate: opts?.isPrivate,
      accessRoleName: opts?.accessRoleName,
      view: opts?.view,
    });
    // A newborn Private Channel's Role is held by nobody; access is granted via the
    // Role (see handleToggleRole).
    selectChannel(created);
  }, [createChannel, selectChannel]);

  /**
   * Re-key a private channel to exactly the members entitled TODAY — repairs
   * custody drift (keys held after revocation, suspected leaks).
   */
  const handleRotateChannelKey = useCallback(async (channelIdHex: string) => {
    if (!roster) throw new Error("Not ready.");
    const keep = memberPubkeys.filter((pk) => isEntitled(roster, ownerHex, pk, channelIdHex));
    const keepSet = new Set(keep);
    await rekeyChannel({
      channelIdHex,
      keepRecipients: keep,
      removedTargets: memberPubkeys.filter((pk) => !keepSet.has(pk)),
    });
  }, [roster, memberPubkeys, ownerHex, rekeyChannel]);

  /**
   * Convert a public channel to private (CORD-03 §2): own key plus a scoped Role
   * (name defaults to the channel's).
   */
  const handlePrivatiseChannel = useCallback(async (channelIdHex: string, accessRoleName?: string) => {
    const def = folded?.channels.get(channelIdHex);
    if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
    const roleName = accessRoleName?.trim() || def.name;
    // The conversion can't cover past messages, so say so.
    const ok = confirm(
      `Make #${def.name} private?\n\n` +
      `It gets its own key from here on, and the "${roleName}" role decides who may read it. Nobody holds that role yet, so grant it to the members who should have access. ` +
      "Messages already posted stay readable to everyone in the community; a restriction can't be applied backwards.",
    );
    if (!ok) return;
    await privatiseChannel({ channelIdHex, accessRoleName: roleName });
    toast({
      title: "Channel is now private",
      description: `Grant the "${roleName}" role to give members access.`,
    });
  }, [folded, privatiseChannel]);

  /**
   * Mint another access Role for a private channel. Entitlement is any-of, so this
   * widens who CAN be let in; it vends on its first grant.
   */
  const handleMintAccessRole = useCallback(async (channelIdHex: string, name: string) => {
    await mintAccessRole({ channelIdHex, name });
    toast({ title: "Access role created", description: `Grant "${name.trim()}" to give members access.` });
  }, [mintAccessRole]);


  // By-id lookup over the decoded set, for resolving inline-reply parents locally.
  const messagesById = useMemo(() => {
    const m = new Map<string, ChatMsg>();
    for (const msg of allMessages) m.set(msg.id, msg);
    return m;
  }, [allMessages]);
  // Parents older than the loaded window come from the store.
  const olderReplyParents = useConcordReplyParents(community, channel?.idHex, allMessages, messagesById);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchFilters(EMPTY_SEARCH_FILTERS);
  }, []);
  const jumpFromSearch = useCallback(
    (channelIdHex: string, message: ChatMsg) => {
      closeSearch();
      jumpToMention(channelIdHex, message);
    },
    [closeSearch, jumpToMention],
  );
  const allChannelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  // Community-wide search over the local rumor store; only fed while the bar is open.
  const {
    results: searchResults,
    isLoading: searchLoading,
    active: searching,
  } = useConcordSearch(
    community,
    allChannelIds,
    searchOpen ? searchFilters : EMPTY_SEARCH_FILTERS,
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const ticketParam = searchParams.get("ticket");
  // Git notification deep links: wait for the activity query, focus the panel, consume the param.
  useEffect(() => {
    if (!ticketParam || openTicket) return;
    const activity = gitActivity.activities.find((item) => item.type !== "ci-run" && item.ticket.id === ticketParam);
    if (!activity || activity.type === "ci-run") return;
    setOpenTicket(activity.ticket);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("ticket");
      return next;
    }, { replace: true });
  }, [ticketParam, openTicket, gitActivity.activities, setSearchParams]);
  // Legacy `?thread=` / `?m=` links become route equivalents.
  useLegacyFocusParams(channelRoute);

  const transport = useMemo(() => ({
    ...baseTransport,
    // MessageTimeline owns scroll restoration around this promise, so chat and Git
    // can't fight over the anchor. `isLoading` is NOT merged: it gates the chat
    // skeleton, and a slow Git query shouldn't hide cached chat.
    hasMore: Boolean(baseTransport.hasMore || gitActivity.hasMore),
    isLoadingOlder: Boolean(baseTransport.isLoadingOlder || gitActivity.isLoadingOlder),
    loadOlder: async () => {
      const [chatAdded, gitAdded] = await Promise.all([baseTransport.loadOlder?.() ?? Promise.resolve(0), gitActivity.loadOlder()]);
      return chatAdded + gitAdded;
    },
    openThread,
    isPinned: pins.canPin ? pins.isPinned : undefined,
    togglePin: pins.canPin ? togglePin : undefined,
  }), [baseTransport, gitActivity, openThread, pins.canPin, pins.isPinned, togglePin]);
  // Concord passes `messages: []` to ChatComposer, so it supplies the bot `user` picker itself.
  const recentAuthors = useMemo(() => authorsByRecency(transport.messages), [transport.messages]);

  // Forum presentation (CORD-03 §2 `view: "forum"`): a feed of titled posts, with
  // the plain timeline as a per-channel local alternate (untitled messages live
  // there). Same folded timeline, so flipping never refetches.
  const [forumAsChat, setForumAsChat] = useLocalStorage<string[]>("armada:concord-forum-as-chat", []);
  const forumOpensAsChat = Boolean(channel && forumAsChat.includes(channel.idHex));
  const presentation: "feed" | "chat" = channel?.view === "forum" && !forumOpensAsChat ? "feed" : "chat";
  const toggleForumPresentation = useCallback(() => {
    if (!channel) return;
    const id = channel.idHex;
    setForumAsChat((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, [channel, setForumAsChat]);

  const {
    timelineRef,
    jumpToMessage: jumpWithinChannel,
    clearMessageFocus,
    activeId,
    toggleActive,
  } = useTimelineFocus({
    // Thread replies belong to ThreadPanel's own permalink.
    messages: baseTransport.messages,
    isLoading: Boolean(baseTransport.isLoading),
    hasMore: transport.hasMore,
    loadOlder: transport.loadOlder,
    // Search results and the forum feed replace the timeline, so neither can
    // consume a focus arrival (titled-post links are handled below).
    enabled: view === "channel" && !searching && presentation !== "feed",
  });
  // `/m/<id>` into a forum: if it's a loaded titled post, open it as a page
  // (replacing the location); untitled messages keep the segment for the chat view.
  const routedMessageId = route?.threadRoot ? undefined : route?.messageId;
  useEffect(() => {
    if (presentation !== "feed" || !routedMessageId || !channelRoute) return;
    const root = baseTransport.messages.find((m) => m.id === routedMessageId);
    if (!root || !isTitledPost(root)) return;
    navigateTo(chatRoute({ ...channelRoute, threadRoot: root.id }), { replace: true });
  }, [presentation, routedMessageId, channelRoute, baseTransport.messages, navigateTo]);

  // `channelSyncing`: the on-screen channel's sync topic is pending or a task is
  // scoped to it, so an empty read never shows "No messages yet" mid-catch-up.
  const syncTasks = useSyncTasks();
  const channelScope = channel ? `c2:${channel.idHex}` : undefined;
  const channelTopic = useSyncTopicState(channelScope);
  const channelSyncing = Boolean(
    channelScope &&
      (channelTopic.status === "pending" || syncTasks.some((t) => t.scope === channelScope)),
  );
  // The serial gate (list → control sweep → fold) as "syncing" on a cold load, so
  // the pane isn't blank before a Channel exists. Scoped so a missing community
  // still reaches not-found.
  const { data: listData, isLoading: communityListLoading } = useCommunityList();
  const gateResolving = Boolean(
    !channel && communityId && (communityListLoading || (baseCommunity && !folded)),
  );
  // No live vault entry for this community: render `CommunityNoAccess`. Only once
  // the list has truly resolved — an unread or undecryptable list (slow nip44
  // signer) must not lock a member out.
  const membershipResolved = Boolean(listData && !listData.decryptFailed && !communityListLoading);
  const noAccess = Boolean(communityId && !baseCommunity && membershipResolved);
  // A catch-up stuck retrying (error/pending cycle) latches until a round settles
  // or the channel changes.
  const [channelSyncFailed, setChannelSyncFailed] = useState(false);
  useEffect(() => setChannelSyncFailed(false), [channelScope]);
  useEffect(() => {
    if (channelTopic.status === "error") setChannelSyncFailed(true);
    else if (channelTopic.status === "settled") setChannelSyncFailed(false);
  }, [channelTopic.status]);

  // Stable identities for memoized rows; `transport` is reached via a ref.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  // Refuse sends while paused for non-staff (CORD-04 §8). Reads the ref for a stable identity.
  const composerCanSend = useCallback((): string | null => {
    if (communityPaused) return "This community is paused. A moderator must resume it before anyone can post.";
    return transportRef.current.canSend?.() ?? null;
  }, [communityPaused]);

  const [forumSort, setForumSort] = useLocalStorage<ForumSort>("armada:concord-forum-sort", "active");
  const [newPostOpen, setNewPostOpen] = useState(false);
  useEffect(() => setNewPostOpen(false), [channel?.idHex]);
  // Titled roots of the loaded window, pinned first, then `forumSort`. Uses
  // `pins.isPinned` directly: everyone sees pins.
  const { messages: topLevelMessages, threadRepliesFor } = baseTransport;
  const feedPosts = useMemo<ForumPost[]>(
    () =>
      presentation !== "feed"
        ? NO_POSTS
        : forumPosts(
            topLevelMessages,
            (id) => threadRepliesFor?.(id) ?? EMPTY_REPLIES,
            { sort: forumSort, isPinned: pins.isPinned },
          ),
    [presentation, topLevelMessages, threadRepliesFor, forumSort, pins.isPinned],
  );
  // "New" per post uses the Threads tab's stamp (`c2t:<rootId>`), never for own words.
  const { readState } = useReadState();
  const isPostNew = useCallback(
    (post: ForumPost) =>
      post.lastActivityBy !== user?.pubkey &&
      post.lastActivityAt > (readState[concordThreadReadKey(post.root.id)] ?? 0),
    [readState, user?.pubkey],
  );
  const openPost = useCallback(
    (post: ForumPost) => {
      // Opening consumes the activity; the thread panel keeps advancing it.
      markThreadRead(post.root.id, post.lastActivityAt);
      openThread(post.root);
    },
    [markThreadRead, openThread],
  );
  const handleCreatePost = useCallback(
    async (title: string, content: string, tags: string[][]) => {
      // One kind-9 with the title as `subject`, plus the composer's tags (same drops as handleSend).
      const extraTags = tags.filter(([name]) => name !== "h" && name !== "e" && name !== "q");
      await send({ content, extraTags: [...subjectTags(title), ...extraTags] });
      setNewPostOpen(false);
      clearMessageFocus();
    },
    [send, clearMessageFocus],
  );
  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: (original, content) => transport.editMessage?.(original, content),
    messages: transport.messages,
    isPending: (id) => transport.sendStatusFor?.(id) !== undefined,
    self: user?.pubkey,
  });

  // Keep the open thread's read stamp advancing as replies land. Visibility-gated.
  const threadRootId = threadRoot?.id;
  useEffect(() => {
    if (!user || !threadRootId || covered) return;
    const replies = transport.threadRepliesFor?.(threadRootId) ?? EMPTY_REPLIES;
    const latest = replies.length > 0 ? replies[replies.length - 1].created_at : threadRoot?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState !== "visible") return;
      markThreadRead(threadRootId, latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, threadRootId, threadRoot?.created_at, transport, markThreadRead, covered]);

  const moderation = useModeration(community, memberPubkeys);

  // Stable member-panel callbacks for memoized MemberRows, delegating through a
  // ref written each render (never invoked on a guard-returned render).
  const memberOpsRef = useRef<{
    setRole: (pk: string, roles: string[]) => Promise<void>;
    toggleRole: (pk: string, roleId: string, on: boolean) => Promise<void>;
    kick: (pk: string) => void;
    unban: (pk: string) => void;
  } | null>(null);
  const handleSetRoleStable = useCallback((pk: string, roles: string[]) => memberOpsRef.current?.setRole(pk, roles), []);
  const handleToggleRoleStable = useCallback(
    (pk: string, roleId: string, on: boolean) => memberOpsRef.current?.toggleRole(pk, roleId, on),
    [],
  );
  const handleUnbanMember = useCallback((pk: string) => memberOpsRef.current?.unban(pk), []);
  const openAddMembers = useCallback(() => setAddMembersOpen(true), []);
  const closeMembers = useCallback(() => setMembersOpen(false), [setMembersOpen]);

  // Moderate a person from wherever they were clicked, gated like the message menu.
  // Every chat row consumes this, so it depends only on identity-stable inputs (not
  // `moderation`, a fresh object per render) and hands back one array per pubkey.
  const bannedHere = moderation.banned;
  const canRekeyHere = moderation.canRekey;
  const memberActionsValue = useMemo<MemberActionsValue>(() => {
    const actionsCache = new Map<string, MemberActionItem[]>();
    const pickerCache = new Map<string, MemberRolePicker | undefined>();
    const buildActions = (pubkey: string): MemberActionItem[] => {
      if (!user || pubkey === user.pubkey) return NO_MEMBER_ACTIONS;
      const out: MemberActionItem[] = [];
      // Tier moves first: the card is where anyone clicked lands, poster or not.
      if (canManageRoles && roster) {
        const current = stockTierOf(roster, pubkey);
        for (const tier of tierMoves(roster, user.pubkey, ownerHex, pubkey)) {
          out.push(
            tier === "admin"
              ? {
                id: "make-admin",
                label: "Make admin",
                icon: Crown,
                confirm: tierChangeConfirm("concord", "admin"),
                onSelect: () => void handleSetRoleStable(pubkey, ["admin"]),
              }
              : tier === "moderator"
                ? {
                  id: "make-moderator",
                  label: current === "admin" ? "Demote to moderator" : "Make moderator",
                  icon: Shield,
                  confirm: tierChangeConfirm("concord", current === "admin" ? "demote" : "moderator"),
                  onSelect: () => void handleSetRoleStable(pubkey, ["moderator"]),
                }
                : {
                  id: "remove-tier",
                  label: current === "admin" ? "Remove admin" : "Remove moderator",
                  icon: ShieldOff,
                  confirm: tierChangeConfirm("concord", "remove"),
                  onSelect: () => void handleSetRoleStable(pubkey, []),
                },
          );
        }
      }
      if (canKickAny && roster && canActOnMember(roster, user.pubkey, ownerHex, pubkey, Permissions.KICK)) {
        out.push({
          id: "kick",
          label: "Kick",
          icon: UserMinus,
          // The confirm dialog, not an instant kick: easy to hit by accident.
          onSelect: () => setKickTarget(pubkey),
        });
      }
      if (bannedHere.has(pubkey)) {
        // A banned member's old messages outlive their roster row.
        if (canBanAny) {
          out.push({ id: "unban", label: "Unban", icon: ShieldOff, onSelect: () => handleUnbanMember(pubkey) });
        }
      } else if (canBanAny && roster && canActOnMember(roster, user.pubkey, ownerHex, pubkey, Permissions.BAN)) {
        out.push({
          id: "ban",
          // A Private ban rotates keys unless someone ELSE holds a live link.
          label: folded && canRekeyHere && !hasForeignLiveLinks(folded, user.pubkey, pubkey) ? "Ban & lock out" : "Ban",
          icon: Ban,
          destructive: true,
          onSelect: () => setBanTarget(pubkey),
        });
      }
      return out.length > 0 ? out : NO_MEMBER_ACTIONS;
    };
    // The Roles picker on the card too, only if some role is assignable.
    const buildPicker = (pubkey: string): MemberRolePicker | undefined => {
      if (!canManageRoles || !roleCatalog?.some((r) => r.assignable) || !canEditMemberRoles(pubkey)) return undefined;
      return {
        catalog: roleCatalog,
        heldRoleIds: intendedRolesFor(pubkey),
        isToggling: isRoleTogglePending,
        onToggle: handleToggleRoleStable,
      };
    };
    return {
      actionsFor: (pubkey: string) => {
        let hit = actionsCache.get(pubkey);
        if (!hit) actionsCache.set(pubkey, (hit = buildActions(pubkey)));
        return hit;
      },
      rolePickerFor: (pubkey: string) => {
        if (!pickerCache.has(pubkey)) pickerCache.set(pubkey, buildPicker(pubkey));
        return pickerCache.get(pubkey);
      },
    };
  }, [
    user, canKickAny, canBanAny, bannedHere, canRekeyHere, handleUnbanMember, folded, roster, ownerHex, handleSetRoleStable,
    canManageRoles, roleCatalog, canEditMemberRoles, intendedRolesFor, isRoleTogglePending, handleToggleRoleStable,
  ]);

  const suppressChannelClick = channelDrag.shouldSuppressClick;
  const handleSelectChannel = useCallback(
    (idHex: string) => {
      // Swallow the click the browser synthesizes after a drag's pointerup.
      if (suppressChannelClick()) return;
      selectChannel(idHex);
      setChannelsOpen(false);
    },
    [suppressChannelClick, selectChannel],
  );
  const handleSetCategory = useCallback(
    (idHex: string, category: string | undefined) => void fileChannel(idHex, category),
    [fileChannel],
  );
  const handleNewCategory = useCallback(
    (c: Channel) => setCategoryPrompt({ channels: [c], initial: "" }),
    [],
  );

  const publishTyping = useTypingPublisher(community, channel);
  const typingPubkeys = useTyping(community, channel);

  if (!communityId) return <Navigate to="/" replace />;
  // Render NOTHING of the community to a non-member; placed before all of it.
  if (noAccess) return <CommunityNoAccess />;

  const handleSend = async (content: string, tags: string[][]) => {
    // Composer tags are sealed verbatim; `h` and stray `e` always dropped. INLINE
    // replies keep NIP-C7 `q` (+ `p`); thread replies use `sendThreadReply` (kind 1111).
    const isReply = Boolean(replyTo);
    const extraTags = tags.filter(([name]) =>
      name !== "h" && name !== "e" && (isReply || name !== "q"),
    );
    await send({ content, extraTags });
    setReplyTo(undefined);
    // Sending means "I'm at the present": drop any parked message location.
    clearMessageFocus();
  };

  const handleLeave = async () => {
    try {
      await leave();
      navigateTo("/");
    } catch (e) {
      toast({
        title: "Couldn't leave",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleDissolve = async () => {
    if (
      !confirm(
        "Permanently dissolve this community for everyone? This cannot be undone. Your invite links will be revoked and your Discover listings removed.",
      )
    ) return;
    let missed: RetirementOutcome | undefined;
    try {
      await dissolve({
        retire: async () => {
          missed = await retireLinks();
        },
      });
      // Internal navigation home, not a reload: `dissolve` marks it dissolved first,
      // which keeps an active call alive (see useCallSync). One toast either way.
      if (missed?.retry) {
        showRetirementMiss(missed);
      } else {
        toast({ title: "Community dissolved" });
      }
      navigateTo("/");
    } catch (e) {
      toast({ title: "Couldn't dissolve", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const handleToggleRole = async (pubkey: string, roleId: string, on: boolean) => {
    if (on && !roleIntent.rolesFor(pubkey).includes(roleId) && roleIntent.rolesFor(pubkey).length >= MAX_ROLES_PER_MEMBER) {
      toast({ title: "Role limit reached", description: `A member holds at most ${MAX_ROLES_PER_MEMBER} roles.`, variant: "destructive" });
      return;
    }
    try {
      // Composes on this client's last intent and ignores repeats in flight: a
      // Grant replaces the whole role list, so racing toggles would clobber.
      const published = await roleIntent.toggle(pubkey, roleId, on);
      if (!published) return; // already in flight
      toast({ title: on ? "Role granted" : "Role removed" });
    } catch (e) {
      toast({ title: "Couldn't change roles", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      return;
    }

    // Role-gated channel keys follow the grant (channelAccess.ts), judged with the
    // change overlaid since the fold lags.
    if (!roster) return;
    const affected = channelsHingingOn(roster, ownerHex, pubkey, roleId, privateChannelsHere);
    const nameOf = (idHex: string) => folded?.channels.get(idHex)?.name ?? idHex.slice(0, 8);
    const listNames = (ids: string[]) => ids.map((id) => `#${nameOf(id)}`).join(", ");

    if (on) {
      if (affected.held.length > 0) {
        try {
          await sendDirectInvite({
            recipientPubkey: pubkey,
            onlyChannelIdHexes: new Set(affected.held),
            // Overlay the just-published Grant, or the recipient reads as unentitled.
            entitlementOverlay: { withRoleIds: [roleId] },
          });
          toast({ title: "Channel keys sent", description: `The member received ${affected.held.length} private channel key${affected.held.length > 1 ? "s" : ""}.` });
        } catch (e) {
          toast({
            title: "Couldn't send the channel keys",
            description: `The role was granted, but delivering its private channel keys failed${e instanceof Error ? `: ${e.message}` : "."} Toggle the role off and on to retry.`,
            variant: "destructive",
          });
        }
      }
      // Only a key holder can vend; the grantee waits until one does.
      if (affected.unheld.length > 0) {
        toast({
          title: "Some channel keys weren't sent",
          description: `You don't hold the key to ${listNames(affected.unheld)}, so a member who does has to share it before they can read ${affected.unheld.length > 1 ? "those channels" : "that channel"}.`,
        });
      }
      return;
    }

    if (affected.held.length === 0 && affected.unheld.length === 0) return;
    // Report the un-rotatable part first: a revoke that cuts nobody is the failure to hear about.
    if (affected.unheld.length > 0) {
      toast({
        title: "Channel access not revoked",
        description: `You don't hold the key to ${listNames(affected.unheld)}, so they keep reading until a member who does rotates it.`,
        variant: "destructive",
      });
    }
    if (affected.held.length === 0) return;
    if (!canRekeyChannel) {
      toast({
        title: "Channel keys not rotated",
        description: "They lost access to a private channel, but rotating its key needs the Manage channels permission. Ask an admin to rotate it.",
        variant: "destructive",
      });
      return;
    }
    for (const idHex of affected.held) {
      const keep = memberPubkeys.filter(
        (pk) => pk !== pubkey && isEntitled(roster, ownerHex, pk, idHex),
      );
      try {
        // Everyone else entitled is kept, so this member is the whole removed set (CORD-06).
        await rekeyChannel({ channelIdHex: idHex, keepRecipients: keep, removedTargets: [pubkey] });
      } catch (e) {
        toast({
          title: "Channel key rotation failed",
          description: `They may still read #${nameOf(idHex)} until it succeeds${e instanceof Error ? `: ${e.message}` : "."}`,
          variant: "destructive",
        });
      }
    }
  };

  const handleSetRole = async (pubkey: string, roles: string[]) => {
    const tier = roles.includes("admin") ? ("admin" as const) : roles.includes("moderator") ? ("moderator" as const) : null;
    try {
      await setTier({ member: pubkey, tier });
      toast({ title: tier === "admin" ? "Made admin" : tier === "moderator" ? "Made moderator" : "Role removed" });
    } catch (e) {
      toast({ title: "Couldn't change role", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  // This render's closures for the memberOpsRef wrappers (render-time ref write, as in ui/avatar.tsx).
  memberOpsRef.current = {
    setRole: handleSetRole,
    toggleRole: handleToggleRole,
    kick: (pk: string) => void moderation.kick({ target: pk }).catch(() => {}),
    unban: (pk: string) => void moderation.unban({ target: pk }).catch(() => {}),
  };

  // A ban rotates keys unless someone ELSE holds a live link (it'd be stranded).
  // Judged as-of after the ban.
  const banWillRotate =
    banTarget !== null && !!folded && !!user && !hasForeignLiveLinks(folded, user.pubkey, banTarget) &&
    moderation.canRekey;

  const runBan = async (targets: string[], onPhase: (phase: BanPhase) => void) => {
    const { rekeyed, publicBan } = await moderation.banMany({ targets, onPhase });
    if (rekeyed || publicBan) {
      toast({ title: "Member banned", description: "They are silenced for everyone in this community." });
    } else {
      toast({ title: "Member banned", description: "Added to the banlist; key rotation didn't complete (you can retry)." });
    }
  };

  const runKick = async (targets: string[], onProgress: (done: number, total: number) => void) => {
    const result = await moderation.kickMany({ targets, onProgress });
    if (result.failed.length === 0) {
      toast({ title: "Member kicked", description: "They're off the member list, but can rejoin from an invite." });
    }
    return result;
  };

  // A standalone rotation strands other creators' live links; warned, not vetoed.
  const rotateStrandsForeignLinks = Boolean(folded && user && hasForeignLiveLinks(folded, user.pubkey));

  const runRotateKeys = async () => {
    await moderation.rotateKeys();
    toast({
      title: "Community keys rotated",
      description: "Everyone still in the community keeps access. The previous keys can't read new messages.",
    });
  };

  const renderChannelRow = (c: Channel) => {
    if (!community) return null;
    const index = renderedIndexOf.get(c.idHex) ?? 0;
    const inCall = Boolean(activeCall?.concord && activeCall.concord.channel.idHex === c.idHex);
    const dragged = channelDrag.sourceIdHex === c.idHex;
    return (
      <div
        key={c.idHex}
        data-ch-slot
        data-ch-index={index}
        data-ch-category={c.category ?? ""}
        onPointerDown={channelDrag.onPointerDown(c.idHex)}
        // `touch-none` while draggable, or Chrome claims the drag as a pan
        // (pointercancel); scrolling is panned by hand (usePressDrag.ts).
        className={cn("relative", canManageChannels && "touch-none")}
      >
      {/* Keep the dragged row mounted (invisible): unmounting the touched node makes Chrome cancel the gesture. */}
      <span className={cn("contents", dragged && "invisible")}>
      <ChannelRow
        community={community}
        channel={c}
        active={Boolean(view === "channel" && channel && channel.idHex === c.idHex)}
        inCall={inCall}
        speaking={inCall ? speakingPubkeys : undefined}
        muted={inCall ? mutedPubkeys : undefined}
        unread={unreadByChannel[c.idHex]}
        onSelect={handleSelectChannel}
        onJoinVoice={handleJoinVoice}
        categories={categoryPicklist}
        onSetCategory={canManageChannels ? handleSetCategory : undefined}
        onNewCategory={handleNewCategory}
      />
      </span>
      {dragged && (
        <span className="pointer-events-none absolute inset-x-0 inset-y-px clip-hairline-lg [--edge:var(--primary)/0.5] [--fill:var(--primary)/0.05] [--fill-hover:var(--primary)/0.05]" />
      )}
      </div>
    );
  };

  // The one channel column (mobile and desktop) carries the drag container ref.
  const channelList = (onNavigate?: () => void, className?: string) => (
    <ChannelSidebarView
      scrollRef={channelDrag.attachColumn}
      className={className ?? (onNavigate ? "flex-1" : "hidden sidebar:flex")}
      title={
        <button
          type="button"
          className="group flex w-full items-center gap-1 min-w-0 text-left cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
          onClick={() => community && setCommunityMenuOpen((v) => !v)}
          disabled={!community}
          aria-label="Community menu"
          aria-expanded={communityMenuOpen}
        >
          <TitleIcon icon={folded?.metadata?.icon} />
          <span className="flex-1 truncate">{community?.name ?? "…"}</span>
          {community && (
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                communityMenuOpen && "rotate-180",
              )}
            />
          )}
        </button>
      }
      titleExpansion={
        community ? (
          <Collapsible open={communityMenuOpen} onOpenChange={setCommunityMenuOpen}>
            <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
              <div className="mx-3 mb-2 mt-1 p-1 space-y-0.5 clip-corner-lg bg-secondary">
                {[
                  {
                    show: Object.keys(unreadByChannel).length > 0,
                    icon: <CheckCheck className="size-4" />,
                    label: "Mark all as read",
                    onClick: markAllChannelsRead,
                  },
                  {
                    show: true,
                    icon: <Settings className="size-4" />,
                    label: "Community settings",
                    onClick: () => {
                      selectPane("settings");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: !!user && !dissolved,
                    icon: <UserPlus className="size-4" />,
                    label: "Invite people",
                    onClick: () => setInviteOpen(true),
                  },
                  {
                    // Listing publishes the secret link, so owner/admin only.
                    show: iAmAdminOrOwner && !dissolved,
                    icon: <Megaphone className="size-4" />,
                    label: "Share to Discover",
                    onClick: () => setShareDiscoverOpen(true),
                  },
                  {
                    show: canManageChannels && !dissolved,
                    icon: <Plus className="size-4" />,
                    label: "Create channel",
                    onClick: () => setCreatingChannel(true),
                  },
                  {
                    // One entry for the moderation panes; also closes the mobile drawer.
                    show: true,
                    icon: <Shield className="size-4" />,
                    label: "Moderation",
                    onClick: () => {
                      const pane = firstModerationPane(moderationAccess);
                      if (pane) selectPane(pane);
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: true,
                    icon: communityMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />,
                    label: communityMuted ? "Unmute community" : "Mute community",
                    onClick: () => toggleCommunityMute(`c2:${community.idHex}`),
                  },
                ]
                  .filter((i) => i.show)
                  .map((i) => (
                    <button
                      key={i.label}
                      type="button"
                      className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left transition-colors clip-corner-lg hover:bg-foreground/10"
                      onClick={() => {
                        i.onClick();
                        setCommunityMenuOpen(false);
                      }}
                    >
                      {i.icon}
                      {i.label}
                    </button>
                  ))}
                {user && (
                  <>
                    <div className="mx-1 my-1 h-px bg-border" />
                    {moderation.canRotateKeys && !dissolved && (
                      <button
                        type="button"
                        disabled={moderation.isRotatingKeys}
                        className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left text-destructive transition-colors clip-corner-lg hover:bg-destructive/10 disabled:opacity-50"
                        onClick={() => {
                          setRotateKeysOpen(true);
                          setCommunityMenuOpen(false);
                        }}
                      >
                        <KeyRound className="size-4" />
                        Rotate community keys
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isLeaving}
                      className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left text-destructive transition-colors clip-corner-lg hover:bg-destructive/10 disabled:opacity-50"
                      onClick={() => {
                        handleLeave();
                        setCommunityMenuOpen(false);
                      }}
                    >
                      <LogOut className="size-4" />
                      {dissolved ? "Remove community" : "Leave community"}
                    </button>
                    {iAmOwner && !dissolved && (
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left text-destructive transition-colors clip-corner-lg hover:bg-destructive/10"
                        onClick={() => {
                          handleDissolve();
                          setCommunityMenuOpen(false);
                        }}
                      >
                        <Trash2 className="size-4" />
                        Dissolve community
                      </button>
                    )}
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : undefined
      }
      banner={folded?.metadata?.banner ? <Banner banner={folded.metadata.banner} /> : undefined}
      addChannelLabel={user && community && canManageChannels ? "Add channel" : undefined}
      onAddChannel={user && community && canManageChannels ? () => setCreatingChannel((v) => !v) : undefined}
      addChannelOpen={creatingChannel}
      footer={<SidebarFooter />}
      preChannels={
        user && community ? (
          <>
            <SuspiciousActivityBanner community={community} channels={channels} folded={folded} onOpen={() => selectPane("suspicious")} />
            <button
              type="button"
              onClick={() => {
                selectPane("all");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "all"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
              )}
              aria-current={view === "all"}
            >
              <Rss className="size-4 shrink-0" />
              <span className="truncate flex-1 min-w-0">All messages</span>
            </button>
            <button
              type="button"
              onClick={() => {
                selectPane("mentions");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "mentions"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                view !== "mentions" && hasUnreadMention && "text-foreground font-semibold",
              )}
              aria-current={view === "mentions"}
            >
              <AtSign className="size-4 shrink-0" />
              <span className="truncate flex-1 min-w-0">Mentions</span>
              {view !== "mentions" && hasUnreadMention ? (
                <span
                  className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none"
                  aria-label="You have unread mentions"
                >
                  @
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => {
                selectPane("threads");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "threads"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                view !== "threads" && hasNewThreadReplies && "text-foreground font-semibold",
              )}
              aria-current={view === "threads"}
            >
              <MessagesSquare className="size-4 shrink-0" />
              <span className="truncate flex-1 min-w-0">Threads</span>
              {view !== "threads" && hasNewThreadReplies ? (
                <span
                  className="shrink-0 size-2 rounded-full bg-primary"
                  aria-label="New thread replies"
                />
              ) : null}
            </button>
            {hasProjects && (
              <button
                type="button"
                onClick={() => {
                  setProjectsTouched(true);
                  selectPane("projects");
                  onNavigate?.();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                  view === "projects"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                )}
                aria-current={view === "projects"}
              >
                <FolderGit2 className="size-4 shrink-0" />
                <span className="truncate flex-1 min-w-0">Projects</span>
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {!community || channels.length === 0 ? (
        showChannelSkeleton ? (
          <div className="space-y-2 px-2 py-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : null
      ) : (
        <>
          {uncategorizedChannels.map(renderChannelRow)}
          {channelCategories.map((group) => {
            const collapsed = collapsedCategories.has(group.key);
            // A collapsed category still shows the active channel and anything unread.
            const shown = collapsed
              ? group.channels.filter(
                  (c) =>
                    (view === "channel" && channel?.idHex === c.idHex) || unreadByChannel[c.idHex],
                )
              : group.channels;
            return (
              // `space-y-0.5` mirrors the sidebar's row spacing for nested rows.
              <div key={group.key} className="space-y-0.5">
                <ChannelCategoryHeading
                  name={group.name}
                  collapsed={collapsed}
                  onToggle={() => toggleCategory(group.key)}
                  hasUnread={group.channels.some((c) => unreadByChannel[c.idHex])}
                  highlight={
                    channelDrag.dragging &&
                    !channelDrag.target?.newCategory &&
                    channelDrag.target?.category === group.name
                  }
                  onRename={
                    canManageChannels
                      ? () => setCategoryPrompt({ channels: group.channels, initial: group.name })
                      : undefined
                  }
                  onUngroup={
                    canManageChannels ? () => void refileCategory(group.channels, undefined) : undefined
                  }
                />
                {shown.map(renderChannelRow)}
              </div>
            );
          })}
          {/* Trailing drop zone (drag only): names a new category for the channel. */}
          {channelDrag.dragging && (
            <div
              data-ch-newzone
              className={cn(
                "mt-2 flex items-center justify-center gap-1.5 clip-hairline-lg px-2 py-3 text-2xs font-semibold uppercase tracking-wider transition-colors",
                channelDrag.target?.newCategory
                  ? "[--edge:var(--primary)] [--fill:var(--primary)/0.05] [--fill-hover:var(--primary)/0.05] text-primary"
                  : "[--edge:var(--primary)/0.5] [--fill:var(--background)/0.4] [--fill-hover:var(--background)/0.4] text-muted-foreground/70",
              )}
            >
              <Plus className="size-3.5" />
              New category
            </div>
          )}
        </>
      )}

      {/* Drag chrome in channel shape, as in ServerRail.tsx. */}

      {channelDrag.pointer && draggedChannel && (
        <div
          className="pointer-events-none fixed z-[300] -translate-y-1/2 animate-in zoom-in-75 duration-150"
          style={{ left: (channelDrag.columnX?.left ?? 0) + 12, top: channelDrag.pointer.y }}
        >
          <span className="flex max-w-48 items-center gap-2 rotate-[-2deg] scale-105 clip-corner-lg bg-muted px-3 py-1.5 text-sm font-medium ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
            <ChannelGlyph isPrivate={draggedChannel.isPrivate} view={draggedChannel.view} className="size-4 shrink-0" />
            <span className="truncate">{draggedChannel.name}</span>
          </span>
        </div>
      )}

      {/* Grabbing-cursor layer: Chromium only re-evaluates the cursor during a drag
          when a new element appears. Must not be pointer-events-none. */}
      {channelDrag.dragging && (
        <div className="fixed inset-0 z-[298] cursor-grabbing" aria-hidden />
      )}

      {channelDrag.indicatorY !== null && !channelDrag.target?.newCategory && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[299] h-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.7)]"
          style={{
            top: channelDrag.indicatorY - 1,
            left: (channelDrag.columnX?.left ?? 0) + 6,
            width: (channelDrag.columnX?.width ?? 0) - 12,
          }}
        />
      )}
    </ChannelSidebarView>
  );

  return (
    <ChannelNavContext.Provider value={channelNav}>
      {/* Member kind-0s often live only on the community's own relays. */}
      <ProfileRelayHints relays={community?.relays} />
      <MemberRolesContext.Provider value={memberRolesValue}>
      <MemberActionsContext.Provider value={memberActionsValue}>
      <ConcordMediaHold community={community} trusted={trustedAuthors}>
      <ChatShell
        scope={appScope}
        reveal={{
          open: channelsOpen,
          onReveal: () => setChannelsOpen(true),
          onClose: () => setChannelsOpen(false),
          underlay: (
            <>
              {/* No onNavigate: closing this list would flash this community's chat
                  before the route changes. */}
              <ServerRail />
              {channelList(() => setChannelsOpen(false), "flex-1 sidebar:flex-none")}
            </>
          ),
        }}
      >
          <ChatHeader>
            <ChatHeaderBack onClick={() => setChannelsOpen(true)} />
            <ChatHeaderTitle
              glyph={(className) =>
                paneHeader ? (
                  <paneHeader.icon className={className} />
                ) : (
                  <ChannelGlyph isPrivate={channel?.isPrivate} view={channel?.view} className={className} />
                )
              }
              title={paneHeader ? paneHeader.label : channel?.name ?? "…"}
              avatar={<TitleAvatar icon={folded?.metadata?.icon} name={community?.name} />}
              context={community?.name ?? "…"}
              onContextClick={community ? () => selectPane("settings") : undefined}
              contextLabel="Community settings"
              indicator={(className) => <SyncStatusIndicator priorityScope={channelScope} className={className} />}
            />
            <ChatHeaderActions>
              {/* A forum has no call, pins bar or events. */}
              {user && view === "channel" && channel && channel.view !== "forum" && !dissolved && (
                <ChatHeaderAction
                  icon={inThisVoice ? Headphones : Phone}
                  label={inThisVoice ? "In voice" : "Join voice"}
                  className={cn(inThisVoice && "text-success")}
                  disabled={inThisVoice}
                  onClick={() => channel && handleJoinVoice(channel, activeBroker ?? null)}
                />
              )}
              {view === "channel" && channel && (
                <ChatHeaderAction
                  icon={Search}
                  label="Search messages"
                  pressed={searchOpen}
                  className="hidden sidebar:inline-flex"
                  onClick={() => setSearchOpen(true)}
                />
              )}
              {view === "channel" && channel && channel.view !== "forum" && (pins.pins.length > 0 || pins.dark) && (
                <ChatHeaderAction
                  icon={Pin}
                  label={pinsOpen ? "Hide pinned messages" : "Show pinned messages"}
                  tooltip="Pinned messages"
                  pressed={pinsOpen}
                  onClick={() => setPinsOpen((v) => !v)}
                />
              )}

              {/* Like pins, only once there is something to show; staff schedule from ⋮. */}
              {view === "channel" && channel && channel.view !== "forum" && calendar.events.length > 0 && (
                <ChatHeaderAction
                  icon={CalendarClock}
                  label={eventsOpen ? "Hide events" : "Show events"}
                  tooltip="Events"
                  pressed={eventsOpen}
                  onClick={() => setEventsOpen((v) => !v)}
                />
              )}

              <DropdownMenu>
                <ChatHeaderMenuTrigger />
                <DropdownMenuContent align="end" className="w-52">
                  <ChatHeaderViewItems
                    onSearch={view === "channel" && channel ? () => setSearchOpen(true) : undefined}
                    onMembers={() => setMembersOpen(true)}
                    membersVisible={membersVisible}
                    onToggleMembers={toggleMembersVisible}
                  />
                  {view === "channel" && channel && channel.view !== "forum" && calendar.canModerate && calendar.events.length === 0 && (
                    <DropdownMenuItem onClick={() => setCreateEventOpen(true)}>
                      <CalendarClock className="size-4" />
                      Schedule an event
                    </DropdownMenuItem>
                  )}
                  {view === "channel" && channel?.isPrivate && addableChannelRoles.length > 0 && (
                    <DropdownMenuItem onClick={openAddMembers}>
                      <UserPlus className="size-4" />
                      Add members
                    </DropdownMenuItem>
                  )}
                  {user && !dissolved && (
                    <DropdownMenuItem onClick={() => setInviteOpen(true)}>
                      <UserPlus className="size-4" />
                      Invite people
                    </DropdownMenuItem>
                  )}
                  {/* A forum's alternate view (CORD-03 §2): the plain timeline. */}
                  {view === "channel" && channel?.view === "forum" && (
                    <DropdownMenuItem onClick={toggleForumPresentation}>
                      {forumOpensAsChat ? <MessageSquareText className="size-4" /> : <Hash className="size-4" />}
                      {forumOpensAsChat ? "View as posts" : "View as chat"}
                    </DropdownMenuItem>
                  )}
                  {user && community && channel && (
                    <DropdownMenuItem
                     
                      onClick={() => toggleConcordChannelMute("c2", community.idHex, channel.idHex)}
                    >
                      {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {channelMuted ? "Unmute channel" : "Mute channel"}
                    </DropdownMenuItem>
                  )}
                  {canManageChannels && community && !dissolved && (
                    communityPause ? (
                      <DropdownMenuItem onClick={() => clearPause.mutate()}>
                        <Play className="size-4" />
                        Resume community
                      </DropdownMenuItem>
                    ) : (
                      // A duration submenu, not a toggle: pausing freezes chat for
                      // everyone, and a bounded pause lifts on its own (CORD-04 §8).
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Pause className="size-4" />
                          Pause community
                        </DropdownMenuSubTrigger>
                        <DropdownMenuPortal>
                          <DropdownMenuSubContent>
                            {PAUSE_DURATIONS.map((d) => (
                              <DropdownMenuItem
                                key={d.label}
                               
                                onClick={() =>
                                  setPaused.mutate(
                                    d.secs === undefined
                                      ? {}
                                      : { untilSecs: Math.floor(Date.now() / 1000) + d.secs },
                                  )
                                }
                              >
                                {d.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuPortal>
                      </DropdownMenuSub>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </ChatHeaderActions>

            {view === "channel" && channel && (
              <ChatSearchBar
                open={searchOpen}
                value={searchFilters.query}
                onChange={(query) => setSearchFilters((f) => ({ ...f, query }))}
                onClose={closeSearch}
                placeholder="Search all channels…"
                filters={
                  <SearchFiltersPopover
                    channels={channels}
                    members={memberPubkeys}
                    filters={searchFilters}
                    onChange={setSearchFilters}
                  />
                }
              />
            )}
          </ChatHeader>

          <CallStageSlot active={inThisVoice} />

          {appScope && <AppStageSlot scope={appScope} />}

          <div className="relative flex flex-1 min-h-0">
            <ComposerBoundsProvider value={composerBoundsRef}>
            <div className={cn(
              "flex-1 min-w-0 flex flex-col",
              chatColumnClass,
              openTicket && ticketExpanded && "thread:flex-none thread:w-0 thread:opacity-0 thread:overflow-hidden thread:pointer-events-none",
            )}>
              {view === "all" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <AllMessagesView
                    channels={channels}
                    messages={feed.messages}
                    isLoading={feed.isLoading}
                    hasMore={feed.hasMore}
                    isLoadingOlder={feed.isLoadingOlder}
                    onLoadOlder={feed.loadOlder}
                    onJump={jumpToMention}
                    mentionsEveryone={messageMentionsEveryone}
                  />
                </div>
              ) : view === "mentions" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <MentionsView
                    channels={channels}
                    mentions={mentions}
                    isLoading={mentionsLoading}
                    onJump={jumpToMention}
                    mentionsEveryone={messageMentionsEveryone}
                  />
                </div>
              ) : isModerationPane(view) ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable pb-safe">
                  {community && (
                    <ModerationView
                      community={community}
                      pane={view}
                      access={moderationAccess}
                      memberPubkeys={memberPubkeys}
                      canModerateMembers={canKickAny || canBanAny}
                      canManageRoles={canManageRoles && !dissolved}
                      onSelect={selectPane}
                    />
                  )}
                </div>
              ) : view === "settings" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && (
                    <CommunitySettingsView
                      community={community}
                      metadata={folded?.metadata}
                      ownerHex={ownerHex}
                      memberCount={memberPubkeys.length}
                      canManageMetadata={canManageMetadata}
                      canManageChannels={canManageChannels}
                      channelRoles={channelRoleCatalog}
                      onPrivatiseChannel={canManageChannels ? handlePrivatiseChannel : undefined}
                      onRotateChannelKey={canRekeyChannel ? handleRotateChannelKey : undefined}
                      onMintAccessRole={canManageRoles ? handleMintAccessRole : undefined}
                      onOpenInvites={() => selectPane("invites")}
                    />
                  )}
                </div>
              ) : view === "suspicious" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && (
                    <SuspiciousActivityView
                      community={community}
                      channels={channels}
                      folded={folded}
                      ban={moderation.ban}
                      kick={(target) => moderation.kick({ target })}
                      canBan={moderation.canBan}
                      canKick={moderation.canKick}
                    />
                  )}
                </div>
              ) : view === "threads" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <ThreadsView
                    channels={channels}
                    threads={displayedThreads}
                    isLoading={threadsLoading}
                    onOpen={openThreadFromList}
                    mentionsEveryone={messageMentionsEveryone}
                  />
                </div>
              ) : view === "projects" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <ProjectsView
                    repos={projects.repos}
                    items={projects.items}
                    isLoading={projects.isLoading}
                    intro="Browse this community's repositories and activity."
                    emptyHint="Repositories attached to this community's channels will appear here."
                    onOpenItem={openProjectItem}
                    headerExtra={
                      <div className="flex items-center gap-1.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground"
                              aria-label="Refresh repository activity"
                              disabled={projects.isSyncing}
                              onClick={projects.refresh}
                            >
                              <RefreshCw className={cn("size-4", projects.isSyncing && "animate-spin")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Refresh repository activity</TooltipContent>
                        </Tooltip>
                        {user && <NewIssueDialog repos={projects.repos} items={projects.items} onCreate={handleCreateIssue} />}
                      </div>
                    }
                  />
                </div>
              ) : searching ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <SearchResultsView
                    channels={channels}
                    results={searchResults}
                    isLoading={searchLoading}
                    query={searchFilters.query}
                    onJump={jumpFromSearch}
                  />
                </div>
              ) : (
                <>
                  {/* Pins/events bars are chat furniture; forums don't mount them. */}
                  {presentation !== "feed" && (
                  <PinnedBar
                    open={pinsOpen}
                    pins={pins.pins}
                    dark={pins.dark}
                    canUnpin={pins.canPin}
                    isUnpinning={pins.isUnpinning}
                    staleEdits={pins.staleEdits}
                    isRefreshingEdits={pins.isRefreshingEdits}
                    onRefreshEdits={pins.canPin ? () => {
                      void (async () => {
                        try {
                          const n = await pins.refreshEdits();
                          toast({ title: n > 0 ? `Updated ${n} pin${n === 1 ? "" : "s"}` : "Pins already current" });
                        } catch (e) {
                          toast({ title: "Couldn't update pins", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                        }
                      })();
                    } : undefined}
                    onJump={jumpWithinChannel}
                    onUnpin={(rumorId) => {
                      void (async () => {
                        try {
                          await pins.unpin({ rumorId });
                        } catch (e) {
                          toast({ title: "Couldn't unpin", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                        }
                      })();
                    }}
                    onClose={() => setPinsOpen(false)}
                  />
                  )}
                  {presentation !== "feed" && (
                  <CalendarEventsBar
                    open={eventsOpen}
                    calendar={calendar}
                    onClose={() => setEventsOpen(false)}
                    onCreate={() => setCreateEventOpen(true)}
                    onDelete={(event) => { void calendar.remove(event); }}
                  />
                  )}
                  {presentation === "feed" && channel && newPostOpen ? (
                    // Writing a post takes the feed's place: a page, not a bar.
                    <NewPostPane
                      className="flex-1 min-h-0"
                      channelName={channel.name}
                      groupId={channel.idHex}
                      mentionPubkeys={memberPubkeys}
                      canMentionEveryone={transport.canMentionEveryone}
                      conversationRelays={community?.relays}
                      canSend={composerCanSend}
                      disappearingTimer={resolveMessageTimer}
                      onSubmit={handleCreatePost}
                      onCancel={() => setNewPostOpen(false)}
                    />
                  ) : presentation === "feed" && channel && threadRoot ? (
                    // Reading a post takes the feed's place (route `/t/<root>`, so back
                    // returns to the feed).
                    <ForumPostPage
                      className="flex-1 min-h-0"
                      root={threadRoot}
                      title={subjectOf(threadRoot) ?? ""}
                      pinned={pins.isPinned(threadRoot.id)}
                      transport={transport}
                      groupId={channel.idHex}
                      canWrite={canWrite}
                      mentionPubkeys={memberPubkeys}
                      conversationRelays={community?.relays}
                      disappearingTimer={resolveMessageTimer}
                      autoFocus={threadAutoFocus}
                      onBack={closeThread}
                    />
                  ) : presentation === "feed" ? (
                    <ForumFeed
                      key={channel?.idHex}
                      className="flex-1 min-h-0"
                      posts={feedPosts}
                      sort={forumSort}
                      onSortChange={setForumSort}
                      isLoading={Boolean(baseTransport.isLoading)}
                      syncing={channelSyncing || gateResolving}
                      hasMore={transport.hasMore}
                      isLoadingOlder={transport.isLoadingOlder}
                      onLoadOlder={transport.loadOlder}
                      onOpen={openPost}
                      isNew={isPostNew}
                      onNewPost={canWrite ? () => setNewPostOpen(true) : undefined}
                      banner={
                        <>
                          {communityPause && channel && (
                            <CommunityPauseBanner
                              pause={communityPause}
                              canManage={canManageChannels}
                              onResume={() => clearPause.mutate()}
                              resuming={clearPause.isPending}
                            />
                          )}
                          <PendingJoinNotice state={pendingJoin.state} onRetry={pendingJoin.retry} />
                        </>
                      }
                    />
                  ) : (
                  <MessageTimeline
                    // No per-channel `key`: switch in place; the lost anchor resets
                    // the timeline via its `anchorLost` path.
                    transport={transport}
                    entries={mixedEntries}
                    newDividerId={newDividerId}
                    renderEntry={(entry, relatedEntries) => isGitTimelineEntry(entry) ? <GitTimelineRow entry={entry} onOpen={openChannelTicket} related={relatedEntries} /> : entry.type === "dm-timer" ? <TimerNotice author={entry.author} seconds={entry.seconds} self={user?.pubkey} /> : null}
                    handleRef={timelineRef}
                    syncing={channelSyncing || gateResolving}
                    syncFailed={channelSyncFailed}
                    className="flex-1 min-h-0"
                    emptyState={
                      // Only once a channel has resolved. A decode dead-end (wraps
                      // pulled, none opened) is distinct from "empty".
                      channel ? (
                        channelDecodeDeadEnd(channel.idHex) ? (
                          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                            There are messages here, but they can't be decrypted with the keys
                            this device holds yet. They should become readable once the next key
                            update from the community reaches you.
                          </p>
                        ) : (
                          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                            No messages yet. Only members can read this channel.
                          </p>
                        )
                      ) : undefined
                    }
                    renderMessage={(msg, continuation) => {
                      const replyId = getQuoteReplyToId(msg);
                      return (
                      <ConcordChatMessage
                        key={msg.id}
                        event={msg}
                        title={subjectOf(msg)}
                        permalink={permalink}
                        reactions={reactionsFor(msg.id)}
                        zaps={transport.zapsFor?.(msg.id)}
                        onSendZap={config.zapsEnabled ? transport.sendZap : undefined}
                        onSendOnchainZap={config.zapsEnabled ? transport.sendOnchainZap : undefined}
                        poll={transport.pollFor?.(msg.id)}
                        calendar={transport.calendarFor?.(msg.id)}
                        replies={transport.threadRepliesFor?.(msg.id) ?? EMPTY_REPLIES}
                        continuation={continuation}
                        canWrite={transport.canWrite}
                        canModerate={transport.canModerate}
                        everyoneMention={Boolean(transport.mentionsEveryone?.(msg))}
                        isPinned={Boolean(transport.isPinned?.(msg.id))}
                        onTogglePin={transport.togglePin}
                        sendStatus={transport.sendStatusFor?.(msg.id)}
                        active={activeId === msg.id}
                        onToggleActive={toggleActive}
                        onOpenThread={onOpenThreadCb}
                        onReply={canWrite ? setReplyTo : undefined}
                        replyToId={replyId}
                        replyParent={replyId ? (messagesById.get(replyId) ?? olderReplyParents.get(replyId)) : undefined}
                        onJumpToReply={jumpWithinChannel}
                        onDelete={transport.deleteMessage}
                        onRetry={transport.retry}
                        onDiscard={transport.discard}
                        isEditing={editingId === msg.id}
                        onEdit={canWrite ? startEditing : undefined}
                        onEditSubmit={handleEditSubmit}
                        onEditCancel={cancelEditing}
                      />
                      );
                    }}
                  />
                  )}

                  {presentation !== "feed" && typingPubkeys.length > 0 && <TypingIndicator pubkeys={typingPubkeys} />}
                  {dissolved ? (
                    <div className="mx-gutter mb-3 mt-1 px-3 py-3 clip-corner-lg bg-destructive/10 flex items-center gap-3">
                      <Trash2 className="size-5 shrink-0 text-destructive" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium text-destructive">This community was dissolved by its owner.</p>
                        <p className="text-muted-foreground">
                          It's now read-only. You can still browse the history, or remove it from your list.
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="shrink-0 clip-corner-lg"
                        disabled={isLeaving}
                        onClick={handleLeave}
                      >
                        {isLeaving ? <Loader2 className="size-4 animate-spin" /> : "Remove"}
                      </Button>
                    </div>
                  ) : excluded ? (
                    <div className="mx-gutter mb-3 mt-1 px-3 py-3 clip-corner-lg bg-muted/60 flex items-center gap-3">
                      <Lock className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium">You no longer have access to this community.</p>
                        <p className="text-muted-foreground">
                          A moderator rotated its keys without you. Your history stays readable; new
                          messages won't. It reappears if you're re-invited, or you can leave.
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0 clip-corner-lg"
                        disabled={isLeaving}
                        onClick={handleLeave}
                      >
                        {isLeaving ? <Loader2 className="size-4 animate-spin" /> : "Leave"}
                      </Button>
                    </div>
                  ) : stranded ? (
                    <div className="mx-gutter mb-3 mt-1 px-3 py-3 clip-corner-lg bg-muted/60 flex items-center gap-3">
                      <Lock className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium">This invite link is out of date.</p>
                        <p className="text-muted-foreground">
                          The community rotated its keys after this link was made, so you're on an
                          older version and can't read new messages.
                          {canRecover
                            ? " This checks for updated keys automatically; you can also ask whoever invited you for a fresh invite, or ask a moderator to send you the current keys."
                            : " Ask whoever invited you for a fresh invite, or ask a moderator to send you the current keys."}
                        </p>
                      </div>
                      {canRecover && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="shrink-0 clip-corner-lg"
                          disabled={recoveryChecking}
                          onClick={() => void recoveryCheckNow()}
                        >
                          {recoveryChecking ? <Loader2 className="size-4 animate-spin" /> : "Check again"}
                        </Button>
                      )}
                    </div>
                  ) : (
                    channel && presentation !== "feed" && (
                      <>
                        {communityPause && (
                          <CommunityPauseBanner
                            pause={communityPause}
                            canManage={canManageChannels}
                            onResume={() => clearPause.mutate()}
                            resuming={clearPause.isPending}
                          />
                        )}
                        <PendingJoinNotice state={pendingJoin.state} onRetry={pendingJoin.retry} />
                        <ChatComposer
                          relayUrl="dm"
                          groupId={channel.idHex}
                          messages={[]}
                          // The canonical share address, not the current location.
                          shareRoute={channelRoute && chatRoute(channelRoute)}
                          mentionPubkeys={memberPubkeys}
                          canMentionEveryone={transport.canMentionEveryone}
                          botCommands
                          recentAuthors={recentAuthors}
                          conversationRelays={community?.relays}
                          placeholder={communityPaused ? "This community is paused" : user ? `Message #${channel.name}` : "Sign in to send"}
                          // Android Direct Share: named community-first. No icon:
                          // the community image is encrypted and the OS fetches
                          // shortcut avatars over plain HTTP.
                          shareLabel={community?.name ? `${community.name} #${channel.name}` : `#${channel.name}`}
                          sendOverride={handleSend}
                          canSend={composerCanSend}
                          onPollSubmit={transport.sendPoll}
                          replyTo={replyTo}
                          sealed
                          onCancelReply={() => setReplyTo(undefined)}
                          onTyping={publishTyping}
                          encryptAttachments
                          disappearingTimer={resolveMessageTimer}
                          onEditLast={canWrite ? editLast : undefined}
                          // Focus on open/switch, except on touch (keyboard).
                          autoFocus={!isTouchDevice}
                        />
                      </>
                    )
                  )}
                </>
              )}
            </div>

            <TicketSidePanel ticket={openTicket} members={memberSet} activities={panelActivities} onClose={() => setOpenTicket(undefined)} onExpandChange={setTicketExpanded} actions={ticketActions} />
            <MountWhenOpened open={creatingChannel}>
              <NewChannelDialog
                open={creatingChannel}
                onOpenChange={setCreatingChannel}
                connectedCoordinates={connectedCoordinates}
                onCreateText={handleCreateTextChannel}
                onCreateRepository={handleCreateRepositoryChannel}
              />
            </MountWhenOpened>
            <MountWhenOpened open={createEventOpen}>
              <CreateEventDialog
                calendar={calendar}
                open={createEventOpen}
                onOpenChange={setCreateEventOpen}
              />
            </MountWhenOpened>
            </ComposerBoundsProvider>

            {/* Forums read posts as a page, so the thread drawer stays shut. */}
            <ThreadPanelSlot open={Boolean(threadRoot) && presentation !== "feed"} expanded={threadExpanded}>
              {lastThreadRoot && channel && presentation !== "feed" && (
                <ThreadPanel
                  root={lastThreadRoot}
                  rootTitle={subjectOf(lastThreadRoot)}
                  transport={transport}
                  relayUrl="dm"
                  groupId={channel.idHex}
                  canWrite={canWrite}
                  mentionPubkeys={memberPubkeys}
                  botCommands
                  conversationRelays={community?.relays}
                  encryptAttachments
                  disappearingTimer={resolveMessageTimer}
                  autoFocus={threadAutoFocus}
                  open={Boolean(threadRoot)}
                  onClose={closeThread}
                  onExpandChange={setThreadExpanded}
                />
              )}
            </ThreadPanelSlot>

            <div
              className={cn(
                "overflow-hidden",
                "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
                "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
                membersOpen ? "" : "pointer-events-none sidebar:pointer-events-auto",
                membersVisible && "sidebar:w-[16.5rem]",
              )}
            >
              <div
                className={cn(
                  "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                  membersOpen ? "transform-none" : "translate-x-full",
                  membersVisible ? "sidebar:transform-none" : "sidebar:translate-x-full",
                )}
              >
                <div aria-hidden className="absolute inset-0 -z-10 bg-background sidebar:hidden" />
                <MemberList
                  admins={panelAdmins}
                  members={panelMembers}
                  currentUserPubkey={user?.pubkey}
                  roleCatalog={roleCatalog}
                  memberRoleIds={memberRoleIds}
                  roleSections={panelSections}
                  onAddMembers={addableChannelRoles.length > 0 ? openAddMembers : undefined}
                  onClose={closeMembers}
                />
              </div>
            </div>
          </div>
      </ChatShell>

      {/* Dialogs are built on first open (MountWhenOpened). */}
      <MountWhenOpened open={inviteOpen}>
        <InviteDialog community={community} open={inviteOpen} onOpenChange={setInviteOpen} canCreateLink={iAmAdminOrOwner} />
      </MountWhenOpened>
      {panelChannel?.isPrivate && (
        <MountWhenOpened open={addMembersOpen}>
          <AddChannelMembersDialog
            open={addMembersOpen}
            onOpenChange={setAddMembersOpen}
            channelName={panelChannel.name}
            candidates={addMemberCandidates}
            roles={addableChannelRoles}
            onAdd={(pk, roleId) => handleToggleRole(pk, roleId, true)}
            isAdding={roleIntent.isPending}
            hasRole={(pk, roleId) => roleIntent.rolesFor(pk).includes(roleId)}
            holdsKey={privateChannelsHere.some((c) => c.idHex === panelChannel.idHex && c.heldByMe)}
          />
        </MountWhenOpened>
      )}
      <MountWhenOpened open={shareDiscoverOpen}>
        <ShareToDiscoverDialog
          open={shareDiscoverOpen}
          onOpenChange={setShareDiscoverOpen}
          communityId={community?.idHex}
        />
      </MountWhenOpened>
      <MountWhenOpened open={banTargets !== null}>
        <BanMemberDialog
          targets={banTargets}
          willRotate={banWillRotate}
          onClose={() => setBanTarget(null)}
          onConfirm={runBan}
        />
      </MountWhenOpened>
      <MountWhenOpened open={kickTargets !== null}>
        <KickMembersDialog
          targets={kickTargets}
          onClose={() => setKickTarget(null)}
          onConfirm={runKick}
        />
      </MountWhenOpened>
      <MountWhenOpened open={rotateKeysOpen}>
        <RotateKeysDialog
          open={rotateKeysOpen}
          memberCount={memberPubkeys.length}
          privateChannelCount={community?.privateChannels.length ?? 0}
          strandsForeignLinks={rotateStrandsForeignLinks}
          onClose={() => setRotateKeysOpen(false)}
          onConfirm={runRotateKeys}
        />
      </MountWhenOpened>
      <MountWhenOpened open={Boolean(categoryPrompt)}>
        <CategoryNameDialog
          open={Boolean(categoryPrompt)}
          initial={categoryPrompt?.initial ?? ""}
          count={categoryPrompt?.channels.length ?? 0}
          onOpenChange={(next) => !next && setCategoryPrompt(null)}
          onSubmit={(name) => categoryPrompt && void refileCategory(categoryPrompt.channels, name)}
        />
      </MountWhenOpened>
      </ConcordMediaHold>
    </MemberActionsContext.Provider>
    </MemberRolesContext.Provider>
    </ChannelNavContext.Provider>
  );
}
