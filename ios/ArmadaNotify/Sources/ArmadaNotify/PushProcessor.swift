import Foundation

/// What the extension should show, once the event is open.
public struct PreparedPush {
    /// Show NOTHING for this push, and mean it — as distinct from returning
    /// nil, which means "I couldn't decide, keep the gateway's fallback".
    ///
    /// The difference matters because the fallback is a VISIBLE notification. A
    /// message the viewer sent from another device, or a reaction to somebody
    /// else's message, would otherwise announce itself as "New message in a
    /// community": only the decrypted rumor can tell, so by the time it is
    /// known, silence has to be something the caller can ask for.
    ///
    /// iOS has no way to suppress a delivered alert entirely — an extension
    /// that calls its handler with unchanged content still shows one — so the
    /// caller turns this into the quietest thing it can (see
    /// `NotificationService`).
    public let drop: Bool
    public let title: String
    public let body: String
    /// Collapse identifier — one notification per conversation.
    public let threadId: String
    /// The in-app path a tap should open.
    public let path: String?
    /// Show this as quietly as the platform allows: an unknown sender under the
    /// `off` request policy.
    public let quiet: Bool
    /// Who sent it, when that is safe to reveal.
    ///
    /// Present only where the sender is already being named in the body — so
    /// never for a request ping, whose whole purpose is to reveal nothing a
    /// stranger controls, including their avatar. `NotificationService` turns
    /// this into a communication notification, which is what makes iOS show the
    /// person rather than the app icon.
    public let sender: Sender?

    public struct Sender {
        /// Hex pubkey, used only as the intent's stable identifier.
        public let id: String
        public let name: String
        /// `https` avatar URL, or nil — already routed by the media policy,
        /// so a stranger's picture is the proxied form and one the policy
        /// would not fetch unprompted is nil (the monogram, then).
        public let avatarUrl: String?
        /// The room, for a group conversation. Absent for a DM.
        public let groupName: String?
    }

    /// Carries the text the caller shows in place of nothing, since iOS
    /// cannot show nothing (see `drop`).
    static func dropped(_ strings: Strings) -> PreparedPush {
        PreparedPush(
            drop: true, title: strings.appName, body: strings.messagesSynced, threadId: "",
            path: nil, quiet: true, sender: nil
        )
    }
}

/// Open the event the gateway inlined, store it, and say what to show.
///
/// The third port of this pipeline: `worker.ts` + `pushRuntime.ts` on the web,
/// `Dm17.kt` + `ServiceStore.kt` on Android, this on iOS.
///
/// Every step is best-effort and non-fatal. An event that cannot be opened
/// gets its plane's fallback text, and one that cannot even be placed (not
/// fetched, forged, not ours) leaves the gateway's static wake-up.
///
/// STORING HAPPENS BEFORE PRESENTING, deliberately: the notification is a side
/// effect of a message arriving, and the message arriving is the part that has
/// to survive. A store that failed still shows the notification; a presentation
/// that failed has still persisted the message.
struct PushProcessor {

    /// Optional, and that is the point: a store that will not open costs the
    /// message's PERSISTENCE, not its notification. Gating presentation on
    /// persistence turns one broken thing into two — the user loses the text as
    /// well as the history — and the store is the half that can be refilled
    /// from a relay later.
    let store: NotifyStore?
    let config: PushConfig
    /// The app's language, from the config.
    let strings: Strings
    let now: Int

    /// Where a refusal goes.
    ///
    /// A decline means many different things — an event that could not be
    /// fetched, a forged one, a login with no key, a bunker that did not
    /// answer, an expired message, an event that is not ours. They are
    /// indistinguishable from outside, so the trace names which one ran.
    ///
    /// A STATUS only — never content, pubkeys or event ids. Defaults to a
    /// no-op, so the Linux suite and any other caller pay nothing for it.
    let trace: (String) -> Void

    /// Fetches an event the gateway could not inline: `(id, relays)`. Defaults
    /// to finding nothing, so the Linux suite never touches the network.
    let fetch: (String, [String]) -> [String: Any]?

    init(
        store: NotifyStore?,
        config: PushConfig,
        now: Int = Int(Date().timeIntervalSince1970),
        trace: @escaping (String) -> Void = { _ in },
        fetch: @escaping (String, [String]) -> [String: Any]? = { _, _ in nil }
    ) {
        self.store = store
        self.config = config
        self.strings = Strings(locale: config.locale)
        self.now = now
        self.trace = trace
        self.fetch = fetch
    }

