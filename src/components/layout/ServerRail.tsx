import { Bell, Bluetooth, CheckCheck, Compass, Folder, FolderOpen, Headphones, Lock, LogOut, MailPlus, MessageSquare, PanelLeftDashed, Plus, Settings, Trash2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import type React from "react";

import { AddDialog } from "@/components/dialogs/AddDialog";
import { DmAvatar } from "@/components/DmAvatar";
import { AvatarInitial } from "@/components/AvatarInitial";
import { NoteToSelfAvatar, NOTE_TO_SELF_NAME } from "@/components/NoteToSelfAvatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_RAIL_RECENT_DMS } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { CommunityListLocked } from "@/concord/components/CommunityListLocked";
import { useCommunityManagement } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useIsExcluded, useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useConcordMentions } from "@/concord/hooks/useConcordMentions";
import { useConcordUnread } from "@/concord/hooks/useConcordUnread";
import { useInviteInbox } from "@/concord/hooks/useDirectInvites";
import { useCommunityIcon } from "@/concord/hooks/useCommunityIcon";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmActivity, type DmActivityItem } from "@/hooks/useDmActivity";
import { useDmConversationName } from "@/hooks/useDmConversationName";
import { useDmPeerUnread, useHasUnreadDMs } from "@/hooks/useDirectMessages";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useMutes } from "@/hooks/useMutes";
import { useNotifLevels, communityScopeKey, dmScopeKey } from "@/hooks/useNotifLevels";
import { useRailDms } from "@/hooks/useRailDms";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { useSwipeLayout } from "@/components/layout/SwipeReveal";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useServerActions } from "@/hooks/useServerActions";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useDragPointerDown, usePressDrag } from "@/hooks/usePressDrag";
import { useFlipReorder } from "@/hooks/useFlipReorder";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { SETTINGS_PATH, SettingsOverlayContext } from "@/lib/settingsOverlay";
import {
  applyDrop,
  dissolveFolder,
  dmRailKey,
  flattenLayout,
  folderAnchor,
  itemAnchor,
  mergeLayout,
  normalizeLayout,
  planDrop,
  railDmPubkeys,
  renameFolder,
} from "@/lib/railLayout";
import { common, defineMessages, FormattedMessage, t, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import type {
  RailDragSource,
  RailDropPlan,
  RailLayoutNode,
  RailSlot,
} from "@/lib/railLayout";

const RAIL_MESSAGES = defineMessages({
  mentioned: { id: "serverRail.mentioned", defaultMessage: "You were mentioned" },
  unread: { id: "serverRail.unread", defaultMessage: "Unread messages" },
  markAsRead: { id: "serverRail.markAsRead", defaultMessage: "Mark as read" },
  messageNotifications: { id: "serverRail.messageNotifications", defaultMessage: "Message notifications" },
  unreadCount: {
    id: "serverRail.unreadCount",
    defaultMessage: "{count, plural, one {# unread message} other {# unread messages}}",
  },
});

function RailTooltipContent({ className, ...props }: React.ComponentProps<typeof TooltipContent>) {
  return <TooltipContent className={cn("rail-tooltip-content", className)} {...props} />;
}

function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A unified rail entry (NIP-29 server, Concord community, or DM); `key` is stable for drag, folders and the persisted layout. */
type RailItem =
  | { kind: "server"; key: string; url: string }
  | { kind: "concord"; key: string; communityId: string; name: string }
  | { kind: "dm"; key: string; pubkey: string };

const concordKey = (communityId: string) => `c2:${communityId}`;

/** The peer's thread, not `/dm`: on mobile `/dm` would land on the list this icon skips. */
const dmRoute = (pubkey: string) => `/dm/${nip19.npubEncode(pubkey)}`;

type RenderNode =
  | { type: "item"; item: RailItem }
  | { type: "folder"; id: string; name: string; items: RailItem[] };

/**
 * Drag props for rail entries. Pointer listeners attach natively via a ref
 * (Radix `asChild` Slots don't reliably forward pointer props); nodes carry
 * `data-rail-anchor` (+ `data-rail-parent`) for slot geometry at pickup.
 */
interface RailDragProps {
  draggable?: boolean;
  dragging?: boolean;
  /** Any drag in progress (locks touch-action). */
  reordering?: boolean;
  highlight?: boolean;
  dragParent?: string;
  onDragPointerDown?: (e: PointerEvent) => void;
  /** True if a click should be suppressed (a drag just finished). */
  shouldSuppressClick?: () => boolean;
  /** Optimistic active highlight on the tap frame, before the transition-wrapped route commits. */
  pending?: boolean;
  onPressed?: () => void;
}

/** Reports a rail entry's menu opening or closing, so the rail can dim the rest of the app on touch. */
const RailMenuOpenContext = createContext<((open: boolean) => void) | undefined>(undefined);

function dragAttrs(anchor: string, parent?: string): Record<string, string> {
  return { "data-rail-anchor": anchor, ...(parent ? { "data-rail-parent": parent } : {}) };
}

function MiniUnreadDot({ mention, unread }: { mention: boolean; unread: boolean }) {
  const intl = useIntl();
  if (!mention && !unread) return null;
  return (
    <span
      className={cn(
        "absolute -top-px -right-px z-10 size-1.5 rounded-full ring-1 ring-background",
        mention ? "bg-primary" : "bg-foreground",
      )}
      aria-label={mention ? intl.formatMessage(RAIL_MESSAGES.mentioned) : intl.formatMessage(RAIL_MESSAGES.unread)}
    />
  );
}

function ServerMiniIcon({ url }: { url: string }) {
  const { data: info } = useRelayInfo(url);
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  const name = info?.name || relayHost(url);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  // NIP-11 icon is relay-controlled.
  const icon = useMediaSrc(sanitizeImageSrc(info?.icon));
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-sm bg-secondary">
      {icon ? (
        <img src={icon} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-monogram font-semibold leading-none text-secondary-foreground">{initial}</span>
      )}
      <MiniUnreadDot mention={anyMention} unread={anyUnread} />
    </span>
  );
}

function Concord2MiniIcon({ communityId, name }: { communityId: string; name: string }) {
  const community = useCommunity(communityId);
  const { data: folded } = useControlFold(community, false);
  const iconUrl = useCommunityIcon(communityId, folded ? (folded.metadata?.icon ?? null) : undefined);
  const displayName = folded?.metadata?.name || name;
  const initial = displayName.trim().charAt(0).toUpperCase() || "·";
  const channels = useChannels(community, false);
  const { byChannel } = useConcordUnread(community, channels);
  const { isConcordChannelMuted } = useMutes();
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-sm bg-muted text-success">
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-monogram font-semibold leading-none">{initial}</span>
      )}
      <MiniUnreadDot
        mention={Object.values(byChannel).some((u) => u.mention)}
        unread={Object.keys(byChannel).some((id) => !isConcordChannelMuted("c2", communityId, id))}
      />
    </span>
  );
}

function DmMiniIcon({ pubkey }: { pubkey: string }) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? intl.formatMessage(NOTE_TO_SELF_NAME) : getDisplayName(metadata, pubkey);
  const unread = useDmPeerUnread(pubkey);
  return (
    <span className="relative flex items-center justify-center">
      {noteToSelf ? (
        <NoteToSelfAvatar sizePx={16} className="size-full" />
      ) : (
        <Avatar shape={getAvatarShape(metadata)} className="size-full">
          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt="" draggable={false} />
          <AvatarFallback className="bg-primary/20 text-monogram font-semibold leading-none text-primary">
            <AvatarInitial name={name} pubkey={pubkey} />
          </AvatarFallback>
        </Avatar>
      )}
      {/* A DM has no channels — the message IS the mention, so plain unread dot. */}
      <MiniUnreadDot mention={false} unread={unread} />
    </span>
  );
}

function RailMiniIcon({ item }: { item: RailItem }) {
  if (item.kind === "server") return <ServerMiniIcon url={item.url} />;
  if (item.kind === "dm") return <DmMiniIcon pubkey={item.pubkey} />;
  return <Concord2MiniIcon communityId={item.communityId} name={item.name} />;
}

