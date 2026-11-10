/**
 * The vsk-13 Roster (CORD-04 §2, §3, §9): Roles ordered by rank keys, `@everyone`,
 * Grants resolved against them, and Tenure, folded by DOWNWARD SUPPORT — an
 * edition counts only bits its signer holds through Roles ranked strictly above
 * everything it touches, so the fold resolves top-down from the owner and has one
 * answer whatever slice of the plane a reader holds.
 *
 * A port of Vector's `fold_authority` / `select_authorized` / `replay`
 * (`crates/vector-core/src/community/v2/service.rs`, MIT), kept close to it so the
 * two clients settle on one Roster; `cord25.fixtures.test.ts` checks it against
 * folds Vector itself produced.
 */

import { aclLocator, bytesToHex, everyoneLocator, grantLocator, hex32, overwriteTargetBytes, tenureLocator } from "@/concord/lib/derive";
import type { AuthorityCitation, ParsedEdition } from "@/concord/lib/edition";
import { denseRanks, isRankKey } from "@/concord/lib/rankKey";
import { hadRepeatedKeys, parseStrictObject, parseStrictValue, strictUint } from "@/concord/lib/strictJson";
import {
  BENEATH_EVERY_ROLE,
  MAX_ROLES_PER_COMMUNITY,
  MAX_ROLES_PER_MEMBER,
  OVERWRITABLE,
  Permissions,
  cutName,
  grantFromJSON,
  roleFromJSON,
  type CommunityRoles,
  type MemberGrant,
  type Overwrite,
  type OverwriteTarget,
  type Role,
} from "@/concord/lib/roles";

/** Control sub-kinds CORD-04 §2, §8, §9 and CORD-03 §1, §4 added (CORD-02 Appendix B). */
export const VSK_RANKED_ROLE = "13";
export const VSK_ACL = "14";
export const VSK_CATEGORY = "15";
export const VSK_TENURE = "16";
export const VSK_SYNC = "17";
export const VSK_WRITERS = "18";

/** Kinds no older client wrote: marked in every Community, so an unmarked one is refused (CORD-04 §1). */
export const ALWAYS_MARKED_VSKS: ReadonlySet<string> = new Set([VSK_RANKED_ROLE, VSK_ACL, VSK_CATEGORY, VSK_TENURE, VSK_SYNC, VSK_WRITERS]);

/** The most Channels a switching `@everyone` lists (CORD-04 §2). */
export const MAX_LEGACY_CHANNELS = 256;
/** A Tenure's entry and head caps (CORD-04 §9). */
export const MAX_TENURE_ENTRIES = 16;
export const MAX_TENURE_HEADS = 512;
const LINK_RUN_CAP = 64;
const HELD_CHAIN_CAP = 4096;

const HEX64 = /^[0-9a-fA-F]{64}$/;

