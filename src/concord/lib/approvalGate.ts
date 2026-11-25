/**
 * "Require approval to post": `@everyone` loses posting, reacting and calls, a plain Role
 * holds them, and approving a member is a Grant of that Role (CORD-04 §3). Every Channel
 * `@everyone` can do none of the three in is Locked, so the gate is the writer key's
 * (CORD-03 §1), not a reader's courtesy. Nothing here is new protocol, and nothing is
 * stored beside the Roster: which Role approves is read off the permissions, as every
 * member's device can.
 */

import { isEntitled } from "@/concord/lib/channelAccess";
import type { FoldedControl } from "@/concord/lib/control";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { BENEATH_EVERY_ROLE, effectivePermissions, highestPosition, permissionsAbove, Permissions, rolesOf, STAFF_MASK, type Role } from "@/concord/lib/roles";

/** What `@everyone` lacks while the gate reads as on. */
export const GATE_BITS = Permissions.SEND_MESSAGES | Permissions.SEND_IN_THREADS | Permissions.ATTACH_FILES;

/** What a gate may have left `@everyone` and still read as on: an older build's, or a bot's. */
export const GATE_EXTRAS = Permissions.ADD_REACTIONS | Permissions.CONNECT;

/**
 * What turning the gate on takes from `@everyone` and gives the approval Role: reacting
 * and joining calls go with posting.
 */
export const GATE_TAKES = GATE_BITS | GATE_EXTRAS;

/** What a welcome Channel gives `@everyone` back: the gate's bits but its calls. */
export const WELCOME_OPENS = GATE_TAKES & ~Permissions.CONNECT;

/** Powers over other members or the Community: a Role holding any is staff's, not the way in. */
const MANAGEMENT_BITS =
  STAFF_MASK |
  Permissions.KICK |
  Permissions.MANAGE_MESSAGES |
  Permissions.MUTE_MEMBERS |
  Permissions.DEAFEN_MEMBERS |
  Permissions.MOVE_MEMBERS |
  Permissions.MODERATE_MEMBERS |
  Permissions.MANAGE_NICKNAMES;

/** A Role that only lets its holders take part: no power over anyone. */
export function isPlainRole(role: Role): boolean {
  return (role.permissions & MANAGEMENT_BITS) === 0n;
}

export interface GateState {
  /** Whether posting is held back for approval, read off the shape turning it on leaves. */
  on: boolean;
  /**
   * `@everyone` can't post, but not in the shape approval leaves: an announcement-only
   * Community, say. Nobody is awaiting approval there, and there is nothing to turn off.
   */
  restricted: boolean;
  /**
   * The Roles approving grants: plain ones that post, ranked lowest first. Several
   * means Approve asks which.
   */
  roles: Role[];
}

const OFF: GateState = { on: false, restricted: false, roles: [] };

/**
 * Turning approval on takes every gate bit from `@everyone` and leaves a plain Role
 * posting; that shape, not `@everyone` merely lacking Send, is what reads as on, since
 * nothing beside the Roster records it.
 */
export function gateState(folded: FoldedControl | undefined): GateState {
  if (!folded?.rankedRoster || folded.roster.everyone === undefined) return OFF;
  if ((folded.roster.everyone & Permissions.SEND_MESSAGES) !== 0n) return OFF;
  const roles = folded.roster.roles
    .filter((r) => r.rank !== undefined && isPlainRole(r) && (r.permissions & Permissions.SEND_MESSAGES) !== 0n)
    .sort((a, b) => b.position - a.position);
  if ((folded.roster.everyone & GATE_BITS) !== 0n || roles.length === 0) return { on: false, restricted: true, roles: [] };
  return { on: true, restricted: false, roles };
}

/**
 * Whether holding `roleId` lets a member into a Private Channel, as a legacy Channel's
 * access Role does once carried onto the ranked Roster: approving through it would hand
 * every newcomer that Channel.
 */
function opensPrivate(folded: FoldedControl, roleId: string): boolean {
  // Nobody: a member holding no Role, so only `roleId` can be what lets them in.
  const nobody = "";
  for (const c of folded.channels.values()) {
    if (c.deleted || !c.isPrivate) continue;
    if (isEntitled(folded.roster, folded.ownerHex, nobody, c.channelIdHex, { withRoleIds: [roleId] }) && !isEntitled(folded.roster, folded.ownerHex, nobody, c.channelIdHex)) return true;
  }
  return false;
}

/**
 * The Roles the turn-on dialog can make the way in: plain ones `me` may edit, the
 * owner's pick of any, none opening a Private Channel. A Role named Verified, as a bot
 * may have made, comes first.
 */
export function adoptableRoles(folded: FoldedControl, me: string): Role[] {
  const mine = me === folded.ownerHex;
  const myRank = highestPosition(folded.roster, me) ?? BENEATH_EVERY_ROLE;
  const verifiedFirst = (r: Role) => (r.name.trim().toLowerCase() === "verified" ? 0 : 1);
  return folded.roster.roles
    .filter((r) => r.rank !== undefined && isPlainRole(r) && (mine || r.position > myRank) && !opensPrivate(folded, r.roleId))
    .sort((a, b) => verifiedFirst(a) - verifiedFirst(b) || b.position - a.position);
}

/** Whether `member` may post somewhere by their server-wide permissions; a Channel's overwrite can still open one. */
export function postsAnywhere(folded: FoldedControl, member: string): boolean {
  return member === folded.ownerHex || (effectivePermissions(folded.roster, member) & Permissions.SEND_MESSAGES) !== 0n;
}

/** Whether `me` may grant `role`: Manage Roles through a Role ranked above it (CORD-04 §3). */
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

