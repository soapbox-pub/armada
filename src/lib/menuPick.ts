import type React from "react";

/** Finger travel past this between down and up is a scroll, not a pick. */
export const MENU_TAP_SLOP_PX = 10;

let pending: { pointerId: number; x: number; y: number } | null = null;

/**
 * Pointer handlers for a row in a menu floating over the composer.
 *
 * Pointer-down is always `preventDefault`ed so the composer keeps focus (and the
 * on-screen keyboard stays up). A mouse picks on press; a finger or pen picks on
 * release, so a drag can scroll the list — the browser fires `pointercancel`
 * when it takes the gesture for panning, and a release past the slop is dropped.
 */
export function menuPickHandlers(onPick: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        pending = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button > 0) return; // secondary/middle press
      onPick();
    },
    onPointerUp: (e: React.PointerEvent) => {
      const start = pending;
      if (!start || start.pointerId !== e.pointerId) return;
      pending = null;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MENU_TAP_SLOP_PX) return;
      onPick();
    },
    onPointerCancel: (e: React.PointerEvent) => {
      if (pending?.pointerId === e.pointerId) pending = null;
    },
  };
}
