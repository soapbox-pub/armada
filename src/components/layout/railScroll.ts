// The touch rail is ONE DOM node moved between pages' slots, and an element
// taken out of the document comes back scrolled to the top. Its offset is
// tracked here while attached and put back after each move.

const SCROLLER = "[data-rail-scroller]";
const REVEAL_MARGIN = 8;

let savedTop = 0;
/** The active entry at the last attach; the rail is scrolled to an entry only when this changes. */
let savedActive: string | null = null;

/** Records the rail's scroll offset; installed once on the portal node. */
export function trackRailScroll(node: HTMLElement): void {
  // Scroll events don't bubble, so listen in the capture phase.
  node.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.isConnected && target.matches(SCROLLER)) {
        savedTop = target.scrollTop;
      }
    },
    { capture: true, passive: true },
  );
}

function activeEntry(nav: HTMLElement): { el: HTMLElement; key: string | null } | null {
  const marker = nav.querySelector<HTMLElement>(".is-active");
  if (!marker) return null;
  const el = marker.closest<HTMLElement>("[data-rail-anchor]") ?? marker.closest<HTMLElement>("a,button") ?? marker;
  return { el, key: el.getAttribute("data-rail-anchor") ?? el.getAttribute("href") ?? el.getAttribute("aria-label") };
}

/**
 * Puts the offset back after the node was (re)attached. A newly selected entry
 * scrolled out of view (opened from a notification or the quick switcher) is
 * brought just inside the edge; the same selection never moves the list.
 */
export function restoreRailScroll(node: HTMLElement): void {
  const nav = node.querySelector<HTMLElement>(SCROLLER);
  if (!nav) return;
  if (nav.scrollTop !== savedTop) nav.scrollTop = savedTop;
  const active = activeEntry(nav);
  const key = active?.key ?? null;
  if (active && key !== savedActive) {
    const view = nav.getBoundingClientRect();
    const rect = active.el.getBoundingClientRect();
    if (rect.height > 0) {
      if (rect.top < view.top) nav.scrollTop = Math.max(0, nav.scrollTop - (view.top - rect.top + REVEAL_MARGIN));
      else if (rect.bottom > view.bottom) nav.scrollTop += rect.bottom - view.bottom + REVEAL_MARGIN;
    }
  }
  savedActive = key;
}

/** Test seam: forget the recorded state. */
export function resetRailScrollForTests(): void {
  savedTop = 0;
  savedActive = null;
}
