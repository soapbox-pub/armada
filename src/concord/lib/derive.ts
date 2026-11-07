/**
 * Concord derivations — CORD-02 Appendix A (frozen). Changing any labeled byte
 * re-addresses every prior event: treat this file as wire format.
 *
 * Construction (A.1): `HKDF-SHA256(ikm=secret, salt=∅, info, L=32)` where
 *   `info = utf8(label) || 0x00 || id[32] || epoch_be[8]?`
 * The id is always present (all-zeroes where meaningless); only the epoch is
 * omittable. The A.3 retry counter appends after the present fields, from 0.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getConversationKey } from "nostr-tools/nip44";

// ── Labels (A.6, frozen) ─────────────────────────────────────────────────────

const LABEL_CHANNEL = "concord/channel";
const LABEL_CONTROL = "concord/control";
const LABEL_CONTROL_SIGNER = "concord/control-signer";
const LABEL_REKEY_PSEUDONYM = "concord/rekey-pseudonym";
const LABEL_BASE_REKEY_PSEUDONYM = "concord/base-rekey-pseudonym";
const LABEL_RECIPIENT_PSEUDONYM = "concord/recipient-pseudonym";
const LABEL_GUESTBOOK = "concord/guestbook";
const LABEL_VOICE_SIGNER = "concord/voice-signer";
const LABEL_VOICE_MEDIA = "concord/voice-media";
const LABEL_VOICE_SENDER = "concord/voice-sender";
const LABEL_DISSOLVED = "concord/dissolved";
const LABEL_GRANT = "concord/grant";
const LABEL_BANLIST = "concord/banlist";
const LABEL_INVITE_LINKS = "concord/invite-links";
const LABEL_PINS = "concord/pins";
const LABEL_SIGNAL = "concord/signal";
const LABEL_INVITE_KEY = "concord/invite-key";
const LABEL_CHANNEL_ACCESS = "concord/channel-access";
const LABEL_CHANNEL_WRITER = "concord/channel-writer";
const LABEL_EVERYONE = "concord/everyone";
const LABEL_TENURE = "concord/tenure";
const LABEL_ACL = "concord/acl";
const LABEL_SYNC = "concord/sync";
const LABEL_WRITERS = "concord/writers";
const LABEL_EDITION_BINDING = "concord/edition-binding";
const LABEL_WRAP_OWNER = "concord/wrap-owner";
// A.7: plain SHA-256 scopes, outside the hkdf shape.
const LABEL_WRITER_SCOPE = "concord/writer-scope";
const LABEL_CERTIFIER_SCOPE = "concord/certifier-scope";
const LABEL_HISTORY_SCOPE = "concord/history-scope";

/** The community_id commitment prefix (A.4) — plain SHA-256, NOT the hkdf shape. */
const LABEL_COMMUNITY = "concord/community";
/** The epoch-key commitment prefix (A.5). */
const LABEL_EPOCH_COMMITMENT = "concord/epoch-key-commitment";

const ZERO32 = new Uint8Array(32);
const ASCII = new TextEncoder();

export function random32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export { bytesToHex, hexToBytes };

/** Parse a 64-char hex string to 32 bytes, throwing on malformed input. */
export function hex32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`invalid 64-char hex (got ${hex.length} chars)`);
  }
  return hexToBytes(hex.toLowerCase());
}

function assert32(name: string, b: Uint8Array): void {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

function toEpoch(epoch: number | bigint): bigint {
  return typeof epoch === "bigint" ? epoch : BigInt(epoch);
}

function u64be(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, false);
  return out;
}

/** `utf8(label) || 0x00 || id[32] || epoch_be[8]?` — epoch omitted when undefined. */
function buildInfo(label: string, id32: Uint8Array, epoch?: bigint): Uint8Array {
  assert32("id", id32);
  const labelBytes = ASCII.encode(label);
  const hasEpoch = epoch !== undefined;
  const out = new Uint8Array(labelBytes.length + 1 + 32 + (hasEpoch ? 8 : 0));
  let o = 0;
  out.set(labelBytes, o);
  o += labelBytes.length;
  out[o] = 0x00;
  o += 1;
  out.set(id32, o);
  o += 32;
  if (hasEpoch) new DataView(out.buffer).setBigUint64(o, epoch, false);
  return out;
}

