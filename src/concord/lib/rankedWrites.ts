/**
 * Writing the vsk-13 Roster and its Channel rules (CORD-03 §4, CORD-04 §2, §3, §8),
 * as Vector's `create_role_v2`, `edit_role_v2`, `move_role_v2`, `delete_role_v2`,
 * `set_everyone`, `set_overwrite`, `set_channel_sync`, the Category writers and
 * `activate_roles_v2` do: each judged as readers will judge the edition, so a write
 * that would be dropped fails here with a reason instead.
 */

import { ARMADA_CHANNEL_CATEGORY_METADATA_KEY, categoryKey, channelCategory } from "@/concord/lib/channelCategory";
import { ARMADA_CHANNEL_ORDER_METADATA_KEY, channelPosition, compareChannelOrder } from "@/concord/lib/channelOrder";
import { sealChannelMetadata } from "@/concord/lib/channelSeal";
import type { FoldedChannel as FoldedChannelDef, FoldedControl } from "@/concord/lib/control";
import { VSK_CHANNEL } from "@/concord/lib/kinds";
import type { ChannelMetadata, PrivateChannelKey } from "@/concord/lib/types";
import { buildEditionRumor, parseEdition, type AuthorityCitation, type ParsedEdition } from "@/concord/lib/edition";
import { bytesToHex, editionBinding, everyoneLocator, grantLocator, hex32, random32, syncLocator } from "@/concord/lib/derive";
import { denseRanks, rankBetween } from "@/concord/lib/rankKey";
import {
  BENEATH_EVERY_ROLE,
  EVERYONE_DEFAULT,
  highestPosition,
  isAuthorized,
  isManagement,
  MAX_ROLES_PER_COMMUNITY,
  MAX_ROLES_PER_MEMBER,
  OVERWRITABLE,
  permissionsAbove,
  Permissions,
  type MemberGrant,
  type OverwriteTarget,
  type Role,
} from "@/concord/lib/roles";
import {
  everyoneToJSON,
  MAX_LEGACY_CHANNELS,
  maySwapOverwrites,
  overwriteLocator,
  overwriteToJSON,
  rankedRoleDeletedJSON,
  rankedRoleToJSON,
  syncToJSON,
  VSK_ACL,
  VSK_CATEGORY,
  VSK_RANKED_ROLE,
  VSK_SYNC,
} from "@/concord/lib/roster";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { t } from "@/i18n/intl";

/** Beneath every Role: what `@everyone` and a roleless member sit at. */
const BENEATH = BENEATH_EVERY_ROLE;
const NAME_MAX_BYTES = 64;
/** At most this many Categories in a Community (Vector `MAX_CATEGORIES`). */
export const MAX_CATEGORIES = 100;

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Who is writing, and what readers will let them write (Vector `RoleAuthor`). */
export interface RoleAuthor {
  me: string;
  ownerHex: string;
  isOwner: boolean;
  /** Their highest Role's position; the owner is 0. */
  rank: number;
  outranks(position: number): boolean;
  /** MANAGE_ROLES and every bit, from Roles positioned strictly above `reach` (CORD-04 §3). */
  supports(reach: number, bits: bigint): boolean;
}

export function roleAuthor(folded: FoldedControl, me: string): RoleAuthor {
  const ownerHex = folded.ownerHex;
  const isOwner = me === ownerHex;
  if (!isOwner) {
    if (folded.banned.has(me)) throw new Error(t({ id: "rankedWrites.banned", defaultMessage: "You are banned from this community." }));
    if (!isAuthorized(folded.roster, me, ownerHex, Permissions.MANAGE_ROLES)) {
      throw new Error(t({ id: "rankedWrites.needsManageRoles", defaultMessage: "Managing roles needs the Manage roles permission." }));
    }
  }
  const rank = isOwner ? 0 : highestPosition(folded.roster, me) ?? BENEATH;
  return {
    me,
    ownerHex,
    isOwner,
    rank,
    outranks: (position) => isOwner || rank < position,
    supports: (reach, bits) => {
      if (isOwner) return true;
      const support = permissionsAbove(folded.roster, me, reach);
      return (support & Permissions.MANAGE_ROLES) !== 0n && (bits & ~support) === 0n;
    },
  };
}

/** Where Vector parks a legacy Channel's access Role; nothing else is minted at or under it. */
export const ACCESS_ROLE_POSITION = 0xffff_fffe;

/**
 * A legacy (vsk-1) Role as its editor saves it, judged as Vector's `create_role`,
 * `edit_role` and `reorder_roles` judge it. A new Role lands beneath everything but
 * the access band; an existing one keeps its channel, and its author must outrank
 * where it stands and where it goes, holding every bit it carries above both.
 */
