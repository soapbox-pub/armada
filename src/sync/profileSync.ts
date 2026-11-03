/**
 * Author profile sync (`profiles` topic). `useAuthor` reads ArmadaDB only;
 * this owns the network side. Components declare on-screen pubkeys
 * ({@link demandProfiles}); one topic drains demand in batched REQs, writes
 * the `main` tenant, and seeds `['author', pubkey]` (newest wins).
 *
 * One topic, not per pubkey (member lists want ONE batched REQ); per-pubkey
 * freshness is durable KV stamps (`profile-fresh:<pubkey>`). Mounted
 * community views register relay HINTS ({@link addProfileRelayHints}) since
 * members' kind 0s often live only there; a new hint re-asks misses at once.
 */
import { KvPrefixCache } from "@/lib/db/kvCache";
import { perfCount } from "@/lib/perf";
import { appEventStore } from "@/lib/db/mainEventStore";
import { seedAuthorCache } from "@/lib/authorCache";
import { clearProfileLoading, markProfileSettled } from "@/lib/profileLoading";
import { invalidateSyncTopic, registerSyncTopic, want } from "@/sync/syncManager";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { QueryClient } from "@tanstack/react-query";

/** Minimal Nostr client a run needs (batcher-backed). */
interface NostrLike {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** What a run needs beyond the demand itself. Registered by the live hooks. */
export interface ProfileSyncContext {
  nostr: NostrLike;
  queryClient: QueryClient;
}

export const PROFILE_SYNC_TOPIC = "profiles";

/** A profile we HAVE is re-checked no sooner than this. */
const FOUND_STALE_MS = 15 * 60_000;
/** A profile we MISSED is re-asked no sooner than this (same hint set). */
const MISS_RETRY_MS = 60_000;
/** Miss backoff ceiling: still catches late profiles, but ~2 requests/hour for profile-less pubkeys. */
const MISS_RETRY_MAX_MS = 30 * 60_000;
/** Consecutive empty rounds per pubkey (cleared when found). */
const missAttempts = new Map<string, number>();
/**
 * Cap on each per-pubkey session map, oldest first. Forgetting a pubkey only
 * errs toward "due": a possibly early re-ask, never a missed one.
 */
const SESSION_MAP_MAX = 10_000;

function capFifo(collection: Map<string, unknown> | Set<string>): void {
  if (collection.size <= SESSION_MAP_MAX) return;
  collection.delete(collection.keys().next().value as string);
}
/** Hinted relays asked per run, at most. */
const MAX_HINT_RELAYS = 6;
/** Pubkeys per REQ against a hinted relay. */
const HINT_CHUNK = 50;
/**
 * Delay before snapshotting demand: rows register across an effect flush (or a
 * few frames), and the first `want` can start a run synchronously.
 */
const SETTLE_MS = 50;

/** On-screen pubkeys, refcounted by mounted demands. */
const demand = new Map<string, number>();

/** One scheduler want while any demand is mounted; `demand` is the real refcount (per-row wants burned CPU). */
let topicWant: (() => void) | undefined;
let demandHolds = 0;

/** Pubkeys found this session; picks the lazy TTL in {@link isDueNow} (unknown errs toward "due"). */
const foundProfiles = new Set<string>();

/** Relays worth asking about profiles right now, refcounted by mounted views. */
const hintRelays = new Map<string, number>();

/** Bumped when a new relay is hinted, so misses are re-asked immediately. */
let hintGeneration = 0;

/** The hint generation each pubkey was last stamped under. Session-scoped. */
const stampedGeneration = new Map<string, number>();

let ctx: ProfileSyncContext | undefined;

/** Durable per-pubkey freshness stamps in KV (purged with KV). */
const stamps = new KvPrefixCache<number>({ prefix: "profile-fresh:" });

/**
 * Declare these pubkeys' profiles wanted on screen; returns a release. The
 * context rides along for module code (last caller wins; one pool/client per app).
 */
export function demandProfiles(pubkeys: string[], context: ProfileSyncContext): () => void {
  ctx = context;
  const pks = [...new Set(pubkeys)].filter(Boolean);
  if (pks.length === 0) return () => undefined;
  for (const pk of pks) demand.set(pk, (demand.get(pk) ?? 0) + 1);
  demandHolds++;
  topicWant ??= want(PROFILE_SYNC_TOPIC, "visible");
  // Wake the topic only if some pubkey is due (fresh rows mustn't force runs).
  if (pks.some(isDueNow)) invalidateSyncTopic(PROFILE_SYNC_TOPIC);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const pk of pks) {
      const count = demand.get(pk);
      if (count === undefined) continue;
      if (count <= 1) demand.delete(pk);
      else demand.set(pk, count - 1);
    }
    demandHolds--;
    if (demandHolds === 0) {
      topicWant?.();
      topicWant = undefined;
    }
  };
}

