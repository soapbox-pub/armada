import ArmadaDB
import XCTest

@testable import ArmadaNotify

/// The DM stranger filter, against the vectors `dmStrangerFilter.test.ts` holds.
final class StrangerFilterTests: XCTestCase {

    private let self_ = String(repeating: "5", count: 64)
    private let member = String(repeating: "a", count: 64)
    private let outsider = String(repeating: "d", count: 64)

    func testLinksAreWhatTheWebRendererLinks() {
        let vectors: [(String, Bool)] = [
            ("free nitro https://spam.example/claim", true),
            ("HTTP://SPAM.EXAMPLE", true),
            ("wss://relay.example", true),
            ("go to spam.example/claim now", true),
            ("[click](https://spam.example)", true),
            ("<https://spam.example>", true),
            ("||https://spam.example||", true),
            ("hey, are you coming tonight?", false),
            ("see you at 8.30", false),
            ("example.com", false),
            ("https://", false),
            ("https:// spam", false),
            ("https://\u{00A0}spam", false),
            ("https://\u{2028}spam", false),
            ("hxxps://spam.example/x", true),
            ("hxxps://spam[.]example", false),
            ("spam[.]example/x", false),
        ]
        for (content, expected) in vectors {
            XCTAssertEqual(StrangerFilter.containsLink(content), expected, content)
        }
    }

    func testScreenCollectsAuthorsAndLinkSendersButNeverTheViewer() {
        let screen = StrangerFilter.screen([
            (author: member, kind: 14, content: "hi"),
            (author: outsider, kind: 14, content: "https://x.example/y"),
            (author: self_, kind: 14, content: "https://mine.example/z"),
            (author: member, kind: 15, content: "https://blossom.example/abc"),
        ], self: self_)
        XCTAssertEqual(screen.authors, [member, outsider])
        XCTAssertEqual(screen.linkAuthors, [outsider])
        let overflow = StrangerFilter.screen([(author: outsider, kind: 14, content: "hi")], self: self_, overflow: true)
        XCTAssertEqual(overflow.linkAuthors, [outsider])
    }

    func testFiltersOutsidersWhoLinkOrEveryOutsiderWhenBlocked() {
        let linked = StrangerFilter.Screen(authors: [outsider], linkAuthors: [outsider])
        let plain = StrangerFilter.Screen(authors: [outsider], linkAuthors: [])
        let members = StrangerFilter.Policy(communityPeers: [member], blockNonMembers: false)
        let blockAll = StrangerFilter.Policy(communityPeers: [member], blockNonMembers: true)
        XCTAssertTrue(StrangerFilter.filtered(linked, policy: members))
        XCTAssertFalse(StrangerFilter.filtered(plain, policy: members))
        XCTAssertTrue(StrangerFilter.filtered(plain, policy: blockAll))
        XCTAssertFalse(StrangerFilter.filtered(StrangerFilter.Screen(authors: [member], linkAuthors: [member]), policy: blockAll))
        XCTAssertFalse(StrangerFilter.filtered(linked, policy: nil))
        XCTAssertTrue(StrangerFilter.filtered(plain + linked, policy: members))
    }

    func testTheConfigCarriesThePolicyAndIgnoresAMalformedOne() {
        let parsed = PushConfig.parse(json: """
        {"self":"\(self_)","knownPeers":[],"strangerFilter":{"communityPeers":["\(member)"],"blockNonMembers":true}}
        """)
        XCTAssertEqual(parsed?.strangerFilter, StrangerFilter.Policy(communityPeers: [member], blockNonMembers: true))
        XCTAssertNil(PushConfig.parse(json: """
        {"self":"\(self_)","knownPeers":[],"strangerFilter":{"blockNonMembers":true}}
        """)?.strangerFilter)
        XCTAssertNil(PushConfig.parse(json: "{\"self\":\"\(self_)\",\"knownPeers\":[]}")?.strangerFilter)
    }

    // MARK: - With the store

    private func store() throws -> NotifyStore {
        NotifyStore(bridge: ArmadaDbBridge(db: try SqliteArmadaDb(db: try SqliteDriver(path: ":memory:"))))
    }

    private func dm(_ id: Character, from author: String, to viewer: String, kind: Int = 14, content: String) -> OpenedDm {
        OpenedDm(
            rumorId: String(repeating: id, count: 64), author: author, kind: kind,
            content: content, tags: [["p", viewer]], createdAt: 1_700_000_000, peers: [author]
        )
    }

    func testTheStoredConversationIsScreened() throws {
        let store = try store()
        try store.writeDm(dm("1", from: outsider, to: self_, content: "hi"), self: self_, now: 1_700_000_000)
        XCTAssertEqual(store.dmScreen(self: self_, peers: [outsider]), StrangerFilter.Screen(authors: [outsider], linkAuthors: []))
        try store.writeDm(dm("2", from: outsider, to: self_, content: "spam.example/claim"), self: self_, now: 1_700_000_000)
        XCTAssertEqual(store.dmScreen(self: self_, peers: [outsider]), StrangerFilter.Screen(authors: [outsider], linkAuthors: [outsider]))
        XCTAssertEqual(store.dmScreen(self: self_, peers: [member]), StrangerFilter.Screen())
    }

    /// The vector wrap carries no link; an earlier stored one from the same
    /// stranger is what filters it.
    func testAStrangerWhoLinkedEarlierRaisesNothing() throws {
        let alicePk = vectorString("alicePk")
        let bobPk = vectorString("bobPk")
        let store = try store()
        try store.writeDm(dm("3", from: bobPk, to: alicePk, content: "https://spam.example/x"), self: alicePk, now: 1_700_000_000)

        func push(_ communityPeers: Set<String>) -> PreparedPush? {
            PushProcessor(
                store: store,
                config: PushConfig(
                    policy: .generic, selfPubkey: alicePk, knownPeers: [],
                    strangerFilter: StrangerFilter.Policy(communityPeers: communityPeers, blockNonMembers: false),
                    secretKey: Hex.decode(vectorString("aliceSk")), nip46: nil, concord: []
                ),
                now: 1_700_000_000
            ).prepare(userInfo: napp(vectorObject("dmWrap")))
        }

        XCTAssertEqual(push([]).map(\.drop), true)
        XCTAssertEqual(push([bobPk])?.title, "Message requests", "a community member's link is a plain request")
    }
}