export function planRoleSave(folded: FoldedControl, me: string, role: Role): Role {
  const author = roleAuthor(folded, me);
  const name = checkName(role.name);
  const current = folded.roster.roles.find((r) => r.roleId === role.roleId);
  if (!current) {
    if (folded.roster.roles.length >= MAX_ROLES_PER_COMMUNITY) {
      throw new Error(t({ id: "rankedWrites.tooManyRoles", defaultMessage: "A community holds at most {max} roles." }, { max: MAX_ROLES_PER_COMMUNITY }));
    }
    const floor = Math.max(author.rank, ...folded.roster.roles.map((r) => r.position).filter((p) => p < ACCESS_ROLE_POSITION), 0);
    if (floor + 1 >= ACCESS_ROLE_POSITION) {
      throw new Error(t({ id: "rankedWrites.noRoomBeneath", defaultMessage: "There's no room beneath your role for a new one; reorder the roles first." }));
    }
    if (!author.supports(floor + 1, role.permissions)) throw noBits();
    return { ...role, name, position: floor + 1 };
  }
  requireHead(folded, current.roleId.toLowerCase());
  if (!author.outranks(current.position) || !author.outranks(role.position)) {
    throw new Error(
      role.position === current.position
        ? t({ id: "rankedWrites.roleAbove", defaultMessage: "You can only edit roles beneath your own." })
        : t({ id: "rankedWrites.moveAbove", defaultMessage: "You can only move roles beneath your own, to a place beneath your own." }),
    );
  }
  if (!author.supports(Math.min(current.position, role.position), role.permissions)) throw noBits();
  // A scope is a Channel's access list: moving it would re-entitle every holder at once.
  const sameScope =
    role.scope.kind === current.scope.kind && (role.scope.kind === "server" || role.scope.channelId.toLowerCase() === (current.scope as { channelId: string }).channelId.toLowerCase());
  if (!sameScope) throw new Error(t({ id: "rankedWrites.scopeFixed", defaultMessage: "A role's channel can't be changed once it's created." }));
  return { ...role, name };
}

/**
 * The Roles a Grant gives `member` (Vector `set_member_roles`): only for a member and
 * Roles beneath what the author's Manage Roles reaches. Only what changes is judged,
 * and a held id this device can't resolve rides through rather than being stripped.
 */
export function planMemberRoles(folded: FoldedControl, communityId: Uint8Array, me: string, member: string, roleIds: string[]): string[] {
  const author = roleAuthor(folded, me);
  if (member === folded.ownerHex) throw new Error(t({ id: "rankedWrites.ownerStanding", defaultMessage: "The owner's standing isn't granted by roles." }));
  requireHead(folded, bytesToHex(grantLocator(communityId, hex32(member))));
  const memberRank = highestPosition(folded.roster, member) ?? BENEATH;
  if (me === member || !author.supports(memberRank, 0n)) {
    throw new Error(t({ id: "rankedWrites.memberAbove", defaultMessage: "You can only change the roles of members beneath you." }));
  }
  const current = folded.roster.grants.find((g) => g.member === member)?.roleIds ?? [];
  const next = [...new Set(roleIds.map((id) => id.toLowerCase()))];
  const roleOf = (id: string) => folded.roster.roles.find((r) => r.roleId === id);
  for (const id of next.filter((id) => !current.includes(id))) {
    const r = roleOf(id);
    if (!r) throw new Error(t({ id: "rankedWrites.noSuchRole", defaultMessage: "No such role." }));
    if (!author.supports(r.position, 0n)) {
      throw new Error(t({ id: "rankedWrites.cantGrant", defaultMessage: "You can't grant “{role}”: it isn't beneath your own role." }, { role: r.name }));
    }
  }
  for (const id of current.filter((id) => !next.includes(id))) {
    const r = roleOf(id);
    if (!r) next.push(id);
    else if (!author.supports(r.position, 0n)) {
      throw new Error(t({ id: "rankedWrites.cantRemove", defaultMessage: "You can't remove “{role}”: it isn't beneath your own role." }, { role: r.name }));
    }
  }
  if (next.length > MAX_ROLES_PER_MEMBER) {
    throw new Error(t({ id: "rankedWrites.tooManyMemberRoles", defaultMessage: "A member holds at most {max} roles." }, { max: MAX_ROLES_PER_MEMBER }));
  }
  return next;
}

function requireRanked(folded: FoldedControl): void {
  if (!folded.rankedRoster) throw new Error(t({ id: "rankedWrites.legacyRoster", defaultMessage: "This community still uses the legacy roles." }));
  // A read that lost `@everyone` would diff every member into or out of every Channel.
  if (folded.roster.everyone === undefined || folded.everyoneServed === false) throw new Error(t({ id: "rankedWrites.unreadable", defaultMessage: "The community's roles couldn't be read; try again." }));
}

