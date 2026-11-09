/**
 * `@nostrify/indexeddb` answers a LIMITED scan by stepping a cursor newest-first,
 * one `continue()` round trip per row. Each round trip lands back on the main
 * thread, so under a busy boot a 400-row timeline window took seconds while the
 * same rows were a few `getAll()`s away. Its own search path already scans in
 * chunks: one key cursor finds a boundary 256 distinct keys down, one `getAll()`
 * fetches the chunk. Limited scans over a few ranges go that way too.
 *
 * Same answer: the newest `limit` matches across every range; which same-second rows
 * a cutting limit keeps may differ, as it already may between the engines. Not
 * for a small limit (a chunk would fetch 256 rows to keep one) or many ranges
 * (the chunked scan gathers up to `limit` per range before merging).
 *
 * Temporary: upstreamed as soapbox-pub/nostrify!146. Delete this module once a
 * released `@nostrify/indexeddb` pages large limited scans itself.
 */
import { NIndexedDB } from "@nostrify/indexeddb";

/** Below this, stepping a cursor reads fewer rows than one chunk. */
export const CHUNKED_MIN_LIMIT = 50;
/** Above this many ranges, the per-range gathering outweighs the round trips saved. */
export const CHUNKED_MAX_CURSORS = 4;

interface Plan {
  ids?: string[];
  indexOnly?: boolean;
  cursors: unknown[];
}
interface Parsed {
  limit?: number;
  neverMatch?: boolean;
  searchKeywords?: unknown;
  matches(row: unknown): boolean;
  matchesTime(createdAt: number): boolean;
}
type QueryFilter = (this: unknown, store: unknown, filter: Parsed, signal?: AbortSignal) => Promise<unknown[]>;
interface Internals {
  prototype: { queryFilter: QueryFilter };
  planScan(filter: Parsed): Plan;
  searchScan(store: unknown, plan: Plan, matches: (row: { created_at: number }) => boolean, limit: number, signal?: AbortSignal): Promise<unknown[]>;
}

/** Whether the library still has the internals this relies on (a test pins it). */
export function chunkedScansSupported(): boolean {
  const lib = NIndexedDB as unknown as Partial<Internals>;
  return typeof lib.prototype?.queryFilter === "function" && typeof lib.planScan === "function" && typeof lib.searchScan === "function";
}

let installed = false;

/** Route limited scans through the chunked path. Idempotent; a no-op if the internals moved. */
export function installChunkedScans(): void {
  if (installed || !chunkedScansSupported()) return;
  installed = true;
  const lib = NIndexedDB as unknown as Internals;
  const original = lib.prototype.queryFilter;
  lib.prototype.queryFilter = function (store, filter, signal) {
    const limit = filter.limit ?? Infinity;
    if (filter.neverMatch || filter.searchKeywords || limit === Infinity || limit < CHUNKED_MIN_LIMIT) {
      return original.call(this, store, filter, signal);
    }
    const plan = lib.planScan(filter);
    if (plan.ids || plan.cursors.length === 0 || plan.cursors.length > CHUNKED_MAX_CURSORS) {
      return original.call(this, store, filter, signal);
    }
    signal?.throwIfAborted();
    const matches = (row: { created_at: number }) => (plan.indexOnly ? filter.matchesTime(row.created_at) : filter.matches(row));
    return lib.searchScan(store, plan, matches, limit, signal);
  };
}
