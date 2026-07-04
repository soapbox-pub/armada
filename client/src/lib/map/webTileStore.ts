import { type DBSchema, type IDBPDatabase, openDB } from "idb";

import type { TileStore } from "@/lib/map/tileStore";
import type { TileIndexEntry } from "@/lib/map/tileContainer";

/**
 * Web/Electron {@link TileStore}: each cached key is its own IndexedDB blob row,
 * keyed by `${regionId}\u0000${key}`. There's no container file, so the
 * appended index carries zero-length placeholders (unused on this backend —
 * {@link readKey} looks blobs up directly). This is the pure-web fallback where
 * Capacitor Filesystem isn't available; it lives in the WebView storage bucket
 * and may be evicted under pressure, which is the unavoidable web limitation.
 */

const DB_NAME = "armada-offline-tiles";
const DB_VERSION = 1;
const STORE = "blobs";

interface TileBlobDB extends DBSchema {
  [STORE]: {
    key: string;
    value: { rowKey: string; regionId: string; key: string; bytes: Uint8Array };
    indexes: { "by-region": string };
  };
}

let dbPromise: Promise<IDBPDatabase<TileBlobDB> | null> | undefined;

function getDB(): Promise<IDBPDatabase<TileBlobDB> | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = openDB<TileBlobDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: "rowKey" });
      store.createIndex("by-region", "regionId");
    },
  }).catch(() => null);
  return dbPromise;
}

const rowKey = (regionId: string, key: string): string => `${regionId}\u0000${key}`;

export const webTileStore: TileStore = {
  async appendRegion(regionId, entries) {
    const index: Record<string, TileIndexEntry> = {};
    const db = await getDB();
    if (!db) return index;
    try {
      const tx = db.transaction(STORE, "readwrite");
      await Promise.all(
        entries.map(({ key, bytes }) => {
          index[key] = { offset: 0, length: bytes.length };
          return tx.store.put({ rowKey: rowKey(regionId, key), regionId, key, bytes });
        }),
      );
      await tx.done;
    } catch {
      // best-effort
    }
    return index;
  },

  async readKey(regionId, key) {
    const db = await getDB();
    if (!db) return null;
    try {
      const row = await db.get(STORE, rowKey(regionId, key));
      return row?.bytes ?? null;
    } catch {
      return null;
    }
  },

  async deleteRegion(regionId) {
    const db = await getDB();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      const keys = await tx.store.index("by-region").getAllKeys(regionId);
      await Promise.all(keys.map((k) => tx.store.delete(k)));
      await tx.done;
    } catch {
      // best-effort
    }
  },

  async clearAll() {
    const db = await getDB();
    if (!db) return;
    try {
      await db.clear(STORE);
    } catch {
      // best-effort
    }
  },
};
