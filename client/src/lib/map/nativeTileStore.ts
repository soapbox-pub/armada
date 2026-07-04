import { Directory, Filesystem } from "@capacitor/filesystem";

import { base64ToBytes, bytesToBase64, packChunk } from "@/lib/map/tileContainer";

import type { TileStore } from "@/lib/map/tileStore";

/**
 * Native (Capacitor Android/iOS) {@link TileStore}: one flat container file per
 * region under the app's private data dir, `maps/<regionId>.bin`. Batches are
 * base64-appended ({@link packChunk} frames them and returns the byte offsets
 * to record in the manifest); reads pull a single tile via a ranged
 * `readFile(offset,length)` so a region file is never loaded whole into memory.
 *
 * Directory choice: `LibraryNoCloud` — persistent app storage that is NOT
 * subject to WebView storage eviction (unlike IndexedDB on iOS) and is excluded
 * from iCloud/device backup (large regenerable caches shouldn't bloat backups).
 * Never `Cache`/`Temporary`, which the OS purges under storage pressure.
 */

const DIR = Directory.LibraryNoCloud;
const ROOT = "maps";
const regionPath = (regionId: string): string => `${ROOT}/${encodeURIComponent(regionId)}.bin`;

/** Track each region file's current byte length so appends know their offset. */
const fileLengths = new Map<string, number>();

async function ensureRoot(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: ROOT, directory: DIR, recursive: true });
  } catch {
    // already exists / race — fine
  }
}

async function currentLength(regionId: string): Promise<number> {
  const cached = fileLengths.get(regionId);
  if (cached !== undefined) return cached;
  try {
    const stat = await Filesystem.stat({ path: regionPath(regionId), directory: DIR });
    const size = typeof stat.size === "number" ? stat.size : 0;
    fileLengths.set(regionId, size);
    return size;
  } catch {
    fileLengths.set(regionId, 0);
    return 0;
  }
}

export const nativeTileStore: TileStore = {
  async appendRegion(regionId, entries) {
    if (entries.length === 0) return {};
    await ensureRoot();
    const base = await currentLength(regionId);
    const { buffer, index } = packChunk(entries, base);
    try {
      await Filesystem.appendFile({
        path: regionPath(regionId),
        directory: DIR,
        data: bytesToBase64(buffer),
      });
      fileLengths.set(regionId, base + buffer.length);
      return index;
    } catch {
      // On failure don't advance the cached length; report no stored keys so
      // the manifest doesn't point at bytes that never landed.
      return {};
    }
  },

  async readKey(regionId, _key, entry) {
    if (!entry) return null;
    try {
      const res = await Filesystem.readFile({
        path: regionPath(regionId),
        directory: DIR,
        offset: entry.offset,
        length: entry.length,
      });
      // Binary reads (no Encoding) return base64 in `data`.
      return typeof res.data === "string" ? base64ToBytes(res.data) : null;
    } catch {
      return null;
    }
  },

  async deleteRegion(regionId) {
    fileLengths.delete(regionId);
    try {
      await Filesystem.deleteFile({ path: regionPath(regionId), directory: DIR });
    } catch {
      // already gone
    }
  },

  async clearAll() {
    fileLengths.clear();
    try {
      await Filesystem.rmdir({ path: ROOT, directory: DIR, recursive: true });
    } catch {
      // nothing to remove
    }
  },
};
