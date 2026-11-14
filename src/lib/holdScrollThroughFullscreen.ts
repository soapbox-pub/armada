/** How long after leaving fullscreen (seen in a scroll) the scroll is still held. */
const HOLD_AFTER_EXIT_MS = 600;
/** Gives up if fullscreen never arrives (the request was refused). */
const HOLD_ENTER_TIMEOUT_MS = 1500;

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;
}

/** The window and every scrolling box around `el`, with where each is now. */
function scrollPositions(el: Element): Array<{ read: () => number; write: (y: number) => void; y: number }> {
  const targets: Array<{ read: () => number; write: (y: number) => void; y: number }> = [
    { read: () => window.scrollY, write: (y) => window.scrollTo({ top: y, behavior: "instant" }), y: window.scrollY },
  ];
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
      const box = node;
      targets.push({ read: () => box.scrollTop, write: (y) => { box.scrollTop = y; }, y: box.scrollTop });
    }
  }
  return targets;
}

let releaseHold: (() => void) | undefined;

/**
 * Keeps the page, and the chat around a player, where they are while the
 * player goes fullscreen and comes back. Android's WebView can drop them to
 * the top as it enters fullscreen and doesn't put them back on the way out;
 * any jump while this holds is undone in the scroll event, before it's drawn.
 * Call it just before requesting fullscreen on `el`.
 *
 * Reads the fullscreen state as scrolls arrive rather than listening for
 * fullscreen changes, so the player's own listener stays the only one.
 */
export function holdScrollThroughFullscreen(el: Element): void {
  releaseHold?.();
  const targets = scrollPositions(el);
  let entered = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  // Gives up if fullscreen never arrives (the request was refused).
  const enterTimer = setTimeout(() => { if (!entered && !fullscreenElement()) release(); }, HOLD_ENTER_TIMEOUT_MS);

  const restore = () => {
    for (const t of targets) if (Math.abs(t.read() - t.y) > 1) t.write(t.y);
    if (fullscreenElement()) {
      entered = true;
    } else if (entered && exitTimer === undefined) {
      // Out again: keep correcting while layout settles, then let go.
      exitTimer = setTimeout(release, HOLD_AFTER_EXIT_MS);
    }
  };
  // The user scrolling for real, outside fullscreen, ends the hold.
  const onUserScroll = () => { if (!fullscreenElement()) release(); };

  function release() {
    clearTimeout(enterTimer);
    clearTimeout(exitTimer);
    document.removeEventListener("scroll", restore, true);
    window.removeEventListener("wheel", onUserScroll);
    window.removeEventListener("touchstart", onUserScroll);
    if (releaseHold === release) releaseHold = undefined;
  }

  // Capturing, so scrolls of the chat's own box arrive here too.
  document.addEventListener("scroll", restore, { capture: true, passive: true });
  window.addEventListener("wheel", onUserScroll, { passive: true });
  window.addEventListener("touchstart", onUserScroll, { passive: true });
  releaseHold = release;
}