// ── Wire content ─────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** CORD-04 §3 permissions: a decimal string (digits only, ≤ 2^64 − 1) or a JSON integer in range. */
export function parsePermissionBits(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v >= 0n && v < 1n << 64n ? v : undefined;
  if (typeof v === "string") {
    if (!/^\d+$/.test(v)) return undefined;
    const n = BigInt(v);
    return n < 1n << 64n ? n : undefined;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

export { cutName };

const RANKED_ROLE_FIELDS = new Set(["role_id", "name", "rank", "permissions", "color", "display", "mentionable", "deleted"]);
/** Integer fields of Roster content, read off their source text (see `strictJson.ts`). */
const INT_KEYS: ReadonlySet<string> = new Set(["permissions", "allow", "deny", "color", "position"]);

export type RankedRole = { kind: "live"; role: Role } | { kind: "deleted"; roleId: string };

/** Absent or `null`, as serde reads an `Option`. */
const none = (v: unknown) => v === undefined || v === null;

/**
 * A vsk-13 Role edition (CORD-04 §2). A field of the wrong type makes the content
 * unparseable, a deletion's included; `null` reads as absent. A live Role needs a
 * rank key; its position is assigned at fold time from the keys in play.
 */
export function parseRankedRole(content: string): RankedRole | undefined {
  const c = parseStrictObject(content, INT_KEYS);
  if (!c || typeof c.role_id !== "string" || !HEX64.test(c.role_id)) return undefined;
  const roleId = c.role_id.toLowerCase();
  const optOf = (k: string, t: "string" | "boolean") => none(c[k]) || typeof c[k] === t;
  if (!optOf("name", "string") || !optOf("rank", "string")) return undefined;
  if (!optOf("deleted", "boolean") || !optOf("display", "boolean") || !optOf("mentionable", "boolean")) return undefined;
  // Absent reads as none, but a present null fails (Vector `perm_decimal_string_opt`).
  const permissions = c.permissions === undefined ? 0n : parsePermissionBits(c.permissions);
  if (permissions === undefined) return undefined;
  const color = none(c.color) ? 0n : strictUint(c.color, 0xffffffffn);
  if (color === undefined) return undefined;
  if (c.deleted === true) return { kind: "deleted", roleId };
  if (!isRankKey(c.rank)) return undefined;
  // Unknown fields round-trip as carried, not as the integer reading of a known name (CORD-04 §2).
  const raw = parseStrictValue(content) as Record<string, unknown>;
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !RANKED_ROLE_FIELDS.has(k)));
  return {
    kind: "live",
    role: {
      roleId,
      name: cutName(typeof c.name === "string" ? c.name : ""),
      position: BENEATH_EVERY_ROLE,
      rank: c.rank,
      permissions,
      scope: { kind: "server" },
      color: Number(color),
      ...(c.display === true ? { display: true } : {}),
      ...(c.mentionable === true ? { mentionable: true } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
  };
}

/** A live vsk-13 Role's content: every field written, false flags included (CORD-04 §2). */
export function rankedRoleToJSON(role: Role): string {
  if (!isRankKey(role.rank)) throw new Error("a Role needs a rank key");
  return JSON.stringify({
    ...(role.extra ?? {}),
    role_id: role.roleId,
    name: role.name,
    rank: role.rank,
    permissions: role.permissions.toString(),
    color: role.color,
    display: role.display === true,
    mentionable: role.mentionable === true,
  });
}

/** A Role's terminal deletion (CORD-04 §2). */
export function rankedRoleDeletedJSON(roleId: string): string {
  return JSON.stringify({ role_id: roleId, deleted: true });
}

/**
 * `@everyone`'s content: its bits, and the Channels that stood before the switch
 * (lowercased, malformed ids dropped, at most 256). A Role's shape at its
 * coordinate is a Role aimed there, not `@everyone`.
 */
export function parseEveryone(content: string): { permissions: bigint; legacy?: string[] } | undefined {
  const c = parseStrictObject(content, INT_KEYS);
  if (!c || "role_id" in c) return undefined;
  const permissions = parsePermissionBits(c.permissions);
  if (permissions === undefined) return undefined;
  if (none(c.legacy)) return { permissions };
  if (!Array.isArray(c.legacy) || c.legacy.some((h) => typeof h !== "string")) return undefined;
  // In serde's BTreeSet order, cut before lowercasing (Vector `parse_everyone_content`).
  const raw = [...new Set(c.legacy as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const legacy = [...new Set(raw.filter((h) => HEX64.test(h)).slice(0, MAX_LEGACY_CHANNELS).map((h) => h.toLowerCase()))].sort();
  return { permissions, legacy };
}

export function everyoneToJSON(permissions: bigint, legacy?: readonly string[]): string {
  return JSON.stringify({ permissions: permissions.toString(), ...(legacy ? { legacy: [...legacy].sort() } : {}) });
}

/** One sealed standing in a Tenure (CORD-04 §9). */
export interface TenureEntry {
  rank: string;
  permissions: bigint;
  heads: string[];
}

/** A Tenure; entries with a malformed rank key, and malformed heads, are dropped, then capped. */
export function parseTenure(content: string): { member: string; sealed: TenureEntry[] } | undefined {
  const c = parseStrictObject(content, INT_KEYS);
  if (!c || typeof c.member !== "string") return undefined;
  const raw = c.sealed === undefined ? [] : c.sealed;
  if (!Array.isArray(raw)) return undefined;
  const sealed: TenureEntry[] = [];
  for (const item of raw) {
    const e = asRecord(item);
    if (!e || hadRepeatedKeys(e) || typeof e.rank !== "string") return undefined;
    const permissions = parsePermissionBits(e.permissions);
    if (permissions === undefined) return undefined;
    const heads = e.heads === undefined ? [] : e.heads;
    if (!Array.isArray(heads) || heads.some((h) => typeof h !== "string")) return undefined;
    if (!isRankKey(e.rank)) continue;
    sealed.push({
      rank: e.rank,
      permissions,
      heads: (heads as string[]).filter((h) => HEX64.test(h)).map((h) => h.toLowerCase()).slice(0, MAX_TENURE_HEADS),
    });
  }
  return { member: c.member.toLowerCase(), sealed: sealed.slice(0, MAX_TENURE_ENTRIES) };
}

export function tenureToJSON(member: string, sealed: TenureEntry[]): string {
  return JSON.stringify({
    member,
    sealed: sealed.map((e) => ({ rank: e.rank, permissions: e.permissions.toString(), heads: e.heads })),
  });
}

/** An overwrite (CORD-04 §8), its bits masked to the overwritable set as it parses. */
export function parseOverwrite(content: string): Overwrite | undefined {
  const c = parseStrictObject(content, INT_KEYS);
  if (!c || typeof c.scope !== "string" || !HEX64.test(c.scope)) return undefined;
  const t = asRecord(c.target);
  if (!t || hadRepeatedKeys(t)) return undefined;
  let target: OverwriteTarget;
  if (t.kind === "everyone" && none(t.id)) target = { kind: "everyone" };
  else if ((t.kind === "role" || t.kind === "member") && typeof t.id === "string" && HEX64.test(t.id)) target = { kind: t.kind, id: t.id.toLowerCase() };
  else return undefined;
  const allow = parsePermissionBits(c.allow);
  const deny = parsePermissionBits(c.deny);
  if (allow === undefined || deny === undefined) return undefined;
  return { scope: c.scope.toLowerCase(), target, allow: allow & OVERWRITABLE, deny: deny & OVERWRITABLE };
}

export function overwriteToJSON(o: Overwrite): string {
  const target = o.target.kind === "everyone" ? { kind: "everyone" } : { kind: o.target.kind, id: o.target.id };
  return JSON.stringify({ scope: o.scope, target, allow: o.allow.toString(), deny: o.deny.toString() });
}

/** The coordinate an overwrite lives at (CORD-04 §8). */
export function overwriteLocator(communityId: Uint8Array, o: Pick<Overwrite, "scope" | "target">): Uint8Array {
  const tb = o.target.kind === "everyone"
    ? overwriteTargetBytes(communityId, "everyone")
    : overwriteTargetBytes(communityId, o.target.kind, hex32(o.target.id));
  return aclLocator(communityId, hex32(o.scope), tb);
}

/**
 * A Channel's sync (CORD-04 §8): `[channel, category?]`. A `sync` that is no string
 * nor `null` leaves it unparseable; `null` or a string that isn't a hex id reads as none.
 */
export function parseSync(content: string): { channel: string; category?: string } | undefined {
  const c = parseStrictObject(content);
  if (!c || typeof c.channel !== "string" || !HEX64.test(c.channel)) return undefined;
  if (c.sync !== undefined && c.sync !== null && typeof c.sync !== "string") return undefined;
  const category = typeof c.sync === "string" && HEX64.test(c.sync) ? c.sync.toLowerCase() : undefined;
  return { channel: c.channel.toLowerCase(), ...(category ? { category } : {}) };
}

export function syncToJSON(channel: string, category?: string): string {
  return JSON.stringify({ channel, ...(category ? { sync: category } : {}) });
}

// ── The fold ─────────────────────────────────────────────────────────────────

/** A held head: what a tracking reader settled on for an entity (CORD-04 §1). */
export interface RosterFloor {
  version: bigint;
  hash: Uint8Array;
  /** The rumor id it was recorded with; without one, any same-version rival may replace it. */
  rumorId?: string;
  author?: string;
  /** The entity kind it was recorded for; a floor of another family never floors the Roster. */
  vsk?: string;
}

/** The vsks whose heads floor the Roster fold (Vector's FLOOR_AUTHORITY family). */
export const AUTHORITY_VSKS: ReadonlySet<string> = new Set(["1", VSK_RANKED_ROLE, "3", "4", VSK_TENURE, VSK_ACL, VSK_SYNC]);

/** What a tracking reader settled on last time, for what a withheld head leaves unknown (CORD-04 §1, §2). */
export interface StoredRoster {
  everyone?: bigint;
  legacyChannels?: string[];
  /**
   * The Roles and Grantees the reader last folded, and the Grantees holding MANAGE_ROLES:
   * the floored entities a plane may stop serving, which a fold tracks for being whole
   * (Vector's `complete`).
   */
  roleIds?: string[];
  grantees?: string[];
  roleManagers?: string[];
}

/** A sealed standing as the fold reads it: its rank mapped to a position. */
export interface Sealed {
  position: number;
  bits: bigint;
  heads: ReadonlySet<string>;
}

/** Each member's sealed standings, from the Tenures the fold admits. */
export type SealedBy = Map<string, Sealed[]>;

/** The bits sealed for `authorHex` over `hashHex` by every standing ranked above `reach`. */
export function sealOf(sealed: SealedBy, authorHex: string, hashHex: string, reach: number): bigint {
  let bits = 0n;
  for (const e of sealed.get(authorHex) ?? []) if (e.position < reach && e.heads.has(hashHex)) bits |= e.bits;
  return bits;
}

/** Some Tenure lists `hashHex` as `authorHex`'s, at whatever standing. */
export function isListed(sealed: SealedBy, authorHex: string, hashHex: string): boolean {
  return (sealed.get(authorHex) ?? []).some((e) => e.heads.has(hashHex));
}

type CandKind = "live" | "deleted" | "everyone" | "history";

interface Cand {
  kind: CandKind;
  role?: Role;
  legacy?: string[];
  grant?: MemberGrant;
  tenure?: { member: string; entries: Sealed[] };
  authorHex: string;
  grantHex: string;
  p: ParsedEdition;
  eid: string;
  hashHex: string;
  idHex: string;
  citation?: AuthorityCitation;
  prevHex?: string;
  floor?: RosterFloor;
  heldServed: boolean;
}

/** A head the Roster fold settled on. `rebased` = below the floor, because the held head was refused. */
export interface RosterHead {
  eid: string;
  edition: ParsedEdition;
  rebased: boolean;
}

export interface RosterFold {
  roles: CommunityRoles;
  heads: RosterHead[];
  sealed: SealedBy;
  /** Entities whose admitted editions sit above a head out of reach: a link withheld. */
  gapped: Set<string>;
  converged: boolean;
  /** Every Roster entity it tracks served its held head, so a refused one is refused on the evidence. */
  complete: boolean;
}

type Judged = { rank?: number } | null;

function isHeld(c: Cand): boolean {
  const f = c.floor;
  return f !== undefined && c.p.version === f.version && c.hashHex === bytesToHex(f.hash) && (f.rumorId === undefined || f.rumorId === c.idHex);
}

function stricter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** A roster's per-member questions answered from each member's Roles gathered once. */
class RoleIndex {
  private byId = new Map<string, Role>();
  private held = new Map<string, Role[]>();

  constructor(roster: CommunityRoles) {
    for (const r of roster.roles) if (!this.byId.has(r.roleId)) this.byId.set(r.roleId, r);
    for (const g of roster.grants) {
      const list = this.held.get(g.member) ?? [];
      for (const rid of g.roleIds) {
        const r = this.byId.get(rid);
        if (r) list.push(r);
      }
      this.held.set(g.member, list);
    }
  }

  role(id: string): Role | undefined {
    return this.byId.get(id);
  }

  permissionsAbove(member: string, bound: number): bigint {
    let bits = 0n;
    for (const r of this.held.get(member) ?? []) if (r.position < bound) bits |= r.permissions;
    return bits;
  }

  highestPositionAbove(member: string, bound: number): number | undefined {
    let best: number | undefined;
    for (const r of this.held.get(member) ?? []) if (r.position < bound && (best === undefined || r.position < best)) best = r.position;
    return best;
  }
}

function forkRankAbove(index: RoleIndex, ownerHex: string, authorHex: string, reach: number): number {
  if (authorHex === ownerHex) return 0;
  return index.highestPositionAbove(authorHex, reach) ?? BENEATH_EVERY_ROLE;
}

function compareKey(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** CORD-04 §5 sync floor against the heads a fold round settled on. */
function citationOk(heads: Map<string, RosterHead>, ownerHex: string, c: Cand): boolean {
  if (c.authorHex === ownerHex) return true;
  const cite = c.citation;
  if (!cite || bytesToHex(cite.entityId) !== c.grantHex) return false;
  const head = heads.get(c.grantHex);
  if (!head) return false;
  if (head.edition.version > cite.version) return true;
  if (head.edition.version === cite.version) return bytesToHex(head.edition.selfHash) === bytesToHex(cite.editionHash);
  return false;
}

/**
 * A same-version rival of a WITHHELD held edition that doesn't beat the key its
 * floor recorded: taking it would let a relay withholding the better one swap in
 * a worse one. Only the owner stands in while the held edition's claims are unknown.
 */
function losesToFloor(c: Cand, index: RoleIndex, ownerHex: string): boolean {
  const f = c.floor;
  if (!f || c.heldServed) return false;
  if (c.p.version !== f.version || c.hashHex === bytesToHex(f.hash)) return false;
  if (c.authorHex !== ownerHex) return true;
  // The owner's rival takes the floor only when it beats the key the floor recorded.
  if (f.rumorId === undefined) return false;
  if (f.author === undefined) return !(c.idHex < f.rumorId);
  const heldRank = forkRankAbove(index, ownerHex, f.author, Number.MAX_SAFE_INTEGER);
  return compareKey([0, c.idHex], [heldRank, f.rumorId]) >= 0;
}

type Picked = { kind: "head"; j: number; rebased: boolean } | { kind: "refused" } | { kind: "carried"; j: number } | { kind: "nothing" };

/**
 * What naming `h` at version `ver` adds to the rank an edition acts on, and whether
 * that rests on evidence in hand: through refused editions (each perhaps a copy of
 * one that stands, so the strictest rank counts) to an admitted one, or to the
 * genesis below this reader's held edition.
 */
function linkRun(
  cands: Cand[],
  start: string,
  ver: bigint,
  byHash: Map<string, number[]>,
  sure: boolean[],
  conf: Judged[],
  claims: (c: Cand) => number | undefined,
): [number | undefined, boolean] {
  let acc: number | undefined;
  let throughHeld = false;
  let at = ver;
  let h = start;
  for (let step = 0; step < LINK_RUN_CAP; step++) {
    const js = byHash.get(h);
    if (!js || cands[js[0]].p.version + 1n !== at) return [undefined, false];
    const k = js.find((x) => conf[x] !== null);
    if (k !== undefined) return [stricter(acc, conf[k]!.rank), js.some((x) => sure[x])];
    throughHeld ||= js.some((x) => isHeld(cands[x]));
    acc = stricter(acc, claims(cands[js[0]]));
    at = cands[js[0]].p.version;
    const prev = cands[js[0]].prevHex;
    if (prev === undefined) return throughHeld ? [acc, true] : [undefined, false];
    h = prev;
  }
  return [undefined, false];
}

/**
 * One entity's chain, replayed ascending (CORD-04 §1, §3), and its head. Each
 * version acts on what the newest admitted version below it left, never on what
 * its own `prev` names alone (its author picks that). Fork siblings are judged at
 * the strictest rank any viable one claims. `judge` returns the rank an admitted
 * edition confers. Candidates arrive version-DESC.
 */
function replay(
  cands: Cand[],
  index: RoleIndex,
  ownerHex: string,
  complete: boolean,
  voided: boolean,
  claims: (c: Cand) => number | undefined,
  judge: (c: Cand, reach: number) => Judged,
  admittedOut: Set<string>,
): [Picked, boolean] {
  const n = cands.length;
  if (n === 0) return [{ kind: "nothing" }, false];
  const floor = cands[0].floor;
  const isOwner = (c: Cand) => c.authorHex === ownerHex;
  const byHash = new Map<string, number[]>();
  for (let j = 0; j < n; j++) {
    const list = byHash.get(cands[j].hashHex);
    if (list) list.push(j);
    else byHash.set(cands[j].hashHex, [j]);
  }
  const node = (h: string, at: bigint) => {
    const js = byHash.get(h);
    return js && cands[js[0]].p.version === at ? js : undefined;
  };
  const admitted = new Array<boolean>(n).fill(false);
  const sure = new Array<boolean>(n).fill(false);
  const conf = new Array<Judged>(n).fill(null);
  const stand = new Array<{ standing?: number; proven: boolean }>(n).fill({ proven: false });
  const key = new Array<[number, string]>(n).fill([BENEATH_EVERY_ROLE, ""]);
  const viable = new Array<boolean>(n).fill(false);
  const runs = new Map<string, [number | undefined, boolean]>();
  let base: number | undefined;

  let i = n;
  while (i > 0) {
    const hi = i;
    const ver = cands[i - 1].p.version;
    while (i > 0 && cands[i - 1].p.version === ver) i--;
    for (let j = i; j < hi; j++) {
      let constraint: number | undefined;
      let proven: boolean;
      const prev = cands[j].prevHex;
      if (prev === undefined) {
        constraint = undefined;
        proven = ver === 1n;
      } else {
        const rk = `${prev}:${ver}`;
        let r = runs.get(rk);
        if (!r) {
          r = linkRun(cands, prev, ver, byHash, sure, conf, claims);
          runs.set(rk, r);
        }
        [constraint, proven] = r;
      }
      stand[j] = { standing: stricter(base, constraint), proven };
    }
    const own = (j: number) => {
      const c = claims(cands[j]);
      const s = stand[j].standing;
      const m = stricter(c, s);
      return m ?? BENEATH_EVERY_ROLE;
    };
    for (let j = i; j < hi; j++) {
      viable[j] = !losesToFloor(cands[j], index, ownerHex) && (hi - i === 1 || judge(cands[j], own(j)) !== null);
    }
    let reach = BENEATH_EVERY_ROLE;
    for (let j = i; j < hi; j++) if (viable[j]) reach = Math.min(reach, own(j));
    for (let j = i; j < hi; j++) {
      const c = cands[j];
      key[j] = [forkRankAbove(index, ownerHex, c.authorHex, reach), c.idHex];
      conf[j] = viable[j] ? judge(c, reach) : null;
      admitted[j] = conf[j] !== null;
      sure[j] = admitted[j] && (stand[j].proven || isOwner(c) || (floor !== undefined && floor.version === ver));
      if (admitted[j]) admittedOut.add(c.idHex);
    }
    let w: number | undefined;
    for (let j = i; j < hi; j++) if (admitted[j] && (w === undefined || compareKey(key[j], key[w]) < 0)) w = j;
    if (w !== undefined) base = conf[w]!.rank;
  }

  const best = (ok: (j: number) => boolean): number | undefined => {
    let top: bigint | undefined;
    for (let j = 0; j < n; j++) if (ok(j) && (top === undefined || cands[j].p.version > top)) top = cands[j].p.version;
    if (top === undefined) return undefined;
    let pick: number | undefined;
    for (let j = 0; j < n; j++) {
      if (ok(j) && cands[j].p.version === top && (pick === undefined || compareKey(key[j], key[pick]) < 0)) pick = j;
    }
    return pick;
  };

  if (!floor || voided) {
    const j = best((x) => admitted[x]);
    if (j !== undefined) return [{ kind: "head", j, rebased: voided && !isHeld(cands[j]) }, false];
    if (!voided) return [{ kind: "nothing" }, false];
    // Nothing stands once the banned signer's editions are gone; page for what stood
    // before them unless the held chain already reads down to its genesis.
    let at = cands.findIndex(isHeld);
    for (let step = 0; step < HELD_CHAIN_CAP && at >= 0; step++) {
      const prev = cands[at].prevHex;
      if (prev === undefined) return [{ kind: "refused" }, false];
      at = node(prev, cands[at].p.version - 1n)?.[0] ?? -1;
    }
    return [{ kind: "refused" }, true];
  }

  // Reachable from the floor along served links, ascending.
  const floorHash = bytesToHex(floor.hash);
  const reachable = new Array<boolean>(n).fill(false);
  for (let j = n - 1; j >= 0; j--) {
    const c = cands[j];
    if (c.p.version < floor.version) reachable[j] = false;
    else if (c.p.version === floor.version) reachable[j] = !losesToFloor(c, index, ownerHex);
    else {
      const prev = c.prevHex;
      reachable[j] = prev !== undefined && (
        (c.p.version === floor.version + 1n && prev === floorHash) ||
        (node(prev, c.p.version - 1n)?.some((k) => reachable[k]) ?? false)
      );
    }
  }
  const gapAbove = (v: bigint) => cands.some((c, j) => admitted[j] && !reachable[j] && c.p.version > v);
  // Above the floor an edition stands on evidence; only the owner acts regardless of rank.
  const advance = (j: number) =>
    reachable[j] && admitted[j] && (cands[j].p.version === floor.version || stand[j].proven || isOwner(cands[j]));
  const head = best(advance);
  if (head !== undefined) return [{ kind: "head", j: head, rebased: false }, gapAbove(cands[head].p.version)];
  if (!cands[0].heldServed) return [{ kind: "nothing" }, false];
  const held = cands.findIndex(isHeld);
  if (held < 0) return [{ kind: "nothing" }, false];
  const gap = gapAbove(floor.version);
  // On a COMPLETE fold, a refused held edition recorded with its id steps down to the
  // predecessor it names when a served copy of that stands on evidence; a genesis has
  // none. Short of evidence it is carried (Vector's `complete`).
  if (complete && floor.rumorId !== undefined) {
    const prev = cands[held].prevHex;
    if (prev === undefined) return [{ kind: "refused" }, gap];
    const own = (j: number) => stricter(claims(cands[j]), stand[j].standing) ?? BENEATH_EVERY_ROLE;
    const floorReach = own(held);
    let target: number | undefined;
    for (const k of node(prev, floor.version - 1n) ?? []) {
      if (!sure[k] || judge(cands[k], Math.min(own(k), floorReach)) === null) continue;
      if (target === undefined || compareKey(key[k], key[target]) < 0) target = k;
    }
    if (target !== undefined) return [{ kind: "head", j: target, rebased: true }, gap];
  }
  return [{ kind: "carried", j: held }, gap];
}

interface Cands {
  roles: Map<string, Cand[]>;
  grants: Map<string, Cand[]>;
  tenures: Map<string, Cand[]>;
  /** Every Roster entity this reader floors served its held head. */
  complete: boolean;
  /** Entities whose held head is withheld while a newer edition is served: page for it. */
  withheld: Set<string>;
}

function buildCands(
  editions: ParsedEdition[],
  communityId: Uint8Array,
  floors: Map<string, RosterFloor>,
  activated: boolean,
  ownerHex: string,
  stored: StoredRoster,
): Cands {
  const everyoneHex = bytesToHex(everyoneLocator(communityId));
  const groups = new Map<string, ParsedEdition[]>();
  for (const e of editions) {
    if (e.vsk !== "1" && e.vsk !== VSK_RANKED_ROLE && e.vsk !== "3" && e.vsk !== VSK_TENURE) continue;
    const eid = bytesToHex(e.entityId);
    const list = groups.get(eid);
    if (list) list.push(e);
    else groups.set(eid, [e]);
  }
  // Rank keys map to dense positions; a Tenure's ranks sit in the same order.
  const keys: string[] = [];
  if (activated) {
    for (const e of editions) {
      if (!e.binding) continue;
      if (e.vsk === VSK_RANKED_ROLE) {
        const r = parseRankedRole(e.content);
        if (r?.kind === "live" && r.role.rank) keys.push(r.role.rank);
      } else if (e.vsk === VSK_TENURE) {
        for (const s of parseTenure(e.content)?.sealed ?? []) keys.push(s.rank);
      }
    }
  }
  const ranks = denseRanks(keys);
  const out: Cands = { roles: new Map(), grants: new Map(), tenures: new Map(), complete: true, withheld: new Set() };
  const heldServed = (eid: string, f: RosterFloor) =>
    (groups.get(eid) ?? []).some((p) => p.version === f.version && bytesToHex(p.selfHash) === bytesToHex(f.hash) && (f.rumorId === undefined || f.rumorId === bytesToHex(p.rumorId)));
  for (const [eid, f] of floors) {
    if (!heldServed(eid, f) && (groups.get(eid) ?? []).some((p) => p.version > f.version)) out.withheld.add(eid);
  }
  // Whole when every entity it tracks served its held head: those in hand, the Roles and
  // Grants it last folded, and the Tenures its floors' authors could have been sealed by.
  const tracked = new Set<string>(groups.keys());
  for (const id of stored.roleIds ?? []) tracked.add(id.toLowerCase());
  for (const m of stored.grantees ?? []) if (/^[0-9a-f]{64}$/i.test(m)) tracked.add(bytesToHex(grantLocator(communityId, hex32(m))));
  const sealers = new Set([ownerHex, ...(stored.roleManagers ?? [])].filter((w) => /^[0-9a-f]{64}$/i.test(w)));
  const authors = new Set([...floors.values()].flatMap((f) => (f.author && /^[0-9a-f]{64}$/i.test(f.author) ? [f.author] : [])));
  for (const a of authors) {
    for (const w of sealers) {
      const eid = bytesToHex(tenureLocator(communityId, hex32(a), hex32(w)));
      if (floors.has(eid)) tracked.add(eid);
    }
  }
  for (const eid of tracked) {
    const f = floors.get(eid);
    if (f && !heldServed(eid, f)) out.complete = false;
  }
  const push = (m: Map<string, Cand[]>, eid: string, c: Cand) => {
    const list = m.get(eid);
    if (list) list.push(c);
    else m.set(eid, [c]);
  };
  for (const [eid, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const floor = floors.get(eid);
    const served = floor !== undefined && heldServed(eid, floor);
    for (const p of group) {
      const authorHex = p.author;
      const base = {
        authorHex,
        grantHex: bytesToHex(grantLocator(communityId, hex32(authorHex))),
        p,
        eid,
        hashHex: bytesToHex(p.selfHash),
        idHex: bytesToHex(p.rumorId),
        citation: p.authority,
        prevHex: p.prevHash ? bytesToHex(p.prevHash) : undefined,
        floor,
        heldServed: served,
      };
      if (p.vsk === "1") {
        if (eid === everyoneHex) continue;
        const role = roleFromJSON(p.content);
        if (role && role.roleId === eid) push(out.roles, eid, { ...base, kind: activated ? "history" : "live", role });
      } else if (p.vsk === VSK_RANKED_ROLE) {
        if (!p.binding || !activated) continue;
        if (eid === everyoneHex) {
          const ev = parseEveryone(p.content);
          if (!ev) continue;
          const role: Role = { roleId: everyoneHex, name: "@everyone", position: BENEATH_EVERY_ROLE, permissions: ev.permissions, scope: { kind: "server" }, color: 0 };
          push(out.roles, eid, { ...base, kind: "everyone", role, legacy: ev.legacy });
          continue;
        }
        const r = parseRankedRole(p.content);
        if (r?.kind === "live" && r.role.roleId === eid) {
          push(out.roles, eid, { ...base, kind: "live", role: { ...r.role, position: ranks.get(r.role.rank!) ?? BENEATH_EVERY_ROLE } });
        } else if (r?.kind === "deleted" && r.roleId === eid) {
          const role: Role = { roleId: eid, name: "", position: BENEATH_EVERY_ROLE, permissions: 0n, scope: { kind: "server" }, color: 0 };
          push(out.roles, eid, { ...base, kind: "deleted", role });
        }
      } else if (p.vsk === VSK_TENURE) {
        if (!activated || !p.binding) continue;
        const t = parseTenure(p.content);
        if (!t || !HEX64.test(t.member)) continue;
        if (bytesToHex(tenureLocator(communityId, hex32(t.member), hex32(authorHex))) !== eid) continue;
        const entries: Sealed[] = [];
        for (const e of t.sealed) {
          const position = ranks.get(e.rank);
          if (position !== undefined) entries.push({ position, bits: e.permissions, heads: new Set(e.heads) });
        }
        push(out.tenures, eid, { ...base, kind: "live", tenure: { member: t.member, entries } });
      } else {
        const grant = grantFromJSON(p.content);
        if (!grant || bytesToHex(grantLocator(communityId, hex32(grant.member))) !== eid) continue;
        push(out.grants, eid, { ...base, kind: "live", grant: { ...grant, roleIds: grant.roleIds.map((r) => r.toLowerCase()).slice(0, MAX_ROLES_PER_MEMBER) } });
      }
    }
  }
  for (const m of [out.roles, out.grants, out.tenures]) {
    for (const list of m.values()) {
      list.sort((a, b) => (a.p.version !== b.p.version ? (a.p.version > b.p.version ? -1 : 1) : a.idHex < b.idHex ? -1 : a.idHex > b.idHex ? 1 : 0));
    }
  }
  return out;
}

/**
 * The owner-seeded delegation fixpoint (CORD-04 §1-§3, §9): per entity the highest
 * edition its author is authorized to write under the roster resolved so far.
 */
function selectAuthorized(cands: Cands, communityId: Uint8Array, ownerHex: string, excluded: ReadonlySet<string>): RosterFold {
  const everyoneHex = bytesToHex(everyoneLocator(communityId));
  let accepted: CommunityRoles = { roles: [], grants: [] };
  let heads = new Map<string, RosterHead>();
  let sealed: SealedBy = new Map();
  let gapped = new Set<string>();
  let converged = false;
  const bound = 2 * (cands.roles.size + cands.grants.size + cands.tenures.size) + 8;

  for (let round = 0; round < bound; round++) {
    const next: CommunityRoles = { roles: [], grants: [] };
    const nextHeads = new Map<string, RosterHead>();
    const nextGapped = new Set<string>(cands.withheld);
    const nextAdmitted = new Set<string>();
    const nextSealed: SealedBy = new Map();
    const standing = new RoleIndex(accepted);
    const citeHeads = heads;
    const currentSealed = sealed;

    // A ban takes what its target wrote, but not what a Tenure sealed (CORD-04 §9).
    // Read off the floor alone: one that recorded no author voids nothing (Vector `held_banned`).
    const voided = (list: Cand[]): boolean => {
      const author = list[0]?.floor?.author;
      if (author === undefined || !excluded.has(author)) return false;
      return !isListed(currentSealed, author, bytesToHex(list[0].floor!.hash));
    };
    const supportFor = (ah: string, c: Cand, reach: number): bigint =>
      standing.permissionsAbove(ah, reach) | sealOf(currentSealed, ah, c.hashHex, reach);

    for (const [eid, list] of cands.tenures) {
      const claims = (c: Cand) => {
        let m: number | undefined;
        for (const e of c.tenure?.entries ?? []) m = m === undefined ? e.position : Math.min(m, e.position);
        return m;
      };
      const judge = (c: Cand): Judged => {
        if (!c.tenure) return null;
        const ah = c.authorHex;
        const listed = isListed(currentSealed, ah, c.hashHex);
        if (excluded.has(ah) && !listed) return null;
        if (c.tenure.member === ah || c.tenure.member === ownerHex) return null;
        if (ah !== ownerHex) {
          const can = c.tenure.entries.every((e) => {
            const support = supportFor(ah, c, e.position);
            return (support & Permissions.MANAGE_ROLES) !== 0n && (e.bits & ~support) === 0n;
          });
          if (!can) return null;
        }
        if (!listed && c.citation && !citationOk(citeHeads, ownerHex, c)) return null;
        return {};
      };
      const [picked, gap] = replay(list, standing, ownerHex, cands.complete, voided(list), claims, judge, nextAdmitted);
      if (gap) nextGapped.add(eid);
      let j: number;
      if (picked.kind === "head") {
        nextHeads.set(eid, { eid, edition: list[picked.j].p, rebased: picked.rebased });
        j = picked.j;
      } else if (picked.kind === "carried") {
        nextHeads.set(eid, { eid, edition: list[picked.j].p, rebased: false });
        j = picked.j;
      } else continue;
      const t = list[j].tenure!;
      nextSealed.set(t.member, [...(nextSealed.get(t.member) ?? []), ...t.entries]);
    }

    for (const [eid, list] of cands.roles) {
      // A deletion and a legacy edition claim no rank: they act at the one the Role stood at.
      const claims = (c: Cand) => (c.kind === "deleted" || c.kind === "history" ? undefined : c.role?.position);
      const judge = (c: Cand, reach: number): Judged => {
        const role = c.role;
        if (!role || c.kind === "history") return null;
        const ah = c.authorHex;
        const listed = isListed(currentSealed, ah, c.hashHex);
        if ((excluded.has(ah) && !listed) || role.position === 0) return null;
        if (ah !== ownerHex) {
          const support = supportFor(ah, c, reach);
          if ((support & Permissions.MANAGE_ROLES) === 0n) return null;
          if ((role.permissions & ~support) !== 0n) return null;
        }
        if (!listed && c.citation && !citationOk(citeHeads, ownerHex, c)) return null;
        return c.kind === "deleted" ? {} : { rank: role.position };
      };
      const [picked, gap] = replay(list, standing, ownerHex, cands.complete, voided(list), claims, judge, nextAdmitted);
      if (gap) nextGapped.add(eid);
      // Deletion is terminal over the authorized chain, and acts at every rank the
      // Role holds from the deletion on.
      let deletion: number | undefined;
      list.forEach((d, j) => {
        if (d.kind !== "deleted" || !nextAdmitted.has(d.idHex)) return;
        let later: number | undefined;
        for (const c of list) {
          if (c.kind === "live" && c.p.version >= d.p.version && nextAdmitted.has(c.idHex) && c.role) {
            later = later === undefined ? c.role.position : Math.min(later, c.role.position);
          }
        }
        if (later !== undefined && judge(d, later) === null) return;
        if (
          deletion === undefined ||
          d.p.version > list[deletion].p.version ||
          (d.p.version === list[deletion].p.version && d.idHex < list[deletion].idHex)
        ) deletion = j;
      });
      if (deletion !== undefined) {
        const d = list[deletion];
        const below = d.floor !== undefined && (d.p.version < d.floor.version || (d.p.version === d.floor.version && !isHeld(d)));
        nextHeads.set(eid, { eid, edition: d.p, rebased: below });
        continue;
      }
      const keep = (c: Cand) => {
        if (c.kind === "everyone") {
          next.everyone = c.role!.permissions;
          next.legacyChannels = c.legacy;
        } else if (c.kind === "live") next.roles.push(c.role!);
      };
      if (picked.kind === "head") {
        keep(list[picked.j]);
        nextHeads.set(eid, { eid, edition: list[picked.j].p, rebased: picked.rebased });
      } else if (picked.kind === "carried") {
        keep(list[picked.j]);
        nextHeads.set(eid, { eid, edition: list[picked.j].p, rebased: false });
      }
    }

    for (const [eid, list] of cands.grants) {
      // Judged on what it names, never on whether those resolve.
      const claims = (c: Cand) => {
        let m: number | undefined;
        for (const rid of c.grant?.roleIds ?? []) {
          if (rid === everyoneHex) continue;
          const r = standing.role(rid);
          if (r) m = m === undefined ? r.position : Math.min(m, r.position);
        }
        return m;
      };
      const judge = (c: Cand, reach: number): Judged => {
        const grant = c.grant;
        if (!grant) return null;
        const ah = c.authorHex;
        const listed = isListed(currentSealed, ah, c.hashHex);
        if ((excluded.has(ah) && !listed) || excluded.has(grant.member)) return null;
        // An uncited edition may add authority, but one naming no Role anyone has published is a strip, and a strip must cite.
        if (!listed && !citationOk(citeHeads, ownerHex, c)) {
          if (c.citation) return null;
          if (grant.roleIds.every((rid) => rid === everyoneHex || !cands.roles.has(rid))) return null;
        }
        const ok = ah === ownerHex ||
          (grant.member !== ownerHex && (supportFor(ah, c, reach) & Permissions.MANAGE_ROLES) !== 0n);
        if (!ok) return null;
        return { rank: claims(c) };
      };
      if (list[0]?.grant && excluded.has(list[0].grant.member)) continue;
      const [picked, gap] = replay(list, standing, ownerHex, cands.complete, voided(list), claims, judge, nextAdmitted);
      if (gap) nextGapped.add(eid);
      let j: number;
      let rebased = false;
      if (picked.kind === "head") {
        j = picked.j;
        rebased = picked.rebased;
      } else if (picked.kind === "carried") j = picked.j;
      else continue;
      nextHeads.set(eid, { eid, edition: list[j].p, rebased });
      const grant = list[j].grant!;
      const ids = grant.roleIds.filter((rid) => rid !== everyoneHex && standing.role(rid) !== undefined);
      // The staff write key rides the Grant; its recipient adopts it off the fold (CORD-04 §3).
      if (ids.length > 0) next.grants.push({ member: grant.member, roleIds: ids, ...(grant.controlWrap !== undefined ? { controlWrap: grant.controlWrap } : {}) });
    }

    const sameHeads = nextHeads.size === heads.size && [...nextHeads].every(([k, h]) => {
      const o = heads.get(k);
      return o !== undefined && o.edition === h.edition && o.rebased === h.rebased;
    });
    const settled = sameHeads && sameRoster(next, accepted) && sameSealed(nextSealed, sealed);
    accepted = next;
    sealed = nextSealed;
    heads = nextHeads;
    gapped = nextGapped;
    if (settled) {
      converged = true;
      break;
    }
  }
  return { roles: accepted, heads: [...heads.values()], sealed, gapped, converged, complete: cands.complete };
}

function sameRoster(a: CommunityRoles, b: CommunityRoles): boolean {
  if (a.everyone !== b.everyone) return false;
  if ((a.legacyChannels ?? []).join() !== (b.legacyChannels ?? []).join() || (a.legacyChannels === undefined) !== (b.legacyChannels === undefined)) return false;
  if (a.roles.length !== b.roles.length || a.grants.length !== b.grants.length) return false;
  for (let i = 0; i < a.roles.length; i++) {
    const x = a.roles[i];
    const y = b.roles[i];
    // The whole Role, as Vector compares rounds.
    if (x.roleId !== y.roleId || x.position !== y.position || x.permissions !== y.permissions || x.name !== y.name || x.rank !== y.rank) return false;
    if (x.color !== y.color || x.display !== y.display || x.mentionable !== y.mentionable || JSON.stringify(x.extra ?? {}) !== JSON.stringify(y.extra ?? {})) return false;
  }
  for (let i = 0; i < a.grants.length; i++) {
    if (a.grants[i].member !== b.grants[i].member || a.grants[i].roleIds.join() !== b.grants[i].roleIds.join()) return false;
  }
  return true;
}

function sameSealed(a: SealedBy, b: SealedBy): boolean {
  if (a.size !== b.size) return false;
  for (const [k, xs] of a) {
    const ys = b.get(k);
    if (!ys || ys.length !== xs.length) return false;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i].position !== ys[i].position || xs[i].bits !== ys[i].bits || [...xs[i].heads].join() !== [...ys[i].heads].join()) return false;
    }
  }
  return true;
}

/** Floors for the Roster's entities, from the heads a tracking reader holds. */
export type RosterFloors = Map<string, RosterFloor>;

/** The floors of the Roster's family: one recorded for another kind's edition at a Roster coordinate floors nothing here. */
function authorityFloors(floors: RosterFloors): RosterFloors {
  const out: RosterFloors = new Map();
  for (const [eid, f] of floors) if (f.vsk === undefined || AUTHORITY_VSKS.has(f.vsk)) out.set(eid, f);
  return out;
}

/**
 * Whether a Community is on the vsk-13 Roster (CORD-04 §2): the reader settled on
 * `@everyone` before, or an owner-rooted vsk-13 fold seats it now.
 */
export function rosterActivated(editions: ParsedEdition[], communityId: Uint8Array, ownerHex: string, floors: RosterFloors, stored: StoredRoster = {}): boolean {
  floors = authorityFloors(floors);
  const everyoneHex = bytesToHex(everyoneLocator(communityId));
  // The `@everyone` this reader held is its persisted floor: a read that misses it can't demote.
  if (floors.has(everyoneHex) || stored.everyone !== undefined) return true;
  const someEveryone = editions.some((e) => e.vsk === VSK_RANKED_ROLE && e.binding && bytesToHex(e.entityId) === everyoneHex);
  if (!someEveryone) return false;
  const sel = selectAuthorized(buildCands(editions, communityId, floors, true, ownerHex, stored), communityId, ownerHex, new Set());
  return sel.heads.some((h) => h.eid === everyoneHex);
}

/**
 * Fold the vsk-13 Roster: Roles, `@everyone`, Grants and Tenures, banned members'
 * editions excluded except what a Tenure keeps. Applies the 100-Role cap after
 * authority is resolved (CORD-04 §2).
 */
export function foldRankedRoster(
  editions: ParsedEdition[],
  communityId: Uint8Array,
  ownerHex: string,
  floors: RosterFloors,
  excluded: ReadonlySet<string> = new Set(),
  stored: StoredRoster = {},
): RosterFold {
  floors = authorityFloors(floors);
  const sel = selectAuthorized(buildCands(editions, communityId, floors, true, ownerHex, stored), communityId, ownerHex, excluded);
  const roles = sel.roles;
  if (roles.roles.length > MAX_ROLES_PER_COMMUNITY) {
    roles.roles.sort((a, b) => (a.roleId < b.roleId ? -1 : 1));
    roles.roles = roles.roles.slice(0, MAX_ROLES_PER_COMMUNITY);
    const kept = new Set(roles.roles.map((r) => r.roleId));
    roles.grants = roles.grants
      .map((g) => ({ ...g, roleIds: g.roleIds.filter((r) => kept.has(r)) }))
      .filter((g) => g.roleIds.length > 0);
  }
  // A withheld `@everyone` keeps the bits the reader held (Vector `stored.everyone`).
  if (roles.everyone === undefined && stored.everyone !== undefined) roles.everyone = stored.everyone;
  // The switch fixes the legacy list (CORD-04 §2): the owner's first `@everyone` edition
  // that reads as one, else the list the reader holds, else the head's.
  const everyoneHex = bytesToHex(everyoneLocator(communityId));
  const switching = editions
    .filter((e) => e.vsk === VSK_RANKED_ROLE && e.binding && e.author === ownerHex && !e.prevHash && bytesToHex(e.entityId) === everyoneHex && parseEveryone(e.content))
    .sort((a, b) => (a.version !== b.version ? (a.version < b.version ? -1 : 1) : bytesToHex(a.rumorId) < bytesToHex(b.rumorId) ? -1 : 1))[0];
  const legacy = (switching && parseEveryone(switching.content)?.legacy) ?? stored.legacyChannels;
  if (legacy) roles.legacyChannels = legacy;
  return { ...sel, roles };
}

/** Whether an overwrite's signer could write it (CORD-04 §8): MANAGE_ROLES and every bit it touches, above its target. */
export function overwriteAuthorized(
  roles: CommunityRoles,
  ownerHex: string,
  banned: ReadonlySet<string>,
  sealed: SealedBy,
  o: Overwrite,
  author: string,
  hashHex: string,
): boolean {
  let rank: number;
  if (o.target.kind === "everyone") rank = BENEATH_EVERY_ROLE;
  else if (o.target.kind === "role") {
    const id = o.target.id;
    const r = roles.roles.find((x) => x.roleId === id);
    if (!r) return false;
    rank = r.position;
  } else {
    const m = o.target.id;
    if (m === ownerHex || banned.has(m)) return false;
    rank = highestPosition(roles, m) ?? BENEATH_EVERY_ROLE;
  }
  if (author === ownerHex) return true;
  if (banned.has(author) && !isListed(sealed, author, hashHex)) return false;
  const support = new RoleIndex(roles).permissionsAbove(author, rank) | sealOf(sealed, author, hashHex, rank);
  return (support & Permissions.MANAGE_ROLES) !== 0n && ((o.allow | o.deny) & ~support) === 0n;
}

function highestPosition(roles: CommunityRoles, member: string): number | undefined {
  const index = new RoleIndex(roles);
  return index.highestPositionAbove(member, Number.MAX_SAFE_INTEGER);
}

/**
 * Whether `author` could write every overwrite in `scopes` as it stands: what a
 * sync swaps all at once (CORD-04 §8).
 */
export function maySwapOverwrites(
  roles: CommunityRoles,
  ownerHex: string,
  author: string,
  scopes: readonly string[],
  sealedOver: (rank: number) => bigint,
): boolean {
  if (author === ownerHex) return true;
  const index = new RoleIndex(roles);
  const held = (rank: number) => index.permissionsAbove(author, rank) | sealedOver(rank);
  if ((held(BENEATH_EVERY_ROLE) & Permissions.MANAGE_ROLES) === 0n) return false;
  return (roles.overwrites ?? []).filter((o) => scopes.includes(o.scope)).every((o) => {
    let rank: number;
    if (o.target.kind === "everyone") rank = BENEATH_EVERY_ROLE;
    else if (o.target.kind === "role") {
      const id = o.target.id;
      rank = roles.roles.find((r) => r.roleId === id)?.position ?? BENEATH_EVERY_ROLE;
    } else rank = index.highestPositionAbove(o.target.id, Number.MAX_SAFE_INTEGER) ?? BENEATH_EVERY_ROLE;
    const support = held(rank);
    return (support & Permissions.MANAGE_ROLES) !== 0n && ((o.allow | o.deny) & ~support) === 0n;
  });
}

/** The bits a member holds through Roles above `bound` (CORD-04 §3). */
export function permissionsAboveIn(roles: CommunityRoles, member: string, bound: number): bigint {
  return new RoleIndex(roles).permissionsAbove(member, bound);
}
