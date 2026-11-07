package buzz.armada.app.db

import android.content.Context
import android.util.Log
import buzz.armada.app.ServiceProfiler
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the background relay service writes, and where.
 *
 * There is one store: the service writes an event into the same tenant the
 * WebView would have written it to, so a message received while the app was
 * dead is simply THERE on open — no replay, no second copy.
 *
 * "The same tenant" is why [RelayScope] exists here as well as in the WebView:
 * NIP-29 data is stored per relay, and a rule only one of the two writers applies
 * is a disagreement about where a message lives.
 *
 * The drain survives, but only as ROUTING. Storing a message and acting on it
 * are different jobs: wire ingest is what parks undecryptable wraps, rings the
 * scopes that repaint a timeline, and feeds notification candidates. So every
 * event also lands in a per-relay handoff queue
 * ([ArmadaDb.serviceQueueTenant]), which the WebView reads and empties on
 * open/resume (peek+ack: a page is only removed once ingest has committed, so a
 * crash mid-drain replays rather than loses).
 *
 * Failures are logged and swallowed throughout. A notification that arrives
 * without its event having been persisted is a degraded notification; a service
 * that dies on a write error posts nothing at all.
 */
object ServiceStore {

    private const val TAG = "ArmadaDb"

    /** How stale a queued event may get before it is dropped unrouted. */
    private const val QUEUE_MAX_AGE_SECS = 14L * 24 * 3600

    /** Writes between prune passes — the sweep is a scan, not a per-write cost. */
    private const val PRUNE_INTERVAL = 500

    private var writesSincePrune = 0

    /**
     * Store a raw relay event in the tenant it belongs to and queue it for wire
     * ingest, returning whether that tenant ALREADY held it.
     *
     * That return is the durable dedupe floor for NIP-17 gift wraps, whose outer
     * timestamps are backdated by up to two days and so can't be gated on time:
     * a wrap either side ever stored — a previous service incarnation, the
     * WebView's inbox sync, or our own just-published self-copy — must not
     * re-notify.
     *
     * [relayUrl] is the relay the event arrived from, and it decides where NIP-29
     * data lands ([RelayScope]) as well as which queue carries it. Relay-relative
     * data with no relay is not stored at all rather than filed under a guess; the
     * service always has one, since it holds a socket per relay.
     */
    @JvmStatic
    @JvmOverloads
    fun ingest(context: Context, event: JSONObject, relayUrl: String? = null): Boolean {
        val rumor = Rumor.parse(event) ?: return false
        val tenant = RelayScope.tenantFor(rumor, relayUrl) ?: return false
        return profiled("db.ingest") { try {
            val db = ArmadaDb.get(context)
            val stored = db.count(tenant, listOf(idFilter(rumor.id))).count > 0
            db.write(
                listOf(
                    SqliteArmadaDb.Write(tenant, rumor),
                    SqliteArmadaDb.Write(ArmadaDb.serviceQueueTenant(relayUrl), rumor),
                ),
            )
            pruneQueue(db)
            stored
        } catch (error: Throwable) {
            Log.w(TAG, "ingest write failed", error)
            false
        } }
    }

    /**
     * Drop queue entries older than [QUEUE_MAX_AGE_SECS], across every relay's
     * queue.
     *
     * The queue is emptied on every app open or resume, so it only grows on an
     * install whose service runs for weeks without the app being opened — and
     * what accumulates there is pure routing, duplicating rows the tenants
     * already hold. Anything this old has nothing left to route: wire ingest
     * would park wraps whose keys have long since arrived by other means and
     * ring scopes for timelines nobody is looking at.
     *
     * Age rather than count, because the queue is read newest-first and there is
     * no cheap "oldest N" — and because the NIP-59 backdate window is two days,
     * so a cutoff has to be well clear of it to be safe.
     */
    private fun pruneQueue(db: SqliteArmadaDb) {
        if (++writesSincePrune < PRUNE_INTERVAL) return
        writesSincePrune = 0

        val cutoff = System.currentTimeMillis() / 1000 - QUEUE_MAX_AGE_SECS
        val filter = listOf(JSONObject().put("until", cutoff))
        for (tenant in queueTenants(db)) db.remove(tenant, filter)
    }

