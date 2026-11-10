import Foundation

/// A fully-opened, verified NIP-17 rumor, attributed to its conversation.
struct OpenedDm {
    let rumorId: String
    /// Verified author — the seal's signer, which equals the rumor's pubkey.
    let author: String
    let kind: Int
    let content: String
    let tags: [[String]]
    let createdAt: Int
    /// Everyone in the conversation except the viewer, sorted.
    let peers: [String]
    /// Backward-compatible shorthand for a 1:1's sole peer.
    var peer: String { peers[0] }
}

/// NIP-17 gift-wrap opening: `wrap(1059) → seal(13) → rumor`.
///
/// A port of `openDmWrap` in `src/lib/nip17/protocol.ts`, refusal for refusal.
/// That matters more than sharing any particular line of it: a notification
/// path that checked FEWER things than the app would be a second, laxer reader
/// of the same bytes, and the one that runs while nobody is watching.
enum Dm17 {

    static let kindChat = 14
    static let kindFile = 15
    static let kindSeal = 13
    static let kindWrap = 1059

    /// Rumors claiming to be further in the future than this are refused.
    private static let maxFutureSkewSecs = 3600

    /// KV prefix of the arrival facts, `dm17at:<self>:<rumorId>` — the port of
    /// `DM_ARRIVAL_PREFIX`. A message that arrived live is ordered, counted unread
    /// and notified by when it arrived, where its sender's clock put it more than
    /// `arrivalSkewSecs` away; the app reads the fact this extension writes.
    static let arrivalPrefix = "dm17at:"

    /// A gap within this is latency, not a clock. The port of `ARRIVAL_SKEW_SECS`.
    static let arrivalSkewSecs = 2

    /// Whether a message that arrived at `at` keeps that as its time. The port of `arrivalCounts`.
    static func arrivalCounts(kind: Int, createdAt: Int, at: Int) -> Bool {
        (kind == kindChat || kind == kindFile) && abs(at - createdAt) > arrivalSkewSecs
    }

    static func arrivalKey(self selfPubkey: String, rumorId: String) -> String {
        "\(arrivalPrefix)\(selfPubkey):\(rumorId)"
    }

    /// The fact recorded for `opened` arriving at `at`, or nil where none is:
    /// `{ at, sent, conv, in }`, the shape `Dm17Arrival` reads.
    static func arrivalFact(_ opened: OpenedDm, self selfPubkey: String, at: Int) -> String? {
        guard arrivalCounts(kind: opened.kind, createdAt: opened.createdAt, at: at), !opened.peers.isEmpty else { return nil }
        let fact: [String: Any] = [
            "at": at,
            "sent": opened.createdAt,
            "conv": opened.peers.joined(separator: ","),
            "in": opened.author != selfPubkey,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: fact, options: [.sortedKeys]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Open a kind-1059 wrap addressed to `self`, or nil for anything the
    /// decryptor cannot open, that is malformed, or that has already expired.
    ///
    /// The checks, in order:
    ///   1. the wrap decrypts to us from `wrap.pubkey` → a kind-13 seal;
    ///   2. the seal decrypts to us from `seal.pubkey` → the rumor;
    ///   3. the rumor's claimed pubkey equals the seal's signer (NIP-59
    ///      anti-spoofing). No Schnorr verify is needed for that: NIP-44's AEAD
    ///      means a seal that decrypted was authenticated to US by its author;
    ///   4. the rumor's id, when it claims one, is its NIP-01 hash;
    ///   5. a NIP-40 deadline that has passed on the wrap, the seal OR the
    ///      rumor rejects the whole envelope. All three, because relays are not
    ///      trusted to have dropped it and a sender can strip the outer tag.
    ///
    /// Whether the sender turns out to be the viewer is NOT decided here — that
    /// is presentation policy, and the caller has to tell it apart from a wrap
    /// that simply would not open.
    static func open(
        wrap: NostrEvent,
        decryptor: Nip44Decryptor,
        self selfPubkey: String,
        now: Int = Int(Date().timeIntervalSince1970)
    ) -> OpenedDm? {
        guard wrap.kind == kindWrap else { return nil }
        guard !Nip40.isExpired(wrap.tags, now: now) else { return nil }

        guard let sealJson = decryptor.decrypt(pubkey: wrap.pubkey, ciphertext: wrap.content),
              let seal = NostrEvent.parse(json: sealJson),
              seal.kind == kindSeal,
              !Nip40.isExpired(seal.tags, now: now)
        else { return nil }

        guard let rumorJson = decryptor.decrypt(pubkey: seal.pubkey, ciphertext: seal.content),
              let rumor = NostrEvent.parse(json: rumorJson)
        else { return nil }

        guard rumor.pubkey == seal.pubkey else { return nil }
        guard rumor.createdAt <= now + maxFutureSkewSecs else { return nil }
        guard !Nip40.isExpired(rumor.tags, now: now) else { return nil }

        let computedId = rumor.computedId
        if let claimed = rumor.id, claimed != computedId { return nil }

        guard let peers = peersOf(rumor, self: selfPubkey) else { return nil }

        return OpenedDm(
            rumorId: computedId,
            author: rumor.pubkey,
            kind: rumor.kind,
            content: rumor.content,
            tags: rumor.tags,
            createdAt: rumor.createdAt,
            peers: peers
        )
    }

    /// Everyone involved except `self`, sorted. Matches `dmPeersOf` in the web
    /// client so both notification readers derive the same group room key.
    static func peersOf(_ rumor: NostrEvent, self selfPubkey: String) -> [String]? {
        var recipients = Set<String>()
        for tag in rumor.tags where tag.first == "p" && tag.count > 1 && !tag[1].isEmpty {
            recipients.insert(tag[1])
        }

        if rumor.pubkey != selfPubkey {
            recipients.insert(rumor.pubkey)
            recipients.remove(selfPubkey)
            return recipients.isEmpty ? nil : recipients.sorted()
        }

        guard !recipients.isEmpty else { return nil }
        recipients.remove(selfPubkey)
        return recipients.isEmpty ? [selfPubkey] : recipients.sorted()
    }

    /// Backward-compatible shorthand used by the existing 1:1 vectors.
    static func peerOf(_ rumor: NostrEvent, self selfPubkey: String) -> String? {
        peersOf(rumor, self: selfPubkey)?.first
    }
}
