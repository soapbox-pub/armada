package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The NIP-17 store rules the background service writes through, ported from
 * `dm17Store.ts` / `protocol.ts` alongside the code.
 *
 * These are the rules that make a second writer safe. The WebView and the
 * service both file rumors into `dm17:<self>`, so a rule only one of them
 * applies is a conversation the two disagree about — and two of them
 * (expiration, provenance) are the difference between a disappearing message
 * disappearing and a forged tag filing a message in someone else's thread.
 *
 * The participants here are real-shaped pubkeys rather than readable names,
 * because their SHAPE is contract: a `p` value that is not 64-char lowercase
 * hex names no participant, so a fixture spelled `"alice"` would exercise the
 * rejection path in every test rather than the rule it was written for.
 */
class Dm17Test {

    private val self = "5".repeat(64)
    private val alice = "a".repeat(64)
    private val bob = "b".repeat(64)
    private val mallory = "d".repeat(64)
    private val now = 1_000_000L

    @Test
    fun `stores a chat rumor from a peer`() {
        assertTrue(Dm17.storable(self, rumor(kind = 14, pubkey = alice), now))
    }

    @Test
    fun `keeps every DM-plane kind`() {
        // The port of `DM_RUMOR_KINDS`, and it must be the WHOLE of it: the
        // service is a second writer into the tenant the WebView reads, so a
        // kind only one of them accepts is a rumor that reaches the store on
        // one path and not the other. Mini App state (3310) arriving while the
        // app is dead would simply be dropped.
        for (kind in listOf(5, 7, 14, 15, 1740, 3310)) {
            assertTrue(Dm17.storable(self, rumor(kind = kind, pubkey = alice), now))
        }
    }

    @Test
    fun `refuses a typing signal and other foreign kinds`() {
        // A typing indicator exists for seconds and must never be stored; a
        // Concord invite arrives in a DM wrap but belongs to another plane.
        assertFalse(Dm17.storable(self, rumor(kind = 23311, pubkey = alice), now))
        assertFalse(Dm17.storable(self, rumor(kind = 1059, pubkey = alice), now))
    }

    @Test
    fun `refuses a Mini App peer signal`() {
        // A kind-30078 peer signal names an iroh node address that is
        // meaningless once the session ends, so it is live routing rather than
        // history and the JS side stores none either. A service that filed one
        // would put a stale address into a dial set months later.
        val signal = rumor(
            kind = 30078,
            pubkey = alice,
            tags = listOf(
                listOf("p", self),
                listOf("d", "vector-webxdc-peer"),
                listOf("webxdc-topic", "A".repeat(52)),
            ),
        )
        assertFalse(Dm17.storable(self, signal, now))
    }

    @Test
    fun `refuses a rumor whose deadline has passed`() {
        val expired = rumor(kind = 14, pubkey = alice, tags = listOf(listOf("expiration", "${now - 1}")))
        assertFalse(Dm17.storable(self, expired, now))

        val live = rumor(kind = 14, pubkey = alice, tags = listOf(listOf("expiration", "${now + 1}")))
        assertTrue(Dm17.storable(self, live, now))
    }

    @Test
    fun `treats the deadline as reached at the deadline`() {
        val due = rumor(kind = 14, pubkey = alice, tags = listOf(listOf("expiration", "$now")))
        assertFalse(Dm17.storable(self, due, now))
    }

    @Test
    fun `ignores an unparseable expiration rather than dropping the rumor`() {
        val nonsense = rumor(kind = 14, pubkey = alice, tags = listOf(listOf("expiration", "soon")))
        assertTrue(Dm17.storable(self, nonsense, now))
    }

    @Test
    fun `attributes a received rumor to its author and our own copy to its recipient`() {
        assertEquals(listOf(alice), Dm17.peersOf(rumor(kind = 14, pubkey = alice), self))

        val mine = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", bob)))
        assertEquals(listOf(bob), Dm17.peersOf(mine, self))
        assertTrue(Dm17.storable(self, mine, now))
    }

    @Test
    fun `refuses our own copy with no recipient to attribute it to`() {
        assertNull(Dm17.peersOf(rumor(kind = 14, pubkey = self), self))
        assertFalse(Dm17.storable(self, rumor(kind = 14, pubkey = self), now))
    }

    @Test
    fun `a peer tag on the rumor cannot move it into another conversation`() {
        // Nothing is injected and nothing reads a `peer` tag, so spelling one
        // out is inert — the conversation comes from the author and `p` tags.
        val forged = rumor(kind = 14, pubkey = mallory, tags = listOf(listOf("peer", bob)))
        assertEquals(listOf(mallory), Dm17.peersOf(forged, self))
    }

