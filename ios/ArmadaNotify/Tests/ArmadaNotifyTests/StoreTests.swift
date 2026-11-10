import ArmadaDB
import XCTest

@testable import ArmadaNotify

/// The extension as a SECOND WRITER into the store the WebView reads.
///
/// This is the part of the port that has no compiler to catch it: the tenant
/// ids are strings both sides have to spell identically, and the ingest
/// refusals are rules that exist in three places and are enforced by none of
/// the readers. A rule only one writer applies is a conversation the two
/// disagree about — for routing, literally a message stored where the timeline
/// never looks.
final class StoreTests: XCTestCase {

    private var db: SqliteArmadaDb!
    private var bridge: ArmadaDbBridge!
    private var store: NotifyStore!

    private let self_ = String(repeating: "a", count: 64)
    private let peer = String(repeating: "b", count: 64)
    private let community = String(repeating: "c", count: 64)
    private let channel = String(repeating: "d", count: 64)
    private let now = 1_700_000_000

    override func setUpWithError() throws {
        db = try SqliteArmadaDb(db: try SqliteDriver(path: ":memory:"))
        bridge = ArmadaDbBridge(db: db)
        store = NotifyStore(bridge: bridge)
    }

    private func rumors(tenant: String) throws -> [[String: Any]] {
        let json = try bridge.query(tenant: tenant, filters: "[{}]")
        let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8))
        return (decoded as? [[String: Any]]) ?? []
    }

    private func dm(kind: Int = 14, tags: [[String]] = [], content: String = "hi") -> OpenedDm {
        OpenedDm(
            rumorId: String(repeating: "1", count: 64), author: peer, kind: kind,
            content: content, tags: tags, createdAt: now, peers: [peer]
        )
    }

    private func chat(kind: Int = 9, tags: [[String]] = []) -> OpenedChat {
        OpenedChat(
            rumorId: String(repeating: "2", count: 64), author: peer, kind: kind,
            content: "shipped it", tags: tags, createdAt: now, ms: now * 1000, channelIdHex: channel
        )
    }

    // MARK: - Tenants

    func testTenantIdsMatchTheWebViewsSpelling() {
        // `dm17Store()` and `communityTenant()` in the TypeScript. A different
        // spelling here would store every message where nothing reads it.
        XCTAssertEqual(NotifyStore.dmTenant(self: self_), "dm17:\(self_)")
        XCTAssertEqual(NotifyStore.communityTenant(community), "c2:\(community)")
    }

    // MARK: - DM writes

    func testWritesADmIntoTheViewersTenant() throws {
        try store.writeDm(dm(), self: self_, now: now)
        let stored = try rumors(tenant: NotifyStore.dmTenant(self: self_))
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0]["pubkey"] as? String, peer)
        XCTAssertEqual(stored[0]["kind"] as? Int, 14)
        XCTAssertEqual(stored[0]["content"] as? String, "hi")
    }

    func testRecordsTheArrivalOfAMessageFromAnOffClock() throws {
        // The key and fact `readDm17Arrivals` reads (dm17Store.ts).
        try store.writeDm(dm(), self: self_, now: now, arrivedAt: now + 120)
        let key = "dm17at:\(self_):\(String(repeating: "1", count: 64))"
        let raw = try XCTUnwrap(store.kvGet(key))
        let fact = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        XCTAssertEqual(fact["at"] as? Int, now + 120)
        XCTAssertEqual(fact["sent"] as? Int, now)
        XCTAssertEqual(fact["conv"] as? String, peer)
        XCTAssertEqual(fact["in"] as? Bool, true)
    }

    func testRecordsNoArrivalWithinTheSkew() throws {
        try store.writeDm(dm(), self: self_, now: now, arrivedAt: now + 2)
        XCTAssertNil(store.kvGet("dm17at:\(self_):\(String(repeating: "1", count: 64))"))
    }

    func testStoresTheRumorAndNothingBesideIt() throws {
        // Its tags are the bytes its id commits to, so a provenance tag written
        // in here would make the row something the sender never signed — and
        // make whatever reads that tag forgeable by anyone who spells it.
        try store.writeDm(dm(tags: [["p", self_]]), self: self_, now: now)
        let stored = try rumors(tenant: NotifyStore.dmTenant(self: self_))
        XCTAssertEqual(stored[0]["tags"] as? [[String]] ?? [], [["p", self_]])
        XCTAssertNil(stored[0]["wrap"])
        XCTAssertNil(stored[0]["peer"])
    }

    func testRefusesAnExpiredDm() throws {
        // A disappearing message that arrives late is never stored. The opener
        // rejects it too, but the guarantee belongs at the write, which every
        // path goes through.
        try store.writeDm(
            dm(tags: [["expiration", String(now - 1)]]), self: self_, now: now
        )
        XCTAssertEqual(try rumors(tenant: NotifyStore.dmTenant(self: self_)).count, 0)
    }

    func testKeepsADmWhoseDeadlineHasNotPassed() throws {
        try store.writeDm(
            dm(tags: [["expiration", String(now + 60)]]), self: self_, now: now
        )
        XCTAssertEqual(try rumors(tenant: NotifyStore.dmTenant(self: self_)).count, 1)
    }

    func testStoresMiniAppState() throws {
        // Kind 3310 is a DM-plane rumor like any other (`DM_RUMOR_KINDS`), and
        // the extension is a SECOND writer into the tenant the WebView reads —
        // so a kind only one of them accepts is state that reaches the store on
        // one path and not the other. The extension needs no rule of its own
        // here: `writeDm` files what the opener handed it, and `PushProcessor`
        // separately declines to make a non-message into a notification.
        let update = OpenedDm(
            rumorId: String(repeating: "5", count: 64), author: peer, kind: 3310,
            content: #"{"move":1}"#,
            tags: [["p", self_], ["i", String(repeating: "A", count: 52)]],
            createdAt: now, peers: [peer]
        )
        try store.writeDm(update, self: self_, now: now)
        let stored = try rumors(tenant: NotifyStore.dmTenant(self: self_))
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0]["kind"] as? Int, 3310)
    }

    // MARK: - Concord writes

    func testWritesAChatRumorIntoTheCommunityTenant() throws {
        try store.writeConcord(chat(), communityId: community, now: now)
        let stored = try rumors(tenant: NotifyStore.communityTenant(community))
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0]["kind"] as? Int, 9)
    }

    func testRefusesAnotherPlanesKind() throws {
        // The other half of the plane boundary. A community's planes share one
        // tenant and a plane is read back BY KIND, so a holder of any one
        // channel's stream key could otherwise wrap a kind-3308 rumor with a
        // valid channel binding and have it served as a control edition —
        // which nothing downstream could catch, a stored rumor having no seal
        // left whose form could be checked.
        for kind in Concord.planeKinds {
            try store.writeConcord(chat(kind: kind), communityId: community, now: now)
        }
        XCTAssertEqual(try rumors(tenant: NotifyStore.communityTenant(community)).count, 0)
    }

    func testRefusesAnExpiredChatRumor() throws {
        try store.writeConcord(
            chat(tags: [["expiration", String(now - 1)]]), communityId: community, now: now
        )
        XCTAssertEqual(try rumors(tenant: NotifyStore.communityTenant(community)).count, 0)
    }

    // MARK: - Reads

    func testReadsADisplayNameFromTheLocalProfile() throws {
        try bridge.event(
            tenant: ArmadaDbTenants.main,
            rumors: """
            [{"id":"\(String(repeating: "3", count: 64))","pubkey":"\(peer)","created_at":1,\
            "kind":0,"tags":[],"content":"{\\"name\\":\\"bob\\"}"}]
            """
        )
        XCTAssertEqual(store.displayName(pubkey: peer), "bob")
    }

    func testFallsBackToDisplayNameThenNoName() throws {
        try bridge.event(
            tenant: ArmadaDbTenants.main,
            rumors: """
            [{"id":"\(String(repeating: "4", count: 64))","pubkey":"\(peer)","created_at":1,\
            "kind":0,"tags":[],"content":"{\\"display_name\\":\\"Bob B\\"}"}]
            """
        )
        XCTAssertEqual(store.displayName(pubkey: peer), "Bob B")
        // An author with no kind-0 at all has no name — a fact established by
        // looking, not a placeholder for a lookup never made. The caller words it.
        XCTAssertNil(store.displayName(pubkey: self_))
    }

    func testReadsANip29GroupNameFromItsOwnRelayTenant() throws {
        // Scoped to the relay: the same group id on two relays is two unrelated
        // groups.
        try bridge.event(
            tenant: ArmadaDbTenants.nip29(relayUrl: "wss://relay.example"),
            rumors: """
            [{"id":"\(String(repeating: "5", count: 64))","pubkey":"\(peer)","created_at":1,\
            "kind":39000,"tags":[["d","团"],["name","General"]],"content":""}]
            """
        )
        XCTAssertEqual(
            store.nip29RoomTitle(relayUrl: "wss://relay.example", groupId: "团"), "General"
        )
        XCTAssertNil(store.nip29RoomTitle(relayUrl: "wss://other.example", groupId: "团"))
    }

    func testReadsAConcordRoomTitleOutOfTheFoldedSnapshot() throws {
        // `channels` is a Map, which foldedCache encodes as a tagged object.
        try bridge.kvSet(
            key: "folded:concord2-fold:\(community)",
            value: """
            {"metadata":{"name":"Armada"},"channels":{"__t":"map","v":\
            [["\(channel)",{"name":"general"}]]}}
            """
        )
        XCTAssertEqual(
            store.concordRoomTitle(communityId: community, channelId: channel, strings: .english),
            "Armada / #general"
        )
    }

    func testConcordRoomTitleDegradesRatherThanGuessing() throws {
        try bridge.kvSet(
            key: "folded:concord2-fold:\(community)",
            value: #"{"metadata":{"name":"Armada"}}"#
        )
        XCTAssertEqual(
            store.concordRoomTitle(communityId: community, channelId: channel, strings: .english),
            "Armada"
        )
        // No fold at all (a fresh join) stays unnamed, and the caller titles
        // the notification "Chat" rather than waiting on a relay.
        XCTAssertNil(
            store.concordRoomTitle(communityId: "unknown", channelId: channel, strings: .english)
        )
    }
}

