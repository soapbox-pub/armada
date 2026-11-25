/**
 * "Require approval to post": `@everyone` loses posting, a Verified Role holds it, and
 * approving a member is a Grant of that Role (CORD-04 §3). Every Channel @everyone can't
 * post in is restricted, so the gate is the writer key's (CORD-03 §1), not a reader's
 * courtesy. Nothing here is new protocol: it is Roles, `@everyone` and overwrites.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import type { FoldedControl } from "@/concord/lib/control";
import { bytesToHex } from "@/concord/lib/derive";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { BENEATH_EVERY_ROLE, effectivePermissions, highestPosition, isAuthorized, permissionsAbove, Permissions, rolesOf, type Role } from "@/concord/lib/roles";

/** What the gate takes from `@everyone` and gives the Verified Role. */
export const GATE_BITS = Permissions.SEND_MESSAGES | Permissions.SEND_IN_THREADS | Permissions.ATTACH_FILES;

/** How many Verified Roles a Community can go through; deleting one retires its id for good (CORD-04 §2). */
const GATE_ROLE_SLOTS = 16;

/**
 * The Verified Role's id: fixed per Community, so two moderators turning the gate on
 * mint one Role. A deleted one's id is never reused, so each slot is tried in turn.
 */
export function gateRoleId(communityIdHex: string, slot: number): string {
  return bytesToHex(sha256(new TextEncoder().encode(`armada/role/verified/${communityIdHex.toLowerCase()}/${slot}`)));
}

/** The live Verified Role, if one stands. */
export function gateRole(folded: FoldedControl, communityIdHex: string): Role | undefined {
  for (let slot = 0; slot < GATE_ROLE_SLOTS; slot++) {
    const id = gateRoleId(communityIdHex, slot);
    const role = folded.roster.roles.find((r) => r.roleId === id);
    if (role) return role;
  }
  return undefined;
}

/** The id a new Verified Role takes: the first slot no edition has used. */
export function freeGateRoleId(folded: FoldedControl, communityIdHex: string): string | undefined {
  for (let slot = 0; slot < GATE_ROLE_SLOTS; slot++) {
    const id = gateRoleId(communityIdHex, slot);
    if (!folded.heads.has(id) && !folded.roster.roles.some((r) => r.roleId === id)) return id;
  }
  return undefined;
}

export interface GateState {
  /** Whether posting is held back for approval now. */
  on: boolean;
  role?: Role;
}

export function gateState(folded: FoldedControl | undefined, communityIdHex: string): GateState {
  if (!folded?.rankedRoster || folded.roster.everyone === undefined) return { on: false };
  const role = gateRole(folded, communityIdHex);
  const on = role !== undefined && (role.permissions & Permissions.SEND_MESSAGES) !== 0n && (folded.roster.everyone & Permissions.SEND_MESSAGES) === 0n;
  return { on, ...(role ? { role } : {}) };
}

/** Whether `member` may post somewhere by their server-wide permissions; a Channel's overwrite can still open one. */
export function postsAnywhere(folded: FoldedControl, member: string): boolean {
  return member === folded.ownerHex || (effectivePermissions(folded.roster, member) & Permissions.SEND_MESSAGES) !== 0n;
}

/** Whether `me` may grant the Verified Role: Manage Roles through a Role ranked above it (CORD-04 §3). */
export function mayApprove(folded: FoldedControl | undefined, me: string | undefined, role: Role | undefined): boolean {
  if (!folded || !me || !role || folded.banned.has(me)) return false;
  if (me === folded.ownerHex) return true;
  return (permissionsAbove(folded.roster, me, role.position) & Permissions.MANAGE_ROLES) !== 0n;
}

/**
 * The welcome Channels: public ones, not synced to a Category, whose own `@everyone`
 * overwrite allows posting, which is how the gate leaves a door open. Read off the
 * Roster, so every moderator's device sees the same ones with nothing stored beside it.
 */
