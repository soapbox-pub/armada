import type { NostrEvent, NostrFilter } from '@nostrify/types';
import type { NPool } from '@nostrify/nostrify';
import type { ArmadaEventStore } from '@/contexts/EventStoreContext';

import { logNostrReq } from '@/lib/nostrQueryLog';
import { perfCount } from '@/lib/perf';
import { queryRelayStrict } from '@/lib/strictRelayQuery';

/** The relay/group handle shape we wrap for caching: query + req. */
type NRelayLike = ReturnType<NPool['relay']>;

/**
 * The write half of the local cache. ArmadaDB's `event()` rather than `NStore`'s:
 * its `relay` argument files NIP-29 events under the serving relay's tenant.
 */
type EventSink = Promise<Pick<ArmadaEventStore, 'event'>>;

/** Maximum number of items per batch to avoid hitting relay filter limits. */
const MAX_BATCH_SIZE = 50;

/**
 * Post-first-EOSE grace (ms) for replaceable batches. The pool's 300ms default
 * cuts off slower relays that hold the kind-0.
 */
const PROFILE_EOSE_GRACE_MS = 1000;

/**
 * Hard deadline (ms) on a coalesced shared query, which runs without any
 * caller's signal. Without it, a never-settling REQ (swallowed by NIP-42, a
 * half-open socket) poisons the coalesce key forever and wedges sync. Real
 * callers time out sooner.
 */
const SHARED_QUERY_DEADLINE_MS = 30_000;

/** A caller waiting on a batched query, with its own resolve/reject and optional signal. */
interface PendingRequest<V> {
  key: string;
  resolve: (value: V) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

interface AbortableRequest {
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

/** Reject requests whose signal already aborted; return the live ones. */
function partitionLive<R extends AbortableRequest>(batch: R[]): R[] {
  const live: R[] = [];
  for (const req of batch) {
    if (req.signal?.aborted) req.reject(req.signal.reason);
    else live.push(req);
  }
  return live;
}

/**
 * Batch abort controller that fires only when EVERY live caller aborted; never
 * if any caller lacks a signal.
 */
function combinedAbortController<R extends AbortableRequest>(live: R[]): AbortController {
  const controller = new AbortController();
  const signals = live.map((r) => r.signal).filter(Boolean) as AbortSignal[];
  if (signals.length > 0 && signals.length === live.length) {
    const checkAllAborted = () => {
      if (signals.every((s) => s.aborted)) controller.abort(signals[0].reason);
    };
    for (const sig of signals) sig.addEventListener('abort', checkAllAborted, { once: true });
  }
  return controller;
}

/** Accumulates requests during a microtask, then `flush()` fires one combined query. */
abstract class MicrotaskBatcher<R extends AbortableRequest> {
  protected pending: R[] = [];
  private scheduled = false;

  protected enqueue(req: R): void {
    this.pending.push(req);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** No request is waiting for a flush. */
  get idle(): boolean {
    return this.pending.length === 0;
  }

  protected drain(): R[] {
    const batch = this.pending;
    this.pending = [];
    this.scheduled = false;
    return batch;
  }

  protected abstract flush(): Promise<void>;
}

class BatchCollector<V> extends MicrotaskBatcher<PendingRequest<V>> {
  constructor(
    private executeBatch: (keys: string[], signal: AbortSignal) => Promise<Map<string, V>>,
  ) {
    super();
  }

  request(key: string, signal?: AbortSignal): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      this.enqueue({ key, resolve, reject, signal });
    });
  }

  protected async flush(): Promise<void> {
    const live = partitionLive(this.drain());
    if (live.length === 0) return;

    const uniqueKeys: string[] = [];
    const seen = new Set<string>();
    for (const req of live) {
      if (!seen.has(req.key)) {
        seen.add(req.key);
        uniqueKeys.push(req.key);
      }
    }

    const controller = combinedAbortController(live);

    try {
      const allResults = new Map<string, V>();
      const chunks: string[][] = [];
      for (let i = 0; i < uniqueKeys.length; i += MAX_BATCH_SIZE) {
        chunks.push(uniqueKeys.slice(i, i + MAX_BATCH_SIZE));
      }

      await Promise.all(
        chunks.map(async (chunk) => {
          const results = await this.executeBatch(chunk, controller.signal);
          for (const [key, value] of results) {
            allResults.set(key, value);
          }
        }),
      );

      for (const req of live) {
        if (req.signal?.aborted) {
          req.reject(req.signal.reason);
        } else {
          req.resolve(allResults.get(req.key) as V);
        }
      }
    } catch (error) {
      for (const req of live) {
        req.reject(error);
      }
    }
  }
}

/** A filter that only fetches events by ID: `{ ids: [x], limit?: n }` */
function isIdsOnlyFilter(filter: NostrFilter): filter is { ids: string[]; limit?: number } {
  const keys = Object.keys(filter);
  return keys.every((k) => k === 'ids' || k === 'limit') && Array.isArray(filter.ids) && filter.ids.length === 1;
}

