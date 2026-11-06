// Armada desktop (Electron) main process.
//
// Armada desktop is a SOVEREIGN, standalone client. It bundles the web build
// (dist/, copied in by CI) and serves it over a custom **secure** scheme
// (app://armada/…) rather than a hosted URL. This means:
//
//   • The app is not tied to any one deployment/domain. The web build is
//     compiled with EMPTY platform relays, so nothing is baked in — the user
//     adds whatever servers they want.
//   • A custom *secure* scheme is still a secure context, so the service worker
//     and Web Push (PushManager) work.
//
// It also adds desktop-native behavior the web build can't: a system tray
// (close-to-tray, Show/Quit, unread badge, launch-minimized) and screen-share
// source selection (Electron has no built-in getDisplayMedia picker).

// ── Session bus repair (Linux) ──────────────────────────────────────────────
//
// Must run before anything touches Chromium. Some launchers hand us an
// environment with DBUS_SESSION_BUS_ADDRESS stripped (version-manager shims
// like asdf's `node`, which is what `npm start` goes through) — Chromium then
// marks it "disabled:" and every D-Bus consumer silently degrades. The one
// that matters is `safeStorage`: without the bus it can't reach the OS
// credential store, `isEncryptionAvailable()` is false, and the login store
// (which holds the nsec) falls back to being written in plaintext.
//
// So restore the well-known per-user socket when, and only when, the variable
// is missing AND that socket actually exists.
if (process.platform === "linux") {
  const current = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!current || current === "disabled:") {
    const socket = `/run/user/${process.getuid()}/bus`;
    if (require("node:fs").existsSync(socket)) {
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socket}`;
    }
  }
}

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  protocol,
  nativeImage,
  nativeTheme,
  ipcMain,
  MessageChannelMain,
  desktopCapturer,
  session,
  systemPreferences,
  safeStorage,
  dialog,
  powerMonitor,
  utilityProcess,
  Notification,
} = require("electron");
// electron-updater and its dependency tree are ~650 KB of source kept resident
// once required; only the self-updating packages ever use it, and only once
// installElectronUpdater runs, so it is required then.
let autoUpdaterInstance = null;
function updater() {
  autoUpdaterInstance ??= require("electron-updater").autoUpdater;
  return autoUpdaterInstance;
}
const {
  isArmadaAppUrl,
  isExternallyOpenableUrl,
  isSignerHandoffUrl,
  isMagnetUrl,
  isNsiteUrl,
  internalAppLinkPath,
} = require("./appOrigin");
const {
  configureAutoUpdater,
  hasDeveloperIdUpdateSignature,
  supportsSelfUpdate,
} = require("./updateSupport");
const { integrateAppImage } = require("./desktopIntegration");
const { listLinuxAudioApplications } = require("./linuxAudioSources");
const {
  detectLinuxTrayEnvironment,
  queryStatusNotifierItems,
} = require("./traySupport");
const { PushToTalkController } = require("./pushToTalk");
const createLinuxStatusNotifier =
  process.platform === "linux"
    ? require("./linuxStatusNotifier").createLinuxStatusNotifier
    : null;
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const {
  loadCurrent,
  loadSite,
  pruneBlobs,
  readBlob,
  readShippedDesktopManifest,
  resolveSitePath,
  stageSite,
} = require("./webSite");
const { spawnSync } = require("node:child_process");
const {
  DEFAULT_LINUX_VIDEO_ENCODER_MODE,
  configureLinuxVideoEncoding,
  readLinuxVideoEncoderMode,
  writeLinuxVideoEncoderMode,
} = require("./linuxVideoAcceleration");
const {
  getLaunchSettings,
  setLaunchSettings,
} = require("./autoLaunch");
const {
  createHevcScreenShareController,
  detectCachedHevcCapability,
} = require("./hevcScreenShare");
const { displayMediaGrant, displayMediaHandlerOptions } = require("./displayMediaPolicy");
const { installYouTubeEmbedIdentity } = require("./youtubeEmbedIdentity");
const { allowPermissionCheck, allowPermissionRequest } = require("./permissionPolicy");
const { configureLowMemory, readLowMemoryMode, writeLowMemoryMode } = require("./lowMemory");
const { fetchImage } = require("./imageFetch");

// Encoder selection is process-wide in Chromium and must be installed before
// app readiness (and therefore before the GPU process starts). Software is the
// Linux default because it is the reliable H.264 + E2EE path; hardware remains
// an explicit device-local preference for VP8/VP9 workloads.
const activeLinuxVideoEncoderMode =
  readLinuxVideoEncoderMode({ userDataPath: app.getPath("userData") }) ??
  DEFAULT_LINUX_VIDEO_ENCODER_MODE;
configureLinuxVideoEncoding({
  commandLine: app.commandLine,
  mode: activeLinuxVideoEncoderMode,
});

// Process-wide V8 flags, so also before readiness (see lowMemory.js).
const activeLowMemoryMode = readLowMemoryMode({ userDataPath: app.getPath("userData") });
configureLowMemory({ commandLine: app.commandLine, on: activeLowMemoryMode });

// Keep Linux's desktop-file identity stable in both the AppImage and Flatpak.
// Electron must receive this before ready so notifications and tray hosts can
// associate the process with buzz.armada.app.desktop. It is also the window's
// WM_CLASS, i.e. the entry a dock looks for when it wants a name and an icon
// for this process — desktopIntegration.js installs that entry for the
// AppImage, which is otherwise the one packaging that has none.
if (process.platform === "linux") {
  app.setDesktopName("buzz.armada.app.desktop");
}

// Windows' analog of the desktop-file identity: the AppUserModelID. A renderer
// `new Notification()` becomes an Action Center toast only when the process's
// AUMID matches an installed Start Menu shortcut's — otherwise Windows drops
// the toast (or shows it under "electron.app.Electron" with the wrong icon).
// The NSIS installer stamps the shortcut's AUMID with electron-builder.yml's
// appId, so this must be that same string, and — like setDesktopName — must be
// set before `ready` so the first toast is already associated.
if (process.platform === "win32") {
  app.setAppUserModelId("buzz.armada.app");
}

// The web bundle that shipped inside the asar. This is the floor: a fresh
// install serves it, and so does any launch where the stored site (webSite.js)
// does not check out. With `activeSite` set, app:// serves that site instead.
const SHIPPED_DIST = path.join(__dirname, "dist");
const WEB_DIR = path.join(app.getPath("userData"), "web");
// Where Flatpak shells up to v0.67.6 unpacked the web archive; nothing reads it.
const LEGACY_BUNDLES_DIR = path.join(app.getPath("userData"), "bundles");
// The shell API level (desktopApi.json) and the build time of the bundle it
// shipped with, below which no site manifest is served.
const SHELL_API = require("./desktopApi.json").level;
const SHELL_BUILT_AT = readShippedDesktopManifest(SHIPPED_DIST)?.builtAt ?? 0;
let activeSite = null;

// How long the renderer has to report that it painted before the shell treats
// the active site as suspect. Generous: a cold start on a slow disk with a
// large store is not a failure.
const BUNDLE_BOOT_GRACE_MS = 45_000;
let bundleBooted = false;

/**
 * Notice a site that never comes up.
 *
 * Recovery is forward-only — the shell does not revert to an older site —
 * so the only thing this can usefully do is stop waiting for the next
 * scheduled poll and look for a newer one right now. That shortens a bad
 * deploy from "until the next check" to "until the fix is published".
 *
 * The check runs in the MAIN process, so a renderer that white-screens cannot
 * take the update path down with it.
 */
function watchBundleBoot() {
  if (bundleBooted) return;
  setTimeout(() => {
    if (bundleBooted) return;
    console.warn(
      `[web] renderer did not report ready within ${BUNDLE_BOOT_GRACE_MS}ms`,
      activeSite ? `(site ${activeSite.id})` : "(shipped bundle)",
    );
    if (webUpdatesSupported()) void checkForDesktopUpdates(false);
  }, BUNDLE_BOOT_GRACE_MS).unref();
}

function installBundleIpc() {
  // Sent by the renderer after React has painted a real frame. Only a message
  // from the window we loaded counts; a subframe cannot vouch for the app.
  ipcMain.on("armada:web-ready", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    bundleBooted = true;
  });

  // The renderer asks on mount too, since the check can finish before it
  // subscribes to armada:web-update-ready.
  // A downloaded installer (electron-updater) is offered through the same toast.
  ipcMain.handle("armada:web-update-pending", () => pendingWebSite !== null || installerDownloaded);
  ipcMain.on("armada:web-update-restart", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (installerDownloaded) {
      isQuitting = true;
      updater().quitAndInstall(false, true);
      return;
    }
    if (pendingWebSite === null) return;
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  });

  // The renderer reports its App Links host (PUBLIC_WEB_ORIGIN's hostname)
  // at boot, so the navigation handlers can recognize a link to our own public
  // host and route it inward instead of out to the browser. Only the main
  // window may set it — a subframe (a WebXDC sandbox, a link embed) must not
  // teach the shell to swallow navigations to a host it names.
  ipcMain.on("armada:register-deep-link-host", (event, host) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    deepLinkHost = typeof host === "string" && host ? host.toLowerCase() : null;
  });
}

/**
 * Choose what app:// serves. Called once, before the window loads, because
 * the handler resolves every request against it; a window keeps the site it
 * booted with until the next launch, so it never mixes two deploys' chunks.
 */
function selectActiveSite() {
  fs.rmSync(LEGACY_BUNDLES_DIR, { recursive: true, force: true });
  if (!webUpdatesSupported()) {
    console.log("[web] serving shipped");
    return;
  }
  try {
    const { parseWebSite } = require("./updateFeed.cjs");
    activeSite = loadSite({ dir: WEB_DIR, parse: parseWebSite, shellApi: SHELL_API, floor: SHELL_BUILT_AT });
    // A stored site that did not load (blobs missing) keeps its blobs for the
    // update check to complete; anything else is unreferenced.
    pruneBlobs(WEB_DIR, [activeSite, loadCurrent(WEB_DIR, parseWebSite)]);
  } catch (error) {
    console.warn("[web] could not load the stored site", error);
    activeSite = null;
  }
  console.log(activeSite ? `[web] serving site ${activeSite.id}` : "[web] serving shipped");
}

let siteRepairRequested = false;

function serveSiteFile(pathname) {
  const sitePath = resolveSitePath(activeSite, pathname);
  const bytes = readBlob(WEB_DIR, activeSite.files.get(sitePath));
  if (bytes) {
    return new Response(bytes, { status: 200, headers: { "Content-Type": contentTypeFor(sitePath) } });
  }
  // Deleted or altered since launch. Never substitute another deploy's copy;
  // the update check downloads it again for the next launch.
  console.warn(`[web] ${sitePath} is missing or does not match the manifest`);
  if (!siteRepairRequested) {
    siteRepairRequested = true;
    void checkForDesktopUpdates(false);
  }
  return new Response("Unavailable", { status: 503 });
}

// Custom app scheme. Host segment "armada" keeps a stable origin
// (app://armada) for the service worker + secure-context checks.
const SCHEME = "app";
const ORIGIN = `${SCHEME}://armada`;
// Load the ROOT path, not /index.html: the SPA router has a catch-all
// `/:user` profile route, so a pathname of "/index.html" boots the app into a
// Nostr lookup for "index.html" ("No such person") instead of the app. The
// protocol handler below maps "/" to index.html.
const APP_START_URL = `${ORIGIN}/`;

// Dev mode (`npm run electron:dev` → scripts/dev-electron.sh): load the Vite
// dev server instead of the bundled dist/, so the renderer gets HMR and React
// fast refresh while the shell around it — tray, screen picker, safeStorage,
// the SQLite store — is the same code the packaged app runs. http://localhost
// is a secure context too, so the service worker and PushManager behave as
// they do on app://.
//
// The cost is a SECOND ORIGIN: everything the renderer keys to its origin
// (localStorage, and so the login store) is separate from a packaged install's,
// which is why the dev script also points --user-data-dir at its own profile
// rather than letting a work-in-progress build write the real armada.db.
// Anything origin-gated below has to accept this origin; with the variable
// unset there is no second origin and nothing changes.
const DEV_URL = (() => {
  const raw = process.env.ARMADA_DEV_URL;
  if (!raw) return "";
  try {
    return new URL(raw).href;
  } catch {
    console.error("[dev] ignoring unparseable ARMADA_DEV_URL:", raw);
    return "";
  }
})();
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : "";
const SPELL_DICTIONARY_URL = "https://armada.buzz/dictionaries/";
const START_URL = DEV_URL || APP_START_URL;

/**
 * Hand a URL to the OS default handler, but only for schemes meant for a
 * browser or mail client. The renderer embeds untrusted third-party frames and
 * window.open from any of them lands here, so the scheme is not trustworthy.
 */
async function openExternalUrl(url) {
  if (!isExternallyOpenableUrl(url)) {
    console.warn("[shell] refused to open external URL", url);
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    console.warn("[shell] could not open external URL", error);
    return false;
  }
}

// The renderer's App Links host (PUBLIC_WEB_ORIGIN's hostname), registered
// over IPC once the web bundle boots; the build has no baked-in origin, so
// until then a link to our own host is treated as external. Once known, such
// links are routed inward (there is no OS-level https handoff into a desktop
// app short of being the default browser). It routes navigations and nothing
// else; the web-bundle updater resolves its source from the signed manifest.
let deepLinkHost = null;

/**
 * Ask the renderer to route an in-app path through its own router.
 *
 * Only ever called for a link the renderer itself just produced and clicked, so
 * the window is up; there is no cold-start buffering to do. A soft navigation
 * there reuses the warm store, query cache and live subscriptions rather than
 * reloading the document.
 */
function dispatchInternalDeepLink(path) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("armada:deep-link", path);
}

