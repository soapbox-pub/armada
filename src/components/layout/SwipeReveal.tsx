import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import { PaneCoveredContext, setPaneCovered } from "@/contexts/PaneCoveredContext";
import { leaveApp, useAndroidBack } from "@/hooks/useAndroidBack";
import { useEdgeSwipe } from "@/hooks/useEdgeSwipe";
import { useIsTouch } from "@/hooks/useIsMobile";
import { onAppStateChange } from "@/lib/appStateEvents";
import { isRecentDeepLinkNavigation } from "@/lib/deepLinkNav";
import { cn } from "@/lib/utils";
import { viewportWidth } from "@/lib/viewportWidth";

const SETTLE_MS = 200;
/** Bounds of a gesture's settle animation, scaled by the distance left. */
const SETTLE_MIN_MS = 90;
const SETTLE_MAX_MS = 250;

/** Parallax shift of the underlay at full cover (% of its own width). */
const UNDERLAY_SHIFT_PCT = 18;

/**
 * Deadline for removing the slide-in keyframe class. A running CSS animation
 * outranks inline style, and Android WebView can freeze the animation timeline
 * across background/resume; timers survive that. `animationend` is the fast path.
 */
const ENTER_ANIM_MAX_MS = 600;

/** Max wait for `open` to catch up with `pendingOpen`; a lost commit would otherwise freeze taps. */
const PENDING_OPEN_MAX_MS = 1000;

const COMMIT_FALLBACK_MS = 80;

interface SwipeRevealProps {
  underlay: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onReveal: () => void;
  onClose: () => void;
  /** Whether `onClose` has a pane to return to; false where it would show nothing. */
  canClose?: boolean;
}

/**
 * Whether `SwipeReveal` drills down (list over pane) rather than laying out side
 * by side. Narrow AND touch, so a small desktop window keeps side-by-side panes.
 */
export function useSwipeLayout(): boolean {
  const isTouch = useIsTouch();
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 899px)");
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    setNarrow(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isTouch && narrow;
}

/**
 * Discord-style swipe-to-reveal for mobile chat screens; plain side-by-side on
 * desktop. Drag writes go straight to `style` in a rAF (see `applyDrag`), and a
 * committed gesture settles optimistically (`pendingOpen`) with navigation
 * deferred until the settle is on the compositor (`deferCommit`), so release doesn't hitch.
 */
