import { describe, expect, it } from "vitest";

import { stripVideoMetadata } from "./stripMetadata";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function box(type: string, ...body: number[][]): number[] {
  const payload = body.flat();
  const n = payload.length + 8;
  return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...ascii(type), ...payload];
}

const LOCATION = ascii("+48.8583+002.2945/");
const ftyp = box("ftyp", ascii("isom"), [0, 0, 0, 0], ascii("isommp41"));
const mdat = box("mdat", ascii("frames"));

async function bytesOf(blob: Blob | null): Promise<string> {
  return String.fromCharCode(...new Uint8Array(await blob!.arrayBuffer()));
}

describe("stripVideoMetadata", () => {
  it("frees moov and track user data and QuickTime metadata, keeping every offset", async () => {
    const moov = box(
      "moov",
      box("mvhd", [0, 0, 0, 0]),
      box("trak", box("tkhd", [1]), box("udta", box("\u00a9xyz", LOCATION))),
      box("udta", box("\u00a9xyz", LOCATION)),
      box("meta", [0, 0, 0, 0], box("keys", ascii("com.apple.quicktime.location.ISO6709")), box("ilst", LOCATION)),
    );
    const input = new Blob([new Uint8Array([...ftyp, ...moov, ...mdat])], { type: "video/mp4" });

    const out = await stripVideoMetadata(input);
    const text = await bytesOf(out);
    expect(out!.size).toBe(input.size);
    expect(out!.type).toBe("video/mp4");
    expect(text).not.toContain("+48.8583");
    expect(text).not.toContain("location.ISO6709");
    expect(text).toContain("mvhd");
    expect(text).toContain("tkhd");
    expect(text.endsWith("mdatframes")).toBe(true);
  });

  it("frees a top-level XMP uuid box", async () => {
    const xmp = box("uuid", [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac], ascii("<GPS/>"));
    const input = new Blob([new Uint8Array([...ftyp, ...box("moov", box("mvhd", [0])), ...xmp, ...mdat])]);
    expect(await bytesOf(await stripVideoMetadata(input))).not.toContain("<GPS/>");
  });

  it("returns the same file when there is nothing to remove, or it isn't ISO-BMFF", async () => {
    const clean = new Blob([new Uint8Array([...ftyp, ...box("moov", box("mvhd", [0])), ...mdat])]);
    expect(await stripVideoMetadata(clean)).toBe(clean);
    const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])]);
    expect(await stripVideoMetadata(webm)).toBe(webm);
  });

  it("refuses an ISO-BMFF file it can't walk", async () => {
    const broken = new Blob([new Uint8Array([...ftyp, 0, 0, 0, 0x40, ...ascii("moov"), 1, 2, 3])]);
    expect(await stripVideoMetadata(broken)).toBeNull();
  });
});
