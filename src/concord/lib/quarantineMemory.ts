/**
 * Flood-detector verdicts remembered across sessions. `floodClusters` depends on
 * context the next session doesn't reload, so once a message is folded it stays
 * folded. One KV entry per (community, channel), `{rumorId: ms}`, behind a
 * `KvPrefixCache`, which merges in memory synchronously and reads synchronously.
 *
 * - Merge-only: a later, less-informed fold never un-remembers.
 * - Still a display fold (collapsed, expandable), never a drop.
 * - False positives persist too, bounded by {@link QUARANTINE_RETENTION_MS} and
 *   {@link QUARANTINE_MAX_IDS} (newest kept).
 */
import { activeFloodPolicy, subscribeActiveFloodPolicy } from "@/concord/lib/floodPolicy";
import { KvPrefixCache } from "@/lib/db/kvCache";

/** How long a remembered verdict outlives its message's timestamp. */
export const QUARANTINE_RETENTION_MS = 30 * 24 * 3_600_000;
/**
 * Max ids per channel (newest win). Also bounds each flush's KV value during a
 * live flood, so sized for what can still render.
 */
export const QUARANTINE_MAX_IDS = 1000;

const cache = new KvPrefixCache<Record<string, number>>({ prefix: "c2quar:" });

const entryId = (communityIdHex: string, channelIdHex: string) =>
  `${communityIdHex}:${channelIdHex}`;

let revision = 0;
cache.subscribe(() => {
  revision++;
});

/**
 * The reader's flood tuning. A remembered verdict is one the STANDARD rules
 * reached, so it is recalled only under a policy at least that strict (one the
 * reader relaxed must stop folding what it now lets through), and a strict
 * policy's verdicts aren't remembered into a later standard session.
 */
const recalls = () => {
  const policy = activeFloodPolicy();
  return policy.sensitivity !== "relaxed" && !policy.exemptBridged;
};
const remembers = () => activeFloodPolicy().sensitivity !== "strict";
subscribeActiveFloodPolicy(() => {
  revision++;
});

/**
 * Re-render on change, notably when the warm lands. Subscribing kicks the warm,
 * so it's what makes the memory exist for a session.
 */
export function subscribeQuarantineMemory(listener: () => void): () => void {
  void cache.ready();
  const offPolicy = subscribeActiveFloodPolicy(listener);
  const off = cache.subscribe(listener);
  return () => {
    offPolicy();
    off();
  };
}

export function quarantineMemoryRevision(): number {
  return revision;
}

/** Resolves once the memory is warm (tests, and anything that must not race it). */
export function quarantineMemoryReady(): Promise<void> {
  return cache.ready();
}

/** Set views memoized on the stored value's identity (folds re-run often). */
const setMemo = new WeakMap<Record<string, number>, Set<string>>();

/**
 * Rumor ids this channel remembers folding, or undefined. Synchronous; empty
 * before the warm lands (a flood may render for a frame, never the reverse).
 */
export function recallQuarantined(
  communityIdHex: string,
  channelIdHex: string,
): ReadonlySet<string> | undefined {
  if (!recalls()) return undefined;
  const value = cache.get(entryId(communityIdHex, channelIdHex));
  if (!value) return undefined;
  let ids = setMemo.get(value);
  if (!ids) setMemo.set(value, (ids = new Set(Object.keys(value))));
  return ids.size > 0 ? ids : undefined;
}

/**
 * Staged, unwritten verdicts per entry id. Staging is a map insert; one flush per
 * {@link QUARANTINE_FLUSH_MS} merges, writes and notifies once — per-call writes
 * made a live flood re-fold every consumer per message.
 */
const pending = new Map<string, Map<string, number>>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> = Promise.resolve();

export const QUARANTINE_FLUSH_MS = 2000;

/**
 * Stage freshly-folded ids (with message timestamps) — cheap, called on every
 * fold. The flush waits for the warm so it can't overwrite a past session's
 * store; cross-tab last-writer-wins only loses a re-detectable verdict.
 */
export function rememberQuarantined(
  communityIdHex: string,
  channelIdHex: string,
  entries: Iterable<readonly [rumorId: string, ms: number]>,
): void {
  if (!communityIdHex || !channelIdHex || !remembers()) return;
  const id = entryId(communityIdHex, channelIdHex);
  const existing = cache.get(id);
  let bucket = pending.get(id);
  let staged = false;
  for (const [rumorId, ms] of entries) {
    if (existing?.[rumorId] !== undefined) continue;
    if (bucket?.has(rumorId)) continue;
    if (!bucket) pending.set(id, (bucket = new Map()));
    bucket.set(rumorId, ms);
    staged = true;
  }
  if (!staged) return;
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    flushing = flush();
  }, QUARANTINE_FLUSH_MS);
}

async function flush(): Promise<void> {
  await cache.ready();
  const staged = [...pending];
  pending.clear();
  for (const [id, bucket] of staged) {
    // Re-check against the warmed map: staging may predate the warm.
    const existing = cache.get(id);
    let next: Record<string, number> | undefined;
    for (const [rumorId, ms] of bucket) {
      if (existing?.[rumorId] !== undefined) continue;
      next ??= { ...existing };
      next[rumorId] = ms;
    }
    if (!next) continue;

    const cutoff = Date.now() - QUARANTINE_RETENTION_MS;
    let kept = Object.entries(next).filter(([, ms]) => ms >= cutoff);
    if (kept.length > QUARANTINE_MAX_IDS) {
      kept.sort((a, b) => b[1] - a[1]);
      kept = kept.slice(0, QUARANTINE_MAX_IDS);
    }
    if (kept.length === 0) {
      if (existing) cache.delete(id);
      continue;
    }
    cache.set(id, Object.fromEntries(kept));
  }
}

/** Flush staged verdicts now (tests). */
export async function flushQuarantineMemory(): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    flushing = flush();
  }
  await flushing;
}
