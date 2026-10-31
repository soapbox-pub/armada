import Foundation

/// ArmadaDB's SQLite engine, in Swift — a port of `src/lib/db/SqliteArmadaDB.ts`
/// by way of `SqliteArmadaDb.kt`, which carry the full rationale. See
/// `ArmadaDbSchema` for the layout and for why the tag index is an FTS5
/// inverted index rather than a b-tree.
///
/// This is intended to be the ONE implementation on iOS, as its Kotlin twin is
/// on Android: the WebView reaches it over `ArmadaDbPlugin`, and a notification
/// extension would write through it directly, against the same file. There is
/// no second engine to keep in step and no format to agree on — the database
/// logic is native, and the bridge is a transport.
///
/// One connection, one database: every tenant shares the `rumors` /
/// `rumor_tags_fts` / `rumor_coords` tables, and the KV store is a fourth.
///
/// Two things carry the whole design:
///
///  - **`seq`, the rowid, encodes time** (`created_at × 2²⁰ + n`). So `ORDER BY
///    seq DESC` is `ORDER BY created_at DESC` for the table, for every b-tree
///    index over it, and — the point of the exercise — for FTS5, which only
///    ever yields rows in rowid order. `since`/`until` become a rowid range
///    that FTS5 pushes down into its own backwards walk of the posting lists.
///  - **Tags are tokens.** A filter's tag terms, and its authors when a tag is
///    already driving, become one MATCH expression: groups of alternatives,
///    ANDed. FTS5 merges the groups' posting lists in C, so the cost is the
///    length of the shortest group rather than the product of them all, and one
///    rumor is one row of the index however many of its tags matched.
///
/// Everything the index doesn't carry — kinds, and authors without a tag — is
/// tested on the `rumors` rows it finds, which costs a column read on a row
/// that was going to be fetched anyway. Filters naming no tag and no keyword
/// are driven by a b-tree instead, chosen by strfry's priority cascade:
///
///   ids → tags/search → pubkey+kind → pubkey → kind → the whole tenant
///
/// Semantics, matching the IndexedDB adapter the web build still uses:
///
///  - Ephemeral kinds (20000–29999) are never stored.
///  - Replaceable (0, 3, 10000–19999) and addressable (30000–39999) rumors
///    supersede older versions at the same (tenant, kind, pubkey, d)
///    coordinate; a stale write is skipped. NIP-01 tie-break: on equal
///    created_at the smaller id wins.
///  - NIP-09 kind-5 deletion requests are applied on write (`e` by id, `a` by
///    coordinate), only against the requester's own rumors in the same tenant;
///    the request itself is retained.
///  - A batch of rumors commits as ONE transaction, across all tenants.
///
/// THREADING: every public method takes `lock` for its whole duration. The
/// transactions here are plain `BEGIN IMMEDIATE` statements and SQLite has no
/// nested ones, so a second caller interleaving statements would have its work
/// swept into — and rolled back with — someone else's transaction. The lock is
/// reentrant, so a public method may call another.
public final class SqliteArmadaDb {

    private let db: ArmadaSqlDriver

    /// Whether to maintain the FTS5 content index that NIP-50 `search` filters
    /// are resolved against. Turning it off roughly halves the cost of a write
    /// and leaves `search` working but slow: keywords then post-filter an
    /// ordinary indexed scan in memory, matching substrings rather than whole
    /// words. Must agree with what was migrated.
    private let search: Bool

    /// Which tags to index, as `[name, value]` rows — only these are queryable
    /// with a `#x` filter. Unlike relay policy this is NOT limited to
    /// single-letter tags: Armada's local planes query on multi-letter names
    /// (`#channel`, `#stream`, `#peer`).
    private let indexTags: (Rumor) -> [[String?]]

    /// A tenant's DERIVED index terms: facts re-derivable from a stored rumor
    /// that no tag of its own states, filed in `rumor_terms` and looked up as a
    /// NIP-50 extension token (`{"search": "conv:<key>"}`).
    ///
    /// This engine never interprets a tenant id or a term — `TermPolicies` is
    /// where that knowledge lives, and `src/lib/db/termPolicies.ts` is its
    /// counterpart on the other side of the bridge. The two must agree exactly,
    /// because a rumor filed under a term the WebView does not look up is a
    /// message the notification extension received while the app was closed and
    /// that the thread then never shows.
    ///
    /// Bound to the TENANT rather than named at each write for that same
    /// reason: the extension writes here knowing nothing about terms, and is
    /// covered anyway.
    private let termsOf: (Rumor, String) -> [String]

    /// Which revision of `termsOf` the index is built by — see
    /// `TermPolicies.generation`. Recorded per tenant, and a recorded generation
    /// that differs makes the tenant's terms be dropped and derived again.
    private let termsGeneration: Int64

    /// Memoised tenant ordinals — one lookup per tenant, not per token.
    private var ords = [String: Int]()

    /// Tenants whose pre-existing rows are known to have been through a policy.
    private var backfilled = Set<String>()

    private let lock = NSRecursiveLock()

    public init(
        db: ArmadaSqlDriver,
        search: Bool = true,
        migrate: Bool = true,
        indexTags: @escaping (Rumor) -> [[String?]] = defaultIndexTags,
        termsOf: @escaping (Rumor, String) -> [String] = TermPolicies.terms(of:tenantId:),
        termsGeneration: Int64 = TermPolicies.generation
    ) throws {
        self.db = db
        self.search = search
        self.indexTags = indexTags
        self.termsOf = termsOf
        self.termsGeneration = termsGeneration
        if migrate { try self.migrate() }
    }

    /// A rumor and the tenant it belongs to, for a batched write.
    public struct Write {
        public let tenant: String
        public let rumor: Rumor

        public init(tenant: String, rumor: Rumor) {
            self.tenant = tenant
            self.rumor = rumor
        }
    }

    /// A count and whether it is an estimate (it never is here).
    public struct Count {
        public let count: Int64
        public let approximate: Bool

        public init(_ count: Int64, approximate: Bool = false) {
            self.count = count
            self.approximate = approximate
        }
    }

    // MARK: - Schema

    /// Create the tables, indexes and triggers, if they don't already exist.
    ///
    /// Unlike the other two ports there is no v0 → v1 rebuild: no iOS build has
    /// ever written a file, so a v0 one cannot exist, and a file that
    /// nonetheless claims a layout this build doesn't know is refused rather
    /// than opened. `CREATE IF NOT EXISTS` over an unknown layout succeeds
    /// silently and then misreads every row.
    public func migrate() throws {
        lock.lock()
        defer { lock.unlock() }

        let version = try db.query("PRAGMA user_version") { $0.int(0) }.first ?? 0

        if version > ArmadaDbSchema.version {
            throw ArmadaDbError.unusable(
                "database is schema version \(version), which this build predates"
            )
        }

        if version < ArmadaDbSchema.version {
            // v0 predates versioning, so it is recognized by its layout: only v0
            // has the `json` column. A fresh file has no `rumors` table at all.
            let legacy = try !db.query(
                "SELECT 1 FROM pragma_table_info('rumors') WHERE name = 'json'"
            ) { $0.int(0) }.isEmpty

            if legacy {
                throw ArmadaDbError.unusable(
                    "database is a v0 layout, which no iOS build can have written"
                )
            }
        }

        let schema =
            search ? ArmadaDbSchema.base + ArmadaDbSchema.search : ArmadaDbSchema.base
        let apply = { for statement in schema { try self.db.run(statement.collapsedWhitespace) } }

        // A file from before the content index was limited to
        // `contentIndexedKinds` has an insert trigger without a WHEN. Swapped in
        // one transaction so no writer on another connection (the notification
        // extension) lands between the drop and the create; what it already
        // indexed stays and leaves with its rumors.
        let insertTrigger = search
            ? try db.query(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'rumors_fts_insert'"
            ) { $0.text(0) }.first
            : nil
        if let insertTrigger,
           insertTrigger.range(of: #"\bWHEN\b"#, options: [.regularExpression, .caseInsensitive]) == nil {
            try transaction {
                try db.run("DROP TRIGGER rumors_fts_insert")
                try apply()
            }
        } else {
            try apply()
        }

        try db.run("PRAGMA user_version = \(ArmadaDbSchema.version)")
    }

