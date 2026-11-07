/**
 * Deleting this account's own giftwraps from a Community's relays (CORD-01 §Deletions,
 * Vector `message_delete.rs`). Each wrap's `p` is derived from the author's key and the
 * message (`concord/wrap-owner`), so any device holding that key finds and deletes them
 * without having saved anything; the derived key is checked against the wrap's `p` by
 * asking relays for exactly the wraps that carry it.
 */

import { clockNowMs } from "@/lib/relayClock";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { bytesToHex, hexToBytes, wrapOwnerKey } from "@/concord/lib/derive";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { finalizePowEvent } from "@/lib/pow";

/** A giftwrap deletion outlives any honest re-broadcast of what it deletes, then leaves: 90 days. */
export const WRAP_DELETION_EXPIRY_SECS = 90 * 24 * 60 * 60;
/** An in-plane delete whose wraps left the relays expires after 30 days, or with the message if sooner. */
export const SCRUBBED_DELETE_EXPIRY_SECS = 30 * 24 * 60 * 60;

/** Random owners a remote-signer account's device kept, by rumor id: only it can delete those wraps. */
const keptOwners = new KvPrefixCache<string>({ prefix: "c2wrapown:" });

/** The `p` key for this account's wrap of `rumorId` at `address`: derived when the account key is held, else one this device kept. */
export function ownWrapOwner(secret: Uint8Array | undefined, address: string, rumorId: string): Uint8Array | undefined {
  if (secret) return wrapOwnerKey(secret, address, hexToBytes(rumorId)).sk;
  const kept = keptOwners.get(rumorId);
  return kept ? hexToBytes(kept) : undefined;
}

/** The `p` key a send of `rumorId` uses: derived when it can be, else a fresh one this device keeps (CORD-01 §Deletions). */
export async function sendWrapOwner(secret: Uint8Array | undefined, address: string, rumorId: string): Promise<Uint8Array> {
  if (secret) return wrapOwnerKey(secret, address, hexToBytes(rumorId)).sk;
  await keptOwners.ready();
  const kept = keptOwners.get(rumorId);
  if (kept) return hexToBytes(kept);
  const sk = generateSecretKey();
  keptOwners.set(rumorId, bytesToHex(sk));
  return sk;
}

/** Whether this device can delete `rumorId`'s wraps: the account key derives their owner, or it kept one. */
export async function canScrub(secret: Uint8Array | undefined, rumorId: string): Promise<boolean> {
  if (secret) return true;
  await keptOwners.ready();
  return keptOwners.get(rumorId) !== undefined;
}

/** A kept owner is dropped once its deletion went out. */
export function forgetKeptOwner(rumorId: string): void {
  keptOwners.delete(rumorId);
}

export interface ScrubPool {
  query(relay: string, filters: NostrFilter[], signal: AbortSignal): Promise<NostrEvent[]>;
  publish(relay: string, event: NostrEvent, signal: AbortSignal): Promise<void>;
}

/** What a scrub reached: the owner's deletions every CORD-01 relay honours, and the plane key's for the rest. */
export interface Scrubbed {
  byOwner: boolean;
  byPlane: boolean;
  /** Nothing is left for this device to delete: a relay answered, and every owner deletion went out. */
  settled: boolean;
}

/** A NIP-09 deletion of giftwraps, `k` naming their kind, expiring once nothing could re-broadcast them. */
function wrapDeletion(wrapIds: string[], sk: Uint8Array, nowSecs: number): Promise<NostrEvent> {
  return finalizePowEvent(
    {
      kind: 5,
      content: "",
      tags: [...wrapIds.map((id) => ["e", id]), ["k", String(KIND_WRAP)], ["expiration", String(nowSecs + WRAP_DELETION_EXPIRY_SECS)]],
      created_at: nowSecs,
    },
    sk,
  );
}

/**
 * Delete from `relays` this account's wraps of `rumorIds`, sent at any of `addresses`
 * (each with the plane key that signed them, where held): one owner deletion per wrap, so none ties
 * wraps together, and best-effort one plane-key deletion per address for relays that
 * judge by author.
 */
export async function scrubOwnWraps(
  pool: ScrubPool,
  relays: readonly string[],
  addresses: readonly { pk: string; sk?: Uint8Array }[],
  rumorIds: readonly string[],
  secret: Uint8Array | undefined,
  opts: { timeoutMs?: number; nowSecs?: number } = {},
): Promise<Scrubbed> {
  await keptOwners.ready();
  const nowSecs = opts.nowSecs ?? Math.floor(clockNowMs() / 1000);
  const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 6_000);
  const owners = new Map<string, { sk: Uint8Array; address: string }>();
  for (const a of addresses) {
    for (const id of rumorIds) {
      const sk = ownWrapOwner(secret, a.pk, id);
      if (sk) owners.set(getPublicKey(sk), { sk, address: a.pk });
    }
  }
  if (owners.size === 0) return { byOwner: false, byPlane: false, settled: true };
  const filter: NostrFilter = { kinds: [KIND_WRAP], authors: addresses.map((a) => a.pk), "#p": [...owners.keys()] };
  const found = new Map<string, NostrEvent>();
  const searched = await Promise.allSettled(relays.map(async (url) => {
    for (const ev of await pool.query(url, [filter], signal())) found.set(ev.id, ev);
  }));
  // A search no relay answered found nothing, which is no evidence there's nothing.
  const answered = searched.some((r) => r.status === "fulfilled");
  const wraps = [...found.values()].flatMap((w) => {
    const p = w.tags.find((t) => t[0] === "p")?.[1];
    const owner = p ? owners.get(p) : undefined;
    return owner && owner.address === w.pubkey ? [{ wrap: w, owner }] : [];
  });
  if (wraps.length === 0) {
    // A relay answered and holds none of them: nothing is left for a kept owner to delete.
    if (answered && !secret) for (const id of rumorIds) forgetKeptOwner(id);
    return { byOwner: false, byPlane: false, settled: answered };
  }

  const sentAnywhere = async (event: NostrEvent) => {
    const results = await Promise.allSettled(relays.map((url) => pool.publish(url, event, signal())));
    return results.some((r) => r.status === "fulfilled");
  };
  const ownerSent = await Promise.all(wraps.map(async ({ wrap, owner }) => sentAnywhere(await wrapDeletion([wrap.id], owner.sk, nowSecs))));
  let byPlane = false;
  for (const a of addresses) {
    const ids = wraps.filter((w) => w.wrap.pubkey === a.pk).map((w) => w.wrap.id);
    if (ids.length === 0 || !a.sk) continue;
    await sentAnywhere(await wrapDeletion(ids, a.sk, nowSecs));
    byPlane = true;
  }
  const byOwner = ownerSent.every(Boolean);
  if (byOwner && !secret) for (const id of rumorIds) forgetKeptOwner(id);
  return { byOwner, byPlane, settled: byOwner };
}

/** When the in-plane delete may leave the relays: once its wraps were deleted every way, 30 days on or with the message. */
export function scrubbedDeleteExpiry(scrubbed: Pick<Scrubbed, "byOwner" | "byPlane">, messageExpiry: number | undefined, nowSecs: number): number | null {
  if (!scrubbed.byOwner || !scrubbed.byPlane) return null;
  const until = nowSecs + SCRUBBED_DELETE_EXPIRY_SECS;
  return messageExpiry !== undefined ? Math.min(messageExpiry, until) : until;
}
