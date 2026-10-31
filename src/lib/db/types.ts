/**
 * ArmadaDB: the storage interface all client data converges on, one adapter
 * per platform engine (see `armadaDB.ts`).
 *
 *  - Tenants: isolated event namespaces addressed by opaque ids (`c2:<id>`,
 *    `dm17:<pubkey>`, `nip29:<relayUrl>`, `main`); a query in one never sees
 *    another (see `relayScope.ts`).
 *  - Rumors, not events: everything is authenticated before it lands, so no `sig`.
 *
 * `id` is normally the NIP-01 hash, but is just the key: the invite inbox keys
 * by WRAP id and `c2park` stores wraps. Everything else stores rumors verbatim
 * (tags are what the id commits to; never write bookkeeping into them).
 */
import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** `NStore` for rumors (no `sig`), same NIP-01 filter semantics. */
export interface NRumorStore {
  /**
   * Rumors matching any filter, newest first (ties: smaller id first).
   *
   * NIP-50 `search` differs by adapter: SQLite (FTS5) matches whole words,
   * case/accent-insensitively, and parses `-keyword`; IndexedDB tests the raw
   * string as a substring. Both fail CLOSED on a non-empty search naming
   * nothing matchable; a blank `search` constrains nothing.
   */
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
  /** Store one rumor; resolves once committed. */
  event(event: NostrRumor, opts?: { signal?: AbortSignal }): Promise<void>;
  count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }>;
  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Key/value store for non-events (cursors, folds, settings). Only
 * JSON-serializable values are in contract (IndexedDB stores natively, SQLite
 * via JSON), so encode `Map`/`Uint8Array`/`bigint` yourself.
 */
export interface ArmadaKV {
  /** The value, or `undefined` if the key was never set. */
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  /** Forget a key; a no-op if never set. */
  delete(key: string): Promise<void>;
  /**
   * Entries (key AND value, one round trip) the selector picks out, pushed down
   * to a range scan. Order is native collation (IndexedDB UTF-16 units, SQLite
   * UTF-8 bytes), which differs only for astral-plane characters — sort yourself
   * if it matters. `reverse` reverses, then `limit` takes from the front.
   */
  list<T>(selector?: ArmadaKVSelector, opts?: ArmadaKVListOptions): Promise<ArmadaKVEntry<T>[]>;
}

/** One entry from {@link ArmadaKV.list}. */
export interface ArmadaKVEntry<T> {
  key: string;
  value: T;
}

/**
 * Which keys {@link ArmadaKV.list} covers: a prefix, a half-open range, or a
 * prefix narrowed by one bound (empty = whole store). As in Deno.KV, `prefix`
 * with BOTH `start` and `end` is rejected.
 */
export interface ArmadaKVSelector {
  prefix?: string;
  /** Inclusive lower bound. */
  start?: string;
  /** Exclusive upper bound. */
  end?: string;
}

export interface ArmadaKVListOptions {
  limit?: number;
  reverse?: boolean;
}

/**
 * A tenant's DERIVED index terms: re-derivable facts no tag states (e.g. a
 * NIP-17 conversation is a participant SET, which a filter can only
 * over-select). A pure function of the row, so a term is a rebuildable cache,
 * unforgeable by senders and never read back — not tag injection (which
 * AGENTS.md forbids).
 *
 * Queried as NIP-50 extension tokens (`{ search: "conv:<key>" }`), matched
 * whole. Engines never interpret terms (see `termPolicies.ts`). A term is
 * `<namespace>:<body>` (namespace up to the FIRST colon); rules:
 *  - At most ONE term per namespace per rumor (else `distinct:` loses groups).
 *  - {@link TERM_NAMESPACES_RESERVED} namespaces are directives, not terms.
 *
 * Bound to the TENANT, not per write, because the Android service and iOS
 * extension write `dm17:<self>` through their own engines (`TermPolicies.kt`,
 * `TermPolicies.swift`) and must be covered automatically.
 */
export type TermPolicy = (rumor: NostrRumor, tenantId: string) => string[];

/** Separates a term's namespace from its body. See {@link TermPolicy}. */
export const TERM_NAMESPACE_SEP = ":";

/**
 * Extension-token keys that are store DIRECTIVES, unavailable as term
 * namespaces. `distinct:<namespace>` collapses to the newest rumor per term.
 */
export const TERM_NAMESPACES_RESERVED: readonly string[] = ["distinct"];

export interface TenantOpts {
  /**
   * The tenant's {@link TermPolicy}, applied to every write (even via handles
   * acquired without it). Declare at the single site spelling the tenant id;
   * disagreeing sites are an undetectable bug. Installing on existing rows
   * schedules a one-time backfill that term reads wait for.
   */
  terms?: TermPolicy;
  /**
   * Revision of {@link terms} the index was built by; a mismatch drops and
   * re-derives the tenant's terms (else policy edits are silently permanent).
   * ONE number shared with Kotlin/Swift ports (one shared file), or every open
   * rebuilds forever.
   */
  termsGeneration?: number;
}