    /// Empty every table (logout purge). Keeps the schema.
    public func wipe() throws {
        lock.lock()
        defer { lock.unlock() }

        try transaction {
            // The triggers empty the index tables row by row; `delete-all` is
            // FTS5's own reset, and settles any row a policy change or a crash
            // orphaned.
            try db.run("DELETE FROM rumors")
            try db.run("INSERT INTO rumor_tags_fts (rumor_tags_fts) VALUES ('delete-all')")
            if search {
                try db.run("INSERT INTO rumors_fts (rumors_fts) VALUES ('delete-all')")
            }
            try db.run("DELETE FROM rumor_coords")
            // Emptied explicitly rather than left to the trigger, for the same
            // reason as `delete-all` above: a row orphaned by a crash outlives
            // the rumor that would have taken it.
            try db.run("DELETE FROM rumor_terms")
            try db.run("DELETE FROM rumor_term_tenants")
            try db.run("DELETE FROM tenants")
            try db.run("DELETE FROM removed_rumors")
            try db.run("DELETE FROM kv")
        }
        // Interned ids are reallocated from scratch after this, so a remembered
        // one would name the wrong tenant.
        ords.removeAll()
        backfilled.removeAll()
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }
        db.close()
    }

    /// Every tenant that has ever been written to.
    public func tenantIds() throws -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return try db.query("SELECT id FROM tenants ORDER BY ord") { $0.text(0) }
    }

    // MARK: - Write path

    /// Store one rumor. Committed when this returns.
    public func event(tenant: String, rumor: Rumor) throws {
        try write([Write(tenant: tenant, rumor: rumor)])
    }

    /// Store a batch of rumors in ONE transaction, across all tenants. Rumors
    /// of ephemeral kinds are dropped rather than stored.
    public func write(_ writes: [Write]) throws {
        let storable = writes.filter { !Kinds.ephemeral($0.rumor.kind) }
        if storable.isEmpty { return }

        lock.lock()
        defer { lock.unlock() }

        try transaction {
            let batched = RumorBatch()
            for write in storable {
                // A rumor that has to READ what the batch has written so far —
                // a replaceable one superseding its coordinate, a kind 5
                // deleting its targets — needs those rows in the table, not in
                // an accumulator. Flushing first keeps every such rumor seeing
                // exactly what it saw when each write was its own statement:
                // everything before it in the batch, and nothing after.
                if Self.needsOwnStatement(write.rumor) {
                    try writeBatch(batched)
                    try writeRumor(write.tenant, write.rumor, batched)
                } else {
                    try stageRumor(write.tenant, write.rumor, batched)
                }
            }
            try writeBatch(batched)
        }
    }

    /// Stage one ordinary rumor's rows into `batch`, to be written with the rest
    /// of its burst — see `RumorBatch`.
    ///
    /// Everything up to the INSERTs is what it always was, including the rowid
    /// lookup, and it happens in the same order. The only difference is where
    /// the rows go.
    private func stageRumor(_ tenant: String, _ rumor: Rumor, _ batch: RumorBatch) throws {
        let ord = try internTenant(tenant)
        guard let seq = try reserveSeq(ord, rumor, batch) else { return }
        batch.add(seq, ord, rumor, tagTokens("t\(ord)", rumor), termsOf(rumor, tenant))
    }

    /// Write a staged batch: one multi-row INSERT per table, per chunk.
    ///
    /// This is the whole reason for staging. `rumors` carries an AFTER INSERT
    /// trigger maintaining the content index, and SQLite runs a trigger's
    /// sub-program per INSERT STATEMENT rather than folding it into the row loop
    /// — so a row per statement paid that setup 4000 times for 4000 rumors and
    /// cost 76µs a row, against 17µs for the same rows and the same trigger
    /// written in batches of 200. Half the cost of a NIP-17 write was this and
    /// nothing else.
    ///
    /// Rows are written in staging order, which is arrival order, and the three
    /// tables are written back to front: a `rumors` row is what makes a rumor
    /// VISIBLE, so its index rows exist by the time anything can find it — which
    /// matters to nothing inside this transaction, and to a reader on another
    /// connection (the app, against the notification extension's writes) it is
    /// the difference between a rumor with no tags and no rumor.
    private func writeBatch(_ batch: RumorBatch) throws {
        for (sql, params) in batch.statements() { try db.run(sql, params) }
        batch.clear()
    }

    /// Apply a single rumor's writes. Runs inside the batch transaction.
    private func writeRumor(_ tenant: String, _ rumor: Rumor, _ batch: RumorBatch) throws {
        let ord = try internTenant(tenant)
        let prefix = "t\(ord)"
        let terms = termsOf(rumor, tenant)

        // Before anything below can supersede or delete on a removed rumor's behalf.
        let removed = try db.query(
            "SELECT 1 FROM removed_rumors WHERE id = ?", [.text(rumor.id)]
        ) { $0.int(0) }
        if !removed.isEmpty { return }

        if Kinds.replaceable(rumor.kind) || Kinds.addressable(rumor.kind) {
            let coord = Self.coordOf(rumor)

            let existing = try db.query(
                "SELECT id, seq, created_at FROM rumor_coords WHERE tenant = ? AND coord = ?",
                [.int(Int64(ord)), .text(coord)]
            ) { Stored(id: $0.text(0), seq: $0.int(1), createdAt: $0.int(2)) }.first

            if let existing {
                // Per NIP-01 the stored version wins ties, and an identical id
                // is a no-op, so only a strictly newer rumor replaces it.
                if !Self.isNewer(rumor.id, rumor.createdAt, existing.id, existing.createdAt) {
                    return
                }
                try deleteRumors(ord, [existing.seq])
            }

            guard let seq = try insertRumor(ord, prefix, rumor, terms, batch) else { return }

            try db.run(
                """
                INSERT OR REPLACE INTO rumor_coords (tenant, coord, id, seq, created_at)
                    VALUES (?, ?, ?, ?, ?)
                """.collapsedWhitespace,
                [
                    .int(Int64(ord)), .text(coord), .text(rumor.id), .int(seq),
                    .int(rumor.createdAt),
                ]
            )
        } else {
            guard try insertRumor(ord, prefix, rumor, terms, batch) != nil else { return }
        }

        // Applied after the insert so a kind 5 arriving alongside its targets in
        // one batch still resolves. The request itself is retained.
        if rumor.kind == 5 { try applyDeletion(ord, rumor) }
    }

    /// Write ONE rumor's row and index rows immediately, returning the rowid
    /// taken — or nil if it was already stored.
    ///
    /// The path for a rumor that can't be staged into its burst's batch (see
    /// `needsOwnStatement`), which is every replaceable, addressable or deletion
    /// rumor and nothing else. Those are a small minority of a sync and each has
    /// to see the rows before it, so they keep the row-per-statement shape.
    ///
    /// Folding the rowid lookup into the INSERT with `RETURNING` would make this
    /// one statement rather than two, and measured 2.7× SLOWER: an INSERT that
    /// returns rows gives up SQLite's fast path and pays a result set per write,
    /// which costs far more than the extra round trip saves.
    private func insertRumor(
        _ ord: Int, _ prefix: String, _ rumor: Rumor, _ terms: [String], _ batch: RumorBatch
    ) throws -> Int64? {
        guard let seq = try reserveSeq(ord, rumor, batch) else { return nil }

        try db.run(
            """
            INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """.collapsedWhitespace,
            [
                .int(seq), .int(Int64(ord)), .text(rumor.id), .int(Int64(rumor.kind)),
                .text(rumor.pubkey), .int(rumor.createdAt), .text(rumor.tagsJson()),
                .text(rumor.content),
            ]
        )

        // The content index is written by a trigger, so this is the only index
        // the write path maintains itself — one row, however many tags the
        // rumor has.
        try db.run(
            "INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)",
            [.int(seq), .text(tagTokens(prefix, rumor))]
        )

        try insertTerms(ord, seq, terms)

        return seq
    }

    /// The rowid this rumor takes, or nil if it is already stored — which makes
    /// a re-delivery a no-op.
    ///
    /// Everything the write needs to know first — whether this rumor is here,
    /// and which rowid is free at its timestamp — is one statement, since each
    /// is a scalar subquery over an index and neither depends on the other. The
    /// rowid is allocated by LOOKING rather than from a counter held across
    /// writes, so a second writer on the same file (the notification extension,
    /// against the app) can't be handed the same one; the bucket spans tenants,
    /// since the rowid is global.
    ///
    /// `batch` is what keeps that true while a burst's rows are written
    /// together: rowids reserved but not yet inserted are invisible to the
    /// lookup, so two rumors sharing a `created_at` in one burst would both be
    /// handed the same one. It is consulted for exactly as long as the
    /// transaction that reserved them, and the transaction is what excludes the
    /// other writer — `BEGIN IMMEDIATE` takes the write lock before the first of
    /// these reads, so nothing can land between reserving a rowid and using it.
    private func reserveSeq(_ ord: Int, _ rumor: Rumor, _ batch: RumorBatch) throws -> Int64? {
        let base = Self.bucket(rumor.createdAt)

        // The same id twice in one burst is one rumor, and the second copy would
        // otherwise reserve a rowid and collide on the unique index.
        if batch.staged(ord, rumor.id) { return nil }

        // A removed id (see `forget`) answers like a stored one, in the same lookup.
        let row = try db.query(
            """
            SELECT (SELECT seq FROM rumors WHERE tenant = ? AND id = ?) AS existing,
                (SELECT 1 FROM removed_rumors WHERE id = ?) AS removed,
                (SELECT MAX(seq) FROM rumors WHERE seq >= ? AND seq < ?) AS last
            """.collapsedWhitespace,
            [.int(Int64(ord)), .text(rumor.id), .text(rumor.id), .int(base), .int(base + Self.seqSpace)]
        ) { ($0.intOrNull(0), $0.intOrNull(1), $0.intOrNull(2)) }.first

        // Already stored: a re-delivered rumor is a no-op.
        if row?.0 != nil { return nil }
        if row?.1 != nil { return nil }

        let stored = row?.2 ?? base - 1
        let seq = Swift.max(stored, batch.lastSeq(base) ?? base - 1) + 1

        // One second may hold 2²⁰ rumors. Anything that manages more of them at
        // the same timestamp has outgrown this encoding, and silently
        // reordering them — or spilling into the next second's rowids — would
        // be worse than saying so.
        guard seq < base + Self.seqSpace else {
            throw ArmadaDbError.unusable(
                "too many rumors at created_at \(rumor.createdAt)"
            )
        }

        batch.reserve(ord, rumor.id, base, seq)
        return seq
    }

    /// File a rumor's derived terms, in ONE statement however many there are.
    ///
    /// `OR IGNORE` because a policy may return the same term twice, and because
    /// the backfill runs over rows a live write may already have indexed.
    ///
    /// A row per statement was the obvious shape and the wrong one: a NIP-17
    /// message is filed under three terms, so the term index alone tripled the
    /// statements a write costs. The text varies with the count, which is
    /// exactly what a driver's statement cache is for — a policy emits the same
    /// handful of counts forever, so this is a few cached shapes, not one per
    /// write.
    private func insertTerms(_ ord: Int, _ seq: Int64, _ terms: [String]) throws {
        let usable = terms.filter { !$0.isEmpty }
        if usable.isEmpty { return }

        var params: [SqlValue] = []
        params.reserveCapacity(usable.count * 3)
        for term in usable {
            params.append(.int(Int64(ord)))
            params.append(.text(term))
            params.append(.int(seq))
        }

        let values = Array(repeating: "(?, ?, ?)", count: usable.count).joined(separator: ", ")
        try db.run("INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES \(values)", params)
    }

    /// Derive and store the terms of every rumor already in `tenant`, once per
    /// generation of its policy.
    ///
    /// A term can't be computed in SQL — the policy is Swift here and
    /// TypeScript on the other side of the bridge — so a schema migration can't
    /// build this index the way it can rebuild a column. It is filled by
    /// walking the tenant instead, newest-first in pages, and the generation
    /// that walked it is recorded in `rumor_term_tenants` so the pass happens
    /// once per file rather than once per launch.
    ///
    /// A RECORDED generation that differs from `termsGeneration` means the index
    /// holds terms some earlier derivation produced. Those are dropped first:
    /// the walk only inserts, so a term the policy no longer derives would
    /// otherwise survive every rebuild and stay matchable forever.
    ///
    /// Writes made while it runs are not a hazard: they go through the same
    /// policy, and every insert is `OR IGNORE`. The app's engine racing the same
    /// rebuild on the same file is likewise benign, if briefly untidy — both
    /// delete what both are about to re-derive, and the loser's inserts land
    /// anyway.
    ///
    /// At most one attempt per tenant per process, whatever the outcome — which
    /// is what `backfilled` records, and it is marked BEFORE the walk rather
    /// than after it. A failure (an unreadable row, a disk error) leaves the
    /// tenant's index partly built and its generation unrecorded, so the next
    /// launch tries again; retrying inside this one would put a full tenant walk
    /// in front of every term read for as long as the store stays broken. The
    /// failure is swallowed for the same reason the TypeScript engine swallows
    /// it: the read that triggered the pass is answerable from the index as it
    /// stands, and failing it instead would take every DM read down with one bad
    /// row.
    private func backfillTerms(_ tenant: String) {
        if backfilled.contains(tenant) { return }
        backfilled.insert(tenant)
        do {
            try walkTerms(tenant)
        } catch {
            // Partly built, generation unrecorded: the next launch walks it again.
        }
    }

    /// `backfillTerms`'s walk, without its once-per-process bookkeeping.
    private func walkTerms(_ tenant: String) throws {
        // Never written to, so nothing to index — and no ordinal to record the
        // fact against. The next launch asks again, which costs one lookup; rows
        // written in the meantime carry their terms already, since the write
        // path derives them.
        guard let ord = try tenantOrd(tenant) else { return }

        let done = try db.query(
            "SELECT generation FROM rumor_term_tenants WHERE tenant = ?",
            [.int(Int64(ord))]
        ) { $0.int(0) }.first

        if done == termsGeneration { return }
        if done != nil {
            try transaction {
                try db.run("DELETE FROM rumor_terms WHERE tenant = ?", [.int(Int64(ord))])
            }
        }

        var before: Int64?

        while true {
            let sql = before == nil
                ? """
                SELECT seq, \(Self.rumorColumns) FROM rumors INDEXED BY rumors_tenant
                    WHERE tenant = ? ORDER BY seq DESC LIMIT ?
                """
                : """
                SELECT seq, \(Self.rumorColumns) FROM rumors INDEXED BY rumors_tenant
                    WHERE tenant = ? AND seq < ? ORDER BY seq DESC LIMIT ?
                """
            var params: [SqlValue] = [.int(Int64(ord))]
            if let before { params.append(.int(before)) }
            params.append(.int(Int64(Self.backfillPage)))

            let page = try db.query(sql.collapsedWhitespace, params) { row in
                (row.int(0), try Self.rumorFromRow(row, 1))
            }
            if page.isEmpty { break }

            try transaction {
                for (seq, rumor) in page {
                    try insertTerms(ord, seq, termsOf(rumor, tenant))
                }
            }

            before = page[page.count - 1].0
            if page.count < Self.backfillPage { break }
        }

        try transaction {
            try db.run(
                "INSERT OR REPLACE INTO rumor_term_tenants (tenant, generation) VALUES (?, ?)",
                [.int(Int64(ord)), .int(termsGeneration)]
            )
        }
    }

    /// Make sure `tenant`'s term index is complete, if a read is about to
    /// depend on it.
    ///
    /// Only reads that reach the term index wait. An ordinary read is unaffected
    /// by a half-built one, and putting a full pass over the tenant in front of
    /// it would charge every caller for a migration none of them asked about.
    ///
    /// The test is whether a filter carries a `search` AT ALL, not whether it
    /// parsed to a term — the same test `SqliteArmadaDB.ts` makes, and it has to
    /// be, because `distinct:<namespace>` reads `rumor_terms` while parsing to
    /// no term of its own (it is a directive; see `ParsedFilter.distinct`).
    /// Gating on `ParsedFilter.terms` left the NIP-17 conversation list — the
    /// one read that is nothing BUT a collapse — grouping over an index no one
    /// had built, so it listed only conversations written since the upgrade.
    private func awaitTerms(_ tenant: String, _ filters: [ParsedFilter]) {
        guard filters.contains(where: { $0.search != nil }) else { return }
        backfillTerms(tenant)
    }

    /// A rumor's index terms as a single space-separated token string: its
    /// indexed tags, plus `<prefix>:_p:<pubkey>` so an author constraint can be
    /// merged into the same MATCH as the tags.
    ///
    /// The *kind* deliberately gets no token: there are only a handful of kinds
    /// in use, so `_k:1` would be a posting list covering a large share of the
    /// store, and intersecting one of those costs more than testing `kind` on
    /// the rows the tag already found.
    private func tagTokens(_ prefix: String, _ rumor: Rumor) -> String {
        var tokens = [String]()
        var seen = Set<String>()

        func add(_ token: String) {
            if seen.insert(token).inserted { tokens.append(token) }
        }

        add("\(prefix):_p:\(Self.part(rumor.pubkey))")

        for row in indexTags(rumor) {
            guard row.count >= 1, let name = row[0] else { continue }
            guard row.count >= 2, let value = row[1] else { continue }
            add(Self.tagToken(prefix, name, value))
        }

        return tokens.joined(separator: " ")
    }

    /// The integer a tenant's tokens name it by, or nil if the tenant has never
    /// been written to — in which case it holds no rumors, and so no tokens
    /// either.
    ///
    /// Interned rather than derived from the id, so distinct tenants can't
    /// share a prefix. A hash could: truncated, by birthday over ids that are
    /// partly attacker-chosen (`c2:<community id>`), and sharing a prefix means
    /// sharing posting lists, which is a cross-tenant read.
    private func tenantOrd(_ tenant: String) throws -> Int? {
        if let ord = ords[tenant] { return ord }

        // Not a trailing closure: inside a `guard` condition Swift reads one as
        // possibly being the statement's body.
        guard
            let ord = try db.query(
                "SELECT ord FROM tenants WHERE id = ?", [.text(tenant)], { Int($0.int(0)) }
            ).first
        else { return nil }

        ords[tenant] = ord
        return ord
    }

    /// The same, allocating one for a tenant being written to for the first
    /// time.
    private func internTenant(_ tenant: String) throws -> Int {
        if let ord = try tenantOrd(tenant) { return ord }

        try db.run("INSERT OR IGNORE INTO tenants (id) VALUES (?)", [.text(tenant)])

        guard
            let ord = try db.query(
                "SELECT ord FROM tenants WHERE id = ?", [.text(tenant)], { Int($0.int(0)) }
            ).first
        else {
            throw ArmadaDbError.unusable("tenant \(tenant) could not be interned")
        }
        ords[tenant] = ord
        return ord
    }

    /// NIP-09: delete the rumors a kind 5 request targets, within its tenant.
    ///
    /// A request can only delete its author's own rumors, so every target is
    /// checked against the request's `pubkey`. `a` tags additionally only
    /// delete versions at or before the request's `created_at`, so a newer
    /// replacement survives.
    private func applyDeletion(_ ord: Int, _ request: Rumor) throws {
        var seqs = [Int64]()
        var seen = Set<Int64>()

        func collect(_ found: [Int64]) {
            for seq in found where seen.insert(seq).inserted { seqs.append(seq) }
        }

        // A request can't delete itself, and a kind 5 occupies no coordinate, so
        // dropping its own id from the `e` targets is the whole of that rule.
        let eTags = request.tags.compactMap { row -> String? in
            guard row.count >= 2, row[0] == "e", let value = row[1], !value.isEmpty,
                value != request.id
            else { return nil }
            return value
        }
        let aTags = request.tags.compactMap { row -> String? in
            guard row.count >= 2, row[0] == "a", let value = row[1], !value.isEmpty
            else { return nil }
            return value
        }
        if eTags.isEmpty && aTags.isEmpty { return }

        for chunk in Sql.batch(eTags, Self.maxParams - 2) {
            let rows = try db.query(
                "SELECT seq FROM rumors WHERE tenant = ? AND \(Sql.memberOf("id", chunk.count)) AND pubkey = ?",
                [.int(Int64(ord))] + chunk.map { SqlValue.text($0) } + [.text(request.pubkey)]
            ) { $0.int(0) }
            collect(rows)
        }

        // Only one version of a coordinate is ever stored, so an `a` tag
        // resolves to at most one rumor via a primary-key lookup.
        let owned = aTags.filter { tag in
            let parts = tag.components(separatedBy: ":")
            return parts.count >= 2 && parts[1] == request.pubkey
        }

        for chunk in Sql.batch(owned, Self.maxParams - 2) {
            let rows = try db.query(
                """
                SELECT seq FROM rumor_coords
                    WHERE tenant = ? AND \(Sql.memberOf("coord", chunk.count)) AND created_at <= ?
                """.collapsedWhitespace,
                [.int(Int64(ord))] + chunk.map { SqlValue.text($0) }
                    + [.int(request.createdAt)]
            ) { $0.int(0) }
            collect(rows)
        }

        try deleteRumors(ord, seqs)
    }

    /// Delete rumors by rowid, along with any coordinate they occupy. Their
    /// index rows go with them, dropped by the triggers — one statement,
    /// however many tags the rumor had.
    ///
    /// Coordinates are removed by their primary key, recomputed from the stored
    /// rumor, so the coordinate table needs no secondary index on `seq`.
    private func deleteRumors(_ ord: Int, _ seqs: [Int64]) throws {
        if seqs.isEmpty { return }

        for chunk in Sql.batch(seqs, Self.maxParams - 1) {
            let rows = try db.query(
                "SELECT kind, pubkey, tags FROM rumors WHERE \(Sql.memberOf("seq", chunk.count))",
                chunk.map { SqlValue.int($0) }
            ) { (Int($0.int(0)), $0.text(1), $0.text(2)) }

            // Only a coordinate-bearing rumor needs its tags parsed, to find the
            // `d` tag its coordinate is built from.
            let coords =
                rows
                .filter { Kinds.replaceable($0.0) || Kinds.addressable($0.0) }
                .map { Self.coordOf(kind: $0.0, pubkey: $0.1, tagsJson: $0.2) }

            for coordChunk in Sql.batch(coords, Self.maxParams - 1) {
                try db.run(
                    "DELETE FROM rumor_coords WHERE tenant = ? AND \(Sql.memberOf("coord", coordChunk.count))",
                    [.int(Int64(ord))] + coordChunk.map { SqlValue.text($0) }
                )
            }

            try db.run(
                "DELETE FROM rumors WHERE \(Sql.memberOf("seq", chunk.count))",
                chunk.map { SqlValue.int($0) }
            )
        }
    }

    // MARK: - Read path

    /// Rumors in `tenant` matching the filters (OR'd together), newest-first,
    /// de-duplicated by id, each filter's `limit` respected.
    public func query(tenant: String, filters: [[String: Any]]) throws -> [Rumor] {
        lock.lock()
        defer { lock.unlock() }

        let parsed = filters.map { ParsedFilter($0) }
        awaitTerms(tenant, parsed)

        // A tenant that was never written to holds nothing, whatever the
        // filters.
        guard let ord = try tenantOrd(tenant) else { return [] }
        let prefix = "t\(ord)"

        var byId = [String: Rumor]()

        for filter in parsed {
            for rumor in try queryFilter(ord, prefix, tenant, filter) {
                byId[rumor.id] = rumor
            }
        }

        return byId.values.sorted(by: Self.newestFirst)
    }

    /// Run a single parsed filter through the planner.
    private func queryFilter(
        _ ord: Int,
        _ prefix: String,
        _ tenant: String,
        _ filter: ParsedFilter
    ) throws -> [Rumor] {
        if filter.neverMatch { return [] }

        let limit = filter.limit ?? Int.max
        if limit <= 0 { return [] }

        let plan = planScan(ord, prefix, filter)

        // ids plans are lookups by key, not scans.
        if let ids = plan.ids { return try queryIds(ord, ids, filter, limit) }

        // A collapse the index couldn't group is applied here instead: the rows
        // come back in order and the first of each group survives. `limit` still
        // means groups, so a page that collapses to fewer rows is followed by
        // another rather than silently answering short.
        let collapse = filter.distinct != nil && !plan.grouped

        // A cursor yields only rows its conditions kept, and the limit is
        // applied after them, so a single complete plan IS the answer: run it
        // once and read the rumor bodies straight out of it.
        if !collapse && plan.cursors.count == 1 && plan.sqlOnly {
            let rows = try readPage(
                plan.cursors[0],
                before: nil,
                limit: limit == Int.max ? nil : limit,
                keys: false
            )
            return rows.map { $0.rumor }.sorted(by: Self.newestFirst)
        }

        var collected = [Rumor]()
        var seen = Set<String>()
        /// Groups already represented, when collapsing.
        var groups = Set<String>()

        // A complete plan yields only matches, so a page need be no larger than
        // what's still wanted; an incomplete one pages in chunks so a filter
        // that matches little doesn't materialize the whole range. A collapsing
        // one cannot size its page from the limit at all: how many rows a group
        // costs isn't known until they are read.
        var pageSize = plan.sqlOnly && !collapse ? min(limit, Self.maxPage) : Self.chunkSize
        var before: Int64?

        while collected.count < limit {
            let page = try scanPage(plan, before, pageSize)
            if page.isEmpty { break }

            before = page[page.count - 1].seq

            for candidate in page {
                if collected.count >= limit { break }
                if !seen.insert(candidate.rumor.id).inserted { continue }
                if !(plan.sqlOnly || filter.matches(candidate.rumor, skipSearch: plan.searched)) {
                    continue
                }

                if collapse {
                    // A rumor with no term in the namespace belongs to no group
                    // and is excluded — the same "no term, no match" a term
                    // lookup gives.
                    guard let key = filter.collapseKey(termsOf(candidate.rumor, tenant)),
                        groups.insert(key).inserted
                    else { continue }
                }

                collected.append(candidate.rumor)
            }

            // A short page means the scan is exhausted.
            if page.count < pageSize { break }

            // Still short of the limit after a full page, so the conditions are
            // rejecting more than they're keeping. Widening geometrically bounds
            // the number of round trips a very selective filter costs.
            pageSize = min(pageSize * 4, Self.maxPage)
        }

        return collected.sorted(by: Self.newestFirst)
    }

    /// Fetch rumors by id, applying whatever else the filter asks for.
    private func queryIds(
        _ ord: Int,
        _ ids: [String],
        _ filter: ParsedFilter,
        _ limit: Int
    ) throws -> [Rumor] {
        var rumors = [Rumor]()

        for chunk in Sql.batch(ids, Self.maxParams - 16) {
            var conditions = ["tenant = ?", Sql.memberOf("id", chunk.count)]
            var params: [SqlValue] = [.int(Int64(ord))]
            params.append(contentsOf: chunk.map { SqlValue.text($0) })

            if let since = filter.since {
                conditions.append("created_at >= ?")
                params.append(.int(since))
            }
            if let until = filter.until {
                conditions.append("created_at <= ?")
                params.append(.int(until))
            }
            if let kinds = filter.kinds, kinds.count <= Self.maxPushdown {
                conditions.append(Sql.memberOf("kind", kinds.count))
                params.append(contentsOf: kinds.map { SqlValue.int(Int64($0)) })
            }
            if let authors = filter.authors, authors.count <= Self.maxPushdown {
                conditions.append(Sql.memberOf("pubkey", authors.count))
                params.append(contentsOf: authors.map { SqlValue.text($0) })
            }

            let rows = try db.query(
                "SELECT \(Self.rumorColumns) FROM rumors\(Sql.whereClause(conditions))",
                params
            ) { try Self.rumorFromRow($0, 0) }

            for rumor in rows {
                // The SQL already applied the ids byte-exactly; see `matches`.
                if filter.matches(rumor, skipSearch: false, skipIds: true) {
                    rumors.append(rumor)
                }
            }
        }

        let sorted = rumors.sorted(by: Self.newestFirst)
        return sorted.count > limit ? Array(sorted.prefix(limit)) : sorted
    }

    /// Read one page of rumors, newest-first, merging the plan's cursors.
    private func scanPage(_ plan: ScanPlan, _ before: Int64?, _ pageSize: Int) throws
        -> [Candidate]
    {
        if plan.cursors.count == 1 {
            return try readPage(plan.cursors[0], before: before, limit: pageSize)
        }

        var merged = [Candidate]()
        for cursor in plan.cursors {
            merged.append(contentsOf: try readPage(cursor, before: before, limit: pageSize))
        }

        merged.sort { $0.seq > $1.seq }
        return Array(merged.prefix(pageSize))
    }

    /// Read one cursor's next rows, newest-first.
    ///
    /// Both kinds of cursor are read the same way, and the shape is the point:
    /// conditions first, `LIMIT` last. A full-text cursor joins the rows its
    /// index found to the rumors table and tests what the index couldn't carry
    /// THERE, before the limit — so SQLite walks the posting lists backwards
    /// and stops as soon as `limit` rows have survived everything.
    ///
    /// `CROSS JOIN` is load-bearing, and is the whole reason that works. It is
    /// SQLite's one way to fix a join order, and without it a condition on the
    /// rumors table is enough to make the planner drive from THERE instead —
    /// seeking the index by rowid once per row, which re-evaluates the MATCH
    /// every time, and then sorting the result through a temp b-tree. Measured
    /// on a 20k store that is 462ms against 0.16ms.
    private func readPage(
        _ cursor: ScanCursor,
        before: Int64?,
        limit: Int?,
        keys: Bool = true
    ) throws -> [Candidate] {
        var params = [SqlValue]()
        let sql: String

        switch cursor {
        case let .fts(cursor):
            let scan = ftsScan(cursor, before)
            params.append(contentsOf: scan.params)
            params.append(contentsOf: cursor.params)

            sql = """
                SELECT \(keys ? "r.seq, " : "")\(Self.rRumorColumns) FROM \(scan.driver)
                    CROSS JOIN rumors r ON r.seq = \(scan.driver).rowid\
                \(Sql.whereClause(scan.conditions + cursor.where)) \
                ORDER BY \(scan.driver).rowid DESC\(limit == nil ? "" : " LIMIT ?")
                """

        case let .table(cursor):
            var conditions = cursor.where
            params.append(contentsOf: cursor.params)
            // A scan of the rumors table alone is ordered and paged by its own
            // rowid; a scan driven by an index table beside it (`rumor_terms`)
            // is ordered by the copy of that rowid in the driver, so the walk
            // belongs to the index and not to a sort of what it found.
            let key = cursor.key

            if let before {
                conditions.append("\(key) < ?")
                params.append(.int(before))
            }

            // The key is only read when a later page has to resume from it; a
            // scan that answers the whole query in one go leaves the column out.
            sql = """
                SELECT \(keys ? "\(key) AS seq, " : "")\(cursor.columns) FROM \(cursor.from)\
                \(Sql.whereClause(conditions)) \
                ORDER BY \(key) DESC\(limit == nil ? "" : " LIMIT ?")
                """
        }

        if let limit { params.append(.int(Int64(limit))) }

        return try db.query(sql.collapsedWhitespace, params) { row in
            Candidate(
                seq: keys ? row.int(0) : 0,
                rumor: try Self.rumorFromRow(row, keys ? 1 : 0)
            )
        }
    }

    /// Reassemble a rumor from a row's `rumorColumns`, starting at `offset`.
    ///
    /// Throwing rather than skipping. A page whose size the caller reads as
    /// "the scan is exhausted" must not shrink for any reason other than the
    /// scan being exhausted: silently dropping a row would end the walk early
    /// and return a short answer as if it were complete. Every row here was
    /// written by `insertRumor` from a parsed rumor, so an unparseable one is a
    /// corrupt store, and saying so beats quietly serving part of it.
    private static func rumorFromRow(_ row: SqlRow, _ offset: Int) throws -> Rumor {
        guard
            let rumor = Rumor.fromRow(
                id: row.text(offset),
                kind: Int(row.int(offset + 1)),
                pubkey: row.text(offset + 2),
                createdAt: row.int(offset + 3),
                tagsJson: row.text(offset + 4),
                content: row.text(offset + 5)
            )
        else {
            throw ArmadaDbError.unusable("unparseable rumor row")
        }
        return rumor
    }

    /// The index scan behind a full-text cursor: which table drives it, and the
    /// conditions that bound it.
    ///
    /// Tokens drive whenever there are tokens, since the token index also
    /// carries the tenant, the time window and the ordering; a keyword-only
    /// filter drives the content index the same way. Keywords *alongside*
    /// tokens are a second index to intersect with, which FTS5 can't do across
    /// tables, so they are resolved to a set the driving scan tests against.
    private func ftsScan(_ cursor: FtsCursor, _ before: Int64?) -> FtsScan {
        let driver = cursor.match != nil ? "rumor_tags_fts" : "rumors_fts"
        var conditions = ["\(driver) MATCH ?"]
        var params: [SqlValue] = [.text(cursor.match ?? cursor.search ?? "")]

        if cursor.match != nil, let search = cursor.search {
            // The `+` is load-bearing. Without it SQLite hands the rowid list to
            // the *token* index as a constraint, which turns one descending scan
            // into one scan per keyword match; with it, the list stays an
            // ordinary filter over a single scan, and SQLite builds a bloom
            // filter for it.
            conditions.append(
                "+\(driver).rowid IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)"
            )
            params.append(.text(search))
        }

        // Bounded on the driver's own rowid, not on the joined `r.seq`: the
        // point is for FTS5 to receive the range and stop its walk, rather than
        // for the rows to be discarded after it has walked them all.
        if let min = cursor.min {
            conditions.append("\(driver).rowid >= ?")
            params.append(.int(min))
        }

        // The paging bound and the filter's `until` are the same kind of
        // constraint, so whichever is tighter is the one that's applied.
        let max = before.map { $0 - 1 } ?? cursor.max
        if let max {
            conditions.append("\(driver).rowid <= ?")
            params.append(.int(max))
        }

        return FtsScan(driver: driver, conditions: conditions, params: params)
    }

    /// The query planner.
    ///
    /// A filter that names a tag or a keyword is driven by the index, which
    /// finds its rows newest-first and lets the rumors table test what's left.
    /// Anything else is driven by a b-tree, chosen by strfry's priority cascade
    /// — every one of those indexes leads with `tenant` and is ordered by time
    /// already, so each is read newest-first, within one namespace, with no
    /// sorter.
    private func planScan(_ ord: Int, _ prefix: String, _ filter: ParsedFilter) -> ScanPlan {
        let time = Self.timeRange(filter)

        // 0. a collapse — one rumor per term in a namespace. Grouped in the
        //    index when nothing outside it has to be tested; otherwise the
        //    filter is planned as usual and collapsed as the rows come back (see
        //    `queryFilter`), which is the only shape that can honour a row
        //    condition BEFORE the collapse.
        if filter.distinct != nil, let plan = planDistinct(ord, filter, time) { return plan }

        // 1. derived terms — ahead of everything else, including ids, because
        //    nothing else can apply them: they are not in the rumor, so a plan
        //    that didn't resolve them in the index has no way to check them
        //    afterwards.
        if !filter.terms.isEmpty { return planTerms(ord, filter, time) }

        // 2. ids — the (tenant, id) unique index.
        if let ids = filter.ids {
            return ScanPlan(ids: ids, cursors: [], sqlOnly: false, searched: false)
        }

        // Without the content index there is nothing to resolve keywords
        // against, so they fall through to the in-memory match instead.
        let search = self.search ? filter.searchQuery : nil

        // 3. tags, or a NIP-50 search: the index drives.
        if !filter.tags.isEmpty || search != nil {
            if let plan = planFts(ord, prefix, filter, search, time) { return plan }
        }

        /// Append the filter's time bounds to a rumors-table cursor.
        func addTime(_ conditions: inout [String], _ params: inout [SqlValue]) {
            // The rowid bound is what stops the scan early; the `created_at`
            // test is what makes it exact, for the timestamps the encoding has
            // to clamp.
            if let min = time.min {
                conditions.append("seq >= ?")
                params.append(.int(min))
            }
            if let max = time.max {
                conditions.append("seq <= ?")
                params.append(.int(max))
            }
            if let since = filter.since {
                conditions.append("created_at >= ?")
                params.append(.int(since))
            }
            if let until = filter.until {
                conditions.append("created_at <= ?")
                params.append(.int(until))
            }
        }

        let searched = filter.searchKeywords == nil
        let kinds = filter.kinds
        let authors = filter.authors
        let pushKinds = kinds == nil || kinds!.count <= Self.maxPushdown

        // 4. authors + kinds, from the composite index. The seeks land in an
        //    index whose entries are (tenant, pubkey, kind, time) in that order,
        //    so each walks straight to the newest rumors of a combination and
        //    stops.
        if let authors, let kinds, pushKinds {
            let cursors = Sql.batch(authors, Self.maxIn).map { chunk -> ScanCursor in
                var conditions = [
                    "tenant = ?",
                    Sql.memberOf("pubkey", chunk.count),
                    Sql.memberOf("kind", kinds.count),
                ]
                var params: [SqlValue] = [.int(Int64(ord))]
                params.append(contentsOf: chunk.map { SqlValue.text($0) })
                params.append(contentsOf: kinds.map { SqlValue.int(Int64($0)) })
                addTime(&conditions, &params)
                return .table(
                    TableCursor(
                        from: "rumors INDEXED BY rumors_pubkey_kind",
                        where: conditions,
                        params: params
                    )
                )
            }
            return ScanPlan(ids: nil, cursors: cursors, sqlOnly: searched, searched: searched)
        }

        // 5. authors alone, with kinds filtering the scan when there are few
        //    enough of them to be worth binding.
        if let authors {
            let cursors = Sql.batch(authors, Self.maxIn).map { chunk -> ScanCursor in
                var conditions = ["tenant = ?", Sql.memberOf("pubkey", chunk.count)]
                var params: [SqlValue] = [.int(Int64(ord))]
                params.append(contentsOf: chunk.map { SqlValue.text($0) })
                addTime(&conditions, &params)

                if let kinds, pushKinds {
                    conditions.append(Sql.memberOf("kind", kinds.count))
                    params.append(contentsOf: kinds.map { SqlValue.int(Int64($0)) })
                }

                return .table(
                    TableCursor(
                        from: "rumors INDEXED BY rumors_pubkey",
                        where: conditions,
                        params: params
                    )
                )
            }
            return ScanPlan(
                ids: nil, cursors: cursors, sqlOnly: searched && pushKinds, searched: searched
            )
        }

        // 6. kinds.
        if let kinds {
            let cursors = Sql.batch(kinds, Self.maxIn).map { chunk -> ScanCursor in
                var conditions = ["tenant = ?", Sql.memberOf("kind", chunk.count)]
                var params: [SqlValue] = [.int(Int64(ord))]
                params.append(contentsOf: chunk.map { SqlValue.int(Int64($0)) })
                addTime(&conditions, &params)
                return .table(
                    TableCursor(
                        from: "rumors INDEXED BY rumors_kind",
                        where: conditions,
                        params: params
                    )
                )
            }
            return ScanPlan(ids: nil, cursors: cursors, sqlOnly: searched, searched: searched)
        }

        // 7. fallback — the whole tenant, newest-first. `(tenant)` is `(tenant,
        //    seq)`, so this is a backwards walk of one contiguous index range.
        var conditions = ["tenant = ?"]
        var params: [SqlValue] = [.int(Int64(ord))]
        addTime(&conditions, &params)

        return ScanPlan(
            ids: nil,
            cursors: [
                .table(
                    TableCursor(
                        from: "rumors INDEXED BY rumors_tenant",
                        where: conditions,
                        params: params
                    )
                )
            ],
            sqlOnly: searched,
            searched: searched
        )
    }

    /// Plan a `distinct:<namespace>` collapse in the INDEX: one row per term in
    /// the namespace, each the newest under it.
    ///
    /// This is the plan the conversation list exists for. `rumor_terms` is keyed
    /// `(tenant, term, seq)`, so a namespace is one contiguous range and
    /// `GROUP BY term` is an ordered walk of it — no temp b-tree to group, and
    /// `MAX(seq)` is the last row of each block. What comes out is at most one
    /// `seq` per group, so the sorter that orders them by recency sorts
    /// CONVERSATIONS rather than messages, and the join reads exactly one rumor
    /// body per row returned.
    ///
    /// Returns nil — leaving the caller to plan the filter as usual and collapse
    /// the rows afterwards — when anything outside the term index has to be
    /// tested. Row conditions apply BEFORE the collapse, and testing `kind` or
    /// `pubkey` inside the grouping would mean a rowid lookup and a whole row
    /// read per index row, which is precisely the cost this plan exists to avoid.
    /// Extra TERMS are the exception: they live in the same table, so they stay
    /// index-only as an `EXISTS`.
    private func planDistinct(_ ord: Int, _ filter: ParsedFilter, _ time: TimeRange) -> ScanPlan? {
        guard let distinct = filter.distinct, let range = TermRange(namespace: distinct) else {
            return nil
        }

        // Anything a row carries has to narrow the candidates, not the survivors,
        // so it cannot be applied after the grouping — and applying it inside
        // means reading the rows. A time bound the rowid encoding had to clamp
        // counts as one of those, since only `created_at` can settle it.
        if filter.ids != nil || filter.kinds != nil || filter.authors != nil
            || !filter.tags.isEmpty || filter.searchKeywords != nil
            || (!time.exact && (filter.since != nil || filter.until != nil))
        {
            return nil
        }

        var conditions = ["x.tenant = ?", "x.term >= ?"]
        var params: [SqlValue] = [.int(Int64(ord)), .text(range.lower)]

        if let upper = range.upper {
            conditions.append("x.term < ?")
            params.append(.text(upper))
        }
        if let min = time.min {
            conditions.append("x.seq >= ?")
            params.append(.int(min))
        }
        if let max = time.max {
            conditions.append("x.seq <= ?")
            params.append(.int(max))
        }
        for term in filter.terms {
            conditions.append(
                "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)"
            )
            params.append(.text(term))
        }

        let grouped =
            "(SELECT MAX(x.seq) AS seq FROM rumor_terms x\(Sql.whereClause(conditions)) GROUP BY x.term)"

        return ScanPlan(
            ids: nil,
            cursors: [
                .table(
                    TableCursor(
                        from: "\(grouped) g CROSS JOIN rumors r ON r.seq = g.seq",
                        where: [],
                        params: params,
                        key: "g.seq",
                        columns: Self.rRumorColumns
                    )
                )
            ],
            sqlOnly: true,
            searched: true,
            grouped: true
        )
    }

    /// Plan a filter that names derived terms: `rumor_terms` drives, and
    /// everything else is tested on the rows it finds.
    ///
    /// One term is a seek to `(tenant, term)` and a backwards walk of the `seq`
    /// range under it — already time-ordered, so the walk stops at the limit
    /// with no sorter and no bodies read past it. Further terms are `EXISTS`
    /// against the same table, which is a point lookup per candidate rather
    /// than a second scan to intersect.
    ///
    /// The `CROSS JOIN` fixes the join order for the reason it does in
    /// `readPage`: the rumors table must be the INNER side, seeked by rowid, or
    /// a condition on one of its columns is enough to make the planner drive
    /// from there and sort the result afterwards.
    private func planTerms(_ ord: Int, _ filter: ParsedFilter, _ time: TimeRange) -> ScanPlan {
        var conditions = ["x.tenant = ?", "x.term = ?"]
        var params: [SqlValue] = [.int(Int64(ord)), .text(filter.terms[0])]

        if let min = time.min {
            conditions.append("x.seq >= ?")
            params.append(.int(min))
        }
        if let max = time.max {
            conditions.append("x.seq <= ?")
            params.append(.int(max))
        }

        for term in filter.terms.dropFirst() {
            conditions.append(
                "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)"
            )
            params.append(.text(term))
        }

        var complete = true

        // ids are pushed down here rather than taking the ids plan: that plan
        // can't apply a term, and this one can apply an id.
        if let ids = filter.ids {
            if ids.count <= Self.maxPushdown {
                conditions.append(Sql.memberOf("r.id", ids.count))
                params.append(contentsOf: ids.map { .text($0) })
            } else {
                complete = false
            }
        }

        if let kinds = filter.kinds {
            if kinds.count <= Self.maxPushdown {
                conditions.append(Sql.memberOf("r.kind", kinds.count))
                params.append(contentsOf: kinds.map { .int(Int64($0)) })
            } else {
                complete = false
            }
        }

        if let authors = filter.authors {
            if authors.count <= Self.maxPushdown {
                conditions.append(Sql.memberOf("r.pubkey", authors.count))
                params.append(contentsOf: authors.map { .text($0) })
            } else {
                complete = false
            }
        }

        // Timestamps the rowid encoding had to clamp are re-checked exactly.
        if !time.exact {
            if let since = filter.since {
                conditions.append("r.created_at >= ?")
                params.append(.int(since))
            }
            if let until = filter.until {
                conditions.append("r.created_at <= ?")
                params.append(.int(until))
            }
        }

        // Tags and keywords are each a full-text index, and the term index is a
        // third — so rather than intersect indexes (which SQLite cannot do
        // across tables) each is resolved to a rowid set the term's walk tests
        // against. The term drives because it is the selective one: a
        // conversation is a handful of rows where `#p` is everything ever sent
        // to a person.
        if !filter.tags.isEmpty {
            // A value list long enough to need splitting has no split to be
            // given here — there is one statement, not one cursor per chunk —
            // so it goes to the in-memory matcher instead, which reads the tags
            // off rows the term has already narrowed to.
            if filter.tags.contains(where: { $0.values.count > Self.maxOr }) {
                complete = false
            } else {
                conditions.append(
                    "x.seq IN (SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?)"
                )
                params.append(
                    .text(
                        Self.matchExpr(
                            filter.tags.map { tag in
                                tag.values.map { Self.tagToken("t\(ord)", tag.name, $0) }
                            }
                        )
                    )
                )
            }
        }

        let search = self.search ? filter.searchQuery : nil
        let searched = filter.searchKeywords == nil || search != nil

        if let search {
            conditions.append("x.seq IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)")
            params.append(.text(search))
        }

        return ScanPlan(
            ids: nil,
            cursors: [
                .table(
                    TableCursor(
                        from: "rumor_terms x CROSS JOIN rumors r ON r.seq = x.seq",
                        where: conditions,
                        params: params,
                        key: "x.seq",
                        columns: Self.rRumorColumns
                    )
                )
            ],
            sqlOnly: complete && searched,
            searched: searched
        )
    }

    /// Plan a filter as one or more MATCH expressions, or nil when the index
    /// can't drive it.
    ///
    /// Every constraint becomes a group of alternatives — the tag values, the
    /// authors — and the groups are ANDed. FTS5 evaluates that by merging the
    /// groups' doclists, so the cost is the length of the *shortest* group
    /// rather than the product of them all.
    private func planFts(
        _ ord: Int,
        _ prefix: String,
        _ filter: ParsedFilter,
        _ search: String?,
        _ time: TimeRange
    ) -> ScanPlan? {
        var groups = [[String]]()

        for tag in filter.tags {
            groups.append(tag.values.map { Self.tagToken(prefix, tag.name, $0) })
        }

        // A search whose keywords are all negations has nothing for FTS5 to
        // match against — there is no way to say "every row except these" — so
        // it is left to the in-memory matcher, as is any search at all when the
        // content index isn't maintained.
        let searched = filter.searchKeywords == nil || search != nil

        let authors = filter.authors
        // Authors join the tags in the index, where they are one more posting
        // list to intersect. Without a tag to intersect *with*, they are better
        // served by their own b-tree, so they're only added here when there is
        // one — and only while there are few enough of them to be worth merging.
        let inIndex =
            !groups.isEmpty && authors != nil && authors!.count <= Self.maxAuthorTerms

        if inIndex, let authors {
            groups.append(authors.map { "\(prefix):_p:\(Self.part($0))" })
        }

        if groups.isEmpty && search == nil { return nil }

        // Whatever the index isn't carrying is tested on the rows it finds,
        // which is what the rumors table is for. Every condition still ends up
        // in SQL — it just costs a column read on a row already fetched instead
        // of a posting list intersection over the whole store.
        var conditions = [String]()
        var params = [SqlValue]()

        // A token carries its tenant; the content index does not, so a
        // keyword-only scan is the one that has to say so.
        if groups.isEmpty {
            conditions.append("r.tenant = ?")
            params.append(.int(Int64(ord)))
        }

        let kinds = filter.kinds
        if let kinds, kinds.count <= Self.maxPushdown {
            conditions.append(Sql.memberOf("r.kind", kinds.count))
            params.append(contentsOf: kinds.map { SqlValue.int(Int64($0)) })
        }

        if !inIndex, let authors, authors.count <= Self.maxPushdown {
            conditions.append(Sql.memberOf("r.pubkey", authors.count))
            params.append(contentsOf: authors.map { SqlValue.text($0) })
        }

        // Timestamps the rowid encoding had to clamp are re-checked exactly
        // here, rather than in memory.
        if !time.exact {
            if let since = filter.since {
                conditions.append("r.created_at >= ?")
                params.append(.int(since))
            }
            if let until = filter.until {
                conditions.append("r.created_at <= ?")
                params.append(.int(until))
            }
        }

        let complete =
            (kinds == nil || kinds!.count <= Self.maxPushdown)
            && (inIndex || authors == nil || authors!.count <= Self.maxPushdown)

        // The longest group is the one worth splitting: every cursor carries
        // every other group in full, so splitting a short one would repeat more
        // work. Named by INDEX rather than by identity, since an array is a
        // value here and two equal groups would otherwise be indistinguishable.
        let longestIndex = groups.indices.max { groups[$0].count < groups[$1].count }
        let longest = longestIndex.map { groups[$0] } ?? []
        let chunks = longest.count > Self.maxOr ? Sql.batch(longest, Self.maxOr) : [longest]

        let cursors = chunks.map { chunk -> ScanCursor in
            .fts(
                FtsCursor(
                    match: groups.isEmpty
                        ? nil
                        : Self.matchExpr(
                            groups.indices.map { $0 == longestIndex ? chunk : groups[$0] }
                        ),
                    search: search,
                    min: time.min,
                    max: time.max,
                    where: conditions,
                    params: params
                )
            )
        }

        return ScanPlan(
            ids: nil, cursors: cursors, sqlOnly: complete && searched, searched: searched
        )
    }

    /// How many rumors in `tenant` match.
    public func count(tenant: String, filters: [[String: Any]]) throws -> Count {
        lock.lock()
        defer { lock.unlock() }

        // A single complete plan is counted inside the index: no rows returned,
        // no rumor bodies read. One rumor is one row of the token index however
        // many of its tags matched, so nothing has to be de-duplicated.
        if filters.count == 1 {
            let filter = ParsedFilter(filters[0])
            if filter.neverMatch { return Count(0) }
            awaitTerms(tenant, [filter])

            if filter.limit == nil {
                // A tenant that was never written to holds nothing to count.
                guard let ord = try tenantOrd(tenant) else { return Count(0) }

                let plan = planScan(ord, "t\(ord)", filter)

                // A collapse the index could not GROUP is applied while scanning
                // the rows (see `query`), so the index counts rows where the
                // caller asked for groups. `planDistinct` bails on anything it
                // can't test inside the grouping — kinds, authors, a tag, a
                // keyword, an inexact bound — and the filter then falls through
                // to the ordinary cascade, where `COUNT(*)` would answer a
                // conversation list with the number of messages in it. Counted
                // from the rows instead, as every other engine does.
                let collapsed = filter.distinct != nil && !plan.grouped

                if !collapsed && plan.sqlOnly && plan.ids == nil && plan.cursors.count == 1 {
                    var params = [SqlValue]()
                    let sql: String

                    switch plan.cursors[0] {
                    case let .fts(cursor):
                        let scan = ftsScan(cursor, nil)
                        params.append(contentsOf: scan.params)

                        // With nothing left to test, the index knows the answer
                        // by itself. Otherwise the rows still have to be
                        // visited, but only their columns, never their bodies.
                        if !cursor.where.isEmpty {
                            params.append(contentsOf: cursor.params)
                            sql = """
                                SELECT COUNT(*) AS count FROM \(scan.driver)
                                    CROSS JOIN rumors r ON r.seq = \(scan.driver).rowid\
                                \(Sql.whereClause(scan.conditions + cursor.where))
                                """
                        } else {
                            sql =
                                "SELECT COUNT(*) AS count FROM \(scan.driver)\(Sql.whereClause(scan.conditions))"
                        }

                    case let .table(cursor):
                        params.append(contentsOf: cursor.params)
                        sql =
                            "SELECT COUNT(*) AS count FROM \(cursor.from)\(Sql.whereClause(cursor.where))"
                    }

                    let count =
                        try db.query(sql.collapsedWhitespace, params) { $0.int(0) }.first ?? 0
                    return Count(count)
                }
            }
        }

        return Count(Int64(try query(tenant: tenant, filters: filters).count))
    }

    /// Remove every rumor in `tenant` matching the filters.
    /// Remove rumors from this device: delete them from every tenant and refuse
    /// them in any tenant from now on, whichever writer delivers them. The
    /// tombstones land first, in the same transaction. Mirrors `SqliteArmadaDB.forget`.
    public func forget(ids: [String]) throws {
        lock.lock()
        defer { lock.unlock() }

        var seen = Set<String>()
        let unique = ids.filter { !$0.isEmpty && seen.insert($0).inserted }
        if unique.isEmpty { return }

        try transaction {
            for chunk in Sql.batch(unique, Self.maxParams) {
                try db.run(
                    "INSERT OR IGNORE INTO removed_rumors (id) VALUES \(chunk.map { _ in "(?)" }.joined(separator: ", "))",
                    chunk.map { SqlValue.text($0) }
                )
            }
            // `rumors_id` is (tenant, id): one probe per tenant, not a table scan.
            let ords = try db.query("SELECT ord FROM tenants") { Int($0.int(0)) }
            for ord in ords {
                var seqs = [Int64]()
                for chunk in Sql.batch(unique, Self.maxParams - 1) {
                    seqs.append(
                        contentsOf: try db.query(
                            "SELECT seq FROM rumors WHERE tenant = ? AND \(Sql.memberOf("id", chunk.count))",
                            [.int(Int64(ord))] + chunk.map { SqlValue.text($0) }
                        ) { $0.int(0) }
                    )
                }
                try deleteRumors(ord, seqs)
            }
        }
    }

    public func remove(tenant: String, filters: [[String: Any]]) throws {
        lock.lock()
        defer { lock.unlock() }

        // A `distinct:` collapse names one rumor per group, which is not something
        // a deletion can coherently be asked for — and answering it as written
        // would delete the newest message of every conversation. Dropped, so the
        // filter removes nothing, which is the same direction every other
        // unhonourable narrowing takes.
        let deletable = filters.filter { ParsedFilter($0).distinct == nil }
        if deletable.isEmpty { return }

        let rumors = try query(tenant: tenant, filters: deletable)
        if rumors.isEmpty { return }

        // Non-empty results mean the tenant has been written to, so it has an
        // ordinal.
        guard let ord = try tenantOrd(tenant) else { return }

        try transaction {
            var seqs = [Int64]()

            for chunk in Sql.batch(rumors.map { $0.id }, Self.maxParams - 1) {
                seqs.append(
                    contentsOf: try db.query(
                        "SELECT seq FROM rumors WHERE tenant = ? AND \(Sql.memberOf("id", chunk.count))",
                        [.int(Int64(ord))] + chunk.map { SqlValue.text($0) }
                    ) { $0.int(0) }
                )
            }

            try deleteRumors(ord, seqs)
        }
    }

    // MARK: - KV
    //
    // A small key/value store for everything that isn't an event: sync cursors,
    // folded state, settings. Values are opaque JSON TEXT here — the WebView
    // serializes and parses them, so the bridge never has to agree with
    // JavaScript about how a value round-trips.

    /// The stored JSON text for `key`, or nil if the key was never set.
    public func kvGet(_ key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return try db.query("SELECT value FROM kv WHERE key = ?", [.text(key)]) { $0.text(0) }
            .first
    }

    public func kvSet(_ key: String, _ json: String) throws {
        lock.lock()
        defer { lock.unlock() }
        try transaction {
            try db.run(
                """
                INSERT INTO kv (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """.collapsedWhitespace,
                [.text(key), .text(json)]
            )
        }
    }

    public func kvDelete(_ key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        try transaction { try db.run("DELETE FROM kv WHERE key = ?", [.text(key)]) }
    }

    /// The entries a selector picks out — KEY AND JSON TEXT, in one call.
    ///
    /// The order is SQLite's `BINARY` collation (UTF-8 bytes), reversed by
    /// `reverse`; `limit` then takes from the front of it.
    public func kvList(
        prefix: String? = nil,
        start: String? = nil,
        end: String? = nil,
        limit: Int? = nil,
        reverse: Bool = false
    ) throws -> [KvEntry] {
        let range = try KvRange.resolve(prefix: prefix, start: start, end: end)
        if range.empty { return [] }

        lock.lock()
        defer { lock.unlock() }
        return try kvScan(range, limit, reverse)
    }

    /// The scan behind `kvList` and a `.scan` op. Callers already hold `lock`.
    private func kvScan(_ range: KvRange, _ limit: Int?, _ reverse: Bool) throws -> [KvEntry] {
        var conditions = [String]()
        var params = [SqlValue]()
        if let lower = range.lower {
            conditions.append("key >= ?")
            params.append(.text(lower))
        }
        if let upper = range.upper {
            conditions.append("key < ?")
            params.append(.text(upper))
        }

        // A limit only reaches SQL when the scan's own order is the answer's —
        // see `KvRange.exact`. Otherwise the rows dropped below would come off
        // the top of a short page.
        var sql = "SELECT key, value FROM kv"
        if !conditions.isEmpty { sql += " WHERE " + conditions.joined(separator: " AND ") }
        sql += " ORDER BY key"
        if reverse { sql += " DESC" }
        if range.exact, let limit {
            sql += " LIMIT ?"
            params.append(.int(Int64(limit)))
        }

        let entries = try db.query(sql, params) { KvEntry(key: $0.text(0), json: $0.text(1)) }
        // The range is a scan hint, not the contract: SQLite compares UTF-8
        // bytes and the WebView's other adapter compares UTF-16 code units, so
        // a range can admit a key the selector doesn't accept.
        if range.exact { return entries }

        let kept = entries.filter { range.matches($0.key) }
        if let limit, kept.count > limit { return Array(kept.prefix(limit)) }
        return kept
    }

    /// One operation in a `kvOps` batch.
    public enum KvOp {
        case get(key: String)
        case set(key: String, json: String)
        case delete(key: String)
        case scan(
            prefix: String? = nil,
            start: String? = nil,
            end: String? = nil,
            limit: Int? = nil,
            reverse: Bool = false
        )
    }

    /// One op's result: the stored JSON text (or nil) for a `.get`, nil for a
    /// `.set`/`.delete`, the entries for a `.scan`.
    public enum KvResult {
        case value(String?)
        case entries([KvEntry])
    }

    /// Execute a batch of KV operations in arrival order: ONE turn of `lock`,
    /// and one transaction when the batch writes at all. The WebView coalesces
    /// a burst into a single bridge call (`NativeArmadaDB.ts`), so the batch
    /// here IS the burst — per-op calls paid a bridge crossing and a lock turn
    /// each, and the bridge's thread pool never guaranteed their ORDER anyway.
    /// A get or scan later in the batch sees an earlier set, exactly the
    /// read-your-writes the web adapter's op queue defines.
    public func kvOps(_ ops: [KvOp]) throws -> [KvResult] {
        lock.lock()
        defer { lock.unlock() }

        func run() throws -> [KvResult] {
            try ops.map { op in
                switch op {
                case let .get(key):
                    return .value(
                        try db.query("SELECT value FROM kv WHERE key = ?", [.text(key)]) {
                            $0.text(0)
                        }.first
                    )
                case let .set(key, json):
                    try db.run(
                        """
                        INSERT INTO kv (key, value) VALUES (?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value
                        """.collapsedWhitespace,
                        [.text(key), .text(json)]
                    )
                    return .value(nil)
                case let .delete(key):
                    try db.run("DELETE FROM kv WHERE key = ?", [.text(key)])
                    return .value(nil)
                case let .scan(prefix, start, end, limit, reverse):
                    let range = try KvRange.resolve(prefix: prefix, start: start, end: end)
                    return .entries(range.empty ? [] : try kvScan(range, limit, reverse))
                }
            }
        }

        // Reads alone skip BEGIN IMMEDIATE: they take no write lock a second
        // writer would then wait out.
        let writes = ops.contains {
            if case .get = $0 { return false }
            if case .scan = $0 { return false }
            return true
        }
        return writes ? try transaction(run) : try run()
    }

    // MARK: - Driver plumbing

    /// Run `body` inside a transaction. Callers already hold `lock`, which is
    /// what keeps a second writer from splicing statements into this one —
    /// SQLite has no nested transactions, so an interleaved write would be
    /// committed, or rolled back, with someone else's.
    private func transaction<T>(_ body: () throws -> T) throws -> T {
        try db.run("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try db.run("COMMIT")
            return value
        } catch {
            try? db.run("ROLLBACK")
            throw error
        }
    }

    private struct Stored {
        let id: String
        let seq: Int64
        let createdAt: Int64
    }

    private struct FtsScan {
        let driver: String
        let conditions: [String]
        let params: [SqlValue]
    }

    // MARK: - constants and pure helpers

    /// Bits of the rowid reserved for the per-second sequence number.
    private static let seqBits: Int64 = 20

    /// Rowids per second: how many rumors may share one `created_at`.
    static let seqSpace: Int64 = 1 << seqBits

    /// Largest `created_at` the rowid encoding can carry (2106-02-07). Beyond
    /// this the timestamp is clamped, which keeps the rowid small at the cost of
    /// ordering *among* absurdly-dated rumors; plans touching such a rumor fall
    /// back to matching it in memory, so results stay correct either way.
    private static let maxTime: Int64 = 0xffff_ffff

    /// How many candidate rows a paged scan reads per round trip.
    private static let chunkSize = 512

    /// Upper bound on bound parameters per statement. SQLite's own limit is
    /// 32766 on modern builds but only 999 on older ones, so statements are
    /// split well below the floor.
    private static let maxParams = 900

    /// Upper bound on the rows one page of a scan may read.
    private static let maxPage = 10_000

    /// Longest `IN (…)` list driving a scan before it is split.
    private static let maxIn = 500

    /// Most terms one MATCH expression may `OR` together.
    private static let maxOr = 500

    /// Most authors worth folding into the MATCH alongside a tag, rather than
    /// testing on the rows the tag finds. Measured crossover on a 20k store: one
    /// author in the index is 8× faster than the pushdown, sixteen is a wash,
    /// and a hundred is 5× slower.
    private static let maxAuthorTerms = 16

    /// Longest value list used to *filter* (rather than drive) a scan.
    private static let maxPushdown = 100

    /// How many rumors one page of the derived-term backfill re-derives.
    private static let backfillPage = 500

    /// The columns a stored rumor is reassembled from.
    private static let rumorColumns = "id, kind, pubkey, created_at, tags, content"

    /// The same columns read through the `r` alias of a joined scan.
    private static let rRumorColumns =
        "r.id, r.kind, r.pubkey, r.created_at, r.tags, r.content"

    /// Newest-first; ties broken by smaller id first (NIP-01).
    private static func newestFirst(_ a: Rumor, _ b: Rumor) -> Bool {
        if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
        return codeUnitAscending(a.id, b.id)
    }

    /// Lowercase hex digits, so escaping never depends on the default locale.
    private static let hex = Array("0123456789abcdef")

    /// The first rowid belonging to a timestamp, clamped to the encodable range.
    private static func bucket(_ createdAt: Int64) -> Int64 {
        Swift.min(Swift.max(createdAt, 0), maxTime) * seqSpace
    }

    /// Whether a rumor has to be written by a statement of its own rather than
    /// staged into its burst's batch.
    ///
    /// Only the ones that READ the rows around them: a replaceable or
    /// addressable rumor resolves its coordinate and deletes what it supersedes,
    /// and a deletion request removes the rumors it names. Both must see the
    /// batch so far and must not see the rest of it — which is what a staged row
    /// can't offer, and what flushing before one of these restores.
    private static func needsOwnStatement(_ rumor: Rumor) -> Bool {
        rumor.kind == 5 || Kinds.replaceable(rumor.kind) || Kinds.addressable(rumor.kind)
    }

    /// Per NIP-01, `a` is "newer" than `b` (same coordinate) when its created_at
    /// is greater, or — on a tie — its id is lexicographically smaller.
    private static func isNewer(
        _ aId: String, _ aTime: Int64, _ bId: String, _ bTime: Int64
    ) -> Bool {
        if aTime > bTime { return true }
        if aTime < bTime { return false }
        return codeUnitAscending(aId, bId)
    }

    /// Encode one part of a tag token.
    ///
    /// Verbatim where possible — rumor ids, pubkeys and Armada's tag names
    /// (`channel`, `stream`, `peer`) already qualify, and they're the values
    /// worth optimizing for. Anything else is hex-escaped, which no tokenizer
    /// will split and no case folding will alter. The two forms can't be
    /// confused: an escaped value starts with `_`, which a verbatim one can
    /// never contain.
    static func part(_ value: String) -> String {
        // The other ports spell this `^[0-9a-z]+$`; a byte test is the same
        // predicate without a regex engine on the write path.
        let verbatim =
            !value.isEmpty
            && value.utf8.allSatisfy {
                (0x30...0x39).contains($0) || (0x61...0x7A).contains($0)
            }
        if verbatim { return value }

        var out = "_"
        out.reserveCapacity(1 + value.utf8.count * 2)
        for byte in value.utf8 {
            out.append(hex[Int(byte >> 4)])
            out.append(hex[Int(byte & 0x0F)])
        }
        return out
    }

    /// The index token for a tag within a tenant, e.g. `t1:e:<id>` or
    /// `t1:t:_c3a9`.
    ///
    /// The tenant prefix can never be mistaken for a tag name, and the reserved
    /// `_p:` author prefix can never be produced by a user's tag: an escaped
    /// name is `_` followed by an EVEN number of hex digits, and `p` is not a
    /// hex digit at all.
    static func tagToken(_ prefix: String, _ name: String, _ value: String) -> String {
        "\(prefix):\(part(name)):\(part(value))"
    }

    /// Build an FTS5 MATCH expression: each group's tokens are alternatives, and
    /// the groups are required together.
    ///
    /// A group with one member is written as a bare phrase rather than a
    /// parenthesized alternation, which is the same query with less for FTS5's
    /// parser to chew through — and single-value groups are the common case.
    private static func matchExpr(_ groups: [[String]]) -> String {
        groups.map { group in
            group.count == 1
                ? phrase(group[0])
                : "(" + group.map(phrase).joined(separator: " OR ") + ")"
        }.joined(separator: " AND ")
    }

    /// A token as an FTS5 phrase. Quoting is what keeps a keyword like `OR` or
    /// `(` from being read as query syntax; embedded quotes are doubled.
    private static func phrase(_ token: String) -> String {
        "\"\(token.replacingOccurrences(of: "\"", with: "\"\""))\""
    }

    /// The `kind:pubkey:d` coordinate of a replaceable or addressable rumor.
    static func coordOf(_ rumor: Rumor) -> String {
        let d = Kinds.addressable(rumor.kind) ? (rumor.tagValue("d") ?? "") : ""
        return "\(rumor.kind):\(rumor.pubkey):\(d)"
    }

    /// The same coordinate, recomputed from stored columns without a full parse.
    static func coordOf(kind: Int, pubkey: String, tagsJson: String) -> String {
        var d = ""
        if Kinds.addressable(kind),
            let parsed = try? JSONSerialization.jsonObject(with: Data(tagsJson.utf8)),
            let tags = parsed as? [Any]
        {
            for entry in tags {
                guard let tag = entry as? [Any], tag.count >= 2 else { continue }
                if tag[0] as? String == "d" {
                    d = tag[1] as? String ?? ""
                    break
                }
            }
        }
        return "\(kind):\(pubkey):\(d)"
    }

    /// The rowid window a filter's `since`/`until` bounds describe, and whether
    /// that window is exact — it isn't when a bound falls outside the range the
    /// rowid encoding can represent, in which case the rumors in the clamped
    /// bucket have to be re-checked against `created_at`.
    private struct TimeRange {
        let min: Int64?
        let max: Int64?
        let exact: Bool
    }

    private static func timeRange(_ filter: ParsedFilter) -> TimeRange {
        var exact = true
        var min: Int64?
        var max: Int64?

        if let since = filter.since {
            if since > maxTime || since < 0 { exact = false }
            min = bucket(since)
        }

        if let until = filter.until {
            if until > maxTime || until < 0 { exact = false }
            max = bucket(until) + seqSpace - 1
        }

        return TimeRange(min: min, max: max, exact: exact)
    }
}

