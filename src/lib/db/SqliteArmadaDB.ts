/**
 * The SQLite adapter for {@link ArmadaDB} — a port of Nostrify's `NSQLiteFTS`
 * with a `tenant` dimension throughout (layout in sqliteSchema.ts). One
 * connection; all tenants share the tables.
 *
 *  - `seq` (rowid) encodes time (`created_at × 2²⁰ + n`), so `ORDER BY seq DESC`
 *    is newest-first everywhere, including FTS5, and `since`/`until` become rowid ranges.
 *  - Tags are tokens: tag terms (and authors, when a tag drives) form one MATCH
 *    of ANDed OR-groups, merged in C.
 * Kinds (and authors without a tag) are tested on fetched rows. Tagless,
 * keywordless filters use strfry's cascade:
 *
 *   ids → tags/search → pubkey+kind → pubkey → kind → the whole tenant
 *
 * Semantics match the IndexedDB adapter: ephemeral kinds never stored;
 * replaceable/addressable supersede per (tenant, kind, pubkey, d), ties to the
 * smaller id; NIP-09 kind 5 applied on write against the requester's own rumors
 * in the tenant (request retained); writes across ALL tenants batch into one
 * transaction per microtask, resolving only after commit.
 *
 * Divergences from `NSQLiteFTS`:
 *  - No deletion tombstone check on write (`NIndexedDB` has none; adapters must agree).
 *  - Results re-sorted `(created_at DESC, id ASC)`; which same-second rumors
 *    survive a cutting `limit` can still differ (scan uses `seq`).
 *  - Only the six NIP-01 fields are stored; extra fields are dropped.
 *  - Reads and writes interleave inside `BEGIN IMMEDIATE`; a second writer on
 *    the file (the Android service) is safe only if equally disciplined.
 */
import { NKinds } from "@nostrify/nostrify";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { ParsedFilter } from "./ParsedFilter";
import { batch, memberOf, qs, where } from "./sql";
import {
  ARMADA_DB_FTS_SCHEMA,
  ARMADA_DB_SCHEMA,
  ARMADA_DB_VERSION,
} from "./sqliteSchema";
import { defaultIndexTags, matchesKvRange, resolveKvRange, termNamespaceRange } from "./types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";
import type {
  ArmadaDB,
  ArmadaDBOpts,
  ArmadaDBUsage,
  ArmadaKV,
  ArmadaKVEntry,
  ArmadaKVListOptions,
  ArmadaKVSelector,
  NRumorStore,
  TenantOpts,
  TermPolicy,
} from "./types";

/** Bits of the rowid reserved for the per-second sequence number. */
const SEQ_BITS = 20;

const SEQ_SPACE = 2 ** SEQ_BITS;

/**
 * Largest `created_at` the rowid encoding carries (2106-02-07); later ones are
 * clamped and matched in memory, so results stay correct.
 */
const MAX_TIME = 0xffffffff;

const CHUNK_SIZE = 512;

/** Bound-parameter cap per statement (older SQLite builds allow only 999). */
const MAX_PARAMS = 900;

const MAX_PAGE = 10_000;

/** Longest `IN (…)` list driving a rumors scan before splitting statements. */
const MAX_IN = 500;

/** Most terms per MATCH `OR` (FTS5 opens an iterator per term). */
const MAX_OR = 500;

/**
 * Most authors folded into the MATCH alongside a tag, versus testing on rows.
 * Measured on 20k rumors: one author 8× faster in the index, 16 a wash, 100 5× slower.
 */
const MAX_AUTHOR_TERMS = 16;

/** Longest value list used to filter (not drive) a scan; longer is matched in memory. */
const MAX_PUSHDOWN = 100;

const BACKFILL_PAGE = 500;

const RUMOR_COLUMNS = "id, kind, pubkey, created_at, tags, content";

const R_RUMOR_COLUMNS = "r.id, r.kind, r.pubkey, r.created_at, r.tags, r.content";

/** Rows and their stored bytes per tenant. `CAST … AS BLOB` measures UTF-8 bytes, not characters. */
const USAGE_TENANTS_SQL =
  "SELECT t.id AS id, COUNT(*) AS rumors, " +
  "SUM(length(CAST(r.content AS BLOB)) + length(CAST(r.tags AS BLOB)) + length(r.id) + length(r.pubkey)) AS bytes " +
  "FROM rumors r JOIN tenants t ON t.ord = r.tenant GROUP BY r.tenant ORDER BY t.id";

const USAGE_KV_SQL =
  "SELECT COUNT(*) AS entries, " +
  "COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0) AS bytes FROM kv";

/** The KV per {@link kvGroupOf} group, largest first; the Kotlin and Swift ports run the same SQL. */
const USAGE_KV_GROUPS_SQL =
  "WITH k AS (SELECT key, length(CAST(key AS BLOB)) + length(CAST(value AS BLOB)) AS b, " +
  "CASE WHEN instr(key, ':') = 0 THEN key ELSE substr(key, 1, instr(key, ':') - 1) END AS head, " +
  "substr(key, instr(key, ':') + 1) AS rest FROM kv) " +
  "SELECT CASE WHEN head = 'folded' AND instr(key, ':') > 0 THEN 'folded:' || " +
  "CASE WHEN instr(rest, ':') = 0 THEN rest ELSE substr(rest, 1, instr(rest, ':') - 1) END ELSE head END AS grp, " +
  "COUNT(*) AS entries, SUM(b) AS bytes FROM k GROUP BY grp ORDER BY bytes DESC, grp";

export interface SqliteArmadaDBOpts extends ArmadaDBOpts {
  /** Install the schema on construction (default `true`; `false` when the transport owns it). */
  migrate?: boolean;
  /**
   * Maintain the FTS5 content index for NIP-50 `search` (default `true`).
   * Off halves write cost; `search` then substring-matches in memory. Must
   * agree with what was migrated (existing triggers still index writes).
   */
  search?: boolean;
}

export class SqliteArmadaDB implements ArmadaDB {
  private readonly db: ArmadaSqlDriver;
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  private readonly search: boolean;
  private readonly stores = new Map<string, SqliteRumorStore>();
  private readonly ords = new Map<string, number>();
  private readonly termPolicies = new Map<string, TermPolicy>();
  private readonly backfills = new Map<string, Promise<void>>();

  private pending: PendingWrite[] = [];
  private flushScheduled = false;
  /**
   * Tail of the write chain: transactions queue rather than interleave (no
   * nested transactions in SQLite).
   */
  private writeLock: Promise<unknown> = Promise.resolve();

  readonly ready: Promise<void>;
  readonly kv: ArmadaKV;

  constructor(db: ArmadaSqlDriver, opts: SqliteArmadaDBOpts = {}) {
    this.db = db;
    this.indexTags = opts.indexTags ?? defaultIndexTags;
    this.search = opts.search !== false;
    this.kv = new SqliteKV(this);

    this.ready = opts.migrate === false ? Promise.resolve() : this.migrate();
    // Mark the rejection handled; every operation awaits `ready` itself.
    this.ready.catch(() => {});
  }

