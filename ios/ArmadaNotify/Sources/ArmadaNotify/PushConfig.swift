import Foundation

/// One Concord channel's current stream, as the extension needs it: the wrap
/// author to recognise, the key that opens it, and the binding the rumor inside
/// must match.
struct ConcordStream {
    /// Stream address (x-only pubkey hex) — equals the wrap's `pubkey`.
    let pubkey: String
    /// NIP-44 conversation key (hex) that decrypts this stream's wraps.
    let conversationKey: String
    /// Epoch (decimal string) the rumor's `epoch` binding tag must equal.
    let epoch: String
    /// Community id (hex) — the deep link and the ArmadaDB tenant.
    let communityId: String
    /// Channel id (hex) — the deep link and the rumor's `channel` binding tag.
    let channelId: String
    /// The community's banned authors (CORD-04), hex pubkeys. A banned member's
    /// message is still stored — the timeline folds it away on read — but the
    /// extension must not present it, so `prepareConcord` drops it after decrypt.
    let banned: Set<String>
    /// Authors currently authorized to issue a literal @everyone, server-wide.
    let mentionEveryoneAuthors: Set<String>
    /// `@everyone` itself holds MENTION_EVERYONE, so any author's @everyone counts.
    let mentionEveryoneAnyone: Bool
    /// The Roles the viewer holds, and who may ping any Role (CORD-04 §8).
    let roleMentions: [RoleMentions.Held]
    let roleMentionAuthors: Set<String>
    /// The relays' clock minus this device's, in ms (CORD-03 §3), from the app's sync.
    let clockOffsetMs: Int
    /// Posts readers collapse ring nobody (CORD-04 §8): authors without SEND here,
    /// and the running Timeouts, author → (from, until) in unix seconds.
    let sendDenied: Set<String>
    /// In a restricted Channel, the only authors whose posts ring; nil elsewhere (CORD-03 §1).
    let postAuthors: Set<String>?
    let timeouts: [String: (from: Int, until: Int)]
    /// The Nicknames members go by in this Community (CORD-04 §10), which name the sender.
    let nicknames: [String: String]
    /// "mentions only": the gateway is content-blind and wakes iOS for every
    /// message on this channel, but the extension decrypts, so `prepareConcord`
    /// drops a message that doesn't `#p`-tag the viewer. Mirrors the Android
    /// service's per-community `mentionOnly` (older configs omit it → notify all).
    let mentionOnly: Bool
    /// The channel/community is muted (level `nothing`). It raises no gateway
    /// subscription, but a lingering one can still wake the device; the channel
    /// is kept in the config with its key so `prepareConcord` OPENS the wrap and
    /// drops it, rather than presenting the gateway's static fallback text.
    let muted: Bool
    /// When this membership began (ms, the vault entry's `added_at`; nil =
    /// unknown). Nothing sent earlier is presented: the viewer wasn't there.
    let joinedAtMs: Int?

    init(
        pubkey: String,
        conversationKey: String,
        epoch: String,
        communityId: String,
        channelId: String,
        banned: Set<String>,
        mentionEveryoneAuthors: Set<String> = [],
        mentionEveryoneAnyone: Bool = false,
        roleMentions: [RoleMentions.Held] = [],
        roleMentionAuthors: Set<String> = [],
        clockOffsetMs: Int = 0,
        sendDenied: Set<String> = [],
        postAuthors: Set<String>? = nil,
        timeouts: [String: (from: Int, until: Int)] = [:],
        nicknames: [String: String] = [:],
        mentionOnly: Bool = false,
        muted: Bool = false,
        joinedAtMs: Int? = nil
    ) {
        self.pubkey = pubkey
        self.conversationKey = conversationKey
        self.epoch = epoch
        self.communityId = communityId
        self.channelId = channelId
        self.banned = banned
        self.mentionEveryoneAuthors = mentionEveryoneAuthors
        self.mentionEveryoneAnyone = mentionEveryoneAnyone
        self.roleMentions = roleMentions
        self.roleMentionAuthors = roleMentionAuthors
        self.clockOffsetMs = clockOffsetMs
        self.sendDenied = sendDenied
        self.postAuthors = postAuthors
        self.timeouts = timeouts
        self.nicknames = nicknames
        self.mentionOnly = mentionOnly
        self.muted = muted
        self.joinedAtMs = joinedAtMs
    }
}