/// One entry from `SqliteArmadaDb.kvList`: a key and the JSON text under it.
public struct KvEntry: Equatable {
    public let key: String
    public let json: String

    public init(key: String, json: String) {
        self.key = key
        self.json = json
    }
}

/// A KV selector reduced to what the scan needs: a half-open key range, plus the
/// prefix the range is only an approximation of. A port of `resolveKvRange` in
/// `src/lib/db/types.ts`.
///
/// Every comparison here is over UTF-16 CODE UNITS, because that is what
/// JavaScript and Kotlin compare and the bounds have to derive identically on
/// all three. Swift's own `<` compares by Unicode canonical equivalence, which
/// would put a decomposed `é` in a different place than the web adapter does.
struct KvRange {
    /// Inclusive lower bound; nil means unbounded below.
    let lower: String?
    /// Exclusive upper bound; nil means unbounded above.
    let upper: String?
    /// Keys must start with this. Empty when the selector named no prefix.
    let prefix: String
    /// Whether the bounds cross, so nothing can match.
    let empty: Bool
    /// Whether the bounds alone select exactly the keys the selector accepts, so
    /// `matches` can only ever agree with them — and a `limit` may be pushed
    /// into the scan. See the TypeScript original for why a bound holding a
    /// surrogate spoils it.
    let exact: Bool

