/**
 * The IndexedDB adapter for {@link ArmadaDB} (web backend). Each tenant is its
 * own database wrapping Nostrify's `NIndexedDB` (IndexedDB can't cheaply prefix
 * every index with a tenant column). Rumors are stored with an empty `sig`,
 * stripped on read.
 */
import { NIndexedDB } from "@nostrify/indexeddb";
import { openDB } from "idb";

import { perfCount, perfKvWrite, perfMark, perfTime } from "@/lib/perf";

import { ParsedFilter } from "./ParsedFilter";
import {
  defaultIndexTags,
  matchesKvRange,
  resolveKvRange,
  TERM_TAG,
  tenantClass,
  termNamespaceRange,
} from "./types";
import { WrittenIds } from "./writtenIds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { DBSchema, IDBPDatabase } from "idb";
import type { NostrRumor } from "@/lib/nostrRumor";
import type {
  ArmadaDB,
  ArmadaDBOpts,
  ArmadaKV,
  ArmadaKVEntry,
  ArmadaKVListOptions,
  ArmadaKVSelector,
  KvRange,
  NRumorStore,
  TenantOpts,
  TermPolicy,
} from "./types";

/** Strip the placeholder signature `NIndexedDB` round-trips. */
function toRumor(event: NostrEvent): NostrRumor {
  const { sig: _sig, ...rumor } = event;
  return rumor;
}

/**
 * The rumor from a raw delegate row (which carries derived index fields),
 * rebuilt field by field so future derived fields can't leak in.
 */
function rowRumor(row: Record<string, unknown>): NostrRumor {
  return {
    id: row.id as string,
    pubkey: row.pubkey as string,
    created_at: row.created_at as number,
    kind: row.kind as number,
    tags: row.tags as string[][],
    content: row.content as string,
  };
}

/** Present a rumor as an event for `NIndexedDB`, which types `sig` required. */
function toEvent(rumor: NostrRumor): NostrEvent {
  return { ...rumor, sig: "" };
}

/**
 * Low-cardinality profiler label for a read's shape (kinds + which fields are
 * present); ids, authors and tag values are counted, never spelled.
 */
function filterShape(filters: NostrFilter[]): string {
  const parts = filters.map((f) => {
    const bits: string[] = [];
    if (f.kinds?.length) bits.push(`k${[...f.kinds].sort((a, b) => a - b).join(",")}`);
    if (f.ids?.length) bits.push(`ids×${f.ids.length}`);
    if (f.authors?.length) bits.push(`authors×${f.authors.length}`);
    for (const key of Object.keys(f)) if (key.startsWith("#")) bits.push(key);
    if (f.search) bits.push("search");
    if (f.since !== undefined || f.until !== undefined) bits.push("time");
    bits.push(f.limit === undefined ? "NO-LIMIT" : `limit${f.limit}`);
    return bits.join("+");
  });
  // One bucket per distinct shape, and a multi-filter read reports as one.
  const unique = [...new Set(parts)].sort();
  return unique.length > 3 ? `${unique.slice(0, 3).join(" | ")} | +${unique.length - 3} more` : unique.join(" | ");
}

/** One delegate call, plus what must still be done to its answer when it over-selects. */
interface DelegateJob {
  /** The filters as `NIndexedDB` should receive them. */
  filters: NostrFilter[];
  /** Applied to every row the delegate returned, when it over-selects. */
  check?: (rumor: NostrRumor) => boolean;
  /** Re-applied after `check`, since the delegate could not be given it. */
  limit?: number;
  /** A `distinct:` collapse to apply to the rows — see {@link Collapse}. */
  collapse?: Collapse;
  /**
   * Candidate driving filters for an over-selecting job, each a superset of the
   * answer; {@link IndexedDBRumorStore.runChecked} picks the most selective.
   */
  drivers?: NostrFilter[];
}

/**
 * A `distinct:<namespace>` collapse to the newest row per term before `limit`.
 * `indexOnly`: the namespace alone selects the rows, so
 * {@link IndexedDBRumorStore.groupScan} can seek once per group.
 */
interface Collapse {
  namespace: string;
  indexOnly: boolean;
  since?: number;
  until?: number;
}

/**
 * Plan a read against a tenant whose terms are indexed under {@link TERM_TAG}.
 *
 * `NIndexedDB`'s planner re-checks tag filters against literal tags unless the
 * plan is index-only, and terms exist only in the index. So a term-only filter
 * is passed as written; anything else is passed as the term alone, with the
 * rest of the filter and its limit applied here. Term-bearing filters get their
 * own job (OR'd filters with separate limits can't be merged).
 *
 * Also fails closed: `NIndexedDB`'s NIP-50 parse drops unsupported extension
 * tokens (e.g. `domain:`), which would widen to the whole tenant — including in
 * `remove()`. Only filters with `search` are parsed, keeping the hot path free.
 * An empty result means nothing can match.
 */