/** The live Roles in rank order, top first (Vector `ranked`). */
export function rankedOrder(folded: FoldedControl): Role[] {
  return folded.roster.roles
    .filter((r) => r.rank !== undefined)
    .sort((a, b) => (a.rank! < b.rank! ? -1 : a.rank! > b.rank! ? 1 : a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
}

/** The next edition at `eid`: version past the head, chained to it, marked, citing the writer's Grant. */
function nextEdition(folded: FoldedControl, communityId: Uint8Array, me: string, vsk: string, eid: Uint8Array, content: string, authority: AuthorityCitation | undefined): NostrRumor {
  const head = folded.heads.get(bytesToHex(eid));
  return buildEditionRumor({
    vsk,
    entityId: eid,
    version: head ? head.version + 1n : 1n,
    ...(head ? { prevHash: head.hash } : {}),
    content,
    actorPubkey: me,
    ...(me !== folded.ownerHex && authority ? { authority } : {}),
    binding: editionBinding(communityId),
  });
}

/** A Role's current head must be in hand before replacing it (Vector `require_role_head`). */
function requireHead(folded: FoldedControl, eidHex: string): void {
  if (folded.heads.has(eidHex) && !folded.headEditions.has(eidHex)) {
    throw new Error(t({ id: "rankedWrites.headUnserved", defaultMessage: "Its current state couldn't be fetched; try again once the relays serve the control plane." }));
  }
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(t({ id: "rankedWrites.roleNeedsName", defaultMessage: "A role needs a name." }));
  if (utf8Len(trimmed) > NAME_MAX_BYTES) throw new Error(t({ id: "rankedWrites.nameTooLong", defaultMessage: "A name is at most 64 bytes." }));
  return trimmed;
}

const noBits = () => new Error(t({ id: "rankedWrites.bitsNotHeld", defaultMessage: "You can't give a role permissions you don't hold." }));

export interface RoleFields {
  name: string;
  color: number;
  permissions: bigint;
  display: boolean;
  mentionable: boolean;
}

/** Mint a Role at the bottom, beneath everything, as in Discord (Vector `create_role_v2`). */
export function planCreateRole(folded: FoldedControl, communityId: Uint8Array, me: string, fields: Pick<RoleFields, "name" | "color" | "permissions"> & Partial<RoleFields>, authority?: AuthorityCitation): { roleId: string; rumor: NostrRumor } {
  requireRanked(folded);
  const author = roleAuthor(folded, me);
  if (folded.roster.roles.length >= MAX_ROLES_PER_COMMUNITY) {
    throw new Error(t({ id: "rankedWrites.tooManyRoles", defaultMessage: "A community holds at most {max} roles." }, { max: MAX_ROLES_PER_COMMUNITY }));
  }
  const name = checkName(fields.name);
  const order = rankedOrder(folded);
  const bottom = order.reduce((m, r) => Math.max(m, r.position), 0) + 1;
  if (!author.supports(bottom, fields.permissions)) throw noBits();
  const rank = rankBetween(order.at(-1)?.rank, undefined);
  if (!rank) throw new Error(t({ id: "rankedWrites.noRoomBottom", defaultMessage: "No room left at the bottom; reorder the roles first." }));
  const roleId = bytesToHex(random32());
  const role: Role = {
    roleId,
    name,
    position: bottom,
    rank,
    permissions: fields.permissions,
    scope: { kind: "server" },
    color: fields.color,
    ...(fields.display ? { display: true } : {}),
    ...(fields.mentionable ? { mentionable: true } : {}),
  };
  return { roleId, rumor: nextEdition(folded, communityId, me, VSK_RANKED_ROLE, hex32(roleId), rankedRoleToJSON(role), authority) };
}

/**
 * Edit a Role in place, keeping its rank and every field another client wrote
 * (Vector `edit_role_v2`). `reduces` says a Tenure must seal its holders first.
 */
export function planEditRole(folded: FoldedControl, communityId: Uint8Array, me: string, roleId: string, fields: RoleFields, authority?: AuthorityCitation): { rumor: NostrRumor; reduces: boolean; holders: string[] } {
  requireRanked(folded);
  const author = roleAuthor(folded, me);
  const current = folded.roster.roles.find((r) => r.roleId === roleId);
  if (!current) throw new Error(t({ id: "rankedWrites.noSuchRole", defaultMessage: "No such role." }));
  requireHead(folded, roleId);
  if (!author.outranks(current.position)) throw new Error(t({ id: "rankedWrites.roleAbove", defaultMessage: "You can only edit roles beneath your own." }));
  if (!author.supports(current.position, fields.permissions)) throw noBits();
  const name = checkName(fields.name);
  const next: Role = {
    ...current,
    name,
    color: fields.color,
    permissions: fields.permissions,
    ...(fields.display ? { display: true } : { display: undefined }),
    ...(fields.mentionable ? { mentionable: true } : { mentionable: undefined }),
  };
  return {
    rumor: nextEdition(folded, communityId, me, VSK_RANKED_ROLE, hex32(roleId), rankedRoleToJSON(next), authority),
    reduces: (current.permissions & ~fields.permissions) !== 0n,
    holders: holdersOf(folded, roleId),
  };
}

export function holdersOf(folded: FoldedControl, roleId: string): string[] {
  return folded.roster.grants.filter((g) => g.roleIds.includes(roleId)).map((g) => g.member);
}

/**
 * Move a Role to `index` in the rank order, 0 the top: one edition on the moved Role,
 * its key minted between its new neighbours (Vector `move_role_in`). `resign` are the
 * Grants the move would orphan, which the mover signs again; `lowers` says its
 * holders' Tenures are owed first.
 */
export function planMoveRole(folded: FoldedControl, communityId: Uint8Array, me: string, roleId: string, index: number, authority?: AuthorityCitation): { rumor: NostrRumor; rank: string; resign: MemberGrant[]; lowers: boolean; holders: string[] } {
  requireRanked(folded);
  const author = roleAuthor(folded, me);
  const current = folded.roster.roles.find((r) => r.roleId === roleId);
  if (!current) throw new Error(t({ id: "rankedWrites.noSuchRole", defaultMessage: "No such role." }));
  requireHead(folded, roleId);
  const others = rankedOrder(folded).filter((r) => r.roleId !== roleId);
  const at = Math.min(Math.max(0, index), others.length);
  const above = at > 0 ? others[at - 1] : undefined;
  const below = others[at];
  const spot = above ? above.position + 1 : 1;
  if (!author.outranks(current.position) || !(author.isOwner || (above !== undefined && author.rank <= above.position))) {
    throw new Error(t({ id: "rankedWrites.moveAbove", defaultMessage: "You can only move roles beneath your own, to a place beneath your own." }));
  }
  if (!author.supports(Math.min(current.position, spot), current.permissions)) {
    throw new Error(t({ id: "rankedWrites.moveBits", defaultMessage: "You can't move “{role}”: it has permissions you don't hold." }, { role: current.name }));
  }
  const rank = rankBetween(above?.rank, below?.rank);
  if (!rank) throw new Error(t({ id: "rankedWrites.noRoomBetween", defaultMessage: "No room between those roles; move a neighbour first." }));
  // A Grant is judged on the Role's rank as it stands: moving it above the Grant's signer takes it from the member.
  const resign = folded.roster.grants.filter((g) => {
    if (!g.roleIds.includes(roleId)) return false;
    const signer = folded.headEditions.get(bytesToHex(grantLocator(communityId, hex32(g.member))))?.author;
    if (!signer || signer === author.ownerHex) return false;
    const signerRank = highestPosition(folded.roster, signer);
    return signerRank === undefined || signerRank >= spot;
  });
  for (const g of resign) {
    const memberRank = highestPosition(folded.roster, g.member) ?? BENEATH;
    const reach = Math.min(spot, memberRank, ...g.roleIds.map((id) => folded.roster.roles.find((r) => r.roleId === id)?.position ?? BENEATH));
    if (!author.outranks(memberRank) || !author.supports(reach, 0n)) {
      throw new Error(t({ id: "rankedWrites.moveOrphans", defaultMessage: "Moving “{role}” there would take it from members you can't give it to." }, { role: current.name }));
    }
  }
  return {
    rumor: nextEdition(folded, communityId, me, VSK_RANKED_ROLE, hex32(roleId), rankedRoleToJSON({ ...current, rank }), authority),
    rank,
    resign: resign.map((g) => ({ member: g.member, roleIds: [...g.roleIds] })),
    lowers: current.rank !== undefined && current.rank < rank,
    holders: holdersOf(folded, roleId),
  };
}

/**
 * The moves that reorder the Roles to `ordered`, top first, Roles it leaves out keeping
 * their order after it (Vector `reorder_roles_v2`): the longest run already in order
 * stays put and each other Role moves once, to just after its predecessor.
 */
export function planReorder(folded: FoldedControl, ordered: readonly string[]): Array<{ roleId: string; index: number }> {
  const cur = rankedOrder(folded).map((r) => r.roleId);
  const target = [...ordered.filter((id) => cur.includes(id)), ...cur.filter((id) => !ordered.includes(id))];
  const seq = target.map((id) => cur.indexOf(id));
  const n = seq.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
  }
  const keep = new Array<boolean>(n).fill(false);
  // The longest run, the earliest among equals.
  let at = -1;
  for (let i = 0; i < n; i++) if (at < 0 || len[i] > len[at]) at = i;
  while (at >= 0) {
    keep[at] = true;
    at = prev[at];
  }
  const moves: Array<{ roleId: string; index: number }> = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    const id = target[i];
    const rest = cur.filter((c) => c !== id);
    const index = i === 0 ? 0 : (() => {
      const p = rest.indexOf(target[i - 1]);
      return p < 0 ? 0 : p + 1;
    })();
    cur.splice(cur.indexOf(id), 1);
    cur.splice(Math.min(index, cur.length), 0, id);
    moves.push({ roleId: id, index });
  }
  return moves;
}

