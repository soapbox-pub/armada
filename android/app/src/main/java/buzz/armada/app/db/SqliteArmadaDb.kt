package buzz.armada.app.db

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import org.json.JSONArray
import org.json.JSONObject

/**
 * ArmadaDB's SQLite engine, in Kotlin — a port of `src/lib/db/SqliteArmadaDB.ts`,
 * which carries the full rationale. See [ArmadaDbSchema] for the layout and for
 * why the tag index is an FTS5 inverted index rather than a b-tree.
 *
 * This is the ONE implementation on Android: the notification service writes
 * through it directly, and the WebView reaches the same instance over
 * `ArmadaDbPlugin`. There is no second engine to keep in step and no format to
 * agree on — the database logic is native, and the bridge is a transport.
 *
 * One connection, one database: every tenant shares the `rumors` /
 * `rumor_tags_fts` / `rumor_coords` tables, and the KV store is a fourth.
 *
 * Two things carry the whole design:
 *
 *  - **`seq`, the rowid, encodes time** (`created_at × 2²⁰ + n`). So `ORDER BY
 *    seq DESC` is `ORDER BY created_at DESC` for the table, for every b-tree
 *    index over it, and — the point of the exercise — for FTS5, which only ever
 *    yields rows in rowid order. `since`/`until` become a rowid range that FTS5
 *    pushes down into its own backwards walk of the posting lists.
 *  - **Tags are tokens.** A filter's tag terms, and its authors when a tag is
 *    already driving, become one MATCH expression: groups of alternatives,
 *    ANDed. FTS5 merges the groups' posting lists in C, so the cost is the
 *    length of the shortest group rather than the product of them all, and one
 *    rumor is one row of the index however many of its tags matched.
 *
 * Everything the index doesn't carry — kinds, and authors without a tag — is
 * tested on the `rumors` rows it finds, which costs a column read on a row that
 * was going to be fetched anyway. Filters naming no tag and no keyword are
 * driven by a b-tree instead, chosen by strfry's priority cascade:
 *
 *   ids → tags/search → pubkey+kind → pubkey → kind → the whole tenant
 *
 * Semantics, matching the IndexedDB adapter the web build still uses:
 *
 *  - Ephemeral kinds (20000–29999) are never stored.
 *  - Replaceable (0, 3, 10000–19999) and addressable (30000–39999) rumors
 *    supersede older versions at the same (tenant, kind, pubkey, d) coordinate;
 *    a stale write is skipped. NIP-01 tie-break: on equal created_at the smaller
 *    id wins.
 *  - NIP-09 kind-5 deletion requests are applied on write (`e` by id, `a` by
 *    coordinate), only against the requester's own rumors in the same tenant;
 *    the request itself is retained.
 *  - A batch of rumors commits as ONE transaction, across all tenants.
 *
 * THREADING: every public method takes [lock] for its whole duration. The
 * transactions here are plain `BEGIN IMMEDIATE` statements and SQLite has no
 * nested ones, so a second caller interleaving statements would have its work
 * swept into — and rolled back with — someone else's transaction. The lock is
 * reentrant, so a public method may call another.
 */