/** HKDF-SHA256, zero-length salt, 32-byte output. */
function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

/**
 * Reduce an hkdf seed to a valid secp256k1 secret key: if invalid, append an
 * incrementing counter byte (from 0) to the info and retry (A.3; ~2^-128 rare).
 */
function hkdfToSecretKey(ikm: Uint8Array, baseInfo: Uint8Array): Uint8Array {
  {
    const seed = hkdf32(ikm, baseInfo);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  for (let counter = 0; counter <= 0xff; counter++) {
    const info = new Uint8Array(baseInfo.length + 1);
    info.set(baseInfo, 0);
    info[baseInfo.length] = counter;
    const seed = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  throw new Error("scalar rejection 257 times running is impossible");
}

/**
 * A plane's stream keypair: the x-only pk is the on-wire Stream address (the
 * `authors` filter), sk signs its wraps, and the NIP-44 self-ECDH key encrypts them.
 */
export interface GroupKey {
  /** secp256k1 secret key (signs the plane's wraps). */
  sk: Uint8Array;
  /** x-only pubkey hex — the Stream address. */
  pk: string;
  /**
   * NIP-44 conversation key (self-ECDH). LAZY: the ECDH is the expensive half, and
   * many keys are only used for their address.
   */
  readonly convKey: Uint8Array;
}

/**
 * A stream as a READER holds it: address + conversation key, plus the signing
 * secret only when held. A Write-Restricted Stream (CORD-01, the split Control
 * Plane) gives every member the address (`control_pk`) and read key, but only
 * staff the `control_root` the signer derives from; read-only paths take this shape.
 */
export interface StreamKeyView {
  /** x-only pubkey hex — the Stream address. */
  pk: string;
  /** NIP-44 conversation key that opens the wraps. */
  readonly convKey: Uint8Array;
  /** The wrap-signing secret, when held (absent for a write-restricted read view). */
  sk?: Uint8Array;
  /**
   * Write-restricted (CORD-01): the wrap signer is a narrower writer set, so readers
   * MUST verify the wrap signature (an ordinary stream's proves nothing).
   */
  restricted?: boolean;
}

/**
 * The persistable form of one derivation (see `groupKeyPersist.ts`). `h` hashes
 * the memo key so the community secret is never spelled out; `sk` is stored hex
 * (same device-trust level as stored plaintext); `ck` appears once computed.
 * Imports are shape-checked, not re-proved (that point-mul is what's cached).
 */
export interface GroupKeyMemoEntry {
  /** sha256 hex of the memo key (label|secret|id|epoch). */
  h: string;
  /** Derived secp256k1 secret key, hex. */
  sk: string;
  /** x-only pubkey hex — the Stream address. */
  pk: string;
  /** NIP-44 conversation key hex; absent until first `convKey` read. */
  ck?: string;
}

/**
 * `groupKey` memo. Each derivation costs an HKDF + base-point multiplication (and
 * a lazy ECDH), and the app re-derives every community's key set on short polls.
 * Sound because derivation is a pure function of (label, secret, id, epoch)
 * (Appendix A is frozen) and GroupKeys are read-only. FIFO-bounded.
 */
const groupKeyMemo = new Map<string, { key: GroupKey; entry: GroupKeyMemoEntry }>();
const GROUP_KEY_MEMO_MAX = 8192;

/** Persisted entries not yet claimed by a derivation this session, keyed by `h`. */
const hydratedEntries = new Map<string, GroupKeyMemoEntry>();

/** Notified synchronously whenever the persistable state gains information. */
let memoDirtyListener: (() => void) | undefined;

function memoDirty(): void {
  memoDirtyListener?.();
}

function hashMemoKey(memoKey: string): string {
  return bytesToHex(sha256(ASCII.encode(memoKey)));
}

/** The GroupKey view over a memo entry; reading `convKey` lazily fills `entry.ck`. */
function entryGroupKey(entry: GroupKeyMemoEntry): GroupKey {
  const sk = hexToBytes(entry.sk);
  const pk = entry.pk;
  let convKey = entry.ck !== undefined ? hexToBytes(entry.ck) : undefined;
  return {
    sk,
    pk,
    get convKey(): Uint8Array {
      if (convKey === undefined) {
        convKey = getConversationKey(sk, pk);
        entry.ck = bytesToHex(convKey);
        memoDirty();
      }
      return convKey;
    },
  };
}

function groupKeyCached(label: string, secret: Uint8Array, id: Uint8Array, epoch?: bigint): GroupKey {
  const memoKey = `${label}|${bytesToHex(secret)}|${bytesToHex(id)}|${epoch ?? ""}`;
  const hit = groupKeyMemo.get(memoKey);
  if (hit) return hit.key;

  const h = hashMemoKey(memoKey);
  let entry = hydratedEntries.get(h);
  if (entry !== undefined) {
    hydratedEntries.delete(h);
  } else {
    const sk = hkdfToSecretKey(secret, buildInfo(label, id, epoch));
    entry = { h, sk: bytesToHex(sk), pk: bytesToHex(schnorr.getPublicKey(sk)) };
    memoDirty();
  }

  const slot = { key: entryGroupKey(entry), entry };
  if (groupKeyMemo.size >= GROUP_KEY_MEMO_MAX) {
    groupKeyMemo.delete(groupKeyMemo.keys().next().value as string);
  }
  groupKeyMemo.set(memoKey, slot);
  return slot.key;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Install persisted entries (malformed rows skipped); each is claimed by the first
 * derivation that asks for it.
 */
export function importGroupKeyMemo(entries: unknown[]): void {
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const { h, sk, pk, ck } = raw as Partial<GroupKeyMemoEntry>;
    if (typeof h !== "string" || !HEX64.test(h)) continue;
    if (typeof sk !== "string" || !HEX64.test(sk)) continue;
    if (typeof pk !== "string" || !HEX64.test(pk)) continue;
    if (ck !== undefined && (typeof ck !== "string" || !HEX64.test(ck))) continue;
    hydratedEntries.set(h, { h, sk, pk, ...(ck !== undefined ? { ck } : {}) });
  }
}

/**
 * Everything worth persisting: this session's memo PLUS unclaimed hydrated
 * entries (so unopened communities keep their cache). Deduped by `h` (live copy
 * wins), oldest first so `limit` drops the stalest.
 */
export function exportGroupKeyMemo(limit: number): GroupKeyMemoEntry[] {
  const byHash = new Map<string, GroupKeyMemoEntry>();
  for (const entry of hydratedEntries.values()) byHash.set(entry.h, entry);
  for (const { entry } of groupKeyMemo.values()) byHash.set(entry.h, entry);
  const entries = [...byHash.values()];
  return entries.length > limit ? entries.slice(entries.length - limit) : entries;
}

/** Register THE dirty listener (last registration wins — one persist layer exists). */
export function onGroupKeyMemoDirty(listener: () => void): void {
  memoDirtyListener = listener;
}

/** Forget every cached and hydrated derivation (they hold stream secrets). */
export function clearGroupKeyMemo(): void {
  groupKeyMemo.clear();
  hydratedEntries.clear();
}

/** Test seam: forget every derivation and the persist listener. */
export function _resetGroupKeyMemoForTests(): void {
  clearGroupKeyMemo();
  memoDirtyListener = undefined;
}

/**
 * A Channel's group key: `secret` is the community_root (Public, at the root
 * epoch) or the Channel's own key (Private, at its channel epoch) — CORD-03 §1.
 */
export function channelGroupKey(secret: Uint8Array, channelId: Uint8Array, epoch: number | bigint): GroupKey {
  assert32("secret", secret);
  assert32("channelId", channelId);
  return groupKeyCached(LABEL_CHANNEL, secret, channelId, toEpoch(epoch));
}

/**
 * The Control Plane's community_root-keyed group key (CORD-02 §5). Post-split it's
 * the READ key; on a LEGACY epoch it was the whole plane (address and signer too).
 * The schemes never collide (different labels).
 */
export function controlGroupKey(communityRoot: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey {
  assert32("communityRoot", communityRoot);
  assert32("communityId", communityId);
  return groupKeyCached(LABEL_CONTROL, communityRoot, communityId, toEpoch(epoch));
}

/**
 * The Control Plane's control_root-keyed SIGNER (CORD-02 §2/§5): `pk` is the
 * plane's address, the staff-only `sk` signs wraps. Content is encrypted under
 * {@link controlGroupKey}'s conv_key, not this one's.
 */
export function controlSignerGroupKey(controlRoot: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey {
  assert32("controlRoot", controlRoot);
  assert32("communityId", communityId);
  return groupKeyCached(LABEL_CONTROL_SIGNER, controlRoot, communityId, toEpoch(epoch));
}

/** The Guestbook Plane's group key (community_root-keyed). */
export function guestbookGroupKey(communityRoot: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey {
  assert32("communityRoot", communityRoot);
  assert32("communityId", communityId);
  return groupKeyCached(LABEL_GUESTBOOK, communityRoot, communityId, toEpoch(epoch));
}

/**
 * A voice Channel's SFU room keypair (CORD-07 §1): pk IS the room name, sk signs
 * token grants (§2). Same `secret`/`epoch` as the Channel's Chat Plane, so the
 * room rolls with the key. The pk is never a stream address.
 */
export function voiceGroupKey(secret: Uint8Array, channelId: Uint8Array, epoch: number | bigint): GroupKey {
  assert32("secret", secret);
  assert32("channelId", channelId);
  return groupKeyCached(LABEL_VOICE_SIGNER, secret, channelId, toEpoch(epoch));
}

/** A voice Channel's 32-byte media root (CORD-07 §1); only feeds {@link voiceSenderKey}. */
export function voiceMediaKey(secret: Uint8Array, channelId: Uint8Array, epoch: number | bigint): Uint8Array {
  assert32("secret", secret);
  assert32("channelId", channelId);
  return hkdf32(secret, buildInfo(LABEL_VOICE_MEDIA, channelId, toEpoch(epoch)));
}

/**
 * Per-sender frame key material (CORD-07 §3):
 * `hkdf(voice_media_key, "concord/voice-sender", sha256(utf8(identity)))`, epoch
 * omitted. Per-sender keys partition AEAD nonce domains; no in-band exchange.
 */
export function voiceSenderKey(mediaKey: Uint8Array, identity: string): Uint8Array {
  assert32("mediaKey", mediaKey);
  return hkdf32(mediaKey, buildInfo(LABEL_VOICE_SENDER, sha256(ASCII.encode(identity))));
}

/** The dissolution tombstone's group key — community_id-keyed, epoch-free (§9). */
export function dissolvedGroupKey(communityId: Uint8Array): GroupKey {
  assert32("communityId", communityId);
  return groupKeyCached(LABEL_DISSOLVED, communityId, ZERO32);
}

/** A private Channel's rekey address for `new_epoch`, keyed by the prior community_root. */
export function channelRekeyGroupKey(
  priorRoot: Uint8Array,
  channelId: Uint8Array,
  newEpoch: number | bigint,
): GroupKey {
  assert32("priorRoot", priorRoot);
  assert32("channelId", channelId);
  return groupKeyCached(LABEL_REKEY_PSEUDONYM, priorRoot, channelId, toEpoch(newEpoch));
}

/** The base-rotation rekey address for `new_epoch`, keyed by the prior community_root. */
export function baseRekeyGroupKey(
  priorRoot: Uint8Array,
  communityId: Uint8Array,
  newEpoch: number | bigint,
): GroupKey {
  assert32("priorRoot", priorRoot);
  assert32("communityId", communityId);
  return groupKeyCached(LABEL_BASE_REKEY_PSEUDONYM, priorRoot, communityId, toEpoch(newEpoch));
}

/** A member's Grant entity coordinate (the edition `eid`). */
export function grantLocator(communityId: Uint8Array, memberXonly: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("memberXonly", memberXonly);
  return hkdf32(communityId, buildInfo(LABEL_GRANT, memberXonly));
}

/** A Channel's Pin List coordinate (CORD-04 §7). */
export function pinsLocator(communityId: Uint8Array, channelId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("channelId", channelId);
  return hkdf32(communityId, buildInfo(LABEL_PINS, channelId));
}

/** The community-wide Banlist coordinate. */
export function banlistLocator(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, buildInfo(LABEL_BANLIST, ZERO32));
}

/** The `@everyone` Role's coordinate (CORD-04 §2); an owner edition here moves a Community to vsk 13. */
export function everyoneLocator(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, buildInfo(LABEL_EVERYONE, ZERO32));
}

/** What a marked edition names in `eb` to bind itself to its Community (CORD-04 §1). */
export function editionBinding(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, buildInfo(LABEL_EDITION_BINDING, ZERO32));
}

function sha256Concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return sha256(out);
}

/** A member's Tenure from one sealer (CORD-04 §9): id `SHA-256(member ‖ sealer)`. */
export function tenureLocator(communityId: Uint8Array, memberXonly: Uint8Array, sealerXonly: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("memberXonly", memberXonly);
  assert32("sealerXonly", sealerXonly);
  return hkdf32(communityId, buildInfo(LABEL_TENURE, sha256Concat(memberXonly, sealerXonly)));
}

/** An overwrite target's kind: what its coordinate hashes with its id (CORD-04 §8). */
export type OverwriteTargetKind = "everyone" | "role" | "member";

/**
 * The 32 bytes a target contributes to its overwrite's coordinate,
 * `SHA-256(utf8(kind) ‖ target)`, `target` being the `@everyone` coordinate for
 * `everyone`, so a Role and a member sharing 32 bytes never share an overwrite.
 */
export function overwriteTargetBytes(communityId: Uint8Array, kind: OverwriteTargetKind, id?: Uint8Array): Uint8Array {
  const target = kind === "everyone" ? everyoneLocator(communityId) : id;
  if (!target) throw new Error(`overwrite target ${kind} needs an id`);
  assert32("target", target);
  return sha256Concat(ASCII.encode(kind), target);
}

/** One overwrite's coordinate (CORD-04 §8): id `SHA-256(scope ‖ targetBytes)`. */
export function aclLocator(communityId: Uint8Array, scope: Uint8Array, targetBytes: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("scope", scope);
  assert32("targetBytes", targetBytes);
  return hkdf32(communityId, buildInfo(LABEL_ACL, sha256Concat(scope, targetBytes)));
}

/** A Channel's sync coordinate (CORD-04 §8). */
export function syncLocator(communityId: Uint8Array, channelId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("channelId", channelId);
  return hkdf32(communityId, buildInfo(LABEL_SYNC, channelId));
}

/** A restricted Channel's Writers ledger coordinate (CORD-03 §1). */
export function writersLocator(communityId: Uint8Array, channelId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("channelId", channelId);
  return hkdf32(communityId, buildInfo(LABEL_WRITERS, channelId));
}

/** A restricted Channel's writer scope, `sha256("concord/writer-scope" ‖ channel_id)` (A.7). */
export function writerScope(channelId: Uint8Array): Uint8Array {
  assert32("channelId", channelId);
  return sha256Concat(ASCII.encode(LABEL_WRITER_SCOPE), channelId);
}

/** A restricted Channel's certifier scope (A.7). */
export function certifierScope(channelId: Uint8Array): Uint8Array {
  assert32("channelId", channelId);
  return sha256Concat(ASCII.encode(LABEL_CERTIFIER_SCOPE), channelId);
}

/** A Channel's read-only history scope (A.7, CORD-03 §5). */
export function historyScope(channelId: Uint8Array): Uint8Array {
  assert32("channelId", channelId);
  return sha256Concat(ASCII.encode(LABEL_HISTORY_SCOPE), channelId);
}

/** A restricted Channel's writer address and wrap signer for a writer epoch (CORD-03 §1). */
export function channelWriterGroupKey(writerSecret: Uint8Array, channelId: Uint8Array, writerEpoch: number | bigint): GroupKey {
  assert32("writerSecret", writerSecret);
  assert32("channelId", channelId);
  return groupKeyCached(LABEL_CHANNEL_WRITER, writerSecret, channelId, toEpoch(writerEpoch));
}

/** A Channel's access plane for a root epoch, where keys are delivered (CORD-03 §5). */
export function channelAccessGroupKey(communityRoot: Uint8Array, channelId: Uint8Array, rootEpoch: number | bigint): GroupKey {
  assert32("communityRoot", communityRoot);
  assert32("channelId", channelId);
  return groupKeyCached(LABEL_CHANNEL_ACCESS, communityRoot, channelId, toEpoch(rootEpoch));
}

/**
 * The `p` key of an author's own wrap at `address` (CORD-01 §Deletions):
 * `group_key(author_secret, "concord/wrap-owner", SHA-256(address ‖ rumor_id))`,
 * so any of the author's clients can delete it, and nobody else can tie it to them.
 * Not memoized: the secret is an account key.
 */
export function wrapOwnerKey(authorSecret: Uint8Array, addressHex: string, rumorId: Uint8Array): { sk: Uint8Array; pk: string } {
  assert32("authorSecret", authorSecret);
  assert32("rumorId", rumorId);
  const sk = hkdfToSecretKey(authorSecret, buildInfo(LABEL_WRAP_OWNER, sha256Concat(hex32(addressHex), rumorId)));
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) };
}

