import { useCallback, useRef } from "react";
import { reducedMotion } from "@/lib/reducedMotion";

const DURATION_MS = 200;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** A capture no reorder followed (a no-op drop) must not animate some later, unrelated render. */
const CAPTURE_TTL_MS = 1000;

/**
 * FLIP for a reorder: `capture()` right before the order changes, `play()` in a layout effect
 * keyed on the order. Each keyed element then glides from where it was to where it landed.
 * `overrides` gives an element a different starting rect — a drag ghost's, so the dropped entry
 * settles from under the pointer rather than jumping from its old slot.
 *
 * Runs on WAAPI, so it composes with CSS transitions and leaves no inline style behind. A keyed
 * element nested in another animates only its motion relative to that parent.
 */
export function useFlipReorder(
  containerRef: React.RefObject<HTMLElement | null>,
  /** Attribute naming each element's stable key, e.g. `data-rail-anchor`. */
  keyAttr: string,
) {
  const captured = useRef<{ at: number; rects: Map<string, DOMRect> } | null>(null);

  const capture = useCallback(
    (overrides?: Record<string, DOMRect | undefined>) => {
      const container = containerRef.current;
      if (!container) return;
      const rects = new Map<string, DOMRect>();
      container.querySelectorAll<HTMLElement>(`[${keyAttr}]`).forEach((el) => {
        rects.set(el.getAttribute(keyAttr)!, el.getBoundingClientRect());
      });
      for (const [key, rect] of Object.entries(overrides ?? {})) if (rect) rects.set(key, rect);
      captured.current = { at: performance.now(), rects };
    },
    [containerRef, keyAttr],
  );

  const play = useCallback(() => {
    const snapshot = captured.current;
    captured.current = null;
    const container = containerRef.current;
    if (!snapshot || !container || performance.now() - snapshot.at > CAPTURE_TTL_MS) return;
    if (reducedMotion()) return;

    const deltas = new Map<Element, { dx: number; dy: number }>();
    const els = container.querySelectorAll<HTMLElement>(`[${keyAttr}]`);
    els.forEach((el) => {
      const before = snapshot.rects.get(el.getAttribute(keyAttr)!);
      if (!before) return;
      const after = el.getBoundingClientRect();
      // Centers, so a differently-sized ghost still settles onto its slot.
      deltas.set(el, {
        dx: before.left + before.width / 2 - (after.left + after.width / 2),
        dy: before.top + before.height / 2 - (after.top + after.height / 2),
      });
    });
    els.forEach((el) => {
      const own = deltas.get(el);
      if (!own || typeof el.animate !== "function") return;
      const parent = el.parentElement?.closest(`[${keyAttr}]`);
      const inherited = parent && container.contains(parent) ? deltas.get(parent) : undefined;
      const dx = own.dx - (inherited?.dx ?? 0);
      const dy = own.dy - (inherited?.dy ?? 0);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: DURATION_MS, easing: EASING },
      );
    });
  }, [containerRef, keyAttr]);

  return { capture, play };
}
