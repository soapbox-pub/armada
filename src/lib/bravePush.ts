/**
 * Brave runs Chromium's push client, which talks to Google's push service, and
 * ships it switched off ("Use Google services for push messaging"). With it off
 * `PushManager.subscribe()` can only fail, and nothing short of subscribing
 * reveals that, so the outcome is remembered per device.
 */

const PUSH_OFF_KEY = "armada:brave-push-service-off";

/** Brave's UA is Chrome's; `navigator.brave` is the only reliable tell. */
export function isBrave(): boolean {
  return typeof navigator !== "undefined" && "brave" in navigator;
}

/** What Chromium rejects `subscribe()` with when it has no push service to register with. */
export function isPushServiceUnavailable(err: unknown): boolean {
  if (!isBrave() || typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return name === "AbortError" && typeof message === "string" && /push service/i.test(message);
}

export function bravePushServiceOff(): boolean {
  if (!isBrave()) return false;
  try {
    return localStorage.getItem(PUSH_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBravePushServiceOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(PUSH_OFF_KEY, "1");
    else localStorage.removeItem(PUSH_OFF_KEY);
  } catch { /* ignore */ }
}
