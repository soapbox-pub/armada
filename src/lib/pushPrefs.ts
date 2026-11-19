/**
 * Account-global notification preferences shared by every notification path
 * (nostr-push, Android service, in-app notifier, level resolver). Stored in
 * encrypted account settings, mirrored to localStorage for the service worker
 * and Android service.
 */

import type { WebPushUnavailableReason } from "@/lib/webPushSupport";
import { accountScopedKey, getActivePubkey } from "@/lib/activeAccount";

const PUSH_PREFS_KEY = "armada:push-prefs";

function pushPrefsKey(pubkey?: string | null): string {
  return accountScopedKey(PUSH_PREFS_KEY, pubkey === undefined ? getActivePubkey() : pubkey);
}

/**
 * Notification mode for DMs from unknown senders (who control the text, name
 * and avatar): `off`, `generic` (content-blind "message request" ping, the
 * default), or `full`. Only applies when `directMessages` is on.
 */
export type DmRequestLevel = "off" | "generic" | "full";

/** Discord-style per-type notification preferences. */
export interface PushPrefs {
  mentions: boolean;
  reactions: boolean;
  replies: boolean;
  directMessages: boolean;
  /** Every group message, not just mentions. Default on. */
  allGroupMessages: boolean;
  /** Default `generic`. */
  dmRequests: DmRequestLevel;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  mentions: true,
  reactions: true,
  replies: true,
  directMessages: true,
  allGroupMessages: true,
  dmRequests: "generic",
};

/** Read the account-global per-type prefs from localStorage, defaults merged. */
export function loadPushPrefs(pubkey?: string | null): PushPrefs {
  try {
    const raw = localStorage.getItem(pushPrefsKey(pubkey));
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PUSH_PREFS };
}

/** Persist the local mirror consumed by background notification runtimes. */
export function savePushPrefs(next: PushPrefs, pubkey?: string | null): void {
  try {
    localStorage.setItem(pushPrefsKey(pubkey), JSON.stringify(next));
  } catch { /* ignore */ }
}

/** What a push-notifications hook hands the settings UI. */
export interface UsePushNotificationsReturn {
  supported: boolean;
  /** Which layer is unavailable, so the UI doesn't blame the OS for every failure. */
  unavailableReason?: WebPushUnavailableReason;
  /** Whether the service worker and VAPID key are ready for a gesture-bound subscribe. */
  ready: boolean;
  error?: string;
  /** Brave's push service is switched off, so subscribing cannot succeed (see `bravePush.ts`). */
  pushServiceOff?: boolean;
  /** Push was enabled, but the browser forgot a session-only permission (Brave's default). */
  permissionExpired?: boolean;
  permission: NotificationPermission;
  enabled: boolean;
  busy: boolean;
  prefs: PushPrefs;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  setPrefs: (next: PushPrefs) => Promise<void>;
  retry: () => void;
}
