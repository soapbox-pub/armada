import { useSyncExternalStore } from "react";

/**
 * Motion and effects, device-wide like the text size (the login screen needs
 * them too, and a phone and a desktop rarely want the same). Four switches:
 *
 * - `motion`: the app's switch OR'd with the OS's `prefers-reduced-motion`,
 *   which the app cannot turn off. Marks `<html>` with `data-reduce-motion`
 *   (animations, transitions, smooth scrolling; `index.css`) and gates canvas
 *   scenes and other JS animation through {@link reducedMotion}.
 * - `media`: animated images show their first frame, GIFs play on hover or tap.
 * - `blur`: `data-reduce-blur` drops backdrop blur.
 * - `flair`: Ultra avatar halos and profile effects are hidden.
 *
 * `media` and `blur` follow `motion` until set, so one switch is still the
 * whole package. `public/theme.js` applies the two attributes before first paint.
 */
export const REDUCE_MOTION_KEY = "armada:reduce-motion";
export const STILL_MEDIA_KEY = "armada:still-media";
export const REDUCE_BLUR_KEY = "armada:reduce-blur";
export const HIDE_FLAIR_KEY = "armada:hide-flair";
export const EFFECT_KEYS = [REDUCE_MOTION_KEY, STILL_MEDIA_KEY, REDUCE_BLUR_KEY, HIDE_FLAIR_KEY] as const;

export const REDUCE_MOTION_ATTR = "data-reduce-motion";
export const REDUCE_BLUR_ATTR = "data-reduce-blur";

/** `true`/`false` when set, `undefined` when following the default. */
function readFlag(key: string): boolean | undefined {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : undefined;
  } catch {
    return undefined;
  }
}

function writeFlag(key: string, value: boolean | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Private-mode/quota: the choice still holds for this session.
  }
}

const media: MediaQueryList | undefined =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;

let motionSetting = readFlag(REDUCE_MOTION_KEY) === true;
let mediaSetting = readFlag(STILL_MEDIA_KEY);
let blurSetting = readFlag(REDUCE_BLUR_KEY);
let flairSetting = readFlag(HIDE_FLAIR_KEY) === true;
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

/** Whether motion should be reduced now: the app switch or the OS setting. */
export function reducedMotion(): boolean {
  return motionSetting || system;
}

/** Whether animated images and GIFs hold still. */
export function stillMedia(): boolean {
  return mediaSetting ?? reducedMotion();
}

/** Whether backdrop blur is off. */
export function reducedBlur(): boolean {
  return blurSetting ?? reducedMotion();
}

/** Whether Ultra avatar halos and profile effects are hidden. */
export function hiddenFlair(): boolean {
  return flairSetting;
}

/** Whether the OS asks for reduced motion, which the app switch cannot override. */
export function systemReducesMotion(): boolean {
  return system;
}

export function setReduceMotionSetting(on: boolean): void {
  if (on === motionSetting) return;
  motionSetting = on;
  writeFlag(REDUCE_MOTION_KEY, on || undefined);
  changed();
}

/**
 * Set a switch that follows Reduce motion until chosen. Choosing what it would
 * follow anyway clears the choice, so it keeps following later changes.
 */
function setFollowing(key: string, on: boolean, assign: (value: boolean | undefined) => void): void {
  const value = on === reducedMotion() ? undefined : on;
  assign(value);
  writeFlag(key, value);
  changed();
}

export function setStillMediaSetting(on: boolean): void {
  setFollowing(STILL_MEDIA_KEY, on, (v) => (mediaSetting = v));
}

export function setReduceBlurSetting(on: boolean): void {
  setFollowing(REDUCE_BLUR_KEY, on, (v) => (blurSetting = v));
}

export function setHideFlairSetting(on: boolean): void {
  if (on === flairSetting) return;
  flairSetting = on;
  writeFlag(HIDE_FLAIR_KEY, on || undefined);
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

/** {@link stillMedia}, re-rendering when it changes. */
export function useStillMedia(): boolean {
  return useSyncExternalStore(onReducedMotionChange, stillMedia);
}

/** {@link hiddenFlair}, re-rendering when it changes. */
export function useHiddenFlair(): boolean {
  return useSyncExternalStore(onReducedMotionChange, hiddenFlair);
}

export interface EffectSettings {
  /** The app's Reduce motion switch, separate from the OS setting. */
  motion: boolean;
  system: boolean;
  media: boolean;
  blur: boolean;
  flair: boolean;
}

let snapshot: { revision: number; value: EffectSettings } | undefined;

function effectSettings(): EffectSettings {
  if (snapshot?.revision !== revision) {
    snapshot = {
      revision,
      value: { motion: motionSetting, system, media: stillMedia(), blur: reducedBlur(), flair: flairSetting },
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