    /// Whether `key` is genuinely in range — the contract the bounds
    /// approximate.
    func matches(_ key: String) -> Bool {
        if !prefix.isEmpty && !key.hasPrefix(prefix) { return false }
        if let lower, codeUnitAscending(key, lower) { return false }
        if let upper, !codeUnitAscending(key, upper) { return false }
        return true
    }

    /// - Throws: `ArmadaDbError.unusable` if a prefix comes with both bounds.
    static func resolve(prefix: String?, start: String?, end: String?) throws -> KvRange {
        let pre = prefix ?? ""
        if !pre.isEmpty && start != nil && end != nil {
            throw ArmadaDbError.unusable(
                "a KV selector cannot combine a prefix with both start and end"
            )
        }

        // The bounds are the INTERSECTION of what the prefix implies and what
        // the caller asked for, so a `start` outside the prefix narrows to
        // nothing rather than escaping it.
        let prefixUpper = prefixUpperBound(pre)
        let lower: String? =
            if let start, codeUnitAscending(pre, start) { start } else { pre.isEmpty ? nil : pre }
        let upper: String? =
            if let end, prefixUpper == nil || codeUnitAscending(end, prefixUpper!) {
                end
            } else {
                prefixUpper
            }

        let openEndedPrefix = !pre.isEmpty && upper == nil
        let exact = !openEndedPrefix && !hasSurrogate(lower) && !hasSurrogate(upper)

        return KvRange(
            lower: lower,
            upper: upper,
            prefix: pre,
            empty: lower != nil && upper != nil && !codeUnitAscending(lower!, upper!),
            exact: exact
        )
    }

