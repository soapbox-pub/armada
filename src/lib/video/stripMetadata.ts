// A video sent as the original (too large to remux, unreadable, no encoder)
// still carries what the camera wrote: a phone's location lives in
// moov/udta (`©xyz`) and moov/meta (`com.apple.quicktime.location.ISO6709`).
// Those boxes are renamed `free` and zero-filled in place, which keeps every
// offset in the file valid; players skip `free` boxes by definition. Action
// cameras, drones and dashcams instead record a timed-metadata TRACK (GoPro
// GPMF, DJI, Apple `mebx`, CAMM) whose samples sit in `mdat`: its `trak` is
// freed the same way and its samples are zeroed where they lie.

/** Boxes that hold user data and metadata only, never anything playback reads. */
const METADATA_BOXES = new Set(["udta", "meta"]);
/** Containers walked for {@link METADATA_BOXES} inside `moov`. */
const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf"]);
/** `hdlr` types of tracks that carry sensor data, never picture or sound. */
const TIMED_METADATA_HANDLERS = new Set(["meta", "camm"]);
/** Adobe's XMP box (`uuid` BE7ACFCB-97A9-42E8-9C71-999491E3AFAC). */
const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";
/** `moov` is read into memory to edit; one larger than this is not a phone's. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
/** Boxes walked inside `moov`. */
const MAX_BOXES = 10_000;
/** Top-level boxes: a fragmented recording has a `moof`+`mdat` pair per fragment. */
const MAX_TOP_LEVEL_BOXES = 1_000_000;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

interface Box { type: string; start: number; header: number; end: number }
type Range = [start: number, end: number];

interface Walk {
  n: number;
  changed: boolean;
  /** File ranges of timed-metadata samples, to zero. */
  zero: Range[];
}

