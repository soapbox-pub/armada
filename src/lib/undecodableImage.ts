import { sniffImageMime } from "@/lib/fileBytes";

/**
 * An image this browser has no decoder for, prepared to send as a plain file,
 * or undefined when its metadata can't be removed and it must not be sent.
 *
 * Without a decoder there is no canvas re-encode (resizeImage) to drop EXIF, so
 * the metadata is blanked in place in the container: TIFF (and the TIFF-based
 * RAWs: DNG, CR2, NEF, ARW…) and HEIF. Zero-filling keeps every offset in the
 * file valid, so the image itself is untouched.
 */
export async function undecodableImageAsFile(file: File): Promise<File | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stripped = isTiff(bytes) ? stripTiff(bytes) : isHeif(bytes) ? stripHeif(bytes) : false;
  if (!stripped) return undefined;
  return new File([bytes], file.name, { type: "application/octet-stream", lastModified: file.lastModified });
}

/** Bytes enough for every signature {@link sniffPickedImage} reads. */
export const PICKED_IMAGE_HEAD_BYTES = 64;

/**
 * An image MIME type for a picked file's leading bytes, whatever the browser
 * reported. A camera file often arrives untyped (RAW, HEIC without the OS
 * codec), and an untyped image would otherwise be sent as a plain file with
 * its location intact. RAWs whose metadata can't be blanked here (CR3, ORF,
 * RW2) are named too, so they are refused rather than sent.
 */
export function sniffPickedImage(head: Uint8Array): string | undefined {
  const sniffed = sniffImageMime(head);
  if (sniffed) return sniffed;
  if (isTiff(head)) return "image/tiff";
  const ascii = (start: number, len: number) => String.fromCharCode(...head.subarray(start, start + len));
  if (head.length >= 4 && ["IIRO", "IIRS", "MMOR", "IIU\0"].includes(ascii(0, 4))) return "image/x-raw";
  if (head.length >= 12 && ascii(4, 8) === "ftypcrx ") return "image/x-canon-cr3";
  if (isHeif(head)) return "image/heif";
  return undefined;
}

/** Thrown on a read past the end or a structure too odd to trust. */
class Malformed extends Error {}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function zero(bytes: Uint8Array, start: number, length: number) {
  if (start < 0 || length < 0 || start + length > bytes.length) throw new Malformed();
  bytes.fill(0, start, start + length);
}

// ── TIFF ─────────────────────────────────────────────────────────────────────

function isTiff(b: Uint8Array): boolean {
  return b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a));
}

/** Sub-IFDs that are metadata through and through: emptied entirely. */
const TIFF_METADATA_IFDS = new Set([0x8769 /* Exif */, 0x8825 /* GPS */]);
/** Tags in an image IFD whose values are blanked: who, where, when and with what. */
const TIFF_METADATA_TAGS = new Set([
  0x010e, // ImageDescription
  0x010f, // Make
  0x0110, // Model
  0x0131, // Software
  0x0132, // DateTime
  0x013b, // Artist
  0x013c, // HostComputer
  0x02bc, // XMP
  0x83bb, // IPTC
  0x8298, // Copyright
  0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f, // Windows XP title/comment/author/keywords/subject
  0xa430, 0xa431, 0xa432, 0xa433, 0xa434, 0xa435, // owner, serial, lens (also in Exif IFD)
  0xc614, // DNG UniqueCameraModel
  0xc615, // DNG LocalizedCameraModel
  0xc62f, // DNG CameraSerialNumber
  0xc65d, // DNG RawDataUniqueID
  0xc68b, // DNG OriginalRawFileName
  0xc68c, // DNG OriginalRawFileData (a whole embedded original, metadata included)
  0xc71b, // DNG PreviewDateTime
]);
/** Image IFDs reachable as children (DNG/RAW SubIFDs), walked like IFD0. */
const TIFF_SUB_IFDS = 0x014a;
const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const MAX_IFDS = 64;

function stripTiff(bytes: Uint8Array): boolean {
  try {
    const dv = view(bytes);
    const le = bytes[0] === 0x49;
    const u16 = (at: number) => { if (at + 2 > bytes.length) throw new Malformed(); return dv.getUint16(at, le); };
    const u32 = (at: number) => { if (at + 4 > bytes.length) throw new Malformed(); return dv.getUint32(at, le); };
    const seen = new Set<number>();

    /** An entry's value bytes: inline in the entry when they fit in 4. */
    const valueOf = (entry: number) => {
      const type = u16(entry + 2);
      const size = (TIFF_TYPE_SIZE[type] ?? 1) * u32(entry + 4);
      return { start: size <= 4 ? entry + 8 : u32(entry + 8), size, type };
    };
    const offsetsOf = (entry: number): number[] => {
      const { start, size, type } = valueOf(entry);
      if (type !== 4 && type !== 13) return [];
      const out: number[] = [];
      for (let i = 0; i < size; i += 4) out.push(u32(start + i));
      return out;
    };

    /** Empty a metadata IFD: its out-of-line values, then the IFD itself (count 0, next 0). */
    const emptyIfd = (at: number) => {
      if (seen.has(at) || seen.size >= MAX_IFDS) throw new Malformed();
      seen.add(at);
      const n = u16(at);
      for (let i = 0; i < n; i++) {
        const entry = at + 2 + i * 12;
        const { start, size } = valueOf(entry);
        if (size > 4) zero(bytes, start, size);
      }
      zero(bytes, at, 2 + n * 12 + 4);
    };

    const walkImageIfd = (at: number) => {
      if (seen.has(at) || seen.size >= MAX_IFDS) throw new Malformed();
      seen.add(at);
      const n = u16(at);
      for (let i = 0; i < n; i++) {
        const entry = at + 2 + i * 12;
        const tag = u16(entry);
        if (TIFF_METADATA_IFDS.has(tag)) {
          for (const ifd of offsetsOf(entry)) if (ifd !== 0) emptyIfd(ifd);
        } else if (TIFF_METADATA_TAGS.has(tag)) {
          const { start, size } = valueOf(entry);
          zero(bytes, start, size);
        } else if (tag === TIFF_SUB_IFDS) {
          for (const ifd of offsetsOf(entry)) if (ifd !== 0) walkImageIfd(ifd);
        }
      }
      const next = u32(at + 2 + n * 12);
      if (next !== 0) walkImageIfd(next);
    };

    walkImageIfd(u32(4));
    return true;
  } catch (error) {
    if (error instanceof Malformed || error instanceof RangeError) return false;
    throw error;
  }
}