/** Replaceable kinds that can be merged into one multi-kind query per author. */
const REPLACEABLE_KINDS = new Set([0, 3, 10000, 10001, 10002, 10003, 10015, 10030, 10063, 16767]);

/** `{ kinds: [k], authors: [a], limit?: n }` with k a known replaceable kind. */
function isReplaceableFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    REPLACEABLE_KINDS.has(filter.kinds[0]) &&
    filter.authors?.length === 1 &&
    filter.limit !== undefined
  );
}

/**
 * Merges replaceable-kind queries for the same pubkey within a microtask into
 * one REQ (e.g. `{ kinds: [0, 3, 10000], authors: [pk] }`); each caller gets its own event.
 */
class ReplaceableCollector extends MicrotaskBatcher<{
  pubkey: string;
  kind: number;
  resolve: (event: NostrEvent | undefined) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}> {
  constructor(
    private pool: NPool,
  ) {
    super();
  }

  /**
   * Stream with a per-call `eoseTimeout` longer than the pool's 300ms, which
   * routinely dropped kind-0s living on slower relays. Stops at merged EOSE or the grace window.
   */
  private async collect(filter: NostrFilter, signal: AbortSignal): Promise<NostrEvent[]> {
    const events: NostrEvent[] = [];
    try {
      for await (const msg of this.pool.req([filter], { signal, eoseTimeout: PROFILE_EOSE_GRACE_MS })) {
        if (msg[0] === 'EVENT') events.push(msg[2]);
        else if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') break;
      }
    } catch {
      // Aborted / relay error — return whatever arrived.
    }
    return events;
  }

  request(pubkey: string, kind: number, signal?: AbortSignal): Promise<NostrEvent | undefined> {
    if (import.meta.env.VITE_PROFILE === "1") {
      // Profiling builds: who asks for replaceables, by call site.
      const site = new Error().stack?.split("\n").slice(3, 6).join(" < ").replace(/https?:\/\/[^/]+/g, "") ?? "?";
      perfCount(`batch.replaceable k${kind} @ ${site}`, 0, 1, "requests");
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      this.enqueue({ pubkey, kind, resolve, reject, signal });
    });
  }

  protected async flush(): Promise<void> {
    const live = partitionLive(this.drain());
    if (live.length === 0) return;

    const kindsByPubkey = new Map<string, Set<number>>();
    for (const { pubkey, kind } of live) {
      if (!kindsByPubkey.has(pubkey)) kindsByPubkey.set(pubkey, new Set());
      kindsByPubkey.get(pubkey)!.add(kind);
    }

    // Group pubkeys by kind-set so identical requests share one REQ.
    const byKindSet = new Map<string, { kinds: number[]; pubkeys: string[] }>();
    for (const [pubkey, kinds] of kindsByPubkey) {
      const key = [...kinds].sort((a, b) => a - b).join(',');
      if (!byKindSet.has(key)) byKindSet.set(key, { kinds: [...kinds].sort((a, b) => a - b), pubkeys: [] });
      byKindSet.get(key)!.pubkeys.push(pubkey);
    }

    const controller = combinedAbortController(live);

    const results = new Map<string, Map<number, NostrEvent | undefined>>();

    try {
      await Promise.all(
        [...byKindSet.values()].map(async ({ kinds, pubkeys }) => {
          const events = await this.collect(
            { kinds, authors: pubkeys, limit: kinds.length * pubkeys.length },
            controller.signal,
          );
          for (const pubkey of pubkeys) {
            if (!results.has(pubkey)) results.set(pubkey, new Map());
          }
          for (const event of events) {
            const kindMap = results.get(event.pubkey);
            if (!kindMap) continue;
            const existing = kindMap.get(event.kind);
            if (!existing || event.created_at > existing.created_at) {
              kindMap.set(event.kind, event);
            }
          }
        }),
      );
    } catch (error) {
      for (const r of live) r.reject(error);
      return;
    }

    // Retry missing kind-0s: the first query resolves once the fastest relay EOSEs,
    // so slower relays get a second chance.
    const missingKind0Pubkeys = [...byKindSet.values()]
      .filter(({ kinds }) => kinds.includes(0))
      .flatMap(({ pubkeys }) => pubkeys)
      .filter((pubkey) => !results.get(pubkey)?.get(0));

    if (missingKind0Pubkeys.length > 0 && !controller.signal.aborted) {
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < missingKind0Pubkeys.length; i += MAX_BATCH_SIZE) {
          chunks.push(missingKind0Pubkeys.slice(i, i + MAX_BATCH_SIZE));
        }

        await Promise.all(
          chunks.map(async (chunk) => {
            const retryEvents = await this.collect(
              { kinds: [0], authors: chunk, limit: chunk.length },
              controller.signal,
            );
            for (const event of retryEvents) {
              if (!results.has(event.pubkey)) results.set(event.pubkey, new Map());
              const kindMap = results.get(event.pubkey)!;
              const existing = kindMap.get(0);
              if (!existing || event.created_at > existing.created_at) {
                kindMap.set(0, event);
              }
            }
          }),
        );
      } catch {
        // Retry failure is non-fatal — callers still get the initial results.
      }
    }

    for (const r of live) {
      if (r.signal?.aborted) {
        r.reject(r.signal.reason);
      } else {
        r.resolve(results.get(r.pubkey)?.get(r.kind));
      }
    }
  }
}

