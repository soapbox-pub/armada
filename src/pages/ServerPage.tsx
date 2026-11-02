import { Bell, BellOff, Hash, IdCard, Link2, MoreVertical, Trash2, Volume2 } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";

import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { GroupBannerImage } from "@/components/GroupBannerImage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { FormattedMessage, common, useIntl } from "@/i18n";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useServerActions } from "@/hooks/useServerActions";
import { useIsBuzzRelay } from "@/buzz/detect";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { activateScope, nip29Scope } from "@/wire/activation";

/** Server home (drill-down level 1); the info pane is desktop-only. */
export function ServerPage() {
  const intl = useIntl();
  const { server } = useParams<{ server: string }>();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const [profileOpen, setProfileOpen] = useState(false);
  // Being navigated into activates this server for the session (wire/activation.ts).
  useEffect(() => {
    if (relayUrl) activateScope(nip29Scope(relayUrl));
  }, [relayUrl]);
  // Called unconditionally (rules of hooks); actions only run once a server resolves.
  const { serverMuted, isRemovable, toggleMute, copyLink, removeServer } =
    useServerActions(relayUrl ?? "");

  const { data: groups, isLoading, isError, relayInfo } = useRelayGroups(relayUrl);
  const relayIcon = useMediaSrc(sanitizeImageSrc(relayInfo?.icon));
  // Buzz: hide DM (hidden) groups and the "Invite-only" badge (Buzz marks every channel `closed`).
  const { isBuzz } = useIsBuzzRelay(relayUrl);
  const visibleGroups = isBuzz ? groups?.filter((g) => !g.isHidden) : groups;

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <ServerRail />
      <ChannelSidebar
        relayUrl={relayUrl}
        className="touch:max-sidebar:flex-1"
      />

      <main className="hidden sidebar:block flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="flex size-16 items-center justify-center clip-corner-lg bg-primary/10 shrink-0 overflow-hidden">
              <img
                src={relayIcon || "/logo.svg"}
                alt={relayInfo?.name || "Armada"}
                className="size-16 object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold truncate">
                {relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "")}
              </h1>
              <p className="text-sm text-muted-foreground break-all">{relayUrl}</p>
              {relayInfo?.description && (
                <p className="mt-2 text-sm text-muted-foreground">{relayInfo.description}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {relayInfo?.limitation?.auth_required && <Badge variant="secondary">NIP-42 AUTH</Badge>}
                {isBuzz ? (
                  <Badge variant="secondary">
                    <FormattedMessage id="serverPage.buzzWorkspace" defaultMessage="Buzz workspace" />
                  </Badge>
                ) : (
                  relayInfo?.supported_nips?.includes(29) && (
                    <Badge variant="secondary">
                      <FormattedMessage id="serverPage.nip29Groups" defaultMessage="NIP-29 groups" />
                    </Badge>
                  )
                )}
                {relayInfo?.software && (
                  <Badge variant="outline" className="max-w-48 truncate">
                    {relayInfo.software.split("/").pop()} {relayInfo.version}
                  </Badge>
                )}
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={intl.formatMessage({ id: "serverPage.serverActions", defaultMessage: "Server actions" })} className="size-8 text-muted-foreground hover:text-foreground shrink-0">
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {user && (
                  <DropdownMenuItem onClick={() => setProfileOpen(true)}>
                    <IdCard className="size-4" />
                    <FormattedMessage id="serverPage.serverIdentity" defaultMessage="Server identity" />
                  </DropdownMenuItem>
                )}
                {user && (
                  <DropdownMenuItem
                   
                    onClick={toggleMute}
                  >
                    {serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                    {serverMuted
                      ? <FormattedMessage id="serverPage.unmuteServer" defaultMessage="Unmute server" />
                      : <FormattedMessage id="serverPage.muteServer" defaultMessage="Mute server" />}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={copyLink}>
                  <Link2 className="size-4" />
                  <FormattedMessage {...common.copyLink} />
                </DropdownMenuItem>
                {isRemovable && (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={removeServer}
                  >
                    <Trash2 className="size-4" />
                    <FormattedMessage id="serverPage.removeServer" defaultMessage="Remove server" />
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              <FormattedMessage id="serverPage.channels" defaultMessage="Channels" />
            </h2>
            {isLoading ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : visibleGroups && visibleGroups.length > 0 ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {visibleGroups.map((group) => (
                  <Card
                    key={group.id}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer overflow-hidden hover:border-primary/50 transition-colors"
                    onClick={() => navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(group.id)}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(group.id)}`);
                      }
                    }}
                  >
                    {group.banner && (
                      <div className="h-20 overflow-hidden">
                        <GroupBannerImage src={group.banner} className="size-full object-cover" />
                      </div>
                    )}
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        {group.hasLivekit ? <Volume2 className="size-4 text-muted-foreground" /> : <Hash className="size-4 text-muted-foreground" />}
                        <span className="truncate">{group.name}</span>
                      </CardTitle>
                      {group.about && (
                        <CardDescription className="line-clamp-2">{group.about}</CardDescription>
                      )}
                    </CardHeader>
                    <CardContent className="pt-0 flex flex-wrap gap-1.5">
                      {group.isPrivate && <Badge variant="outline" className="text-3xs"><FormattedMessage id="serverPage.membersOnly" defaultMessage="Members-only" /></Badge>}
                      {group.isClosed && !isBuzz && <Badge variant="outline" className="text-3xs"><FormattedMessage id="serverPage.inviteOnly" defaultMessage="Invite-only" /></Badge>}
                      {group.hasLivekit && <Badge variant="outline" className="text-3xs"><FormattedMessage id="serverPage.voice" defaultMessage="Voice" /></Badge>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : isError && !groups ? (
              <Card className="border-dashed">
                <CardContent className="py-12 px-8 text-center">
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    <FormattedMessage
                      id="serverPage.unreachable"
                      defaultMessage="Couldn’t reach this server. It may be offline or unreachable."
                    />
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="py-12 px-8 text-center">
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    <FormattedMessage
                      id="serverPage.noChannels"
                      defaultMessage="No channels on this server yet. Create one from the sidebar, or wait a moment for the relay to respond."
                    />
                  </p>
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      </main>

      {relayUrl && (
        <ServerProfileDialog
          relayUrl={relayUrl}
          open={profileOpen}
          onOpenChange={setProfileOpen}
        />
      )}
    </ServerScopeProvider>
  );
}
