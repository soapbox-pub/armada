/**
 * Android notification delivery style, shared between the FCM push path
 * (useFcmNotifications) and the persistent foreground-service path
 * (useNativeNotifications), plus the settings UI.
 *
 *  - "persistent": Armada holds a foreground-service relay connection and fires
 *    notifications instantly. No Google. Covers groups + Concord + DMs, but
 *    keeps a service running (battery cost).
 *  - "push": FCM via the shared nostr-push server. Battery-free, OS-delivered,
 *    but only covers what the server can match/deliver (DMs + Concord as a
 *    generic "New message"); requires Firebase configured in the build.
 *
 * Web/PWA ignore this entirely (they use Web Push).
 */

export type NotificationStyle = "persistent" | "push";

const STYLE_KEY = "armada:notification-style";

/** Default to the fully-featured, no-Google path. */
export const DEFAULT_NOTIFICATION_STYLE: NotificationStyle = "persistent";

export function loadNotificationStyle(): NotificationStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (raw === "push" || raw === "persistent") return raw;
  } catch {
    // ignore
  }
  return DEFAULT_NOTIFICATION_STYLE;
}

export function saveNotificationStyle(style: NotificationStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    // ignore
  }
}