export interface ArmadaDB {
  /** The event store for `id`, created on first use; same id → same store (writes batch). */
  tenant(id: string, opts?: TenantOpts): NRumorStore;
  kv: ArmadaKV;
  /**
   * Delete rumors from every tenant and refuse them from now on, whichever writer
   * delivers them (the Android service and iOS extension share the engine).
   */
  forget(ids: readonly string[]): Promise<void>;
}

export interface ArmadaDBOpts {
  /** `[name, value]` tags to index for `#x` queries. Defaults to {@link defaultIndexTags}. */
  indexTags?(rumor: NostrRumor): string[][];
}

/**
 * Reserved tag name under which an engine may file terms in its ordinary tag
 * index (IndexedDB's only option). {@link defaultIndexTags} refuses it, so
 * senders can't reach it.
 */
export const TERM_TAG = "~";

/**
 * Default tag index policy: names ≤20 chars (multi-letter allowed, e.g.
 * `#channel`), non-empty values <200 chars (keeps blobs out), except {@link TERM_TAG}.
 */
export function defaultIndexTags(rumor: NostrRumor): string[][] {
  return rumor.tags.filter(
    ([name, value]) =>
      !!name && name !== TERM_TAG && name.length <= 20 && !!value && value.length < 200,
  );
}

/**
 * Exclusive upper bound of keys starting with `prefix`, or `undefined` if
 * open-ended. Only a NARROWING: adapters still filter (collations differ).
 */
export function prefixUpperBound(prefix: string): string | undefined {
  if (!prefix) return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last === 0xffff) return undefined;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * The half-open range of `<namespace>:<anything>` terms. Computed by engines
 * so a prefix can't span namespaces (`conv` vs `convmsg:`). A trailing
 * delimiter is tolerated.
 */
export function termNamespaceRange(
  namespace: string,
): { lower: string; upper: string | undefined } | undefined {
  const name = namespace.endsWith(TERM_NAMESPACE_SEP) ? namespace.slice(0, -1) : namespace;
  if (!name || name.includes(TERM_NAMESPACE_SEP)) return undefined;
  const lower = name + TERM_NAMESPACE_SEP;
  return { lower, upper: prefixUpperBound(lower) };
}

/**
 * An {@link ArmadaKVSelector} reduced to what an engine can scan: a half-open
 * key range, plus the prefix the range is only an approximation of.
 */
export interface KvRange {
  /** Inclusive lower bound; `undefined` = unbounded. */
  lower?: string;
  /** Exclusive upper bound; `undefined` = unbounded. */
  upper?: string;
  /** Keys must start with this (`""` if none). */
  prefix: string;
  /**
   * The bounds cross, so nothing matches. A flag because `IDBKeyRange.bound`
   * throws on inverted ranges.
   */
  empty: boolean;
  /**
   * The bounds select exactly the accepted keys, so an engine may push `limit`
   * into the scan (never otherwise, or filtering would short the answer).
   */
  exact: boolean;
}

/** Whether `text` holds a surrogate code unit — see {@link resolveKvRange}. */
function hasSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Resolve a selector into the scanned range; shared by every adapter and ported
 * as `KvRange.resolve` in `SqliteArmadaDb.kt`.
 * @throws TypeError if `prefix` is combined with both `start` and `end`.
 */
export function resolveKvRange(selector: ArmadaKVSelector = {}): KvRange {
  const { prefix = "", start, end } = selector;
  if (prefix && start !== undefined && end !== undefined) {
    throw new TypeError("A KV selector cannot combine a prefix with both start and end");
  }

  // Intersect with the prefix range, so `start` can't escape it.
  const prefixUpper = prefixUpperBound(prefix);
  const lower = start !== undefined && start > prefix ? start : prefix || undefined;
  const upper = end !== undefined && (prefixUpper === undefined || end < prefixUpper)
    ? end
    : prefixUpper;

  return {
    lower,
    upper,
    prefix,
    empty: lower !== undefined && upper !== undefined && lower >= upper,
    exact: boundsAreExact(lower, upper, prefix),
  };
}

/**
 * Whether `[lower, upper)` admits only accepted keys. Spoiled by an open-ended
 * scan under a prefix, or a surrogate in a bound (SQLite UTF-8 vs IndexedDB
 * UTF-16 ordering; lone surrogates become U+FFFD in SQLite).
 */
function boundsAreExact(lower: string | undefined, upper: string | undefined, prefix: string): boolean {
  if (prefix && upper === undefined) return false;
  return !hasSurrogate(lower ?? "") && !hasSurrogate(upper ?? "");
}

/** Whether `key` is truly in `range`; adapters filter scans through this (it only removes rows). */
export function matchesKvRange(key: string, range: KvRange): boolean {
  if (range.prefix && !key.startsWith(range.prefix)) return false;
  if (range.lower !== undefined && key < range.lower) return false;
  if (range.upper !== undefined && key >= range.upper) return false;
  return true;
}

/**
 * Profiler label for a tenant's CLASS (`c2:*`, `nip29:*`, `main`), so totals
 * aren't scattered per community/relay.
 */
export function tenantClass(id: string): string {
  const head = id.split(":", 1)[0];
  return head === id ? id : `${head}:*`;
}
