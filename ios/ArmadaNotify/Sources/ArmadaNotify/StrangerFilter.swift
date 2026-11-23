import Foundation

/// The DM stranger filter — the port of `src/lib/dmStrangerFilter.ts`, which
/// `pushRuntime.ts` and Android's `StrangerFilter.kt` also apply. A request-tier
/// conversation is filtered when someone outside the viewer's communities wrote
/// in it and either sent a link or the viewer filters every non-member.
enum StrangerFilter {

    /// Past this many stored messages every author counts as a link sender, so a
    /// flood can't push its first link out of the read. `DM_SCREEN_WINDOW`.
    static let window = 500

    /// `LINK_TOKEN_PATTERN` spelled out in ASCII: ICU's `\s`, `\w` and case
    /// folding aren't JavaScript's, so the whitespace set and letter cases are explicit.
    private static let link = try! NSRegularExpression(
        pattern: "(?:(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?)://|(?:[A-Za-z0-9_-]{1,63}\\.){1,10}[A-Za-z]{2,24}/)"
            + "[^<>|\"\\t\\n\\x{000B}\\f\\r \\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]+"
    )

    static func containsLink(_ content: String) -> Bool {
        link.firstMatch(in: content, range: NSRange(content.startIndex..., in: content)) != nil
    }

    /// Who wrote in a conversation (never the viewer), and who of them sent a link.
    struct Screen: Equatable {
        var authors: Set<String> = []
        var linkAuthors: Set<String> = []

        static func + (a: Screen, b: Screen) -> Screen {
            Screen(authors: a.authors.union(b.authors), linkAuthors: a.linkAuthors.union(b.linkAuthors))
        }
    }

    /// A file message's content is its own URL, so it never counts as a link.
    static func screen(
        _ messages: [(author: String, kind: Int, content: String)],
        self selfPubkey: String,
        overflow: Bool = false
    ) -> Screen {
        var screen = Screen()
        for message in messages where !message.author.isEmpty && message.author != selfPubkey {
            screen.authors.insert(message.author)
            if overflow || (message.kind != Dm17.kindFile && containsLink(message.content)) {
                screen.linkAuthors.insert(message.author)
            }
        }
        return screen
    }

    /// The viewer's community peers and whether every non-member is filtered.
    struct Policy: Equatable {
        let communityPeers: Set<String>
        let blockNonMembers: Bool

        /// The config's `strangerFilter`; nil (filter off) when absent or malformed.
        static func parse(_ raw: Any?) -> Policy? {
            guard let object = raw as? [String: Any],
                  let peers = object["communityPeers"] as? [String]
            else { return nil }
            return Policy(communityPeers: Set(peers), blockNonMembers: (object["blockNonMembers"] as? Bool) ?? false)
        }
    }

    static func filtered(_ screen: Screen, policy: Policy?) -> Bool {
        guard let policy else { return false }
        let suspects = policy.blockNonMembers ? screen.authors : screen.linkAuthors
        return suspects.contains { !policy.communityPeers.contains($0) }
    }
}