/**
 * Batches fixed-kind, fixed-`d` addressable queries across AUTHORS (e.g. NIP-38
 * statuses, kind 30315 `d: "general"`, for a member list). Opposite axis from
 * `dTagCollectors`, which batch many `d` tags for one author.
 */
class FixedDTagAuthorCollector extends MicrotaskBatcher<{
  author: string;
  resolve: (event: NostrEvent | undefined) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}> {
  constructor(
    private pool: NPool,
    private kind: number,
    private dTag: string,
  ) {
    super();
  }

  request(author: string, signal?: AbortSignal): Promise<NostrEvent | undefined> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      this.enqueue({ author, resolve, reject, signal });
    });
  }

  protected async flush(): Promise<void> {
    const live = partitionLive(this.drain());
    if (live.length === 0) return;

    const authors: string[] = [];
    const seen = new Set<string>();
    for (const r of live) {
      if (!seen.has(r.author)) {
        seen.add(r.author);
        authors.push(r.author);
      }
    }

    const controller = combinedAbortController(live);

    const byAuthor = new Map<string, NostrEvent>();
    try {
      const chunks: string[][] = [];
      for (let i = 0; i < authors.length; i += MAX_BATCH_SIZE) {
        chunks.push(authors.slice(i, i + MAX_BATCH_SIZE));
      }
      await Promise.all(
        chunks.map(async (chunk) => {
          const events = await this.pool.query(
            [{ kinds: [this.kind], authors: chunk, '#d': [this.dTag], limit: chunk.length }],
            { signal: controller.signal },
          );
          for (const event of events) {
            // Relays may return events that don't match the d-tag.
            const d = event.tags.find(([name]) => name === 'd')?.[1] ?? '';
            if (d !== this.dTag) continue;
            const existing = byAuthor.get(event.pubkey);
            if (!existing || event.created_at > existing.created_at) {
              byAuthor.set(event.pubkey, event);
            }
          }
        }),
      );
    } catch (error) {
      for (const r of live) r.reject(error);
      return;
    }

    for (const r of live) {
      if (r.signal?.aborted) {
        r.reject(r.signal.reason);
      } else {
        r.resolve(byAuthor.get(r.author));
      }
    }
  }
}

/** A filter for kind:7 reactions by a single author to a single event. */
function isReactionFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#e' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    filter.kinds[0] === 7 &&
    filter.authors?.length === 1 &&
    (filter as Record<string, unknown>)['#e'] !== undefined &&
    (Array.isArray((filter as Record<string, unknown>)['#e']) && ((filter as Record<string, unknown>)['#e'] as string[]).length === 1)
  );
}

/** A filter for kind:6/16 reposts by a single author to a single event. */
function isRepostFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  const kinds = filter.kinds;
  if (!kinds || kinds.length === 0) return false;
  const eTag = (filter as Record<string, unknown>)['#e'];
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#e' || k === 'limit') &&
    kinds.every((k) => k === 6 || k === 16) &&
    filter.authors?.length === 1 &&
    eTag !== undefined &&
    Array.isArray(eTag) &&
    (eTag as string[]).length === 1
  );
}

/** Single `#e` tag with kinds, e.g. `{ kinds: [7, 9735], '#e': [id], limit: 10 }`. No `authors` (that's the reaction pattern). */
function isETagFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === '#e' || k === 'limit') &&
    Array.isArray(filter.kinds) &&
    filter.kinds.length > 0 &&
    !filter.authors &&
    (filter as Record<string, unknown>)['#e'] !== undefined &&
    Array.isArray((filter as Record<string, unknown>)['#e']) &&
    ((filter as Record<string, unknown>)['#e'] as string[]).length === 1
  );
}

function getETagValue(filter: NostrFilter): string {
  return ((filter as Record<string, unknown>)['#e'] as string[])[0];
}

