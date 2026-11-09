import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, type Location } from "react-router-dom";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";
import { useShareTargetNavigation } from "@/hooks/useShareTargetNavigation";
import {
  coldLaunchPending,
  consumeColdLaunchDeepLink,
  onColdLaunchResolved,
} from "@/lib/coldLaunchDeepLink";
import {
  coldSharePending,
  consumeColdShareRoute,
  onColdShareResolved,
} from "@/lib/shareTarget";
import { BlankSplash, BootSplash } from "@/components/brand/BootSplash";
import { LocationRefProvider } from "@/components/LocationRefProvider";
import { Nip19Route } from "@/components/Nip19Route";
import { ThemePreviewBar } from "@/components/ThemePreviewBar";
import { VersionCheck } from "@/components/VersionCheck";
import { DesktopUpdateToast } from "@/components/DesktopUpdateToast";
import { Toaster } from "@/components/ui/toaster";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useIsBlocked } from "@/lib/blocklistStore";
import { firstRailRoute, homeSkippedOf, type HomeLandingState } from "@/lib/railLayout";
import { parseJoinLink, setPendingJoin } from "@/lib/joinLink";
import { CONCORD2_PANES } from "@/lib/routes";
import { lazyWithReload } from "@/lib/chunkReload";
import { likelySignedIn } from "@/lib/likelySignedIn";
// Not lazy: the signed-out landing rides in the entry chunk so it paints on mount.
import { WelcomePage } from "@/pages/WelcomePage";
import {
  ProfileOverlayContext,
  profileOverlayPubkey,
  type ProfileBackgroundState,
  type ProfileOverlay,
} from "@/lib/profileOverlay";
import { SettingsOverlayContext, useSettingsOverlayController } from "@/lib/settingsOverlay";
import { isDesktop } from "@/lib/desktop";
import { isNativeRuntime } from "@/lib/platform";
import { markBootPainted } from "@/lib/bootGate";
import { routeOpensBootGate } from "@/lib/bootGateRoute";

// Route-level code splitting. lazyWithReload turns a stale-chunk fetch after a
// deploy into a one-time reload instead of a crash.

// Lazy: nothing in the frame is usable by a signed-out visitor.
const MainLayout = lazy(lazyWithReload(() => import("@/components/layout/MainLayout").then((m) => ({ default: m.MainLayout }))));

// Prefetch the frame on a signed-in launch so lazy MainLayout doesn't slow it.
if (likelySignedIn()) {
  void import("@/components/layout/MainLayout").catch(() => undefined);
}

const LazySignedInRouterServices = lazy(() =>
  import("@/components/SignedInServices").then((m) => ({ default: m.SignedInRouterServices })),
);

const ConcordPage = lazy(lazyWithReload(() => import("@/concord/pages/ConcordPage").then((m) => ({ default: m.ConcordPage }))));
const CreateCommunityPage = lazy(lazyWithReload(() => import("@/pages/CreateCommunityPage").then((m) => ({ default: m.CreateCommunityPage }))));
const DiscordImportPage = lazy(lazyWithReload(() => import("@/pages/DiscordImportPage").then((m) => ({ default: m.DiscordImportPage }))));
const HistoryAuditPage = lazy(lazyWithReload(() => import("@/pages/HistoryAuditPage").then((m) => ({ default: m.HistoryAuditPage }))));
const DiscoverPage = lazy(lazyWithReload(() => import("@/pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage }))));
const DMsPage = lazy(lazyWithReload(() => import("@/pages/DMsPage").then((m) => ({ default: m.DMsPage }))));
const DownloadsPage = lazy(lazyWithReload(() => import("@/pages/DownloadsPage").then((m) => ({ default: m.DownloadsPage }))));
const GroupPage = lazy(lazyWithReload(() => import("@/pages/GroupPage").then((m) => ({ default: m.GroupPage }))));
const InboxPage = lazy(lazyWithReload(() => import("@/pages/InboxPage").then((m) => ({ default: m.InboxPage }))));
const GiftPage = lazy(lazyWithReload(() => import("@/pages/GiftPage")));
const InvitePage = lazy(lazyWithReload(() => import("@/concord/pages/InvitePage")));
const InvitesPage = lazy(lazyWithReload(() => import("@/concord/pages/InvitesPage").then((m) => ({ default: m.InvitesPage }))));
const BuzzInvitePage = lazy(lazyWithReload(() => import("@/buzz/BuzzInvitePage")));
const MeshPage = lazy(lazyWithReload(() => import("@/pages/MeshPage")));
const ChangelogPage = lazy(lazyWithReload(() => import("@/pages/ChangelogPage").then((m) => ({ default: m.ChangelogPage }))));
const NotificationsPage = lazy(lazyWithReload(() => import("@/pages/NotificationsPage").then((m) => ({ default: m.NotificationsPage }))));
const NotFound = lazy(lazyWithReload(() => import("@/pages/NotFound").then((m) => ({ default: m.NotFound }))));
const PrivacyPolicyPage = lazy(lazyWithReload(() => import("@/pages/PrivacyPolicyPage").then((m) => ({ default: m.PrivacyPolicyPage }))));
const ProjectsPage = lazy(lazyWithReload(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage }))));
const RemoteLoginSuccessPage = lazy(lazyWithReload(() => import("@/pages/RemoteLoginSuccessPage").then((m) => ({ default: m.RemoteLoginSuccessPage }))));
const ServerPage = lazy(lazyWithReload(() => import("@/pages/ServerPage").then((m) => ({ default: m.ServerPage }))));
const SettingsPage = lazy(lazyWithReload(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))));
const SharePage = lazy(lazyWithReload(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage }))));
const SupportPage = lazy(lazyWithReload(() => import("@/pages/SupportPage").then((m) => ({ default: m.SupportPage }))));
const TermsPage = lazy(lazyWithReload(() => import("@/pages/TermsPage").then((m) => ({ default: m.TermsPage }))));

