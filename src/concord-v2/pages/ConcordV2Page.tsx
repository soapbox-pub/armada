import { AtSign, Ban, CalendarClock, CheckCheck, ChevronDown, ChevronLeft, Bell, BellOff, Folder, FolderGit2, Hash, Headphones, Link as LinkIcon, Loader2, Lock, LogOut, Megaphone, MessagesSquare, MoreVertical, Phone, Pin, Plus, RefreshCw, ScrollText, Search, Settings, Shield, Timer, Trash2, UserPlus, Users, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { AppStageSlot } from "@/components/chat/AppStage";
import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef, getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { LoginArea } from "@/components/auth/LoginArea";
import { JoinButton } from "@/components/auth/JoinButton";
import { MemberList } from "@/components/chat/MemberList";
import { ProfileRelayHints } from "@/components/ProfileRelayHints";
import { ChannelCategoryHeading2 } from "@/concord-v2/components/ChannelCategoryHeading2";
import { categoryKey, categoryNames, groupChannelsByCategory } from "@/concord-v2/lib/channelCategory";
import {
  applyArrangement,
  arrangementChanges,
  arrangementSettled,
  pendingFromPlan,
  planChannelDrop,
  type PendingArrangement,
} from "@/concord-v2/lib/channelArrangement";
import { useChannelDrag, type ChannelDrop, type ChannelDropSlot } from "@/concord-v2/hooks/useChannelDrag";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { CalendarEventsBar } from "@/components/chat/CalendarEventsBar";
import { PinnedBar2 } from "@/concord-v2/components/PinnedBar2";
import { CreateEventDialog } from "@/components/dialogs/CreateEventDialog";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { GitTimelineRow, TicketSidePanel } from "@/components/chat/GitTimeline";
import { isGitTimelineEntry, mergeChannelTimeline } from "@/components/chat/channelTimeline";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { VoiceParticipantList } from "@/components/VoicePresence";
import { CommunityInfoDialog2 } from "@/concord-v2/components/CommunityInfoDialog2";
import { AddChannelMembersDialog } from "@/concord-v2/components/AddChannelMembersDialog2";
import { ImageLightbox2 } from "@/concord-v2/components/ImageLightbox2";
import { InviteDialog2 } from "@/concord-v2/components/InviteDialog2";
import { ShareToDiscoverDialog } from "@/concord-v2/components/ShareToDiscoverDialog";
import { RolesDialog2 } from "@/concord-v2/components/RolesDialog2";
import { AuditLogView } from "@/concord-v2/components/AuditLogView2";
import { BannedView } from "@/concord-v2/components/BannedView2";
import { SuspiciousActivityBanner2 } from "@/concord-v2/components/SuspiciousActivityBanner2";
import { useBanSelfRemove2 } from "@/concord-v2/hooks/useBanSelfRemove2";
import { useLinkAuthorityWatch2, useLinkFreshnessWatch2 } from "@/concord-v2/hooks/useInvites2";
import { InvitesView } from "@/concord-v2/components/InvitesView2";
import { MembersView } from "@/concord-v2/components/MembersView2";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { MemberRolesContext, type MemberRolesValue } from "@/contexts/MemberRolesContext";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import type { AppScope } from "@/contexts/AppsContext";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { useAppContext } from "@/hooks/useAppContext";
import { usePerfMilestone } from "@/hooks/usePerfMilestone";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import { useCall } from "@/hooks/useCall";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useAuthor } from "@/hooks/useAuthor";
import { useChannelGitActivity } from "@/hooks/useChannelGitActivity";
import { useGitProjects } from "@/hooks/useGitProjects";
import { useGitWorkItemActions, type GitWorkItemRepository } from "@/hooks/useGitWorkItemActions";
import { NewChannelDialog2, type WizardRepository } from "@/concord-v2/components/NewChannelDialog2";
import { NewIssueDialog } from "@/components/projects/NewIssueDialog";
import { ProjectsView } from "@/components/projects/ProjectsView";
import type { ProjectWorkItem } from "@/components/projects/projectData";
import { useCommunityGitActivity } from "@/hooks/useCommunityGitActivity";
import { useNewMessagesDivider } from "@/hooks/useNewMessagesDivider";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useSyncTasks } from "@/hooks/useSyncActivity";
import { useSyncTopicState } from "@/sync/useSyncTopic";
import { concordChannelMuteKey, useMutes } from "@/hooks/useMutes";
import { useNotifLevels, concordChannelScopeKey } from "@/hooks/useNotifLevels";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { toast } from "@/hooks/useToast";
import { useCommunity2, useCommunityList2, useIsExcluded2 } from "@/concord-v2/hooks/useCommunityList2";
import { channelDecodeDeadEnd } from "@/concord-v2/lib/channelSync";
import { activateScope, concord2Scope } from "@/wire/activation";
import { useCommunityManagement2, useStrandedRecovery2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useChannels2, useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { usePins2 } from "@/concord-v2/hooks/usePins2";
import { BanMemberDialog } from "@/concord-v2/components/BanMemberDialog2";
import type { BanPhase } from "@/concord-v2/hooks/useModeration2";
import { hasForeignLiveLinks } from "@/concord-v2/lib/control";
import { replyTargetOf } from "@/concord-v2/lib/chat";
import { communityTimerNotice } from "@/concord-v2/lib/disappearing";
import { sweepExpiredCommunityRumors } from "@/concord-v2/lib/rumorStore";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useGuestbook2 } from "@/concord-v2/hooks/useGuestbook2";
import { useModeration2, useReadCutRetry2 } from "@/concord-v2/hooks/useModeration2";
import { useChannelRekey2, useChannelRekeyWatch2, useLinkRefreshWatch2, useRekeyWatch2 } from "@/concord-v2/hooks/useRekey2";
import { useInviteActions2 } from "@/concord-v2/hooks/useInvites2";
import { channelsHingingOn, isEntitled } from "@/concord-v2/lib/channelAccess";
import { bytesToHex } from "@/concord-v2/lib/derive";
import { useRelayFollow2 } from "@/concord-v2/hooks/useRelayFollow2";
import { useRoleIntent } from "@/concord-v2/hooks/useRoleIntent";
import { useRoles2, useStaffKeyWatch2 } from "@/concord-v2/hooks/useRoles2";
import { useSendMessage2 } from "@/concord-v2/hooks/useChannel2";
import { useTransport2 } from "@/concord-v2/hooks/useTransport2";
import { useConcord2Unread, type Concord2Unread } from "@/concord-v2/hooks/useConcord2Unread";
import { useConcord2Mentions } from "@/concord-v2/hooks/useConcord2Mentions";
import { useConcordSearch2 } from "@/concord-v2/hooks/useConcordSearch2";
import { SearchFiltersPopover, SearchResultsView } from "@/concord-v2/components/Search2";
import { EMPTY_SEARCH_FILTERS, type SearchFilters2 } from "@/concord-v2/lib/search";
import { useConcord2Threads, type Concord2Thread } from "@/concord-v2/hooks/useConcord2Threads";
import { useTyping2, useTypingPublisher2 } from "@/concord-v2/hooks/useTyping2";
import { resolveVoiceBroker, useVoiceBroker2, useVoicePresence2 } from "@/concord-v2/hooks/useVoice2";
import type { VoicePresenceFold } from "@/concord-v2/lib/voice";
import { useRegisterChannelStreamKeys2 } from "@/concord-v2/hooks/useStreamAuth2";
import { completeMemberlist } from "@/concord-v2/lib/guestbook";
import { badgeOf, byDisplayOrder, canActOnMember, canActOnPosition, isAuthorized, isAuthorizedIn, MAX_ROLES_PER_MEMBER, Permissions } from "@/concord-v2/lib/roles";
import { channelGitRepositoryAttachments, NAME_MAX_BYTES, type ChannelV2, type CommunityV2, type ImagePointer } from "@/concord-v2/lib/types";
import { matchGitTicketRepository, parseGitRepositoryAddress, sortAndDedupeGitTimelineActivities, trustedGitStatusAuthors, type GitComment, type GitStatusKind, type GitTicket } from "@/lib/gitActivity";
import { cn, pickDefaultChannel } from "@/lib/utils";
import { chatRoute, parseChatRoute, type ChatRoute, type Concord2Pane } from "@/lib/routes";
import { useLegacyFocusParams } from "@/hooks/useLegacyFocusParams";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortTimeAgo } from "@/lib/formatTime";

import { authorsByRecency, threadSummary } from "@/components/chat/transport";
import type { ChatMsg, MessageCalendar, MessagePoll, MessageReactions, MessageZaps, OnchainZapAnnouncement, SendStatus, ZapPayment } from "@/components/chat/transport";

/** Stable empty replies array so a thread-less row keeps a constant prop. */
const EMPTY_REPLIES: ChatMsg[] = [];

/** The community's decrypted icon for the channel-list title. Renders nothing
 *  when the community has no icon (the header falls back to a name-only
 *  layout). */
function TitleIcon2({ icon }: { icon: ImagePointer | undefined }) {
  const url = useDecryptedImage2(icon);
  if (!url) return null;
  return <img src={url} alt="" className="size-6 rounded object-cover shrink-0" />;
}

/** Larger community avatar for the mobile chat header, with an initial fallback. */
function TitleAvatar2({ icon, name }: { icon: ImagePointer | undefined; name: string | undefined }) {
  const url = useDecryptedImage2(icon);
  if (url) {
    return <img src={url} alt="" className="size-8 rounded object-cover shrink-0" />;
  }
  return (
    <div className="size-8 rounded shrink-0 bg-muted text-muted-foreground flex items-center justify-center text-sm font-semibold uppercase">
      {name?.trim()?.[0] ?? "#"}
    </div>
  );
}