/** If every filter is an `#e`/`#q` filter for the same single event id, return that id. */
function isMultiFilterETagBatchable(filters: NostrFilter[]): string | null {
  if (filters.length < 2) return null;
  let commonId: string | null = null;

  for (const filter of filters) {
    const keys = Object.keys(filter);
    const isEFilter = keys.every((k) => k === 'kinds' || k === '#e' || k === 'limit') &&
      (filter as Record<string, unknown>)['#e'] !== undefined &&
      Array.isArray((filter as Record<string, unknown>)['#e']) &&
      ((filter as Record<string, unknown>)['#e'] as string[]).length === 1;

    const isQFilter = keys.every((k) => k === 'kinds' || k === '#q' || k === 'limit') &&
      (filter as Record<string, unknown>)['#q'] !== undefined &&
      Array.isArray((filter as Record<string, unknown>)['#q']) &&
      ((filter as Record<string, unknown>)['#q'] as string[]).length === 1;

    if (!isEFilter && !isQFilter) return null;

    const id = isEFilter
      ? ((filter as Record<string, unknown>)['#e'] as string[])[0]
      : ((filter as Record<string, unknown>)['#q'] as string[])[0];

    if (commonId === null) {
      commonId = id;
    } else if (id !== commonId) {
      return null; // Different IDs, can't batch
    }
  }

  return commonId;
}

/** Addressable per-user singletons batched across authors rather than `d` tags (NIP-38 statuses). */
const AUTHOR_BATCHED_DTAG_KINDS = new Set([30315]);

/** `{ kinds: [k], authors: [a], '#d': [d], limit?: n }` with `k ∈ AUTHOR_BATCHED_DTAG_KINDS`. */
function isAuthorBatchedDTagFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#d' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    AUTHOR_BATCHED_DTAG_KINDS.has(filter.kinds[0]) &&
    filter.authors?.length === 1 &&
    (filter as Record<string, unknown>)['#d'] !== undefined &&
    Array.isArray((filter as Record<string, unknown>)['#d']) &&
    ((filter as Record<string, unknown>)['#d'] as string[]).length === 1
  );
}

/** A filter for addressable events by d-tag: `{ kinds: [k], authors: [a], '#d': [d], limit?: n }` */
function isDTagFilter(filter: NostrFilter): boolean {
  const keys = Object.keys(filter);
  return (
    keys.every((k) => k === 'kinds' || k === 'authors' || k === '#d' || k === 'limit') &&
    filter.kinds?.length === 1 &&
    filter.authors?.length === 1 &&
    (filter as Record<string, unknown>)['#d'] !== undefined &&
    (Array.isArray((filter as Record<string, unknown>)['#d']) && ((filter as Record<string, unknown>)['#d'] as string[]).length === 1)
  );
}

type RelayMsg =
  | import('@nostrify/types').NostrRelayEVENT
  | import('@nostrify/types').NostrRelayEOSE
  | import('@nostrify/types').NostrRelayCLOSED;

/**
 * `.req()` options. `cache: false` skips the write-through mirror for consumers
 * that store what they admit themselves. Not in Nostrify's `NRelay` type, so
 * pass it as a variable rather than an object literal.
 */
export interface CachingReqOpts {
  signal?: AbortSignal;
  cache?: boolean;
}

/** Coalescing key: scope relays + filters, canonicalized so ordering can't split a match. */
function coalesceKey(scopeRelays: string[], filters: NostrFilter[]): string {
  const norm = filters.map((f) => {
    const entries = Object.entries(f)
      .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries);
  });
  return `${[...scopeRelays].sort().join(',')}|${norm.join('|')}`;
}

/**
 * One upstream `req()` fanned out to N subscribers with the same key. Live-tail
 * only (no replay); the upstream is aborted when the last subscriber detaches.
 * Collapses duplicate identical kind-1059 REQs from Concord/DM hooks.
 */
class SharedSubscription {
  private subscribers = new Set<Subscriber>();
  private controller = new AbortController();
  private closed = false;

  constructor(
    /** Gets the subscription's own abort signal so teardown actually CLOSEs the REQ. */
    source: (signal: AbortSignal) => AsyncIterable<RelayMsg>,
    private onEmpty: () => void,
    private onMessage: (msg: RelayMsg) => void,
  ) {
    void this.pump(source(this.controller.signal));
  }

  private async pump(source: AsyncIterable<RelayMsg>): Promise<void> {
    try {
      for await (const msg of source) {
        if (this.controller.signal.aborted) break;
        this.onMessage(msg);
        for (const sub of this.subscribers) sub.push(msg);
      }
    } catch { /* ignore */ } finally {
      this.close();
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    for (const sub of this.subscribers) sub.finish();
    this.subscribers.clear();
  }

  isOpen(): boolean {
    return !this.closed;
  }

  /** Attach a subscriber; aborting or breaking out detaches, and the last one leaving tears down the upstream. */
  subscribe(signal?: AbortSignal): AsyncIterable<RelayMsg> {
    const sub = new Subscriber();
    this.subscribers.add(sub);

    const detach = () => {
      if (!this.subscribers.delete(sub)) return;
      sub.finish();
      if (this.subscribers.size === 0) {
        this.controller.abort();
        this.onEmpty();
      }
    };

    if (signal) {
      if (signal.aborted) detach();
      else signal.addEventListener('abort', detach, { once: true });
    }

    const isClosed = () => this.closed;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          if (isClosed()) return;
          yield* sub.drain();
        } finally {
          detach();
        }
      },
    };
  }
}

