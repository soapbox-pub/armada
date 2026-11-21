// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { resetRailScrollForTests, restoreRailScroll, trackRailScroll } from "./railScroll";

const ENTRY = 50;

/** A 200px-tall rail of ten 50px entries, laid out by hand since jsdom has no layout. */
function buildRail(active: number) {
  const node = document.createElement("div");
  const nav = document.createElement("nav");
  nav.setAttribute("data-rail-scroller", "");
  nav.getBoundingClientRect = () => ({ top: 0, bottom: 200, height: 200 }) as DOMRect;
  for (let i = 0; i < 10; i++) {
    const entry = document.createElement("div");
    entry.setAttribute("data-rail-anchor", `item:${i}`);
    const top = i * ENTRY;
    entry.getBoundingClientRect = () =>
      ({ top: top - nav.scrollTop, bottom: top + ENTRY - nav.scrollTop, height: ENTRY }) as DOMRect;
    const icon = document.createElement("span");
    if (i === active) icon.className = "is-active";
    entry.appendChild(icon);
    nav.appendChild(entry);
  }
  node.appendChild(nav);
  trackRailScroll(node);
  document.body.appendChild(node);
  return { node, nav };
}

function scroll(nav: HTMLElement, top: number) {
  nav.scrollTop = top;
  nav.dispatchEvent(new Event("scroll"));
}

/** Moving the node to another slot drops its offset, as a browser does. */
function move(node: HTMLElement, nav: HTMLElement) {
  node.remove();
  nav.scrollTop = 0;
  document.body.appendChild(node);
  restoreRailScroll(node);
}

function setActive(nav: HTMLElement, index: number) {
  nav.querySelector(".is-active")?.classList.remove("is-active");
  nav.querySelectorAll("[data-rail-anchor] span")[index].classList.add("is-active");
}

describe("rail scroll restore", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetRailScrollForTests();
  });

  it("puts the offset back after the node is moved", () => {
    const { node, nav } = buildRail(6);
    restoreRailScroll(node);
    scroll(nav, 250);
    setActive(nav, 7);
    move(node, nav);
    expect(nav.scrollTop).toBe(250);
  });

  it("does not move the list for the same selection, even scrolled out of view", () => {
    const { node, nav } = buildRail(0);
    restoreRailScroll(node);
    scroll(nav, 250);
    move(node, nav);
    expect(nav.scrollTop).toBe(250);
  });

  it("brings a newly selected entry out of view just inside the edge", () => {
    const { node, nav } = buildRail(6);
    restoreRailScroll(node);
    scroll(nav, 250);
    // Selected elsewhere (the quick switcher) while the rail was away.
    setActive(nav, 0);
    move(node, nav);
    expect(nav.scrollTop).toBe(0);

    scroll(nav, 0);
    setActive(nav, 9);
    move(node, nav);
    // Entry 9 spans 450–500; the bottom edge plus the margin.
    expect(nav.scrollTop).toBe(308);
  });

  it("ignores scrolls while detached", () => {
    const { node, nav } = buildRail(6);
    restoreRailScroll(node);
    scroll(nav, 250);
    node.remove();
    scroll(nav, 0);
    document.body.appendChild(node);
    restoreRailScroll(node);
    expect(nav.scrollTop).toBe(250);
  });
});
