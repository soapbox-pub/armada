import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";
import { useShareTargetNavigation } from "@/hooks/useShareTargetNavigation";
import { useForegroundNotifications } from "@/hooks/useForegroundNotifications";
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
import { MainLayout } from "@/components/layout/MainLayout";
import { VersionCheck } from "@/components/VersionCheck";
import { Toaster } from "@/components/ui/toaster";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useWarmDiscover } from "@/hooks/useDiscover";
import { flattenLayout, mergeLayout, railKeyToRoute } from "@/lib/railLayout";
import { parseJoinLink, setPendingJoin } from "@/lib/joinLink";
import { CONCORD2_PANES } from "@/lib/routes";
import { lazyWithReload } from "@/lib/chunkReload";

// Route-level code splitting: each page loads as its own chunk on first visit,
// so the boot bundle carries only the shell + the landing route's code. This is
// a large cut on a mid-range Android WebView, where parsing the previously
// monolithic bundle was a visible slice of every cold start.
//
// Each import is wrapped with lazyWithReload so a stale-chunk fetch after a
// deploy (an open tab referencing pruned hashes) triggers a one-time reload to
// a consistent build instead of surfacing as a crash.
const ConcordPage = lazy(lazyWithReload(() => import("@/concord/pages/ConcordPage").then((m) => ({ default: m.ConcordPage }))));
const DiscordImportPage = lazy(lazyWithReload(() => import("@/pages/DiscordImportPage").then((m) => ({ default: m.DiscordImportPage }))));
const HistoryAuditPage = lazy(lazyWithReload(() => import("@/pages/HistoryAuditPage").then((m) => ({ default: m.HistoryAuditPage }))));
const DiscoverPage = lazy(lazyWithReload(() => import("@/pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage }))));
const DMsPage = lazy(lazyWithReload(() => import("@/pages/DMsPage").then((m) => ({ default: m.DMsPage }))));
const DownloadsPage = lazy(lazyWithReload(() => import("@/pages/DownloadsPage").then((m) => ({ default: m.DownloadsPage }))));
const GroupPage = lazy(lazyWithReload(() => import("@/pages/GroupPage").then((m) => ({ default: m.GroupPage }))));
const InboxPage = lazy(lazyWithReload(() => import("@/pages/InboxPage").then((m) => ({ default: m.InboxPage }))));
const InvitePage = lazy(lazyWithReload(() => import("@/concord/pages/InvitePage")));
const InvitesPage = lazy(lazyWithReload(() => import("@/concord/pages/InvitesPage").then((m) => ({ default: m.InvitesPage }))));
const BuzzInvitePage = lazy(lazyWithReload(() => import("@/buzz/BuzzInvitePage")));
const MeshPage = lazy(lazyWithReload(() => import("@/pages/MeshPage")));
const ChangelogPage = lazy(lazyWithReload(() => import("@/pages/ChangelogPage").then((m) => ({ default: m.ChangelogPage }))));
const NotFound = lazy(lazyWithReload(() => import("@/pages/NotFound").then((m) => ({ default: m.NotFound }))));
const PrivacyPolicyPage = lazy(lazyWithReload(() => import("@/pages/PrivacyPolicyPage").then((m) => ({ default: m.PrivacyPolicyPage }))));
const ProjectsPage = lazy(lazyWithReload(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage }))));
const RemoteLoginSuccessPage = lazy(lazyWithReload(() => import("@/pages/RemoteLoginSuccessPage").then((m) => ({ default: m.RemoteLoginSuccessPage }))));
const ServerPage = lazy(lazyWithReload(() => import("@/pages/ServerPage").then((m) => ({ default: m.ServerPage }))));
const SettingsPage = lazy(lazyWithReload(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))));
const SharePage = lazy(lazyWithReload(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage }))));
const TermsPage = lazy(lazyWithReload(() => import("@/pages/TermsPage").then((m) => ({ default: m.TermsPage }))));
const UserPage = lazy(lazyWithReload(() => import("@/pages/UserPage").then((m) => ({ default: m.UserPage }))));
const WelcomePage = lazy(lazyWithReload(() => import("@/pages/WelcomePage").then((m) => ({ default: m.WelcomePage }))));

/**
 * Dispatch `/invite/<segment>` to the right landing page. A Concord invite's
 * segment is a bech32 `naddr`; a Buzz relay invite's is a dotted HMAC token
 * (contains `.`, never bech32), so the shapes never collide.
 */
