/**
 * Discover Control peek — a background, in-memory fold of a listing's Control
 * Plane so cards can show channel count (and probe public chat streams) without
 * joining. Not a member sync: nothing written to ArmadaDB, no stream-auth, and
 * peeks are serialized ({@link enqueueDiscoverControlPeek}).
 */

import { foldControlState, openControlEditions, type FoldedControl } from "@/concord/lib/control";
import { baseRekeyGroupKey, controlGroupKey, hex32, type StreamKeyView } from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { openPlaneWrapsChunked } from "@/concord/lib/planeSync";
import { honoredRootRotations, parseRekey, type ParsedRekey } from "@/concord/lib/rekey";
import { isStaff } from "@/concord/lib/roles";
import { openWrap } from "@/concord/lib/stream";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrEvent } from "nostr-tools";

/** One page — matches the member Control sweep's page size. */
const PEEK_PAGE = 500;
/** Per-relay cap so a flooded plane can't pin Discover open forever. */
const PEEK_MAX_WRAPS = 2_000;
const PEEK_TIMEOUT_MS = 12_000;

/**
 * Persisted peek per community: seeds the next session's first paint (STALE), and
 * the live query still runs.
 */
const CONTROL_PEEK_KV = "discover:control-peek:";

export interface DiscoverControlPeek {
  channelCount: number;
  /** Non-deleted public channel ids — for last-active stream probes. */
  publicChannelIdHexes: string[];
  /** The root epoch folded: a peek answers only for bundles at it. */
  epoch?: number;
  /** The owner and every holder of a Control-writing bit (CORD-04 §3). */
  staff?: string[];
  /**
   * An honored Refounding has moved the community past this epoch (CORD-06), so
   * every link still on it lands nowhere. The invite registries are no witness to
   * a link's liveness: published registries leave out links that work.
   */
  rotated?: boolean;
}

export async function readCachedControlPeek(
  communityId: string,
  epoch: number,
): Promise<DiscoverControlPeek | undefined> {
  try {
    const stored = await getArmadaDB().kv.get<DiscoverControlPeek>(CONTROL_PEEK_KV + communityId);
    if (
      !stored
      || typeof stored.channelCount !== "number"
      || !Array.isArray(stored.publicChannelIdHexes)
      || stored.epoch !== epoch
    ) {
      return undefined;
    }
    return stored;
  } catch {
    return undefined;
  }
}

export function writeCachedControlPeek(communityId: string, peek: DiscoverControlPeek): void {
  getArmadaDB()
    .kv.set(CONTROL_PEEK_KV + communityId, peek)
    .catch(() => undefined);
}

type PeekNostr = {
  relay: (url: string) => {
    query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  };
};

/** Read view for the bundle's current Control address (split or legacy). */
export function controlViewFromBundle(bundle: InviteBundle): StreamKeyView | null {
  try {
    const root = hex32(bundle.community_root);
    const communityId = hex32(bundle.community_id);
    const read = controlGroupKey(root, communityId, bundle.root_epoch);
    if (typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk)) {
      return {
        pk: bundle.control_pk.toLowerCase(),
        get convKey() {
          return read.convKey;
        },
        restricted: true,
      };
    }
    return read;
  } catch {
    return null;
  }
}

export function summarizeDiscoverChannels(
  channels: Iterable<{ channelIdHex: string; isPrivate: boolean; deleted: boolean }>,
): DiscoverControlPeek {
  let channelCount = 0;
  const publicChannelIdHexes: string[] = [];
  for (const c of channels) {
    if (c.deleted) continue;
    channelCount += 1;
    if (!c.isPrivate) publicChannelIdHexes.push(c.channelIdHex);
  }
  return { channelCount, publicChannelIdHexes };
}

/** Serial peek queue: one Control read at a time (cards paint from the bundle meanwhile). */
let peekTail: Promise<unknown> = Promise.resolve();