    @Test
    fun `names the tenant per viewer`() {
        assertEquals("dm17:$self", Dm17.tenant(self))
        assertEquals(self, Dm17.tenantSelf("dm17:$self"))
        assertNull(Dm17.tenantSelf("main"))
    }

    // ── Conversation identity ────────────────────────────────────────────────
    //
    // These must agree with `src/lib/nip17/conversation.ts` exactly. The term
    // this derivation produces is what a rumor is FILED under, and the WebView
    // looks it up by deriving it independently — so a divergence here is a
    // message received while the app was dead that the thread never shows.

    @Test
    fun `a group is the participant set, from either direction`() {
        // Received: the sender joins the room whether or not they p-tagged
        // themselves, and the viewer is never their own peer.
        val received = rumor(
            kind = 14,
            pubkey = alice,
            tags = listOf(listOf("p", self), listOf("p", bob)),
        )
        assertEquals(listOf(alice, bob), Dm17.peersOf(received, self))

        // Our own copy of the same room reduces to the same set, which is what
        // makes both halves of one conversation one conversation.
        val mine = rumor(
            kind = 14,
            pubkey = self,
            tags = listOf(listOf("p", alice), listOf("p", bob)),
        )
        assertEquals(listOf(alice, bob), Dm17.peersOf(mine, self))
        assertEquals(Dm17.convTerm(listOf(alice, bob)), Dm17.convTerm(listOf(bob, alice)))
    }

    @Test
    fun `note to self is its own conversation`() {
        val note = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", self)))
        assertEquals(listOf(self), Dm17.peersOf(note, self))
        assertTrue(Dm17.storable(self, note, now))
    }

    // A `p` value is whatever the sender typed, and the shape of a participant
    // is what every consumer of a set assumes: the term joins them with
    // NOTHING, the key joins them with `,`, and the key becomes the `/dm/`
    // deep link a notification tap follows.

    @Test
    fun `a p value that is not a pubkey names no participant`() {
        val evil = "z?call=" + "f".repeat(57) // right length, wrong alphabet
        assertEquals(64, evil.length)
        val crafted = rumor(
            kind = 14,
            pubkey = alice,
            tags = listOf(listOf("p", self), listOf("p", evil)),
        )
        assertEquals(listOf(alice), Dm17.peersOf(crafted, self))

        // Uppercase hex is a different spelling of the same key and would fork
        // one conversation in two; the wire form is lowercase.
        val upper = rumor(kind = 14, pubkey = alice, tags = listOf(listOf("p", bob.uppercase())))
        assertEquals(listOf(alice), Dm17.peersOf(upper, self))

        for (bad in listOf("ab", "a".repeat(63), "a".repeat(65), "npub1" + "q".repeat(58))) {
            val r = rumor(kind = 14, pubkey = alice, tags = listOf(listOf("p", bad)))
            assertEquals(listOf(alice), Dm17.peersOf(r, self))
        }
    }

    @Test
    fun `a crafted p value cannot reach the conversation key a route is built from`() {
        // The crafted value sorts after every real pubkey (`z` > `f`), so
        // unfiltered it would sit LAST — leaving a genuine pubkey where the
        // route's first segment is read, and splicing a query string into
        // "/dm/" + key where nothing encodes it.
        val evil = "z?call=" + "f".repeat(57)
        val crafted = rumor(
            kind = 14,
            pubkey = alice,
            tags = listOf(listOf("p", self), listOf("p", evil)),
        )
        val key = Dm17.convKey(Dm17.peersOf(crafted, self)!!)
        assertEquals(alice, key)
        assertFalse(key.contains("?"))
        for (peer in Dm17.convPeers(key)) assertTrue(Dm17.isPubkey(peer))
    }

    @Test
    fun `an own copy whose only p values are malformed names no room`() {
        val orphan = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", "nonsense")))
        assertNull(Dm17.peersOf(orphan, self))
    }

    @Test
    fun `a one-to-one term is the peer alone, unseparated`() {
        // Pubkeys are fixed-width hex, so a set is joined with nothing — a term
        // crosses a NIP-50 search string, whose parse ends a token at
        // whitespace. That width is why a `p` value is checked at all.
        assertEquals("conv:$alice", Dm17.convTerm(listOf(alice)))
        assertEquals("conv:$alice$bob", Dm17.convTerm(listOf(bob, alice)))
    }

    @Test
    fun `a one-to-one conversation key is the peer alone`() {
        // The equivalence the notification path rests on: a 1:1 room key, its
        // read marker and its `/dm/<key>` deep link are byte-identical to the
        // single-pubkey spelling that predates group DMs, so making the service
        // conversation-keyed re-files no existing thread.
        assertEquals(alice, Dm17.convKey(listOf(alice)))
        assertEquals(listOf(alice), Dm17.convPeers(alice))
        // Note to Self is `[self]`, and so is a key like any other.
        assertEquals(self, Dm17.convKey(listOf(self)))
    }

