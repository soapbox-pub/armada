/**
 * NIP-17 private DMs — standard, interoperable NIP-59 pipeline:
 *
 *   rumor(unsigned kind 14/15/7/5, real author, real created_at)
 *     └ seal(kind 13, signed by the sender, nip44 to the recipient, backdated)
 *         └ wrap(kind 1059, ["p", recipient], backdated, single-use ephemeral key)
 *
 * Groups: more than one `p` on the rumor; one seal+wrap per participant (plus
 * self), each to their kind-10050 inbox. First-contact wraps carry an outer
 * `["k", "14"]` hint for k-aware inbox indexing.
 *
 * Disappearing messages (Armada extension, {@link KIND_DM_TIMER}): NIP-40
 * `expiration` is stamped on rumor, seal AND wrap, so relays can drop the wrap
 * and readers learn the deadline after decryption. Enforced client-side at
 * {@link openDmWrap} and on every read; absolute deadline (`sent_at + timer`).
 */

import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey, getEventHash } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent, UnsignedEvent } from "nostr-tools/pure";

import { forgetDecrypt } from "@/lib/decryptCache";
import { finalizePowEvent } from "@/lib/pow";
import { isRemovedMessageId } from "@/lib/removedMessages";

import type { NostrRumor } from "@/lib/nostrRumor";

import { dmPeersOf } from "./conversation";

/** NIP-17 chat message rumor. */
export const KIND_DM_CHAT = 14;
/** NIP-17 file message rumor. */
export const KIND_DM_FILE = 15;
/** NIP-25 reaction rumor (NIP-17 allows reactions in the encrypted chat). */
export const KIND_DM_REACTION = 7;
/** NIP-09 delete rumor (wrapped into the conversation per NIP-17). */
export const KIND_DM_DELETE = 5;
/**
 * Disappearing-messages timer change (Armada extension, NIP-17 ⊕ NIP-40). Newest
 * wins; `0` = off. Tags: peer `p` + `["timer", "<seconds>"]`; empty content.
 * Never expires itself — it's shared conversation state.
 */
export const KIND_DM_TIMER = 1740;
/**
 * Typing indicator (Armada extension; same kind as Concord's, CORD-02 Appendix B).
 * Empty content, peer `p`, no expiration. NOT in {@link DM_RUMOR_KINDS}: never stored.
 */
export const KIND_DM_TYPING = 23311;
/** NIP-59 seal. */
export const KIND_DM_SEAL = 13;
/** NIP-59 gift wrap. */
export const KIND_DM_WRAP = 1059;
/**
 * Voice-call signal (Armada extension; see `src/lib/dmCall.ts`). Content is the
 * phase ("offer", "answer", "decline", "end"); tags carry the call binding.
 * Rides the ephemeral 21059 wrap so no record of a call is stored anywhere
 * (trade-off: no missed-call record on devices offline during the ring).
 * NOT in {@link DM_RUMOR_KINDS}.
 */
export const KIND_DM_CALL = 23314;
/**
 * Ephemeral gift wrap (Armada extension, mirroring Concord's 21059): relays
 * broadcast but don't store, so live signals don't pile up in inboxes. Inner
 * seal is standard NIP-59.
 */
export const KIND_DM_WRAP_EPHEMERAL = 21059;

/** How long a typing signal stays live before it ages out. */
export const TYPING_WINDOW_SECS = 8;

/**
 * In-chat app state (as Concord, CORD-02 Appendix B). Stored like any DM rumor
 * but read by {@link queryDm17Webxdc}, not thread reads.
 */
export const KIND_DM_WEBXDC = 3310;

/**
 * Vector's DM peer-signal kind. Processed live only (it names a session-bound
 * transport address), never stored or queried directly.
 */
export const KIND_DM_PEER_SIGNAL = 30078;

/** Every rumor kind the DM plane stores and folds. */
export const DM_RUMOR_KINDS = [
  KIND_DM_DELETE,
  KIND_DM_REACTION,
  KIND_DM_CHAT,
  KIND_DM_FILE,
  KIND_DM_TIMER,
  KIND_DM_WEBXDC,
];

/**
 * Kinds a thread read asks for: everything stored except app state, which is
 * unbounded and would compete for the thread filter's single `limit`.
 */