/** A rumor this writer built, as a reader parses it. */
export function parsedOf(rumor: NostrRumor): ParsedEdition {
  return parseEdition({ rumorId: rumor.id, author: rumor.pubkey, kind: rumor.kind, content: rumor.content, tags: rumor.tags, ms: rumor.created_at * 1000, createdAt: rumor.created_at } as OpenedEvent);
}

/**
 * Carry editions this writer just published into its fold, as the next fold will read
 * them: their heads advance, and a moved Role takes its new rank, the Roster's positions
 * dense-ranked again (Vector `move_role_in`'s carry), so the next move is judged on it.
 */
export function carryForward(folded: FoldedControl, rumors: readonly NostrRumor[], moved?: { roleId: string; rank: string }): FoldedControl {
  const heads = new Map(folded.heads);
  const headEditions = new Map(folded.headEditions);
  for (const rumor of rumors) {
    const p = parsedOf(rumor);
    const eid = bytesToHex(p.entityId);
    heads.set(eid, { version: p.version, hash: p.selfHash, rumorId: bytesToHex(p.rumorId), author: p.author, vsk: p.vsk });
    headEditions.set(eid, p);
  }
  let roles = folded.roster.roles;
  if (moved) {
    roles = roles.map((r) => (r.roleId === moved.roleId ? { ...r, rank: moved.rank } : r));
    const ranks = denseRanks(roles.flatMap((r) => (r.rank !== undefined ? [r.rank] : [])));
    roles = roles.map((r) => (r.rank !== undefined ? { ...r, position: ranks.get(r.rank) ?? r.position } : r));
  }
  return { ...folded, heads, headEditions, roster: { ...folded.roster, roles } };
}