/// Presentation must not depend on persistence.
///
/// The store and the notification fail independently: a database that will not
/// open costs the message its history and its sender's name, but the text has
/// already been decrypted and refusing to show it would turn one broken thing
/// into two. This is the rule that was wrong first time round — the extension
/// bailed on a nil store and every push silently fell back to the gateway's
/// static text.
final class StorelessTests: XCTestCase {

    private let self_ = String(repeating: "a", count: 64)
    private let peer = String(repeating: "b", count: 64)

    func testPresentsANip29MessageWithNoStoreAtAll() {
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: []
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)

        let event = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        let prepared = processor.prepare(userInfo: napp(event, relays: ["wss://relay.example"]))

        XCTAssertNotNil(prepared, "a decrypted message must still be shown")
        XCTAssertEqual(prepared?.body, "Anonymous: shipped it")
        XCTAssertEqual(prepared?.threadId, "h:general")
        XCTAssertFalse(prepared?.drop ?? true)
    }

    /// A NIP-29 message arrives in the clear, so its signature is the only
    /// thing binding it to an author. Without this check the `pubkey` is just a
    /// string the sender picked — and it is used to look up the VIEWER'S stored
    /// kind-0, so naming a real contact borrows that contact's name and avatar
    /// for a communication notification on a message they never sent.
    func testRefusesANip29MessageWhoseSignatureDoesNotMatchItsAuthor() {
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: []
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)

        // Signed by Bob, claiming to be Alice.
        let forged = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it",
            forgedPubkey: vectorString("alicePk")
        )
        XCTAssertNil(processor.prepare(userInfo: napp(forged)))

        // And an event whose body was edited after signing, so its id no longer
        // hashes to the content the signature covers.
        var tampered = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        tampered["content"] = "shipped nothing"
        XCTAssertNil(processor.prepare(userInfo: napp(tampered)))

        // An unsigned one is refused too — there is nothing else to go on.
        var unsigned = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        unsigned.removeValue(forKey: "sig")
        XCTAssertNil(processor.prepare(userInfo: napp(unsigned)))
    }

    func testStillDropsTheViewersOwnMessageWithNoStore() {
        // Degrading must not lose the decisions either — an own message is
        // still not news.
        // The viewer is Alice here, so the message can actually be signed as
        // hers — the drop decision is made after the signature check.
        let config = PushConfig(
            policy: .generic, selfPubkey: vectorString("alicePk"), knownPeers: [],
            secretKey: nil, nip46: nil, concord: []
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)
        let event = signedEvent(
            secretKeyHex: vectorString("aliceSk"), kind: 9,
            tags: [["h", "general"]], content: "mine"
        )
        let prepared = processor.prepare(userInfo: napp(event))
        XCTAssertEqual(prepared?.drop, true)
    }

    /// A banned member (CORD-04) is folded off the timeline on read, and must
    /// be folded off the notification too — the same decision, made here from
    /// the decrypted author, which is the first place the ban set can be
    /// applied to a Concord wrap.
    func testDropsABannedMembersConcordMessage() {
        let concord = vectorObject("concord")
        let bobPk = vectorString("bobPk") // the vector wrap's real author
        let stream = ConcordStream(
            pubkey: concord["streamPk"] as! String,
            conversationKey: concord["convKey"] as! String,
            epoch: concord["epoch"] as! String,
            communityId: "cc",
            channelId: concord["channelId"] as! String,
            banned: [bobPk]
        )
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: [stream]
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)
        let prepared = processor.prepare(
            userInfo: napp(concord["wrap"] as! [String: Any])
        )
        XCTAssertEqual(prepared?.drop, true, "a banned member's message must not notify")
    }

    /// A message dated ahead of the local clock is HELD, not announced: the
    /// timeline hides it until its time comes (`Concord.futureHoldSecs`), so
    /// buzzing now would notify about a message the reader can't yet see, and
    /// the OS would stamp it "in 5m" from the future createdAt. Mirrors the web
    /// worker's `prepareConcord` and the Android service's FUTURE_HOLD_MS.
    /// A post its readers collapse rings nobody (CORD-04 §8, Vector `post_silenced`):
    /// an author without SEND in the Channel, or inside a running Timeout's window.
    func testSilencesACollapsedPost() {
        let concord = vectorObject("concord")
        let author = vectorString("bobPk")
        let wrap: [AnyHashable: Any] = napp(concord["wrap"] as! [String: Any])
        func prepared(_ denied: Set<String>, _ timeouts: [String: (from: Int, until: Int)]) -> Bool? {
            let stream = ConcordStream(
                pubkey: concord["streamPk"] as! String, conversationKey: concord["convKey"] as! String,
                epoch: concord["epoch"] as! String, communityId: "cc", channelId: concord["channelId"] as! String,
                banned: [], sendDenied: denied, timeouts: timeouts
            )
            let config = PushConfig(policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil, nip46: nil, concord: [stream])
            return PushProcessor(store: nil, config: config, now: 1_700_000_600).prepare(userInfo: wrap)?.drop
        }
        XCTAssertNotEqual(prepared([], [:]), true, "the baseline notifies")
        XCTAssertEqual(prepared([author], [:]), true, "no SEND in an open Channel")
        XCTAssertEqual(prepared([], [author: (from: 1_700_000_000, until: 1_700_001_000)]), true, "inside a running Timeout")
        XCTAssertNotEqual(prepared([], [author: (from: 1_700_000_000, until: 1_700_000_550)]), true, "a lapsed Timeout")
    }

    /// A reaction rings only the author it reacts to: one saying `@everyone` is not a
    /// mass mention, even where every member may mention everyone. Mirrors the web
    /// worker and the Android service.
    func testAReactionSayingEveryoneRingsNobodyElse() {
        let (wrap, stream) = streamWrap(kind: 7, content: "@everyone", tags: [["p", vectorString("bobPk")]], everyoneMayMention: true)
        let config = PushConfig(policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil, nip46: nil, concord: [stream])
        XCTAssertEqual(PushProcessor(store: nil, config: config, now: 1_700_000_600).prepare(userInfo: napp(wrap))?.drop, true)
    }

    /// A parity gap, pinned as it stands: in Vector a reaction never rings, even one to the
    /// viewer's own message (it reaches `on_community_update`, never the notifier); here it
    /// still does, as in the web worker. Flip the assertion when that changes.
    func testAReactionToTheViewersMessageStillRingsUnlikeVector() {
        let (wrap, stream) = streamWrap(kind: 7, content: "🔥", tags: [["e", String(repeating: "ab", count: 32)], ["p", self_]])
        let config = PushConfig(policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil, nip46: nil, concord: [stream])
        XCTAssertNotEqual(PushProcessor(store: nil, config: config, now: 1_700_000_600).prepare(userInfo: napp(wrap))?.drop, true)
    }

    /// A malformed `ms` tag makes the rumor malformed, so it is dropped, never announced as
    /// a wrap that wouldn't open (CORD-02 §5, Vector `resolve_ms_strict`). Mirrors the web
    /// worker and the Android service.
    func testDropsAMessageWithAMalformedMsTag() {
        for ms in ["1000", "05", "x"] {
            let (wrap, stream) = streamWrap(kind: 9, content: "hi", tags: [["ms", ms]])
            let config = PushConfig(policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil, nip46: nil, concord: [stream])
            XCTAssertEqual(PushProcessor(store: nil, config: config, now: 1_700_000_600).prepare(userInfo: napp(wrap))?.drop, true, ms)
        }
    }

    /// A chat wrap by bob at a fresh stream address, and the stream that opens it.
    private func streamWrap(kind: Int, content: String, tags: [[String]], everyoneMayMention: Bool = false) -> ([String: Any], ConcordStream) {
        let streamSk = String(repeating: "03", count: 32)
        let streamPk = Secp256k1.xonlyPublicKey(secretKey: Hex.decode(streamSk)!)!
        let convKey = Secp256k1.conversationKey(secretKey: Hex.decode(streamSk)!, peerPubkeyHex: streamPk)!
        let channel = String(repeating: "cd", count: 32)
        var rumor: [String: Any] = [
            "pubkey": vectorString("bobPk"), "created_at": 1_700_000_500, "kind": kind, "content": content,
            "tags": [["channel", channel], ["epoch", "1"]] + tags,
        ]
        rumor["id"] = NostrEvent.parse(rumor)!.computedId
        func json(_ o: [String: Any]) -> String { String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)! }
        let seal = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: Concord.kindSealEncrypted, tags: [],
            content: Nip44.encrypt(conversationKey: convKey, plaintext: json(rumor))!, createdAt: 1_700_000_500
        )
        let wrap = signedEvent(
            secretKeyHex: streamSk, kind: 1059, tags: [["p", vectorString("alicePk")]],
            content: Nip44.encrypt(conversationKey: convKey, plaintext: json(seal))!, createdAt: 1_700_000_500
        )
        let stream = ConcordStream(
            pubkey: streamPk, conversationKey: Hex.encode(convKey), epoch: "1", communityId: "cc", channelId: channel,
            banned: [], mentionEveryoneAnyone: everyoneMayMention
        )
        return (wrap, stream)
    }

    /// At a restricted Channel's read address a post rings only from those who manage it (CORD-03 §1 Held posts).
    func testRingsOnlyManagersInARestrictedChannel() {
        let concord = vectorObject("concord")
        let author = vectorString("bobPk")
        let wrap: [AnyHashable: Any] = napp(concord["wrap"] as! [String: Any])
        func prepared(_ posters: Set<String>?) -> Bool? {
            let stream = ConcordStream(
                pubkey: concord["streamPk"] as! String, conversationKey: concord["convKey"] as! String,
                epoch: concord["epoch"] as! String, communityId: "cc", channelId: concord["channelId"] as! String,
                banned: [], postAuthors: posters
            )
            let config = PushConfig(policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil, nip46: nil, concord: [stream])
            return PushProcessor(store: nil, config: config, now: 1_700_000_600).prepare(userInfo: wrap)?.drop
        }
        XCTAssertNotEqual(prepared(nil), true, "an unrestricted Channel")
        XCTAssertNotEqual(prepared([author]), true, "a manager's post")
        XCTAssertEqual(prepared(["00" + String(repeating: "1", count: 62)]), true, "a post nobody vouches for")
    }

    /// A Community sender is named by the Nickname they go by there (CORD-04 §10, Vector `sender_in`).
    func testNamesTheSenderByTheirNickname() {
        let concord = vectorObject("concord")
        let author = vectorString("bobPk")
        let stream = ConcordStream(
            pubkey: concord["streamPk"] as! String, conversationKey: concord["convKey"] as! String,
            epoch: concord["epoch"] as! String, communityId: "cc", channelId: concord["channelId"] as! String,
            banned: [], nicknames: [author: "Captain"]
        )
        let config = PushConfig(policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil, nip46: nil, concord: [stream])
        let prepared = PushProcessor(store: nil, config: config, now: 1_700_000_600)
            .prepare(userInfo: napp(concord["wrap"] as! [String: Any]))
        XCTAssertTrue((prepared?.title ?? "").contains("Captain") || (prepared?.body ?? "").contains("Captain"), "\(String(describing: prepared))")
    }

    func testHoldsAFutureDatedConcordMessage() {
        let concord = vectorObject("concord")
        let stream = ConcordStream(
            pubkey: concord["streamPk"] as! String,
            conversationKey: concord["convKey"] as! String,
            epoch: concord["epoch"] as! String,
            communityId: "cc",
            channelId: concord["channelId"] as! String,
            banned: []
        )
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: [stream]
        )
        let wrap: [AnyHashable: Any] = napp(concord["wrap"] as! [String: Any])
        // A clock well behind the vector's rumor: it reads as future and holds.
        XCTAssertEqual(
            PushProcessor(store: nil, config: config, now: 1_699_000_000)
                .prepare(userInfo: wrap)?.drop,
            true,
            "a future-dated message must not notify"
        )
        // Baseline: with the clock at/after the rumor (dated 1_700_000_500),
        // the same wrap notifies.
        XCTAssertNotEqual(
            PushProcessor(store: nil, config: config, now: 1_700_000_500)
                .prepare(userInfo: wrap)?.drop,
            true,
            "a message no longer in the future must notify"
        )
        // A device clock behind the relays', corrected by the app's offset, judges it due.
        let corrected = ConcordStream(
            pubkey: stream.pubkey, conversationKey: stream.conversationKey, epoch: stream.epoch,
            communityId: stream.communityId, channelId: stream.channelId, banned: [],
            clockOffsetMs: 1_001_000_000
        )
        let correctedConfig = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: [corrected]
        )
        XCTAssertNotEqual(
            PushProcessor(store: nil, config: correctedConfig, now: 1_699_000_000)
                .prepare(userInfo: wrap)?.drop,
            true,
            "the relays' clock decides what's dated ahead"
        )
    }

    /// A channel at "mentions only" wakes iOS for every message (the gateway
    /// can't read the encrypted wrap), so the extension — which decrypts — must
    /// drop a message that doesn't `#p`-tag the viewer. Mirrors the Android
    /// service's `mentionOnly`.
    func testDropsANonMentionMessageUnderMentionsOnly() {
        let concord = vectorObject("concord")
        let wrap = concord["wrap"] as! [String: Any]
        func stream(mentionOnly: Bool) -> ConcordStream {
            ConcordStream(
                pubkey: concord["streamPk"] as! String,
                conversationKey: concord["convKey"] as! String,
                epoch: concord["epoch"] as! String,
                communityId: "cc",
                channelId: concord["channelId"] as! String,
                banned: [],
                mentionOnly: mentionOnly
            )
        }
        func processor(mentionOnly: Bool) -> PushProcessor {
            PushProcessor(
                store: nil,
                config: PushConfig(
                    policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
                    nip46: nil, concord: [stream(mentionOnly: mentionOnly)]
                ),
                // At/after the rumor's own time (dated 1_700_000_500), so the
                // future-hold isn't what decides these — the mention rule is.
                now: 1_700_000_500
            )
        }
        // Baseline: at "all messages" the same wrap (author bobPk, no `#p` for
        // the all-`a` viewer) notifies.
        XCTAssertNotEqual(
            processor(mentionOnly: false)
                .prepare(userInfo: napp(wrap))?.drop,
            true,
            "a non-mention notifies a channel set to all messages"
        )
        // Mentions-only: the same non-mention wrap is dropped.
        XCTAssertEqual(
            processor(mentionOnly: true)
                .prepare(userInfo: napp(wrap))?.drop,
            true,
            "a non-mention must not notify a mentions-only channel"
        )
    }

    /// A muted channel (level `nothing`) raises no gateway subscription, but a
    /// lingering one can still wake iOS. The stream is kept in the config with
    /// its key so the extension OPENS the wrap and drops it, rather than
    /// presenting the gateway's static fallback text. Mirrors the web worker's
    /// `prepareConcord` and the Android service.
    func testDropsAMutedChannelMessage() {
        let concord = vectorObject("concord")
        let wrap = concord["wrap"] as! [String: Any]
        func stream(muted: Bool) -> ConcordStream {
            ConcordStream(
                pubkey: concord["streamPk"] as! String,
                conversationKey: concord["convKey"] as! String,
                epoch: concord["epoch"] as! String,
                communityId: "cc",
                channelId: concord["channelId"] as! String,
                banned: [],
                muted: muted
            )
        }
        func processor(muted: Bool) -> PushProcessor {
            PushProcessor(
                store: nil,
                config: PushConfig(
                    policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
                    nip46: nil, concord: [stream(muted: muted)]
                ),
                now: 1_700_000_500
            )
        }
        // Baseline: not muted, the same wrap notifies.
        XCTAssertNotEqual(
            processor(muted: false)
                .prepare(userInfo: napp(wrap))?.drop,
            true,
            "a message on an unmuted channel notifies"
        )
        // Muted: the same wrap is dropped rather than shown.
        XCTAssertEqual(
            processor(muted: true)
                .prepare(userInfo: napp(wrap))?.drop,
            true,
            "a message on a muted channel must not notify"
        )
    }
}

