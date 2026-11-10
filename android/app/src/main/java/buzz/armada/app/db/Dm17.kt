package buzz.armada.app.db

/**
 * The NIP-17 opened-DM store's rules, in Kotlin — a port of the parts of
 * `src/lib/nip17/dm17Store.ts` and `protocol.ts` that decide what may be stored
 * and how it is shaped.
 *
 * The background service decrypts DM gift wraps for its notifications anyway, so
 * it files the recovered rumor in the same per-viewer tenant the WebView reads
 * (`dm17:<self>`) rather than throwing it away and leaving the app to open the
 * wrap a second time. That only works if it obeys the same rules — otherwise the
 * two writers disagree about what a conversation contains.
 *
 * Pure and Context-free so the rules can be tested on the JVM without an
 * emulator; [ServiceStore.storeDm17Rumor] is the thin part that writes.
 */
internal object Dm17 {

    /**
     * The rumor kinds the DM store holds: NIP-09 delete, NIP-25 reaction,
     * chat, file, Armada's disappearing-messages timer, and Mini App state
     * (3310). The port of `DM_RUMOR_KINDS`.
     *
     * Typing indicators (23311) are deliberately absent — the signal IS the
     * event's existence, it lives for seconds, and it must never reach the
     * store. Mini App PEER SIGNALS (30078) are absent for the same reason:
     * they name a transport address that is meaningless once the session ends.
     */
    val KINDS = setOf(5, 7, 14, 15, 1740, 3310)

    /**
     * The kinds worth LISTING — a chat message or a file — which [MSG_TERM] and
     * [MINE_TERM] cover. The port of `DM_MESSAGE_KINDS`.
     */
    val MESSAGE_KINDS = setOf(14, 15)

    /** The ArmadaDB tenant holding one viewer's opened DMs. */
    fun tenant(self: String): String = TENANT_PREFIX + self

    /**
     * The NIP-40 deadline these tags carry, or null. `Number(raw)` semantics:
     * anything that isn't a finite number is no deadline at all.
     */
    fun expirationOf(tags: List<List<String?>>): Long? {
        val raw = tags.firstOrNull { it.getOrNull(0) == "expiration" }?.getOrNull(1) ?: return null
        val secs = raw.trim().toDoubleOrNull() ?: return null
        if (secs.isNaN() || secs.isInfinite()) return null
        return secs.toLong()
    }

    /** Whether these tags carry a NIP-40 deadline that has already passed. */
    fun isExpired(tags: List<List<String?>>, now: Long): Boolean {
        val at = expirationOf(tags) ?: return false
        return at <= now
    }

    /**
     * Whether a string is a bare 32-byte pubkey in lowercase hex — the port of
     * `isPubkey` in `src/lib/nip17/conversation.ts`.
     *
     * A `p` VALUE is whatever the sender typed, and everything downstream of a
     * participant set assumes a pubkey: [convTerm] joins participants with
     * NOTHING (fixed width is what makes that unambiguous), [convKey] joins
     * them with a separator a value could otherwise contain, and the key
     * becomes the `/dm/` deep link a notification tap follows. So a value that
     * is not a pubkey is not a participant, and is dropped where the set is
     * built rather than checked again by each thing that consumes it.
     */
    fun isPubkey(value: String): Boolean {
        if (value.length != 64) return false
        for (c in value) {
            val hex = (c in '0'..'9') || (c in 'a'..'f')
            if (!hex) return false
        }
        return true
    }

