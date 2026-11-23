/**
 * The Vector Hub: Vector's community directory at vectorapp.io, read into
 * Discover beside the kind-3314 announcements.
 *
 * Not a Nostr feature — an HTTP JSON list the Vector team reviews, each entry a
 * plain Concord invite link. The card resolves the link like any other, so the
 * hub's own name/description/icon are never shown; only what the link's bundle
 * says. What the hub alone knows (category, member count, its "official" mark)
 * is shown as the hub's claim.
 */

import { parseInviteLink } from "@/concord/lib/invite";
import { config } from "@/lib/env";

/** The hub's listing endpoint. Unset = Vector's public hub; empty = off. */
export const VECTOR_HUB_URL: string = (config("VECTOR_HUB_URL") ?? "https://vectorapp.io/api/hub").trim();

/** Where a person can browse or submit to the hub itself. */
export const VECTOR_HUB_PAGE = "https://vectorapp.io/hub";

/** A listing from the hub, reduced to what Discover uses. */
export interface VectorHubListing {
  /** The hub's own id for the listing. */
  id: number;
  inviteUrl: string;
  linkSigner: string;
  category: string;
  /** The hub poller's member count; null until it has polled. */
  memberCount: number | null;
  /** Curated by the Vector team. */
  official: boolean;
  /** Unix seconds. */
  createdAt: number;
  /** Position in the hub's own order (official first, then busiest). */
  rank: number;
}

const MAX_CATEGORY = 80;

/** The hub's response as listings, in its order, one per link. Malformed entries are dropped. */
export function parseVectorHub(body: unknown): VectorHubListing[] {
  if (!Array.isArray(body)) return [];
  const out: VectorHubListing[] = [];
  const seen = new Set<string>();
  for (const raw of body) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.invite_url !== "string") continue;
    const inviteUrl = entry.invite_url.trim();
    const parsed = parseInviteLink(inviteUrl);
    if (!parsed || seen.has(parsed.linkSigner)) continue;
    seen.add(parsed.linkSigner);
    const memberCount = entry.member_count;
    out.push({
      id: typeof entry.id === "number" ? entry.id : 0,
      inviteUrl,
      linkSigner: parsed.linkSigner,
      category: typeof entry.category === "string" ? entry.category.trim().slice(0, MAX_CATEGORY) : "",
      memberCount:
        typeof memberCount === "number" && Number.isSafeInteger(memberCount) && memberCount >= 0 ? memberCount : null,
      official: entry.official === true,
      createdAt: typeof entry.created_at === "number" && Number.isFinite(entry.created_at) ? entry.created_at : 0,
      rank: out.length,
    });
  }
  return out;
}

/** Fetch the hub's listings. Throws on a network error or a non-2xx answer. */
export async function fetchVectorHub(url: string, signal?: AbortSignal): Promise<VectorHubListing[]> {
  const res = await fetch(url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Vector Hub answered ${res.status}`);
  return parseVectorHub(await res.json());
}