// Dark background matching the app theme (index.html theme-color #100b15).
const BACKGROUND = "#100b15";
// The window icon. On Linux this is also the art a dock or panel draws for a
// window it cannot match to an installed .desktop entry (the AppImage case —
// see desktopIntegration.js), so it has to be the LAUNCHER tile — the crest on
// the cut-corner vessel shape the UI gives server icons — rather than the
// full-bleed square. macOS and Windows draw the icon from the packaged bundle
// instead, where electron-builder derives .icns/.ico from build/icon.png.
const ICON = path.join(__dirname, "build", process.platform === "linux" ? "linux-icon.png" : "icon.png");
// Tray art (electron/icon-src/tray.svg): the simplified Armada A, the same
// shape as the Android notification small icon. A tray slot is ~16-22px, so
// the full crest in ICON is unreadable there.
const TRAY_DIR = path.join(__dirname, "build");

/**
 * The launcher tile at `size`×`size` as PNG bytes, for the hicolor icon theme.
 * Scaling once here beats shipping one 512 for every slot from a 16px panel up.
 */
function renderLinuxIcon(size) {
  const image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) return null;
  const resized = image.getSize().width === size
    ? image
    : image.resize({ width: size, height: size, quality: "best" });
  return resized.toPNG();
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
let lastWindowBlurAt = 0;

/**
 * IPC for the bridge, answered for the main window only. Only it has the
 * preload today; the guard keeps that true of the bridge's behaviour, not just
 * of which renderer happens to load it.
 */
function handleFromMainWindow(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error(`${channel} is available only to Armada's main window.`);
    }
    return listener(event, ...args);
  });
}

function onFromMainWindow(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    listener(event, ...args);
  });
}
/** @type {Tray | null} */
let tray = null;
let registeredTrayItem = null;
// Closing may hide the window only while a usable tray host exists. Linux
// desktops can accept a Tray object without displaying it (notably stock
// GNOME), so this is established through the session bus before it is trusted.
let closeToTraySupported = process.platform !== "linux";
let traySupportCheck = null;
let linuxCloseCheckInFlight = false;
let hiddenTrayMonitor = null;
// True once the user has actually chosen to quit (vs. closing to tray).
let isQuitting = false;
// True while a user-requested update check is in flight. Background checks
// stay quiet when the installed build is already current or the feed is down.
let manualUpdateCheck = false;
let updateCheckInFlight = false;
let macSelfUpdateEligible;
let updateCheckTimer = null;
// Id of a site staged this run and awaiting a restart to activate.
let pendingWebSite = null;
// A site needing a newer shell has been announced this run.
let shellUpdateAnnounced = false;
// electron-updater has an installer staged; it also installs on quit.
let installerDownloaded = false;
const pushToTalk = new PushToTalkController({
  platform: process.platform,
  env: process.env,
  portalFactory: () => {
    const { LinuxGlobalShortcutsPortal } = require("./linuxGlobalShortcuts");
    const shortcutIdFile = path.join(app.getPath("userData"), "push-to-talk-portal-action");
    return new LinuxGlobalShortcutsPortal({
      loadShortcutId: () => fs.readFileSync(shortcutIdFile, "utf8").trim(),
      saveShortcutId: (shortcutId) => fs.writeFileSync(shortcutIdFile, shortcutId, { mode: 0o600 }),
    });
  },
  // Prompt only when the user explicitly enables/configures push to talk.
  // macOS global input hooks require this OS-level Accessibility grant.
  isMacTrusted: () =>
    process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(true),
  sendState: (pressed) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("armada:push-to-talk-state", Boolean(pressed));
  },
  sendStatus: (status) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("armada:push-to-talk-status", status);
  },
});
// Honour --hidden / --minimized (autostart "launch minimized to tray").
const startHidden =
  process.argv.includes("--hidden") || process.argv.includes("--minimized");

// Register the custom scheme as privileged BEFORE app is ready. standard +
// secure makes it a secure context that can host a service worker; the rest
// give it normal fetch/stream/CSP behavior.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      // Keep V8's compiled bytecode for app:// scripts between loads, as
      // Chromium does for http(s); without it every launch compiles the bundle.
      codeCache: true,
    },
  },
]);

// ── Serving the bundled SPA over app:// ──────────────────────────────────────

// Minimal extension → MIME map for the assets the SPA actually ships. The
// browser is strict about a few of these (a module script served as text/plain
// is rejected; .css with the wrong type is ignored), so we set them explicitly.
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// Read a bundled file and return an HTTP Response. We read through Node's `fs`
// (NOT net.fetch of a file:// URL) because the web build is packaged inside
// `app.asar`: `fs` is asar-aware, while Chromium's file:// network stack is
// not — handing it `…/app.asar/dist/index.html` 404s (notably on Windows).
function serveFile(filePath) {
  try {
    const body = fs.readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": contentTypeFor(filePath) },
    });
  } catch {
    return null;
  }
}

function registerAppProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    // One origin: the preload bridge and permissions are granted to app://armada only.
    if (url.host !== "armada") return new Response("Not Found", { status: 404 });
    // Strip query/hash; resolve within the active site or the shipped bundle.
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (activeSite) return serveSiteFile(pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const dist = SHIPPED_DIST;
    const indexHtml = path.join(dist, "index.html");
    let filePath = path.normalize(path.join(dist, pathname));
    // Reject path traversal. Compare with a trailing separator so a sibling
    // like `<dist>-evil` can't pass the prefix check.
    if (filePath !== dist && !filePath.startsWith(dist + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }

    // SPA fallback: a request without a file extension (a client route like
    // /s/<server>/<group>) serves index.html so the router can handle it.
    if (!path.extname(filePath)) {
      filePath = indexHtml;
    }

    // Serve the file; if it's missing (e.g. a route that *looked* like a file
    // because a relay param contains a dot), fall back to index.html so the
    // SPA router can resolve it instead of 404ing.
    return serveFile(filePath) ?? serveFile(indexHtml) ??
      new Response("Not Found", { status: 404 });
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow({ show = !startHidden || !closeToTraySupported } = {}) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 480,
    minHeight: 600,
    show,
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    title: "Armada",
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep the renderer (and its live relay subscriptions / notification
      // wire) pumping while the window is hidden to tray. Without this,
      // Chromium throttles background timers and idles sockets, so
      // notifications stall for minutes until the window is refocused.
      backgroundThrottling: false,
    },
  });

  // Close → hide only when the tray is known to be visible. On Linux we
  // re-check at the moment of closing because a shell extension or tray host
  // can disappear during the session; without one, normal close quits and
  // tears down calls instead of leaving an invisible process behind.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();

    if (process.platform !== "linux") {
      if (closeToTraySupported && tray) {
        hideWindowToTray();
      } else {
        isQuitting = true;
        app.quit();
      }
      return;
    }
    if (linuxCloseCheckInFlight) return;
    linuxCloseCheckInFlight = true;
    void refreshTraySupport()
      .then((supported) => {
        if (supported) {
          hideWindowToTray();
        } else {
          isQuitting = true;
          app.quit();
        }
      })
      .finally(() => {
        linuxCloseCheckInFlight = false;
      });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // Tell the page whether anyone can see it (armada:window-visibility). With
  // background throttling off it can't tell from the Page Visibility API, and
  // it rests while unseen: no catch-up or history paging, no animation frames.
  // Sent on every load too, so a launch straight to the tray starts resting.
  const sendVisibility = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("armada:window-visibility", mainWindow.isVisible() && !mainWindow.isMinimized());
  };
  for (const event of ["show", "hide", "minimize", "restore"]) mainWindow.on(event, sendVisibility);
  mainWindow.webContents.on("did-finish-load", sendVisibility);

  // A flash requested for a notification ends the moment the user is looking
  // (Windows keeps the taskbar entry highlighted until told otherwise).
  mainWindow.on("focus", () => {
    mainWindow?.flashFrame(false);
  });
  mainWindow.on("blur", () => {
    lastWindowBlurAt = Date.now();
  });

  // Esc always leaves HTML fullscreen. An embed that went fullscreen (a Mini
  // App is sender-written code) has keyboard focus, and a key the page
  // consumes may never reach Electron's own Esc handling, so take it before
  // the page sees it. The renderer shows the matching hint (fullscreenHint.ts).
  let htmlFullscreen = false;
  mainWindow.on("enter-html-full-screen", () => {
    htmlFullscreen = true;
  });
  mainWindow.on("leave-html-full-screen", () => {
    htmlFullscreen = false;
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!htmlFullscreen || input.type !== "keyDown" || input.key !== "Escape") return;
    event.preventDefault();
    mainWindow.webContents
      .executeJavaScript("document.exitFullscreen().catch(() => {})")
      .catch(() => {});
  });

  // A renderer that dies (an OOM, a GPU/driver crash) leaves the window
  // painting nothing but its background colour, and with the app menu removed
  // there is no reload accelerator to get out of it — so reload here. A crash
  // that recurs within a minute of the last reload is not retried, which keeps
  // a page that dies on boot from spinning in a crash loop.
  let lastRendererReload = 0;
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[shell] renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (isQuitting || details.reason === "clean-exit") return;
    const now = Date.now();
    if (now - lastRendererReload < 60_000) return;
    lastRendererReload = now;
    mainWindow?.webContents.reload();
  });

  // The app menu is removed (Menu.setApplicationMenu(null)), and the default
  // DevTools accelerators come from that menu — so in dev mode bind them
  // directly, or there is no way into the inspector at all.
  if (DEV_URL) {
    mainWindow.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      const toggle = input.key === "F12" ||
        ((input.control || input.meta) && input.shift && input.key === "I");
      if (toggle) mainWindow.webContents.toggleDevTools();
    });
  }

  mainWindow.loadURL(START_URL);
}

function showWindow() {
  stopHiddenTrayMonitor();
  if (!mainWindow) {
    createWindow({ show: true });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── System tray ──────────────────────────────────────────────────────────────

// Only macOS masks a tray icon for us: a template image is re-tinted by the
// system for light/dark and for the highlighted (clicked) state. Elsewhere the
// panel gets a bitmap and draws it as authored — Electron's Tray takes a
// NativeImage, not an icon-theme NAME, so there is no symbolic recoloring to
// opt into — and we pick the variant ourselves.
function trayImage() {
  let file;
  if (process.platform === "darwin") {
    file = "trayTemplate.png";
  } else if (process.platform === "win32") {
    // The taskbar tracks the system theme, which is what nativeTheme reports.
    file = nativeTheme.shouldUseDarkColors ? "tray-white.ico" : "tray-dark.ico";
  } else {
    // Linux: white, like every other monochrome panel icon. NOT keyed to
    // nativeTheme — that is the app's GTK/color-scheme preference, and a panel
    // is styled independently of it (GNOME's top bar stays dark under a light
    // theme), so following it would paint a dark glyph onto a dark panel.
    file = "tray-white.png";
  }
  // createFromPath picks up the @2x companion for HiDPI panels on its own.
  const image = nativeImage.createFromPath(path.join(TRAY_DIR, file));
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function trayMenuEntries() {
  return [
    { id: 1, label: "Show Armada", activate: showWindow },
    autoUpdatesSupported() || webUpdatesSupported()
      ? {
          id: 2,
          label: "Check for Updates…",
          activate: () => void checkForDesktopUpdates(true),
        }
      : {
          id: 2,
          label:
            process.platform === "linux" && app.isPackaged
              ? "Updates are managed by your package manager"
              : "Automatic updates unavailable",
          enabled: false,
        },
    { id: 3, type: "separator" },
    {
      id: 4,
      label: "Quit",
      activate: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate(
    trayMenuEntries().map(({ activate, ...entry }) => ({
      ...entry,
      id: String(entry.id),
      click: activate,
    })),
  );
}

// Clicking the Windows tray takes focus from the window before the click
// arrives, so a blur this recent still counts as the window having had focus.
const TRAY_BLUR_GRACE_MS = 400;

function toggleWindowFromTray() {
  // Every accessor on a destroyed BrowserWindow throws, and the tray outlives
  // the window on close-to-quit paths.
  // A window that is open but buried under others is brought forward, not hidden.
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized() &&
    (mainWindow.isFocused() || Date.now() - lastWindowBlurAt < TRAY_BLUR_GRACE_MS)
  ) {
    hideWindowToTray();
  } else {
    showWindow();
  }
}

/**
 * Run a tray callback without letting it escape.
 *
 * linuxStatusNotifier dispatches these from queueMicrotask, so a throw is an
 * uncaught main-process exception rather than a rejected promise — and
 * Menu.popup() does throw when it cannot resolve a window, which is exactly
 * the closed-to-tray case these callbacks exist to serve.
 */
function guardTrayCallback(run) {
  return (...args) => {
    try {
      run(...args);
    } catch (error) {
      console.warn("[tray] callback failed", error);
    }
  };
}

async function createTray({ statusNotifier = false } = {}) {
  if (tray && !tray.isDestroyed()) return true;
  let image = trayImage();
  if (image.isEmpty()) {
    console.warn("[tray] packaged tray icon is missing");
    return false;
  }

  if (statusNotifier && createLinuxStatusNotifier) {
    try {
      tray = await createLinuxStatusNotifier({
        image,
        tooltip: "Armada",
        getMenuEntries: trayMenuEntries,
        onActivate: guardTrayCallback(toggleWindowFromTray),
        onContextMenu: guardTrayCallback((x, y) => {
          const options = {};
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            options.window = mainWindow;
          }
          if (Number.isInteger(x)) options.x = x;
          if (Number.isInteger(y)) options.y = y;
          buildTrayContextMenu().popup(options);
        }),
      });
      return true;
    } catch (error) {
      tray = null;
      console.warn("[tray] failed to create StatusNotifierItem", error);
      return false;
    }
  }

  if (!image.isEmpty()) {
    image = image.resize({ width: 22, height: 22 });
  }
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  } catch (error) {
    tray = null;
    console.warn("[tray] failed to create system tray icon", error);
    return false;
  }
  if (process.platform === "win32") {
    nativeTheme.on("updated", () => {
      if (!tray || tray.isDestroyed()) return;
      tray.setImage(trayImage().resize({ width: 22, height: 22 }));
    });
  }
  tray.setToolTip("Armada");
  tray.setContextMenu(buildTrayContextMenu());
  tray.on("click", toggleWindowFromTray);
  return true;
}

function destroyTray() {
  tray?.destroy();
  tray = null;
  registeredTrayItem = null;
}

async function refreshTraySupport() {
  if (process.platform !== "linux") return closeToTraySupported;
  if (traySupportCheck) return traySupportCheck;

  traySupportCheck = detectLinuxTrayEnvironment()
    .then(async ({ supported, watcherOwned, registeredItems }) => {
      if (!supported) {
        closeToTraySupported = false;
        destroyTray();
        return false;
      }

      if (tray && !tray.isDestroyed()) {
        if (!watcherOwned || registeredItems?.includes(registeredTrayItem)) {
          closeToTraySupported = true;
          return true;
        }
        destroyTray();
      }

      const itemsBeforeCreation = new Set(registeredItems || []);
      closeToTraySupported = await createTray({ statusNotifier: watcherOwned });
      // Verify the watcher actually accepted Armada's item, not merely that a
      // host exists. This catches sandbox filters and shell incompatibilities
      // before close-to-tray can strand an invisible process. X11's legacy
      // GtkStatusIcon fallback has no watcher entry and skips this check.
      if (closeToTraySupported && watcherOwned) {
        for (let attempt = 0; attempt < 5 && !registeredTrayItem; attempt += 1) {
          const currentItems = await queryStatusNotifierItems();
          registeredTrayItem = currentItems?.find((item) => !itemsBeforeCreation.has(item)) || null;
          if (!registeredTrayItem && attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!registeredTrayItem) {
          console.warn("[tray] StatusNotifier host did not register Armada's tray item");
          closeToTraySupported = false;
          destroyTray();
        }
      }
      return closeToTraySupported;
    })
    .catch((error) => {
      console.warn("[tray] failed to detect a Linux tray host", error);
      closeToTraySupported = false;
      destroyTray();
      return false;
    })
    .finally(() => {
      traySupportCheck = null;
    });
  return traySupportCheck;
}

function stopHiddenTrayMonitor() {
  if (!hiddenTrayMonitor) return;
  clearInterval(hiddenTrayMonitor);
  hiddenTrayMonitor = null;
}

function startHiddenTrayMonitor() {
  if (process.platform !== "linux" || hiddenTrayMonitor) return;
  hiddenTrayMonitor = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) {
      stopHiddenTrayMonitor();
      return;
    }
    void refreshTraySupport().then((supported) => {
      if (!supported && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        showWindow();
      }
    });
  }, 15_000);
  hiddenTrayMonitor.unref?.();
}

function hideWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed() || !closeToTraySupported || !tray) return;
  mainWindow.hide();
  // backgroundThrottling: false keeps the page's visibilityState "visible"
  // while hidden, so the renderer cannot see the close itself. Tell it, so
  // playing media and embeds stop instead of carrying on from the tray.
  mainWindow.webContents.send("armada:window-hidden");
  startHiddenTrayMonitor();
}

// ── Application updates ────────────────────────────────────────────────────
//
// Two tracks. The WEB track (every build but the store editions) loads the web
// app from Armada's signed nsite manifest, so the releases that only touch
// src/ — nearly all of them — reach every desktop, including the ones that
// cannot replace themselves (deb, Flatpak, cross-built macOS). See webSite.js.
//
// The SHELL track is electron-updater, for the installed NSIS build on
// Windows, signed macOS builds and the AppImage. A portable .exe has nowhere
// stable to install an update, a deb stays owned by apt and a Flatpak by
// `flatpak update`, so those never contact the release feed.
//
// The feed is the NIP-82 release and its assets — the same ones /downloads
// reads — resolved by ./nostrUpdateProvider.js. The `publish` block in
// electron-builder.yml is not a feed: it is the only thing that makes
// electron-builder package an app-update.yml, which electron-updater reads on
// every DOWNLOAD for its cache directory name. Its url is never fetched —
// setFeedURL below replaces the provider outright. See electron/README.md.

function autoUpdatesSupported() {
  if (!app.isPackaged) return false;
  if (process.platform === "darwin" && macSelfUpdateEligible === undefined) {
    const disabledMarker = fs.existsSync(
      path.join(process.resourcesPath, "armada-no-self-update"),
    );
    if (disabledMarker) {
      macSelfUpdateEligible = false;
    } else {
      const result = spawnSync(
        "/usr/bin/codesign",
        ["-dv", "--verbose=4", process.execPath],
        { encoding: "utf8" },
      );
      macSelfUpdateEligible =
        result.status === 0 &&
        hasDeveloperIdUpdateSignature(`${result.stdout || ""}\n${result.stderr || ""}`);
    }
  }
  return supportsSelfUpdate({
    isPackaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    isMas: process.mas,
    isWindowsStore: process.windowsStore,
    // The Linux-cross-built macOS archives are ad-hoc signed and cannot safely
    // replace themselves. A real Developer ID build made on macOS has no marker
    // and uses electron-builder's signed zip feed normally.
    macUpdateDisabled: process.platform === "darwin" && !macSelfUpdateEligible,
  });
}

// Store editions take their code from the store's review, not from a relay.
// ARMADA_DEV_WEB_UPDATE=1 under `npm run electron:dev` runs the staging half
// against the dev profile's userData (the window still loads the dev server).
function webUpdatesSupported() {
  if (!app.isPackaged) return Boolean(DEV_URL) && process.env.ARMADA_DEV_WEB_UPDATE === "1";
  return !process.mas && !process.windowsStore;
}

async function showUpdateMessage(options) {
  // Only parent to a VISIBLE window. Update checks run on a timer, so this can
  // fire while the app sits in the tray or was autostarted hidden, and a
  // window-modal sheet on a hidden macOS window is never shown at all — the
  // awaited promise would simply never settle.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

async function checkForDesktopUpdates(manual = false) {
  const shellUpdates = autoUpdatesSupported();
  if (!shellUpdates && !webUpdatesSupported()) return;
  if (updateCheckInFlight) {
    if (manual) manualUpdateCheck = true;
    return;
  }
  updateCheckInFlight = true;
  manualUpdateCheck = manual;
  try {
    const web = webUpdatesSupported() ? await checkForWebUpdate() : "unchanged";
    if (web === "installed") announceWebUpdate();
    if (shellUpdates) {
      // electron-updater's events report the outcome; a staged site has
      // already answered a manual check with the restart toast.
      if (web === "installed") manualUpdateCheck = false;
      await updater().checkForUpdates();
      return;
    }
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    await reportWebUpdate(web, wasManual);
  } catch (error) {
    console.warn("[updater] update check failed", error);
    const shouldReport = manual && manualUpdateCheck;
    manualUpdateCheck = false;
    if (shouldReport) {
      await showUpdateMessage({
        type: "error",
        title: "Update check failed",
        message: "Armada could not check for updates.",
        detail: "Check your connection and try again.",
      });
    }
  } finally {
    updateCheckInFlight = false;
  }
}

/**
 * Stage the newest signed site for the next launch (webSite.js). Resolves
 * `"installed"`, `"unchanged"`, `"incompatible"` (it needs a newer shell) or
 * `"failed"`; never rejects, so the shell track still runs.
 */
async function checkForWebUpdate() {
  try {
    const { parseWebSite, resolveWebSite } = require("./updateFeed.cjs");
    const site = await resolveWebSite();
    // No acceptable manifest is "nothing newer", not a failure.
    if (!site) return "unchanged";
    const outcome = await stageSite({
      dir: WEB_DIR,
      site,
      active: activeSite,
      parse: parseWebSite,
      shellApi: SHELL_API,
      shellVersion: app.getVersion(),
      floor: SHELL_BUILT_AT,
    });
    if (outcome.result === "installed" && pendingWebSite !== outcome.id) {
      console.log(`[web] staged site ${outcome.id}`);
      pendingWebSite = outcome.id;
    }
    if (outcome.result === "incompatible") console.log(`[web] site ${outcome.id} needs a newer shell`);
    return outcome.result;
  } catch (error) {
    console.warn("[web] update failed", error);
    return "failed";
  }
}

function announceWebUpdate() {
  // The renderer offers the restart as an in-app toast; no OS dialog.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("armada:web-update-ready");
    if (manualUpdateCheck) showWindow();
  }
}

const DOWNLOADS_URL = "https://armada.buzz/downloads";