// A collapsed folder must light for ANY member, not just the four shown.
// Hooks can't loop, so each member mounts an invisible probe that reports up.

function ServerUnreadProbe({
  url,
  onChange,
}: {
  url: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  useEffect(() => onChange(anyUnread, anyMention), [anyUnread, anyMention, onChange]);
  return null;
}

function Concord2UnreadProbe({
  communityId,
  onChange,
}: {
  communityId: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const community = useCommunity(communityId);
  const channels = useChannels(community, false);
  const { byChannel } = useConcordUnread(community, channels);
  const { isConcordChannelMuted } = useMutes();
  const unread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c2", communityId, id),
  );
  const mention = Object.values(byChannel).some((u) => u.mention);
  useEffect(() => onChange(unread, mention), [unread, mention, onChange]);
  return null;
}

function DmUnreadProbe({
  pubkey,
  onChange,
}: {
  pubkey: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const unread = useDmPeerUnread(pubkey);
  useEffect(() => onChange(unread, false), [unread, onChange]);
  return null;
}

function RailItemUnreadProbe({
  item,
  onChange,
}: {
  item: RailItem;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  if (item.kind === "server") return <ServerUnreadProbe url={item.url} onChange={onChange} />;
  if (item.kind === "dm") return <DmUnreadProbe pubkey={item.pubkey} onChange={onChange} />;
  return <Concord2UnreadProbe communityId={item.communityId} onChange={onChange} />;
}

function ServerMentionProbe({
  url,
  onChange,
}: {
  url: string;
  onChange: (key: string, mention: boolean) => void;
}) {
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((group) => group.id), [groups]);
  const { anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  useEffect(() => onChange(url, anyMention), [url, anyMention, onChange]);
  useEffect(() => () => onChange(url, false), [url, onChange]);
  return null;
}

function ConcordMentionProbe({
  communityId,
  onChange,
}: {
  communityId: string;
  onChange: (key: string, mention: boolean) => void;
}) {
  const community = useCommunity(communityId);
  const channels = useChannels(community, false);
  // Follows the community's dedicated Mentions read stamp, so clearing the Bell
  // doesn't mark every mentioned channel read.
  const { hasNew: mention } = useConcordMentions(community, channels);
  const key = concordKey(communityId);
  useEffect(() => onChange(key, mention), [key, mention, onChange]);
  useEffect(() => () => onChange(key, false), [key, onChange]);
  return null;
}

function FolderMiniGrid({ items }: { items: RailItem[] }) {
  return (
    <span className="grid size-12 grid-cols-2 grid-rows-2 gap-1 clip-corner-lg bg-secondary/80 p-1.5">
      {items.slice(0, 4).map((item) => (
        <RailMiniIcon key={item.key} item={item} />
      ))}
    </span>
  );
}

function ServerDragGhost({ url }: { url: string }) {
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="block size-12 rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      <Avatar className="size-12 clip-corner-lg ring-2 ring-primary">
        <AvatarImage src={info?.icon} alt={name} />
        <AvatarFallback className="bg-secondary font-semibold text-primary">
          {initial}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}

function Concord2DragGhost({ communityId, name }: { communityId: string; name: string }) {
  const community = useCommunity(communityId);
  const { data: folded } = useControlFold(community, false);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useCommunityIcon(communityId, folded ? (folded.metadata?.icon ?? null) : undefined);
  return (
    <span className="flex items-center justify-center size-12 rotate-[-6deg] scale-110 clip-corner-lg overflow-hidden bg-muted text-success ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-sm font-semibold">{initials}</span>
      )}
    </span>
  );
}

function DmDragGhost({ pubkey }: { pubkey: string }) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? intl.formatMessage(NOTE_TO_SELF_NAME) : getDisplayName(metadata, pubkey);
  return (
    <span className="block size-12 rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      {noteToSelf ? (
        <NoteToSelfAvatar sizePx={48} className="size-12 ring-2 ring-primary" />
      ) : (
        <Avatar shape={getAvatarShape(metadata)} className="size-12 ring-2 ring-primary">
          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
          <AvatarFallback className="bg-primary/20 font-semibold text-primary">
            <AvatarInitial name={name} pubkey={pubkey} />
          </AvatarFallback>
        </Avatar>
      )}
    </span>
  );
}