  tenant(id: string, opts: TenantOpts = {}): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new SqliteRumorStore(this, id);
      this.stores.set(id, store);
    }
    if (opts.terms) this.installTerms(id, opts.terms, opts.termsGeneration ?? 0);
    return store;
  }

  /**
   * Bind a tenant's {@link TermPolicy} (to the TENANT, so every writer gets
   * terms) and backfill its existing rows.
   */
  private installTerms(tenant: string, policy: TermPolicy, generation: number): void {
    if (this.termPolicies.get(tenant) === policy) return;
    this.termPolicies.set(tenant, policy);
    // Not awaited: only term-index reads wait (see `awaitTerms`). Eager start is
    // this engine's optimization; native ports backfill on first such read. All
    // must agree: no half-built index is read, and a failed pass leaves the
    // generation unrecorded for retry. Swallowed so one bad row doesn't fail reads.
    this.backfills.set(tenant, this.backfillTerms(tenant, generation).catch(() => {}));
  }

  private termsOf(tenant: string, rumor: NostrRumor): string[] {
    const policy = this.termPolicies.get(tenant);
    return policy ? policy(rumor, tenant) : [];
  }

  /**
   * Wait for `tenant`'s term backfill only for reads that may hit the index.
   * Must gate on any `search` in every port, not `ParsedFilter.terms`:
   * `distinct:` reads `rumor_terms` without a term of its own.
   */
  private async awaitTerms(tenant: string, filters: NostrFilter[]): Promise<void> {
    const pending = this.backfills.get(tenant);
    if (!pending) return;
    if (!filters.some((filter) => typeof filter.search === "string")) return;
    await pending;
  }

  /**
   * Derive and store terms for every rumor in `tenant`, once per policy
   * generation (recorded in `rumor_term_tenants`). Terms can't be computed in
   * SQL, so this walks the tenant newest-first in pages. A different recorded
   * generation drops existing terms first (the walk only inserts). Concurrent
   * writes and a second engine racing are benign (`OR IGNORE`).
   */
  private async backfillTerms(tenant: string, generation: number): Promise<void> {
    await this.ready;

    // Never-written tenant: nothing to index, no ordinal to record against.
    const ord = await this.tenantOrd(tenant);
    if (ord === undefined) return;

    const [done] = await this.all(
      `SELECT generation FROM rumor_term_tenants WHERE tenant = ?`,
      [ord],
    );
    if (done && Number(done.generation) === generation) return;
    if (done) {
      await this.transaction(() => this.run(`DELETE FROM rumor_terms WHERE tenant = ?`, [ord]));
    }

    let before: number | undefined;

    for (;;) {
      const rows = await this.all(
        `SELECT seq, ${RUMOR_COLUMNS} FROM rumors INDEXED BY rumors_tenant
          WHERE tenant = ?${before === undefined ? "" : " AND seq < ?"}
          ORDER BY seq DESC LIMIT ?`.replace(/\s+/g, " "),
        before === undefined ? [ord, BACKFILL_PAGE] : [ord, before, BACKFILL_PAGE],
      );
      if (rows.length === 0) break;

      await this.transaction(async () => {
        for (const row of rows) {
          await this.insertTerms(ord, Number(row.seq), this.termsOf(tenant, rowRumor(row)));
        }
      });

      before = Number(rows[rows.length - 1].seq);
      if (rows.length < BACKFILL_PAGE) break;
    }

    await this.transaction(() =>
      this.run(
        `INSERT OR REPLACE INTO rumor_term_tenants (tenant, generation) VALUES (?, ?)`,
        [ord, generation],
      )
    );
  }

  /** Create tables/indexes/triggers if missing. */
  async migrate(): Promise<void> {
    const schema = this.search
      ? [...ARMADA_DB_SCHEMA, ...ARMADA_DB_FTS_SCHEMA]
      : ARMADA_DB_SCHEMA;

    // A file from before the content index was limited to CONTENT_INDEXED_KINDS
    // has an insert trigger without a WHEN. Swapped in one transaction so no
    // writer on another connection lands between the drop and the create; what
    // it already indexed stays and leaves with its rumors.
    const [insertTrigger] = this.search
      ? await this.all(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'rumors_fts_insert'`)
      : [];
    const apply = async (): Promise<void> => {
      for (const statement of schema) {
        await this.run(statement.trim().replace(/\s+/g, " "));
      }
    };
    if (insertTrigger && !/\bWHEN\b/i.test(String(insertTrigger.sql))) {
      await this.transaction(async () => {
        await this.run(`DROP TRIGGER rumors_fts_insert`);
        await apply();
      });
    } else {
      await apply();
    }

    await this.run(`PRAGMA user_version = ${ARMADA_DB_VERSION}`);
  }

  async wipe(): Promise<void> {
    await this.ready;
    await this.transaction(async () => {
      // `delete-all` also clears FTS rows orphaned by a crash or policy change.
      await this.run(`DELETE FROM rumors`);
      await this.run(`INSERT INTO rumor_tags_fts (rumor_tags_fts) VALUES ('delete-all')`);
      if (this.search) {
        await this.run(`INSERT INTO rumors_fts (rumors_fts) VALUES ('delete-all')`);
      }
      await this.run(`DELETE FROM rumor_coords`);
      // Explicit, for the same orphan reason.
      await this.run(`DELETE FROM rumor_terms`);
      await this.run(`DELETE FROM rumor_term_tenants`);
      await this.run(`DELETE FROM tenants`);
      await this.run(`DELETE FROM removed_rumors`);
      await this.run(`DELETE FROM kv`);
    });

    // Interned ids are reallocated after this.
    this.ords.clear();

    // Policies stay bound; empty tenants need no backfill.
    this.backfills.clear();
  }

  /** See {@link ArmadaDB.usage}; the Kotlin and Swift ports run the same SQL. */
  async usage(): Promise<ArmadaDBUsage> {
    await this.ready;
    const tenants = await this.all(USAGE_TENANTS_SQL);
    const [kv] = await this.all(USAGE_KV_SQL);
    const groups = await this.all(USAGE_KV_GROUPS_SQL);
    const [pages] = await this.all(`PRAGMA page_count`);
    const [size] = await this.all(`PRAGMA page_size`);
    return {
      tenants: tenants.map((row) => ({ id: String(row.id), rumors: Number(row.rumors), bytes: Number(row.bytes) })),
      kv: {
        entries: Number(kv?.entries ?? 0),
        bytes: Number(kv?.bytes ?? 0),
        groups: groups.map((row) => ({ group: String(row.grp), entries: Number(row.entries), bytes: Number(row.bytes) })),
      },
      fileBytes: Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.db.close?.();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Queue a rumor for the batched commit on the next microtask. */
  putRumor(tenant: string, rumor: NostrRumor): Promise<void> {
    if (NKinds.ephemeral(rumor.kind)) return Promise.resolve();

    // Only the six NIP-01 columns are stored, so `sig` never is.
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ tenant, rumor, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flushWrites();
    });
  }

  private async flushWrites(): Promise<void> {
    const writes = this.pending;
    if (writes.length === 0) return;

    this.pending = [];

    try {
      await this.ready;
      await this.transaction(async () => {
        const batched = new RumorBatch();
        for (const { tenant, rumor } of writes) {
          // Rumors that READ the batch (supersession, kind 5) need prior rows in
          // the table: flush first so they see exactly what preceded them.
          if (needsOwnStatement(rumor)) {
            await this.writeBatch(batched);
            await this.writeRumor(tenant, rumor, batched);
          } else {
            await this.stageRumor(tenant, rumor, batched);
          }
        }
        await this.writeBatch(batched);
      });
    } catch (error) {
      for (const write of writes) write.reject(error);
      return;
    }

    // Settled after commit, so resolving means durable.
    for (const write of writes) write.resolve();
  }

  /** Stage one ordinary rumor's rows into `batch` (see {@link RumorBatch}). */
  private async stageRumor(tenant: string, rumor: NostrRumor, batch: RumorBatch): Promise<void> {
    const ord = await this.internTenant(tenant);
    const seq = await this.reserveSeq(ord, rumor, batch);
    if (seq === undefined) return;
    batch.add(seq, ord, rumor, this.tagTokens(`t${ord}`, rumor), this.termsOf(tenant, rumor));
  }

  /**
   * Write a staged batch as multi-row INSERTs per table. SQLite runs a
   * trigger's sub-program per statement, so row-per-statement cost 76µs/row vs
   * 17µs batched. Tables are written back to front so a `rumors` row (what
   * makes it visible) never lacks its index rows for another connection.
   */
  private async writeBatch(batch: RumorBatch): Promise<void> {
    for (const [sql, params] of batch.statements()) await this.run(sql, params);
    batch.clear();
  }

  private async writeRumor(tenant: string, rumor: NostrRumor, batch: RumorBatch): Promise<void> {
    const ord = await this.internTenant(tenant);
    const prefix = `t${ord}`;
    const terms = this.termsOf(tenant, rumor);
    let seq: number | undefined;

    // Before anything below can supersede or delete on a removed rumor's behalf.
    const [removed] = await this.all(`SELECT 1 AS hit FROM removed_rumors WHERE id = ?`, [rumor.id]);
    if (removed) return;

    if (NKinds.replaceable(rumor.kind) || NKinds.addressable(rumor.kind)) {
      const coord = getCoord(rumor);

      const [existing] = await this.all(
        `SELECT id, seq, created_at FROM rumor_coords WHERE tenant = ? AND coord = ?`,
        [ord, coord],
      );

      if (existing) {
        const stored = { id: String(existing.id), created_at: Number(existing.created_at) };
        // NIP-01: only a strictly newer version (ties to the smaller id) replaces.
        if (!isNewer(rumor, stored)) return;
        await this.deleteRumors(ord, [Number(existing.seq)]);
      }

      seq = await this.insertRumor(ord, prefix, rumor, terms, batch);
      if (seq === undefined) return;

      await this.run(
        `INSERT OR REPLACE INTO rumor_coords (tenant, coord, id, seq, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        [ord, coord, rumor.id, seq, rumor.created_at],
      );
    } else {
      seq = await this.insertRumor(ord, prefix, rumor, terms, batch);
      if (seq === undefined) return;
    }

    // After the insert so a kind 5 alongside its targets still resolves.
    if (rumor.kind === 5) {
      await this.applyDeletion(ord, rumor);
    }
  }

  /**
   * Write ONE rumor's rows immediately (for {@link needsOwnStatement} rumors,
   * which must see prior rows); `undefined` if already stored. `RETURNING`
   * measured 2.7× slower (loses SQLite's insert fast path).
   */
  private async insertRumor(
    ord: number,
    prefix: string,
    rumor: NostrRumor,
    terms: string[],
    batch: RumorBatch,
  ): Promise<number | undefined> {
    const seq = await this.reserveSeq(ord, rumor, batch);
    if (seq === undefined) return undefined;

    await this.run(
      `INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seq,
        ord,
        rumor.id,
        rumor.kind,
        rumor.pubkey,
        rumor.created_at,
        JSON.stringify(rumor.tags),
        rumor.content,
      ],
    );

    // The content index is trigger-maintained; this is the only index written here.
    await this.run(
      `INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)`,
      [seq, this.tagTokens(prefix, rumor)],
    );

    await this.insertTerms(ord, seq, terms);

    return seq;
  }

  /**
   * The rowid this rumor takes, or `undefined` if already stored. Allocated by
   * LOOKING (not a counter) so a second writer can't get the same one; the
   * bucket spans tenants. `batch` covers reserved-but-unwritten rowids, and
   * `BEGIN IMMEDIATE` holds the write lock from reservation to use.
   */
  private async reserveSeq(
    ord: number,
    rumor: NostrRumor,
    batch: RumorBatch,
  ): Promise<number | undefined> {
    const base = bucket(rumor.created_at);

    // Same id twice in one burst would collide on the unique index.
    if (batch.staged(ord, rumor.id)) return undefined;

    // A removed id (see `forget`) answers like a stored one, in the same lookup.
    const [row] = await this.all(
      `SELECT (SELECT seq FROM rumors WHERE tenant = ? AND id = ?) AS existing,
        (SELECT 1 FROM removed_rumors WHERE id = ?) AS removed,
        (SELECT MAX(seq) FROM rumors WHERE seq >= ? AND seq < ?) AS last`,
      [ord, rumor.id, rumor.id, base, base + SEQ_SPACE],
    );

    if (row?.existing !== null && row?.existing !== undefined) return undefined;
    if (row?.removed !== null && row?.removed !== undefined) return undefined;

    const stored = row?.last === null || row?.last === undefined ? undefined : Number(row.last);
    const seq = Math.max(stored ?? base - 1, batch.lastSeq(base) ?? base - 1) + 1;

    // >2²⁰ rumors in one second outgrows the encoding; fail loudly.
    if (seq >= base + SEQ_SPACE) {
      throw new Error(`ArmadaDB: too many rumors at created_at ${rumor.created_at}`);
    }

    batch.reserve(ord, rumor.id, base, seq);
    return seq;
  }

  /**
   * File a rumor's derived terms in ONE statement (varying shapes are few and
   * cached). `OR IGNORE`: duplicate terms, and backfill over live-indexed rows.
   */
  private async insertTerms(ord: number, seq: number, terms: string[]): Promise<void> {
    const usable = terms.filter((term) => typeof term === "string" && term !== "");
    if (usable.length === 0) return;

    const params: SqlValue[] = [];
    for (const term of usable) params.push(ord, term, seq);

    await this.run(
      `INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES ${
        usable.map(() => "(?, ?, ?)").join(", ")
      }`,
      params,
    );
  }

  /**
   * A rumor's index tokens: indexed tags plus `<tenant>:_p:<pubkey>` (authors
   * merge into the same MATCH). No kind token: its posting list would be huge.
   */
  private tagTokens(prefix: string, rumor: NostrRumor): string {
    const tokens: string[] = [`${prefix}:_p:${part(rumor.pubkey)}`];
    const seen = new Set<string>();

    for (const [name, value] of this.indexTags(rumor)) {
      if (typeof name !== "string" || typeof value !== "string") continue;
      const token = tagToken(prefix, name, value);
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }

    return tokens.join(" ");
  }

  /**
   * A tenant's interned integer, or `undefined` if never written (no rows).
   * Interned, not hashed: colliding prefixes would share posting lists
   * (cross-tenant read). Durable, so cached per process.
   */
  private async tenantOrd(tenant: string): Promise<number | undefined> {
    const cached = this.ords.get(tenant);
    if (cached !== undefined) return cached;

    const [row] = await this.all(`SELECT ord FROM tenants WHERE id = ?`, [tenant]);
    if (!row) return undefined;

    const ord = Number(row.ord);
    this.ords.set(tenant, ord);
    return ord;
  }

  private async internTenant(tenant: string): Promise<number> {
    const existing = await this.tenantOrd(tenant);
    if (existing !== undefined) return existing;

    await this.run(`INSERT OR IGNORE INTO tenants (id) VALUES (?)`, [tenant]);

    const [row] = await this.all(`SELECT ord FROM tenants WHERE id = ?`, [tenant]);
    const ord = Number(row.ord);
    this.ords.set(tenant, ord);
    return ord;
  }

  /**
   * NIP-09: delete a kind 5's targets in its tenant, only the author's own;
   * `a` targets only at or before the request's `created_at`.
   */
  private async applyDeletion(ord: number, request: NostrRumor): Promise<void> {
    const targets = request.tags.filter(
      ([name, value]) => (name === "e" || name === "a") && !!value,
    );
    if (targets.length === 0) return;

    const seqs = new Set<number>();

    // A request can't delete itself (it occupies no coordinate).
    const eTags = targets
      .filter(([name, value]) => name === "e" && value !== request.id)
      .map(([, value]) => value);
    const aTags = targets.filter(([name]) => name === "a").map(([, value]) => value);

    for (const chunk of batch(eTags, MAX_PARAMS - 2)) {
      const rows = await this.all(
        `SELECT seq FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)} AND pubkey = ?`,
        [ord, ...chunk, request.pubkey],
      );
      for (const row of rows) seqs.add(Number(row.seq));
    }

    // One stored version per coordinate: a primary-key lookup.
    const owned = aTags.filter((coord) => coord.split(":")[1] === request.pubkey);

    for (const chunk of batch(owned, MAX_PARAMS - 2)) {
      const rows = await this.all(
        `SELECT seq FROM rumor_coords
          WHERE tenant = ? AND ${memberOf("coord", chunk)} AND created_at <= ?`,
        [ord, ...chunk, request.created_at],
      );
      for (const row of rows) seqs.add(Number(row.seq));
    }

    await this.deleteRumors(ord, [...seqs]);
  }

  /**
   * Delete rumors by rowid plus their coordinates (by primary key, recomputed
   * from the row); triggers drop index rows.
   */
  private async deleteRumors(ord: number, seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;

    for (const chunk of batch(seqs, MAX_PARAMS - 1)) {
      const rows = await this.all(
        `SELECT kind, pubkey, tags FROM rumors WHERE ${memberOf("seq", chunk)}`,
        chunk,
      );

      // Only coordinate-bearing rumors need tags parsed.
      const coords = rows
        .filter((row) => NKinds.replaceable(Number(row.kind)) || NKinds.addressable(Number(row.kind)))
        .map((row) =>
          getCoord({
            kind: Number(row.kind),
            pubkey: String(row.pubkey),
            tags: JSON.parse(String(row.tags)) as string[][],
          })
        );

      for (const coordChunk of batch(coords, MAX_PARAMS - 1)) {
        await this.run(
          `DELETE FROM rumor_coords WHERE tenant = ? AND ${memberOf("coord", coordChunk)}`,
          [ord, ...coordChunk],
        );
      }

      await this.run(`DELETE FROM rumors WHERE ${memberOf("seq", chunk)}`, chunk);
    }
  }

  /**
   * Rumors in `tenant` matching the filters (OR'd together), newest-first,
   * de-duplicated by id, each filter's `limit` respected.
   */
  async queryTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRumor[]> {
    await this.ready;
    await this.awaitTerms(tenant, filters);

    const ord = await this.tenantOrd(tenant);
    if (ord === undefined) return [];

    const byId = new Map<string, NostrRumor>();
    const prefix = `t${ord}`;

    // Sequential: one connection.
    for (const filter of filters) {
      const parsed = new ParsedFilter(filter);
      for (const rumor of await this.queryFilter(ord, prefix, tenant, parsed, opts?.signal)) {
        byId.set(rumor.id, rumor);
      }
    }

    return [...byId.values()].sort(compareNewest);
  }

  private async queryFilter(
    ord: number,
    prefix: string,
    tenant: string,
    filter: ParsedFilter,
    signal?: AbortSignal,
  ): Promise<NostrRumor[]> {
    if (filter.neverMatch) return [];

    const limit = filter.limit ?? Infinity;
    if (limit <= 0) return [];

    signal?.throwIfAborted();

    const plan = this.planScan(ord, prefix, filter);

    if (plan.ids) {
      return await this.queryIds(ord, plan.ids, filter, limit);
    }

    // Collapse not grouped by the index is applied here; `limit` still counts
    // groups, so short pages continue.
    const collapse = filter.distinct !== undefined && !plan.grouped;

    // A single complete plan IS the answer: run it once.
    if (!collapse && plan.cursors.length === 1 && plan.sqlOnly) {
      const rows = await this.readPage(
        plan.cursors[0],
        undefined,
        limit === Infinity ? undefined : limit,
        false,
      );
      const found = rows.map((row) => row.rumor);
      found.sort(compareNewest);
      return found;
    }

    const collected: NostrRumor[] = [];
    const seen = new Set<string>();
    const groups = new Set<string>();

    // Complete plans page to the remaining limit; incomplete or collapsing ones
    // page in chunks.
    let pageSize = plan.sqlOnly && !collapse ? Math.min(limit, MAX_PAGE) : CHUNK_SIZE;

    let before: number | undefined;

    while (collected.length < limit) {
      signal?.throwIfAborted();

      const page = await this.scanPage(plan, before, pageSize);
      if (page.length === 0) break;

      before = page[page.length - 1].seq;

      for (const { rumor } of page) {
        if (collected.length >= limit) break;
        if (seen.has(rumor.id)) continue;
        seen.add(rumor.id);

        if (!(plan.sqlOnly || filter.matches(rumor, plan.searched))) continue;

        if (collapse) {
          // No term in the namespace: excluded.
          const key = filter.collapseKey(this.termsOf(tenant, rumor));
          if (key === undefined || groups.has(key)) continue;
          groups.add(key);
        }

        collected.push(rumor);
      }

      if (page.length < pageSize) break;

      // Conditions are selective: widen geometrically.
      pageSize = Math.min(pageSize * 4, MAX_PAGE);
    }

    collected.sort(compareNewest);
    return collected;
  }

  private async queryIds(
    ord: number,
    ids: string[],
    filter: ParsedFilter,
    limit: number,
  ): Promise<NostrRumor[]> {
    const rumors: NostrRumor[] = [];

    for (const chunk of batch(ids, MAX_PARAMS - 16)) {
      const conditions = ["tenant = ?", memberOf("id", chunk)];
      const params: SqlValue[] = [ord, ...chunk];

      if (filter.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(filter.since);
      }
      if (filter.until !== undefined) {
        conditions.push("created_at <= ?");
        params.push(filter.until);
      }
      if (filter.kinds && filter.kinds.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("kind", filter.kinds));
        params.push(...filter.kinds);
      }
      if (filter.authors && filter.authors.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("pubkey", filter.authors));
        params.push(...filter.authors);
      }

      for (
        const row of await this.all(`SELECT ${RUMOR_COLUMNS} FROM rumors${where(conditions)}`, params)
      ) {
        const rumor = rowRumor(row);
        // SQL already applied ids byte-exactly; see `matches`.
        if (filter.matches(rumor, false, true)) rumors.push(rumor);
      }
    }

    rumors.sort(compareNewest);
    return rumors.length > limit ? rumors.slice(0, limit) : rumors;
  }

  private async scanPage(
    plan: ScanPlan,
    before: number | undefined,
    pageSize: number,
  ): Promise<Candidate[]> {
    if (plan.cursors.length === 1) {
      return await this.readPage(plan.cursors[0], before, pageSize);
    }

    const merged: Candidate[] = [];

    for (const cursor of plan.cursors) {
      merged.push(...await this.readPage(cursor, before, pageSize));
    }

    merged.sort((a, b) => b.seq - a.seq);
    return merged.slice(0, pageSize);
  }

  /**
   * Read one cursor's next rows, newest-first: conditions first, `LIMIT` last,
   * so SQLite walks posting lists backwards and stops once `limit` rows survive.
   *
   * `CROSS JOIN` is load-bearing: it fixes the join order; otherwise a
   * rumors-table condition makes the planner drive from rumors, re-evaluating
   * MATCH per row and sorting via temp b-tree (462ms vs 0.16ms on 20k). See the plan test.
   */
  private async readPage(
    cursor: ScanCursor,
    before: number | undefined,
    limit: number | undefined,
    keys = true,
  ): Promise<Candidate[]> {
    let sql: string;
    const params: SqlValue[] = [];

    if (!("from" in cursor)) {
      const scan = this.ftsScan(cursor, before);
      params.push(...scan.params, ...(cursor.where ? cursor.params ?? [] : []));

      sql = `SELECT ${keys ? "r.seq, " : ""}${R_RUMOR_COLUMNS} FROM ${scan.driver}
        CROSS JOIN rumors r ON r.seq = ${scan.driver}.rowid${
        where([...scan.conditions, ...(cursor.where ?? [])])
      } ORDER BY ${scan.driver}.rowid DESC${limit === undefined ? "" : " LIMIT ?"}`;
    } else {
      const conditions = [...cursor.where];
      params.push(...cursor.params);
      // Index-driven scans (`rumor_terms`) order by the driver's copy of the rowid.
      const key = cursor.key ?? "seq";

      if (before !== undefined) {
        conditions.push(`${key} < ?`);
        params.push(before);
      }

      // Key column only needed for paging.
      sql = `SELECT ${keys ? `${key} AS seq, ` : ""}${cursor.columns ?? RUMOR_COLUMNS} FROM ${cursor.from}${
        where(conditions)
      } ORDER BY ${key} DESC${limit === undefined ? "" : " LIMIT ?"}`;
    }

    if (limit !== undefined) params.push(limit);

    const rows = await this.all(sql.replace(/\s+/g, " "), params);

    return rows.map((row) => ({
      seq: keys ? Number(row.seq) : 0,
      rumor: rowRumor(row),
    }));
  }

  /**
   * The index scan behind a full-text cursor. Tokens drive when present (they
   * carry tenant, time and order); keywords alongside are resolved to a rowid
   * set (FTS5 can't intersect across tables).
   */
  private ftsScan(
    cursor: FtsCursor,
    before: number | undefined,
  ): { driver: string; conditions: string[]; params: SqlValue[] } {
    const driver = cursor.match ? "rumor_tags_fts" : "rumors_fts";
    const conditions = [`${driver} MATCH ?`];
    const params: SqlValue[] = [cursor.match ?? cursor.search!];

    if (cursor.match && cursor.search) {
      // The `+` is load-bearing: without it SQLite pushes the rowid list into
      // the token index as one scan per match instead of a single filtered scan.
      conditions.push(
        `+${driver}.rowid IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)`,
      );
      params.push(cursor.search);
    }

    // Bound the driver's rowid so FTS5 stops its walk early.
    if (cursor.min !== undefined) {
      conditions.push(`${driver}.rowid >= ?`);
      params.push(cursor.min);
    }

    // Paging bound and `until`: the tighter applies.
    const max = before !== undefined ? before - 1 : cursor.max;

    if (max !== undefined) {
      conditions.push(`${driver}.rowid <= ?`);
      params.push(max);
    }

    return { driver, conditions, params };
  }

  /**
   * The query planner: tags/keywords drive via the index; otherwise a b-tree
   * by strfry's cascade (all lead with `tenant` and are time-ordered).
   */
  private planScan(ord: number, prefix: string, filter: ParsedFilter): ScanPlan {
    const { min, max, exact } = timeRange(filter);

    // 0. a collapse: grouped in the index when nothing outside it must be
    //    tested; otherwise collapsed as rows come back (`queryFilter`).
    if (filter.distinct !== undefined) {
      const plan = this.planDistinct(ord, filter, min, max, exact);
      if (plan) return plan;
    }

    // 1. derived terms, ahead of ids: nothing else can check them afterwards.
    if (filter.terms.length > 0) {
      return this.planTerms(ord, filter, min, max, exact);
    }

    // 2. ids — the (tenant, id) unique index.
    if (filter.ids) {
      return { ids: filter.ids, cursors: [], sqlOnly: false, searched: false };
    }

    // Without the content index, keywords fall to the in-memory match.
    const search = this.search ? filter.searchQuery : undefined;

    // 3. tags, or a NIP-50 search: the index drives.
    if (filter.tags.length > 0 || search) {
      const plan = this.planFts(ord, prefix, filter, search, min, max, exact);
      if (plan) return plan;
    }

    const addTime = (conditions: string[], params: SqlValue[]): void => {
      // Rowid bound stops the scan; `created_at` makes it exact for clamped timestamps.
      if (min !== undefined) {
        conditions.push("seq >= ?");
        params.push(min);
      }
      if (max !== undefined) {
        conditions.push("seq <= ?");
        params.push(max);
      }
      if (filter.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(filter.since);
      }
      if (filter.until !== undefined) {
        conditions.push("created_at <= ?");
        params.push(filter.until);
      }
    };

    const searched = !filter.searchKeywords;
    const pushKinds = !filter.kinds || filter.kinds.length <= MAX_PUSHDOWN;

    // 4. authors + kinds via the (tenant, pubkey, kind, time) composite index.
    if (filter.authors && filter.kinds && pushKinds) {
      const cursors = [...batch(filter.authors, MAX_IN)].map((authors): ScanCursor => {
        const conditions = [
          "tenant = ?",
          memberOf("pubkey", authors),
          memberOf("kind", filter.kinds!),
        ];
        const params: SqlValue[] = [ord, ...authors, ...filter.kinds!];

        addTime(conditions, params);

        return { from: "rumors INDEXED BY rumors_pubkey_kind", where: conditions, params };
      });

      return { cursors, sqlOnly: searched, searched };
    }

    // 5. authors, kinds filtering when few enough to bind.
    if (filter.authors) {
      const cursors = [...batch(filter.authors, MAX_IN)].map((authors): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("pubkey", authors)];
        const params: SqlValue[] = [ord, ...authors];

        addTime(conditions, params);

        if (filter.kinds && pushKinds) {
          conditions.push(memberOf("kind", filter.kinds));
          params.push(...filter.kinds);
        }

        return { from: "rumors INDEXED BY rumors_pubkey", where: conditions, params };
      });

      return { cursors, sqlOnly: searched && pushKinds, searched };
    }

    // 6. kinds.
    if (filter.kinds) {
      const cursors = [...batch(filter.kinds, MAX_IN)].map((kinds): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("kind", kinds)];
        const params: SqlValue[] = [ord, ...kinds];

        addTime(conditions, params);

        return { from: "rumors INDEXED BY rumors_kind", where: conditions, params };
      });

      return { cursors, sqlOnly: searched, searched };
    }

    // 7. fallback: the whole tenant, one contiguous backwards index walk.
    const conditions = ["tenant = ?"];
    const params: SqlValue[] = [ord];
    addTime(conditions, params);

    return {
      cursors: [{ from: "rumors INDEXED BY rumors_tenant", where: conditions, params }],
      sqlOnly: searched,
      searched,
    };
  }

  /**
   * Plan a filter as MATCH expressions (ANDed groups of alternatives; cost is
   * the shortest group), or `undefined` when the index can't drive it.
   */
  private planFts(
    ord: number,
    prefix: string,
    filter: ParsedFilter,
    search: string | undefined,
    min: number | undefined,
    max: number | undefined,
    exact: boolean,
  ): ScanPlan | undefined {
    const groups: string[][] = [];

    for (const tag of filter.tags) {
      groups.push(tag.values.map((value) => tagToken(prefix, tag.name, value)));
    }

    // All-negation searches can't be expressed in FTS5; left to the in-memory matcher.
    const searched = !filter.searchKeywords || !!search;

    // Authors join the index only alongside a tag, and only while few.
    const inIndex = groups.length > 0 && !!filter.authors &&
      filter.authors.length <= MAX_AUTHOR_TERMS;

    if (inIndex) {
      groups.push(filter.authors!.map((pubkey) => `${prefix}:_p:${part(pubkey)}`));
    }

    if (groups.length === 0 && !search) return undefined;

    // What the index doesn't carry is tested in SQL on fetched rows.
    const conditions: string[] = [];
    const params: SqlValue[] = [];

    // Tokens carry the tenant; keyword-only scans must state it.
    if (groups.length === 0) {
      conditions.push("r.tenant = ?");
      params.push(ord);
    }

    if (filter.kinds && filter.kinds.length <= MAX_PUSHDOWN) {
      conditions.push(memberOf("r.kind", filter.kinds));
      params.push(...filter.kinds);
    }

    if (!inIndex && filter.authors && filter.authors.length <= MAX_PUSHDOWN) {
      conditions.push(memberOf("r.pubkey", filter.authors));
      params.push(...filter.authors);
    }

    // Re-check clamped timestamps exactly.
    if (!exact && filter.since !== undefined) {
      conditions.push("r.created_at >= ?");
      params.push(filter.since);
    }
    if (!exact && filter.until !== undefined) {
      conditions.push("r.created_at <= ?");
      params.push(filter.until);
    }

    const complete = (!filter.kinds || filter.kinds.length <= MAX_PUSHDOWN) &&
      (inIndex || !filter.authors || filter.authors.length <= MAX_PUSHDOWN);

    // Split the longest group (every cursor repeats the others in full).
    const longest = groups.reduce((a, b) => (b.length > a.length ? b : a), groups[0] ?? []);
    const chunks = longest.length > MAX_OR ? [...batch(longest, MAX_OR)] : [longest];

    const cursors: ScanCursor[] = chunks.map((chunk): ScanCursor => ({
      match: groups.length > 0
        ? matchExpr(groups.map((group) => (group === longest ? chunk : group)))
        : undefined,
      search,
      min,
      max,
      where: conditions,
      params,
    }));

    return { cursors, sqlOnly: complete && searched, searched };
  }

  /**
   * Plan a `distinct:<namespace>` collapse in the INDEX (the conversation
   * list): `rumor_terms` `(tenant, term, seq)` makes `GROUP BY term` an ordered
   * walk with `MAX(seq)` per block, so the sorter sorts conversations and one
   * body is read per row.
   *
   * `undefined` (collapse after the normal plan) when row conditions must be
   * tested, since they apply BEFORE the collapse; extra terms stay index-only
   * via `EXISTS`. `CROSS JOIN` fixes the join order as in {@link planTerms}.
   */
  private planDistinct(
    ord: number,
    filter: ParsedFilter,
    min: number | undefined,
    max: number | undefined,
    exact: boolean,
  ): ScanPlan | undefined {
    const range = termNamespaceRange(filter.distinct!);
    if (!range) return undefined;

    // Row conditions (incl. clamped time bounds) can't be applied index-only.
    if (
      filter.ids || filter.kinds || filter.authors || filter.tags.length > 0 ||
      filter.searchKeywords || (!exact && (filter.since !== undefined || filter.until !== undefined))
    ) {
      return undefined;
    }

    const conditions = ["x.tenant = ?", "x.term >= ?"];
    const params: SqlValue[] = [ord, range.lower];

    if (range.upper !== undefined) {
      conditions.push("x.term < ?");
      params.push(range.upper);
    }
    if (min !== undefined) {
      conditions.push("x.seq >= ?");
      params.push(min);
    }
    if (max !== undefined) {
      conditions.push("x.seq <= ?");
      params.push(max);
    }
    for (const term of filter.terms) {
      conditions.push(
        "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)",
      );
      params.push(term);
    }

    const grouped = `(SELECT MAX(x.seq) AS seq FROM rumor_terms x${
      where(conditions)
    } GROUP BY x.term)`;

    return {
      cursors: [{
        from: `${grouped} g CROSS JOIN rumors r ON r.seq = g.seq`,
        key: "g.seq",
        columns: R_RUMOR_COLUMNS,
        where: [],
        params,
      }],
      grouped: true,
      sqlOnly: true,
      searched: true,
    };
  }

  /**
   * Plan a filter naming derived terms: `rumor_terms` drives (a time-ordered
   * range walk per term; extra terms as `EXISTS` point lookups) and the rest is
   * tested on rows. `CROSS JOIN` keeps rumors the inner side (see {@link readPage}).
   */
  private planTerms(
    ord: number,
    filter: ParsedFilter,
    min: number | undefined,
    max: number | undefined,
    exact: boolean,
  ): ScanPlan {
    const [driving, ...rest] = filter.terms;
    const conditions = ["x.tenant = ?", "x.term = ?"];
    const params: SqlValue[] = [ord, driving];

    if (min !== undefined) {
      conditions.push("x.seq >= ?");
      params.push(min);
    }
    if (max !== undefined) {
      conditions.push("x.seq <= ?");
      params.push(max);
    }

    for (const term of rest) {
      conditions.push(
        "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)",
      );
      params.push(term);
    }

    let complete = true;

    // ids are pushed down here: the ids plan can't apply a term.
    if (filter.ids) {
      if (filter.ids.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("r.id", filter.ids));
        params.push(...filter.ids);
      } else {
        complete = false;
      }
    }

    if (filter.kinds) {
      if (filter.kinds.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("r.kind", filter.kinds));
        params.push(...filter.kinds);
      } else {
        complete = false;
      }
    }

    if (filter.authors) {
      if (filter.authors.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("r.pubkey", filter.authors));
        params.push(...filter.authors);
      } else {
        complete = false;
      }
    }

    // Re-check clamped timestamps exactly.
    if (!exact && filter.since !== undefined) {
      conditions.push("r.created_at >= ?");
      params.push(filter.since);
    }
    if (!exact && filter.until !== undefined) {
      conditions.push("r.created_at <= ?");
      params.push(filter.until);
    }

    // Tags and keywords resolve to rowid sets the term walk tests (no
    // cross-table index intersection); the term is the selective driver.
    if (filter.tags.length > 0) {
      // Too long to split in one statement: left to the in-memory matcher.
      if (filter.tags.some((tag) => tag.values.length > MAX_OR)) {
        complete = false;
      } else {
        conditions.push(
          "x.seq IN (SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?)",
        );
        params.push(
          matchExpr(
            filter.tags.map((tag) => tag.values.map((value) => tagToken(`t${ord}`, tag.name, value))),
          ),
        );
      }
    }

    const search = this.search ? filter.searchQuery : undefined;
    const searched = !filter.searchKeywords || !!search;

    if (search) {
      conditions.push("x.seq IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)");
      params.push(search);
    }

    return {
      cursors: [{
        from: "rumor_terms x CROSS JOIN rumors r ON r.seq = x.seq",
        key: "x.seq",
        columns: R_RUMOR_COLUMNS,
        where: conditions,
        params,
      }],
      sqlOnly: complete && searched,
      searched,
    };
  }

  async countTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    await this.ready;
    await this.awaitTerms(tenant, filters);

    // A single complete plan is counted inside the index, no bodies read.
    if (filters.length === 1) {
      const filter = new ParsedFilter(filters[0]);
      if (filter.neverMatch) return { count: 0, approximate: false };

      if (filter.limit === undefined) {
        const ord = await this.tenantOrd(tenant);
        if (ord === undefined) return { count: 0, approximate: false };

        const plan = this.planScan(ord, `t${ord}`, filter);

        // An ungrouped collapse would make `COUNT(*)` count messages, not
        // groups; count from the rows instead (as IndexedDBArmadaDB does).
        const collapsed = filter.distinct !== undefined && !plan.grouped;

        if (!collapsed && plan.sqlOnly && !plan.ids && plan.cursors.length === 1) {
          const [cursor] = plan.cursors;
          let sql: string;
          const params: SqlValue[] = [];

          if (!("from" in cursor)) {
            const scan = this.ftsScan(cursor, undefined);
            params.push(...scan.params);

            // Nothing left to test: the index alone answers; else visit columns only.
            if (cursor.where?.length) {
              params.push(...(cursor.params ?? []));
              sql = `SELECT COUNT(*) AS count FROM ${scan.driver}
                CROSS JOIN rumors r ON r.seq = ${scan.driver}.rowid${
                where([...scan.conditions, ...cursor.where])
              }`;
            } else {
              sql = `SELECT COUNT(*) AS count FROM ${scan.driver}${where(scan.conditions)}`;
            }
          } else {
            sql = `SELECT COUNT(*) AS count FROM ${cursor.from}${where(cursor.where)}`;
            params.push(...cursor.params);
          }

          const [row] = await this.all(sql.replace(/\s+/g, " "), params);
          return { count: Number(row?.count ?? 0), approximate: false };
        }
      }
    }

    const rumors = await this.queryTenant(tenant, filters, opts);
    return { count: rumors.length, approximate: false };
  }

  async removeTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    // A `distinct:` collapse isn't a coherent deletion (it'd delete every
    // conversation's newest message); dropped, like other unhonourable narrowings.
    const deletable = filters.filter((filter) => new ParsedFilter(filter).distinct === undefined);
    if (deletable.length === 0) return;

    const rumors = await this.queryTenant(tenant, deletable, opts);
    if (rumors.length === 0) return;

    // Non-empty results imply an ordinal.
    const ord = await this.tenantOrd(tenant);
    if (ord === undefined) return;

    await this.transaction(async () => {
      const seqs: number[] = [];

      for (const chunk of batch(rumors.map((rumor) => rumor.id), MAX_PARAMS - 1)) {
        const rows = await this.all(
          `SELECT seq FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)}`,
          [ord, ...chunk],
        );
        for (const row of rows) seqs.push(Number(row.seq));
      }

      await this.deleteRumors(ord, seqs);
    });
  }

  /**
   * Delete these rumors from every tenant and refuse them in any tenant from now
   * on. The tombstone lands first in the same transaction, so a write queued
   * before this call is refused too rather than racing it.
   */
  async forget(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)].filter((id) => typeof id === "string" && id !== "");
    if (unique.length === 0) return;
    await this.ready;

    await this.transaction(async () => {
      for (const chunk of batch(unique, MAX_PARAMS)) {
        await this.run(
          `INSERT OR IGNORE INTO removed_rumors (id) VALUES ${chunk.map(() => "(?)").join(", ")}`,
          chunk,
        );
      }
      // `rumors_id` is (tenant, id): one probe per tenant, not a table scan.
      for (const { ord } of await this.all(`SELECT ord FROM tenants`)) {
        const seqs: number[] = [];
        for (const chunk of batch(unique, MAX_PARAMS - 1)) {
          const rows = await this.all(
            `SELECT seq FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)}`,
            [Number(ord), ...chunk],
          );
          for (const row of rows) seqs.push(Number(row.seq));
        }
        await this.deleteRumors(Number(ord), seqs);
      }
    });
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.db.run(sql, params);
  }

  async all(sql: string, params: SqlValue[] = []): Promise<SqlRow[]> {
    return await this.db.all(sql, params);
  }

  /** Run `fn` in a transaction, queued behind any in flight (so it isn't swept into another's rollback). */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeLock.then(async () => {
      await this.run("BEGIN IMMEDIATE");

      try {
        const value = await fn();
        await this.run("COMMIT");
        return value;
      } catch (error) {
        await this.run("ROLLBACK");
        throw error;
      }
    });

    // Keep the chain alive after failures.
    this.writeLock = result.catch(() => {});

    return result;
  }

  [Symbol.toStringTag] = "SqliteArmadaDB";
}

class SqliteRumorStore implements NRumorStore {
  constructor(
    private readonly db: SqliteArmadaDB,
    private readonly id: string,
  ) {}

  event(event: NostrRumor, _opts?: { signal?: AbortSignal }): Promise<void> {
    return this.db.putRumor(this.id, event);
  }

  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    return this.db.queryTenant(this.id, filters, opts);
  }

  count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    return this.db.countTenant(this.id, filters, opts);
  }

  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    return this.db.removeTenant(this.id, filters, opts);
  }

  [Symbol.toStringTag] = "SqliteRumorStore";
}

class SqliteKV implements ArmadaKV {
  constructor(private readonly db: SqliteArmadaDB) {}

  async get<T>(key: string): Promise<T | undefined> {
    await this.db.ready;
    const [row] = await this.db.all(`SELECT value FROM kv WHERE key = ?`, [key]);
    if (typeof row?.value !== "string") return undefined;
    return JSON.parse(row.value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.db.ready;
    // Values without a JSON form are normalized to null, like the other adapters.
    const json = JSON.stringify(value) ?? "null";
    await this.db.transaction(() =>
      this.db.run(
        `INSERT INTO kv (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, json],
      )
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.ready;
    await this.db.transaction(() => this.db.run(`DELETE FROM kv WHERE key = ?`, [key]));
  }

  async list<T>(
    selector?: ArmadaKVSelector,
    opts: ArmadaKVListOptions = {},
  ): Promise<ArmadaKVEntry<T>[]> {
    const range = resolveKvRange(selector);
    if (range.empty) return [];
    await this.db.ready;

    const conditions: string[] = [];
    const params: SqlValue[] = [];
    if (range.lower !== undefined) {
      conditions.push(`key >= ?`);
      params.push(range.lower);
    }
    if (range.upper !== undefined) {
      conditions.push(`key < ?`);
      params.push(range.upper);
    }

    // Push `limit` into SQL only when exact (see `KvRange.exact`).
    let sql = `SELECT key, value FROM kv${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}` +
      ` ORDER BY key${opts.reverse ? " DESC" : ""}`;
    if (range.exact && opts.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = await this.db.all(sql, params);
    let entries = rows.map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.value)) as T,
    }));
    // The range is a scan hint, not the contract — see `matchesKvRange`.
    if (!range.exact) {
      entries = entries.filter((entry) => matchesKvRange(entry.key, range));
      if (opts.limit !== undefined && entries.length > opts.limit) entries = entries.slice(0, opts.limit);
    }
    return entries;
  }
}

