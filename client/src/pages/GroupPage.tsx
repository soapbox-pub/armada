import { DoorOpen, Hash, IdCard, Loader2, Lock, LogOut, Menu, MoreVertical, Phone, Pin, Search, Settings2, Trash2, UserPlus, Users, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { CallStageSlot } from "@/components/chat/CallStage";
import { GroupChat } from "@/components/chat/GroupChat";
import { MemberList } from "@/components/chat/MemberList";
import { PinnedMessagesBar } from "@/components/chat/PinnedMessagesBar";
import { GroupSettingsDialog } from "@/components/dialogs/GroupSettingsDialog";
import { InvitePeopleDialog } from "@/components/dialogs/InvitePeopleDialog";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMembership, useJoinGroup, useLeaveGroup } from "@/hooks/useGroupMembership";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useCommunityRoles } from "@/hooks/useCommunityRoles";
import { useRelayLivekitSupport } from "@/hooks/useLivekit";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { toast } from "@/hooks/useToast";
import { routeParamToRelay } from "@/lib/platform";
import { relayRejectionMessage } from "@/lib/nip29";
import { cn } from "@/lib/utils";

function JoinBanner({ relayUrl, groupId, isClosed }: { relayUrl: string; groupId: string; isClosed: boolean }) {
  const join = useJoinGroup(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [searchParams] = useSearchParams();
  // Accept both Armada's `?code=` and Flotilla/Coracle's `?c=` invite param.
  const inviteCode = searchParams.get("code") ?? searchParams.get("c") ?? "";
  const [code, setCode] = useState(inviteCode);
  const autoJoined = useRef(false);

  const handleJoin = useCallback(async () => {
    try {
      await join.mutateAsync({ code: code.trim() || undefined });
      updateList({ type: "add-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Join request sent", description: "The relay will admit you automatically or after review." });
    } catch (e) {
      toast({
        title: "Couldn't join",
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  }, [join, code, updateList, groupId, relayUrl]);

  // Shared invite link → join automatically once on arrival.
  useEffect(() => {
    if (inviteCode && !autoJoined.current && !join.isPending) {
      autoJoined.current = true;
      void handleJoin();
    }
  }, [inviteCode, join.isPending, handleJoin]);

  return (
    <div className="flex flex-wrap items-center gap-2 mx-2 mt-2 px-4 py-2.5 clip-corner-lg bg-chrome">
      <DoorOpen className="size-4 text-primary shrink-0" />
      <span className="text-sm flex-1 min-w-40">
        You're not a member of this channel{isClosed ? " — it's invite-only" : ""}.
      </span>
      {isClosed && (
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Invite code"
          className="h-8 w-36 text-sm"
        />
      )}
      <Button size="sm" className="h-8" onClick={handleJoin} disabled={join.isPending}>
        {join.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Join channel"}
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

  const { user } = useCurrentUser();
  const { data: details, isLoading } = useGroup(relayUrl, groupId);
  const { data: membership, isLoading: membershipLoading } = useGroupMembership(relayUrl, groupId);
  const { data: relayHasLivekit } = useRelayLivekitSupport(relayUrl);
  const leave = useLeaveGroup(relayUrl ?? "", groupId ?? "");
  const { removeUser, putUser, deleteGroup } = useGroupModeration(relayUrl ?? "", groupId ?? "");
  const { data: communityRolesData, assignRole, unassignRole } = useCommunityRoles(relayUrl);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { activeCall, joinCall } = useCall();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  /** Whether the desktop member roster is shown (toggled from the header). */
  const [membersVisible, setMembersVisible] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(false);
  /** Whether the header search bar is expanded, and its current query text. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** Whether the pinned-messages bar is expanded below the header. */
  const [pinsOpen, setPinsOpen] = useState(false);
  const [serverProfileOpen, setServerProfileOpen] = useState(false);
  /** Server whose channels are shown in the mobile drawer (defaults to current). */
  const [drawerServer, setDrawerServer] = useState(relayUrl ?? "");

  const isAdmin = useMemo(
    () => Boolean(user && details?.admins.some((a) => a.pubkey === user.pubkey)),
    [user, details?.admins],
  );

  const { pinnedIds, unpin } = usePinnedMessages(relayUrl, groupId);
  const hasPins = pinnedIds.length > 0;

  const searchInputRef = useRef<HTMLInputElement>(null);
  // Lets the pinned-messages bar jump to a message in the timeline; GroupChat
  // assigns the scroll function into this ref.
  const scrollToMessageRef = useRef<((id: string) => void) | null>(null);
  // Focus the search field when it expands. `preventScroll` is essential: the
  // input starts off-screen (left-full) and slides in, so a default focus()
  // makes the browser scroll the whole page to reveal it — a visible jolt.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);
  // Collapse the pinned bar if everything gets unpinned while it's open.
  useEffect(() => {
    if (pinsOpen && !hasPins) setPinsOpen(false);
  }, [pinsOpen, hasPins]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  if (!relayUrl || !groupId) {
    return <Navigate to="/" replace />;
  }

  const group = details?.group;
  // Admins may only appear in the kind 39001 admins list (e.g. the group
  // creator), not in 39002 members or via 9000 put-user events, so treat
  // admin status as membership too.
  const isMember =
    isAdmin || Boolean(membership?.isMember) || Boolean(user && details?.members.includes(user.pubkey));
  // NIP-29 relays generally only accept writes from members (relay29 always
  // does), so gate the composer on membership.
  const canWrite = Boolean(user) && isMember;
  // Membership is a TRI-STATE: while the group details or the membership query
  // are still resolving and we don't yet have a positive membership signal, the
  // member-vs-not answer is UNKNOWN — not "not a member". Surfacing the "join to
  // message" prompt during this window flashes it at actual members. When a
  // logged-in user is in this ambiguous window, the composer area shows a
  // skeleton instead of the join prompt.
  const membershipPending = Boolean(user) && !isMember && (isLoading || membershipLoading);
  // Voice is available when the group is tagged `livekit` or the relay
  // advertises the NIP-29 LiveKit extension for all its groups.
  const hasVoice = Boolean(group?.hasLivekit || relayHasLivekit);
  // Whether the active app-level call is this channel's room.
  const inThisCall = activeCall?.relayUrl === relayUrl && activeCall?.groupId === groupId;

  const handleLeave = async () => {
    try {
      await leave.mutateAsync({});
      updateList({ type: "remove-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Left channel" });
    } catch (e) {
      toast({
        title: "Leave failed",
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${group?.name ?? groupId}"? This removes the channel for everyone and cannot be undone.`)) {
      return;
    }
    try {
      await deleteGroup.mutateAsync({});
      updateList({ type: "remove-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Channel deleted" });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  };

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      {/* Desktop panes (hidden on mobile — the chat is the full screen). */}
      <ServerRail className="hidden sidebar:flex" />
      <ChannelSidebar relayUrl={relayUrl} className="hidden sidebar:flex" />

      <main className="flex-1 min-w-0 flex flex-col safe-area-top">
        {/* Channel header — detached floating command bar, matching the right
            roster: same margin, cut-corner card, and recessed chrome shade. */}
        <header className="relative h-12 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
          {/* Mobile menu → reveals the channel list as a left drawer. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open channels"
            className="size-9 shrink-0 sidebar:hidden"
            onClick={() => setChannelsOpen(true)}
          >
            <Menu className="size-5" />
          </Button>

          {group?.hasLivekit
            ? <Volume2 className="size-5 text-muted-foreground shrink-0" />
            : <Hash className="size-5 text-muted-foreground shrink-0" />}
          <div className="min-w-0 flex-1">
            <h1 className="font-semibold truncate leading-tight">
              {isLoading ? "…" : group?.name ?? groupId}
            </h1>
            {group?.about && (
              <p className="text-xs text-muted-foreground truncate">{group.about}</p>
            )}
          </div>
          {group?.isPrivate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="size-4 text-muted-foreground" aria-label="Members-only channel" />
              </TooltipTrigger>
              <TooltipContent>Members-only — only members can read</TooltipContent>
            </Tooltip>
          )}
          {hasVoice && !inThisCall && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Join voice"
                  className="size-8 text-muted-foreground hover:text-success"
                  onClick={() => joinCall(relayUrl, groupId)}
                >
                  <Phone className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Join voice</TooltipContent>
            </Tooltip>
          )}
          {/* Pinned messages — toggles the browse bar below the header. */}
          {hasPins && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Pinned messages"
                  aria-pressed={pinsOpen}
                  className={cn("size-8 text-muted-foreground", pinsOpen && "text-foreground")}
                  onClick={() => setPinsOpen((v) => !v)}
                >
                  <Pin className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pinned messages</TooltipContent>
            </Tooltip>
          )}
          {/* Search messages in this channel — expands inline below. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search messages"
                aria-pressed={searchOpen}
                className={cn("size-8 text-muted-foreground", searchOpen && "text-foreground")}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search messages</TooltipContent>
          </Tooltip>
          {/* Mobile members button → opens the member sheet. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Members"
            aria-pressed={membersOpen}
            className="size-8 sidebar:hidden"
            onClick={() => setMembersOpen((v) => !v)}
          >
            <Users className="size-4" />
          </Button>
          {/* Desktop members toggle → shows/hides the roster panel. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={membersVisible ? "Hide members" : "Show members"}
                aria-pressed={membersVisible}
                className={cn(
                  "size-8 hidden sidebar:inline-flex text-muted-foreground",
                  membersVisible && "text-foreground",
                )}
                onClick={() => setMembersVisible((v) => !v)}
              >
                <Users className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
          </Tooltip>
          {(isAdmin || (user && isMember)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More options"
                  className="size-8 text-muted-foreground"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 p-1.5">
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
                  {group?.name ?? "Channel"}
                </DropdownMenuLabel>
                {user && (
                  <DropdownMenuItem className="px-3 py-2" onClick={() => setServerProfileOpen(true)}>
                    <IdCard className="size-4" />
                    Server identity
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem className="px-3 py-2" onClick={() => setInviteOpen(true)}>
                    <UserPlus className="size-4" />
                    Invite people
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem className="px-3 py-2" onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="size-4" />
                    Channel settings
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleDelete}
                      disabled={deleteGroup.isPending}
                      className="px-3 py-2 text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      Delete channel
                    </DropdownMenuItem>
                  </>
                )}
                {user && isMember && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleLeave}
                      disabled={leave.isPending}
                      className="px-3 py-2 text-destructive focus:text-destructive"
                    >
                      <LogOut className="size-4" />
                      Leave channel
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Inline search bar: smoothly expands across the header (covering the
              title and actions) when open. On mobile it leaves the menu button
              visible; on desktop it covers the full bar. An X dismisses it.
              Slides via GPU-composited transform (not `left`) so it animates on
              the compositor and never forces a per-frame reflow / jitter. */}
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
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              placeholder="Search this channel…"
              className="h-8 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close search"
              className="size-8 shrink-0 text-muted-foreground"
              onClick={closeSearch}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* Pinned messages bar — slides open below the header. */}
        <PinnedMessagesBar
          open={pinsOpen}
          pinnedIds={pinnedIds}
          relayUrl={relayUrl}
          canModerate={isAdmin}
          onJump={(id) => scrollToMessageRef.current?.(id)}
          onUnpin={(id) => { void unpin(id); }}
          onClose={() => setPinsOpen(false)}
        />

        {/* Top-of-chat call stage: the active call's participants + video tiles
            portal in here (dismissable, toggled from the corner call panel)
            when this channel is the one in call. */}
        <CallStageSlot active={inThisCall} />

        {/* Join banner */}
        {user && !isMember && !isLoading && (
          <JoinBanner relayUrl={relayUrl} groupId={groupId} isClosed={Boolean(group?.isClosed)} />
        )}

        {/* The active voice call (if any) renders as a persistent docked bar in
            MainLayout, so it survives navigation between channels/servers. */}

        {/* Chat + members. The member panel mirrors the thread panel: in-flow
            animated-width on desktop, full-screen floating card overlay on
            mobile (no drawer/backdrop). */}
        <div className="relative flex flex-1 min-h-0">
          <GroupChat
            relayUrl={relayUrl}
            groupId={groupId}
            canWrite={canWrite}
            membershipPending={membershipPending}
            canModerate={isAdmin}
            searchQuery={searchOpen ? searchQuery : ""}
            scrollToMessageRef={scrollToMessageRef}
          />
          <div
            className={cn(
              "overflow-hidden",
              "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
              "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
              membersOpen ? "" : "pointer-events-none sidebar:pointer-events-auto",
              membersVisible && "sidebar:w-[16.5rem]",
            )}
          >
            {/* Mobile backdrop: fades in/out in sync with the panel slide. */}
            <div
              className={cn(
                "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                membersOpen ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                // Mobile: driven by membersOpen. Desktop: driven by membersVisible.
                membersOpen ? "translate-x-0" : "translate-x-full",
                membersVisible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
              )}
            >
              <MemberList
                admins={details?.admins ?? []}
                members={details?.members ?? []}
                canModerate={isAdmin}
                viewerIsAdmin={isAdmin}
                currentUserPubkey={user?.pubkey}
                onRemove={(pubkey) => removeUser.mutate({ pubkey })}
                onSetRole={(pubkey, roles) => putUser.mutate({ pubkey, roles })}
                onEditProfile={() => setServerProfileOpen(true)}
                onClose={() => setMembersOpen(false)}
                communityRoles={communityRolesData?.roles}
                communityAssignments={communityRolesData?.assignments}
                onToggleCommunityRole={(pubkey, roleId, assigned) =>
                  assigned
                    ? unassignRole.mutate({ pubkey, roleId })
                    : assignRole.mutate({ pubkey, roleId })
                }
              />
            </div>
          </div>
        </div>
      </main>

      {/* Mobile channel list drawer (server rail + channels) */}
      <Sheet
        open={channelsOpen}
        onOpenChange={(open) => {
          setChannelsOpen(open);
          if (open) setDrawerServer(relayUrl);        }}
      >
        <SheetContent
          side="left"
          className="flex w-[min(20rem,85vw)] gap-0 p-0 sidebar:hidden [&>button]:hidden"
          aria-label="Channels"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* The rail + channel-list header own their own top safe-area inset,
              so this wrapper must not add it again (would double-pad). */}
          <div className="flex h-full w-full">
            <ServerRail
              selectedServer={drawerServer}
              onServerSelect={setDrawerServer}
            />
            <ChannelSidebar
              relayUrl={drawerServer}
              onNavigate={() => setChannelsOpen(false)}
              className="flex-1"
            />
          </div>
        </SheetContent>
      </Sheet>

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
    </ServerScopeProvider>
  );
}