/** Dispatch `/invite/<segment>`: an naddr is a Concord invite, anything else a relay (Buzz) invite. */
function InviteRoute() {
  const { naddr } = useParams<{ naddr: string }>();
  const isBuzz = !!naddr && !/^naddr1/i.test(naddr);
  return isBuzz ? <BuzzInvitePage /> : <InvitePage />;
}

/**
 * Signup "join" link (`/join?relay=wss://...`): stashes the relay for the signup
 * wizard. Never touches a signed-in user's relays.
 */
function JoinRoute() {
  const { user } = useCurrentUser();
  const { search } = useLocation();
  const join = useMemo(() => parseJoinLink(search), [search]);
  if (!user && join) setPendingJoin(join);
  return <Navigate to="/" replace />;
}

/**
 * Signed-out: render the landing here (`/` is its address). Signed-in: first
 * rail item, else mesh (where available), else DMs/Discover.
 */
function HomeRedirect() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();
  // Set synchronously before the wizard's `login.*`, so the redirects below don't
  // yank the user out of onboarding.
  const onboarding = useOnboardingActive();

  // Cold launch from a notification tap or share resolves async; hold the default
  // redirect until known or the late navigate loses the race.
  const [state, setState] = useState<{ ready: boolean; deepLink: string | null }>(() =>
    coldLaunchPending() || coldSharePending()
      ? { ready: false, deepLink: null }
      : { ready: true, deepLink: consumeColdLaunchDeepLink() ?? consumeColdShareRoute() },
  );
  useEffect(() => {
    const check = () => {
      if (coldLaunchPending() || coldSharePending()) return;
      setState((prev) =>
        prev.ready
          ? prev
          : { ready: true, deepLink: consumeColdLaunchDeepLink() ?? consumeColdShareRoute() },
      );
    };
    const offLaunch = onColdLaunchResolved(check);
    const offShare = onColdShareResolved(check);
    return () => {
      offLaunch();
      offShare();
    };
  }, []);

  // Land on the first item of the arranged rail. `railLayout` is in app config and
  // available synchronously, so this doesn't race the lists' async load.
  const liveServers = useNip29Servers();
  const isBlocked = useIsBlocked();
  const { state: historyState } = useLocation();
  const homeSkipped = useMemo(() => homeSkippedOf(historyState) ?? [], [historyState]);
  const firstRoute = useMemo(() => {
    const skipped = new Set(homeSkipped);
    return firstRailRoute(config.railLayout, liveServers, (id) => isBlocked(id) || skipped.has(id));
  }, [config.railLayout, liveServers, isBlocked, homeSkipped]);
  const landingState = useMemo<HomeLandingState>(() => ({ homeSkipped }), [homeSkipped]);

  if (!state.ready) {
    // Launch URL not yet known: hold the redirect (can reach the 1.5s bridge timeout).
    return user ? <BootSplash /> : <BlankSplash />;
  }
  if (state.deepLink) {
    return <Navigate to={state.deepLink} replace />;
  }

  // `onboarding` keeps the wizard mounted across its own login.
  if (!user || onboarding) {
    return <WelcomePage />;
  }

  // Offline: mesh is the only working transport, but only on Android with BLE.
  // Wait briefly for the availability probe.
  if (!online) {
    if (mesh.probing) {
      return <BootSplash />;
    }
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
  }

  if (!firstRoute) {
    // No community yet: mesh where available, else DMs. Don't force the landing,
    // or community-less users are re-onboarded on every relaunch.
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
    // `/dm` bounces to `/` when DMs are disabled, so avoid the loop.
    return <Navigate to={config.dmsDisabled ? "/discover" : "/dm"} replace />;
  }
  return <Navigate to={firstRoute} replace state={landingState} />;
}