/** The first rowid belonging to a timestamp, clamped to the encodable range. */
function bucket(created_at: number): number {
  const time = Math.min(Math.max(Math.floor(created_at), 0), MAX_TIME);
  return time * SEQ_SPACE;
}

/**
 * The rowid window for `since`/`until`; inexact when a bound falls outside the
 * encodable range (then `created_at` must be re-checked).
 */
function timeRange(filter: ParsedFilter): { min?: number; max?: number; exact: boolean } {
  let exact = true;
  let min: number | undefined;
  let max: number | undefined;

  if (filter.since !== undefined) {
    if (filter.since > MAX_TIME || filter.since < 0) exact = false;
    min = bucket(filter.since);
  }

  if (filter.until !== undefined) {
    if (filter.until > MAX_TIME || filter.until < 0) exact = false;
    max = bucket(filter.until) + SEQ_SPACE - 1;
  }

  return { min, max, exact };
}

function getCoord(rumor: Pick<NostrRumor, "kind" | "pubkey" | "tags">): string {
  const d = NKinds.addressable(rumor.kind)
    ? rumor.tags.find(([name]) => name === "d")?.[1] ?? ""
    : "";
  return `${rumor.kind}:${rumor.pubkey}:${d}`;
}

/** NIP-01: newer by created_at, ties to the lexicographically smaller id. */
function isNewer(
  a: { id: string; created_at: number },
  b: { id: string; created_at: number },
): boolean {
  if (a.created_at > b.created_at) return true;
  if (a.created_at < b.created_at) return false;
  return a.id < b.id;
}