function ghostTransform(x: number, y: number): string {
  return `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
}

function sameDropPlan(a: RailDropPlan | null, b: RailDropPlan | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Positioned by its owner writing `transform` (see `placeGhost`), never by a re-render. */
function DragGhost({
  ref,
  item,
  folderItems,
}: {
  ref: React.Ref<HTMLDivElement>;
  item?: RailItem;
  folderItems?: RailItem[];
}) {
  return (
    <div ref={ref} className="pointer-events-none fixed left-0 top-0 z-[300] will-change-transform">
      {/* The entrance animates `transform` too, so it lives on an inner element. */}
      <div className="animate-in zoom-in-75 duration-150">
        {folderItems ? (
          <span className="block rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
            <FolderMiniGrid items={folderItems} />
          </span>
        ) : item?.kind === "server" ? (
          <ServerDragGhost url={item.url} />
        ) : item?.kind === "dm" ? (
          <DmDragGhost pubkey={item.pubkey} />
        ) : item ? (
          <Concord2DragGhost communityId={item.communityId} name={item.name} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Keeps a dragged entry's content MOUNTED (hidden under the placeholder):
 * unmounting the touched node makes Chrome fire pointercancel on first move.
 */
function DragSlot({ dragging, children }: { dragging?: boolean; children: React.ReactNode }) {
  return (
    <>
      <span className={cn("contents", dragging && "invisible")}>{children}</span>
      {dragging && (
        <span className="absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5" />
      )}
    </>
  );
}

const ServerButton = memo(function ServerButton({
  url,
  onNavigate,
  onSelect,
  selected,
  inCall,
  draggable,
  dragging,
  reordering,
  highlight,
  dragParent,
  onDragPointerDown,
  shouldSuppressClick,
  pending,
  onPressed,
}: {
  url: string;
  onNavigate?: () => void;
  /** When provided, selecting a server fires this instead of navigating. */
  onSelect?: (url: string) => void;
  selected?: boolean;
  inCall?: boolean;
} & RailDragProps) {
  const intl = useIntl();
  const triggerRef = useRef<HTMLElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const { data: info } = useRelayInfo(url);
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { byGroup, anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  const { markRead } = useReadState();
  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { isRemovable, removeServer } = useServerActions(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const hasUnread = Object.keys(byGroup).length > 0;
  const markAllRead = useCallback(() => {
    for (const [groupId, unread] of Object.entries(byGroup)) {
      markRead(channelReadKey(url, groupId), unread.latest);
    }
  }, [byGroup, markRead, url]);

  const inner = (isActive: boolean) => (
    <>
      <span
        className={cn(
          "absolute -left-2 w-[3px] bg-primary transition-all",
          isActive ? "h-12 opacity-100" : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
        )}
      />
      {/* Glow is a drop-shadow on the wrapper so it traces the clip-path (box-shadow would be clipped). */}
      <span
        className={cn(
          "relative block size-12 transition-all duration-150",
          isActive && "[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
          highlight && "rounded-xl ring-2 ring-primary scale-110",
        )}
      >
        <Avatar
          className={cn(
            "size-12 clip-corner-lg transition-all duration-150",
            // (saturate-50: 75 isn't on Tailwind's scale.)
            "opacity-60 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
            (isActive || highlight) && "opacity-100 saturate-100",
            isActive && "is-active",
          )}
        >
          <AvatarImage src={info?.icon} alt={name} />
          <AvatarFallback
            className={cn(
              "bg-secondary font-semibold",
              isActive ? "text-primary" : "text-secondary-foreground",
            )}
          >
            {initial}
          </AvatarFallback>
        </Avatar>
        {inCall && (
          <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
            <Headphones className="size-2.5" />
          </span>
        )}
        {!isActive && anyMention ? (
          <span
            className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none ring-2 ring-background"
            aria-label={intl.formatMessage(RAIL_MESSAGES.mentioned)}
          >
            @
          </span>
        ) : !isActive && anyUnread ? (
          <span
            className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-foreground ring-2 ring-background"
            aria-label={intl.formatMessage(RAIL_MESSAGES.unread)}
          />
        ) : null}
      </span>
    </>
  );

  const triggerClass = "group relative flex items-center justify-center shrink-0 touch-none";

  const dragClass = cn(
    // No grab cursor on hover: it suggests HTML5 dragging.
    dragging && "cursor-grabbing",
    // Lock touch-action mid-reorder so the browser can't steal the gesture as a pan.
    reordering && "touch-none",
  );

  // Pointerdown is attached natively via `triggerRef` (see useDragPointerDown).
  const interactionProps = draggable ? dragAttrs(itemAnchor(url), dragParent) : {};

  const onMenuOpenChange = useContext(RailMenuOpenContext);
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            {onSelect ? (
              <button
                ref={triggerRef as React.RefObject<HTMLButtonElement>}
                type="button"
                aria-label={name}
                onClick={() => {
                  if (shouldSuppressClick?.()) return;
                  onSelect(url);
                }}
                className={cn(triggerClass, dragClass, selected && "is-active")}
                {...interactionProps}
              >
                <DragSlot dragging={dragging}>{inner(Boolean(selected))}</DragSlot>
              </button>
            ) : (
              <NavLink
                ref={triggerRef as React.RefObject<HTMLAnchorElement>}
                to={`/s/${relayToRouteParam(url)}`}
                aria-label={name}
                onClick={(e) => {
                  if (shouldSuppressClick?.()) {
                    e.preventDefault();
                    return;
                  }
                  onPressed?.();
                  onNavigate?.();
                }}
                // A STRING, not a function: Radix Slot cloning stringifies a function
                // className into its source text.
                className={cn(triggerClass, dragClass)}
                {...interactionProps}
              >
                {({ isActive }) => (
                  <DragSlot dragging={dragging}>{inner(isActive || Boolean(pending))}</DragSlot>
                )}
              </NavLink>
            )}
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {name}
          <span className="block text-xs text-muted-foreground">{url}</span>
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem className="gap-2" disabled={!hasUnread} onSelect={markAllRead}>
          <CheckCheck className="size-4" />
          <FormattedMessage {...RAIL_MESSAGES.markAsRead} />
        </ContextMenuItem>
        <NotifLevelMenu
          label={intl.formatMessage({ id: "serverRail.serverNotifications", defaultMessage: "Server notifications" })}
          level={communityLevel(url)}
          onChange={(lvl) => setNotifLevel(communityScopeKey(url), lvl)}
        />
        {isRemovable && (
          <ContextMenuItem
            className="gap-2 text-destructive focus:text-destructive"
            onSelect={removeServer}
          >
            <Trash2 className="size-4" />
            <FormattedMessage id="serverRail.removeServer" defaultMessage="Remove server" />
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Rail button for an E2EE Concord community (CORD-02); icon from the folded Control Plane. */
const Concord2Button = memo(function Concord2Button({
  communityId,
  name,
  onNavigate,
  draggable,
  dragging,
  reordering,
  highlight,
  dragParent,
  onDragPointerDown,
  shouldSuppressClick,
  pending,
  onPressed,
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
} & RailDragProps) {
  const intl = useIntl();
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const community = useCommunity(communityId);
  // active=false: don't fan out a control-plane REQ per community on pageload;
  // the community page syncs it, sharing this query key.
  const { data: folded } = useControlFold(community, false);
  // Kicked/banned: the icon stays (only Leave/Dissolve remove it), but is marked.
  const excluded = useIsExcluded(communityId);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useCommunityIcon(communityId, folded ? (folded.metadata?.icon ?? null) : undefined);

  // From the local rumor cache only. Muted channels don't light the dot; mentions still badge.
  const channels = useChannels(community, false);
  const { byChannel, markRead: markC2Read } = useConcordUnread(community, channels);
  const { isConcordChannelMuted } = useMutes();
  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();

  const anyUnread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c2", communityId, id),
  );
  const anyMention = Object.values(byChannel).some((u) => u.mention);
  const hasUnread = Object.keys(byChannel).length > 0;
  const markAllRead = useCallback(() => {
    for (const [channelId, unread] of Object.entries(byChannel)) {
      markC2Read(channelId, unread.latest);
    }
  }, [byChannel, markC2Read]);

  // Tombstone locally; Guestbook leave and vault write follow in the background.
  const navigate = useNavigate();
  const { leave } = useCommunityManagement(community);
  const handleLeave = async () => {
    try {
      await leave();
      navigate("/");
    } catch (e) {
      toast({
        title: t({ id: "serverRail.leaveFailed", defaultMessage: "Couldn't leave" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const onMenuOpenChange = useContext(RailMenuOpenContext);
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              ref={triggerRef}
          to={`/c/${encodeURIComponent(communityId)}`}
          aria-label={displayName}
          onClick={(e) => {
            if (shouldSuppressClick?.()) {
              e.preventDefault();
              return;
            }
            onPressed?.();
            onNavigate?.();
          }}
          className={cn(
            "group relative flex items-center justify-center shrink-0 touch-none",
            dragging && "cursor-grabbing",
            reordering && "touch-none",
          )}
          {...(draggable ? dragAttrs(itemAnchor(concordKey(communityId)), dragParent) : {})}
        >
          {({ isActive: routeActive }) => {
            const isActive = routeActive || Boolean(pending);
            return (
            <DragSlot dragging={dragging}>
              <>
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    isActive
                      ? "h-12 opacity-100"
                      : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                  )}
                />
                <span
                  className={cn(
                    "relative block size-12",
                    highlight && "rounded-xl ring-2 ring-primary scale-110 transition-all duration-150",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center size-12 clip-corner-lg overflow-hidden transition-all duration-150",
                      "bg-muted text-success opacity-60 saturate-50",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      (isActive || highlight) && "opacity-100 saturate-100",
                      isActive && "is-active",
                    )}
                  >
                    {iconUrl ? (
                      <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
                    ) : (
                      <span className="text-sm font-semibold">{initials}</span>
                    )}
                  </span>
                  {excluded ? (
                    <span
                      className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background"
                      aria-label={intl.formatMessage({ id: "serverRail.noAccessLabel", defaultMessage: "You no longer have access to this community" })}
                    >
                      <Lock className="size-2.5" />
                    </span>
                  ) : null}
                  {!isActive && anyMention ? (
                    <span
                      className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none ring-2 ring-background"
                      aria-label={intl.formatMessage(RAIL_MESSAGES.mentioned)}
                    >
                      @
                    </span>
                  ) : !isActive && anyUnread ? (
                    <span
                      className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-foreground ring-2 ring-background"
                      aria-label={intl.formatMessage(RAIL_MESSAGES.unread)}
                    />
                  ) : null}
                </span>
              </>
            </DragSlot>
            );
          }}
        </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {displayName}
          {excluded ? <span className="ml-1 font-normal text-muted-foreground"><FormattedMessage id="serverRail.noAccess" defaultMessage="· no access" /></span> : null}
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem className="gap-2" disabled={!hasUnread} onSelect={markAllRead}>
          <CheckCheck className="size-4" />
          <FormattedMessage {...RAIL_MESSAGES.markAsRead} />
        </ContextMenuItem>
        <NotifLevelMenu
          label={intl.formatMessage({ id: "serverRail.communityNotifications", defaultMessage: "Community notifications" })}
          level={communityLevel(concordKey(communityId))}
          onChange={(lvl) => setNotifLevel(concordKey(communityId), lvl)}
        />
        <ContextMenuItem
          className="gap-2 text-destructive focus:text-destructive"
          onSelect={handleLeave}
        >
          <LogOut className="size-4" />
          {excluded ? <FormattedMessage id="serverRail.leaveNoAccess" defaultMessage="Leave (no access)" /> : <FormattedMessage id="serverRail.leaveCommunity" defaultMessage="Leave community" />}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Rail button for a pinned DM; opens the thread (see `dmRoute`). */
const DmButton = memo(function DmButton({
  pubkey,
  unreadCount,
  onNavigate,
  inCall,
  draggable,
  dragging,
  reordering,
  highlight,
  dragParent,
  onDragPointerDown,
  shouldSuppressClick,
  pending,
  onPressed,
}: {
  pubkey: string;
  unreadCount?: number;
  onNavigate?: () => void;
  inCall?: boolean;
} & RailDragProps) {
  const intl = useIntl();
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  // Own conversation is Note to Self, not the viewer's face.
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? intl.formatMessage(NOTE_TO_SELF_NAME) : getDisplayName(metadata, pubkey);
  const unread = useDmPeerUnread(pubkey);
  const displayedUnreadCount = unreadCount ?? (unread ? 1 : 0);
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { removeFromRail } = useRailDms();

  const dimClass = (isActive: boolean) =>
    cn(
      "transition-all duration-150 opacity-60 saturate-50",
      "group-hover:opacity-100 group-hover:saturate-100",
      (isActive || highlight) && "opacity-100 saturate-100",
      isActive && "is-active",
    );

  const onMenuOpenChange = useContext(RailMenuOpenContext);
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              ref={triggerRef}
              to={dmRoute(pubkey)}
              aria-label={name}
              onClick={(e) => {
                if (shouldSuppressClick?.()) {
                  e.preventDefault();
                  return;
                }
                onPressed?.();
                onNavigate?.();
              }}
              className={cn(
                "group relative flex items-center justify-center shrink-0 touch-none",
                dragging && "cursor-grabbing",
                reordering && "touch-none",
              )}
              {...(draggable ? dragAttrs(itemAnchor(dmRailKey(pubkey)), dragParent) : {})}
            >
              {({ isActive: routeActive }) => {
                const isActive = routeActive || Boolean(pending);
                return (
                <DragSlot dragging={dragging}>
                  <>
                    <span
                      className={cn(
                        "absolute -left-2 w-[3px] bg-primary transition-all",
                        isActive
                          ? "h-12 opacity-100"
                          : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                      )}
                    />
                    <span
                      className={cn(
                        "relative block size-12",
                        highlight && "rounded-xl ring-2 ring-primary scale-110 transition-all duration-150",
                      )}
                    >
                      {noteToSelf ? (
                        <NoteToSelfAvatar sizePx={48} className={cn("size-12", dimClass(isActive))} />
                      ) : (
                        <Avatar
                          shape={getAvatarShape(metadata)}
                          className={cn("size-12", dimClass(isActive))}
                        >
                          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
                          <AvatarFallback className="bg-primary/20 font-semibold text-primary">
                            <AvatarInitial name={name} pubkey={pubkey} />
                          </AvatarFallback>
                        </Avatar>
                      )}
                      {inCall && (
                        <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                          <Headphones className="size-2.5" />
                        </span>
                      )}
                      {!isActive && displayedUnreadCount > 0 ? (
                        <span
                          className="absolute -top-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-bold leading-none text-primary-foreground ring-2 ring-background"
                          aria-label={intl.formatMessage(RAIL_MESSAGES.unreadCount, { count: displayedUnreadCount })}
                        >
                          {displayedUnreadCount > 99 ? "99+" : displayedUnreadCount}
                        </span>
                      ) : null}
                    </span>
                  </>
                </DragSlot>
                );
              }}
            </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {name}
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label={intl.formatMessage(RAIL_MESSAGES.messageNotifications)}
          level={dmLevel(pubkey)}
          onChange={(lvl) => setNotifLevel(dmScopeKey(pubkey), lvl)}
        />
        {/* Only removes the rail icon; the conversation is untouched. */}
        <ContextMenuItem className="gap-2" onSelect={() => removeFromRail(pubkey)}>
          <PanelLeftDashed className="size-4" />
          <FormattedMessage id="serverRail.removeFromRail" defaultMessage="Remove from rail" />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Automatic recent-conversation avatar; not in `railLayout` and not draggable. */
const RecentDmButton = memo(function RecentDmButton({
  item,
  onNavigate,
  inCall,
  pending,
  onPressed,
}: {
  item: DmActivityItem;
  onNavigate?: () => void;
  inCall?: boolean;
  pending?: boolean;
  onPressed?: () => void;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { name } = useDmConversationName(item.peers, user?.pubkey);
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();

  const onMenuOpenChange = useContext(RailMenuOpenContext);
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              to={item.route}
              data-recent-dm={item.key}
              aria-label={name}
              onClick={() => {
                onPressed?.();
                onNavigate?.();
              }}
              className="group relative flex items-center justify-center shrink-0"
            >
              {({ isActive: routeActive }) => {
                const isActive = routeActive || Boolean(pending);
                return (
                  <>
                    <span
                      className={cn(
                        "absolute -left-2 w-[3px] bg-primary transition-all",
                        isActive
                          ? "h-12 opacity-100"
                          : "h-2 opacity-0 group-hover:h-6 group-hover:opacity-60",
                      )}
                    />
                    <span className={cn(
                      "relative block size-12 transition-all duration-150",
                      isActive && "[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                    )}>
                      <DmAvatar
                        peers={item.peers}
                        selfPubkey={user?.pubkey}
                        sizePx={48}
                        className={cn(
                          "size-12 transition-all duration-150 opacity-60 saturate-50",
                          "group-hover:opacity-100 group-hover:saturate-100",
                          isActive && "opacity-100 saturate-100 is-active",
                        )}
                      />
                      {inCall && (
                        <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                          <Headphones className="size-2.5" />
                        </span>
                      )}
                      {!isActive && item.unreadCount > 0 && (
                        <span
                          className="absolute -top-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-bold leading-none text-primary-foreground ring-2 ring-background"
                          aria-label={intl.formatMessage(RAIL_MESSAGES.unreadCount, { count: item.unreadCount })}
                        >
                          {item.unreadCount > 99 ? "99+" : item.unreadCount}
                        </span>
                      )}
                    </span>
                  </>
                );
              }}
            </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">{name}</RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label={intl.formatMessage(RAIL_MESSAGES.messageNotifications)}
          level={dmLevel(item.key)}
          onChange={(level) => setNotifLevel(dmScopeKey(item.key), level)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Server folder: collapsed shows a 2×2 member grid; drags as one unit. */
function RailFolder({
  id,
  name,
  items,
  open,
  active,
  onToggle,
  onRenameRequest,
  onDissolve,
  draggable,
  dragging,
  reordering,
  highlight,
  onDragPointerDown,
  shouldSuppressClick,
  children,
}: {
  id: string;
  name: string;
  items: RailItem[];
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onRenameRequest: () => void;
  onDissolve: () => void;
  children?: React.ReactNode;
} & RailDragProps) {
  const intl = useIntl();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);
  const onMenuOpenChange = useContext(RailMenuOpenContext);

  const label = name.trim() || intl.formatMessage({ id: "serverRail.folder", defaultMessage: "Folder" });

  // Rollup across ALL members, reported by the per-member probes; shown only while collapsed.
  const [memberUnread, setMemberUnread] = useState<
    Record<string, { unread: boolean; mention: boolean }>
  >({});
  const reportUnread = useCallback((key: string, unread: boolean, mention: boolean) => {
    setMemberUnread((prev) => {
      const cur = prev[key];
      if (cur && cur.unread === unread && cur.mention === mention) return prev;
      return { ...prev, [key]: { unread, mention } };
    });
  }, []);
  const anyUnread = !open && items.some((it) => memberUnread[it.key]?.unread);
  const anyMention = !open && items.some((it) => memberUnread[it.key]?.mention);
  const probes = !open
    ? items.map((it) => (
        <RailItemUnreadProbe
          key={it.key}
          item={it}
          onChange={(unread, mention) => reportUnread(it.key, unread, mention)}
        />
      ))
    : null;

  const header = (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={label}
              aria-expanded={open}
              onClick={() => {
                if (shouldSuppressClick?.()) return;
                onToggle();
              }}
              className={cn(
                "group relative flex items-center justify-center shrink-0 touch-none cursor-pointer",
                dragging && "cursor-grabbing",
                reordering && "touch-none",
              )}
              {...(draggable ? dragAttrs(folderAnchor(id)) : {})}
            >
              <span
                className={cn(
                  "absolute -left-2 w-[3px] bg-primary transition-all",
                  !open && active
                    ? "h-12 opacity-100"
                    : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                )}
              />
              <DragSlot dragging={dragging && !open}>
                <span
                  className={cn(
                    "relative block size-12 transition-all duration-150",
                    highlight && "rounded-xl ring-2 ring-primary scale-110",
                  )}
                >
                  {/* Dimming on an inner wrapper so the badge outside stays full strength. */}
                  <span
                    className={cn(
                      "block size-12 transition-all duration-150",
                      !open && !active && !highlight &&
                        "opacity-70 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
                    )}
                  >
                    {open ? (
                      <span className="flex size-12 items-center justify-center clip-corner-lg bg-secondary/80 text-primary">
                        <FolderOpen className="size-5" />
                      </span>
                    ) : (
                      <FolderMiniGrid items={items} />
                    )}
                  </span>
                  {anyMention ? (
                    <span
                      className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none ring-2 ring-background"
                      aria-label={intl.formatMessage(RAIL_MESSAGES.mentioned)}
                    >
                      @
                    </span>
                  ) : anyUnread ? (
                    <span
                      className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-foreground ring-2 ring-background"
                      aria-label={intl.formatMessage(RAIL_MESSAGES.unread)}
                    />
                  ) : null}
                </span>
              </DragSlot>
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {label}
          <span className="block text-xs text-muted-foreground">
            {items.length === 1 ? "1 community" : `${items.length} communities`}
          </span>
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRenameRequest}><FormattedMessage id="serverRail.renameFolder" defaultMessage="Rename folder" /></ContextMenuItem>
        <ContextMenuItem onSelect={onDissolve}><FormattedMessage id="serverRail.removeFolder" defaultMessage="Remove folder" /></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  if (!open) {
    return (
      <>
        {probes}
        {header}
      </>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-4 sidebar:gap-5 shrink-0 rounded-2xl bg-secondary/40 px-1.5 py-1.5 transition-colors",
        // Frozen slot geometry must not change mid-gesture.
        dragging && "opacity-40",
      )}
    >
      {header}
      {children}
    </div>
  );
}

/**
 * Side-by-side (desktop) layout, where MainLayout owns the persistent rail,
 * vs. touch drill-down.
 */
function useSideBySideLayout(): boolean {
  return !useSwipeLayout();
}

// Drill-down rail persistence: rendered ONCE by MainLayout's shell rail into
// this detached container, and each page's `<ServerRail />` slot ADOPTS the
// DOM node on mount. Rebuilding the rail on every section switch would make
// the first tap after a switch feel dead; moving a DOM node is invisible to React.
let railPortalNode: HTMLDivElement | null = null;
function getRailPortalNode(): HTMLDivElement {
  if (!railPortalNode) {
    railPortalNode = document.createElement("div");
    // `display: contents` on both so the rail lays out as if inline.
    railPortalNode.style.display = "contents";
  }
  return railPortalNode;
}

function RailSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const node = getRailPortalNode();
    // appendChild MOVES the node; the outgoing slot's cleanup already ran, so no railless frame.
    slot.appendChild(node);
    return () => {
      if (node.parentNode === slot) slot.removeChild(node);
    };
  }, []);
  return <div style={{ display: "contents" }} ref={ref} />;
}

export interface ServerRailProps {
  onNavigate?: () => void;
  onServerSelect?: (url: string) => void;
  selectedServer?: string;
  className?: string;
  /** `shell`: MainLayout's persistent rail (in place on desktop, portaled on touch). `page`: a slot adopting it. */
  variant?: "shell" | "page";
}

export function ServerRail({ variant = "page", ...props }: ServerRailProps) {
  const sideBySide = useSideBySideLayout();
  const { user } = useCurrentUser();
  if (variant === "shell") {
    // No `user` gate: drill-down pages manage their own logged-out state.
    if (!sideBySide) return createPortal(<ServerRailInner {...props} />, getRailPortalNode());
    // Logged-out visitors on public in-shell pages must not see the rail chrome.
    if (!user) return null;
    return <ServerRailInner {...props} />;
  }
  if (sideBySide) return null;
  // Pages that customize the rail keep a private instance.
  if (props.onNavigate || props.onServerSelect) return <ServerRailInner {...props} />;
  return <RailSlot />;
}

function ServerRailInner({
  onNavigate,
  onServerSelect,
  selectedServer,
  className,
}: ServerRailProps) {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeCall } = useCall();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const hasUnreadDMs = useHasUnreadDMs();
  const { items: dmActivity } = useDmActivity();
  // Received Concord invites (CORD-05 §6); shown only while some are pending.
  const { items: inviteItems, requests: inviteRequests, unreadCount: inviteUnread } = useInviteInbox();
  const pendingInvites = inviteItems.length + inviteRequests.length;
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const concord = useLiveCommunities();
  const [addOpen, setAddOpen] = useState(false);

  // Optimistic highlight: React Router v7 wraps navigations in startTransition,
  // so a slow switch looks like a dead tap. Timeout covers re-tapping the active entry.
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  useEffect(() => {
    setPendingNav(null);
  }, [location]);

  // Settings toggles its overlay directly (not via navigation). A cold
  // `/settings` goes to the last non-settings location, or home.
  const settingsOverlay = useContext(SettingsOverlayContext);
  const onSettingsPage = location.pathname === SETTINGS_PATH;
  const inSettings = settingsOverlay.open || onSettingsPage;
  const lastOutsideSettings = useRef<string | null>(null);
  useEffect(() => {
    if (!onSettingsPage) {
      lastOutsideSettings.current = location.pathname + location.search + location.hash;
    }
  }, [onSettingsPage, location]);
  const toggleSettings = () => {
    onNavigate?.();
    if (settingsOverlay.open) settingsOverlay.close();
    else if (onSettingsPage) navigate(lastOutsideSettings.current ?? "/");
    else settingsOverlay.show();
  };
  useEffect(() => {
    if (pendingNav === null) return;
    const timer = window.setTimeout(() => setPendingNav(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingNav]);
  // Cached per key so memoized buttons keep their bailout.
  const pressedByKey = useRef(new Map<string, () => void>());
  const onPressedFor = (key: string) => {
    let fn = pressedByKey.current.get(key);
    if (!fn) {
      fn = () => setPendingNav(key);
      pressedByKey.current.set(key, fn);
    }
    return fn;
  };

  // Servers from the user's kind 10009 list.
  const servers = useNip29Servers();

  // Notification Center collects mentions and invites only (DMs have their own).
  const [mentionBySpace, setMentionBySpace] = useState<Record<string, boolean>>({});
  const reportMention = useCallback((key: string, mention: boolean) => {
    setMentionBySpace((current) => {
      if (current[key] === mention) return current;
      return { ...current, [key]: mention };
    });
  }, []);
  const hasUnreadNotifications =
    inviteUnread > 0 || Object.values(mentionBySpace).some(Boolean);

  // Rail DMs have no source list — the arrangement IS the record.
  const railDms = useMemo(
    () => railDmPubkeys(config.railLayout),
    [config.railLayout],
  );
  const dmActivityByKey = useMemo(
    () => new Map(dmActivity.map((item) => [item.key, item])),
    [dmActivity],
  );
  const recentDms = useMemo(() => {
    if (config.dmsDisabled || !config.showRecentRailDms) return [];
    const manuallyArranged = new Set(railDms);
    return dmActivity
      .filter((item) => item.unreadCount > 0 && !manuallyArranged.has(item.key))
      .slice(0, MAX_RAIL_RECENT_DMS);
  }, [dmActivity, railDms, config.showRecentRailDms, config.dmsDisabled]);

  const items = useMemo<RailItem[]>(() => {
    const base: RailItem[] = [];
    base.push(...servers.map((url) => ({ kind: "server" as const, key: url, url })));
    if (user) {
      if (!config.dmsDisabled) {
        base.push(
          ...railDms.map((pubkey) => ({ kind: "dm" as const, key: dmRailKey(pubkey), pubkey })),
        );
      }
      for (const entry of concord) {
        base.push({
          kind: "concord",
          key: concordKey(entry.community_id),
          communityId: entry.community_id,
          name: entry.current.name,
        });
      }
    }
    return base;
  }, [servers, concord, railDms, user, config.dmsDisabled]);

  const liveByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items]);

  // Known-but-not-live keys are KEPT (only skipped at render) so an early drag
  // can't wipe another device's folders.
  const layout = useMemo(
    () => mergeLayout(config.railLayout, items.map((it) => it.key)),
    [config.railLayout, items],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const renderNodes = useMemo<RenderNode[]>(() => {
    const out: RenderNode[] = [];
    for (const node of layout) {
      if (node.type === "item") {
        const item = liveByKey.get(node.key);
        if (item) out.push({ type: "item", item });
      } else {
        const kids = node.keys
          .map((k) => liveByKey.get(k))
          .filter((it): it is RailItem => it !== undefined);
        if (kids.length > 0) out.push({ type: "folder", id: node.id, name: node.name, items: kids });
      }
    }
    return out;
  }, [layout, liveByKey]);

  const openFolders = useMemo(() => new Set(config.railOpenFolders), [config.railOpenFolders]);
  const toggleFolder = useCallback(
    (id: string) => {
      updateConfig((current) => {
        const open = new Set(current.railOpenFolders);
        if (open.has(id)) open.delete(id);
        else open.add(id);
        return { ...current, railOpenFolders: [...open] };
      });
    },
    [updateConfig],
  );

  const isItemActive = useCallback(
    (item: RailItem): boolean => {
      if (item.kind === "server" && onServerSelect) return selectedServer === item.url;
      const base =
        item.kind === "server"
          ? `/s/${relayToRouteParam(item.url)}`
          : item.kind === "dm"
            ? dmRoute(item.pubkey)
            : `/c/${encodeURIComponent(item.communityId)}`;
      return location.pathname === base || location.pathname.startsWith(`${base}/`);
    },
    [location.pathname, onServerSelect, selectedServer],
  );

  const persistLayout = useCallback(
    (nodes: RailLayoutNode[]) => {
      const normalized = normalizeLayout(nodes);
      const keys = flattenLayout(normalized);
      updateConfig((current) => ({ ...current, railLayout: normalized }));

      // Sync relay order to kind 10009 (cross-device source of truth). Relay URLs only.
      const addedOrder = keys.filter(
        (k) => !k.startsWith("c2:") && !k.startsWith("dm:"),
      );
      if (user && addedOrder.length > 0) {
        updateList({ type: "reorder-servers", urls: addedOrder }).catch((err) =>
          console.warn("Failed to persist server order:", err),
        );
      }
    },
    [updateConfig, updateList, user],
  );

  // Drag: a mouse picks up on movement; touch holds ~300ms, and early movement is a
  // scroll. DOM order never changes mid-drag: slot geometry is frozen at pickup in the
  // nav's CONTENT coordinates (so an edge auto-scroll doesn't stale it), `planDrop`
  // previews, `applyDrop` applies on release and FLIP animates the settle.
  // The ghost is moved by writing its transform, and state changes only when the
  // plan does, so a drag doesn't re-render the rail per pointer event.
  const [dropPlan, setDropPlan] = useState<RailDropPlan | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const slotsRef = useRef<RailSlot[]>([]);
  const navTopRef = useRef(0);
  const dropPlanRef = useRef<RailDropPlan | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const flip = useFlipReorder(navRef, "data-rail-anchor");

  const placeGhost = useCallback(() => {
    const ghost = ghostRef.current;
    if (ghost) ghost.style.transform = ghostTransform(pointerRef.current.x, pointerRef.current.y);
  }, []);
  const attachGhost = useCallback(
    (el: HTMLDivElement | null) => {
      ghostRef.current = el;
      placeGhost();
    },
    [placeGhost],
  );

  const aim = useCallback(
    (source: RailDragSource, x: number, y: number) => {
      pointerRef.current = { x, y };
      placeGhost();
      const nav = navRef.current;
      const contentY = y - navTopRef.current + (nav?.scrollTop ?? 0);
      const plan = planDrop(contentY, slotsRef.current, source);
      if (sameDropPlan(plan, dropPlanRef.current)) return;
      dropPlanRef.current = plan;
      setDropPlan(plan);
    },
    [placeGhost],
  );

  const endDrag = () => {
    dropPlanRef.current = null;
    setDropPlan(null);
  };

  const railDrag = usePressDrag<RailDragSource>({
    containerRef: navRef,
    onPickup: (source, x, y) => {
      const nav = navRef.current;
      if (nav) {
        const navTop = nav.getBoundingClientRect().top;
        navTopRef.current = navTop;
        const slots: RailSlot[] = [];
        nav.querySelectorAll<HTMLElement>("[data-rail-anchor]").forEach((el) => {
          const r = el.getBoundingClientRect();
          slots.push({
            anchor: el.dataset.railAnchor!,
            parentFolderId: el.dataset.railParent || undefined,
            top: r.top - navTop + nav.scrollTop,
            height: r.height,
          });
        });
        slotsRef.current = slots;
      }
      dropPlanRef.current = null;
      aim(source, x, y);
    },
    onAim: aim,
    onDrop: (source) => {
      const plan = dropPlanRef.current;
      const ghostRect = ghostRef.current?.getBoundingClientRect();
      endDrag();
      if (!plan) return;
      const current = layoutRef.current;
      const next = normalizeLayout(applyDrop(current, source, plan.target));
      // Dropped back where it was: nothing to publish.
      if (JSON.stringify(next) === JSON.stringify(normalizeLayout(current))) return;
      const anchor = source.kind === "item" ? itemAnchor(source.key) : folderAnchor(source.id);
      flip.capture({ [anchor]: ghostRect });
      persistLayout(next);
    },
    onAbort: endDrag,
    heldTouchOpensMenu: true,
  });

  const playFlip = flip.play;
  useLayoutEffect(() => {
    playFlip();
  }, [renderNodes, playFlip]);

  const { dragging: reordering, shouldSuppressClick } = railDrag;
  // Touch: an entry's menu or drag dims everything beside the rail, as Discord's does.
  const isTouch = useIsTouch();
  const [menuOpen, setMenuOpen] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railRight, setRailRight] = useState(0);
  const dimmed = isTouch && (menuOpen || reordering);
  useLayoutEffect(() => {
    if (dimmed) setRailRight(railRef.current?.getBoundingClientRect().right ?? 0);
  }, [dimmed]);
  const dragSource = railDrag.source;
  const handleDragPointerDown = railDrag.begin;
  const draggable = items.length > 1;
  const reachZone = !useSideBySideLayout();

  // The Settings footer divider only shows when content is scrolled off below.
  const [contentBelow, setContentBelow] = useState(false);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () =>
      setContentBelow(nav.scrollHeight - nav.scrollTop - nav.clientHeight > 1);
    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => nav.removeEventListener("scroll", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    for (const child of Array.from(nav.children)) ro.observe(child);
    return () => {
      nav.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [renderNodes, user, mesh.available, pendingInvites, recentDms.length]);

  const draggedItem =
    dragSource?.kind === "item" ? (liveByKey.get(dragSource.key) ?? null) : null;
  const draggedFolder =
    dragSource?.kind === "folder"
      ? (renderNodes.find(
          (n): n is Extract<RenderNode, { type: "folder" }> =>
            n.type === "folder" && n.id === dragSource.id,
        ) ?? null)
      : null;

  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const requestRename = useCallback(
    (id: string) => {
      const folder = layoutRef.current.find(
        (n): n is Extract<RailLayoutNode, { type: "folder" }> =>
          n.type === "folder" && n.id === id,
      );
      setRenameValue(folder?.name ?? "");
      setRenameId(id);
    },
    [],
  );
  const submitRename = useCallback(() => {
    if (renameId !== null) {
      persistLayout(renameFolder(layoutRef.current, renameId, renameValue.trim()));
    }
    setRenameId(null);
  }, [renameId, renameValue, persistLayout]);

  // Cached per item key so a fresh closure doesn't defeat memoized buttons.
  const dragDownByKey = useRef(new Map<string, (e: PointerEvent) => void>());
  const dragPointerDownFor = (key: string) => {
    let fn = dragDownByKey.current.get(key);
    if (!fn) {
      fn = (e: PointerEvent) => handleDragPointerDown({ kind: "item", key })(e);
      dragDownByKey.current.set(key, fn);
    }
    return fn;
  };

  const renderItem = (item: RailItem, parentFolderId?: string) => {
    const common: RailDragProps = {
      draggable,
      dragging: dragSource?.kind === "item" && dragSource.key === item.key,
      reordering,
      highlight: dropPlan?.highlightAnchor === itemAnchor(item.key),
      dragParent: parentFolderId,
      onDragPointerDown: dragPointerDownFor(item.key),
      shouldSuppressClick,
      pending: pendingNav === item.key,
      onPressed: onPressedFor(item.key),
    };
    if (item.kind === "server") {
      return (
        <ServerButton
          key={item.key}
          url={item.url}
          onNavigate={onNavigate}
          onSelect={onServerSelect}
          selected={onServerSelect ? selectedServer === item.url : undefined}
          inCall={!activeCall?.dmPeer && activeCall?.relayUrl === item.url}
          {...common}
        />
      );
    }
    if (item.kind === "dm") {
      return (
        <DmButton
          key={item.key}
          pubkey={item.pubkey}
          unreadCount={dmActivityByKey.get(item.pubkey)?.unreadCount}
          onNavigate={onNavigate}
          inCall={activeCall?.dmPeer === item.pubkey}
          {...common}
        />
      );
    }
    return (
      <Concord2Button
        key={item.key}
        communityId={item.communityId}
        name={item.name}
        onNavigate={onNavigate}
        {...common}
      />
    );
  };

  const rail = (
    <div
      ref={railRef}
      className={cn(
        "flex flex-col items-center w-[60px] touch:w-[72px] sidebar:w-[72px] shrink-0 overflow-hidden bg-chrome-deep select-none",
        className,
      )}
    >
      <nav
        ref={railDrag.attachContainer}
        aria-label={intl.formatMessage({ id: "serverRail.servers", defaultMessage: "Servers" })}
        // Suppress native HTML5 drag, which hijacks the custom reorder gesture.
        onDragStart={(e) => e.preventDefault()}
        // Entries start their own press.
        onPointerDown={(e) => {
          if (!(e.target as Element).closest("[data-rail-anchor]")) railDrag.panFrom(e.nativeEvent);
        }}
        className={cn(
          // `overflow-x-clip` is required: `overflow-y-auto` alone computes overflow-x
          // to `auto`, giving a horizontal scrollbar in the narrow rail.
          "flex flex-col items-center gap-4 sidebar:gap-5 w-full flex-1 min-h-0",
          "overflow-y-auto overflow-x-clip [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          "relative pb-2",
          "touch:touch-none",
          reordering && "overflow-hidden",
        )}
      >
        {/* In content coordinates, so it scrolls with the entries under an edge auto-scroll. */}
        {reordering && dropPlan?.indicatorY !== undefined && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-1.5 z-10 h-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.7)] transition-[top] duration-100 ease-out"
            style={{ top: dropPlan.indicatorY - 1 }}
          />
        )}
        {user && servers.map((url) => (
          <ServerMentionProbe key={`mention:${url}`} url={url} onChange={reportMention} />
        ))}
        {user && concord.map((entry) => (
          <ConcordMentionProbe
            key={`mention:c2:${entry.community_id}`}
            communityId={entry.community_id}
            onChange={reportMention}
          />
        ))}

        {/* Mesh only where it can run (Android with BLE). */}
        {user && mesh.available && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/mesh"
                aria-label={intl.formatMessage({ id: "serverRail.nearbyMesh", defaultMessage: "Nearby mesh" })}
                onClick={() => {
                  onPressedFor("nav:mesh")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:mesh" && "h-12 opacity-100",
                  )}
                />
                <span
                  className={cn(
                    "relative block size-12 transition-all duration-150",
                    "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                      "bg-muted text-primary opacity-50 saturate-50",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                      pendingNav === "nav:mesh" && "opacity-100 saturate-100",
                    )}
                  >
                    <Bluetooth className="size-5" />
                  </span>
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              <FormattedMessage id="serverRail.nearbyMesh" defaultMessage="Nearby mesh" />
            </RailTooltipContent>
          </Tooltip>
        )}

        {user && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/notifications"
                aria-label={intl.formatMessage({ id: "serverRail.notifications", defaultMessage: "Notifications" })}
                onClick={() => {
                  onPressedFor("nav:notifications")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:h-6 group-hover:opacity-60",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:notifications" && "h-12 opacity-100",
                  )}
                />
                <span className={cn(
                  "relative block size-12 transition-all duration-150",
                  "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                )}>
                  <span className={cn(
                    "flex size-12 items-center justify-center clip-corner-lg bg-muted text-primary opacity-50 saturate-50 transition-all duration-150",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                    pendingNav === "nav:notifications" && "opacity-100 saturate-100",
                  )}>
                    <Bell className="size-5" />
                  </span>
                  {hasUnreadNotifications && (
                    <span
                      className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-primary ring-2 ring-background group-aria-[current=page]:hidden"
                      aria-label={intl.formatMessage({ id: "serverRail.unreadNotifications", defaultMessage: "Unread notifications" })}
                    />
                  )}
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              <FormattedMessage id="serverRail.notifications" defaultMessage="Notifications" />
            </RailTooltipContent>
          </Tooltip>
        )}

        {user && !config.dmsDisabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/dm"
                aria-label={intl.formatMessage({ id: "serverRail.directMessages", defaultMessage: "Direct messages" })}
                onClick={() => {
                  onPressedFor("nav:dm")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                {/* `pendingNav` classes are the optimistic tap highlight. */}
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:dm" && "h-12 opacity-100",
                  )}
                />
                <span
                  className={cn(
                    "relative block size-12 transition-all duration-150",
                    "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                      "bg-muted text-primary opacity-50 saturate-50",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                      pendingNav === "nav:dm" && "opacity-100 saturate-100",
                    )}
                  >
                    <MessageSquare className="size-5" />
                  </span>
                  {activeCall?.dmPeer && (
                    <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                      <Headphones className="size-2.5" />
                    </span>
                  )}
                  {hasUnreadDMs && (
                    <span
                      className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-primary ring-2 ring-background group-aria-[current=page]:hidden"
                      aria-label={intl.formatMessage({ id: "serverRail.unreadDirectMessages", defaultMessage: "Unread direct messages" })}
                    />
                  )}
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              <FormattedMessage id="serverRail.directMessages" defaultMessage="Direct messages" />
            </RailTooltipContent>
          </Tooltip>
        )}

        {user && pendingInvites > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/invites"
                aria-label={intl.formatMessage({ id: "serverRail.invites", defaultMessage: "Invites" })}
                onClick={() => {
                  onPressedFor("nav:invites")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:invites" && "h-12 opacity-100",
                  )}
                />
                <span
                  className={cn(
                    "relative block size-12 transition-all duration-150",
                    "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                      "bg-muted text-success opacity-60 saturate-50",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                      pendingNav === "nav:invites" && "opacity-100 saturate-100",
                    )}
                  >
                    <MailPlus className="size-5" />
                  </span>
                  {inviteUnread > 0 && (
                    <span
                      className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none ring-2 ring-background group-aria-[current=page]:hidden"
                      aria-label={intl.formatMessage(
                        { id: "serverRail.newInvites", defaultMessage: "{count, plural, one {# new invite} other {# new invites}}" },
                        { count: inviteUnread },
                      )}
                    >
                      {inviteUnread}
                    </span>
                  )}
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              <FormattedMessage id="serverRail.invites" defaultMessage="Invites" />
            </RailTooltipContent>
          </Tooltip>
        )}

        {user && recentDms.map((item) => (
          <RecentDmButton
            key={`recent:${item.key}`}
            item={item}
            onNavigate={onNavigate}
            inCall={activeCall?.dmPeer === item.key}
            pending={pendingNav === `recent:${item.key}`}
            onPressed={onPressedFor(`recent:${item.key}`)}
          />
        ))}

        {user && renderNodes.length > 0 && (
          <div
            className="h-px w-7 shrink-0 -mb-px bg-chrome-divider"
            data-rail-account-separator
            aria-hidden
          />
        )}

        {renderNodes.map((node) =>
          node.type === "item" ? (
            renderItem(node.item)
          ) : (
            <RailFolder
              key={node.id}
              id={node.id}
              name={node.name}
              items={node.items}
              open={openFolders.has(node.id)}
              active={node.items.some(isItemActive)}
              onToggle={() => toggleFolder(node.id)}
              onRenameRequest={() => requestRename(node.id)}
              onDissolve={() => persistLayout(dissolveFolder(layoutRef.current, node.id))}
              draggable={draggable}
              dragging={dragSource?.kind === "folder" && dragSource.id === node.id}
              reordering={reordering}
              highlight={dropPlan?.highlightAnchor === folderAnchor(node.id)}
              onDragPointerDown={(e) => handleDragPointerDown({ kind: "folder", id: node.id })(e)}
              shouldSuppressClick={shouldSuppressClick}
            >
              {node.items.map((item) => renderItem(item, node.id))}
            </RailFolder>
          ),
        )}

        {renderNodes.length > 0 && <div className="w-7 h-px -mb-px bg-chrome-divider shrink-0" />}

        <CommunityListLocked />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label={intl.formatMessage({ id: "serverRail.addAria", defaultMessage: "Add a server or encrypted chat" })}
              className="size-12 touch:size-12 shrink-0 clip-corner-lg transition-all text-success hover:bg-success hover:text-success-foreground"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="size-5" />
            </Button>
          </TooltipTrigger>
          <RailTooltipContent side="right"><FormattedMessage id="serverRail.addTooltip" defaultMessage="Add a server or chat" /></RailTooltipContent>
        </Tooltip>

        {config.showDiscover && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/discover"
                aria-label={intl.formatMessage({ id: "serverRail.discover", defaultMessage: "Discover" })}
                onClick={() => {
                  onPressedFor("nav:discover")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:discover" && "h-12 opacity-100",
                  )}
                />
                <span
                  className={cn(
                    "relative block size-12 transition-all duration-150",
                    "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                      "bg-muted text-primary opacity-50 saturate-50",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                      pendingNav === "nav:discover" && "opacity-100 saturate-100",
                    )}
                  >
                    <Compass className="size-5" />
                  </span>
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              <FormattedMessage id="serverRail.discover" defaultMessage="Discover" />
            </RailTooltipContent>
          </Tooltip>
        )}
      </nav>

      {/* Bottom safe-area padding lives here so Settings lines up with ChannelSidebar's account switcher. */}
      <div
        className={cn(
          "flex flex-col items-center shrink-0 w-full pt-3",
          contentBelow && "border-t border-chrome-divider",
          "pb-[var(--bottom-chrome-pad)] sidebar:pb-[calc(var(--safe-area-pad-bottom-tight,0.25rem)+0.5rem)]",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label={inSettings ? intl.formatMessage({ id: "serverRail.closeSettings", defaultMessage: "Close settings" }) : intl.formatMessage(common.settings)}
              aria-pressed={inSettings}
              className={cn(
                "size-12 touch:size-12 shrink-0 clip-corner-lg transition-all",
                inSettings && "bg-primary/20 text-primary hover:bg-primary/25",
              )}
              onClick={toggleSettings}
            >
              <Settings className="size-5" />
            </Button>
          </TooltipTrigger>
          <RailTooltipContent side="right">
            {inSettings ? intl.formatMessage({ id: "serverRail.closeSettings", defaultMessage: "Close settings" }) : intl.formatMessage(common.settings)}
          </RailTooltipContent>
        </Tooltip>
      </div>

      <AddDialog open={addOpen} onOpenChange={setAddOpen} />

      <Dialog open={renameId !== null} onOpenChange={(open) => !open && setRenameId(null)}>
        <ChromeDialogContent title={intl.formatMessage({ id: "serverRail.renameFolder", defaultMessage: "Rename folder" })} className="sm:max-w-sm">
          <ChromeDialogHeader
            icon={Folder}
            title={intl.formatMessage({ id: "serverRail.renameFolderHeading", defaultMessage: "rename folder" })}
            description={intl.formatMessage({ id: "serverRail.renameFolderDescription", defaultMessage: "Name this group of communities." })}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
            className="mt-6"
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={intl.formatMessage({ id: "serverRail.folderName", defaultMessage: "Folder name" })}
              aria-label={intl.formatMessage({ id: "serverRail.folderName", defaultMessage: "Folder name" })}
              autoFocus
              maxLength={64}
              className="bg-background/40 border-transparent"
            />
            <ChromeDialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenameId(null)}>
                <FormattedMessage {...common.cancel} />
              </Button>
              <Button type="submit">
                <FormattedMessage {...common.save} />
              </Button>
            </ChromeDialogFooter>
          </form>
        </ChromeDialogContent>
      </Dialog>

      {dragSource && (draggedItem || draggedFolder) && (
        <DragGhost
          ref={attachGhost}
          item={draggedItem ?? undefined}
          folderItems={draggedFolder?.items}
        />
      )}

      {/* Chromium doesn't re-evaluate cursor while a button is held and the pointer
          is still, but a NEW element under the pointer forces it. Must NOT be
          pointer-events-none (those don't contribute a cursor). */}
      {reordering && (
        <div data-rail-drag-overlay className="fixed inset-0 z-[298] cursor-grabbing" aria-hidden />
      )}
      {isTouch &&
        createPortal(
          <div
            aria-hidden
            className={cn(
              "pointer-events-none fixed inset-y-0 right-0 z-[250] bg-black/60 transition-opacity duration-150",
              dimmed ? "opacity-100" : "opacity-0",
            )}
            style={{ left: railRight }}
          />,
          document.body,
        )}
    </div>
  );

  const body = !reachZone ? (
    rail
  ) : (
    // Outside the rail's overflow clip.
    <div className="relative flex shrink-0">
      {rail}
      <RailReachZone panFrom={railDrag.panFrom} attach={railDrag.attachPanSurface} />
    </div>
  );
  return <RailMenuOpenContext.Provider value={setMenuOpen}>{body}</RailMenuOpenContext.Provider>;
}

/** Extends the rail's touch area over the list: swipes scroll the rail, taps reach what's beneath. */
function RailReachZone({
  panFrom,
  attach,
}: {
  panFrom: (e: PointerEvent) => boolean;
  attach: (el: HTMLElement | null) => void;
}) {
  const caughtFling = useRef(false);
  return (
    <div
      ref={attach}
      aria-hidden
      data-rail-reach
      className="absolute inset-y-0 left-full z-20 w-10 touch-none"
      onPointerDown={(e) => {
        caughtFling.current = panFrom(e.nativeEvent);
      }}
      onClick={(e) => {
        if (caughtFling.current) return;
        const zone = e.currentTarget;
        zone.style.pointerEvents = "none";
        const below = document.elementFromPoint(e.clientX, e.clientY);
        zone.style.pointerEvents = "";
        if (below instanceof HTMLElement) below.click();
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
