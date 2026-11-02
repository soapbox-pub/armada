// Preload bridge for the Armada desktop app.
//
// Runs in the sandboxed, context-isolated preload world and exposes an explicit API
// to the web app on window.armadaDesktop. The web build feature-detects this
// object: when absent (a normal browser) it no-ops; when present it lights up
// desktop-only behavior (unread badge, native screen-share picker).

const { contextBridge, ipcRenderer } = require("electron");

let screenSourcePicker = null;

ipcRenderer.on("armada:hevc-screen-share-port", (event, message) => {
  const next = event.ports?.[0];
  const sessionId = message?.sessionId;
  if (!next || typeof sessionId !== "string" || !sessionId) {
    next?.close();
    return;
  }
  if (typeof window === "undefined") {
    next.close();
    return;
  }
  // IPC arrives in this isolated preload world. Transfer the port once into
  // the page's main world, following Electron's context-isolated MessagePort
  // pattern. Frames then travel main-world → main-process without passing
  // through contextBridge's per-call request/response serializer.
  window.postMessage(
    { type: "armada:hevc-screen-share-port", sessionId },
    "*",
    [next],
  );
});

// Main → preload → renderer request/response bridge for getDisplayMedia.
// Context isolation gives preload and the page different global objects, so a
// callback stored directly on preload's `window` is not visible to main-world
// JavaScript. IPC is the deliberate bridge between those contexts.
ipcRenderer.on("armada:pick-screen-source", async (_event, requestId) => {
  let sourceId = null;
  try {
    sourceId = screenSourcePicker ? await screenSourcePicker() : null;
  } catch {
    sourceId = null;
  }
  ipcRenderer.send(
    "armada:screen-source-picked",
    requestId,
    typeof sourceId === "string" && sourceId ? sourceId : null,
  );
});

