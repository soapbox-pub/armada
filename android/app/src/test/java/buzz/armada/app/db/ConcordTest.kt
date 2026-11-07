package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Concord chat-ingress rules the background service writes through,
 * ported from `rumorStore.ts` / `kinds.ts` alongside the code.
 *
 * These are the rules that make a second writer safe. The WebView and the
 * service both file chat rumors into `c2:<communityIdHex>`, and neither fact
 * they turn on survives the write — the seal form is not stored, and every
 * plane shares that one tenant — so a rule only one writer applies is a row the
 * other's readers trust for something it never was.
 */
class ConcordTest {

    private val community = "ab".repeat(32)
    private val now = 1_000_000L

    @Test
    fun `stores an ordinary chat message`() {
        assertTrue(Concord.storable(community, Concord.SEAL_ENCRYPTED, rumor(kind = 9), now))
    }

    @Test
    fun `keeps every chat kind, including ones the timeline does not read`() {
        // A denylist, so kinds outside the timeline's own list still store —
        // 3310 is the WebXDC signal, read by its own query, and 1740 the
        // CORD-08 timer notice.
        for (kind in listOf(5, 7, 9, 1018, 1068, 1111, 1740, 3302, 3310, 8333, 9735, 31922, 31923, 31925)) {
            assertTrue("kind $kind", Concord.storable(community, Concord.SEAL_ENCRYPTED, rumor(kind), now))
        }
    }

    @Test
    fun `refuses a rumor whose kind belongs to another plane`() {
        // The reverse splice: a member of ANY channel holds its stream key
        // legitimately, so the channel binding proves nothing here. A plane is
        // read back by kind, and a stored rumor keeps no seal for the fold to
        // check the form of, so this is the only place it can be refused.
        for (kind in listOf(3308, 3306, 3309, 3312, 3314, 3315, 3303)) {
            assertFalse("kind $kind", Concord.storable(community, Concord.SEAL_ENCRYPTED, rumor(kind), now))
        }
    }

    @Test
    fun `refuses a chat rumor that did not arrive under an encrypted seal`() {
        // A plaintext seal would make the message a standalone signed artifact
        // any relay could display (CORD-02 §5).
        assertFalse(Concord.storable(community, 20014, rumor(kind = 9), now))
    }

    @Test
    fun `refuses a rumor with no community to file it under`() {
        assertFalse(Concord.storable("", Concord.SEAL_ENCRYPTED, rumor(kind = 9), now))
    }

    @Test
    fun `a channel tag cannot move a plane kind past the refusal`() {
        val forged = rumor(kind = 3308, tags = listOf(listOf("channel", "cd".repeat(32)), listOf("epoch", "0")))
        assertFalse(Concord.storable(community, Concord.SEAL_ENCRYPTED, forged, now))
    }

    @Test
    fun `refuses a chat rumor whose NIP-40 deadline has passed`() {
        // CORD-08 §3: the WebView refuses an expired rumor at ingest and its
        // sweep only walks what the read filter already hides — a second
        // writer storing one would plant a disappearing message past its
        // deadline.
        val expired = rumor(kind = 9, tags = listOf(listOf("expiration", (now - 1).toString())))
        assertFalse(Concord.storable(community, Concord.SEAL_ENCRYPTED, expired, now))
        val atDeadline = rumor(kind = 9, tags = listOf(listOf("expiration", now.toString())))
        assertFalse(Concord.storable(community, Concord.SEAL_ENCRYPTED, atDeadline, now))
    }

    @Test
    fun `stores a chat rumor whose NIP-40 deadline is still ahead`() {
        val live = rumor(kind = 9, tags = listOf(listOf("expiration", (now + 60).toString())))
        assertTrue(Concord.storable(community, Concord.SEAL_ENCRYPTED, live, now))
    }

    @Test
    fun `a malformed expiration tag is no deadline, not an expired one`() {
        // A garbage tag must not be able to hide a message (the WebView's
        // `expirationOf` reads it the same way).
        val garbage = rumor(kind = 9, tags = listOf(listOf("expiration", "soon")))
        assertTrue(Concord.storable(community, Concord.SEAL_ENCRYPTED, garbage, now))
    }

    @Test
    fun `reads a rumor's time to the millisecond off its first ms tag, as resolveMs does`() {
        assertEquals(5_000L, Concord.resolvedMs(5, emptyList()))
        assertEquals(5_042L, Concord.resolvedMs(5, listOf(listOf("ms", "42"))))
        assertEquals(5_999L, Concord.resolvedMs(5, listOf(listOf("ms", "999"), listOf("ms", "x"))))
        for (bad in listOf("1000", "042", "+5", " 5", "1e2", "", "-1")) {
            assertEquals("ms $bad", null, Concord.resolvedMs(5, listOf(listOf("ms", bad))))
        }
        assertEquals(null, Concord.resolvedMs(5, listOf(listOf("ms"))))
    }

    @Test
    fun `refuses a chat rumor whose ms tag is malformed (CORD-02 §4)`() {
        assertFalse(Concord.storable(community, Concord.SEAL_ENCRYPTED, rumor(kind = 9, tags = listOf(listOf("ms", "1000"))), now))
        assertTrue(Concord.storable(community, Concord.SEAL_ENCRYPTED, rumor(kind = 9, tags = listOf(listOf("ms", "7"))), now))
    }

    @Test
    fun `names the tenant per community`() {
        assertEquals("c2:$community", Concord.tenant(community))
    }

    private fun rumor(
        kind: Int,
        tags: List<List<String>> = emptyList(),
    ): Rumor = Rumor.of("id-$kind", "alice", 1_000_000L, kind, tags, "hello")!!
}