function Banner2({ banner }: { banner: ImagePointer | undefined }) {
  const url = useDecryptedImage2(banner);
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
      {open && <ImageLightbox2 src={url} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Concord V2 inline-reply context: resolve the replied-to rumor from the
 *  in-memory decoded set (rumors aren't relay-fetchable) and render the shared
 *  "replying to …" chrome. Clicking jumps the timeline to the parent. */
function ReplyContext2({ parent, onJump }: { parent: ChatMsg | undefined; onJump: (id: string) => void }) {
  const author = useAuthor(parent?.pubkey);
  const name = useScopedDisplayName(parent?.pubkey, author.data?.metadata);
  if (!parent) return null;
  const image = firstImageRef(parent);
  return (
    <ReplyContextLine
      name={name}
      pubkey={parent.pubkey}
      preview={<ReplyPreview content={parent.content} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(parent.id)}
    />
  );
}

interface ChatMessage2Props {
  /** Channel route for "Copy message link" (see ChatMessage.permalink). */
  permalink?: ChatRoute;
  event: ChatMsg;
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
  sendStatus: SendStatus | undefined;
  active: boolean;
  onToggleActive: (id: string) => void;
  onOpenThread: ((event: ChatMsg) => void) | undefined;
  onReply: ((event: ChatMsg) => void) | undefined;
  /**
   * The inline reply's parent: its id (undefined when this isn't a reply) and
   * the resolved message (undefined when it isn't in the decoded set). Passed
   * as plain values rather than a ready-made element — a fresh element on every
   * caller render would defeat this component's `memo` for every reply row.
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

/** Memoized per-message binding (mirrors V1's ConcordChatMessage). A normal
 *  reply quotes the parent inline (`onReply`); "reply in thread" opens the
 *  thread panel (`onOpenThread`). */
const ChatMessage2 = memo(function ChatMessage2({
  event,
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
  const threadInfo = threadSummary(replies);
  const replyContext = replyToId ? (
    <ReplyContext2 parent={replyParent} onJump={onJumpToReply} />
  ) : undefined;
  // Concord V2 messages are unsigned rumors sealed at the channel's stream
  // address — there's no relay-addressable event id, so the "Copy message ID" /
  // "View on Ditto" off-ramps are nonsensical. Pass the rumor through so the
  // context menu offers "View event JSON" instead.
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
  return (
    <ChatMessage
      event={event}
      rumor={rumor}
      canWrite={canWrite}
      canModerate={canModerate}
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
      onRetry={onRetry ? () => onRetry(event) : undefined}
      onDiscard={onDiscard ? () => onDiscard(event.id) : undefined}
      isEditing={isEditing}
      onEdit={onEdit}
      onEditSubmit={onEditSubmit}
      onEditCancel={onEditCancel}
      permalink={permalink}
    />
  );
});

/**
 * The pinned footer for the V2 channel sidebar: the persistent voice call-bar
 * slot (the call UI portals here, above the account area) — mirroring the
 * NIP-29 ChannelSidebar footer. Each rendered instance (desktop pane + mobile
 * drawer) registers its own slot.
 */
function SidebarFooter2() {
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
      {/* Voice call bar slot — the persistent call UI portals here. */}
      <div ref={ref} className="empty:hidden shrink-0 px-2 pb-2" />
      {/* Account area. The inner pb-2 mirrors the composer's inner `p-2` so the
          switcher and the chat composer end at the SAME line above the safe-area
          inset (without it the switcher sat ~8px lower). */}
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

/**
 * Names a category, for one channel being filed under a new one or for every
 * channel in an existing one being renamed. It is the same act either way: a
 * category has no id, so its name IS the thing, and both cases end in the same
 * `onSubmit(name)` re-filing the channels it was handed.
 *
 * A prefilled name that comes back unchanged is a no-op rather than N
 * pointless editions.
 */
function CategoryNameDialog2({
  open,
  initial,
  count,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  /** How many channels the name will be applied to, for the button's copy. */
  count: number;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const trimmed = value.trim();
  const unchanged = trimmed === initial.trim();
  const renaming = Boolean(initial);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={renaming ? "Rename category" : "New category"}>
        {/* The house dialog header: centered crest + lowercase mono heading.
            It also gives the shell's close button its own row — the form used
            to start flush at the top, putting the X over the input's corner. */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Folder className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {renaming ? "rename category" : "new category"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {renaming
              ? count > 1
                ? `Renames it for all ${count} channels in it — a category is only ever the channels naming it, so each one is re-filed.`
                : "A category is only ever the channels naming it, so renaming re-files the channel in it."
              : "A heading to group channels under in the sidebar. It exists for as long as a channel is in it."}
          </p>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || unchanged) {
              onOpenChange(false);
              return;
            }
            onSubmit(trimmed);
            onOpenChange(false);
          }}
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="channel-category-name"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Category name
            </Label>
            <Input
              id="channel-category-name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. Voice"
              autoComplete="off"
              autoFocus
              maxLength={NAME_MAX_BYTES}
              className="bg-background/40 border-transparent"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={!trimmed || unchanged}>
              {renaming ? "Rename" : "Create"}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}

const ChannelRow2 = memo(function ChannelRow2({
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
  community: CommunityV2 | undefined;
  channel: ChannelV2;
  active: boolean;
  /** Whether the user's current call is THIS channel's voice room. */
  inCall: boolean;
  /** Live speaker set (only passed when `inCall`), for roster voice activity. */
  speaking?: ReadonlySet<string>;
  /** Live muted set (only passed when `inCall`), for the roster mute indicator. */
  muted?: ReadonlySet<string>;
  unread?: Concord2Unread;
  onSelect: (channelIdHex: string) => void;
  onJoinVoice: (channel: ChannelV2, broker: string | null, fold?: VoicePresenceFold) => void;
  /** Category names already in use, offered so near-duplicates aren't retyped. */
  categories?: string[];
  /** Undefined for a member without MANAGE_CHANNELS: no filing menu at all. */
  onSetCategory?: (channelIdHex: string, category: string | undefined) => void;
  /** Opens the naming prompt — a context menu is a poor place for a text field. */
  onNewCategory?: (channel: ChannelV2) => void;
}) {
  // Every Channel is callable (CORD-07): live presence drives the Discord-style
  // nested roster under the row whenever a call is active, and the rendezvous
  // broker is resolved ahead of the click so joining a call is instant.
  const fold = useVoicePresence2(community, channel);
  const { data: broker } = useVoiceBroker2(channel, fold);
  const { voiceRoomPubkeys } = useCall();
  const { isConcordChannelMuted } = useMutes();
  const { concordChannelLevel, setLevel: setNotifLevel } = useNotifLevels();
  const muted = community
    ? isConcordChannelMuted("c2", community.idHex, channel.idHex)
    : false;
  const foldedParticipants = useMemo(() => fold.present.map((p) => p.author), [fold]);
  // Raised hands (Armada client feature) read straight off the presence fold,
  // so the roster shows them even for a call you haven't joined.
  const raisedVoice = useMemo(
    () => new Set(fold.present.filter((p) => p.hand).map((p) => p.author)),
    [fold],
  );
  // While YOU are in this call, the connected room's live LiveKit roster is
  // authoritative — presence heartbeats lag (30s cadence, 90s staleness) and
  // desync. Folded presence remains the source for calls you're not in.
  const participants = inCall && voiceRoomPubkeys ? voiceRoomPubkeys : foldedParticipants;

  const Icon = channel.isPrivate ? Lock : Hash;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  // A call is live in this channel when anyone is present.
  const occupied = participants.length > 0;
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
                // Slack-style selection: the active channel sits on a filled primary
                // rectangle with the house cut-corner chamfer (matches ChannelSidebar).
                "flex flex-1 min-w-0 items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left",
                !active && "text-muted-foreground group-hover/row:text-foreground",
                // Unread (but not selected) channels read brighter + bold (Slack).
                // Muted channels never bold — their unread is deliberately silent.
                !active && hasUnread && !muted && "text-foreground font-semibold",
                // Muted channels read dimmer (Discord-style).
                !active && muted && "opacity-60",
                active && "font-medium",
              )}
            >
              <Icon className={cn("size-4 shrink-0", occupied && !active && "text-success")} />
              <span className="truncate flex-1 min-w-0">{channel.name}</span>
              {inCall && <Headphones className={cn("size-3.5 shrink-0", !active && "text-success")} />}
              {muted && <BellOff className="size-3 shrink-0 opacity-60" aria-label="Muted" />}
              {/* Mention indicator: an "@" pill. Plain unread is conveyed by the row's
                  brighter + bold text (no dot). */}
              {hasMention ? (
                <span
                  className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
                  aria-label="You were mentioned"
                >
                  @
                </span>
              ) : null}
            </button>
            {/* Quick call CTA (Discord-style): join/start a call in this channel
                without leaving the list. Always visible while a call is live;
                otherwise appears on hover/focus (desktop only — touch devices
                have no hover, so it stays hidden there until a call is live). */}
            {!inCall && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onJoinVoice(channel, broker ?? null, fold);
                }}
                aria-label={occupied ? "Join call" : "Start call"}
                title={occupied ? "Join call" : "Start call"}
                className={cn(
                  "shrink-0 flex items-center justify-center size-7 mr-1 rounded transition-opacity",
                  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                  // No hover on touch devices: keep it hidden there unless a call
                  // is already live in the channel.
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
          {/* Discord-style nested voice roster: who's in the call, under the row
              (with live speaking rings while you're in it). Shown whenever a
              call is live in the channel. */}
          {occupied && (
            <VoiceParticipantList
              participants={participants}
              speaking={speaking}
              muted={mutedVoice}
              raised={raisedVoice}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {community && (
          <NotifLevelMenu
            label="Channel notifications"
            level={concordChannelLevel("c2", community.idHex, channel.idHex)}
            onChange={(lvl) =>
              setNotifLevel(concordChannelScopeKey("c2", community.idHex, channel.idHex), lvl)
            }
          />
        )}
        {onSetCategory && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Folder className="mr-2 size-4" />
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
 * The community-wide "@ Mentions" pane: every cached kind-9 message that
 * p-tags the current user, across all channels, newest-first — read purely
 * from the local decrypted rumor cache. Each message is grouped under a header
 * naming its source channel; clicking a mention jumps to that message in its
 * channel. The rows reuse the shared `ChatMessage` shell (read-only — no
 * react/reply/delete in this aggregate view).
 */
function MentionsView({
  channels,
  mentions,
  isLoading,
  onJump,
}: {
  channels: ChannelV2[];
  mentions: ChatMsg[];
  isLoading: boolean;
  onJump: (channelIdHex: string, messageId: string) => void;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, ChannelV2>();
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
              {ch?.isPrivate ? (
                <Lock className="size-3 shrink-0" />
              ) : (
                <Hash className="size-3 shrink-0" />
              )}
              <span className="truncate">{ch?.name ?? "unknown channel"}</span>
            </div>
            <MentionMessage
              event={msg}
              onJump={ch ? () => onJump(channelIdHex, msg.id) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A single read-only mention row (unsigned rumor → "View event JSON" menu).
 * The row is a button that jumps to the message in its channel; the inner
 * `ChatMessage`'s own controls (context menu, links) stop propagation so they
 * still work, and text remains selectable.
 */
const MentionMessage = memo(function MentionMessage({
  event,
  onJump,
}: {
  event: ChatMsg;
  onJump?: () => void;
}) {
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
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
      className={cn("clip-corner-lg", onJump && "cursor-pointer hover:bg-foreground/5 transition-colors")}
      aria-label={onJump ? "Jump to this message" : undefined}
    >
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} />
    </div>
  );
});

/**
 * The community-wide "Threads" pane: every thread the current user has
 * participated in (authored the root or a reply), newest-reply first, read
 * purely from the local rumor cache. Each row shows the thread root plus a
 * reply summary; clicking it switches to that channel and opens the thread
 * panel. Unread rows (a newer reply than last opened) light up.
 */
function ThreadsView({
  channels,
  threads,
  isLoading,
  onOpen,
}: {
  channels: ChannelV2[];
  threads: Concord2Thread[];
  isLoading: boolean;
  onOpen: (thread: Concord2Thread) => void;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, ChannelV2>();
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
              {ch?.isPrivate ? (
                <Lock className="size-3 shrink-0" />
              ) : (
                <Hash className="size-3 shrink-0" />
              )}
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
              <ThreadRootPreview event={t.root} />
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
const ThreadRootPreview = memo(function ThreadRootPreview({ event }: { event: ChatMsg }) {
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
  return (
    <div className="pointer-events-none">
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} />
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
      <AvatarImage src={metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-[9px] font-semibold uppercase">
        {name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * A disappearing-messages timer change (CORD-08 §4), rendered as a centered
 * notice like the DM feed's — conversation state, not a message: no avatar,
 * no actions, no reactions.
 */
function TimerNotice2({ author, seconds, self }: { author: string; seconds: number; self: string | undefined }) {
  const a = useAuthor(author);
  const name = a.data?.metadata?.name ?? author.slice(0, 8);
  return (
    <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 select-none" role="status">
      <Timer className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="text-[11px] text-muted-foreground/80 text-center">
        {communityTimerNotice(seconds, author === self, name)}
      </span>
    </div>
  );
}

/**
 * A Concord V2 community — CORD-01..06 Private Streams over interchangeable
 * relays, no host, no `#z` tags: every plane is kind-1059 traffic at derived
 * stream addresses. Lives at `/c/:communityId`, rehydrated from the
 * self-encrypted Community List. Renders through the SAME shared chat
 * components as NIP-29 / DMs / Concord V1; only the transport differs.
 */
export function ConcordV2Page() {
  // The whole location, parsed once: which channel, which community-wide pane,
  // which thread, which message. Read through `parseChatRoute` rather than
  // `useParams` because the panes are static segments (they have no param to
  // read) and because it is the same parse the builder, the notification
  // producers and the analytics sanitizer use — one spelling of the route.
  const location = useLocation();
  const { pathname } = location;
  const route = useMemo(() => {
    const parsed = parseChatRoute(pathname);
    return parsed?.kind === "concord2" ? parsed : undefined;
  }, [pathname]);
  const communityId = route?.communityId;
  const routeChannelId = route?.channelId;
  const routePane = route?.pane;
  const routeThreadRoot = route?.threadRoot;
  const { user } = useCurrentUser();
  const navigateTo = useNavigate();
  // Whether the reply composer should take focus when the thread panel opens.
  // An intent belonging to the click that navigated, not to the location — a
  // shared link must not steal focus — so it rides in history state, which
  // stays out of the URL and survives Back/Forward.
  const threadAutoFocus = Boolean((location.state as { threadAutoFocus?: boolean } | null)?.threadAutoFocus);
  const isTouchDevice = useIsTouch();
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const { config, updateConfig } = useAppContext();
  const { mutedChannels, isCommunityMuted, toggleCommunityMute, toggleConcordChannelMute } = useMutes();
  const lastChannelKey = communityId ? `c2:${communityId}` : "";

  // Session activation: being navigated into makes this community "live" for
  // the rest of the session — the wire stops deferring it (unread-dot rule)
  // and the global control sweep gives it first turn (see wire/activation).
  useEffect(() => {
    if (communityId) activateScope(concord2Scope(communityId));
  }, [communityId]);

  const baseCommunity = useCommunity2(communityId);
  const { data: folded } = useControlFold2(baseCommunity);
  // Overlay the folded, owner-controlled metadata onto the bundle preview.
  const community = useMemo<CommunityV2 | undefined>(() => {
    if (!baseCommunity) return undefined;
    if (!folded?.metadata) return baseCommunity;
    return { ...baseCommunity, name: folded.metadata.name || baseCommunity.name };
  }, [baseCommunity, folded]);
  const channels = useChannels2(baseCommunity);
  // The serial gate in front of the timeline: the community has to rehydrate from
  // the list, the control plane has to be read and folded, and only then does a
  // ChannelV2 (with its derived stream keys) exist for the timeline query to be
  // ENABLED on. Each step gets a milestone so a profile shows which one the user
  // was actually waiting on, rather than one undifferentiated "slow".
  usePerfMilestone("page.community resolved", Boolean(baseCommunity));
  usePerfMilestone("page.control folded", Boolean(folded));
  usePerfMilestone("page.channels resolved", channels.length > 0);
  // Only show channel skeletons if there's nothing to render yet AND that has
  // lasted long enough to be worth a placeholder. On a cache hit the bundle
  // resolves within a frame or two, so the skeleton would otherwise flash for a
  // nanosecond — which reads as a glitch. Delay it so fast loads show nothing.
  // The list counts as "nothing to render" until the control fold resolves:
  // before that it holds only the bundle's private channels (public channels
  // exist only in the fold), and painting that fragment as if it were the
  // sidebar reads as the community having lost its channels.
  const showChannelSkeleton = useDelayedFlag(!community || !folded || channels.length === 0);

  // Categories are derived from the channels the member can actually see —
  // `channelsView` has already dropped any whose key they don't hold — so a
  // category all of whose channels are gated away simply isn't here. No
  // separate visibility rule to keep in step (see channelCategory.ts).
  /**
   * A drop the user has made but the control plane has not confirmed yet: one
   * edition per moved channel, each a signed publish, so waiting for the fold
   * would leave the row under the finger sitting where it was for as long as
   * the relay takes. The overlay is the planned arrangement, applied over the
   * folded channels and re-sorted by the same comparator `channelsView` uses,
   * so the sidebar reads exactly as it will once the editions land. It is
   * dropped when the fold agrees (below) or when the publish fails.
   */
  const [pendingArrangement, setPendingArrangement] = useState<PendingArrangement | null>(null);

  const arrangedChannels = useMemo(
    () => applyArrangement(channels, pendingArrangement),
    [channels, pendingArrangement],
  );

  // Let go of the overlay the moment the fold says the same thing, so a later
  // change from anyone else is never masked by a drop of ours that has landed.
  useEffect(() => {
    if (pendingArrangement && arrangementSettled(channels, pendingArrangement)) {
      setPendingArrangement(null);
    }
  }, [channels, pendingArrangement]);

  const { uncategorized: uncategorizedChannels, categories: channelCategories } = useMemo(
    () => groupChannelsByCategory(arrangedChannels, (c) => c.category),
    [arrangedChannels],
  );

  const categoryPicklist = useMemo(
    () => categoryNames(arrangedChannels, (c) => c.category),
    [arrangedChannels],
  );

  /**
   * The sidebar's rendered sequence, flattened — the uncategorized run then
   * each category's channels, exactly as drawn. A drop index is an index into
   * THIS, so the drag never has to translate between what the user sees and
   * how the fold happens to be ordered (channelArrangement.ts).
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
        // Don't leave an empty array behind for every community ever visited.
        if (collapsed.size > 0) next[idHex] = [...collapsed];
        else delete next[idHex];
        return { ...current, collapsedChannelCategories: next };
      });
    },
    [community?.idHex, updateConfig],
  );

  // Per-channel unread badges, computed purely from the local rumor cache
  // (which the wire keeps fed for every channel of every community).
  const gitAttachmentsByChannel = useMemo(() => new Map(channels.map((candidate) => [
    candidate.idHex,
    channelGitRepositoryAttachments(folded?.channels.get(candidate.idHex)?.metadata ?? { name: candidate.name, private: candidate.isPrivate }),
  ])), [channels, folded]);
  const communityGitActivity = useCommunityGitActivity(gitAttachmentsByChannel);
  // The Projects tab exists only once some channel is tied to a repository.
  const hasProjects = useMemo(
    () => [...gitAttachmentsByChannel.values()].some((list) => list.some((attachment) => attachment.detachedAt === undefined)),
    [gitAttachmentsByChannel],
  );
  const { byChannel: unreadByChannel, markRead: markChannelRead } = useConcord2Unread(community?.idHex, channels, communityGitActivity.byChannel);

  // "Mark all as read": stamp every unread channel to its newest unread
  // message (monotonic stamps, so already-read channels no-op).
  const markAllChannelsRead = useCallback(() => {
    for (const [idHex, unread] of Object.entries(unreadByChannel)) {
      markChannelRead(idHex, unread.latest);
    }
  }, [unreadByChannel, markChannelRead]);

  // Community-wide "@ Mentions" — every cached kind-9 that p-tags the user,
  // across all channels, served from the local rumor cache only. Its unread
  // indicator has its OWN read state (not the channel read state), so opening
  // the Mentions tab clears it without visiting every mentioning channel
  // (issue #53; see the auto-mark effect below).
  const {
    mentions,
    isLoading: mentionsLoading,
    hasNew: hasUnreadMention,
    markRead: markMentionsRead,
    markAllRead: markAllMentionsRead,
  } = useConcord2Mentions(channels, community?.idHex);

  // Community-wide "Threads" — threads the user participated in (authored the
  // root or a reply), newest-reply first, from the local rumor cache only.
  // Lights up when any has replies newer than the user last opened it; opening
  // the Threads pane marks everything in it read (see the auto-mark effect
  // below).
  const {
    threads,
    isLoading: threadsLoading,
    hasNew: hasNewThreadReplies,
    markRead: markThreadRead,
    markAllRead: markAllThreadsRead,
  } = useConcord2Threads(community?.idHex, channels);

  // Authenticate the connection as this community's per-channel stream keys
  // (control/guestbook/dissolved keys are registered app-wide in MainLayout).
  useRegisterChannelStreamKeys2(communityId);

  // React to base-rekey rotations (adopt the new epoch, or discover removal).
  // `stranded`: a stale invite dropped us onto a superseded epoch with no wire
  // path forward — the link is out of date and only a refresh/Direct Invite heals.
  const { stranded } = useRekeyWatch2(baseCommunity);
  // And per-held-private-channel rotations (CORD-06 §2): adopt fresh channel
  // keys or drop a channel we've been removed from. No-op without any.
  useChannelRekeyWatch2(baseCommunity);
  // Adopt the staff write key a promotion delivered inside my Grant
  // (CORD-04 §3): verify the control_wrap and record the control_root in the
  // vault, unlocking Control Plane writes on this and my other devices.
  useStaffKeyWatch2(baseCommunity);
  // Keep our OWN live invite links vending the current epoch (CORD-05 §2), so a
  // rotation on another device / by another admin doesn't leave them stale.
  useLinkRefreshWatch2(baseCommunity);
  // Follow the fold's relay list (CORD-02 §6): a Metadata edition that moves
  // the community's relays re-points this member (and, via the 13302
  // write-back, their other devices) at the new set.
  useRelayFollow2(baseCommunity);
  // Honest-client compliance: a stripped CREATE_INVITE means my own live
  // links must die — only my signer_sk can tombstone their bundles.
  useLinkAuthorityWatch2(baseCommunity);
  // Keep my live links' bundles vending the CURRENT community (metadata +
  // epoch): a stale coordinate otherwise serves old previews to Discover and
  // old keys to joiners until its creator happens to re-mint.
  useLinkFreshnessWatch2(baseCommunity);
  // Durable read-cut: finish a rotating ban's rotation that a relay outage
  // dropped, from the keep-list persisted at ban time. Mounted ONCE here.
  useReadCutRetry2(baseCommunity);
  // Stranded self-heal: while stranded, quietly re-resolve the link we joined
  // through; once its creator refreshes the bundle, merge the fresh epoch in.
  const { canRecover, checking: recoveryChecking, checkNow: recoveryCheckNow } = useStrandedRecovery2(baseCommunity, stranded);

  // Kicked/banned: the community stays on the rail but goes read-only (the
  // composer is swapped for a banner). Cleared automatically if re-included.
  const excluded = useIsExcluded2(communityId);

  // Seeded from the route when it names a channel, else from the persisted
  // last-open channel for this community — synchronously available from app
  // config. Knowing the channel id at FIRST render is what lets the timeline
  // snapshot prewarm and paint before the control fold has resolved anything
  // (a community-only URL previously had no id until the fold, so the
  // snapshot never engaged and the chat pane sat on a skeleton).
  // `pickDefaultChannel` prefers this same stored id once channels resolve,
  // and a stale id (channel since deleted) falls back to the first channel —
  // but only once the control fold has resolved and the miss is therefore
  // real (see the `channel` memo below).
  // The route names the channel. When it doesn't — the community root, or a
  // community-wide pane, both of which leave the channel implicit — fall back
  // to the persisted last-open channel, which app config makes available
  // synchronously on the first render. That fallback is what lets the timeline
  // snapshot prewarm and paint before the control fold has resolved anything.
  const channelIdHex = routeChannelId ?? (lastChannelKey ? config.lastChannelByServer[lastChannelKey] ?? null : null);
  // Which pane the main area shows: the selected channel's chat, or one of the
  // community-wide panes. Navigating to a channel returns to chat by virtue of
  // the route no longer naming a pane.
  const view: "channel" | Concord2Pane = routePane ?? "channel";
  const selectChannel = useCallback(
    (idHex: string) => {
      if (!communityId) return;
      navigateTo(chatRoute({ kind: "concord2", communityId, channelId: idHex }));
    },
    [communityId, navigateTo],
  );
  const selectPane = useCallback(
    (pane: Concord2Pane) => {
      if (!communityId) return;
      navigateTo(chatRoute({ kind: "concord2", communityId, pane }));
    },
    [communityId, navigateTo],
  );
  // Projects data loads lazily: the first time the tab is opened this session,
  // or when a ticket conversation opens (its trust set and thread need it).
  const [projectsTouched, setProjectsTouched] = useState(false);
  const [openTicket, setOpenTicket] = useState<GitTicket | undefined>();
  const channelNameById = useMemo(() => new Map(channels.map((c) => [c.idHex, c.name])), [channels]);
  const projects = useGitProjects(gitAttachmentsByChannel, channelNameById, projectsTouched || Boolean(openTicket));
  const timelineRef = useRef<MessageTimelineHandle | null>(null);
  // Clicking a mention: navigate to its channel with the message focused. The
  // cross-channel wait is the permalink's — `/m/<id>` names the target, and
  // the hunt resolves it once that channel's timeline has it — so there is no
  // pending-jump state to keep in step with the route.
  const jumpToMention = useCallback(
    (channelIdHex: string, messageId: string) => {
      if (!communityId) return;
      navigateTo(chatRoute({ kind: "concord2", communityId, channelId: channelIdHex, messageId }));
      setChannelsOpen(false);
    },
    [communityId, navigateTo],
  );
  // Opening a thread from the Threads tab: navigate straight to the thread's
  // own route, in whichever channel it lives. Marks it read and drops its
  // "new" highlight (the auto-mark below keeps rows lit for the visit, but
  // actually opening one means it's been read for real).
  const openThreadFromList = useCallback(
    (thread: Concord2Thread) => {
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
          kind: "concord2",
          communityId,
          channelId: thread.channelIdHex,
          threadRoot: thread.root.id,
        }),
      );
      setChannelsOpen(false);
    },
    [communityId, navigateTo, markThreadRead],
  );

  // Having the Mentions pane on screen counts as reading it, same as Threads
  // below: the list is flat and newest-first, so the pane being visible means
  // the newest mention is too — advance the last-seen stamp immediately, and
  // again as new mentions land while the pane stays open. Visibility-gated so
  // a background tab doesn't silently eat the badge. (Unlike Threads there's
  // no per-row "new" highlight to preserve, so no snapshot.)
  useEffect(() => {
    if (view !== "mentions" || !user || !hasUnreadMention) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markAllMentionsRead();
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [view, user, hasUnreadMention, markAllMentionsRead]);

  // Having the Threads pane on screen counts as reading it: every listed
  // thread with unseen replies is marked read (the sidebar dot clears by just
  // looking — no manual "mark all"), immediately and as new replies or the
  // initial scan land while the pane stays open. The rows keep their "new"
  // highlight for the visit, though: `freshThreadIds` snapshots each root as
  // it's auto-cleared so the visual survives the read map advancing, and
  // resets on leaving the pane. Visibility-gated like the channel read stamp
  // below, so a background tab doesn't silently eat unread threads.
  const [freshThreadIds, setFreshThreadIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (view !== "threads") {
      setFreshThreadIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    if (!user || !hasNewThreadReplies) return;
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
  }, [view, user, hasNewThreadReplies, threads, markAllThreadsRead]);

  // What the Threads pane renders: the live list, with the just-auto-cleared
  // roots still lit as "new" for this visit.
  const displayedThreads = useMemo(
    () =>
      threads.map((t) =>
        !t.hasNew && freshThreadIds.has(t.root.id) ? { ...t, hasNew: true } : t,
      ),
    [threads, freshThreadIds],
  );
  // Let `#channel-name` hashtags in chat jump to that local channel.
  const navChannels = useMemo(
    () => channels.map((c) => ({ name: c.name, go: () => selectChannel(c.idHex) })),
    [channels, selectChannel],
  );
  const channelNav = useChannelNavValue(navChannels);

  // Until the control fold resolves, `channels` holds ONLY the private
  // channels carried in the bundle (channelsView renders held keys without
  // waiting for the fold) — a public channel named by the URL is not findable
  // yet. So before the fold, a miss means "not known yet", not "deleted": stay
  // unresolved rather than falling back, or the reader is dropped into the
  // first private channel, yanked to the right one when the fold lands, and
  // the wrong id is persisted as last-open along the way. Same for the
  // default pick on a channel-less URL, which the canonicalize effect below
  // would otherwise write into the address bar for good.
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

  // The chat scope for in-message app affordances (a `.xdc` launch card) and
  // the top-of-chat app stage. Present only once both community + channel
  // resolve; drives `useChatScope()` and `<AppStageSlot>` like the NIP-29 /
  // Concord v1 pages do.
  const appScope = useMemo<AppScope | undefined>(
    () => (community && channel ? { kind: "concord2", community, channel } : undefined),
    [community, channel],
  );

  // Individual mute states for the ⋮ menu. Like GroupPage, the side-by-side
  // "Mute channel" / "Mute community" items each reflect only their own scope
  // (no cascade), so a muted community doesn't flip the channel item.
  const channelMuted = Boolean(
    community && channel &&
    mutedChannels.has(concordChannelMuteKey("c2", community.idHex, channel.idHex)),
  );
  const communityMuted = Boolean(community && isCommunityMuted(`c2:${community.idHex}`));

  useEffect(() => {
    if (!lastChannelKey || !channel) return;
    updateConfig((c) =>
      c.lastChannelByServer[lastChannelKey] === channel.idHex
        ? c
        : { ...c, lastChannelByServer: { ...c.lastChannelByServer, [lastChannelKey]: channel.idHex } },
    );
  }, [channel, lastChannelKey, updateConfig]);

  // Canonicalize the community root: `/c/<id>` resolves a default channel to
  // render, so name it in the URL once it is known. Without this the address
  // bar keeps claiming the community while the reader is looking at a
  // channel — and "Copy message link" would build a link that lands elsewhere
  // for anyone whose default resolves differently.
  //
  // `replace`, because this is the app finishing the reader's navigation
  // rather than a new one: a pushed entry here would make Back bounce between
  // the bare URL and its own redirect. A pane route is already canonical and
  // deliberately leaves the channel implicit, so it is left alone.
  useEffect(() => {
    if (!communityId || routeChannelId || routePane || !channel) return;
    navigateTo(chatRoute({ kind: "concord2", communityId, channelId: channel.idHex }), {
      replace: true,
    });
  }, [communityId, routeChannelId, routePane, channel, navigateTo]);

  const { setTier, setMemberRoles } = useRoles2(community);
  const { sendDirectInvite } = useInviteActions2(community);
  const { rekeyChannel, canRekeyChannel } = useChannelRekey2(community);
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const roster = folded?.roster;
  const canManageRoles = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_ROLES));
  const canManageMetadata = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_METADATA));
  const canManageChannels = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS));
  const canCreateInvite = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.CREATE_INVITE));
  // Only the owner and admins may mint a shareable invite link. A plain member
  // still opens the invite dialog and invites people one by one (direct key
  // handoff); the link section is hidden from them. Same owner-or-admin gate the
  // Discover share below uses.
  const iAmAdminOrOwner = Boolean(user && (iAmOwner || (roster ? badgeOf(roster, user.pubkey) === "admin" : false)));
  const canKickAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.KICK));
  const canBanAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.BAN));
  // Channel-targeted authority honors role scope: a Role scoped to one channel
  // moderates there and nowhere else (its bits are inert outside it).
  const canModerateMessages = Boolean(
    user && folded && channel &&
    isAuthorizedIn(folded.roster, user.pubkey, ownerHex, channel.idHex, Permissions.MANAGE_MESSAGES),
  );
  // A dissolved community is terminal: the owner has torn it down, so no key
  // rotation or new messages will ever land. Keep it fully readable (members
  // asked to still see the history), but freeze every write path.
  //
  // `excluded` (a moderator rotated the keys without us) and `stranded` (a stale
  // invite dropped us onto a superseded epoch) are equally write-dead: our new
  // messages would be encrypted to keys nobody keeps. All three replace the main
  // composer with a notice; folding them into `canWrite` freezes the same write
  // paths everywhere else too — timeline reply/edit and the thread composer.
  const { data: dissolved } = useDissolved2(community);
  const canWrite = Boolean(user && channel && !dissolved && !excluded && !stranded);

  const { transport: baseTransport, reactionsFor, allMessages, calendar, timerEntries, openedById } = useTransport2(community, channel, canWrite, canModerateMessages, channelIdHex);

  // Physically purge this community's expired disappearing messages
  // (CORD-08 §3) — the sweep self-gates to one walk per interval, and every
  // read path filters expired rows regardless, so this is hygiene, not a gate.
  const sweepIdHex = community?.idHex;
  useEffect(() => {
    if (sweepIdHex) void sweepExpiredCommunityRumors(sweepIdHex);
  }, [sweepIdHex]);

  // Pins (CORD-04 §7). Building a proof needs the ORIGINAL seal, not the
  // rendered message, so the toggle reaches back into the opened-rumor cache
  // by rumor id — the decrypted row alone can prove nothing.
  const pins = usePins2(community, channel, openedById);
  const togglePin = useCallback(
    (event: ChatMsg) => {
      const run = async () => {
        try {
          if (pins.isPinned(event.id)) {
            await pins.unpin({ rumorId: event.id });
            toast({ title: "Unpinned" });
            return;
          }
          const opened = openedById.get(event.id);
          if (!opened) throw new Error("That message isn't loaded here any more — scroll to it and try again.");
          await pins.pin({ opened });
          toast({ title: "Pinned", description: "Everyone in this channel can see it, now and after any key rotation." });
        } catch (e) {
          toast({ title: "Couldn't update pins", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
        }
      };
      void run();
    },
    [pins, openedById],
  );
  // Git activity remains its own event domain. The store-first channel hook
  // supplies attached repository activity; this page only merges its display
  // order with decrypted chat rumors.
  const gitAttachments = useMemo(
    () => channelGitRepositoryAttachments(folded?.channels.get(channel?.idHex ?? "")?.metadata ?? { name: channel?.name ?? "", private: Boolean(channel?.isPrivate) }),
    [folded, channel?.idHex, channel?.name, channel?.isPrivate],
  );
  const gitActivity = useChannelGitActivity(channel?.idHex, gitAttachments);
  const mixedEntries = useMemo(() => mergeChannelTimeline(baseTransport.messages, gitActivity.activities, timerEntries), [baseTransport.messages, gitActivity.activities, timerEntries]);
  // Memoized: this parallel array feeds a hook that settles once, and
  // rebuilding it on every page render was a full-timeline allocation per
  // keystroke/hover anywhere on the page.
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
    setOpenTicket(ticket);
    void projects.refreshTicket(ticket);
  }, [projects]);
  // The conversation panel merges gated channel activity with the Projects
  // view's full history, so a ticket opened from either surface reads complete.
  const panelActivities = useMemo(
    () => projects.activities.length === 0
      ? gitActivity.activities
      : sortAndDedupeGitTimelineActivities([...gitActivity.activities, ...projects.activities]),
    [gitActivity.activities, projects.activities],
  );
  const gitActions = useGitWorkItemActions();
  // The ticket's repository as this community holds it (address + trust set).
  // No first-tag fallback: `a` tag order is author-controlled, so guessing
  // could grant a fork owner status controls (and mis-tag emitted statuses)
  // while the projects data is still loading. Controls appear once it lands.
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
      ? async (ticket: GitTicket, content: string, media?: readonly string[][]) => {
          await gitActions.commentOnTicket(ticket, content, projects.relaysForCoordinates(ticket.repositoryAddresses.map((address) => address.coordinate)), media);
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
  const { mutateAsync: send } = useSendMessage2(community, channel);

  // (useActiveRoom is called below, after `threadRoot` is defined, so it can
  // also pass thread-level keys for notification suppression.)

  // Mark the open channel read up to its newest timeline entry (chat or git)
  // while it's on screen —
  // immediately and again on tab refocus (mirrors GroupChat's NIP-29 behavior).
  // Reading a channel naturally also consumes what it shows: mentions of the
  // user and new replies in threads they participate in get their own stamps
  // advanced too, so the Mentions/Threads tabs don't re-badge what was already
  // read here.
  const channelIdForRead = channel?.idHex;
  const readerPubkey = user?.pubkey;
  useEffect(() => {
    if (!readerPubkey || !channelIdForRead || mixedEntries.length === 0) return;
    const latest = mixedEntries[mixedEntries.length - 1]?.createdAt ?? 0;
    if (latest <= 0) return;

    // The newest visible mention of the user (never self-authored — the tab
    // doesn't surface self-mentions), and the newest visible reply per
    // participated thread.
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
      markChannelRead(channelIdForRead, latest);
      if (newestMention > 0) markMentionsRead(newestMention);
      for (const [root, ts] of replyStamps) markThreadRead(root, ts);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [readerPubkey, channelIdForRead, mixedEntries, allMessages, threads, markChannelRead, markMentionsRead, markThreadRead]);

  const { leave, isLeaving, dissolve, createChannel, privatiseChannel, setChannelCategory, arrangeChannels } =
    useCommunityManagement2(community);

  /**
   * File one channel, from the sidebar's own context menu — the same edition
   * the community-settings row publishes, just reachable where the arrangement
   * is actually visible.
   */
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

  /**
   * Re-file every channel in a category at once — what "rename" and "ungroup"
   * mean when a category is only ever the set of channels naming it. One
   * edition per channel, sequentially so a rate-limited relay doesn't drop
   * half of them, and each is independently version-chained (they are
   * different entities), so a failure part-way leaves a half-renamed category
   * rather than a corrupt one. Renaming onto a name already in use merges.
   */
  /** The column the drag pans by hand on touch (rows are `touch-action: none`). */
  const channelScrollRef = useRef<HTMLElement | null>(null);

  /**
   * Measure the drop points off the DOM at pickup. Each row offers two — its
   * top edge and its bottom edge — so the ends of every run and every category
   * are reachable without enumerating them; nearest-y wins.
   */
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
    // Only present once a drag is in flight, which is why the slots are
    // re-measured after the chrome mounts (useChannelDrag.ts). The channel
    // lands at the end of the sequence, so the index is the row count — each
    // row contributed two slots above.
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
      // A brand-new category has no name yet, so the drop becomes the naming
      // prompt; the channel is filed when it's answered.
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
      // Show the whole planned arrangement, not just the changed run: it is
      // what the sidebar will read once the editions land, and `before` was
      // itself read off the rendered order, so a second drag before the first
      // confirms plans against what the user is looking at.
      setPendingArrangement(pendingFromPlan(plan));
      void arrangeChannels(changes).catch((e: unknown) => {
        // Put the sidebar back: nothing was published, so the optimistic order
        // is a claim about the community that isn't true.
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

  const refileCategory = useCallback(
    async (members: readonly ChannelV2[], category: string | undefined) => {
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
  // Repositories already connected anywhere in this community (wizard dedupe).
  const connectedCoordinates = useMemo(
    () => new Set([...gitAttachmentsByChannel.values()].flatMap((list) => list.filter((a) => a.detachedAt === undefined).map((a) => a.address.coordinate))),
    [gitAttachmentsByChannel],
  );
  const { coalesced } = useGuestbook2(community);

  // Voice (CORD-07): the active channel's live presence + rendezvous broker
  // (both no-op for text channels) power the join button.
  const { joinConcordCall, activeCall, speakingPubkeys, mutedPubkeys } = useCall();
  const activeFold = useVoicePresence2(community, channel);
  const { data: activeBroker } = useVoiceBroker2(channel, activeFold);
  const inThisVoice = Boolean(
    activeCall?.concord && channel && activeCall.concord.channel.idHex === channel.idHex,
  );

  const handleJoinVoice = useCallback(
    async (ch: ChannelV2, broker: string | null, fold?: VoicePresenceFold) => {
      if (!community || !user) return;
      if (activeCall?.concord?.channel.idHex === ch.idHex) return; // already there
      let resolved = broker;
      if (!resolved) {
        // The broker query may still be loading, or a transient probe failure
        // cached `null` — re-run the rendezvous live instead of refusing.
        const roomHex = ch.voice.room.pk;
        resolved = roomHex
          ? await resolveVoiceBroker(roomHex, fold ?? { present: [], claims: new Map() })
          : null;
      }
      if (!resolved) {
        toast({
          title: "Voice unavailable",
          description: "No reachable voice server. You can set one under Settings → Voice.",
          variant: "destructive",
        });
        return;
      }
      joinConcordCall({ community, channel: ch, broker: resolved });
    },
    [community, user, activeCall, joinConcordCall],
  );

  // Compliant self-removal: if the folded Banlist names ME, silently tear
  // down the local copy and route home (CORD-04 §4).
  useBanSelfRemove2(baseCommunity, useCallback(() => navigateTo("/"), [navigateTo]));
  const [creatingChannel, setCreatingChannel] = useState(false);

  // Close the create-channel wizard when switching communities — the user's
  // MANAGE_CHANNELS permission doesn't carry over.
  useEffect(() => {
    setCreatingChannel(false);
    setCommunityMenuOpen(false);
  }, [communityId]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [shareDiscoverOpen, setShareDiscoverOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [banTarget, setBanTarget] = useState<string | null>(null);
  /**
   * The pending "name a category" prompt. A category has no id, so naming one
   * is the same act whether it is being created (file one channel under a new
   * name) or renamed (re-file every channel currently under the old one) —
   * hence one prompt with two targets rather than two dialogs.
   */
  const [categoryPrompt, setCategoryPrompt] = useState<
    { channels: ChannelV2[]; initial: string } | null
  >(null);
  // The community-name header menu (Discord-style): expands inline below the
  // header, pushing the channel list down with a height animation.
  const [communityMenuOpen, setCommunityMenuOpen] = useState(false);
  /** Member roster pane, persisted in app config (`memberListVisible`). Defaults
   * OFF on touch devices (a landscape phone crosses the 900px breakpoint but is
   * too short to spare the roster width); openable from the header toggle. On
   * real desktop it stays on. Once the user hides or shows it, that choice is
   * remembered across visits. */
  const membersVisible = config.memberListVisible ?? !isTouchDevice;
  const toggleMembersVisible = () =>
    updateConfig((c) => ({ ...c, memberListVisible: !(c.memberListVisible ?? !isTouchDevice) }));
  const [membersOpen, setMembersOpen] = useState(false);
  // Header message search: expands inline over the header, swapping the timeline
  // for community-wide (cross-channel) results while active. `searchFilters`
  // holds the structured query (text + channels + authors + media facet).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilters2>(EMPTY_SEARCH_FILTERS);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Mobile: landing on the community root (no channel in the URL) shows the
  // channel list, not a chat pane — selecting a community should let you pick a
  // channel, not auto-dive into one. A deep link with a channel opens chat
  // directly. (On desktop the SwipeReveal is inert — both panes always show.)
  const [channelsOpen, setChannelsOpen] = useState(!routeChannelId);
  // This page instance is reused across community switches (the route pattern
  // is stable), so the initial state above only applies to the first mount.
  // Reset the reveal state to match the destination route *during render* (not
  // in a post-paint effect): switching community navigates to its root
  // (no channel), so `channelsOpen` must already be `true` on the first render
  // after the route change. A lagging effect would paint one frame of the
  // (stale) chat pane first — the "flash of the previous chat" glitch. A deep
  // link with a channel opens chat directly.
  //
  // Keyed on the COMMUNITY, not on the community+channel pair: the root route
  // canonicalizes itself to a channel (see the redirect above), so a key that
  // included the channel would fire a second time the instant that redirect
  // lands and slam the list shut again — the list would flash and never stay
  // open. What matters is how the reader ARRIVED at this community, which is
  // exactly what the first render for a new `communityId` sees. Selecting a
  // channel or a pane still closes the list, explicitly, at each call site.
  const [navKey, setNavKey] = useState(communityId);
  if (navKey !== communityId) {
    setNavKey(communityId);
    setChannelsOpen(!routeChannelId);
  }
  // The open thread is the one the route names, resolved against loaded
  // history. Deriving it (rather than mirroring the id into state) is what
  // makes the panel survive a refresh, close on Back, and open from a
  // notification without a second code path: there is one answer to "which
  // thread is open", and the URL is it.
  //
  // An unresolved id — a deep link into a thread whose root is older than the
  // loaded window — simply leaves the panel closed while the hunt in
  // `usePermalinkTarget` pages back toward it.
  const threadRoot = useMemo(
    () => (routeThreadRoot ? allMessages.find((m) => m.id === routeThreadRoot) : undefined),
    [routeThreadRoot, allMessages],
  );
  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [threadExpanded, setThreadExpanded] = useState(false);
  // Drop the slide-out keepalive when the channel or community changes. The
  // panel itself needs no closing — leaving a channel drops the `/t/` segment,
  // so `threadRoot` resolves to nothing — but `lastThreadRoot` is cleared here
  // rather than only by the animation timeout, which re-runs on `threadRoot`
  // changes and so wouldn't fire for an already-closed panel. The scope key
  // includes `communityId` because the page is reused across community
  // switches (no route `key`) and `channel?.idHex` alone can lag the change.
  const threadScopeKey = `${communityId}\u0000${channel?.idHex ?? ""}`;
  const [threadChannelKey, setThreadChannelKey] = useState(threadScopeKey);
  if (threadChannelKey !== threadScopeKey) {
    setThreadChannelKey(threadScopeKey);
    setLastThreadRoot(undefined);
  }
  // Search is community-wide, so it survives channel switches but resets when
  // the community changes.
  const [searchCommunityKey, setSearchCommunityKey] = useState(communityId);
  if (searchCommunityKey !== communityId) {
    setSearchCommunityKey(communityId);
    setSearchOpen(false);
    setSearchFilters(EMPTY_SEARCH_FILTERS);
  }
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback((id: string) => setActiveId((cur) => (cur === id ? undefined : id)), []);

  // Tell the native notification service this channel (and, if a thread panel
  // is open, that specific thread) is on screen, so it suppresses redundant
  // tray entries. Cleared on unmount/background. The roomKey shapes must match
  // the service: `c2:<channelIdHex>` for the channel, `c2:<channelIdHex>:t:<rootId>`
  // for a specific open thread.
  useActiveRoom(
    channel?.idHex ? `c2:${channel.idHex}` : undefined,
    channel?.idHex && threadRoot ? `c2:${channel.idHex}:t:${threadRoot.id}` : undefined,
  );

  // Member list: the coalesced Guestbook (joins) ∪ observed authors ∪ roster,
  // minus the banned — the Complete Memberlist (CORD-02 §5).
  //
  // The Admin/Mod tier badge follows the STOCK Admin/Moderator roles only
  // (the same name-match setTier grants by), never permission-bit inference:
  // a custom role carrying management bits shows as itself — its hoisted
  // section or name chip — not as a phantom "Mod".
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

  // The per-member "Roles" picker: every role, position-ordered (ties broken by
  // the lower role_id, the display rule of CORD-04 §3), each flagged with
  // whether the viewer outranks its position — the same gate the fold applies,
  // so an un-assignable role renders disabled instead of failing on publish.
  const roleCatalog = useMemo(() => {
    if (!roster || !user) return undefined;
    return [...roster.roles]
      .sort(byDisplayOrder)
      .map((r) => ({
        id: r.roleId,
        name: r.name,
        color: r.color,
        channelName:
          r.scope.kind === "channel"
            ? (folded?.channels.get(r.scope.channelId)?.name ?? "deleted channel")
            : undefined,
        assignable: canActOnPosition(roster, user.pubkey, ownerHex, r.position, Permissions.MANAGE_ROLES),
      }));
  }, [roster, user, ownerHex, folded]);

  // Per channel, the Roles scoped to it — the channel's access list
  // (CORD-04 §2), for the info dialog's access panel.
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

  // Every surface that shows a person (profile card today) can name their
  // roles without each one re-deriving the roster.
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
      // The owner may hold roles COSMETICALLY (hoisted-section filing; their
      // authority stays position 0 either way), and only they can self-grant:
      // the fold admits any owner-authored grant, while no one else may ever
      // target the owner (canActOnMember).
      if (user.pubkey === ownerHex && pubkey === ownerHex) return true;
      return canActOnMember(roster, user.pubkey, ownerHex, pubkey, Permissions.MANAGE_ROLES);
    },
    [roster, user, ownerHex],
  );

  // EVERY live Private Channel, flagged with whether I hold its key — not
  // just the ones I hold. Granting a Role scoped to one vends its key onward;
  // revoking that Role rotates the key away from the loser (CORD-06 §1). A
  // revoke that only looked at my own keyring could not see that a channel I
  // lack changed hands, so it would report success while the target kept
  // reading it (`channelsHingingOn` splits the two).
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
    // Observed authors: newest ms each pubkey was seen publishing. `created_at`
    // is seconds; the Guestbook fold compares against millisecond kick/leave
    // times, so scale up. This lets `completeMemberlist` drop a kicked member
    // whose only presence is stale chat history, while an author still active
    // AFTER their kick correctly re-enters.
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

  // One Set identity per member-list change, shared by the git timeline rows
  // and the ticket side panel — building a fresh Set inside render handed
  // their memoized components a new prop every time the page rendered.
  const memberSet = useMemo(() => new Set(memberPubkeys), [memberPubkeys]);

  // Hoisted role sections (Role.display): position order, a member files under
  // their highest hoisted role only. The owner included — a self-granted
  // hoisted role moves their row out of the synthetic Admins group (the crown
  // chip still marks them; authority is position 0 either way).
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

  // A private channel's member panel shows only those entitled to its key
  // (CORD-03: readable only by granted role-holders) — listing members who
  // can't read the room would be a lie about access.
  const entitledHere = useCallback(
    (pk: string) => !channel?.isPrivate || isEntitled(roster, ownerHex, pk, channel.idHex),
    [channel, roster, ownerHex],
  );
  const panelMembers = useMemo(() => memberPubkeys.filter(entitledHere), [memberPubkeys, entitledHere]);
  const panelAdmins = useMemo(() => memberAdmins.filter((a) => entitledHere(a.pubkey)), [memberAdmins, entitledHere]);
  const panelSections = useMemo(
    () => roleSections?.map((s) => ({ ...s, members: s.members.filter(entitledHere) })).filter((s) => s.members.length > 0),
    [roleSections, entitledHere],
  );

  // "Add members" to a private channel = grant one of its scoped Roles (the
  // grant vends the key, handleToggleRole). The panel affordance exists only
  // when the viewer can actually grant one: MANAGE_ROLES alone doesn't cover
  // a role whose position the viewer doesn't outrank.
  const addableChannelRoles = useMemo(() => {
    if (!channel?.isPrivate) return [];
    const assignable = new Set((roleCatalog ?? []).filter((r) => r.assignable).map((r) => r.id));
    return (channelRoleCatalog.get(channel.idHex) ?? []).filter((r) => assignable.has(r.id));
  }, [channel, channelRoleCatalog, roleCatalog]);
  const addMemberCandidates = useMemo(
    () => (channel?.isPrivate ? memberPubkeys.filter((pk) => !entitledHere(pk)) : []),
    [channel, memberPubkeys, entitledHere],
  );

  // The dialog is about ONE channel's access; switching rooms closes it.
  useEffect(() => setAddMembersOpen(false), [channel?.idHex]);

  const handleCreateTextChannel = useCallback(async (name: string, opts?: { isPrivate?: boolean }) => {
    const { channelIdHex: created } = await createChannel({ name, isPrivate: opts?.isPrivate });
    // A newborn Private Channel is born alongside the Role that names who may
    // read it, and nobody holds that Role yet — so there is nobody to vend to.
    // Access starts empty and is handed out by granting the Role, which is the
    // path that vends the key (see handleToggleRole).
    selectChannel(created);
  }, [createChannel, selectChannel]);

  /**
   * Re-key a private channel to exactly the members entitled TODAY. The repair
   * for custody drift: anyone still holding a key they are no longer entitled
   * to (a key vended before a Role was revoked elsewhere, a suspected leak) is
   * cut from here forward, without needing a role change to trigger it.
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
   * Convert a public channel to private (CORD-03 §2). It gets its own key and
   * a Role scoped to it; access is then granted by handing out that Role.
   */
  const handlePrivatiseChannel = useCallback(async (channelIdHex: string) => {
    const def = folded?.channels.get(channelIdHex);
    if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
    // The conversion moves the conversation to a new stream and cannot reach
    // back over what has already been said, so the trade is stated plainly.
    const ok = confirm(
      `Make #${def.name} private?\n\n` +
      "It gets its own key from here on, and a role of the same name decides who may read it — nobody holds that role yet, so grant it to the members who should have access. " +
      "Messages already posted stay readable to everyone in the community; a restriction can't be applied backwards.",
    );
    if (!ok) return;
    await privatiseChannel({ channelIdHex });
    toast({
      title: "Channel is now private",
      description: `Grant the "${def.name}" role to give members access.`,
    });
  }, [folded, privatiseChannel]);


  // Opening a thread is a navigation: it pushes `/t/<root>` onto the channel
  // route. Back therefore closes the panel, the panel survives a refresh, and
  // "Copy message link" inside it can name where the reader actually is.
  //
  // Read-stamping stays out of this: the effect below marks whatever thread is
  // open, which covers arriving by link or by Back as well as by click.
  const openThread = useCallback(
    (event: ChatMsg, focusReply = false) => {
      if (!communityId || !channel) return;
      navigateTo(
        chatRoute({ kind: "concord2", communityId, channelId: channel.idHex, threadRoot: event.id }),
        { state: { threadAutoFocus: focusReply } },
      );
    },
    [communityId, channel, navigateTo],
  );
  // Closing when no thread is routed is a no-op rather than a second push, so
  // a stray close (the panel is still mounted through its slide-out) can't
  // stack duplicate history entries.
  const closeThread = useCallback(() => {
    if (!communityId || !channel || !routeThreadRoot) return;
    setThreadExpanded(false);
    navigateTo(chatRoute({ kind: "concord2", communityId, channelId: channel.idHex }));
  }, [communityId, channel, routeThreadRoot, navigateTo]);

  // Inline-reply plumbing: a by-id lookup over the decoded set (rumors aren't
  // relay-fetchable, so the "replying to …" line resolves the parent locally),
  // and a jump-to-message handler for clicking that line.
  const messagesById = useMemo(() => {
    const m = new Map<string, ChatMsg>();
    for (const msg of allMessages) m.set(msg.id, msg);
    return m;
  }, [allMessages]);
  const jumpWithinChannel = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

  // Focus the search field when it expands. `preventScroll` matters: the input
  // starts off-screen (translated right) and slides in, so a default focus()
  // would scroll the page to reveal it — a visible jolt.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchFilters(EMPTY_SEARCH_FILTERS);
  }, []);
  // Every channel in the community — the default search scope when the filter
  // picks no specific channels.
  const allChannelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  // Community-wide message search over the local decrypted rumor store. The
  // filters are only fed in while the bar is open, so closing it stops search.
  const {
    results: searchResults,
    isLoading: searchLoading,
    active: searching,
  } = useConcordSearch2(
    community?.idHex,
    allChannelIds,
    searchOpen ? searchFilters : EMPTY_SEARCH_FILTERS,
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const ticketParam = searchParams.get("ticket");
  // Git notification deep links use the stable ticket event id. Wait for the
  // local activity query, focus the matching panel, then consume the parameter.
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
  // Pre-path deep links (`?thread=`, `?m=`) become their route equivalents.
  // Old tray notifications and copied links still carry them.
  useLegacyFocusParams(
    useMemo(
      () =>
        communityId && channel
          ? ({ kind: "concord2", communityId, channelId: channel.idHex } as const)
          : undefined,
      [communityId, channel],
    ),
  );

  // Keep the thread panel content mounted through its slide-out animation.
  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), 200);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // Inject `openThread` (page-owned panel state) onto the data transport.
  const transport = useMemo(() => ({
    ...baseTransport,
    // A scroll-up page is one mixed operation. Both stores may prepend entries;
    // MessageTimeline owns the single scroll-height restoration around this
    // promise, so chat and Git cannot fight over the reader's anchor.
    //
    // `isLoading` is deliberately NOT merged: it is the timeline's skeleton
    // gate, and the skeleton stands for the chat store read. Git activity is
    // its own event domain read from the shared event store, so ORing it in
    // held a fully-cached conversation behind a skeleton whenever a
    // repo-attached channel's Git query was slow. Its rows simply appear when
    // they resolve, like any other late entry.
    hasMore: Boolean(baseTransport.hasMore || gitActivity.hasMore),
    isLoadingOlder: Boolean(baseTransport.isLoadingOlder || gitActivity.isLoadingOlder),
    loadOlder: async () => {
      const [chatAdded, gitAdded] = await Promise.all([baseTransport.loadOlder?.() ?? Promise.resolve(0), gitActivity.loadOlder()]);
      return chatAdded + gitAdded;
    },
    openThread,
    // Lights up the pin entry in the message menu (ChatMessage already renders
    // it when both are present).
    isPinned: pins.canPin ? pins.isPinned : undefined,
    togglePin: pins.canPin ? togglePin : undefined,
  }), [baseTransport, gitActivity, openThread, pins.canPin, pins.isPinned, togglePin]);
  // Recently-active members, for a bot command's `user`-argument picker. Concord
  // hands its timeline to ChatComposer as `messages: []`, so it must supply this.
  const recentAuthors = useMemo(() => authorsByRecency(transport.messages), [transport.messages]);

  // Message permalinks (`?m=<id>` — notification taps, copied links): scroll
  // to the target with the focus indicator once it's loaded, pulling older
  // pages when it's further back than the loaded history.
  const permalinkScroll = useCallback(
    (id: string) => timelineRef.current?.scrollToMessage(id, true) ?? false,
    [],
  );
  const clearMessageFocus = useMessagePermalink({
    messages: allMessages,
    isLoading: Boolean(baseTransport.isLoading),
    hasMore: transport.hasMore,
    loadOlder: transport.loadOlder,
    scrollTo: permalinkScroll,
    enabled: view === "channel",
  });

  // Background catch-up. `channelSyncing` = the channel on screen is being
  // caught up: its sync TOPIC is pending (covers the whole span from the
  // timeline hook declaring interest to the scheduler's round settling —
  // including the queue/warm-up gaps before any relay is touched), or a sync
  // task is scoped to it (the running round's live message counts). The
  // timeline uses it for its quiet catching-up affordance, so an empty store
  // read never paints "No messages yet" as a verdict mid-catch-up. The
  // passive corner indicator on the header icon surfaces whatever is in
  // flight (self-gated so a sub-second sync never paints), so it needn't hide
  // once the focused channel is live — it simply goes away when there's no
  // work left.
  const syncTasks = useSyncTasks();
  const channelScope = channel ? `c2:${channel.idHex}` : undefined;
  const channelTopic = useSyncTopicState(channelScope);
  const channelSyncing = Boolean(
    channelScope &&
      (channelTopic.status === "pending" || syncTasks.some((t) => t.scope === channelScope)),
  );
  // The serial gate itself (community list → control sweep → fold), surfaced
  // as "syncing" while it is genuinely in flight on a cold load. Before the
  // fold names a ChannelV2 the timeline query is disabled and `isLoading` is
  // deliberately false, so without this the chat pane sat BLANK — no spinner,
  // no skeleton — for the whole list-fetch + control-sweep chain on a fresh
  // device. Scoped so a resolved list with no such community (a bad link, a
  // left community) still falls through to the page's not-found handling
  // instead of spinning forever.
  const { isLoading: communityListLoading } = useCommunityList2();
  const gateResolving = Boolean(
    !channel && communityId && (communityListLoading || (baseCommunity && !folded)),
  );
  // A catch-up stuck in its retry loop: the scheduler alternates error
  // (backoff) and pending (retry) forever against an unreachable relay set,
  // so the verdict must LATCH across that cycle — it clears only when a round
  // actually settles, or when the channel changes.
  const [channelSyncFailed, setChannelSyncFailed] = useState(false);
  useEffect(() => setChannelSyncFailed(false), [channelScope]);
  useEffect(() => {
    if (channelTopic.status === "error") setChannelSyncFailed(true);
    else if (channelTopic.status === "settled") setChannelSyncFailed(false);
  }, [channelTopic.status]);

  const onOpenThreadCb = useMemo(
    () => (canWrite ? (event: ChatMsg) => openThread(event, true) : undefined),
    [canWrite, openThread],
  );

  // Stable identities so an unchanged message row's props don't churn and its
  // `memo` can bail out. `transport` is rebuilt on every message, so reach it
  // through a ref rather than depending on it.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const startEditing = useCallback((e: ChatMsg) => setEditingId(e.id), []);
  const cancelEditing = useCallback(() => setEditingId(undefined), []);

  const handleEditSubmit = useCallback(async (original: ChatMsg, content: string) => {
    const trimmed = content.trim();
    if (!trimmed || trimmed === original.content.trim()) {
      setEditingId(undefined);
      return;
    }
    setEditingId(undefined);
    try {
      await transportRef.current.editMessage?.(original, trimmed);
    } catch {
      toast({
        title: "Edit failed",
        description: "Could not publish the edit.",
        variant: "destructive",
      });
    }
  }, []);

  // Keep the open thread's read stamp advancing as new replies land while its
  // panel is on screen — mirrors the channel read effect above so the Threads
  // tab's "new" highlight clears for replies that arrive mid-view, not just
  // for replies that were present at open time. Visibility-gated so a
  // backgrounded tab doesn't silently eat the badge.
  const threadRootId = threadRoot?.id;
  useEffect(() => {
    if (!user || !threadRootId) return;
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
  }, [user, threadRootId, threadRoot?.created_at, transport, markThreadRead]);

  const moderation = useModeration2(community, memberPubkeys);

  // The member panel's action callbacks land on every memoized MemberRow, so
  // they must keep a stable identity while their bodies read the freshest
  // fold/moderation state. The handler closures live below the route guard;
  // each render writes them into this ref, and these render-stable wrappers
  // delegate through it (never invoked on a guard-returned render).
  const memberOpsRef = useRef<{
    setRole: (pk: string, roles: string[]) => Promise<void>;
    toggleRole: (pk: string, roleId: string, on: boolean) => Promise<void>;
    kick: (pk: string) => void;
    unban: (pk: string) => void;
    banLabel: (pk: string) => string;
  } | null>(null);
  const handleSetRoleStable = useCallback((pk: string, roles: string[]) => memberOpsRef.current?.setRole(pk, roles), []);
  const handleToggleRoleStable = useCallback(
    (pk: string, roleId: string, on: boolean) => memberOpsRef.current?.toggleRole(pk, roleId, on),
    [],
  );
  const handleKickMember = useCallback((pk: string) => memberOpsRef.current?.kick(pk), []);
  const handleUnbanMember = useCallback((pk: string) => memberOpsRef.current?.unban(pk), []);
  const memberBanLabel = useCallback((pk: string) => memberOpsRef.current?.banLabel(pk) ?? "Ban", []);
  const openAddMembers = useCallback(() => setAddMembersOpen(true), []);
  const closeMembers = useCallback(() => setMembersOpen(false), []);

  // Stable identities for the memoized ChannelRow2's callbacks; these close
  // over only render-stable values, so no ref indirection is needed.
  const suppressChannelClick = channelDrag.shouldSuppressClick;
  const handleSelectChannel = useCallback(
    (idHex: string) => {
      // The browser synthesizes a click after the drag's pointerup;
      // without this, dropping a channel also navigates to it.
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
    (c: ChannelV2) => setCategoryPrompt({ channels: [c], initial: "" }),
    [],
  );

  const publishTyping = useTypingPublisher2(community, channel);
  const typingPubkeys = useTyping2(community, channel);


  // A dissolved community stays viewable (read-only) rather than redirecting
  // home — members asked to keep seeing the history. `canWrite` (above) is
  // already false when `dissolved`, freezing every write path; the timeline
  // renders a banner + explicit "Remove" button (below) so the member can
  // reap their own list entry when they're ready. The owner's dissolution
  // can't reach into each member's self-encrypted list, so removal MUST be a
  // local, per-member action.

  if (!communityId) return <Navigate to="/" replace />;

  const handleSend = async (content: string, tags: string[][]) => {
    // The composer's content-derived tags (emoji, imeta, mentions) are sealed
    // verbatim; NIP-29 `h` and stray `e` tags are always dropped. An INLINE
    // reply keeps its NIP-C7 `q` (+ the `p` notifying the replied-to author) so
    // it renders quoted in the timeline; a top-level message keeps neither.
    // THREAD replies are a separate path (kind-1111, via `sendThreadReply`).
    const isReply = Boolean(replyTo);
    const extraTags = tags.filter(([name]) =>
      name !== "h" && name !== "e" && (isReply || name !== "q"),
    );
    await send({ content, extraTags });
    setReplyTo(undefined);
    // Sending is an explicit "I'm at the present": the location must stop
    // claiming the reader is parked at some older message.
    clearMessageFocus();
  };

  const handleLeave = async () => {
    try {
      await leave();
      navigateTo("/");
    } catch {
      // best-effort
    }
  };

  const handleDissolve = async () => {
    if (!confirm("Permanently dissolve this community for everyone? This cannot be undone.")) return;
    try {
      await dissolve();
      toast({ title: "Community dissolved" });
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
      // Composes on this client's last intent, not the lagging fold, and
      // ignores a repeat of the same toggle while one is in flight — a Grant
      // replaces the member's WHOLE role list, so two racing toggles would
      // drop each other's role and start the gate rotation below twice.
      const published = await roleIntent.toggle(pubkey, roleId, on);
      if (!published) return; // already in flight
      toast({ title: on ? "Role granted" : "Role removed" });
    } catch (e) {
      toast({ title: "Couldn't change roles", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      return;
    }

    // Role-gated channel keys follow the grant (channelAccess.ts). Judged with the
    // just-published change overlaid, since the fold lags the publish; "via
    // another role" uses the withoutRoleIds overlay so a member keeping
    // entitlement through a second scoped role is never vended-to or cut twice.
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
            // The Grant landed moments ago and the fold still lags it, so the
            // vend has to judge entitlement with it overlaid — otherwise the
            // recipient reads as unentitled and is handed nothing.
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
      // A key I don't hold can't be vended by me, and the grantee cannot read
      // the room until someone who holds it hands it over.
      if (affected.unheld.length > 0) {
        toast({
          title: "Some channel keys weren't sent",
          description: `You don't hold the key to ${listNames(affected.unheld)}, so a member who does has to share it before they can read ${affected.unheld.length > 1 ? "those channels" : "that channel"}.`,
        });
      }
      return;
    }

    if (affected.held.length === 0 && affected.unheld.length === 0) return;
    // Say the un-rotatable part FIRST and always: a revoke that cuts nobody is
    // the failure worth hearing about, and it is invisible from my keyring.
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
        description: "They lost access to a private channel, but rotating its key needs the Manage-channels permission — ask an admin to rotate it.",
        variant: "destructive",
      });
      return;
    }
    for (const idHex of affected.held) {
      const keep = memberPubkeys.filter(
        (pk) => pk !== pubkey && isEntitled(roster, ownerHex, pk, idHex),
      );
      try {
        // The revoke targets exactly this member: everyone else entitled is
        // kept, so they are the whole removed set (CORD-06 §Authority).
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

  // This render's closures for the stable member-panel wrappers declared
  // above the route guard (memberOpsRef): a render-time ref write, as in
  // ui/avatar.tsx.
  memberOpsRef.current = {
    setRole: handleSetRole,
    toggleRole: handleToggleRole,
    kick: (pk: string) => void moderation.kick({ target: pk }).catch(() => {}),
    unban: (pk: string) => void moderation.unban({ target: pk }).catch(() => {}),
    banLabel: (pk: string) =>
      folded && user && moderation.canRekey && !hasForeignLiveLinks(folded, user.pubkey, pk)
        ? "Ban & lock out"
        : "Ban",
  };

  // A ban rotates keys unless someone ELSE holds a live link (a rotation
  // would strand it; my own links refresh with the rotation). Judged as-of
  // after this ban: the target's links die with their authority.
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

  const renderChannelRow = (c: ChannelV2) => {
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
        // Unconditional `touch-none` while the drag is live, as the rail's
        // entries carry: Chrome's gesture arbitration otherwise claims a touch
        // drag as a pan and kills it with pointercancel. The column is then
        // panned by hand for gestures that turn out to be scrolls
        // (usePressDrag.ts). A member who can't rearrange gets neither, and
        // keeps native scrolling.
        className={cn("relative", canManageChannels && "touch-none")}
      >
      {/* The dragged row's real content stays MOUNTED and merely invisible,
          with the dashed placeholder over it — the rail's `DragSlot`, and for
          its reason: unmounting the DOM node the finger is touching detaches
          the touch target, its events stop bubbling, and Chrome cancels the
          gesture on the first movement. */}
      <span className={cn("contents", dragged && "invisible")}>
      <ChannelRow2
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
        <span className="pointer-events-none absolute inset-x-0 inset-y-px clip-corner-lg border-2 border-dashed border-primary/50 bg-primary/5" />
      )}
      </div>
    );
  };

  // There is ONE channel column, mounted on every viewport (the mobile reveal
  // and the desktop sidebar are the same element), so it always carries the
  // drag's container ref — which is both what the drop slots are measured out
  // of and where the touchmove canceller lives.
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
          <TitleIcon2 icon={folded?.metadata?.icon} />
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
              <div className="mx-2 mb-2 mt-1 p-1 space-y-0.5 clip-corner-lg bg-secondary">
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
                    onClick: () => setInfoOpen(true),
                  },
                  {
                    show: !!user && !dissolved,
                    icon: <UserPlus className="size-4" />,
                    label: "Invite people",
                    onClick: () => setInviteOpen(true),
                  },
                  {
                    // Listing publishes an invite link (secret included), so
                    // only the owner or an admin may put the community on
                    // Discover — the same gate the share dialog enforces.
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
                    show: canManageRoles && !dissolved,
                    icon: <Shield className="size-4" />,
                    label: "Manage roles",
                    onClick: () => setRolesOpen(true),
                  },
                  {
                    show: true,
                    icon: <ScrollText className="size-4" />,
                    label: "Audit log",
                    // Also close the mobile channel drawer so the view slides
                    // into the <main> overlay (inert on desktop).
                    onClick: () => {
                      selectPane("audit");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: true,
                    icon: <LinkIcon className="size-4" />,
                    label: "Invite links",
                    onClick: () => {
                      selectPane("invites");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: canBanAny,
                    icon: <Ban className="size-4" />,
                    label: "Banned members",
                    onClick: () => {
                      selectPane("banned");
                      setChannelsOpen(false);
                    },
                  },
                  {
                    show: canManageRoles || canKickAny || canBanAny || canCreateInvite,
                    icon: <Users className="size-4" />,
                    label: "Members",
                    onClick: () => {
                      selectPane("members");
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
      banner={folded?.metadata?.banner ? <Banner2 banner={folded.metadata.banner} /> : undefined}
      addChannelLabel={user && community && canManageChannels ? "Add channel" : undefined}
      onAddChannel={user && community && canManageChannels ? () => setCreatingChannel((v) => !v) : undefined}
      addChannelOpen={creatingChannel}
      footer={<SidebarFooter2 />}
      preChannels={
        user && community ? (
          <>
            <SuspiciousActivityBanner2 community={community} folded={folded} ban={moderation.ban} />
            <button
              type="button"
              onClick={() => {
                selectPane("mentions");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "mentions"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                // Unread (but not selected) mentions read brighter + bold, matching
                // an unread channel row.
                view !== "mentions" && hasUnreadMention && "text-foreground font-semibold",
              )}
              aria-current={view === "mentions"}
            >
              <AtSign className="size-4 shrink-0" />
              <span className="truncate flex-1 min-w-0">Mentions</span>
              {view !== "mentions" && hasUnreadMention ? (
                <span
                  className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
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
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
                view === "threads"
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                // Unread (but not selected) thread replies read brighter + bold.
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
                  "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
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
            // A collapsed category still surfaces the channel you are in and
            // anything unread — folding a heading away is for tidiness, and
            // must never make the active channel vanish or silence a mention.
            const shown = collapsed
              ? group.channels.filter(
                  (c) =>
                    (view === "channel" && channel?.idHex === c.idHex) || unreadByChannel[c.idHex],
                )
              : group.channels;
            return (
              // `space-y-0.5` mirrors the sidebar's own row spacing: these rows
              // are nested a level deeper than the uncategorized ones, so
              // without it a filed channel sits flush against its neighbour.
              <div key={group.key} className="space-y-0.5">
                <ChannelCategoryHeading2
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
          {/* The trailing drop zone: dragging here asks for a name and files
              the channel under it. Only while dragging — an always-present
              "new category" affordance would be a button, and a category with
              no channel in it can't exist to be created. */}
          {channelDrag.dragging && (
            <div
              data-ch-newzone
              className={cn(
                "mt-2 flex items-center justify-center gap-1.5 clip-corner-lg border-2 border-dashed px-2 py-3 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                channelDrag.target?.newCategory
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-primary/50 text-muted-foreground/70",
              )}
            >
              <Plus className="size-3.5" />
              New category
            </div>
          )}
        </>
      )}

      {/* Everything below is the server rail's drag chrome, in channel shape:
          the pointer-following ghost, the grabbing-cursor layer and the
          insertion line (ServerRail.tsx). Same z-bands, same treatments. */}

      {channelDrag.pointer && draggedChannel && (
        <div
          className="pointer-events-none fixed z-[300] -translate-y-1/2 animate-in zoom-in-75 duration-150"
          style={{ left: (channelDrag.columnX?.left ?? 0) + 12, top: channelDrag.pointer.y }}
        >
          <span className="flex max-w-48 items-center gap-2 rotate-[-2deg] scale-105 clip-corner-lg bg-muted px-3 py-1.5 text-sm font-medium ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
            {draggedChannel.isPrivate ? (
              <Lock className="size-4 shrink-0" />
            ) : (
              <Hash className="size-4 shrink-0" />
            )}
            <span className="truncate">{draggedChannel.name}</span>
          </span>
        </div>
      )}

      {/* A full-viewport layer carrying the grabbing cursor. This is what makes
          the cursor actually flip at pickup: Chromium does not re-evaluate a
          style-only cursor change while a button is down and the pointer is
          stationary, but a NEW element appearing under it forces the recompute.
          It must NOT be pointer-events-none (hit-test-transparent elements
          don't contribute a cursor); the listeners live on window, so events
          bubbling through it are still seen. */}
      {channelDrag.dragging && (
        <div className="fixed inset-0 z-[298] cursor-grabbing" aria-hidden />
      )}

      {/* Insertion indicator: where the drop would land. */}
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
      {/* Member kind-0s often live only on the community's own relays, which
          the pool's general routing never asks. */}
      <ProfileRelayHints relays={community?.relays} />
      <MemberRolesContext.Provider value={memberRolesValue}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            {/* The rail only ever navigates to *other* servers/communities, so
                it must NOT close this community's channel list on click: doing
                so slides this community's chat pane back in for a frame before
                the route changes — the "flash of the previous chat" glitch. The
                destination governs its own reveal state. (DMsPage omits the prop
                for the same reason.) */}
            <ServerRail />
            {channelList(() => setChannelsOpen(false), "flex-1 sidebar:flex-none")}
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          <header className="relative h-12 touch:h-14 max-sidebar:h-auto max-sidebar:py-2 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to channels"
              className="size-9 touch:size-11 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>

            {/* Desktop / wide: "# channel-name" (or "@ Mentions" / "Threads"). */}
            <div className="relative hidden sidebar:flex items-center gap-1.5 min-w-0">
              {/* Passive background-sync indicator, pinned to the corner of the
                  leading title icon (replaces the old full-width sync bar). */}
              <SyncStatusIndicator
                priorityScope={channelScope}
                className="absolute -bottom-0.5 left-2 z-10"
              />
              {view === "mentions" ? (
                <>
                  <AtSign className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Mentions</h1>
                </>
              ) : view === "audit" ? (
                <>
                  <ScrollText className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Audit log</h1>
                </>
              ) : view === "invites" ? (
                <>
                  <LinkIcon className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Invite links</h1>
                </>
              ) : view === "banned" ? (
                <>
                  <Ban className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Banned members</h1>
                </>
              ) : view === "members" ? (
                <>
                  <Users className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Members</h1>
                </>
              ) : view === "threads" ? (
                <>
                  <MessagesSquare className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Threads</h1>
                </>
              ) : view === "projects" ? (
                <>
                  <FolderGit2 className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Projects</h1>
                </>
              ) : (
                <>
                  {channel?.isPrivate ? (
                    <Lock className="size-5 text-muted-foreground shrink-0" />
                  ) : (
                    <Hash className="size-5 text-muted-foreground shrink-0" />
                  )}
                  <h1 className="font-semibold truncate leading-tight">{channel?.name ?? "…"}</h1>
                </>
              )}
            </div>

            {/* Mobile: community avatar + name large, channel muted below */}
            <div className="relative flex sidebar:hidden items-center min-w-0">
              {/* Passive background-sync indicator, pinned to the avatar corner
                  (can't live inside the info button — nested buttons). */}
              <SyncStatusIndicator
                priorityScope={channelScope}
                className="absolute bottom-0 left-5 z-10"
              />
              <button
                type="button"
                className="flex items-center gap-2.5 min-w-0 text-left"
                onClick={() => community && setInfoOpen(true)}
                disabled={!community}
                aria-label="Community info"
              >
              <TitleAvatar2 icon={folded?.metadata?.icon} name={community?.name} />
              <div className="min-w-0 flex flex-col">
                <span className="font-semibold text-base leading-tight truncate">{community?.name ?? "…"}</span>
                <span className="text-xs text-muted-foreground leading-tight truncate flex items-center gap-0.5">
                  {view === "mentions" ? (
                    <>
                      <AtSign className="size-3 shrink-0" />
                      Mentions
                    </>
                  ) : view === "audit" ? (
                    <>
                      <ScrollText className="size-3 shrink-0" />
                      Audit log
                    </>
                  ) : view === "invites" ? (
                    <>
                      <LinkIcon className="size-3 shrink-0" />
                      Invite links
                    </>
                  ) : view === "banned" ? (
                    <>
                      <Ban className="size-3 shrink-0" />
                      Banned members
                    </>
                  ) : view === "members" ? (
                    <>
                      <Users className="size-3 shrink-0" />
                      Members
                    </>
                  ) : view === "threads" ? (
                    <>
                      <MessagesSquare className="size-3 shrink-0" />
                      Threads
                    </>
                  ) : view === "projects" ? (
                    <>
                      <FolderGit2 className="size-3 shrink-0" />
                      Projects
                    </>
                  ) : (
                    <>
                      {channel?.isPrivate ? (
                        <Lock className="size-3 shrink-0" />
                      ) : (
                        <Hash className="size-3 shrink-0" />
                      )}
                      {channel?.name ?? "…"}
                    </>
                  )}
                </span>
              </div>
            </button>
            </div>
            <div className="ml-auto flex items-center gap-0.5">
              {/* Voice — the primary channel action, inline at every width
                  (mirrors the DM header's Call). Search + the members toggle
                  stay inline on desktop; Invite and Mute always live in the …
                  menu, and on mobile Search + Members join them there. */}
              {user && view === "channel" && channel && !dissolved && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 touch:size-11", inThisVoice && "text-success")}
                      aria-label={inThisVoice ? "In voice" : "Join voice"}
                      disabled={inThisVoice}
                      onClick={() => channel && handleJoinVoice(channel, activeBroker ?? null, activeFold)}
                    >
                      {inThisVoice ? <Headphones className="size-4" /> : <Phone className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{inThisVoice ? "In voice" : "Join voice"}</TooltipContent>
                </Tooltip>
              )}
              {view === "channel" && channel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Search messages"
                      aria-pressed={searchOpen}
                      className={cn("size-8 hidden sidebar:inline-flex text-muted-foreground", searchOpen && "text-foreground")}
                      onClick={() => setSearchOpen(true)}
                    >
                      <Search className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Search messages</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 hidden sidebar:inline-flex text-muted-foreground", membersVisible && "text-foreground")}
                    aria-label={membersVisible ? "Hide members" : "Show members"}
                    aria-pressed={membersVisible}
                    onClick={toggleMembersVisible}
                  >
                    <Users className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
              </Tooltip>

              {view === "channel" && channel && (pins.pins.length > 0 || pins.dark) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 touch:size-11 text-muted-foreground", pinsOpen && "text-foreground")}
                      aria-label={pinsOpen ? "Hide pinned messages" : "Show pinned messages"}
                      aria-pressed={pinsOpen}
                      onClick={() => setPinsOpen((v) => !v)}
                    >
                      <Pin className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Pinned messages</TooltipContent>
                </Tooltip>
              )}

              {view === "channel" && channel && (calendar.events.length > 0 || calendar.canModerate) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 touch:size-11 text-muted-foreground", eventsOpen && "text-foreground")}
                      aria-label={eventsOpen ? "Hide events" : "Show events"}
                      aria-pressed={eventsOpen}
                      onClick={() => setEventsOpen((v) => !v)}
                    >
                      <CalendarClock className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Events</TooltipContent>
                </Tooltip>
              )}

              {/* Overflow … menu — shown at every width. Invite and Mute always
                  live here (they were the least-used inline buttons cluttering
                  the desktop bar); Search + Members are here only on mobile,
                  where they aren't already inline. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="More options"
                    className="size-8 touch:size-11 shrink-0 text-muted-foreground"
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 p-1.5">
                  {view === "channel" && channel && (
                    <DropdownMenuItem className="px-3 py-2 sidebar:hidden" onClick={() => setSearchOpen(true)}>
                      <Search className="size-4" />
                      Search messages
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem className="px-3 py-2 sidebar:hidden" onClick={() => setMembersOpen(true)}>
                    <Users className="size-4" />
                    Members
                  </DropdownMenuItem>
                  {user && !dissolved && (
                    <DropdownMenuItem className="px-3 py-2" onClick={() => setInviteOpen(true)}>
                      <UserPlus className="size-4" />
                      Invite people
                    </DropdownMenuItem>
                  )}
                  {user && community && channel && (
                    <DropdownMenuItem
                      className="px-3 py-2"
                      onClick={() => toggleConcordChannelMute("c2", community.idHex, channel.idHex)}
                    >
                      {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {channelMuted ? "Unmute channel" : "Mute channel"}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Inline search bar: slides in over the header when open, covering
                the title + actions (leaves the mobile back button visible; on
                desktop it covers the full bar). Slides via a GPU-composited
                transform so it never forces a per-frame reflow. Mirrors NIP-29. */}
            {view === "channel" && channel && (
              <div
                className={cn(
                  "absolute inset-y-0 right-0 left-10 sidebar:left-0 z-10 flex items-center gap-1.5 px-2 sidebar:px-3",
                  "bg-chrome clip-corner-lg overflow-hidden",
                  "transition-transform duration-300 ease-in-out",
                  searchOpen
                    ? "translate-x-0 pointer-events-auto"
                    : "translate-x-full pointer-events-none",
                )}
              >
                <Search className="size-4 text-muted-foreground shrink-0" />
                <Input
                  ref={searchInputRef}
                  value={searchFilters.query}
                  onChange={(e) => setSearchFilters((f) => ({ ...f, query: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeSearch();
                  }}
                  placeholder="Search all channels…"
                  className="h-8 touch:h-10 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                <SearchFiltersPopover
                  channels={channels}
                  members={memberPubkeys}
                  filters={searchFilters}
                  onChange={setSearchFilters}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close search"
                  className="size-8 touch:size-10 shrink-0 text-muted-foreground"
                  onClick={closeSearch}
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
          </header>

          {/* Top-of-chat call stage portal target (active when this channel is
              the one in encrypted voice). */}
          <CallStageSlot active={inThisVoice} />

          {/* Top-of-chat app stage (webxdc apps) for this channel. */}
          {appScope && <AppStageSlot scope={appScope} />}

          <ChatScopeContext.Provider value={appScope}>
          <div className="relative flex flex-1 min-h-0">
            <ComposerBoundsProvider value={composerBoundsRef}>
            <div className={cn(
              "flex-1 min-w-0 flex flex-col",
              "sidebar:transition-[width,opacity] sidebar:duration-300 sidebar:ease-out",
              threadRoot && threadExpanded && "sidebar:flex-none sidebar:w-0 sidebar:opacity-0 sidebar:overflow-hidden sidebar:pointer-events-none",
            )}>
              {view === "mentions" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <MentionsView
                    channels={channels}
                    mentions={mentions}
                    isLoading={mentionsLoading}
                    onJump={jumpToMention}
                  />
                </div>
              ) : view === "audit" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && <AuditLogView community={community} />}
                </div>
              ) : view === "invites" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && <InvitesView community={community} />}
                </div>
              ) : view === "banned" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable pb-safe">
                  {community && <BannedView community={community} />}
                </div>
              ) : view === "members" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  {community && (
                    <MembersView
                      community={community}
                      memberPubkeys={memberPubkeys}
                      canModerate={canKickAny || canBanAny}
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
                /* Community-wide search results replace the timeline + composer
                   in-place. Clicking a result jumps to its channel. */
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable pb-safe">
                  <SearchResultsView
                    channels={channels}
                    results={searchResults}
                    isLoading={searchLoading}
                    query={searchFilters.query}
                    onJump={(channelIdHex, messageId) => {
                      closeSearch();
                      jumpToMention(channelIdHex, messageId);
                    }}
                  />
                </div>
              ) : (
                <>
                  <PinnedBar2
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
                          toast({ title: "Unpinned" });
                        } catch (e) {
                          toast({ title: "Couldn't unpin", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                        }
                      })();
                    }}
                    onClose={() => setPinsOpen(false)}
                  />
                  <CalendarEventsBar
                    open={eventsOpen}
                    calendar={calendar}
                    onClose={() => setEventsOpen(false)}
                    onCreate={() => setCreateEventOpen(true)}
                    onDelete={(event) => { void calendar.remove(event); }}
                  />
                  <MessageTimeline
                    key={channel?.idHex ?? channelIdHex ?? "none"}
                    transport={transport}
                    entries={mixedEntries}
                    newDividerId={newDividerId}
                    renderEntry={(entry, relatedEntries) => isGitTimelineEntry(entry) ? <GitTimelineRow entry={entry} members={memberSet} onOpen={(ticket) => { setOpenTicket(ticket); void gitActivity.refreshTicket(ticket); }} commentEntries={entry.type === "git-comment" ? relatedEntries as Extract<typeof entry, { type: "git-comment" }>[] : undefined} activities={gitActivity.activities} /> : entry.type === "dm-timer" ? <TimerNotice2 author={entry.author} seconds={entry.seconds} self={user?.pubkey} /> : null}
                    handleRef={timelineRef}
                    syncing={channelSyncing || gateResolving}
                    syncFailed={channelSyncFailed}
                    className="flex-1 min-h-0"
                    emptyState={
                      // Only once a channel has actually resolved. Before the
                      // control fold names one there is no conversation to
                      // call empty, and "say something" would be inviting the
                      // reader to write into a channel that isn't there yet.
                      // A decode dead-end (the last round pulled wraps and
                      // opened none) is a different verdict from "empty": the
                      // messages exist, this device just can't read them yet.
                      channel ? (
                        channelDecodeDeadEnd(channel.idHex) ? (
                          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                            There are messages here, but they can't be decrypted with the keys
                            this device holds yet. They should become readable once the next key
                            update from the community reaches you.
                          </p>
                        ) : (
                          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                            No messages yet. Say something — only members can read it.
                          </p>
                        )
                      ) : undefined
                    }
                    renderMessage={(msg, continuation) => {
                      const replyId = getQuoteReplyToId(msg);
                      return (
                      <ChatMessage2
                        key={msg.id}
                        event={msg}
                        permalink={communityId && channel ? { kind: "concord2", communityId, channelId: channel.idHex } : undefined}
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
                        isPinned={Boolean(transport.isPinned?.(msg.id))}
                        onTogglePin={transport.togglePin}
                        sendStatus={transport.sendStatusFor?.(msg.id)}
                        active={activeId === msg.id}
                        onToggleActive={toggleActive}
                        onOpenThread={onOpenThreadCb}
                        onReply={canWrite ? setReplyTo : undefined}
                        replyToId={replyId}
                        replyParent={replyId ? messagesById.get(replyId) : undefined}
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

                  {typingPubkeys.length > 0 && <TypingIndicator pubkeys={typingPubkeys} />}
                  {dissolved ? (
                    <div className="mx-2 mb-3 mt-1 px-3 py-3 clip-corner-lg bg-destructive/10 flex items-center gap-3">
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
                    <div className="mx-2 mb-3 mt-1 px-3 py-3 clip-corner-lg bg-muted/60 flex items-center gap-3">
                      <Lock className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-medium">You no longer have access to this community.</p>
                        <p className="text-muted-foreground">
                          A moderator rotated its keys without you. Your history stays readable; new
                          messages won't. It reappears if you're re-invited — or you can leave.
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
                    <div className="mx-2 mb-3 mt-1 px-3 py-3 clip-corner-lg bg-muted/60 flex items-center gap-3">
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
                    channel && (
                      <ChatComposer
                        relayUrl="dm"
                        groupId={channel.idHex}
                        messages={[]}
                        mentionPubkeys={memberPubkeys}
                        botCommands
                        recentAuthors={recentAuthors}
                        conversationRelays={community?.relays}
                        placeholder={user ? `Message #${channel.name}` : "Sign in to send"}
                        sendOverride={handleSend}
                        onPollSubmit={transport.sendPoll}
                        replyTo={replyTo}
                        replyMarker="nipc7"
                        onCancelReply={() => setReplyTo(undefined)}
                        onTyping={publishTyping}
                        encryptAttachments
                      />
                    )
                  )}
                </>
              )}
            </div>

            <TicketSidePanel ticket={openTicket} members={memberSet} activities={panelActivities} onClose={() => setOpenTicket(undefined)} actions={ticketActions} />
            <NewChannelDialog2
              open={creatingChannel}
              onOpenChange={setCreatingChannel}
              connectedCoordinates={connectedCoordinates}
              onCreateText={handleCreateTextChannel}
              onCreateRepository={handleCreateRepositoryChannel}
            />
            <CreateEventDialog
              calendar={calendar}
              open={createEventOpen}
              onOpenChange={setCreateEventOpen}
            />
            </ComposerBoundsProvider>

            {/* Thread panel. Desktop: in-flow sibling whose width animates open.
                Mobile: overlays the chat. Mirrors GroupChat. */}
            <div
              className={cn(
                "overflow-hidden",
                "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
                "sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
                threadRoot
                  ? (threadExpanded ? "sidebar:flex-1 sidebar:w-full" : "sidebar:shrink-0 sidebar:w-[23rem]")
                  : "sidebar:shrink-0 sidebar:w-0 pointer-events-none sidebar:pointer-events-auto",
              )}
            >
              <div
                className={cn(
                  "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                  threadRoot ? "opacity-100" : "opacity-0",
                )}
              />
              <div
                className={cn(
                  "relative h-full flex w-full transition-transform duration-200 ease-out",
                  threadRoot ? "translate-x-0" : "translate-x-full",
                  threadExpanded ? "sidebar:w-full" : "sidebar:w-[23rem]",
                )}
              >
                {lastThreadRoot && channel && (
                  <ThreadPanel
                    root={lastThreadRoot}
                    transport={transport}
                    relayUrl="dm"
                    groupId={channel.idHex}
                    canWrite={canWrite}
                    mentionPubkeys={memberPubkeys}
                    botCommands
                    conversationRelays={community?.relays}
                    autoFocus={threadAutoFocus}
                    open={Boolean(threadRoot)}
                    onClose={closeThread}
                    onExpandChange={setThreadExpanded}
                  />
                )}
              </div>
            </div>

            {/* Member panel: width-animated on desktop, slide overlay on mobile. */}
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
                  "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                  membersOpen ? "opacity-100" : "opacity-0",
                )}
              />
              <div
                className={cn(
                  "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                  membersOpen ? "translate-x-0" : "translate-x-full",
                  membersVisible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
                )}
              >
                <MemberList
                  admins={panelAdmins}
                  members={panelMembers}
                  canModerate={canManageRoles || canKickAny || canBanAny}
                  viewerIsAdmin={iAmOwner}
                  currentUserPubkey={user?.pubkey}
                  onSetRole={canManageRoles ? handleSetRoleStable : undefined}
                  roleCatalog={roleCatalog}
                  memberRoleIds={memberRoleIds}
                  canEditMemberRoles={canEditMemberRoles}
                  onToggleRole={canManageRoles ? handleToggleRoleStable : undefined}
                  isRoleToggling={roleIntent.isPending}
                  roleSections={panelSections}
                  onKick={canKickAny ? handleKickMember : undefined}
                  onBan={canBanAny ? setBanTarget : undefined}
                  banLabel={memberBanLabel}
                  onUnban={canBanAny ? handleUnbanMember : undefined}
                  bannedPubkeys={moderation.banned}
                  onAddMembers={
                    channel?.isPrivate && addableChannelRoles.length > 0
                      ? openAddMembers
                      : undefined
                  }
                  onClose={closeMembers}
                />
              </div>
            </div>
          </div>
          </ChatScopeContext.Provider>
        </main>
      </SwipeReveal>

      <InviteDialog2 community={community} open={inviteOpen} onOpenChange={setInviteOpen} canCreateLink={iAmAdminOrOwner} />
      {channel?.isPrivate && (
        <AddChannelMembersDialog
          open={addMembersOpen}
          onOpenChange={setAddMembersOpen}
          channelName={channel.name}
          candidates={addMemberCandidates}
          roles={addableChannelRoles}
          onAdd={(pk, roleId) => handleToggleRole(pk, roleId, true)}
          isAdding={roleIntent.isPending}
          hasRole={(pk, roleId) => roleIntent.rolesFor(pk).includes(roleId)}
          holdsKey={privateChannelsHere.some((c) => c.idHex === channel.idHex && c.heldByMe)}
        />
      )}
      <ShareToDiscoverDialog
        open={shareDiscoverOpen}
        onOpenChange={setShareDiscoverOpen}
        communityId={community?.idHex}
      />
      <BanMemberDialog
        targets={banTarget ? [banTarget] : null}
        willRotate={banWillRotate}
        onClose={() => setBanTarget(null)}
        onConfirm={runBan}
      />
      <CommunityInfoDialog2
        community={community}
        metadata={folded?.metadata}
        ownerHex={ownerHex}
        memberCount={memberPubkeys.length}
        canManageMetadata={canManageMetadata}
        canManageChannels={canManageChannels}
        channelRoles={channelRoleCatalog}
        onPrivatiseChannel={canManageChannels ? handlePrivatiseChannel : undefined}
        onRotateChannelKey={canRekeyChannel ? handleRotateChannelKey : undefined}
        open={infoOpen}
        onOpenChange={setInfoOpen}
      />
      <CategoryNameDialog2
        open={Boolean(categoryPrompt)}
        initial={categoryPrompt?.initial ?? ""}
        count={categoryPrompt?.channels.length ?? 0}
        onOpenChange={(next) => !next && setCategoryPrompt(null)}
        onSubmit={(name) => categoryPrompt && void refileCategory(categoryPrompt.channels, name)}
      />
      <RolesDialog2 community={community} open={rolesOpen} onOpenChange={setRolesOpen} />
    </MemberRolesContext.Provider>
    </ChannelNavContext.Provider>
  );
}