contextBridge.exposeInMainWorld("armadaDesktop", {
  isDesktop: true,

  /** Report the current unread/mention count for the tray + OS badge. */
  setBadge: (count) => ipcRenderer.send("armada:set-badge", count),

  /**
   * Flash the taskbar entry / bounce the dock for a notification that arrived
   * while the window is not focused. The main process drops it when the window
   * IS focused and stops the flash on the next focus.
   */
  requestAttention: () => ipcRenderer.send("armada:request-attention"),

  /**
   * Tell the shell the web bundle actually painted. The shell serves a
   * swappable bundle from userData, and this is how it learns the one it chose
   * comes up at all — silence past a grace period makes it look for a newer
   * one immediately rather than waiting for the next scheduled check.
   */
  signalWebReady: () => ipcRenderer.send("armada:web-ready"),

  /**
   * Web-bundle updates (Flatpak): whether a newer bundle was installed this
   * run, a subscription for when one is, and a restart to activate it.
   */
  isWebUpdatePending: () => ipcRenderer.invoke("armada:web-update-pending"),
  onWebUpdateReady: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = () => handler();
    ipcRenderer.on("armada:web-update-ready", listener);
    return () => ipcRenderer.removeListener("armada:web-update-ready", listener);
  },
  restartForWebUpdate: () => ipcRenderer.send("armada:web-update-restart"),

  /**
   * Report the App Links host (PUBLIC_WEB_ORIGIN's hostname) at boot, so the
   * shell routes links to our own public host inward instead of to the browser.
   * The build bakes in no origin, so the main process has no other way to know.
   */
  registerDeepLinkHost: (host) =>
    ipcRenderer.send("armada:register-deep-link-host", host),

  /**
   * Subscribe to in-app deep links the shell intercepted (an https link to our
   * own host that would otherwise have opened the browser). The handler gets
   * the router path; returns an unsubscribe.
   */
  onDeepLink: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, path) => handler(path);
    ipcRenderer.on("armada:deep-link", listener);
    return () => ipcRenderer.removeListener("armada:deep-link", listener);
  },

  /** { platform, version } of the desktop shell. */
  getInfo: () => ipcRenderer.invoke("armada:platform"),

  /**
   * Subscribe to the shell's power-resume signal (wake from suspend, or unlock
   * of a machine that slept locked). The relay WebSockets are typically dead
   * across a suspend without Chromium firing a `close`, so the handler force-
   * rebuilds the pool sockets. Returns an unsubscribe.
   */
  onResume: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = () => handler();
    ipcRenderer.on("armada:resume", listener);
    return () => ipcRenderer.removeListener("armada:resume", listener);
  },

  /**
   * Subscribe to the window being closed to the tray. The page stays
   * "visible" to the Page Visibility API (background throttling is off), so
   * this is the only way it learns to stop playing media. Returns an
   * unsubscribe.
   */
  onWindowHidden: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = () => handler();
    ipcRenderer.on("armada:window-hidden", listener);
    return () => ipcRenderer.removeListener("armada:window-hidden", listener);
  },

  /**
   * Subscribe to whether the window can be seen (shown and not minimized),
   * including once per page load. Returns an unsubscribe.
   */
  onWindowVisibility: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, visible) => handler(visible === true);
    ipcRenderer.on("armada:window-visibility", listener);
    return () => ipcRenderer.removeListener("armada:window-visibility", listener);
  },

  /**
   * Read the "launch Armada at login" state: { supported, openAtLogin,
   * openAsHidden }. `openAsHidden` starts the app minimized to the tray.
   */
  getLaunchSettings: () => ipcRenderer.invoke("armada:get-launch-settings"),

  /** Enable/disable launch-at-login and the start-minimized flag. */
  setLaunchSettings: (settings) =>
    ipcRenderer.invoke("armada:set-launch-settings", settings),

  /** Linux WebRTC encoder policy. Changes take effect after an app restart. */
  getVideoEncoderMode: () => ipcRenderer.invoke("armada:video-encoder-mode"),
  setVideoEncoderMode: (mode) => ipcRenderer.invoke("armada:set-video-encoder-mode", mode),

  /** Linux FFmpeg/VA-API H.265 publisher capability and lifecycle. */
  getHevcScreenShareCapability: () =>
    ipcRenderer.invoke("armada:hevc-screen-share-capability"),
  getHevcScreenShareStatus: () =>
    ipcRenderer.invoke("armada:hevc-screen-share-status"),
  startHevcScreenShare: (config) =>
    ipcRenderer.invoke("armada:hevc-screen-share-start", config),
  stopHevcScreenShare: () => ipcRenderer.invoke("armada:hevc-screen-share-stop"),
  onHevcScreenShareStatus: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("armada:hevc-screen-share-status", listener);
    return () => ipcRenderer.removeListener("armada:hevc-screen-share-status", listener);
  },

  /**
   * OS-level microphone access status. Reflects the system privacy setting
   * (macOS TCC / Windows "let desktop apps use the microphone"), independent of
   * our in-app permission handler. Resolves to one of: "not-determined" |
   * "granted" | "denied" | "restricted" | "unknown" (always "granted" on Linux).
   */
  getMicAccessStatus: () => ipcRenderer.invoke("armada:mic-access-status"),

  /**
   * Open the OS microphone privacy settings so the user can allow desktop apps
   * to use the mic. Resolves true if a settings page was opened, false if the
   * platform has no deep link.
   */
  openMicPrivacySettings: () => ipcRenderer.invoke("armada:open-mic-settings"),

  /** macOS Screen Recording permission status and Settings shortcut. */
  getScreenCaptureAccessStatus: () =>
    ipcRenderer.invoke("armada:screen-capture-access-status"),
  openScreenCapturePrivacySettings: () =>
    ipcRenderer.invoke("armada:open-screen-capture-settings"),

  /**
   * Register (or clear with null) the physical key used for desktop push to
   * talk. Resolves { supported, backend, bindingLabel, reason }.
   */
  configurePushToTalk: (binding) =>
    ipcRenderer.invoke("armada:push-to-talk-configure", binding),

  /** Open the trusted Wayland portal UI that owns an existing global binding. */
  openPushToTalkSystemSettings: () =>
    ipcRenderer.invoke("armada:push-to-talk-open-system-settings"),

  /** Listen only while a connected room needs push-to-talk state. */
  setPushToTalkActive: (active) =>
    ipcRenderer.invoke("armada:push-to-talk-active", Boolean(active)),

  /** Subscribe to global key-down/key-up state; returns an unsubscribe. */
  onPushToTalkState: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, pressed) => handler(Boolean(pressed));
    ipcRenderer.on("armada:push-to-talk-state", listener);
    return () => ipcRenderer.removeListener("armada:push-to-talk-state", listener);
  },

  /** Track a Wayland portal binding changed through the system dialog. */
  onPushToTalkStatus: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("armada:push-to-talk-status", listener);
    return () => ipcRenderer.removeListener("armada:push-to-talk-status", listener);
  },

  /**
   * Whether OS-backed secret encryption is usable, and which backend provides
   * it: { available, backend }. `backend` is the Chromium password store on
   * Linux ("gnome_libsecret" | "kwallet*" | "basic_text" | "unknown") and the
   * platform name elsewhere. "basic_text" means a hardcoded key — obfuscation,
   * not encryption.
   */
  getSecretsStatus: () => ipcRenderer.invoke("armada:secrets-status"),

  /**
   * Encrypt a string with the OS credential store. Resolves base64 ciphertext,
   * or null when encryption is unavailable (the caller then stores plaintext
   * rather than failing the write).
   */
  encryptSecret: (plaintext) => ipcRenderer.invoke("armada:encrypt-secret", plaintext),

  /**
   * Decrypt base64 ciphertext produced by encryptSecret. Resolves null when it
   * can't be opened (reset keyring, profile moved between machines) — which
   * means "locked", NOT "empty": callers must not overwrite the stored blob.
   */
  decryptSecret: (base64) => ipcRenderer.invoke("armada:decrypt-secret", base64),

  /**
   * List shareable screens/windows for the in-app screen-share picker.
   * Returns [{ id, name, thumbnail, appIcon, isScreen }].
   */
  getScreenSources: () => ipcRenderer.invoke("armada:get-screen-sources"),

  /**
   * Linux/PipeWire application audio available to add to a screen share.
   * Resolves { supported, reason, sources: [{ id, name }] }. The opaque ids
   * remain valid until the next source-list request.
   */
  getLinuxShareAudioSources: () =>
    ipcRenderer.invoke("armada:linux-share-audio-sources"),

  /** Prepare the venmic virtual microphone for system or application audio. */
  startLinuxShareAudio: (selection) =>
    ipcRenderer.invoke("armada:linux-share-audio-start", selection),

  /** Unmute the virtual mic once its track is attached to the display stream. */
  unmuteLinuxShareAudio: () =>
    ipcRenderer.invoke("armada:linux-share-audio-unmute"),

  /** Tear down the virtual mic when sharing ends or is cancelled. */
  stopLinuxShareAudio: () => ipcRenderer.invoke("armada:linux-share-audio-stop"),

  /**
   * Register the callback the main process invokes over IPC when
   * getDisplayMedia() is called. It must resolve to the chosen source id (from
   * getScreenSources), or null/undefined to cancel.
   */
  onPickScreenSource: (handler) => {
    screenSourcePicker = handler;
  },

  /**
   * The desktop ArmadaDB store: one SQLite file in the OS's per-app config
   * directory, with the query engine in the main process (see main.js).
   *
   * `available` is resolved HERE, synchronously, and not by the renderer later:
   * the web app picks its storage adapter before anything reads, so a promise
   * would be too late and a wrong guess would mean two stores. sendSync is one
   * round trip at preload, against a value the main process already computed
   * during whenReady.
   *
   * `call` dispatches one method of the store's surface — the same surface the
   * Android plugin exposes, so the web app drives both through one adapter.
   */
  armadaDb: {
    available: ipcRenderer.sendSync("armada:db-available") === true,
    call: (op, payload) => ipcRenderer.invoke("armada:db", op, payload),
  },
});
