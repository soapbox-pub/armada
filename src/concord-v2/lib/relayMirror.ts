/**
 * Relay mirror — seed newly-adopted relays with the community's history
 * (CORD-02 §6: "a client may optionally rebroadcast old events to a newly
 * adopted relay").
 *
 * A raw relay-to-relay copy of signed wraps, run BEFORE the relay-list edition
 * publishes, so a fresh joiner never lands on a new relay mid-epoch and folds
 * a half-arrived Control Plane. Verbatim events, no re-sealing: a wrap is
 * self-contained and every receiver verifies it exactly as before.
 *
 * What gets mirrored is the CORRECTNESS set — everything a fresh joiner or a
 * catching-up device needs, and nothing more:
 *   - Control Plane, every held epoch (a compaction already folded prior
 *     epochs into the current one, CORD-06);
 *   - Guestbook Plane, every held epoch (the member list);
 *   - rekey addresses between held epochs plus the pending next one, so a
 *     straggler can still walk the continuity chain forward (CORD-06 §2);
 *   - the dissolution address (the grave travels with the community).
 * Chat history stays where it was sent — messages are a property of their era
 * and every member's device holds its own copy.
 */

import { controlGroups } from "@/concord-v2/lib/control";
import { guestbookGroups } from "@/concord-v2/lib/guestbook";
import {
  baseRekeyGroupKey,
  channelRekeyGroupKey,
  dissolvedGroupKey,
  type StreamKeyView,
} from "@/concord-v2/lib/derive";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { logSync } from "@/lib/syncLog";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable client the mirror needs (test seam). */
export interface MirrorNostr {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  };
}

export interface MirrorProgress {
  phase: "fetch" | "publish";
  relay: string;
  /** Events gathered (fetch) or delivered+failed (publish) so far. */
  done: number;
  /** Total wraps to deliver — 0 while still fetching. */
  total: number;
}

export interface MirrorRelayResult {
  accepted: number;
  /** Events the relay refused (policy — e.g. rejecting old `created_at`s) or failed. */
  rejected: number;
}

export interface MirrorReport {
  /** Distinct wraps found across the source relays. */
  found: number;
  perRelay: Map<string, MirrorRelayResult>;
}

const PAGE_LIMIT = 500;
/** Runaway guard: 40 pages × 500 = 20k wraps per author chunk, far past any real plane. */
const MAX_PAGES = 40;
const AUTHORS_PER_FILTER = 200;
/** Defensive ceiling on derivable addresses (heldRoots × channels × epochs). */
const MAX_GROUPS = 600;
const PUBLISH_CONCURRENCY = 10;

/**
 * Every stream address whose history a new relay needs. Derivable entirely
 * from the member's own key material — no fold required.
 */
export function mirrorGroups(community: CommunityV2): StreamKeyView[] {
  const groups: StreamKeyView[] = [
    ...controlGroups(community),
    ...guestbookGroups(community),
    dissolvedGroupKey(community.id),
  ];
  // Base rotations: each held epoch's NEXT-epoch address covers the rotation
  // that led out of it (and the pending one out of the current epoch).
  for (const r of community.heldRoots) {
    groups.push(baseRekeyGroupKey(r.key, community.id, r.epoch + 1n));
  }
  // Held private channels: every channel epoch up to the pending next, under
  // every held root — a Refounding seals channel rekeys under the PRIOR root
  // (CORD-06 §3), so a reader can't know which root keyed a given rotation.
  for (const ch of community.privateChannels) {
    const top = ch.epoch + 1n;
    for (let e = 1n; e <= top; e++) {
      for (const r of community.heldRoots) {
        groups.push(channelRekeyGroupKey(r.key, ch.id, e));
        if (groups.length >= MAX_GROUPS) break;
      }
      if (groups.length >= MAX_GROUPS) break;
    }
    if (groups.length >= MAX_GROUPS) {
      logSync("mirror", `${community.idHex.slice(0, 8)} group enumeration capped at ${MAX_GROUPS}`);
      break;
    }
  }
  // Dedupe by address (held-root overlaps can re-derive the same key).
  const seen = new Set<string>();
  return groups.filter((g) => (seen.has(g.pk) ? false : (seen.add(g.pk), true)));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Mirror cancelled.", "AbortError");
}