/** The web track's outcome, for a build with no shell updater. */
async function reportWebUpdate(result, manual) {
  if (result === "installed") return;
  if (result === "incompatible") {
    if (manual) {
      const { response } = await showUpdateMessage({
        type: "info",
        title: "Armada update available",
        message: "This update needs a newer version of the Armada app.",
        detail: "Install the latest Armada to keep getting updates.",
        buttons: ["Open Downloads", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) void openExternalUrl(DOWNLOADS_URL);
    } else if (!shellUpdateAnnounced && Notification.isSupported()) {
      shellUpdateAnnounced = true;
      const notification = new Notification({
        title: "Armada update available",
        body: "This update needs a newer version of the Armada app. Click to download it.",
      });
      notification.on("click", () => void openExternalUrl(DOWNLOADS_URL));
      notification.show();
    }
    return;
  }
  if (!manual) return;
  if (result === "failed") {
    await showUpdateMessage({
      type: "error",
      title: "Update check failed",
      message: "Armada could not check for updates.",
      detail: "Check your connection and try again.",
    });
    return;
  }
  await showUpdateMessage({
    type: "info",
    title: "Armada is up to date",
    message: "You are running the newest available version.",
  });
}

function installAutoUpdater() {
  const electronUpdater = autoUpdatesSupported();
  if (!electronUpdater && !webUpdatesSupported()) return;
  if (electronUpdater) installElectronUpdater();

  // Let the UI and keyring finish booting before the first network request.
  setTimeout(() => void checkForDesktopUpdates(false), 10_000).unref();
  updateCheckTimer = setInterval(
    () => void checkForDesktopUpdates(false),
    4 * 60 * 60 * 1000,
  );
  updateCheckTimer.unref();
}

function installElectronUpdater() {
  // Reaching here means this package has a single writable update owner: an
  // installed Windows NSIS build, a Developer ID-signed macOS build, or an
  // AppImage. Windows signing improves publisher verification and reputation,
  // but is not required: a user who installed Armada's unsigned NSIS build has
  // opted into the same HTTPS + feed-SHA-512 trust model the AppImage uses.
  const autoUpdater = updater();
  configureAutoUpdater(autoUpdater);
  // Overrides the `provider: generic` feed baked into app-update.yml at package
  // time. Passing the class rather than a URL is electron-updater's documented
  // `custom` provider contract.
  autoUpdater.setFeedURL({ provider: "custom", updateProvider: require("./nostrUpdateProvider").NostrReleaseProvider });
  autoUpdater.logger = console;

  autoUpdater.on("update-not-available", async () => {
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    if (!wasManual) return;
    await showUpdateMessage({
      type: "info",
      title: "Armada is up to date",
      message: `You are running Armada ${app.getVersion()}, the newest available version.`,
    });
  });

  autoUpdater.on("error", async (error) => {
    console.warn("[updater] updater error", error);
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    if (!wasManual) return;
    await showUpdateMessage({
      type: "error",
      title: "Update check failed",
      message: "Armada could not check for updates.",
      detail: "Check your connection and try again.",
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    installerDownloaded = true;
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    // An unprompted check must not raise a modal: on Windows it takes focus from
    // whatever app the user is in. The in-app toast offers the restart instead.
    if (!wasManual) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("armada:web-update-ready");
      return;
    }
    const { response } = await showUpdateMessage({
      type: "info",
      title: "Armada update ready",
      message: `Armada ${info.version} has been downloaded.`,
      detail: "Restart Armada to install it now, or choose Later to install when you quit.",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
}

// ── Unread badge ─────────────────────────────────────────────────────────────
//
// The web app reports its unread/mention count through the preload bridge
// (window.armadaDesktop.setBadge). We reflect it on the OS badge where
// supported (macOS dock, some Linux DEs via Unity launcher) and always on the
// tray tooltip + a small overlay dot.

function setUnreadBadge(count) {
  const n = Math.max(0, Number(count) || 0);

  if (typeof app.setBadgeCount === "function") {
    app.setBadgeCount(n);
  }

  if (tray) {
    tray.setToolTip(n > 0 ? `Armada (${n} unread)` : "Armada");
  }

  if (mainWindow && process.platform === "win32") {
    if (n > 0) {
      const dot = nativeImage.createFromDataURL(UNREAD_OVERLAY_DATA_URL);
      mainWindow.setOverlayIcon(dot, `${n} unread`);
    } else {
      mainWindow.setOverlayIcon(null, "");
    }
  }
}

// A tiny red dot (16x16 SVG) for the Windows taskbar overlay.
const UNREAD_OVERLAY_DATA_URL =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#e0245e"/></svg>',
  ).toString("base64");

// ── Screen share (getDisplayMedia) ──────────────────────────────────────────
//
// Electron has no native screen-picker, so getDisplayMedia() does nothing until
// we install a request handler. We surface the available sources to the
// renderer (preload exposes pickScreenShareSource) and let the in-app UI choose,
// then hand the chosen source back to Electron.

// Keep the native DesktopCapturerSource objects from the list shown to the
// renderer. On Linux/Wayland, getSources() enters the ScreenCast portal and
// returns the ONE source the user authorized. Calling getSources() again after
// the in-app picker would start a second portal session and lose the authorized
// PipeWire stream, so the display-media handler must grant this exact object.
const screenShareSources = new Map();
const pendingScreenSharePicks = new Map();
let nextScreenSharePickId = 1;

function resolveScreenSharePick(requestId, sourceId) {
  const pending = pendingScreenSharePicks.get(requestId);
  if (!pending) return;
  pendingScreenSharePicks.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(typeof sourceId === "string" && sourceId ? sourceId : null);
}

function requestScreenSharePick() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  const requestId = nextScreenSharePickId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolveScreenSharePick(requestId, null), 5 * 60_000);
    pendingScreenSharePicks.set(requestId, { resolve, timer });
    try {
      mainWindow.webContents.send("armada:pick-screen-source", requestId);
    } catch {
      resolveScreenSharePick(requestId, null);
    }
  });
}

function installDisplayMediaHandler() {
  ipcMain.on("armada:screen-source-picked", (event, requestId, sourceId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!Number.isSafeInteger(requestId)) return;
    resolveScreenSharePick(requestId, sourceId);
  });

  // The renderer asks for the source list and returns the chosen id; we cache
  // it for the duration of one getDisplayMedia call.
  handleFromMainWindow("armada:get-screen-sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: true,
      });
      screenShareSources.clear();
      for (const source of sources) screenShareSources.set(source.id, source);
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail?.toDataURL() ?? "",
        appIcon:
          source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : "",
        isScreen: source.id.startsWith("screen:"),
      }));
    } catch (error) {
      screenShareSources.clear();
      console.warn("[screen-share] failed to list display sources", error);
      throw error;
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Electron's callback is one-shot and throws synchronously when an empty
      // result cancels a video request. Mark it complete BEFORE invoking it so
      // that a thrown cancellation can never result in a second callback.
      let completed = false;
      const complete = (streams, reportError = true) => {
        if (completed) return;
        completed = true;
        try {
          callback(streams);
        } catch (error) {
          if (reportError) console.warn("[screen-share] Electron rejected display source", error);
        }
      };

      // Ask the renderer to pick a source via the context-isolated preload IPC
      // bridge. A property written on preload's window is invisible to the
      // page, so executeJavaScript cannot be used to call the React handler.
      const pick = async () => {
        try {
          const chosenId = await requestScreenSharePick();
          if (!chosenId) {
            screenShareSources.clear();
            complete({}, false); // user cancelled
            return;
          }
          const source = screenShareSources.get(chosenId);
          screenShareSources.clear();
          if (!source) {
            console.warn("[screen-share] selected display source is no longer available");
            complete({}, false);
            return;
          }
          // Linux audio is attached through venmic. On macOS 15+ the trusted
          // system picker bypasses this handler and owns its audio selection.
          complete(displayMediaGrant(source, {
            platform: process.platform,
            audioRequested: request.audioRequested,
          }));
        } catch (error) {
          screenShareSources.clear();
          console.warn("[screen-share] display capture request failed", error);
          complete({}, false);
        }
      };
      void pick();
    },
    // Electron falls back to this handler on macOS versions without the
    // trusted system picker.
    displayMediaHandlerOptions(process.platform),
  );
}

// ── Linux screen-share audio (PipeWire) ────────────────────────────────────
//
// Chromium cannot attach Linux system audio to getDisplayMedia. venmic creates
// a temporary PipeWire virtual microphone whose monitor contains either the
// selected applications or the default speakers. The renderer adds that mic's
// track to the display stream before LiveKit publishes it.

// venmic lives in a utility process (linuxAudioWorker.js): its native teardown
// at exit() can abort, and killing the worker on quit skips that teardown.
let linuxAudioWorker = null;
let linuxAudioProbe = null;
let linuxAudioRequestId = 0;
const linuxAudioPending = new Map();
const linuxAudioMatchers = new Map();

function linuxAudioWorkerProcess() {
  if (linuxAudioWorker) return linuxAudioWorker;
  const worker = utilityProcess.fork(path.join(__dirname, "linuxAudioWorker.js"), [], {
    serviceName: "Armada PipeWire Audio",
  });
  worker.on("message", ({ id, ok, value, error }) => {
    const pending = linuxAudioPending.get(id);
    if (!pending) return;
    linuxAudioPending.delete(id);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(error));
  });
  worker.on("exit", (code) => {
    if (linuxAudioWorker !== worker) return;
    if (!isQuitting) console.warn(`[screen-share] PipeWire audio worker exited (${code})`);
    linuxAudioWorker = null;
    // A fresh worker re-probes, so a crash is recoverable on the next share.
    linuxAudioProbe = null;
    for (const pending of linuxAudioPending.values()) {
      pending.reject(new Error("PipeWire audio worker exited"));
    }
    linuxAudioPending.clear();
  });
  linuxAudioWorker = worker;
  return worker;
}

