import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { isRouterPath } from "@/lib/deepLinkUrl";

import type { MediaPolicyConfig } from "@/lib/mediaPolicy";

/**
 * Bridge to `ArmadaPushPlugin.swift` (iOS APNs). iOS can't run a background
 * relay listener, so the APNs token goes to the same content-blind nostr-push2
 * gateway as web (an `apn` connection); see `useIosPush.ts`. No Android
 * version: no Play Services, and its background service is better anyway.
 */

/** Whether the OS has been asked, and what it said. */
export type NativePushPermission = "granted" | "denied" | "default";

/** What `register()` returns once APNs has minted (or refused) a token. */
export interface NativePushRegistration {
  granted: boolean;
  /** The APNs device token, lowercase hex. Absent when not granted / failed. */
  token?: string;
  /** The app's bundle id, which becomes the gateway's `apns-topic`. */
  bundleId?: string;
  /** APNs host from the build's `aps-environment`; a token is valid on exactly one host. */
  environment?: "sandbox" | "production";
  /** Why no token, when `granted` is true but APNs still refused. */
  error?: string;
}

/** A notification tap, as an in-app router path. */
export interface NativePushOpen {
  path?: string;
}

export interface ArmadaPushPlugin {
  permission(): Promise<{ status: NativePushPermission }>;
  /** Prompt (iOS shows it once per install) and register with APNs. No user-gesture requirement. */
  register(): Promise<NativePushRegistration>;
  unregister(): Promise<void>;
  /** Clear the app icon badge and any delivered notifications. */
  clearBadge(): Promise<void>;
  /** Config for the Notification Service Extension; JSON, see `IosPushConfig`. */
  writeConfig(options: { config: string }): Promise<void>;
  /** Delete that config, on disable or logout. */
  clearConfig(): Promise<void>;
  /**
   * Record the last gateway registration outcome on disk for debugging
   * (otherwise unobservable). `line` is a status and must never carry a token or key.
   */
  recordStatus(options: { line: string }): Promise<void>;
  /** The tap that cold-launched this process (buffered by the plugin), consumed once; `{}` otherwise. */
  takePendingOpen(): Promise<NativePushOpen>;
  /** The route on screen, so a push about that room arrives without a banner. */
  setActiveRoute(options: { path: string }): Promise<void>;
  /** A notification tapped while the app was already running. */
  addListener(
    eventName: "pushOpened",
    listener: (data: NativePushOpen) => void,
  ): Promise<PluginListenerHandle>;
}

export const ArmadaPush = registerPlugin<ArmadaPushPlugin>("ArmadaPush");

/**
 * What the Notification Service Extension needs to open an inlined event; same
 * shape as `SwPushConfig`. No display data (read from ArmadaDB at push time).
 * `sk` only for nsec logins; bunker logins send `nip46` (a smaller secret);
 * NIP-07 logins send neither.
 */
export interface IosPushConfig {
  policy: string;
  /** Global DM fallback; exact `dmLevels` entries override it. */
  directMessages: boolean;
  /** Exact canonical NIP-17 conversation levels (group keys stay intact). */
  dmLevels?: Record<string, "all" | "mentions" | "nothing">;
  /**
   * Running timed mutes on DMs by room key (`dm:<conversation>`) → epoch seconds
   * they end; the extension drops a DM until then, as it does one at `nothing`.
   */
  roomMutes?: Record<string, number>;
  self: string;
  knownPeers: string[];
  /** Exact authored/pinned NIP-17 conversation keys (groups stay exact). */
  knownConversations?: string[];
  /** Peers whose presence suppresses their whole DM conversation. */
  mutedPeers?: string[];
  sk?: string;
  nip46?: { clientSk: string; bunkerPubkey: string; relays: string[] };
  concord?: Array<{
    pk: string;
    convKey: string;
    epoch: string;
    communityId: string;
    channelId: string;
    /** Banned authors (CORD-04, hex); the extension drops their messages after decrypt. */
    banned?: string[];
    /**
     * The gateway can't filter encrypted wraps, so the extension suppresses messages
     * that don't `#p`-tag the user. Mirrors Android's `mentionOnly`.
     */
    mentionOnly?: boolean;
    /** Muted: kept with its key so a lingering subscription's wrap is opened and dropped, not shown as fallback text. */
    muted?: boolean;
  }>;
  /** Media policy for avatar fetches; absent = default policy. */
  mediaPolicy?: MediaPolicyConfig;
  /** The app's language code; the extension words notifications in it (absent = English). */
  locale?: string;
}

export async function writeIosPushConfig(config: IosPushConfig): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.writeConfig({ config: JSON.stringify(config) });
}

/** Called on disable and logout, so no key outlives its session. */
export async function clearIosPushConfig(): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.clearConfig().catch(() => {});
}

/** Best-effort one-line registration status; never throws. Keep secrets out of `line`. */
export async function recordPushStatus(line: string): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.recordStatus({ line }).catch(() => {});
}

/** Best-effort; never throws. */
export async function reportActiveRoute(path: string): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.setActiveRoute({ path }).catch(() => {});
}

/** iOS with the plugin present (not `isNativePlatform()`: Android would hit an empty proxy). */
export function hasIosPush(): boolean {
  return Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("ArmadaPush");
}

/** The cold-launch notification tap as a router path (a push tap produces no launch URL). Null without the plugin. */
export async function takePendingPushOpen(): Promise<string | null> {
  if (!hasIosPush()) return null;
  const { path } = await ArmadaPush.takePendingOpen();
  return path && isRouterPath(path) ? path : null;
}