    /**
     * Every handoff queue: one per relay, plus the retired unscoped queue so a
     * backlog left by the previous build is still drained and pruned.
     */
    private fun queueTenants(db: SqliteArmadaDb): List<String> =
        db.tenantIds().filter {
            it == ArmadaDb.TENANT_SERVICE_QUEUE || it.startsWith(ArmadaDb.TENANT_SERVICE_QUEUE_PREFIX)
        }

    /**
     * Store an event WITHOUT queueing it for ingest — for what the service
     * fetched for its own use (a kind-0 profile, a kind-39000 group name) or
     * acted on itself (NIP-34 git activity). The WebView reads all of it out of
     * the store like any other cached event; it just has nothing to route.
     *
     * Routed by the same rule as [ingest], so the kind-39000 metadata the service
     * fetches to title a notification lands in the tenant the channel list reads
     * — which means [relayUrl] is required for it, and a group-scoped event
     * offered without one is dropped rather than misfiled.
     */
    @JvmStatic
    @JvmOverloads
    fun cache(context: Context, event: JSONObject, relayUrl: String? = null) {
        val rumor = Rumor.parse(event) ?: return
        val tenant = RelayScope.tenantFor(rumor, relayUrl) ?: return
        profiled("db.cache") { try {
            ArmadaDb.get(context).event(tenant, rumor)
        } catch (error: Throwable) {
            Log.w(TAG, "cache write failed", error)
        } }
    }

    /**
     * File one of [self]'s own replaceable documents (see [SelfState]) in the
     * `main` tenant — the same tenant, in the same database file, that the
     * WebView's app-wide event store reads. Returns whether it was stored.
     *
     * No routing queue entry: nothing about a follow list or a settings blob is
     * a notification candidate or needs a pass through wire ingest. The tenant
     * write IS the delivery — the app finds the current version already on disk
     * when it next opens, whether or not any relay is reachable at that moment.
     *
     * The store replaces by `kind:pubkey:d` coordinate for replaceable and
     * addressable kinds, so re-receiving these on every reconnect costs one row
     * each rather than growing a history nobody reads.
     */
    @JvmStatic
    @JvmOverloads
    fun cacheSelfState(
        context: Context,
        event: JSONObject,
        self: String,
        dTags: Set<String> = SelfState.DEFAULT_D_TAGS,
        derivedDocs: Map<String, String> = emptyMap(),
    ): Boolean {
        val rumor = Rumor.parse(event) ?: return false
        if (!SelfState.storable(self, rumor, dTags, derivedDocs)) return false
        return profiled("db.cacheSelfState") { try {
            ArmadaDb.get(context).event(ArmadaDb.TENANT_MAIN, rumor)
            true
        } catch (error: Throwable) {
            Log.w(TAG, "self-state write failed", error)
            false
        } }
    }

    /**
     * The relay URLs of the newest stored kind-10050 DM-inbox list for
     * [pubkey], or null when the store holds none. A read, never a fetch — so
     * a notification quick reply can address the peer's NIP-17 inbox without a
     * relay round-trip whenever the WebView (or a previous lookup) already
     * cached the list.
     */
    @JvmStatic
    fun dmInboxRelays(context: Context, pubkey: String): List<String>? = try {
        val filter = JSONObject()
            .put("kinds", JSONArray().put(10050))
            .put("authors", JSONArray().put(pubkey))
            .put("limit", 1)
        ArmadaDb.get(context).query(ArmadaDb.TENANT_MAIN, listOf(filter))
            .firstOrNull()
            ?.tags
            ?.filter { it.size >= 2 && it[0] == "relay" }
            ?.mapNotNull { it[1]?.takeIf(String::isNotEmpty) }
            ?.takeIf { it.isNotEmpty() }
    } catch (error: Throwable) {
        Log.w(TAG, "dm inbox read failed", error)
        null
    }

