import { useSyncExternalStore } from "react";

/**
 * Reduce motion: the app's own switch, OR'd with the OS's
 * `prefers-reduced-motion`. Whenever either holds, `<html>` carries
 * `data-reduce-motion`, which `index.css` reads to stop animations, transitions,
 * smooth scrolling and backdrop blur, and JS reads through {@link reducedMotion}
 * to skip canvas scenes and freeze animated media. Device-wide like the text
 * size, for the same reasons. `public/theme.js` applies it before first paint.
 */
export const REDUCE_MOTION_KEY = "armada:reduce-motion";
export const REDUCE_MOTION_ATTR = "data-reduce-motion";

function readSetting(): boolean {
  try {
    return localStorage.getItem(REDUCE_MOTION_KEY) === "1";
  } catch {
    return false;
  }
}

const media: MediaQueryList | undefined =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;

let setting = readSetting();
let system = media?.matches ?? false;
const listeners = new Set<() => void>();

function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(REDUCE_MOTION_ATTR, setting || system);
}

function changed(): void {
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
  return setting || system;
}

/** Whether the OS asks for reduced motion, which the app switch cannot override. */
export function systemReducesMotion(): boolean {
  return system;
}

/** The app's own switch, separate from the OS setting. */
export function getReduceMotionSetting(): boolean {
  return setting;
}

export function setReduceMotionSetting(on: boolean): void {
  if (on === setting) return;
  setting = on;
  try {
    if (on) localStorage.setItem(REDUCE_MOTION_KEY, "1");
    else localStorage.removeItem(REDUCE_MOTION_KEY);
  } catch {
    // Private-mode/quota: the choice still holds for this session.
  }
  changed();
}

/** Notified when {@link reducedMotion} may have changed. Returns an unsubscribe. */
export function onReducedMotionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** {@link reducedMotion}, re-rendering when it changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, reducedMotion);
}

/** The app switch, re-rendering when it or the OS setting changes. */
export function useReduceMotionSetting(): { setting: boolean; system: boolean } {
  const s = useSyncExternalStore(onReducedMotionChange, getReduceMotionSetting);
  const sys = useSyncExternalStore(onReducedMotionChange, systemReducesMotion);
  return { setting: s, system: sys };
}

/** Formats that never animate. Anything else might: GIF, WebP, APNG behind `.png`, or a `blob:`/hash URL. */
const STILL_EXTENSIONS = /\.(jpe?g|svg|bmp|ico)(?:[?#]|$)/i;

/** Whether an image URL could be animated, so must be frozen while motion is reduced. */
export function mayAnimate(src: string | undefined): boolean {
  return Boolean(src) && !STILL_EXTENSIONS.test(src!);
}

/** `"smooth"` unless motion is reduced. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? "auto" : "smooth";
}
