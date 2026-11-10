/**
 * Discover boosts: a NIP-32 label (kind 1985) vouching for a listed community:
 *
 *   ["L", "armada.discover"]
 *   ["l", "boost", "armada.discover"]
 *   ["e", <announcement id>] …          the community's listings
 *   ["nonce", …, "18"]                  NIP-13 work
 *
 * Boosts are read through Discover's web of trust, so a stranger's listing
 * surfaces only once someone in it (not its owner) boosts it. A boost counts for
 * {@link BOOST_WINDOW_SECONDS}, enforced by readers, and is withdrawn by its
 * author's kind 5.
 */

import { hexToBytes } from "@noble/hashes/utils.js";
import { leadingZeroBits } from "@/lib/pow";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

export const LABEL_KIND = 1985;
export const DISCOVER_LABEL_NAMESPACE = "armada.discover";
export const DISCOVER_BOOST = "boost";

/** Cheap once, costly in bulk. */
export const BOOST_POW_BITS = 18;
export const BOOST_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** Active boosts reaching each level. Cosmetic. */
export const BOOST_LEVELS = [2, 7, 14] as const;

const HEX64 = /^[0-9a-f]{64}$/;

export function buildBoostLabel(announcementIds: readonly string[]): EventTemplate {
  return {
    kind: LABEL_KIND,
    content: "",
    tags: [
      ["L", DISCOVER_LABEL_NAMESPACE],
      ["l", DISCOVER_BOOST, DISCOVER_LABEL_NAMESPACE],
      ...[...new Set(announcementIds)].map((id) => ["e", id]),
      ["alt", "Discover: boosted community"],
      ["nonce", "", String(BOOST_POW_BITS)],
    ],
  };
}

export function buildBoostWithdrawal(labelIds: readonly string[]): EventTemplate {
  return {
    kind: 5,
    content: "",
    tags: [...labelIds.map((id) => ["e", id]), ["k", String(LABEL_KIND)]],
  };
}

export interface Boost {
  pubkey: string;
  event: NostrRumor;
}

/** Boosts per announcement id: newest per booster, oldest booster first. */
export type BoostsByListing = Map<string, Boost[]>;

/** Earliest `created_at` a boost still counts from. */
export function boostFloor(nowSeconds: number = nowSecs()): number {
  return nowSeconds - BOOST_WINDOW_SECONDS;
}

function hasBoostWork(event: NostrRumor): boolean {
  return HEX64.test(event.id) && leadingZeroBits(hexToBytes(event.id)) >= BOOST_POW_BITS;
}

/**
 * Fold labels and deletions into the boosts that count: in the namespace, carrying
 * the work, inside the window, and not withdrawn. A kind 5 removes a label only
 * when its signer wrote it, so nobody can strip someone else's boost.
 */
export function foldBoosts(events: readonly NostrRumor[], nowSeconds?: number): BoostsByListing {
  const floor = boostFloor(nowSeconds);
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== 5) continue;
    for (const [name, id] of event.tags) if (name === "e" && id) deleted.add(`${event.pubkey}:${id}`);
  }
  const newest = new Map<string, Map<string, Boost>>();
  for (const event of events) {
    if (event.kind !== LABEL_KIND || event.created_at < floor || deleted.has(`${event.pubkey}:${event.id}`)) continue;
    if (!event.tags.some(([n, v, ns]) => n === "l" && v === DISCOVER_BOOST && ns === DISCOVER_LABEL_NAMESPACE)) continue;
    if (!hasBoostWork(event)) continue;
    for (const [name, listing] of event.tags) {
      if (name !== "e" || !listing || !HEX64.test(listing)) continue;
      const byBooster = newest.get(listing) ?? new Map<string, Boost>();
      const prev = byBooster.get(event.pubkey);
      if (!prev || event.created_at > prev.event.created_at) byBooster.set(event.pubkey, { pubkey: event.pubkey, event });
      newest.set(listing, byBooster);
    }
  }
  const out: BoostsByListing = new Map();
  for (const [listing, byBooster] of newest) {
    out.set(listing, [...byBooster.values()].sort((a, b) => a.event.created_at - b.event.created_at));
  }
  return out;
}

/** The boosts of any of `listings` (one community's), one per booster, oldest first. */
export function boostsFor(boosts: BoostsByListing, listings: readonly string[]): Boost[] {
  const byBooster = new Map<string, Boost>();
  for (const listing of listings) {
    for (const boost of boosts.get(listing) ?? []) {
      const prev = byBooster.get(boost.pubkey);
      if (!prev || boost.event.created_at > prev.event.created_at) byBooster.set(boost.pubkey, boost);
    }
  }
  return [...byBooster.values()].sort((a, b) => a.event.created_at - b.event.created_at);
}

/** The level `count` active boosts reach (0–3), and how many the next one needs. */
export function boostLevel(count: number): { level: number; next: number | undefined } {
  const level = BOOST_LEVELS.filter((needed) => count >= needed).length;
  return { level, next: BOOST_LEVELS[level] };
}

/**
 * The boosts that vouch for a listing: by someone in `vouchers` (`null`, under the
 * unfiltered switch, is anyone), and never its owner's own.
 */
export function vouchingBoosts(boosts: readonly Boost[], vouchers: ReadonlySet<string> | null, owner: string): Boost[] {
  return boosts.filter((b) => b.pubkey !== owner && (vouchers === null || vouchers.has(b.pubkey)));
}