/** Fan-out subscriber: an async queue drained by an iterator. */
class Subscriber {
  private queue: RelayMsg[] = [];
  private wake?: () => void;
  private done = false;

  push(msg: RelayMsg): void {
    if (this.done) return;
    this.queue.push(msg);
    this.wake?.();
  }

  finish(): void {
    this.done = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<RelayMsg> {
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Transparent batching proxy for NPool. Single-item `.query()` patterns (by id,
 * profile, reaction, d-tag, …) are held for a microtask and combined into one
 * REQ. `relay()`/`group()` handles also coalesce identical concurrent
 * `.query()`/`.req()` calls onto one upstream (see `wrapCaching`).
 */
export class NostrBatcher {
  private replaceableCollector: ReplaceableCollector;
  private eventCollector: BatchCollector<NostrEvent | undefined>;
  /** Keyed by userPubkey so each user's reactions batch separately. */
  private reactionCollectors = new Map<string, BatchCollector<NostrEvent | undefined>>();
  /** Keyed by `${userPubkey}:${kindsKey}` so each user's reposts batch separately per kind set. */
  private repostCollectors = new Map<string, BatchCollector<NostrEvent | undefined>>();
  /** Keyed by `${kind}:${author}` for d-tag batching. */
  private dTagCollectors = new Map<string, BatchCollector<NostrEvent | undefined>>();
  /** Keyed by `${kind}:${dTag}` for author batching of fixed-d-tag addressable kinds (e.g. NIP-38 statuses). */
  private fixedDTagAuthorCollectors = new Map<string, FixedDTagAuthorCollector>();
  private eTagCollectors = new Map<string, BatchCollector<NostrEvent[]>>();
  private multiFilterCollectors = new Map<string, BatchCollector<NostrEvent[]>>();

  /** In-flight `relay()`/`group()` queries by scope+filters, shared by identical concurrent reads. */
  private inflightQueries = new Map<string, Promise<NostrEvent[]>>();

  /** Live shared `.req()` subscriptions by scope+filters (see {@link SharedSubscription}). */
  private sharedSubs = new Map<string, SharedSubscription>();

  /**
   * Optional local cache (a promise: IndexedDB opens async; never blocks reads).
   * Write-only by design: the cache strips signatures, so reading from it would
   * serve unsigned events to callers expecting relay-fresh ones.
   */
  private store?: EventSink;

  constructor(private pool: NPool, store?: EventSink) {
    this.store = store;
    this.replaceableCollector = new ReplaceableCollector(pool);
    this.eventCollector = new BatchCollector((ids, signal) =>
      this.executeEventBatch(ids, signal),
    );
  }

  /**
   * Mirror events into the local cache (fire-and-forget, errors swallowed).
   * `sourceUrl` is the serving relay, known only via `relay(url)`; without it the
   * store drops group-scoped (NIP-29) data by design (see `db/relayScope.ts`).
   * Gift wraps (1059/21059) are NEVER cached — this is the single chokepoint.
   */
  private cacheEvents(events: NostrEvent[], sourceUrl?: string): void {
    if (!this.store) return;
    const cacheable = events.filter((event) => event.kind !== 1059 && event.kind !== 21059);
    if (cacheable.length === 0) return;
    void this.store
      .then((store) => Promise.all(cacheable.map((event) => store.event(event, { relay: sourceUrl }))))
      .catch(() => {
      });
  }

  /** Proxy for `pool.query()`: batches recognized patterns, passes others through; results are cached. */
  async query(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    const events = await this.queryInner(filters, opts);
    this.cacheEvents(events);
    return events;
  }

  private async queryInner(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    if (filters.length === 1) {
      const filter = filters[0];

      if (isIdsOnlyFilter(filter)) {
        const event = await this.eventCollector.request(filter.ids[0], opts?.signal);
        return event ? [event] : [];
      }

      if (isReplaceableFilter(filter)) {
        const event = await this.replaceableCollector.request(filter.authors![0], filter.kinds![0], opts?.signal);
        return event ? [event] : [];
      }

      if (isReactionFilter(filter)) {
        const userPubkey = filter.authors![0];
        const eventId = ((filter as Record<string, unknown>)['#e'] as string[])[0];
        let collector = this.reactionCollectors.get(userPubkey);
        if (!collector) {
          collector = new BatchCollector((eventIds, signal) =>
            this.executeReactionBatch(userPubkey, eventIds, signal),
          );
          this.reactionCollectors.set(userPubkey, collector);
        }
        const event = await collector.request(eventId, opts?.signal);
        return event ? [event] : [];
      }

      if (isRepostFilter(filter)) {
        const userPubkey = filter.authors![0];
        const eventId = ((filter as Record<string, unknown>)['#e'] as string[])[0];
        const kindsKey = [...filter.kinds!].sort().join(',');
        const collectorKey = `${userPubkey}:${kindsKey}`;
        let collector = this.repostCollectors.get(collectorKey);
        if (!collector) {
          collector = new BatchCollector((eventIds, signal) =>
            this.executeRepostBatch(userPubkey, filter.kinds!, eventIds, signal),
          );
          this.repostCollectors.set(collectorKey, collector);
        }
        const event = await collector.request(eventId, opts?.signal);
        return event ? [event] : [];
      }

      if (isETagFilter(filter)) {
        const eventId = getETagValue(filter);
        const kindsKey = [...filter.kinds!].sort().join(',');
        const limit = filter.limit ?? 50;
        const collectorKey = `${kindsKey}:${limit}`;
        let collector = this.eTagCollectors.get(collectorKey);
        if (!collector) {
          collector = new BatchCollector((eventIds, signal) =>
            this.executeETagBatch(filter.kinds!, eventIds, limit, signal),
          );
          this.eTagCollectors.set(collectorKey, collector);
        }
        return collector.request(eventId, opts?.signal);
      }

      // Must precede the generic d-tag check (same shape, different axis).
      if (isAuthorBatchedDTagFilter(filter)) {
        const kind = filter.kinds![0];
        const author = filter.authors![0];
        const dTag = ((filter as Record<string, unknown>)['#d'] as string[])[0];
        const collectorKey = `${kind}:${dTag}`;
        let collector = this.fixedDTagAuthorCollectors.get(collectorKey);
        if (!collector) {
          collector = new FixedDTagAuthorCollector(this.pool, kind, dTag);
          this.fixedDTagAuthorCollectors.set(collectorKey, collector);
        }
        const event = await collector.request(author, opts?.signal);
        return event ? [event] : [];
      }

      if (isDTagFilter(filter)) {
        const kind = filter.kinds![0];
        const author = filter.authors![0];
        const dTag = ((filter as Record<string, unknown>)['#d'] as string[])[0];
        const collectorKey = `${kind}:${author}`;
        let collector = this.dTagCollectors.get(collectorKey);
        if (!collector) {
          collector = new BatchCollector((dTags, signal) =>
            this.executeDTagBatch(kind, author, dTags, signal),
          );
          this.dTagCollectors.set(collectorKey, collector);
        }
        try {
          const event = await collector.request(dTag, opts?.signal);
          return event ? [event] : [];
        } finally {
          // One key per author ever queried: drop the collector once it drains.
          if (collector.idle && this.dTagCollectors.get(collectorKey) === collector) {
            this.dTagCollectors.delete(collectorKey);
          }
        }
      }
    }

    const multiFilterEventId = isMultiFilterETagBatchable(filters);
    if (multiFilterEventId !== null) {
      // Queries with the same filter shape (kinds, tag names, limits) batch together.
      const shapeKey = filters.map((f) => {
        const keys = Object.keys(f).sort();
        return keys.map((k) => k === '#e' || k === '#q' ? k : `${k}:${JSON.stringify((f as Record<string, unknown>)[k])}`).join('|');
      }).join(';;');

      let collector = this.multiFilterCollectors.get(shapeKey);
      if (!collector) {
        collector = new BatchCollector((eventIds, signal) =>
          this.executeMultiFilterBatch(filters, eventIds, signal),
        );
        this.multiFilterCollectors.set(shapeKey, collector);
      }
      return collector.request(multiFilterEventId, opts?.signal);
    }

    return this.pool.query(filters, opts);
  }

  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.pool.event(event, opts);
  }

  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal; eoseTimeout?: number },
  ): AsyncIterable<import('@nostrify/types').NostrRelayEVENT | import('@nostrify/types').NostrRelayEOSE | import('@nostrify/types').NostrRelayCLOSED> {
    const source = this.pool.req(filters, opts);
    const cacheEvents = this.cacheEvents.bind(this);
    return (async function* () {
      for await (const msg of source) {
        if (msg[0] === 'EVENT') {
          cacheEvents([msg[2]]);
        }
        yield msg;
      }
    })();
  }

