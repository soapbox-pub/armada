/**
 * Desktop (Electron) bridge: `window.armadaDesktop` from electron/preload.js.
 * Absent on the web, where every helper no-ops.
 */

import { t } from "@/i18n/intl";
import type { WebUpdateChannel } from "@/lib/desktopUpdate";

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string;
  isScreen: boolean;
}

export interface LinuxShareAudioSource {
  id: string;
  name: string;
}

export interface LinuxShareAudioSources {
  supported: boolean;
  reason: string | null;
  sources: LinuxShareAudioSource[];
}

export type LinuxShareAudioSelection =
  | { mode: "system" }
  | { mode: "applications"; sourceIds: string[] };

/** OS-level mic access (TCC on macOS, privacy setting on Windows); always "granted" on Linux. */
export type MicAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

/**
 * The OS facility encrypting stored secrets. On Linux, `basic_text` is a
 * hardcoded key (obfuscation, not encryption) — no keyring daemon.
 */
export interface SecretsStatus {
  available: boolean;
  backend:
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "darwin"
    | "win32"
    | "linux"
    | "unknown"
    | string;
}

export interface DesktopLaunchSettings {
  /** Whether launch-at-login is configurable on this OS/build. */
  supported: boolean;
  openAtLogin: boolean;
  openAsHidden: boolean;
}

/** Low memory mode as the shell has it: what this launch runs, what the next will. */
export interface DesktopLowMemoryState {
  active: boolean;
  configured: boolean;
  restartRequired: boolean;
}

/** The shell's web track (electron/webUpdateChannel.js); see `WebUpdateChannel`. */
export interface DesktopWebUpdateState {
  channel: WebUpdateChannel;
  /** The signed site this run serves, or null for the bundle the app shipped with. */
  serving: { id: string; track: string; createdAt: number } | null;
  /** A newer site is downloaded and waits for a restart. */
  pending: boolean;
}

export type DesktopVideoEncoderMode = "compatibility" | "hardware";

export interface DesktopVideoEncoderState {
  available: boolean;
  active: DesktopVideoEncoderMode | null;
  configured: DesktopVideoEncoderMode | null;
  restartRequired?: boolean;
}

export interface DesktopHevcScreenShareCapability {
  available: boolean;
  encoder: string | null;
  backend: string | null;
  device: string | null;
  helperPath?: string | null;
  ffmpegPath?: string | null;
  reason: string | null;
}

export type DesktopHevcScreenShareState =
  | "idle"
  | "starting"
  | "published"
  | "error"
  | "stopped";

/** Live state emitted by the Linux FFmpeg/VA-API screen-share publisher. */
export interface DesktopHevcScreenShareStatus {
  state: DesktopHevcScreenShareState;
  active: boolean;
  sessionId?: string;
  backend?: string;
  encoder?: string;
  device?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
  framesReceived?: number;
  framesDropped?: number;
  inputFrameRate?: number;
  encodedBytes?: number;
  encodedBitrate?: number;
  pipelineStage?: string;
  error?: string;
  reason?: string;
}

