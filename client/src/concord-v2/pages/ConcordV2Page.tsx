import { AtSign, ChevronDown, ChevronLeft, Bell, BellOff, Hash, Headphones, Loader2, Lock, LogOut, MessagesSquare, Phone, Plus, Settings, Shield, Trash2, UserPlus, Users, Volume2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, firstImageRef, ReplyContextLine, getQuoteReplyToId, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { LoginArea } from "@/components/auth/LoginArea";
import { JoinButton } from "@/components/auth/JoinButton";
import { MemberList } from "@/components/chat/MemberList";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { VoiceParticipantList } from "@/components/VoicePresence";
import { CommunityInfoDialog2 } from "@/concord-v2/components/CommunityInfoDialog2";
import { ImageLightbox2 } from "@/concord-v2/components/ImageLightbox2";
import { InviteDialog2 } from "@/concord-v2/components/InviteDialog2";
import { RolesDialog2 } from "@/concord-v2/components/RolesDialog2";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCall } from "@/hooks/useCall";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { concordChannelMuteKey, useMutes } from "@/hooks/useMutes";
import { toast } from "@/hooks/useToast";
import { useCommunity2 } from "@/concord-v2/hooks/useCommunityList2";
import { useCommunityManagement2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useChannels2, useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useGuestbook2 } from "@/concord-v2/hooks/useGuestbook2";
import { useModeration2 } from "@/concord-v2/hooks/useModeration2";
import { useRekeyWatch2 } from "@/concord-v2/hooks/useRekey2";
import { useRoles2 } from "@/concord-v2/hooks/useRoles2";
import { useSendMessage2 } from "@/concord-v2/hooks/useChannel2";
import { useTransport2 } from "@/concord-v2/hooks/useTransport2";
import { useConcord2Unread, type Concord2Unread } from "@/concord-v2/hooks/useConcord2Unread";
import { useConcord2Mentions } from "@/concord-v2/hooks/useConcord2Mentions";
import { useConcord2Threads, type Concord2Thread } from "@/concord-v2/hooks/useConcord2Threads";
import { useTyping2, useTypingPublisher2 } from "@/concord-v2/hooks/useTyping2";
import { resolveVoiceBroker, useVoiceBroker2, useVoicePresence2 } from "@/concord-v2/hooks/useVoice2";
import type { VoicePresenceFold } from "@/concord-v2/lib/voice";
import { useRegisterChannelStreamKeys2 } from "@/concord-v2/hooks/useStreamAuth2";
import { completeMemberlist } from "@/concord-v2/lib/guestbook";
import { badgeOf, isAuthorized, Permissions } from "@/concord-v2/lib/roles";
import type { ChannelV2, CommunityV2, ImagePointer } from "@/concord-v2/lib/types";
import { cn, pickDefaultChannel } from "@/lib/utils";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortTimeAgo } from "@/lib/formatTime";

import { threadSummary } from "@/components/chat/transport";
import type { ChatMsg, MessageReactions, MessageZaps, SendStatus, ZapPayment } from "@/components/chat/transport";

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
      preview={<ReplyPreview content={parent.content} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(parent.id)}
    />
  );
}