function InviteRoute() {
  const { naddr } = useParams<{ naddr: string }>();
  const isBuzz = !!naddr && !/^naddr1/i.test(naddr) && naddr.includes(".");
  return isBuzz ? <BuzzInvitePage /> : <InvitePage />;
}

/**
 * A signup "join" / referral link (`/join?relay=wss://op.example`): seed a
 * BRAND-NEW account onto an operator's relay(s). It never touches a signed-in
 * user's own relays — an existing user is simply sent home — and an unusable
 * link (no valid relay) falls through the same way. Otherwise the parsed link
 * is stashed for the signup wizard, which shows a named confirmation before
 * adopting anything.
 */
function JoinRoute() {
  const { user } = useCurrentUser();
  const { search } = useLocation();
  const join = useMemo(() => parseJoinLink(search), [search]);
  if (!user && join) setPendingJoin(join);
  return <Navigate to={!user && join ? "/welcome" : "/"} replace />;
}

/**
 * Land the user somewhere sensible.
 *
 * A logged-out user always gets the welcome/onboarding screen first — dropping
 * a signed-out user straight into a relay's channel list (which may be slow or
 * AUTH-gated) leaves them staring at a skeleton with no explanation of what
 * Armada is or how to sign in.
 *
 * Once signed in: a hosted deployment has pinned platform relays and goes
 * straight to the first one; a standalone (rogue) client ships with NO pinned
 * relay, so fall back to the user's first added server, read from their synced
 * kind-10009 list (via its folded offline snapshot) — or, if they have none
 * yet, the welcome screen (to add one).
 */
function HomeRedirect() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();

  // Cold launch from a notification tap or an incoming share: the launch
  // intent resolves async (see coldLaunchDeepLink / shareTarget). Hold the
  // default redirect until both are known — otherwise we'd send `/` to the
  // default server, ServerPage would auto-open the default group, and the late
  // navigate would lose that race. A launch intent is a deep link XOR a share
  // (ACTION_VIEW vs ACTION_SEND), so at most one of the two produces a path.
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

  // Land on the first item of the user's *arranged* community rail — NIP-29
  // servers AND Concord communities intermixed in the order they chose
  // (the same list the far-left rail renders). The persisted `railLayout`
  // lives in app config and is therefore available synchronously on the first
  // render — before the server and Concord lists rehydrate from their folded
  // caches — so the redirect commits to the right destination without racing
  // the rail's async load. `mergeLayout` appends any live NIP-29 server the
  // layout doesn't yet know about (a fresh user who never reordered).
  const liveServers = useNip29Servers();
  const firstRoute = useMemo(() => {
    const servers = new Set(liveServers);
    const ordered = flattenLayout(mergeLayout(config.railLayout, liveServers));
    for (const key of ordered) {
      // A NIP-29 server key (relay URL) is only a valid landing target if the
      // user still has it: the layout keeps keys for items that aren't live
      // yet (lists still loading), so skip those — and skip stale keys from
      // surfaces this client no longer has. Concord
      // keys are always navigable — their page handles a still-loading
      // community.
      if (!key.startsWith("c2:") && !servers.has(key)) continue;
      const route = railKeyToRoute(key);
      if (route) return route;
    }
    return null;
  }, [config.railLayout, liveServers]);

  if (!state.ready) {
    // Launch URL not yet known — committing to a default destination here
    // would lose the race against the deep link, so hold the redirect. Show
    // the branded splash rather than a blank frame (this wait can reach the
    // 1.5s bridge-guard timeout on a slow cold start) — unless we're signed
    // out, in which case this lands on /welcome, which draws the crest itself.
    return user ? <BootSplash /> : <BlankSplash />;
  }
  if (state.deepLink) {
    return <Navigate to={state.deepLink} replace />;
  }

  if (!user) {
    return <Navigate to="/welcome" replace />;
  }

  // Offline: the mesh is the only transport that still works — but only where
  // it exists (Android with BLE). Redirecting a web/desktop user to a
  // permanently-unavailable /mesh page is a dead end; they're better off on
  // the cached server view. Hold the redirect briefly while the availability
  // probe resolves so an offline Android launch still lands on mesh.
  if (!online) {
    if (mesh.probing) {
      return <BootSplash />;
    }
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
  }

  if (!firstRoute) {
    // Signed in but no community yet. The mesh is the home where it exists
    // (Android); otherwise land on DMs — a real, usable screen. We deliberately
    // do NOT force /welcome here: the create/join onboarding takeover is only
    // for account creation (the signup wizard drives it in-session). Re-forcing
    // it on every page load / relaunch for an already-signed-in, community-less
    // user was the bug — refresh or reopen the app and you'd be dumped back on
    // the getting-started screen. They can always reach create/join from the +
    // in the app.
    if (mesh.available) {
      return <Navigate to="/mesh" replace />;
    }
    return <Navigate to="/dm" replace />;
  }
  return <Navigate to={firstRoute} replace />;
}