/** Whether `me` holds Manage Roles and `bits` besides everything `@everyone` has, as rewriting it takes (CORD-04 §2). */
function rewritesEveryone(folded: FoldedControl | undefined, me: string | undefined, bits: bigint): boolean {
  if (!folded?.rankedRoster || !me || folded.banned.has(me)) return false;
  if (me === folded.ownerHex) return true;
  const needs = (folded.roster.everyone ?? 0n) | bits | Permissions.MANAGE_ROLES;
  return (permissionsAbove(folded.roster, me, BENEATH_EVERY_ROLE) & needs) === needs;
}

/**
 * Whether `me` may turn the gate on or off. Turning it on gives a Role all the gate
 * takes; turning it off gives `@everyone` posting back, and whatever else `me` holds.
 */
export function maySwitchGate(folded: FoldedControl | undefined, me: string | undefined): boolean {
  return rewritesEveryone(folded, me, gateState(folded).on ? GATE_BITS : GATE_TAKES);
}

/** The gate's bits `me` may give `@everyone` back when turning it off. */
export function restorableBits(folded: FoldedControl | undefined, me: string | undefined): bigint {
  if (!folded || !me) return 0n;
  return me === folded.ownerHex ? GATE_TAKES : permissionsAbove(folded.roster, me, BENEATH_EVERY_ROLE) & GATE_TAKES;
}

/** What `@everyone` still holds of {@link GATE_EXTRAS} with the gate on: members waiting for approval react or join calls. */
export function gateLeaves(folded: FoldedControl | undefined): bigint {
  return gateState(folded).on ? (folded?.roster.everyone ?? 0n) & GATE_EXTRAS : 0n;
}

/** Whether `me` may take what {@link gateLeaves} names from `@everyone` and give it to the approval Roles. */
export function mayTightenGate(folded: FoldedControl | undefined, me: string | undefined): boolean {
  return rewritesEveryone(folded, me, gateLeaves(folded));
}

/** Whether `member`'s own Roles hold every one of `bits`, so losing `@everyone`'s costs them nothing. */
function rolesCover(folded: FoldedControl, member: string, bits: bigint): boolean {
  return (rolesOf(folded.roster, member).reduce((acc, r) => acc | r.permissions, 0n) & bits) === bits;
}

/**
 * Who taking `bits` from `@everyone` on a standing gate costs something: members whose
 * Roles post without holding all of them. `grant` get the approval Role, `unreachable`
 * are those `me` doesn't outrank.
 */
export function owedOnTighten(folded: FoldedControl, me: string, bits: bigint): { grant: string[]; unreachable: string[] } {
  const owed = [...new Set(folded.roster.grants.map((g) => g.member))]
    .filter((pk) => pk !== folded.ownerHex && pk !== me && !folded.banned.has(pk))
    .filter((pk) => rolesCover(folded, pk, Permissions.SEND_MESSAGES) && !rolesCover(folded, pk, bits))
    .sort();
  return {
    grant: owed.filter((pk) => outranksMemberForGrant(folded, me, pk)),
    unreachable: owed.filter((pk) => !outranksMemberForGrant(folded, me, pk)),
  };
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
 * Whether `me` still posts once `@everyone` can't: the owner, a Role of theirs posts, or
 * they hold `adopting`, the Role about to. Nobody grants themselves a Role (CORD-04 §3),
 * so otherwise the switch silences its author.
 */
export function keepsPosting(folded: FoldedControl, me: string, adopting?: string): boolean {
  return me === folded.ownerHex || rolesOf(folded.roster, me).some((r) => r.roleId === adopting || (r.permissions & Permissions.SEND_MESSAGES) !== 0n);
}

/** Whether `me` may change `member`'s Roles at all: strictly above them, with Manage Roles (CORD-04 §3). */
export function outranksMemberForGrant(folded: FoldedControl, me: string, member: string): boolean {
  if (member === me || member === folded.ownerHex) return false;
  if (me === folded.ownerHex) return true;
  const rank = highestPosition(folded.roster, member) ?? BENEATH_EVERY_ROLE;
  return (permissionsAbove(folded.roster, me, rank) & Permissions.MANAGE_ROLES) !== 0n;
}

/**
 * Who keeps posting when the gate goes on: members seen posting since `sinceMs`, and
 * every member already holding a Role, unless their Roles already hold all the gate
 * takes. Everyone else waits for approval. A member already holding the approval Role posts, so a run
 * cut short picks up where it stopped; `unreachable` are those `me` can't grant to, who
 * need someone ranked above them. `role` is the approval Role as it will be, posting.
 */
export function carriedOver(
  folded: FoldedControl,
  me: string,
  members: readonly string[],
  observed: ReadonlyMap<string, number>,
  sinceMs: number,
  roleId?: string,
): { grant: string[]; unreachable: string[]; waiting: number; holding: number } {
  const holds = (pk: string) => folded.roster.grants.find((g) => g.member === pk)?.roleIds ?? [];
  const eligible = members.filter((pk) => pk !== folded.ownerHex && pk !== me && !folded.banned.has(pk));
  const posts = (pk: string) => Boolean(roleId && holds(pk).includes(roleId)) || rolesCover(folded, pk, GATE_TAKES);
  const unposting = eligible.filter((pk) => !posts(pk));
  const kept = (pk: string) => (observed.get(pk) ?? 0) >= sinceMs || holds(pk).length > 0;
  const owed = unposting.filter(kept).sort();
  return {
    grant: owed.filter((pk) => outranksMemberForGrant(folded, me, pk)),
    unreachable: owed.filter((pk) => !outranksMemberForGrant(folded, me, pk)),
    waiting: unposting.filter((pk) => !kept(pk)).length,
    /** Already holding all the gate takes through their Roles, so owed nothing. */
    holding: eligible.length - unposting.length,
  };
}
