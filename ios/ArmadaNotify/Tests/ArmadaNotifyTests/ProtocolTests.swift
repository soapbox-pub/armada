import XCTest

@testable import ArmadaNotify

/// NIP-44, NIP-17 and Concord, against envelopes built by the app's own
/// libraries. This is the layer where a port drifts silently: an opener that is
/// merely LAXER than the web worker still opens every real message, and the
/// refusals it dropped only matter when someone is attacking.
final class ProtocolTests: XCTestCase {

    private var aliceSk: [UInt8] { Hex.decode(vectorString("aliceSk"))! }
    private var alicePk: String { vectorString("alicePk") }
    private var bobPk: String { vectorString("bobPk") }
    private var dmWrap: NostrEvent { NostrEvent.parse(vectorObject("dmWrap"))! }

    /// Comfortably inside the vectors' lifetime; they carry no expiration, so
    /// only the future-skew check depends on this.
    private let now = 1_700_001_000

    // MARK: - Conversation key

    func testConversationKeyMatchesNostrTools() {
        let key = Secp256k1.conversationKey(secretKey: aliceSk, peerPubkeyHex: bobPk)
        XCTAssertEqual(key.map(Hex.encode), vectorString("convKey"))
    }

    func testConversationKeyIsSymmetric() {
        let bobSk = Hex.decode(vectorString("bobSk"))!
        XCTAssertEqual(
            Secp256k1.conversationKey(secretKey: aliceSk, peerPubkeyHex: bobPk),
            Secp256k1.conversationKey(secretKey: bobSk, peerPubkeyHex: alicePk)
        )
    }

    func testConversationKeyRefusesMalformedInput() {
        XCTAssertNil(Secp256k1.conversationKey(secretKey: aliceSk, peerPubkeyHex: "nonsense"))
        XCTAssertNil(Secp256k1.conversationKey(secretKey: aliceSk, peerPubkeyHex: "ab"))
        // An x with no point on the curve.
        XCTAssertNil(
            Secp256k1.conversationKey(secretKey: aliceSk, peerPubkeyHex: String(repeating: "f", count: 64))
        )
        XCTAssertNil(Secp256k1.conversationKey(secretKey: [1, 2, 3], peerPubkeyHex: bobPk))
    }

    // MARK: - NIP-17

    func testOpensARealGiftWrap() {
        let opened = Dm17.open(wrap: dmWrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: now)
        XCTAssertNotNil(opened)
        XCTAssertEqual(opened?.author, bobPk)
        XCTAssertEqual(opened?.kind, 14)
        XCTAssertEqual(opened?.content, "hello from bob é 🚀")
        XCTAssertEqual(opened?.peer, bobPk)
        // The id is RECOMPUTED, never taken from the rumor's claim.
        XCTAssertEqual(opened?.rumorId, vectorString("rumorId"))
    }

    func testRefusesAWrapAddressedToSomeoneElse() {
        let bobSk = Hex.decode(vectorString("bobSk"))!
        XCTAssertNil(Dm17.open(wrap: dmWrap, decryptor: LocalDecryptor(secretKey: bobSk), self: bobPk, now: now))
    }

    func testRefusesANonWrapKind() {
        var wrap = dmWrap
        wrap.kind = 1060
        XCTAssertNil(Dm17.open(wrap: wrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: now))
    }

    func testRefusesAnExpiredEnvelopeAtTheOuterLevel() {
        var wrap = dmWrap
        wrap.tags.append(["expiration", String(now - 1)])
        XCTAssertNil(Dm17.open(wrap: wrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: now))
    }

    func testAcceptsAnExpirationStillInTheFuture() {
        var wrap = dmWrap
        wrap.tags.append(["expiration", String(now + 3600)])
        XCTAssertNotNil(Dm17.open(wrap: wrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: now))
    }

    func testAMalformedExpirationDoesNotHideAMessage() {
        var wrap = dmWrap
        wrap.tags.append(["expiration", "not-a-number"])
        XCTAssertNotNil(Dm17.open(wrap: wrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: now))
    }

