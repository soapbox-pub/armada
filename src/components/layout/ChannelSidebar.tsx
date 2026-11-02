import { Bell, BellOff, CheckCheck, ChevronDown, CircleAlert, FolderGit2, Hash, Headphones, IdCard, Inbox, Link as LinkIcon, Loader2, Lock, MessageSquareText, Plus, RefreshCw, Trash2, Volume2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import { BuzzDmName } from "@/buzz/BuzzDmName";
import { useIsBuzzRelay } from "@/buzz/detect";
import { buzzChannelArchived, buzzChannelType } from "@/buzz/protocol";
import { useBuzzHiddenDms } from "@/buzz/useBuzzDms";
import { CreateGroupDialog } from "@/components/dialogs/CreateGroupDialog";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { JoinButton } from "@/components/auth/JoinButton";
import { LoginArea } from "@/components/auth/LoginArea";
import { VoiceParticipantList } from "@/components/VoicePresence";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitParticipants, useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useNotifLevels, channelScopeKey } from "@/hooks/useNotifLevels";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInbox } from "@/hooks/useRelayInbox";
import { useRelayUnread, type GroupUnread } from "@/hooks/useRelayUnread";
import { useServerActions } from "@/hooks/useServerActions";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList, useUserGroupList } from "@/hooks/useUserGroupList";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { groupRefsOn, missingGroupIds } from "@/lib/nip29";
import { relayToRouteParam } from "@/lib/platform";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { shareOrigin } from "@/lib/shareOrigin";

import type { Nip29Group } from "@/lib/nip29";