    /// The `$type` of nostr-push2's payload (Tenna's `napp.push.payload`).
    static let payloadType = "napp.push.payload"

    /// `userInfo` is the APNs payload: nostr-push2 puts the `napp.push.payload`
    /// keys (`event_id`, `relays`, and `event` when it fit) at the top level
    /// beside `aps`.
    ///
    /// Nil means nothing could be placed, and the caller keeps the gateway's
    /// generic text. An event whose plane is known but which cannot be opened
    /// gets that plane's fallback instead, so it still says what it is and
    /// still opens somewhere useful.
    func prepare(userInfo: [AnyHashable: Any]) -> PreparedPush? {
        guard userInfo["$type"] as? String == Self.payloadType,
              let eventId = userInfo["event_id"] as? String
        else {
            trace("not-napp-payload")
            return nil
        }
        let relays = ((userInfo["relays"] as? [Any]) ?? []).compactMap { $0 as? String }

        var rawEvent = userInfo["event"] as? [String: Any]
        if rawEvent == nil {
            rawEvent = fetch(eventId, relays)
            if rawEvent == nil {
                trace("not-inlined-unfetched")
                return nil
            }
        }
        guard let raw = rawEvent, let event = NostrEvent.parse(raw) else {
            trace("unparseable-event")
            return nil
        }

        // The relay that delivered it, and the gateway in between, are exactly
        // the parties this pipeline does not trust. For a NIP-29 message the
        // signature is the only thing binding it to an author, whose stored
        // kind-0 would otherwise be borrowed for a forged notification.
        guard let id = event.id, id == eventId, id == event.computedId else {
            trace("bad-id")
            return nil
        }
        guard let sig = event.sig,
              let signedDigest = Hex.decode(id),
              Secp256k1.schnorrVerify(
                  message: signedDigest, pubkeyHex: event.pubkey, signatureHex: sig
              )
        else {
            trace("bad-sig")
            return nil
        }

        guard let scope = Self.scope(of: event, config: config) else {
            trace("unplaced(\(event.kind))")
            return nil
        }
        switch scope {
        case .dm:
            return prepareDm(wrap: event) ?? Self.fallback(.dm, path: "/dm", strings: strings)
        case .c2:
            return prepareConcord(wrap: event)
                ?? Self.fallback(.c2, path: Concord.stream(for: event, in: config.concord).map {
                    "/c/\(escape($0.communityId))/\(escape($0.channelId))"
                }, strings: strings)
        case .group, .groupMention:
            return prepareGroup(event: event, relays: relays)
        }
    }

    /// Which plane an event belongs to, from the event alone — nostr-push2
    /// merges every subscription into one list and says nothing about which
    /// matched. Mirrors `pushScope` in `pushRuntime.ts`.
    enum Scope: Equatable {
        case dm, c2, group, groupMention
    }

    private static let groupKinds: Set<Int> = [9, 1111, 7]

    static func scope(of event: NostrEvent, config: PushConfig) -> Scope? {
        let addressedToSelf = event.hasTag("p", value: config.selfPubkey)
        if event.kind == 1059 {
            // Routing is by author: a Concord wrap is signed by its stream
            // address, a NIP-17 wrap by a throwaway key.
            if Concord.stream(for: event, in: config.concord) != nil { return .c2 }
            return addressedToSelf ? .dm : nil
        }
        if event.kind == 4 { return .dm }
        if groupKinds.contains(event.kind), event.uniqueTag("h") != nil {
            return addressedToSelf ? .groupMention : .group
        }
        return nil
    }

    /// What an event of a known plane shows when it cannot be opened: a bunker
    /// that did not answer, a login whose key never reaches the device, a
    /// legacy kind-4 DM. Mirrors the web worker's `FALLBACK_TEXT`.
    static func fallback(_ scope: Scope, path: String?, strings: Strings) -> PreparedPush {
        let body: String
        let threadId: String
        switch scope {
        case .dm:
            body = strings.newDirectMessage
            threadId = "armada-dm"
        case .c2:
            body = strings.newCommunityMessage
            threadId = "armada-c2"
        case .group:
            body = strings.newChannelMessage
            threadId = "armada-groups"
        case .groupMention:
            body = strings.someoneMentionedYou
            threadId = "armada-groups"
        }
        return PreparedPush(
            drop: false, title: strings.newMessage, body: body, threadId: threadId,
            path: path, quiet: false, sender: nil
        )
    }