export const DM_THREAD_KINDS = DM_RUMOR_KINDS.filter((kind) => kind !== KIND_DM_WEBXDC);

/** NIP-59: outer (seal + wrap) timestamps are tweaked into the past, ≤ 2 days. */
export const MAX_WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** NIP-44 hard plaintext cap; a lenient publisher mints undecryptable events. */
const NIP44_MAX_PLAINTEXT = 65_535;

function tweakedPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * MAX_WRAP_BACKDATE_SECS);
}

/** NIP-40 deadline (unix seconds), or undefined. Malformed values count as absent so garbage can't hide a message. */
export function expirationOf(tags: readonly string[][]): number | undefined {
  const raw = tags.find(([name]) => name === "expiration")?.[1];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) ? secs : undefined;
}

/** Whether these tags carry a NIP-40 deadline that has already passed. */
export function isExpired(tags: readonly string[][], nowSecs = Math.floor(Date.now() / 1000)): boolean {
  const at = expirationOf(tags);
  return at !== undefined && at <= nowSecs;
}

/** Append a NIP-40 `expiration` tag when `expiresAt` is set (else pass through). */
export function withExpiration(tags: string[][], expiresAt?: number): string[][] {
  return expiresAt === undefined ? tags : [...tags, ["expiration", String(Math.floor(expiresAt))]];
}

/** What sending/opening a NIP-17 DM needs (every nip44-capable login has it). */
export interface Dm17Signer {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    /** `cache: false` asks a caching signer not to persist this plaintext (expiring envelopes). */
    decrypt(pubkey: string, ciphertext: string, opts?: { cache?: boolean }): Promise<string>;
  };
}

