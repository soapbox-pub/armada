/**
 * Centering + highlighting a jumped-to row, shared by the timeline and thread
 * panel so both permalink shapes look identical.
 */

/** The jump indicator: an inset shadow, so nothing shifts when it lands. */
const INDICATOR = "shadow-[inset_3px_0_0_0_hsl(var(--primary))]";

/**
 * The wash. Stronger than, and `!` over, the `bg-primary/10` a row that mentions
 * the viewer already carries, so a jump to such a row is still visible.
 */
export const FLASH_WASH = "!bg-primary/25";

/**
 * The row's own vertical scroller. Avoids `scrollIntoView`, which scrolls EVERY
 * ancestor on both axes: on mobile it scrolls the `overflow: hidden` shell
 * sideways past SwipeReveal's parked pane, freezing touch input until restart.
 */
function ownScroller(row: HTMLElement): HTMLElement | null {
  let node = row.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Center `row` by writing only its own scroller's `scrollTop`; no scroller, no scroll. */
function centerInScroller(row: HTMLElement): void {
  const scroller = ownScroller(row);
  if (!scroller) return;
  const rowBox = row.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const offsetWithin = rowBox.top - scrollerBox.top + scroller.scrollTop;
  scroller.scrollTop = offsetWithin - (scroller.clientHeight - rowBox.height) / 2;
}

/**
 * Center and flash `row` with a wash and a primary bar. `focus` (a permalink
 * target) holds both longer.
 */
export function flashRow(row: HTMLElement, focus = false): void {
  // Unpainted rows above sit at their `contain-intrinsic-size` estimate and media
  // resolves late, so re-center on the next two frames.
  centerInScroller(row);
  requestAnimationFrame(() => {
    centerInScroller(row);
    requestAnimationFrame(() => centerInScroller(row));
  });
  row.classList.add(FLASH_WASH, INDICATOR, "transition-colors", "duration-1000", "rounded-md");
  const washMs = focus ? 3000 : 2000;
  setTimeout(() => row.classList.remove(FLASH_WASH), washMs);
  setTimeout(() => {
    row.classList.remove("transition-colors", "duration-1000", "rounded-md", INDICATOR);
  }, washMs + 1000);
}