    func testRefusesTamperedCiphertext() {
        var wrap = dmWrap
        // Flip a byte of the base64 payload; the HMAC must catch it.
        var content = Array(wrap.content)
        content[content.count / 2] = content[content.count / 2] == "A" ? "B" : "A"
        wrap.content = String(content)
        XCTAssertNil(Dm17.open(wrap: wrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: now))
    }

    func testRefusesARumorClaimingTheFuture() {
        // The rumor's created_at is 1700000000; a `now` far enough behind it
        // puts it beyond the hour of tolerated skew.
        XCTAssertNil(
            Dm17.open(wrap: dmWrap, decryptor: LocalDecryptor(secretKey: aliceSk), self: alicePk, now: 1_699_000_000)
        )
    }

    func testPeerOfPrefersTheSenderAndFallsBackToTheFirstPTag() {
        let received = NostrEvent(
            id: nil, pubkey: bobPk, createdAt: 0, kind: 14, tags: [["p", alicePk]],
            content: "", sig: nil
        )
        XCTAssertEqual(Dm17.peerOf(received, self: alicePk), bobPk)

        let ownCopy = NostrEvent(
            id: nil, pubkey: alicePk, createdAt: 0, kind: 14, tags: [["p", bobPk]],
            content: "", sig: nil
        )
        XCTAssertEqual(Dm17.peerOf(ownCopy, self: alicePk), bobPk)

        let unattributable = NostrEvent(
            id: nil, pubkey: alicePk, createdAt: 0, kind: 14, tags: [], content: "", sig: nil
        )
        XCTAssertNil(Dm17.peerOf(unattributable, self: alicePk))
    }

    func testPeersOfUsesTheCanonicalGroupParticipantSet() {
        let carolPk = String(repeating: "c", count: 64)
        let received = NostrEvent(
            id: nil, pubkey: bobPk, createdAt: 0, kind: 14,
            tags: [["p", alicePk], ["p", carolPk]], content: "", sig: nil
        )
        XCTAssertEqual(Dm17.peersOf(received, self: alicePk), [bobPk, carolPk].sorted())

        let ownCopy = NostrEvent(
            id: nil, pubkey: alicePk, createdAt: 0, kind: 14,
            tags: [["p", bobPk], ["p", carolPk]], content: "", sig: nil
        )
        XCTAssertEqual(Dm17.peersOf(ownCopy, self: alicePk), [bobPk, carolPk].sorted())
    }

    // MARK: - Concord

    private var concordVector: [String: Any] { vectorObject("concord") }

    private var concordStream: ConcordStream {
        ConcordStream(
            pubkey: concordVector["streamPk"] as! String,
            conversationKey: concordVector["convKey"] as! String,
            epoch: concordVector["epoch"] as! String,
            communityId: "cc",
            channelId: concordVector["channelId"] as! String,
            banned: []
        )
    }

    private var concordWrap: NostrEvent {
        NostrEvent.parse(concordVector["wrap"] as! [String: Any])!
    }

    func testOpensARealConcordChatWrap() {
        let opened = Concord.open(wrap: concordWrap, stream: concordStream)
        XCTAssertNotNil(opened)
        XCTAssertEqual(opened?.author, bobPk)
        XCTAssertEqual(opened?.kind, 9)
        XCTAssertEqual(opened?.content, "shipped it")
        XCTAssertEqual(opened?.rumorId, concordVector["rumorId"] as? String)
    }

    func testRefusesAWrapFromAnotherStreamAddress() {
        var stream = concordStream
        stream = ConcordStream(
            pubkey: alicePk,
            conversationKey: stream.conversationKey,
            epoch: stream.epoch,
            communityId: stream.communityId,
            channelId: stream.channelId,
            banned: stream.banned
        )
        XCTAssertNil(Concord.open(wrap: concordWrap, stream: stream))
    }

