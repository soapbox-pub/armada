import { type DBSchema, type IDBPDatabase, openDB } from "idb";

import type { BBox } from "@/lib/map/tileMath";
import type { TileIndexEntry } from "@/lib/map/tileContainer";

/**
 * Metadata catalog for downloaded offline map regions.
 *
 * The bulk tile bytes live in a {@link import("@/lib/map/tileStore").TileStore}
 * backend (native Filesystem container files, or IndexedDB blobs on web). This
 * separate, tiny IndexedDB database is the *catalog*: which regions exist,
 * their bbox / zoom / provider tile-version, their size + tile count, and — for
 * the native flat-container backend — the `(offset, length)` index locating
 * each key inside a region's file. It's small, indexed, and (crucially on iOS,
 * where the WebView storage bucket can be evicted) reconstructable from the
 * container files if it were ever lost. Degrades to a no-op when IndexedDB is
 * unavailable (SSR / private mode).
 *
 * `sharedAssets` is one pseudo-region ({@link SHARED_REGION_ID}) holding the
 * style/tilejson/sprite/glyph/hillshade bytes reused across every region, so
 * they're fetched and stored once.
 */

const DB_NAME = "armada-offline-maps";
const DB_VERSION = 2;
const REGIONS = "regions";
const TILE_INDEX = "tileIndex";

/** The pseudo-region id under which shared (non-tile) assets are catalogued. */
export const SHARED_REGION_ID = "__shared__";

/** A downloaded region (or the shared-asset pseudo-region). */
export interface RegionRecord {
  id: string;
  /** User-facing name (default: reverse-geocoded; renameable). */
  name: string;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
  /** Provider tile-build prefix at download time, for staleness detection. */
  tileVersion: string;
  tileCount: number;
  bytes: number;
  createdAt: number;
}

/**
 * One key's location inside a region's flat container file (native), keyed by
 * `${regionId}\u0000${key}`. Absent on the web backend (blobs keyed directly).
 */
interface TileIndexRow extends TileIndexEntry {
  rowKey: string;
  regionId: string;
  key: string;
}

interface OfflineMapsDB extends DBSchema {
  [REGIONS]: {
    key: string;
    value: RegionRecord;
  };
  [TILE_INDEX]: {
    key: string;
    value: TileIndexRow;
    indexes: { "by-region": string; "by-key": string };
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineMapsDB> | null> | undefined;

function getDB(): Promise<IDBPDatabase<OfflineMapsDB> | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = openDB<OfflineMapsDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore(REGIONS, { keyPath: "id" });
        const idx = db.createObjectStore(TILE_INDEX, { keyPath: "rowKey" });
        idx.createIndex("by-region", "regionId");
      }
      if (oldVersion < 2) {
        // v2: index by tile key, so the protocol handler's "which regions have
        // this tile?" lookup is a point query instead of a full-store scan.
        tx.objectStore(TILE_INDEX).createIndex("by-key", "key");
      }
    },
  }).catch(() => null);
  return dbPromise;
}

const rowKey = (regionId: string, key: string): string => `${regionId}\u0000${key}`;

/** All catalogued regions except the shared-asset pseudo-region, newest first. */
export async function listRegions(): Promise<RegionRecord[]> {
  const db = await getDB();
  if (!db) return [];
  try {
    const all = await db.getAll(REGIONS);
    return all
      .filter((r) => r.id !== SHARED_REGION_ID)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** Fetch one region record (including the shared pseudo-region). */
export async function getRegion(id: string): Promise<RegionRecord | null> {
  const db = await getDB();
  if (!db) return null;
  try {
    return (await db.get(REGIONS, id)) ?? null;
  } catch {
    return null;
  }
}

/** Insert/replace a region record. */
export async function putRegion(record: RegionRecord): Promise<void> {
  const db = await getDB();
  if (!db) return;
  try {
    await db.put(REGIONS, record);
  } catch {
    // best-effort
  }
}

/** Rename a region. No-op if it doesn't exist. */
export async function renameRegion(id: string, name: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  try {
    const rec = await db.get(REGIONS, id);
    if (rec) await db.put(REGIONS, { ...rec, name });
  } catch {
    // best-effort
  }
}

/** Merge a batch of key→(offset,length) index rows for one region. */
export async function putTileIndex(
  regionId: string,
  index: Record<string, TileIndexEntry>,
): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const keys = Object.keys(index);
  if (keys.length === 0) return;
  try {
    const tx = db.transaction(TILE_INDEX, "readwrite");
    await Promise.all(
      keys.map((key) =>
        tx.store.put({
          rowKey: rowKey(regionId, key),
          regionId,
          key,
          offset: index[key].offset,
          length: index[key].length,
        }),
      ),
    );
    await tx.done;
  } catch {
    // best-effort
  }
}

/** Look up where `key` lives inside `regionId`'s container file. */
export async function getTileIndexEntry(
  regionId: string,
  key: string,
): Promise<TileIndexEntry | null> {
  const db = await getDB();
  if (!db) return null;
  try {
    const row = await db.get(TILE_INDEX, rowKey(regionId, key));
    return row ? { offset: row.offset, length: row.length } : null;
  } catch {
    return null;
  }
}

/**
 * Every region whose catalogued tile index contains `key` (a tile can belong to
 * several overlapping regions). Ordered newest-first so a lookup prefers the
 * freshest copy.
 */
export async function regionsContainingKey(key: string): Promise<
  { regionId: string; entry: TileIndexEntry }[]
> {
  const db = await getDB();
  if (!db) return [];
  try {
    const hits = await db.getAllFromIndex(TILE_INDEX, "by-key", key);
    if (hits.length === 0) return [];
    const regions = await db.getAll(REGIONS);
    const order = new Map(regions.map((r) => [r.id, r.createdAt]));
    return hits
      .sort((a, b) => (order.get(b.regionId) ?? 0) - (order.get(a.regionId) ?? 0))
      .map((r) => ({ regionId: r.regionId, entry: { offset: r.offset, length: r.length } }));
  } catch {
    return [];
  }
}

/** Delete a region's catalog record and its tile index rows. */
export async function deleteRegionRecord(id: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  try {
    await db.delete(REGIONS, id);
    const tx = db.transaction(TILE_INDEX, "readwrite");
    const keys = await tx.store.index("by-region").getAllKeys(id);
    await Promise.all(keys.map((k) => tx.store.delete(k)));
    await tx.done;
  } catch {
    // best-effort
  }
}

/** Sum of `bytes` across all real (non-shared) regions. */
export async function totalRegionBytes(): Promise<number> {
  const regions = await listRegions();
  return regions.reduce((n, r) => n + r.bytes, 0);
}

/** Test seam: close and reset the cached connection. */
export async function __resetOfflineManifestForTests(): Promise<void> {
  const prev = dbPromise;
  dbPromise = undefined;
  try {
    (await prev)?.close();
  } catch {
    // ignore
  }
}
