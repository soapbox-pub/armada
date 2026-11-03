/**
 * Blocking someone drops this device's copies of their media: every cached blob
 * and decrypted attachment their stored rows name, and their profile picture and
 * banner. The rows themselves stay, so unblocking brings their messages back;
 * the media downloads again if it's shown.
 */
import { getArmadaDB } from "@/lib/db/armadaDB";
import { evictRowMedia } from "@/lib/evictMessageMedia";
import { isWrapTenant } from "@/lib/purgeBannedUser";
import { tenantIdsOf } from "@/lib/removeMessageFromDevice";

/** KV: the blocked users whose media this device has already dropped. */
const evictedKey = (self: string) => `blocked-media-evicted:${self}`;

/** Drop the device's copies of `pubkey`'s media, wherever their rows name it. */
export async function evictBlockedUserMedia(pubkey: string): Promise<void> {
  const db = getArmadaDB();
  for (const tenant of await tenantIdsOf(db)) {
    if (isWrapTenant(tenant)) continue;
    const rows = await db.tenant(tenant).query([{ authors: [pubkey] }]).catch(() => []);
    for (const row of rows) evictRowMedia(row);
  }
}

/**
 * Evict every user in `blocked` not yet evicted for `self`, then forget the ones
 * no longer blocked, so blocking them again evicts again.
 */
export async function evictNewlyBlockedMedia(
  self: string,
  blocked: ReadonlySet<string>,
  live: () => boolean = () => true,
): Promise<void> {
  const kv = getArmadaDB().kv;
  const stored = await kv.get<string[]>(evictedKey(self)).catch(() => undefined);
  const done = new Set(Array.isArray(stored) ? stored : []);
  const before = done.size;
  for (const pubkey of blocked) {
    if (done.has(pubkey)) continue;
    if (!live()) return;
    await evictBlockedUserMedia(pubkey);
    done.add(pubkey);
  }
  const next = [...done].filter((pk) => blocked.has(pk));
  if (done.size !== before || next.length !== done.size) {
    await kv.set(evictedKey(self), next).catch(() => undefined);
  }
}
