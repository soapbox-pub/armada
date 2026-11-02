// Structural metadata handling for images that upload byte-for-byte: walked to
// the end rather than sniffed at the head, since EXIF, XMP and text chunks may
// sit anywhere before (PNG, WebP: and after) the image data.

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

export function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a;
}

export function isWebp(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP";
}

export function isGif(b: Uint8Array): boolean {
  return b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a");
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** Image data and how to render it; anything else (EXIF, XMP, text, C2PA, private chunks) is metadata. */
const PNG_KEPT = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS",
  "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "cICP", "mDCV", "cLLI",
  "bKGD", "pHYs",
  "acTL", "fcTL", "fdAT",
]);

interface Span { type: string; start: number; end: number }

function pngChunks(b: Uint8Array): Span[] | null {
  if (!isPng(b)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Span[] = [];
  let at = 8;
  while (at + 12 <= b.length) {
    const end = at + 12 + dv.getUint32(at);
    if (end > b.length) return null;
    const type = ascii(b, at + 4, 4);
    out.push({ type, start: at, end });
    if (type === "IEND") return out;
    at = end;
  }
  return null;
}

/** WebP chunks a renderer needs. EXIF, `XMP ` and unknown chunks are dropped. */
const WEBP_KEPT = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

function webpChunks(b: Uint8Array): Span[] | null {
  if (!isWebp(b)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riffEnd = 8 + dv.getUint32(4, true);
  if (riffEnd > b.length) return null;
  const out: Span[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const size = dv.getUint32(at + 4, true);
    const end = at + 8 + size + (size & 1);
    if (end > riffEnd) return null;
    out.push({ type: ascii(b, at, 4), start: at, end });
    at = end;
  }
  return at === riffEnd ? out : null;
}

/** GIF blocks, as spans; `type` is "ext:<label>[:<app id>]", "image" or "trailer". */
function gifBlocks(b: Uint8Array): { head: number; blocks: Span[] } | null {
  if (!isGif(b) || b.length < 13) return null;
  let at = 13;
  if (b[10] & 0x80) at += 3 * (1 << ((b[10] & 0x07) + 1));
  const head = at;
  const blocks: Span[] = [];
  const subBlocks = (from: number): number => {
    let p = from;
    while (p < b.length) {
      const n = b[p];
      p += 1 + n;
      if (n === 0) return p;
    }
    return -1;
  };
  while (at < b.length) {
    const start = at;
    const kind = b[at];
    if (kind === 0x3b) {
      blocks.push({ type: "trailer", start, end: at + 1 });
      return { head, blocks };
    }
    if (kind === 0x21) {
      if (at + 2 > b.length) return null;
      const label = b[at + 1];
      let type = `ext:${label}`;
      if (label === 0xff && at + 14 <= b.length && b[at + 2] === 11) type += `:${ascii(b, at + 3, 11)}`;
      const end = subBlocks(at + 2);
      if (end < 0) return null;
      blocks.push({ type, start, end });
      at = end;
    } else if (kind === 0x2c) {
      if (at + 10 > b.length) return null;
      let p = at + 10;
      if (b[at + 9] & 0x80) p += 3 * (1 << ((b[at + 9] & 0x07) + 1));
      const end = subBlocks(p + 1); // past the LZW minimum code size
      if (end < 0) return null;
      blocks.push({ type: "image", start, end });
      at = end;
    } else {
      return null;
    }
  }
  return null;
}

/** Graphic control, plain text and the looping extensions; comments and other application data are metadata. */
function gifKept(type: string): boolean {
  return type === "image" || type === "trailer" || type === "ext:249" || type === "ext:1" ||
    type === "ext:255:NETSCAPE2.0" || type === "ext:255:ANIMEXTS1.0";
}

/**
 * JPEG metadata segments before the scan: APP1 (EXIF/XMP), APP2 (ICC/FlashPix),
 * APP3–APP15 except APP14 (Adobe, which affects decoding), and COM.
 */
function jpegHasMetadata(b: Uint8Array): boolean | null {
  let at = 2;
  while (at + 2 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xda) return false;
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if ((marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe) return true;
    if (at + 4 > b.length) return null;
    const length = (b[at + 2] << 8) | b[at + 3];
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * Whether a decodable image must go through the canvas re-encode to send no
 * metadata. Structural for JPEG, PNG, WebP and GIF; an ISO-BMFF image (HEIC,
 * AVIF) keeps its EXIF as an item anywhere in the file, so it is always
 * re-encoded. A layout that can't be walked counts as metadata.
 */
export function needsMetadataStrip(b: Uint8Array): boolean {
  if (isJpeg(b)) return jpegHasMetadata(b) ?? true;
  if (isPng(b)) return pngChunks(b)?.some((c) => !PNG_KEPT.has(c.type)) ?? true;
  if (isWebp(b)) return webpChunks(b)?.some((c) => !WEBP_KEPT.has(c.type)) ?? true;
  if (isGif(b)) return gifBlocks(b)?.blocks.some((c) => !gifKept(c.type)) ?? true;
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") return true;
  // BMP and the like carry no metadata container.
  return false;
}

function concat(b: Uint8Array, head: number, spans: Span[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(head + spans.reduce((n, s) => n + s.end - s.start, 0));
  out.set(b.subarray(0, head), 0);
  let at = head;
  for (const s of spans) {
    out.set(b.subarray(s.start, s.end), at);
    at += s.end - s.start;
  }
  return out;
}

/**
 * An animated PNG, WebP or GIF with its metadata chunks removed and every frame
 * kept, or null when its layout can't be walked (the caller then flattens it
 * through the canvas rather than send it as it is).
 */
export function stripAnimatedMetadata(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const png = pngChunks(b);
  if (png) return concat(b, 8, png.filter((c) => PNG_KEPT.has(c.type)));

  const webp = webpChunks(b);
  if (webp) {
    const out = concat(b, 12, webp.filter((c) => WEBP_KEPT.has(c.type)));
    const dv = new DataView(out.buffer);
    dv.setUint32(4, out.length - 8, true);
    // VP8X flags: no EXIF (bit 3), no XMP (bit 2) after the strip.
    if (ascii(out, 12, 4) === "VP8X") out[20] &= ~0x0c;
    return out;
  }

  const gif = gifBlocks(b);
  if (gif) return concat(b, gif.head, gif.blocks.filter((c) => gifKept(c.type)));

  return null;
}