function callLinuxAudioWorker(op, args) {
  const worker = linuxAudioWorkerProcess();
  const id = ++linuxAudioRequestId;
  return new Promise((resolve, reject) => {
    linuxAudioPending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

// Resolves to { loadError, canUnmute }; only the first call loads venmic.
function probeLinuxAudio() {
  if (process.platform !== "linux") return Promise.resolve(null);
  linuxAudioProbe ??= callLinuxAudioWorker("probe").catch((error) => {
    console.warn("[screen-share] PipeWire audio worker failed", error);
    linuxAudioProbe = null;
    return { loadError: "The PipeWire audio capture module could not be loaded." };
  });
  return linuxAudioProbe;
}

function stopLinuxAudioWorker() {
  const worker = linuxAudioWorker;
  if (!worker) return;
  linuxAudioWorker = null;
  worker.kill();
}

function electronAudioServiceMatcher() {
  const metric = app.getAppMetrics().find((entry) => entry.name === "Audio Service");
  return metric ? { "application.process.id": String(metric.pid) } : null;
}

async function listLinuxAudioSources() {
  if (process.platform !== "linux") {
    return { supported: false, reason: null, sources: [] };
  }
  const probe = await probeLinuxAudio();
  if (probe.loadError) {
    return { supported: false, reason: probe.loadError, sources: [] };
  }

  try {
    const audioService = electronAudioServiceMatcher();
    const applications = await callLinuxAudioWorker("applications", {
      electronAudioProcessId: audioService?.["application.process.id"],
    });
    // Rebuilt rather than merged: the table only has to resolve ids the picker
    // is still holding, and those ids name the application, so a re-list either
    // yields the same entry or drops one that has gone away.
    linuxAudioMatchers.clear();

    const sources = applications.map((source) => {
      linuxAudioMatchers.set(source.id, source.matcher);
      return { id: source.id, name: source.name };
    });
    return { supported: true, reason: null, sources };
  } catch (error) {
    console.warn("[screen-share] failed to enumerate PipeWire audio", error);
    return { supported: false, reason: "PipeWire audio sources could not be listed.", sources: [] };
  }
}

async function startLinuxShareAudio(selection) {
  const probe = await probeLinuxAudio();
  if (!probe || probe.loadError) return false;
  try {
    const exclude = [];
    const audioService = electronAudioServiceMatcher();
    if (audioService) exclude.push(audioService);
    exclude.push({ "media.class": "Stream/Input/Audio" }, { "node.virtual": "true" });

    const common = {
      exclude,
      ignore_devices: true,
      only_speakers: true,
      only_default_speakers: true,
      // Stay muted until the renderer has attached the virtual microphone;
      // this avoids a short burst through the user's normal mic path.
      // Unknown options are harmless to venmic 6.x, which cannot unmute.
      mute: probe.canUnmute,
    };
    let data = null;
    if (selection?.mode === "system") {
      data = { ...common, include: [] };
    } else if (selection?.mode === "applications" && Array.isArray(selection.sourceIds)) {
      const include = selection.sourceIds
        .map((id) => linuxAudioMatchers.get(id))
        .filter(Boolean);
      if (include.length > 0) data = { ...common, include };
    }
    if (!data) return false;
    return await callLinuxAudioWorker("link", { data });
  } catch (error) {
    console.warn("[screen-share] failed to start PipeWire audio", error);
    return false;
  }
}

function installLinuxShareAudioIpc() {
  handleFromMainWindow("armada:linux-share-audio-sources", () => listLinuxAudioSources());
  handleFromMainWindow("armada:linux-share-audio-start", (_event, selection) =>
    startLinuxShareAudio(selection),
  );
  handleFromMainWindow("armada:linux-share-audio-unmute", async () => {
    if (!linuxAudioWorker || !linuxAudioProbe) return false;
    try {
      const probe = await linuxAudioProbe;
      if (probe.loadError) return false;
      // The Flatpak-compatible venmic 6.x addon is already live after link().
      if (!probe.canUnmute) return true;
      return await callLinuxAudioWorker("unmute");
    } catch {
      return false;
    }
  });
  handleFromMainWindow("armada:linux-share-audio-stop", async () => {
    if (!linuxAudioWorker) return;
    try {
      await callLinuxAudioWorker("unlink");
    } catch (error) {
      console.warn("[screen-share] failed to stop PipeWire audio", error);
    }
  });
}

// ── Linux H.265 screen share (FFmpeg/VA-API → LiveKit) ────────────────────

const hevcScreenShare = createHevcScreenShareController({
  sendStatus(status) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("armada:hevc-screen-share-status", status);
  },
});

function installHevcScreenShareIpc() {
  // Every handler is gated, not just the one that spawns: the capability probe
  // runs FFmpeg, and stop() can cancel a session another sender does not own.
  // Only the main window has this preload, so the guard costs nothing today
  // and stops being free to omit the day a second window exists.
  const requireMainWindow = (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error("H.265 publishing is available only to Armada's main window.");
    }
  };
  ipcMain.handle("armada:hevc-screen-share-capability", (event) => {
    requireMainWindow(event);
    return detectCachedHevcCapability();
  });
  ipcMain.handle("armada:hevc-screen-share-status", (event) => {
    requireMainWindow(event);
    return hevcScreenShare.status();
  });
  ipcMain.handle("armada:hevc-screen-share-start", async (event, config) => {
    requireMainWindow(event);
    const { port1, port2 } = new MessageChannelMain();
    const sessionId = randomUUID();
    try {
      const status = await hevcScreenShare.start(config, port1, sessionId);
      // Keep high-volume video frames off ordinary request/response IPC. The
      // renderer sends cloned ArrayBuffers over this dedicated port because
      // Electron 43 turns transferred ArrayBuffers into null at MessagePortMain.
      event.sender.postMessage(
        "armada:hevc-screen-share-port",
        { sessionId },
        [port2],
      );
      return { ...status, sessionId };
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  });
  ipcMain.handle("armada:hevc-screen-share-stop", (event) => {
    requireMainWindow(event);
    return hevcScreenShare.stop("requested");
  });
}

// ── Permissions (microphone/camera for voice) ───────────────────────────────
//
// Electron's default is to grant renderer permission requests, but we set an
// explicit handler so the policy is deliberate: media (mic/camera for LiveKit
// voice), notifications, fullscreen, clipboard and pointer lock are allowed
// for our own app:// origin only, embeds it frames get fullscreen, and only the
// allowlisted provider players get clipboard write (permissionPolicy.js);
// everything else is denied. On macOS the OS additionally gates mic/camera
// behind TCC — the Info.plist usage strings live in electron-builder.yml
// (extendInfo).
//
// Windows has its own OS-level gate ("Let desktop apps access your
// microphone"); when it is off getUserMedia rejects whatever our handlers say.
// We can't flip it, so armada:mic-access-status / armada:open-mic-settings
// below let the renderer detect it and guide the user there.

// Our own origin: app://armada (isArmadaAppUrl, which compares scheme+host
// rather than `URL.origin` — "null" for a custom scheme — and rejects
// userinfo lookalikes; see appOrigin.js), plus the Vite dev server in dev
// mode.
function isAppOrigin(url) {
  if (isArmadaAppUrl(url)) return true;
  if (DEV_ORIGIN === "") return false;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}` === DEV_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Keep every renderer on our own origin, and hand everything else to the OS.
 *
 * Bound through `web-contents-created` rather than to the main window, because
 * a window opened by the allow branch below is a SEPARATE webContents that
 * would otherwise carry none of this. That window is reachable from untrusted
 * content — the WebXDC sandbox runs with `allow-popups-to-escape-sandbox` and
 * link embeds load foreign origins — and its opener may navigate it afterwards,
 * so without a handler of its own it is a chromeless, CSP-less window wearing
 * the app's title. (It gets no preload: Electron does not inherit one into a
 * child window, so the bridge was never exposed. The exposure is the frame.)
 *
 * Only main-frame navigation is policed. Subframes are left alone on purpose:
 * the app embeds foreign origins by design (YouTube, Spotify, the WebXDC
 * sandbox), and which ones is CSP `frame-src`'s job — a native origin check
 * there would refuse the embeds instead of hardening them.
 */
function installNavigationHandlers() {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAppOrigin(url)) {
        // Explicit rather than inherited: no preload, and the main window's isolation.
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: { preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      // A link to our own public web host (a copied message/invite link) is
      // routed through the renderer's router rather than opened in the browser
      // — the same in-app landing Android/iOS give it, minus an OS handoff a
      // desktop app can't have. Everything else is still handed to the OS.
      const internalPath = internalAppLinkPath(url, deepLinkHost);
      if (internalPath) {
        dispatchInternalDeepLink(internalPath);
        return { action: "deny" };
      }
      void openExternalUrl(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isAppOrigin(url)) return;
      event.preventDefault();
      if (isSignerHandoffUrl(url) || isMagnetUrl(url) || isNsiteUrl(url)) {
        // Only our own top frame may hand a pairing link to the signer, a
        // magnet link to the torrent client or an nsite link to its browser:
        // an embed with top-navigation rights must not choose any of them. A missing
        // initiator (frame gone) is refused.
        const initiator = event.initiator;
        if (initiator && !initiator.parent && isAppOrigin(initiator.url)) {
          shell.openExternal(url).catch((error) => {
            console.warn("[shell] no handler for", new URL(url).protocol, error);
          });
        } else {
          console.warn("[shell] refused", new URL(url).protocol, "link from", initiator?.url);
        }
        return;
      }
      const internalPath = internalAppLinkPath(url, deepLinkHost);
      if (internalPath) {
        dispatchInternalDeepLink(internalPath);
        return;
      }
      void openExternalUrl(url);
    });
    contents.on("will-attach-webview", (event) => {
      // `webviewTag` is off, so this cannot fire. Refuse anyway rather than
      // leave the outcome to a webPreferences default.
      event.preventDefault();
    });
  });
}

function installPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const topUrl = webContents?.getURL() || "";
      callback(allowPermissionRequest({ permission, details, topUrl, isAppOrigin }));
    },
  );
  // Synchronous check (e.g. navigator.permissions.query, mediaDevices checks).
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      return allowPermissionCheck({ permission, requestingOrigin, details, isAppOrigin });
    },
  );
}

// ── Secret storage (safeStorage) ────────────────────────────────────────────
//
// The web build keeps the login store — which for an nsec login holds the raw
// secret key — in localStorage, i.e. plaintext in the profile's LevelDB. On
// desktop we can do better: `safeStorage` wraps the OS credential store
// (libsecret/kwallet on Linux, Keychain on macOS, DPAPI on Windows), so the
// blob is encrypted at rest against anything reading the profile directory.
//
// This does NOT defend against code running inside the app — the renderer can
// always ask for a decrypt, exactly as it can on the mobile keystore path.
// What it buys is at-rest protection: a stolen disk, a backup/sync tool, or
// another account on the machine no longer yields a usable nsec.
//
// The renderer owns the storage container and the migration; the main process
// only lends it the cipher. Buffers cross the bridge as base64 because the
// bridge carries JSON.

function installSecretIpc() {
  // Whether encryption is usable, plus which backend is doing it. On Linux a
  // machine with no keyring daemon falls back to `basic_text` — a hardcoded
  // key, i.e. obfuscation rather than encryption. We still use it (it costs
  // nothing and can't fail to unlock), but the renderer surfaces the backend
  // in Settings so the user isn't told they have protection they don't.
  handleFromMainWindow("armada:secrets-status", () => {
    try {
      return {
        available: safeStorage.isEncryptionAvailable(),
        backend:
          process.platform === "linux"
            ? safeStorage.getSelectedStorageBackend()
            : process.platform,
      };
    } catch {
      return { available: false, backend: "unknown" };
    }
  });

  handleFromMainWindow("armada:encrypt-secret", (_event, plaintext) => {
    try {
      if (typeof plaintext !== "string") return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.encryptString(plaintext).toString("base64");
    } catch {
      return null;
    }
  });

  // Returns null rather than throwing when the ciphertext can't be opened (a
  // reset keyring, a profile copied to another machine). The renderer treats
  // null as "locked, not empty" and must not overwrite the blob — it is very
  // likely the only copy of the user's identity key.
  handleFromMainWindow("armada:decrypt-secret", (_event, base64) => {
    try {
      if (typeof base64 !== "string" || !base64) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(base64, "base64"));
    } catch {
      return null;
    }
  });
}

// ── Local storage (ArmadaDB over SQLite) ────────────────────────────────────
//
// Desktop stores its data the way Android does, not the way the web does: one
// SQLite file, with the query engine out here in the main process, reached by
// the renderer over IPC. `db.cjs` is the bundled build of the app's own store
// (src/lib/db — see vite.config.electron.ts), so this is the same engine and
// the same schema the test suite exercises, not a second implementation.
//
// The alternative was Chromium's IndexedDB, which is what the web build uses.
// In a browser tab that's the only option; in a desktop app it puts the user's
// messages inside a profile directory keyed by the renderer's origin, where
// they can't be found, backed up, or carried to another machine — and it ties
// their survival to a storage area the browser engine treats as evictable.
//
// The file lives in the OS's per-app config directory (app.getPath("userData"),
// i.e. ~/.config/Armada on Linux, %APPDATA%\Armada on Windows,
// ~/Library/Application Support/Armada on macOS) alongside everything else the
// app owns.

/** @type {{ call: (op: string, payload?: unknown) => Promise<unknown>, close: () => Promise<void> } | null} */
let dbServer = null;

/**
 * Narrow the store to its owner before anything opens it.
 *
 * The file holds decrypted message history, and Node creates it at the umask
 * default — 0644 on most Linux setups, i.e. readable by every other account on
 * the machine. That is the one way this store is worse than the Chromium
 * profile it replaces, and it costs two syscalls to close. It is NOT a defence
 * against malware running as the user: that process can read the file whatever
 * its mode, and could read the IndexedDB tree too.
 *
 * Done BEFORE the open because SQLite gives a new -wal/-shm the mode it finds
 * on the database, so fixing the database first fixes the pair it creates; the
 * explicit pass afterwards catches a -wal left at 0644 by an earlier build.
 *
 * Skipped on Windows, where fs.chmod only toggles the read-only flag and the
 * per-user ACL on %APPDATA% is the control that actually applies. Every step is
 * best-effort: a filesystem without POSIX modes (a FAT mount, some network
 * homes) must not cost the user their database.
 */
function restrictToOwner(file) {
  if (process.platform === "win32") return;
  const attempt = (fn) => {
    try {
      fn();
    } catch {
      // Advisory hardening; the store still opens without it.
    }
  };
  attempt(() => fs.chmodSync(path.dirname(file), 0o700));
  // Create it here if it is absent, so the mode is right from the first byte
  // rather than after a window in which it sat readable.
  attempt(() => fs.closeSync(fs.openSync(file, "a", 0o600)));
  attempt(() => fs.chmodSync(file, 0o600));
}

function installDbIpc() {
  const file = path.join(app.getPath("userData"), "armada.db");
  restrictToOwner(file);
  try {
    const { openArmadaDbServer } = require("./db.cjs");
    dbServer = openArmadaDbServer(file);
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      if (process.platform === "win32") break;
      try {
        fs.chmodSync(sidecar, 0o600);
      } catch {
        // Absent (no WAL yet) or not chmod-able; neither is fatal.
      }
    }
  } catch (error) {
    // A read-only profile directory, a full disk, a database written by a
    // build whose schema this one can't open. Reported to the renderer as
    // "unavailable" rather than left to fail on first read, so it can fall
    // back to IndexedDB and still run.
    console.error("[db] could not open", file, error);
    dbServer = null;
  }

  // Answered synchronously at preload time: the renderer picks its storage
  // adapter before anything reads, so the answer has to be ready before the
  // window loads. It is — the file is opened above, during whenReady.
  ipcMain.on("armada:db-available", (event) => {
    event.returnValue = dbServer !== null;
  });

  handleFromMainWindow("armada:db", async (_event, op, payload) => {
    if (!dbServer) throw new Error("The ArmadaDB store is unavailable");
    return await dbServer.call(String(op), payload ?? {});
  });
}

// Release the connection on the way out so SQLite checkpoints the WAL and the
// next launch opens a settled file rather than replaying one.
async function closeDb() {
  const server = dbServer;
  dbServer = null;
  if (!server) return;
  try {
    await server.close();
  } catch {
    // shutting down anyway
  }
}

// ── IPC from the renderer (preload bridge) ──────────────────────────────────

function installIpc() {
  onFromMainWindow("armada:set-badge", (_event, count) => setUnreadBadge(count));
  // The renderer presented an OS notification: draw attention to the window
  // without raising it — the taskbar flash on Windows, urgency on Linux, a
  // dock bounce on macOS — unless the user is already looking at it.
  onFromMainWindow("armada:request-attention", () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
    mainWindow.flashFrame(true);
  });
  ipcMain.handle("armada:platform", () => ({
    platform: process.platform,
    version: app.getVersion(),
  }));
  ipcMain.handle("armada:video-encoder-mode", () => ({
    available: process.platform === "linux",
    active: process.platform === "linux" ? activeLinuxVideoEncoderMode : null,
    configured: readLinuxVideoEncoderMode({ userDataPath: app.getPath("userData") }),
  }));
  const lowMemoryState = () => {
    const configured = readLowMemoryMode({ userDataPath: app.getPath("userData") });
    return { active: activeLowMemoryMode, configured, restartRequired: configured !== activeLowMemoryMode };
  };
  ipcMain.handle("armada:low-memory-mode", lowMemoryState);
  // Bytes of an image whose host sends no CORS headers (see imageFetch.js).
  handleFromMainWindow("armada:fetch-image", (_event, url) =>
    fetchImage(typeof url === "string" ? url : "", {
      fetchImpl: (href, init) => session.defaultSession.fetch(href, init),
      resolveImpl: async (u) => {
        if ((await session.defaultSession.resolveProxy(u.href)).trim() !== "DIRECT") return null;
        const { endpoints } = await session.defaultSession.resolveHost(u.hostname);
        return endpoints.map((e) => e.address);
      },
    }),
  );
  // Chromium's HTTP cache, for Settings › Storage.
  handleFromMainWindow("armada:web-cache-size", () => session.defaultSession.getCacheSize());
  handleFromMainWindow("armada:clear-web-cache", () => session.defaultSession.clearCache());
  handleFromMainWindow("armada:set-low-memory-mode", (_event, on) => {
    try {
      writeLowMemoryMode(on === true, { userDataPath: app.getPath("userData") });
    } catch (error) {
      console.warn("failed to save low memory mode", error);
    }
    return lowMemoryState();
  });
  handleFromMainWindow("armada:relaunch", () => {
    isQuitting = true;
    // The AppImage runtime unmounts `execPath` once this process exits; $APPIMAGE is the file itself.
    app.relaunch(process.platform === "linux" && process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
    app.quit();
  });
  handleFromMainWindow("armada:set-video-encoder-mode", (_event, mode) => {
    try {
      const saved = writeLinuxVideoEncoderMode(mode, { userDataPath: app.getPath("userData") });
      const configured = readLinuxVideoEncoderMode({ userDataPath: app.getPath("userData") });
      return {
        available: process.platform === "linux",
        active: process.platform === "linux" ? activeLinuxVideoEncoderMode : null,
        configured,
        restartRequired: saved && configured !== activeLinuxVideoEncoderMode,
      };
    } catch (error) {
      console.warn("failed to save video encoder mode", error);
      return {
        available: process.platform === "linux",
        active: process.platform === "linux" ? activeLinuxVideoEncoderMode : null,
        configured: activeLinuxVideoEncoderMode,
        restartRequired: false,
      };
    }
  });

  // Launch-at-login. The OS holds whether the app is registered; the
  // start-minimized flag is mirrored into userData (see autoLaunch.js).
  handleFromMainWindow("armada:get-launch-settings", () =>
    getLaunchSettings({ appImpl: app, userDataPath: app.getPath("userData") }),
  );
  handleFromMainWindow("armada:set-launch-settings", (_event, settings) => {
    try {
      return setLaunchSettings(settings ?? {}, {
        appImpl: app,
        userDataPath: app.getPath("userData"),
      });
    } catch (error) {
      console.warn("failed to save launch settings", error);
      return getLaunchSettings({ appImpl: app, userDataPath: app.getPath("userData") });
    }
  });

  // OS-level microphone access status. On macOS/Windows this reflects the
  // system privacy setting (not our in-app permission handler); on Linux it's
  // always "granted". Values: "not-determined" | "granted" | "denied" |
  // "restricted" | "unknown".
  ipcMain.handle("armada:mic-access-status", () => {
    try {
      return systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      return "unknown";
    }
  });

  // Open the OS microphone privacy settings so the user can allow desktop apps
  // to use the mic. No-op (resolves false) on platforms without a deep link.
  // These two go to shell.openExternal directly rather than through
  // openExternalUrl: they are compile-time constants in OS-private schemes,
  // which is exactly what that allowlist exists to reject.
  handleFromMainWindow("armada:open-mic-settings", async () => {
    try {
      if (process.platform === "win32") {
        await shell.openExternal("ms-settings:privacy-microphone");
        return true;
      }
      if (process.platform === "darwin") {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        );
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  // macOS Screen Recording is a separate TCC permission from camera/mic.
  // Other platforms do not expose a useful OS-level display-capture status.
  ipcMain.handle("armada:screen-capture-access-status", () => {
    if (process.platform !== "darwin") return "unknown";
    try {
      return systemPreferences.getMediaAccessStatus("screen");
    } catch {
      return "unknown";
    }
  });
  handleFromMainWindow("armada:open-screen-capture-settings", async () => {
    if (process.platform !== "darwin") return false;
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
      return true;
    } catch {
      return false;
    }
  });

  // True hold-to-talk needs both press and release events while Armada is in
  // the background. Windows/macOS and Linux X11 use the native hook; Linux
  // Wayland/Flatpak uses the Global Shortcuts portal's Activated/Deactivated
  // signals. The renderer only marks this active while a LiveKit room exists.
  handleFromMainWindow("armada:push-to-talk-configure", (_event, binding) =>
    pushToTalk.configure(binding),
  );
  handleFromMainWindow("armada:push-to-talk-open-system-settings", () =>
    pushToTalk.openSystemSettings(),
  );
  handleFromMainWindow("armada:push-to-talk-active", (_event, active) =>
    pushToTalk.setActive(active),
  );
}

// ── App lifecycle ────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    if (DEV_URL) {
      console.log(`[dev] ${DEV_URL} — profile ${app.getPath("userData")}`);
    }
    Menu.setApplicationMenu(null);
    // Before registerAppProtocol(): the handler resolves every request against
    // the bundle chosen here.
    selectActiveSite();
    registerAppProtocol();
    // YouTube rejects embedded players whose client identity is a custom
    // scheme (error 153). Packaged app:// builds identify themselves by the
    // Electron app id; normal web/dev origins keep their own HTTP Referer.
    // Install this before createWindow() so the first embed cannot race it.
    installYouTubeEmbedIdentity({
      webRequest: session.defaultSession.webRequest,
      isPackaged: app.isPackaged,
    });
    // Hunspell dictionaries (Windows/Linux) from our site, not Google's CDN.
    // The deploy publishes them (scripts/fetch-spell-dictionaries.sh); a locale
    // it lacks gets no spellcheck rather than a request to Google.
    session.defaultSession.setSpellCheckerDictionaryDownloadURL(SPELL_DICTIONARY_URL);
    // Before createWindow(): these bind through `web-contents-created`, so
    // they have to be listening before the first webContents exists.
    installNavigationHandlers();
    installPermissionHandlers();
    installIpc();
    // After whenReady: on Linux safeStorage has no key until the app is ready.
    installSecretIpc();
    // Before createWindow(): the preload asks whether the store opened, and it
    // asks synchronously, because the renderer chooses its storage adapter
    // before it reads anything.
    installDbIpc();
    installDisplayMediaHandler();
    installLinuxShareAudioIpc();
    installHevcScreenShareIpc();
    installBundleIpc();
    installAutoUpdater();
    // A suspended or locked machine may never deliver the physical key-up.
    // Fail closed instead of leaving the microphone live after wake/unlock.
    powerMonitor.on("suspend", () => pushToTalk.cancelPress());
    powerMonitor.on("lock-screen", () => pushToTalk.cancelPress());
    // Across a suspend/resume the OS freezes the process: TCP connections die
    // but Chromium usually delivers no `close` for the frozen WebSocket, so the
    // relay sockets read OPEN while carrying no traffic and the renderer's
    // self-heal (which re-REQs on the same dead socket) never recovers. There
    // is no OS-level resume signal inside the sandboxed renderer, so relay it
    // from here; the renderer force-rebuilds every pool socket (see
    // NostrProvider). `unlock-screen` is not resume, but a machine that slept
    // on a lock screen surfaces the same dead sockets on unlock.
    const notifyResume = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("armada:resume");
    };
    powerMonitor.on("resume", notifyResume);
    powerMonitor.on("unlock-screen", notifyResume);
    // Create the window BEFORE probing the tray. On Linux that probe is a
    // chain of gdbus round trips with 1.5s timeouts each, so a session whose
    // D-Bus is slow or wedged would otherwise show no window at all for
    // several seconds. Nothing about constructing the window depends on the
    // answer — only whether a --hidden start is safe, reconciled below.
    createWindow({ show: !startHidden });
    watchBundleBoot();

    // Give the AppImage the .desktop entry no installer wrote for it, so the
    // dock has a name and an icon to draw instead of the bare WM_CLASS. Not
    // awaited and not fatal: nothing about running depends on the outcome.
    void integrateAppImage({
      version: app.getVersion(),
      renderIcon: renderLinuxIcon,
    }).then((result) => {
      if (result.reason === "error") {
        console.warn("[shell] desktop integration failed", result.error);
      }
    });

    if (process.platform === "linux") {
      await refreshTraySupport();
    } else {
      closeToTraySupported = await createTray();
    }
    // --hidden is safe only when the process has a visible way back in.
    if (startHidden && !closeToTraySupported) showWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow({ show: true });
      else showWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopHiddenTrayMonitor();
    hevcScreenShare.stop("app-quit");
    stopLinuxAudioWorker();
    // Not awaited: before-quit is synchronous. The catch keeps a bus teardown
  // rejection from surfacing as an unhandled rejection during shutdown.
  void pushToTalk.destroy().catch(() => {});
  });

  // Closing the database is async, and quitting is not, so the first pass is
  // deferred until the connection is released. `closeDb` clears the handle
  // before it awaits, so the re-entrant quit falls straight through.
  app.on("will-quit", (event) => {
    if (!dbServer) return;
    event.preventDefault();
    // Re-quitting from will-quit's own preventDefault continuation is a no-op:
    // Electron guards against re-entrant quit while the will-quit emission is
    // still on the stack. closeDb resolves on a microtask (node:sqlite's
    // close() is synchronous), so calling app.quit() directly lands inside that
    // same emission and the app hangs instead of exiting. setImmediate defers
    // the second quit to a fresh macrotask, past the guard.
    closeDb().finally(() => setImmediate(() => app.quit()));
  });

  // With a usable tray, the app keeps running when all windows are closed.
  app.on("window-all-closed", () => {
    if (!closeToTraySupported) app.quit();
  });
}