    /**
     * The derived Concord stream secrets (hex, keyed by stream address) for
     * every requested address the group-key memo holds, read from the KV the
     * WebView persists it in (`c2gkmemo` — see groupKeyPersist.ts). The
     * derived keys are ALREADY at rest in this same shared database, which is
     * what lets the service sign a quick reply's wrap and a NIP-42 stream
     * AUTH without any key crossing the plugin bridge. One read + one parse
     * however many addresses are asked for; the caller verifies sk → pk
     * before signing with anything returned.
     */
    @JvmStatic
    fun streamSecrets(context: Context, pks: List<String>): Map<String, String> {
        if (pks.isEmpty()) return emptyMap()
        return try {
            val raw = ArmadaDb.get(context).kvGet("c2gkmemo") ?: return emptyMap()
            val wanted = pks.toHashSet()
            val out = HashMap<String, String>()
            val entries = JSONArray(raw)
            for (i in 0 until entries.length()) {
                val entry = entries.optJSONObject(i) ?: continue
                val pk = entry.optString("pk")
                if (pk !in wanted) continue
                val sk = entry.optString("sk")
                if (sk.isNotEmpty()) out[pk] = sk
            }
            out
        } catch (error: Throwable) {
            Log.w(TAG, "stream secret read failed", error)
            emptyMap()
        }
    }

    /** Single-address form of [streamSecrets]. */
    @JvmStatic
    fun streamSecret(context: Context, pk: String): String? =
        streamSecrets(context, listOf(pk))[pk]

    /**
     * The conversation a decrypted rumor belongs to, as a `dmConvKey` string, or
     * null when it names no room. The Java-facing door onto [Dm17.peersOf] —
     * the service is Java and [Dm17] is `internal` Kotlin.
     *
     * This is the ONE derivation of a DM's identity the service makes. A NIP-17
     * conversation is its participant SET, so the seal author alone names a
     * conversation only when there are exactly two people in it.
     */
    @JvmStatic
    fun dm17ConvKey(self: String, rumor: JSONObject): String? {
        val parsed = Rumor.parse(rumor) ?: return null
        val peers = Dm17.peersOf(parsed, self) ?: return null
        return Dm17.convKey(peers)
    }

    /** The participants a conversation key names — [Dm17.convPeers] for Java. */
    @JvmStatic
    fun dm17ConvPeers(convKey: String): List<String> = Dm17.convPeers(convKey)

    /**
     * The conversation's disappearing-message timer, in seconds (0 = off): the
     * newest kind-1740 rumor of that conversation wins, exactly as the WebView
     * folds it (`queryDm17Timer`).
     *
     * Read through the `conv:` term, which is the same one filter the WebView
     * uses and the reason `limit: 1` is exactly right: a participant SET cannot
     * be expressed as an author/`#p` filter, which over-selects in both
     * directions, so in a group the newest row could belong to a neighbouring
     * conversation's timer.
     *
     * A malformed or absent `timer` tag on that newest notice reads as "off",
     * matching `queryDm17Timer` rather than skipping past it — the two writers
     * agreeing matters more here than either rule does.
     */
    @JvmStatic
    fun dm17TimerSecs(context: Context, self: String, convKey: String): Long = try {
        val peers = Dm17.convPeers(convKey).filter { it != self }
        val filter = JSONObject()
            .put("kinds", JSONArray().put(1740))
            .put("search", Dm17.convTerm(if (peers.isEmpty()) listOf(self) else peers))
            .put("limit", 1)
        ArmadaDb.get(context).query(Dm17.tenant(self), listOf(filter))
            .firstOrNull()
            ?.tagValue("timer")
            ?.toLongOrNull()
            ?.takeIf { it >= 0 }
            ?: 0L
    } catch (error: Throwable) {
        Log.w(TAG, "dm timer read failed", error)
        0L
    }

    /** The stored kind-0 for a pubkey, or null — so a profile already fetched isn't fetched again. */
    @JvmStatic
    fun profileRaw(context: Context, pubkey: String): String? = try {
        val filter = JSONObject()
            .put("kinds", JSONArray().put(0))
            .put("authors", JSONArray().put(pubkey))
            .put("limit", 1)
        ArmadaDb.get(context).query(ArmadaDb.TENANT_MAIN, listOf(filter)).firstOrNull()?.toJson()
    } catch (error: Throwable) {
        Log.w(TAG, "profile read failed", error)
        null
    }