class SqliteArmadaDb(
    private val db: ArmadaSqlDriver,
    /**
     * Whether to maintain the FTS5 content index that NIP-50 `search` filters
     * are resolved against. Turning it off roughly halves the cost of a write
     * and leaves `search` working but slow: keywords then post-filter an
     * ordinary indexed scan in memory, matching substrings rather than whole
     * words. Must agree with what was migrated.
     */
    private val search: Boolean = true,
    migrate: Boolean = true,
    /**
     * Which tags to index, as `[name, value]` rows — only these are queryable
     * with a `#x` filter. Unlike relay policy this is NOT limited to
     * single-letter tags: Armada's local planes query on multi-letter names
     * (`#channel`, `#stream`, `#peer`).
     */
    private val indexTags: (Rumor) -> List<List<String?>> = ::defaultIndexTags,
    /**
     * A tenant's DERIVED index terms: facts re-derivable from a stored rumor
     * that no tag of its own states, filed in `rumor_terms` and looked up as a
     * NIP-50 extension token (`{"search": "conv:<key>"}`).
     *
     * This engine never interprets a tenant id or a term — [TermPolicies] is
     * where that knowledge lives, and `src/lib/db/termPolicies.ts` is its
     * counterpart on the other side of the bridge. The two must agree exactly,
     * because a rumor filed under a term the WebView does not look up is a
     * message the service received while the app was dead and that the thread
     * then never shows.
     *
     * Bound to the TENANT rather than named at each write for that same reason:
     * the notification service writes here knowing nothing about terms, and is
     * covered anyway.
     */
    private val termsOf: (Rumor, String) -> List<String> = TermPolicies::termsOf,
    /**
     * Which revision of [termsOf] the index is built by — see
     * [TermPolicies.GENERATION]. Recorded per tenant, and a recorded generation
     * that differs makes the tenant's terms be dropped and derived again.
     */
    private val termsGeneration: Long = TermPolicies.GENERATION,
) : AutoCloseable {

    /** Memoised tenant ordinals — one lookup per tenant, not per token. */
    private val ords = HashMap<String, Int>()

    /** Tenants whose pre-existing rows are known to have been through a policy. */
    private val backfilled = HashSet<String>()

    private val lock = ReentrantLock()

    init {
        if (migrate) migrate()
    }

    /** A rumor and the tenant it belongs to, for a batched write. */
    class Write(val tenant: String, val rumor: Rumor)

    /** A count and whether it is an estimate (it never is here). */
    class Count(val count: Long, val approximate: Boolean = false)

    // ── Schema ────────────────────────────────────────────────────────────────

    /** Create the tables, indexes and triggers, if they don't already exist. */
    fun migrate() {
        lock.withLock {
            val schema = if (search) ArmadaDbSchema.BASE + ArmadaDbSchema.SEARCH else ArmadaDbSchema.BASE
            val apply = { for (statement in schema) db.run(statement.collapseWhitespace()) }

            // A file from before the content index was limited to
            // CONTENT_INDEXED_KINDS has an insert trigger without a WHEN. Swapped
            // in one transaction so no writer on another connection lands
            // between the drop and the create; what it already indexed stays
            // and leaves with its rumors.
            val insertTrigger = if (search) {
                db.query(
                    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'rumors_fts_insert'",
                ) { it.text(0) }.firstOrNull()
            } else {
                null
            }
            if (insertTrigger != null && !LEGACY_TRIGGER_WHEN.containsMatchIn(insertTrigger)) {
                transaction {
                    db.run("DROP TRIGGER rumors_fts_insert")
                    apply()
                }
            } else {
                apply()
            }

            db.run("PRAGMA user_version = ${ArmadaDbSchema.VERSION}")
        }
    }

    /** Empty every table (logout purge). Keeps the schema. */
    fun wipe() {
        lock.withLock {
            transaction {
                // The triggers empty the index tables row by row; `delete-all`
                // is FTS5's own reset, and settles any row a policy change or a
                // crash orphaned.
                db.run("DELETE FROM rumors")
                db.run("INSERT INTO rumor_tags_fts (rumor_tags_fts) VALUES ('delete-all')")
                if (search) db.run("INSERT INTO rumors_fts (rumors_fts) VALUES ('delete-all')")
                db.run("DELETE FROM rumor_coords")
                // Emptied explicitly rather than left to the trigger, for the
                // same reason as `delete-all` above: a row orphaned by a crash
                // outlives the rumor that would have taken it.
                db.run("DELETE FROM rumor_terms")
                db.run("DELETE FROM rumor_term_tenants")
                db.run("DELETE FROM tenants")
                db.run("DELETE FROM removed_rumors")
                db.run("DELETE FROM kv")
            }
            // Interned ids are reallocated from scratch after this, so a
            // remembered one would name the wrong tenant.
            ords.clear()
            backfilled.clear()
        }
    }

    override fun close() {
        lock.withLock { db.close() }
    }

    /** Every tenant that has ever been written to. */
    fun tenantIds(): List<String> = lock.withLock {
        db.query("SELECT id FROM tenants ORDER BY ord") { it.text(0) }
    }

    /** One tenant's share of [usage]. */
    data class TenantUsage(val id: String, val rumors: Long, val bytes: Long)

    /** `ArmadaDB.usage`: the same SQL as `SqliteArmadaDB.ts`, so the three engines report alike. */
    data class Usage(val tenants: List<TenantUsage>, val kvEntries: Long, val kvBytes: Long, val fileBytes: Long) {
        fun toJson(): String = JSONObject()
            .put(
                "tenants",
                JSONArray(tenants.map { JSONObject().put("id", it.id).put("rumors", it.rumors).put("bytes", it.bytes) }),
            )
            .put("kv", JSONObject().put("entries", kvEntries).put("bytes", kvBytes))
            .put("fileBytes", fileBytes)
            .toString()
    }

    fun usage(): Usage = lock.withLock {
        val tenants = db.query(
            "SELECT t.id AS id, COUNT(*) AS rumors, " +
                "SUM(length(CAST(r.content AS BLOB)) + length(CAST(r.tags AS BLOB)) + length(r.id) + length(r.pubkey)) AS bytes " +
                "FROM rumors r JOIN tenants t ON t.ord = r.tenant GROUP BY r.tenant ORDER BY t.id",
        ) { TenantUsage(it.text(0), it.long(1), it.long(2)) }
        val kv = db.query(
            "SELECT COUNT(*) AS entries, " +
                "COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0) AS bytes FROM kv",
        ) { it.long(0) to it.long(1) }.first()
        val pages = db.query("PRAGMA page_count") { it.long(0) }.first()
        val pageSize = db.query("PRAGMA page_size") { it.long(0) }.first()
        Usage(tenants, kv.first, kv.second, pages * pageSize)
    }

    // ── Write path ────────────────────────────────────────────────────────────

    /** Store one rumor. Committed when this returns. */
    fun event(tenant: String, rumor: Rumor) = write(listOf(Write(tenant, rumor)))

    /**
     * Store a batch of rumors in ONE transaction, across all tenants. Rumors of
     * ephemeral kinds are dropped rather than stored.
     */
    fun write(writes: List<Write>) {
        val storable = writes.filter { !Kinds.ephemeral(it.rumor.kind) }
        if (storable.isEmpty()) return

        lock.withLock {
            transaction {
                val batched = RumorBatch()
                for (write in storable) {
                    // A rumor that has to READ what the batch has written so far
                    // — a replaceable one superseding its coordinate, a kind 5
                    // deleting its targets — needs those rows in the table, not
                    // in an accumulator. Flushing first keeps every such rumor
                    // seeing exactly what it saw when each write was its own
                    // statement: everything before it in the batch, and nothing
                    // after.
                    if (needsOwnStatement(write.rumor)) {
                        writeBatch(batched)
                        writeRumor(write.tenant, write.rumor, batched)
                    } else {
                        stageRumor(write.tenant, write.rumor, batched)
                    }
                }
                writeBatch(batched)
            }
        }
    }

    /**
     * Stage one ordinary rumor's rows into [batch], to be written with the rest
     * of its burst — see [RumorBatch].
     *
     * Everything up to the INSERTs is what it always was, including the rowid
     * lookup, and it happens in the same order. The only difference is where the
     * rows go.
     */
    private fun stageRumor(tenant: String, rumor: Rumor, batch: RumorBatch) {
        val ord = internTenant(tenant)
        val seq = reserveSeq(ord, rumor, batch) ?: return
        batch.add(seq, ord, rumor, tagTokens("t$ord", rumor), termsOf(rumor, tenant))
    }

    /**
     * Write a staged batch: one multi-row INSERT per table, per chunk.
     *
     * This is the whole reason for staging. `rumors` carries an AFTER INSERT
     * trigger maintaining the content index, and SQLite runs a trigger's
     * sub-program per INSERT STATEMENT rather than folding it into the row loop
     * — so a row per statement paid that setup 4000 times for 4000 rumors and
     * cost 76µs a row, against 17µs for the same rows and the same trigger
     * written in batches of 200. Half the cost of a NIP-17 write was this and
     * nothing else.
     *
     * Rows are written in staging order, which is arrival order, and the three
     * tables are written back to front: a `rumors` row is what makes a rumor
     * VISIBLE, so its index rows exist by the time anything can find it — which
     * matters to nothing inside this transaction, and to a reader on another
     * connection (the WebView, against the service's writes) it is the
     * difference between a rumor with no tags and no rumor.
     */
    private fun writeBatch(batch: RumorBatch) {
        for ((sql, params) in batch.statements()) db.run(sql, params)
        batch.clear()
    }

    /** Apply a single rumor's writes. Runs inside the batch transaction. */
    private fun writeRumor(tenant: String, rumor: Rumor, batch: RumorBatch) {
        val ord = internTenant(tenant)
        val prefix = "t$ord"
        val terms = termsOf(rumor, tenant)

        // Before anything below can supersede or delete on a removed rumor's behalf.
        val removed = db.query("SELECT 1 FROM removed_rumors WHERE id = ?", listOf(rumor.id)) { true }
        if (removed.isNotEmpty()) return

        if (Kinds.replaceable(rumor.kind) || Kinds.addressable(rumor.kind)) {
            val coord = coordOf(rumor)

            val existing = db.query(
                "SELECT id, seq, created_at FROM rumor_coords WHERE tenant = ? AND coord = ?",
                listOf(ord, coord),
            ) { Stored(it.text(0), it.long(1), it.long(2)) }.firstOrNull()

            if (existing != null) {
                // Per NIP-01 the stored version wins ties, and an identical id
                // is a no-op, so only a strictly newer rumor replaces it.
                if (!isNewer(rumor.id, rumor.createdAt, existing.id, existing.createdAt)) return
                deleteRumors(ord, listOf(existing.seq))
            }

            val seq = insertRumor(ord, prefix, rumor, terms, batch) ?: return

            db.run(
                """INSERT OR REPLACE INTO rumor_coords (tenant, coord, id, seq, created_at)
                    VALUES (?, ?, ?, ?, ?)""".collapseWhitespace(),
                listOf(ord, coord, rumor.id, seq, rumor.createdAt),
            )
        } else {
            insertRumor(ord, prefix, rumor, terms, batch) ?: return
        }

        // Applied after the insert so a kind 5 arriving alongside its targets in
        // one batch still resolves. The request itself is retained.
        if (rumor.kind == 5) applyDeletion(ord, rumor)
    }

    /**
     * Write ONE rumor's row and index rows immediately, returning the rowid
     * taken — or null if it was already stored.
     *
     * The path for a rumor that can't be staged into its burst's batch (see
     * [needsOwnStatement]), which is every replaceable, addressable or deletion
     * rumor and nothing else. Those are a small minority of a sync and each has
     * to see the rows before it, so they keep the row-per-statement shape.
     *
     * Folding the rowid lookup into the INSERT with `RETURNING` would make this
     * one statement rather than two, and measured 2.7× SLOWER: an INSERT that
     * returns rows gives up SQLite's fast path and pays a result set per write,
     * which costs far more than the extra round trip saves.
     */
    private fun insertRumor(
        ord: Int,
        prefix: String,
        rumor: Rumor,
        terms: List<String>,
        batch: RumorBatch,
    ): Long? {
        val seq = reserveSeq(ord, rumor, batch) ?: return null

        db.run(
            """INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""".collapseWhitespace(),
            listOf(seq, ord, rumor.id, rumor.kind, rumor.pubkey, rumor.createdAt, rumor.tagsJson(), rumor.content),
        )

        // The content index is written by a trigger, so this is the only index
        // the write path maintains itself — one row, however many tags the rumor
        // has.
        db.run(
            "INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)",
            listOf(seq, tagTokens(prefix, rumor)),
        )

        insertTerms(ord, seq, terms)

        return seq
    }

    /**
     * The rowid this rumor takes, or null if it is already stored — which makes
     * a re-delivery a no-op.
     *
     * Everything the write needs to know first — whether this rumor is here, and
     * which rowid is free at its timestamp — is one statement, since each is a
     * scalar subquery over an index and neither depends on the other. The rowid
     * is allocated by LOOKING rather than from a counter held across writes, so
     * a second writer on the same file (the WebView, against this service) can't
     * be handed the same one; the bucket spans tenants, since the rowid is
     * global.
     *
     * [batch] is what keeps that true while a burst's rows are written
     * together: rowids reserved but not yet inserted are invisible to the
     * lookup, so two rumors sharing a `created_at` in one burst would both be
     * handed the same one. It is consulted for exactly as long as the
     * transaction that reserved them, and the transaction is what excludes the
     * other writer — `BEGIN IMMEDIATE` takes the write lock before the first of
     * these reads, so nothing can land between reserving a rowid and using it.
     */
    private fun reserveSeq(ord: Int, rumor: Rumor, batch: RumorBatch): Long? {
        val base = bucket(rumor.createdAt)

        // The same id twice in one burst is one rumor, and the second copy would
        // otherwise reserve a rowid and collide on the unique index.
        if (batch.staged(ord, rumor.id)) return null

        // A removed id (see [forget]) answers like a stored one, in the same lookup.
        val row = db.query(
            """SELECT (SELECT seq FROM rumors WHERE tenant = ? AND id = ?) AS existing,
                (SELECT 1 FROM removed_rumors WHERE id = ?) AS removed,
                (SELECT MAX(seq) FROM rumors WHERE seq >= ? AND seq < ?) AS last""".collapseWhitespace(),
            listOf(ord, rumor.id, rumor.id, base, base + SEQ_SPACE),
        ) { Triple(it.longOrNull(0), it.longOrNull(1), it.longOrNull(2)) }.firstOrNull()

        // Already stored: a re-delivered rumor is a no-op.
        if (row?.first != null) return null
        if (row?.second != null) return null

        val stored = row?.third
        val seq = maxOf(stored ?: (base - 1), batch.lastSeq(base) ?: (base - 1)) + 1

        // One second may hold 2²⁰ rumors. Anything that manages more of them at
        // the same timestamp has outgrown this encoding, and silently reordering
        // them — or spilling into the next second's rowids — would be worse than
        // saying so.
        check(seq < base + SEQ_SPACE) {
            "ArmadaDB: too many rumors at created_at ${rumor.createdAt}"
        }

        batch.reserve(ord, rumor.id, base, seq)
        return seq
    }

    /**
     * File a rumor's derived terms, in ONE statement however many there are.
     *
     * `OR IGNORE` because a policy may return the same term twice, and because
     * the backfill runs over rows a live write may already have indexed.
     *
     * A row per statement was the obvious shape and the wrong one: a NIP-17
     * message is filed under three terms, so the term index alone tripled the
     * statements a write costs. The text varies with the count, which is exactly
     * what a driver's statement cache is for — a policy emits the same handful
     * of counts forever, so this is a few cached shapes, not one per write.
     */
    private fun insertTerms(ord: Int, seq: Long, terms: List<String>) {
        val usable = terms.filter { it.isNotEmpty() }
        if (usable.isEmpty()) return

        val params = ArrayList<Any?>(usable.size * 3)
        for (term in usable) {
            params.add(ord)
            params.add(term)
            params.add(seq)
        }

        db.run(
            "INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES " +
                usable.joinToString(", ") { "(?, ?, ?)" },
            params,
        )
    }

    /**
     * Derive and store the terms of every rumor already in `tenant`, once per
     * generation of its policy.
     *
     * A term can't be computed in SQL — the policy is Kotlin here and
     * TypeScript on the other side of the bridge — so a schema migration can't
     * build this index the way it can rebuild a column. It is filled by walking
     * the tenant instead, newest-first in pages, and the generation that walked
     * it is recorded in `rumor_term_tenants` so the pass happens once per file
     * rather than once per launch.
     *
     * A RECORDED generation that differs from [termsGeneration] means the index
     * holds terms some earlier derivation produced. Those are dropped first: the
     * walk only inserts, so a term the policy no longer derives would otherwise
     * survive every rebuild and stay matchable forever.
     *
     * Writes made while it runs are not a hazard: they go through the same
     * policy, and every insert is `OR IGNORE`. The WebView's engine racing the
     * same rebuild on the same file is likewise benign, if briefly untidy —
     * both delete what both are about to re-derive, and the loser's inserts
     * land anyway.
     *
     * At most one attempt per tenant per process, whatever the outcome — which
     * is what [backfilled] records, and it is marked BEFORE the walk rather than
     * after it. A failure (an unreadable row, a disk error) leaves the tenant's
     * index partly built and its generation unrecorded, so the next launch tries
     * again; retrying inside this one would put a full tenant walk in front of
     * every term read for as long as the store stays broken. The failure is
     * swallowed for the same reason the TypeScript engine swallows it: the read
     * that triggered the pass is answerable from the index as it stands, and
     * failing it instead would take every DM read down with one bad row.
     */
    private fun backfillTerms(tenant: String) {
        if (tenant in backfilled) return
        backfilled.add(tenant)
        try {
            walkTerms(tenant)
        } catch (_: Exception) {
            // Partly built, generation unrecorded: the next launch walks it again.
        }
    }

    /** [backfillTerms]'s walk, without its once-per-process bookkeeping. */
    private fun walkTerms(tenant: String) {
        val ord = tenantOrd(tenant)
        if (ord == null) {
            // Never written to, so nothing to index — and no ordinal to record
            // the fact against. The next launch asks again, which costs one
            // lookup; rows written in the meantime carry their terms already,
            // since the write path derives them.
            return
        }

        val done = db.query(
            "SELECT generation FROM rumor_term_tenants WHERE tenant = ?",
            listOf(ord),
        ) { it.long(0) }.firstOrNull()

        if (done == termsGeneration) return
        if (done != null) {
            transaction {
                db.run("DELETE FROM rumor_terms WHERE tenant = ?", listOf(ord))
            }
        }

        var before: Long? = null

        while (true) {
            val sql = if (before == null) {
                """SELECT seq, $RUMOR_COLUMNS FROM rumors INDEXED BY rumors_tenant
                    WHERE tenant = ? ORDER BY seq DESC LIMIT ?"""
            } else {
                """SELECT seq, $RUMOR_COLUMNS FROM rumors INDEXED BY rumors_tenant
                    WHERE tenant = ? AND seq < ? ORDER BY seq DESC LIMIT ?"""
            }
            val params = if (before == null) {
                listOf<Any?>(ord, BACKFILL_PAGE)
            } else {
                listOf<Any?>(ord, before, BACKFILL_PAGE)
            }

            val page = db.query(sql.collapseWhitespace(), params) {
                Pair(it.long(0), rumorFromRow(it, 1))
            }
            if (page.isEmpty()) break

            transaction {
                for ((seq, rumor) in page) insertTerms(ord, seq, termsOf(rumor, tenant))
            }

            before = page.last().first
            if (page.size < BACKFILL_PAGE) break
        }

        transaction {
            db.run(
                "INSERT OR REPLACE INTO rumor_term_tenants (tenant, generation) VALUES (?, ?)",
                listOf(ord, termsGeneration),
            )
        }
    }

    /**
     * Make sure `tenant`'s term index is complete, if a read is about to depend
     * on it.
     *
     * Only reads that reach the term index wait. An ordinary read is unaffected
     * by a half-built one, and putting a full pass over the tenant in front of
     * it would charge every caller for a migration none of them asked about.
     *
     * The test is whether a filter carries a `search` AT ALL, not whether it
     * parsed to a term — the same test `SqliteArmadaDB.ts` makes, and it has to
     * be, because `distinct:<namespace>` reads `rumor_terms` while parsing to no
     * term of its own (it is a directive; see [ParsedFilter.distinct]). Gating on
     * [ParsedFilter.terms] left the NIP-17 conversation list — the one read that
     * is nothing BUT a collapse — grouping over an index no one had built, so it
     * listed only conversations written since the upgrade.
     */
    private fun awaitTerms(tenant: String, filters: List<ParsedFilter>) {
        if (filters.none { it.search != null }) return
        backfillTerms(tenant)
    }

    /**
     * A rumor's index terms as a single space-separated token string: its
     * indexed tags, plus `<prefix>:_p:<pubkey>` so an author constraint can be
     * merged into the same MATCH as the tags.
     *
     * The *kind* deliberately gets no token: there are only a handful of kinds
     * in use, so `_k:1` would be a posting list covering a large share of the
     * store, and intersecting one of those costs more than testing `kind` on the
     * rows the tag already found.
     */
    private fun tagTokens(prefix: String, rumor: Rumor): String {
        val tokens = LinkedHashSet<String>()
        tokens.add("$prefix:_p:${part(rumor.pubkey)}")

        for (row in indexTags(rumor)) {
            val name = row.getOrNull(0) ?: continue
            val value = row.getOrNull(1) ?: continue
            tokens.add(tagToken(prefix, name, value))
        }

        return tokens.joinToString(" ")
    }

    /**
     * The integer a tenant's tokens name it by, or null if the tenant has never
     * been written to — in which case it holds no rumors, and so no tokens
     * either.
     *
     * Interned rather than derived from the id, so distinct tenants can't share
     * a prefix. A hash could: truncated, by birthday over ids that are partly
     * attacker-chosen (`c2:<community id>`), and sharing a prefix means sharing
     * posting lists, which is a cross-tenant read.
     */
    private fun tenantOrd(tenant: String): Int? {
        ords[tenant]?.let { return it }

        val ord = db.query("SELECT ord FROM tenants WHERE id = ?", listOf(tenant)) {
            it.long(0).toInt()
        }.firstOrNull() ?: return null

        ords[tenant] = ord
        return ord
    }

    /** The same, allocating one for a tenant being written to for the first time. */
    private fun internTenant(tenant: String): Int {
        tenantOrd(tenant)?.let { return it }

        db.run("INSERT OR IGNORE INTO tenants (id) VALUES (?)", listOf(tenant))

        val ord = db.query("SELECT ord FROM tenants WHERE id = ?", listOf(tenant)) {
            it.long(0).toInt()
        }.first()
        ords[tenant] = ord
        return ord
    }

    /**
     * NIP-09: delete the rumors a kind 5 request targets, within its tenant.
     *
     * A request can only delete its author's own rumors, so every target is
     * checked against the request's `pubkey`. `a` tags additionally only delete
     * versions at or before the request's `created_at`, so a newer replacement
     * survives.
     */
    private fun applyDeletion(ord: Int, request: Rumor) {
        val seqs = LinkedHashSet<Long>()

        // A request can't delete itself, and a kind 5 occupies no coordinate, so
        // dropping its own id from the `e` targets is the whole of that rule.
        val eTags = request.tags.mapNotNull { row ->
            val name = row.getOrNull(0)
            val value = row.getOrNull(1)
            if (name == "e" && !value.isNullOrEmpty() && value != request.id) value else null
        }
        val aTags = request.tags.mapNotNull { row ->
            val name = row.getOrNull(0)
            val value = row.getOrNull(1)
            if (name == "a" && !value.isNullOrEmpty()) value else null
        }
        if (eTags.isEmpty() && aTags.isEmpty()) return

        for (chunk in Sql.batch(eTags, MAX_PARAMS - 2)) {
            val rows = db.query(
                "SELECT seq FROM rumors WHERE tenant = ? AND ${Sql.memberOf("id", chunk)} AND pubkey = ?",
                listOf(ord) + chunk + listOf(request.pubkey),
            ) { it.long(0) }
            seqs.addAll(rows)
        }

        // Only one version of a coordinate is ever stored, so an `a` tag
        // resolves to at most one rumor via a primary-key lookup.
        val owned = aTags.filter { it.split(":").getOrNull(1) == request.pubkey }

        for (chunk in Sql.batch(owned, MAX_PARAMS - 2)) {
            val rows = db.query(
                """SELECT seq FROM rumor_coords
                    WHERE tenant = ? AND ${Sql.memberOf("coord", chunk)} AND created_at <= ?"""
                    .collapseWhitespace(),
                listOf(ord) + chunk + listOf(request.createdAt),
            ) { it.long(0) }
            seqs.addAll(rows)
        }

        deleteRumors(ord, seqs.toList())
    }

    /**
     * Delete rumors by rowid, along with any coordinate they occupy. Their index
     * rows go with them, dropped by the triggers — one statement, however many
     * tags the rumor had.
     *
     * Coordinates are removed by their primary key, recomputed from the stored
     * rumor, so the coordinate table needs no secondary index on `seq`.
     */
    private fun deleteRumors(ord: Int, seqs: List<Long>) {
        if (seqs.isEmpty()) return

        for (chunk in Sql.batch(seqs, MAX_PARAMS - 1)) {
            val rows = db.query(
                "SELECT kind, pubkey, tags FROM rumors WHERE ${Sql.memberOf("seq", chunk)}",
                chunk,
            ) { Triple(it.long(0).toInt(), it.text(1), it.text(2)) }

            // Only a coordinate-bearing rumor needs its tags parsed, to find
            // the `d` tag its coordinate is built from.
            val coords = rows
                .filter { Kinds.replaceable(it.first) || Kinds.addressable(it.first) }
                .map { (kind, pubkey, tagsJson) -> coordOf(kind, pubkey, tagsJson) }

            for (coordChunk in Sql.batch(coords, MAX_PARAMS - 1)) {
                db.run(
                    "DELETE FROM rumor_coords WHERE tenant = ? AND ${Sql.memberOf("coord", coordChunk)}",
                    listOf(ord) + coordChunk,
                )
            }

            db.run("DELETE FROM rumors WHERE ${Sql.memberOf("seq", chunk)}", chunk)
        }
    }

    // ── Read path ─────────────────────────────────────────────────────────────

    /**
     * Rumors in [tenant] matching the filters (OR'd together), newest-first,
     * de-duplicated by id, each filter's `limit` respected.
     */
    fun query(tenant: String, filters: List<JSONObject>): List<Rumor> = lock.withLock {
        val parsed = filters.map { ParsedFilter(it) }
        awaitTerms(tenant, parsed)

        // A tenant that was never written to holds nothing, whatever the
        // filters.
        val ord = tenantOrd(tenant) ?: return@withLock emptyList()
        val prefix = "t$ord"

        val byId = LinkedHashMap<String, Rumor>()

        for (filter in parsed) {
            for (rumor in queryFilter(ord, prefix, tenant, filter)) {
                byId[rumor.id] = rumor
            }
        }

        byId.values.sortedWith(NEWEST_FIRST)
    }

    /** Run a single parsed filter through the planner. */
    private fun queryFilter(
        ord: Int,
        prefix: String,
        tenant: String,
        filter: ParsedFilter,
    ): List<Rumor> {
        if (filter.neverMatch) return emptyList()

        val limit = filter.limit ?: Int.MAX_VALUE
        if (limit <= 0) return emptyList()

        val plan = planScan(ord, prefix, filter)

        // ids plans are lookups by key, not scans.
        plan.ids?.let { return queryIds(ord, it, filter, limit) }

        // A collapse the index couldn't group is applied here instead: the rows
        // come back in order and the first of each group survives. `limit` still
        // means groups, so a page that collapses to fewer rows is followed by
        // another rather than silently answering short.
        val collapse = filter.distinct != null && !plan.grouped

        // A cursor yields only rows its conditions kept, and the limit is
        // applied after them, so a single complete plan IS the answer: run it
        // once and read the rumor bodies straight out of it.
        if (!collapse && plan.cursors.size == 1 && plan.sqlOnly) {
            val rows = readPage(
                plan.cursors[0],
                before = null,
                limit = if (limit == Int.MAX_VALUE) null else limit,
                keys = false,
            )
            return rows.map { it.rumor }.sortedWith(NEWEST_FIRST)
        }

        val collected = ArrayList<Rumor>()
        val seen = HashSet<String>()
        /** Groups already represented, when collapsing. */
        val groups = HashSet<String>()

        // A complete plan yields only matches, so a page need be no larger than
        // what's still wanted; an incomplete one pages in chunks so a filter
        // that matches little doesn't materialize the whole range. A collapsing
        // one cannot size its page from the limit at all: how many rows a group
        // costs isn't known until they are read.
        var pageSize = if (plan.sqlOnly && !collapse) minOf(limit, MAX_PAGE) else CHUNK_SIZE
        var before: Long? = null

        while (collected.size < limit) {
            val page = scanPage(plan, before, pageSize)
            if (page.isEmpty()) break

            before = page.last().seq

            for (candidate in page) {
                if (collected.size >= limit) break
                if (!seen.add(candidate.rumor.id)) continue
                if (!(plan.sqlOnly || filter.matches(candidate.rumor, plan.searched))) continue

                if (collapse) {
                    // A rumor with no term in the namespace belongs to no group
                    // and is excluded — the same "no term, no match" a term
                    // lookup gives.
                    val key = filter.collapseKey(termsOf(candidate.rumor, tenant))
                    if (key == null || !groups.add(key)) continue
                }

                collected.add(candidate.rumor)
            }

            // A short page means the scan is exhausted.
            if (page.size < pageSize) break

            // Still short of the limit after a full page, so the conditions are
            // rejecting more than they're keeping. Widening geometrically bounds
            // the number of round trips a very selective filter costs.
            pageSize = minOf(pageSize * 4, MAX_PAGE)
        }

        return collected.sortedWith(NEWEST_FIRST)
    }

    /** Fetch rumors by id, applying whatever else the filter asks for. */
    private fun queryIds(
        ord: Int,
        ids: List<String>,
        filter: ParsedFilter,
        limit: Int,
    ): List<Rumor> {
        val rumors = ArrayList<Rumor>()

        for (chunk in Sql.batch(ids, MAX_PARAMS - 16)) {
            val conditions = arrayListOf("tenant = ?", Sql.memberOf("id", chunk))
            val params = ArrayList<Any?>()
            params.add(ord)
            params.addAll(chunk)

            filter.since?.let {
                conditions.add("created_at >= ?")
                params.add(it)
            }
            filter.until?.let {
                conditions.add("created_at <= ?")
                params.add(it)
            }
            filter.kinds?.takeIf { it.size <= MAX_PUSHDOWN }?.let {
                conditions.add(Sql.memberOf("kind", it))
                params.addAll(it)
            }
            filter.authors?.takeIf { it.size <= MAX_PUSHDOWN }?.let {
                conditions.add(Sql.memberOf("pubkey", it))
                params.addAll(it)
            }

            val rows = db.query("SELECT $RUMOR_COLUMNS FROM rumors${Sql.where(conditions)}", params) {
                rumorFromRow(it, 0)
            }
            for (rumor in rows) {
                // The SQL already applied the ids byte-exactly; see `matches`.
                if (filter.matches(rumor, skipSearch = false, skipIds = true)) rumors.add(rumor)
            }
        }

        val sorted = rumors.sortedWith(NEWEST_FIRST)
        return if (sorted.size > limit) sorted.take(limit) else sorted
    }

    /** Read one page of rumors, newest-first, merging the plan's cursors. */
    private fun scanPage(plan: ScanPlan, before: Long?, pageSize: Int): List<Candidate> {
        if (plan.cursors.size == 1) return readPage(plan.cursors[0], before, pageSize)

        val merged = ArrayList<Candidate>()
        for (cursor in plan.cursors) merged.addAll(readPage(cursor, before, pageSize))

        merged.sortByDescending { it.seq }
        return merged.take(pageSize)
    }

    /**
     * Read one cursor's next rows, newest-first.
     *
     * Both kinds of cursor are read the same way, and the shape is the point:
     * conditions first, `LIMIT` last. A full-text cursor joins the rows its
     * index found to the rumors table and tests what the index couldn't carry
     * THERE, before the limit — so SQLite walks the posting lists backwards and
     * stops as soon as `limit` rows have survived everything.
     *
     * `CROSS JOIN` is load-bearing, and is the whole reason that works. It is
     * SQLite's one way to fix a join order, and without it a condition on the
     * rumors table is enough to make the planner drive from THERE instead —
     * seeking the index by rowid once per row, which re-evaluates the MATCH
     * every time, and then sorting the result through a temp b-tree. Measured on
     * a 20k store that is 462ms against 0.16ms.
     */
    private fun readPage(
        cursor: ScanCursor,
        before: Long?,
        limit: Int?,
        keys: Boolean = true,
    ): List<Candidate> {
        val params = ArrayList<Any?>()

        val sql = when (cursor) {
            is FtsCursor -> {
                val scan = ftsScan(cursor, before)
                params.addAll(scan.params)
                params.addAll(cursor.params)

                """SELECT ${if (keys) "r.seq, " else ""}$R_RUMOR_COLUMNS FROM ${scan.driver}
                    CROSS JOIN rumors r ON r.seq = ${scan.driver}.rowid${
                    Sql.where(scan.conditions + cursor.where)
                } ORDER BY ${scan.driver}.rowid DESC${if (limit == null) "" else " LIMIT ?"}"""
            }

            is TableCursor -> {
                val conditions = ArrayList(cursor.where)
                params.addAll(cursor.params)
                // A scan of the rumors table alone is ordered and paged by its
                // own rowid; a scan driven by an index table beside it
                // (`rumor_terms`) is ordered by the copy of that rowid in the
                // driver, so the walk belongs to the index and not to a sort of
                // what it found.
                val key = cursor.key

                if (before != null) {
                    conditions.add("$key < ?")
                    params.add(before)
                }

                // The key is only read when a later page has to resume from it;
                // a scan that answers the whole query in one go leaves the
                // column out.
                """SELECT ${if (keys) "$key AS seq, " else ""}${cursor.columns} FROM ${cursor.from}${
                    Sql.where(conditions)
                } ORDER BY $key DESC${if (limit == null) "" else " LIMIT ?"}"""
            }
        }

        if (limit != null) params.add(limit)

        return db.query(sql.collapseWhitespace(), params) { row ->
            val seq = if (keys) row.long(0) else 0L
            Candidate(seq, rumorFromRow(row, if (keys) 1 else 0))
        }
    }

    /**
     * Reassemble a rumor from a row's [RUMOR_COLUMNS], starting at [offset].
     *
     * Throwing rather than skipping. A page whose size the caller reads as
     * "the scan is exhausted" must not shrink for any reason other than the
     * scan being exhausted: silently dropping a row would end the walk early
     * and return a short answer as if it were complete. Every row here was
     * written by `insertRumor` from a parsed rumor, so an unparseable one is a
     * corrupt store, and saying so beats quietly serving part of it.
     */
    private fun rumorFromRow(row: SqlRow, offset: Int): Rumor = Rumor.fromRow(
        id = row.text(offset),
        kind = row.long(offset + 1).toInt(),
        pubkey = row.text(offset + 2),
        createdAt = row.long(offset + 3),
        tagsJson = row.text(offset + 4),
        content = row.text(offset + 5),
    ) ?: error("ArmadaDB: unparseable rumor row")

    /**
     * The index scan behind a full-text cursor: which table drives it, and the
     * conditions that bound it.
     *
     * Tokens drive whenever there are tokens, since the token index also carries
     * the tenant, the time window and the ordering; a keyword-only filter drives
     * the content index the same way. Keywords *alongside* tokens are a second
     * index to intersect with, which FTS5 can't do across tables, so they are
     * resolved to a set the driving scan tests against.
     */
    private fun ftsScan(cursor: FtsCursor, before: Long?): FtsScan {
        val driver = if (cursor.match != null) "rumor_tags_fts" else "rumors_fts"
        val conditions = arrayListOf("$driver MATCH ?")
        val params = ArrayList<Any?>()
        params.add(cursor.match ?: cursor.search!!)

        if (cursor.match != null && cursor.search != null) {
            // The `+` is load-bearing. Without it SQLite hands the rowid list to
            // the *token* index as a constraint, which turns one descending scan
            // into one scan per keyword match; with it, the list stays an
            // ordinary filter over a single scan, and SQLite builds a bloom
            // filter for it.
            conditions.add("+$driver.rowid IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)")
            params.add(cursor.search)
        }

        // Bounded on the driver's own rowid, not on the joined `r.seq`: the
        // point is for FTS5 to receive the range and stop its walk, rather than
        // for the rows to be discarded after it has walked them all.
        cursor.min?.let {
            conditions.add("$driver.rowid >= ?")
            params.add(it)
        }

        // The paging bound and the filter's `until` are the same kind of
        // constraint, so whichever is tighter is the one that's applied.
        val max = if (before != null) before - 1 else cursor.max
        max?.let {
            conditions.add("$driver.rowid <= ?")
            params.add(it)
        }

        return FtsScan(driver, conditions, params)
    }

    /**
     * The query planner.
     *
     * A filter that names a tag or a keyword is driven by the index, which finds
     * its rows newest-first and lets the rumors table test what's left. Anything
     * else is driven by a b-tree, chosen by strfry's priority cascade — every one
     * of those indexes leads with `tenant` and is ordered by time already, so
     * each is read newest-first, within one namespace, with no sorter.
     */
    private fun planScan(ord: Int, prefix: String, filter: ParsedFilter): ScanPlan {
        val time = timeRange(filter)

        // 0. a collapse — one rumor per term in a namespace. Grouped in the
        //    index when nothing outside it has to be tested; otherwise the
        //    filter is planned as usual and collapsed as the rows come back
        //    (see [queryFilter]), which is the only shape that can honour a row
        //    condition BEFORE the collapse.
        if (filter.distinct != null) {
            planDistinct(ord, filter, time)?.let { return it }
        }

        // 1. derived terms — ahead of everything else, including ids, because
        //    nothing else can apply them: they are not in the rumor, so a plan
        //    that didn't resolve them in the index has no way to check them
        //    afterwards.
        if (filter.terms.isNotEmpty()) return planTerms(ord, filter, time)

        // 2. ids — the (tenant, id) unique index.
        filter.ids?.let { return ScanPlan(ids = it, cursors = emptyList(), sqlOnly = false, searched = false) }

        // Without the content index there is nothing to resolve keywords
        // against, so they fall through to the in-memory match instead.
        val search = if (this.search) filter.searchQuery else null

        // 3. tags, or a NIP-50 search: the index drives.
        if (filter.tags.isNotEmpty() || search != null) {
            planFts(ord, prefix, filter, search, time)?.let { return it }
        }

        /** Append the filter's time bounds to a rumors-table cursor. */
        fun addTime(conditions: MutableList<String>, params: MutableList<Any?>) {
            // The rowid bound is what stops the scan early; the `created_at`
            // test is what makes it exact, for the timestamps the encoding has
            // to clamp.
            time.min?.let {
                conditions.add("seq >= ?")
                params.add(it)
            }
            time.max?.let {
                conditions.add("seq <= ?")
                params.add(it)
            }
            filter.since?.let {
                conditions.add("created_at >= ?")
                params.add(it)
            }
            filter.until?.let {
                conditions.add("created_at <= ?")
                params.add(it)
            }
        }

        val searched = filter.searchKeywords == null
        val kinds = filter.kinds
        val authors = filter.authors
        val pushKinds = kinds == null || kinds.size <= MAX_PUSHDOWN

        // 4. authors + kinds, from the composite index. The seeks land in an
        //    index whose entries are (tenant, pubkey, kind, time) in that order,
        //    so each walks straight to the newest rumors of a combination and
        //    stops.
        if (authors != null && kinds != null && pushKinds) {
            val cursors = Sql.batch(authors, MAX_IN).map { chunk ->
                val conditions = arrayListOf(
                    "tenant = ?",
                    Sql.memberOf("pubkey", chunk),
                    Sql.memberOf("kind", kinds),
                )
                val params = ArrayList<Any?>()
                params.add(ord)
                params.addAll(chunk)
                params.addAll(kinds)
                addTime(conditions, params)
                TableCursor("rumors INDEXED BY rumors_pubkey_kind", conditions, params)
            }
            return ScanPlan(null, cursors, sqlOnly = searched, searched = searched)
        }

        // 5. authors alone, with kinds filtering the scan when there are few
        //    enough of them to be worth binding.
        if (authors != null) {
            val cursors = Sql.batch(authors, MAX_IN).map { chunk ->
                val conditions = arrayListOf("tenant = ?", Sql.memberOf("pubkey", chunk))
                val params = ArrayList<Any?>()
                params.add(ord)
                params.addAll(chunk)
                addTime(conditions, params)

                if (kinds != null && pushKinds) {
                    conditions.add(Sql.memberOf("kind", kinds))
                    params.addAll(kinds)
                }

                TableCursor("rumors INDEXED BY rumors_pubkey", conditions, params)
            }
            return ScanPlan(null, cursors, sqlOnly = searched && pushKinds, searched = searched)
        }

        // 6. kinds.
        if (kinds != null) {
            val cursors = Sql.batch(kinds, MAX_IN).map { chunk ->
                val conditions = arrayListOf("tenant = ?", Sql.memberOf("kind", chunk))
                val params = ArrayList<Any?>()
                params.add(ord)
                params.addAll(chunk)
                addTime(conditions, params)
                TableCursor("rumors INDEXED BY rumors_kind", conditions, params)
            }
            return ScanPlan(null, cursors, sqlOnly = searched, searched = searched)
        }

        // 7. fallback — the whole tenant, newest-first. `(tenant)` is `(tenant,
        //    seq)`, so this is a backwards walk of one contiguous index range.
        val conditions = arrayListOf("tenant = ?")
        val params = ArrayList<Any?>()
        params.add(ord)
        addTime(conditions, params)

        return ScanPlan(
            null,
            listOf(TableCursor("rumors INDEXED BY rumors_tenant", conditions, params)),
            sqlOnly = searched,
            searched = searched,
        )
    }

    /**
     * Plan a `distinct:<namespace>` collapse in the INDEX: one row per term in
     * the namespace, each the newest under it.
     *
     * This is the plan the conversation list exists for. `rumor_terms` is keyed
     * `(tenant, term, seq)`, so a namespace is one contiguous range and
     * `GROUP BY term` is an ordered walk of it — no temp b-tree to group, and
     * `MAX(seq)` is the last row of each block. What comes out is at most one
     * `seq` per group, so the sorter that orders them by recency sorts
     * CONVERSATIONS rather than messages, and the join reads exactly one rumor
     * body per row returned.
     *
     * Returns null — leaving the caller to plan the filter as usual and collapse
     * the rows afterwards — when anything outside the term index has to be
     * tested. Row conditions apply BEFORE the collapse, and testing `kind` or
     * `pubkey` inside the grouping would mean a rowid lookup and a whole row read
     * per index row, which is precisely the cost this plan exists to avoid. Extra
     * TERMS are the exception: they live in the same table, so they stay
     * index-only as an `EXISTS`.
     */
    private fun planDistinct(ord: Int, filter: ParsedFilter, time: TimeRange): ScanPlan? {
        val range = TermRange.of(filter.distinct!!) ?: return null

        // Anything a row carries has to narrow the candidates, not the
        // survivors, so it cannot be applied after the grouping — and applying
        // it inside means reading the rows. A time bound the rowid encoding had
        // to clamp counts as one of those, since only `created_at` can settle it.
        if (
            filter.ids != null || filter.kinds != null || filter.authors != null ||
            filter.tags.isNotEmpty() || filter.searchKeywords != null ||
            (!time.exact && (filter.since != null || filter.until != null))
        ) {
            return null
        }

        val conditions = arrayListOf("x.tenant = ?", "x.term >= ?")
        val params = ArrayList<Any?>()
        params.add(ord)
        params.add(range.lower)

        range.upper?.let {
            conditions.add("x.term < ?")
            params.add(it)
        }
        time.min?.let {
            conditions.add("x.seq >= ?")
            params.add(it)
        }
        time.max?.let {
            conditions.add("x.seq <= ?")
            params.add(it)
        }
        for (term in filter.terms) {
            conditions.add(
                "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)",
            )
            params.add(term)
        }

        val grouped = "(SELECT MAX(x.seq) AS seq FROM rumor_terms x${Sql.where(conditions)} GROUP BY x.term)"

        return ScanPlan(
            null,
            listOf(
                TableCursor(
                    from = "$grouped g CROSS JOIN rumors r ON r.seq = g.seq",
                    where = emptyList(),
                    params = params,
                    key = "g.seq",
                    columns = R_RUMOR_COLUMNS,
                ),
            ),
            sqlOnly = true,
            searched = true,
            grouped = true,
        )
    }

    /**
     * Plan a filter that names derived terms: `rumor_terms` drives, and
     * everything else is tested on the rows it finds.
     *
     * One term is a seek to `(tenant, term)` and a backwards walk of the `seq`
     * range under it — already time-ordered, so the walk stops at the limit with
     * no sorter and no bodies read past it. Further terms are `EXISTS` against
     * the same table, which is a point lookup per candidate rather than a second
     * scan to intersect.
     *
     * The `CROSS JOIN` fixes the join order for the reason it does in
     * [readPage]: the rumors table must be the INNER side, seeked by rowid, or a
     * condition on one of its columns is enough to make the planner drive from
     * there and sort the result afterwards.
     */
    private fun planTerms(ord: Int, filter: ParsedFilter, time: TimeRange): ScanPlan {
        val conditions = arrayListOf("x.tenant = ?", "x.term = ?")
        val params = ArrayList<Any?>()
        params.add(ord)
        params.add(filter.terms.first())

        time.min?.let {
            conditions.add("x.seq >= ?")
            params.add(it)
        }
        time.max?.let {
            conditions.add("x.seq <= ?")
            params.add(it)
        }

        for (term in filter.terms.drop(1)) {
            conditions.add(
                "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)",
            )
            params.add(term)
        }

        var complete = true

        // ids are pushed down here rather than taking the ids plan: that plan
        // can't apply a term, and this one can apply an id.
        filter.ids?.let { ids ->
            if (ids.size <= MAX_PUSHDOWN) {
                conditions.add(Sql.memberOf("r.id", ids))
                params.addAll(ids)
            } else {
                complete = false
            }
        }

        filter.kinds?.let { kinds ->
            if (kinds.size <= MAX_PUSHDOWN) {
                conditions.add(Sql.memberOf("r.kind", kinds))
                params.addAll(kinds)
            } else {
                complete = false
            }
        }

        filter.authors?.let { authors ->
            if (authors.size <= MAX_PUSHDOWN) {
                conditions.add(Sql.memberOf("r.pubkey", authors))
                params.addAll(authors)
            } else {
                complete = false
            }
        }

        // Timestamps the rowid encoding had to clamp are re-checked exactly.
        if (!time.exact) {
            filter.since?.let {
                conditions.add("r.created_at >= ?")
                params.add(it)
            }
            filter.until?.let {
                conditions.add("r.created_at <= ?")
                params.add(it)
            }
        }

        // Tags and keywords are each a full-text index, and the term index is a
        // third — so rather than intersect indexes (which SQLite cannot do
        // across tables) each is resolved to a rowid set the term's walk tests
        // against. The term drives because it is the selective one: a
        // conversation is a handful of rows where `#p` is everything ever sent
        // to a person.
        if (filter.tags.isNotEmpty()) {
            // A value list long enough to need splitting has no split to be
            // given here — there is one statement, not one cursor per chunk —
            // so it goes to the in-memory matcher instead, which reads the tags
            // off rows the term has already narrowed to.
            if (filter.tags.any { it.values.size > MAX_OR }) {
                complete = false
            } else {
                conditions.add("x.seq IN (SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?)")
                params.add(
                    matchExpr(
                        filter.tags.map { tag ->
                            tag.values.map { value -> tagToken("t$ord", tag.name, value) }
                        },
                    ),
                )
            }
        }

        val search = if (this.search) filter.searchQuery else null
        val searched = filter.searchKeywords == null || search != null

        if (search != null) {
            conditions.add("x.seq IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)")
            params.add(search)
        }

        return ScanPlan(
            null,
            listOf(
                TableCursor(
                    from = "rumor_terms x CROSS JOIN rumors r ON r.seq = x.seq",
                    where = conditions,
                    params = params,
                    key = "x.seq",
                    columns = R_RUMOR_COLUMNS,
                ),
            ),
            sqlOnly = complete && searched,
            searched = searched,
        )
    }

    /**
     * Plan a filter as one or more MATCH expressions, or null when the index
     * can't drive it.
     *
     * Every constraint becomes a group of alternatives — the tag values, the
     * authors — and the groups are ANDed. FTS5 evaluates that by merging the
     * groups' doclists, so the cost is the length of the *shortest* group rather
     * than the product of them all.
     */
    private fun planFts(
        ord: Int,
        prefix: String,
        filter: ParsedFilter,
        search: String?,
        time: TimeRange,
    ): ScanPlan? {
        val groups = ArrayList<List<String>>()

        for (tag in filter.tags) {
            groups.add(tag.values.map { tagToken(prefix, tag.name, it) })
        }

        // A search whose keywords are all negations has nothing for FTS5 to
        // match against — there is no way to say "every row except these" — so
        // it is left to the in-memory matcher, as is any search at all when the
        // content index isn't maintained.
        val searched = filter.searchKeywords == null || search != null

        val authors = filter.authors
        // Authors join the tags in the index, where they are one more posting
        // list to intersect. Without a tag to intersect *with*, they are better
        // served by their own b-tree, so they're only added here when there is
        // one — and only while there are few enough of them to be worth merging.
        val inIndex = groups.isNotEmpty() && authors != null && authors.size <= MAX_AUTHOR_TERMS

        if (inIndex) {
            groups.add(authors!!.map { "$prefix:_p:${part(it)}" })
        }

        if (groups.isEmpty() && search == null) return null

        // Whatever the index isn't carrying is tested on the rows it finds,
        // which is what the rumors table is for. Every condition still ends up
        // in SQL — it just costs a column read on a row already fetched instead
        // of a posting list intersection over the whole store.
        val conditions = ArrayList<String>()
        val params = ArrayList<Any?>()

        // A token carries its tenant; the content index does not, so a
        // keyword-only scan is the one that has to say so.
        if (groups.isEmpty()) {
            conditions.add("r.tenant = ?")
            params.add(ord)
        }

        val kinds = filter.kinds
        if (kinds != null && kinds.size <= MAX_PUSHDOWN) {
            conditions.add(Sql.memberOf("r.kind", kinds))
            params.addAll(kinds)
        }

        if (!inIndex && authors != null && authors.size <= MAX_PUSHDOWN) {
            conditions.add(Sql.memberOf("r.pubkey", authors))
            params.addAll(authors)
        }

        // Timestamps the rowid encoding had to clamp are re-checked exactly
        // here, rather than in memory.
        if (!time.exact) {
            filter.since?.let {
                conditions.add("r.created_at >= ?")
                params.add(it)
            }
            filter.until?.let {
                conditions.add("r.created_at <= ?")
                params.add(it)
            }
        }

        val complete = (kinds == null || kinds.size <= MAX_PUSHDOWN) &&
            (inIndex || authors == null || authors.size <= MAX_PUSHDOWN)

        // The longest group is the one worth splitting: every cursor carries
        // every other group in full, so splitting a short one would repeat more
        // work.
        val longest = groups.maxByOrNull { it.size } ?: emptyList()
        val chunks = if (longest.size > MAX_OR) Sql.batch(longest, MAX_OR) else listOf(longest)

        val cursors = chunks.map { chunk ->
            FtsCursor(
                match = if (groups.isEmpty()) {
                    null
                } else {
                    matchExpr(groups.map { if (it === longest) chunk else it })
                },
                search = search,
                min = time.min,
                max = time.max,
                where = conditions,
                params = params,
            )
        }

        return ScanPlan(null, cursors, sqlOnly = complete && searched, searched = searched)
    }

    /** How many rumors in [tenant] match. */
    fun count(tenant: String, filters: List<JSONObject>): Count = lock.withLock {
        // A single complete plan is counted inside the index: no rows returned,
        // no rumor bodies read. One rumor is one row of the token index however
        // many of its tags matched, so nothing has to be de-duplicated.
        if (filters.size == 1) {
            val filter = ParsedFilter(filters[0])
            if (filter.neverMatch) return Count(0)
            awaitTerms(tenant, listOf(filter))

            if (filter.limit == null) {
                // A tenant that was never written to holds nothing to count.
                val ord = tenantOrd(tenant) ?: return Count(0)

                val plan = planScan(ord, "t$ord", filter)

                // A collapse the index could not GROUP is applied while scanning
                // the rows (see [query]), so the index counts rows where the
                // caller asked for groups. [planDistinct] bails on anything it
                // can't test inside the grouping — kinds, authors, a tag, a
                // keyword, an inexact bound — and the filter then falls through
                // to the ordinary cascade, where `COUNT(*)` would answer a
                // conversation list with the number of messages in it. Counted
                // from the rows instead, as every other engine does.
                val collapsed = filter.distinct != null && !plan.grouped

                if (!collapsed && plan.sqlOnly && plan.ids == null && plan.cursors.size == 1) {
                    val cursor = plan.cursors[0]
                    val params = ArrayList<Any?>()

                    val sql = when (cursor) {
                        is FtsCursor -> {
                            val scan = ftsScan(cursor, null)
                            params.addAll(scan.params)

                            // With nothing left to test, the index knows the
                            // answer by itself. Otherwise the rows still have to
                            // be visited, but only their columns, never their
                            // bodies.
                            if (cursor.where.isNotEmpty()) {
                                params.addAll(cursor.params)
                                """SELECT COUNT(*) AS count FROM ${scan.driver}
                                    CROSS JOIN rumors r ON r.seq = ${scan.driver}.rowid${
                                    Sql.where(scan.conditions + cursor.where)
                                }"""
                            } else {
                                "SELECT COUNT(*) AS count FROM ${scan.driver}${Sql.where(scan.conditions)}"
                            }
                        }

                        is TableCursor -> {
                            params.addAll(cursor.params)
                            "SELECT COUNT(*) AS count FROM ${cursor.from}${Sql.where(cursor.where)}"
                        }
                    }

                    val count = db.query(sql.collapseWhitespace(), params) { it.long(0) }.firstOrNull() ?: 0L
                    return Count(count)
                }
            }
        }

        Count(query(tenant, filters).size.toLong())
    }

    /**
     * Remove rumors from this device: delete them from every tenant and refuse
     * them in any tenant from now on, whichever writer delivers them. The
     * tombstones land first, in the same transaction. Mirrors `SqliteArmadaDB.forget`.
     */
    fun forget(ids: List<String>) = lock.withLock {
        val unique = ids.filter { it.isNotEmpty() }.distinct()
        if (unique.isEmpty()) return@withLock

        transaction {
            for (chunk in Sql.batch(unique, MAX_PARAMS)) {
                db.run(
                    "INSERT OR IGNORE INTO removed_rumors (id) VALUES ${chunk.joinToString(", ") { "(?)" }}",
                    chunk,
                )
            }
            // `rumors_id` is (tenant, id): one probe per tenant, not a table scan.
            val ords = db.query("SELECT ord FROM tenants") { it.long(0).toInt() }
            for (ord in ords) {
                val seqs = ArrayList<Long>()
                for (chunk in Sql.batch(unique, MAX_PARAMS - 1)) {
                    seqs.addAll(
                        db.query(
                            "SELECT seq FROM rumors WHERE tenant = ? AND ${Sql.memberOf("id", chunk)}",
                            listOf(ord) + chunk,
                        ) { it.long(0) },
                    )
                }
                deleteRumors(ord, seqs)
            }
        }
    }

    /** Remove every rumor in [tenant] matching the filters. */
    fun remove(tenant: String, filters: List<JSONObject>) = lock.withLock {
        // A `distinct:` collapse names one rumor per group, which is not something
        // a deletion can coherently be asked for — and answering it as written
        // would delete the newest message of every conversation. Dropped, so the
        // filter removes nothing, which is the same direction every other
        // unhonourable narrowing takes.
        val deletable = filters.filter { ParsedFilter(it).distinct == null }
        if (deletable.isEmpty()) return@withLock

        val rumors = query(tenant, deletable)
        if (rumors.isEmpty()) return@withLock

        // Non-empty results mean the tenant has been written to, so it has an
        // ordinal.
        val ord = tenantOrd(tenant) ?: return@withLock

        transaction {
            val seqs = ArrayList<Long>()

            for (chunk in Sql.batch(rumors.map { it.id }, MAX_PARAMS - 1)) {
                seqs.addAll(
                    db.query(
                        "SELECT seq FROM rumors WHERE tenant = ? AND ${Sql.memberOf("id", chunk)}",
                        listOf(ord) + chunk,
                    ) { it.long(0) },
                )
            }

            deleteRumors(ord, seqs)
        }
    }

    // ── KV ────────────────────────────────────────────────────────────────────
    //
    // A small key/value store for everything that isn't an event: sync cursors,
    // folded state, settings. Values are opaque JSON TEXT here — the WebView
    // serializes and parses them, so the bridge never has to agree with
    // JavaScript about how a value round-trips.

    /** The stored JSON text for [key], or null if the key was never set. */
    fun kvGet(key: String): String? = lock.withLock {
        db.query("SELECT value FROM kv WHERE key = ?", listOf(key)) { it.text(0) }.firstOrNull()
    }

    fun kvSet(key: String, json: String) = lock.withLock {
        transaction {
            db.run(
                """INSERT INTO kv (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value""".collapseWhitespace(),
                listOf(key, json),
            )
        }
    }

    fun kvDelete(key: String) = lock.withLock {
        transaction { db.run("DELETE FROM kv WHERE key = ?", listOf(key)) }
    }

    /**
     * The entries a selector picks out — KEY AND JSON TEXT, in one call.
     *
     * The order is SQLite's `BINARY` collation (UTF-8 bytes), reversed by
     * [reverse]; [limit] then takes from the front of it.
     */
    fun kvList(
        prefix: String? = null,
        start: String? = null,
        end: String? = null,
        limit: Int? = null,
        reverse: Boolean = false,
    ): List<KvEntry> {
        val range = KvRange.resolve(prefix, start, end)
        if (range.empty) return emptyList()

        return lock.withLock { kvScan(range, limit, reverse) }
    }

    /** The scan behind [kvList] and a [KvOp.Scan]. Callers already hold [lock]. */
    private fun kvScan(range: KvRange, limit: Int?, reverse: Boolean): List<KvEntry> {
        val conditions = mutableListOf<String>()
        val params = mutableListOf<Any?>()
        range.lower?.let {
            conditions.add("key >= ?")
            params.add(it)
        }
        range.upper?.let {
            conditions.add("key < ?")
            params.add(it)
        }

        // A limit only reaches SQL when the scan's own order is the answer's
        // — see [KvRange.exact]. Otherwise the rows dropped below would come
        // off the top of a short page.
        val sql = StringBuilder("SELECT key, value FROM kv")
        if (conditions.isNotEmpty()) sql.append(" WHERE ").append(conditions.joinToString(" AND "))
        sql.append(" ORDER BY key")
        if (reverse) sql.append(" DESC")
        if (range.exact && limit != null) {
            sql.append(" LIMIT ?")
            params.add(limit.toLong())
        }

        val entries = db.query(sql.toString(), params) { KvEntry(it.text(0), it.text(1)) }
        // The range is a scan hint, not the contract: SQLite compares UTF-8
        // bytes and the WebView's other adapter compares UTF-16 code units,
        // so a range can admit a key the selector doesn't accept.
        return if (range.exact) {
            entries
        } else {
            val kept = entries.filter { range.matches(it.key) }
            if (limit != null && kept.size > limit) kept.subList(0, limit) else kept
        }
    }

    /** One operation in a [kvOps] batch. */
    sealed class KvOp {
        data class Get(val key: String) : KvOp()
        data class Set(val key: String, val json: String) : KvOp()
        data class Delete(val key: String) : KvOp()
        data class Scan(
            val prefix: String? = null,
            val start: String? = null,
            val end: String? = null,
            val limit: Int? = null,
            val reverse: Boolean = false,
        ) : KvOp()
    }

    /**
     * Execute a batch of KV operations in arrival order: ONE turn of [lock],
     * and one transaction when the batch writes at all. The WebView coalesces
     * a burst into a single bridge call (`NativeArmadaDB.ts`), so the batch
     * here IS the burst — per-op calls paid a bridge crossing and a lock turn
     * each, and Capacitor's thread pool never guaranteed their ORDER anyway.
     * A get or scan later in the batch sees an earlier set, exactly the
     * read-your-writes the web adapter's op queue defines.
     *
     * Returns one element per op: the stored JSON text (or null) for a
     * [KvOp.Get], null for a [KvOp.Set]/[KvOp.Delete], a list of [KvEntry]
     * for a [KvOp.Scan].
     */
    fun kvOps(ops: List<KvOp>): List<Any?> = lock.withLock {
        val run = {
            ops.map { op ->
                when (op) {
                    is KvOp.Get ->
                        db.query("SELECT value FROM kv WHERE key = ?", listOf(op.key)) { it.text(0) }
                            .firstOrNull()
                    is KvOp.Set -> {
                        db.run(
                            """INSERT INTO kv (key, value) VALUES (?, ?)
                                ON CONFLICT(key) DO UPDATE SET value = excluded.value""".collapseWhitespace(),
                            listOf(op.key, op.json),
                        )
                        null
                    }
                    is KvOp.Delete -> {
                        db.run("DELETE FROM kv WHERE key = ?", listOf(op.key))
                        null
                    }
                    is KvOp.Scan -> {
                        val range = KvRange.resolve(op.prefix, op.start, op.end)
                        if (range.empty) emptyList<KvEntry>() else kvScan(range, op.limit, op.reverse)
                    }
                }
            }
        }
        // Reads alone skip BEGIN IMMEDIATE: they take no write lock the
        // notification service would then wait out.
        if (ops.any { it is KvOp.Set || it is KvOp.Delete }) transaction(run) else run()
    }

    // ── Driver plumbing ───────────────────────────────────────────────────────

    /**
     * Run [body] inside a transaction. Callers already hold [lock], which is
     * what keeps a second writer from splicing statements into this one —
     * SQLite has no nested transactions, so an interleaved write would be
     * committed, or rolled back, with someone else's.
     */
    private inline fun <T> transaction(body: () -> T): T {
        db.run("BEGIN IMMEDIATE")
        return try {
            val value = body()
            db.run("COMMIT")
            value
        } catch (error: Throwable) {
            runCatching { db.run("ROLLBACK") }
            throw error
        }
    }

    private class Stored(val id: String, val seq: Long, val createdAt: Long)

    private class FtsScan(
        val driver: String,
        val conditions: List<String>,
        val params: List<Any?>,
    )

    companion object {
        private val LEGACY_TRIGGER_WHEN = Regex("\\bWHEN\\b", RegexOption.IGNORE_CASE)

        /** Bits of the rowid reserved for the per-second sequence number. */
        private const val SEQ_BITS = 20

        /** Rowids per second: how many rumors may share one `created_at`. */
        private const val SEQ_SPACE = 1L shl SEQ_BITS

        /**
         * Largest `created_at` the rowid encoding can carry (2106-02-07). Beyond
         * this the timestamp is clamped, which keeps the rowid small at the cost
         * of ordering *among* absurdly-dated rumors; plans touching such a rumor
         * fall back to matching it in memory, so results stay correct either way.
         */
        private const val MAX_TIME = 0xffffffffL

        /** How many candidate rows a paged scan reads per round trip. */
        private const val CHUNK_SIZE = 512

        /**
         * Upper bound on bound parameters per statement. SQLite's own limit is
         * 32766 on modern builds but only 999 on older ones, so statements are
         * split well below the floor.
         */
        private const val MAX_PARAMS = 900

        /** Upper bound on the rows one page of a scan may read. */
        private const val MAX_PAGE = 10_000

        /** Longest `IN (…)` list driving a scan before it is split. */
        private const val MAX_IN = 500

        /** Most terms one MATCH expression may `OR` together. */
        private const val MAX_OR = 500

        /**
         * Most authors worth folding into the MATCH alongside a tag, rather than
         * testing on the rows the tag finds. Measured crossover on a 20k store:
         * one author in the index is 8× faster than the pushdown, sixteen is a
         * wash, and a hundred is 5× slower.
         */
        private const val MAX_AUTHOR_TERMS = 16

        /** Longest value list used to *filter* (rather than drive) a scan. */
        private const val MAX_PUSHDOWN = 100

        /** How many rumors one page of the derived-term backfill re-derives. */
        private const val BACKFILL_PAGE = 500

        /** The columns a stored rumor is reassembled from. */
        private const val RUMOR_COLUMNS = "id, kind, pubkey, created_at, tags, content"

        /** The same columns read through the `r` alias of a joined scan. */
        private const val R_RUMOR_COLUMNS = "r.id, r.kind, r.pubkey, r.created_at, r.tags, r.content"

        /** Newest-first; ties broken by smaller id first (NIP-01). */
        private val NEWEST_FIRST = Comparator<Rumor> { a, b ->
            if (a.createdAt != b.createdAt) b.createdAt.compareTo(a.createdAt) else a.id.compareTo(b.id)
        }

        /**
         * Tokens are only safe to embed verbatim when the tokenizer can't split
         * or fold them: lowercase ASCII alphanumerics, and nothing else.
         */
        private val VERBATIM = Regex("^[0-9a-z]+$")

        /** Lowercase hex digits, so escaping never depends on the default locale. */
        private val HEX = "0123456789abcdef".toCharArray()

        /** The first rowid belonging to a timestamp, clamped to the encodable range. */
        private fun bucket(createdAt: Long): Long =
            createdAt.coerceIn(0L, MAX_TIME) * SEQ_SPACE

        /**
         * Per NIP-01, `a` is "newer" than `b` (same coordinate) when its
         * created_at is greater, or — on a tie — its id is lexicographically
         * smaller.
         */
        private fun isNewer(aId: String, aTime: Long, bId: String, bTime: Long): Boolean {
            if (aTime > bTime) return true
            if (aTime < bTime) return false
            return aId < bId
        }

        /**
         * Encode one part of a tag token.
         *
         * Verbatim where possible — rumor ids, pubkeys and Armada's tag names
         * (`channel`, `stream`, `peer`) already qualify, and they're the values
         * worth optimizing for. Anything else is hex-escaped, which no tokenizer
         * will split and no case folding will alter. The two forms can't be
         * confused: an escaped value starts with `_`, which a verbatim one can
         * never contain.
         */
        internal fun part(value: String): String {
            if (VERBATIM.matches(value)) return value

            val hex = StringBuilder("_")
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val octet = byte.toInt() and 0xff
                hex.append(HEX[octet ushr 4]).append(HEX[octet and 0x0f])
            }
            return hex.toString()
        }

        /**
         * The index token for a tag within a tenant, e.g. `t1:e:<id>` or
         * `t1:t:_c3a9`.
         *
         * The tenant prefix can never be mistaken for a tag name, and the
         * reserved `_p:` author prefix can never be produced by a user's tag: an
         * escaped name is `_` followed by an EVEN number of hex digits, and `p`
         * is not a hex digit at all.
         */
        internal fun tagToken(prefix: String, name: String, value: String): String =
            "$prefix:${part(name)}:${part(value)}"

        /**
         * Build an FTS5 MATCH expression: each group's tokens are alternatives,
         * and the groups are required together.
         *
         * A group with one member is written as a bare phrase rather than a
         * parenthesized alternation, which is the same query with less for
         * FTS5's parser to chew through — and single-value groups are the common
         * case.
         */
        private fun matchExpr(groups: List<List<String>>): String = groups.joinToString(" AND ") { group ->
            if (group.size == 1) phrase(group[0]) else "(${group.joinToString(" OR ") { phrase(it) }})"
        }

        /**
         * A token as an FTS5 phrase. Quoting is what keeps a keyword like `OR` or
         * `(` from being read as query syntax; embedded quotes are doubled.
         */
        private fun phrase(token: String): String = "\"${token.replace("\"", "\"\"")}\""

        /** The `kind:pubkey:d` coordinate of a replaceable or addressable rumor. */
        internal fun coordOf(rumor: Rumor): String {
            val d = if (Kinds.addressable(rumor.kind)) rumor.tagValue("d") ?: "" else ""
            return "${rumor.kind}:${rumor.pubkey}:$d"
        }

        /** The same coordinate, recomputed from stored columns without a full parse. */
        internal fun coordOf(kind: Int, pubkey: String, tagsJson: String): String {
            var d = ""
            if (Kinds.addressable(kind)) {
                val tags = runCatching { JSONArray(tagsJson) }.getOrNull()
                if (tags != null) {
                    for (i in 0 until tags.length()) {
                        val tag = tags.optJSONArray(i) ?: continue
                        if (tag.length() >= 2 && tag.opt(0) == "d") {
                            d = tag.opt(1) as? String ?: ""
                            break
                        }
                    }
                }
            }
            return "$kind:$pubkey:$d"
        }

        /**
         * The exclusive upper bound of the key range starting with [prefix], or
         * null when there isn't one — an empty prefix, or one ending in the
         * maximal code unit, both of which are open-ended.
         */
        internal fun prefixUpperBound(prefix: String): String? {
            if (prefix.isEmpty()) return null
            val last = prefix[prefix.length - 1]
            if (last.code == 0xffff) return null
            return prefix.dropLast(1) + (last + 1)
        }
    }

    /**
     * The rowid window a filter's `since`/`until` bounds describe, and whether
     * that window is exact — it isn't when a bound falls outside the range the
     * rowid encoding can represent, in which case the rumors in the clamped
     * bucket have to be re-checked against `created_at`.
     */
    private class TimeRange(val min: Long?, val max: Long?, val exact: Boolean)

    private fun timeRange(filter: ParsedFilter): TimeRange {
        var exact = true
        var min: Long? = null
        var max: Long? = null

        filter.since?.let {
            if (it > MAX_TIME || it < 0) exact = false
            min = bucket(it)
        }

        filter.until?.let {
            if (it > MAX_TIME || it < 0) exact = false
            max = bucket(it) + SEQ_SPACE - 1
        }

        return TimeRange(min, max, exact)
    }
}

