import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptNotificationIcon, encryptImageBlob } from "@/concord/lib/image";

import { MAX_NOTIFICATION_ICON_CHARS, notificationIconDataUrl } from "./notificationIcon";

const probe = vi.hoisted(() => ({ intact: true }));
vi.mock("@/lib/canvasProbe", () => ({ canvasReadbackIntact: () => probe.intact }));

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_MAGIC);
  return bytes;
}

/** OffscreenCanvas whose encoder output size is chosen per type. */
function stubCanvas(sizes: {
  png: number;
  jpeg: (quality: number) => number;
  /** Absent: the encoder can't write WebP and hands back PNG, as Safari's does. */
  webp?: (quality: number) => number;
  transparent?: boolean;
}) {
  const drawn: Array<{ width: number; height: number }> = [];
  const encoded: Array<{ type: string; quality?: number }> = [];
  class FakeCanvas {
    constructor(public width: number, public height: number) {}
    getContext() {
      return {
        drawImage: () => drawn.push({ width: this.width, height: this.height }),
        getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, sizes.transparent ? 0 : 255]) }),
      };
    }
    async convertToBlob({ type, quality }: { type: string; quality?: number }) {
      encoded.push({ type, quality });
      if (type === "image/webp" && !sizes.webp) return new Blob([new Uint8Array(sizes.png)], { type: "image/png" });
      const size = type === "image/png"
        ? sizes.png
        : type === "image/webp"
          ? sizes.webp!(quality ?? 1)
          : sizes.jpeg(quality ?? 1);
      return new Blob([new Uint8Array(size)], { type });
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("createImageBitmap", async () => ({ width: 2000, height: 1000, close: () => {} }));
  return { drawn, encoded };
}

afterEach(() => {
  probe.intact = true;
  vi.unstubAllGlobals();
});

describe("notificationIconDataUrl", () => {
  it("passes the original through where a fingerprint blocker poisons canvas readback", async () => {
    probe.intact = false;
    const { drawn } = stubCanvas({ png: 8 * 1024, jpeg: () => 4 * 1024 });
    const original = png(1024);
    const url = await notificationIconDataUrl(original, "image/png");
    expect(drawn).toEqual([]);
    expect(url).toBe(`data:image/png;base64,${Buffer.from(original).toString("base64")}`);
  });

  it("draws nothing for an original too large to pass through when readback is poisoned", async () => {
    probe.intact = false;
    const { drawn } = stubCanvas({ png: 8 * 1024, jpeg: () => 4 * 1024 });
    expect(await notificationIconDataUrl(png(600_000), "image/png")).toBeUndefined();
    expect(drawn).toEqual([]);
  });

  it("redraws to the longest edge and keeps a small PNG", async () => {
    const { drawn, encoded } = stubCanvas({ png: 8 * 1024, jpeg: () => 4 * 1024 });
    const url = await notificationIconDataUrl(png(600_000), "image/png");
    expect(drawn).toEqual([{ width: 256, height: 128 }]);
    expect(encoded).toEqual([{ type: "image/png", quality: undefined }]);
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it("falls back to JPEG for a photo, lowering quality until it fits", async () => {
    const { encoded } = stubCanvas({
      png: 120 * 1024,
      jpeg: (quality) => (quality > 0.7 ? 60 * 1024 : 20 * 1024),
    });
    const url = await notificationIconDataUrl(png(600_000), "image/png");
    expect(encoded.map((e) => e.type)).toEqual(["image/png", "image/jpeg", "image/jpeg"]);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    expect(url!.length).toBeLessThanOrEqual(MAX_NOTIFICATION_ICON_CHARS);
  });

  it("never flattens a transparent icon to JPEG", async () => {
    const { encoded } = stubCanvas({ png: 24 * 1024, jpeg: () => 4 * 1024, transparent: true });
    const url = await notificationIconDataUrl(png(600_000), "image/png");
    expect(encoded.map((e) => e.type)).toEqual(["image/png"]);
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it("shrinks a large transparent icon as WebP, and gives up where WebP can't be written", async () => {
    const withWebp = stubCanvas({ png: 120 * 1024, jpeg: () => 4 * 1024, webp: () => 8 * 1024, transparent: true });
    expect(await notificationIconDataUrl(png(600_000), "image/png")).toMatch(/^data:image\/webp;base64,/);
    expect(withWebp.encoded.map((e) => e.type)).not.toContain("image/jpeg");

    const without = stubCanvas({ png: 120 * 1024, jpeg: () => 4 * 1024, transparent: true });
    expect(await notificationIconDataUrl(png(600_000), "image/png")).toBeUndefined();
    expect(without.encoded.map((e) => e.type)).not.toContain("image/jpeg");
  });

  it("gives up rather than hand over an icon too large to be drawn", async () => {
    stubCanvas({ png: 120 * 1024, jpeg: () => 60 * 1024 });
    expect(await notificationIconDataUrl(png(600_000), "image/png")).toBeUndefined();
  });

  it("gives up on an undecodable picture", async () => {
    stubCanvas({ png: 1024, jpeg: () => 1024 });
    vi.stubGlobal("createImageBitmap", async () => { throw new Error("bad image"); });
    expect(await notificationIconDataUrl(png(1024), "image/png")).toBeUndefined();
  });

  it("without a canvas, passes a small original through and refuses a large one", async () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(await notificationIconDataUrl(png(1024), "image/png")).toMatch(/^data:image\/png;base64,/);
    expect(await notificationIconDataUrl(png(600_000), "image/png")).toBeUndefined();
  });

  it("refuses what isn't a raster image", async () => {
    stubCanvas({ png: 1024, jpeg: () => 1024 });
    expect(await notificationIconDataUrl(png(1024), "image/svg+xml")).toBeUndefined();
    expect(await notificationIconDataUrl(png(1024), "application/octet-stream")).toBeUndefined();
  });
});

describe("decryptNotificationIcon", () => {
  it("decrypts a community icon into a notification-sized data: URL", async () => {
    const plaintext = png(600_000);
    const { ciphertext, key, nonce, hash } = await encryptImageBlob(new Blob([plaintext]));
    vi.stubGlobal("fetch", async () => new Response(ciphertext));
    const { drawn } = stubCanvas({ png: 8 * 1024, jpeg: () => 4 * 1024 });

    const url = await decryptNotificationIcon({ url: "https://blossom.example/abc", key, nonce, hash }, []);
    expect(drawn).toHaveLength(1);
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it("is undefined when the icon can't be fetched", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    const url = await decryptNotificationIcon(
      { url: "https://blossom.example/abc", key: "00".repeat(32), nonce: "00".repeat(16), hash: "00".repeat(32) },
      [],
    );
    expect(url).toBeUndefined();
  });
});