    /**
     * The participants of a rumor's conversation, from `self`'s perspective:
     * everyone involved except the viewer, sorted. `[self]` for Note to Self.
     * Null when unattributable — an own copy with no `p` tag names no room, and
     * callers drop it rather than guess.
     *
     * A port of `dmPeersOf` in `src/lib/nip17/conversation.ts`, and it has to
     * agree with it exactly: this is what [convTerm] files a rumor under, and a
     * rumor filed under a term the WebView does not look up is a message that
     * arrived while the app was dead and is then invisible in the thread.
     *
     * A NIP-17 conversation is its participant SET, not a peer — the `p` set
     * defines the room. Canonicalizing to "everyone but the viewer, sorted"
     * makes the two directions agree: a message Alice sends to {me, Bob} arrives
     * as `pubkey: Alice, p: [me, Bob]` and my reply leaves as
     * `pubkey: me, p: [Alice, Bob]`, and both reduce to [Alice, Bob]. For a 1:1
     * it yields exactly `[peer]`.
     */
    fun peersOf(rumor: Rumor, self: String): List<String>? {
        val recipients = LinkedHashSet<String>()
        for (tag in rumor.tags) {
            val value = tag.getOrNull(1)
            if (tag.getOrNull(0) == "p" && !value.isNullOrEmpty() && isPubkey(value)) {
                recipients.add(value)
            }
        }

        if (rumor.pubkey != self) {
            // Received: the sender is a participant whether or not they p-tagged
            // themselves, and we are not one of our own peers. The author is
            // held to the same shape as a `p` value, so EVERY element of the
            // result is a pubkey — the property the term, the key and the route
            // all rest on. In practice it always is: the service only gets here
            // from a seal whose signature it verified.
            if (!isPubkey(rumor.pubkey)) return null
            val others = LinkedHashSet(recipients)
            others.add(rumor.pubkey)
            others.remove(self)
            return if (others.isEmpty()) null else others.sorted()
        }

        // Our own copy: only the `p` set says where it went.
        if (recipients.isEmpty()) return null
        val others = LinkedHashSet(recipients)
        others.remove(self)
        return if (others.isEmpty()) listOf(self) else others.sorted()
    }

    /**
     * Separator between participants in a conversation KEY — the port of
     * `DM_PEER_SEP`. Legal unescaped in a URL path segment, so the deep link a
     * notification carries stays `/dm/<a>,<b>`.
     */
    const val PEER_SEP = ","

    /**
     * The stable string key for a participant set — the port of `dmConvKey`.
     *
     * For a 1:1 (and Note to Self) this is exactly the other party's pubkey, so
     * a `dm:<convKey>` room key, its read marker and its deep link are all
     * byte-identical to a single-peer key, so no existing 1:1 thread re-files.
     *
     * Unlike [convTerm] this joins with [PEER_SEP], because a key is read back
     * apart again ([convPeers]) while a term is only ever compared whole.
     */
    fun convKey(peers: List<String>): String = peers.sorted().joinToString(PEER_SEP)

    /** The participants a conversation key names. Inverse of [convKey]. */
    fun convPeers(key: String): List<String> =
        key.split(PEER_SEP).filter { it.isNotEmpty() }

    /**
     * The derived index term for a participant set — the port of `dmConvTerm`.
     *
     * Joined with NOTHING rather than with a separator: a term crosses a NIP-50
     * search string, whose parse ends a token at whitespace. Pubkeys are
     * fixed-width 64-char hex, so concatenating them is unambiguous.
     */
    fun convTerm(peers: List<String>, namespace: String = CONV_TERM): String =
        "$namespace:" + peers.sorted().joinToString("")

    /** The namespace every rumor of a conversation is filed under. */
    const val CONV_TERM = "conv"

    /**
     * The namespace holding only the rumors worth listing (chat and file), so
     * `distinct:convmsg` can name the newest MESSAGE of every conversation
     * without any engine reading a rumor's kind. See `DM_MSG_TERM`.
     */
    const val MSG_TERM = "convmsg"

    /**
     * The same, restricted to messages the VIEWER sent — "conversations I have
     * written in", which is what tells the notification path that a sender is not
     * a stranger. See `DM_MINE_TERM`.
     */
    const val MINE_TERM = "convmine"