/** One entry from [SqliteArmadaDb.kvList]: a key and the JSON text under it. */
data class KvEntry(val key: String, val json: String)

/**
 * A KV selector reduced to what the scan needs: a half-open key range, plus the
 * prefix the range is only an approximation of. A port of `resolveKvRange` in
 * `src/lib/db/types.ts` — Kotlin compares strings by UTF-16 code unit, as
 * JavaScript does, so the bounds derive identically on both sides.
 */
internal data class KvRange(
    /** Inclusive lower bound; null means unbounded below. */
    val lower: String?,
    /** Exclusive upper bound; null means unbounded above. */
    val upper: String?,
    /** Keys must start with this. Empty when the selector named no prefix. */
    val prefix: String,
    /** Whether the bounds cross, so nothing can match. */
    val empty: Boolean,
    /**
     * Whether the bounds alone select exactly the keys the selector accepts, so
     * [matches] can only ever agree with them — and a `limit` may be pushed into
     * the scan. See the TypeScript original for why a bound holding a surrogate
     * spoils it.
     */
    val exact: Boolean,
) {
    /** Whether [key] is genuinely in range — the contract the bounds approximate. */
    fun matches(key: String): Boolean {
        if (prefix.isNotEmpty() && !key.startsWith(prefix)) return false
        if (lower != null && key < lower) return false
        if (upper != null && key >= upper) return false
        return true
    }

    companion object {
        /** @throws IllegalArgumentException if a prefix comes with both bounds. */
        fun resolve(prefix: String?, start: String?, end: String?): KvRange {
            val pre = prefix ?: ""
            require(!(pre.isNotEmpty() && start != null && end != null)) {
                "A KV selector cannot combine a prefix with both start and end"
            }

            // The bounds are the INTERSECTION of what the prefix implies and what
            // the caller asked for, so a `start` outside the prefix narrows to
            // nothing rather than escaping it.
            val prefixUpper = SqliteArmadaDb.prefixUpperBound(pre)
            val lower = if (start != null && start > pre) start else pre.ifEmpty { null }
            val upper = if (end != null && (prefixUpper == null || end < prefixUpper)) end else prefixUpper

            val openEndedPrefix = pre.isNotEmpty() && upper == null
            val exact = !openEndedPrefix && !hasSurrogate(lower) && !hasSurrogate(upper)
            return KvRange(
                lower = lower,
                upper = upper,
                prefix = pre,
                empty = lower != null && upper != null && lower >= upper,
                exact = exact,
            )
        }

        private fun hasSurrogate(text: String?): Boolean =
            text != null && text.any { it.code in 0xd800..0xdfff }
    }
}