/// Who a notification says it is FROM.
///
/// `PreparedPush.sender` is what the extension turns into a communication
/// notification, which is the only way iOS shows a person instead of the app
/// icon. It therefore carries a privacy rule, not just a name: it is present
/// exactly where the sender is already being named in the body.
final class SenderIdentityTests: XCTestCase {

    private let self_ = String(repeating: "a", count: 64)
    private let peer = String(repeating: "b", count: 64)

    private func config(
        knownPeers: Set<String> = [],
        policy: DmRequestLevel = .generic,
        knownConversations: Set<String> = [],
        mutedPeers: Set<String> = [],
        directMessages: Bool = true,
        dmLevels: [String: DmNotificationLevel] = [:]
    ) -> PushConfig {
        PushConfig(
            policy: policy, directMessages: directMessages, dmLevels: dmLevels,
            selfPubkey: self_, knownPeers: knownPeers,
            knownConversations: knownConversations, mutedPeers: mutedPeers,
            secretKey: nil, nip46: nil, concord: []
        )
    }

    func testCommunityAvatarOnlyForKnownPeers() {
        let stranger = String(repeating: "f", count: 64)
        let cfg = config(knownPeers: [peer])
        XCTAssertTrue(PushProcessor.communityAvatarShown(author: peer, config: cfg))
        XCTAssertFalse(
            PushProcessor.communityAvatarShown(author: stranger, config: cfg),
            "anyone with a community's key can post; their face stays off the lock screen"
        )
        let all = PushConfig(
            policy: .generic, directMessages: true, dmLevels: [:],
            selfPubkey: self_, knownPeers: [], knownConversations: [], mutedPeers: [],
            secretKey: nil, nip46: nil, concord: [],
            mediaPolicy: MediaPolicy(allCommunityAvatars: true)
        )
        XCTAssertTrue(PushProcessor.communityAvatarShown(author: stranger, config: all))
    }

