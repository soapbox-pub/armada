import type { TileCoord } from "@/lib/map/tileMath";

/**
 * Addressing + framing for offline map assets.
 *
 * Every cached resource — a vector tile, a glyph range, a sprite sheet, the
 * style/tilejson JSON — is identified by a stable string **key**. On native
 * (Capacitor Filesystem) all of a region's tiles live in ONE flat container
 * file, and the {@link TileIndexEntry} `(offset, length)` map (kept in the
 * metadata DB) says where each key's bytes sit inside it; on web each key maps
 * to its own IndexedDB row. This module owns only the *addressing* and the
 * pure byte-framing helpers — it performs no I/O, so it's trivially testable.
 *
 * Keys are opaque strings but structured for readability/debuggability:
 *   tile:   `t/<z>/<x>/<y>`
 *   asset:  `a/<kind>/<path>`   (kind = style|tilejson|sprite|glyph|raster)
 */

/** Where a key's bytes live inside a region's flat container file. */
export interface TileIndexEntry {
  offset: number;
  length: number;
}

/** Non-tile assets that must also be cached for the map to render offline. */
export type AssetKind = "style" | "tilejson" | "sprite" | "glyph" | "raster";

/** Stable key for a vector tile. */
export function tileKey(t: TileCoord): string {
  return `t/${t.z}/${t.x}/${t.y}`;
}

/**
 * Stable key for a shared (non-tile) asset. `id` is a normalized identifier for
 * the resource — for glyphs `"<fontstack>/<range>"`, for sprites `"ofm.json"` /
 * `"ofm.png"` / `"ofm@2x.png"`, for raster hillshade `"<z>/<x>/<y>"`, etc.
 */
export function assetKey(kind: AssetKind, id: string): string {
  return `a/${kind}/${id}`;
}

/** True for keys produced by {@link tileKey}. */
export function isTileKey(key: string): boolean {
  return key.startsWith("t/");
}

/**
 * Concatenate a batch of (key → bytes) into one buffer plus the index that
 * locates each key within it, relative to `baseOffset` (the current end of the
 * container file on native, so batches can be appended incrementally). Pure:
 * the caller writes/appends `buffer` to storage and merges `index` into the
 * manifest.
 */
export function packChunk(
  entries: { key: string; bytes: Uint8Array }[],
  baseOffset = 0,
): { buffer: Uint8Array; index: Record<string, TileIndexEntry> } {
  const total = entries.reduce((n, e) => n + e.bytes.length, 0);
  const buffer = new Uint8Array(total);
  const index: Record<string, TileIndexEntry> = {};
  let cursor = 0;
  for (const { key, bytes } of entries) {
    buffer.set(bytes, cursor);
    index[key] = { offset: baseOffset + cursor, length: bytes.length };
    cursor += bytes.length;
  }
  return { buffer, index };
}

/** Slice one key's bytes out of a fully-loaded container buffer. */
export function sliceFromBuffer(buffer: Uint8Array, entry: TileIndexEntry): Uint8Array {
  return buffer.subarray(entry.offset, entry.offset + entry.length);
}

/** Base64 (no data-url prefix) → bytes. Used to decode Filesystem reads. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes → base64 (no data-url prefix). Used to write Filesystem chunks. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
