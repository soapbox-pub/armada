import { afterEach, describe, expect, it, vi } from "vitest";

import { canDecodeImage, makeImageThumb, resizeImage } from "./resizeImage";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `tEXt`/`iTXt`-style data: a NUL-terminated keyword, then the payload. */
function keyed(keyword: string, payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const keywordBytes = encoder.encode(keyword);
  const payloadBytes = encoder.encode(payload);
  const data = new Uint8Array(keywordBytes.length + 1 + payloadBytes.length);
  data.set(keywordBytes, 0);
  data.set(payloadBytes, keywordBytes.length + 1);
  return data;
}

/** Minimal PNG framing (CRCs zeroed; nothing here reads them) with one tEXt chunk. */
function pngWithTextChunk(keyword: string, payload: string, extra: Array<[string, Uint8Array]> = []) {
  const data = keyed(keyword, payload);
  const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const push = (chunkType: string, chunkData: Uint8Array) => {
    bytes.push(
      (chunkData.length >>> 24) & 0xff, (chunkData.length >>> 16) & 0xff,
      (chunkData.length >>> 8) & 0xff, chunkData.length & 0xff,
    );
    for (let i = 0; i < 4; i++) bytes.push(chunkType.charCodeAt(i));
    for (const b of chunkData) bytes.push(b);
    bytes.push(0, 0, 0, 0);
  };
  push("IHDR", new Uint8Array(13));
  push("tEXt", data);
  for (const [type, chunk] of extra) push(type, chunk);
  push("IDAT", new Uint8Array([1, 2, 3]));
  push("IEND", new Uint8Array(0));
  return new Uint8Array(bytes);
}

function b64(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

function stubBitmap(width: number, height: number) {
  vi.stubGlobal("createImageBitmap", async () => ({ width, height, close: () => undefined }));
}

describe("resizeImage", () => {
  it("decodes without imageOrientation where the WebView rejects \"from-image\"", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("createImageBitmap", async (_file: Blob, options?: ImageBitmapOptions) => {
      calls.push(options);
      if (options?.imageOrientation) {
        throw new TypeError("The provided value 'from-image' is not a valid enum value of type ImageOrientation.");
      }
      return { width: 64, height: 48, close: () => undefined };
    });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "dot.png", { type: "image/png" });

    const out = await resizeImage(file);

    expect(out).toEqual({ file, dimensions: "64x48" });
    expect(calls).toEqual([{ imageOrientation: "from-image" }, undefined]);
  });

  it("does not swallow a decode failure that isn't the option", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    });
    const file = new File([new Uint8Array([1, 2, 3])], "bad.png", { type: "image/png" });

    await expect(resizeImage(file)).rejects.toThrow("could not be decoded");
  });

  it("uploads an oversized character-card PNG byte-for-byte — the payload is the file", async () => {
    // 2752px high, so every normal photo would be re-encoded and its tEXt chunk lost.
    stubBitmap(1835, 2752);
    const png = pngWithTextChunk("chara", b64({
      spec: "chara_card_v2",
      data: { name: "Keqing", description: "The Yuheng of the Liyue Qixing." },
    }));
    const file = new File([png], "card.png", { type: "image/png" });

    const out = await resizeImage(file);

    expect(new Uint8Array(await out.file.arrayBuffer())).toEqual(png);
    expect(out.file.type).toBe("image/png");
    expect(out.dimensions).toBe("1835x2752");
  });

  it("drops a card's other metadata chunks but keeps the card, even with no declared type", async () => {
    stubBitmap(512, 512);
    const card = b64({ spec: "chara_card_v2", data: { name: "Keqing", description: "d" } });
    const png = pngWithTextChunk("chara", card, [
      ["eXIf", new Uint8Array([0x4d, 0x4d, 0, 0x2a])],
      ["tEXt", keyed("parameters", "prompt, seed 42")],
      ["iTXt", keyed("XML:com.adobe.xmp", "<x:xmpmeta/>")],
      ["tEXt", keyed("chara_ext-asset", "pointer")],
      ["caBX", new TextEncoder().encode("c2pa-manifest")],
      ["prVt", new TextEncoder().encode("private-note")],
      ["pHYs", new Uint8Array(9)],
    ]);
    const file = new File([png], "card", { type: "" });

    const out = await resizeImage(file);
    const bytes = new Uint8Array(await out.file.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);

    expect(out.file.type).toBe("image/png");
    expect(out.file.name).toBe("card.png");
    expect(text).toContain("chara\0");
    expect(text).toContain("chara_ext-asset");
    expect(text).toContain("IDAT");
    expect(text).toContain("pHYs");
    for (const gone of ["eXIf", "parameters", "xmpmeta", "c2pa-manifest", "private-note"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("still re-encodes an oversized PNG that carries no card", async () => {
    stubBitmap(4000, 3000);
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array(10)], { type: "image/jpeg" })),
        };
        return canvas;
      },
    });
    const file = new File([pngWithTextChunk("Comment", "just a note")], "photo.png", { type: "image/png" });

    const out = await resizeImage(file);

    // The canvas path ran: same-shape scaled file, re-typed by the encoder.
    expect(out.file).not.toBe(file);
    expect(out.dimensions).toBe("1920x1440");
  });
});

