import { describe, expect, it } from "vitest";

import { sniffPickedImage, undecodableImageAsFile } from "./undecodableImage";

const CAMERA = "SECRETCAM";
/** The GPS latitude's degrees numerator: findable in the bytes if it survives. */
const LATITUDE = [0x0b, 0xad, 0xc0, 0xde];
const PIXELS = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8];

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A little-endian TIFF: IFD0 (Make, strip, GPS pointer) → GPS IFD (latitude). */
function tiff(): number[] {
  const out: number[] = [];
  const u16 = (v: number) => out.push(v & 0xff, v >> 8);
  const u32 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
  const entry = (tag: number, type: number, count: number, value: number) => (u16(tag), u16(type), u32(count), u32(value));

  out.push(0x49, 0x49); u16(42); u32(8);
  const ifd0 = 8;
  const ifd0Size = 2 + 4 * 12 + 4;
  const make = ifd0 + ifd0Size;
  const makeBytes = [...ascii(CAMERA), 0];
  const pixels = make + makeBytes.length;
  const gps = pixels + PIXELS.length;
  const gpsSize = 2 + 2 * 12 + 4;
  const lat = gps + gpsSize;

  u16(4);
  entry(0x010f, 2, makeBytes.length, make); // Make
  entry(0x0111, 4, 1, pixels); // StripOffsets
  entry(0x0117, 4, 1, PIXELS.length); // StripByteCounts
  entry(0x8825, 4, 1, gps); // GPSInfo
  u32(0);
  out.push(...makeBytes, ...PIXELS);
  u16(2);
  entry(0x0001, 2, 2, 0x4e); // GPSLatitudeRef "N"
  entry(0x0002, 5, 3, lat); // GPSLatitude
  u32(0);
  out.push(...LATITUDE, 1, 0, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0);
  return out;
}