export interface DesktopHevcScreenShareConfig {
  url: string;
  token: string;
  /** Exactly 32 sender-key bytes, base64 encoded. */
  keyMaterial: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

/**
 * The desktop shell's SQLite ArmadaDB store (main-process engine). `available`
 * is known synchronously at preload so the renderer can fall back to
 * IndexedDB; `call` dispatches one `ArmadaDbPlugin` method (see `ElectronArmadaDB.ts`).
 */
interface ArmadaDesktopDb {
  available: boolean;
  call: (op: string, payload?: unknown) => Promise<unknown>;
}

export interface DesktopPushToTalkBinding {
  code: string;
  label: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface DesktopPushToTalkStatus {
  supported: boolean;
  backend: "native" | "portal" | null;
  bindingLabel: string | null;
  reason: string | null;
  settingsAvailable?: boolean;
  settingsHint?: string | null;
}

interface ArmadaDesktopBridge {
  isDesktop: true;
  setBadge: (count: number) => void;
  getInfo: () => Promise<{ platform: string; version: string }>;
  // Optional members: newer bundles may run in older shells; feature-detect.
  onResume?: (handler: () => void) => () => void;
  onWindowHidden?: (handler: () => void) => () => void;
  onWindowVisibility?: (handler: (visible: boolean) => void) => () => void;
  getLaunchSettings?: () => Promise<DesktopLaunchSettings>;
  setLaunchSettings?: (settings: {
    openAtLogin: boolean;
    openAsHidden: boolean;
  }) => Promise<DesktopLaunchSettings>;
  fetchImage?: (url: string) => Promise<{ type: string; data: Uint8Array<ArrayBuffer> } | null>;
  /** A relay's `Date` and `Age`, which the page can't read cross-origin; null when it didn't answer. */
  httpDate?: (url: string) => Promise<{ date: string | null; age: string | null } | null>;
  getWebCacheSize?: () => Promise<number>;
  clearWebCache?: () => Promise<void>;
  getLowMemoryMode?: () => Promise<DesktopLowMemoryState>;
  setLowMemoryMode?: (on: boolean) => Promise<DesktopLowMemoryState>;
  relaunch?: () => Promise<void>;
  getWebUpdateChannel?: () => Promise<DesktopWebUpdateState | null>;
  setWebUpdateChannel?: (channel: WebUpdateChannel) => Promise<DesktopWebUpdateState | null>;
  getVideoEncoderMode?: () => Promise<DesktopVideoEncoderState>;
  setVideoEncoderMode?: (mode: DesktopVideoEncoderMode) => Promise<DesktopVideoEncoderState>;
  getHevcScreenShareCapability?: () => Promise<DesktopHevcScreenShareCapability>;
  getHevcScreenShareStatus?: () => Promise<DesktopHevcScreenShareStatus>;
  startHevcScreenShare?: (
    config: DesktopHevcScreenShareConfig,
  ) => Promise<DesktopHevcScreenShareStatus>;
  stopHevcScreenShare?: () => Promise<DesktopHevcScreenShareStatus>;
  onHevcScreenShareStatus?: (
    handler: (status: DesktopHevcScreenShareStatus) => void,
  ) => () => void;
  getScreenSources: () => Promise<ScreenSource[]>;
  onPickScreenSource: (handler: () => string | null | Promise<string | null>) => void;
  getLinuxShareAudioSources?: () => Promise<LinuxShareAudioSources>;
  startLinuxShareAudio?: (selection: LinuxShareAudioSelection) => Promise<boolean>;
  unmuteLinuxShareAudio?: () => Promise<boolean>;
  stopLinuxShareAudio?: () => Promise<void>;
  getMicAccessStatus: () => Promise<MicAccessStatus>;
  openMicPrivacySettings: () => Promise<boolean>;
  getScreenCaptureAccessStatus?: () => Promise<MicAccessStatus>;
  openScreenCapturePrivacySettings?: () => Promise<boolean>;
  configurePushToTalk?: (
    binding: DesktopPushToTalkBinding | null,
  ) => Promise<DesktopPushToTalkStatus>;
  openPushToTalkSystemSettings?: () => Promise<boolean>;
  setPushToTalkActive?: (active: boolean) => Promise<boolean>;
  onPushToTalkState?: (handler: (pressed: boolean) => void) => () => void;
  onPushToTalkStatus?: (handler: (status: DesktopPushToTalkStatus) => void) => () => void;
  getSecretsStatus?: () => Promise<SecretsStatus>;
  encryptSecret?: (plaintext: string) => Promise<string | null>;
  decryptSecret?: (base64: string) => Promise<string | null>;
  signalWebReady?: () => void;
  isWebUpdatePending?: () => Promise<boolean>;
  onWebUpdateReady?: (handler: () => void) => () => void;
  restartForWebUpdate?: () => void;
  // Renderer reports its App Links host; the shell returns router paths of caught links.
  registerDeepLinkHost?: (host: string) => void;
  onDeepLink?: (handler: (path: string) => void) => () => void;
  armadaDb?: ArmadaDesktopDb;
  requestAttention?: () => void;
}

declare global {
  interface Window {
    armadaDesktop?: ArmadaDesktopBridge;
  }
}

/** The desktop bridge, or undefined on the web. */
export function desktop(): ArmadaDesktopBridge | undefined {
  return typeof window !== "undefined" ? window.armadaDesktop : undefined;
}

/** True when running inside the Armada desktop app. */
export const isDesktop = (): boolean => Boolean(desktop()?.isDesktop);

// Bridge wrappers treat a failing shell as "no answer" rather than propagating.
export async function getDesktopLowMemoryState(): Promise<DesktopLowMemoryState | null> {
  try {
    return (await desktop()?.getLowMemoryMode?.()) ?? null;
  } catch {
    return null;
  }
}

/** Bytes in the shell's HTTP cache, or null where the shell can't say. */
export async function getDesktopWebCacheSize(): Promise<number | null> {
  try {
    return (await desktop()?.getWebCacheSize?.()) ?? null;
  } catch {
    return null;
  }
}

export async function clearDesktopWebCache(): Promise<void> {
  try {
    await desktop()?.clearWebCache?.();
  } catch { /* nothing cleared */ }
}

export async function setDesktopLowMemoryMode(on: boolean): Promise<DesktopLowMemoryState | null> {
  try {
    return (await desktop()?.setLowMemoryMode?.(on)) ?? null;
  } catch {
    return null;
  }
}

/** The web track's state, or null on the web, an older shell, or a store edition. */
export async function getDesktopWebUpdateState(): Promise<DesktopWebUpdateState | null> {
  try {
    return (await desktop()?.getWebUpdateChannel?.()) ?? null;
  } catch {
    return null;
  }
}

export async function setDesktopWebUpdateChannel(channel: WebUpdateChannel): Promise<DesktopWebUpdateState | null> {
  try {
    return (await desktop()?.setWebUpdateChannel?.(channel)) ?? null;
  } catch {
    return null;
  }
}

/** Whether the shell can read images for hosts that send no CORS headers. */
export function canFetchDesktopImages(): boolean {
  return typeof desktop()?.fetchImage === "function";
}

/** An image's bytes through the shell, for a host without CORS. Null on web/older shells. */
export async function fetchDesktopImage(url: string): Promise<Blob | null> {
  try {
    const out = await desktop()?.fetchImage?.(url);
    return out ? new Blob([out.data], { type: out.type }) : null;
  } catch {
    return null;
  }
}

/** Restart the desktop app. No-op on web/older shells. */
export function relaunchDesktop(): void {
  void desktop()?.relaunch?.()?.catch(() => {});
}

export async function getDesktopVideoEncoderState(): Promise<DesktopVideoEncoderState | null> {
  try {
    return (await desktop()?.getVideoEncoderMode?.()) ?? null;
  } catch (error) {
    console.warn("failed to read the desktop video encoder mode", error);
    return null;
  }
}

export async function setDesktopVideoEncoderMode(
  mode: DesktopVideoEncoderMode,
): Promise<DesktopVideoEncoderState | null> {
  try {
    return (await desktop()?.setVideoEncoderMode?.(mode)) ?? null;
  } catch (error) {
    console.warn("failed to set the desktop video encoder mode", error);
    return null;
  }
}

/** Subscribe to the shell's power-resume signal (wake/unlock). No-op on web/older shells. */
export function onDesktopResume(handler: () => void): () => void {
  try {
    return desktop()?.onResume?.(handler) ?? (() => {});
  } catch {
    return () => {};
  }
}

/** Subscribe to the window being shown or hidden/minimized. No-op on web/older shells. */
export function onDesktopWindowVisibility(handler: (visible: boolean) => void): () => void {
  try {
    return desktop()?.onWindowVisibility?.(handler) ?? (() => {});
  } catch {
    return () => {};
  }
}

/** Subscribe to the window being closed to the tray. No-op on web/older shells. */
export function onDesktopWindowHidden(handler: () => void): () => void {
  try {
    return desktop()?.onWindowHidden?.(handler) ?? (() => {});
  } catch {
    return () => {};
  }
}

/**
 * Call `handler` once when the shell has installed a newer web bundle this run,
 * whether that happened before or after subscribing. No-op on web/older shells.
 */
export function onDesktopWebUpdateReady(handler: () => void): () => void {
  const bridge = desktop();
  if (!bridge?.onWebUpdateReady) return () => {};
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    handler();
  };
  try {
    const unsubscribe = bridge.onWebUpdateReady(fire);
    bridge.isWebUpdatePending?.().then((pending) => {
      if (pending) fire();
    }, () => {});
    return () => {
      done = true;
      unsubscribe();
    };
  } catch {
    return () => {};
  }
}

export function restartForDesktopWebUpdate(): void {
  desktop()?.restartForWebUpdate?.();
}

/** Launch-at-login settings, or null on web/older shells (hide the control). */
export async function getDesktopLaunchSettings(): Promise<DesktopLaunchSettings | null> {
  try {
    return (await desktop()?.getLaunchSettings?.()) ?? null;
  } catch (error) {
    console.warn("failed to read the desktop launch settings", error);
    return null;
  }
}

export async function setDesktopLaunchSettings(settings: {
  openAtLogin: boolean;
  openAsHidden: boolean;
}): Promise<DesktopLaunchSettings | null> {
  try {
    return (await desktop()?.setLaunchSettings?.(settings)) ?? null;
  } catch (error) {
    console.warn("failed to set the desktop launch settings", error);
    return null;
  }
}

export async function desktopHevcScreenShareCapability(): Promise<DesktopHevcScreenShareCapability> {
  const bridge = desktop();
  if (!bridge?.getHevcScreenShareCapability) {
    return {
      available: false,
      encoder: null,
      backend: null,
      device: null,
      reason: t({ id: "desktop.hevcUnavailable", defaultMessage: "This Armada build does not contain the custom H.265 publisher." }),
    };
  }
  try {
    return await bridge.getHevcScreenShareCapability();
  } catch (error) {
    return {
      available: false,
      encoder: null,
      backend: null,
      device: null,
      reason: error instanceof Error ? error.message : t({ id: "desktop.hevcProbeFailed", defaultMessage: "The H.265 capability probe failed." }),
    };
  }
}

export function subscribeDesktopHevcScreenShareStatus(
  handler: (status: DesktopHevcScreenShareStatus) => void,
): () => void {
  return desktop()?.onHevcScreenShareStatus?.(handler) ?? (() => {});
}

let hevcFrameAbort: AbortController | null = null;
let hevcFramePort: MessagePort | null = null;
let hevcFrameGeneration = 0;
const pendingHevcPorts = new Map<string, MessagePort>();
const waitingHevcPorts = new Map<string, (port: MessagePort) => void>();

export function acceptDesktopHevcScreenShareFramePort(
  sessionId: string,
  port: MessagePort,
): void {
  port.start();
  const resolve = waitingHevcPorts.get(sessionId);
  if (resolve) {
    waitingHevcPorts.delete(sessionId);
    resolve(port);
    return;
  }
  try {
    pendingHevcPorts.get(sessionId)?.close();
  } catch {
    // already closed
  }
  pendingHevcPorts.set(sessionId, port);
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.type !== "armada:hevc-screen-share-port" ||
      typeof event.data.sessionId !== "string" ||
      !event.ports[0]
    ) {
      return;
    }
    acceptDesktopHevcScreenShareFramePort(event.data.sessionId, event.ports[0]);
  });
}