describe("makeImageThumb", () => {
  function stubCanvas(blob: Blob) {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000, close: () => undefined }));
    const drawn: number[][] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => drawn.push([canvas.width, canvas.height]) }),
          toBlob: (cb: (b: Blob) => void) => cb(blob),
        };
        return canvas;
      },
    });
    return drawn;
  }

  const photo = (size: number, type = "image/jpeg") =>
    new File([new Uint8Array(size)], "photo.jpg", { type });

  it("scales the longest side to the preview size", async () => {
    const drawn = stubCanvas(new Blob([new Uint8Array(40_000)], { type: "image/jpeg" }));
    const thumb = await makeImageThumb(photo(3_000_000));
    expect(drawn).toEqual([[768, 576]]);
    expect(thumb?.type).toBe("image/jpeg");
    expect(thumb?.size).toBe(40_000);
  });

  it("skips a preview that would not save much", async () => {
    stubCanvas(new Blob([new Uint8Array(60_000)], { type: "image/jpeg" }));
    expect(await makeImageThumb(photo(100_000))).toBeUndefined();
  });

  it("skips an image that may be transparent where WebP can't be encoded", async () => {
    // A browser without a WebP encoder hands back PNG.
    stubCanvas(new Blob([new Uint8Array(40_000)], { type: "image/png" }));
    expect(await makeImageThumb(photo(3_000_000, "image/png"))).toBeUndefined();
  });
});

describe("resizeImage of an SVG", () => {
  /**
   * Chromium as measured: `createImageBitmap` rejects an SVG Blob outright, and an
   * `<img>` of one without natural dimensions unless resize options are given.
   */
  function stubChromiumSvg(natural: { width: number; height: number; intrinsic?: boolean }) {
    vi.stubGlobal("createImageBitmap", async (source: unknown, options?: ImageBitmapOptions) => {
      if (source instanceof Blob) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      const img = source as { naturalWidth: number; naturalHeight: number };
      if (natural.intrinsic === false && !options?.resizeWidth) {
        throw new DOMException("The image element contains an SVG image without natural dimensions", "InvalidStateError");
      }
      return { width: options?.resizeWidth ?? img.naturalWidth, height: options?.resizeHeight ?? img.naturalHeight, close: () => undefined };
    });
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = natural.width;
      naturalHeight = natural.height;
      decode = async () => undefined;
    });
    vi.stubGlobal("URL", class extends URL {
      static override createObjectURL = () => "blob:svg";
      static override revokeObjectURL = () => undefined;
    });
  }

  const svg = (markup: string) => new File([markup], "logo.svg", { type: "image/svg+xml" });

  it("sizes one with natural dimensions instead of failing the upload", async () => {
    stubChromiumSvg({ width: 10, height: 20 });
    const out = await resizeImage(svg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"/>'));
    expect(out.dimensions).toBe("10x20");
  });

  it("sizes a viewBox-only one by its aspect", async () => {
    // Chromium still reports a default natural size (300x150) for it.
    stubChromiumSvg({ width: 300, height: 150, intrinsic: false });
    const out = await resizeImage(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 15"/>'));
    const [w, h] = out.dimensions.split("x").map(Number);
    expect(w / h).toBe(2);
  });
});

describe("canDecodeImage", () => {
  const raw = new File([new Uint8Array([0x49, 0x49, 0x2a, 0])], "IMG_1608.CR2", { type: "image/x-canon-cr2" });

  it("trusts the common web types without decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    expect(await canDecodeImage(raw, "image/jpeg")).toBe(true);
    expect(decode).not.toHaveBeenCalled();
  });

  it("probes anything else, so a camera RAW the browser can't read becomes a file", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    });
    expect(await canDecodeImage(raw, "image/x-canon-cr2")).toBe(false);
  });

  it("keeps an unusual type inline when this browser decodes it", async () => {
    stubBitmap(10, 10);
    expect(await canDecodeImage(raw, "image/heic")).toBe(true);
  });
});
