import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { usePressDrag } from "@/hooks/usePressDrag";

export interface ChannelDropSlot {
  index: number;
  /** Undefined is the uncategorized run. */
  category: string | undefined;
  y: number;
  newCategory?: boolean;
}

export interface ChannelDrop {
  index: number;
  category: string | undefined;
  newCategory?: boolean;
}

/**
 * Channel-shaped half of the sidebar drag; the gesture is {@link usePressDrag}
 * (shared with the server rail). Rows carry `touch-none` while a mouse could drag
 * them and while armed; an unarmed row scrolls natively on touch.
 *
 * With `handle`, presses come from a dedicated `touch-none` grip instead: every
 * pointer picks up by moving, and the rest of the row is left to scroll.
 */
export function useChannelDrag({
  enabled,
  columnRef,
  boundsRef,
  measure,
  onDrop,
  handle = false,
}: {
  enabled: boolean;
  /** The scroller the drag pans at its edges. */
  columnRef: React.MutableRefObject<HTMLElement | null>;
  /** What the drop indicator spans, where that isn't the scroller itself. */
  boundsRef?: React.RefObject<HTMLElement | null>;
  measure: () => ChannelDropSlot[];
  onDrop: (sourceIdHex: string, drop: ChannelDrop) => void;
  handle?: boolean;
}) {
  const [target, setTarget] = useState<ChannelDrop | null>(null);
  const [indicatorY, setIndicatorY] = useState<number | null>(null);
  const [columnX, setColumnX] = useState<{ left: number; width: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const slots = useRef<ChannelDropSlot[]>([]);
  const targetRef = useRef<ChannelDrop | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  // Ref so a new closure from the caller doesn't re-run the re-measure.
  const measureRef = useRef(measure);
  measureRef.current = measure;

  const aim = useCallback((_source: string, x: number, y: number) => {
    lastPoint.current = { x, y };
    setPointer({ x, y });
    let best: ChannelDropSlot | null = null;
    let bestDistance = Infinity;
    for (const slot of slots.current) {
      const distance = Math.abs(slot.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slot;
      }
    }
    if (!best) return;
    targetRef.current = { index: best.index, category: best.category, newCategory: best.newCategory };
    setTarget(targetRef.current);
    setIndicatorY(best.y);
  }, []);

  const finish = useCallback(() => {
    const landed = targetRef.current;
    targetRef.current = null;
    slots.current = [];
    setTarget(null);
    setIndicatorY(null);
    setColumnX(null);
    setPointer(null);
    return landed;
  }, []);

  const drag = usePressDrag<string>({
    containerRef: columnRef,
    onPickup: (idHex, x, y) => {
      slots.current = measure();
      const rect = (boundsRef?.current ?? columnRef.current)?.getBoundingClientRect();
      setColumnX(rect ? { left: rect.left, width: rect.width } : null);
      aim(idHex, x, y);
    },
    onAim: aim,
    onDrop: (idHex) => {
      const landed = finish();
      if (landed) onDrop(idHex, landed);
    },
    onAbort: finish,
    // Slots are frozen in viewport coords; edge auto-scroll moves rows, so re-measure.
    onContainerScroll: () => {
      slots.current = measureRef.current();
    },
    // Touch on a row: a hold opens the row's menu, whose "Move" arms the row.
    touchHold: handle ? "drag" : "menu",
    pickupOnMove: handle ? "all" : "mouse",
  });

  /** Re-measure once the "new category" zone mounts (it only exists mid-drag). */
  useLayoutEffect(() => {
    if (!drag.dragging) return;
    slots.current = measureRef.current();
    const at = lastPoint.current;
    if (at) aim("", at.x, at.y);
  }, [drag.dragging, aim]);

  const onPointerDown = useCallback(
    (idHex: string) => (e: React.PointerEvent) => {
      // Synthetic events bubble through portals (menus the row opened), so only
      // accept presses in the row's own DOM subtree.
      if (!e.currentTarget.contains(e.target as Node)) return;
      if (enabled) drag.begin(idHex)(e.nativeEvent);
    },
    [enabled, drag],
  );

  return {
    sourceIdHex: drag.source,
    dragging: drag.dragging,
    target,
    indicatorY,
    columnX,
    pointer,
    attachColumn: drag.attachContainer,
    shouldSuppressClick: drag.shouldSuppressClick,
    /** The row a touch may drag (armed by its menu's "Move"). */
    armedIdHex: drag.armed,
    arm: drag.arm,
    onPointerDown,
  };
}
