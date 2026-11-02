import { describe, expect, it } from "vitest";

import { needsMetadataStrip, stripAnimatedMetadata } from "./imageMetadataStrip";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const has = (bytes: Uint8Array, text: string) => String.fromCharCode(...bytes).includes(text);

function jpeg(segments: [number, number[]][], trailing: number[] = [0xff, 0xda]): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  for (const [marker, payload] of segments) {
    const length = payload.length + 2;
    bytes.push(0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload);
  }
  return new Uint8Array([...bytes, ...trailing]);
}

function png(chunks: [string, number[]][]): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const [type, data] of chunks) {
    const n = data.length;
    out.push(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...ascii(type), ...data, 0, 0, 0, 0);
  }
  return new Uint8Array(out);
}

function webp(chunks: [string, number[]][]): Uint8Array {
  const body: number[] = ascii("WEBP");
  for (const [type, data] of chunks) {
    const n = data.length;
    body.push(...ascii(type), n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24, ...data);
    if (n & 1) body.push(0);
  }
  const n = body.length;
  return new Uint8Array([...ascii("RIFF"), n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24, ...body]);
}

/** GIF89a, no global table, the given blocks, then the trailer. */
function gif(blocks: number[][]): Uint8Array {
  return new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0, ...blocks.flat(), 0x3b]);
}
const IMAGE = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0];
const GCE = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
const LOOP = [0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0];
const COMMENT = [0x21, 0xfe, 5, ...ascii("SECRT"), 0];
const XMP = [0x21, 0xff, 11, ...ascii("XMP DataXMP"), 4, ...ascii("GPS!"), 0];

describe("needsMetadataStrip", () => {
  it("walks a JPEG to the scan: EXIF, IPTC and comments, behind any header", () => {
    expect(needsMetadataStrip(jpeg([[0xe1, ascii("Exif\0\0MM\0*")]]))).toBe(true);
    expect(needsMetadataStrip(jpeg([[0xe0, new Array(70_000).fill(0x20).slice(0, 65_000)], [0xe1, ascii("Exif\0\0")]]))).toBe(true);
    expect(needsMetadataStrip(jpeg([[0xed, ascii("Photoshop 3.0")]]))).toBe(true);
    expect(needsMetadataStrip(jpeg([[0xfe, ascii("comment")]]))).toBe(true);
    expect(needsMetadataStrip(jpeg([[0xe0, ascii("JFIF\0")]]))).toBe(false);
    expect(needsMetadataStrip(jpeg([[0xee, ascii("Adobe")]]))).toBe(false);
    // Entropy-coded data after SOS is never parsed as segments.
    expect(needsMetadataStrip(jpeg([[0xe0, ascii("JFIF\0")]], [0xff, 0xda, 0xff, 0xe1, 0, 8, ...ascii("Exif")]))).toBe(false);
  });

  it("treats a JPEG it can't walk to the scan as needing the re-encode", () => {
    expect(needsMetadataStrip(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xe1]))).toBe(true);
  });

  it("finds a PNG text chunk anywhere, including after the image data", () => {
    expect(needsMetadataStrip(png([["IHDR", [0]], ["IDAT", [0]], ["IEND", []]]))).toBe(false);
    expect(needsMetadataStrip(png([["IHDR", [0]], ["IDAT", [0]], ["tEXt", ascii("GPS\0here")], ["IEND", []]]))).toBe(true);
    expect(needsMetadataStrip(png([["IHDR", [0]], ["eXIf", [1]], ["IDAT", [0]], ["IEND", []]]))).toBe(true);
  });

  it("finds a WebP EXIF or XMP chunk", () => {
    expect(needsMetadataStrip(webp([["VP8X", new Array(10).fill(0)], ["VP8 ", [1, 2]]]))).toBe(false);
    expect(needsMetadataStrip(webp([["VP8X", new Array(10).fill(0)], ["VP8 ", [1, 2]], ["EXIF", [1]]]))).toBe(true);
  });

  it("always re-encodes an ISO-BMFF image, whose EXIF may sit deep in mdat", () => {
    expect(needsMetadataStrip(new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypheic"), 0, 0, 0, 0]))).toBe(true);
  });
});

describe("stripAnimatedMetadata", () => {
  it("drops an APNG's text and EXIF chunks, keeping every frame chunk", () => {
    const apng = png([["IHDR", [0]], ["acTL", [1]], ["tEXt", ascii("Author\0me")], ["fcTL", [2]], ["IDAT", [0]], ["fdAT", [3]], ["eXIf", [4]], ["IEND", []]]);
    const out = stripAnimatedMetadata(apng)!;
    expect(has(out, "tEXt") || has(out, "eXIf")).toBe(false);
    for (const kept of ["IHDR", "acTL", "fcTL", "IDAT", "fdAT", "IEND"]) expect(has(out, kept)).toBe(true);
  });

  it("drops an animated WebP's EXIF and XMP chunks, clearing their VP8X flags and fixing the RIFF size", () => {
    const flags = [0x02 | 0x04 | 0x08, ...new Array(9).fill(0)];
    const anim = webp([["VP8X", flags], ["ANIM", [0, 0, 0, 0, 0, 0]], ["ANMF", [1, 2, 3]], ["EXIF", ascii("GPS")], ["XMP ", ascii("<x/>")]]);
    const out = stripAnimatedMetadata(anim)!;
    expect(has(out, "EXIF") || has(out, "XMP ")).toBe(false);
    expect(has(out, "ANMF")).toBe(true);
    expect(out[20]).toBe(0x02);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it("drops a GIF's comments and XMP, keeping frames, timing and the loop", () => {
    const anim = gif([LOOP, COMMENT, GCE, IMAGE, XMP, GCE, IMAGE]);
    const out = stripAnimatedMetadata(anim)!;
    expect(has(out, "SECRT") || has(out, "XMP Data")).toBe(false);
    expect(has(out, "NETSCAPE2.0")).toBe(true);
    expect(out.length).toBe(anim.length - COMMENT.length - XMP.length);
    expect(out[out.length - 1]).toBe(0x3b);
  });

  it("returns null for a layout it can't walk, so the caller flattens it instead", () => {
    expect(stripAnimatedMetadata(new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x99]))).toBeNull();
    expect(stripAnimatedMetadata(new Uint8Array(ascii("not an image")))).toBeNull();
  });
});
