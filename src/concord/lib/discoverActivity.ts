/**
 * Discover activity — cheap "last wrap" probes for public Concord listings. The
 * invite bundle makes stream addresses derivable without joining, and kind-1059
 * wraps aren't NIP-17-fuzzed (CORD-01), so the newest wrap's `created_at` is a real
 * "last active" signal. Public chat streams need channel ids from a Control fold
 * (bundles omit them), passed via `publicChannelIdHexes`.
 */

import {
  channelGroupKey,
  controlGroupKey,
  guestbookGroupKey,
  hex32,
} from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrFilter } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

/** One community's probe target for a batched last-wrap REQ. */
export interface DiscoverActivityTarget {
  /** Invite link-signer — the Discover card's stable key. */
  linkSigner: string;
  /** Stream author pubkeys to probe (guestbook, control, channel streams). */
  authors: string[];
  relays: string[];
}

/** Derive probeable stream authors from an invite bundle (plus optional public channel ids). */
export function discoverStreamAuthors(
  bundle: InviteBundle,
  opts?: { publicChannelIdHexes?: readonly string[] },
): string[] {
  const out = new Set<string>();
  let root: Uint8Array;
  let communityId: Uint8Array;
  try {
    root = hex32(bundle.community_root);
    communityId = hex32(bundle.community_id);
  } catch {
    return [];
  }
  const epoch = bundle.root_epoch;

  try {
    out.add(guestbookGroupKey(root, communityId, epoch).pk);
  } catch { /* ignore */ }

  if (typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk)) {
    out.add(bundle.control_pk.toLowerCase());
  } else {
    try {
      // Legacy pre-split: the read key's pk is also the wrap address.
      out.add(controlGroupKey(root, communityId, epoch).pk);
    } catch { /* ignore */ }
  }

  for (const ch of Array.isArray(bundle.channels) ? bundle.channels : []) {
    try {
      out.add(channelGroupKey(hex32(ch.key), hex32(ch.id), ch.epoch).pk);
    } catch { /* ignore */ }
  }

  for (const idHex of opts?.publicChannelIdHexes ?? []) {
    try {
      out.add(channelGroupKey(root, hex32(idHex), epoch).pk);
    } catch { /* ignore */ }
  }

  return [...out];
}

/**
 * One `limit: 1` filter per target. `until` matters: every link-holder holds the
 * guestbook stream's secret and can post a wrap dated 2038, pinning "Active now";
 * bounding the REQ skips past such forgeries (as `planeSync` does).
 */
export function discoverActivityFilters(
  targets: DiscoverActivityTarget[],
  now = nowSeconds(),
): NostrFilter[] {
  return targets
    .filter((t) => t.authors.length > 0)
    .map((t) => ({
      kinds: [KIND_WRAP],
      authors: t.authors,
      until: now,
      limit: 1,
    }));
}

/**
 * Relays commonly cap filters per REQ by rejecting the whole subscription, so an
 * over-wide REQ costs every listing its timestamp.
 */
const MAX_FILTERS_PER_REQ = 16;

/** One REQ: a relay set and the filters to ask it for. */
export interface DiscoverActivityBatch {
  relays: string[];
  filters: NostrFilter[];
}

/**
 * Split targets into REQs grouped by RELAY SET, then chunked, so each relay is
 * asked only about listings it hosts (less traffic, less leaked interest).
 */
export function discoverActivityBatches(
  targets: DiscoverActivityTarget[],
  now = nowSeconds(),
): DiscoverActivityBatch[] {
  const byRelaySet = new Map<string, { relays: string[]; targets: DiscoverActivityTarget[] }>();
  for (const t of targets) {
    if (t.authors.length === 0) continue;
    const relays = [
      ...new Set(t.relays.map(normalizeRelayUrl).filter((u): u is string => !!u)),
    ].sort();
    if (relays.length === 0) continue;
    const key = relays.join("\n");
    const bucket = byRelaySet.get(key);
    if (bucket) bucket.targets.push(t);
    else byRelaySet.set(key, { relays, targets: [t] });
  }

  const out: DiscoverActivityBatch[] = [];
  for (const { relays, targets: group } of byRelaySet.values()) {
    for (let i = 0; i < group.length; i += MAX_FILTERS_PER_REQ) {
      const slice = group.slice(i, i + MAX_FILTERS_PER_REQ);
      out.push({ relays, filters: discoverActivityFilters(slice, now) });
    }
  }
  return out;
}

function nowSeconds(): number {
  return nowSecs();
}

/** Map wrap events back to link-signers by stream author (community-unique derivations). */
export function activityByLinkSigner(
  targets: DiscoverActivityTarget[],
  events: ReadonlyArray<{ pubkey: string; created_at: number }>,
  now = nowSeconds(),
): Record<string, number> {
  const authorToSigners = new Map<string, string[]>();
  for (const t of targets) {
    for (const pk of t.authors) {
      const list = authorToSigners.get(pk);
      if (list) list.push(t.linkSigner);
      else authorToSigners.set(pk, [t.linkSigner]);
    }
  }
  const out: Record<string, number> = {};
  for (const ev of events) {
    // Relays may ignore `until`; re-check, since one future-dated wrap freezes "Active now".
    if (ev.created_at > now) continue;
    const signers = authorToSigners.get(ev.pubkey);
    if (!signers) continue;
    for (const linkSigner of signers) {
      const prev = out[linkSigner] ?? 0;
      if (ev.created_at > prev) out[linkSigner] = ev.created_at;
    }
  }
  return out;
}
