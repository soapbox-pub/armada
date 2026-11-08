import XCTest
@testable import ArmadaNotify

/// The extension's port of `reactionContent.ts`, against the same cases as `chat.test.ts`.
final class ReactionContentTests: XCTestCase {
    func testTakesLikesShortcodesAndShortGlyphs() {
        XCTAssertTrue(ReactionContent.renderable(""))
        XCTAssertTrue(ReactionContent.renderable("+"))
        XCTAssertTrue(ReactionContent.renderable(":catJAM:"))
        XCTAssertTrue(ReactionContent.renderable("🔥"))
    }

    func testDropsJunk() {
        XCTAssertFalse(ReactionContent.renderable(":catclap:https://i.nostr.build/lLMrw.gif"))
        XCTAssertFalse(ReactionContent.renderable("this is a whole sentence"))
        XCTAssertFalse(ReactionContent.renderable("a\u{00A0}b"))
    }
}