function waitForHevcFramePort(sessionId: string, signal: AbortSignal): Promise<MessagePort> {
  const pending = pendingHevcPorts.get(sessionId);
  if (pending) {
    pendingHevcPorts.delete(sessionId);
    if (signal.aborted) {
      try {
        pending.close();
      } catch {
        // already closed
      }
      return Promise.reject(new Error("The H.265 start was cancelled."));
    }
    return Promise.resolve(pending);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (port?: MessagePort, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      waitingHevcPorts.delete(sessionId);
      if (error) reject(error);
      else if (port) resolve(port);
    };
    const onPort = (port: MessagePort) => finish(port);
    const onAbort = () => finish(undefined, new Error("The H.265 start was cancelled."));
    const timeout = window.setTimeout(
      () => finish(undefined, new Error("The H.265 frame channel did not open.")),
      5_000,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    waitingHevcPorts.set(sessionId, onPort);
    if (signal.aborted) onAbort();
  });
}

function disposeHevcPreview(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch {
    // already detached
  }
  video.srcObject = null;
  video.remove();
}

function cancelHevcFramePump(): void {
  hevcFrameGeneration += 1;
  hevcFrameAbort?.abort();
  hevcFrameAbort = null;
}

function closeHevcFramePorts(): void {
  try {
    hevcFramePort?.close();
  } catch {
    // already closed
  }
  hevcFramePort = null;
  for (const port of pendingHevcPorts.values()) {
    try {
      port.close();
    } catch {
      // already closed
    }
  }
  pendingHevcPorts.clear();
  waitingHevcPorts.clear();
}