    func testGroupTrustAndTapStayScopedToTheExactConversation() {
        let other = String(repeating: "c", count: 64)
        let peers = [peer, other].sorted()
        let key = peers.joined(separator: ",")
        let groupConfig = config(knownConversations: [key])

        XCTAssertTrue(PushProcessor.isKnownDm(peers: peers, config: groupConfig))
        XCTAssertFalse(
            PushProcessor.isKnownDm(peers: [peer], config: groupConfig),
            "group participation must not trust the author in an unrelated 1:1"
        )
        XCTAssertEqual(PushProcessor.dmThreadId(peers: peers), "dm-\(key)")
        // The thread id is the conversation KEY (hex, an internal identity);
        // the path is a ROUTE, and every route in the app spells a pubkey as
        // an npub. The two are deliberately not the same string.
        XCTAssertEqual(
            PushProcessor.dmPath(peers: peers),
            "/dm/\(peers.map { Bech32.npub($0)! }.joined(separator: ","))"
        )
        XCTAssertFalse(PushProcessor.dmPath(peers: peers).contains(peer))
        XCTAssertTrue(
            PushProcessor.isMutedDm(
                peers: peers,
                config: config(knownConversations: [key], mutedPeers: [other])
            ),
            "one muted participant hides the whole group, matching the DM list"
        )
    }

