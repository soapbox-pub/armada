/**
 * Native uses Capacitor Haptics: the Android WebView doesn't implement
 * `navigator.vibrate`. Web falls back to the Vibration API. Fire-and-forget.
 * Scaled by the user's `AppConfig.hapticIntensity`, pushed here by `AppProvider`.
 */

import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

import type { HapticIntensity } from "@/contexts/AppContext";

const native = () => Capacitor.isNativePlatform();

let intensity: HapticIntensity = "medium";

export function setHapticIntensity(value: HapticIntensity): void {
  intensity = value;
}

type Style = "light" | "medium" | "heavy";
const STYLES: Style[] = ["light", "medium", "heavy"];

/** Native styles have no amplitude, so low/high shift a style one step instead. */
function shifted(style: Style): Style {
  const step = intensity === "low" ? -1 : intensity === "high" ? 1 : 0;
  return STYLES[Math.max(0, Math.min(STYLES.length - 1, STYLES.indexOf(style) + step))];
}

const WEB_SCALE: Record<HapticIntensity, number> = { off: 0, low: 0.5, medium: 1, high: 2 };

function webVibrate(pattern: number | number[]): void {
  const scale = WEB_SCALE[intensity];
  // Only the pulses scale; the gaps between them keep the pattern's rhythm.
  const scaled = Array.isArray(pattern)
    ? pattern.map((ms, i) => (i % 2 === 0 ? Math.max(1, Math.round(ms * scale)) : ms))
    : Math.max(1, Math.round(pattern * scale));
  try {
    navigator.vibrate?.(scaled);
  } catch { /* ignore */ }
}

function nativeImpact(style: Style): void {
  const map = {
    light: ImpactStyle.Light,
    medium: ImpactStyle.Medium,
    heavy: ImpactStyle.Heavy,
  } as const;
  void Haptics.impact({ style: map[style] }).catch(() => undefined);
}

/** A light selection tick — toggles, segmented controls, picking an item. */
export function selectionChanged(): void {
  if (intensity === "off") return;
  if (native()) {
    if (intensity === "high") nativeImpact("light");
    else void Haptics.selectionChanged().catch(() => undefined);
    return;
  }
  webVibrate(10);
}

/** A discrete impact — taps that commit an action, picking up a draggable. */
export function impact(style: Style = "medium"): void {
  if (intensity === "off") return;
  if (native()) {
    nativeImpact(shifted(style));
    return;
  }
  webVibrate(style === "heavy" ? 25 : style === "medium" ? 15 : 8);
}

/** A success/warning/error notification buzz. */
export function notify(type: "success" | "warning" | "error" = "success"): void {
  if (intensity === "off") return;
  if (native()) {
    if (intensity === "low") {
      nativeImpact("light");
      return;
    }
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