/** Unsigned DM rumor with the REAL author and time; only seal/wrap are backdated. */
export function buildDmRumor(opts: {
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  createdAt?: number;
}): NostrRumor {
  const unsigned: UnsignedEvent = {
    kind: opts.kind,
    content: opts.content,
    tags: opts.tags,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    pubkey: opts.pubkey,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

/**
 * Kind-14 tags: one `p` per receiver (the room), optional `e` reply parent, then
 * extra composer tags. `p` leads so own copies recover the conversation.
 */
export function dmChatTags(
  peers: readonly string[],
  opts?: { replyTo?: string; extraTags?: string[][]; expiresAt?: number },
): string[][] {
  const tags: string[][] = peers.map((peer) => ["p", peer]);
  if (opts?.replyTo) tags.push(["e", opts.replyTo]);
  for (const t of opts?.extraTags ?? []) tags.push(t);
  return withExpiration(tags, opts?.expiresAt);
}

/** Kind-7 reaction tags: `p` set, then NIP-25 `e` target and `k` target-kind. */
export function dmReactionTags(
  peers: readonly string[],
  targetId: string,
  targetKind: number,
  extraTags?: string[][],
  expiresAt?: number,
): string[][] {
  return withExpiration(
    [
      ...peers.map((peer) => ["p", peer]),
      ["e", targetId],
      ["k", String(targetKind)],
      ...(extraTags ?? []),
    ],
    expiresAt,
  );
}

/**
 * Kind-5 delete tags. NEVER expiring: the target may outlive a shorter timer,
 * and an expired tombstone would let it come back.
 */
export function dmDeleteTags(
  peers: readonly string[],
  targetId: string,
  targetKind: number,
): string[][] {
  return [...peers.map((peer) => ["p", peer]), ["e", targetId], ["k", String(targetKind)]];
}

/** Optional webxdc `sendUpdate` fields — a Mini App API contract shared with Concord's 3310 (`useConcordAppSync`). */
export interface DmWebxdcMeta {
  info?: string;
  document?: string;
  summary?: string;
}

/** Kind-3310 Mini App state tags: `p` set, session `i` tag, then {@link DmWebxdcMeta}. */
export function dmWebxdcTags(
  peers: readonly string[],
  uuid: string,
  opts?: DmWebxdcMeta & { expiresAt?: number },
): string[][] {
  const tags: string[][] = [...peers.map((peer) => ["p", peer]), ["i", uuid]];
  if (opts?.info) tags.push(["info", opts.info]);
  if (opts?.document) tags.push(["document", opts.document]);
  if (opts?.summary) tags.push(["summary", opts.summary]);
  return withExpiration(tags, opts?.expiresAt);
}

/** The two rumors that make one optional NIP-17 edit operation. */
export interface DmEditRumors {
  /** New kind-14 message with the edited content at the original timestamp. */
  replacement: NostrRumor;
  /** Kind-5 tombstone for the superseded message. */
  deletion: NostrRumor;
}

/**
 * NIP-17 edit: delete the old rumor and publish a new kind 14 with the SAME
 * `created_at`, keeping room/reply/media/expiration tags. Clients without edit
 * support see a deletion plus a message.
 */
export function buildDmEditRumors(
  original: NostrRumor,
  peers: readonly string[],
  content: string,
  editedAt = Math.floor(Date.now() / 1000),
): DmEditRumors {
  if (original.kind !== KIND_DM_CHAT) throw new Error("Only NIP-17 chat messages can be edited");

  const editTimestamp = Math.floor(editedAt);
  const replacement = buildDmRumor({
    kind: KIND_DM_CHAT,
    content,
    tags: [
      ...original.tags.filter(([name]) => name !== "edited"),
      ["edited", String(editTimestamp)],
    ],
    pubkey: original.pubkey,
    createdAt: original.created_at,
  });
  const deletion = buildDmRumor({
    kind: KIND_DM_DELETE,
    content: "",
    tags: dmDeleteTags(peers, original.id, original.kind),
    pubkey: original.pubkey,
    createdAt: editTimestamp,
  });

  return { replacement, deletion };
}

/** Tags for a kind-1740 timer-change rumor. `seconds` of 0 turns it off. */
export function dmTimerTags(peers: readonly string[], seconds: number): string[][] {
  return [
    ...peers.map((peer) => ["p", peer]),
    ["timer", String(Math.max(0, Math.floor(seconds)))],
  ];
}

/**
 * Kind-23311 typing tags: just the `p` set. No `expiration`: freshness is
 * `created_at` vs {@link TYPING_WINDOW_SECS}.
 */
export function dmTypingTags(peers: readonly string[]): string[][] {
  return peers.map((peer) => ["p", peer]);
}

/** Timer seconds (0 = off) from a kind-1740 rumor; undefined if malformed (never read as "off"). */
export function dmTimerSeconds(rumor: { tags: readonly string[][] }): number | undefined {
  const raw = rumor.tags.find(([name]) => name === "timer")?.[1];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : undefined;
}

/**
 * Seal a rumor to one recipient (kind 13, nip44, backdated) with the sender's
 * real identity. Self-copy passes the sender's own pubkey. NIP-40 `expiration`
 * propagates onto the seal.
 */
export async function sealDmRumor(
  rumor: NostrRumor,
  recipientPk: string,
  signer: Dm17Signer,
): Promise<NostrEvent> {
  if (!signer.nip44) throw new Error("This signer can't send private messages (NIP-44 unsupported).");
  const json = JSON.stringify(rumor);
  if (new TextEncoder().encode(json).length > NIP44_MAX_PLAINTEXT) {
    throw new Error("Message is too large to encrypt.");
  }
  return signer.signEvent({
    kind: KIND_DM_SEAL,
    content: await signer.nip44.encrypt(recipientPk, json),
    tags: withExpiration([], expirationOf(rumor.tags)),
    created_at: tweakedPast(),
  });
}

/** Wrap a seal with a single-use key; opens with standard `nip44.decrypt(wrap.pubkey, content)`. */
export function wrapDmSeal(
  seal: NostrEvent,
  recipientPk: string,
  opts?: { firstContact?: boolean; expiresAt?: number },
): Promise<NostrEvent> {
  const wrapSk = generateSecretKey();
  const convKey = getConversationKey(wrapSk, recipientPk);
  const tags: string[][] = [["p", recipientPk]];
  // First-contact hint for k-aware inbox indexing; omitted afterwards to avoid leaking the inner kind.
  if (opts?.firstContact) tags.push(["k", String(KIND_DM_CHAT)]);
  // The outer NIP-40 tag is the only expiry a relay can act on.
  return finalizePowEvent(
    {
      kind: KIND_DM_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), convKey),
      tags: withExpiration(tags, opts?.expiresAt ?? expirationOf(seal.tags)),
      created_at: tweakedPast(),
    },
    wrapSk,
  );
}

