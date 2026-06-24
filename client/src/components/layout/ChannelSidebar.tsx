import { Hash, Headphones, Loader2, Lock, Plus, RefreshCw, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import { CreateGroupDialog } from "@/components/dialogs/CreateGroupDialog";
import { LoginArea } from "@/components/auth/LoginArea";
import LoginDialog from "@/components/auth/LoginDialog";
import { VoicePresence } from "@/components/VoicePresence";
import SignupDialog from "@/components/auth/SignupDialog";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useLivekitParticipants, useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayUnread, type GroupUnread } from "@/hooks/useRelayUnread";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

import type { Nip29Group } from "@/lib/nip29";

function ChannelLink({
  group,
  unread,
  onNavigate,
}: {
  group: Nip29Group;
  unread?: GroupUnread;
  onNavigate?: () => void;
}) {
  const { activeCall } = useCall();
  // Voice capability: prefer the per-group `livekit` metadata tag, but fall
  // back to the relay-level capability (`/.well-known/nip29/livekit` 204).
  // Armada's relay29 metadata doesn't emit the `livekit` group tag, so
  // `group.hasLivekit` is false even though the relay speaks LiveKit — without
  // this fallback we'd never query presence and could only show a call when
  // *you* are in it (matching GroupPage's `hasVoice` gate).
  const { data: relayHasLivekit } = useRelayLivekitSupport(group.relay);
  const hasVoice = group.hasLivekit || Boolean(relayHasLivekit);
  const inCall = activeCall?.relayUrl === group.relay && activeCall?.groupId === group.id;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  // Live presence (kind 39004) so we can show when others are in voice here,
  // even if we haven't joined. Only worth querying for voice-capable groups.
  const { data: participants } = useLivekitParticipants(
    hasVoice ? group.relay : undefined,
    hasVoice ? group.id : undefined,
  );
  const othersInVoice = !inCall && (participants?.length ?? 0) > 0;
  // The audio icon should only appear when a call is actually live here (you're
  // in it or others are) — otherwise a voice-capable channel reads as a normal
  // text channel.
  const callActive = inCall || othersInVoice;
  const Icon = callActive ? Volume2 : Hash;

  return (
    <NavLink
      to={`/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // Chart-rule HUD entry: a glowing left gutter-tick marks state
          // instead of a full-bleed grey hover block. Raked left padding
          // echoes the console's diagonal.
          "gutter-tick flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors",
          "text-muted-foreground hover:text-foreground",
          // Unread channels read brighter even when not selected.
          !isActive && hasUnread && "text-foreground font-medium",
          isActive && "is-active text-foreground font-medium",
        )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate flex-1">{group.name}</span>
      {inCall ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Headphones className="size-3.5 shrink-0 text-success" aria-label="Voice active" />
          </TooltipTrigger>
          <TooltipContent>You're in voice here</TooltipContent>
        </Tooltip>
      ) : othersInVoice ? (
        <VoicePresence participants={participants!} className="text-success/90" />
      ) : null}
      {group.isPrivate && <Lock className="size-3 shrink-0 opacity-60" aria-label="Private" />}
      {/* Unread / mention indicator: an "@" pill for mentions, else a dot. */}
      {hasMention ? (
        <span
          className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
          aria-label="You were mentioned"
        >
          @
        </span>
      ) : hasUnread ? (
        <span className="shrink-0 size-2 rounded-full bg-foreground" aria-label="Unread messages" />
      ) : null}
    </NavLink>
  );
}

interface ChannelSidebarProps {
  relayUrl: string;
  onNavigate?: () => void;
  className?: string;
}

/**
 * Channel list for a server: its NIP-29 groups, a create-channel action, and
 * the account area pinned to the bottom (Discord-style).
 */
export function ChannelSidebar({ relayUrl, onNavigate, className }: ChannelSidebarProps) {
  const { data: groups, isLoading, isError, refetch, relayInfo } = useRelayGroups(relayUrl);
  const { user } = useCurrentUser();
  const { registerCallBarSlot } = useCall();
  const callBarRef = useRef<HTMLDivElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);

  // Don't let skeletons run for the full connect/timeout window (which can be
  // 8–16s on a slow or AUTH-gated relay) — that reads as a hang. Show skeletons
  // briefly, then switch to an explicit "Connecting…" message.
  const [skeletonExpired, setSkeletonExpired] = useState(false);
  useEffect(() => {
    setSkeletonExpired(false);
    const t = setTimeout(() => setSkeletonExpired(true), 2500);
    return () => clearTimeout(t);
  }, [relayUrl]);

  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { byGroup } = useRelayUnread(relayUrl, groupIds);

  // Register this sidebar's slot so the persistent call bar portals above the
  // account pill. Every instance (desktop pane + mobile drawer) registers; the
  // hidden panes simply don't show their copy.
  useEffect(() => {
    const el = callBarRef.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);

  return (
    <ChannelSidebarView
      className={className}
      title={relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "")}
      subtitle={relayUrl.replace(/^wss?:\/\//, "").replace(/\/$/, "")}
      badge={
        relayInfo?.limitation?.auth_required ? (
          <Badge variant="secondary" className="mt-0.5 w-fit text-[10px] px-1.5 py-0">AUTH required</Badge>
        ) : undefined
      }
      addChannelLabel={user ? "Create channel" : undefined}
      onAddChannel={user ? () => setCreateOpen(true) : undefined}
      footer={
        <>
          {/* Voice call bar slot — the persistent call UI portals here. */}
          <div ref={callBarRef} className="empty:hidden shrink-0" />

          {/* Account area */}
          <div className="px-3 pb-safe shrink-0">
            {user ? (
              <LoginArea className="w-full flex" />
            ) : (
              <div className="p-2 flex justify-center">
                <Button
                  onClick={() => setJoinOpen(true)}
                  className="w-full max-w-xs clip-corner-lg font-medium"
                >
                  Join
                </Button>
              </div>
            )}
          </div>

          <LoginDialog
            isOpen={joinOpen}
            onClose={() => setJoinOpen(false)}
            onLogin={() => setJoinOpen(false)}
            onSignupClick={() => {
              setJoinOpen(false);
              setSignupOpen(true);
            }}
          />
          <SignupDialog isOpen={signupOpen} onClose={() => setSignupOpen(false)} />

          <CreateGroupDialog relayUrl={relayUrl} open={createOpen} onOpenChange={setCreateOpen} />
        </>
      }
    >
      {isLoading && !skeletonExpired ? (
        <div className="space-y-2 px-2 py-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : isLoading ? (
        // Loading has outlasted the skeleton window — show an explicit,
        // non-looping "Connecting…" so it doesn't read as a hang.
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Connecting to server…
          </span>
        </div>
      ) : groups && groups.length > 0 ? (
        groups.map((group) => (
          <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
        ))
      ) : isError && !groups ? (
        // The relay couldn't be reached (NIP-11 and the group query both failed).
        <div className="px-3 py-8 text-center text-sm text-muted-foreground space-y-3">
          <p>Couldn&rsquo;t reach this server. It may be offline or unreachable.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground space-y-3">
          <p>No channels yet.</p>
          {user ? (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-2">
              <Plus className="size-3.5" />
              Create your first channel
            </Button>
          ) : (
            <p className="text-xs">Sign in to create one.</p>
          )}
        </div>
      )}
    </ChannelSidebarView>
  );
}
