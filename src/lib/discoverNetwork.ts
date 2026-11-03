import { contactListPubkeys } from "@/lib/contactList";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Discover's one web-of-trust hop, after Ditto's: the people the viewer's
 * follows follow, ranked by how many of those follows name them.
 */

/** Ranked hop members kept; the rest of a large network is noise. */
export const DISCOVER_NETWORK_LIMIT = 2000;

/**
 * Authors per filter, one filter set per REQ: strfry relays reject filters past
 * a total item count ("total filter items too large"), and a search variant
 * rides in the same REQ as its plain twin.
 */
export const DISCOVER_AUTHOR_CHUNK = 300;

export function chunkAuthors(authors: string[], size = DISCOVER_AUTHOR_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < authors.length; i += size) chunks.push(authors.slice(i, i + size));
  return chunks;
}

/**
 * Pubkeys named by the newest kind 3 of each of `follows`, scored by how many
 * lists name them (once per list), highest first. Excludes the viewer and
 * `follows` themselves, which Discover already includes directly. Lists by
 * anyone outside `follows` are ignored, so a relay can't inject endorsements.
 */
export function rankDiscoverNetwork(
  viewer: string,
  follows: string[],
  lists: NostrRumor[],
  limit = DISCOVER_NETWORK_LIMIT,
): string[] {
  const direct = new Set(follows);
  const newest = new Map<string, NostrRumor>();
  for (const event of lists) {
    if (event.kind !== 3 || !direct.has(event.pubkey) || event.pubkey === viewer) continue;
    const prev = newest.get(event.pubkey);
    if (!prev || event.created_at > prev.created_at) newest.set(event.pubkey, event);
  }
  const counts = new Map<string, number>();
  for (const list of newest.values()) {
    for (const pk of new Set(contactListPubkeys(list))) {
      if (pk === viewer || direct.has(pk)) continue;
      counts.set(pk, (counts.get(pk) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([pk]) => pk);
}

/** A network as stored in KV: the hex pubkeys concatenated, ~half the size of a JSON array. */
export interface StoredDiscoverNetwork {
  updatedAt: number;
  authors: string;
}

export function packNetwork(authors: string[], updatedAt: number): StoredDiscoverNetwork {
  return { updatedAt, authors: authors.join("") };
}

export function unpackNetwork(stored: unknown): { updatedAt: number; authors: string[] } | null {
  if (!stored || typeof stored !== "object") return null;
  const { updatedAt, authors } = stored as Partial<StoredDiscoverNetwork>;
  if (typeof updatedAt !== "number" || typeof authors !== "string" || authors.length % 64 !== 0) return null;
  if (!/^[0-9a-f]*$/.test(authors)) return null;
  const out: string[] = [];
  for (let i = 0; i < authors.length; i += 64) out.push(authors.slice(i, i + 64));
  return { updatedAt, authors: out };
}