  /** The pool's open connections, keyed by URL. */
  get relays(): ReadonlyMap<string, unknown> {
    return this.pool.relays;
  }

  relay(url: string) {
    return this.wrapCaching(this.pool.relay(url), url);
  }

  group(urls: string[]) {
    return this.wrapCaching(this.pool.group(urls), undefined, urls);
  }

  /**
   * Mirror a relay/group handle's `.query()`/`.req()` output into the cache;
   * group-scoped traffic bypasses the pool, so it would otherwise never persist.
   * `sourceUrl` (`relay(url)`) decides the tenant events are filed under;
   * `groupUrls` only feeds the query log.
   */
  private wrapCaching<R extends NRelayLike>(relay: R, sourceUrl?: string, groupUrls?: string[]): R {
    const via = sourceUrl ? `relay(${sourceUrl})` : `group(${groupUrls?.length ?? 0})`;
    const scopeRelays = sourceUrl ? [sourceUrl] : (groupUrls ?? []);
    const coalescedQuery = this.coalescedQuery.bind(this);
    const coalescedReq = this.coalescedReq.bind(this);
    return new Proxy(relay, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (filters: NostrFilter[], opts?: { signal?: AbortSignal }) =>
            coalescedQuery(target, via, scopeRelays, sourceUrl, filters, opts);
        }
        if (prop === 'queryStrict') {
          return (filters: NostrFilter[], opts?: { signal?: AbortSignal }) =>
            coalescedQuery(target, via, scopeRelays, sourceUrl, filters, opts, true);
        }
        if (prop === 'req') {
          return (filters: NostrFilter[], opts?: CachingReqOpts) =>
            coalescedReq(target, via, scopeRelays, sourceUrl, filters, opts);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * `.query()` with in-flight coalescing: identical concurrent reads share one
   * upstream request (one logged REQ). Each caller's `signal` only rejects that
   * caller, never the shared request.
   */
  private coalescedQuery(
    target: NRelayLike,
    via: string,
    scopeRelays: string[],
    sourceUrl: string | undefined,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
    strict = false,
  ): Promise<NostrEvent[]> {
    const key = `${via}::${strict ? 'strict::' : ''}${coalesceKey(scopeRelays, filters)}`;
    let shared = this.inflightQueries.get(key);
    if (!shared) {
      logNostrReq(scopeRelays, filters, via);
      // No caller signal, so one abort can't cancel it for others; the deadline is
      // its only signal (see SHARED_QUERY_DEADLINE_MS).
      const deadline = AbortSignal.timeout(SHARED_QUERY_DEADLINE_MS);
      shared = (strict
        ? queryRelayStrict({ req: target.req.bind(target) }, filters, { signal: deadline })
        : target.query(filters, { signal: deadline }))
        .then((events) => {
          this.cacheEvents(events, sourceUrl);
          return events;
        })
        .finally(() => {
          this.inflightQueries.delete(key);
        });
      this.inflightQueries.set(key, shared);
    }

    const signal = opts?.signal;
    if (!signal) return shared;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      shared.then(
        (events) => {
          signal.removeEventListener('abort', onAbort);
          resolve(events);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  /**
   * `.req()` with multiplexing: identical concurrent live tails share one upstream
   * subscription, torn down when the last subscriber detaches.
   */
  private coalescedReq(
    target: NRelayLike,
    via: string,
    scopeRelays: string[],
    sourceUrl: string | undefined,
    filters: NostrFilter[],
    opts?: CachingReqOpts,
  ): AsyncIterable<RelayMsg> {
    const cache = opts?.cache !== false;
    const key = `${via}::${coalesceKey(scopeRelays, filters)}${cache ? '' : '::uncached'}`;
    let shared = this.sharedSubs.get(key);
    if (!shared || !shared.isOpen()) {
      logNostrReq(scopeRelays, filters, via);
      const sharedSubs = this.sharedSubs;
      const sub: SharedSubscription = new SharedSubscription(
        (signal) => target.req(filters, { signal }) as AsyncIterable<RelayMsg>,
        () => {
          if (sharedSubs.get(key) === sub) sharedSubs.delete(key);
        },
        (msg) => {
          if (cache && msg[0] === 'EVENT') {
            this.cacheEvents([msg[2]], sourceUrl);
          }
        },
      );
      shared = sub;
      this.sharedSubs.set(key, sub);
    }
    return shared.subscribe(opts?.signal);
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  private async executeRepostBatch(
    userPubkey: string,
    kinds: number[],
    eventIds: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ kinds, authors: [userPubkey], '#e': eventIds, limit: eventIds.length }],
        { signal },
      );
      const repostMap = new Map<string, NostrEvent>();
      for (const event of events) {
        const eTag = event.tags.find(([name]) => name === 'e')?.[1];
        if (!eTag) continue;
        const existing = repostMap.get(eTag);
        if (!existing || event.created_at > existing.created_at) {
          repostMap.set(eTag, event);
        }
      }
      for (const eventId of eventIds) {
        results.set(eventId, repostMap.get(eventId));
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, undefined);
      }
    }
    return results;
  }

  private async executeEventBatch(
    ids: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ ids, limit: ids.length }],
        { signal },
      );
      const byId = new Map<string, NostrEvent>();
      for (const event of events) {
        byId.set(event.id, event);
      }
      for (const id of ids) {
        results.set(id, byId.get(id));
      }
    } catch {
      for (const id of ids) {
        results.set(id, undefined);
      }
    }
    return results;
  }

  private async executeReactionBatch(
    userPubkey: string,
    eventIds: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ kinds: [7], authors: [userPubkey], '#e': eventIds, limit: eventIds.length }],
        { signal },
      );
      const reactionMap = new Map<string, NostrEvent>();
      for (const event of events) {
        const eTag = event.tags.findLast(([name]) => name === 'e')?.[1];
        if (!eTag) continue;
        const existing = reactionMap.get(eTag);
        if (!existing || event.created_at > existing.created_at) {
          reactionMap.set(eTag, event);
        }
      }
      for (const eventId of eventIds) {
        results.set(eventId, reactionMap.get(eventId));
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, undefined);
      }
    }
    return results;
  }

  private async executeDTagBatch(
    kind: number,
    author: string,
    dTags: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent | undefined>> {
    const results = new Map<string, NostrEvent | undefined>();
    try {
      const events = await this.pool.query(
        [{ kinds: [kind], authors: [author], '#d': dTags, limit: dTags.length }],
        { signal },
      );
      const byDTag = new Map<string, NostrEvent>();
      for (const event of events) {
        const d = event.tags.find(([name]) => name === 'd')?.[1];
        if (!d) continue;
        const existing = byDTag.get(d);
        if (!existing || event.created_at > existing.created_at) {
          byDTag.set(d, event);
        }
      }
      for (const dTag of dTags) {
        results.set(dTag, byDTag.get(dTag));
      }
    } catch {
      for (const dTag of dTags) {
        results.set(dTag, undefined);
      }
    }
    return results;
  }

  private async executeETagBatch(
    kinds: number[],
    eventIds: string[],
    perEventLimit: number,
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent[]>> {
    const results = new Map<string, NostrEvent[]>();
    try {
      const events = await this.pool.query(
        [{ kinds, '#e': eventIds, limit: eventIds.length * perEventLimit }],
        { signal },
      );

      const byEventId = new Map<string, NostrEvent[]>();
      const eventIdSet = new Set(eventIds);
      for (const event of events) {
        for (const tag of event.tags) {
          if (tag[0] === 'e' && eventIdSet.has(tag[1])) {
            const existing = byEventId.get(tag[1]) ?? [];
            existing.push(event);
            byEventId.set(tag[1], existing);
          }
        }
      }

      for (const eventId of eventIds) {
        results.set(eventId, byEventId.get(eventId) ?? []);
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, []);
      }
    }
    return results;
  }

  private async executeMultiFilterBatch(
    templateFilters: NostrFilter[],
    eventIds: string[],
    signal: AbortSignal,
  ): Promise<Map<string, NostrEvent[]>> {
    const results = new Map<string, NostrEvent[]>();
    try {
      const batchedFilters: NostrFilter[] = templateFilters.map((f) => {
        const clone = { ...f };
        const rec = clone as Record<string, unknown>;
        if (rec['#e'] !== undefined) {
          rec['#e'] = eventIds;
          if (clone.limit) {
            clone.limit = clone.limit * eventIds.length;
          }
        }
        if (rec['#q'] !== undefined) {
          rec['#q'] = eventIds;
          if (clone.limit) {
            clone.limit = clone.limit * eventIds.length;
          }
        }
        return clone;
      });

      const events = await this.pool.query(batchedFilters, { signal });

      const byEventId = new Map<string, NostrEvent[]>();
      const eventIdSet = new Set(eventIds);

      for (const event of events) {
        const matchedIds = new Set<string>();
        for (const tag of event.tags) {
          if ((tag[0] === 'e' || tag[0] === 'q') && eventIdSet.has(tag[1])) {
            matchedIds.add(tag[1]);
          }
        }
        for (const id of matchedIds) {
          const existing = byEventId.get(id) ?? [];
          existing.push(event);
          byEventId.set(id, existing);
        }
      }

      for (const eventId of eventIds) {
        results.set(eventId, byEventId.get(eventId) ?? []);
      }
    } catch {
      for (const eventId of eventIds) {
        results.set(eventId, []);
      }
    }
    return results;
  }
}

/** The client contract (`NRelay` plus scoped handles), listed explicitly rather than walking the prototype. */
const CLIENT_METHODS = ['query', 'event', 'req', 'relay', 'group', 'close'] as const;

/**
 * Re-present a client as a plain object of receiver-bound functions. Consumers
 * use `nostr` structurally and may lift methods (`{ relay: nostr.relay }`),
 * which throws on a class instance. Applied once
 * at the provider.
 */
export function detachableClient<T extends object>(client: T): T {
  const source = client as unknown as Record<string, unknown>;
  const bound: Record<string, unknown> = {};
  for (const name of CLIENT_METHODS) {
    const method = source[name];
    if (typeof method !== 'function') continue;
    bound[name] = (method as (...args: unknown[]) => unknown).bind(client);
  }
  // A live view, not a snapshot: `useEvent` routes a hinted relay through the pool when it's open.
  if ('relays' in client) {
    Object.defineProperty(bound, 'relays', { enumerable: true, get: () => source.relays });
  }
  return bound as T;
}
