/**
 * A deleted Channel leaves this device (CORD-03 §2, Vector `purge_deleted_channel`):
 * what it holds of the Chat Plane, the files its account uploaded there that nothing
 * else uses, and, paced and resuming across restarts, its account's own wraps there
 * that this device can delete: their owner derived from the account key, or kept.
 * Its keys stay, since a Roster change can undo a deletion.
 */

import { dropChannelSnapshots } from "@/concord/hooks/timelineSnapshot";
import { forgetChatRumor } from "@/concord/lib/chat";
import { bytesToHex, hexToBytes } from "@/concord/lib/derive";
import { forgetStoredSeals, queryChannelRumors, removeRumors } from "@/concord/lib/rumorStore";
import type { Channel, Community } from "@/concord/lib/types";
import { canScrub, scrubOwnWraps, type ScrubPool } from "@/concord/lib/wrapScrub";
import { forgetTokenizedContent } from "@/components/chat/tokenCache";
import { forgetRenderedPlaintext } from "@/hooks/dmRenderCache";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { evictMessageMedia, mediaRefs } from "@/lib/evictMessageMedia";
import { otherUsersOfMedia } from "@/lib/removeMessageFromDevice";
import { logSync } from "@/lib/syncLog";

/** The most rows one purge reads; a second fold finds the rest. */
const PURGE_LIMIT = 50_000;
/** One wrap a second: a large Channel leaves the relays without flooding them. */
export const SCRUB_PACE_MS = 1_000;

/** A queued deletion of one of this account's wraps: where it was sent, by which plane keys. */
interface QueuedScrub {
  communityIdHex: string;
  relays: string[];
  addresses: { pk: string; sk?: string }[];
}

const scrubQueue = new KvPrefixCache<QueuedScrub>({ prefix: "c2scrub:" });

export interface PurgeResult {
  removed: number;
  uploads: string[];
  queued: number;
}

/**
 * Drop what this device holds of `channel`, whose deletion the Control Plane carries.
 * A second run finds nothing, so it may run on every fold.
 */
export async function purgeDeletedChannel(
  community: Community,
  channel: Channel,
  self: string,
  secret: Uint8Array | undefined,
): Promise<PurgeResult> {
  const rows = await queryChannelRumors(community.idHex, channel.idHex, { limit: PURGE_LIMIT });
  if (rows.length === 0) return { removed: 0, uploads: [], queued: 0 };
  const mine = rows.filter((r) => r.author === self);

  await scrubQueue.ready();
  let queued = 0;
  for (const r of mine) {
    if (!(await canScrub(secret, r.rumorId))) continue;
    const addresses = channel.streams
      .filter((st) => st.epoch === r.epoch)
      .map((st) => ({ pk: st.group.pk, ...(st.group.sk ? { sk: bytesToHex(st.group.sk) } : {}) }));
    if (addresses.length === 0) continue;
    scrubQueue.set(r.rumorId, { communityIdHex: community.idHex, relays: community.relays, addresses });
    queued++;
  }

  const ids = rows.map((r) => r.rumorId);
  for (const id of ids) {
    forgetChatRumor(id);
    forgetRenderedPlaintext(id);
    forgetTokenizedContent(id);
  }
  await removeRumors(community.idHex, ids);
  await dropChannelSnapshots(channel.idHex);
  await Promise.all(ids.map((id) => forgetStoredSeals([community.idHex], id)));

  // With the Channel's rows gone, a file is unused once nothing outside it names it.
  const db = getArmadaDB();
  const uploads = new Set<string>();
  for (const r of rows) {
    const refs = mediaRefs(r.tags, r.content);
    if (refs.urls.size === 0 && refs.hashes.size === 0) continue;
    const kept = await otherUsersOfMedia(db, { id: r.rumorId, tags: r.tags, content: r.content });
    evictMessageMedia(r.tags, r.content, kept);
    if (r.author !== self) continue;
    const inUse = new Set(kept.flatMap((k) => [...mediaRefs(k.tags, k.content).urls]));
    for (const url of refs.urls) if (!inUse.has(url)) uploads.add(url);
  }
  logSync("purge", `${community.idHex.slice(0, 8)} #${channel.idHex.slice(0, 8)} deleted: ${ids.length} row(s) dropped, ${mine.length} own`);
  return { removed: ids.length, uploads: [...uploads], queued };
}

let draining = false;

/**
 * Work through the queued wrap deletions, one per {@link SCRUB_PACE_MS}, until none
 * is left; one that can't go out stays queued and the next drain tries again.
 */
export async function drainWrapScrubs(pool: ScrubPool, secret: Uint8Array | undefined, paceMs = SCRUB_PACE_MS): Promise<number> {
  if (draining) return 0;
  draining = true;
  let done = 0;
  try {
    await scrubQueue.ready();
    for (const id of scrubQueue.ids()) {
      const q = scrubQueue.get(id);
      if (!q) continue;
      const addresses = q.addresses.map((a) => ({ pk: a.pk, ...(a.sk ? { sk: hexToBytes(a.sk) } : {}) }));
      const scrubbed = await scrubOwnWraps(pool, q.relays, addresses, [id], secret).catch(() => undefined);
      // One that can't go out stays queued for the next drain (Vector `drain_scrubs`).
      if (!scrubbed?.settled) break;
      scrubQueue.delete(id);
      done++;
      if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    }
  } finally {
    draining = false;
  }
  return done;
}

/** For tests and logout. */
export function queuedWrapScrubs(): string[] {
  return scrubQueue.ids();
}
