/**
 * The last painted window of a NIP-17 conversation, persisted in ArmadaDB KV so
 * a warm reload paints instantly instead of waiting on `queryDm17Thread`.
 * Same rules as the Concord timeline snapshot:
 *  - seeded STALE so the real read still runs and heals behind it;
 *  - never overwrites a populated cache (re-checked after the await);
 *  - rows filtered to the conversation they claim.
 * Plus: NIP-40 expiry is applied at write AND read, so disappearing messages
 * can't come back from cache. The rumors are already stored decrypted in
 * dm17Store, so no new at-rest exposure; purged on logout with the KV.
 */
import { listFoldedKeys, readFolded, writeFolded } from "@/lib/foldedCache";
import { isExpired } from "@/lib/nip17/protocol";
import { isRemovedMessageId } from "@/lib/removedMessages";
import { dmConvKey } from "@/lib/nip17/conversation";
import { perfCount, perfMark } from "@/lib/perf";

import type { OpenedDm } from "@/lib/nip17/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { nowSecs } from "@/lib/relayClock";

/**
 * Newest rows kept per conversation. Larger than the channel snapshot's 40
 * because reactions/deletes/timers share the window; truncating newest-first
 * is safe since those are always newer than their targets.
 */
const SNAP_WINDOW = 80;

const SNAP_PREFIX = "dm17-thread-snap:";

function snapKey(self: string, conversation: string): string {
  return `${SNAP_PREFIX}${self}:${conversation}`;
}

/** Rewrite every conversation snapshot holding any of `rumorIds` without them (removed from this device). */
export async function scrubDm17ThreadSnapshots(rumorIds: readonly string[]): Promise<void> {
  const ids = new Set(rumorIds);
  const keys = await listFoldedKeys(SNAP_PREFIX).catch(() => []);
  await Promise.all(keys.map(async (key) => {
    const snap = await readFolded<OpenedDm[]>(key);
    if (!snap?.some((m) => ids.has(m.rumorId))) return;
    await writeFolded(key, snap.filter((m) => !ids.has(m.rumorId)));
  }));
}

/** Rewrite every conversation snapshot holding a banned user's messages without them. */
export async function scrubDm17ThreadSnapshotsByAuthor(author: string): Promise<void> {
  const keys = await listFoldedKeys(SNAP_PREFIX).catch(() => []);
  await Promise.all(keys.map(async (key) => {
    const snap = await readFolded<OpenedDm[]>(key);
    if (!snap?.some((m) => m.author === author)) return;
    await writeFolded(key, snap.filter((m) => m.author !== author));
  }));
}

/**
 * One prewarm attempt per query key per session; the write path keeps it fresh.
 * FIFO-capped: a forgotten key only costs one more snapshot read.
 */
const prewarmed = new Set<string>();
const PREWARMED_MAX = 1000;

/**
 * Seed `queryKey` (the conversation's thread query) from the persisted
 * snapshot, unless the cache already has data. Fire-and-forget from an effect.
 */
export async function prewarmDm17ThreadSnapshot(
  queryClient: QueryClient,
  self: string,
  conversation: string,
  queryKey: readonly unknown[],
): Promise<void> {
  // Keyed by query key, which carries decrypt-consent state, so a consent change re-seeds.
  const once = JSON.stringify(queryKey);
  if (prewarmed.has(once)) return;
  prewarmed.add(once);
  if (prewarmed.size > PREWARMED_MAX) prewarmed.delete(prewarmed.values().next().value as string);
  if ((queryClient.getQueryData<OpenedDm[]>(queryKey)?.length ?? 0) > 0) return;
  const snap = await readFolded<OpenedDm[]>(snapKey(self, conversation));
  if (!snap || snap.length === 0) {
    perfMark("dm17.snap.prewarm", `${conversation.slice(0, 8)} miss`);
    return;
  }
  const now = nowSecs();
  // Re-check rows against their conversation so a corrupted snapshot can't cross-paint.
  const own = snap.filter(
    (m) => dmConvKey(m.peers ?? []) === conversation && !isExpired(m.tags, now) && !isRemovedMessageId(m.rumorId),
  );
  if (own.length === 0) return;
  // The real store read may have landed during the await; it wins.
  if ((queryClient.getQueryData<OpenedDm[]>(queryKey)?.length ?? 0) > 0) return;
  // Stale on arrival so the mount still runs the store read and inbox sync.
  queryClient.setQueryData<OpenedDm[]>(queryKey, own, { updatedAt: Date.now() - 60_000 });
  perfMark("dm17.snap.prewarm", `${conversation.slice(0, 8)} seeded ${own.length} row(s)`);
}

/** Persist the newest {@link SNAP_WINDOW} unexpired rows of `window`. */
export function persistDm17ThreadSnapshot(
  self: string,
  conversation: string,
  window: readonly OpenedDm[],
): Promise<void> {
  if (window.length === 0) return Promise.resolve();
  const now = nowSecs();
  const newest = window
    .filter((m) => !isExpired(m.tags, now) && !isRemovedMessageId(m.rumorId))
    .sort((a, b) => b.createdAt - a.createdAt || (a.rumorId < b.rumorId ? -1 : 1))
    .slice(0, SNAP_WINDOW);
  if (newest.length === 0) return Promise.resolve();
  // Aggregated, not a mark: marks are an unbounded timeline and this runs per paint.
  perfCount("dm17.snap.persist", 0, newest.length, "rows");
  // writeFolded skips an encoding identical to the last one written.
  return writeFolded(snapKey(self, conversation), newest);
}

/** Forget this session's prewarm attempts (logout). */
export function clearDm17ThreadSnapshotMemory(): void {
  prewarmed.clear();
}

/** Test seam. */
export const _resetDm17ThreadSnapshotForTests = clearDm17ThreadSnapshotMemory;