    @Test
    fun `a group conversation key round-trips through its participants`() {
        // Sorted, so the two directions of one conversation name one key —
        // and separated, unlike a term, because a key is read back apart to
        // become the `p` tags of a reply.
        assertEquals("$alice,$bob", Dm17.convKey(listOf(bob, alice)))
        assertEquals(listOf(alice, bob), Dm17.convPeers("$alice,$bob"))
        assertEquals(
            Dm17.convKey(listOf(alice, bob)),
            Dm17.convKey(listOf(bob, alice)),
        )
    }

    @Test
    fun `an empty conversation key names nobody`() {
        // What `canReply` leans on: a room key the service can't decode is one
        // it must not seal a reply for.
        assertEquals(emptyList<String>(), Dm17.convPeers(""))
        assertEquals(emptyList<String>(), Dm17.convPeers(","))
    }

    @Test
    fun `a rumor's conversation key is its participant set`() {
        // The derivation the notification path makes: keyed by the SENDER, a
        // group message would land in the 1:1 thread with whoever spoke.
        val received = rumor(
            kind = 14,
            pubkey = alice,
            tags = listOf(listOf("p", self), listOf("p", bob)),
        )
        assertEquals("$alice,$bob", Dm17.convKey(Dm17.peersOf(received, self)!!))
    }

    @Test
    fun `files a rumor under the conversation its tenant names`() {
        val received = rumor(
            kind = 14,
            pubkey = alice,
            tags = listOf(listOf("p", self), listOf("p", bob)),
        )
        // Every rumor of the conversation, plus the message-only namespace the
        // conversation list collapses over.
        assertEquals(
            listOf("conv:$alice$bob", "convmsg:$alice$bob"),
            TermPolicies.termsOf(received, Dm17.tenant(self)),
        )
        // A tenant that derives no terms says so, rather than guessing.
        assertEquals(emptyList<String>(), TermPolicies.termsOf(received, "main"))
    }

    @Test
    fun `files the viewer's own message under the mine namespace too`() {
        val sent = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", alice)))
        // `convmine:` is what "conversations I have written in" is a collapse
        // over — the set that keeps a thread with someone the viewer doesn't
        // follow, and that tells the notification path they are not a stranger.
        assertEquals(
            listOf("conv:$alice", "convmsg:$alice", "convmine:$alice"),
            TermPolicies.termsOf(sent, Dm17.tenant(self)),
        )
    }

    @Test
    fun `keeps a reaction out of the message namespaces`() {
        // A reaction belongs to the conversation but is not a row the list can
        // show, and `distinct:convmsg` is how it never becomes one.
        val reaction = rumor(kind = 7, pubkey = self, tags = listOf(listOf("p", alice)))
        assertEquals(listOf("conv:$alice"), TermPolicies.termsOf(reaction, Dm17.tenant(self)))
    }

    @Test
    fun `an unattributable rumor is filed under nothing`() {
        val orphan = rumor(kind = 14, pubkey = self)
        assertEquals(emptyList<String>(), TermPolicies.termsOf(orphan, Dm17.tenant(self)))
    }

    @Test
    fun `records the arrival of a message whose sender's clock was off`() {
        // `rumor()` is dated now - 10: ten seconds slow, past ARRIVAL_SKEW_SECS.
        val fact = org.json.JSONObject(Dm17.arrivalFact(self, rumor(kind = 14, pubkey = alice), now)!!)
        assertEquals(now, fact.getLong("at"))
        assertEquals(now - 10, fact.getLong("sent"))
        assertEquals(alice, fact.getString("conv"))
        assertTrue(fact.getBoolean("in"))
        assertEquals("dm17at:$self:id-14-$alice", Dm17.arrivalKey(self, "id-14-$alice"))
    }

    @Test
    fun `records no arrival within the skew, or for anything but a message`() {
        assertNull(Dm17.arrivalFact(self, rumor(kind = 14, pubkey = alice), now - 8))
        assertNull(Dm17.arrivalFact(self, rumor(kind = 7, pubkey = alice), now))
        assertFalse(Dm17.arrivalCounts(14, now, now + Dm17.ARRIVAL_SKEW_SECS))
        assertTrue(Dm17.arrivalCounts(15, now, now - Dm17.ARRIVAL_SKEW_SECS - 1))
    }

    private fun rumor(
        kind: Int,
        pubkey: String,
        tags: List<List<String>> = emptyList(),
    ): Rumor = Rumor.of("id-$kind-$pubkey", pubkey, now - 10, kind, tags, "hello")!!
}