/** A row a scan produced: the rumor, and the rowid a later page resumes from. */
private class Candidate(val seq: Long, val rumor: Rumor)

/**
 * One scan: either a full-text match over a window of rowids, or a b-tree scan
 * over the rumors table.
 */
private sealed class ScanCursor

/**
 * A full-text scan, bounded by the filter's time range: a token expression, a
 * NIP-50 keyword expression, or both, plus whatever conditions are left for the
 * rumors rows it finds.
 */
private class FtsCursor(
    val match: String?,
    val search: String?,
    val min: Long?,
    val max: Long?,
    /** Conditions on the matched rumors, as `r.column …`. */
    val where: List<String>,
    val params: List<Any?>,
) : ScanCursor()

/**
 * A b-tree scan: the rumors table with a forced index, or an index table joined
 * to it (the derived-term index).
 */
private class TableCursor(
    val from: String,
    val where: List<String>,
    val params: List<Any?>,
    /**
     * The expression the scan is ordered and paged by.
     *
     * A join names it on the DRIVING table (`x.seq`), which is what keeps the
     * walk inside that table's index instead of sorting whatever the join
     * produced.
     */
    val key: String = "seq",
    /** The rumor columns, aliased when the scan is a join. */
    val columns: String = "id, kind, pubkey, created_at, tags, content",
) : ScanCursor()