/** Delete a Role: terminal, it leaves every holder and frees its slot (Vector `delete_role_v2`). */
export function planDeleteRole(folded: FoldedControl, communityId: Uint8Array, me: string, roleId: string, authority?: AuthorityCitation): { rumor: NostrRumor; holders: string[] } {
  requireRanked(folded);
  const author = roleAuthor(folded, me);
  const current = folded.roster.roles.find((r) => r.roleId === roleId);
  if (!current) throw new Error(t({ id: "rankedWrites.noSuchRole", defaultMessage: "No such role." }));
  requireHead(folded, roleId);
  if (!author.outranks(current.position) || !author.supports(current.position, 0n)) {
    throw new Error(t({ id: "rankedWrites.deleteAbove", defaultMessage: "You can only delete roles beneath your own." }));
  }
  return { rumor: nextEdition(folded, communityId, me, VSK_RANKED_ROLE, hex32(roleId), rankedRoleDeletedJSON(roleId), authority), holders: holdersOf(folded, roleId) };
}

/** Set what `@everyone` holds; its editor holds every bit through their Roles (Vector `set_everyone`). */
export function planSetEveryone(folded: FoldedControl, communityId: Uint8Array, me: string, permissions: bigint, authority?: AuthorityCitation): NostrRumor {
  if (me !== folded.ownerHex) requireRanked(folded);
  else if (!folded.rankedRoster) throw new Error(t({ id: "rankedWrites.legacyRoster", defaultMessage: "This community still uses the legacy roles." }));
  const author = roleAuthor(folded, me);
  if (!author.supports(BENEATH, permissions)) throw new Error(t({ id: "rankedWrites.everyoneBits", defaultMessage: "You can't give everyone permissions you don't hold." }));
  return nextEdition(folded, communityId, me, VSK_RANKED_ROLE, everyoneLocator(communityId), everyoneToJSON(permissions, folded.roster.legacyChannels), authority);
}

/** The rank an overwrite's target sits at (CORD-04 §8). */
function targetRank(folded: FoldedControl, target: OverwriteTarget): number {
  if (target.kind === "everyone") return BENEATH;
  if (target.kind === "role") {
    const role = folded.roster.roles.find((r) => r.roleId === target.id);
    if (!role) throw new Error(t({ id: "rankedWrites.noSuchRole", defaultMessage: "No such role." }));
    return role.position;
  }
  if (target.id === folded.ownerHex) throw new Error(t({ id: "rankedWrites.ownerEverywhere", defaultMessage: "The owner holds every permission everywhere." }));
  return highestPosition(folded.roster, target.id) ?? BENEATH;
}

/**
 * Set, or with no bits clear, one overwrite on a Channel or Category (Vector `set_overwrite`):
 * MANAGE_ROLES and every bit it touches, the ones it clears included, held above its target.
 */
export function planOverwrite(folded: FoldedControl, communityId: Uint8Array, me: string, held: ReadonlySet<string>, scope: string, target: OverwriteTarget, allow: bigint, deny: bigint, authority?: AuthorityCitation): NostrRumor {
  requireRanked(folded);
  const author = roleAuthor(folded, me);
  if (((allow | deny) & ~OVERWRITABLE) !== 0n) throw new Error(t({ id: "rankedWrites.notOverwritable", defaultMessage: "Only channel permissions can be set per channel." }));
  const scopeHex = scope.toLowerCase();
  const channel = folded.channels.get(scopeHex);
  if ((!channel || channel.deleted) && !(folded.categories?.get(scopeHex) && !folded.categories.get(scopeHex)!.deleted)) {
    throw new Error(t({ id: "rankedWrites.noSuchScope", defaultMessage: "No such channel or category." }));
  }
  // Keys follow the change, so a private Channel this device can't key can't be settled.
  for (const c of folded.channels.values()) {
    if (c.deleted || !c.isPrivate || held.has(c.channelIdHex)) continue;
    if (c.channelIdHex === scopeHex || folded.roster.syncs?.[c.channelIdHex] === scopeHex) throw unkeyed();
  }
  const rank = targetRank(folded, target);
  const current = (folded.roster.overwrites ?? []).find((o) => o.scope === scopeHex && sameTarget(o.target, target));
  const changed = (allow ^ (current?.allow ?? 0n)) | (deny ^ (current?.deny ?? 0n));
  if (!author.supports(rank, allow | deny | changed)) {
    throw new Error(t({ id: "rankedWrites.overwriteBits", defaultMessage: "You can only set permissions you hold, for roles and members beneath you." }));
  }
  const eid = overwriteLocator(communityId, { scope: scopeHex, target });
  if (!author.isOwner) requireHead(folded, bytesToHex(eid));
  return nextEdition(folded, communityId, me, VSK_ACL, eid, overwriteToJSON({ scope: scopeHex, target, allow, deny }), authority);
}

