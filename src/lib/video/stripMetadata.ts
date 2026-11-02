// A video sent as the original (too large to remux, unreadable, no encoder)
// still carries what the camera wrote: a phone's location lives in
// moov/udta (`©xyz`) and moov/meta (`com.apple.quicktime.location.ISO6709`).
// Those boxes are renamed `free` and zero-filled in place, which keeps every
// offset in the file valid; players skip `free` boxes by definition.

/** Boxes that hold user data and metadata only, never anything playback reads. */
const METADATA_BOXES = new Set(["udta", "meta"]);
/** Containers walked for {@link METADATA_BOXES} inside `moov`. */
const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf"]);
/** Adobe's XMP box (`uuid` BE7ACFCB-97A9-42E8-9C71-999491E3AFAC). */
const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";
/** `moov` is read into memory to edit; one larger than this is not a phone's. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_BOXES = 10_000;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

interface Box { type: string; start: number; header: number; end: number }

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

/** Rename to `free` and zero the body; false when a box can't be walked. */
function neutralize(moov: Uint8Array, from: number, to: number, counter: { n: number; changed: boolean }): boolean {
  let at = from;
  while (at < to) {
    if (++counter.n > MAX_BOXES) return false;
    const box = readBox(moov, at, to);
    if (!box) return false;
    if (METADATA_BOXES.has(box.type)) {
      moov.set([0x66, 0x72, 0x65, 0x65], at + 4); // "free"
      moov.fill(0, at + box.header, box.end);
      counter.changed = true;
    } else if (CONTAINERS.has(box.type) && !neutralize(moov, at + box.header, box.end, counter)) {
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
 * `file` with its metadata boxes neutralized; `file` itself when it is not an
 * ISO-BMFF container (MP4, MOV, 3GP) or carries none; null when it is one and
 * can't be walked, so the caller refuses it rather than send it as it is.
 */
export async function stripVideoMetadata(file: Blob): Promise<Blob | null> {
  const read = async (at: number, n: number) => new Uint8Array(await file.slice(at, at + n).arrayBuffer());
  if (!isIsoBmff(await read(0, 16))) return file;

  const parts: BlobPart[] = [];
  let copiedTo = 0;
  let changed = false;
  let at = 0;
  for (let count = 0; at < file.size; count++) {
    if (count > MAX_BOXES) return null;
    const head = await read(at, 32);
    const box = readBox(head, 0, file.size, at);
    if (!box) return null;
    const isXmp = box.type === "uuid" && head.length >= 24 && hex(head.subarray(box.header, box.header + 16)) === XMP_UUID;

    if (box.type === "moov" || METADATA_BOXES.has(box.type) || isXmp) {
      if (box.end - box.start > MAX_MOOV_BYTES) return null;
      const bytes = await read(box.start, box.end - box.start);
      if (box.type === "moov") {
        const walk = { n: 0, changed: false };
        if (!neutralize(bytes, box.header, bytes.length, walk)) return null;
        if (walk.changed) {
          parts.push(file.slice(copiedTo, box.start), bytes);
          copiedTo = box.end;
          changed = true;
        }
      } else {
        bytes.set([0x66, 0x72, 0x65, 0x65], 4);
        bytes.fill(0, box.header);
        parts.push(file.slice(copiedTo, box.start), bytes);
        copiedTo = box.end;
        changed = true;
      }
    }
    at = box.end;
  }
  if (at !== file.size) return null;
  if (!changed) return file;
  parts.push(file.slice(copiedTo));
  return new Blob(parts, { type: file.type });
}