/** A planned scan: how to fetch a single filter's rumors. */
private class ScanPlan(
    /** For ids plans: fetch these keys directly instead of scanning. */
    val ids: List<String>?,
    /**
     * Normally one scan. A filter with a value list too long for a single MATCH
     * — or for one statement's parameter budget — is split into several, merged
     * by the caller.
     */
    val cursors: List<ScanCursor>,
    /** Whether the cursors express the filter completely. */
    val sqlOnly: Boolean,
    /** Whether the plan applies the filter's NIP-50 keywords itself. */
    val searched: Boolean,
    /**
     * Whether the cursor already yields one row per `distinct:` group. When it
     * doesn't, a collapsed filter is collapsed row by row as its pages come
     * back, and `limit` counts groups rather than rows — so no limit may be
     * pushed into the SQL.
     */
    val grouped: Boolean = false,
)

/**
 * Whether a rumor has to be written by a statement of its own rather than
 * staged into its burst's batch.
 *
 * Only the ones that READ the rows around them: a replaceable or addressable
 * rumor resolves its coordinate and deletes what it supersedes, and a deletion
 * request removes the rumors it names. Both must see the batch so far and must
 * not see the rest of it — which is what a staged row can't offer, and what
 * flushing before one of these restores.
 */
private fun needsOwnStatement(rumor: Rumor): Boolean =
    rumor.kind == 5 || Kinds.replaceable(rumor.kind) || Kinds.addressable(rumor.kind)