const unkeyed = () => new Error(t({ id: "rankedWrites.unkeyedPrivate", defaultMessage: "You can only change who reads a private channel you can read." }));

export function sameTarget(a: OverwriteTarget, b: OverwriteTarget): boolean {
  return a.kind === b.kind && (a.kind === "everyone" || (b.kind !== "everyone" && a.id.toLowerCase() === b.id.toLowerCase()));
}

/**
 * Sync a Channel to `category`'s overwrites, or back to its own (Vector `set_channel_sync`):
 * every rule on both sides swaps at once, so the writer must be able to write them all.
 */
export function planSync(folded: FoldedControl, communityId: Uint8Array, me: string, held: ReadonlySet<string>, channelIdHex: string, category: string | undefined, authority?: AuthorityCitation): NostrRumor {
  requireRanked(folded);
  const author = roleAuthor(folded, me);
  const ch = channelIdHex.toLowerCase();
  const def = folded.channels.get(ch);
  if (!def || def.deleted) throw new Error(t({ id: "rankedWrites.noSuchChannel", defaultMessage: "No such channel." }));
  if (def.isPrivate && !held.has(ch)) throw unkeyed();
  const cat = category?.toLowerCase();
  if (cat && !(folded.categories?.get(cat) && !folded.categories.get(cat)!.deleted)) {
    throw new Error(t({ id: "rankedWrites.noSuchCategory", defaultMessage: "No such category." }));
  }
  const scopes = [ch, ...(cat ? [cat] : []), ...(folded.roster.syncs?.[ch] ? [folded.roster.syncs[ch]] : [])];
  if (!maySwapOverwrites(folded.roster, folded.ownerHex, me, scopes, () => 0n)) {
    throw new Error(t({ id: "rankedWrites.syncSwaps", defaultMessage: "Syncing swaps permissions you can't set; ask someone who can." }));
  }
  const eid = syncLocator(communityId, hex32(ch));
  if (!author.isOwner) requireHead(folded, bytesToHex(eid));
  return nextEdition(folded, communityId, me, VSK_SYNC, eid, syncToJSON(ch, cat), authority);
}

function requireChannelManager(folded: FoldedControl, me: string): void {
  if (me !== folded.ownerHex && !isAuthorized(folded.roster, me, folded.ownerHex, Permissions.MANAGE_CHANNELS)) {
    throw new Error(t({ id: "rankedWrites.needsManageChannels", defaultMessage: "Managing channels needs the Manage channels permission." }));
  }
}

const liveCategories = (folded: FoldedControl) => [...(folded.categories?.values() ?? [])].filter((c) => !c.deleted);

/** Code point order, which is UTF-8 byte order, not UTF-16's. */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length - y.length;
}

/** Categories in sidebar order: keyless last, then by rank key, name and id (CORD-03 §4, Vector `sidebar`). */
export function categoryOrder(folded: FoldedControl): ReturnType<typeof liveCategories> {
  return liveCategories(folded).sort(
    (a, b) =>
      Number(a.position === undefined) - Number(b.position === undefined) ||
      (a.position !== undefined && b.position !== undefined ? byCodePoint(a.position, b.position) : 0) ||
      byCodePoint(a.name, b.name) ||
      (a.idHex < b.idHex ? -1 : a.idHex > b.idHex ? 1 : 0),
  );
}

function categoryJSON(name: string, position: string | undefined, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, name, ...(position ? { position } : {}) });
}

/** Create a Category at the bottom of the sidebar (Vector `create_category`). */
export function planCreateCategory(folded: FoldedControl, communityId: Uint8Array, me: string, name: string, authority?: AuthorityCitation): { idHex: string; rumor: NostrRumor } {
  requireRanked(folded);
  requireChannelManager(folded, me);
  if (liveCategories(folded).length >= MAX_CATEGORIES) {
    throw new Error(t({ id: "rankedWrites.tooManyCategories", defaultMessage: "A community holds at most {max} categories." }, { max: MAX_CATEGORIES }));
  }
  const trimmed = name.trim();
  if (!trimmed) throw new Error(t({ id: "rankedWrites.categoryNeedsName", defaultMessage: "A category needs a name." }));
  const last = liveCategories(folded).map((c) => c.position).filter((p): p is string => p !== undefined).sort().at(-1);
  const position = rankBetween(last, undefined);
  if (!position) throw new Error(t({ id: "rankedWrites.noRoomCategory", defaultMessage: "No room for another category." }));
  const idHex = bytesToHex(random32());
  return { idHex, rumor: nextEdition(folded, communityId, me, VSK_CATEGORY, hex32(idHex), categoryJSON(trimmed, position), authority) };
}