    /**
     * Park a Concord wrap the service could not open, for the WebView, which
     * holds the stream keys. Stored without its signature: a wrap is signed by a
     * derived stream key that authenticates no individual, and everything that
     * does authenticate the message is the seal sealed inside it.
     */
    @JvmStatic
    fun parkConcordWrap(context: Context, wrap: JSONObject) {
        val rumor = Rumor.parse(wrap) ?: return
        try {
            ArmadaDb.get(context).event(ArmadaDb.TENANT_C2_PARK, rumor)
        } catch (error: Throwable) {
            Log.w(TAG, "park write failed", error)
        }
    }

    /**
     * Store a Concord chat rumor the service decrypted, in its community's
     * opened-event tenant — the same row, byte for byte, that the WebView's
     * `openedToStored` writes.
     *
     * The rumor is stored EXACTLY as its author wrote it. Nothing about the
     * wrap is folded into its tags: a rumor's tags are the bytes its id commits
     * to, and the chat plane asks for none of it back — a channel read is a
     * `#channel` query, and that binding tag is the author's own. Nothing about
     * the wrap is stored BESIDE the rumor either; the service never opens a
     * plane wrap, and the one wrap-derived fact the WebView does keep (which
     * control stream an edition arrived on) belongs to a plane it never sees.
     *
     * What may be stored is [Concord.storable]'s to decide, and it applies the
     * WebView's two chat-ingress rules: the seal must have been encrypted
     * (CORD-02 §5), and the kind must not be one another plane is read back by.
     * Neither fact survives the write — the seal form is not stored, and the
     * planes share this tenant — so a second writer that skipped either would
     * plant a row every reader downstream then trusts.
     *
     * `openConcord` has already checked what makes this safe to file under a
     * channel: the seal's signature, that the rumor's author IS the seal's
     * signer, and that the channel/epoch binding matches the stream whose key
     * opened the wrap.
     */
    /** A decrypted Concord rumor's time in ms, or null when its `ms` tag refuses it ([Concord.resolvedMs]). */
    @JvmStatic
    fun concordRumorMs(rumor: JSONObject): Long? {
        val opened = Rumor.parse(rumor) ?: return null
        return Concord.resolvedMs(opened.createdAt, opened.tags)
    }

    @JvmStatic
    fun storeConcordRumor(
        context: Context,
        communityIdHex: String,
        sealKind: Int,
        rumor: JSONObject,
    ) {
        val opened = Rumor.parse(rumor) ?: return
        if (!Concord.storable(communityIdHex, sealKind, opened, System.currentTimeMillis() / 1000)) {
            Log.w(TAG, "refusing a Concord chat rumor the chat plane may not carry")
            return
        }

        profiled("db.storeConcordRumor") { try {
            ArmadaDb.get(context).event(Concord.tenant(communityIdHex), opened)
        } catch (error: Throwable) {
            Log.w(TAG, "concord rumor write failed", error)
        } }
    }

    /**
     * File a decrypted NIP-17 rumor in the viewer's opened-DM tenant, under the
     * same rules the WebView's `writeDm17Rumors` applies — see [Dm17].
     *
     * The service decrypts DM wraps for its notifications regardless; storing
     * the result is what stops the app having to open the same wrap a second
     * time on launch, and is why a DM received overnight is in its thread
     * immediately. A kind-5 delete stored here triggers the store's self-only
     * NIP-09 pass, exactly as it does when the WebView writes one.
     *
     * The caller owns the crypto: that the seal's signature is good, that the
     * rumor's author IS the seal's signer, and that the rumor's id is the NIP-01
     * hash of its own contents rather than one the sender chose.
     */
    @JvmStatic
    fun storeDm17Rumor(context: Context, self: String, rumor: JSONObject) {
        val opened = Rumor.parse(rumor) ?: return
        if (!Dm17.storable(self, opened, System.currentTimeMillis() / 1000)) return

        profiled("db.storeDm17Rumor") { try {
            ArmadaDb.get(context).event(Dm17.tenant(self), opened)
        } catch (error: Throwable) {
            Log.w(TAG, "dm rumor write failed", error)
        } }
    }