    /// The exclusive upper bound of the key range starting with `prefix`, or nil
    /// when there isn't one — an empty prefix, or one ending in the maximal code
    /// unit, both of which are open-ended.
    ///
    /// Incrementing the last code unit can land on an unpaired surrogate, which
    /// the other two ports can hold in a string and Swift cannot. That case
    /// returns nil, which makes the prefix open-ended and so `exact` false — the
    /// scan widens and `matches` does the real work, rather than the bound
    /// silently becoming U+FFFD.
    static func prefixUpperBound(_ prefix: String) -> String? {
        if prefix.isEmpty { return nil }

        var units = Array(prefix.utf16)
        guard let last = units.last, last != 0xFFFF else { return nil }
        units[units.count - 1] = last + 1

        let bumped = String(decoding: units, as: UTF16.self)
        // `String(decoding:)` repairs ill-formed sequences instead of failing,
        // so the only way to know it was representable is to encode it back.
        guard Array(bumped.utf16) == units else { return nil }
        return bumped
    }

    private static func hasSurrogate(_ text: String?) -> Bool {
        guard let text else { return false }
        return text.utf16.contains { (0xD800...0xDFFF).contains($0) }
    }
}

/// A row a scan produced: the rumor, and the rowid a later page resumes from.
private struct Candidate {
    let seq: Int64
    let rumor: Rumor
}