export function cancelDesktopHevcScreenShareFrames(): void {
  cancelHevcFramePump();
  closeHevcFramePorts();
}

function waitForVideoFrame(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let frameCallback = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeEventListener("error", onError);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("resize", onReady);
      track.removeEventListener("ended", onEnded);
      signal.removeEventListener("abort", onAbort);
      if (frameCallback && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(frameCallback);
      }
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(new Error(video.error?.message || "Chromium rejected the captured video track."));
    const onReady = () => {
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        finish();
      }
    };
    const onEnded = () => finish(new Error("The selected screen source ended before capture began."));
    const onAbort = () => finish(new Error("The H.265 start was cancelled."));
    const timeout = window.setTimeout(() => {
      const settings = track.getSettings();
      finish(new Error(
        `No captured video frame became available within 15 seconds (track=${track.readyState}, muted=${track.muted}, track-size=${settings.width ?? "?"}×${settings.height ?? "?"}, video=${video.videoWidth}×${video.videoHeight}, readyState=${video.readyState}).`,
      ));
    }, 15_000);

    video.addEventListener("error", onError, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("playing", onReady, { once: true });
    video.addEventListener("resize", onReady);
    track.addEventListener("ended", onEnded, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (typeof video.requestVideoFrameCallback === "function") {
      frameCallback = video.requestVideoFrameCallback(() => finish());
    }
    video.play().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    if (track.readyState !== "live") onEnded();
    onReady();
    if (signal.aborted) onAbort();
  });
}

