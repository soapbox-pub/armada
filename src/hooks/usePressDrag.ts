import { useCallback, useEffect, useRef, useState } from "react";

import { cancelPressUnder, isCancellingPress } from "@/lib/cancelPress";
import { holdTimeout } from "@/lib/holdTimeout";
import { impact } from "@/lib/haptics";

/** How long a press rests before it becomes a drag, on every pointer type. */
const PICKUP_MS = 300;
/** Movement that picks up at once where moving picks up (mouse; every pointer on a handle). */
const MOVE_PICKUP_PX = 5;
/** Past this much movement, a touch that started on an entry is a scroll. */
const SCROLL_SLOP_PX = 10;
/**
 * A pickup that never travels past this from the origin is a held tap: no drop, and the click
 * must still navigate.
 */
const DRAG_MOVE_SLOP_PX = 10;
/** Travel that turns a menu hold into a drag; the finger is already settled, so less is needed. */
const HOLD_DRAG_SLOP_PX = 6;
/** Edge auto-scroll zone while dragging; speed ramps up to {@link EDGE_SCROLL_MAX_PX} at the edge. */
const EDGE_SCROLL_ZONE_PX = 56;
const EDGE_SCROLL_MAX_PX = 14;
/** Floor so it never stalls sub-pixel. */
const EDGE_SCROLL_MIN_PX = 2;
/** Trailing window for release velocity, so one jittery sample doesn't decide the fling. */
const FLING_WINDOW_MS = 100;
const FLING_REST_MS = 50;
const FLING_MIN_VELOCITY = 0.1;
const FLING_MAX_VELOCITY = 8;
/** Exponential decay time constant (ms); coast distance is velocity × this. */
const FLING_DECAY_MS = 325;
const FLING_STOP_VELOCITY = 0.02;
/** px/ms; a tap that stops a slower fling still clicks. */
const FLING_CATCH_VELOCITY = 0.3;

/**
 * Touches this hook has claimed, as a hand-panned scroll or a drag, for `useEdgeSwipe`
 * (MeshPage's rail is inside its pane).
 */
const handScrolling = new Set<number>();

export function isHandScrolling(pointerId: number): boolean {
  return handScrolling.has(pointerId);
}

export interface PressDragOptions<T> {
  /** Owned by the caller and populated by `attachContainer`. */
  containerRef: React.MutableRefObject<HTMLElement | null>;
  /**
   * Called once at pickup; the rendered order must not change during a drag, so this
   * geometry holds for the whole gesture.
   */
  onPickup: (source: T, x: number, y: number) => void;
  onAim: (source: T, x: number, y: number) => void;
  onDrop: (source: T) => void;
  /** The browser reclaimed the pointer: abort WITHOUT applying. */
  onAbort: () => void;
  /** Called before the re-aim after an auto-scroll, so frozen geometry can be re-measured. */
  onContainerScroll?: () => void;
  /**
   * Which pointers pick up by moving rather than only by holding. `"mouse"` (default) keeps
   * touch's long-press, where early movement is a scroll; `"all"` is for a dedicated drag
   * handle, which has nothing else to do with a moving finger.
   */
  pickupOnMove?: "mouse" | "all";
  /**
   * What a touch hold on an entry does. `"drag"` (default) picks it up; `"menu"` leaves the
   * hold to the entry's long-press menu and the touch to native scrolling, and a touch drags
   * only an entry {@link arm}ed first (its menu's "Move"). Armed entries need `touch-action: none`.
   */
  touchHold?: "drag" | "menu";
  /**
    * Under `touchHold: "drag"`, a touch hold opens the entry's context menu (a `contextmenu` at
    * the finger) instead of picking up; travelling then closes it and picks up, as Discord's
    * server list does. Released still, the menu stays open and the press does not click.
    */
  heldTouchOpensMenu?: boolean;
}