/**
 * Ephemeral (kind-21059) variant of {@link wrapDmSeal}. NOT backdated: it's
 * never stored, is stale after {@link TYPING_WINDOW_SECS}, and some relays drop
 * far-past events.
 */
export function wrapDmSealEphemeral(seal: NostrEvent, recipientPk: string): Promise<NostrEvent> {
  const wrapSk = generateSecretKey();
  return finalizePowEvent(
    {
      kind: KIND_DM_WRAP_EPHEMERAL,
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(wrapSk, recipientPk)),
      tags: [["p", recipientPk]],
      created_at: Math.floor(Date.now() / 1000),
    },
    wrapSk,
  );
}

/** A fully-opened, verified DM rumor, attributed to its conversation. */
export interface OpenedDm {
  /** Rumor id (NIP-01 hash): message id, dedup and display key. */
  rumorId: string;
  /** Verified author (the seal's signer, equal to the rumor's pubkey). */
  author: string;
  kind: number;
  content: string;
  tags: string[][];
  createdAt: number;
  /** Participants from the viewer's side (see {@link dmPeersOf}). */
  peers: string[];
  wrapId: string;
}

/** The NIP-40 deadline this opened rumor disappears at, if any. */
export function dmExpiresAt(opened: Pick<OpenedDm, "tags">): number | undefined {
  return expirationOf(opened.tags);
}

/** Reject rumors claiming to be from further in the future than this. */
const MAX_FUTURE_SKEW_SECS = 3600;

/**
 * Open a kind-1059 (or, via `opts.wrapKind`, 21059) wrap addressed to `self`.
 * Returns the verified rumor or undefined; rumor kinds are not filtered. Checks:
 * rumor pubkey == seal signer (NIP-59; NIP-44 AEAD already authenticates the
 * seal), and rumor id == its NIP-01 hash. An expired NIP-40 tag at ANY level
 * rejects the envelope before it can be persisted, and expiring envelopes skip
 * the signer's persistent decrypt cache.
 */
export async function openDmWrap(
  wrap: NostrEvent,
  signer: Pick<Dm17Signer, "nip44">,
  self: string,
  opts?: { wrapKind?: number; cache?: boolean },
): Promise<OpenedDm | undefined> {
  if (wrap.kind !== (opts?.wrapKind ?? KIND_DM_WRAP) || !signer.nip44) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (isExpired(wrap.tags, now)) return undefined;
  try {
    // `cache: false` (ephemeral plane) also skips the signer's persistent decrypt cache.
    const wrapCache = opts?.cache !== false && expirationOf(wrap.tags) === undefined;
    const seal = JSON.parse(
      await signer.nip44.decrypt(wrap.pubkey, wrap.content, { cache: wrapCache }),
    ) as NostrEvent;
    if (seal.kind !== KIND_DM_SEAL || typeof seal.pubkey !== "string") return undefined;
    if (!Array.isArray(seal.tags) || isExpired(seal.tags, now)) return undefined;

    const sealCache = wrapCache && expirationOf(seal.tags) === undefined;
    const rumor = JSON.parse(
      await signer.nip44.decrypt(seal.pubkey, seal.content, { cache: sealCache }),
    ) as NostrRumor;
    if (rumor.pubkey !== seal.pubkey) return undefined;
    if (typeof rumor.kind !== "number" || typeof rumor.content !== "string") return undefined;
    if (!Array.isArray(rumor.tags) || typeof rumor.created_at !== "number") return undefined;
    if (rumor.created_at > now + MAX_FUTURE_SKEW_SECS) return undefined;
    if (isExpired(rumor.tags, now)) return undefined;

    const computedId = getEventHash({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
      pubkey: rumor.pubkey,
    });
    if (rumor.id !== undefined && rumor.id !== computedId) return undefined;
    // Removed from this device: what opening it just cached goes too.
    if (isRemovedMessageId(computedId)) {
      await Promise.all([
        forgetDecrypt(self, "nip44", wrap.pubkey, wrap.content),
        forgetDecrypt(self, "nip44", seal.pubkey, seal.content),
      ]);
      return undefined;
    }

    const peers = dmPeersOf(rumor, self);
    if (!peers) return undefined;

    return {
      rumorId: computedId,
      author: rumor.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      createdAt: rumor.created_at,
      peers,
      wrapId: wrap.id,
    };
  } catch {
    return undefined;
  }
}