    /**
     * The [TermPolicy] for a `dm17:<self>` tenant: each rumor filed under the
     * one conversation it belongs to, in every namespace it qualifies for.
     *
     * `self` comes from the TENANT ID, which is the whole shape of the
     * contract — [SqliteArmadaDb] never interprets a tenant id or a term, and
     * this is the layer that spells `dm17:` in the first place.
     *
     * Exactly one term per namespace, which `distinct:` requires: a rumor that
     * was the newest of two groups could only ever be returned once.
     *
     * The service writes through this while the app is dead, so a message that
     * arrives then is already in the conversation list's index when the app
     * opens — which is the whole reason a policy binds to the tenant.
     */
    fun termsOf(rumor: Rumor, tenantId: String): List<String> {
        val self = tenantSelf(tenantId) ?: return emptyList()
        val peers = peersOf(rumor, self) ?: return emptyList()

        val terms = mutableListOf(convTerm(peers))
        if (rumor.kind in MESSAGE_KINDS) {
            terms.add(convTerm(peers, MSG_TERM))
            if (rumor.pubkey == self) terms.add(convTerm(peers, MINE_TERM))
        }
        return terms
    }

    /**
     * The pubkey in a `dm17:<self>` tenant id, or null for any other id —
     * including a bare `dm17:`, which names no viewer. Falling through with an
     * empty `self` would file every participant of every rumor as a peer, where
     * the TypeScript policy (whose `!self` check is the same test) derives
     * nothing; the id is malformed either way, and the two must agree on what a
     * malformed one means.
     */
    fun tenantSelf(tenantId: String): String? {
        if (!tenantId.startsWith(TENANT_PREFIX)) return null
        return tenantId.substring(TENANT_PREFIX.length).ifEmpty { null }
    }

    private const val TENANT_PREFIX = "dm17:"

    /**
     * Whether an opened DM rumor may be stored.
     *
     * What IS stored is the rumor, untouched — nothing is injected on the way
     * in. A rumor's tags are the bytes its id commits to, so bookkeeping
     * written into them makes the stored row something its sender never signed,
     * and makes the store's own idea of a conversation forgeable by anyone who
     * spells that tag themselves. The conversation is derived on read instead,
     * from the author and `p` tags ([peersOf]).
     *
     * Refused when:
     *
     *  - it isn't a DM-plane kind (a typing signal, or a foreign rumor kind
     *    that arrived in a DM wrap — Concord invites travel this way);
     *  - its NIP-40 deadline has passed. This is the single choke point every
     *    writer goes through, which is why the check lives here and not only at
     *    the point of decryption: a disappearing message that arrives late is
     *    simply never stored;
     *  - it has no attributable conversation, so no read could ever surface it
     *    in a thread.
     */
    fun storable(self: String, rumor: Rumor, now: Long): Boolean {
        if (self.isEmpty()) return false
        if (rumor.kind !in KINDS) return false
        if (isExpired(rumor.tags, now)) return false
        return peersOf(rumor, self) != null
    }

    /**
     * KV prefix of the arrival facts, `dm17at:<self>:<rumorId>` — the port of
     * `DM_ARRIVAL_PREFIX`. A message that arrived live is ordered, counted unread
     * and notified by when it arrived, where its sender's clock put it more than
     * [ARRIVAL_SKEW_SECS] away; the WebView reads the fact this service writes.
     */
    const val ARRIVAL_PREFIX = "dm17at:"

    /** A gap within this is latency, not a clock. The port of `ARRIVAL_SKEW_SECS`. */
    const val ARRIVAL_SKEW_SECS = 2L

    /** Whether a message that arrived at [at] keeps that as its time. The port of `arrivalCounts`. */
    fun arrivalCounts(kind: Int, createdAt: Long, at: Long): Boolean =
        kind in MESSAGE_KINDS && kotlin.math.abs(at - createdAt) > ARRIVAL_SKEW_SECS

    fun arrivalKey(self: String, rumorId: String): String = "$ARRIVAL_PREFIX$self:$rumorId"

    /**
     * The fact recorded for [rumor] arriving at [at], or null where none is:
     * `{ at, sent, conv, in }`, the shape `Dm17Arrival` reads.
     */
    fun arrivalFact(self: String, rumor: Rumor, at: Long): String? {
        if (!arrivalCounts(rumor.kind, rumor.createdAt, at)) return null
        val peers = peersOf(rumor, self) ?: return null
        return org.json.JSONObject()
            .put("at", at)
            .put("sent", rumor.createdAt)
            .put("conv", convKey(peers))
            .put("in", rumor.pubkey != self)
            .toString()
    }
}