/// A bunker login's remote signer, as much of it as decryption needs.
///
/// The key here is the CLIENT key, not the identity key: it addresses the
/// bunker and nothing else. That makes it strictly weaker than the `sk` an
/// nsec login stores — it cannot decrypt or sign anything by itself, only ask a
/// bunker that can, over a grant the user already made and can revoke there.
struct Nip46Config {
    let clientSecretKey: [UInt8]
    let bunkerPubkey: String
    let relays: [String]
}

/// How to notify for a DM from someone the viewer doesn't know.
enum DmRequestLevel: String {
    case off
    case generic
    case full
}

/// Notification policy for one exact NIP-17 conversation. `mentions` is the
/// same as `all` for DMs because every direct message addresses the viewer.
enum DmNotificationLevel: String {
    case all
    case mentions
    case nothing
}

/// What the extension needs to OPEN an event the push payload inlined.
///
/// The iOS counterpart of `SwPushConfig` (`src/lib/swPushConfig.ts`), and it
/// carries the same fields for the same reasons. Like that one it holds NO
/// display data: names, avatars and room titles are read out of ArmadaDB at
/// push time, for any author, rather than pre-sealed for a listed few.
///
/// SECURITY. `sk` is the account's identity key and is present ONLY for nsec
/// logins. It has to be present at all because a NIP-17 wrap is authored by a
/// fresh ephemeral key per message: there is no conversation key to precompute,
/// so opening one needs the ECDH itself.
///
/// A bunker (NIP-46) login sends `nip46` instead — the CLIENT key, the bunker's
/// pubkey and its relays — and the extension asks the bunker to decrypt
/// (`Nip46Client`). That is a materially smaller secret: the client key can
/// only address the bunker, under a grant the user made in the app and can
/// revoke there, whereas an `sk` is the account. Extension (NIP-07) logins send
/// neither and stay the generic wake-up, as they do in the web worker: there is
/// no browser to ask.
///
/// It lives in the App Group container under
/// `.completeUntilFirstUserAuthentication`, which is the weakest protection
/// class that still works — a notification arrives while the device is LOCKED,
/// and anything stronger would make the extension unable to read its own
/// config. That is the same container, and the same reachable-while-locked
/// exposure, as the decrypted DM and Concord history ArmadaDB already keeps
/// there; the difference the key adds is the ability to read FUTURE messages,
/// which is why it is written only while push is enabled and deleted on
/// disable/logout.
///
/// The Concord keys beside it are a strictly smaller secret: a stream's
/// conversation key READS one channel at one epoch, the wrap-SIGNING key is not
/// here at all, so nothing in this file can write to a community — and the set
/// goes stale by itself at the next rekey.
struct PushConfig {
    let policy: DmRequestLevel
    /// Account-global DM fallback. An exact `dmLevels` entry overrides it.
    let directMessages: Bool
    /// Exact canonical participant-set room keys; group membership never
    /// widens a level into unrelated one-to-one conversations.
    let dmLevels: [String: DmNotificationLevel]
    /// The viewer's own pubkey (hex) — to drop self-sent copies.
    let selfPubkey: String
    /// follows ∪ accepted ∪ pinned (hex) — the "known" senders.
    let knownPeers: Set<String>
    /// Exact authored/pinned NIP-17 rooms; group members stay scoped to it.
    let knownConversations: Set<String>
    /// Peers whose presence suppresses their whole DM conversation.
    let mutedPeers: Set<String>
    /// Decrypt key bytes. Present for nsec logins only.
    let secretKey: [UInt8]?
    /// The bunker to ask instead, for NIP-46 logins.
    let nip46: Nip46Config?
    /// The CURRENT epoch's stream for every watched channel. Only the current
    /// one: a retired epoch is read-cutoff history and must not notify.
    let concord: [ConcordStream]
    /// Where a sender's avatar may be fetched from — the app's media policy
    /// (`MediaPolicy`), applied to the one fetch the extension makes. A config
    /// written before the field existed gets the default: proxying off.
    let mediaPolicy: MediaPolicy
    /// The app's language code, for `Strings`. Absent in a config written
    /// before the field existed, which reads English.
    let locale: String?