/** A creator's invite-link Registry coordinate (CORD-05 §5). */
export function inviteLinksLocator(communityId: Uint8Array, creatorXonly: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("creatorXonly", creatorXonly);
  return hkdf32(communityId, buildInfo(LABEL_INVITE_LINKS, creatorXonly));
}

/**
 * A Community Signal's coordinate (CORD-04 §8): the id slot is
 * `sha256(utf8(signal_id))` (as the voice-sender key does, A.6). Keyless and
 * epoch-free, so it survives Refoundings.
 */
export function signalLocator(communityId: Uint8Array, signalId: string): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, buildInfo(LABEL_SIGNAL, sha256(ASCII.encode(signalId))));
}

/**
 * A rekey blob's per-recipient locator (CORD-06 §2):
 * `hkdf(rotator_xonly || recipient_xonly, "concord/recipient-pseudonym", scope_id, epoch)`.
 * From PUBLIC inputs so bunker accounts can find their blob.
 */
export function recipientLocator(
  rotatorXonly: Uint8Array,
  recipientXonly: Uint8Array,
  scopeId: Uint8Array,
  newEpoch: number | bigint,
): Uint8Array {
  assert32("rotatorXonly", rotatorXonly);
  assert32("recipientXonly", recipientXonly);
  const ikm = new Uint8Array(64);
  ikm.set(rotatorXonly, 0);
  ikm.set(recipientXonly, 32);
  return hkdf32(ikm, buildInfo(LABEL_RECIPIENT_PSEUDONYM, scopeId, toEpoch(newEpoch)));
}