    /// Show-nothing, worded in the app's language.
    private var dropped: PreparedPush { .dropped(strings) }

    // MARK: - DM

    /// Whether a Concord sender's avatar may appear on the notification. Anyone
    /// with the key can post (CORD-04 §1), so unless the reader loads everyone's
    /// media only a known peer's face reaches the lock screen; mirrors
    /// `communityAvatarShown` in `pushRuntime.ts`.
    static func communityAvatarShown(author: String, config: PushConfig) -> Bool {
        config.mediaPolicy.allCommunityAvatars || config.knownPeers.contains(author)
    }

    static func dmConversationKey(peers: [String]) -> String {
        peers.joined(separator: ",")
    }

    static func isKnownDm(peers: [String], config: PushConfig) -> Bool {
        let key = dmConversationKey(peers: peers)
        return config.knownConversations.contains(key)
            || peers.allSatisfy { config.knownPeers.contains($0) }
    }

    static func isMutedDm(peers: [String], config: PushConfig) -> Bool {
        peers.contains(where: { config.mutedPeers.contains($0) })
    }

    static func dmNotificationLevel(
        peers: [String], config: PushConfig
    ) -> DmNotificationLevel {
        let key = dmConversationKey(peers: peers)
        return config.dmLevels[key] ?? (config.directMessages ? .all : .nothing)
    }

    /// The `/dm/<peers>` route a tap on this notification opens.
    ///
    /// Participants are NPUBS, not the hex the conversation key is made of —
    /// the mirror of `dmPathSegment` in the web client's `chatRoute`
    /// (`src/lib/routes.ts`) and of `dmRoute` in the Android service. A route
    /// string is an identity in the app (the share stash is keyed by one, a
    /// share shortcut is published under one), so a hex path from here would be
    /// a second name for a conversation the rest of the app calls something
    /// else. A participant that isn't a pubkey is left as-is, so a malformed
    /// key still yields a parseable path rather than a dropped destination.
    static func dmPath(peers: [String]) -> String {
        "/dm/\(peers.map { Bech32.npub($0) ?? $0 }.joined(separator: ","))"
    }

    static func dmThreadId(peers: [String]) -> String {
        "dm-\(dmConversationKey(peers: peers))"
    }

    private func prepareDm(wrap: NostrEvent) -> PreparedPush? {
        guard let decryptor = dmDecryptor() else {
            // Neither an on-device key nor a usable bunker: this login cannot
            // open a wrap at all, which is a configuration fact rather than a
            // failure of this message.
            trace("dm-no-decryptor")
            return nil
        }
        guard let opened = Dm17.open(
            wrap: wrap, decryptor: decryptor, self: config.selfPubkey, now: now
        ) else {
            // Addressed to someone else, malformed, expired — or, for a bunker
            // login, a decrypt the bunker did not answer in time.
            trace(config.secretKey == nil ? "dm-open-failed(bunker)" : "dm-open-failed(local)")
            return nil
        }

        // Persist first: a DM exists nowhere else once it is read off the relay.
        try? store?.writeDm(opened, self: config.selfPubkey, now: now)

        // Our own sent copy is addressed to us too, and is not news.
        if opened.author == config.selfPubkey { return dropped }

        // Match the DM list: a group containing any muted participant is
        // hidden as a whole, even if this message's author is unmuted.
        if Self.isMutedDm(peers: opened.peers, config: config) {
            return dropped
        }

        // The gateway has to watch every addressed gift wrap when either the
        // global switch OR one exact room is enabled. Enforce the actual
        // fallback after decrypt so that broad subscription cannot wake an
        // unrelated room. For a DM, `mentions` is equivalent to `all`.
        if Self.dmNotificationLevel(peers: opened.peers, config: config) == .nothing {
            return dropped
        }

        // Reactions, deletes and timer changes are not messages.
        guard opened.kind == Dm17.kindChat || opened.kind == Dm17.kindFile else {
            return requestPing(quiet: true)
        }

        let known = Self.isKnownDm(peers: opened.peers, config: config)
        if !known && config.policy != .full {
            // A stranger picks the text, the name AND the avatar alike — gate
            // all of it before any reaches the screen.
            return requestPing(quiet: config.policy == .off)
        }

        let profile = store?.profile(pubkey: opened.author)
        let message = NotificationPreview.Message(
            plane: .dm,
            kind: opened.kind,
            content: opened.content,
            authorName: profile?.name ?? strings.anonymous,
            roomTitle: nil,
            imetaMime: NotificationPreview.firstImetaMime(opened.tags),
            mentionNames: store?.mentionNames(in: opened.content) ?? [:]
        )
        var shaped = message
        shaped.threadReply = NotificationPreview.isThreadReply(
            kind: opened.kind, tags: opened.tags
        )
        let presented = NotificationPreview.present(shaped, strings: strings)
        return PreparedPush(
            drop: false,
            title: presented.title,
            body: presented.body,
            threadId: Self.dmThreadId(peers: opened.peers),
            path: Self.dmPath(peers: opened.peers),
            quiet: false,
            sender: PreparedPush.Sender(
                id: opened.author,
                name: profile?.name ?? strings.anonymous,
                avatarUrl: config.mediaPolicy.resolve(profile?.picture),
                groupName: nil
            )
        )
    }