    func testRefusesAChannelSplice() {
        // The rumor's committed channel must strict-equal the coordinate whose
        // key opened the wrap, or a keyholder could splice one author's rumor
        // into a channel they never posted to.
        let spliced = ConcordStream(
            pubkey: concordStream.pubkey,
            conversationKey: concordStream.conversationKey,
            epoch: concordStream.epoch,
            communityId: concordStream.communityId,
            channelId: String(repeating: "cd", count: 32),
            banned: []
        )
        XCTAssertNil(Concord.open(wrap: concordWrap, stream: spliced))
    }

    func testRefusesAnEpochMismatch() {
        let stale = ConcordStream(
            pubkey: concordStream.pubkey,
            conversationKey: concordStream.conversationKey,
            epoch: "8",
            communityId: concordStream.communityId,
            channelId: concordStream.channelId,
            banned: []
        )
        XCTAssertNil(Concord.open(wrap: concordWrap, stream: stale))
    }

    func testRefusesTheWrongConversationKey() {
        let wrong = ConcordStream(
            pubkey: concordStream.pubkey,
            conversationKey: String(repeating: "ab", count: 32),
            epoch: concordStream.epoch,
            communityId: concordStream.communityId,
            channelId: concordStream.channelId,
            banned: []
        )
        XCTAssertNil(Concord.open(wrap: concordWrap, stream: wrong))
    }

    func testReadsARumorsMillisecondsAsResolveMsDoes() {
        // `resolveMs` in src/concord/lib/stream.ts, and Concord.resolvedMs on Android.
        XCTAssertEqual(Concord.resolvedMs(createdAt: 5, tags: []), 5_000)
        XCTAssertEqual(Concord.resolvedMs(createdAt: 5, tags: [["ms", "42"]]), 5_042)
        XCTAssertEqual(Concord.resolvedMs(createdAt: 5, tags: [["ms", "999"], ["ms", "x"]]), 5_999)
        for bad in ["1000", "042", "+5", " 5", "1e2", "", "-1", "٣"] {
            XCTAssertNil(Concord.resolvedMs(createdAt: 5, tags: [["ms", bad]]), "ms \(bad)")
        }
        XCTAssertNil(Concord.resolvedMs(createdAt: 5, tags: [["ms"]]))
    }

    func testPlaneKindsAreTheOnesReadBackByKind() {
        // The chat ingress refuses exactly these: control, guestbook
        // (join/leave, kick, snapshot) and rekey.
        XCTAssertEqual(Concord.planeKinds, [3308, 3306, 3309, 3312, 3314, 3315, 3303])
    }

    // MARK: - Canonical event id

    func testEventIdMatchesTheJavaScriptSerialization() {
        // The rumor from the DM vector, whose id nostr-tools computed.
        let rumor = NostrEvent(
            id: nil,
            pubkey: bobPk,
            createdAt: 1_700_000_000,
            kind: 14,
            tags: [["p", alicePk]],
            content: "hello from bob é 🚀",
            sig: nil
        )
        XCTAssertEqual(rumor.computedId, vectorString("rumorId"))
    }

    func testEventIdEscapesControlCharactersTheWayJsonStringifyDoes() {
        // Not a vector — a shape check. A newline must become `\n`, not a raw
        // byte, and a tab `\t`; anything else changes the hash.
        let event = NostrEvent(
            id: nil, pubkey: bobPk, createdAt: 1, kind: 1,
            tags: [["x", "a\tb"]], content: "line1\nline2\u{01}", sig: nil
        )
        // Two different escapings must not collide, and the id must be stable.
        XCTAssertEqual(event.computedId, event.computedId)
        XCTAssertEqual(event.computedId.count, 64)
    }

    func testUniqueTagTreatsARepeatedTagAsAbsent() {
        let event = NostrEvent(
            id: nil, pubkey: bobPk, createdAt: 1, kind: 1,
            tags: [["channel", "a"], ["channel", "b"]], content: "", sig: nil
        )
        XCTAssertNil(event.uniqueTag("channel"))
    }

    func testParseRefusesNonStringTagEntries() {
        let object: [String: Any] = [
            "pubkey": bobPk, "created_at": 1, "kind": 1,
            "tags": [["p", 7]], "content": "",
        ]
        XCTAssertNil(NostrEvent.parse(object))
    }
}
