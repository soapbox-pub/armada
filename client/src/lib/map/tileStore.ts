import type { TileIndexEntry } from "@/lib/map/tileContainer";

/**
 * Storage backend for offline map bytes (tiles + shared assets).
 *
 * Two implementations, chosen at runtime by platform (see {@link getTileStore}):
 *
 *  - **native** (Capacitor Android/iOS): one flat container file per region in
 *    the app's private data directory — bounded only by device disk and immune
 *    to WebView storage eviction, which IndexedDB is *not* on iOS. Reads are
 *    ranged (offset+length) so a multi-hundred-MB region file is never loaded
 *    whole into memory.
 *  - **web / Electron**: each key is its own IndexedDB blob row. Accepts that
 *    the browser storage bucket may be evicted under pressure — the honest
 *    limit of the pure-web target.
 *
 * The download pipeline appends batches to a region via {@link appendRegion}
 * (returning the offset index to merge into the manifest); the map protocol
 * handler reads a single key via {@link readKey}. Deleting a region drops its
 * bytes ({@link deleteRegion}).
 */
export interface TileStore {
  /**
   * Append a batch of (key → bytes) to `regionId`'s storage. Returns the
   * `(offset,length)` index for the appended keys (native: positions in the
   * container file; web: zero-length placeholders, since blobs are keyed
   * directly). The caller merges this into the manifest DB.
   */
  appendRegion(
    regionId: string,
    entries: { key: string; bytes: Uint8Array }[],
  ): Promise<Record<string, TileIndexEntry>>;

  /**
   * Read one key's bytes. `regionId`/`entry` are the manifest's hint for the
   * native container (offset+length); the web backend ignores them and looks
   * the blob up directly. Returns null if absent.
   */
  readKey(
    regionId: string,
    key: string,
    entry: TileIndexEntry | null,
  ): Promise<Uint8Array | null>;

  /** Remove all bytes for `regionId`. */
  deleteRegion(regionId: string): Promise<void>;

  /** Remove every offline-map byte (used on logout / storage reset). */
  clearAll(): Promise<void>;
}
