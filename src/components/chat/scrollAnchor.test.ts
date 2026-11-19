// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  captureScrollAnchor,
  clampedScrollTop,
  distanceFromBottom,
  restoreScrollAnchor,
} from "@/components/chat/scrollAnchor";

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    width: 100,
    height,
    toJSON: () => ({}),
  };
}

describe("scrollAnchor", () => {
  it("keeps the same row at the same pixel after content grows above it", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    const first = document.createElement("div");
    const anchorRow = document.createElement("div");
    first.dataset.scrollAnchor = "first";
    anchorRow.dataset.scrollAnchor = "anchor";
    content.append(first, anchorRow);
    scroller.append(content);

    let anchorTop = 100;
    scroller.getBoundingClientRect = () => rect(0, 200);
    content.getBoundingClientRect = () => rect(-scroller.scrollTop, anchorTop + 500);
    first.getBoundingClientRect = () => rect(-scroller.scrollTop, 100);
    anchorRow.getBoundingClientRect = () => rect(anchorTop - scroller.scrollTop, 100);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => anchorTop + 500 },
    });
    scroller.scrollTop = 150;

    const anchor = captureScrollAnchor(scroller, content);
    expect(anchor?.rows[0]).toMatchObject({ key: "anchor", offset: 100 });

    anchorTop += 240;
    expect(restoreScrollAnchor(scroller, content, anchor!)).toBe(true);
    expect(scroller.scrollTop).toBe(390);
  });

  it("falls back to a following row and avoids no-op momentum-cancelling writes", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.dataset.scrollAnchor = "first";
    second.dataset.scrollAnchor = "second";
    content.append(first, second);
    scroller.append(content);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    scroller.scrollTop = 50;
    scroller.getBoundingClientRect = () => rect(0, 200);
    content.getBoundingClientRect = () => rect(-scroller.scrollTop, 1_000);
    first.getBoundingClientRect = () => rect(-scroller.scrollTop, 100);
    second.getBoundingClientRect = () => rect(100 - scroller.scrollTop, 100);

    const anchor = captureScrollAnchor(scroller, content)!;
    const ownScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    let writes = 0;
    let top = 50;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        writes += 1;
        top = value;
      },
    });

    expect(restoreScrollAnchor(scroller, content, anchor)).toBe(true);
    expect(writes).toBe(0);

    first.remove();
    expect(restoreScrollAnchor(scroller, content, anchor)).toBe(true);
    expect(writes).toBe(0);
    if (ownScrollTop) Object.defineProperty(scroller, "scrollTop", ownScrollTop);
  });

  it("keeps a scroll made after the capture while compensating growth above", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    const anchorRow = document.createElement("div");
    anchorRow.dataset.scrollAnchor = "anchor";
    content.append(anchorRow);
    scroller.append(content);

    let anchorTop = 300;
    scroller.getBoundingClientRect = () => rect(0, 200);
    content.getBoundingClientRect = () => rect(-scroller.scrollTop, anchorTop + 1_000);
    anchorRow.getBoundingClientRect = () => rect(anchorTop - scroller.scrollTop, 100);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => anchorTop + 1_000 },
    });
    scroller.scrollTop = 250;
    const anchor = captureScrollAnchor(scroller, content)!;

    // The reader scrolls up 30px, then rows are revealed above before that
    // scroll's event is handled.
    scroller.scrollTop = 220;
    anchorTop += 400;
    expect(restoreScrollAnchor(scroller, content, anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(620);
  });

  it("undoes the browser clamping scrollTop when content shrinks under the reader", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    const anchorRow = document.createElement("div");
    anchorRow.dataset.scrollAnchor = "anchor";
    content.append(anchorRow);
    scroller.append(content);

    let anchorTop = 500;
    let tail = 300;
    scroller.getBoundingClientRect = () => rect(0, 200);
    content.getBoundingClientRect = () => rect(-scroller.scrollTop, anchorTop + tail);
    anchorRow.getBoundingClientRect = () => rect(anchorTop - scroller.scrollTop, 100);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => anchorTop + tail },
    });
    scroller.scrollTop = 550;
    const anchor = captureScrollAnchor(scroller, content)!;

    // Rows trimmed above (-300) while rows grow below (+100): max is now 400,
    // and the browser has clamped 550 down to it.
    anchorTop -= 300;
    tail += 100;
    scroller.scrollTop = 400;
    expect(restoreScrollAnchor(scroller, content, anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(250);
  });

  it("normalizes Safari rubber-band offsets", () => {
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    });

    scroller.scrollTop = -80;
    expect(clampedScrollTop(scroller)).toBe(0);
    expect(distanceFromBottom(scroller)).toBe(800);

    scroller.scrollTop = 900;
    expect(clampedScrollTop(scroller)).toBe(800);
    expect(distanceFromBottom(scroller)).toBe(0);
  });
});