/**
 * Gate a route behind being signed in. Public chat (servers, groups, Concord
 * communities), the invite landing, and the welcome screen render for
 * logged-out users; everything else (DMs, settings) bounces a signed-out user
 * to the landing page rather than showing them an empty, account-scoped shell.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  if (!user) {
    return <Navigate to="/welcome" replace />;
  }
  return <>{children}</>;
}

/**
 * Redirect the old `/dms` paths to `/dm`. Targets that still spell the old path
 * live OUTSIDE this build and cannot be rewritten by shipping it: a push
 * subscription registered before the rename is stored on the relay with
 * `url: "/dms"` until the client next re-registers, and an Android notification
 * already in the tray carries an `armada://open/dms/<peer>` PendingIntent that
 * survives the app update. Search and hash ride along — the notification deep
 * link appends `?message=<id>` to scroll to the message that fired it.
 */
function LegacyDmRedirect() {
  const { peer } = useParams<{ peer: string }>();
  const { search, hash } = useLocation();
  return <Navigate to={`/dm${peer ? `/${peer}` : ""}${search}${hash}`} replace />;
}

/**
 * The Suspense fallback for lazy route chunks: the branded splash, except on
 * the way to /welcome, which paints its own crest and so would otherwise show
 * a draw that gets cut off the moment the chunk lands.
 */
function RouteFallback() {
  const { pathname } = useLocation();
  return pathname === "/welcome" ? <BlankSplash /> : <BootSplash />;
}

/**
 * Warm the chat route chunks shortly after boot. Route-level code splitting
 * keeps the boot bundle small, but it also means a LATER navigation — e.g. a
 * notification tap into a room whose page chunk hasn't been visited this
 * session — pauses on the Suspense splash for a chunk fetch + parse. Prefetch
 * the pages a notification tap can target once the landing route has settled,
 * off the critical path (delayed, idle priority), so both hold: small boot
 * AND instant taps.
 */
