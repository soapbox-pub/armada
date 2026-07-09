/**
 * Concord V2 event-kind registry — CORD-02 Appendix B (frozen).
 *
 * Every durable plane event is a kind-1059 wrap around a seal (CORD-01); the
 * INNER rumor carries the functional kind. Standard kinds are reused where one
 * fits (9 message, 7 reaction, 5 delete); the dedicated 33xx block covers the
 * rest. Retired numbers (3300, 3301, 3304, 3305, 3307, 3311, 23308) are burned
 * forever and never appear here.
 */

// ── Envelope kinds (CORD-01) ─────────────────────────────────────────────────

/** Durable gift wrap (the outer envelope of every stored plane event). */
export const KIND_WRAP = 1059;
/** Ephemeral gift wrap — identical structure, relays MUST NOT store it. */
export const KIND_WRAP_EPHEMERAL = 21059;
/** Encrypted seal: the rumor is NIP-44-encrypted again inside the wrap. */
export const KIND_SEAL_ENCRYPTED = 20013;
/** Plaintext seal: the seal's content is the rumor's JSON string, byte-verbatim. */
export const KIND_SEAL_PLAINTEXT = 20014;

// ── Chat Plane rumor kinds ───────────────────────────────────────────────────

/** Chat message (NIP-C7 shape; `q` tags are inline quote-replies, NOT threads). */
export const KIND_MESSAGE = 9;
/**
 * Threaded reply (NIP-22 comment). A thread reply is a kind-1111 rumor pointing
 * at its thread root (`K`/`E`/`P`) and immediate parent (`k`/`e`/`p`), NOT a
 * kind-9 message with a `q` tag — `q` is reserved for inline quote-replies per
 * NIP-C7. See {@link buildV2CommentTags}.
 */
export const KIND_COMMENT = 1111;
/** Reaction (NIP-25 shape). */
export const KIND_REACTION = 7;
/** Delete (NIP-09 shape; names the author's own rumor ids). */
export const KIND_DELETE = 5;
/** Message edit (fields not yet pinned by the CORDs; `e` names the target). */
export const KIND_EDIT = 3302;
/**
 * Zap (CORD.md): NIP-57 receipt shape authored by the PAYER, plus a
 * `preimage` tag as the payment proof. Verified locally by every member
 * (sha256(preimage) == bolt11 payment hash, amount tag == invoice amount);
 * unverified zaps never enter tallies.
 */
export const KIND_ZAP = 9735;
/** WebXDC peer signal. */
export const KIND_WEBXDC = 3310;
/** Typing indicator — ephemeral rumor (rides a 21059 wrap). */
export const KIND_TYPING = 23311;
/** Voice presence (CORD-07 §4) — ephemeral rumor (rides a 21059 wrap). */
export const KIND_VOICE_PRESENCE = 23313;

// ── Guestbook Plane rumor kinds ──────────────────────────────────────────────

/** Join / Leave: self-signed, the content is the verb. */
export const KIND_JOIN_LEAVE = 3306;
/** Kick: admin-signed, names its target, cites its Grant (`vac`). */
export const KIND_KICK = 3309;
/** Guestbook snapshot: refounder-signed, chunked at 400 members. */
export const KIND_SNAPSHOT = 3312;

// ── Person-addressed rumor kinds (standard NIP-59, not stream traffic) ──────

/**
 * Direct invite (CORD-05 §6): the invite bundle giftwrapped straight to an
 * npub — a kind-13 seal signed by the inviter's REAL key inside an
 * ephemeral-author, recipient-`p`-tagged 1059 wrap (classic NIP-59, NOT the
 * reversed stream wrap). The wrap carries an outer `["k", "3313"]` tag so a
 * recipient can index exactly their invites without decrypting their whole
 * giftwrap inbox.
 */
export const KIND_DIRECT_INVITE = 3313;

// ── Control / rekey rumor kinds ──────────────────────────────────────────────

/** Control edition (sub-kinded by the `vsk` tag). */
export const KIND_CONTROL = 3308;
/** Rekey blobs (CORD-06), delivered at rekey addresses. */
export const KIND_REKEY = 3303;

// ── Bare kinds (outside the wrap) ────────────────────────────────────────────

/** Public invite bundle: addressable, signed by the per-link keypair, empty `d`. */
export const KIND_INVITE_BUNDLE = 33301;
/** A member's self-encrypted Community List (replaceable, one per user). */
export const KIND_COMMUNITY_LIST = 13302;
/** A creator's self-encrypted Invite List (replaceable, one per user). */
export const KIND_INVITE_LIST = 13303;

// ── Control edition sub-kinds (the `vsk` tag) ────────────────────────────────

export const VSK_METADATA = "0";
export const VSK_ROLE = "1";
export const VSK_CHANNEL = "2";
export const VSK_GRANT = "3";
export const VSK_BANLIST = "4";
// 5 reserved (role ordering); 6/9 claimed by the addressable invite marker;
// 7 retired (v1 owner attestation).
export const VSK_INVITE_REGISTRY = "8";
export const VSK_DISSOLVED = "10";

/** Invite-bundle marker values for its `vsk` tag: live vs revocation tombstone. */
export const VSK_INVITE_LIVE = "6";
export const VSK_INVITE_REVOKED = "9";
