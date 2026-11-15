/**
 * Native uses Capacitor Haptics: the Android WebView doesn't implement
 * `navigator.vibrate`. Web falls back to the Vibration API. Fire-and-forget.
 */

import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

const native = () => Capacitor.isNativePlatform();

function webVibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch { /* ignore */ }
}

/** A light selection tick — toggles, segmented controls, picking an item. */
export function selectionChanged(): void {
  if (native()) {
    void Haptics.selectionChanged().catch(() => undefined);
    return;
  }
  webVibrate(10);
}

/** A discrete impact — taps that commit an action, picking up a draggable. */
export function impact(style: "light" | "medium" | "heavy" = "medium"): void {
  if (native()) {
    const map = {
      light: ImpactStyle.Light,
      medium: ImpactStyle.Medium,
      heavy: ImpactStyle.Heavy,
    } as const;
    void Haptics.impact({ style: map[style] }).catch(() => undefined);
    return;
  }
  webVibrate(style === "heavy" ? 25 : style === "medium" ? 15 : 8);
}

/** A success/warning/error notification buzz. */
export function notify(type: "success" | "warning" | "error" = "success"): void {
  if (native()) {
    const map = {
      success: NotificationType.Success,
      warning: NotificationType.Warning,
      error: NotificationType.Error,
    } as const;
    void Haptics.notification({ type: map[type] }).catch(() => undefined);
    return;
  }
  webVibrate(type === "error" ? [10, 40, 10] : 20);
}
