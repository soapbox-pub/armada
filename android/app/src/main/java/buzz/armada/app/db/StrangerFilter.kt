package buzz.armada.app.db

import org.json.JSONObject

/**
 * The DM stranger filter, in Kotlin — the port of `src/lib/dmStrangerFilter.ts`,
 * which `pushRuntime.ts` and `ArmadaNotify`'s `StrangerFilter.swift` also apply.
 * A request-tier conversation is filtered when someone outside the viewer's
 * communities wrote in it and either sent a link or the viewer filters every
 * non-member. Pure so the rule can be tested on the JVM.
 */
object StrangerFilter {

    /**
     * Past this many stored messages every author counts as a link sender, so a
     * flood can't push its first link out of the read. `DM_SCREEN_WINDOW`.
     */
    const val WINDOW = 500

    /**
     * `LINK_TOKEN_PATTERN` spelled out in ASCII: Java's `\s` and case folding
     * aren't JavaScript's, so the whitespace set and the letter cases are explicit.
     */
    private val LINK = Regex(
        "(?:(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?)://|(?:[A-Za-z0-9_-]{1,63}\\.){1,10}[A-Za-z]{2,24}/)" +
            "[^<>|\"\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
    )

    @JvmStatic
    fun containsLink(content: String): Boolean = LINK.containsMatchIn(content)

    /** Who wrote in a conversation (never the viewer), and who of them sent a link. */
    data class Screen(val authors: Set<String>, val linkAuthors: Set<String>) {
        operator fun plus(other: Screen) =
            Screen(authors + other.authors, linkAuthors + other.linkAuthors)
    }

    /** One stored or incoming message, as much of it as the filter reads. */
    data class Message(val author: String, val kind: Int, val content: String)

    /** A file message's content is its own URL, so it never counts as a link. */
    @JvmStatic
    fun screen(messages: Iterable<Message>, self: String, overflow: Boolean = false): Screen {
        val authors = LinkedHashSet<String>()
        val linkAuthors = LinkedHashSet<String>()
        for ((author, kind, content) in messages) {
            if (author.isEmpty() || author == self) continue
            authors.add(author)
            if (overflow || (kind != 15 && containsLink(content))) linkAuthors.add(author)
        }
        return Screen(authors, linkAuthors)
    }

    /** The viewer's community peers and whether every non-member is filtered. */
    data class Policy(val communityPeers: Set<String>, val blockNonMembers: Boolean) {
        companion object {
            /** The `dmStrangerFilter` pref; null (filter off) when absent or unreadable. */
            @JvmStatic
            fun parse(raw: String?): Policy? = try {
                if (raw.isNullOrEmpty()) null else {
                    val obj = JSONObject(raw)
                    val peers = obj.optJSONArray("communityPeers")
                    if (peers == null) null else Policy(
                        (0 until peers.length()).mapNotNull { peers.optString(it, null) }.toSet(),
                        obj.optBoolean("blockNonMembers", false),
                    )
                }
            } catch (_: Exception) {
                null
            }
        }
    }

    @JvmStatic
    fun filtered(screen: Screen, policy: Policy?): Boolean {
        if (policy == null) return false
        val suspects = if (policy.blockNonMembers) screen.authors else screen.linkAuthors
        return suspects.any { it !in policy.communityPeers }
    }
}
