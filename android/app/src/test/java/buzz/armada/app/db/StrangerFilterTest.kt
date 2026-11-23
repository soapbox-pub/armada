package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The DM stranger filter, against the vectors `dmStrangerFilter.test.ts` holds. */
class StrangerFilterTest {

    private val self = "5".repeat(64)
    private val member = "a".repeat(64)
    private val outsider = "d".repeat(64)

    @Test
    fun linksAreWhatTheWebRendererLinks() {
        val vectors = listOf(
            "free nitro https://spam.example/claim" to true,
            "HTTP://SPAM.EXAMPLE" to true,
            "wss://relay.example" to true,
            "go to spam.example/claim now" to true,
            "[click](https://spam.example)" to true,
            "<https://spam.example>" to true,
            "||https://spam.example||" to true,
            "hey, are you coming tonight?" to false,
            "see you at 8.30" to false,
            "example.com" to false,
            "https://" to false,
            "https:// spam" to false,
            "https://\u00a0spam" to false,
            "https://\u2028spam" to false,
            "hxxps://spam.example/x" to true,
            "hxxps://spam[.]example" to false,
            "spam[.]example/x" to false,
        )
        for ((content, expected) in vectors) {
            assertEquals(content, expected, StrangerFilter.containsLink(content))
        }
    }

    @Test
    fun screenCollectsAuthorsAndLinkSendersButNeverTheViewer() {
        val screen = StrangerFilter.screen(
            listOf(
                StrangerFilter.Message(member, 14, "hi"),
                StrangerFilter.Message(outsider, 14, "https://x.example/y"),
                StrangerFilter.Message(self, 14, "https://mine.example/z"),
                StrangerFilter.Message(member, 15, "https://blossom.example/abc"),
            ),
            self,
        )
        assertEquals(setOf(member, outsider), screen.authors)
        assertEquals(setOf(outsider), screen.linkAuthors)
    }

    @Test
    fun pastTheWindowEveryAuthorCountsAsALinkSender() {
        val screen = StrangerFilter.screen(listOf(StrangerFilter.Message(outsider, 14, "hi")), self, overflow = true)
        assertEquals(setOf(outsider), screen.linkAuthors)
    }

    @Test
    fun filtersOutsidersWhoLinkOrEveryOutsiderWhenBlocked() {
        val linked = StrangerFilter.Screen(setOf(outsider), setOf(outsider))
        val plain = StrangerFilter.Screen(setOf(outsider), emptySet())
        val members = StrangerFilter.Policy(setOf(member), blockNonMembers = false)
        val blockAll = StrangerFilter.Policy(setOf(member), blockNonMembers = true)
        assertTrue(StrangerFilter.filtered(linked, members))
        assertFalse(StrangerFilter.filtered(plain, members))
        assertTrue(StrangerFilter.filtered(plain, blockAll))
        assertFalse(StrangerFilter.filtered(StrangerFilter.Screen(setOf(member), setOf(member)), blockAll))
        assertFalse(StrangerFilter.filtered(linked, null))
        assertTrue(StrangerFilter.filtered(plain + linked, members))
    }

    @Test
    fun parsesThePolicyAndRejectsMalformedOnes() {
        val policy = StrangerFilter.Policy.parse("""{"communityPeers":["$member"],"blockNonMembers":true}""")
        assertEquals(setOf(member), policy?.communityPeers)
        assertEquals(true, policy?.blockNonMembers)
        assertNull(StrangerFilter.Policy.parse(null))
        assertNull(StrangerFilter.Policy.parse("{"))
        assertNull(StrangerFilter.Policy.parse("""{"blockNonMembers":true}"""))
    }
}