/** The public-invite bundle decrypt key, derived from the link's unlock token. */
export function inviteBundleKey(token: Uint8Array): Uint8Array {
  return hkdf32(token, buildInfo(LABEL_INVITE_KEY, ZERO32));
}

/**
 * The self-certifying community identity:
 * `sha256("concord/community" || owner_xonly || owner_salt)`.
 */
export function communityIdOf(ownerXonly: Uint8Array, ownerSalt: Uint8Array): Uint8Array {
  assert32("ownerXonly", ownerXonly);
  assert32("ownerSalt", ownerSalt);
  const label = ASCII.encode(LABEL_COMMUNITY);
  const pre = new Uint8Array(label.length + 64);
  pre.set(label, 0);
  pre.set(ownerXonly, label.length);
  pre.set(ownerSalt, label.length + 32);
  return sha256(pre);
}

/** Verify a claimed (owner, salt) pair reproduces `communityId`. */
export function verifyCommunityId(communityIdHex: string, ownerHex: string, ownerSaltHex: string): boolean {
  try {
    return bytesToHex(communityIdOf(hex32(ownerHex), hex32(ownerSaltHex))) === communityIdHex.toLowerCase();
  } catch {
    return false;
  }
}

/** `sha256("concord/epoch-key-commitment" || prev_epoch_be || prev_key)` (CORD-06). */
export function epochKeyCommitment(prevEpoch: number | bigint, prevKey: Uint8Array): Uint8Array {
  assert32("prevKey", prevKey);
  const label = ASCII.encode(LABEL_EPOCH_COMMITMENT);
  const pre = new Uint8Array(label.length + 8 + 32);
  pre.set(label, 0);
  pre.set(u64be(toEpoch(prevEpoch)), label.length);
  pre.set(prevKey, label.length + 8);
  return sha256(pre);
}
