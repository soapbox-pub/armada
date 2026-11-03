import { useRef } from "react";

/** Two taps this close in time and place are one double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
/** A tap is short and still; anything longer or further is a hold, scroll or swipe. */
const TAP_MAX_MS = 250;
const TAP_SLOP_PX = 10;

/** Controls and media keep their own taps. */
const OWN_TAPS = "a, button, input, textarea, select, img, video, audio, iframe, [contenteditable], [role=button], [role=menuitem]";

/**
 * Double-tap on touch, from pointer events. Returns handlers to compose with
 * the element's own; `onDoubleTap` undefined disarms it.
 */
export function useDoubleTap(onDoubleTap: (() => void) | undefined) {
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTap = useRef<{ x: number; y: number; t: number } | null>(null);
  const callback = useRef(onDoubleTap);
  callback.current = onDoubleTap;

  return {
    onPointerDown: (e: React.PointerEvent) => {
      // React bubbles events out of portals (a lightbox, a dialog) into the row.
      const inside = !(e.currentTarget instanceof Node && e.target instanceof Node) || e.currentTarget.contains(e.target);
      down.current = e.pointerType === "touch" && callback.current && inside ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const start = down.current;
      down.current = null;
      if (!start || !callback.current) return;
      if (e.currentTarget instanceof Node && e.target instanceof Node && !e.currentTarget.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest(OWN_TAPS)) return;
      if (e.timeStamp - start.t > TAP_MAX_MS || Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP_PX) {
        lastTap.current = null;
        return;
      }
      const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      const prev = lastTap.current;
      if (prev && tap.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(tap.x - prev.x, tap.y - prev.y) <= DOUBLE_TAP_SLOP_PX) {
        lastTap.current = null;
        callback.current();
        return;
      }
      lastTap.current = tap;
    },
  };
}
