import { useSyncExternalStore } from "react";

import { isTrayResting, onTrayRest } from "@/lib/trayRest";

/**
 * Reduce effects, device-wide like the text size (the login screen needs it
 * too, and a phone and a desktop rarely want the same). One master switch;
 * while it is on, four parts each apply unless switched off:
 *
 * - `motion`: animations, transitions, smooth scrolling (`data-reduce-motion`
 *   on `<html>`, read by `index.css`; JS reads {@link reducedMotion}).
 * - `media`: animated images show their first frame, GIFs play on hover or tap.
 * - `blur`: `data-reduce-blur` drops backdrop blur.
 * - `flair`: Ultra avatar halos and profile effects are hidden.
 *
 * The OS's `prefers-reduced-motion` turns the master on and forces `motion`,
 * which the app cannot override. `public/theme.js` applies both attributes
 * before first paint.
 */
export const REDUCE_EFFECTS_KEY = "armada:reduce-effects";
const PART_KEYS = {
  motion: "armada:reduce-motion",
  media: "armada:still-media",
  blur: "armada:reduce-blur",
  flair: "armada:hide-flair",
} as const;
export type EffectPart = keyof typeof PART_KEYS;
export const EFFECT_KEYS = [REDUCE_EFFECTS_KEY, ...Object.values(PART_KEYS)] as const;

export const REDUCE_MOTION_ATTR = "data-reduce-motion";
export const REDUCE_BLUR_ATTR = "data-reduce-blur";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private-mode/quota: the choice still holds for this session.
  }
}

const media: MediaQueryList | undefined =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;

let master = read(REDUCE_EFFECTS_KEY) === "1";
/** Parts switched off under the master; stored as "0", absent means on. */
const excluded = new Set<EffectPart>(
  (Object.keys(PART_KEYS) as EffectPart[]).filter((part) => read(PART_KEYS[part]) === "0"),
);
let system = media?.matches ?? false;
/** Bumped on every change, so snapshot hooks re-render once per change. */
let revision = 0;
const listeners = new Set<() => void>();

function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(REDUCE_MOTION_ATTR, reducedMotion());
  document.documentElement.toggleAttribute(REDUCE_BLUR_ATTR, reducedBlur());
}

function changed(): void {
  revision++;
  apply();
  for (const listener of listeners) listener();
}

media?.addEventListener?.("change", (e) => {
  system = e.matches;
  changed();
});
apply();

/** Whether the master switch is in effect: set here, or forced by the OS. */
function enabled(): boolean {
  return master || system;
}

function part(p: EffectPart): boolean {
  return enabled() && !excluded.has(p);
}

/** Whether motion should be reduced now. The OS setting always forces it. */
export function reducedMotion(): boolean {
  return system || part("motion");
}

/** Whether animated images and GIFs hold still. */
export function stillMedia(): boolean {
  return part("media");
}

/** Whether backdrop blur is off. */
export function reducedBlur(): boolean {
  return part("blur");
}

/** Whether Ultra avatar halos and profile effects are hidden. */
export function hiddenFlair(): boolean {
  return part("flair");
}

/** Whether the OS asks for reduced motion, which the app cannot override. */
export function systemReducesMotion(): boolean {
  return system;
}

export function setReduceEffects(on: boolean): void {
  if (on === master) return;
  master = on;
  write(REDUCE_EFFECTS_KEY, on ? "1" : undefined);
  changed();
}

/** Include or leave out one part while the master is on. */
export function setEffectPart(p: EffectPart, on: boolean): void {
  if (on === !excluded.has(p)) return;
  if (on) excluded.delete(p);
  else excluded.add(p);
  write(PART_KEYS[p], on ? undefined : "0");
  changed();
}

/** Notified when any of these may have changed. Returns an unsubscribe. */
export function onReducedMotionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** {@link reducedMotion}, re-rendering when it changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, reducedMotion);
}

function onStillMediaChange(listener: () => void): () => void {
  const offMotion = onReducedMotionChange(listener);
  const offRest = onTrayRest(listener);
  return () => {
    offMotion();
    offRest();
  };
}

/**
 * {@link stillMedia}, or the desktop window resting out of sight: the
 * compositor animates GIFs on its own, drawing frames for a hidden window.
 */
export function useStillMedia(): boolean {
  return useSyncExternalStore(onStillMediaChange, () => stillMedia() || isTrayResting());
}

/**
 * {@link stillMedia} alone, for what is cached per setting (thumbnails): a
 * rest flip must not re-make every mounted image.
 */
export function useStillMediaSetting(): boolean {
  return useSyncExternalStore(onReducedMotionChange, stillMedia);
}

/** {@link hiddenFlair}, re-rendering when it changes. */
export function useHiddenFlair(): boolean {
  return useSyncExternalStore(onReducedMotionChange, hiddenFlair);
}

export interface EffectSettings {
  /** The master switch as it applies: set here, or forced by the OS. */
  enabled: boolean;
  system: boolean;
  motion: boolean;
  media: boolean;
  blur: boolean;
  flair: boolean;
}

let snapshot: { revision: number; value: EffectSettings } | undefined;

function effectSettings(): EffectSettings {
  if (snapshot?.revision !== revision) {
    snapshot = {
      revision,
      value: { enabled: enabled(), system, motion: reducedMotion(), media: stillMedia(), blur: reducedBlur(), flair: hiddenFlair() },
    };
  }
  return snapshot.value;
}

/** Every switch's current effect, for the settings page. */
export function useEffectSettings(): EffectSettings {
  return useSyncExternalStore(onReducedMotionChange, effectSettings);
}

/** Formats that never animate. Anything else might: GIF, WebP, APNG behind `.png`, or a `blob:`/hash URL. */
const STILL_EXTENSIONS = /\.(jpe?g|svg|bmp|ico)(?:[?#]|$)/i;

/** Whether an image URL could be animated, so must be frozen while media is still. */
export function mayAnimate(src: string | undefined): boolean {
  return Boolean(src) && !STILL_EXTENSIONS.test(src!);
}

/** `"smooth"` unless motion is reduced. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? "auto" : "smooth";
}
