package buzz.armada.app.db

/**
 * The Concord opened-event store's rules, in Kotlin — a port of the parts of
 * `src/concord/lib/kinds.ts` and `rumorStore.ts` that decide what the CHAT
 * plane may put in a community's tenant.
 *
 * The background service decrypts chat wraps for its notifications anyway, so it
 * files the recovered rumor in the same per-community tenant the WebView reads
 * rather than throwing it away and leaving the app to open the wrap a second
 * time. That only works if it obeys the same rules — a rule only one writer
 * applies is a conversation the two disagree about.
 *
 * Pure and Context-free so the rules can be tested on the JVM without an
 * emulator; [ServiceStore.storeConcordRumor] is the thin part that writes.
 */
internal object Concord {

    /** CORD-02 §5's encrypted seal — the only form a chat wrap may carry. */
    const val SEAL_ENCRYPTED = 20013

    /**
     * Every kind claimed by a non-chat plane: control (3308), guestbook
     * (3306/3309/3312/3314/3315) and rekey (3303). Mirrors `PLANE_KINDS` in
     * `src/concord/lib/kinds.ts`.
     */
    val PLANE_KINDS = setOf(3308, 3306, 3309, 3312, 3314, 3315, 3303)

    /** The ArmadaDB tenant holding one community's opened events. */
    fun tenant(communityIdHex: String): String = ArmadaDb.communityTenant(communityIdHex)

    /**
     * Whether an opened CHAT rumor may be stored in a community's tenant.
     *
     * Refused when:
     *
     *  - the seal was not encrypted. Chat seals MUST be (CORD-02 §5), and this
     *    is where that holds for rows the service writes: the seal form is not
     *    stored, so no reader downstream can re-derive it — the WebView refuses
     *    a plaintext-sealed chat wrap at ingest, and a second writer must apply
     *    the same rule or it would plant a row every reader then treats as
     *    encrypted-sealed;
     *  - the kind belongs to another plane. A community's planes share this
     *    tenant and a plane is read back BY KIND, so a chat wrap carrying a
     *    kind-3308 rumor would be served as a control edition — and a stored
     *    rumor has no seal left for the fold to check the form of. This is the
     *    other half of the boundary the WebView's `writeOpened` guards from the
     *    plane side.
     *  - its NIP-40 deadline has passed (CORD-08 §3). The WebView's
     *    `writeRumors` refuses an expired chat rumor at ingest, and its sweep
     *    only walks rows the read filter already hides — a second writer that
     *    stored one would plant a disappearing message past its deadline.
     *
     * The caller owns the crypto: that the seal's signature is good, that the
     * rumor's author IS the seal's signer, and that the channel/epoch binding
     * matches the stream whose key opened the wrap.
     */
    fun storable(communityIdHex: String, sealKind: Int, rumor: Rumor, now: Long): Boolean {
        if (communityIdHex.isEmpty()) return false
        if (sealKind != SEAL_ENCRYPTED) return false
        if (rumor.kind in PLANE_KINDS) return false
        return !Dm17.isExpired(rumor.tags, now)
    }
}