function useWarmRouteChunks() {
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const load of [
        () => import("@/pages/GroupPage"),
        () => import("@/concord/pages/ConcordPage"),
        () => import("@/pages/DMsPage"),
        () => import("@/pages/ServerPage"),
        // Not a notification target, but the landing surface a new user hits
        // first — its first paint shouldn't stack a chunk fetch on top of the
        // directory queries.
        () => import("@/pages/DiscoverPage"),
      ]) {
        void load().catch(() => undefined);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Mounts the notification-tap → React Router navigation bridge, and its
 * warm-share sibling. Rendered inside <BrowserRouter> so `useNavigate`
 * resolves; renders nothing.
 */
function NotificationNavigation() {
  useNotificationNavigation();
  useShareTargetNavigation();
  return null;
}

/**
 * Runs the foreground (in-page) notifier: selected sounds and inactive-tab
 * markers plus OS notifications for incoming messages/mentions/DMs. Must be
 * inside the router (it navigates on notification click). Inert on native.
 */
function ForegroundNotifications() {
  useForegroundNotifications();
  return null;
}

export function AppRouter() {
  useWarmRouteChunks();
  // Data too, not just code: pre-resolve the Discover directory at idle so the
  // page's first open paints real cards instead of a skeleton waterfall.
  useWarmDiscover();
  // No `future` prop on the router: `v7_startTransition` and
  // `v7_relativeSplatPath` were opt-ins under v6 and are the only behavior v7
  // has.
  return (
      <BrowserRouter>
        <NotificationNavigation />
        <ForegroundNotifications />
        <VersionCheck />
        {/* MUST render inside <BrowserRouter>: toasts can carry router <Link>
            actions (e.g. VersionCheck's "What's new" → /changelog). With the
            Toaster outside the router, rendering such a toast throws useHref()
            and unmounts the whole tree to the error screen — which is exactly
            once per release, since VersionCheck stamps the version before
            toasting. */}
        <Toaster />
        {/* Lazy route chunks paint the branded splash while they load, never a
            blank frame. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/join" element={<JoinRoute />} />
            <Route path="/s/:server" element={<ServerPage />} />
            {/* Static segments outrank the `:groupId` param, so the Projects
                and Inbox views resolve here, not as a channel. */}
            <Route path="/s/:server/projects" element={<ProjectsPage />} />
            <Route path="/s/:server/inbox" element={<RequireAuth><InboxPage /></RequireAuth>} />
            {/* A room, optionally with a thread open and/or a message focused
                (see `lib/routes.ts`). `/t/` and `/m/` are markers rather than
                bare positions so that a thread root's two identities — the
                message in the timeline and the thread it opens — stay
                distinguishable. Each surface renders the same page for all
                four shapes; the page reads the params. */}
            <Route path="/s/:server/:groupId" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/m/:messageId" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/t/:threadRoot" element={<GroupPage />} />
            <Route path="/s/:server/:groupId/t/:threadRoot/m/:messageId" element={<GroupPage />} />
            <Route path="/c/:communityId" element={<ConcordPage />} />
            <Route path="/c/:communityId/history" element={<RequireAuth><HistoryAuditPage /></RequireAuth>} />
            {/* Community-wide panes. Static segments outrank `:channelId`, and
                Concord channel ids are hex, so these can never be shadowed by
                a real channel. Kept in one place: `CONCORD2_PANES`. */}
            {CONCORD2_PANES.map((pane) => (
              <Route key={pane} path={`/c/:communityId/${pane}`} element={<ConcordPage />} />
            ))}
            <Route path="/c/:communityId/:channelId" element={<ConcordPage />} />
            <Route path="/c/:communityId/:channelId/m/:messageId" element={<ConcordPage />} />
            <Route path="/c/:communityId/:channelId/t/:threadRoot" element={<ConcordPage />} />
            <Route path="/c/:communityId/:channelId/t/:threadRoot/m/:messageId" element={<ConcordPage />} />
            {/* Concord invite links carry an naddr path segment at
                /invite/<naddr>#… (CORD-05). A Buzz relay invite shares the
                same `/invite/<code>` path (its code is a dotted HMAC token,
                never an naddr), dispatched by InviteRoute. */}
            <Route path="/invite/:naddr" element={<InviteRoute />} />
            <Route path="/changelog" element={<ChangelogPage />} />
            {/* Also a real directory on the hosted deployment, where CI rsyncs
                the installers — nginx serves the SPA shell as its index so a
                reload or a shared link reaches this route rather than the 403
                a directory with no index would otherwise produce. */}
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/share" element={<SharePage />} />
            {/* Callback target baked into nostrconnect:// URIs — remote
                signers redirect here after the user approves pairing. */}
            <Route path="/remoteloginsuccess" element={<RemoteLoginSuccessPage />} />
            {/* Public browse/search directory — no auth (joining/adding prompts
                sign-in at the point of action, like the invite landing). */}
            <Route path="/discover" element={<DiscoverPage />} />
            {/* Full-screen wizard. A route, not a dialog: it has to outlive the
                Add dialog its entry point sits in (see DiscordImportPage). */}
            <Route path="/import/discord" element={<RequireAuth><DiscordImportPage /></RequireAuth>} />
            <Route path="/mesh" element={<RequireAuth><MeshPage /></RequireAuth>} />
            {/* The received direct-invite inbox (account-level, CORD-05 §6).
                Distinct from a community's own `/c/:id/invites` link-admin pane. */}
            <Route path="/invites" element={<RequireAuth><InvitesPage /></RequireAuth>} />
            <Route path="/dm" element={<RequireAuth><DMsPage /></RequireAuth>} />
            <Route path="/dm/:peer" element={<RequireAuth><DMsPage /></RequireAuth>} />
            {/* DMs have no thread panel, so no `/t/` shape here. */}
            <Route path="/dm/:peer/m/:messageId" element={<RequireAuth><DMsPage /></RequireAuth>} />
            {/* Pre-rename links (stale push subscriptions, tray notifications,
                bookmarks). Declared before `/:user`, which would otherwise
                swallow a bare `/dms` and render its own 404. */}
            <Route path="/dms" element={<LegacyDmRedirect />} />
            <Route path="/dms/:peer" element={<LegacyDmRedirect />} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
            {/* A person's public chat link: `/<npub>`, `/<name@domain>` or
                `/<domain>`. Declared last for readability only — React Router
                ranks every static segment above a dynamic one regardless of
                order — but it DOES outrank the `*` route below, so UserPage
                renders the 404 itself for a segment that names nobody. */}
            <Route path="/:user" element={<UserPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRouter;