    /// How this login can open a gift wrap, or nil if it cannot.
    ///
    /// An nsec login decrypts locally. A bunker login asks the bunker, which
    /// costs two round-trips inside the notification's budget and is why the
    /// timeout is short: an unreachable or slow bunker must degrade to the
    /// gateway's static text quickly, not sit on the extension until iOS kills
    /// it. A NIP-07 login has neither and gets nil — there is no browser here.
    private func dmDecryptor() -> Nip44Decryptor? {
        if let sk = config.secretKey { return LocalDecryptor(secretKey: sk) }
        guard let nip46 = config.nip46 else { return nil }
        guard let client = Nip46Client(
            clientSecretKey: nip46.clientSecretKey,
            bunkerPubkey: nip46.bunkerPubkey,
            relays: nip46.relays,
            timeout: Self.bunkerTimeout
        ) else { return nil }
        return RemoteDecryptor(client: client)
    }

    /// Total budget for the bunker exchange, both RPCs together.
    ///
    /// iOS allows the extension around 30 seconds, but spending them is not
    /// free: the notification is not shown until the handler is called, so a
    /// long wait is a late banner. Ten seconds is enough for two relay
    /// round-trips and short enough that a dead bunker is barely noticeable.
    private static let bunkerTimeout: TimeInterval = 10

    /// The content-blind ping for an unknown sender: nothing they control.
    private func requestPing(quiet: Bool) -> PreparedPush {
        PreparedPush(
            drop: false,
            title: strings.messageRequests,
            body: strings.newMessageRequest(many: quiet),
            threadId: "armada-dm-requests",
            path: "/dm",
            quiet: quiet,
            // No sender: a stranger controls their name AND their avatar, and
            // the point of this ping is that none of it reaches the screen.
            sender: nil
        )
    }

    // MARK: - Concord