async function copyHevcFrame(
  video: HTMLVideoElement,
  canvas: OffscreenCanvas,
  context: OffscreenCanvasRenderingContext2D,
  output: ArrayBuffer,
  config: Pick<DesktopHevcScreenShareConfig, "width" | "height">,
  signal: AbortSignal,
): Promise<void> {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    throw new Error("Chromium reported no current captured video frame.");
  }

  const source = new VideoFrame(video, { timestamp: Math.round(performance.now() * 1_000) });
  try {
    const sourceWidth = source.displayWidth || source.codedWidth;
    const sourceHeight = source.displayHeight || source.codedHeight;
    const scale = Math.min(config.width / sourceWidth, config.height / sourceHeight);
    const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
    const left = Math.floor((config.width - width) / 2);
    const top = Math.floor((config.height - height) / 2);
    const resize = sourceWidth !== config.width || sourceHeight !== config.height;
    let frame = source;
    let ownsFrame = false;
    if (resize) {
      context.fillStyle = "black";
      context.fillRect(0, 0, config.width, config.height);
      context.drawImage(source, left, top, width, height);
      frame = new VideoFrame(canvas, {
        timestamp: source.timestamp,
        ...(source.duration === null ? {} : { duration: source.duration }),
      });
      ownsFrame = true;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(new Error("The H.265 frame conversion was cancelled."));
        const timeout = window.setTimeout(
          () => finish(new Error("Chromium did not convert the captured frame within 10 seconds.")),
          10_000,
        );
        signal.addEventListener("abort", onAbort, { once: true });
        frame.copyTo(output, {
          format: "RGBA",
          layout: [{ offset: 0, stride: config.width * 4 }],
        }).then(() => finish(), (error) => finish(error instanceof Error ? error : new Error(String(error))));
        if (signal.aborted) onAbort();
      });
    } finally {
      if (ownsFrame) frame.close();
    }
  } finally {
    source.close();
  }
}