    func testPushConfigCarriesMutedAuthorsSeparatelyFromKnownRooms() {
        let key = [peer, String(repeating: "c", count: 64)].sorted().joined(separator: ",")
        let parsed = PushConfig.parse(json: """
        {"policy":"full","directMessages":false,"dmLevels":{"\(key)":"all"},
         "self":"\(self_)","knownPeers":[],
         "knownConversations":["\(key)"],"mutedPeers":["\(peer)"]}
        """)
        XCTAssertEqual(parsed?.knownConversations, Set([key]))
        XCTAssertEqual(parsed?.mutedPeers, Set([peer]))
        XCTAssertEqual(parsed?.directMessages, false)
        XCTAssertEqual(parsed?.dmLevels[key], .all)
    }

    func testPushConfigCarriesEveryoneAuthorityAndMatchesOnlyTheExactToken() {
        let moderator = String(repeating: "d", count: 64)
        let parsed = PushConfig.parse(json: """
        {"policy":"generic","self":"\(self_)","knownPeers":[],
         "concord":[{"pk":"\(peer)","convKey":"\(peer)","epoch":"1",
         "communityId":"cc","channelId":"dd",
         "mentionEveryoneAuthors":["\(moderator)"],"mentionOnly":true,"muted":true}]}
        """)
        XCTAssertEqual(parsed?.concord.first?.mentionEveryoneAuthors, Set([moderator]))
        XCTAssertEqual(parsed?.concord.first?.muted, true)
        XCTAssertEqual(parsed?.concord.first?.mentionEveryoneAnyone, false)
        let anyone = PushConfig.parse(json: """
        {"policy":"generic","self":"\(self_)","knownPeers":[],
         "concord":[{"pk":"\(peer)","convKey":"\(peer)","epoch":"1",
         "communityId":"cc","channelId":"dd","mentionEveryoneAnyone":true}]}
        """)
        XCTAssertEqual(anyone?.concord.first?.mentionEveryoneAnyone, true)
        XCTAssertTrue(PushProcessor.hasEveryoneMention("Heads up @everyone!"))
        XCTAssertFalse(PushProcessor.hasEveryoneMention("mail@everyone.example"))
        XCTAssertFalse(PushProcessor.hasEveryoneMention("@everyone_else"))
        XCTAssertFalse(PushProcessor.hasEveryoneMention("@everyone你"))
        XCTAssertFalse(PushProcessor.hasEveryoneMention("@Everyone"))
    }