/**
 * Parameters one staged INSERT will carry.
 *
 * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is 32766 in every build this schema
 * requires, but was 999 for a decade before 3.32 and is a compile-time option
 * any packager may still set. A budget below the old default costs nothing
 * measurable, since the trigger overhead this batching exists to amortize is
 * already gone by ~100 rows a statement, and it cannot be the thing that breaks
 * on a platform nobody tested.
 */
private const val BATCH_PARAMS = 900

/**
 * One burst's rows, staged for a multi-row INSERT per table.
 *
 * It is also the burst's rowid ledger — see `SqliteArmadaDb.reserveSeq` —
 * because a rowid reserved for a staged row isn't in the table yet and so is
 * invisible to the lookup that reserves the next one.
 *
 * Lives exactly as long as one transaction. Nothing here outlives a commit,
 * which is what keeps the ledger from becoming a cache of what another writer
 * may since have changed.
 */
private class RumorBatch {
    /** 8 parameters per row, in `rumors` column order. */
    private val rumors = ArrayList<Any?>()

    /** 2 per row: rowid and its tag tokens. */
    private val tags = ArrayList<Any?>()

    /** 3 per row: tenant, term, rowid. */
    private val terms = ArrayList<Any?>()

    /** `<ord>:<id>` of every rumor reserved in this transaction. */
    private val ids = HashSet<String>()

