/**
 * Concord Control Plane editions — CORD-04 §1. An edition is a kind-3308 RUMOR
 * (authorship is the plaintext seal's signature, surviving compaction re-wraps):
 *
 *   ["vsk", n]                — entity type (the registry, CORD-02 Appendix B)
 *   ["eid", hex32]            — the entity's stable coordinate
 *   ["ev",  n]                — this edition's version, climbing from 1
 *   ["ep",  hex32]            — prev edition hash (absent on the first)
 *   ["vac", eid, ver, hash]   — the authority citation (absent when the owner acts)
 *   ["eh", "2"], ["eb", hex]  — MARKED: the hash covers the signer, bound to a Community
 *
 * Deliberately NO version tag: absence means this spec (CORD-02 Appendix B).
 */

import { hexToBytes } from "@noble/hashes/utils.js";

import { bytesToHex } from "@/concord/lib/derive";
import { KIND_CONTROL, KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import { buildRumor, type OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { editionHash, markedEditionHash, type Edition } from "@/concord/lib/version";

const TAG_SUBKIND = "vsk";
const TAG_ENTITY = "eid";
const TAG_EVERSION = "ev";
const TAG_EPREV = "ep";
const TAG_CITATION = "vac";
const TAG_EHASH = "eh";
const TAG_EBIND = "eb";

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * CORD-01 §5: tag numbers are decimal with no leading zeros. `BigInt()`/`Number()`
 * accept more (`"04"`, `"0x4"`, `"1e2"`...), and honoring those would silently
 * diverge from stricter peers.
 */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** True if `s` is a spec-shaped tag number (see {@link DECIMAL}). */
export function isTagDecimal(s: string | undefined): s is string {
  return s !== undefined && DECIMAL.test(s);
}

/** The pinned authority an actor claims for an action (CORD-04 §5). */
export interface AuthorityCitation {
  entityId: Uint8Array;
  version: bigint;
  editionHash: Uint8Array;
}

export function citationToTag(c: AuthorityCitation): string[] {
  return [TAG_CITATION, bytesToHex(c.entityId), c.version.toString(), bytesToHex(c.editionHash)];
}

export function citationFromTags(tags: string[][]): AuthorityCitation | undefined {
  const t = tags.find((t) => t.length >= 4 && t[0] === TAG_CITATION);
  if (!t) return undefined;
  if (!HEX64.test(t[1]) || !HEX64.test(t[3]) || !isTagDecimal(t[2])) return undefined;
  return { entityId: hexToBytes(t[1]), version: BigInt(t[2]), editionHash: hexToBytes(t[3]) };
}

/** Build an unsigned edition rumor (kind 3308). The plaintext SEAL proves the actor. */
export function buildEditionRumor(opts: {
  vsk: string;
  entityId: Uint8Array;
  version: bigint;
  prevHash?: Uint8Array;
  content: string;
  actorPubkey: string;
  createdAtSecs?: number;
  authority?: AuthorityCitation;
  /** `edition_binding(community_id)` (CORD-04 §1): when given, the edition is MARKED. */
  binding?: Uint8Array;
}): NostrRumor {
  const tags: string[][] = [
    [TAG_SUBKIND, opts.vsk],
    [TAG_ENTITY, bytesToHex(opts.entityId)],
    [TAG_EVERSION, opts.version.toString()],
  ];
  if (opts.prevHash) tags.push([TAG_EPREV, bytesToHex(opts.prevHash)]);
  if (opts.authority) tags.push(citationToTag(opts.authority));
  if (opts.binding) tags.push([TAG_EHASH, "2"], [TAG_EBIND, bytesToHex(opts.binding)]);
  return buildRumor({
    kind: KIND_CONTROL,
    content: opts.content,
    tags,
    pubkey: opts.actorPubkey,
    ms: null,
    createdAtSecs: opts.createdAtSecs,
  });
}

export interface ParsedEdition {
  /** The real npub (hex) that signed the seal around this edition. */
  author: string;
  vsk: string;
  entityId: Uint8Array;
  version: bigint;
  prevHash?: Uint8Array;
  content: string;
  /** `editionHash` of this edition — what the next edition's `ep` cites. */
  selfHash: Uint8Array;
  /**
   * The Community a MARKED edition binds itself to (`eb`, CORD-04 §1); absent for
   * an unmarked edition, whose hash covers no signer.
   */
  binding?: Uint8Array;
  createdAt: number;
  /** The rumor id (bytes) — the equal-version fold tiebreak. */
  rumorId: Uint8Array;
  authority?: AuthorityCitation;
  /** The opened stream event this edition arrived in (carries the re-wrappable seal). */
  opened: OpenedEvent;
}

export class EditionError extends Error {
  constructor(public code: "missing-field" | "bad-field", message: string) {
    super(message);
    this.name = "EditionError";
  }
}

function decodeHash(hex: string | undefined, field: string): Uint8Array {
  if (!hex || !HEX64.test(hex)) throw new EditionError("bad-field", field);
  return hexToBytes(hex.toLowerCase());
}

/**
 * Parse an OPENED control stream event into an edition (the stream layer already
 * proved authorship and integrity). Rejects duplicate machinery tags. Does NOT
 * check roster authorization — the fold does.
 */
export function parseEdition(opened: OpenedEvent): ParsedEdition {
  if (opened.kind !== KIND_CONTROL) throw new EditionError("bad-field", "kind");
  // Control seals MUST be plaintext (CORD-02 §5): an encrypted-seal edition can't
  // survive compaction. Checked whenever the seal form is known; stored rumors
  // were already checked by `writeOpened`.
  if (opened.sealKind !== undefined && opened.sealKind !== KIND_SEAL_PLAINTEXT) {
    throw new EditionError("bad-field", "seal-kind");
  }

  for (const name of [TAG_SUBKIND, TAG_ENTITY, TAG_EVERSION, TAG_EPREV, TAG_CITATION, TAG_EHASH, TAG_EBIND]) {
    if (opened.tags.filter((t) => t[0] === name).length > 1) {
      throw new EditionError("bad-field", `duplicate tag: ${name}`);
    }
  }
  const get = (name: string): string | undefined => opened.tags.find((t) => t[0] === name)?.[1];

  const vsk = get(TAG_SUBKIND);
  if (vsk === undefined) throw new EditionError("missing-field", "vsk");
  const entityId = decodeHash(get(TAG_ENTITY), "eid");
  const evStr = get(TAG_EVERSION);
  if (evStr === undefined) throw new EditionError("missing-field", "ev");
  if (!isTagDecimal(evStr)) throw new EditionError("bad-field", "ev");
  const version = BigInt(evStr);
  const epStr = get(TAG_EPREV);
  const prevHash = epStr !== undefined ? decodeHash(epStr, "ep") : undefined;

  // A marked edition is bound and covers its signer; any other marker is a form
  // this reader doesn't know. An `eb` without `eh` is ignored (CORD-04 §1).
  const eh = get(TAG_EHASH);
  let binding: Uint8Array | undefined;
  if (eh !== undefined) {
    if (eh !== "2") throw new EditionError("bad-field", "eh");
    const eb = get(TAG_EBIND);
    if (eb === undefined) throw new EditionError("missing-field", "eb");
    binding = decodeHash(eb, "eb");
  }
  const content = new TextEncoder().encode(opened.content);
  const selfHash = binding
    ? markedEditionHash(entityId, version, prevHash, content, hexToBytes(opened.author))
    : editionHash(entityId, version, prevHash, content);

  return {
    author: opened.author,
    vsk,
    entityId,
    version,
    prevHash,
    content: opened.content,
    selfHash,
    ...(binding ? { binding } : {}),
    createdAt: opened.createdAt,
    rumorId: hexToBytes(opened.rumorId),
    authority: citationFromTags(opened.tags),
    opened,
  };
}

/** The `version.Edition` view used by `version.fold`. */
export function toFoldEdition(p: ParsedEdition): Edition {
  return {
    version: p.version,
    prevHash: p.prevHash,
    selfHash: p.selfHash,
    createdAt: p.createdAt,
    tiebreakId: p.rumorId,
  };
}
