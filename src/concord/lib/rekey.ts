/**
 * Concord Rekeys & Refoundings — CORD-06.
 *
 * A rotation mints a fresh key at the next epoch and delivers per-recipient
 * blobs (kind 3303, ≤80 per event or 60 for a base rotation, chunked) at an address derived from the
 * PRIOR secret; a removed member finding no blob across ALL chunks knows they're out.
 *
 * Blob plaintext is fixed-width per form (CORD-06 §1), NIP-44 under the
 * Rotator↔recipient pairwise key:
 *   - channel rotation: 72 = `scope_id[32] ‖ epoch_be[8] ‖ new_key[32]`;
 *   - base rotation member: 104, + `new_control_pk[32]` (CORD-02 §2);
 *   - staff: 136, + `new_control_root[32]`;
 *   - 72-byte BASE blob: legacy pre-split, read-only (CORD-06 §3).
 * Other widths are dropped. Signer nip44 APIs take strings, so bytes travel as
 * base64 inside the plaintext (unpinned by the spec — flagged as feedback).
 */

import { hadRepeatedKeys, parseStrictValue } from "@/concord/lib/strictJson";
import { uniqueTag } from "@/concord/lib/strictJson";
import { bytesToHex, channelRekeyGroupKey, controlSignerGroupKey, epochKeyCommitment, random32, recipientLocator } from "@/concord/lib/derive";
import { KIND_REKEY, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { citationFromTags, citationToTag, isTagDecimal, type AuthorityCitation } from "@/concord/lib/edition";
import { buildRumor, type OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { readFolded, writeFolded } from "@/lib/foldedCache";

/** Per-recipient blobs per Channel rekey event (CORD-06 §1). */
export const REKEY_BLOBS_PER_EVENT = 80;

/** Per-recipient blobs per base rekey event, whose blobs are wider (CORD-06 §1). */
export const REKEY_BASE_BLOBS_PER_EVENT = 60;

/**
 * Byte ceiling on one rekey rumor's JSON, alongside the count caps. 28,672 is
 * the top of the NIP-44 padding bucket whose seal and wrap still serialize
 * under the 64 KB relay event limit (CORD-02 Appendix B), about 55 KB, so the
 * count caps bind for every real blob width. Finer chunking is always
 * wire-legal (see {@link parseRekey}).
 */
export const REKEY_RUMOR_MAX_BYTES = 28_672;

/**
 * How many channel epochs past the held one to watch. Watching only `held + 1`
 * strands anyone who missed a rotation (offline, auth-gated, stale key), who'd
 * never learn they were removed.
 */
export const CHANNEL_REKEY_LOOKAHEAD = 8;

const ZERO32 = new Uint8Array(32);
const ZERO32_HEX = "0".repeat(64);

/** A rotation's scope: one Private Channel, or the community_root (a Refounding). */
export type RekeyScope = { kind: "channel"; channelId: Uint8Array } | { kind: "root" };

/** The 32-byte scope id: the channel id, or all-zeroes for the root (never collides). */
export function rekeyScopeId(scope: RekeyScope): Uint8Array {
  return scope.kind === "channel" ? scope.channelId : ZERO32;
}

// The wrapped plaintext (fixed-width per form, CORD-06 §1)
/** `scope_id[32] ‖ epoch_be[8] ‖ new_key[32]` — scope and epoch live INSIDE the ciphertext. */
export function encodeWrappedKey(scopeId: Uint8Array, newEpoch: bigint, newKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(72);
  out.set(scopeId, 0);
  new DataView(out.buffer).setBigUint64(32, newEpoch, false);
  out.set(newKey, 40);
  return out;
}

/**
 * A BASE rotation's blob: the 72-byte layout plus the next epoch's
 * `new_control_pk[32]` (104 bytes, every member), a staff recipient's
 * additionally `new_control_root[32]` (136 bytes) — CORD-06 §1.
 */
export function encodeWrappedBaseKey(
  newEpoch: bigint,
  newRoot: Uint8Array,
  newControlPk: Uint8Array,
  newControlRoot?: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(newControlRoot ? 136 : 104);
  out.set(encodeWrappedKey(ZERO32, newEpoch, newRoot), 0);
  out.set(newControlPk, 72);
  if (newControlRoot) out.set(newControlRoot, 104);
  return out;
}

/**
 * Parse + verify a decrypted 72-byte CHANNEL blob against the event's tags: a
 * recipient accepts the key only when the INNER scope and epoch match, which
 * is what makes a blob unspliceable across channels/epochs (CORD-06 §1).
 */
export function decodeWrappedKey(
  plain: Uint8Array,
  expectedScopeId: Uint8Array,
  expectedEpoch: bigint,
): Uint8Array {
  if (plain.length !== 72) throw new Error(`wrapped key must be 72 bytes, got ${plain.length}`);
  const scopeId = plain.slice(0, 32);
  const epoch = new DataView(plain.buffer, plain.byteOffset).getBigUint64(32, false);
  if (bytesToHex(scopeId) !== bytesToHex(expectedScopeId)) throw new Error("wrapped key scope mismatch");
  if (epoch !== expectedEpoch) throw new Error("wrapped key epoch mismatch");
  return plain.slice(40, 72);
}

/** A parsed base-rotation blob (CORD-06 §1); the width declared the form. */
export interface WrappedBaseKey {
  newRoot: Uint8Array;
  /** Next epoch's Control Plane address (hex); absent on a legacy 72-byte blob (CORD-06 §3). */
  controlPk?: string;
  /** The staff write secret (136-byte form only), already verified to derive to `controlPk`. */
  controlRoot?: Uint8Array;
}

/**
 * Parse + verify a decrypted BASE blob (CORD-06 §1): widths 72 (legacy), 104
 * (member), 136 (staff). Scope must be all-zero and epoch match the tags; a
 * 136-byte blob's `new_control_root` must derive to its `new_control_pk`
 * (CORD-02 §5) or it's refused whole.
 */
export function decodeWrappedBaseKey(
  plain: Uint8Array,
  communityId: Uint8Array,
  expectedEpoch: bigint,
): WrappedBaseKey {
  if (plain.length !== 72 && plain.length !== 104 && plain.length !== 136) {
    throw new Error(`wrapped base key must be 72, 104 or 136 bytes, got ${plain.length}`);
  }
  const scopeId = plain.slice(0, 32);
  const epoch = new DataView(plain.buffer, plain.byteOffset).getBigUint64(32, false);
  if (bytesToHex(scopeId) !== ZERO32_HEX) throw new Error("wrapped key scope mismatch");
  if (epoch !== expectedEpoch) throw new Error("wrapped key epoch mismatch");
  const newRoot = plain.slice(40, 72);
  if (plain.length === 72) return { newRoot };
  const controlPk = bytesToHex(plain.slice(72, 104));
  if (plain.length === 104) return { newRoot, controlPk };
  const controlRoot = plain.slice(104, 136);
  if (controlSignerGroupKey(controlRoot, communityId, expectedEpoch).pk !== controlPk) {
    throw new Error("wrapped control_root does not derive to its control_pk");
  }
  return { newRoot, controlPk, controlRoot };
}

/** base64 helpers for carrying the 72 bytes through string-only nip44 signers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The 3303 rumor
/** One located, wrapped key. */
export interface RekeyBlob {
  /** Where its recipient finds it (hex of {@link recipientLocator}). */
  locator: string;
  /** NIP-44 ciphertext under the Rotator↔recipient pairwise key. */
  wrapped: string;
}

export interface RekeyRotation {
  scope: RekeyScope;
  newEpoch: bigint;
  prevEpoch: bigint;
  /** The epoch-key commitment over the key being replaced (continuity check). */
  prevCommit: string;
}

/** Build the chunked 3303 rumors for one rotation. */
export function buildRekeyRumors(
  rotatorPubkey: string,
  rotation: RekeyRotation,
  blobs: RekeyBlob[],
  ms: number,
  /**
   * The Grant the rotator acts under (CORD-04 §5). On EVERY chunk so a partial
   * holder can judge authority. Absent when the owner rotates.
   */
  authority?: AuthorityCitation,
): NostrRumor[] {
  const scopeHex = bytesToHex(rekeyScopeId(rotation.scope));
  const tagsFor = (i: string, n: string) => [
    ["scope", scopeHex],
    ["newepoch", rotation.newEpoch.toString()],
    ["prevepoch", rotation.prevEpoch.toString()],
    ["prevcommit", rotation.prevCommit],
    ["chunk", i, n],
    ...(authority ? [citationToTag(authority)] : []),
  ];

  // Chunk budget vs. the rumor envelope, measured once at the widest possible
  // ["chunk", i, n] (over-reserving only makes chunks smaller).
  const widest = Math.max(1, blobs.length).toString();
  const envelope = utf8Len(JSON.stringify(
    buildRumor({ kind: KIND_REKEY, content: "", tags: tagsFor(widest, widest), pubkey: rotatorPubkey, ms }),
  ));
  const budget = REKEY_RUMOR_MAX_BYTES - envelope;
  const perEvent = rotation.scope.kind === "root" ? REKEY_BASE_BLOBS_PER_EVENT : REKEY_BLOBS_PER_EVENT;

  const chunks: RekeyBlob[][] = [];
  let current: RekeyBlob[] = [];
  let used = 2; // the content's own "[]"
  for (const blob of blobs) {
    const cost = escapedJsonLen(blob);
    // `+ 1` for the comma. A lone over-budget blob is kept (blobs are indivisible).
    if (current.length > 0 && (current.length >= perEvent || used + 1 + cost > budget)) {
      chunks.push(current);
      current = [];
      used = 2;
    }
    used += cost + (current.length > 0 ? 1 : 0);
    current.push(blob);
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);

  const n = chunks.length;
  return chunks.map((chunk, i) =>
    buildRumor({
      kind: KIND_REKEY,
      content: JSON.stringify(chunk),
      tags: tagsFor((i + 1).toString(), n.toString()),
      pubkey: rotatorPubkey,
      ms,
    }),
  );
}

const UTF8 = new TextEncoder();

function utf8Len(s: string): number {
  return UTF8.encode(s).length;
}

/** A blob's length inside the rumor's JSON-escaped `content` string (sans outer quotes). */
function escapedJsonLen(blob: RekeyBlob): number {
  return utf8Len(JSON.stringify(JSON.stringify(blob))) - 2;
}

export interface ParsedRekey {
  /** The rotator's real pubkey (the seal's signer). */
  rotator: string;
  scopeIdHex: string;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevCommit: string;
  chunkIndex: number;
  chunkCount: number;
  blobs: RekeyBlob[];
  /** ms of the rumor (ordering / correlation aid). */
  ms: number;
  /** A Severing Refounding's mark (CORD-06 §3), base scope only. */
  severed: boolean;
  /** The CORD-04 §5 citation the rotator acts under (absent when the owner acts). */
  authority?: AuthorityCitation;
}

/** The most blobs a reader takes in one 3303 (CORD-06 §1): above the send caps, so a spec-limit chunk still parses. */
export const MAX_REKEY_BLOBS_RECEIVED = 120;

export { uniqueTag };

/** A 3303's blob array, read as serde reads `Vec<RekeyBlob>`, or undefined. */
export function parseRekeyBlobs(content: string): RekeyBlob[] | undefined {
  // As serde reads a `Vec<RekeyBlob>`: a lone surrogate, or a field given twice, refuses it.
  const parsed = parseStrictValue(content);
  if (!Array.isArray(parsed) || parsed.length > MAX_REKEY_BLOBS_RECEIVED) return undefined;
  const ok = parsed.every((b) => b && typeof b === "object" && !Array.isArray(b) && !hadRepeatedKeys(b) && typeof b.locator === "string" && typeof b.wrapped === "string");
  return ok ? (parsed as RekeyBlob[]).map((b) => ({ locator: b.locator, wrapped: b.wrapped })) : undefined;
}

/** Parse an opened rekey stream event into its rotation fields (Vector's `parse_rekey_chunk`). */
export function parseRekey(opened: OpenedEvent): ParsedRekey {
  if (opened.kind !== KIND_REKEY) throw new Error("not a rekey rumor");
  // Checked while the seal form is known; stored rumors passed this at ingest (see parseEdition).
  if (opened.sealKind !== undefined && opened.sealKind !== KIND_SEAL_ENCRYPTED) {
    throw new Error("rekey seals must be encrypted (CORD-02 §5)");
  }
  const scope = uniqueTag(opened.tags, "scope");
  const newEpoch = uniqueTag(opened.tags, "newepoch");
  const prevEpoch = uniqueTag(opened.tags, "prevepoch");
  const prevCommit = uniqueTag(opened.tags, "prevcommit");
  const sever = uniqueTag(opened.tags, "sever");
  const chunks = opened.tags.filter((t) => t.length >= 3 && t[0] === "chunk");
  if (!scope || !/^[0-9a-f]{64}$/i.test(scope)) throw new Error("bad scope tag");
  if (!isTagDecimal(newEpoch ?? undefined)) throw new Error("bad newepoch tag");
  if (!isTagDecimal(prevEpoch ?? undefined)) throw new Error("bad prevepoch tag");
  if (BigInt(newEpoch!) <= BigInt(prevEpoch!)) throw new Error("newepoch must exceed prevepoch");
  if (!prevCommit || !/^[0-9a-f]{64}$/i.test(prevCommit)) throw new Error("bad prevcommit tag");
  // Strict decimals, not `Number()` ("1e2", "0x2", " 2 " would be accepted).
  if (chunks.length !== 1 || !isTagDecimal(chunks[0][1]) || !isTagDecimal(chunks[0][2])) throw new Error("bad chunk tag");
  const chunkIndex = Number(chunks[0][1]);
  const chunkCount = Number(chunks[0][2]);
  if (chunkIndex < 1 || chunkCount < 1 || chunkIndex > chunkCount || chunkCount > 0xffffffff) {
    throw new Error("bad chunk tag");
  }
  // CORD-06 §3: present means exactly "1"; any other value, or twice, is malformed.
  if (sever === null || (sever !== undefined && sever !== "1")) throw new Error("bad sever tag");
  const blobs = parseRekeyBlobs(opened.content);
  if (!blobs) throw new Error("bad rekey content");
  return {
    rotator: opened.author,
    scopeIdHex: scope.toLowerCase(),
    newEpoch: BigInt(newEpoch!),
    prevEpoch: BigInt(prevEpoch!),
    prevCommit: prevCommit.toLowerCase(),
    chunkIndex,
    chunkCount,
    blobs,
    ms: opened.ms,
    severed: sever === "1",
    authority: citationFromTags(opened.tags),
  };
}

export interface RekeyRotationSet {
  rotator: string;
  scopeIdHex: string;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevCommit: string;
  /** The largest `n` any chunk declares: an extension raises it (CORD-06 §1). */
  chunkCount: number;
  /** chunkIndex → every chunk claiming it; their blobs union. */
  chunks: Map<number, ParsedRekey[]>;
  complete: boolean;
  /** Any chunk marked it a Severing Refounding (CORD-06 §3), so an unmarked chunk can't launder the mark away. */
  severed: boolean;
  /**
   * Authority citation from the first chunk. All chunks must carry identical
   * authority (CORD-06 §2); a disagreeing chunk means distrust the set.
   */
  authority?: AuthorityCitation;
}

export function groupRotations(parsed: ParsedRekey[]): RekeyRotationSet[] {
  const byKey = new Map<string, RekeyRotationSet>();
  for (const p of parsed) {
    const key = `${p.rotator}:${p.scopeIdHex}:${p.newEpoch}:${p.prevCommit}`;
    let set = byKey.get(key);
    if (!set) {
      byKey.set(
        key,
        (set = {
          rotator: p.rotator,
          scopeIdHex: p.scopeIdHex,
          newEpoch: p.newEpoch,
          prevEpoch: p.prevEpoch,
          prevCommit: p.prevCommit,
          chunkCount: p.chunkCount,
          chunks: new Map(),
          complete: false,
          severed: false,
          authority: p.authority,
        }),
      );
    }
    // Extensions declare a larger total; a second chunk at a held index unions its
    // blobs, since dropping one would read its recipients as removed (Vector `collect_rotations`).
    set.chunkCount = Math.max(set.chunkCount, p.chunkCount);
    const at = set.chunks.get(p.chunkIndex);
    if (at) at.push(p);
    else set.chunks.set(p.chunkIndex, [p]);
    if (p.severed && p.scopeIdHex === ZERO32_HEX) set.severed = true;
  }
  for (const set of byKey.values()) {
    let complete = set.chunkCount >= 1;
    for (let i = 1; i <= set.chunkCount && complete; i++) complete = set.chunks.has(i);
    set.complete = complete;
  }
  return [...byKey.values()];
}

/**
 * Verify a rotation's CONTINUITY against the key we currently hold: the
 * commitment over (prevEpoch, heldKey) must equal the event's `prevcommit`.
 * A mismatch with a HIGHER prevepoch means we missed a rotation (fetch the gap
 * first); any other mismatch is a fork or garbage — reject (CORD-06 §2).
 */
export function checkContinuity(set: { prevEpoch: bigint; prevCommit: string }, heldEpoch: bigint, heldKey: Uint8Array):
  | { ok: true }
  | { ok: false; reason: "gap" | "fork" } {
  if (set.prevEpoch === heldEpoch) {
    const commit = bytesToHex(epochKeyCommitment(heldEpoch, heldKey));
    return commit === set.prevCommit ? { ok: true } : { ok: false, reason: "fork" };
  }
  return { ok: false, reason: set.prevEpoch > heldEpoch ? "gap" : "fork" };
}

/** Find my blob across a complete rotation's chunks by my locator. */
export function findBlob(set: RekeyRotationSet, locatorHex: string): RekeyBlob | undefined {
  for (const list of set.chunks.values()) {
    for (const chunk of list) {
      const hit = chunk.blobs.find((b) => b.locator === locatorHex);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * When this rotation was sent: its earliest chunk's time (Vector's `at_ms`), so a
 * later extension can't date it past a member's join. A rotation predating a
 * member's join isn't an exclusion.
 */
export function rotationPublishedAtMs(set: RekeyRotationSet): number {
  let earliest = Infinity;
  for (const list of set.chunks.values()) for (const chunk of list) if (chunk.ms < earliest) earliest = chunk.ms;
  return Number.isFinite(earliest) ? earliest : 0;
}

/**
 * Whether a complete rotation with no blob for me actually EXCLUDES me. A member
 * joining via a stale invite lands on historical Refoundings they were never
 * part of; only one published at/after `joinedAtMs` (List `added_at`) excludes.
 * Skew errs toward keeping the rail icon, which is safe: rotation enforces secrecy.
 */
export function rotationExcludesMe(rotatedAtMs: number, joinedAtMs: number): boolean {
  return rotatedAtMs >= joinedAtMs;
}


/**
 * Race convergence (CORD-06 §3): among authorized candidates at one continuity
 * point, the lowest NEW KEY wins. The heal is DOWN-ONLY.
 */
export function lowerKeyWins(a: Uint8Array, b: Uint8Array): Uint8Array {
  return bytesToHex(a) <= bytesToHex(b) ? a : b;
}

export function mintRotationKey(): Uint8Array {
  return random32();
}

/**
 * Mint a rotation key ONCE per `(rotator, scope, newEpoch, prevCommit)` and
 * return it on every retry. {@link groupRotations} keys on those four, so a
 * retry with a fresh key would merge into the first attempt's set and split
 * members across two keys at one epoch. Falls back to a fresh key if the
 * reservation can't persist. DEVICE-LOCAL: two devices of one rotator can
 * still collide (bunkers can't provide a deterministic secret).
 */
export async function mintOrReuseRotationKey(
  communityIdHex: string,
  scope: RekeyScope,
  newEpoch: bigint,
  prevCommit: string,
): Promise<Uint8Array> {
  const key = `rekey-mint:${communityIdHex}:${bytesToHex(rekeyScopeId(scope))}:${newEpoch}:${prevCommit}`;
  const held = await readFolded<Uint8Array>(key);
  if (held instanceof Uint8Array && held.length === 32) return held;
  const minted = mintRotationKey();
  await writeFolded(key, minted);
  return minted;
}

/**
 * The `control_root` minted beside a base rotation's new root (CORD-06 §3),
 * reserved like {@link mintOrReuseRotationKey} for the same reason.
 */
export async function mintOrReuseControlRoot(
  communityIdHex: string,
  newEpoch: bigint,
  prevCommit: string,
): Promise<Uint8Array> {
  const key = `rekey-mint:${communityIdHex}:${ZERO32_HEX}:${newEpoch}:${prevCommit}:control`;
  const held = await readFolded<Uint8Array>(key);
  if (held instanceof Uint8Array && held.length === 32) return held;
  const minted = mintRotationKey();
  await writeFolded(key, minted);
  return minted;
}

// The Grant's control_wrap plaintext (CORD-04 §3)
/**
 * `epoch_be[8] ‖ control_root[32]` — the staff write key inside a staff-making
 * Grant, NIP-44 under the granter↔member pairwise key.
 */
export function encodeControlWrap(epoch: bigint, controlRoot: Uint8Array): Uint8Array {
  const out = new Uint8Array(40);
  new DataView(out.buffer).setBigUint64(0, epoch, false);
  out.set(controlRoot, 8);
  return out;
}

/** Parse a decrypted 40-byte control_wrap; the caller verifies the derivation. */
export function decodeControlWrap(plain: Uint8Array): { epoch: bigint; controlRoot: Uint8Array } {
  if (plain.length !== 40) throw new Error(`control_wrap must be 40 bytes, got ${plain.length}`);
  return {
    epoch: new DataView(plain.buffer, plain.byteOffset).getBigUint64(0, false),
    controlRoot: plain.slice(8, 40),
  };
}

/** Compute my locator for a rotation (public inputs only — bunker-friendly). */
export function myLocator(rotatorHex: string, myHex: string, scopeIdHex: string, newEpoch: bigint): string {
  const hexToBytes32 = (h: string) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  return bytesToHex(
    recipientLocator(hexToBytes32(rotatorHex), hexToBytes32(myHex), hexToBytes32(scopeIdHex), newEpoch),
  );
}

export { ZERO32_HEX as ROOT_SCOPE_HEX };

/**
 * Every rekey address a channel could have used, epochs 1..`maxEpoch`, under each
 * held root. Needs no channel key (CORD-06 §2: root + channel_id), so anyone
 * privatising a channel can check CORD-03 §2's monotonic epoch counter.
 * Returns address pubkey → epoch.
 */
export function channelRekeyAddressWindow(
  roots: ReadonlyArray<{ key: Uint8Array }>,
  channelId: Uint8Array,
  maxEpoch: number,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const root of roots) {
    for (let e = 1; e <= maxEpoch; e++) {
      out.set(channelRekeyGroupKey(root.key, channelId, BigInt(e)).pk, BigInt(e));
    }
  }
  return out;
}

/**
 * The highest channel epoch any observed rotation address accounts for — the
 * floor a privatisation must climb past (0n when the channel has never been
 * private, so the first privatisation is epoch 1, CORD-03 §2).
 */
export function highestRotatedEpoch(
  window: ReadonlyMap<string, bigint>,
  seenAuthors: Iterable<string>,
): bigint {
  let highest = 0n;
  for (const pk of seenAuthors) {
    const epoch = window.get(pk);
    if (epoch !== undefined && epoch > highest) highest = epoch;
  }
  return highest;
}

/**
 * {@link highestRotatedEpoch}, but throws on an INCONCLUSIVE read: a rotation at
 * `maxEpoch` may have more above it, and minting a reused epoch (CORD-03 §2) is
 * silent and unrecoverable.
 */
export function channelEpochFloor(
  window: ReadonlyMap<string, bigint>,
  seenAuthors: Iterable<string>,
  maxEpoch: number,
): bigint {
  const highest = highestRotatedEpoch(window, seenAuthors);
  if (highest >= BigInt(maxEpoch)) {
    throw new Error(
      `This channel has rotated at least ${maxEpoch} times; this client can't establish its next epoch safely.`,
    );
  }
  return highest;
}