    /** The highest rowid handed out per `created_at` bucket. */
    private val seqs = HashMap<Long, Long>()

    /** Whether this transaction already reserved a rowid for (`ord`, `id`). */
    fun staged(ord: Int, id: String): Boolean = "$ord:$id" in ids

    /** The highest rowid handed out in `base`'s bucket, if any. */
    fun lastSeq(base: Long): Long? = seqs[base]

    /** Record a rowid as taken, before the row it belongs to exists. */
    fun reserve(ord: Int, id: String, base: Long, seq: Long) {
        ids.add("$ord:$id")
        seqs[base] = seq
    }

    fun add(seq: Long, ord: Int, rumor: Rumor, tokens: String, terms: List<String>) {
        rumors.add(seq)
        rumors.add(ord)
        rumors.add(rumor.id)
        rumors.add(rumor.kind)
        rumors.add(rumor.pubkey)
        rumors.add(rumor.createdAt)
        rumors.add(rumor.tagsJson())
        rumors.add(rumor.content)

        tags.add(seq)
        tags.add(tokens)

        for (term in terms) {
            if (term.isEmpty()) continue
            this.terms.add(ord)
            this.terms.add(term)
            this.terms.add(seq)
        }
    }

    /** The staged INSERTs, in the order they must run. */
    fun statements(): List<Pair<String, List<Any?>>> {
        val out = ArrayList<Pair<String, List<Any?>>>()
        // Index rows first, so a rumor is never findable before the index that
        // finds it — see `SqliteArmadaDb.writeBatch`.
        rows(out, tags, 2) { "INSERT INTO rumor_tags_fts (rowid, tokens) VALUES $it" }
        rows(out, terms, 3) { "INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES $it" }
        rows(out, rumors, 8) {
            "INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content) VALUES $it"
        }
        return out
    }