/**
 * Walk one source relay's full history for `authors`, newest-down via `until`
 * pages. Dedup handles the inclusive-`until` boundary overlap; a page that
 * adds nothing new ends the walk (a whole same-second page past the wall is
 * accepted as done — control planes never write hundreds of events in one
 * second).
 */
async function fetchAllWraps(
  nostr: MirrorNostr,
  url: string,
  authors: string[],
  out: Map<string, NostrEvent>,
  onPage?: (gathered: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const authorChunk of chunk(authors, AUTHORS_PER_FILTER)) {
    let until: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      throwIfAborted(signal);
      const filter: NostrFilter = {
        kinds: [KIND_WRAP],
        authors: authorChunk,
        limit: PAGE_LIMIT,
        ...(until !== undefined ? { until } : {}),
      };
      const events = await nostr
        .relay(url)
        .query([filter], { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]) });
      let added = 0;
      let oldest = Infinity;
      for (const ev of events) {
        oldest = Math.min(oldest, ev.created_at);
        if (!out.has(ev.id)) {
          out.set(ev.id, ev);
          added++;
        }
      }
      onPage?.(out.size);
      if (events.length < PAGE_LIMIT || added === 0) break;
      until = oldest;
    }
  }
}

/** Deliver wraps to one target relay; every event is attempted, failures counted. */
async function publishWraps(
  nostr: MirrorNostr,
  url: string,
  wraps: NostrEvent[],
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
): Promise<MirrorRelayResult> {
  let accepted = 0;
  const failed: NostrEvent[] = [];
  const deliver = async (batchList: NostrEvent[], sink: NostrEvent[] | null) => {
    let done = 0;
    for (const batch of chunk(batchList, PUBLISH_CONCURRENCY)) {
      throwIfAborted(signal);
      const results = await Promise.allSettled(
        batch.map((w) => nostr.relay(url).event(w, { signal: AbortSignal.timeout(8000) })),
      );
      results.forEach((r, i) => {
        if (r.status === "fulfilled") accepted++;
        else sink?.push(batch[i]);
      });
      done += batch.length;
      onProgress?.(done);
    }
  };
  await deliver(wraps, failed);
  // One retry sweep: a transient socket loss shouldn't count as a rejection.
  const retry = failed.splice(0, failed.length);
  if (retry.length > 0) await deliver(retry, failed);
  return { accepted, rejected: failed.length };
}

/**
 * Copy the community's correctness-set history from its current relays onto
 * `targetRelays` (the newly-added ones). Idempotent and resumable: events are
 * keyed by id, so a re-run re-offers the same wraps and relays dedup.
 */
export async function mirrorHistoryToRelays(
  nostr: MirrorNostr,
  community: CommunityV2,
  targetRelays: string[],
  opts?: { onProgress?: (p: MirrorProgress) => void; signal?: AbortSignal },
): Promise<MirrorReport> {
  const groups = mirrorGroups(community);
  // The new relays may NIP-42 auth-gate: scope our stream keys to them so the
  // pool can answer their challenges before/while the EVENTs land.
  registerStreamKeys(groups, targetRelays);

  const sources = community.relays.filter((url) => !targetRelays.includes(url));
  const authors = groups.map((g) => g.pk);
  const wraps = new Map<string, NostrEvent>();
  for (const url of sources) {
    try {
      await fetchAllWraps(
        nostr,
        url,
        authors,
        wraps,
        (gathered) => opts?.onProgress?.({ phase: "fetch", relay: url, done: gathered, total: 0 }),
        opts?.signal,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // A source that won't answer only narrows the copy; the union of the
      // remaining sources still mirrors everything they hold.
      logSync("mirror", `${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const all = [...wraps.values()].sort((a, b) => a.created_at - b.created_at);
  logSync(
    "mirror",
    `${community.idHex.slice(0, 8)}: ${all.length} wrap(s) from ${sources.length} source(s) → ${targetRelays.length} target(s) (${authors.length} address(es))`,
  );

  const perRelay = new Map<string, MirrorRelayResult>();
  for (const url of targetRelays) {
    const result = await publishWraps(
      nostr,
      url,
      all,
      (done) => opts?.onProgress?.({ phase: "publish", relay: url, done, total: all.length }),
      opts?.signal,
    );
    perRelay.set(url, result);
    logSync("mirror", `${url}: ${result.accepted}/${all.length} accepted, ${result.rejected} rejected`);
  }

  return { found: all.length, perRelay };
}