/** Rename a Category, keeping its place (Vector `rename_category`). */
export function planRenameCategory(folded: FoldedControl, communityId: Uint8Array, me: string, idHex: string, name: string, authority?: AuthorityCitation): NostrRumor {
  requireRanked(folded);
  requireChannelManager(folded, me);
  const current = folded.categories?.get(idHex.toLowerCase());
  if (!current || current.deleted) throw new Error(t({ id: "rankedWrites.noSuchCategory", defaultMessage: "No such category." }));
  const trimmed = name.trim();
  if (!trimmed) throw new Error(t({ id: "rankedWrites.categoryNeedsName", defaultMessage: "A category needs a name." }));
  return nextEdition(folded, communityId, me, VSK_CATEGORY, hex32(current.idHex), categoryJSON(trimmed, current.position, current.extra), authority);
}

/** Delete a Category: terminal; its Channels render uncategorized (Vector `delete_category`). */
export function planDeleteCategory(folded: FoldedControl, communityId: Uint8Array, me: string, idHex: string, authority?: AuthorityCitation): NostrRumor {
  requireRanked(folded);
  requireChannelManager(folded, me);
  const current = folded.categories?.get(idHex.toLowerCase());
  if (!current || current.deleted) throw new Error(t({ id: "rankedWrites.noSuchCategory", defaultMessage: "No such category." }));
  return nextEdition(folded, communityId, me, VSK_CATEGORY, hex32(current.idHex), JSON.stringify({ deleted: true }), authority);
}

/**
 * Move a Category to `index` among the Categories, 0 the top (Vector `move_category`):
 * a neighbour with no key, or one out of order, is keyed first.
 */
export function planMoveCategory(folded: FoldedControl, communityId: Uint8Array, me: string, idHex: string, index: number, authority?: AuthorityCitation): NostrRumor[] {
  requireRanked(folded);
  requireChannelManager(folded, me);
  const current = folded.categories?.get(idHex.toLowerCase());
  if (!current || current.deleted) throw new Error(t({ id: "rankedWrites.noSuchCategory", defaultMessage: "No such category." }));
  const others = categoryOrder(folded).filter((c) => c.idHex !== current.idHex);
  const rumors: NostrRumor[] = [];
  const keys: string[] = [];
  for (const c of others) {
    const last = keys.at(-1);
    if (c.position !== undefined && (last === undefined || last < c.position)) {
      keys.push(c.position);
      continue;
    }
    const key = rankBetween(last, undefined);
    if (!key) throw new Error(t({ id: "rankedWrites.noRoomCategory", defaultMessage: "No room for another category." }));
    rumors.push(nextEdition(folded, communityId, me, VSK_CATEGORY, hex32(c.idHex), categoryJSON(c.name, key, c.extra), authority));
    keys.push(key);
  }
  const at = Math.min(Math.max(0, index), keys.length);
  const position = rankBetween(at > 0 ? keys[at - 1] : undefined, keys[at]);
  if (!position) throw new Error(t({ id: "rankedWrites.noRoomBetweenCategories", defaultMessage: "No room between those categories." }));
  rumors.push(nextEdition(folded, communityId, me, VSK_CATEGORY, hex32(current.idHex), categoryJSON(current.name, position, current.extra), authority));
  return rumors;
}

/**
 * Move a Community from the legacy Roster to the vsk-13 one (CORD-04 §2, Vector
 * `activate_roles_v2`), the owner alone: each legacy Role continues its own chain as a
 * ranked Role, peers kept peers; a Channel's access Role becomes a Role its Private
 * Channel lets through; and `@everyone` goes last, listing every Channel that stands.
 */
export function planActivation(
  folded: FoldedControl,
  communityId: Uint8Array,
  me: string,
  everyone: bigint = EVERYONE_DEFAULT,
  held: readonly PrivateChannelKey[] = [],
): { rumors: NostrRumor[]; unfiled: string[] } {
  if (me !== folded.ownerHex) throw new Error(t({ id: "rankedWrites.ownerSwitches", defaultMessage: "Only the owner moves a community to ranked roles." }));
  if (folded.rankedRoster) throw new Error(t({ id: "rankedWrites.alreadyRanked", defaultMessage: "This community already uses ranked roles." }));
  const standing = [...folded.channels.values()].filter((c) => !c.deleted).map((c) => c.channelIdHex).sort();
  if (standing.length > MAX_LEGACY_CHANNELS) {
    throw new Error(t({ id: "rankedWrites.tooManyChannelsToSwitch", defaultMessage: "A community moves to ranked roles with at most {max} channels." }, { max: MAX_LEGACY_CHANNELS }));
  }
  const legacy = [...folded.roster.roles].sort((a, b) => a.position - b.position || (a.roleId < b.roleId ? -1 : 1));
  const rumors: NostrRumor[] = [];
  let last: string | undefined;
  let prevPosition: number | undefined;
  for (const role of legacy) {
    requireHead(folded, role.roleId);
    // Legacy peers stay peers.
    const rank = last !== undefined && prevPosition === role.position ? last : rankBetween(last, undefined);
    if (!rank) throw new Error(t({ id: "rankedWrites.tooManyToCarry", defaultMessage: "Too many roles to carry across." }));
    // A managing Role predates the channel bits; it keeps managing channel access.
    const permissions = (role.permissions & Permissions.MANAGE_ROLES) !== 0n ? role.permissions | EVERYONE_DEFAULT : role.permissions;
    // The legacy member list set admins apart; they stay apart.
    const display = role.display === true || isManagement(role.permissions);
    rumors.push(nextEdition(folded, communityId, me, VSK_RANKED_ROLE, hex32(role.roleId), rankedRoleToJSON({ ...role, rank, permissions, scope: { kind: "server" }, ...(display ? { display: true } : {}) }), undefined));
    last = rank;
    prevPosition = role.position;
  }
  // A Channel's access Role becomes a Role its Private Channel lets through.
  const scoped = legacy
    .flatMap((role) => (role.scope.kind === "channel" && /^[0-9a-fA-F]{64}$/.test(role.scope.channelId) ? [{ role, scope: role.scope.channelId.toLowerCase() }] : []))
    .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  for (const { role, scope } of scoped) {
    const o = { scope, target: { kind: "role" as const, id: role.roleId }, allow: Permissions.VIEW_CHANNEL, deny: 0n };
    rumors.push(nextEdition(folded, communityId, me, VSK_ACL, overwriteLocator(communityId, o), overwriteToJSON(o), undefined));
  }
  rumors.push(nextEdition(folded, communityId, me, VSK_RANKED_ROLE, everyoneLocator(communityId), everyoneToJSON(everyone, standing), undefined));
  const carried = planSidebarCarry(folded, communityId, me, held);
  return { rumors: [...rumors, ...carried.rumors], unfiled: carried.unfiled };
}