    /**
     * Whether an event carries a NIP-40 deadline that has already passed.
     *
     * Used on the gift wrap and the seal before either is opened: a disappearing
     * message whose deadline is behind us is not delivered at all, matching the
     * WebView's `openDmWrap`, which refuses an expired envelope before it
     * decrypts anything.
     */
    @JvmStatic
    fun isExpired(event: JSONObject): Boolean {
        val parsed = Rumor.parse(event) ?: return false
        return Dm17.isExpired(parsed.tags, System.currentTimeMillis() / 1000)
    }

    // ── The service → WebView routing queue ──────────────────────────────────

    /**
     * One page of queued events, the ids that acknowledge it, and the relay it
     * came from (null only for the retired unscoped queue).
     *
     * A page is ONE relay's worth because the WebView's ingest routes NIP-29
     * events into the tenant for the relay that served them, and a rumor carries
     * no record of that — the queue tenant's id is where the fact lives.
     */
    class Page(val events: List<String>, val ids: List<String>, val relay: String?)

    /**
     * A page of queued events, oldest first WITHIN the page. Nothing is
     * removed: the WebView acknowledges with [ackDrain] only once ingest has
     * committed, so a page interrupted by a crash is handed out again rather
     * than lost.
     *
     * ACROSS pages the walk is newest-first — the store answers newest-first,
     * and taking the oldest page instead would mean reading past the whole
     * backlog to reach its tail, once per page, which is quadratic in exactly
     * the case that made the backlog deep. It costs nothing to allow, because
     * a drain is not how any of this becomes durable: the events are already in
     * the tenants the WebView reads, and what a pass through ingest still does
     * — parking a wrap, ringing a scope, offering a notification candidate — is
     * idempotent and order-independent. (Candidates raise nothing here anyway:
     * the WebView ingests a drained page as NOT live, because the service has
     * already notified for it.)
     */
    @JvmStatic
    fun drain(context: Context, limit: Int): Page = try {
        val db = ArmadaDb.get(context)
        val filter = listOf(JSONObject().put("limit", limit))
        // One relay's queue per page — the first with anything in it. The JS side
        // loops until a page comes back empty, so every relay is drained; taking
        // them one at a time is what lets a page name its relay.
        var page = Page(emptyList(), emptyList(), null)
        for (tenant in queueTenants(db)) {
            val rumors = db.query(tenant, filter).asReversed()
            if (rumors.isEmpty()) continue
            page = Page(rumors.map { it.toJson() }, rumors.map { it.id }, ArmadaDb.queueTenantRelay(tenant))
            break
        }
        page
    } catch (error: Throwable) {
        Log.w(TAG, "drain failed", error)
        Page(emptyList(), emptyList(), null)
    }

    /**
     * Drop an acknowledged page from one relay's queue. [relayUrl] must be the
     * one [drain] returned with the page, or the ids would be removed from a
     * queue that never held them and the page would replay forever.
     */
    @JvmStatic
    @JvmOverloads
    fun ackDrain(context: Context, ids: List<String>, relayUrl: String? = null) {
        if (ids.isEmpty()) return
        try {
            val filter = JSONObject().put("ids", JSONArray(ids))
            ArmadaDb.get(context).remove(ArmadaDb.serviceQueueTenant(relayUrl), listOf(filter))
        } catch (error: Throwable) {
            Log.w(TAG, "drain ack failed", error)
        }
    }

    private fun idFilter(id: String): JSONObject =
        JSONObject().put("ids", JSONArray().put(id))

    /**
     * Time [block] under [label] in profiling builds (see ServiceProfiler);
     * a plain call otherwise — `ON` is a compile-time constant.
     */
    private inline fun <T> profiled(label: String, block: () -> T): T {
        if (!ServiceProfiler.ON) return block()
        val started = ServiceProfiler.begin(label)
        try {
            return block()
        } finally {
            ServiceProfiler.end(label, started)
        }
    }
}
