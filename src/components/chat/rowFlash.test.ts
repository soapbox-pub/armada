// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FLASH_WASH, flashRow } from "./rowFlash";

/**
 * The geometry that produced the frozen-touch bug, in miniature.
 *
 * A notification tap lands on `/c/…/m/<id>` while `SwipeReveal` has the channel
 * list revealed, so the chat pane is parked at `translateX(100vw)`. That parked
 * pane doubles the shell's scrollable width, and the shell is `overflow:
 * hidden` — a scroll container the user cannot scroll but the browser can.
 * Centering the permalink row inside the parked pane used to scroll the SHELL
 * sideways by a viewport, which left a `pointer-events: none` pane covering the
 * screen and the interactive list out of view: an app that renders normally and
 * takes no input until it is killed.
 *
 * jsdom does no layout, so the boxes are stubbed. What is being asserted is not
 * a pixel result but the invariant that broke: centering a row moves that row's
 * OWN scroller and nothing else.
 */

const VIEWPORT = 411;

interface Fixture {
  shell: HTMLDivElement;
  scroller: HTMLDivElement;
  row: HTMLDivElement;
}

/** Give an element a fixed layout box and scroll extents jsdom won't compute. */
function stub(
  el: HTMLElement,
  box: { top: number; height: number },
  extents?: { scrollHeight: number; clientHeight: number },
) {
  el.getBoundingClientRect = () =>
    ({ top: box.top, height: box.height, bottom: box.top + box.height, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON: () => ({}) }) as DOMRect;
  if (extents) {
    Object.defineProperty(el, "scrollHeight", { value: extents.scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: extents.clientHeight, configurable: true });
  }
}

function build(): Fixture {
  const shell = document.createElement("div");
  shell.style.overflow = "hidden";
  // The parked pane makes the shell scrollable sideways; `hidden` does not stop
  // the browser scrolling it, which is the entire hazard.
  Object.defineProperty(shell, "scrollWidth", { value: VIEWPORT * 2, configurable: true });
  Object.defineProperty(shell, "clientWidth", { value: VIEWPORT, configurable: true });

  const pane = document.createElement("div");
  pane.style.transform = `translate3d(${VIEWPORT}px, 0, 0)`;

  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";

  const row = document.createElement("div");

  scroller.appendChild(row);
  pane.appendChild(scroller);
  shell.appendChild(pane);
  document.body.appendChild(shell);

  stub(scroller, { top: 0, height: 800 }, { scrollHeight: 5000, clientHeight: 800 });
  stub(row, { top: 1200, height: 100 });
  return { shell, scroller, row };
}

describe("flashRow", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView at all, so a bare spy would make
    // the ancestor assertion below pass against the very code that caused the
    // bug. Emulate what the browser actually does instead: walk EVERY
    // scrollable ancestor and scroll each one until the target is in view, on
    // both axes. With this in place the old `scrollIntoView({block:"center"})`
    // implementation fails the ancestor test, which is the point of having it.
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      for (let el = this.parentElement; el; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth - el.clientWidth;
      }
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("centers the row by scrolling its own scroller", () => {
    const { scroller, row } = build();
    scroller.scrollTop = 0;

    flashRow(row);

    // row is 1200px below the scroller's top; centering an 100px row in an
    // 800px viewport puts it at 1200 - (800 - 100) / 2.
    expect(scroller.scrollTop).toBe(1200 - 350);
  });

  it("re-centers on the next two frames, for rows that resize as they paint", async () => {
    const { scroller, row } = build();
    const writes: number[] = [];
    let value = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (v: number) => {
        value = v;
        writes.push(v);
      },
    });

    flashRow(row);
    // Rows above the target sit at their `contain-intrinsic-size` estimate and
    // embeds resolve a frame or two late, so one pass lands only approximately.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));

    expect(writes).toHaveLength(3);
  });

  it("never scrolls an ancestor, so a parked pane cannot slide the shell", () => {
    const { shell, row } = build();

    flashRow(row, true);

    expect(shell.scrollLeft).toBe(0);
    expect(shell.scrollTop).toBe(0);
  });

  it("does not use scrollIntoView, which walks every scrollable ancestor", () => {
    const { row } = build();

    flashRow(row);

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves a row with no scrolling ancestor alone rather than scrolling further up", () => {
    const orphan = document.createElement("div");
    const plain = document.createElement("div");
    plain.appendChild(orphan);
    document.body.appendChild(plain);
    stub(orphan, { top: 10, height: 10 });

    expect(() => flashRow(orphan)).not.toThrow();
    expect(plain.scrollTop).toBe(0);
  });

  it("marks a reply jump as plainly as a permalink, over a mention's own tint", () => {
    const { row } = build();
    const indicator = "shadow-[inset_3px_0_0_0_hsl(var(--primary))]";

    flashRow(row);
    expect(row.classList.contains(indicator)).toBe(true);
    expect(row.classList.contains(FLASH_WASH)).toBe(true);
    expect(FLASH_WASH).not.toBe("bg-primary/10");
  });
});