function readBox(b: Uint8Array, at: number, limit: number, base = 0): Box | null {
  if (at + 8 > b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let size = dv.getUint32(at);
  let header = 8;
  if (size === 1) {
    if (at + 16 > b.length) return null;
    const big = dv.getBigUint64(at + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    header = 16;
  } else if (size === 0) {
    size = limit - (base + at);
  }
  if (size < header || base + at + size > limit) return null;
  return { type: ascii(b, at + 4, 4), start: base + at, header, end: base + at + size };
}

/** The direct child of type `type` within `[from, to)`, undefined when absent, null when unwalkable. */
function child(b: Uint8Array, from: number, to: number, type: string): Box | null | undefined {
  for (let at = from, n = 0; at < to; n++) {
    if (n > MAX_BOXES) return null;
    const box = readBox(b, at, to);
    if (!box) return null;
    if (box.type === type) return box;
    at = box.end;
  }
  return undefined;
}

function path(b: Uint8Array, parent: Box, types: string[]): Box | null | undefined {
  let at: Box | null | undefined = parent;
  for (const type of types) {
    if (!at) return at;
    at = child(b, at.start + at.header, at.end, type);
  }
  return at;
}

function handlerOf(b: Uint8Array, trak: Box): string | null | undefined {
  const hdlr = path(b, trak, ["mdia", "hdlr"]);
  if (!hdlr) return hdlr;
  // version/flags, pre_defined, then handler_type.
  const at = hdlr.start + hdlr.header + 8;
  return at + 4 <= hdlr.end ? ascii(b, at, 4) : null;
}

/** Where a track's samples lie in the file, from its sample table; null when it can't be read. */
function sampleRanges(b: Uint8Array, trak: Box, fileSize: number): Range[] | null {
  const stbl = path(b, trak, ["mdia", "minf", "stbl"]);
  if (stbl === undefined) return [];
  if (!stbl) return null;
  const inner = (type: string) => child(b, stbl.start + stbl.header, stbl.end, type);
  const stsz = inner("stsz");
  const stsc = inner("stsc");
  const stco = inner("stco");
  const co64 = inner("co64");
  if (stsz === null || stsc === null || stco === null || co64 === null) return null;
  if (!stsz) return inner("stz2") === undefined ? [] : null;
  const chunks = stco ?? co64;
  if (!stsc || !chunks) return null;

  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const body = (box: Box) => box.start + box.header + 4;
  const fits = (box: Box, at: number, n: number) => at + n <= box.end;

  const sz = body(stsz);
  if (!fits(stsz, sz, 8)) return null;
  const fixed = dv.getUint32(sz);
  const sampleCount = dv.getUint32(sz + 4);
  if (fixed === 0 && !fits(stsz, sz + 8, sampleCount * 4)) return null;
  const sizeOf = (i: number) => (fixed !== 0 ? fixed : dv.getUint32(sz + 8 + i * 4));

  const wide = chunks.type === "co64";
  const co = body(chunks);
  if (!fits(chunks, co, 4)) return null;
  const chunkCount = dv.getUint32(co);
  if (!fits(chunks, co + 4, chunkCount * (wide ? 8 : 4))) return null;
  const offsetOf = (c: number) => (wide ? Number(dv.getBigUint64(co + 4 + c * 8)) : dv.getUint32(co + 4 + c * 4));

  const sc = body(stsc);
  if (!fits(stsc, sc, 4)) return null;
  const runs = dv.getUint32(sc);
  if (!fits(stsc, sc + 4, runs * 12)) return null;

  const ranges: Range[] = [];
  let sample = 0;
  for (let r = 0; r < runs; r++) {
    const first = dv.getUint32(sc + 4 + r * 12) - 1;
    const perChunk = dv.getUint32(sc + 8 + r * 12);
    const last = r + 1 < runs ? dv.getUint32(sc + 4 + (r + 1) * 12) - 1 : chunkCount;
    if (first < 0 || last > chunkCount || last < first) return null;
    for (let c = first; c < last; c++) {
      const start = offsetOf(c);
      let bytes = 0;
      for (let k = 0; k < perChunk; k++, sample++) {
        if (sample >= sampleCount) return null;
        bytes += sizeOf(sample);
      }
      if (start + bytes > fileSize) return null;
      if (bytes > 0) ranges.push([start, start + bytes]);
    }
  }
  return ranges;
}

/** Rename to `free` and zero the body. */
function free(b: Uint8Array, box: Box, base: number): void {
  b.set([0x66, 0x72, 0x65, 0x65], box.start - base + 4); // "free"
  b.fill(0, box.start - base + box.header, box.end - base);
}

/** Neutralize metadata within `moov`; false when a box can't be walked. */
function neutralize(moov: Uint8Array, from: number, to: number, walk: Walk, fileSize: number): boolean {
  let at = from;
  while (at < to) {
    if (++walk.n > MAX_BOXES) return false;
    const box = readBox(moov, at, to);
    if (!box) return false;
    if (METADATA_BOXES.has(box.type)) {
      free(moov, box, 0);
      walk.changed = true;
    } else if (box.type === "trak") {
      const handler = handlerOf(moov, box);
      if (handler === null) return false;
      if (handler && TIMED_METADATA_HANDLERS.has(handler)) {
        const ranges = sampleRanges(moov, box, fileSize);
        if (!ranges) return false;
        walk.zero.push(...ranges);
        free(moov, box, 0);
        walk.changed = true;
      } else if (!neutralize(moov, at + box.header, box.end, walk, fileSize)) {
        return false;
      }
    } else if (CONTAINERS.has(box.type) && !neutralize(moov, at + box.header, box.end, walk, fileSize)) {
      return false;
    }
    at = box.end;
  }
  return at === to;
}

function isIsoBmff(head: Uint8Array): boolean {
  return head.length >= 8 && ["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(ascii(head, 4, 4));
}

/**
 * `file` with its metadata neutralized; `file` itself when it is not an
 * ISO-BMFF container (MP4, MOV, 3GP) or carries none; null when it is one and
 * can't be walked, so the caller refuses it rather than send it as it is.
 */
export async function stripVideoMetadata(file: Blob): Promise<Blob | null> {
  const read = async (at: number, n: number): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await file.slice(at, at + n).arrayBuffer());
  if (!isIsoBmff(await read(0, 16))) return file;

  /** Rewritten boxes, and sample ranges to zero, in file offsets. */
  const replaced: Array<{ start: number; end: number; bytes: Uint8Array<ArrayBuffer> }> = [];
  const zero: Range[] = [];
  let fragmented = false;
  let at = 0;
  for (let count = 0; at < file.size; count++) {
    if (count > MAX_TOP_LEVEL_BOXES) return null;
    const head = await read(at, 32);
    const box = readBox(head, 0, file.size, at);
    if (!box) return null;
    if (box.type === "moof") fragmented = true;
    const isXmp = box.type === "uuid" && head.length >= 24 && hex(head.subarray(box.header, box.header + 16)) === XMP_UUID;

    if (box.type === "moov" || METADATA_BOXES.has(box.type) || isXmp) {
      if (box.end - box.start > MAX_MOOV_BYTES) return null;
      const bytes = await read(box.start, box.end - box.start);
      if (box.type === "moov") {
        const walk: Walk = { n: 0, changed: false, zero: [] };
        if (!neutralize(bytes, box.header, bytes.length, walk, file.size)) return null;
        if (walk.changed) replaced.push({ start: box.start, end: box.end, bytes });
        zero.push(...walk.zero);
      } else {
        bytes.set([0x66, 0x72, 0x65, 0x65], 4);
        bytes.fill(0, box.header);
        replaced.push({ start: box.start, end: box.end, bytes });
      }
    }
    at = box.end;
  }
  if (at !== file.size) return null;
  // A fragment's `traf` can hold more samples of the track than `moov` lists.
  if (fragmented && zero.length > 0) return null;
  if (replaced.length === 0 && zero.length === 0) return file;

  const edits = [
    ...replaced,
    ...zero.map(([start, end]) => ({ start, end, bytes: undefined as Uint8Array<ArrayBuffer> | undefined })),
  ].sort((a, b) => a.start - b.start);
  const parts: BlobPart[] = [];
  let copiedTo = 0;
  for (const edit of edits) {
    // Overlapping samples, or samples inside a rewritten box: zero what's left.
    const start = Math.max(edit.start, copiedTo);
    if (edit.end <= start) continue;
    if (edit.bytes && start !== edit.start) return null;
    parts.push(file.slice(copiedTo, start), edit.bytes ?? new Uint8Array(edit.end - start));
    copiedTo = edit.end;
  }
  parts.push(file.slice(copiedTo));
  return new Blob(parts, { type: file.type });
}
