package buzz.armada.app.db

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The conformance suite for the native ArmadaDB, ported from
 * `src/lib/db/ArmadaDB.test.ts` (the adapter-parity suite) and
 * `src/lib/db/SqliteArmadaDB.test.ts` (the SQLite internals the parity suite
 * can't see: query plans, index upkeep, tokenizer escaping, injection).
 *
 * This runs the REAL engine, not a stand-in: `androidx.sqlite:sqlite-bundled`
 * publishes the same SQLite 3.50.1 for the JVM as it does per Android ABI, so
 * an ordinary unit test exercises the FTS5 features (`contentless_delete`,
 * `automerge`, the `ascii tokenchars` tokenizer) and the JSON1 trigger the
 * schema depends on — which is what makes this suite evidence about the APK
 * rather than about a mock.
 */
class ArmadaDbTest {

    private var driver: RecordingDriver? = null
    private var store: SqliteArmadaDb? = null

    private fun open(search: Boolean = true): SqliteArmadaDb {
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        return SqliteArmadaDb(recording, search = search).also { store = it }
    }

    /**
     * The same store with a stand-in term policy, so the derived-term tests
     * exercise the index rather than NIP-17. The engine never interprets a term
     * — that is the contract — so any policy is as good as the real one here.
     */
    private fun openWithTerms(policy: (Rumor, String) -> List<String>): SqliteArmadaDb {
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        return SqliteArmadaDb(recording, termsOf = policy).also { store = it }
    }

    @After
    fun tearDown() {
        runCatching { store?.close() }
        store = null
        driver = null
    }

    // ── Tenant stores ─────────────────────────────────────────────────────────

    @Test
    fun `stores and queries a rumor`() {
        val db = open()
        val r = rumor(id = "a")
        db.event("c2:abc", r)

        val got = db.query("c2:abc", filters("{\"kinds\":[1]}"))
        assertEquals(listOf("a"), got.map { it.id })
        assertEquals(r.content, got[0].content)
    }

    @Test
    fun `strips a signature rather than storing it`() {
        val db = open()
        val signed = JSONObject(rumor(id = "a").toJson()).put("sig", "f".repeat(128))
        db.event("t", Rumor.parse(signed)!!)

        val got = db.query("t", filters("{}"))
        assertFalse(got[0].toJsonObject().has("sig"))
    }

    @Test
    fun `queries a multi-letter tag`() {
        val db = open()
        val inChannel = rumor(id = "a", tags = listOf(listOf("channel", "chan-1")))
        db.event("c2:abc", inChannel)
        db.event("c2:abc", rumor(id = "b", tags = listOf(listOf("channel", "chan-2"))))

        val got = db.query("c2:abc", filters("{\"#channel\":[\"chan-1\"]}"))
        assertEquals(listOf("a"), got.map { it.id })
    }

    @Test
    fun `isolates rumors between tenants`() {
        val db = open()
        db.event("c2:a", rumor(id = "a"))
        db.event("c2:b", rumor(id = "b"))

        assertEquals(listOf("a"), db.query("c2:a", filters("{}")).map { it.id })
        assertEquals(listOf("b"), db.query("c2:b", filters("{}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("c2:c", filters("{}")).map { it.id })
    }

    @Test
    fun `isolates the tag index between tenants`() {
        val db = open()
        db.event("c2:a", rumor(id = "a", tags = listOf(listOf("channel", "chan-1"))))
        db.event("c2:b", rumor(id = "b", tags = listOf(listOf("channel", "chan-2"))))

        assertEquals(emptyList<String>(), db.query("c2:b", filters("{\"#channel\":[\"chan-1\"]}")).map { it.id })
        assertEquals(listOf("a"), db.query("c2:a", filters("{\"#channel\":[\"chan-1\"]}")).map { it.id })
    }

    @Test
    fun `returns rumors newest first, ties broken by smaller id`() {
        val db = open()
        db.event("t", rumor(id = "b", createdAt = 100))
        db.event("t", rumor(id = "a", createdAt = 100))
        db.event("t", rumor(id = "c", createdAt = 200))

        assertEquals(listOf("c", "a", "b"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `applies each filter's limit`() {
        val db = open()
        for (i in 1..5) db.event("t", rumor(id = "r$i", createdAt = 100L + i))

        assertEquals(listOf("r5", "r4"), db.query("t", filters("{\"limit\":2}")).map { it.id })
    }

    @Test
    fun `ORs several filters and de-duplicates by id`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 1, createdAt = 100))
        db.event("t", rumor(id = "b", kind = 7, createdAt = 200))

        val got = db.query("t", filters("{\"kinds\":[1]}", "{\"kinds\":[1,7]}"))
        assertEquals(listOf("b", "a"), got.map { it.id })
    }

    @Test
    fun `an empty array constraint matches nothing`() {
        val db = open()
        db.event("t", rumor(id = "a"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"ids\":[]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"kinds\":[]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"#e\":[]}")).map { it.id })
    }

    @Test
    fun `a constraint whose values all fail to decode matches nothing`() {
        // Same thing as `[]` once decoded, and the same answer: a narrowing
        // query that isn't understood must not come back with the tenant. It is
        // also what keeps the planner from emitting `IN ()`, which is not SQL.
        val db = open()
        db.event("t", rumor(id = "a", kind = 1))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"kinds\":[\"1\"]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"authors\":[7]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"ids\":[null]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"#e\":\"a\"}")).map { it.id })

        // And it is the CONSTRAINT that fails, not the whole query: a filter
        // with no such key is unaffected.
        assertEquals(listOf("a"), db.query("t", filters("{\"kinds\":[1]}")).map { it.id })
    }

    @Test
    fun `honours ids, authors, kinds and the time window`() {
        val db = open()
        db.event("t", rumor(id = "a", pubkey = "alice", kind = 1, createdAt = 100))
        db.event("t", rumor(id = "b", pubkey = "bob", kind = 1, createdAt = 200))
        db.event("t", rumor(id = "c", pubkey = "alice", kind = 7, createdAt = 300))

        assertEquals(listOf("b"), db.query("t", filters("{\"ids\":[\"b\"]}")).map { it.id })
        assertEquals(listOf("c", "a"), db.query("t", filters("{\"authors\":[\"alice\"]}")).map { it.id })
        assertEquals(listOf("b", "a"), db.query("t", filters("{\"kinds\":[1]}")).map { it.id })
        assertEquals(listOf("a"), db.query("t", filters("{\"authors\":[\"alice\"],\"kinds\":[1]}")).map { it.id })
        assertEquals(listOf("b", "a"), db.query("t", filters("{\"until\":200}")).map { it.id })
        assertEquals(listOf("c", "b"), db.query("t", filters("{\"since\":200}")).map { it.id })
    }

    @Test
    fun `never stores an ephemeral kind`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 20001))

        assertEquals(emptyList<String>(), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `stores a rumor whose tag value is too long to index`() {
        val db = open()
        val huge = "x".repeat(500)
        db.event("t", rumor(id = "a", tags = listOf(listOf("blob", huge))))

        assertEquals(listOf("a"), db.query("t", filters("{}")).map { it.id })
        // Indexed tags cap the value length, so the tag itself is not queryable.
        assertEquals(
            emptyList<String>(),
            db.query("t", listOf(JSONObject().put("#blob", JSONArray().put(huge)))).map { it.id },
        )
    }

    @Test
    fun `re-delivering a rumor is a no-op`() {
        val db = open()
        db.event("t", rumor(id = "a"))
        db.event("t", rumor(id = "a"))

        assertEquals(1, db.query("t", filters("{}")).size)
        assertEquals(1L, db.count("t", filters("{}")).count)
    }

    @Test
    fun `counts and removes`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 1))
        db.event("t", rumor(id = "b", kind = 7))

        assertEquals(2L, db.count("t", filters("{}")).count)
        assertEquals(1L, db.count("t", filters("{\"kinds\":[7]}")).count)
        assertFalse(db.count("t", filters("{}")).approximate)

        db.remove("t", filters("{\"kinds\":[7]}"))
        assertEquals(listOf("a"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `writes a batch as one transaction`() {
        val db = open()
        db.write(
            listOf(
                SqliteArmadaDb.Write("a", rumor(id = "1")),
                SqliteArmadaDb.Write("b", rumor(id = "2")),
            ),
        )

        assertEquals(listOf("1"), db.query("a", filters("{}")).map { it.id })
        assertEquals(listOf("2"), db.query("b", filters("{}")).map { it.id })
    }

    // ── Replaceable rumors ────────────────────────────────────────────────────

    @Test
    fun `a newer replaceable rumor supersedes the older one`() {
        val db = open()
        db.event("t", rumor(id = "old", kind = 0, pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "new", kind = 0, pubkey = "alice", createdAt = 200))

        assertEquals(listOf("new"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `a stale replaceable write is skipped`() {
        val db = open()
        db.event("t", rumor(id = "new", kind = 0, pubkey = "alice", createdAt = 200))
        db.event("t", rumor(id = "old", kind = 0, pubkey = "alice", createdAt = 100))

        assertEquals(listOf("new"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `equal created_at is broken by the smaller id, and the stored one wins`() {
        val db = open()
        db.event("t", rumor(id = "bbb", kind = 0, pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "aaa", kind = 0, pubkey = "alice", createdAt = 100))
        assertEquals(listOf("aaa"), db.query("t", filters("{}")).map { it.id })

        db.event("t", rumor(id = "ccc", kind = 0, pubkey = "alice", createdAt = 100))
        assertEquals(listOf("aaa"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `addressable rumors supersede per d tag`() {
        val db = open()
        db.event("t", rumor(id = "a1", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "one"))))
        db.event("t", rumor(id = "b1", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "two"))))
        db.event("t", rumor(id = "a2", kind = 30000, pubkey = "alice", createdAt = 200, tags = listOf(listOf("d", "one"))))

        assertEquals(setOf("a2", "b1"), db.query("t", filters("{}")).map { it.id }.toSet())
    }

    @Test
    fun `supersession is per tenant and per author`() {
        val db = open()
        db.event("a", rumor(id = "one", kind = 0, pubkey = "alice", createdAt = 100))
        db.event("b", rumor(id = "two", kind = 0, pubkey = "alice", createdAt = 200))
        db.event("a", rumor(id = "three", kind = 0, pubkey = "bob", createdAt = 200))

        assertEquals(setOf("one", "three"), db.query("a", filters("{}")).map { it.id }.toSet())
        assertEquals(listOf("two"), db.query("b", filters("{}")).map { it.id })
    }

    // ── forget (removed from this device) ─────────────────────────────────────

    @Test
    fun `forget deletes the id from every tenant and leaves the rest`() {
        val db = open()
        db.event("a", rumor(id = "gone"))
        db.event("a", rumor(id = "kept"))
        db.event("b", rumor(id = "gone"))

        db.forget(listOf("gone"))

        assertEquals(listOf("kept"), db.query("a", filters("{}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("b", filters("{}")).map { it.id })
    }

    @Test
    fun `forget refuses the id afterwards in any tenant, in a batch and alone`() {
        val db = open()
        db.forget(listOf("gone"))
        db.write(
            listOf(
                SqliteArmadaDb.Write("a", rumor(id = "gone")),
                SqliteArmadaDb.Write("a", rumor(id = "other")),
            ),
        )
        db.event("never-opened", rumor(id = "gone"))

        assertEquals(listOf("other"), db.query("a", filters("{}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("never-opened", filters("{}")).map { it.id })
    }

    @Test
    fun `a removed replaceable is refused without superseding the stored version`() {
        val db = open()
        db.event("t", rumor(id = "old", kind = 10000, pubkey = "alice", createdAt = 100))
        db.forget(listOf("newer"))
        db.event("t", rumor(id = "newer", kind = 10000, pubkey = "alice", createdAt = 200))

        assertEquals(listOf("old"), db.query("t", filters("{\"kinds\":[10000]}")).map { it.id })
    }

    @Test
    fun `the wipe forgets what was removed`() {
        val db = open()
        db.forget(listOf("gone"))
        db.wipe()
        db.event("t", rumor(id = "gone"))

        assertEquals(listOf("gone"), db.query("t", filters("{}")).map { it.id })
    }

    // ── NIP-09 deletion ───────────────────────────────────────────────────────

    @Test
    fun `a kind 5 deletes the author's own targeted rumor`() {
        val db = open()
        db.event("t", rumor(id = "target", pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "del", kind = 5, pubkey = "alice", createdAt = 200, tags = listOf(listOf("e", "target"))))

        // The request itself is retained.
        assertEquals(listOf("del"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `a kind 5 cannot delete another author's rumor`() {
        val db = open()
        db.event("t", rumor(id = "target", pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "del", kind = 5, pubkey = "mallory", createdAt = 200, tags = listOf(listOf("e", "target"))))

        assertEquals(setOf("target", "del"), db.query("t", filters("{}")).map { it.id }.toSet())
    }

    @Test
    fun `a kind 5 deletes by coordinate but spares a newer replacement`() {
        val db = open()
        db.event(
            "t",
            rumor(id = "old", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "x"))),
        )
        db.event(
            "t",
            rumor(id = "del", kind = 5, pubkey = "alice", createdAt = 150, tags = listOf(listOf("a", "30000:alice:x"))),
        )
        assertEquals(listOf("del"), db.query("t", filters("{}")).map { it.id })

        db.event(
            "t",
            rumor(id = "fresh", kind = 30000, pubkey = "alice", createdAt = 200, tags = listOf(listOf("d", "x"))),
        )
        db.event(
            "t",
            rumor(id = "del2", kind = 5, pubkey = "alice", createdAt = 160, tags = listOf(listOf("a", "30000:alice:x"))),
        )
        assertTrue(db.query("t", filters("{}")).any { it.id == "fresh" })
    }

    @Test
    fun `a crafted a tag cannot delete another author's coordinate`() {
        val db = open()
        db.event(
            "t",
            rumor(id = "victim", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "x"))),
        )
        db.event(
            "t",
            rumor(id = "del", kind = 5, pubkey = "mallory", createdAt = 200, tags = listOf(listOf("a", "30000:alice:x"))),
        )

        assertTrue(db.query("t", filters("{}")).any { it.id == "victim" })
    }

    // ── NIP-50 search ─────────────────────────────────────────────────────────

    // A chat kind, so these exercise the content index rather than the in-memory match.
    private fun chat(id: String, content: String, tags: List<List<String>> = emptyList()) =
        rumor(id = id, kind = 9, content = content, tags = tags)

    private fun search(db: SqliteArmadaDb, tenant: String, json: String): List<String> =
        db.query(tenant, filters("{\"kinds\":[9],$json}")).map { it.id }

    @Test
    fun `search matches word prefixes, case and accent insensitively`() {
        val db = open()
        db.event("t", chat("a", "The quick brown fox"))
        db.event("t", chat("b", "CAFÉ society"))

        assertEquals(listOf("a"), search(db, "t", "\"search\":\"BROWN\""))
        assertEquals(listOf("b"), search(db, "t", "\"search\":\"cafe\""))
        // A word being typed finds itself; the middle of a word does not.
        assertEquals(listOf("a"), search(db, "t", "\"search\":\"brow\""))
        assertEquals(emptyList<String>(), search(db, "t", "\"search\":\"rown\""))
    }

    @Test
    fun `search ANDs keywords and honours negation`() {
        val db = open()
        db.event("t", chat("a", "red boat"))
        db.event("t", chat("b", "red anchor"))

        assertEquals(listOf("a"), search(db, "t", "\"search\":\"red -anchor\""))
        assertEquals(emptyList<String>(), search(db, "t", "\"search\":\"red sail\""))
    }

    @Test
    fun `search intersects with a tag-driven scan and is tenant-scoped`() {
        val db = open()
        db.event("a", chat("hit", "red boat", listOf(listOf("channel", "c1"))))
        db.event("a", chat("miss", "blue boat", listOf(listOf("channel", "c1"))))
        db.event("b", chat("other", "red boat"))

        assertEquals(listOf("hit"), search(db, "a", "\"#channel\":[\"c1\"],\"search\":\"red\""))
        assertEquals(listOf("other"), search(db, "b", "\"search\":\"red\""))
    }

    @Test
    fun `only the content kinds are indexed, and the rest are matched in memory`() {
        val db = open()
        db.event("t", chat("message", "harbour lights"))
        db.event("t", rumor(id = "setting", kind = 30078, tags = listOf(listOf("d", "x")), content = "harbour lights"))

        assertEquals(1L, driver!!.query("SELECT COUNT(*) FROM rumors_fts") { it.long(0) }.single())
        assertEquals(listOf("message"), search(db, "t", "\"search\":\"harbour\""))
        // A kind the index doesn't hold is still found, by substring.
        assertEquals(
            listOf("setting"),
            db.query("t", filters("{\"kinds\":[30078],\"search\":\"arbou\"}")).map { it.id },
        )
        assertEquals(2, db.query("t", filters("{\"search\":\"harbour\"}")).size)
    }

    @Test
    fun `an existing file's content index is limited on open, and old entries leave with their rumors`() {
        val db = open()
        val recording = driver!!
        // The insert trigger every file carried before the kind restriction.
        recording.run("DROP TRIGGER rumors_fts_insert")
        recording.run(
            "CREATE TRIGGER rumors_fts_insert AFTER INSERT ON rumors BEGIN " +
                "INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, new.content); END",
        )
        db.event("t", rumor(id = "v1", kind = 30078, createdAt = 100, tags = listOf(listOf("d", "x"))))
        assertEquals(1L, recording.query("SELECT COUNT(*) FROM rumors_fts") { it.long(0) }.single())

        val reopened = SqliteArmadaDb(recording)
        val trigger = recording.query("SELECT sql FROM sqlite_master WHERE name = 'rumors_fts_insert'") { it.text(0) }
        assertTrue(trigger.single().contains("WHEN new.kind IN (9, 14, 15, 1068, 1111)"))
        assertEquals(1L, recording.query("SELECT COUNT(*) FROM rumors_fts") { it.long(0) }.single())

        reopened.event("t", rumor(id = "v2", kind = 30078, createdAt = 200, tags = listOf(listOf("d", "x"))))
        assertEquals(0L, recording.query("SELECT COUNT(*) FROM rumors_fts") { it.long(0) }.single())
    }

    @Test
    fun `a search parsing to no keywords fails closed`() {
        val db = open()
        db.event("t", rumor(id = "a", content = "anything"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"domain:example.com\"}")).map { it.id })
        // A blank search asked for nothing, so it constrains nothing.
        assertEquals(listOf("a"), db.query("t", filters("{\"search\":\"  \"}")).map { it.id })
    }

    @Test
    fun `search still works with the content index off`() {
        val db = open(search = false)
        db.event("t", chat("a", "The quick brown fox"))

        assertEquals(listOf("a"), search(db, "t", "\"search\":\"brown\""))
        // Without the index it is a substring match, matching IndexedDB.
        assertEquals(listOf("a"), search(db, "t", "\"search\":\"rown\""))
    }

    @Test
    fun `a removed rumor disappears from the search index`() {
        val db = open()
        db.event("t", chat("a", "findable"))
        db.remove("t", filters("{\"ids\":[\"a\"]}"))

        assertEquals(emptyList<String>(), search(db, "t", "\"search\":\"findable\""))
    }

    // ── Query plans ───────────────────────────────────────────────────────────

    @Test
    fun `the token index drives a tag filter and rumors is never scanned`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))

        val plans = driver!!.record { db.query("t", filters("{\"#channel\":[\"c1\"],\"kinds\":[1]}")) }

        assertTrue(plans.any { it.contains("rumor_tags_fts") })
        assertTrue(plans.none { it.contains("SCAN rumors") })
    }

    @Test
    fun `an author is folded into the same MATCH as a tag`() {
        val db = open()
        db.event("t", rumor(id = "a", pubkey = "alice", tags = listOf(listOf("channel", "c1"))))

        driver!!.record { db.query("t", filters("{\"#channel\":[\"c1\"],\"authors\":[\"alice\"]}")) }

        val match = driver!!.lastMatchExpression()
        assertTrue(match!!.contains(":_p:alice"))
        assertTrue(match.contains(":channel:c1"))
    }

    @Test
    fun `a filter naming only authors and kinds uses the composite index`() {
        val db = open()
        db.event("t", rumor(id = "a", pubkey = "alice"))

        val plans = driver!!.record { db.query("t", filters("{\"authors\":[\"alice\"],\"kinds\":[1]}")) }
        assertTrue(plans.any { it.contains("rumors_pubkey_kind") })
    }

    @Test
    fun `an unconstrained filter walks the tenant index`() {
        val db = open()
        db.event("t", rumor(id = "a"))

        val plans = driver!!.record { db.query("t", filters("{}")) }
        assertTrue(plans.any { it.contains("rumors_tenant") })
    }

    @Test
    fun `a tag filter on a tenant that was never written short-circuits`() {
        val db = open()
        db.event("other", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))

        driver!!.record { db.query("empty", filters("{\"#channel\":[\"c1\"]}")) }

        // The tenant lookup is the only statement: with no interned ordinal
        // there are no tokens to match, so neither the index nor the table is
        // touched at all.
        assertTrue(driver!!.selects.none { it.first.contains("rumors") })
    }

    @Test
    fun `counting a complete plan never reads a rumor body`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))

        driver!!.record { assertEquals(1L, db.count("t", filters("{\"#channel\":[\"c1\"]}")).count) }
        assertTrue(driver!!.selects.none { it.first.contains("content") })
    }

    // ── Index upkeep ──────────────────────────────────────────────────────────

    @Test
    fun `no token row outlives supersession`() {
        val db = open()
        db.event("t", rumor(id = "old", kind = 0, pubkey = "alice", createdAt = 100, tags = listOf(listOf("channel", "c1"))))
        db.event("t", rumor(id = "new", kind = 0, pubkey = "alice", createdAt = 200, tags = listOf(listOf("channel", "c2"))))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
        assertEquals(listOf("new"), db.query("t", filters("{\"#channel\":[\"c2\"]}")).map { it.id })
    }

    @Test
    fun `no token or coordinate row outlives removal`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 30000, pubkey = "alice", tags = listOf(listOf("d", "x"), listOf("channel", "c1"))))
        db.remove("t", filters("{\"ids\":[\"a\"]}"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
        assertEquals(0L, rowCount("rumor_coords"))
        assertEquals(0L, rowCount("rumors"))

        // The coordinate is free again.
        db.event("t", rumor(id = "b", kind = 30000, pubkey = "alice", createdAt = 50, tags = listOf(listOf("d", "x"))))
        assertEquals(listOf("b"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `wipe empties every table`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))
        db.kvSet("k", "1")
        db.wipe()

        assertEquals(emptyList<String>(), db.query("t", filters("{}")).map { it.id })
        assertEquals(emptyList<KvEntry>(), db.kvList())
        assertEquals(emptyList<String>(), db.tenantIds())
        assertEquals(0L, rowCount("rumors"))
        assertEquals(0L, rowCount("rumor_coords"))

        // The tenant interning starts over without naming the wrong namespace.
        db.event("u", rumor(id = "b", tags = listOf(listOf("channel", "c1"))))
        assertEquals(emptyList<String>(), db.query("t", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
        assertEquals(listOf("b"), db.query("u", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
    }

    // ── Injection ─────────────────────────────────────────────────────────────

    @Test
    fun `a hostile tag value is escaped rather than tokenized`() {
        val db = open()
        val hostile = "c1\" OR \"x\" AND (b"
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", hostile))))
        db.event("t", rumor(id = "b", tags = listOf(listOf("channel", "c1"))))

        val got = db.query("t", listOf(JSONObject().put("#channel", JSONArray().put(hostile))))
        assertEquals(listOf("a"), got.map { it.id })
    }

    @Test
    fun `a tag cannot forge another rumor's author token`() {
        val db = open()
        db.event("t", rumor(id = "victim", pubkey = "alice", tags = listOf(listOf("channel", "c1"))))
        // A tag literally named `_p` would collide with the reserved author
        // prefix if names weren't escaped.
        db.event("t", rumor(id = "forged", pubkey = "mallory", tags = listOf(listOf("_p", "alice"), listOf("channel", "c1"))))

        val got = db.query("t", filters("{\"#channel\":[\"c1\"],\"authors\":[\"alice\"]}"))
        assertEquals(listOf("victim"), got.map { it.id })
    }

    @Test
    fun `a forged token prefix cannot reach another tenant`() {
        val db = open()
        db.event("main", rumor(id = "secret", tags = listOf(listOf("channel", "private"))))
        // `t0`/`t1` are what the tenant prefixes look like; a tag value spelling
        // one out must not become another tenant's posting list.
        db.event("evil", rumor(id = "probe", tags = listOf(listOf("t1", "channel:private"))))

        assertEquals(emptyList<String>(), db.query("evil", filters("{\"#channel\":[\"private\"]}")).map { it.id })
        assertEquals(listOf("secret"), db.query("main", filters("{\"#channel\":[\"private\"]}")).map { it.id })
    }

    @Test
    fun `control characters survive every user-controlled string`() {
        val db = open()
        val nasty = "a\u0000b\u001f\"'\\;--\n\t"
        db.event(nasty, rumor(id = nasty, pubkey = nasty, content = nasty, tags = listOf(listOf(nasty, nasty))))

        val got = db.query(nasty, listOf(JSONObject().put("#$nasty", JSONArray().put(nasty))))
        assertEquals(listOf(nasty), got.map { it.id })
        assertEquals(nasty, got[0].content)
    }

    @Test
    fun `a NUL in a search falls back to the in-memory match`() {
        val db = open()
        db.event("t", chat("a", "hello"))

        // FTS5's query parser is NUL-terminated, so such a keyword can't be put
        // to the index at all; it is matched in memory instead, where it matches
        // nothing rather than quietly searching for "hel".
        val filter = JSONObject().put("kinds", org.json.JSONArray().put(9)).put("search", "hel\u0000lo")
        assertEquals(emptyList<String>(), db.query("t", listOf(filter)).map { it.id })
    }

    @Test
    fun `a hostile kv key round-trips`() {
        val db = open()
        val key = "k\u0000'\";--"
        db.kvSet(key, "{\"a\":1}")

        assertEquals("{\"a\":1}", db.kvGet(key))
        assertEquals(listOf(KvEntry(key, "{\"a\":1}")), db.kvList("k"))
    }

    // ── KV ────────────────────────────────────────────────────────────────────

    @Test
    fun `kv gets, sets, overwrites and deletes`() {
        val db = open()
        assertNull(db.kvGet("missing"))

        db.kvSet("a", "1")
        assertEquals("1", db.kvGet("a"))

        db.kvSet("a", "2")
        assertEquals("2", db.kvGet("a"))

        db.kvDelete("a")
        assertNull(db.kvGet("a"))
        // Deleting a key that was never set is a no-op, not an error.
        db.kvDelete("a")
    }

    @Test
    fun `kv entries are prefix-scanned and ordered`() {
        val db = open()
        for (key in listOf("b:1", "a:2", "a:1", "a:10")) db.kvSet(key, "null")

        assertEquals(listOf("a:1", "a:10", "a:2", "b:1"), db.kvList().map { it.key })
        assertEquals(listOf("a:1", "a:10", "a:2"), db.kvList("a:").map { it.key })
        assertEquals(emptyList<KvEntry>(), db.kvList("zzz"))
    }

    @Test
    fun `kv list carries the value with the key`() {
        val db = open()
        db.kvSet("a:1", "{\"since\":7}")
        db.kvSet("a:2", "null")

        // The JSON text, verbatim: nothing native parses or respells it.
        assertEquals(
            listOf(KvEntry("a:1", "{\"since\":7}"), KvEntry("a:2", "null")),
            db.kvList("a:"),
        )
    }

    @Test
    fun `a prefix is a boundary, not a substring`() {
        val db = open()
        db.kvSet("ab", "null")
        db.kvSet("b", "null")

        assertEquals(listOf("ab"), db.kvList("a").map { it.key })
    }

    @Test
    fun `kv list scans a half-open range`() {
        val db = open()
        for (key in listOf("a", "b", "c", "d")) db.kvSet(key, "null")

        // `start` inclusive, `end` exclusive.
        assertEquals(listOf("b", "c"), db.kvList(start = "b", end = "d").map { it.key })
        assertEquals(listOf("c", "d"), db.kvList(start = "c").map { it.key })
        assertEquals(listOf("a"), db.kvList(end = "b").map { it.key })
    }

    @Test
    fun `kv list resumes a prefix scan from a cursor`() {
        val db = open()
        for (n in 1..4) db.kvSet("log:$n", "null")

        assertEquals(listOf("log:3", "log:4"), db.kvList("log:", start = "log:3").map { it.key })
        assertEquals(listOf("log:1", "log:2"), db.kvList("log:", end = "log:3").map { it.key })
    }

    @Test
    fun `kvOps executes a mixed batch in arrival order`() {
        val db = open()

        // Read-your-writes inside one batch: each get sees the set before it.
        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Set("a", "1"),
                SqliteArmadaDb.KvOp.Get("a"),
                SqliteArmadaDb.KvOp.Set("a", "2"),
                SqliteArmadaDb.KvOp.Get("a"),
                SqliteArmadaDb.KvOp.Delete("a"),
                SqliteArmadaDb.KvOp.Get("a"),
            ),
        )

        assertEquals(listOf(null, "1", null, "2", null, null), results)
        assertNull(db.kvGet("a"))
    }

    @Test
    fun `kvOps scan sees earlier writes in the same batch`() {
        val db = open()

        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Set("p:1", "1"),
                SqliteArmadaDb.KvOp.Set("p:2", "2"),
                SqliteArmadaDb.KvOp.Scan(prefix = "p:"),
            ),
        )

        assertEquals(listOf(KvEntry("p:1", "1"), KvEntry("p:2", "2")), results[2])
    }

    @Test
    fun `kvOps answers a read-only batch without a transaction`() {
        val db = open()
        db.kvSet("k", "\"v\"")

        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Get("k"),
                SqliteArmadaDb.KvOp.Get("missing"),
                SqliteArmadaDb.KvOp.Scan(prefix = "zzz"),
            ),
        )

        assertEquals("\"v\"", results[0])
        assertNull(results[1])
        assertEquals(emptyList<KvEntry>(), results[2])
    }

    @Test
    fun `kvOps scan honors range, limit and reverse like kvList`() {
        val db = open()
        for (n in 1..4) db.kvSet("log:$n", "null")

        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Scan(prefix = "log:", start = "log:3"),
                SqliteArmadaDb.KvOp.Scan(prefix = "log:", limit = 2),
                SqliteArmadaDb.KvOp.Scan(prefix = "log:", reverse = true, limit = 1),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        fun keys(i: Int) = (results[i] as List<KvEntry>).map { it.key }
        assertEquals(listOf("log:3", "log:4"), keys(0))
        assertEquals(listOf("log:1", "log:2"), keys(1))
        assertEquals(listOf("log:4"), keys(2))
    }

    @Test
    fun `a range bound stays inside its prefix`() {
        val db = open()
        db.kvSet("p:1", "null")
        db.kvSet("q:1", "null")

        // A bound outside the prefix narrows to nothing rather than escaping it.
        assertEquals(emptyList<KvEntry>(), db.kvList("p:", start = "q:"))
        assertEquals(emptyList<KvEntry>(), db.kvList("p:", end = "a"))
        assertEquals(listOf("p:1"), db.kvList("p:", start = "a").map { it.key })
    }

    @Test
    fun `kv list is empty when the bounds cross`() {
        val db = open()
        db.kvSet("b", "null")

        assertEquals(emptyList<KvEntry>(), db.kvList(start = "z", end = "a"))
        assertEquals(emptyList<KvEntry>(), db.kvList(start = "b", end = "b"))
    }

    @Test
    fun `kv list refuses a prefix given both bounds`() {
        val db = open()

        // The bounds already describe the range; a prefix on top of them is
        // either redundant or a contradiction.
        assertThrows(IllegalArgumentException::class.java) {
            db.kvList("p:", start = "p:1", end = "p:9")
        }
    }

    @Test
    fun `kv list limits and reverses`() {
        val db = open()
        for (n in 1..3) db.kvSet("p:$n", "null")

        assertEquals(listOf("p:1", "p:2"), db.kvList("p:", limit = 2).map { it.key })
        assertEquals(emptyList<KvEntry>(), db.kvList("p:", limit = 0))
        assertEquals(listOf("p:3", "p:2", "p:1"), db.kvList("p:", reverse = true).map { it.key })
        // A limit takes from the front of the order it was asked for, so
        // reversing makes it the LAST entries.
        assertEquals(listOf("p:3"), db.kvList("p:", limit = 1, reverse = true).map { it.key })
    }

    @Test
    fun `a prefix ending in the maximal code unit scans open-ended`() {
        val db = open()
        val prefix = "x\uffff"
        db.kvSet("${prefix}1", "null")
        db.kvSet("y", "null")

        // There is no exclusive upper bound for this prefix, so the range is
        // open-ended and everything above it is read and then filtered. What
        // comes back must still be only genuine matches — never the tail of the
        // store, and never a page filled out to `limit` from beyond the prefix.
        assertEquals(emptyList<KvEntry>(), db.kvList(prefix))
        assertEquals(emptyList<KvEntry>(), db.kvList(prefix, limit = 2))

        // ENGINE NOTE: the bundled SQLite's JNI boundary replaces U+FFFF (a
        // Unicode noncharacter) with U+FFFD, so a key containing one cannot
        // round-trip and can never match a prefix spelling the original. The
        // web build's adapters keep it verbatim. Nothing Armada stores is
        // affected — no tenant id, cursor key or cache key is built from
        // noncharacters — but a future key space must not assume otherwise.
        assertEquals(listOf("x\ufffd1", "y"), db.kvList().map { it.key })
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun rowCount(table: String): Long =
        driver!!.query("SELECT COUNT(*) FROM $table") { it.long(0) }.first()

    // ── Derived terms ─────────────────────────────────────────────────────────
    //
    // The term index: facts a policy computes from a rumor, queried as NIP-50
    // extension tokens. Ported from `ArmadaDB.test.ts`'s "derived terms" block,
    // and NIP-17-free for the same reason it is there — the engine never
    // interprets a term.

    /** Files each rumor under the sorted set of its `p` tags. */
    private val peersPolicy: (Rumor, String) -> List<String> = { rumor, _ ->
        val set = rumor.tags.filter { it.getOrNull(0) == "p" }.mapNotNull { it.getOrNull(1) }
            .distinct().sorted()
        if (set.isEmpty()) emptyList() else listOf("conv:" + set.joinToString(""))
    }

    /** Every `p` tag as its own term, so one rumor carries several. */
    private val eachPolicy: (Rumor, String) -> List<String> = { rumor, _ ->
        rumor.tags.filter { it.getOrNull(0) == "p" }.mapNotNull { it.getOrNull(1) }.map { "with:$it" }
    }

    @Test
    fun `selects exactly the rumors a policy filed under a term`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "pair", tags = listOf(listOf("p", "ana"), listOf("p", "ben"))))
        db.event("t", rumor(id = "ana", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "ben", tags = listOf(listOf("p", "ben"))))

        // The exact set, and neither of the 1:1s that share its members — which
        // is the whole thing a tag filter cannot express.
        assertEquals(listOf("pair"), db.query("t", filters("{\"search\":\"conv:anaben\"}")).map { it.id })
        assertEquals(listOf("ana"), db.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id })
        assertEquals(listOf("ben"), db.query("t", filters("{\"search\":\"conv:ben\"}")).map { it.id })
    }

    @Test
    fun `requires every term a filter names`() {
        val db = openWithTerms(eachPolicy)
        db.event("t", rumor(id = "both", createdAt = 200, tags = listOf(listOf("p", "ana"), listOf("p", "ben"))))
        db.event("t", rumor(id = "one", createdAt = 100, tags = listOf(listOf("p", "ana"))))

        assertEquals(listOf("both", "one"), db.query("t", filters("{\"search\":\"with:ana\"}")).map { it.id })
        // Conditions within a filter AND, terms included.
        assertEquals(listOf("both"), db.query("t", filters("{\"search\":\"with:ana with:ben\"}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"with:ana with:cy\"}")).map { it.id })
    }

    @Test
    fun `matches nothing for a term in a tenant that derives none`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("p", "ana"))))

        // Fails closed, exactly like an unsupported NIP-50 extension: a
        // narrowing query that can't be honored answers with nothing.
        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id })
        assertEquals(0L, db.count("t", filters("{\"search\":\"conv:ana\"}")).count)
    }

    @Test
    fun `a term cannot be forged by a tag the sender wrote`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "real", tags = listOf(listOf("p", "ana"))))
        // A sender claiming a term for a conversation they are not in. Terms
        // live in their own table, so there is nothing here for a tag to reach.
        db.event("t", rumor(id = "fake", tags = listOf(listOf("conv", "ana"), listOf("~", "conv:ana"))))

        assertEquals(listOf("real"), db.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id })
    }

    @Test
    fun `narrows a term alongside the filter's other constraints`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "kept", kind = 14, pubkey = "ana", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "wrongkind", kind = 7, pubkey = "ana", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "wrongauthor", kind = 14, pubkey = "ben", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "wrongconv", kind = 14, pubkey = "ana", tags = listOf(listOf("p", "ben"))))

        val got = db.query("t", filters("{\"search\":\"conv:ana\",\"kinds\":[14],\"authors\":[\"ana\"]}"))
        assertEquals(listOf("kept"), got.map { it.id })
    }

    @Test
    fun `applies the limit to the term's own rows`() {
        val db = openWithTerms(peersPolicy)
        // Interleaved, so a limit applied before the term would come back short.
        for (i in 0 until 6) {
            db.event("t", rumor(id = "ana-$i", createdAt = 100 + i * 2L, tags = listOf(listOf("p", "ana"))))
            db.event("t", rumor(id = "ben-$i", createdAt = 101 + i * 2L, tags = listOf(listOf("p", "ben"))))
        }

        val got = db.query("t", filters("{\"search\":\"conv:ana\",\"limit\":3}"))
        assertEquals(listOf("ana-5", "ana-4", "ana-3"), got.map { it.id })
    }

    @Test
    fun `finds a match far below a term's newest rows`() {
        val db = openWithTerms(peersPolicy)
        // One matching rumor, underneath a term's whole history. An adapter that
        // narrows in memory has to read down to it — and one that pages while
        // doing so must page until the range is EXHAUSTED, not until some budget
        // is: a search budget dressed as a page limit turns a rumor that exists
        // into one the store denies having.
        db.event("t", rumor(id = "deep", createdAt = 100, content = "needle", tags = listOf(listOf("p", "ana"))))
        for (i in 0 until 200) {
            db.event("t", rumor(id = "hay-$i", createdAt = 200 + i.toLong(), content = "hay", tags = listOf(listOf("p", "ana"))))
        }

        val got = db.query("t", filters("{\"search\":\"conv:ana needle\",\"limit\":1}"))
        assertEquals(listOf("deep"), got.map { it.id })
    }

    @Test
    fun `finds a match among more rumors than a page, all at one timestamp`() {
        val db = openWithTerms(peersPolicy)
        // Every rumor shares a `created_at`, so a pager walking a time bound can
        // never advance past them — the whole second is one boundary. Reading a
        // page and stepping below its oldest row would skip the rest of it.
        for (i in 0 until 200) {
            db.event("t", rumor(id = "tie-$i", createdAt = 500, content = "hay", tags = listOf(listOf("p", "ana"))))
        }
        db.event("t", rumor(id = "zz-buried", createdAt = 500, content = "needle", tags = listOf(listOf("p", "ana"))))

        val got = db.query("t", filters("{\"search\":\"conv:ana needle\",\"limit\":1}"))
        assertEquals(listOf("zz-buried"), got.map { it.id })
    }

    @Test
    fun `drives a term lookup off its own index, newest-first`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "a", tags = listOf(listOf("p", "ana"))))
        driver!!.selects.clear()
        db.query("t", filters("{\"search\":\"conv:ana\",\"limit\":10}"))

        // The CROSS JOIN is what fixes the join order: the rumors table must be
        // the inner side, seeked by rowid, or a condition on one of its columns
        // makes the planner drive from there and sort afterwards.
        val scan = driver!!.selects.first { it.first.contains("rumor_terms x") }.first
        assertTrue(scan.contains("CROSS JOIN rumors r ON r.seq = x.seq"))
        assertTrue(scan.contains("ORDER BY x.seq DESC"))
        assertTrue(scan.contains("LIMIT ?"))
    }

    @Test
    fun `counts and removes by term`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "ana", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "ben", tags = listOf(listOf("p", "ben"))))

        assertEquals(1L, db.count("t", filters("{\"search\":\"conv:ana\"}")).count)
        db.remove("t", filters("{\"search\":\"conv:ana\"}"))
        assertEquals(listOf("ben"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `forgets a term when its rumor is deleted`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "gone", pubkey = "ana", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "req", kind = 5, pubkey = "ana", tags = listOf(listOf("e", "gone"))))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id })
        // The trigger cleared the index row, not just the rumor.
        assertEquals(
            emptyList<Long>(),
            driver!!.query("SELECT seq FROM rumor_terms WHERE term = ?", listOf("conv:ana")) { it.long(0) },
        )
    }

    @Test
    fun `keeps a term inside its own tenant`() {
        val db = openWithTerms(peersPolicy)
        db.event("a", rumor(id = "mine", tags = listOf(listOf("p", "ana"))))
        db.event("b", rumor(id = "theirs", tags = listOf(listOf("p", "ana"))))

        assertEquals(listOf("mine"), db.query("a", filters("{\"search\":\"conv:ana\"}")).map { it.id })
    }

    @Test
    fun `combines a term with a keyword`() {
        val db = openWithTerms(peersPolicy)
        db.event("t", rumor(id = "hit", content = "the quick brown fox", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "otherconv", content = "the quick brown fox", tags = listOf(listOf("p", "ben"))))
        db.event("t", rumor(id = "othertext", content = "nothing here", tags = listOf(listOf("p", "ana"))))

        assertEquals(listOf("hit"), db.query("t", filters("{\"search\":\"brown conv:ana\"}")).map { it.id })
    }

    @Test
    fun `indexes rows that were already stored when the policy arrived`() {
        // The service and the WebView open the same file, and a policy can be
        // added by an app update — so the rows already there have to be walked
        // once. Reads that name a term wait for that; ordinary reads don't.
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        val before = SqliteArmadaDb(recording, migrate = true).also { store = it }
        before.event("t", rumor(id = "old", createdAt = 100, tags = listOf(listOf("p", "ana"))))

        val after = SqliteArmadaDb(recording, termsOf = peersPolicy).also { store = it }
        after.event("t", rumor(id = "fresh", createdAt = 200, tags = listOf(listOf("p", "ana"))))

        assertEquals(
            listOf("fresh", "old"),
            after.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id },
        )

        // And only once: the second store records that it walked the tenant.
        val third = SqliteArmadaDb(recording, termsOf = { _, _ -> error("re-walked") })
            .also { store = it }
        assertEquals(
            listOf("fresh", "old"),
            third.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id },
        )
    }

    @Test
    fun `re-derives every term when the generation changes`() {
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        val first = SqliteArmadaDb(recording, termsOf = peersPolicy, termsGeneration = 1)
            .also { store = it }
        first.event("t", rumor(id = "stored", tags = listOf(listOf("p", "ana"))))
        assertEquals(
            listOf("stored"),
            first.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id },
        )

        // The same rows, a different derivation. Both halves matter: the new
        // term has to reach rows written before it, and the old one has to STOP
        // matching — an index that only ever gains terms would keep answering a
        // lookup no policy derives any more.
        val renamed = SqliteArmadaDb(recording, termsOf = eachPolicy, termsGeneration = 2)
            .also { store = it }
        assertEquals(
            listOf("stored"),
            renamed.query("t", filters("{\"search\":\"with:ana\"}")).map { it.id },
        )
        assertEquals(
            emptyList<String>(),
            renamed.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id },
        )
    }

    @Test
    fun `leaves the index alone when the generation is unchanged`() {
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        val first = SqliteArmadaDb(recording, termsOf = peersPolicy, termsGeneration = 1)
            .also { store = it }
        first.event("t", rumor(id = "stored", createdAt = 100, tags = listOf(listOf("p", "ana"))))
        first.query("t", filters("{\"search\":\"conv:ana\"}"))

        // A different policy at the SAME generation: the marker says this tenant
        // is done, so the pass doesn't run and the stored row keeps the terms it
        // was written with. That is what makes the backfill once-per-file rather
        // than once-per-launch — the generation is the only thing that reopens
        // it.
        val same = SqliteArmadaDb(recording, termsOf = eachPolicy, termsGeneration = 1)
            .also { store = it }
        same.event("t", rumor(id = "later", createdAt = 200, tags = listOf(listOf("p", "ana"))))

        assertEquals(
            listOf("stored"),
            same.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id },
        )
        assertEquals(
            listOf("later"),
            same.query("t", filters("{\"search\":\"with:ana\"}")).map { it.id },
        )
    }

    // ── distinct: collapsing a read to one rumor per group ───────────────────
    //
    // Ported from `ArmadaDB.test.ts`'s "collapsing a read with distinct:" block,
    // and NIP-17-free for the same reason: the engine never interprets a term.

    /**
     * Files each rumor under the sorted set of its `p` tags, in two namespaces —
     * `conv:` for every kind and `msg:` for kind 1 only. That is the shape the DM
     * list uses: a collapse can then name the newest MESSAGE of a conversation
     * without the engine reading any rumor's kind.
     */
    private val convPolicy: (Rumor, String) -> List<String> = { rumor, _ ->
        val set = rumor.tags.filter { it.getOrNull(0) == "p" }.mapNotNull { it.getOrNull(1) }
            .distinct().sorted()
        if (set.isEmpty()) {
            emptyList()
        } else {
            val key = set.joinToString("")
            if (rumor.kind == 1) listOf("conv:$key", "msg:$key") else listOf("conv:$key")
        }
    }

    @Test
    fun `returns the newest rumor of every group`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "ana-old", createdAt = 100, tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "ana-new", createdAt = 300, tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "ben", createdAt = 200, tags = listOf(listOf("p", "ben"))))
        db.event(
            "t",
            rumor(id = "group", createdAt = 150, tags = listOf(listOf("p", "ana"), listOf("p", "ben"))),
        )

        // One row per participant SET, ordered by that row — not the newest
        // rumors, which is what an ungrouped read with a limit would have given.
        assertEquals(
            listOf("ana-new", "ben", "group"),
            db.query("t", filters("{\"search\":\"distinct:conv\"}")).map { it.id },
        )
    }

    @Test
    fun `counts groups against the limit, not rows`() {
        val db = openWithTerms(convPolicy)
        for (i in 0 until 5) {
            db.event("t", rumor(id = "busy-$i", createdAt = 200L + i, tags = listOf(listOf("p", "ana"))))
        }
        db.event("t", rumor(id = "quiet", createdAt = 100, tags = listOf(listOf("p", "ben"))))

        // The old shape's bug in one assertion: the newest two ROWS are two
        // messages of the busy thread and no sign of the quiet one.
        assertEquals(
            listOf("busy-4", "quiet"),
            db.query("t", filters("{\"search\":\"distinct:conv\",\"limit\":2}")).map { it.id },
        )
    }

    @Test
    fun `excludes a rumor with no term in the namespace`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "listed", tags = listOf(listOf("p", "ana"))))
        // In a conversation, but not in the `msg:` grouping.
        db.event("t", rumor(id = "reaction", kind = 7, tags = listOf(listOf("p", "ana"))))
        // In no conversation at all.
        db.event("t", rumor(id = "orphan"))

        assertEquals(
            listOf("listed"),
            db.query("t", filters("{\"search\":\"distinct:msg\"}")).map { it.id },
        )
    }

    @Test
    fun `names one namespace, whatever the delimiter`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "ana", tags = listOf(listOf("p", "ana"))))

        assertEquals(
            listOf("ana"),
            db.query("t", filters("{\"search\":\"distinct:conv\"}")).map { it.id },
        )
        assertEquals(
            listOf("ana"),
            db.query("t", filters("{\"search\":\"distinct:conv:\"}")).map { it.id },
        )
    }

    @Test
    fun `applies the rest of the filter before collapsing`() {
        val db = openWithTerms(convPolicy)
        db.event(
            "t",
            rumor(id = "mine", pubkey = "me", createdAt = 100, tags = listOf(listOf("p", "ana"))),
        )
        db.event(
            "t",
            rumor(id = "theirs", pubkey = "ana", createdAt = 200, tags = listOf(listOf("p", "ana"))),
        )

        // The newest rumor of the group is theirs; the newest MATCHING one is
        // mine. Collapsing first and filtering after would answer with nothing.
        assertEquals(
            listOf("mine"),
            db.query("t", filters("{\"search\":\"distinct:conv\",\"authors\":[\"me\"]}")).map { it.id },
        )
        assertEquals(
            emptyList<String>(),
            db.query("t", filters("{\"search\":\"distinct:conv\",\"kinds\":[7]}")).map { it.id },
        )
    }

    @Test
    fun `bounds the window before collapsing too`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "early", createdAt = 100, tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "late", createdAt = 300, tags = listOf(listOf("p", "ana"))))

        assertEquals(
            listOf("early"),
            db.query("t", filters("{\"search\":\"distinct:conv\",\"until\":200}")).map { it.id },
        )
        assertEquals(
            listOf("late"),
            db.query("t", filters("{\"search\":\"distinct:conv\",\"since\":200}")).map { it.id },
        )
        assertEquals(
            emptyList<String>(),
            db.query("t", filters("{\"search\":\"distinct:conv\",\"since\":400}")).map { it.id },
        )
    }

    @Test
    fun `combines a collapse with a term`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "ana", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "ben", tags = listOf(listOf("p", "ben"))))

        assertEquals(
            listOf("ana"),
            db.query("t", filters("{\"search\":\"distinct:conv conv:ana\"}")).map { it.id },
        )
    }

    @Test
    fun `counts the groups`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "a1", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "a2", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "b1", tags = listOf(listOf("p", "ben"))))

        assertEquals(2L, db.count("t", filters("{\"search\":\"distinct:conv\"}")).count)
    }

    @Test
    fun `counts groups when the filter narrows the rows too`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "a1", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "a2", tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "b1", tags = listOf(listOf("p", "ben"))))
        db.event("t", rumor(id = "c1", kind = 7, tags = listOf(listOf("p", "cat"))))

        // A row condition the index can't test inside the grouping (here
        // `kinds`) makes the collapse happen while scanning instead — and a
        // count that reads its answer out of the index would then count ROWS,
        // reporting a conversation list as the number of messages in it.
        val filter = filters("{\"search\":\"distinct:conv\",\"kinds\":[1]}")
        assertEquals(2L, db.count("t", filter).count)
        assertEquals(2, db.query("t", filter).size)
    }

    @Test
    fun `refuses to remove by a collapse`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "older", createdAt = 100, tags = listOf(listOf("p", "ana"))))
        db.event("t", rumor(id = "newer", createdAt = 200, tags = listOf(listOf("p", "ana"))))

        db.remove("t", filters("{\"search\":\"distinct:conv\"}"))

        assertEquals(
            listOf("newer", "older"),
            db.query("t", filters("{\"search\":\"conv:ana\"}")).map { it.id },
        )
    }

    @Test
    fun `collapse matches nothing in a tenant that derives no terms`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("p", "ana"))))

        assertEquals(
            emptyList<String>(),
            db.query("t", filters("{\"search\":\"distinct:conv\"}")).map { it.id },
        )
    }

    @Test
    fun `collapses rows that were already stored when the policy arrived`() {
        // The pass that indexes a tenant's existing rows is triggered by a read
        // that reaches the term index — and a collapse reaches it while naming
        // no term of its own. Waiting only on a filter's parsed TERMS leaves
        // this read grouping over an index nothing has built, which is the DM
        // list of every install that upgrades into the feature.
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        val before = SqliteArmadaDb(recording, migrate = true).also { store = it }
        before.event("t", rumor(id = "ana-old", createdAt = 100, tags = listOf(listOf("p", "ana"))))
        before.event("t", rumor(id = "ana-new", createdAt = 300, tags = listOf(listOf("p", "ana"))))
        before.event("t", rumor(id = "ben", createdAt = 200, tags = listOf(listOf("p", "ben"))))

        val after = SqliteArmadaDb(recording, termsOf = convPolicy).also { store = it }
        assertEquals(
            listOf("ana-new", "ben"),
            after.query("t", filters("{\"search\":\"distinct:conv\"}")).map { it.id },
        )
    }

    @Test
    fun `refuses two collapses rather than picking one`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "a", tags = listOf(listOf("p", "ana"))))

        assertEquals(
            emptyList<String>(),
            db.query("t", filters("{\"search\":\"distinct:conv distinct:msg\"}")).map { it.id },
        )
    }

    @Test
    fun `refuses a namespace that isn't one`() {
        val db = openWithTerms(convPolicy)
        db.event("t", rumor(id = "a", tags = listOf(listOf("p", "ana"))))

        assertEquals(
            emptyList<String>(),
            db.query("t", filters("{\"search\":\"distinct:conv:ana\"}")).map { it.id },
        )
    }

    @Test
    fun `pins the term generation to the other ports`() {
        // One number, written into a file three engines share: two ports that
        // disagree would each read the other's as stale and rebuild the index on
        // every open. `TERM_GENERATION` in `src/lib/db/termPolicies.ts` and
        // `TermPolicies.generation` in Swift are this literal.
        assertEquals(3L, TermPolicies.GENERATION)
    }

    private fun filters(vararg json: String): List<JSONObject> = json.map { JSONObject(it) }

    private fun rumor(
        id: String,
        pubkey: String = "alice",
        createdAt: Long = 1000,
        kind: Int = 1,
        tags: List<List<String>> = emptyList(),
        content: String = "hello",
    ): Rumor = Rumor.of(id, pubkey, createdAt, kind, tags, content)!!

    /**
     * A driver that remembers the SELECTs a call issued, so a plan can be
     * asserted rather than inferred from timings — the whole point of forcing
     * indexes and of the `CROSS JOIN`.
     */
    private class RecordingDriver(private val inner: ArmadaSqlDriver) : ArmadaSqlDriver {
        val selects = mutableListOf<Pair<String, List<Any?>>>()

        override fun run(sql: String, params: List<Any?>) = inner.run(sql, params)

        override fun <T> query(sql: String, params: List<Any?>, read: (SqlRow) -> T): List<T> {
            if (sql.startsWith("SELECT")) selects.add(sql to params)
            return inner.query(sql, params, read)
        }

        override fun close() = inner.close()

        /** The `EXPLAIN QUERY PLAN` details of every SELECT [body] issued. */
        fun record(body: () -> Unit): List<String> {
            selects.clear()
            body()
            return selects.flatMap { (sql, params) ->
                inner.query("EXPLAIN QUERY PLAN $sql", params) { it.text(3) }
            }
        }

        /** The MATCH expression the last recorded scan bound, if any. */
        fun lastMatchExpression(): String? = selects
            .lastOrNull { it.first.contains("MATCH") }
            ?.second
            ?.firstOrNull() as? String
    }
}