function rowRumor(row: SqlRow): NostrRumor {
  return {
    id: String(row.id),
    pubkey: String(row.pubkey),
    created_at: Number(row.created_at),
    kind: Number(row.kind),
    tags: JSON.parse(String(row.tags)) as string[][],
    content: String(row.content),
  };
}

function compareNewest(a: NostrRumor, b: NostrRumor): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Safe to embed verbatim (tokenizer can't split or fold): lowercase ASCII alphanumerics. */
const VERBATIM = /^[0-9a-z]+$/;

/**
 * Encode one part of a tag token: verbatim where possible (ids, pubkeys,
 * Armada tag names), else `_` + UTF-8 hex, unambiguous since verbatim never contains `_`.
 */
function part(value: string): string {
  if (VERBATIM.test(value)) return value;

  let hex = "_";
  for (const byte of utf8ToBytes(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

/**
 * Index token for a tag in a tenant (`t1:e:<id>`). The reserved `_p:` author
 * prefix can't be produced by a user tag (escaped names are `_` + hex; `p` isn't hex).
 */
function tagToken(prefix: string, name: string, value: string): string {
  return `${prefix}:${part(name)}:${part(value)}`;
}

/** FTS5 MATCH expression: alternatives within a group, groups ANDed; single-member groups bare. */
function matchExpr(groups: string[][]): string {
  return groups
    .map((group) => (group.length === 1 ? phrase(group[0]) : `(${group.map(phrase).join(" OR ")})`))
    .join(" AND ");
}

/** A token as an FTS5 phrase (quoted, quotes doubled) so it's never query syntax. */
function phrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Whether a rumor must be written by its own statement: supersession and
 * kind-5 deletions READ the batch so far and must not see the rest.
 */
function needsOwnStatement(rumor: NostrRumor): boolean {
  return rumor.kind === 5 || NKinds.replaceable(rumor.kind) || NKinds.addressable(rumor.kind);
}

/**
 * Parameters per staged INSERT: below SQLite's pre-3.32 default of 999 since
 * native transports are others' builds; batching gains are flat by ~100 rows.
 */
const BATCH_PARAMS = 900;

/**
 * One burst's rows staged for multi-row INSERTs, and its rowid ledger (see
 * {@link SqliteArmadaDB.reserveSeq}): staged rowids are invisible to the
 * lookup. Lives for exactly one transaction.
 */
class RumorBatch {
  private rumors: SqlValue[] = [];
  private tags: SqlValue[] = [];
  private terms: SqlValue[] = [];
  private ids = new Set<string>();
  private seqs = new Map<number, number>();

  staged(ord: number, id: string): boolean {
    return this.ids.has(`${ord}:${id}`);
  }

  lastSeq(base: number): number | undefined {
    return this.seqs.get(base);
  }

  reserve(ord: number, id: string, base: number, seq: number): void {
    this.ids.add(`${ord}:${id}`);
    this.seqs.set(base, seq);
  }

  add(seq: number, ord: number, rumor: NostrRumor, tokens: string, terms: string[]): void {
    this.rumors.push(
      seq,
      ord,
      rumor.id,
      rumor.kind,
      rumor.pubkey,
      rumor.created_at,
      JSON.stringify(rumor.tags),
      rumor.content,
    );
    this.tags.push(seq, tokens);
    for (const term of terms) {
      if (typeof term === "string" && term !== "") this.terms.push(ord, term, seq);
    }
  }

  /** The staged INSERTs, in the order they must run. */
  *statements(): Generator<[sql: string, params: SqlValue[]]> {
    // Index rows first; see `SqliteArmadaDB.writeBatch`.
    yield* rows(
      this.tags,
      2,
      (values) => `INSERT INTO rumor_tags_fts (rowid, tokens) VALUES ${values}`,
    );
    yield* rows(
      this.terms,
      3,
      (values) => `INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES ${values}`,
    );
    yield* rows(
      this.rumors,
      8,
      (values) =>
        `INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content) VALUES ${values}`,
    );
  }

  /** Drop the staged rows, keeping the ledger for the rest of the transaction. */
  clear(): void {
    this.rumors = [];
    this.tags = [];
    this.terms = [];
  }
}

/** Chunk flat parameters into multi-row INSERTs of at most {@link BATCH_PARAMS}. */
function* rows(
  params: SqlValue[],
  width: number,
  sql: (values: string) => string,
): Generator<[sql: string, params: SqlValue[]]> {
  const perStatement = Math.max(1, Math.floor(BATCH_PARAMS / width)) * width;
  for (let i = 0; i < params.length; i += perStatement) {
    const chunk = params.slice(i, i + perStatement);
    const values = new Array(chunk.length / width).fill(`(${qs(width)})`).join(", ");
    yield [sql(values), chunk];
  }
}

interface PendingWrite {
  tenant: string;
  rumor: NostrRumor;
  resolve(): void;
  reject(error: unknown): void;
}

/** A scanned row; its rowid is where the next page resumes. */
interface Candidate {
  seq: number;
  rumor: NostrRumor;
}

/** Either a full-text match over a rowid window, or a b-tree scan. */
type ScanCursor = FtsCursor | TableCursor;

/** A full-text scan (tokens, keywords, or both) bounded by time, plus row conditions. */
interface FtsCursor {
  match?: string;
  search?: string;
  min?: number;
  max?: number;
  where?: string[];
  params?: SqlValue[];
}

/** A b-tree scan: rumors with a forced index, or an index table joined to it. */
interface TableCursor {
  from: string;
  where: string[];
  params: SqlValue[];
  /**
   * Order/paging expression (default `seq`), named on the DRIVING table in
   * joins (`x.seq`) so the walk stays in its index.
   */
  key?: string;
  columns?: string;
}

interface ScanPlan {
  ids?: string[];
  /** Usually one; split when a value list exceeds one MATCH or parameter budget. */
  cursors: ScanCursor[];
  sqlOnly: boolean;
  searched: boolean;
  /**
   * The cursor already yields one row per `distinct:` group. Otherwise collapse
   * happens row by row and no limit may be pushed into SQL.
   */
  grouped?: boolean;
}
