/**
 * Concord event-kind registry — CORD-02 Appendix B (frozen).
 *
 * Every durable plane event is a kind-1059 wrap around a seal (CORD-01); the
 * INNER rumor carries the functional kind. Standard kinds are reused where one
 * fits (9 message, 7 reaction, 5 delete); the dedicated 33xx block covers the
 * rest. Retired numbers (3300, 3301, 3304, 3305, 3307, 3311, 23308) are burned
 * forever and never appear here.
 */

// Envelope kinds (CORD-01)
/** Durable gift wrap (the outer envelope of every stored plane event). */
export const KIND_WRAP = 1059;
/** Ephemeral gift wrap — identical structure, relays MUST NOT store it. */
export const KIND_WRAP_EPHEMERAL = 21059;
/** Encrypted seal: the rumor is NIP-44-encrypted again inside the wrap. */
export const KIND_SEAL_ENCRYPTED = 20013;
/** Plaintext seal: the seal's content is the rumor's JSON string, byte-verbatim. */
export const KIND_SEAL_PLAINTEXT = 20014;

// Chat Plane rumor kinds
/** Chat message (NIP-C7 shape; `q` tags are inline quote-replies, NOT threads). */
export const KIND_MESSAGE = 9;
/** Threaded reply (NIP-22). `q` on kind 9 is inline quote-reply only (NIP-C7). */
export const KIND_COMMENT = 1111;
/** Reaction (NIP-25 shape). */
export const KIND_REACTION = 7;
/** Delete (NIP-09 shape; names the author's own rumor ids). */
export const KIND_DELETE = 5;
/** Message edit (fields not yet pinned by the CORDs; `e` names the target). */
export const KIND_EDIT = 3302;
/**
 * Disappearing-messages timer notice (CORD-08 §4): `["timer", "<seconds>"]` ("0" =
 * off), as NIP-17 clients use. Informational; shown only if the author holds
 * MANAGE_METADATA. Never carries an `expiration` tag itself.
 */
export const KIND_TIMER_NOTICE = 1740;
/**
/**
 * Zap: NIP-57 receipt authored by the PAYER plus a `preimage` tag, verified
 * locally (sha256(preimage) == payment hash, amount matches); unverified zaps
 * never enter tallies.
 */
export const KIND_ZAP = 9735;
/** On-chain Bitcoin zap attribution (NIP-? §8333 shape, sealed as a rumor). */
export const KIND_ONCHAIN_ZAP = 8333;
/** Poll (NIP-88 kind 1068), sealed as a Chat rumor; visible and the `e`-target of votes. */
export const KIND_POLL = 1068;
/** Poll vote (NIP-88 kind 1018); tallied per poll, latest per pubkey wins; never its own row. */
export const KIND_POLL_VOTE = 1018;
/**
 * Calendar events (NIP-52 date/time), sealed as Chat rumors and shown in the
 * events bar. Identity is (author, `d`) within the channel; RSVPs use `e` (a
 * rumor has no `a`-coordinate).
 */
export const KIND_CALENDAR_DATE = 31922;
export const KIND_CALENDAR_TIME = 31923;
/** Calendar RSVP (NIP-52 kind 31925), an `e`-referencing side event like a vote. */
export const KIND_CALENDAR_RSVP = 31925;
/** WebXDC peer signal. */
export const KIND_WEBXDC = 3310;
/** Typing indicator — ephemeral rumor (rides a 21059 wrap). */
export const KIND_TYPING = 23311;
/** Voice presence (CORD-07 §4) — ephemeral rumor (rides a 21059 wrap). */
export const KIND_VOICE_PRESENCE = 23313;
/** A moderator's voice directive (CORD-07 §7), ephemeral on the Channel's plane. */
export const KIND_VOICE_DIRECTIVE = 23314;

// Guestbook Plane rumor kinds
/** Join / Leave: self-signed, the content is the verb. */
export const KIND_JOIN_LEAVE = 3306;
/** Kick: admin-signed, names its target, cites its Grant (`vac`). */
export const KIND_KICK = 3309;
/** Guestbook snapshot: refounder-signed, chunked at 400 members. */
export const KIND_SNAPSHOT = 3312;
/** Timeout (CORD-04 §8): moderator-signed, silences its target until a time. */
export const KIND_TIMEOUT = 3314;
/** Nickname (CORD-04 §10): what its target goes by in this Community. */
export const KIND_NICKNAME = 3315;