/// One scan: either a full-text match over a window of rowids, or a b-tree scan
/// over the rumors table.
private enum ScanCursor {
    case fts(FtsCursor)
    case table(TableCursor)
}

/// A full-text scan, bounded by the filter's time range: a token expression, a
/// NIP-50 keyword expression, or both, plus whatever conditions are left for the
/// rumors rows it finds.
private struct FtsCursor {
    let match: String?
    let search: String?
    let min: Int64?
    let max: Int64?
    /// Conditions on the matched rumors, as `r.column …`.
    let `where`: [String]
    let params: [SqlValue]
}

/// A b-tree scan: the rumors table with a forced index, or an index table
/// joined to it (the derived-term index).
private struct TableCursor {
    let from: String
    let `where`: [String]
    let params: [SqlValue]
    /// The expression the scan is ordered and paged by.
    ///
    /// A join names it on the DRIVING table (`x.seq`), which is what keeps the
    /// walk inside that table's index instead of sorting whatever the join
    /// produced.
    var key: String = "seq"
    /// The rumor columns, aliased when the scan is a join.
    var columns: String = "id, kind, pubkey, created_at, tags, content"
}

/// A planned scan: how to fetch a single filter's rumors.
private struct ScanPlan {
    /// For ids plans: fetch these keys directly instead of scanning.
    let ids: [String]?
    /// Normally one scan. A filter with a value list too long for a single MATCH
    /// — or for one statement's parameter budget — is split into several, merged
    /// by the caller.
    let cursors: [ScanCursor]
    /// Whether the cursors express the filter completely.
    let sqlOnly: Bool
    /// Whether the plan applies the filter's NIP-50 keywords itself.
    let searched: Bool
    /// Whether the cursor already yields one row per `distinct:` group. When it
    /// doesn't, a collapsed filter is collapsed row by row as its pages come
    /// back, and `limit` counts groups rather than rows — so no limit may be
    /// pushed into the SQL.
    var grouped: Bool = false
}