interface ChatMessage2Props {
  event: ChatMsg;
  reactions: MessageReactions;
  zaps: MessageZaps | undefined;
  onSendZap: ((target: ChatMsg, payment: ZapPayment) => Promise<void>) | undefined;
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
  /** Resolved "replying to …" line for an inline reply (undefined otherwise). */
  replyContext: ReactNode;
  onDelete: ((event: ChatMsg) => void) | undefined;
  onRetry: ((event: ChatMsg) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
}

/** Memoized per-message binding (mirrors V1's ConcordChatMessage). A normal
 *  reply quotes the parent inline (`onReply`); "reply in thread" opens the
 *  thread panel (`onOpenThread`). */
const ChatMessage2 = memo(function ChatMessage2({
  event,
  reactions,
  zaps,
  onSendZap,
  replies,
  continuation,
  canWrite,
  canModerate,
  sendStatus,
  active,
  onToggleActive,
  onOpenThread,
  onReply,
  replyContext,
  onDelete,
  onRetry,
  onDiscard,
}: ChatMessage2Props) {
  const threadInfo = threadSummary(replies);
  // Concord V2 messages are unsigned rumors sealed at the channel's stream
  // address — there's no relay-addressable event id, so the "Copy message ID" /
  // "View on Ditto" off-ramps are nonsensical. Pass the rumor through so the
  // context menu offers "View event JSON" instead. Drop the synthetic empty
  // `sig` the transport adds for rendering (a rumor has no signature).
  const rumor = useMemo(() => {
    const { sig: _sig, ...rest } = event;
    return rest;
  }, [event]);
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
      onRetry={onRetry ? () => onRetry(event) : undefined}
      onDiscard={onDiscard ? () => onDiscard(event.id) : undefined}
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

function ChannelRow2({
  community,
  channel,
  active,
  inCall,
  speaking,
  muted: mutedVoice,
  unread,
  onSelect,
  onJoinVoice,
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
  onSelect: () => void;
  onJoinVoice: (channel: ChannelV2, broker: string | null, fold?: VoicePresenceFold) => void;
}) {
  // Voice channels (CORD-07): live presence drives the Discord-style nested
  // roster under the row, and the rendezvous broker is resolved ahead of the
  // click so joining is instant. Both hooks no-op for text channels.
  const fold = useVoicePresence2(community, channel);
  const { data: broker } = useVoiceBroker2(channel, fold);
  const { voiceRoomPubkeys } = useCall();
  const { isConcordChannelMuted, toggleConcordChannelMute } = useMutes();
  const muted = community
    ? isConcordChannelMuted("c2", community.idHex, channel.idHex)
    : false;
  const foldedParticipants = useMemo(() => fold.present.map((p) => p.author), [fold]);
  // While YOU are in this call, the connected room's live LiveKit roster is
  // authoritative — presence heartbeats lag (30s cadence, 90s staleness) and
  // desync. Folded presence remains the source for calls you're not in.
  const participants = inCall && voiceRoomPubkeys ? voiceRoomPubkeys : foldedParticipants;

  const Icon = channel.isVoice ? Volume2 : channel.isPrivate ? Lock : Hash;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  const occupied = channel.isVoice && participants.length > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div>
          <button
            type="button"
            onClick={() => {
              onSelect();
              // Discord-style: clicking a voice channel joins its call (and opens
              // its chat via onSelect).
              if (channel.isVoice && !inCall) onJoinVoice(channel, broker ?? null, fold);
            }}
            className={cn(
              // Slack-style selection: the active channel sits on a filled primary
              // rectangle with the house cut-corner chamfer (matches ChannelSidebar).
              "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 text-sm transition-colors text-left",
              !active && "text-muted-foreground hover:text-foreground hover:bg-foreground/5 clip-corner-lg",
              // Unread (but not selected) channels read brighter + bold (Slack).
              // Muted channels never bold — their unread is deliberately silent.
              !active && hasUnread && !muted && "text-foreground font-semibold",
              // Muted channels read dimmer (Discord-style).
              !active && muted && "opacity-60",
              active && "clip-corner-lg bg-primary text-primary-foreground font-medium",
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
          {/* Discord-style nested voice roster: who's in the call, under the row
              (with live speaking rings while you're in it). */}
          {channel.isVoice && <VoiceParticipantList participants={participants} speaking={speaking} muted={mutedVoice} />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          disabled={!community}
          onSelect={() => {
            if (community) toggleConcordChannelMute("c2", community.idHex, channel.idHex);
          }}
        >
          {muted ? (
            <>
              <Bell className="mr-2 size-4" /> Unmute channel
            </>
          ) : (
            <>
              <BellOff className="mr-2 size-4" /> Mute channel
            </>
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
    <div className="flex flex-col py-2">
      {mentions.map((msg) => {
        const channelIdHex = msg.tags.find((t) => t[0] === "channel")?.[1] ?? "";
        const ch = nameByChannel.get(channelIdHex);
        return (
          <div key={msg.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              {ch?.isVoice ? (
                <Volume2 className="size-3 shrink-0" />
              ) : ch?.isPrivate ? (
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
  const rumor = useMemo(() => {
    const { sig: _sig, ...rest } = event;
    return rest;
  }, [event]);
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
    <div className="flex flex-col py-2">
      {threads.map((t) => {
        const ch = nameByChannel.get(t.channelIdHex);
        return (
          <div key={t.root.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              {ch?.isVoice ? (
                <Volume2 className="size-3 shrink-0" />
              ) : ch?.isPrivate ? (
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
  const rumor = useMemo(() => {
    const { sig: _sig, ...rest } = event;
    return rest;
  }, [event]);
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
 * A Concord V2 community — CORD-01..06 Private Streams over interchangeable
 * relays, no host, no `#z` tags: every plane is kind-1059 traffic at derived
 * stream addresses. Lives at `/c/:communityId`, rehydrated from the
 * self-encrypted Community List. Renders through the SAME shared chat
 * components as NIP-29 / DMs / Concord V1; only the transport differs.
 */
export function ConcordV2Page() {
  const { communityId, channelId: routeChannelId } = useParams<{ communityId: string; channelId: string }>();
  const { user } = useCurrentUser();
  const isTouchDevice = useIsTouch();
  const { config, updateConfig } = useAppContext();
  const { mutedChannels, isCommunityMuted, toggleCommunityMute, toggleConcordChannelMute } = useMutes();
  const lastChannelKey = communityId ? `c2:${communityId}` : "";

  const baseCommunity = useCommunity2(communityId);
  const { data: folded } = useControlFold2(baseCommunity);
  // Overlay the folded, owner-controlled metadata onto the bundle preview.
  const community = useMemo<CommunityV2 | undefined>(() => {
    if (!baseCommunity) return undefined;
    if (!folded?.metadata) return baseCommunity;
    return { ...baseCommunity, name: folded.metadata.name || baseCommunity.name };
  }, [baseCommunity, folded]);
  const channels = useChannels2(baseCommunity);
  // Only show channel skeletons if there's nothing to render yet AND that has
  // lasted long enough to be worth a placeholder. On a cache hit the bundle
  // resolves within a frame or two, so the skeleton would otherwise flash for a
  // nanosecond — which reads as a glitch. Delay it so fast loads show nothing.
  const showChannelSkeleton = useDelayedFlag(!community || channels.length === 0);

  // Per-channel unread badges, computed purely from the local rumor cache
  // (which the wire keeps fed for every channel of every community).
  const { byChannel: unreadByChannel, markRead: markChannelRead } = useConcord2Unread(channels);

  // Community-wide "@ Mentions" — every cached kind-9 that p-tags the user,
  // across all channels, served from the local rumor cache only.
  const { mentions, isLoading: mentionsLoading } = useConcord2Mentions(channels);
  // The "@ Mentions" item lights up like a channel does: it's "unread" when
  // ANY channel has an unread mention (same read-state the channel rows use),
  // so opening the channel that mentioned you clears both together.
  const hasUnreadMention = useMemo(
    () => Object.values(unreadByChannel).some((u) => u.mention),
    [unreadByChannel],
  );

  // Community-wide "Threads" — threads the user participated in (authored the
  // root or a reply), newest-reply first, from the local rumor cache only.
  // Lights up when any has replies newer than the user last opened it.
  const {
    threads,
    isLoading: threadsLoading,
    hasNew: hasNewThreadReplies,
    markRead: markThreadRead,
  } = useConcord2Threads(channels);

  // Authenticate the connection as this community's per-channel stream keys
  // (control/guestbook/dissolved keys are registered app-wide in MainLayout).
  useRegisterChannelStreamKeys2(communityId);

  // React to base-rekey rotations (adopt the new epoch, or discover removal).
  useRekeyWatch2(baseCommunity);

  const [channelIdHex, setChannelIdHex] = useState<string | null>(routeChannelId ?? null);
  useEffect(() => {
    if (routeChannelId) setChannelIdHex(routeChannelId);
  }, [routeChannelId]);
  // Which pane the main area shows: the selected channel's chat, the
  // community-wide "@ Mentions" list, or the "Threads" list. Selecting a
  // channel returns to chat.
  const [view, setView] = useState<"channel" | "mentions" | "threads">("channel");
  useEffect(() => {
    if (routeChannelId) setView("channel");
  }, [routeChannelId]);
  const selectChannel = useCallback((idHex: string) => {
    setChannelIdHex(idHex);
    setView("channel");
  }, []);
  // A pending "jump to message" target set by clicking a mention: switch to its
  // channel, then scroll+highlight it once that channel's timeline has loaded
  // it (an effect below fires when the message appears in `allMessages`).
  const [jumpTarget, setJumpTarget] = useState<{ channelIdHex: string; messageId: string } | null>(null);
  const timelineRef = useRef<MessageTimelineHandle | null>(null);
  const jumpToMention = useCallback(
    (channelIdHex: string, messageId: string) => {
      setJumpTarget({ channelIdHex, messageId });
      selectChannel(channelIdHex);
      setChannelsOpen(false);
    },
    [selectChannel],
  );
  // Opening a thread from the Threads tab: switch to its channel, then open the
  // thread panel once that channel's transport has the root loaded (an effect
  // below fires when the root appears in `allMessages`). Marks the thread read.
  const [pendingThread, setPendingThread] = useState<Concord2Thread | null>(null);
  const openThreadFromList = useCallback(
    (thread: Concord2Thread) => {
      markThreadRead(thread.root.id, thread.lastReplyAt);
      setPendingThread(thread);
      selectChannel(thread.channelIdHex);
      setChannelsOpen(false);
    },
    [selectChannel, markThreadRead],
  );
  // Let `#channel-name` hashtags in chat jump to that local channel.
  const navChannels = useMemo(
    () => channels.map((c) => ({ name: c.name, go: () => selectChannel(c.idHex) })),
    [channels, selectChannel],
  );
  const channelNav = useChannelNavValue(navChannels);

  const channel = useMemo(() => {
    if (channels.length === 0) return undefined;
    if (channelIdHex) return channels.find((c) => c.idHex === channelIdHex) ?? channels[0];
    return pickDefaultChannel(
      channels,
      config.lastChannelByServer[lastChannelKey],
      (c) => c.idHex,
      (c) => c.name,
    );
  }, [channels, channelIdHex, config.lastChannelByServer, lastChannelKey]);

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

  const { setTier } = useRoles2(community);
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const roster = folded?.roster;
  const canManageRoles = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_ROLES));
  const canManageMetadata = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_METADATA));
  const canManageChannels = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS));
  const canKickAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.KICK));
  const canBanAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.BAN));
  const canModerateMessages = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_MESSAGES));
  const canWrite = Boolean(user && channel);

  const { transport: baseTransport, reactionsFor, allMessages } = useTransport2(community, channel, canWrite, canModerateMessages);
  const { mutateAsync: send } = useSendMessage2(community, channel);

  // Fulfil a pending mention jump: once the target channel is active AND its
  // timeline has loaded the target message, scroll+highlight it, then clear
  // the target. `scrollToMessage` is a no-op if the row isn't mounted yet, so
  // we retry as `allMessages` grows (backfill) until it lands or the channel
  // changes out from under us.
  useEffect(() => {
    if (!jumpTarget || view !== "channel") return;
    if (channel?.idHex !== jumpTarget.channelIdHex) return;
    if (!allMessages.some((m) => m.id === jumpTarget.messageId)) return;
    const id = jumpTarget.messageId;
    const t = setTimeout(() => timelineRef.current?.scrollToMessage(id), 60);
    setJumpTarget(null);
    return () => clearTimeout(t);
  }, [jumpTarget, view, channel?.idHex, allMessages]);

  // Mark the open channel read up to its newest message while it's on screen —
  // immediately and again on tab refocus (mirrors GroupChat's NIP-29 behavior).
  const channelIdForRead = channel?.idHex;
  useEffect(() => {
    if (!user || !channelIdForRead || allMessages.length === 0) return;
    const latest = allMessages[allMessages.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markChannelRead(channelIdForRead, latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, channelIdForRead, allMessages, markChannelRead]);

  const { leave, isLeaving, dissolve, createChannel, isAddingChannel } = useCommunityManagement2(community);
  const { data: dissolved } = useDissolved2(community);
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
        const roomHex = ch.voice?.room.pk;
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

  const navigateTo = useNavigate();
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelVoice, setNewChannelVoice] = useState(false);

  // Close the inline create-channel form when switching communities — the
  // user's MANAGE_CHANNELS permission doesn't carry over.
  useEffect(() => {
    setCreatingChannel(false);
    setNewChannelName("");
    setNewChannelVoice(false);
    setCommunityMenuOpen(false);
  }, [communityId]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  // The community-name header menu (Discord-style): expands inline below the
  // header, pushing the channel list down with a height animation.
  const [communityMenuOpen, setCommunityMenuOpen] = useState(false);
  /** Member roster pane. Defaults OFF on touch devices (a landscape phone
   * crosses the 900px breakpoint but is too short to spare the roster width);
   * openable from the header toggle. On real desktop it stays on. */
  const [membersVisible, setMembersVisible] = useState(() => !isTouchDevice);
  const [membersOpen, setMembersOpen] = useState(false);
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
  const [navKey, setNavKey] = useState(`${communityId}\u0000${routeChannelId ?? ""}`);
  const curNavKey = `${communityId}\u0000${routeChannelId ?? ""}`;
  if (navKey !== curNavKey) {
    setNavKey(curNavKey);
    setChannelsOpen(!routeChannelId);
  }
  const [threadRoot, setThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback((id: string) => setActiveId((cur) => (cur === id ? undefined : id)), []);

  // Member list: the coalesced Guestbook (joins) ∪ observed authors ∪ roster,
  // minus the banned — the Complete Memberlist (CORD-02 §5).
  const memberAdmins = useMemo(() => {
    const out: Array<{ pubkey: string; roles: string[] }> = [];
    if (ownerHex) out.push({ pubkey: ownerHex, roles: ["owner"] });
    if (roster) {
      for (const g of roster.grants) {
        if (g.member === ownerHex) continue;
        const badge = badgeOf(roster, g.member);
        if (badge) out.push({ pubkey: g.member, roles: [badge] });
      }
    }
    return out;
  }, [roster, ownerHex]);

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
    const set = completeMemberlist(coalesced, observed, banned);
    for (const g of roster?.grants ?? []) if (g.roleIds.length > 0 && !banned.has(g.member)) set.add(g.member);
    if (ownerHex) set.add(ownerHex);
    if (user && !banned.has(user.pubkey)) set.add(user.pubkey);
    return [...set];
  }, [coalesced, allMessages, roster, ownerHex, user, folded]);

  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    setThreadAutoFocus(focusReply);
    setThreadRoot(event);
  }, []);

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

  // Fulfil a pending Threads-tab open: once its channel is active and the
  // transport has loaded the root, open the thread panel with the freshly
  // resolved root (so replies bucket correctly), then clear the target.
  useEffect(() => {
    if (!pendingThread) return;
    if (channel?.idHex !== pendingThread.channelIdHex) return;
    const loaded = allMessages.find((m) => m.id === pendingThread.root.id);
    if (!loaded) return;
    openThread(loaded);
    setPendingThread(null);
  }, [pendingThread, channel?.idHex, allMessages, openThread]);

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
  const transport = useMemo(() => ({ ...baseTransport, openThread }), [baseTransport, openThread]);

  const onOpenThreadCb = useMemo(
    () => (canWrite ? (event: ChatMsg) => openThread(event, true) : undefined),
    [canWrite, openThread],
  );

  const moderation = useModeration2(community, memberPubkeys);

  const publishTyping = useTypingPublisher2(community, channel);
  const typingPubkeys = useTyping2(community, channel);

  // A dissolved community is terminal — read-only would be ideal; for now
  // navigate home (the list entry stays until the user leaves).
  useEffect(() => {
    if (dissolved) navigateTo("/");
  }, [dissolved, navigateTo]);

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
  };

  const handleCreateChannel = async () => {
    const name = newChannelName.trim();
    if (!name || !community) return;
    try {
      const { channelIdHex: created } = await createChannel({ name, voice: newChannelVoice });
      selectChannel(created);
      setNewChannelName("");
      setNewChannelVoice(false);
      setCreatingChannel(false);
    } catch {
      // keep the input open so the user can retry
    }
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
    if (!confirm("Permanently delete this community for everyone? This cannot be undone.")) return;
    try {
      await dissolve();
      toast({ title: "Community deleted" });
      navigateTo("/");
    } catch (e) {
      toast({ title: "Couldn't delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
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

  const handleBan = async (pubkey: string) => {
    try {
      const { rekeyed } = await moderation.ban({ target: pubkey });
      if (rekeyed) {
        toast({ title: "Member banned", description: "Keys rotated; they can no longer read new messages." });
      } else {
        toast({ title: "Member banned", description: "Added to the banlist; key rotation didn't complete (you can retry)." });
      }
    } catch (e) {
      toast({ title: "Couldn't ban", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const channelList = (onNavigate?: () => void, className?: string) => (
    <ChannelSidebarView
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
                    show: true,
                    icon: <Settings className="size-4" />,
                    label: "Community settings",
                    onClick: () => setInfoOpen(true),
                  },
                  {
                    show: !!user,
                    icon: <UserPlus className="size-4" />,
                    label: "Invite people",
                    onClick: () => setInviteOpen(true),
                  },
                  {
                    show: canManageChannels,
                    icon: <Plus className="size-4" />,
                    label: "Create channel",
                    onClick: () => setCreatingChannel(true),
                  },
                  {
                    show: canManageRoles,
                    icon: <Shield className="size-4" />,
                    label: "Manage roles",
                    onClick: () => setRolesOpen(true),
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
                      Leave community
                    </button>
                    {iAmOwner && (
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2 text-sm text-left text-destructive transition-colors clip-corner-lg hover:bg-destructive/10"
                        onClick={() => {
                          handleDissolve();
                          setCommunityMenuOpen(false);
                        }}
                      >
                        <Trash2 className="size-4" />
                        Delete community
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
            <button
              type="button"
              onClick={() => {
                setView("mentions");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 text-sm transition-colors text-left clip-corner-lg",
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
                setView("threads");
                onNavigate?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 text-sm transition-colors text-left clip-corner-lg",
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
          </>
        ) : undefined
      }
      channelsHeaderExtra={
        creatingChannel ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateChannel();
            }}
            className="mx-2 my-1 p-1.5 space-y-1.5 clip-corner-lg bg-foreground/5"
          >
            {/* Channel type: an explicit Text / Voice segmented choice (the
                CORD-07 `voice` flag is minted with the channel; Discord-style). */}
            <div className="flex gap-1" role="radiogroup" aria-label="Channel type">
              <button
                type="button"
                role="radio"
                aria-checked={!newChannelVoice}
                onClick={() => setNewChannelVoice(false)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1 text-xs font-medium clip-corner-lg transition-colors",
                  !newChannelVoice
                    ? "bg-primary text-primary-foreground"
                    : "bg-foreground/5 text-muted-foreground hover:text-foreground",
                )}
              >
                <Hash className="size-3.5" />
                Text
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={newChannelVoice}
                onClick={() => setNewChannelVoice(true)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1 text-xs font-medium clip-corner-lg transition-colors",
                  newChannelVoice
                    ? "bg-primary text-primary-foreground"
                    : "bg-foreground/5 text-muted-foreground hover:text-foreground",
                )}
              >
                <Volume2 className="size-3.5" />
                Voice
              </button>
            </div>
            <div className="flex items-center gap-1">
              <Input
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                placeholder={newChannelVoice ? "e.g. lounge, music, game-night" : "e.g. general, memes, dev-talk"}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setCreatingChannel(false);
                    setNewChannelName("");
                    setNewChannelVoice(false);
                  }
                }}
                className="h-7 text-sm"
              />
              <Button
                type="submit"
                size="icon"
                className="size-7 shrink-0 clip-corner-lg"
                aria-label={newChannelVoice ? "Create voice channel" : "Create text channel"}
                disabled={isAddingChannel || !newChannelName.trim()}
              >
                {isAddingChannel ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </Button>
            </div>
          </form>
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
        channels.map((c) => {
          const inCall = Boolean(activeCall?.concord && activeCall.concord.channel.idHex === c.idHex);
          return (
            <ChannelRow2
              key={c.idHex}
              community={community}
              channel={c}
              active={Boolean(view === "channel" && channel && channel.idHex === c.idHex)}
              inCall={inCall}
              speaking={inCall ? speakingPubkeys : undefined}
              muted={inCall ? mutedPubkeys : undefined}
              unread={unreadByChannel[c.idHex]}
              onSelect={() => {
                selectChannel(c.idHex);
                onNavigate?.();
              }}
              onJoinVoice={handleJoinVoice}
            />
          );
        })
      )}
    </ChannelSidebarView>
  );

  return (
    <ChannelNavContext.Provider value={channelNav}>
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
              className="size-9 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>

            {/* Desktop / wide: "# channel-name" (or "@ Mentions" / "Threads"). */}
            <div className="hidden sidebar:flex items-center gap-1.5 min-w-0">
              {view === "mentions" ? (
                <>
                  <AtSign className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Mentions</h1>
                </>
              ) : view === "threads" ? (
                <>
                  <MessagesSquare className="size-5 text-muted-foreground shrink-0" />
                  <h1 className="font-semibold truncate leading-tight">Threads</h1>
                </>
              ) : (
                <>
                  {channel?.isVoice ? (
                    <Volume2 className="size-5 text-muted-foreground shrink-0" />
                  ) : channel?.isPrivate ? (
                    <Lock className="size-5 text-muted-foreground shrink-0" />
                  ) : (
                    <Hash className="size-5 text-muted-foreground shrink-0" />
                  )}
                  <h1 className="font-semibold truncate leading-tight">{channel?.name ?? "…"}</h1>
                </>
              )}
            </div>

            {/* Mobile: community avatar + name large, channel muted below */}
            <button
              type="button"
              className="flex sidebar:hidden items-center gap-2.5 min-w-0 text-left"
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
                  ) : view === "threads" ? (
                    <>
                      <MessagesSquare className="size-3 shrink-0" />
                      Threads
                    </>
                  ) : (
                    <>
                      {channel?.isVoice ? (
                        <Volume2 className="size-3 shrink-0" />
                      ) : channel?.isPrivate ? (
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
            <div className="ml-auto flex items-center gap-0.5">
              {user && channel?.isVoice && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 touch:size-10", inThisVoice && "text-success")}
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
              {user && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8 touch:size-10" aria-label="Invite people" onClick={() => setInviteOpen(true)}>
                      <UserPlus className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Invite people</TooltipContent>
                </Tooltip>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Members"
                aria-pressed={membersOpen}
                className="size-8 touch:size-10 sidebar:hidden"
                onClick={() => setMembersOpen((v) => !v)}
              >
                <Users className="size-4" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 hidden sidebar:inline-flex text-muted-foreground", membersVisible && "text-foreground")}
                    aria-label={membersVisible ? "Hide members" : "Show members"}
                    aria-pressed={membersVisible}
                    onClick={() => setMembersVisible((v) => !v)}
                  >
                    <Users className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
              </Tooltip>
              {user && community && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 touch:size-10"
                      disabled={!channel}
                      aria-label={channelMuted ? "Unmute channel" : "Mute channel"}
                      onClick={() => {
                        if (channel) toggleConcordChannelMute("c2", community.idHex, channel.idHex);
                      }}
                    >
                      {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{channelMuted ? "Unmute channel" : "Mute channel"}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </header>

          {/* Top-of-chat call stage portal target (active when this channel is
              the one in encrypted voice). */}
          <CallStageSlot active={inThisVoice} />

          <div className="relative flex flex-1 min-h-0">
            <div className="flex-1 min-w-0 flex flex-col">
              {view === "mentions" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable">
                  <MentionsView
                    channels={channels}
                    mentions={mentions}
                    isLoading={mentionsLoading}
                    onJump={jumpToMention}
                  />
                </div>
              ) : view === "threads" ? (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable">
                  <ThreadsView
                    channels={channels}
                    threads={threads}
                    isLoading={threadsLoading}
                    onOpen={openThreadFromList}
                  />
                </div>
              ) : (
                <>
                  <MessageTimeline
                    key={channel?.idHex ?? "none"}
                    transport={transport}
                    handleRef={timelineRef}
                    className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
                    emptyState={
                      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                        No messages yet. Say something — only members can read it.
                      </p>
                    }
                    renderMessage={(msg, continuation) => {
                      const replyId = getQuoteReplyToId(msg);
                      return (
                      <ChatMessage2
                        key={msg.id}
                        event={msg}
                        reactions={reactionsFor(msg.id)}
                        zaps={transport.zapsFor?.(msg.id)}
                        onSendZap={transport.sendZap}
                        replies={transport.threadRepliesFor?.(msg.id) ?? EMPTY_REPLIES}
                        continuation={continuation}
                        canWrite={transport.canWrite}
                        canModerate={transport.canModerate}
                        sendStatus={transport.sendStatusFor?.(msg.id)}
                        active={activeId === msg.id}
                        onToggleActive={toggleActive}
                        onOpenThread={onOpenThreadCb}
                        onReply={canWrite ? setReplyTo : undefined}
                        replyContext={
                          replyId ? (
                            <ReplyContext2 parent={messagesById.get(replyId)} onJump={jumpWithinChannel} />
                          ) : undefined
                        }
                        onDelete={transport.deleteMessage}
                        onRetry={transport.retry}
                        onDiscard={transport.discard}
                      />
                      );
                    }}
                  />

                  {typingPubkeys.length > 0 && <TypingIndicator pubkeys={typingPubkeys} />}
                  {channel && (
                    <ChatComposer
                      relayUrl="dm"
                      groupId={channel.idHex}
                      messages={[]}
                      mentionPubkeys={memberPubkeys}
                      placeholder={user ? `Message #${channel.name}` : "Sign in to send"}
                      sendOverride={handleSend}
                      replyTo={replyTo}
                      replyMarker="nipc7"
                      onCancelReply={() => setReplyTo(undefined)}
                      onTyping={publishTyping}
                      encryptAttachments
                    />
                  )}
                </>
              )}
            </div>

            {/* Thread panel. Desktop: in-flow sibling whose width animates open.
                Mobile: overlays the chat. Mirrors GroupChat. */}
            <div
              className={cn(
                "overflow-hidden",
                "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
                "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
                threadRoot ? "sidebar:w-[23rem]" : "pointer-events-none sidebar:pointer-events-auto",
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
                  "relative h-full flex w-full sidebar:w-[23rem] transition-transform duration-200 ease-out",
                  threadRoot ? "translate-x-0" : "translate-x-full",
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
                    autoFocus={threadAutoFocus}
                    onClose={() => setThreadRoot(undefined)}
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
                  admins={memberAdmins}
                  members={memberPubkeys}
                  canModerate={canManageRoles || canKickAny || canBanAny}
                  viewerIsAdmin={iAmOwner}
                  currentUserPubkey={user?.pubkey}
                  onSetRole={canManageRoles ? handleSetRole : undefined}
                  onKick={canKickAny ? (pk) => moderation.kick({ target: pk }).catch(() => {}) : undefined}
                  onBan={canBanAny ? handleBan : undefined}
                  onUnban={canBanAny ? (pk) => moderation.unban({ target: pk }).catch(() => {}) : undefined}
                  bannedPubkeys={moderation.banned}
                  onClose={() => setMembersOpen(false)}
                />
              </div>
            </div>
          </div>
        </main>
      </SwipeReveal>

      <InviteDialog2 community={community} open={inviteOpen} onOpenChange={setInviteOpen} />
      <CommunityInfoDialog2
        community={community}
        metadata={folded?.metadata}
        ownerHex={ownerHex}
        memberCount={memberPubkeys.length}
        canManageMetadata={canManageMetadata}
        canManageChannels={canManageChannels}
        open={infoOpen}
        onOpenChange={setInfoOpen}
      />
      <RolesDialog2 community={community} open={rolesOpen} onOpenChange={setRolesOpen} />
    </ChannelNavContext.Provider>
  );
}
