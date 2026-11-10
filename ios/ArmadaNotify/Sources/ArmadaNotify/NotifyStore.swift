import ArmadaDB
import Foundation

/// The extension's door onto ArmadaDB: the same database file, in the same App
/// Group container, that the WebView reads.
///
/// This is the whole point of the extension beyond the text it shows. A message
/// that arrives while the app is dead is written into the tenant the app reads
/// it from, so it is simply THERE on open — the arrangement the Android
/// background service has had all along, and the reason the database was put in
/// the App Group before anything was stored in it.
///
/// The write rules are ported, not invented. A rule only one writer applies is
/// a conversation the two writers disagree about, and nothing is stored beside
/// a rumor for a reader to re-check them against.
struct NotifyStore {

    private let bridge: ArmadaDbBridge

    init(bridge: ArmadaDbBridge) {
        self.bridge = bridge
    }

    #if canImport(Darwin)
        /// Open the shared store at its App Group path.
        init() throws {
            self.bridge = ArmadaDbBridge(db: try ArmadaDbStore.shared(path: try ArmadaDbLocation.path()))
        }
    #endif

    // MARK: - Tenants

    /// The opened-DM tenant for one viewer. Mirrors `dm17Store()`.
    static func dmTenant(self selfPubkey: String) -> String { "dm17:\(selfPubkey)" }

    /// A community's opened events. Mirrors `communityTenant()`.
    static func communityTenant(_ communityIdHex: String) -> String { "c2:\(communityIdHex)" }

    // MARK: - Writes

    /// Persist an opened NIP-17 rumor.
    ///
    /// An already-expired rumor is never written. `Dm17.open` rejects those
    /// too, but the guarantee belongs at the write: a disappearing message that
    /// arrives late is simply never stored.
    ///
    /// The user's OWN sent copy is written like any other — it is how the other
    /// device's half of a conversation reaches this one at all — even though it
    /// is dropped from the notification.
    ///
    /// `arrivedAt` is when a push delivered it, recorded where the sender's
    /// clock put it elsewhere (`Dm17.arrivalFact`).
    func writeDm(_ opened: OpenedDm, self selfPubkey: String, now: Int, arrivedAt: Int? = nil) throws {
        guard !Nip40.isExpired(opened.tags, now: now) else { return }
        let rumor: [String: Any] = [
            "id": opened.rumorId,
            "pubkey": opened.author,
            "created_at": opened.createdAt,
            "kind": opened.kind,
            "tags": opened.tags,
            "content": opened.content,
        ]
        try write(tenant: Self.dmTenant(self: selfPubkey), rumors: [rumor])
        if let arrivedAt, let fact = Dm17.arrivalFact(opened, self: selfPubkey, at: arrivedAt) {
            try bridge.kvSet(key: Dm17.arrivalKey(self: selfPubkey, rumorId: opened.rumorId), value: fact)
        }
    }

    /// Persist an opened Concord chat rumor.
    ///
    /// Refuses the kinds another plane is read back by. A community's planes
    /// share one tenant and a plane is read BY KIND, so without this a holder
    /// of any one channel's stream key could wrap a control-plane kind carrying
    /// a valid channel binding and have it served as a control edition —
    /// and nothing downstream would catch it, a stored rumor having no seal
    /// left whose form could be checked.
    func writeConcord(_ opened: OpenedChat, communityId: String, now: Int) throws {
        guard !Concord.planeKinds.contains(opened.kind) else { return }
        guard !Nip40.isExpired(opened.tags, now: now) else { return }
        let rumor: [String: Any] = [
            "id": opened.rumorId,
            "pubkey": opened.author,
            "created_at": opened.createdAt,
            "kind": opened.kind,
            "tags": opened.tags,
            "content": opened.content,
        ]
        try write(tenant: Self.communityTenant(communityId), rumors: [rumor])
    }

    private func write(tenant: String, rumors: [[String: Any]]) throws {
        let data = try JSONSerialization.data(withJSONObject: rumors)
        try bridge.event(tenant: tenant, rumors: String(decoding: data, as: UTF8.self))
    }

    // MARK: - Reads

    /// A sender's name and avatar, from the local kind-0 and never the network.
    struct Profile {
        /// Nil for a profile that names no one; the caller words the absence.
        let name: String?
        /// An `https` picture URL, or nil. Only https: a notification image is
        /// fetched by the extension, and a plaintext URL would both leak the
        /// read and be trivially substitutable in flight.
        let picture: String?
    }