/// Parameters one staged INSERT will carry.
///
/// SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is 32766 in every build this schema
/// requires, but was 999 for a decade before 3.32 and is a compile-time option
/// any packager may still set. A budget below the old default costs nothing
/// measurable, since the trigger overhead this batching exists to amortize is
/// already gone by ~100 rows a statement, and it cannot be the thing that breaks
/// on a platform nobody tested.
private let batchParams = 900

/// One burst's rows, staged for a multi-row INSERT per table.
///
/// It is also the burst's rowid ledger — see `SqliteArmadaDb.reserveSeq` —
/// because a rowid reserved for a staged row isn't in the table yet and so is
/// invisible to the lookup that reserves the next one.
///
/// Lives exactly as long as one transaction. Nothing here outlives a commit,
/// which is what keeps the ledger from becoming a cache of what another writer
/// may since have changed. A class rather than a struct so the store's own
/// methods mutate the one instance the transaction threads through them.
private final class RumorBatch {
    /// 8 parameters per row, in `rumors` column order.
    private var rumors: [SqlValue] = []
    /// 2 per row: rowid and its tag tokens.
    private var tags: [SqlValue] = []
    /// 3 per row: tenant, term, rowid.
    private var terms: [SqlValue] = []
    /// `<ord>:<id>` of every rumor reserved in this transaction.
    private var ids: Set<String> = []
    /// The highest rowid handed out per `created_at` bucket.
    private var seqs: [Int64: Int64] = [:]