function planFilters(
  filters: NostrFilter[],
  tenant: string,
  policy: TermPolicy | undefined,
): DelegateJob[] {
  if (!filters.some((f) => typeof f.search === "string")) return [{ filters }];

  const plain: NostrFilter[] = [];
  const jobs: DelegateJob[] = [];

  for (const filter of filters) {
    if (typeof filter.search !== "string") {
      plain.push(filter);
      continue;
    }

    const parsed = new ParsedFilter(filter);
    if (parsed.neverMatch) continue;

    if (parsed.terms.length === 0 && parsed.distinct === undefined) {
      plain.push(filter);
      continue;
    }

    // A term in a tenant that derives none can never match.
    if (!policy) continue;

    const term = parsed.terms.length > 0 ? { [`#${TERM_TAG}`]: [parsed.terms[0]] } : {};
    const bounded: NostrFilter = { ...term };
    if (filter.since !== undefined) bounded.since = filter.since;
    if (filter.until !== undefined) bounded.until = filter.until;

    if (parsed.distinct !== undefined) {
      // Never hand a collapse a limit (rows vs groups); apply the rest of the
      // filter BEFORE collapsing so each group's survivor is the newest match.
      const indexOnly = parsed.terms.length === 0 && !parsed.ids && !parsed.authors &&
        !parsed.kinds && parsed.tags.length === 0 && !parsed.searchKeywords;
      jobs.push({
        // The delegate can't narrow by namespace: index-only goes to the group scan.
        filters: [indexOnly ? {} : bounded],
        check: indexOnly
          ? undefined
          : (rumor) => parsed.matches(rumor) && parsed.matchesTerms(policy(rumor, tenant)),
        limit: filter.limit,
        collapse: {
          namespace: parsed.distinct,
          indexOnly,
          since: filter.since,
          until: filter.until,
        },
      });
      continue;
    }

    // Term plus time window only: the tag index answers exactly.
    if (
      parsed.terms.length === 1 && !parsed.ids && !parsed.authors && !parsed.kinds &&
      parsed.tags.length === 0 && !parsed.searchKeywords
    ) {
      if (filter.limit !== undefined) bounded.limit = filter.limit;
      plain.push(bounded);
      continue;
    }

    const rest = restDriver(filter, parsed);
    jobs.push({
      filters: [bounded],
      drivers: rest ? [bounded, rest] : [bounded],
      check: (rumor) => parsed.matches(rumor) && parsed.matchesTerms(policy(rumor, tenant)),
      limit: filter.limit,
    });
  }

  if (plain.length > 0) jobs.unshift({ filters: plain });
  return jobs;
}

/**
 * The filter's non-term half as a candidate driver, or `undefined` if not
 * worth offering. The term isn't always selective (the DM timer sits at the
 * bottom of a thread; kind 1740 is a handful of rows), so
 * {@link IndexedDBRumorStore.runChecked} counts both. Disqualified when nothing
 * drives it (time window only) or `NIndexedDB` can't count it from one index
 * (one major field, or authors+kinds). `ids` always wins (primary-key gets).
 */
function restDriver(filter: NostrFilter, parsed: ParsedFilter): NostrFilter | undefined {
  const { search: _search, limit: _limit, ...rest } = filter;
  if (parsed.ids) return rest;

  const majors = (parsed.authors ? 1 : 0) + (parsed.kinds ? 1 : 0) + parsed.tags.length;
  if (majors === 0) return undefined;
  if (majors > 1 && !(majors === 2 && parsed.authors && parsed.kinds)) return undefined;
  return rest;
}

/** Merge job results by id, in the store's order. */
function mergeJobs(results: NostrRumor[][]): NostrRumor[] {
  if (results.length === 1) return results[0];
  const byId = new Map<string, NostrRumor>();
  for (const rumors of results) for (const rumor of rumors) byId.set(rumor.id, rumor);
  return [...byId.values()].sort(compareNewest);
}

/** Newest first, ties by id — the order every read comes back in. */
function compareNewest(a: NostrRumor, b: NostrRumor): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The rumor's term in `namespace` (its collapse group), if any. */
function keyIn(namespace: string, derived: string[]): string | undefined {
  const prefix = `${namespace}:`;
  return derived.find((term) => term.startsWith(prefix));
}

/**
 * `NIndexedDB`'s object store and index, read directly by
 * {@link IndexedDBRumorStore.groupScan} to enumerate distinct index values (no
 * store API does). Deliberate coupling: every use is guarded and falls back to
 * a walk. Opened at version 1 with a throwing upgrade so a missing DB isn't
 * created half-formed.
 */
const DELEGATE = { store: "events", tagIndex: "by-tag", version: 1 } as const;

/** How many rumors one page of the term backfill re-indexes. */
const BACKFILL_PAGE = 500;

/**
 * Largest range a checked read takes whole (one `getAll`) rather than paging
 * with a cursor step per row. See {@link IndexedDBRumorStore.runChecked}.
 */
const CHECKED_PAGE = 128;

/**
 * Loop guard only: checked-read paging must be exhaustive (a budget would deny
 * existing rumors). Each round advances `until` or widens the page.
 */
const CHECKED_MAX_PAGES = 1024;