/**
 * Carry Armada's own sidebar onto the vsk-13 one at the switch (CORD-03 §2, §4): each
 * `armada.category` name becomes a Category in the order the sidebar shows it, and each
 * Channel files under its id with a rank key keeping its place; the `armada.category`
 * and `armada.order` fields go, so nothing reads the old arrangement again. A Private
 * Channel whose key isn't held can't be sealed again, so it comes back in `unfiled`.
 */
export function planSidebarCarry(
  folded: FoldedControl,
  communityId: Uint8Array,
  me: string,
  held: readonly PrivateChannelKey[],
): { rumors: NostrRumor[]; unfiled: string[] } {
  const standing = [...folded.channels.values()]
    .filter((c) => !c.deleted && !c.sealed)
    .sort((a, b) => compareChannelOrder({ position: channelPosition(a.metadata), name: a.name }, { position: channelPosition(b.metadata), name: b.name }));
  const groups = new Map<string, { name: string; channels: FoldedChannelDef[] }>();
  const loose: FoldedChannelDef[] = [];
  for (const c of standing) {
    const name = channelCategory(c.metadata);
    if (!name) {
      loose.push(c);
      continue;
    }
    const key = categoryKey(name);
    const group = groups.get(key) ?? { name, channels: [] };
    group.channels.push(c);
    groups.set(key, group);
  }
  if (groups.size > MAX_CATEGORIES) {
    throw new Error(t({ id: "rankedWrites.tooManyCategories", defaultMessage: "A community holds at most {max} categories." }, { max: MAX_CATEGORIES }));
  }
  const rumors: NostrRumor[] = [];
  const unfiled: string[] = [];
  const keys = (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(rankBetween(out.at(-1), undefined)!);
    return out;
  };
  const file = (channels: FoldedChannelDef[], categoryId: string | undefined) => {
    const ranks = keys(channels.length);
    channels.forEach((c, i) => {
      const { category: _category, position: _position, custom, ...rest } = c.metadata;
      const kept = isRecord(custom) ? Object.fromEntries(Object.entries(custom).filter(([k]) => k !== ARMADA_CHANNEL_CATEGORY_METADATA_KEY && k !== ARMADA_CHANNEL_ORDER_METADATA_KEY)) : undefined;
      const meta: ChannelMetadata = { ...rest, ...(kept && Object.keys(kept).length > 0 ? { custom: kept } : {}), ...(categoryId ? { category: categoryId } : {}), position: ranks[i] };
      const eid = hex32(c.channelIdHex);
      if (!c.isPrivate) {
        rumors.push(nextEdition(folded, communityId, me, VSK_CHANNEL, eid, JSON.stringify(meta), undefined));
        return;
      }
      // On the vsk-13 Roster a Private Channel's details are sealed (CORD-03 §2).
      const key = held.find((k) => bytesToHex(k.id) === c.channelIdHex);
      if (!key) {
        unfiled.push(c.channelIdHex);
        return;
      }
      const head = folded.heads.get(c.channelIdHex);
      rumors.push(nextEdition(folded, communityId, me, VSK_CHANNEL, eid, sealChannelMetadata(meta, key.key, key.id, key.epoch, head ? bytesToHex(head.hash) : undefined), undefined));
    });
  };
  file(loose, undefined);
  const catRanks = keys(groups.size);
  [...groups.values()].forEach((g, i) => {
    const idHex = bytesToHex(random32());
    rumors.push(nextEdition(folded, communityId, me, VSK_CATEGORY, hex32(idHex), categoryJSON(g.name, catRanks[i]), undefined));
    file(g.channels, idHex);
  });
  return { rumors, unfiled };
}