    /// Whether this transaction already reserved a rowid for (`ord`, `id`).
    func staged(_ ord: Int, _ id: String) -> Bool {
        ids.contains("\(ord):\(id)")
    }

    /// The highest rowid handed out in `base`'s bucket, if any.
    func lastSeq(_ base: Int64) -> Int64? {
        seqs[base]
    }

    /// Record a rowid as taken, before the row it belongs to exists.
    func reserve(_ ord: Int, _ id: String, _ base: Int64, _ seq: Int64) {
        ids.insert("\(ord):\(id)")
        seqs[base] = seq
    }

    func add(_ seq: Int64, _ ord: Int, _ rumor: Rumor, _ tokens: String, _ terms: [String]) {
        rumors.append(contentsOf: [
            .int(seq), .int(Int64(ord)), .text(rumor.id), .int(Int64(rumor.kind)),
            .text(rumor.pubkey), .int(rumor.createdAt), .text(rumor.tagsJson()),
            .text(rumor.content),
        ])

        tags.append(contentsOf: [.int(seq), .text(tokens)])

        for term in terms where !term.isEmpty {
            self.terms.append(contentsOf: [.int(Int64(ord)), .text(term), .int(seq)])
        }
    }

    /// The staged INSERTs, in the order they must run.
    func statements() -> [(String, [SqlValue])] {
        var out: [(String, [SqlValue])] = []
        // Index rows first, so a rumor is never findable before the index that
        // finds it — see `SqliteArmadaDb.writeBatch`.
        append(&out, tags, 2) { "INSERT INTO rumor_tags_fts (rowid, tokens) VALUES \($0)" }
        append(&out, terms, 3) {
            "INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES \($0)"
        }
        append(&out, rumors, 8) {
            """
            INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content) \
            VALUES \($0)
            """
        }
        return out
    }

    /// Drop the staged rows, keeping the ledger for the rest of the transaction.
    func clear() {
        rumors = []
        tags = []
        terms = []
    }

    /// Chunk flat parameters into multi-row INSERTs of at most `batchParams`.
    private func append(
        _ out: inout [(String, [SqlValue])],
        _ params: [SqlValue],
        _ width: Int,
        _ sql: (String) -> String
    ) {
        let perStatement = Swift.max(1, batchParams / width) * width
        var i = 0
        while i < params.count {
            let chunk = Array(params[i ..< Swift.min(i + perStatement, params.count)])
            let values = Array(repeating: "(\(Sql.qs(width)))", count: chunk.count / width)
                .joined(separator: ", ")
            out.append((sql(values), chunk))
            i += perStatement
        }
    }
}

/// The tag name an engine may use to file a term policy's terms in its ORDINARY
/// tag index, rather than in an index of their own — which is what the web
/// client's IndexedDB adapter does (`TERM_TAG` in `src/lib/db/types.ts`), the
/// `indexTags` hook being the only place `NIndexedDB` can add an index term.
///
/// This engine has `rumor_terms` and needs no such thing, but the name is
/// reserved here too: the tag index is content the four engines are held to
/// agree on for identical input, and one that indexed `~` would answer
/// `{"#~": [...]}` for a tag a sender wrote where the others answer nothing.
public let termTag = "~"

/// Default tag index policy: index every tag with a short name and a non-empty
/// value under 200 chars, except the reserved `termTag`. The value length cap is
/// what keeps blobs (a serialized seal, an embedded proof) out of the index.
///
/// The caps count UTF-16 code units, not Characters: the other three engines
/// measure a JavaScript/Kotlin `length`, and `String.count` is grapheme
/// clusters — so a name of twenty combining-mark-bearing graphemes would be
/// indexed here and skipped everywhere else.
public func defaultIndexTags(_ rumor: Rumor) -> [[String?]] {
    rumor.tags.filter { row in
        guard row.count >= 2, let name = row[0], let value = row[1] else { return false }
        return !name.isEmpty && name != termTag && name.utf16.count <= 20
            && !value.isEmpty && value.utf16.count < 200
    }
}