/**
 * Backoff before re-asking an empty pubkey: geometric, capped at
 * {@link MISS_RETRY_MAX_MS}. Demand lives as long as a mounted row, so a flat
 * retry would mean a REQ per minute forever per profile-less author. New hint
 * relays still re-ask misses immediately.
 */
export function _missRetryDelayMs(attempts: number): number {
  return Math.min(MISS_RETRY_MS * 2 ** (Math.max(1, attempts) - 1), MISS_RETRY_MAX_MS);
}

function missRetryDelay(pk: string): number {
  return _missRetryDelayMs(missAttempts.get(pk) ?? 1);
}

/** Test seam: consecutive empty rounds recorded for `pk`. */
export function _profileMissAttemptsForTests(pk: string): number {
  return missAttempts.get(pk) ?? 0;
}

/** Synchronous mirror of the run's candidate filter; errs toward "due". */
function isDueNow(pk: string): boolean {
  const stamp = stamps.get(pk);
  if (stamp === undefined) return true;
  const found = foundProfiles.has(pk);
  if (Date.now() - stamp > (found ? FOUND_STALE_MS : missRetryDelay(pk))) return true;
  return !found && stampedGeneration.get(pk) !== hintGeneration;
}

/** Register relays likely holding on-screen profiles; returns a release. */
export function addProfileRelayHints(relays: string[]): () => void {
  const urls = [...new Set(relays)].filter(Boolean);
  if (urls.length === 0) return () => undefined;
  let fresh = false;
  for (const url of urls) {
    const count = hintRelays.get(url) ?? 0;
    if (count === 0) fresh = true;
    hintRelays.set(url, count + 1);
  }
  if (fresh) {
    hintGeneration++;
    invalidateSyncTopic(PROFILE_SYNC_TOPIC);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const url of urls) {
      const count = hintRelays.get(url);
      if (count === undefined) continue;
      if (count <= 1) hintRelays.delete(url);
      else hintRelays.set(url, count - 1);
    }
  };
}

