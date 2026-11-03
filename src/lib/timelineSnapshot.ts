/**
 * Synchronous last-known-good timeline snapshots in localStorage, seeding
 * timeline queries' `initialData` so the first frame paints before the slow
 * first IndexedDB read on cold Android WebView launches. Merges are
 * append-only/dedup-by-id, so the seed can't clobber fresher data. Not for the
 * DM conversation LIST, whose order depends on every conversation.
 *
 * Storage: `armada:snap:v1:<scope>` → foldedCache-encoded items (keeps
 * Uint8Array/bigint); `armada:snap:index` → shared LRU of scopes, oldest first.
 * Holds decrypted plaintext (same trust level as existing caches); the
 * `armada:` prefix gets it purged on logout.
 */

import { decode, encode } from "@/lib/foldedCache";

const PREFIX = "armada:snap:v1:";
const INDEX_KEY = "armada:snap:index";

/** Most snapshotted conversations kept across ALL transports (shared LRU). */
const MAX_SCOPES = 16;
/** Newest items kept per conversation — roughly one screenful plus headroom. */
const MAX_ITEMS = 30;

/** Snapshot scope for a NIP-29 group timeline. */
export function nip29SnapshotScope(relayUrl: string, groupId: string): string {
  return `nip29:${relayUrl}|${groupId}`;
}

/** Snapshot scope for a 1:1 DM thread (self-scoped: DMs are per-account). */
export function dmThreadSnapshotScope(self: string, peer: string): string {
  return `dm:${self}|${peer}`;
}

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(index: string[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Best-effort.
  }
}

/** Drop every snapshot holding an item by `author` (a banned user's): the next read repaints it. */
export function dropTimelineSnapshotsByAuthor(author: string): void {
  if (typeof localStorage === "undefined") return;
  const index = readIndex();
  const kept = index.filter((scope) => {
    const items = readTimelineSnapshot<{ pubkey?: unknown; author?: unknown }>(scope);
    if (!items?.some((item) => item?.pubkey === author || item?.author === author)) return true;
    try {
      localStorage.removeItem(PREFIX + scope);
    } catch {
      // ignore
    }
    return false;
  });
  if (kept.length !== index.length) writeIndex(kept);
}

/** Read a scope's snapshot, or undefined. Synchronous, for `initialData`. */
export function readTimelineSnapshot<T>(scope: string | undefined): T[] | undefined {
  if (!scope || typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw) return undefined;
    const items = decode<T[]>(raw);
    return Array.isArray(items) && items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the newest {@link MAX_ITEMS} (items oldest-first) and bump the scope
 * in the shared LRU. Best-effort.
 */
export function writeTimelineSnapshot(scope: string | undefined, items: readonly unknown[]): void {
  if (!scope || typeof localStorage === "undefined") return;
  if (items.length === 0) return;
  try {
    const newest = items.slice(-MAX_ITEMS);
    localStorage.setItem(PREFIX + scope, encode(newest));

    const index = readIndex().filter((s) => s !== scope);
    index.push(scope);
    while (index.length > MAX_SCOPES) {
      const evicted = index.shift();
      if (evicted) {
        try {
          localStorage.removeItem(PREFIX + evicted);
        } catch {
          // ignore
        }
      }
    }
    writeIndex(index);
  } catch {
    // Quota exceeded / unavailable — snapshots are best-effort.
  }
}