/** A minimal HEIF: ftyp, meta (iinf + iloc) naming an image item and an Exif item in mdat. */
function heif(): number[] {
  const be32 = (v: number) => [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const be16 = (v: number) => [v >> 8, v & 0xff];
  const box = (type: string, body: number[]) => [...be32(8 + body.length), ...ascii(type), ...body];
  const full = (type: string, version: number, body: number[]) => box(type, [version, 0, 0, 0, ...body]);
  const infe = (id: number, type: string) => full("infe", 2, [...be16(id), ...be16(0), ...ascii(type), 0]);
  const exif = [0, 0, 0, 6, ...ascii("Exif"), 0, 0, ...tiff()];

  const ftyp = box("ftyp", [...ascii("heic"), 0, 0, 0, 0, ...ascii("mif1heic")]);
  const iloc = (pixelsAt: number, exifAt: number) =>
    full("iloc", 0, [
      0x44, 0x00, ...be16(2),
      ...be16(1), ...be16(0), ...be16(1), ...be32(pixelsAt), ...be32(PIXELS.length),
      ...be16(2), ...be16(0), ...be16(1), ...be32(exifAt), ...be32(exif.length),
    ]);
  const iinf = full("iinf", 0, [...be16(2), ...infe(1, "hvc1"), ...infe(2, "Exif")]);
  const metaLen = full("meta", 0, [...iinf, ...iloc(0, 0)]).length;
  const mdatData = ftyp.length + metaLen + 8;
  const meta = full("meta", 0, [...iinf, ...iloc(mdatData, mdatData + PIXELS.length)]);
  return [...ftyp, ...meta, ...box("mdat", [...PIXELS, ...exif])];
}

const contains = (hay: Uint8Array, needle: number[]) =>
  hay.some((_, i) => needle.every((b, j) => hay[i + j] === b));

async function bytesOf(file: File) {
  return new Uint8Array(await file.arrayBuffer());
}

describe("undecodableImageAsFile", () => {
  for (const [label, build, name, type] of [
    ["TIFF", tiff, "IMG_0001.tif", "image/tiff"],
    ["HEIC", heif, "IMG_0001.HEIC", "image/heic"],
  ] as const) {
    it(`strips the GPS position and camera from a ${label} and leaves the image`, async () => {
      const original = new Uint8Array(build());
      expect(contains(original, LATITUDE)).toBe(true);
      expect(contains(original, ascii(CAMERA))).toBe(true);

      const sent = await undecodableImageAsFile(new File([original], name, { type }));
      expect(sent).toBeDefined();
      const bytes = await bytesOf(sent!);
      expect(sent!.type).toBe("application/octet-stream");
      expect(contains(bytes, LATITUDE)).toBe(false);
      expect(contains(bytes, ascii(CAMERA))).toBe(false);
      expect(contains(bytes, PIXELS)).toBe(true);
      expect(bytes.length).toBe(original.length);
    });
  }

  it("blanks a DNG's camera serial number in IFD0, where no Exif IFD covers it", async () => {
    const bytes = new Uint8Array(tiff());
    // Retag IFD0's first entry (Make) as CameraSerialNumber.
    new DataView(bytes.buffer).setUint16(8 + 2, 0xc62f, true);
    const sent = await undecodableImageAsFile(new File([bytes], "IMG_0001.dng", { type: "image/x-adobe-dng" }));
    expect(sent).toBeDefined();
    const out = await bytesOf(sent!);
    expect(contains(out, ascii(CAMERA))).toBe(false);
    expect(contains(out, PIXELS)).toBe(true);
  });

  it("refuses a TIFF whose metadata pointer leads outside the file", async () => {
    const bytes = new Uint8Array(tiff());
    // GPSInfo is IFD0's fourth entry; its value is the GPS IFD's offset.
    new DataView(bytes.buffer).setUint32(8 + 2 + 3 * 12 + 8, 0xfffffff0, true);
    expect(await undecodableImageAsFile(new File([bytes], "IMG_0001.tif", { type: "image/tiff" }))).toBeUndefined();
  });

  it("refuses a format whose metadata it can't find", async () => {
    const cr3ish = new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypcrx "), 0, 0, 0, 1, ...ascii("crx isom"), ...ascii(CAMERA)]);
    expect(await undecodableImageAsFile(new File([cr3ish], "IMG_0001.CR3", { type: "image/x-canon-cr3" }))).toBeUndefined();
  });
});

describe("sniffPickedImage", () => {
  const head = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(64).fill(0)].slice(0, 64));

  it("names an untyped camera file an image, whatever its extension said", () => {
    expect(sniffPickedImage(head(0xff, 0xd8, 0xff, 0xe1))).toBe("image/jpeg");
    expect(sniffPickedImage(head(0x49, 0x49, 0x2a, 0))).toBe("image/tiff");
    expect(sniffPickedImage(head(0x4d, 0x4d, 0, 0x2a))).toBe("image/tiff");
    expect(sniffPickedImage(head(0, 0, 0, 0x18, ...ascii("ftypheic")))).toBe("image/heic");
    expect(sniffPickedImage(head(0, 0, 0, 0x18, ...ascii("ftypmsf1")))).toBe("image/heif");
  });

  it("names the RAWs it can't strip, so they are refused rather than sent", () => {
    expect(sniffPickedImage(head(0, 0, 0, 0x18, ...ascii("ftypcrx ")))).toBe("image/x-canon-cr3");
    expect(sniffPickedImage(head(...ascii("IIRO")))).toBe("image/x-raw");
    expect(sniffPickedImage(head(...ascii("IIU"), 0))).toBe("image/x-raw");
  });

  it("leaves everything else alone", () => {
    expect(sniffPickedImage(head(...ascii("%PDF-1.7")))).toBeUndefined();
    expect(sniffPickedImage(head(...ascii("PK"), 3, 4))).toBeUndefined();
    expect(sniffPickedImage(head(0, 0, 0, 0x18, ...ascii("ftypisom")))).toBeUndefined();
    expect(sniffPickedImage(new Uint8Array())).toBeUndefined();
  });
});