/**
 * Press-and-hold drag for the server rail and channel sidebar. Gesture only; slots and drops
 * are the caller's. Non-obvious parts:
 * - The touchmove canceller is permanent on the container: Chrome decides at touchstart whether a
 *   blocking listener applies, so one added mid-gesture is ignored and the browser pans anyway.
 * - Entries carry `touch-action: none` unconditionally, so scrolls starting on one are panned and
 *   flung here by hand.
 * - Attach `begin` natively via {@link useDragPointerDown}: Radix `asChild` Slots don't reliably
 *   forward React pointer props.
 * A mouse picks up as soon as it moves (or after the hold); early touch movement becomes a scroll.
 */
export function usePressDrag<T>({
  containerRef,
  onPickup,
  onAim,
  onDrop,
  onAbort,
  onContainerScroll,
  pickupOnMove = "mouse",
  touchHold = "drag",
  heldTouchOpensMenu = false,
}: PressDragOptions<T>) {
  const [source, setSource] = useState<T | null>(null);
  /** The entry a touch may drag under `touchHold: "menu"`; ref for listeners. */
  const [armed, setArmed] = useState<T | null>(null);
  const armedRef = useRef<T | null>(null);
  const arm = useCallback((from: T) => {
    armedRef.current = from;
    setArmed(from);
  }, []);
  const disarm = useCallback(() => {
    armedRef.current = null;
    setArmed(null);
  }, []);
  /** The pointerdown `press` last handled, so a press anywhere else disarms. */
  const lastPress = useRef<PointerEvent | null>(null);
  /** Read inside listeners where state would be stale. */
  const active = useRef<T | null>(null);
  const timer = useRef<(() => void) | null>(null);
  /** Set briefly after a drag so the ensuing click doesn't navigate/toggle. */
  const didDrag = useRef(false);
  const flingRaf = useRef<number | null>(null);
  /** Set while the press that caught a fling is down, so its tap doesn't click. */
  const caughtFling = useRef(false);
  // Ref keeps listeners current and `begin` stable.
  const handlers = useRef({ onPickup, onAim, onDrop, onAbort, onContainerScroll });
  handlers.current = { onPickup, onAim, onDrop, onAbort, onContainerScroll };

  const panning = useRef(false);
  /** Each live gesture's teardown, so unmount mid-gesture detaches its window listeners and rAF. */
  const liveGestures = useRef(new Set<() => void>());

  // Also while panning: from an uncancelled fast lift Chromium starts an invisible fling, even
  // under `touch-action: none`, and drops the next tap as its cancel.
  const onTouchMove = useCallback((ev: TouchEvent) => {
    if ((active.current !== null || panning.current) && ev.cancelable) ev.preventDefault();
  }, []);

  /** Swallow the click the browser synthesizes after this pointerup. */
  const suppressClick = useCallback(() => {
    didDrag.current = true;
    setTimeout(() => {
      didDrag.current = false;
    }, 300);
  }, []);

  const flingVelocity = useRef(0);

  /** True if the fling was still visibly moving. */
  const stopFling = useCallback(() => {
    if (flingRaf.current === null) return false;
    cancelAnimationFrame(flingRaf.current);
    flingRaf.current = null;
    return Math.abs(flingVelocity.current) >= FLING_CATCH_VELOCITY;
  }, []);

  /** `velocity` in scroll px/ms, positive downward. */
  const fling = useCallback(
    (velocity: number) => {
      stopFling();
      let v = Math.max(-FLING_MAX_VELOCITY, Math.min(FLING_MAX_VELOCITY, velocity));
      flingVelocity.current = v;
      let last = performance.now();
      const tick = () => {
        const el = containerRef.current;
        const now = performance.now();
        const dt = now - last;
        last = now;
        const decay = Math.exp(-dt / FLING_DECAY_MS);
        // Integral over the frame, so coast length is frame-rate independent.
        const distance = v * FLING_DECAY_MS * (1 - decay);
        v *= decay;
        flingVelocity.current = v;
        if (!el) {
          flingRaf.current = null;
          return;
        }
        const before = el.scrollTop;
        el.scrollTop = before + distance;
        // Hit an end (or a rounded-away sub-pixel step).
        if (Math.abs(v) < FLING_STOP_VELOCITY || (el.scrollTop === before && Math.abs(distance) >= 1)) {
          flingRaf.current = null;
          return;
        }
        flingRaf.current = requestAnimationFrame(tick);
      };
      if (Math.abs(v) >= FLING_MIN_VELOCITY) flingRaf.current = requestAnimationFrame(tick);
    },
    [containerRef, stopFling],
  );

  // Capture phase, before an entry's `begin`; the catching tap must not click.
  const onContainerPointerDown = useCallback(() => {
    caughtFling.current = stopFling();
    if (!caughtFling.current) return;
    const release = () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      // Outlive the click the browser synthesizes after pointerup.
      setTimeout(() => {
        caughtFling.current = false;
      }, 300);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }, [stopFling]);

  /**
   * Callback ref: the container may mount after the hook (behind a loading gate), and an effect
   * reading a null ref would silently leave the canceller off.
   */
  const attachContainer = useCallback(
    (el: HTMLElement | null) => {
      containerRef.current?.removeEventListener("touchmove", onTouchMove);
      containerRef.current?.removeEventListener("pointerdown", onContainerPointerDown, true);
      if (containerRef.current !== el) stopFling();
      containerRef.current = el;
      el?.addEventListener("touchmove", onTouchMove, { passive: false });
      el?.addEventListener("pointerdown", onContainerPointerDown, true);
    },
    [containerRef, onTouchMove, onContainerPointerDown, stopFling],
  );

  /** For a {@link panFrom} surface outside the container. */
  const panSurface = useRef<HTMLElement | null>(null);
  const attachPanSurface = useCallback(
    (el: HTMLElement | null) => {
      panSurface.current?.removeEventListener("touchmove", onTouchMove);
      panSurface.current = el;
      el?.addEventListener("touchmove", onTouchMove, { passive: false });
    },
    [onTouchMove],
  );

  // Grabbing cursor only while picked up; a grab-on-hover hand confuses people.
  const dragging = source !== null;
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragging]);

  /** `from` null: scroll only. */
  const press = useCallback(
    (from: T | null, e: PointerEvent) => {
      // Only left mouse / touch / pen.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      lastPress.current = e;
      const isMouse = e.pointerType === "mouse";
      const armedHere = from !== null && armedRef.current !== null && armedRef.current === from;
      if (from !== null && !armedHere) disarm();
      // Hold opens the entry's menu and the touch scrolls natively.
      if (touchHold === "menu" && !isMouse && from !== null && !armedHere) return;
      // Normally already caught by the container's own listener.
      stopFling();
      const pointerId = e.pointerId;
      const pressTarget = e.target;
      const movePicks = from !== null && (isMouse || pickupOnMove === "all" || armedHere);
      const startX = e.clientX;
      const startY = e.clientY;
      // Pick up at the cursor rather than the press point.
      let lastX = startX;
      let lastY = startY;
      let manualScroll = false;
      let lastScrollY = startY;
      let scrollSamples: { t: number; y: number }[] = [];
      // Across the whole gesture, including the hold; a pickup that never moved far is a held tap.
      let everMovedFar = false;
      /**
       * A touch hold showing the entry's menu ({@link PressDragOptions.heldTouchOpensMenu}):
       * nothing is picked up until the finger travels.
       */
      let held = false;
      let menuOpen = false;
      let openingMenu = false;
      let pressCancelled = false;
      let autoScrollRaf: number | null = null;

      const stopAutoScroll = () => {
        if (autoScrollRaf !== null) cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
      };

      // No pointer events fire while still, so the edge scroll runs its own frame loop;
      // onContainerScroll lets the caller re-measure frozen geometry.
      const autoScrollTick = () => {
        autoScrollRaf = requestAnimationFrame(autoScrollTick);
        if (active.current === null) return;
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Never let the two zones overlap on a short container.
        const zone = Math.min(EDGE_SCROLL_ZONE_PX, rect.height / 2);
        const fromTop = lastY - rect.top;
        const fromBottom = rect.bottom - lastY;
        let delta = 0;
        if (fromTop < zone && el.scrollTop > 0) {
          const ramp = (zone - Math.max(0, fromTop)) / zone;
          delta = -Math.max(EDGE_SCROLL_MIN_PX, ramp * EDGE_SCROLL_MAX_PX);
        } else if (fromBottom < zone && el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
          const ramp = (zone - Math.max(0, fromBottom)) / zone;
          delta = Math.max(EDGE_SCROLL_MIN_PX, ramp * EDGE_SCROLL_MAX_PX);
        }
        if (delta === 0) return;
        const before = el.scrollTop;
        el.scrollTop = before + delta;
        if (el.scrollTop === before) return;
        handlers.current.onContainerScroll?.();
        handlers.current.onAim(active.current, lastX, lastY);
      };

      const clear = () => {
        liveGestures.current.delete(clear);
        timer.current?.();
        timer.current = null;
        stopAutoScroll();
        handScrolling.delete(pointerId);
        panning.current = false;
        if (armedHere) disarm();
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("contextmenu", onContextMenu, true);
      };

      // Swallow the touch long-press context menu mid-drag (it would open an entry's Radix menu).
      const onContextMenu = (ev: Event) => {
        if ((active.current !== null || held) && !openingMenu) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!everMovedFar && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_MOVE_SLOP_PX) {
          everMovedFar = true;
        }
        if (active.current === null) {
          lastX = ev.clientX;
          lastY = ev.clientY;
          if (held) {
            if (ev.cancelable) ev.preventDefault();
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= HOLD_DRAG_SLOP_PX) return;
            everMovedFar = true;
            // Travelling turns the menu hold into a drag.
            held = false;
            if (menuOpen) closeOpenMenu();
            menuOpen = false;
            pickup();
            return;
          }
          // Entries are `touch-action: none`, so pan the container by hand.
          if (manualScroll) {
            const el = containerRef.current;
            if (el) el.scrollTop -= ev.clientY - lastScrollY;
            lastScrollY = ev.clientY;
            const t = performance.now();
            scrollSamples.push({ t, y: ev.clientY });
            scrollSamples = scrollSamples.filter((s) => t - s.t <= FLING_WINDOW_MS);
            return;
          }
          if (movePicks) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > MOVE_PICKUP_PX) {
              // A drag from its first pixels: releasing close by is still a drop, not a click.
              everMovedFar = true;
              pickup();
            }
            return;
          }
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > SCROLL_SLOP_PX) {
            // A clearly sideways move is a drawer swipe (`useEdgeSwipe`), not a scroll: let go.
            if (Math.abs(ev.clientX - startX) > Math.abs(ev.clientY - startY) * 2) {
              clear();
              return;
            }
            // Early touch movement is a scroll; hand the rest to the manual panner.
            timer.current?.();
            timer.current = null;
            manualScroll = true;
            panning.current = true;
            handScrolling.add(pointerId);
            lastScrollY = ev.clientY;
            scrollSamples = [{ t: performance.now(), y: ev.clientY }];
          }
          return;
        }
        if (ev.cancelable) ev.preventDefault();
        lastX = ev.clientX;
        lastY = ev.clientY;
        handlers.current.onAim(active.current, ev.clientX, ev.clientY);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dragged = active.current;
        active.current = null;
        clear();
        setSource(null);
        if (manualScroll) {
          // Fling from the trailing window's velocity, unless the finger rested first.
          const now = performance.now();
          const first = scrollSamples[0];
          const last = scrollSamples[scrollSamples.length - 1];
          if (first && last && last.t > first.t && now - last.t <= FLING_REST_MS) {
            fling(-(last.y - first.y) / (last.t - first.t));
          }
        }
        // The menu the hold opened stays up and replaces the click.
        if (held) {
          if (menuOpen) suppressClick();
          return;
        }
        if (dragged === null) return;
        // A held tap, not a reorder: abort and let the click navigate.
        if (!everMovedFar) {
          handlers.current.onAbort();
          return;
        }
        try {
          handlers.current.onDrop(dragged);
        } catch (err) {
          // A failed drop must never wedge drag state or leave listeners attached.
          console.error("Failed to apply drop:", err);
        }
        suppressClick();
      };

      // The browser reclaimed the pointer: abort without applying.
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || isCancellingPress()) return;
        active.current = null;
        clear();
        setSource(null);
        handlers.current.onAbort();
      };

      // Capture: claim the scroll before `useEdgeSwipe` sees the same move.
      window.addEventListener("pointermove", onMove, { passive: false, capture: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("contextmenu", onContextMenu, true);
      liveGestures.current.add(clear);

      function pickup() {
        timer.current?.();
        timer.current = null;
        if (active.current !== null || from === null) return;
        active.current = from;
        handScrolling.add(pointerId);
        cancelEntryPress();
        handlers.current.onPickup(from, lastX, lastY);
        setSource(from);
        if (isMouse || !heldTouchOpensMenu) impact("medium");
        autoScrollTick();
      }

      // The drag (or menu hold) prevents the moves the entry's long-press menu clears on.
      function cancelEntryPress() {
        if (isMouse || pressCancelled) return;
        pressCancelled = true;
        cancelPressUnder(pressTarget, null, pointerId, e.pointerType);
      }

      /** Show the entry's menu, holding the touch still claimed so travelling can still drag. */
      function holdForMenu() {
        timer.current = null;
        held = true;
        panning.current = true;
        handScrolling.add(pointerId);
        cancelEntryPress();
        openingMenu = true;
        try {
          menuOpen = openMenuAt(pressTarget, lastX, lastY);
        } finally {
          openingMenu = false;
        }
        impact("medium");
      }

      // A touch that became a scroll cleared the timer. An armed entry moves to pick up,
      // leaving a still hold to its menu.
      if (from !== null && !armedHere) {
        timer.current = holdTimeout(heldTouchOpensMenu && !isMouse ? holdForMenu : pickup, PICKUP_MS);
      }
    },
    [containerRef, fling, stopFling, pickupOnMove, touchHold, heldTouchOpensMenu, disarm, suppressClick],
  );

  const begin = useCallback((from: T) => (e: PointerEvent) => press(from, e), [press]);

  /** Scroll-only press from a `touch-action: none` surface off any entry; true if it caught a fling. */
  const panFrom = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") return false;
      const caught = stopFling();
      press(null, e);
      return caught;
    },
    [press, stopFling],
  );

  // A press that reached no entry (outside, or on the list's chrome) leaves move mode.
  useEffect(() => {
    if (armed === null) return;
    const onDown = (e: PointerEvent) => {
      if (lastPress.current !== e) disarm();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [armed, disarm]);

  /** A drag just finished, or the tap only caught a fling. */
  const shouldSuppressClick = useCallback(() => didDrag.current || caughtFling.current, []);

  useEffect(() => {
    const gestures = liveGestures.current;
    return () => {
      active.current = null;
      for (const clear of [...gestures]) clear();
      timer.current?.();
      stopFling();
    };
  }, [stopFling]);

  return { attachContainer, attachPanSurface, begin, panFrom, source, dragging, shouldSuppressClick, armed, arm, disarm };
}

/** Open the context menu (Radix's `ContextMenuTrigger`) of the entry under `target`. */
function openMenuAt(target: EventTarget | null, clientX: number, clientY: number): boolean {
  if (!(target instanceof Element) || !target.isConnected) return false;
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY });
  target.dispatchEvent(ev);
  // Radix's trigger prevents the event it opens on.
  return ev.defaultPrevented;
}

/** Dismiss the open Radix menu the way its Escape does; it prevents the key, so page-level Escape handlers skip it. */
function closeOpenMenu() {
  const menu = document.querySelector("[role='menu'][data-state='open']");
  menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

/** Radix `asChild` Slots don't reliably forward React pointer props. */
export function useDragPointerDown(
  ref: React.RefObject<HTMLElement | null>,
  draggable: boolean | undefined,
  onDragPointerDown: ((e: PointerEvent) => void) | undefined,
) {
  const handlerRef = useRef(onDragPointerDown);
  handlerRef.current = onDragPointerDown;
  useEffect(() => {
    const el = ref.current;
    if (!el || !draggable) return;
    const handler = (e: PointerEvent) => handlerRef.current?.(e);
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [ref, draggable]);
}