    private func prepareConcord(wrap: NostrEvent) -> PreparedPush? {
        // No stream claims this wrap's author: a channel this install is not
        // watching, or an epoch it has no key for yet (the config holds only
        // the CURRENT epoch, and a rekey moves it).
        guard let stream = Concord.stream(for: wrap, in: config.concord) else {
            trace("c2-no-stream(\(config.concord.count) watched)")
            return nil
        }
        let read = Concord.read(wrap: wrap, stream: stream)
        if case .malformed = read {
            trace("c2-malformed")
            return dropped
        }
        guard case .chat(let opened) = read else {
            trace("c2-open-failed")
            return nil
        }

        // Store it either way: a message we won't announce is still a message,
        // and the timeline it belongs to has no other copy.
        try? store?.writeConcord(opened, communityId: stream.communityId, now: now)

        // A rumor dated ahead of the local clock is HELD: stored above like
        // every other message (the timeline hides it until its time comes,
        // Concord.futureHoldSecs), but never announced. Announcing it now would
        // buzz for a message the reader can't yet see, and the OS would stamp
        // the notification "in 5m" from its future createdAt.
        if opened.ms > now * 1000 + stream.clockOffsetMs + Concord.futureHoldSecs * 1000 { return dropped }

        // Our own message, sent from another device. The local send marks its
        // own event id, but nothing marks one made elsewhere — only the
        // decrypted author says so, and that is here.
        if opened.author == config.selfPubkey { return dropped }

        // A muted channel/community (level `nothing`): stored above so its
        // timeline stays complete, and — here — never announced. The mute
        // normally means no gateway subscription at all, but a lingering one can
        // still wake the device, and this is where a leaked wrap is silenced
        // rather than presented as the gateway's static fallback text.
        if stream.muted { return dropped }

        // A banned member (CORD-04): stored above like every other message,
        // folded off the timeline on read, and — here — never announced. The
        // author is on the encrypted rumor, so this is the first place it can
        // be checked.
        if stream.banned.contains(opened.author) { return dropped }

        // A post its readers collapse rings nobody (CORD-04 §8): no SEND in this open
        // Channel, or inside a running Timeout's window.
        if stream.sendDenied.contains(opened.author) { return dropped }
        // At a restricted Channel's read address a post stands only from those who manage it (CORD-03 §1).
        if let posters = stream.postAuthors, opened.kind != Concord.kindReaction, !posters.contains(opened.author) { return dropped }
        if let t = stream.timeouts[opened.author],
           t.until * 1000 > now * 1000 + stream.clockOffsetMs,
           opened.ms >= t.from * 1000, opened.ms < t.until * 1000 {
            return dropped
        }

        // Sent before this membership began: stored above, never announced.
        if !Self.sentDuringMembership(createdAt: opened.createdAt, joinedAtMs: stream.joinedAtMs) {
            return dropped
        }

        let directMention = opened.tags.contains {
            $0.count > 1 && $0[0] == "p" && $0[1] == config.selfPubkey
        }
        let reaction = opened.kind == Concord.kindReaction
        // A reaction is aimed at one message's author only: its content mentions nobody.
        let mention = directMention || (!reaction && (
            ((stream.mentionEveryoneAnyone || stream.mentionEveryoneAuthors.contains(opened.author))
                && Self.hasEveryoneMention(opened.content))
            || RoleMentions.pings(
                content: opened.content, tags: opened.tags, held: stream.roleMentions,
                authorMentionsAny: stream.roleMentionAuthors.contains(opened.author)
            )
        ))
        // A reaction notifies only when it points at one of YOUR messages; the
        // `p` tag is on the encrypted rumor, so this is the first place it can
        // be read at all.
        if reaction && !mention { return dropped }
        // One no row could render rings nobody, as the timeline drops it.
        if reaction && !ReactionContent.renderable(opened.content) { return dropped }

        // "Mentions only": the gateway can't filter an encrypted wrap, so it
        // wakes us for every message on this channel; here — the first place the
        // decrypted `p` tags are legible — we drop anything that doesn't tag the
        // viewer, matching the Android service and the channel's chosen level.
        if stream.mentionOnly && !mention { return dropped }

        let profile = store?.profile(pubkey: opened.author)
        var message = NotificationPreview.Message(
            plane: .c2,
            kind: opened.kind,
            content: opened.content,
            authorName: stream.nicknames[opened.author] ?? profile?.name ?? strings.anonymous,
            roomTitle: store?.concordRoomTitle(
                communityId: stream.communityId, channelId: stream.channelId, strings: strings
            ),
            mention: mention,
            reaction: reaction,
            imetaMime: NotificationPreview.firstImetaMime(opened.tags),
            mentionNames: store?.mentionNames(in: opened.content) ?? [:]
        )
        message.threadReply = NotificationPreview.isThreadReply(
            kind: opened.kind, tags: opened.tags
        )

        let presented = NotificationPreview.present(message, strings: strings)
        // A reaction points at the message it reacted to — the thing the reader
        // is being told about, and the only one of the two a timeline can show.
        //
        // Percent-escaped like the NIP-29 path below, because an `e` tag is an
        // arbitrary string chosen by any holder of the channel's stream key —
        // so an unescaped one ("../../../invite/…") sends the tap to a route of
        // the sender's choosing rather than to their message.
        let target = opened.uniqueETag ?? opened.rumorId
        return PreparedPush(
            drop: false,
            title: presented.title,
            body: presented.body,
            threadId: "c2:\(stream.channelId)",
            path: "/c/\(escape(stream.communityId))/\(escape(stream.channelId))/m/\(escape(target))",
            quiet: false,
            sender: PreparedPush.Sender(
                id: opened.author,
                name: profile?.name ?? strings.anonymous,
                avatarUrl: Self.communityAvatarShown(author: opened.author, config: config)
                    ? config.mediaPolicy.resolve(profile?.picture) : nil,
                groupName: message.roomTitle
            )
        )
    }

    // MARK: - NIP-29