async function runProfileSync(signal: AbortSignal): Promise<void> {
  const c = ctx;
  // No context means no demand (woken by a hint or stale stamp).
  if (!c || demand.size === 0) return;

  await stamps.ready();
  // Let the mounting burst finish (SETTLE_MS); later mounts go to the next run.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  if (signal.aborted) return;

  const demanded = [...demand.keys()];
  const store = await appEventStore();

  // One local read: picks TTLs, heals store/query-cache divergence, and feeds
  // the newest-wins merge.
  const cached = await store.query([{ kinds: [0], authors: demanded }]);
  const found = new Set<string>();
  for (const ev of cached) {
    found.add(ev.pubkey);
    // Before the early return, so a candidate-less round still teaches the TTL.
    foundProfiles.add(ev.pubkey);
    capFifo(foundProfiles);
    seedAuthorCache(c.queryClient, ev.pubkey, ev);
  }

  const now = Date.now();
  const candidates = demanded.filter((pk) => {
    const stamp = stamps.get(pk);
    if (stamp === undefined) return true;
    if (now - stamp > (found.has(pk) ? FOUND_STALE_MS : MISS_RETRY_MS)) return true;
    return !found.has(pk) && stampedGeneration.get(pk) !== hintGeneration;
  });
  if (candidates.length === 0) return;

  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

  // Pool pass: the batcher merges these into chunked multi-author REQs.
  const poolPass = Promise.all(
    candidates.map(async (pk) => {
      try {
        const [ev] = await c.nostr.query(
          [{ kinds: [0], authors: [pk], limit: 1 }],
          { signal: runSignal },
        );
        return ev;
      } catch {
        return undefined;
      }
    }),
  );

  // Hint pass alongside; a dead relay costs only its chunk.
  const hinted = [...hintRelays.keys()].slice(0, MAX_HINT_RELAYS);
  const hintPass = Promise.all(
    hinted.map(async (url) => {
      const out: NostrEvent[] = [];
      for (let i = 0; i < candidates.length; i += HINT_CHUNK) {
        const chunk = candidates.slice(i, i + HINT_CHUNK);
        try {
          out.push(
            ...(await c.nostr.relay(url).query(
              [{ kinds: [0], authors: chunk, limit: chunk.length }],
              { signal: runSignal },
            )),
          );
        } catch {
          // one relay must not fail the round
        }
      }
      return out;
    }),
  );

  const [poolEvents, hintEvents] = await Promise.all([poolPass, hintPass]);
  perfCount(signal.aborted ? "profiles.run (torn down)" : "profiles.run", 0, candidates.length, "pubkeys");

  const newest = new Map<string, NostrEvent>();
  for (const ev of [...poolEvents, ...hintEvents.flat()]) {
    if (!ev || ev.kind !== 0) continue;
    const prev = newest.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
  }

  // Keep and stamp what arrived even if torn down (re-fetching after scroll
  // costs megabytes of kind 0s on phones).
  await Promise.all(
    [...newest.values()].map((ev) => store.event(ev).catch(() => undefined)),
  );
  const at = Date.now();
  for (const [pk, ev] of newest) {
    stamps.set(pk, at);
    stampedGeneration.set(pk, hintGeneration);
    capFifo(stampedGeneration);
    foundProfiles.add(pk);
    capFifo(foundProfiles);
    missAttempts.delete(pk);
    seedAuthorCache(c.queryClient, pk, ev);
  }
  // Stamp MISSES only for a completed round.
  if (signal.aborted) return;
  for (const pk of candidates) {
    if (newest.has(pk)) continue;
    stamps.set(pk, at);
    stampedGeneration.set(pk, hintGeneration);
    capFifo(stampedGeneration);
    missAttempts.set(pk, (missAttempts.get(pk) ?? 0) + 1);
    capFifo(missAttempts);
    markProfileSettled(pk);
  }
}

/** Whether a profile round has ever answered for `pk`, found or missed (durable). */
export async function hasProfileStamp(pk: string): Promise<boolean> {
  await stamps.ready();
  return stamps.get(pk) !== undefined;
}

registerSyncTopic(PROFILE_SYNC_TOPIC, {
  // Floor between rounds, coalescing mount bursts.
  minIntervalMs: 5_000,
  // Re-run while rows are on screen; per-pubkey stamps make it a no-op unless a retry is due.
  staleAfterMs: 60_000,
  handler: ({ signal }) => runProfileSync(signal),
});

/**
 * Forget this session's per-pubkey bookkeeping (logout). Demand, hints and the
 * context stay: they belong to mounted views, which keep syncing.
 */
export function clearProfileSyncMemory(): void {
  stampedGeneration.clear();
  foundProfiles.clear();
  missAttempts.clear();
  clearProfileLoading();
}

/** Test seam: drop all demand, hints, context, and session generations. */
export function _resetProfileSyncForTests(): void {
  clearProfileSyncMemory();
  demand.clear();
  hintRelays.clear();
  hintGeneration = 0;
  ctx = undefined;
  demandHolds = 0;
  topicWant?.();
  topicWant = undefined;
}