    func testConcordPresentsOnlyWhatWasSentDuringTheMembership() {
        let parsed = PushConfig.parse(json: """
        {"policy":"generic","self":"\(self_)","knownPeers":[],
         "concord":[{"pk":"\(peer)","convKey":"\(peer)","epoch":"1",
         "communityId":"cc","channelId":"dd","joinedAtMs":2700}]}
        """)
        XCTAssertEqual(parsed?.concord.first?.joinedAtMs, 2700)
        XCTAssertFalse(PushProcessor.sentDuringMembership(createdAt: 1, joinedAtMs: 2000))
        XCTAssertTrue(PushProcessor.sentDuringMembership(createdAt: 2, joinedAtMs: 2700))
        XCTAssertTrue(PushProcessor.sentDuringMembership(createdAt: 3, joinedAtMs: 2000))
        XCTAssertTrue(PushProcessor.sentDuringMembership(createdAt: 1, joinedAtMs: nil))
    }

    func testExactDmLevelOverridesGlobalFallbackWithoutWideningGroupKeys() {
        let other = String(repeating: "c", count: 64)
        let group = [peer, other].sorted()
        let groupKey = group.joined(separator: ",")
        let onlyGroup = config(
            directMessages: false,
            dmLevels: [groupKey: .mentions, peer: .nothing]
        )

        XCTAssertEqual(
            PushProcessor.dmNotificationLevel(peers: group, config: onlyGroup),
            .mentions,
            "an explicitly enabled group stays enabled when the global fallback is off"
        )
        XCTAssertEqual(
            PushProcessor.dmNotificationLevel(peers: [peer], config: onlyGroup),
            .nothing,
            "the group's level must not leak into a one-to-one room"
        )
        XCTAssertEqual(
            PushProcessor.dmNotificationLevel(peers: [other], config: onlyGroup),
            .nothing,
            "an unrelated room inherits the disabled global fallback"
        )
        XCTAssertEqual(
            PushProcessor.dmNotificationLevel(
                peers: [other], config: config(directMessages: true)
            ),
            .all,
            "rooms without an exact level inherit the enabled global fallback"
        )
    }