    /** Drop the staged rows, keeping the ledger for the rest of the transaction. */
    fun clear() {
        rumors.clear()
        tags.clear()
        terms.clear()
    }

    /** Chunk flat parameters into multi-row INSERTs of at most [BATCH_PARAMS]. */
    private fun rows(
        out: MutableList<Pair<String, List<Any?>>>,
        params: List<Any?>,
        width: Int,
        sql: (values: String) -> String,
    ) {
        val perStatement = (BATCH_PARAMS / width).coerceAtLeast(1) * width
        var i = 0
        while (i < params.size) {
            val chunk = params.subList(i, minOf(i + perStatement, params.size))
            val values = (0 until chunk.size / width).joinToString(", ") { "(${Sql.qs(width)})" }
            out.add(sql(values) to ArrayList(chunk))
            i += perStatement
        }
    }
}

/**
 * The tag name an engine may use to file a term policy's terms in its ORDINARY
 * tag index, rather than in an index of their own — which is what the web
 * client's IndexedDB adapter does (`TERM_TAG` in `src/lib/db/types.ts`), the
 * `indexTags` hook being the only place `NIndexedDB` can add an index term.
 *
 * This engine has `rumor_terms` and needs no such thing, but the name is
 * reserved here too: the tag index is content the four engines are held to
 * agree on for identical input, and one that indexed `~` would answer
 * `{"#~": [...]}` for a tag a sender wrote where the others answer nothing.
 */
internal const val TERM_TAG = "~"

/**
 * Default tag index policy: index every tag with a short name and a non-empty
 * value under 200 chars, except the reserved [TERM_TAG]. The value length cap is
 * what keeps blobs (a serialized seal, an embedded proof) out of the index.
 */
internal fun defaultIndexTags(rumor: Rumor): List<List<String?>> = rumor.tags.filter { row ->
    val name = row.getOrNull(0)
    val value = row.getOrNull(1)
    !name.isNullOrEmpty() && name != TERM_TAG && name.length <= 20 &&
        !value.isNullOrEmpty() && value.length < 200
}