/** Bounce signed-out users to `/` for account-scoped routes. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  if (!user) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * With `config.dmsDisabled`, send stale DM deep links to `/`. Wraps
 * `RequireAuth` so a signed-out hit still bounces to the landing first.
 */
function RequireDms({ children }: { children: ReactNode }) {
  const { config } = useAppContext();
  if (config.dmsDisabled) {
    return <Navigate to="/" replace />;
  }
  return <RequireAuth>{children}</RequireAuth>;
}

/**
 * Redirect legacy `/dms` paths to `/dm`. Needed for links outside this build:
 * old push subscriptions and Android tray notifications (`armada://open/dms/<peer>`).
 */
function LegacyDmRedirect() {
  const { peer } = useParams<{ peer: string }>();
  const { search, hash } = useLocation();
  return <Navigate to={`/dm${peer ? `/${peer}` : ""}${search}${hash}`} replace />;
}

function RouteFallback() {
  return <BootSplash />;
}

/**
 * Prefetch notification-target route chunks at idle after boot so a later
 * notification tap doesn't wait on a chunk fetch. Web only: the desktop and
 * native apps load chunks from their own bundle in milliseconds, and an
 * `import()` keeps the evaluated modules resident (~15 MB on desktop).
 */
function useWarmRouteChunks() {
  useEffect(() => {
    if (isDesktop() || isNativeRuntime()) return;
    const timer = setTimeout(() => {
      for (const load of [
        () => import("@/pages/GroupPage"),
        () => import("@/concord/pages/ConcordPage"),
        () => import("@/pages/DMsPage"),
        () => import("@/pages/NotificationsPage"),
        () => import("@/pages/ServerPage"),
        () => import("@/pages/DiscoverPage"),
        // The profile overlay opens over a page, so nothing else would warm it.
        () => import("@/components/profile/ProfileDialog"),
        () => import("@/pages/SettingsPage"),
      ]) {
        void load().catch(() => undefined);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);
}

/** Notification-tap and warm-share navigation bridges; must be inside <BrowserRouter>. */
function NotificationNavigation() {
  useNotificationNavigation();
  useShareTargetNavigation();
  return null;
}

/** In-router signed-in services, gated on `user` and lazy like `SignedInServices`. */
function SignedInRouterServicesGate() {
  const { user } = useCurrentUser();
  if (!user) return null;
  return (
    <Suspense fallback={null}>
      <LazySignedInRouterServices />
    </Suspense>
  );
}

/**
 * Keep the previous `location` object while it names the same history entry,
 * so closing an overlay doesn't re-render the routed tree.
 */
function useSameEntry(location: Location): Location {
  const ref = useRef(location);
  const prev = ref.current;
  if (
    prev !== location &&
    !(
      prev.key === location.key &&
      prev.pathname === location.pathname &&
      prev.search === location.search &&
      prev.hash === location.hash
    )
  ) {
    ref.current = location;
  }
  return ref.current;
}

/**
 * Routes are matched against `backgroundLocation` when present, so the page
 * behind a profile/settings overlay stays mounted (see `lib/profileOverlay.ts`).
 */
function AppRoutes() {
  const location = useLocation();
  const background = (location.state as ProfileBackgroundState | null)?.backgroundLocation;
  const routedPubkey = background ? profileOverlayPubkey(location.pathname) : undefined;

  // Cleared by any completed navigation, so a click that never opens a profile
  // can't strand the spinner.
  const [opening, setOpening] = useState(false);
  useEffect(() => setOpening(false), [location]);
  const overlay = useMemo<ProfileOverlay>(
    () => ({ pubkey: routedPubkey, opening, begin: () => setOpening(true) }),
    [routedPubkey, opening],
  );
  const settings = useSettingsOverlayController(location, useNavigate());
  const target = useSameEntry(background ?? location);

  // A page with no timeline opens the boot gate on its first frame (see bootGateRoute).
  const gatePath = target.pathname;
  useEffect(() => {
    if (routeOpensBootGate(gatePath)) return;
    const frame = requestAnimationFrame(() => markBootPainted());
    return () => cancelAnimationFrame(frame);
  }, [gatePath]);

  // Load-bearing memo: `<Routes>` would otherwise re-render the whole routed tree
  // when only the overlay changes.
  const routes = useMemo(
    () => (
        <Routes location={target}>
          {/* Outside <MainLayout> so the landing and pure redirects don't fetch the frame. */}
          <Route path="/" element={<HomeRedirect />} />
          {/* Old landing address; bookmarks and older builds' logout still use it. */}
          <Route path="/welcome" element={<Navigate to="/" replace />} />
          <Route path="/join" element={<JoinRoute />} />
          <Route element={<MainLayout />}>
            <Route path="/s/:server" element={<ServerPage />} />
            <Route path="/s/:server/projects" element={<ProjectsPage />} />
            <Route path="/s/:server/inbox" element={<RequireAuth><InboxPage /></RequireAuth>} />
            {/* `/t/` and `/m/` markers keep a thread root's two identities distinct (see `lib/routes.ts`). */}
            <Route path="/s/:server/:groupId" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/m/:messageId" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/t/:threadRoot" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/t/:threadRoot/m/:messageId" element={<GroupPage />} />
            {/* Membership is a key the account holds, so there's no signed-out view. */}
            <Route path="/c/:communityId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/history" element={<RequireAuth><HistoryAuditPage /></RequireAuth>} />
            {CONCORD2_PANES.map((pane) => (
              <Route key={pane} path={`/c/:communityId/${pane}`} element={<RequireAuth><ConcordPage /></RequireAuth>} />
            ))}
            <Route path="/c/:communityId/:channelId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/:channelId/m/:messageId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/:channelId/t/:threadRoot" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            <Route path="/c/:communityId/:channelId/t/:threadRoot/m/:messageId" element={<RequireAuth><ConcordPage /></RequireAuth>} />
            {/* Concord invites carry an naddr (CORD-05); Buzz invite codes never do. */}
            <Route path="/invite/:naddr" element={<InviteRoute />} />
            {/* Armada Ultra gifts; signed out too, so a gift doubles as an invite. */}
            <Route path="/gift/:from" element={<GiftPage />} />
            <Route path="/changelog" element={<ChangelogPage />} />
            {/* Also a real directory on the hosted deployment (installers). */}
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/support" element={<SupportPage />} />
            <Route path="/share" element={<SharePage />} />
            {/* Callback target baked into nostrconnect:// URIs. */}
            <Route path="/remoteloginsuccess" element={<RemoteLoginSuccessPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            {/* Routes, not dialogs: they must outlive the Add dialog (see DiscordImportPage). */}
            <Route path="/create" element={<RequireAuth><CreateCommunityPage /></RequireAuth>} />
            <Route path="/import/discord" element={<RequireAuth><DiscordImportPage /></RequireAuth>} />
            <Route path="/mesh" element={<RequireAuth><MeshPage /></RequireAuth>} />
            {/* Received direct invites (CORD-05 §6). */}
            <Route path="/invites" element={<RequireAuth><InvitesPage /></RequireAuth>} />
            <Route path="/notifications" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
            <Route path="/dm" element={<RequireDms><DMsPage /></RequireDms>} />
            <Route path="/dm/:peer" element={<RequireDms><DMsPage /></RequireDms>} />
            <Route path="/dm/:peer/m/:messageId" element={<RequireDms><DMsPage /></RequireDms>} />
            {/* Must precede `/:user`, which would swallow `/dms`. */}
            <Route path="/dms" element={<LegacyDmRedirect />} />
            <Route path="/dms/:peer" element={<LegacyDmRedirect />} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
            {/* `/<npub|nprofile|nip05|naddr>` (see Nip19Route). UserPage renders the 404 for unknown segments. */}
            <Route path="/:user" element={<Nip19Route />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
    ),
    [target],
  );

  return (
    <ProfileOverlayContext.Provider value={overlay}>
      <SettingsOverlayContext.Provider value={settings}>
        <Suspense fallback={<RouteFallback />}>{routes}</Suspense>
      </SettingsOverlayContext.Provider>
    </ProfileOverlayContext.Provider>
  );
}

export function AppRouter() {
  useWarmRouteChunks();
  return (
    <BrowserRouter>
      <NotificationNavigation />
      <SignedInRouterServicesGate />
      <VersionCheck />
      <DesktopUpdateToast />
      {/* MUST be inside <BrowserRouter>: toasts can carry router <Link> actions. */}
      <Toaster />
      <ThemePreviewBar />
      <LocationRefProvider>
        <AppRoutes />
      </LocationRefProvider>
    </BrowserRouter>
  );
}

export default AppRouter;