function postHevcFrame(
  port: MessagePort,
  frame: ArrayBuffer,
  sequence: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (accepted: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      port.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(accepted);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "frame-ack" && event.data.sequence === sequence) finish(true);
    };
    const onAbort = () => finish(false);
    const timeout = window.setTimeout(
      () => finish(false, new Error("FFmpeg did not accept a capture frame within 10 seconds.")),
      10_000,
    );
    port.addEventListener("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      // Electron 43 can't reliably transfer this ArrayBuffer through its main-process MessagePort; clone one reusable buffer.
      port.postMessage({ type: "frame", sequence, frame });
    } catch (error) {
      finish(false, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Convert the Chromium capture to bounded RGBA frames for the Linux
 * FFmpeg/VA-API publisher. Resolves only once real HEVC bytes are published.
 */
export async function startDesktopHevcScreenShare(
  track: MediaStreamTrack,
  config: DesktopHevcScreenShareConfig,
): Promise<DesktopHevcScreenShareStatus> {
  const bridge = desktop();
  if (!bridge?.startHevcScreenShare || !bridge.stopHevcScreenShare) {
    throw new Error("This Armada shell does not contain the custom H.265 publisher.");
  }
  if (
    typeof document === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    throw new Error("This desktop runtime cannot convert captured frames for H.265.");
  }

  const controller = new AbortController();
  const generation = ++hevcFrameGeneration;
  hevcFrameAbort?.abort();
  hevcFrameAbort = controller;
  await bridge.stopHevcScreenShare();
  closeHevcFramePorts();
  if (controller.signal.aborted || generation !== hevcFrameGeneration) {
    throw new Error("The H.265 start was cancelled.");
  }
  if (track.readyState !== "live") {
    if (hevcFrameAbort === controller) hevcFrameAbort = null;
    throw new Error("The selected screen source ended before capture began.");
  }
  track.contentHint = "detail";

  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:2px",
    "height:2px",
    "opacity:0.001",
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";");
  video.srcObject = new MediaStream([track]);
  document.body.appendChild(video);

  const canvas = new OffscreenCanvas(config.width, config.height);
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) {
    disposeHevcPreview(video);
    if (hevcFrameAbort === controller) hevcFrameAbort = null;
    throw new Error("Could not create the H.265 frame conversion canvas.");
  }
  const frameInterval = 1_000 / config.frameRate;
  const frame = new ArrayBuffer(config.width * config.height * 4);
  let shellStarted = false;
  let port: MessagePort | null = null;

  try {
    await waitForVideoFrame(video, track, controller.signal);
    await copyHevcFrame(video, canvas, context, frame, config, controller.signal);
    if (controller.signal.aborted || generation !== hevcFrameGeneration) {
      throw new Error("The H.265 start was cancelled.");
    }
    const started = await bridge.startHevcScreenShare(config);
    shellStarted = true;
    if (controller.signal.aborted || generation !== hevcFrameGeneration) {
      throw new Error("The H.265 start was superseded.");
    }
    if (!started.sessionId) {
      throw new Error("The H.265 encoder did not identify its frame channel.");
    }
    port = await waitForHevcFramePort(started.sessionId, controller.signal);
    hevcFramePort = port;
    port.postMessage({ type: "stage", stage: "Sending verified capture frame" });

    let sequence = 0;
    if (!await postHevcFrame(port, frame, ++sequence, controller.signal)) {
      throw new Error("The H.265 start was cancelled before its first frame was accepted.");
    }

    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const began = performance.now();
          if (
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.videoWidth === 0 ||
            video.videoHeight === 0
          ) {
            await new Promise((resolve) => window.setTimeout(resolve, 10));
            continue;
          }
          await copyHevcFrame(video, canvas, context, frame, config, controller.signal);
          if (!await postHevcFrame(port!, frame, ++sequence, controller.signal)) break;
          const remaining = frameInterval - (performance.now() - began);
          if (remaining > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, remaining));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[screen-share] H.265 frame conversion stopped", error);
          // postMessage on a closed port is a silent no-op, so stop unconditionally.
          try {
            port?.postMessage({
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // The stop below is the recovery either way.
          }
          void bridge.stopHevcScreenShare?.().catch((stopError) =>
            console.warn("[screen-share] failed to stop the H.265 publisher", stopError),
          );
        }
      } finally {
        disposeHevcPreview(video);
        if (hevcFrameAbort === controller) hevcFrameAbort = null;
        // The pump may end on its own; close the port before dropping the reference.
        if (hevcFramePort === port) {
          try {
            port?.close();
          } catch {
            // already closed
          }
          hevcFramePort = null;
        }
      }
    })();

    if (!bridge.getHevcScreenShareStatus) return started;
    const deadline = performance.now() + 20_000;
    while (!controller.signal.aborted && performance.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const status = await bridge.getHevcScreenShareStatus();
      if (status.state === "published" && (status.encodedBytes ?? 0) > 0) return status;
      if (status.state === "error") {
        throw new Error(status.error || "The H.265 pipeline failed before sending video.");
      }
    }
    if (controller.signal.aborted) {
      const status = await bridge.getHevcScreenShareStatus();
      throw new Error(status.error || status.reason || "The H.265 start was cancelled.");
    }
    throw new Error("The H.265 pipeline did not produce video within 20 seconds.");
  } catch (error) {
    controller.abort();
    try {
      port?.close();
    } catch {
      // already closed
    }
    if (hevcFramePort === port) hevcFramePort = null;
    disposeHevcPreview(video);
    if (shellStarted && generation === hevcFrameGeneration) {
      try {
        await bridge.stopHevcScreenShare();
      } catch {
        // Preserve the more useful pipeline failure.
      }
    }
    if (hevcFrameAbort === controller) hevcFrameAbort = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start the H.265 capture pipeline: ${detail}`);
  }
}

export async function stopDesktopHevcScreenShare(): Promise<DesktopHevcScreenShareStatus> {
  cancelHevcFramePump();
  const bridge = desktop();
  if (!bridge?.stopHevcScreenShare) {
    closeHevcFramePorts();
    return { state: "idle", active: false };
  }
  try {
    return await bridge.stopHevcScreenShare();
  } finally {
    closeHevcFramePorts();
  }
}

/**
 * Tell the desktop shell this bundle painted. Silence past its grace period
 * makes it look for a newer swappable bundle immediately (recovery is forward-only).
 */
export function signalDesktopWebReady(): void {
  try {
    desktop()?.signalWebReady?.();
  } catch {
    // Older shell or mid-shutdown bridge; never break first paint.
  }
}

/**
 * Tell the shell our share-link host so in-app clicks on those links route
 * internally instead of the browser. No-op on web/older shells.
 */
export function registerDesktopDeepLinkHost(host: string): void {
  try {
    desktop()?.registerDeepLinkHost?.(host);
  } catch {
    // Older shell: links open in the browser. Never break boot.
  }
}

/** Subscribe to deep-link router paths the shell intercepted. No-op on web/older shells. */
export function onDesktopDeepLink(handler: (path: string) => void): () => void {
  try {
    return desktop()?.onDeepLink?.(handler) ?? (() => {});
  } catch {
    return () => {};
  }
}

/**
 * Flash/bounce the window for attention without raising it (ignored while
 * focused). No-op on web/older shells.
 */
export function requestDesktopAttention(): void {
  try {
    desktop()?.requestAttention?.();
  } catch {
    // ignore
  }
}

/** Reflect the unread count on the tray / OS badge (no-op on web). */
export function setDesktopBadge(count: number): void {
  try {
    desktop()?.setBadge(count);
  } catch {
    // ignore
  }
}

/**
 * OS mic access. "granted" on web or without the bridge, so callers try
 * getUserMedia unless "denied"/"restricted".
 */
export async function desktopMicAccessStatus(): Promise<MicAccessStatus> {
  const bridge = desktop();
  if (!bridge?.getMicAccessStatus) return "granted";
  try {
    return await bridge.getMicAccessStatus();
  } catch {
    return "unknown";
  }
}

/** Open OS mic privacy settings (Windows/macOS); false if unsupported. */
export async function openDesktopMicSettings(): Promise<boolean> {
  const bridge = desktop();
  if (!bridge?.openMicPrivacySettings) return false;
  try {
    return await bridge.openMicPrivacySettings();
  } catch {
    return false;
  }
}

/** macOS Screen Recording privacy status; unknown elsewhere. */
export async function desktopScreenCaptureAccessStatus(): Promise<MicAccessStatus> {
  const bridge = desktop();
  if (!bridge?.getScreenCaptureAccessStatus) return "unknown";
  try {
    return await bridge.getScreenCaptureAccessStatus();
  } catch {
    return "unknown";
  }
}

/** Open macOS Privacy & Security at Screen Recording. */
export async function openDesktopScreenCaptureSettings(): Promise<boolean> {
  const bridge = desktop();
  if (!bridge?.openScreenCapturePrivacySettings) return false;
  try {
    return await bridge.openScreenCapturePrivacySettings();
  } catch {
    return false;
  }
}

/** Whether the shell can encrypt secrets with the OS credential store, and which backend. */
export async function desktopSecretsStatus(): Promise<SecretsStatus> {
  const bridge = desktop();
  if (!bridge?.getSecretsStatus) return { available: false, backend: "unknown" };
  try {
    return await bridge.getSecretsStatus();
  } catch {
    return { available: false, backend: "unknown" };
  }
}

/** Encrypt with the OS credential store; null when unavailable (callers store plaintext). */
export async function desktopEncryptSecret(plaintext: string): Promise<string | null> {
  const bridge = desktop();
  if (!bridge?.encryptSecret) return null;
  try {
    return await bridge.encryptSecret(plaintext);
  } catch {
    return null;
  }
}

/**
 * Decrypt from `desktopEncryptSecret`. Null means "locked", not "empty":
 * callers must preserve the ciphertext.
 */
export async function desktopDecryptSecret(base64: string): Promise<string | null> {
  const bridge = desktop();
  if (!bridge?.decryptSecret) return null;
  try {
    return await bridge.decryptSecret(base64);
  } catch {
    return null;
  }
}

let nextLinuxShareAudioGeneration = 1;
let linuxShareAudioGeneration: number | null = null;
// Set when the picker chose "No audio"; consumed by the next capture.
let shareAudioDeclined = false;
let displayMediaAudioInstalled = false;

export async function desktopShareAudioSources(): Promise<LinuxShareAudioSources> {
  const bridge = desktop();
  if (!bridge?.getLinuxShareAudioSources) {
    return { supported: false, reason: null, sources: [] };
  }
  try {
    return await bridge.getLinuxShareAudioSources();
  } catch {
    return { supported: false, reason: t({ id: "desktop.appAudioFailed", defaultMessage: "Application audio could not be loaded." }), sources: [] };
  }
}

export async function prepareDesktopShareAudio(
  selection: LinuxShareAudioSelection,
): Promise<boolean> {
  const bridge = desktop();
  if (!bridge?.startLinuxShareAudio) return false;
  try {
    const prepared = await bridge.startLinuxShareAudio(selection);
    shareAudioDeclined = false;
    linuxShareAudioGeneration = prepared ? nextLinuxShareAudioGeneration++ : null;
    return prepared;
  } catch {
    linuxShareAudioGeneration = null;
    return false;
  }
}

export async function stopDesktopShareAudio(): Promise<void> {
  return stopDesktopShareAudioGeneration();
}

/**
 * Mark the next capture as carrying no share audio. Teardown is deferred to
 * that capture since the picker may still be cancelled (acquire-before-replace).
 */
export function declineDesktopShareAudio(): void {
  shareAudioDeclined = true;
}

async function stopDesktopShareAudioGeneration(expected?: number): Promise<void> {
  if (expected !== undefined && linuxShareAudioGeneration !== expected) return;
  linuxShareAudioGeneration = null;
  try {
    await desktop()?.stopLinuxShareAudio?.();
  } catch {
    // Best effort: the shell also unlinks before starting the next share.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function findVenmicDevice(mediaDevices: MediaDevices): Promise<MediaDeviceInfo | null> {
  // PipeWire/Chromium discover the virtual source asynchronously; retry briefly
  // to avoid silently video-only shares.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const devices = await mediaDevices.enumerateDevices();
    const device = devices.find(
      (candidate) =>
        candidate.kind === "audioinput" && candidate.label === "vencord-screen-share",
    );
    if (device) return device;
    await wait(50);
  }
  return null;
}

/**
 * Attach venmic's PipeWire audio track to Electron's Linux display stream,
 * wrapping getDisplayMedia (which LiveKit calls directly) before React mounts.
 */
export function installDesktopDisplayMediaAudio(): void {
  if (displayMediaAudioInstalled || typeof navigator === "undefined") return;
  const bridge = desktop();
  const mediaDevices = navigator.mediaDevices;
  if (
    !bridge?.startLinuxShareAudio ||
    !bridge.unmuteLinuxShareAudio ||
    !bridge.stopLinuxShareAudio ||
    typeof mediaDevices?.getDisplayMedia !== "function"
  ) {
    return;
  }
  const unmuteLinuxShareAudio = bridge.unmuteLinuxShareAudio;

  displayMediaAudioInstalled = true;
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    const generationBeforeCapture = linuxShareAudioGeneration;
    let stream: MediaStream;
    try {
      stream = await originalGetDisplayMedia(constraints);
    } catch (error) {
      // Cancelling must leave the existing share's route; only tear down a NEW route.
      if (linuxShareAudioGeneration !== generationBeforeCapture) {
        await stopDesktopShareAudio();
      }
      throw error;
    }
    if (shareAudioDeclined) {
      // The capture succeeded, so the share this route belonged to is gone.
      shareAudioDeclined = false;
      await stopDesktopShareAudio();
      return stream;
    }
    const captureGeneration = linuxShareAudioGeneration;
    if (captureGeneration === null) {
      return stream;
    }
    if (constraints?.audio === false || stream.getAudioTracks().length > 0) {
      await stopDesktopShareAudioGeneration(captureGeneration);
      return stream;
    }

    try {
      const device = await findVenmicDevice(mediaDevices);
      if (!device) throw new Error("venmic virtual microphone did not appear");
      const audioStream = await mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: device.deviceId },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: 2,
          sampleRate: 48_000,
        },
      });
      const audioTrack = audioStream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("venmic returned no audio track");
      stream.addTrack(audioTrack);
      await unmuteLinuxShareAudio();

      let stopped = false;
      const stopAudio = () => {
        if (stopped) return;
        stopped = true;
        audioTrack.stop();
        void stopDesktopShareAudioGeneration(captureGeneration);
      };
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener("ended", stopAudio, { once: true });
        // stop() doesn't dispatch `ended` (LiveKit uses stop()); wrap so PipeWire unlinks.
        const stopVideo = videoTrack.stop.bind(videoTrack);
        videoTrack.stop = () => {
          stopAudio();
          stopVideo();
        };
      }
      audioTrack.addEventListener(
        "ended",
        () => void stopDesktopShareAudioGeneration(captureGeneration),
        { once: true },
      );
      return stream;
    } catch (error) {
      console.warn("[screen-share] failed to attach Linux application audio", error);
      // Scope the teardown: retries/stalls leave time for a newer share's route.
      await stopDesktopShareAudioGeneration(captureGeneration);
      return stream;
    }
  };
}