    init(
        policy: DmRequestLevel,
        directMessages: Bool = true,
        dmLevels: [String: DmNotificationLevel] = [:],
        selfPubkey: String,
        knownPeers: Set<String>,
        knownConversations: Set<String> = [],
        mutedPeers: Set<String> = [],
        secretKey: [UInt8]?,
        nip46: Nip46Config?,
        concord: [ConcordStream],
        mediaPolicy: MediaPolicy = .defaults,
        locale: String? = nil
    ) {
        self.policy = policy
        self.directMessages = directMessages
        self.dmLevels = dmLevels
        self.selfPubkey = selfPubkey
        self.knownPeers = knownPeers
        self.knownConversations = knownConversations
        self.mutedPeers = mutedPeers
        self.secretKey = secretKey
        self.nip46 = nip46
        self.concord = concord
        self.mediaPolicy = mediaPolicy
        self.locale = locale
    }

    static func parse(json: String) -> PushConfig? {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let object = decoded as? [String: Any],
              let selfPubkey = object["self"] as? String
        else { return nil }

        let policy = DmRequestLevel(rawValue: object["policy"] as? String ?? "") ?? .generic
        // Older configs predate exact DM levels. A config existed only while
        // the global DM subscription was enabled, so `true` preserves their
        // historical behavior during an app/extension upgrade race.
        let directMessages = (object["directMessages"] as? Bool) ?? true
        var dmLevels = [String: DmNotificationLevel]()
        for (key, raw) in (object["dmLevels"] as? [String: String]) ?? [:] {
            if let level = DmNotificationLevel(rawValue: raw) {
                dmLevels[key] = level
            }
        }
        let knownPeers = Set((object["knownPeers"] as? [String]) ?? [])
        let knownConversations = Set((object["knownConversations"] as? [String]) ?? [])
        let mutedPeers = Set((object["mutedPeers"] as? [String]) ?? [])

        var secretKey: [UInt8]?
        if let hex = object["sk"] as? String, let bytes = Hex.decode(hex), bytes.count == 32 {
            secretKey = bytes
        }

        var nip46: Nip46Config?
        if let entry = object["nip46"] as? [String: Any],
            let clientHex = entry["clientSk"] as? String,
            let clientKey = Hex.decode(clientHex), clientKey.count == 32,
            let bunkerPubkey = entry["bunkerPubkey"] as? String,
            let relays = entry["relays"] as? [String], !relays.isEmpty {
            nip46 = Nip46Config(
                clientSecretKey: clientKey, bunkerPubkey: bunkerPubkey, relays: relays
            )
        }

        var streams = [ConcordStream]()
        for raw in (object["concord"] as? [Any]) ?? [] {
            guard let entry = raw as? [String: Any],
                  let pubkey = entry["pk"] as? String,
                  let convKey = entry["convKey"] as? String,
                  let epoch = entry["epoch"] as? String,
                  let communityId = entry["communityId"] as? String,
                  let channelId = entry["channelId"] as? String
            else { continue }
            streams.append(ConcordStream(
                pubkey: pubkey,
                conversationKey: convKey,
                epoch: epoch,
                communityId: communityId,
                channelId: channelId,
                banned: Set((entry["banned"] as? [String]) ?? []),
                mentionEveryoneAuthors: Set((entry["mentionEveryoneAuthors"] as? [String]) ?? []),
                mentionEveryoneAnyone: (entry["mentionEveryoneAnyone"] as? Bool) ?? false,
                roleMentions: RoleMentions.parse(entry["roleMentions"]),
                roleMentionAuthors: Set((entry["roleMentionAuthors"] as? [String]) ?? []),
                clockOffsetMs: (entry["clockOffsetMs"] as? NSNumber).map { Int($0.doubleValue) } ?? 0,
                sendDenied: Set((entry["sendDenied"] as? [String]) ?? []),
                postAuthors: (entry["postAuthors"] as? [String]).map(Set.init),
                timeouts: Dictionary(
                    ((entry["timeouts"] as? [[String: Any]]) ?? []).compactMap { t -> (String, (from: Int, until: Int))? in
                        guard let pk = t["pk"] as? String,
                              let from = (t["fromSecs"] as? NSNumber).map({ Int($0.doubleValue) }),
                              let until = (t["until"] as? NSNumber).map({ Int($0.doubleValue) }) else { return nil }
                        return (pk, (from: from, until: until))
                    },
                    uniquingKeysWith: { a, _ in a }
                ),
                nicknames: ((entry["nicknames"] as? [String: Any]) ?? [:]).compactMapValues { ($0 as? String).flatMap { $0.isEmpty ? nil : $0 } },
                mentionOnly: (entry["mentionOnly"] as? Bool) ?? false,
                muted: (entry["muted"] as? Bool) ?? false,
                joinedAtMs: (entry["joinedAtMs"] as? NSNumber).map { Int($0.doubleValue) }
            ))
        }

        return PushConfig(
            policy: policy,
            directMessages: directMessages,
            dmLevels: dmLevels,
            selfPubkey: selfPubkey,
            knownPeers: knownPeers,
            knownConversations: knownConversations,
            mutedPeers: mutedPeers,
            secretKey: secretKey,
            nip46: nip46,
            concord: streams,
            mediaPolicy: MediaPolicy.parse(object["mediaPolicy"] as? [String: Any]),
            locale: object["locale"] as? String
        )
    }
}