    /// A NIP-29 group message, which arrives in the clear. Its signature has
    /// already been checked by `prepare`.
    ///
    /// Deliberately NOT stored. nostr-push2 names the relay the event arrived
    /// from, but it reads its OWN relays rather than the group's, so that is
    /// not necessarily the group's host and filing it there would be a guess
    /// at a tenant. Nothing is lost: the message is plaintext on a relay the
    /// app re-reads on open, which is exactly the case the "no relay, no
    /// store" rule calls refetchable.
    private func prepareGroup(event: NostrEvent, relays: [String]) -> PreparedPush? {
        guard let groupId = event.uniqueTag("h"), let eventId = event.id else {
            trace("grp-no-h")
            return nil
        }

        if event.pubkey == config.selfPubkey { return dropped }

        // Ask each candidate relay's tenant and accept a name only if exactly
        // ONE knows this group: a hit on two would be two different groups that
        // merely share an id, and naming the notification after either is a
        // coin toss.
        var named = [(relay: String, title: String)]()
        for relay in relays {
            if let title = store?.nip29RoomTitle(relayUrl: relay, groupId: groupId) {
                named.append((relay, title))
            }
        }
        let only = named.count == 1 ? named[0] : nil

        let mention = event.tags.contains {
            $0.count > 1 && $0[0] == "p" && $0[1] == config.selfPubkey
        }
        let profile = store?.profile(pubkey: event.pubkey)
        var message = NotificationPreview.Message(
            plane: .nip29,
            kind: event.kind,
            content: event.content,
            authorName: profile?.name ?? strings.anonymous,
            roomTitle: only?.title,
            mention: mention,
            imetaMime: NotificationPreview.firstImetaMime(event.tags),
            mentionNames: store?.mentionNames(in: event.content) ?? [:]
        )
        message.threadReply = NotificationPreview.isThreadReply(
            kind: event.kind, tags: event.tags
        )

        let presented = NotificationPreview.present(message, strings: strings)
        let relay = only?.relay ?? relays.first
        let threadRoot = NotificationPreview.nip29ThreadRoot(kind: event.kind, tags: event.tags)
        let path = relay.map {
            groupPath(relayUrl: $0, groupId: groupId, eventId: eventId, threadRoot: threadRoot)
        }
        return PreparedPush(
            drop: false,
            title: presented.title,
            body: presented.body,
            threadId: "h:\(groupId)",
            path: path,
            quiet: false,
            sender: PreparedPush.Sender(
                id: event.pubkey,
                name: profile?.name ?? strings.anonymous,
                avatarUrl: config.mediaPolicy.resolve(profile?.picture),
                groupName: only?.title
            )
        )
    }

    /// Deep link to a message in a NIP-29 group, inside its thread when it is a
    /// reply. Mirrors `routes.ts`: the relay's `wss://` scheme is dropped and
    /// `ws://` shortened to `ws:`.
    private func groupPath(relayUrl: String, groupId: String, eventId: String, threadRoot: String?) -> String {
        var trimmed = relayUrl
        if trimmed.lowercased().hasPrefix("wss://") {
            trimmed = String(trimmed.dropFirst(6))
        } else if trimmed.lowercased().hasPrefix("ws://") {
            trimmed = "ws:" + trimmed.dropFirst(5)
        }
        let thread = threadRoot.map { "/t/\(escape($0))" } ?? ""
        return "/s/\(escape(trimmed))/\(escape(groupId))\(thread)/m/\(escape(eventId))"
    }

    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(
            withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        ) ?? value
    }

    /// Mirrors membershipFloor.ts: compared at whole seconds; nil admits all.
    static func sentDuringMembership(createdAt: Int, joinedAtMs: Int?) -> Bool {
        guard let joinedAtMs, joinedAtMs > 0 else { return true }
        return createdAt >= joinedAtMs / 1000
    }

    /// Match the interoperable lowercase token without treating an email or a
    /// longer handle such as `@everyone_else` as a mass mention.
    static func hasEveryoneMention(_ content: String) -> Bool {
        content.range(
            of: #"(^|[^\p{L}\p{N}_@])@everyone(?![\p{L}\p{N}_])"#,
            options: .regularExpression
        ) != nil
    }
}

private extension OpenedChat {
    /// The one `e` tag, or nil when absent or repeated.
    var uniqueETag: String? {
        var found: String?
        for tag in tags where tag.first == "e" {
            if found != nil { return nil }
            found = tag.count > 1 ? tag[1] : nil
        }
        return found
    }
}
