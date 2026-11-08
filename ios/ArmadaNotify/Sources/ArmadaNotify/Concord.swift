import Foundation

/// A fully-opened, verified Concord chat rumor.
struct OpenedChat {
    let rumorId: String
    /// Verified real author — the seal's signer, which equals the rumor's pubkey.
    let author: String
    let kind: Int
    let content: String
    let tags: [[String]]
    let createdAt: Int
    /// Its time in ms (CORD-02 §4): `createdAt` plus its `ms` tag.
    let ms: Int
    /// The channel whose key opened it, already checked against the binding.
    let channelIdHex: String
}

/// Concord Private Streams (CORD-01/02/03) — the chat plane, opening side.
///
/// A stream event REVERSES NIP-59: the wrap's author is the plane's derived
/// stream key (in the clear), and the content is encrypted under the stream's
/// conversation key rather than to the p-tagged one. That is what makes routing
/// here one map lookup and one decrypt rather than trial decryption of every
/// key held.
///
/// A port of `openWrap` + `checkChannelBinding` in `src/concord/lib/stream.ts`,
/// restricted to what a notification needs.
enum Concord {

    static let kindWrap = 1059
    static let kindWrapEphemeral = 21059
    static let kindSealEncrypted = 20013
    static let kindSealPlaintext = 20014

    static let kindMessage = 9
    static let kindReaction = 7

    /// How far ahead of the local clock a chat rumor may be dated before it is
    /// HELD — stored, but not announced — until its time passes. Mirrors the
    /// web/desktop fold's FUTURE_HOLD_MS (`src/concord/lib/stream.ts`) and the
    /// Android service's FUTURE_HOLD_MS: a message the timeline hides for being
    /// "in the future" must not buzz here either, or the reader gets a
    /// notification (stamped "in 5m" from its future createdAt) about a message
    /// they can't yet see. A small grace, so ordinary sub-second clock jitter
    /// between honest clients doesn't flap — NOT the hour of ingest skew NIP-17
    /// tolerates (`Dm17.maxFutureSkewSecs`).
    static let futureHoldSecs = 5

    /// Kinds claimed by a NON-chat plane (CORD-02 §5): control, guestbook
    /// (join/leave, kick, snapshot, timeout, nickname) and rekey.
    ///
    /// The chat ingress refuses these, and that refusal is half a fence. A
    /// community's planes share one tenant and a plane is read back BY KIND, so
    /// without it a holder of any ONE channel's stream key could wrap a
    /// kind-3308 rumor carrying a valid channel binding and have it served as a
    /// control edition — and nothing downstream would catch it, a stored rumor
    /// having no seal left whose form could be checked.
    static let planeKinds: Set<Int> = [3308, 3306, 3309, 3312, 3314, 3315, 3303]

    /// Open a chat wrap under the stream key that claims it.
    ///
    /// Routing is by `wrap.pubkey`. The seal's Schnorr signature is verified
    /// (it is the authorship proof); the WRAP's own signature is deliberately
    /// not, because it is made with a key every reader of the stream holds and
    /// therefore proves nothing.
    ///
    /// The seal MUST be the ENCRYPTED form (CORD-02 §5). A plaintext seal would
    /// make the message a standalone signed artifact any relay could display,
    /// and this matches the web worker's rule rather than the Android
    /// service's laxer one.
    static func open(wrap: NostrEvent, stream: ConcordStream) -> OpenedChat? {
        if case .chat(let opened) = read(wrap: wrap, stream: stream) { return opened }
        return nil
    }

    /// What a wrap held: a chat rumor, or one that opened but is malformed (a bad `ms`,
    /// CORD-02 §5), which is dropped rather than announced as a wrap that wouldn't open.
    enum Read {
        case chat(OpenedChat)
        case malformed
    }

    static func read(wrap: NostrEvent, stream: ConcordStream) -> Read? {
        guard wrap.kind == kindWrap || wrap.kind == kindWrapEphemeral else { return nil }
        guard wrap.pubkey == stream.pubkey else { return nil }
        guard let convKey = Hex.decode(stream.conversationKey), convKey.count == 32 else {
            return nil
        }

        guard let sealJson = Nip44.decrypt(conversationKey: convKey, payloadBase64: wrap.content),
              let seal = NostrEvent.parse(json: sealJson),
              seal.kind == kindSealEncrypted
        else { return nil }

        // The seal is a complete signed event; its id must be its own hash
        // before the signature over that id means anything.
        guard let sealId = seal.id, let sealSig = seal.sig, sealId == seal.computedId else {
            return nil
        }
        guard let message = Hex.decode(sealId),
              Secp256k1.schnorrVerify(
                  message: message, pubkeyHex: seal.pubkey, signatureHex: sealSig
              )
        else { return nil }

        guard let rumorJson = Nip44.decrypt(
            conversationKey: convKey, payloadBase64: seal.content
        ), let rumor = NostrEvent.parse(json: rumorJson) else { return nil }

        // A keyholder must not be able to re-seal another member's rumor under
        // their own name.
        guard rumor.pubkey == seal.pubkey else { return nil }
        guard let claimedId = rumor.id, claimedId == rumor.computedId else { return nil }

        // The binding: the rumor's committed channel and epoch must strict-equal
        // the coordinate whose key decrypted the wrap, or a keyholder could
        // splice one author's rumor into a context they never chose — including
        // a private channel, or one in another community.
        guard rumor.uniqueTag("channel") == stream.channelId else { return nil }
        guard rumor.uniqueTag("epoch") == stream.epoch else { return nil }
        // Only read addresses are listened on, where a `wepoch` is forged (CORD-03 §3):
        // stored, the timeline would stand it as a writer's post.
        guard !rumor.tags.contains(where: { $0.first == "wepoch" }) else { return nil }

        guard rumor.kind == kindMessage || rumor.kind == kindReaction else { return nil }
        guard let ms = resolvedMs(createdAt: rumor.createdAt, tags: rumor.tags) else { return .malformed }

        return .chat(OpenedChat(
            rumorId: claimedId,
            author: seal.pubkey,
            kind: rumor.kind,
            content: rumor.content,
            tags: rumor.tags,
            createdAt: rumor.createdAt,
            ms: ms,
            channelIdHex: stream.channelId
        ))
    }

    /// A rumor's time in ms: `createdAt` plus its first `ms` tag, or nil when that tag is
    /// malformed, which refuses the rumor as `resolveMs` in `src/concord/lib/stream.ts` does.
    static func resolvedMs(createdAt: Int, tags: [[String]]) -> Int? {
        guard let tag = tags.first(where: { $0.first == "ms" }) else { return createdAt * 1000 }
        guard tag.count > 1 else { return nil }
        let raw = tag[1]
        let digits = raw.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
        guard digits, (1...3).contains(raw.utf8.count), raw == "0" || !raw.hasPrefix("0"), let n = Int(raw) else { return nil }
        return createdAt * 1000 + n
    }

    /// Find the stream whose address authored this wrap, if any is watched.
    static func stream(for wrap: NostrEvent, in streams: [ConcordStream]) -> ConcordStream? {
        streams.first { $0.pubkey == wrap.pubkey }
    }
}
