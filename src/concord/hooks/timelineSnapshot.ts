/**
 * The last painted window of a channel's timeline, persisted so a warm reload
 * paints before the key-derivation chain resolves (seeded from the route's
 * channel id on first render).
 *
 * - Seeded STALE, so the real store read still runs, and that read REPLACES the
 *   seed ({@link takeSnapshotSeed}) rather than merging into it: a row the store
 *   doesn't hold must not outlive the reload that restored it.
 * - Never holds an unsealed send: it was never a message, and `outgoing.ts`
 *   owns it until it is one.
 * - Never overwrites a populated cache (re-checked after the KV await).
 * - Rows filtered to their claimed channel id.
 * - Moderation is applied live by `foldTimeline`, not baked in.
 *
 * No new at-rest exposure (rumors are already stored decrypted); purged on logout.
 * SCOPED BY VIEWER, load-bearing: this cache is read before any key proves
 * membership, so without the pubkey key another account could read it.
 */
import { isUnsealedRow } from "@/concord/lib/outgoing";
import { listFoldedKeys, readFolded, writeFolded } from "@/lib/foldedCache";
import { perfMark } from "@/lib/perf";
import { isRemovedMessageId } from "@/lib/removedMessages";

import type { QueryClient } from "@tanstack/react-query";
import type { OpenedChat } from "@/concord/lib/chat";

const SNAP_WINDOW = 40;

const SNAP_PREFIX = "c2-timeline-snap:";

function snapKey(viewerPubkey: string, channelIdHex: string): string {
  return `${SNAP_PREFIX}${viewerPubkey}:${channelIdHex}`;
}

/** Rewrite every channel snapshot holding `rumorId` without it (removed from this device). */
export async function scrubTimelineSnapshots(rumorId: string): Promise<void> {
  const keys = await listFoldedKeys(SNAP_PREFIX).catch(() => []);
  await Promise.all(keys.map(async (key) => {
    const snap = await readFolded<OpenedChat[]>(key);
    if (!snap?.some((m) => m.rumorId === rumorId)) return;
    await writeFolded(key, snap.filter((m) => m.rumorId !== rumorId));
  }));
}

/** Rewrite every channel snapshot holding a banned user's rows without them; the store's tombstones replace them. */
export async function scrubTimelineSnapshotsByAuthor(author: string): Promise<void> {
  const keys = await listFoldedKeys(SNAP_PREFIX).catch(() => []);
  await Promise.all(keys.map(async (key) => {
    const snap = await readFolded<OpenedChat[]>(key);
    if (!snap?.some((m) => m.author === author)) return;
    await writeFolded(key, snap.filter((m) => m.author !== author));
  }));
}

const prewarmed = new Set<string>();
/** Channels whose cache currently holds a snapshot seed no store read has replaced yet. */
const seeded = new Set<string>();

/** Seed `queryKey` from the snapshot unless the cache has data. */
export async function prewarmTimelineSnapshot(
  queryClient: QueryClient,
  viewerPubkey: string,
  channelIdHex: string,
  queryKey: readonly unknown[],
): Promise<void> {
  const key = snapKey(viewerPubkey, channelIdHex);
  if (prewarmed.has(key)) return;
  prewarmed.add(key);
  if ((queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0) return;
  const snap = await readFolded<OpenedChat[]>(key);
  if (!snap || snap.length === 0) {
    perfMark("snap.prewarm", `${channelIdHex.slice(0, 8)} miss`);
    return;
  }
  const own = snap.filter((m) => m.channelIdHex === channelIdHex && !isUnsealedRow(m) && !isRemovedMessageId(m.rumorId));
  if (own.length === 0) return;
  // The real store read may have landed meanwhile; it wins.
  if ((queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0) return;
  // Stale on arrival: a first frame, never an answer.
  queryClient.setQueryData<OpenedChat[]>(queryKey, own, { updatedAt: Date.now() - 60_000 });
  seeded.add(key);
  perfMark("snap.prewarm", `${channelIdHex.slice(0, 8)} seeded ${own.length} row(s)`);
}

export function persistTimelineSnapshot(
  viewerPubkey: string,
  channelIdHex: string,
  window: OpenedChat[],
): Promise<void> {
  const sealed = window.filter((m) => !isUnsealedRow(m) && !isRemovedMessageId(m.rumorId));
  if (sealed.length === 0) return Promise.resolve();
  const key = snapKey(viewerPubkey, channelIdHex);
  const newest = sealed.sort((a, b) => b.ms - a.ms).slice(0, SNAP_WINDOW);
  // writeFolded skips an encoding identical to the last one it wrote.
  perfMark("snap.persist", `${channelIdHex.slice(0, 8)} ${newest.length} row(s)`);
  return writeFolded(key, newest);
}

/** Whether the cache holds an unreplaced snapshot seed; true at most once per seed. */
export function takeSnapshotSeed(viewerPubkey: string | undefined, channelIdHex: string): boolean {
  if (!viewerPubkey) return false;
  return seeded.delete(snapKey(viewerPubkey, channelIdHex));
}

/** Forget which channels were prewarmed/seeded. Logout. */
export function clearTimelineSnapshotMemory(): void {
  prewarmed.clear();
  seeded.clear();
}

/** Test seam. */
export const _resetTimelineSnapshotForTests = clearTimelineSnapshotMemory;