    /// A notification is the one surface with no time to wait on a relay, so an
    /// author this cannot name has no name — a fact established by looking, not
    /// a placeholder for a lookup that never happened.
    func profile(pubkey: String) -> Profile {
        guard let events = query(
            tenant: ArmadaDbTenants.main,
            filters: [["kinds": [0], "authors": [pubkey], "limit": 1]]
        ), let first = events.first,
            let content = first["content"] as? String,
            let decoded = try? JSONSerialization.jsonObject(with: Data(content.utf8)),
            let metadata = decoded as? [String: Any]
        else { return Profile(name: nil, picture: nil) }

        var name: String?
        if let value = metadata["name"] as? String, !value.isEmpty {
            name = value
        } else if let value = metadata["display_name"] as? String, !value.isEmpty {
            name = value
        }

        var picture: String?
        if let value = metadata["picture"] as? String, value.lowercased().hasPrefix("https://") {
            picture = value
        }
        return Profile(name: name, picture: picture)
    }

    /// Just the name, for the mention map.
    func displayName(pubkey: String) -> String? {
        profile(pubkey: pubkey).name
    }

    /// Resolve the names a message's NIP-27 mentions refer to, locally. Absent
    /// entries leave the raw token in place rather than showing a wrong name.
    func mentionNames(in content: String) -> [String: String] {
        var names = [String: String]()
        for pubkey in NotificationPreview.mentionedPubkeys(in: content) {
            if let name = displayName(pubkey: pubkey) { names[pubkey] = name }
        }
        return names
    }

    /// A NIP-29 group's name from its relay-signed kind-39000 metadata, scoped
    /// to the relay's own tenant — a group id names nothing without its relay.
    func nip29RoomTitle(relayUrl: String, groupId: String) -> String? {
        guard let events = query(
            tenant: ArmadaDbTenants.nip29(relayUrl: relayUrl),
            filters: [["kinds": [39000], "#d": [groupId], "limit": 1]]
        ), let first = events.first, let tags = first["tags"] as? [[String]] else { return nil }
        for tag in tags where tag.count > 1 && tag[0] == "name" && !tag[1].isEmpty { return tag[1] }
        return nil
    }

    /// A Concord channel's title — "Community / #channel" — from the folded
    /// control snapshot in KV.
    ///
    /// Read as a narrow slice rather than through the whole fold: a name is
    /// independently useful, and there is nothing here a partially-unreadable
    /// fold could make unsafe. `channels` is a `Map`, which `foldedCache`
    /// encodes as `{"__t":"map","v":[[key, value], …]}`.
    func concordRoomTitle(communityId: String, channelId: String, strings: Strings) -> String? {
        // `try?` flattens the throwing call's own `String?`, so this is one
        // binding, not two: a missing key and a failed read are the same answer.
        guard let json = try? bridge.kvGet(key: "folded:concord2-fold:\(communityId)"),
              let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let fold = decoded as? [String: Any]
        else { return nil }

        let metadata = fold["metadata"] as? [String: Any]
        let community = (metadata?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }

        var channel: String?
        if let channels = fold["channels"] as? [String: Any],
           let entries = channels["v"] as? [[Any]] {
            for entry in entries where entry.count == 2 {
                guard let key = entry[0] as? String, key == channelId else { continue }
                channel = (entry[1] as? [String: Any])?["name"] as? String
                break
            }
        }
        if let value = channel, value.isEmpty { channel = nil }

        switch (community, channel) {
        case let (community?, channel?): return strings.roomTitle(community: community, channel: channel)
        case let (community?, nil): return community
        case let (nil, channel?): return strings.channelTitle(channel: channel)
        default: return nil
        }
    }

    /// KV read/write straight through, for the ids the extension tracks.
    func kvGet(_ key: String) -> String? {
        try? bridge.kvGet(key: key)
    }

    func kvSet(_ key: String, _ value: String) {
        try? bridge.kvSet(key: key, value: value)
    }

    private func query(tenant: String, filters: [[String: Any]]) -> [[String: Any]]? {
        guard let filterData = try? JSONSerialization.data(withJSONObject: filters),
              let json = try? bridge.query(
                  tenant: tenant, filters: String(decoding: filterData, as: UTF8.self)
              ),
              let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let events = decoded as? [[String: Any]]
        else { return nil }
        return events
    }
}