export function enqueueDiscoverControlPeek<T>(fn: () => Promise<T>): Promise<T> {
  const run = peekTail.then(fn, fn);
  peekTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test seam — reset the serial chain between suites. */
export function _resetDiscoverControlPeekQueueForTests(): void {
  peekTail = Promise.resolve();
}

/**
 * Fetch + decrypt + fold Control for one invite bundle. Best-effort: partial reads
 * still return what they found, but are NOT cached (a persisted under-count
 * outlives its cause).
 */
export async function peekDiscoverControl(
  nostr: PeekNostr,
  bundle: InviteBundle,
  signal?: AbortSignal,
): Promise<DiscoverControlPeek | null> {
  const view = controlViewFromBundle(bundle);
  if (!view) return null;

  const relays = [
    ...new Set(
      (Array.isArray(bundle.relays) ? bundle.relays : [])
        .map(normalizeRelayUrl)
        .filter((u): u is string => !!u),
    ),
  ];
  if (relays.length === 0) return null;

  let communityId: Uint8Array;
  try {
    communityId = hex32(bundle.community_id);
  } catch {
    return null;
  }

  const timeout = AbortSignal.any(
    [AbortSignal.timeout(PEEK_TIMEOUT_MS), ...(signal ? [signal] : [])],
  );

  const epoch = bundle.root_epoch;
  const read = await fetchControlWraps(nostr, relays, view.pk, timeout);
  if (read.wraps.length === 0) {
    // Empty plane and silent relay look identical: report, never persist.
    return { channelCount: 0, publicChannelIdHexes: [], epoch };
  }

  const opened = await openPlaneWrapsChunked(read.wraps, [view]);
  const editions = openControlEditions(opened);
  const folded = foldControlState(editions, communityId, bundle.owner);
  const staff = new Set([folded.ownerHex]);
  for (const g of folded.roster.grants) if (isStaff(folded.roster, g.member, folded.ownerHex)) staff.add(g.member);
  const peek: DiscoverControlPeek = {
    ...summarizeDiscoverChannels(folded.channels.values()),
    epoch,
    staff: [...staff].sort(),
    rotated: await refoundedPast(nostr, relays, bundle, folded, timeout),
  };
  // Cache only a COMPLETE read with a metadata head: a truncated plane under-counts,
  // and a missing metadata head means a Refounding's compaction (CORD-06 §3) is
  // still mid-roll.
  if (read.complete && folded.metadata) writeCachedControlPeek(bundle.community_id, peek);
  return peek;
}

/** Rekey wraps read at the next epoch's base address; a Refounding is a handful of chunks. */
const REKEY_PEEK_LIMIT = 200;

/**
 * Whether an honored, complete Refounding moved the community off the bundle's
 * epoch. Anyone holding the link holds that root and can write the address, so
 * authority comes from the epoch's fold, never from the wrap.
 */
async function refoundedPast(
  nostr: PeekNostr,
  relays: string[],
  bundle: InviteBundle,
  folded: FoldedControl,
  signal: AbortSignal,
): Promise<boolean> {
  let root: Uint8Array;
  let communityId: Uint8Array;
  try {
    root = hex32(bundle.community_root);
    communityId = hex32(bundle.community_id);
  } catch {
    return false;
  }
  const epoch = BigInt(bundle.root_epoch);
  const address = baseRekeyGroupKey(root, communityId, epoch + 1n);
  const reads = await Promise.allSettled(
    relays.map((url) =>
      nostr.relay(url).query([{ kinds: [KIND_WRAP], authors: [address.pk], limit: REKEY_PEEK_LIMIT }], { signal }),
    ),
  );
  const seen = new Set<string>();
  const parsed: ParsedRekey[] = [];
  for (const r of reads) {
    if (r.status !== "fulfilled") continue;
    for (const wrap of r.value) {
      if (wrap.pubkey !== address.pk || seen.has(wrap.id)) continue;
      seen.add(wrap.id);
      try {
        parsed.push(parseRekey(openWrap(wrap, address)));
      } catch {
        // not a rekey at this address
      }
    }
  }
  return honoredRootRotations(parsed, folded, communityId, epoch, root).some((set) => set.complete);
}

interface ControlWrapRead {
  wraps: NostrEvent[];
  /** Every relay was paged to exhaustion — see {@link peekDiscoverControl}. */
  complete: boolean;
}

/**
 * Page each relay INDEPENDENTLY and merge by wrap id: one cursor across relays
 * skips windows a shallower relay wasn't asked for (as in `channelSync`).
 */
async function fetchControlWraps(
  nostr: PeekNostr,
  relays: string[],
  author: string,
  signal: AbortSignal,
): Promise<ControlWrapRead> {
  const reads = await Promise.allSettled(
    relays.map((url) => pageControlWraps(nostr, url, author, signal)),
  );
  const byId = new Map<string, NostrEvent>();
  let complete = true;
  for (const r of reads) {
    if (r.status !== "fulfilled") {
      complete = false;
      continue;
    }
    if (!r.value.complete) complete = false;
    for (const ev of r.value.wraps) byId.set(ev.id, ev);
  }
  return { wraps: [...byId.values()], complete };
}

/** Walk one relay's copy of the plane, newest first. */
async function pageControlWraps(
  nostr: PeekNostr,
  url: string,
  author: string,
  signal: AbortSignal,
): Promise<ControlWrapRead> {
  const wraps: NostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | undefined;

  for (;;) {
    if (wraps.length >= PEEK_MAX_WRAPS) return { wraps, complete: false };
    const filter: NostrFilter = { kinds: [KIND_WRAP], authors: [author], limit: PEEK_PAGE };
    if (until !== undefined) filter.until = until;

    let page: NostrEvent[];
    try {
      page = await nostr.relay(url).query([filter], { signal });
    } catch {
      return { wraps, complete: false };
    }

    let fresh = 0;
    let oldest = Infinity;
    for (const ev of page) {
      if (ev.created_at < oldest) oldest = ev.created_at;
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      wraps.push(ev);
      fresh += 1;
    }

    if (page.length < PEEK_PAGE) return { wraps, complete: true };
    if (oldest === Infinity || oldest <= 0) return { wraps, complete: true };

    // `until` is INCLUSIVE: pages overlap by a second on purpose so same-second bursts
    // (a community founding) aren't skipped; dedupe makes it free. An all-duplicate
    // page means the burst is wider than a page — stop and report incomplete.
    if (fresh === 0) return { wraps, complete: false };
    until = oldest;
  }
}