    func testANip29MessageNamesItsSender() {
        let processor = PushProcessor(store: nil, config: config(), now: 1_700_000_000)
        let bob = vectorString("bobPk")
        let event = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        let prepared = processor.prepare(userInfo: napp(event))

        XCTAssertEqual(prepared?.sender?.id, bob, "the pubkey is the conversation's identity")
        XCTAssertEqual(prepared?.sender?.name, "Anonymous")
        // No store, so no kind-0 and no picture — the notification falls back to
        // the monogram, which is still the person.
        XCTAssertNil(prepared?.sender?.avatarUrl)
    }

    /// The rule this type exists to carry. A stranger picks their own name AND
    /// their own avatar, so a message request must reach the screen with
    /// neither — a content-blind ping cannot become a person.
    func testAMessageRequestHasNoSender() {
        let alicePk = vectorString("alicePk")
        let processor = PushProcessor(
            store: nil,
            config: PushConfig(
                policy: .generic, selfPubkey: alicePk, knownPeers: [],
                secretKey: Hex.decode(vectorString("aliceSk")), nip46: nil, concord: []
            ),
            now: 1_700_000_000
        )
        let prepared = processor.prepare(
            userInfo: napp(vectorObject("dmWrap"))
        )

        XCTAssertEqual(prepared?.title, "Message requests", "the request ping, not the message")
        XCTAssertNil(prepared?.sender, "a stranger must not become a communication notification")
    }

    /// The same wrap from a KNOWN sender is a person, and says so.
    func testAKnownSenderIsNamed() {
        let alicePk = vectorString("alicePk")
        let bobPk = vectorString("bobPk")
        let processor = PushProcessor(
            store: nil,
            config: PushConfig(
                policy: .generic, selfPubkey: alicePk, knownPeers: [bobPk],
                secretKey: Hex.decode(vectorString("aliceSk")), nip46: nil, concord: []
            ),
            now: 1_700_000_000
        )
        let prepared = processor.prepare(
            userInfo: napp(vectorObject("dmWrap"))
        )

        XCTAssertEqual(prepared?.sender?.id, bobPk)
        XCTAssertNil(prepared?.sender?.groupName, "a DM is not a group conversation")
    }
}