// ── HEIF (ISO BMFF) ──────────────────────────────────────────────────────────

function isHeif(b: Uint8Array): boolean {
  if (b.length < 12 || String.fromCharCode(...b.subarray(4, 8)) !== "ftyp") return false;
  const brands = new Set<string>();
  const size = view(b).getUint32(0);
  for (let at = 8; at + 4 <= Math.min(size, b.length); at += 4) {
    if (at === 12) continue; // minor_version
    brands.add(String.fromCharCode(...b.subarray(at, at + 4)));
  }
  return ["mif1", "msf1", "heic", "heix", "heim", "heis", "hevc", "hevx", "avif", "avis"].some((brand) => brands.has(brand));
}

interface Box {
  type: string;
  /** First byte after the header. */
  body: number;
  end: number;
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const dv = view(bytes);
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = dv.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) throw new Malformed();
      const big = dv.getBigUint64(at + 8);
      if (big > BigInt(end - at)) throw new Malformed();
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) throw new Malformed();
    out.push({ type, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

/** Item ids whose payload is metadata: EXIF, and XMP (a `mime` item typed as RDF). */
function metadataItems(bytes: Uint8Array, iinf: Box): Set<number> {
  const dv = view(bytes);
  const version = bytes[iinf.body];
  const first = iinf.body + 4 + (version === 0 ? 2 : 4);
  const ids = new Set<number>();
  for (const infe of boxes(bytes, first, iinf.end)) {
    if (infe.type !== "infe") continue;
    const v = bytes[infe.body];
    if (v < 2) throw new Malformed(); // pre-HEIF item info: no item_type to read
    let at = infe.body + 4;
    const id = v === 2 ? dv.getUint16(at) : dv.getUint32(at);
    at += (v === 2 ? 2 : 4) + 2;
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    at += 4;
    if (type === "Exif") ids.add(id);
    if (type === "mime") {
      while (at < infe.end && bytes[at] !== 0) at++; // item_name
      const contentStart = ++at;
      while (at < infe.end && bytes[at] !== 0) at++;
      const content = String.fromCharCode(...bytes.subarray(contentStart, at));
      if (content.startsWith("application/rdf+xml")) ids.add(id);
    }
  }
  return ids;
}

function stripHeif(bytes: Uint8Array): boolean {
  try {
    const dv = view(bytes);
    const top = boxes(bytes, 0, bytes.length);
    const meta = top.find((b) => b.type === "meta");
    if (!meta) return false;
    const children = boxes(bytes, meta.body + 4, meta.end);
    const iinf = children.find((b) => b.type === "iinf");
    const iloc = children.find((b) => b.type === "iloc");
    const idat = children.find((b) => b.type === "idat");
    if (!iinf || !iloc) return false;
    const targets = metadataItems(bytes, iinf);
    if (targets.size === 0) return true;

    const read = (at: number, size: number): number => {
      if (size === 0) return 0;
      if (at + size > iloc.end) throw new Malformed();
      if (size === 4) return dv.getUint32(at);
      if (size === 8) {
        const big = dv.getBigUint64(at);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Malformed();
        return Number(big);
      }
      throw new Malformed();
    };
    const version = bytes[iloc.body];
    let at = iloc.body + 4;
    const offsetSize = bytes[at] >> 4;
    const lengthSize = bytes[at] & 0xf;
    const baseSize = bytes[at + 1] >> 4;
    const indexSize = version >= 1 ? bytes[at + 1] & 0xf : 0;
    at += 2;
    const count = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
    at += version < 2 ? 2 : 4;
    let found = 0;
    for (let i = 0; i < count; i++) {
      const id = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
      at += version < 2 ? 2 : 4;
      const method = version >= 1 ? dv.getUint16(at) & 0xf : 0;
      if (version >= 1) at += 2;
      at += 2; // data_reference_index
      const base = read(at, baseSize);
      at += baseSize;
      const extents = dv.getUint16(at);
      at += 2;
      for (let e = 0; e < extents; e++) {
        at += indexSize;
        const offset = read(at, offsetSize);
        at += offsetSize;
        const length = read(at, lengthSize);
        at += lengthSize;
        if (!targets.has(id)) continue;
        // A zero length means "the rest of the source": nothing to bound a blanking by.
        if (length === 0) throw new Malformed();
        if (method === 0) zero(bytes, base + offset, length);
        else if (method === 1 && idat) zero(bytes, idat.body + base + offset, length);
        else throw new Malformed();
      }
      if (at > iloc.end) throw new Malformed();
      if (targets.has(id)) found++;
    }
    // A metadata item with no location we could blank is metadata we'd be sending.
    return found === targets.size;
  } catch (error) {
    if (error instanceof Malformed || error instanceof RangeError) return false;
    throw error;
  }
}
