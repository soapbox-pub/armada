import { useCallback, useRef, useState } from "react";

import { selectionChanged } from "@/lib/haptics";

/**
 * Swipe-to-reply: a LEFTWARD drag past `THRESHOLD` calls `onSwipe`. Left, so it never collides
 * with the rightward pane-reveal swipe (`useEdgeSwipe`) on the same surface. Horizontal must exceed
 * 2× vertical; rows should set `touch-action: pan-y`. Haptic pulse when the threshold is crossed.
 */

const THRESHOLD = 60;
const MAX_DRAG = 100;
const HORIZONTAL_RATIO = 2;

/**
 * Lightboxes portal outside the row, but a touch armed before one opened keeps driving this
 * row's gesture underneath it; bail whenever one is present.
 */
function isLightboxOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector("[data-lightbox-content]") !== null
  );
}

export interface UseSwipeToReplyResult {
  /** Positive magnitude; apply as `translateX(-offset)`. */
  offset: number;
  /** Disables the spring-back transition. */
  dragging: boolean;
  /** For icon opacity. */
  pastThreshold: boolean;
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
}

/** @param enabled Set to `false` on non-touch devices to skip all touch handling. */
export function useSwipeToReply(
  onSwipe: () => void,
  enabled: boolean,
): UseSwipeToReplyResult {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Refs avoid re-renders during the drag.
  const startX = useRef(0);
  const startY = useRef(0);
  const active = useRef(false);
  const horizontal = useRef(false);
  const vibrated = useRef(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || isLightboxOpen()) return;
      const touch = e.touches[0];
      if (!touch) return;
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      active.current = true;
      horizontal.current = false;
      vibrated.current = false;
      // Don't set dragging yet — wait until we know it's horizontal.
    },
    [enabled],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || !active.current) return;
      // A lightbox opened mid-gesture: disarm so we don't reply underneath it.
      if (isLightboxOpen()) {
        active.current = false;
        horizontal.current = false;
        setDragging(false);
        setOffset(0);
        return;
      }
      const touch = e.touches[0];
      if (!touch) return;

      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;

      if (!horizontal.current) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx < 5 && absDy < 5) return; // wait for real movement
        if (absDx > absDy * HORIZONTAL_RATIO && dx < 0) {
          horizontal.current = true;
          setDragging(true);
        } else {
          // Vertical (scroll) or rightward (pane reveal, see useEdgeSwipe): bail.
          active.current = false;
          return;
        }
      }

      const clamped = Math.max(0, Math.min(-dx, MAX_DRAG));
      setOffset(clamped);

      if (clamped >= THRESHOLD && !vibrated.current) {
        vibrated.current = true;
        selectionChanged();
      }
    },
    [enabled],
  );

  // The system back gesture pilfers an edge swipe mid-drag; spring back, never reply.
  const onTouchCancel = useCallback(() => {
    active.current = false;
    horizontal.current = false;
    setDragging(false);
    setOffset(0);
  }, []);

  const onTouchEnd = useCallback(
    () => {
      if (!enabled || !active.current) {
        active.current = false;
        horizontal.current = false;
        setDragging(false);
        setOffset(0);
        return;
      }

      const triggered = offset >= THRESHOLD && !isLightboxOpen();
      active.current = false;
      horizontal.current = false;
      setDragging(false);
      setOffset(0);

      if (triggered) {
        onSwipe();
      }
    },
    [enabled, offset, onSwipe],
  );

  return {
    offset,
    dragging,
    pastThreshold: offset >= THRESHOLD,
    touchHandlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
  };
}