function ChannelLink({
  group,
  unread,
  onNavigate,
  buzzDm = false,
  dimmed = false,
}: {
  group: Nip29Group;
  unread?: GroupUnread;
  onNavigate?: () => void;
  buzzDm?: boolean;
  dimmed?: boolean;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { activeCall } = useCall();
  const { speakingPubkeys, mutedPubkeys, streamingPubkeys, voiceRoomPubkeys } = useVoiceActivity();
  const { markRead } = useReadState();
  const { channelLevel, setLevel } = useNotifLevels();
  const notificationLevel = channelLevel(group.relay, group.id);
  const muted = notificationLevel === "nothing";
  // A Buzz DM channel's title is its roster (kind 39002).
  const { data: dmDetails } = useGroup(buzzDm ? group.relay : undefined, buzzDm ? group.id : undefined);
  // Fall back to relay-level LiveKit support: Armada's relay29 doesn't emit the
  // per-group `livekit` tag (matches GroupPage's `hasVoice`).
  const { data: relayHasLivekit } = useRelayLivekitSupport(group.relay);
  const hasVoice = group.hasLivekit || Boolean(relayHasLivekit);
  const inCall = activeCall?.relayUrl === group.relay && activeCall?.groupId === group.id;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  const { data: participants } = useLivekitParticipants(
    hasVoice ? group.relay : undefined,
    hasVoice ? group.id : undefined,
  );
  const othersInVoice = !inCall && (participants?.length ?? 0) > 0;
  // While in the call, the live LiveKit roster is authoritative; kind-39004
  // presence desyncs easily and is only the fallback.
  const roster = inCall && voiceRoomPubkeys ? voiceRoomPubkeys : participants;
  // Only show the audio icon when a call is live here.
  const callActive = inCall || othersInVoice;
  const Icon = buzzDm ? MessageSquareText : callActive ? Volume2 : Hash;

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div>
          <NavLink
        to={`/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            "flex items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors",
            !isActive && "text-muted-foreground hover:text-foreground hover:bg-foreground/5 clip-corner-lg",
            // Muted channels never bold — their unread is deliberately silent.
            !isActive && hasUnread && !muted && "text-foreground font-semibold",
            !isActive && (muted || dimmed) && "opacity-60",
            isActive && "clip-corner-lg bg-primary text-primary-foreground font-medium",
          )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate flex-1">
          {buzzDm
            ? <BuzzDmName members={dmDetails?.members ?? []} selfPubkey={user?.pubkey} />
            : group.name}
        </span>
        {inCall && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Headphones className="size-3.5 shrink-0 text-success" aria-label={intl.formatMessage({ id: "channelSidebar.voiceActive", defaultMessage: "Voice active" })} />
            </TooltipTrigger>
            <TooltipContent><FormattedMessage id="channelSidebar.inVoiceHere" defaultMessage="You're in voice here" /></TooltipContent>
          </Tooltip>
        )}
        {group.isPrivate && <Lock className="size-3 shrink-0 opacity-60" aria-label={intl.formatMessage({ id: "channelSidebar.private", defaultMessage: "Private" })} />}
        {hasMention ? (
          <span
            className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none"
            aria-label={intl.formatMessage({ id: "channelSidebar.mentioned", defaultMessage: "You were mentioned" })}
          >
            @
          </span>
        ) : null}
      </NavLink>
      {callActive && (roster?.length ?? 0) > 0 && (
        <VoiceParticipantList
          participants={roster!}
          speaking={inCall ? speakingPubkeys : undefined}
          muted={inCall ? mutedPubkeys : undefined}
          streaming={inCall ? streamingPubkeys : undefined}
        />
      )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          disabled={!hasUnread}
          onSelect={() => {
            if (unread) markRead(channelReadKey(group.relay, group.id), unread.latest);
          }}
        >
          <CheckCheck className="mr-2 size-4" /> <FormattedMessage id="channelSidebar.markAsRead" defaultMessage="Mark as read" />
        </ContextMenuItem>
        <NotifLevelMenu
          label={intl.formatMessage({ id: "channelSidebar.notifications", defaultMessage: "Notifications" })}
          level={notificationLevel}
          onChange={(lvl) => setLevel(channelScopeKey(group.relay, group.id), lvl)}
        />
        <ContextMenuItem
          onSelect={() => {
            const url = `${shareOrigin()}/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`;
            writeClipboardText(url).catch(() => undefined);
          }}
        >
          <LinkIcon className="mr-2 size-4" /> <FormattedMessage id="channelSidebar.copyChannelLink" defaultMessage="Copy channel link" />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A kind-10009 channel the relay has no metadata for: never created, or deleted. */
function MissingChannelRow({ relayUrl, groupId }: { relayUrl: string; groupId: string }) {
  const { data: list } = useUserGroupList();
  const { mutateAsync: updateList, isPending } = useUpdateUserGroupList();
  const intl = useIntl();
  const remove = async () => {
    // Every spelling of this relay the list carries for the id.
    const refs = groupRefsOn(list?.groups ?? [], relayUrl).filter((ref) => ref.id === groupId);
    for (const ref of refs) await updateList({ type: "remove-group", ref });
  };

  return (
    <div className="flex items-center gap-2 pl-3 pr-1 text-sm text-muted-foreground opacity-60">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex flex-1 min-w-0 items-center gap-2 py-1.5 touch:py-3">
            <CircleAlert className="size-4 shrink-0" />
            <span className="truncate font-mono text-xs">{groupId}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <FormattedMessage id="channelSidebar.missingTooltip" defaultMessage="Not found on this server. It may not support NIP-29 groups, or the channel was deleted." />
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 touch:size-11 shrink-0"
        disabled={isPending}
        onClick={() =>
          void remove().catch((e: unknown) =>
            toast({
              title: t({ id: "channelSidebar.removeFailed", defaultMessage: "Couldn't update your channel list" }),
              description: e instanceof Error ? e.message : undefined,
              variant: "destructive",
            }),
          )
        }
        aria-label={intl.formatMessage({ id: "channelSidebar.removeMissing", defaultMessage: "Remove {groupId} from your channel list" }, { groupId })}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

interface ChannelSidebarProps {
  relayUrl: string;
  onNavigate?: () => void;
  className?: string;
}

/** Channel list for a NIP-29 server, with create-channel and the account area. */
export function ChannelSidebar({ relayUrl, onNavigate, className }: ChannelSidebarProps) {
  const { data: groups, isLoading, isFetching, isError, refetch, relayInfo } = useRelayGroups(relayUrl);
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { data: userGroupList } = useUserGroupList();
  const { registerCallBarSlot } = useCall();
  const callBarRef = useRef<HTMLDivElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // The only place server actions are reachable on mobile (ServerPage is hidden there).
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const { serverMuted, isRemovable, toggleMute, copyLink, removeServer } =
    useServerActions(relayUrl);
  const { isBuzz } = useIsBuzzRelay(relayUrl);
  const hiddenDms = useBuzzHiddenDms(isBuzz ? relayUrl : undefined);
  const buzzSections = useMemo(() => {
    if (!isBuzz || !groups) return undefined;
    const streams: typeof groups = [];
    const forums: typeof groups = [];
    const dms: typeof groups = [];
    const archived: typeof groups = [];
    for (const g of groups) {
      if (buzzChannelArchived(g.event)) {
        archived.push(g);
        continue;
      }
      const type = buzzChannelType(g.event);
      if (type === "dm") {
        if (!hiddenDms.has(g.id)) dms.push(g);
      } else if (type === "forum") {
        forums.push(g);
      } else {
        streams.push(g);
      }
    }
    return { streams, forums, dms, archived };
  }, [isBuzz, groups, hiddenDms]);

  // Only after a settled read: a just-joined channel is missing until its refetch lands.
  const missingIds = useMemo(
    () =>
      user && !isBuzz && groups && !isFetching
        ? missingGroupIds(userGroupList?.groups ?? [], relayUrl, groups)
        : [],
    [user, isBuzz, groups, isFetching, userGroupList?.groups, relayUrl],
  );

  // Create permission doesn't carry over to another server.
  useEffect(() => {
    setCreateOpen(false);
    setProfileOpen(false);
    setServerMenuOpen(false);
  }, [relayUrl]);

  // Skeletons for the full connect/timeout window (8–16s on AUTH-gated relays)
  // read as a hang, so switch to "Connecting…".
  const [skeletonExpired, setSkeletonExpired] = useState(false);
  useEffect(() => {
    setSkeletonExpired(false);
    const timer = setTimeout(() => setSkeletonExpired(true), 2500);
    return () => clearTimeout(timer);
  }, [relayUrl]);

  // Cache hits resolve in a frame; don't flash a skeleton.
  const showLoadingUi = useDelayedFlag(isLoading);

  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { byGroup } = useRelayUnread(relayUrl, groupIds);
  const { unreadCount: inboxUnread } = useRelayInbox(relayUrl, groupIds);

  // Monotonic, so already-read channels no-op.
  const { markRead } = useReadState();
  const hasUnread = Object.keys(byGroup).length > 0;
  const markAllRead = useCallback(() => {
    for (const [groupId, unread] of Object.entries(byGroup)) {
      markRead(channelReadKey(relayUrl, groupId), unread.latest);
    }
  }, [byGroup, markRead, relayUrl]);

  // Slot for the persistent call bar; every instance registers, hidden panes just don't show it.
  useEffect(() => {
    const el = callBarRef.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);

  const serverName = relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "");
  // NIP-11 fields are relay-controlled, so sanitize.
  // Its host is the relay's choice too, so the load goes through the media policy.
  const relayIcon = useMediaSrc(sanitizeImageSrc(relayInfo?.icon));
  const relayBanner = useMediaSrc(sanitizeImageSrc(relayInfo?.banner));

  return (
    <ChannelSidebarView
      className={className}
      title={
        <button
          type="button"
          className="group flex w-full items-center gap-1 min-w-0 text-left cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setServerMenuOpen((v) => !v)}
          aria-label={intl.formatMessage({ id: "channelSidebar.serverMenu", defaultMessage: "Server menu" })}
          aria-expanded={serverMenuOpen}
        >
          {relayIcon && (
            <img src={relayIcon} alt="" className="size-6 rounded object-cover shrink-0" />
          )}
          <span className="flex-1 truncate">{serverName}</span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              serverMenuOpen && "rotate-180",
            )}
          />
        </button>
      }
      titleExpansion={
        <Collapsible open={serverMenuOpen} onOpenChange={setServerMenuOpen}>
          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
            <div className="mx-3 mb-2 mt-1 p-1 space-y-0.5 clip-corner-lg bg-secondary">
              {([
                {
                  show: !!user && hasUnread,
                  icon: <CheckCheck className="size-4" />,
                  label: intl.formatMessage({ id: "channelSidebar.markAllRead", defaultMessage: "Mark all as read" }),
                  onClick: markAllRead,
                },
                {
                  show: !!user,
                  icon: <Plus className="size-4" />,
                  label: intl.formatMessage({ id: "channelSidebar.createChannel", defaultMessage: "Create channel" }),
                  onClick: () => setCreateOpen(true),
                },
                {
                  show: !!user,
                  icon: <IdCard className="size-4" />,
                  label: intl.formatMessage({ id: "channelSidebar.serverIdentity", defaultMessage: "Server identity" }),
                  onClick: () => setProfileOpen(true),
                },
                {
                  show: !!user,
                  icon: serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />,
                  label: serverMuted
                    ? intl.formatMessage({ id: "channelSidebar.unmuteServer", defaultMessage: "Unmute server" })
                    : intl.formatMessage({ id: "channelSidebar.muteServer", defaultMessage: "Mute server" }),
                  onClick: toggleMute,
                },
                {
                  show: true,
                  icon: <LinkIcon className="size-4" />,
                  label: intl.formatMessage({ id: "channelSidebar.copyServerLink", defaultMessage: "Copy server link" }),
                  onClick: copyLink,
                },
                {
                  show: true,
                  icon: <RefreshCw className="size-4" />,
                  label: intl.formatMessage({ id: "channelSidebar.refreshChannels", defaultMessage: "Refresh channels" }),
                  onClick: () => refetch(),
                },
                {
                  show: isRemovable,
                  icon: <Trash2 className="size-4" />,
                  label: intl.formatMessage({ id: "channelSidebar.removeServer", defaultMessage: "Remove server" }),
                  onClick: removeServer,
                  destructive: true,
                },
              ] as Array<{
                show: boolean;
                icon: ReactNode;
                label: string;
                onClick: () => void;
                destructive?: boolean;
              }>)
                .filter((i) => i.show)
                .map((i) => (
                  <button
                    key={i.label}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-sm text-left transition-colors clip-corner-lg hover:bg-foreground/10",
                      i.destructive && "text-destructive",
                    )}
                    onClick={() => {
                      i.onClick();
                      setServerMenuOpen(false);
                    }}
                  >
                    {i.icon}
                    {i.label}
                  </button>
                ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      }
      banner={
        relayBanner ? (
          <div className="size-full overflow-hidden">
            <img src={relayBanner} alt="" className="size-full object-cover" />
          </div>
        ) : undefined
      }
      addChannelLabel={user ? intl.formatMessage({ id: "channelSidebar.createChannel", defaultMessage: "Create channel" }) : undefined}
      onAddChannel={user ? () => setCreateOpen(true) : undefined}
      preChannels={
        user || isBuzz ? (
          <>
            {user && (
              <NavLink
                to={`/s/${relayToRouteParam(relayUrl)}/inbox`}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors clip-corner-lg",
                    isActive
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                  )
                }
              >
                <Inbox className="size-4 shrink-0" />
                <span className="truncate flex-1 min-w-0"><FormattedMessage id="channelSidebar.inbox" defaultMessage="Inbox" /></span>
                {inboxUnread > 0 && (
                  <span
                    className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-3xs font-bold leading-none"
                    aria-label={intl.formatMessage(
                      { id: "channelSidebar.unreadMentions", defaultMessage: "{count, plural, one {# unread mention} other {# unread mentions}}" },
                      { count: inboxUnread },
                    )}
                  >
                    {Math.min(inboxUnread, 99)}
                  </span>
                )}
              </NavLink>
            )}
            {isBuzz && (
              <NavLink
                to={`/s/${relayToRouteParam(relayUrl)}/projects`}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 touch:py-3 text-sm transition-colors clip-corner-lg",
                    isActive
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                  )
                }
              >
                <FolderGit2 className="size-4 shrink-0" />
                <span className="truncate flex-1 min-w-0"><FormattedMessage id="channelSidebar.projects" defaultMessage="Projects" /></span>
              </NavLink>
            )}
          </>
        ) : undefined
      }
      postChannels={
        buzzSections ? (
          <>
            {buzzSections.forums.length > 0 && (
              <div className="space-y-0.5">
                <div className="flex h-10 items-center px-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <FormattedMessage id="channelSidebar.forums" defaultMessage="Forums" />
                  </span>
                </div>
                {buzzSections.forums.map((group) => (
                  <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
                ))}
              </div>
            )}
            {buzzSections.dms.length > 0 && (
              <div className="space-y-0.5">
                <div className="flex h-10 items-center gap-1.5 px-2">
                  <MessageSquareText className="size-3 text-muted-foreground" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <FormattedMessage id="channelSidebar.directMessages" defaultMessage="Direct messages" />
                  </span>
                </div>
                {buzzSections.dms.map((group) => (
                  <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} buzzDm />
                ))}
              </div>
            )}
            {buzzSections.archived.length > 0 && (
              <div className="space-y-0.5">
                <div className="flex h-10 items-center px-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    <FormattedMessage id="channelSidebar.archived" defaultMessage="Archived" />
                  </span>
                </div>
                {buzzSections.archived.map((group) => (
                  <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} dimmed />
                ))}
              </div>
            )}
          </>
        ) : undefined
      }
      footer={
        <>
          <div ref={callBarRef} className="empty:hidden shrink-0" />

          {/* Ends on the composer's line: the same --bottom-chrome-pad on mobile. */}
          <div className="px-3 pb-[var(--bottom-chrome-pad)] sidebar:pb-[var(--safe-area-pad-bottom-tight)] shrink-0">
            {user ? (
              <div className="sidebar:pb-2">
                <LoginArea className="w-full flex" />
              </div>
            ) : (
              <div className="p-2 flex justify-center">
                <JoinButton className="w-full max-w-xs clip-corner-lg font-medium" />
              </div>
            )}
          </div>

          <CreateGroupDialog relayUrl={relayUrl} open={createOpen} onOpenChange={setCreateOpen} />
          <ServerProfileDialog relayUrl={relayUrl} open={profileOpen} onOpenChange={setProfileOpen} />
        </>
      }
    >
      {isLoading && !showLoadingUi ? (
        null
      ) : isLoading && !skeletonExpired ? (
        <div className="space-y-2 px-2 py-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : isLoading ? (
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> <FormattedMessage id="channelSidebar.connecting" defaultMessage="Connecting to server…" />
          </span>
        </div>
      ) : buzzSections ? (
        <>
          {buzzSections.streams.map((group) => (
            <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
          ))}
          {buzzSections.streams.length + buzzSections.forums.length + buzzSections.dms.length + buzzSections.archived.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              <FormattedMessage id="channelSidebar.noChannels" defaultMessage="No channels yet." />
            </div>
          )}
        </>
      ) : (groups && groups.length > 0) || missingIds.length > 0 ? (
        <>
          {(groups ?? []).map((group) => (
            <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
          ))}
          {missingIds.length > 0 && (
            <div className="space-y-0.5 pt-2">
              <div className="flex h-10 items-center px-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  <FormattedMessage id="channelSidebar.notFound" defaultMessage="Not found on this server" />
                </span>
              </div>
              {missingIds.map((id) => (
                <MissingChannelRow key={id} relayUrl={relayUrl} groupId={id} />
              ))}
            </div>
          )}
        </>
      ) : isError && !groups ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground space-y-3">
          <p>
            <FormattedMessage id="channelSidebar.unreachable" defaultMessage="Couldn’t reach this server. It may be offline or unreachable." />
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="size-3.5" />
            <FormattedMessage {...common.retry} />
          </Button>
        </div>
      ) : (
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          <FormattedMessage id="channelSidebar.noChannels" defaultMessage="No channels yet." />
        </div>
      )}
    </ChannelSidebarView>
  );
}
