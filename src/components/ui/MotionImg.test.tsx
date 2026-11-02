/**
 * Under reduced motion an image that may animate is replaced by its first
 * frame, drawn into a canvas that keeps the image's classes; a format that
 * never animates, or motion left on, renders a plain `<img>`.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MotionImg } from "@/components/ui/MotionImg";
import { mayAnimate, setReduceEffects } from "@/lib/reducedMotion";

describe("MotionImg", () => {
  // jsdom has no 2D canvas; the draw is the browser's business.
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => {
    setReduceEffects(false);
    vi.restoreAllMocks();
  });

  it("knows which formats can animate", () => {
    expect(mayAnimate("https://x.test/a.gif")).toBe(true);
    expect(mayAnimate("https://x.test/a.webp?w=64")).toBe(true);
    expect(mayAnimate("https://blossom.test/" + "ab".repeat(32))).toBe(true);
    expect(mayAnimate("blob:https://armada.test/1")).toBe(true);
    expect(mayAnimate("https://x.test/a.JPG")).toBe(false);
    expect(mayAnimate("https://x.test/a.svg#icon")).toBe(false);
    expect(mayAnimate(undefined)).toBe(false);
  });

  it("is a plain img while motion is allowed", () => {
    const { container } = render(<MotionImg src="https://x.test/a.gif" alt="a" className="size-4" />);
    expect(container.querySelector("img")?.className).toBe("size-4");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("is a plain img for a still format under reduced motion", () => {
    setReduceEffects(true);
    const { container } = render(<MotionImg src="https://x.test/a.jpg" alt="a" />);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("swaps an animated image for its first frame once loaded, keeping classes", () => {
    setReduceEffects(true);
    let loads = 0;
    const { container } = render(
      <MotionImg src="https://x.test/a.gif" alt="party" className="size-4 object-cover" onLoad={() => loads++} />,
    );
    const img = container.querySelector("img")!;
    const canvas = container.querySelector("canvas")!;
    // Loading: the image is invisible (so it never animates on screen) and the canvas waits.
    expect(img.style.opacity).toBe("0");
    expect(canvas.style.display).toBe("none");

    Object.defineProperty(img, "naturalWidth", { value: 32 });
    Object.defineProperty(img, "naturalHeight", { value: 16 });
    fireEvent.load(img);

    expect(loads).toBe(1);
    expect(container.querySelector("img")).toBeNull();
    const shown = container.querySelector("canvas")!;
    expect(shown.style.display).toBe("");
    expect(shown.className).toBe("size-4 object-cover");
    expect(shown.getAttribute("aria-label")).toBe("party");
    expect([shown.width, shown.height]).toEqual([32, 16]);
  });
});