class IndexedDBRumorStore implements NRumorStore {
  private readonly store: NIndexedDB;
  /** Profiler label — the tenant's class, see {@link tenantClass}. */
  private readonly label: string;
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  /**
   * The tenant's {@link TermPolicy}. Read through a closure by `indexTags` so a
   * policy declared after first acquisition governs later writes.
   */
  private terms?: TermPolicy;
  /** The one-time pass over rows written before the policy was installed. */
  private backfill?: Promise<void>;
  /**
   * Whether the connection is known open. Operations before that resolve
   * include the open's cost, so the first is profiled under a separate label.
   */
  private opened = false;
  /** Ids already committed, so the relay cache's re-writes cost nothing. */
  private readonly written = new WrittenIds();
  /** The second, read-only handle {@link groupScan} walks. Opened at most once. */
  private raw?: Promise<IDBPDatabase | null>;

  constructor(
    private readonly name: string,
    indexTags: (rumor: NostrRumor) => string[][],
    label: string,
    private readonly tenantId: string,
    /** Which of these ids were removed from this device (`ArmadaDB.forget`). */
    private readonly removedAmong: (ids: string[]) => Promise<Set<string>> = async () => new Set(),
  ) {
    // Terms ride in the ordinary tag index under the reserved `TERM_TAG` (the
    // only hook `NIndexedDB` offers); `defaultIndexTags` refuses that name from senders.
    this.store = new NIndexedDB(name, {
      indexTags: (event) => {
        const tags = indexTags(event);
        const policy = this.terms;
        if (!policy) return tags;
        return [...tags, ...policy(event, tenantId).map((term) => [TERM_TAG, term])];
      },
    });
    this.label = label;
    this.indexTags = indexTags;
  }

  /**
   * Bind the tenant's {@link TermPolicy} and backfill existing rows: `indexTags`
   * runs only on write, so every stored rumor is re-`put` via `NIndexedDB`
   * directly (bypassing `event()`'s skip). A re-put replaces index entries
   * wholesale, so a generation bump needs nothing more (unlike SQLite).
   */
  installTerms(
    policy: TermPolicy,
    done: () => Promise<boolean>,
    finish: () => Promise<void>,
  ): void {
    if (this.terms === policy) return;
    this.terms = policy;
    this.backfill = (async () => {
      if (await done()) return;
      let until: number | undefined;
      for (;;) {
        const page = await this.store.query([{ limit: BACKFILL_PAGE, until }]);
        if (page.length === 0) break;
        await Promise.all(page.map((event) => this.store.event(event)));
        const oldest = page[page.length - 1].created_at;
        // `until` is inclusive: stop if a run of equal timestamps stalls paging.
        if (until !== undefined && oldest >= until) break;
        until = oldest;
        if (page.length < BACKFILL_PAGE) break;
      }
      await finish();
    })().catch(() => {});
  }

  /**
   * Wait for the term backfill only for reads that may hit the term index.
   * Must gate on any `search`, not `ParsedFilter.terms`: `distinct:` reads the
   * index without a term of its own.
   */
  private async awaitTerms(filters: NostrFilter[]): Promise<void> {
    if (!this.backfill) return;
    if (!filters.some((filter) => typeof filter.search === "string")) return;
    await this.backfill;
  }

  /** `db.<op> <class>` once the connection is up, `db.<op> <class> (cold)` before. */
  private op(name: string): string {
    return this.opened ? `db.${name} ${this.label}` : `db.${name} ${this.label} (cold)`;
  }

