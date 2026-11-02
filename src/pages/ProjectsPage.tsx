import { ChevronLeft, FolderGit2 } from "lucide-react";
import { Navigate, useParams } from "react-router-dom";
import { useState } from "react";

import { BuzzProjectsView } from "@/buzz/BuzzProjects";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { Button } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/i18n";
import { routeParamToRelay } from "@/lib/platform";

/**
 * A Buzz workspace's NIP-34 Projects view; a mobile drill-down over the rail
 * and channel list like GroupPage.
 */
export function ProjectsPage() {
  const intl = useIntl();
  const { server } = useParams<{ server: string }>();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const [channelsOpen, setChannelsOpen] = useState(false);

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            <ServerRail />
            <ChannelSidebar
              relayUrl={relayUrl}
              onNavigate={() => setChannelsOpen(false)}
              className="touch:max-sidebar:flex-1"
            />
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "projectsPage.backToChannels", defaultMessage: "Back to channels" })}
              className="size-9 touch:size-11 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <FolderGit2 className="size-5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <h1 className="font-semibold truncate leading-tight">
                <FormattedMessage id="projectsPage.title" defaultMessage="Projects" />
              </h1>
            </div>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <BuzzProjectsView relayUrl={relayUrl} />
          </div>
        </main>
      </SwipeReveal>
    </ServerScopeProvider>
  );
}

export default ProjectsPage;
