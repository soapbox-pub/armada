import { Bell, BellOff, CalendarClock, Crown, DoorOpen, Headphones, IdCard, Loader2, LogOut, MessageSquareText, Phone, Pin, ScrollText, Search, Settings2, Shield, ShieldOff, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { BuzzCanvasBar } from "@/buzz/BuzzCanvas";
import { BuzzChat } from "@/buzz/BuzzChat";
import { BuzzDmName } from "@/buzz/BuzzDmName";
import { useIsBuzzRelay } from "@/buzz/detect";
import { buzzChannelTopic, buzzChannelType } from "@/buzz/protocol";
import { useBuzzOpenDm } from "@/buzz/useBuzzDms";
import { useBuzzPresence } from "@/buzz/useBuzzPresence";
import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { AppStageSlot } from "@/components/chat/AppStage";
import {
  ChatHeader,
  ChatHeaderAction,
  ChatHeaderActions,
  ChatHeaderAvatar,
  ChatHeaderBack,
  ChatHeaderMenuTrigger,
  ChatHeaderTitle,
  ChatHeaderViewItems,
  keepItemFocus,
} from "@/components/chat/ChatHeader";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { CalendarEventsBar } from "@/components/chat/CalendarEventsBar";
import { GroupChat } from "@/components/chat/GroupChat";
import { MemberList } from "@/components/chat/MemberList";
import { PinnedMessagesBar } from "@/components/chat/PinnedMessagesBar";
import { GroupBannerImage } from "@/components/GroupBannerImage";
import { CreateEventDialog } from "@/components/dialogs/CreateEventDialog";
import { GroupSettingsDialog } from "@/components/dialogs/GroupSettingsDialog";
import { InvitePeopleDialog } from "@/components/dialogs/InvitePeopleDialog";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { PaneResizeHandle } from "@/components/layout/PaneResizeHandle";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ProfileRelayHints } from "@/components/ProfileRelayHints";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import { MemberActionsContext, type MemberActionItem, type MemberActionsValue } from "@/contexts/MemberActionsContext";
import { CustomEmojisProvider } from "@/hooks/useCustomEmojis";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMembership, useJoinGroup, useLeaveGroup } from "@/hooks/useGroupMembership";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayMembers } from "@/hooks/useRelayMembers";
import { useHeaderOverflow } from "@/hooks/useHeaderOverflow";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useMobileMembersOverlay } from "@/hooks/useMobileMembersOverlay";
import { useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { channelMuteKey, useMutes } from "@/hooks/useMutes";
import { useNip29CalendarTransport } from "@/hooks/useCalendarEvents";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useUpdateUserGroupList, useUserGroupList } from "@/hooks/useUserGroupList";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { routeParamToRelay } from "@/lib/platform";
import { chatRoute } from "@/lib/routes";
import { NIP29_REMOVE_CONFIRM, tierChangeConfirm, type TierChange } from "@/lib/memberTierConfirm";
import { relayRejectionMessage, type Nip29Admin } from "@/lib/nip29";
import { displayHost, sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { activateScope, nip29Scope } from "@/wire/activation";

function JoinBanner({ relayUrl, groupId, isClosed }: { relayUrl: string; groupId: string; isClosed: boolean }) {
  const intl = useIntl();
  const join = useJoinGroup(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [searchParams] = useSearchParams();
  // Armada `?code=`, Flotilla/Coracle `?c=`, NIP-29 naddr `?invite=`.
  const inviteCode = searchParams.get("code") ?? searchParams.get("c") ?? searchParams.get("invite") ?? "";
  const [code, setCode] = useState(inviteCode);

  // Invite links only pre-fill the code; joining waits for the click.
  const handleJoin = useCallback(async () => {
    try {
      await join.mutateAsync({ code: code.trim() || undefined });
      // Joining is the explicit intent that puts the server in the 10009 list (the rail's source).
      updateList({ type: "add-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({
        title: t({ id: "groupPage.join.sent", defaultMessage: "Join request sent" }),
        description: t({
          id: "groupPage.join.sentDescription",
          defaultMessage: "The relay will admit you automatically or after review.",
        }),
      });
    } catch (e) {
      toast({
        title: t({ id: "groupPage.join.failed", defaultMessage: "Couldn't join" }),
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  }, [join, code, updateList, groupId, relayUrl]);

  return (
    <div className="flex flex-wrap items-center gap-2 mx-gutter mt-stack px-4 py-2.5 clip-corner-lg bg-chrome">
      <DoorOpen className="size-4 text-primary shrink-0" />
      <span className="text-sm flex-1 min-w-40">
        {inviteCode ? (
          <FormattedMessage
            id="groupPage.join.invited"
            defaultMessage="You've been invited to this channel on <b>{host}</b>."
            values={{ host: displayHost(relayUrl), b: (chunks) => <span className="font-medium">{chunks}</span> }}
          />
        ) : isClosed ? (
          <FormattedMessage
            id="groupPage.join.notMemberInviteOnly"
            defaultMessage="You're not a member of this invite-only channel."
          />
        ) : (
          <FormattedMessage id="groupPage.join.notMember" defaultMessage="You're not a member of this channel." />
        )}
      </span>
      {isClosed && (
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={intl.formatMessage({ id: "groupPage.join.codePlaceholder", defaultMessage: "Invite code" })}
          className="h-8 w-36 text-sm"
        />
      )}
      <Button size="sm" className="h-8" onClick={handleJoin} disabled={join.isPending}>
        {join.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <FormattedMessage id="groupPage.join.button" defaultMessage="Join channel" />
        )}
      </Button>
    </div>
  );
}

/**
 * A channel (NIP-29 group): header, optional voice bar, chat timeline,
 * member panel, join/leave and admin controls.
 */
export function GroupPage() {
  const { server, groupId: rawGroupId } = useParams<{ server: string; groupId: string }>();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const groupId = rawGroupId ? decodeURIComponent(rawGroupId) : undefined;

  const intl = useIntl();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const navigate = useNavigate();
  const { data: details, isLoading } = useGroup(relayUrl, groupId);
  // Community-level roles (NIP-43, kind 13534): on Buzz, owner/admin applies to every channel.
  const { data: relayMemberRoles } = useRelayMembers(relayUrl);
  const { data: membership, isLoading: membershipLoading } = useGroupMembership(relayUrl, groupId);
  const { data: relayHasLivekit } = useRelayLivekitSupport(relayUrl);
  const { data: relayInfo } = useRelayInfo(relayUrl);
  const serverName = relayInfo?.name || relayUrl?.replace(/^wss?:\/\//, "");
  // NIP-11 fields are relay-controlled, so sanitize.
  const serverIcon = useMediaSrc(sanitizeImageSrc(relayInfo?.icon));
  // Buzz relays get BuzzChat and drop pins/calendar/polls. `ready` gates the
  // chat SURFACE: before NIP-11 answers, GroupChat would publish plain NIP-29
  // reply shapes Buzz mishandles or rejects — not undoable.
  const { isBuzz, ready: relayModeReady } = useIsBuzzRelay(relayUrl);
  const buzzPresence = useBuzzPresence(isBuzz ? relayUrl : undefined);
  const openBuzzDm = useBuzzOpenDm(isBuzz ? relayUrl : undefined);
  const handleBuzzMessage = useCallback(
    async (peer: string) => {
      if (!relayUrl) return;
      try {
        const dmId = await openBuzzDm(peer);
        navigate(chatRoute({ kind: "nip29", relayUrl, groupId: dmId }));
      } catch (e) {
        toast({
          title: t({ id: "groupPage.dmFailed", defaultMessage: "Couldn't start the conversation" }),
          description: relayRejectionMessage(e),
          variant: "destructive",
        });
      }
    },
    [relayUrl, openBuzzDm, navigate],
  );
  const leave = useLeaveGroup(relayUrl ?? "", groupId ?? "");
  const { removeUser, putUser, deleteGroup } = useGroupModeration(relayUrl ?? "", groupId ?? "");
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { data: userGroupList } = useUserGroupList();
  const { mutedChannels, isCommunityMuted, toggleChannelMute, toggleCommunityMute } = useMutes();
  // Individual (not cascaded) mute states: the menu shows channel and server
  // mute side by side, each reflecting only its own scope.
  const channelMuted = Boolean(relayUrl && groupId && mutedChannels.has(channelMuteKey(relayUrl, groupId)));
  const serverMuted = Boolean(relayUrl && isCommunityMuted(relayUrl));
  const { activeCall, joinCall } = useCall();
  const isTouchDevice = useIsTouch();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  /** Desktop member roster visibility (`memberListVisible`); defaults off on touch devices. */
  const membersVisible = config.memberListVisible ?? !isTouchDevice;
  const toggleMembersVisible = () =>
    updateConfig((c) => ({ ...c, memberListVisible: !(c.memberListVisible ?? !isTouchDevice) }));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pinsOpen, setPinsOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [serverProfileOpen, setServerProfileOpen] = useState(false);

  const isAdmin = useMemo(() => {
    if (!user) return false;
    // Per-channel admin (39001) or community-wide owner/admin (NIP-43 13534).
    if (details?.admins.some((a) => a.pubkey === user.pubkey)) return true;
    const communityRole = relayMemberRoles?.[user.pubkey.toLowerCase()];
    return communityRole === "owner" || communityRole === "admin";
  }, [user, details?.admins, relayMemberRoles]);

  // Fold community owner/admins (NIP-43) into the channel admins (39001);
  // the higher rank wins (owner > admin).
  const mergedAdmins = useMemo<Nip29Admin[]>(() => {
    const roles = new Map<string, Set<string>>();
    for (const a of details?.admins ?? []) {
      roles.set(a.pubkey, new Set(a.roles.map((r) => r.toLowerCase())));
    }
    for (const [pubkey, role] of Object.entries(relayMemberRoles ?? {})) {
      if (role !== "owner" && role !== "admin") continue;
      const set = roles.get(pubkey) ?? new Set<string>();
      set.add(role);
      roles.set(pubkey, set);
    }
    return [...roles.entries()].map(([pubkey, set]) => ({ pubkey, roles: [...set] }));
  }, [details?.admins, relayMemberRoles]);

  // NIP-29 staff actions for every person surface in this group (member list,
  // message menus, profile card); `useUserModeration` adds block and report.
  const removeMember = removeUser.mutate;
  const putMember = putUser.mutate;
  const memberActionsValue = useMemo<MemberActionsValue>(
    () => ({
      actionsFor: (pubkey: string) => {
        if (!isAdmin || !user || pubkey === user.pubkey) return [];
        const roles = new Set(mergedAdmins.find((a) => a.pubkey === pubkey)?.roles ?? []);
        // The owner is never a valid target.
        if (roles.has("owner")) return [];
        const targetAdmin = roles.has("admin");
        const targetModerator = roles.has("moderator");
        const setRoles = (next: string[]) => putMember({ pubkey, roles: next });
        const out: MemberActionItem[] = [];
        const tier = (change: TierChange) => tierChangeConfirm("nip29", change);
        if (!targetAdmin) {
          out.push({ id: "make-admin", label: intl.formatMessage({ id: "groupPage.member.makeAdmin", defaultMessage: "Make admin" }), icon: Crown, confirm: tier("admin"), onSelect: () => setRoles(["admin"]) });
        }
        if (targetAdmin) {
          out.push({ id: "make-moderator", label: intl.formatMessage({ id: "groupPage.member.demote", defaultMessage: "Demote to moderator" }), icon: Shield, confirm: tier("demote"), onSelect: () => setRoles(["moderator"]) });
        } else if (!targetModerator) {
          out.push({ id: "make-moderator", label: intl.formatMessage({ id: "groupPage.member.makeModerator", defaultMessage: "Make moderator" }), icon: Shield, confirm: tier("moderator"), onSelect: () => setRoles(["moderator"]) });
        }
        if (targetAdmin || targetModerator) {
          out.push({ id: "remove-tier", label: intl.formatMessage({ id: "groupPage.member.removeRole", defaultMessage: "Remove role" }), icon: ShieldOff, confirm: tier("remove"), onSelect: () => setRoles([]) });
        }
        out.push({
          id: "remove",
          label: intl.formatMessage({ id: "groupPage.member.remove", defaultMessage: "Remove from channel" }),
          icon: UserMinus,
          destructive: true,
          confirm: NIP29_REMOVE_CONFIRM,
          onSelect: () => removeMember({ pubkey }),
        });
        return out;
      },
    }),
    [isAdmin, user, mergedAdmins, putMember, removeMember, intl],
  );

  const { data: relayGroups } = useRelayGroups(relayUrl);
  const navChannels = useMemo(
    () =>
      relayUrl
        ? (relayGroups ?? []).map((g) => ({
            name: g.name,
            go: () => navigate(chatRoute({ kind: "nip29", relayUrl, groupId: g.id })),
          }))
        : [],
    [relayGroups, relayUrl, navigate],
  );
  const channelNav = useChannelNavValue(navChannels);
  // Memoized: every message row reads this context.
  const chatScope = useMemo(
    () => (relayUrl && groupId ? { kind: "nip29" as const, relayUrl, groupId } : undefined),
    [relayUrl, groupId],
  );

  const { pinnedRefs, unpin } = usePinnedMessages(relayUrl, groupId);
  const hasPins = pinnedRefs.length > 0;

  const calendar = useNip29CalendarTransport(relayUrl, groupId, isAdmin);
  const hasEvents = calendar.events.length > 0;

  // Pins/Events fold into the ⋮ menu (events first) when the header overflows,
  // measured rather than breakpointed since the action set varies. Buzz lacks
  // pins (9010/39005) and calendar (NIP-52). Must precede any early return.
  const showEvents = !isBuzz && (hasEvents || isAdmin);
  const showPins = !isBuzz && hasPins;
  const [canvasOpen, setCanvasOpen] = useState(false);
  const collapsibleCount = (showEvents ? 1 : 0) + (showPins ? 1 : 0);
  const { ref: headerActionsRef, overflowCount } = useHeaderOverflow(collapsibleCount);
  const eventsCollapsed = showEvents && overflowCount >= 1;
  const pinsCollapsed = showPins && overflowCount >= (showEvents ? 2 : 1);

  useEffect(() => {
    if (pinsOpen && !hasPins) setPinsOpen(false);
  }, [pinsOpen, hasPins]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  // Mobile "back": reveal and HOLD this server's channel list until a channel is tapped.
  const [channelsOpen, setChannelsOpen] = useState(false);
  // Close on group change so the new chat opens flush.
  useEffect(() => {
    setChannelsOpen(false);
  }, [groupId]);
  const [membersOpen, setMembersOpen] = useMobileMembersOverlay(
    `${relayUrl ?? ""}|${groupId ?? ""}`,
    channelsOpen,
  );
  // Being navigated into activates this server for the session (wire/activation.ts).
  useEffect(() => {
    if (relayUrl) activateScope(nip29Scope(relayUrl));
  }, [relayUrl]);
  // Last-opened channel for ServerPage's auto-open (local-only).
  useEffect(() => {
    if (!relayUrl || !groupId) return;
    updateConfig((c) =>
      c.lastChannelByServer[relayUrl] === groupId
        ? c
        : {
            ...c,
            lastChannelByServer: { ...c.lastChannelByServer, [relayUrl]: groupId },
          },
    );
  }, [relayUrl, groupId, updateConfig]);

  // Visiting deliberately does NOT add the server to the rail or publish an
  // `add-server`: passive mounts (notifications, restores, back-nav) would undo
  // removals and race cold pools into rebuilding lists from empty. The rail is
  // exactly the 10009 list, changed only by explicit action.

  const group = details?.group;
  const buzzType = isBuzz && group ? buzzChannelType(group.event) : undefined;
  const buzzTopic = isBuzz && group ? buzzChannelTopic(group.event) : undefined;
  // The user's own 10009 list counts as membership: it's cached locally and
  // resolves instantly/offline, while relay membership queries can be
  // cold/empty/AUTH-gated on reopen and flash "Join channel" at members.
  const joinedLocally = Boolean(
    userGroupList?.groups.some((g) => g.id === groupId && g.relay === relayUrl),
  );
  // Admins may appear only in 39001, so they count as members.
  const isMember =
    isAdmin ||
    joinedLocally ||
    Boolean(membership?.isMember) ||
    Boolean(user && details?.members.includes(user.pubkey));
  // NIP-29 relays generally accept writes only from members.
  const canWrite = Boolean(user) && isMember;
  // Membership is TRI-STATE: while unresolved, show a skeleton instead of the
  // join prompt (which would flash at real members).
  const membershipPending = Boolean(user) && !isMember && (isLoading || membershipLoading);

  if (!relayUrl || !groupId) {
    return <Navigate to="/" replace />;
  }

  // `livekit`-tagged group, or the relay advertises the NIP-29 LiveKit extension.
  const hasVoice = Boolean(group?.hasLivekit || relayHasLivekit);
  const inThisCall = activeCall?.relayUrl === relayUrl && activeCall?.groupId === groupId;

  const handleLeave = async () => {
    try {
      await leave.mutateAsync({});
      updateList({ type: "remove-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: t({ id: "groupPage.left", defaultMessage: "Left channel" }) });
    } catch (e) {
      toast({
        title: t({ id: "groupPage.leaveFailed", defaultMessage: "Leave failed" }),
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t(
      {
        id: "groupPage.deleteConfirm",
        defaultMessage: "Delete \"{name}\"? This removes the channel for everyone and cannot be undone.",
      },
      { name: group?.name ?? groupId },
    ))) {
      return;
    }
    try {
      await deleteGroup.mutateAsync({});
      updateList({ type: "remove-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: t({ id: "groupPage.deleted", defaultMessage: "Channel deleted" }) });
    } catch (e) {
      toast({
        title: t({ id: "groupPage.deleteFailed", defaultMessage: "Delete failed" }),
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  };

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      {/* Member kind-0s often live only on this relay, which general routing never asks. */}
      <ProfileRelayHints relays={relayUrl ? [relayUrl] : undefined} />
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            {/* The rail must NOT close the channel list on click (it'd flash the
                previous chat before the route changes). */}
            <ServerRail />
            <ChannelSidebar
              relayUrl={relayUrl}
              onNavigate={() => setChannelsOpen(false)}
              className="flex-1 sidebar:flex-none"
            />
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
        <ChatHeader ref={headerActionsRef}>
          <ChatHeaderBack onClick={() => setChannelsOpen(true)} />
          <ChatHeaderTitle
            // Floor: the row overflows instead, which useHeaderOverflow measures.
            className="min-w-[5rem]"
            glyph={(className) =>
              buzzType === "dm"
                ? <MessageSquareText className={className} />
                : <ChannelGlyph isPrivate={group?.isPrivate} occupied={group?.hasLivekit} className={className} />
            }
            title={
              isLoading
                ? "…"
                : buzzType === "dm"
                  ? <BuzzDmName members={details?.members ?? []} selfPubkey={user?.pubkey} />
                  : group?.name ?? groupId
            }
            topic={buzzTopic || group?.about}
            avatar={<ChatHeaderAvatar src={serverIcon} name={serverName} />}
            context={serverName}
          />
          <ChatHeaderActions>
            {hasVoice && (
              <ChatHeaderAction
                icon={inThisCall ? Headphones : Phone}
                label={inThisCall
                  ? intl.formatMessage({ id: "groupPage.inVoice", defaultMessage: "In voice" })
                  : intl.formatMessage({ id: "groupPage.joinVoice", defaultMessage: "Join voice" })}
                className={cn(inThisCall && "text-success")}
                disabled={inThisCall}
                onClick={() => joinCall(relayUrl, groupId)}
              />
            )}
            <ChatHeaderAction
              icon={Search}
              label={intl.formatMessage({ id: "groupPage.searchMessages", defaultMessage: "Search messages" })}
              pressed={searchOpen}
              className="hidden sidebar:inline-flex"
              onClick={() => setSearchOpen(true)}
            />
            {isBuzz && (
              <ChatHeaderAction
                icon={ScrollText}
                label={intl.formatMessage({ id: "groupPage.canvas", defaultMessage: "Canvas" })}
                pressed={canvasOpen}
                onClick={() => setCanvasOpen((v) => !v)}
              />
            )}
            {showPins && !pinsCollapsed && (
              <ChatHeaderAction
                icon={Pin}
                label={pinsOpen
                  ? intl.formatMessage({ id: "groupPage.hidePins", defaultMessage: "Hide pinned messages" })
                  : intl.formatMessage({ id: "groupPage.showPins", defaultMessage: "Show pinned messages" })}
                tooltip={intl.formatMessage({ id: "groupPage.pinnedMessages", defaultMessage: "Pinned messages" })}
                pressed={pinsOpen}
                onClick={() => setPinsOpen((v) => !v)}
              />
            )}
            {showEvents && !eventsCollapsed && (
              <ChatHeaderAction
                icon={CalendarClock}
                label={eventsOpen
                  ? intl.formatMessage({ id: "groupPage.hideEvents", defaultMessage: "Hide events" })
                  : intl.formatMessage({ id: "groupPage.showEvents", defaultMessage: "Show events" })}
                tooltip={intl.formatMessage({ id: "groupPage.events", defaultMessage: "Events" })}
                pressed={eventsOpen}
                onClick={() => setEventsOpen((v) => !v)}
              />
            )}
            <DropdownMenu>
              <ChatHeaderMenuTrigger />
              <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={keepItemFocus}>
                <ChatHeaderViewItems
                  onSearch={() => setSearchOpen(true)}
                  onMembers={() => setMembersOpen(true)}
                  membersVisible={membersVisible}
                  onToggleMembers={toggleMembersVisible}
                />
                {/* Pins/Events overflowed from the header. */}
                {(pinsCollapsed || eventsCollapsed) && (
                  <>
                    {pinsCollapsed && (
                      <DropdownMenuItem
                        className={cn("px-3 py-2", pinsOpen && "text-foreground font-medium")}
                        onClick={() => setPinsOpen((v) => !v)}
                      >
                        <Pin className="size-4" />
                        <FormattedMessage id="groupPage.pinnedMessages" defaultMessage="Pinned messages" />
                      </DropdownMenuItem>
                    )}
                    {eventsCollapsed && (
                      <DropdownMenuItem
                        className={cn("px-3 py-2", eventsOpen && "text-foreground font-medium")}
                        onClick={() => setEventsOpen((v) => !v)}
                      >
                        <CalendarClock className="size-4" />
                        <FormattedMessage id="groupPage.events" defaultMessage="Events" />
                      </DropdownMenuItem>
                    )}
                    {user && <DropdownMenuSeparator />}
                  </>
                )}
                {user && (
                  <>
                    <DropdownMenuItem
                     
                      onClick={() => toggleChannelMute(relayUrl, groupId)}
                    >
                      {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {channelMuted ? (
                        <FormattedMessage id="groupPage.unmuteChannel" defaultMessage="Unmute channel" />
                      ) : (
                        <FormattedMessage id="groupPage.muteChannel" defaultMessage="Mute channel" />
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                     
                      onClick={() => toggleCommunityMute(relayUrl)}
                    >
                      {serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {serverMuted ? (
                        <FormattedMessage id="groupPage.unmuteServer" defaultMessage="Unmute server" />
                      ) : (
                        <FormattedMessage id="groupPage.muteServer" defaultMessage="Mute server" />
                      )}
                    </DropdownMenuItem>
                  </>
                )}
                {user && (
                  <DropdownMenuItem onClick={() => setServerProfileOpen(true)}>
                    <IdCard className="size-4" />
                    <FormattedMessage id="groupPage.serverIdentity" defaultMessage="Server identity" />
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem onClick={() => setInviteOpen(true)}>
                    <UserPlus className="size-4" />
                    <FormattedMessage id="groupPage.invitePeople" defaultMessage="Invite people" />
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="size-4" />
                    <FormattedMessage id="groupPage.channelSettings" defaultMessage="Channel settings" />
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleDelete}
                      disabled={deleteGroup.isPending}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      <FormattedMessage id="groupPage.deleteChannel" defaultMessage="Delete channel" />
                    </DropdownMenuItem>
                  </>
                )}
                {user && isMember && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleLeave}
                      disabled={leave.isPending}
                      className="text-destructive focus:text-destructive"
                    >
                      <LogOut className="size-4" />
                      <FormattedMessage id="groupPage.leaveChannel" defaultMessage="Leave channel" />
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </ChatHeaderActions>

          <ChatSearchBar
            open={searchOpen}
            value={searchQuery}
            onChange={setSearchQuery}
            onClose={closeSearch}
            placeholder={intl.formatMessage({ id: "groupPage.searchPlaceholder", defaultMessage: "Search this channel…" })}
          />
        </ChatHeader>

        {group?.banner && (
          <div className="mx-gutter mt-stack h-24 shrink-0 overflow-hidden clip-corner-lg">
            <GroupBannerImage src={group.banner} className="size-full object-cover" />
          </div>
        )}

        {isBuzz && (
          <BuzzCanvasBar
            open={canvasOpen}
            relayUrl={relayUrl}
            channelId={groupId}
            onClose={() => setCanvasOpen(false)}
          />
        )}

        <PinnedMessagesBar
          open={pinsOpen}
          pinnedRefs={pinnedRefs}
          relayUrl={relayUrl}
          canModerate={isAdmin}
          // A navigation (`/m/<id>`), not a scroll, so Back works and the chat's
          // permalink handling can load older pages.
          onJump={(id) => navigate(chatRoute({ kind: "nip29", relayUrl, groupId, messageId: id }))}
          onUnpin={(id) => { void unpin(id); }}
          onClose={() => setPinsOpen(false)}
        />

        <CalendarEventsBar
          open={eventsOpen}
          calendar={calendar}
          onClose={() => setEventsOpen(false)}
          onCreate={() => setCreateEventOpen(true)}
          onDelete={(event) => { void calendar.remove(event); }}
        />

        <CallStageSlot active={inThisCall} />

        <AppStageSlot scope={{ kind: "nip29", relayUrl, groupId }} />

        {/* Buzz stamps `closed` on every channel, so the closed/invite-code affordance is NIP-29-only. */}
        {user && !isMember && !isLoading && (
          <JoinBanner relayUrl={relayUrl} groupId={groupId} isClosed={Boolean(group?.isClosed) && !isBuzz} />
        )}

        <ChatScopeContext.Provider value={chatScope}>
        <MemberActionsContext.Provider value={memberActionsValue}>
        <CustomEmojisProvider>
        <ChannelNavContext.Provider value={channelNav}>
        <div className="relative flex flex-1 min-h-0">
          {!relayModeReady ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-label={intl.formatMessage({ id: "groupPage.connecting", defaultMessage: "Connecting to server" })} />
            </div>
          ) : isBuzz ? (
            <BuzzChat
              relayUrl={relayUrl}
              channelId={groupId}
              channelType={buzzType}
              canWrite={canWrite}
              membershipPending={membershipPending}
              canModerate={isAdmin}
              searchQuery={searchOpen ? searchQuery : ""}
            />
          ) : (
            <GroupChat
              relayUrl={relayUrl}
              groupId={groupId}
              canWrite={canWrite}
              membershipPending={membershipPending}
              canModerate={isAdmin}
              calendar={calendar}
              searchQuery={searchOpen ? searchQuery : ""}
            />
          )}
          <div
            className={cn(
              "overflow-hidden",
              "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
              "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out [[data-pane-resizing]_&]:transition-none",
              membersOpen ? "" : "pointer-events-none sidebar:pointer-events-auto",
              membersVisible && "sidebar:w-[var(--member-list-w,16.5rem)]",
            )}
          >
            <div
              className={cn(
                "relative h-full flex w-full sidebar:w-[var(--member-list-w,16.5rem)] transition-transform duration-200 ease-out",
                membersOpen ? "transform-none" : "translate-x-full",
                membersVisible ? "sidebar:transform-none" : "sidebar:translate-x-full",
              )}
            >
              <div aria-hidden className="absolute inset-0 -z-10 bg-background sidebar:hidden" />
              {membersVisible && <PaneResizeHandle pane="member" />}
              <MemberList
                admins={mergedAdmins}
                members={details?.members ?? []}
                memberRoles={details?.memberRoles}
                presence={isBuzz ? buzzPresence : undefined}
                onMessage={isBuzz ? handleBuzzMessage : undefined}
                currentUserPubkey={user?.pubkey}
                onEditProfile={() => setServerProfileOpen(true)}
                onClose={() => setMembersOpen(false)}
              />
            </div>
          </div>
        </div>
        </ChannelNavContext.Provider>
        </CustomEmojisProvider>
        </MemberActionsContext.Provider>
        </ChatScopeContext.Provider>
        </main>
      </SwipeReveal>

      {group && (
        <GroupSettingsDialog
          relayUrl={relayUrl}
          group={group}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
      {group && (
        <InvitePeopleDialog
          relayUrl={relayUrl}
          group={group}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
        />
      )}
      <ServerProfileDialog
        relayUrl={relayUrl}
        open={serverProfileOpen}
        onOpenChange={setServerProfileOpen}
      />
      <CreateEventDialog
        calendar={calendar}
        open={createEventOpen}
        onOpenChange={setCreateEventOpen}
      />
    </ServerScopeProvider>
  );
}