export function SwipeReveal({ underlay, children, open, onReveal, onClose, canClose = true }: SwipeRevealProps) {
  const swipeEnabled = useSwipeLayout();

  // Optimistic resting state; `null` whenever the `open` prop is authoritative.
  const [pendingOpen, setPendingOpen] = useState<boolean | null>(null);
  const effectiveOpen = pendingOpen ?? open;
  const [coverToken] = useState(() => Symbol("pane"));
  const listShowing = swipeEnabled && effectiveOpen;
  useEffect(() => {
    setPaneCovered(coverToken, listShowing);
    return () => setPaneCovered(coverToken, false);
  }, [coverToken, listShowing]);

  const paneRef = useRef<HTMLDivElement>(null);
  const underlayRef = useRef<HTMLDivElement>(null);

  // Written synchronously: Chrome already aligns pointermove to the frame, and a
  // rAF hop here would put the pane a frame behind the finger.
  const dragOffset = useRef(0);
  const applyDrag = useCallback((offset: number) => {
    const width = window.innerWidth || 1;
    const off = Math.max(0, Math.min(offset, width));
    dragOffset.current = off;
    if (paneRef.current) {
      paneRef.current.style.transform = `translate3d(${off}px, 0, 0)`;
    }
    if (underlayRef.current) {
      underlayRef.current.style.transform = `translateX(${-(1 - off / width) * UNDERLAY_SHIFT_PCT}%)`;
    }
  }, []);

  // A release settles over the distance left at the finger's speed, so a flick
  // finishes as fast as it was thrown and a nearly-done drag doesn't coast.
  const settleMs = useRef<number | null>(null);
  const releaseAt = useCallback((target: number, velocity: number) => {
    const width = window.innerWidth || 1;
    const remaining = Math.abs(target - dragOffset.current);
    const base = SETTLE_MIN_MS + (SETTLE_MAX_MS - SETTLE_MIN_MS) * (remaining / width);
    settleMs.current = Math.round(
      velocity > 0.2 ? Math.min(base, Math.max(SETTLE_MIN_MS, (2.5 * remaining) / velocity)) : base,
    );
  }, []);

  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Frame 1 paints the resting transform (compositor owns the transition),
  // frame 2 runs navigation. Android can stop servicing rAF across
  // background/resume, stranding `pendingOpen`, so a setTimeout backstop races it.
  const commitRaf = useRef<number | null>(null);
  const commitTimeout = useRef<number | null>(null);
  const clearCommitSchedules = useCallback(() => {
    if (commitRaf.current !== null) {
      cancelAnimationFrame(commitRaf.current);
      commitRaf.current = null;
    }
    if (commitTimeout.current !== null) {
      window.clearTimeout(commitTimeout.current);
      commitTimeout.current = null;
    }
  }, []);
  const deferCommit = useCallback((fn: () => void) => {
    clearCommitSchedules();
    const run = () => {
      clearCommitSchedules();
      fn();
    };
    commitRaf.current = requestAnimationFrame(() => {
      commitRaf.current = requestAnimationFrame(() => {
        commitRaf.current = null;
        run();
      });
    });
    commitTimeout.current = window.setTimeout(run, COMMIT_FALLBACK_MS);
  }, [clearCommitSchedules]);
  useEffect(() => () => clearCommitSchedules(), [clearCommitSchedules]);

  // Only gesture-driven `open` changes animate; navigation changes snap, or the
  // chat visibly slides across the screen.
  const gestureCommit = useRef(false);
  const commitReveal = useCallback(() => {
    gestureCommit.current = true;
    setPendingOpen(true);
    deferCommit(() => onRevealRef.current());
  }, [deferCommit]);
  const commitClose = useCallback(() => {
    gestureCommit.current = true;
    setPendingOpen(false);
    deferCommit(() => onCloseRef.current());
  }, [deferCommit]);

  // Android back reveals the list when the chat is showing (the OS eats in-WebView
  // edge swipes). From the revealed list, back leaves the app by default (it is a
  // root screen); `androidBackLeavesApp` off returns to the chat behind the list,
  // so back toggles the two and never walks history out of the app.
  const backLeavesApp =
    useContext(AppContext)?.config.androidBackLeavesApp ?? defaultConfig.androidBackLeavesApp;
  useAndroidBack(() => {
    settleMs.current = null;
    if (!effectiveOpen) {
      commitReveal();
      return true;
    }
    if (!backLeavesApp && canClose) {
      commitClose();
      return true;
    }
    leaveApp();
    return true;
  }, swipeEnabled);

  // Compositor-run keyframe slide-in on fresh mount, so heavy chat mounting doesn't
  // stutter it. Skipped for deep-link arrivals.
  const [enterAnim, setEnterAnim] = useState(() => swipeEnabled && !open && !isRecentDeepLinkNavigation());

  // Must be removed (see ENTER_ANIM_MAX_MS): a wedged keyframe pins the pane.
  useEffect(() => {
    if (!enterAnim) return;
    const id = window.setTimeout(() => setEnterAnim(false), ENTER_ANIM_MAX_MS);
    return () => window.clearTimeout(id);
  }, [enterAnim]);

  const openSwipe = useEdgeSwipe({
    enabled: swipeEnabled && !effectiveOpen,
    direction: "open",
    onCommit: commitReveal,
    onRelease: useCallback(
      (v: number, committed: boolean) => releaseAt(committed ? window.innerWidth || 1 : 0, committed ? v : -v),
      [releaseAt],
    ),
    onDragMove: applyDrag,
  });
  const closeSwipe = useEdgeSwipe({
    enabled: swipeEnabled && effectiveOpen && canClose,
    direction: "close",
    onCommit: commitClose,
    onRelease: useCallback(
      (v: number, committed: boolean) => releaseAt(committed ? 0 : window.innerWidth || 1, committed ? v : -v),
      [releaseAt],
    ),
    onDragMove: useCallback(
      (dragX: number) => applyDrag((window.innerWidth || 1) - dragX),
      [applyDrag],
    ),
  });

  // Native, not React props: the server rail is portaled from MainLayout and DOM-moved
  // into the underlay, so its presses bubble here only through the DOM.
  const closeHandlersRef = useRef(closeSwipe.handlers);
  closeHandlersRef.current = closeSwipe.handlers;
  useEffect(() => {
    const el = underlayRef.current;
    if (!swipeEnabled || !el) return;
    const on = (name: keyof typeof closeHandlersRef.current) => (e: PointerEvent) =>
      closeHandlersRef.current[name](e as unknown as React.PointerEvent);
    const listeners = {
      pointerdown: on("onPointerDown"),
      pointermove: on("onPointerMove"),
      pointerup: on("onPointerUp"),
      pointercancel: on("onPointerCancel"),
    };
    for (const [type, fn] of Object.entries(listeners)) el.addEventListener(type, fn as EventListener);
    return () => {
      for (const [type, fn] of Object.entries(listeners)) el.removeEventListener(type, fn as EventListener);
    };
  }, [swipeEnabled]);

  // Suppress the transition for one render on non-gesture `open` flips; layout effect so the snap lands pre-paint.
  const prevOpen = useRef(open);
  const [snap, setSnap] = useState(false);
  const cancelOpenSwipe = openSwipe.cancel;
  const cancelCloseSwipe = closeSwipe.cancel;
  useLayoutEffect(() => {
    if (prevOpen.current !== open) {
      setSnap(!gestureCommit.current);
      prevOpen.current = open;
      // Navigation is authoritative: abandon any in-flight drag. Not when it only
      // lands the last gesture's commit, which may trail a swipe already started.
      if (!gestureCommit.current) {
        cancelOpenSwipe();
        cancelCloseSwipe();
      }
      setPendingOpen(null);
    }
    gestureCommit.current = false;
  }, [open, cancelOpenSwipe, cancelCloseSwipe]);
  useEffect(() => {
    if (!snap) return;
    const id = requestAnimationFrame(() => setSnap(false));
    return () => cancelAnimationFrame(id);
  }, [snap]);

  // Spring `pendingOpen` back if navigation never lands, or the pane stays pointer-events-none.
  useEffect(() => {
    if (pendingOpen === null || pendingOpen === open) return;
    const id = window.setTimeout(() => setPendingOpen(null), PENDING_OPEN_MAX_MS);
    return () => window.clearTimeout(id);
  }, [pendingOpen, open]);

  // On resume (Capacitor `appStateChange`; visibility events don't fire, per
  // App.tsx), drop all drag transients and force a commit so transforms are
  // rewritten from the prop.
  const [, bumpResync] = useState(0);
  useEffect(() => {
    if (!swipeEnabled) return;
    return onAppStateChange((active) => {
      if (!active) return;
      cancelOpenSwipe();
      cancelCloseSwipe();
      setPendingOpen(null);
      setEnterAnim(false);
      // Bump unconditionally so the reconciling commit happens.
      bumpResync((n) => n + 1);
    });
  }, [swipeEnabled, cancelOpenSwipe, cancelCloseSwipe]);

  // Gates `will-change`: a permanent hint pins a full-screen compositor layer.
  const [moving, setMoving] = useState(() => enterAnim);
  const firstMotion = useRef(true);
  useEffect(() => {
    if (firstMotion.current) {
      firstMotion.current = false;
      return;
    }
    setMoving(true);
  }, [effectiveOpen, openSwipe.dragging, closeSwipe.dragging]);
  useEffect(() => {
    if (!moving || openSwipe.dragging || closeSwipe.dragging) return;
    const id = window.setTimeout(() => setMoving(false), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [moving, openSwipe.dragging, closeSwipe.dragging]);

  const width = viewportWidth();
  // Only a drag away from the current rest position counts, so a drag left over
  // from before an `open` flip is inert rather than pinning the pane mid-slide.
  const openDragging = openSwipe.dragging && !effectiveOpen;
  const closeDragging = closeSwipe.dragging && effectiveOpen;
  let offset: number;
  if (openDragging) {
    offset = openSwipe.dragXRef.current; // 0 → width as it slides out
  } else if (closeDragging) {
    offset = width - closeSwipe.dragXRef.current; // width → 0 as it slides back
  } else {
    offset = effectiveOpen ? width : 0;
  }
  offset = Math.max(0, Math.min(offset, width));
  const dragging = openDragging || closeDragging;

  const progress = width > 0 ? offset / width : 0;
  // Inline, not classes: a class change on these full-screen layers restyles the
  // whole document (12-30ms on a phone), twice per swipe; an inline style is ~0.
  const settleTransition =
    dragging || snap ? undefined : `transform ${settleMs.current ?? SETTLE_MS}ms cubic-bezier(0, 0, 0.2, 1)`;
  const underlayShift = -(1 - progress) * UNDERLAY_SHIFT_PCT;

  // The drag writes transforms imperatively, so React's style prop may be stale;
  // rewrite the rest position before paint on every commit.
  useLayoutEffect(() => {
    if (!swipeEnabled || dragging) return;
    if (paneRef.current) {
      paneRef.current.style.transform = `translate3d(${offset}px, 0, 0)`;
    }
    if (underlayRef.current) {
      underlayRef.current.style.transform = `translateX(${underlayShift}%)`;
    }
  });

  if (!swipeEnabled) {
    return (
      <>
        {underlay}
        {children}
      </>
    );
  }

  return (
    <>
      {/* Close handlers stay mounted regardless of `open` (the hook self-gates);
          detaching mid-gesture would remove the pointerup that ends the drag. */}
      <div
        ref={underlayRef}
        className="absolute inset-0 flex [contain:layout_paint]"
        style={{
          transform: `translateX(${underlayShift}%)`,
          transition: settleTransition,
          touchAction: effectiveOpen ? "pan-y" : undefined,
          willChange: moving ? "transform" : undefined,
        }}
        aria-hidden={progress === 0}
      >
        {underlay}
      </div>

      <div
        ref={paneRef}
        {...openSwipe.handlers}
        // Scoped to the pane's own animation; children's bubble here too.
        onAnimationEnd={(e) => {
          if (enterAnim && e.target === e.currentTarget) setEnterAnim(false);
        }}
        className={cn(
          "absolute inset-0 z-10 flex flex-col bg-background shadow-2xl [contain:layout_paint]",
          enterAnim && "animate-in slide-in-from-right duration-200 ease-out",
        )}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          transition: settleTransition,
          // Keyed on the optimistic state so the list is tappable on the release frame.
          pointerEvents: effectiveOpen && !dragging ? "none" : undefined,
          touchAction: "pan-y",
          willChange: moving ? "transform" : undefined,
        }}
      >
        <PaneCoveredContext.Provider value={effectiveOpen}>{children}</PaneCoveredContext.Provider>
      </div>
    </>
  );
}
