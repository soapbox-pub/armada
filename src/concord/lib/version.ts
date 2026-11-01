/**
 * Per-entity version chains for Control Plane editions — CORD-04 §1. Folding
 * picks the head: refuse-downgrade, lower rumor id breaks equal-version ties,
 * contiguous chain-walk failing closed on gaps — except after a Refounding,
 * where a fresh joiner accepts the highest verified head ({@link bootstrapHead}).
 */

import { sha256 } from "@noble/hashes/sha2.js";

/** Edition-hash domain label — CORD-04 §1, frozen ("v1" is spec; renaming re-hashes every chain). */
const EDITION_LABEL = "vector-community/v1/edition";

function u64be(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, false);
  return out;
}

/**
 * The length-prefixed, domain-separated preimage an edition's identity commits
 * to (CORD-04 §1, frozen):
 * `len64(label) ‖ label ‖ entity_id[32] ‖ version_be[8] ‖ has_prev(1) ‖
 *  prev_hash[32 or zero] ‖ len64(content) ‖ content`.
 * `content` is hashed as the exact bytes on the wire, never re-serialized.
 */
export function editionPreimage(
  entityId: Uint8Array,
  version: bigint,
  prevHash: Uint8Array | undefined,
  content: Uint8Array,
): Uint8Array {
  const labelBytes = new TextEncoder().encode(EDITION_LABEL);
  const parts: Uint8Array[] = [
    u64be(BigInt(labelBytes.length)),
    labelBytes,
    entityId,
    u64be(version),
    new Uint8Array([prevHash ? 1 : 0]),
    prevHash ?? new Uint8Array(32),
    u64be(BigInt(content.length)),
    content,
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SHA-256 of {@link editionPreimage} — what the next edition's `ep` cites. */
export function editionHash(
  entityId: Uint8Array,
  version: bigint,
  prevHash: Uint8Array | undefined,
  content: Uint8Array,
): Uint8Array {
  return sha256(editionPreimage(entityId, version, prevHash, content));
}

const EDITION_SIGNER_LABEL = new TextEncoder().encode("concord/edition-signer");

/**
 * A MARKED edition's hash (CORD-04 §1): `SHA-256(signing_bytes ‖
 * utf8("concord/edition-signer") ‖ signer[32])`, the label raw, so a copy
 * re-signed under another key is another edition.
 */
export function markedEditionHash(
  entityId: Uint8Array,
  version: bigint,
  prevHash: Uint8Array | undefined,
  content: Uint8Array,
  signer: Uint8Array,
): Uint8Array {
  const pre = editionPreimage(entityId, version, prevHash, content);
  const out = new Uint8Array(pre.length + EDITION_SIGNER_LABEL.length + 32);
  out.set(pre, 0);
  out.set(EDITION_SIGNER_LABEL, pre.length);
  out.set(signer, pre.length + EDITION_SIGNER_LABEL.length);
  return sha256(out);
}

/** One fetched edition of an entity, reduced to what the fold needs. */
export interface Edition {
  version: bigint;
  prevHash?: Uint8Array;
  /** `editionHash` of THIS edition. */
  selfHash: Uint8Array;
  createdAt: number;
  /** Rumor id bytes — the deterministic equal-version tiebreak. */
  tiebreakId: Uint8Array;
}

export interface FoldResult {
  /** Index of the chosen head edition, or null if nothing folds. */
  head: number | null;
  /** A higher version exists but doesn't link contiguously — fail closed + refetch. */
  gap: boolean;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Exported for control.ts's floor-hash check; see `headCandidates`. */
export function bytesEq(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && cmpBytes(a, b) === 0;
}

/**
 * Fold a set of editions for ONE entity into its current head, chain-checked.
 * `floor` is the highest version already accepted (0n = none), `floorHash`
 * that held edition's selfHash.
 */
export function fold(editions: Edition[], floor: bigint, floorHash?: Uint8Array): FoldResult {
  // Keep EVERY sibling per version, not a single winner: `tiebreakId` is
  // publisher-chosen, so a junk edition sorting lower would otherwise fail the
  // floor anchor and pin the entity forever. The `prevHash` link decides.
  const byVersion = new Map<bigint, number[]>();
  for (let i = 0; i < editions.length; i++) {
    const e = editions[i];
    if (e.version < floor) continue;
    const list = byVersion.get(e.version);
    if (list) list.push(i);
    else byVersion.set(e.version, [i]);
  }
  for (const list of byVersion.values()) {
    list.sort((x, y) => cmpBytes(editions[x].tiebreakId, editions[y].tiebreakId));
  }
  const versions = [...byVersion.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (versions.length === 0) return { head: null, gap: false };

  // Anchor on a sibling that links to what we hold, preferring the tiebreak winner.
  const base = byVersion.get(versions[0])!;
  let anchorIdx: number | undefined;
  if (floor === 0n) {
    if (versions[0] === 1n) anchorIdx = base.find((i) => editions[i].prevHash === undefined);
  } else if (floorHash !== undefined && versions[0] === floor) {
    anchorIdx = base.find((i) => bytesEq(floorHash, editions[i].selfHash));
  } else if (floorHash !== undefined && versions[0] === floor + 1n) {
    anchorIdx = base.find((i) => bytesEq(editions[i].prevHash, floorHash));
  }
  let gap = anchorIdx === undefined;

  // Walk choosing at each step the sibling that links to the one just accepted.
  let headIdx = anchorIdx ?? base[0];
  for (let k = 0; k + 1 < versions.length; k++) {
    if (versions[k + 1] !== versions[k] + 1n) {
      gap = true;
      break;
    }
    const next = byVersion
      .get(versions[k + 1])!
      .find((i) => bytesEq(editions[i].prevHash, editions[headIdx].selfHash));
    if (next === undefined) {
      gap = true;
      break;
    }
    headIdx = next;
  }
  return { head: headIdx, gap };
}

/**
 * The head a BOOTSTRAPPING client accepts after a Refounding's compaction
 * (CORD-04 §1): the winner at the highest version, ignoring contiguity (signature
 * + authority check are the whole test).
 */
export function bootstrapHead(editions: Edition[], floor: bigint): number | null {
  let best: number | null = null;
  for (let i = 0; i < editions.length; i++) {
    const e = editions[i];
    if (e.version < floor) continue;
    if (best === null) {
      best = i;
    } else {
      const cur = editions[best];
      if (e.version > cur.version || (e.version === cur.version && cmpBytes(e.tiebreakId, cur.tiebreakId) < 0)) {
        best = i;
      }
    }
  }
  return best;
}
