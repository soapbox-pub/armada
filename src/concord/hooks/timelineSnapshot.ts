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
import { SnapshotLru } from "@/lib/snapshotLru";
import { isRemovedMessageId } from "@/lib/removedMessages";

import type { QueryClient } from "@tanstack/react-query";
import type { OpenedChat } from "@/concord/lib/chat";

const SNAP_WINDOW = 40;

const SNAP_PREFIX = "c2-timeline-snap:";

/** Channels keeping a snapshot; the least recently painted beyond it lose theirs. */
const SNAP_CHANNELS = 40;
const recent = new SnapshotLru(SNAP_PREFIX, "c2-timeline-recent", SNAP_CHANNELS);

function snapKey(viewerPubkey: string, channelIdHex: string): string {
  return `${SNAP_PREFIX}${viewerPubkey}:${channelIdHex}`;
}

/** Rewrite every channel snapshot holding any of `rumorIds` without them (removed from this device). */
export async function scrubTimelineSnapshots(rumorIds: readonly string[]): Promise<void> {
  const ids = new Set(rumorIds);
  const keys = await listFoldedKeys(SNAP_PREFIX).catch(() => []);
  await Promise.all(keys.map(async (key) => {
    const snap = await readFolded<OpenedChat[]>(key);
    if (!snap?.some((m) => ids.has(m.rumorId))) return;
    await writeFolded(key, snap.filter((m) => !ids.has(m.rumorId)));
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

/** Empty every viewer's snapshot of `channelIdHex` (a deleted Channel, CORD-03 §2). */
export async function dropChannelSnapshots(channelIdHex: string): Promise<void> {
  const keys = await listFoldedKeys(SNAP_PREFIX).catch(() => []);
  await Promise.all(keys.filter((k) => k.endsWith(`:${channelIdHex}`)).map((k) => writeFolded(k, [] as OpenedChat[])));
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
  // Without the envelope: painting never reads it, and it was most of each row.
  const newest = sealed.sort((a, b) => b.ms - a.ms).slice(0, SNAP_WINDOW).map(withoutEnvelope);
  // writeFolded skips an encoding identical to the last one it wrote.
  perfMark("snap.persist", `${channelIdHex.slice(0, 8)} ${newest.length} row(s)`);
  return writeFolded(key, newest).then(() => recent.touch(key));
}

/** Whether the cache holds an unreplaced snapshot seed; true at most once per seed. */
export function takeSnapshotSeed(viewerPubkey: string | undefined, channelIdHex: string): boolean {
  if (!viewerPubkey) return false;
  return seeded.delete(snapKey(viewerPubkey, channelIdHex));
}

function withoutEnvelope(row: OpenedChat): OpenedChat {
  if (row.seal === undefined && row.wrapId === undefined) return row;
  const { seal: _seal, wrapId: _wrapId, ...rest } = row;
  return rest;
}

/** Forget which channels were prewarmed/seeded. Logout. */
export function clearTimelineSnapshotMemory(): void {
  prewarmed.clear();
  seeded.clear();
  recent.reset();
}

/** Test seam. */
export const _resetTimelineSnapshotForTests = clearTimelineSnapshotMemory;