export function welcomeChannels(folded: FoldedControl): string[] {
  const out: string[] = [];
  for (const [idHex, channel] of folded.channels) {
    if (channel.deleted || channel.isPrivate || folded.roster.syncs?.[idHex.toLowerCase()]) continue;
    const own = folded.roster.overwrites?.find((o) => o.scope === idHex.toLowerCase() && o.target.kind === "everyone");
    if (own && (own.allow & Permissions.SEND_MESSAGES) !== 0n) out.push(idHex);
  }
  return out.sort();
}

/** Whether `me` may turn the gate on or off: editing `@everyone` takes Manage Roles (CORD-04 §2). */
export function maySwitchGate(folded: FoldedControl | undefined, me: string | undefined): boolean {
  if (!folded?.rankedRoster || !me || folded.banned.has(me)) return false;
  return isAuthorized(folded.roster, me, folded.ownerHex, Permissions.MANAGE_ROLES);
}

/** Joined members the gate holds back: no posting of their own, not banned, not the owner. */
export function awaitingApproval(folded: FoldedControl, coalesced: ReadonlyMap<string, CoalescedMember>): Set<string> {
  const out = new Set<string>();
  for (const m of coalesced.values()) {
    if (m.state !== "join" || folded.banned.has(m.pubkey)) continue;
    if (!postsAnywhere(folded, m.pubkey)) out.add(m.pubkey);
  }
  return out;
}

/**
 * Whether `me` still posts once `@everyone` can't: the owner, or a Role of theirs posts.
 * Nobody grants themselves a Role (CORD-04 §3), so otherwise the switch silences its author.
 */
export function keepsPosting(folded: FoldedControl, me: string): boolean {
  return me === folded.ownerHex || rolesOf(folded.roster, me).some((r) => (r.permissions & Permissions.SEND_MESSAGES) !== 0n);
}

/** Whether `me` may change `member`'s Roles at all: strictly above them, with Manage Roles (CORD-04 §3). */
function outranksMemberForGrant(folded: FoldedControl, me: string, member: string): boolean {
  if (member === me || member === folded.ownerHex) return false;
  if (me === folded.ownerHex) return true;
  const rank = highestPosition(folded.roster, member) ?? BENEATH_EVERY_ROLE;
  return (permissionsAbove(folded.roster, me, rank) & Permissions.MANAGE_ROLES) !== 0n;
}

/**
 * Who keeps posting when the gate goes on: members seen posting since `sinceMs`, and
 * every member already holding a Role, unless a Role of theirs already posts. Everyone
 * else waits for approval. A member already holding Verified is left out, so a run cut
 * short picks up where it stopped; `unreachable` are those `me` can't grant to, who need
 * someone ranked above them.
 */
export function carriedOver(
  folded: FoldedControl,
  me: string,
  members: readonly string[],
  observed: ReadonlyMap<string, number>,
  sinceMs: number,
  roleId: string | undefined,
): { grant: string[]; unreachable: string[]; waiting: number } {
  const holds = (pk: string) => folded.roster.grants.find((g) => g.member === pk)?.roleIds ?? [];
  const rolePosts = (pk: string) => rolesOf(folded.roster, pk).some((r) => (r.permissions & Permissions.SEND_MESSAGES) !== 0n);
  const unposting = members
    .filter((pk) => pk !== folded.ownerHex && pk !== me && !folded.banned.has(pk))
    .filter((pk) => !(roleId && holds(pk).includes(roleId)) && !rolePosts(pk));
  const kept = (pk: string) => (observed.get(pk) ?? 0) >= sinceMs || holds(pk).length > 0;
  const owed = unposting.filter(kept).sort();
  return {
    grant: owed.filter((pk) => outranksMemberForGrant(folded, me, pk)),
    unreachable: owed.filter((pk) => !outranksMemberForGrant(folded, me, pk)),
    waiting: unposting.filter((pk) => !kept(pk)).length,
  };
}
