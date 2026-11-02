import { describe, expect, it } from "vitest";

import { isAnimatedImage } from "./imageMetadata";

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

describe("isAnimatedImage", () => {
  it("treats every GIF as animated", () => {
    expect(isAnimatedImage("image/gif", new Uint8Array(ascii("GIF89a")))).toBe(true);
  });

  it("detects an animated WebP by its ANIM chunk", () => {
    const webp = new Uint8Array(ascii("RIFF____WEBPVP8X________ANIM"));
    expect(isAnimatedImage("image/webp", webp)).toBe(true);
  });

  it("treats a still WebP as not animated", () => {
    const webp = new Uint8Array(ascii("RIFF____WEBPVP8 ________"));
    expect(isAnimatedImage("image/webp", webp)).toBe(false);
  });

  it("detects an APNG by its acTL chunk", () => {
    const apng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...ascii("IHDR________acTL________IDAT"),
    ]);
    expect(isAnimatedImage("image/png", apng)).toBe(true);
  });

  it("treats a still PNG as not animated", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...ascii("IHDR________IDAT________acTL"),
    ]);
    // `acTL` after `IDAT` is not an animation control chunk.
    expect(isAnimatedImage("image/png", png)).toBe(false);
  });

  it("treats JPEG as never animated", () => {
    expect(isAnimatedImage("image/jpeg", new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});