  private async settled<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } finally {
      this.opened = true;
    }
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    await this.awaitTerms(filters);
    const jobs = planFilters(filters, this.tenantId, this.terms);
    if (jobs.length === 0) return [];
    // Rows RETURNED, not walked; high mean with low rows signals a scan.
    let returned = 0;
    const results = await perfTime(
      this.op("query"),
      () =>
        this.settled(Promise.all(jobs.map(async (job) => {
          if (job.collapse) {
            const rumors = await this.runCollapse(job, job.collapse, opts);
            returned += rumors.length;
            return rumors;
          }
          if (job.check) {
            const rumors = await this.runChecked(job, opts);
            returned += rumors.length;
            return rumors;
          }
          const events = await this.store.query(job.filters, opts);
          returned += events.length;
          let rumors = events.map(toRumor);
          if (job.limit !== undefined && rumors.length > job.limit) rumors = rumors.slice(0, job.limit);
          return rumors;
        }))),
      () => returned,
    );
    // Same time, bucketed by query shape to attribute cost to callers.
    perfCount(`shape ${this.label} ${filterShape(filters)}`, 0, returned);
    return mergeJobs(results);
  }

  /**
   * One over-selecting job: read the cheaper of its {@link DelegateJob.drivers}
   * (one index-only `count` each) and narrow here. A limit is paged down
   * `until` in {@link CHECKED_PAGE} steps rather than dropped, since rows the
   * check rejects would otherwise short the page.
   */
  private async runChecked(
    job: DelegateJob,
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRumor[]> {
    const check = job.check ?? (() => true);
    const { driver, rows } = await this.chooseDriver(job, opts);

    // A small range is read whole in one `getAll` request (e.g. the timer read).
    if (job.limit === undefined || (rows !== undefined && rows <= CHECKED_PAGE)) {
      const events = await this.store.query([driver], opts);
      const rumors = events.map(toRumor).filter(check);
      return job.limit === undefined ? rumors : rumors.slice(0, job.limit);
    }

    const kept: NostrRumor[] = [];
    const seen = new Set<string>();
    let until = driver.until;
    // First page is exactly the limit, so a check that rejects nothing costs one round trip.
    let page = job.limit;

    for (let round = 0; round < CHECKED_MAX_PAGES && kept.length < job.limit; round++) {
      const filter: NostrFilter = { ...driver, limit: page };
      if (until !== undefined) filter.until = until;

      const events = await this.store.query([filter], opts);
      let fresh = 0;
      let oldest = Infinity;

      for (const event of events) {
        oldest = Math.min(oldest, event.created_at);
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        fresh++;
        const rumor = toRumor(event);
        if (check(rumor) && kept.length < job.limit) kept.push(rumor);
      }

      if (events.length < page) break;
      // `until` is inclusive: re-read the boundary second (`seen` drops repeats)
      // rather than lose same-second rows; widening rescues all-repeat pages.
      if (fresh > 0) until = oldest;
      // The check is selective: widen fast.
      page *= 4;
    }

    return kept;
  }

  /**
   * The driver selecting fewest rows. `ids` wins outright; a failed count is
   * read as unusable, never cheapest.
   */
  private async chooseDriver(
    job: DelegateJob,
    opts?: { signal?: AbortSignal },
  ): Promise<{ driver: NostrFilter; rows?: number }> {
    const drivers = job.drivers ?? job.filters;
    if (drivers.length === 1) return { driver: drivers[0] };

    const ids = drivers.find((driver) => driver.ids !== undefined);
    if (ids) return { driver: ids, rows: ids.ids?.length };

    const counts = await Promise.all(drivers.map(async (driver) => {
      try {
        // No limit, so the delegate counts from its index alone.
        const { limit: _limit, ...unlimited } = driver;
        return (await this.store.count([unlimited], opts)).count;
      } catch {
        return Infinity;
      }
    }));

    let best = 0;
    for (let i = 1; i < drivers.length; i++) if (counts[i] < counts[best]) best = i;
    return {
      driver: drivers[best],
      rows: Number.isFinite(counts[best]) ? counts[best] : undefined,
    };
  }

  /**
   * One collapsed job: newest rumor per term in a namespace, via
   * {@link groupScan} or the fallback walk. Both must answer identically (the
   * conformance suite asserts it); the fallback also handles row conditions.
   */
  private async runCollapse(
    job: DelegateJob,
    collapse: Collapse,
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRumor[]> {
    const policy = this.terms;
    if (!policy) return [];

    if (collapse.indexOnly) {
      const scanned = await this.groupScan(collapse);
      if (scanned) {
        const sorted = scanned.sort(compareNewest);
        return job.limit === undefined ? sorted : sorted.slice(0, job.limit);
      }
    }

    const events = await this.store.query(job.filters, opts);
    let rumors = events.map(toRumor);
    if (job.check) rumors = rumors.filter(job.check);
    rumors.sort(compareNewest);

    const groups = new Set<string>();
    const kept: NostrRumor[] = [];

    for (const rumor of rumors) {
      if (job.limit !== undefined && kept.length >= job.limit) break;
      // No term in the namespace: no group, excluded.
      const key = keyIn(collapse.namespace, policy(rumor, this.tenantId));
      if (key === undefined || groups.has(key)) continue;
      groups.add(key);
      kept.push(rumor);
    }

    return kept;
  }

  /**
   * Every group in `namespace` as its newest rumor, via a loose index scan: a
   * descending cursor over `[name, value, created_at]` jumps group to group with
   * `continue([TERM_TAG, term, -Infinity])`. All groups are enumerated even with
   * a limit (term order vs recency). `undefined` → caller falls back to the walk.
   */
  private async groupScan(collapse: Collapse): Promise<NostrRumor[] | undefined> {
    const range = termNamespaceRange(collapse.namespace);
    if (!range) return undefined;

    try {
      const db = await this.delegateDb();
      if (!db) return undefined;

      const index = db.transaction(DELEGATE.store, "readonly")
        .objectStore(DELEGATE.store)
        .index(DELEGATE.tagIndex);

      const bounds = IDBKeyRange.bound(
        [TERM_TAG, range.lower, -Infinity],
        range.upper === undefined ? [TERM_TAG, [], -Infinity] : [TERM_TAG, range.upper, -Infinity],
        false,
        true,
      );

      const found: NostrRumor[] = [];
      let cursor = await index.openCursor(bounds, "prev");

      while (cursor) {
        const key = cursor.key as [string, string, number];
        const term = key[1];
        const at = key[2];

        // Newest entry above the window: seek down within the group.
        if (collapse.until !== undefined && at > collapse.until) {
          cursor = await cursor.continue([TERM_TAG, term, collapse.until]);
          continue;
        }

        // Newest entry already too old: skip the whole group.
        if (collapse.since !== undefined && at < collapse.since) {
          cursor = await cursor.continue([TERM_TAG, term, -Infinity]);
          continue;
        }

        found.push(rowRumor(cursor.value as Record<string, unknown>));
        cursor = await cursor.continue([TERM_TAG, term, -Infinity]);
      }

      return found;
    } catch {
      // Unrecognized layout / missing DB: read it the slow way, never answer with less.
      return undefined;
    }
  }

  /**
   * Read-only handle on the delegate's database. Opened at its schema version
   * with a throwing upgrade so a missing DB's creation is reverted; opening
   * version-less would leave an empty DB the delegate never upgrades.
   */
  private delegateDb(): Promise<IDBPDatabase | null> {
    this.raw ??= (async () => {
      if (typeof indexedDB === "undefined") return null;
      try {
        return await openDB(this.name, DELEGATE.version, {
          upgrade() {
            throw new Error("not this adapter's database to create");
          },
          blocking(_current, _blocked, event) {
            // Newer layout wants in; release (the group scan is only an optimization).
            (event.target as IDBDatabase | null)?.close();
          },
        });
      } catch {
        return null;
      }
    })();
    return this.raw;
  }

  /** Writes queued for the on-disk existence check, keyed by id (duplicates collapse). */
  private gate = new Map<
    string,
    {
      rumor: NostrRumor;
      opts?: { signal?: AbortSignal };
      settlers: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
    }
  >();
  private gateScheduled = false;
  /** The scheduled gate pass, and writes it started that haven't committed (see {@link quiesce}). */
  private gateTask: Promise<void> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();

  /** Settle once every write accepted so far has committed or been refused. */
  async quiesce(): Promise<void> {
    await this.gateTask;
    await Promise.allSettled([...this.inflight]);
  }

  event(event: NostrRumor, opts?: { signal?: AbortSignal }): Promise<void> {
    // A re-write of an id can store nothing new. `written` covers this session;
    // the gate asks the DB about the rest, so warm boots don't re-write their
    // corpus in readwrite transactions that starve reads.
    if (this.written.has(event.id)) {
      perfCount(`db.write ${this.label} (skipped)`, 0, 1, "events");
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const pending = this.gate.get(event.id);
      if (pending) {
        pending.settlers.push({ resolve, reject });
        return;
      }
      this.gate.set(event.id, { rumor: event, opts, settlers: [{ resolve, reject }] });
      if (!this.gateScheduled) {
        this.gateScheduled = true;
        // One macrotask captures a synchronous burst for one readonly check.
        this.gateTask = new Promise<void>((done) => {
          setTimeout(() => void this.flushGate().finally(done), 0);
        });
      }
    });
  }

  /**
   * Resolve the queued batch with ONE readonly ids query: rows already stored
   * resolve immediately (that IS durability, even for parked-wrap ACKs); misses
   * go to the write path.
   */
  private async flushGate(): Promise<void> {
    this.gateScheduled = false;
    const batch = this.gate;
    this.gate = new Map();
    if (batch.size === 0) return;

    let existing = new Set<string>();
    let removed = new Set<string>();
    try {
      const [rows, refused] = await perfTime(
        this.op("precheck"),
        () => Promise.all([
          this.settled(this.store.query([{ ids: [...batch.keys()] }])),
          // Read per batch, not cached: the page and the service worker both write here.
          this.removedAmong([...batch.keys()]),
        ]),
        ([found]) => found.length,
      );
      existing = new Set(rows.map((row) => row.id));
      removed = refused;
    } catch {
      // Unanswerable: treat every row as missing.
    }

    const writes: Array<{ id: string; write: Promise<void> }> = [];
    for (const [id, entry] of batch) {
      // Removed from this device: refused like a stored row, and not remembered
      // as written (it isn't).
      if (removed.has(id)) {
        for (const settler of entry.settlers) settler.resolve();
        continue;
      }
      if (existing.has(id)) {
        this.written.add(id);
        perfCount(`db.write ${this.label} (on disk)`, 0, 1, "events");
        for (const settler of entry.settlers) settler.resolve();
        continue;
      }
      // Counts index entries: every tag <20 chars is indexed (multiEntry), so
      // one event can be hundreds of index rows.
      perfCount("db.index entries", 0, this.indexTags(entry.rumor).length, "entries");
      const write = perfTime(this.op("write"), async () => {
        await this.settled(this.store.event(toEvent(entry.rumor), entry.opts));
        // After the commit: callers treat resolution as durable (parked-wrap ACKs).
        this.written.add(id);
      });
      this.inflight.add(write);
      void write.finally(() => this.inflight.delete(write)).catch(() => undefined);
      void write.then(
        () => {
          for (const settler of entry.settlers) settler.resolve();
        },
        (error: unknown) => {
          for (const settler of entry.settlers) settler.reject(error);
        },
      );
      writes.push({ id, write });
    }
    if (writes.length > 0) this.sweepRemoved(writes);
  }

  /**
   * Another context can `forget` an id between this batch's precheck and commit,
   * missing our row. Its tombstone lands before its delete, so re-reading the
   * tombstones after our commit catches what it missed.
   */
  private sweepRemoved(writes: Array<{ id: string; write: Promise<void> }>): void {
    const sweep = (async () => {
      await Promise.allSettled(writes.map(({ write }) => write));
      const removed = await this.removedAmong(writes.map(({ id }) => id));
      if (removed.size === 0) return;
      await this.remove([{ ids: [...removed] }]);
    })().catch(() => undefined);
    this.inflight.add(sweep);
    void sweep.finally(() => this.inflight.delete(sweep));
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    await this.awaitTerms(filters);
    const jobs = planFilters(filters, this.tenantId, this.terms);
    if (jobs.length === 0) return { count: 0, approximate: false };
    // Over-selecting, multi-job (double counting) and collapsed (group) reads
    // must be counted from the rows.
    if (jobs.length > 1 || jobs[0].check || jobs[0].collapse) {
      return { count: (await this.query(filters, opts)).length, approximate: false };
    }
    const { count, approximate } = await perfTime(this.op("count"), () =>
      this.settled(this.store.count(jobs[0].filters, opts)),
    );
    return { count, approximate: approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    await this.awaitTerms(filters);
    // A `distinct:` collapse isn't a coherent deletion (it'd delete every
    // conversation's newest message); dropped before planning and the id fallback.
    const deletable = filters.filter((filter) => new ParsedFilter(filter).distinct === undefined);
    if (deletable.length === 0) return;
    // Nothing matches: nothing removed, `written` keeps its ids.
    const jobs = planFilters(deletable, this.tenantId, this.terms);
    if (jobs.length === 0) return;
    // A removed event must be storable again.
    this.written.forget();
    // Resolve over-selecting filters to ids first, or `check`'s spared rows get deleted.
    let target: NostrFilter[];
    if (jobs.length === 1 && !jobs[0].check) {
      target = jobs[0].filters;
    } else {
      const ids = (await this.query(deletable, opts)).map((rumor) => rumor.id);
      if (ids.length === 0) return;
      target = [{ ids }];
    }
    await perfTime(this.op("remove"), () => this.settled(this.store.remove(target, opts)));
  }

  async close(): Promise<void> {
    const raw = this.raw;
    this.raw = undefined;
    (await raw)?.close();
    await this.store.close();
  }

  [Symbol.toStringTag] = "IndexedDBRumorStore";
}

interface KVSchema extends DBSchema {
  kv: { key: string; value: unknown };
  /**
   * Durable registry of opened tenant ids, for purges on browsers without
   * `indexedDB.databases()` (Firefox). A separate store so it can't collide with KV keys.
   */
  tenants: { key: string; value: true };
  /**
   * Tenant ids whose rows have been backfilled, valued by term-policy
   * GENERATION (a legacy `true` matches none, re-running once). SQLite's
   * equivalent is `rumor_term_tenants`. Also holds the removed-id tombstones
   * under {@link REMOVED_KEY}, read only by exact key like the generations.
   */
  termed: { key: string; value: number | true };
}

/**
 * Tombstone key for a removed id (SQLite's `removed_rumors`). In an existing store:
 * a new one needs a version bump, which an older tab can block for good. The NUL
 * keeps it clear of tenant ids.
 */
const REMOVED_KEY = (id: string) => `\u0000removed:${id}`;

/**
 * IndexedDB store-layout version for this KV database; bump when {@link KVSchema}
 * gains a store. Not the data-schema version (`ARMADA_DB_VERSION` in `schema.ts`).
 */
const KV_DB_VERSION = 3;

/**
 * KV over its own database (which also holds the tenant registry); values
 * stored natively. No-op when IndexedDB is unavailable (iOS Lockdown Mode, etc.).
 */
class IndexedDBKV implements ArmadaKV {
  private db: Promise<IDBPDatabase<KVSchema> | null>;
  private readonly registered = new Set<string>();

  constructor(private readonly name: string) {
    this.db = this.open();
  }

  private async open(): Promise<IDBPDatabase<KVSchema> | null> {
    if (typeof indexedDB === "undefined") return null;
    const name = this.name;
    try {
      // Every KV read queues behind the cold open.
      const callbacks = {
        upgrade(db: IDBPDatabase<KVSchema>) {
          // Idempotent across upgrades.
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          if (!db.objectStoreNames.contains("tenants")) db.createObjectStore("tenants");
          if (!db.objectStoreNames.contains("termed")) db.createObjectStore("termed");
        },
        blocking: (_current: number, blocked: number | null, event: IDBVersionChangeEvent) => {
          // A newer build's upgrade waits on every open connection: release ours,
          // or every KV read in that tab queues behind it forever. The reopen
          // queues behind that upgrade and lands on its layout (the VersionError
          // arm below), so this tab's KV keeps answering. A deletion (`blocked`
          // null: the logout purge) is not followed back in.
          (event.target as IDBDatabase | null)?.close();
          if (blocked !== null) this.db = this.open();
        },
      };
      return await perfTime("db.open kv", async () => {
        try {
          return await openDB<KVSchema>(name, KV_DB_VERSION, callbacks);
        } catch (error) {
          // Already at a later layout (a newer build ran here): open it as it is,
          // since every layout keeps the stores this one reads.
          if (!(error instanceof DOMException && error.name === "VersionError")) throw error;
          return await openDB<KVSchema>(name, undefined, { blocking: callbacks.blocking });
        }
      });
    } catch {
      return null;
    }
  }

  /** Record that `id` has a tenant database (best-effort, fire-and-forget). */
  async rememberTenant(id: string): Promise<void> {
    if (this.registered.has(id)) return;
    this.registered.add(id);
    try {
      const db = await this.db;
      await db?.put("tenants", true, id);
    } catch {
      // A purge still finds open tenants via the in-memory map.
      this.registered.delete(id);
    }
  }

  /** Whether `id`'s rows have been backfilled for exactly `generation`. */
  async isTermed(id: string, generation: number): Promise<boolean> {
    try {
      const db = await this.db;
      return (await db?.get("termed", id)) === generation;
    } catch {
      // Unanswerable: re-run (a re-put is harmless).
      return false;
    }
  }

  /** Record that `id`'s backfill has completed for `generation` (best-effort). */
  async setTermed(id: string, generation: number): Promise<void> {
    try {
      const db = await this.db;
      await db?.put("termed", generation, id);
    } catch {
      // The pass simply runs again next boot.
    }
  }

  /** Record removed ids; rejects if they couldn't be (the caller must know). */
  async addRemoved(ids: readonly string[]): Promise<void> {
    const db = await this.db;
    if (!db) return;
    const tx = db.transaction("termed", "readwrite");
    await Promise.all([...ids.map((id) => tx.store.put(true, REMOVED_KEY(id))), tx.done]);
  }

  /** Which of `ids` were removed. Unanswerable counts as none, like the precheck. */
  async removedAmong(ids: readonly string[]): Promise<Set<string>> {
    try {
      const db = await this.db;
      if (!db || ids.length === 0) return new Set();
      const tx = db.transaction("termed", "readonly");
      const hits = await Promise.all(ids.map((id) => tx.store.getKey(REMOVED_KEY(id))));
      await tx.done;
      return new Set(ids.filter((_, i) => hits[i] !== undefined));
    } catch {
      return new Set();
    }
  }

  /** Every tenant id recorded by this or a previous session. */
  async knownTenants(): Promise<string[]> {
    try {
      const db = await this.db;
      return db ? ((await db.getAllKeys("tenants")) as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Ops queued for one shared transaction per burst, in arrival order (keeps
   * read-your-writes). Per-call transactions cost three tasks each; bursty
   * callers measured 1.6s per get on a congested boot.
   */
  private pendingOps: Array<
    | { op: "get"; key: string; resolve: (value: unknown) => void }
    | { op: "set"; key: string; value: unknown; resolve: () => void; reject: (error: unknown) => void }
    | { op: "delete"; key: string; resolve: () => void; reject: (error: unknown) => void }
    | {
      op: "list";
      range: KvRange;
      opts: ArmadaKVListOptions;
      resolve: (entries: ArmadaKVEntry<unknown>[]) => void;
    }
  > = [];
  private opsScheduled = false;

  private scheduleOps(): void {
    if (this.opsScheduled) return;
    this.opsScheduled = true;
    setTimeout(() => void this.flushOps(), 0);
  }

  private async flushOps(): Promise<void> {
    this.opsScheduled = false;
    const ops = this.pendingOps;
    this.pendingOps = [];
    if (ops.length === 0) return;

    const db = await this.db;
    if (!db) {
      // Degraded (no IndexedDB): reads answer their miss value, writes no-op.
      for (const op of ops) {
        if (op.op === "list") op.resolve([]);
        else if (op.op === "get") op.resolve(undefined);
        else op.resolve();
      }
      return;
    }

    const mode = ops.some((op) => op.op === "set" || op.op === "delete") ? "readwrite" : "readonly";
    try {
      const tx = db.transaction("kv", mode as "readwrite");
      // The cast only narrows for typechecking; read-only bursts never call put/delete.
      const store = tx.store;
      const results = await Promise.all(
        ops.map((op) => {
          if (op.op === "get") return store.get(op.key);
          if (op.op === "set") return store.put(op.value, op.key);
          if (op.op === "delete") return store.delete(op.key);
          // Two `getAll`s over the same range (same order, zipped) beat a cursor's per-row round trips.
          const query = IndexedDBKV.keyRange(op.range);
          const count = IndexedDBKV.scanCount(op.range, op.opts);
          return Promise.all([store.getAllKeys(query, count), store.getAll(query, count)]);
        }),
      );
      await tx.done;
      for (const [i, op] of ops.entries()) {
        if (op.op === "get") op.resolve(results[i] as never);
        else if (op.op === "list") {
          const [keys, values] = results[i] as [string[], unknown[]];
          let entries = keys.map((key, j) => ({ key, value: values[j] }));
          // The range is a scan hint, not the contract — see `matchesKvRange`.
          if (!op.range.exact) entries = entries.filter((entry) => matchesKvRange(entry.key, op.range));
          if (op.opts.reverse) entries.reverse();
          const { limit } = op.opts;
          op.resolve(limit !== undefined && entries.length > limit ? entries.slice(0, limit) : entries);
        } else op.resolve();
      }
    } catch (error) {
      // Failed reads are misses; failed writes reject.
      for (const op of ops) {
        if (op.op === "get") op.resolve(undefined);
        else if (op.op === "list") op.resolve([]);
        else op.reject(error);
      }
    }
  }

  /** The key range `range` scans (everything, when it is unbounded). */
  private static keyRange(range: KvRange): IDBKeyRange | undefined {
    const { lower, upper } = range;
    if (lower === undefined && upper === undefined) return undefined;
    if (upper === undefined) return IDBKeyRange.lowerBound(lower!);
    if (lower === undefined) return IDBKeyRange.upperBound(upper, true);
    return IDBKeyRange.bound(lower, upper, false, true);
  }

  /**
   * Rows to ask the scan for, or `undefined` for all. `getAll` counts from the
   * lower end, so push `limit` down only when exact and not reversed.
   */
  private static scanCount(range: KvRange, opts: ArmadaKVListOptions): number | undefined {
    return range.exact && !opts.reverse ? opts.limit : undefined;
  }

  get<T>(key: string): Promise<T | undefined> {
    return perfTime("kv.get", () =>
      new Promise<T | undefined>((resolve) => {
        this.pendingOps.push({ op: "get", key, resolve: resolve as (value: unknown) => void });
        this.scheduleOps();
      }));
  }

  set<T>(key: string, value: T): Promise<void> {
    if (import.meta.env.VITE_PROFILE === "1") perfKvWrite(key, value);
    return perfTime("kv.set", () =>
      new Promise<void>((resolve, reject) => {
        // Normalize out-of-contract `undefined` to null, like the other adapters.
        this.pendingOps.push({ op: "set", key, value: value === undefined ? null : value, resolve, reject });
        this.scheduleOps();
      }));
  }

  delete(key: string): Promise<void> {
    return perfTime("kv.delete", () =>
      new Promise<void>((resolve, reject) => {
        this.pendingOps.push({ op: "delete", key, resolve, reject });
        this.scheduleOps();
      }));
  }

  // `async` so a refused selector rejects rather than throws synchronously.
  async list<T>(
    selector?: ArmadaKVSelector,
    opts: ArmadaKVListOptions = {},
  ): Promise<ArmadaKVEntry<T>[]> {
    const range = resolveKvRange(selector);
    if (range.empty) return [];
    // Same queue as writes, so a list after fire-and-forget sets observes them.
    return perfTime(
      "kv.list",
      () =>
        new Promise<ArmadaKVEntry<T>[]>((resolve) => {
          this.pendingOps.push({
            op: "list",
            range,
            opts,
            resolve: resolve as (entries: ArmadaKVEntry<unknown>[]) => void,
          });
          this.scheduleOps();
        }),
      (entries) => entries.length,
      "entries",
    );
  }

  async close(): Promise<void> {
    (await this.db)?.close();
  }
}

export class IndexedDBArmadaDB implements ArmadaDB {
  private readonly stores = new Map<string, IndexedDBRumorStore>();
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  readonly kv: IndexedDBKV;

  /**
   * @param name Prefix for the IndexedDB databases this instance owns:
   *   `${name}:kv` and one `${name}:t:${tenantId}` per tenant.
   */
  constructor(
    private readonly name: string,
    opts: ArmadaDBOpts = {},
  ) {
    this.indexTags = opts.indexTags ?? defaultIndexTags;
    this.kv = new IndexedDBKV(`${name}:kv`);
  }

  tenant(id: string, opts: TenantOpts = {}): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      // Each tenant is a separate cold `openDB`; the mark counts them.
      perfMark("db.tenant open", id);
      store = new IndexedDBRumorStore(
        IndexedDBArmadaDB.databaseName(this.name, id),
        this.indexTags,
        tenantClass(id),
        id,
        (ids) => this.kv.removedAmong(ids),
      );
      this.stores.set(id, store);
      // Registered on open: an empty tenant still has a database to purge.
      void this.kv.rememberTenant(id);
    }
    if (opts.terms) {
      store.installTerms(
        opts.terms,
        () => this.kv.isTermed(id, opts.termsGeneration ?? 0),
        () => this.kv.setTermed(id, opts.termsGeneration ?? 0),
      );
    }
    return store;
  }

  /** See {@link ArmadaDB.forget}. The tombstones land before any row is deleted. */
  async forget(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)].filter((id) => typeof id === "string" && id !== "");
    if (unique.length === 0) return;
    await this.kv.addRemoved(unique);
    // A write that passed its precheck before the tombstones landed commits
    // first, so the delete below catches it.
    await Promise.all([...this.stores.values()].map((store) => store.quiesce()));
    const tenants = await this.tenantIds();
    await Promise.all(tenants.map((id) => this.tenant(id).remove([{ ids: unique }])));
  }

  /** Every tenant id with a database: registry plus opened-this-session. */
  async tenantIds(): Promise<string[]> {
    return [...new Set([...(await this.kv.knownTenants()), ...this.stores.keys()])];
  }

  /** A tenant's IndexedDB database name (lets a purge delete without opening). */
  static databaseName(name: string, tenantId: string): string {
    return `${name}:t:${tenantId}`;
  }

  /** Close every connection this instance opened. */
  async close(): Promise<void> {
    const stores = [...this.stores.values()];
    this.stores.clear();
    await Promise.all([...stores.map((s) => s.close()), this.kv.close()]);
  }

  [Symbol.toStringTag] = "IndexedDBArmadaDB";
}