#if canImport(Darwin)

    /// Where the extension finds its config.
    ///
    /// A file of its own in the App Group container rather than a row in
    /// ArmadaDB's KV: the KV is a general-purpose store the app queries, lists
    /// and would happily include in a diagnostic dump, and an identity key
    /// should not be somewhere a future convenience can sweep it up. A separate
    /// file also gets its own protection class and its own delete.
    public enum PushConfigStore {

        public static let fileName = "push-config.json"

        public static func url(appGroup group: String = "group.buzz.armada.app") -> URL? {
            FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: group)?
                .appendingPathComponent(fileName)
        }

        /// Replace the config. `.completeUntilFirstUserAuthentication` is
        /// required, not chosen: a push arrives while the device is locked, and
        /// `.complete` would leave the extension unable to open its own file.
        public static func write(_ json: String) throws {
            guard let url = url() else {
                throw NSError(
                    domain: "ArmadaNotify", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "App Group container unavailable"]
                )
            }
            try Data(json.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }

        /// Delete the config, on push disable or logout.
        public static func clear() {
            guard let url = url() else { return }
            try? FileManager.default.removeItem(at: url)
        }

        /// What the App Group actually looks like from this process.
        ///
        /// Reported back to the WebView when a write fails, because the two
        /// interesting failures are indistinguishable from the outside: an
        /// entitlement the OS did not grant (no container at all) and a
        /// container that is there but unwritable. It also says whether
        /// ArmadaDB's file is present, since the store and this config share
        /// one container — if neither is there, the problem is the container,
        /// not the config.
        public static func describe(appGroup group: String = "group.buzz.armada.app") -> String {
            guard let container = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: group)
            else {
                return "App Group \(group) resolved to no container — the entitlement is "
                    + "missing or the group is not provisioned on the App ID"
            }
            let files = FileManager.default
            let db = container.appendingPathComponent("armada-db.sqlite").path
            return "container ok; armada-db.sqlite "
                + (files.fileExists(atPath: db) ? "present" : "ABSENT")
                + "; config "
                + (files.fileExists(atPath: container.appendingPathComponent(fileName).path)
                    ? "present" : "absent")
        }

        static func read() -> PushConfig? {
            guard let url = url(), let data = try? Data(contentsOf: url) else { return nil }
            return PushConfig.parse(json: String(decoding: data, as: UTF8.self))
        }
    }

#endif
