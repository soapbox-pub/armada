/**
 * Thumbnails round a box up to a fixed bucket (so one avatar shown at many
 * sizes shares copies), and anything the browser can't resize — or a host that
 * refuses CORS — falls back to the original rather than to nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireThumb, AnimatedThumb, clearThumbs, releaseThumb, sniffImageType, thumbBucket, thumbsSupported } from "./imageThumb";

describe("imageThumb", () => {
  afterEach(() => {
    clearThumbs();
    vi.unstubAllGlobals();
  });

  it("rounds a box times the pixel ratio up to a bucket, capped at the largest", () => {
    expect(thumbBucket(32, 1)).toBe(64);
    expect(thumbBucket(40, 2)).toBe(128);
    expect(thumbBucket(96, 2)).toBe(256);
    expect(thumbBucket(240, 1.5)).toBe(512);
    expect(thumbBucket(900, 2)).toBe(512);
    // A ratio below 1 never makes a thumbnail smaller than the box.
    expect(thumbBucket(100, 0.5)).toBe(128);
  });

  it("falls back to the original where the browser can't resize", async () => {
    expect(thumbsSupported()).toBe(false);
    const t = acquireThumb("https://x.test/a.jpg", 64, false);
    expect(await t.promise).toBeNull();
    releaseThumb(t.key);
  });

  it("falls back to the original when the host refuses CORS, and asks that host only once", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    vi.stubGlobal("OffscreenCanvas", class {});
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await acquireThumb("https://nocors.test/a.jpg", 64, false).promise).toBeNull();
    expect(await acquireThumb("https://nocors.test/b.jpg", 64, false).promise).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves an animated image alone unless media is held still", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1000, height: 1000, close() {} })));
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob([new Uint8Array(16)], { type: "image/gif" }))));
    expect(await acquireThumb("https://x.test/party.gif", 64, false).promise).toBeNull();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("tells formats from their bytes when the server mislabels them", () => {
    const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect(sniffImageType(bytes("GIF89a......"), "application/octet-stream")).toBe("image/gif");
    expect(sniffImageType(bytes("RIFF\0\0\0\0WEBPVP8X"), "")).toBe("image/webp");
    expect(sniffImageType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47), "")).toBe("image/png");
    expect(sniffImageType(Uint8Array.of(0xff, 0xd8, 0xff), "x")).toBe("image/jpeg");
    expect(sniffImageType(bytes("<svg"), "image/svg+xml")).toBe("image/svg+xml");
  });

  it("plays an animation on one timer while watched, and stops after its repetitions", () => {
    vi.useFakeTimers();
    try {
      const frames = [0, 1, 2].map((n) => ({ n, close() {} }) as unknown as ImageBitmap);
      const anim = new AnimatedThumb(8, 8, frames, [100, 100, 100], 1);
      const a: number[] = [];
      const b: number[] = [];
      const offA = anim.subscribe((f) => a.push((f as unknown as { n: number }).n));
      const offB = anim.subscribe((f) => b.push((f as unknown as { n: number }).n));
      vi.advanceTimersByTime(250);
      expect(a).toEqual([0, 1, 2]);
      expect(b).toEqual([0, 1, 2]);
      offA();
      offB();
      vi.advanceTimersByTime(1000);
      expect(a).toEqual([0, 1, 2]);
      // Watched again: plays out its one repetition, then holds.
      const c: number[] = [];
      anim.subscribe((f) => c.push((f as unknown as { n: number }).n));
      vi.advanceTimersByTime(5000);
      expect(c).toEqual([2, 0, 1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});

