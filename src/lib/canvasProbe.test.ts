import { afterEach, describe, expect, it, vi } from "vitest";

import { canvasReadbackIntact, resetCanvasProbe } from "./canvasProbe";

/** An OffscreenCanvas whose readback is `readback(drawn)`, drawn being what fillRect painted. */
function stubCanvas(readback: (drawn: Uint8ClampedArray) => Uint8ClampedArray) {
  class FakeCanvas {
    constructor(public width: number, public height: number) {}
    getContext() {
      const drawn = new Uint8ClampedArray(this.width * this.height * 4);
      const width = this.width;
      return {
        fillStyle: "",
        fillRect(x: number, y: number) {
          const [r, g, b] = (this.fillStyle.match(/\d+/g) ?? []).map(Number);
          drawn.set([r, g, b, 255], (y * width + x) * 4);
        },
        getImageData: () => ({ data: readback(drawn) }),
      };
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCanvasProbe();
});

describe("canvasReadbackIntact", () => {
  it("is true where readback returns what was drawn", () => {
    stubCanvas((drawn) => drawn);
    expect(canvasReadbackIntact()).toBe(true);
  });

  // Firefox's ImageExtraction::Placeholder (GeneratePlaceholderCanvasData.h), what
  // Tor Browser returns until the site is allowed: 32 random bytes tiled over the
  // buffer, which is a picture's vertical stripes.
  it("is false for Tor Browser's placeholder readback", () => {
    const random = Uint8ClampedArray.from({ length: 32 }, (_, i) => (i * 97 + 13) % 256);
    stubCanvas((drawn) => drawn.map((_, i) => random[i % 32]));
    expect(canvasReadbackIntact()).toBe(false);
  });

  it("is false for a placeholder with no randomness (all white)", () => {
    stubCanvas((drawn) => drawn.map(() => 255));
    expect(canvasReadbackIntact()).toBe(false);
  });

  it("is false where readback throws", () => {
    stubCanvas(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(canvasReadbackIntact()).toBe(false);
  });

  it("tolerates low-bit noise like Firefox's and Brave's randomization", () => {
    stubCanvas((drawn) => drawn.map((v, i) => (i % 4 === 3 ? v : v ^ 1)));
    expect(canvasReadbackIntact()).toBe(true);
  });
});
