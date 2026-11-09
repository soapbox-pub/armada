import XCTest
@testable import ArmadaNotify

/// The extension's port of `roleMentions.ts`, checked against the same cases as
/// `roleMentions.test.ts` and Android's `RoleMentionsTest`.
final class RoleMentionsTests: XCTestCase {
    let mods = String(repeating: "a", count: 64)
    let quiet = String(repeating: "b", count: 64)
    lazy var held = [RoleMentions.Held(id: mods, name: "Mods", anyone: true), RoleMentions.Held(id: quiet, name: "Quiet", anyone: false)]

    func testPingsAHeldMentionableRoleNamedInTheText() {
        XCTAssertTrue(RoleMentions.pings(content: "hey @Mods", tags: [["role", mods]], held: held, authorMentionsAny: false))
    }

    func testATagWithoutItsNameInTheTextPingsNobody() {
        XCTAssertFalse(RoleMentions.pings(content: "hey all", tags: [["role", mods]], held: held, authorMentionsAny: false))
    }

    func testARoleThatIsntMentionablePingsOnlyFromAnAuthorWhoMayMentionAny() {
        XCTAssertFalse(RoleMentions.pings(content: "hey @Quiet", tags: [["role", quiet]], held: held, authorMentionsAny: false))
        XCTAssertTrue(RoleMentions.pings(content: "hey @Quiet", tags: [["role", quiet]], held: held, authorMentionsAny: true))
    }

    func testARoleWithAnEmptyNamePingsNobody() {
        // An empty name would match any `@`.
        let unnamed = [RoleMentions.Held(id: mods, name: "", anyone: true)]
        XCTAssertFalse(RoleMentions.pings(content: "hey @bob", tags: [["role", mods]], held: unnamed, authorMentionsAny: true))
    }

    func testReadsOnlyLowercaseIdsTheFirstSixteenDistinct() {
        XCTAssertEqual(RoleMentions.ids([["role", mods.uppercased()]]), [])
        let many = (0..<20).map { ["role", String(format: "%064x", $0)] }
        XCTAssertEqual(RoleMentions.ids(many).count, 16)
        XCTAssertEqual(RoleMentions.ids([["role", mods], ["role", mods]]), [mods])
    }

    func testMatchesTheNameByteForByte() {
        // A precomposed é in the text doesn't name a Role spelled with a combining accent.
        let decomposed = [RoleMentions.Held(id: mods, name: "Cafe\u{301}", anyone: true)]
        XCTAssertFalse(RoleMentions.pings(content: "@Caf\u{E9}", tags: [["role", mods]], held: decomposed, authorMentionsAny: false))
        XCTAssertTrue(RoleMentions.pings(content: "@Cafe\u{301}", tags: [["role", mods]], held: decomposed, authorMentionsAny: false))
    }

    func testParsesTheConfigsRoles() {
        let parsed = RoleMentions.parse([["id": mods, "name": "Mods", "anyone": true], ["id": "x"]])
        XCTAssertEqual(parsed, [RoleMentions.Held(id: mods, name: "Mods", anyone: true)])
    }
}