// Person-addressed rumor kinds (standard NIP-59, not stream traffic)
/**
 * Direct invite (CORD-05 §6): classic NIP-59 (kind-13 seal by the inviter's real
 * key, recipient-`p`-tagged 1059), with an outer `["k", "3313"]` tag for indexing.
 */
export const KIND_DIRECT_INVITE = 3313;

// Control / rekey rumor kinds
/** Control edition (sub-kinded by the `vsk` tag). */
export const KIND_CONTROL = 3308;
/** Rekey blobs (CORD-06), delivered at rekey addresses. */
export const KIND_REKEY = 3303;

// Bare kinds (outside the wrap)
/** Public invite bundle: addressable, signed by the per-link keypair, empty `d`. */
export const KIND_INVITE_BUNDLE = 33301;
/**
 * A member's self-encrypted Community List (CORD-02 §8): addressable, one
 * event per FRAGMENT at `d` = the fragment index in decimal.
 */
export const KIND_COMMUNITY_LIST_FRAG = 33302;
/**
 * RETIRED single-event Community List, superseded by 33302. Never written; read
 * only by the confirmed-empty seed's rescue fetch so old vaults can migrate.
 */
export const KIND_COMMUNITY_LIST_RETIRED = 13302;
/** A creator's self-encrypted Invite List (replaceable, one per user). */
export const KIND_INVITE_LIST = 13303;

// Control edition sub-kinds (the `vsk` tag)
export const VSK_METADATA = "0";
export const VSK_ROLE = "1";
export const VSK_CHANNEL = "2";
export const VSK_GRANT = "3";
export const VSK_BANLIST = "4";
// 5 reserved (role ordering); 6/9 claimed by the addressable invite marker;
// 7 retired (v1 owner attestation).
export const VSK_INVITE_REGISTRY = "8";
export const VSK_DISSOLVED = "10";
export const VSK_PINS = "11";
/**
 * Community Signals (CORD-04 §8): a NAMESPACE — each `signal_id` is its own
 * control edition at `signalLocator(cid, signal_id)`. Enforcement is a reader-side
 * fold, never a drop.
 */
export const VSK_SIGNALS = "12";

/**
 * The one implemented `signal_id`: closes the Community to non-staff. Content
 * `{ paused: boolean, until?: number }` (unix s), gated by MANAGE_CHANNELS.
 * Unknown tokens are never derived, so invisible rather than mis-enforced.
 */
export const SIGNAL_PAUSE = "pause";

/** Invite-bundle marker values for its `vsk` tag: live vs revocation tombstone. */
export const VSK_INVITE_LIVE = "6";
export const VSK_INVITE_REVOKED = "9";

// Plane rules (CORD-02 §5)
/** Stream planes read back BY KIND. Chat is read by `#channel` tag instead. */
export type Plane = "control" | "guestbook" | "rekey";

/**
 * Each plane's rumor kinds and seal form (CORD-02 §5). Kind sets are disjoint, so
 * the plane is a property of the rumor. Enforced once at ingest
 * ({@link writeOpened}) against the plane whose keys opened the wrap — otherwise
 * one plane's key-holder could forge another plane's rumors.
 */
export const PLANE_RULES: Record<Plane, { kinds: number[]; sealKind: number }> = {
  control: { kinds: [KIND_CONTROL], sealKind: KIND_SEAL_PLAINTEXT },
  guestbook: { kinds: [KIND_JOIN_LEAVE, KIND_KICK, KIND_SNAPSHOT, KIND_TIMEOUT, KIND_NICKNAME], sealKind: KIND_SEAL_ENCRYPTED },
  rekey: { kinds: [KIND_REKEY], sealKind: KIND_SEAL_ENCRYPTED },
};

/**
 * Every non-chat plane kind — refused by CHAT ingress, mirroring `writeOpened`.
 * Planes share one tenant, so without this one channel's key-holder could inject
 * a kind-3308 rumor that `queryPlane` serves as a control edition.
 */
export const PLANE_KINDS: ReadonlySet<number> = new Set(
  Object.values(PLANE_RULES).flatMap((rule) => rule.kinds),
);
