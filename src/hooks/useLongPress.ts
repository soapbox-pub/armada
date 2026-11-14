import { useCallback, useEffect, useRef } from "react";

import { holdTimeout } from "@/lib/holdTimeout";

/**
 * Deliberately under the platform long-press (~500ms on Android/iOS): a tie loses the gesture
 * to the OS, which cancels our pointer stream.
 */
export const LONG_PRESS_MS = 400;

/** Generous: a resting thumb wanders. */
export const LONG_PRESS_SLOP_PX = 16;

/** Interactive descendants own their presses, so they must not also open the row's menu. */
const INTERACTIVE = "button, a, input, textarea, select, [role='button'], [role='menuitem']";

/**
 * Press-and-hold for touch only (pointer devices use hover toolbar / right-click).
 * Disqualified by travel past {@link LONG_PRESS_SLOP_PX}, or a `pointercancel` before the threshold
 * (how a scroll presents: the browser claims the pan inside its own smaller slop). A cancel whose
 * timestamps already span the threshold still fires (platform confiscating a completed hold).
 * While armed, the stream is watched on the WINDOW: an ancestor may take pointer capture
 * (`useEdgeSwipe`), retargeting the rest away from this element.
 * `allowInteractive` lifts the interactive-descendant guard (e.g. a message image).
 */
export function useLongPress(
  onLongPress: (() => void) | undefined,
  { allowInteractive = false }: { allowInteractive?: boolean } = {},
) {
  const timer = useRef<(() => void) | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  // So the click and context menu after release don't act on top of the menu.
  const fired = useRef(false);
  // Hardware timestamp: a main-thread stall can deliver down+up together and cancel the timer,
  // so release consults event times.
  const downStamp = useRef(0);
  const unwatch = useRef<(() => void) | null>(null);
  // Ref so window listeners call the current callback without re-binding.
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = useCallback(() => {
    timer.current?.();
    timer.current = null;
    origin.current = null;
    unwatch.current?.();
    unwatch.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const handleMove = useCallback(
    (x: number, y: number) => {
      if (!timer.current || !origin.current) return;
      if (Math.hypot(x - origin.current.x, y - origin.current.y) > LONG_PRESS_SLOP_PX) cancel();
    },
    [cancel],
  );

  /**
   * A hold whose timestamps span the threshold fires late (stalled release, or the platform
   * confiscating it); shorter just disarms.
   */
  const handleEnd = useCallback(
    (timeStamp: number) => {
      if (callback.current && timer.current && timeStamp - downStamp.current >= LONG_PRESS_MS) {
        cancel();
        fired.current = true;
        callback.current();
        return;
      }
      cancel();
    },
    [cancel],
  );

  /**
   * Capture-phase window listeners so pointer capture or stopPropagation can't strand the
   * timer. Scoped to the arming pointer.
   */
  const watch = useCallback(
    (id: number | undefined) => {
      unwatch.current?.();
      const mine = (e: PointerEvent) =>
        id === undefined || e.pointerId === undefined || e.pointerId === id;
      const onMove = (e: PointerEvent) => {
        if (mine(e)) handleMove(e.clientX, e.clientY);
      };
      const onEnd = (e: PointerEvent) => {
        if (mine(e)) handleEnd(e.timeStamp);
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onEnd, true);
      window.addEventListener("pointercancel", onEnd, true);
      unwatch.current = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onEnd, true);
        window.removeEventListener("pointercancel", onEnd, true);
      };
    },
    [handleMove, handleEnd],
  );

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (!onLongPress || e.pointerType !== "touch") return;
      // Portaled overlays (a lightbox) bubble here through the React tree.
      if (e.currentTarget instanceof Node && e.target instanceof Node && !e.currentTarget.contains(e.target)) return;
      if (!allowInteractive && (e.target as HTMLElement).closest(INTERACTIVE)) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      downStamp.current = e.timeStamp;
      timer.current?.();
      timer.current = holdTimeout(() => {
        timer.current = null;
        cancel();
        fired.current = true;
        callback.current?.();
      }, LONG_PRESS_MS);
      watch(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => handleMove(e.clientX, e.clientY),
    onPointerUp: (e: React.PointerEvent) => handleEnd(e.timeStamp),
    onPointerCancel: (e: React.PointerEvent) => handleEnd(e.timeStamp),
    onClick: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e: React.MouseEvent) => {
      // Suppress the platform's long-press callout on top of our sheet.
      if (fired.current) e.preventDefault();
    },
  };
}
