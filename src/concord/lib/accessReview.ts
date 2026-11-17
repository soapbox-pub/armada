/**
 * Who a Roster change lets into a Channel and who it shuts out, judged before it
 * is written (CORD-03 §5, CORD-04 §8): the same before/after reading the key
 * settle makes afterwards (`planSettle`), over public Channels too, and with the
 * road each member's access rests on. Pure.
 */

import { channelRoleIds } from "@/concord/lib/channelAccess";
import { byDisplayOrder, channelPermissions, Permissions, rolesOf, type CommunityRoles, type OverwriteTarget } from "@/concord/lib/roles";

/** What a member's view of a Channel rests on. */
export type AccessRoad = { kind: "member" } | { kind: "role"; id: string } | { kind: "everyone" } | { kind: "creator" };

const VIEW = Permissions.VIEW_CHANNEL;

/** Whether `pk` sees the Channel: View Channel on the vsk-13 Roster, a channel-scoped Role on a Private one otherwise. */
export function views(roster: CommunityRoles, ownerHex: string | undefined, pk: string, channelIdHex: string, isPrivate: boolean): boolean {
  if (pk === ownerHex) return true;
  if (roster.everyone !== undefined) return (channelPermissions(roster, ownerHex, pk, channelIdHex, isPrivate) & VIEW) !== 0n;
  if (!isPrivate) return true;
  const held = new Set(rolesOf(roster, pk).map((r) => r.roleId));
  return channelRoleIds(roster, channelIdHex).some((id) => held.has(id));
}

/** The most specific thing letting `pk` see the Channel, in the order `channelPermissions` resolves it; undefined when nothing does. */
export function viewRoad(roster: CommunityRoles, ownerHex: string | undefined, pk: string, channelIdHex: string, isPrivate: boolean): AccessRoad | undefined {
  if (!views(roster, ownerHex, pk, channelIdHex, isPrivate)) return undefined;
  const held = rolesOf(roster, pk).sort(byDisplayOrder);
  const channel = channelIdHex.toLowerCase();
  if (roster.everyone === undefined) {
    if (!isPrivate) return { kind: "everyone" };
    const ids = channelRoleIds(roster, channel);
    const role = held.find((r) => ids.includes(r.roleId));
    return role ? { kind: "role", id: role.roleId } : undefined;
  }
  const scope = roster.syncs?.[channel] ?? channel;
  const here = (roster.overwrites ?? []).filter((o) => o.scope === scope);
  const mine = here.find((o) => o.target.kind === "member" && o.target.id === pk);
  if (mine && (mine.allow & VIEW) !== 0n) return { kind: "member" };
  const ruleOf = (roleId: string) => here.find((o) => o.target.kind === "role" && o.target.id === roleId);
  const denied = held.some((r) => ((ruleOf(r.roleId)?.deny ?? 0n) & VIEW) !== 0n);
  const everyone = here.find((o) => o.target.kind === "everyone");
  const resolved = (bits: bigint) => (everyone ? (bits & ~everyone.deny) | everyone.allow : bits);
  const open = !isPrivate && !denied;
  if (open && (resolved(roster.everyone) & VIEW) !== 0n) return { kind: "everyone" };
  const allowed = held.find((r) => ((ruleOf(r.roleId)?.allow ?? 0n) & VIEW) !== 0n);
  if (allowed) return { kind: "role", id: allowed.roleId };
  const carrying = open ? held.find((r) => (resolved(r.permissions) & VIEW) !== 0n) : undefined;
  if (carrying) return { kind: "role", id: carrying.roleId };
  if (roster.creators?.[channel] === pk) return { kind: "creator" };
  return { kind: "everyone" };
}

const sameTarget = (a: OverwriteTarget, b: OverwriteTarget) =>
  a.kind === b.kind && (a.kind === "everyone" || a.id.toLowerCase() === (b as { id: string }).id.toLowerCase());

/** `roster` as a scope's rules leave it: its sync set or cleared, and each named target's overwrite replaced. */
export function withRules(
  roster: CommunityRoles,
  scope: string,
  change: { sync?: { category: string | undefined }; overwrites: ReadonlyArray<{ target: OverwriteTarget; allow: bigint; deny: bigint }> },
): CommunityRoles {
  const syncs = { ...(roster.syncs ?? {}) };
  if (change.sync) {
    if (change.sync.category) syncs[scope] = change.sync.category;
    else delete syncs[scope];
  }
  const kept = (roster.overwrites ?? []).filter((o) => !(o.scope === scope && change.overwrites.some((c) => sameTarget(c.target, o.target))));
  const written = change.overwrites.filter((o) => o.allow !== 0n || o.deny !== 0n).map((o) => ({ scope, target: o.target, allow: o.allow, deny: o.deny }));
  return { ...roster, syncs, overwrites: [...kept, ...written] };
}

export interface ReviewChannel {
  idHex: string;
  wasPrivate: boolean;
  isPrivate: boolean;
}

/** One member's view of one Channel moving. */
export interface AccessMove {
  member: string;
  channelIdHex: string;
  /** What the access rests on: after the change for one gained or kept, before it for one lost. */
  road?: AccessRoad;
  /** The Channel is Private on both sides, so the move is a key delivered or rotated away. */
  keyed: boolean;
  /** Let in without Read Message History: the key comes with a fresh epoch (CORD-03 §5). */
  fresh?: boolean;
}

export interface AccessReview {
  gains: AccessMove[];
  losses: AccessMove[];
  /** Who still reads a Channel that is going Private: the ones its first key is sealed to. */
  keeps: AccessMove[];
}

export const emptyReview = (): AccessReview => ({ gains: [], losses: [], keeps: [] });

/**
 * What taking the Roster from `before` to `after` does to who sees `channels`. The
 * owner sees everything and a banned member is the ban's to cut, so neither is
 * listed; whoever makes the change is, since shutting oneself out is worth seeing.
 */
export function reviewAccess(o: {
  before: CommunityRoles;
  after: CommunityRoles;
  ownerHex: string | undefined;
  banned?: ReadonlySet<string>;
  members: readonly string[];
  channels: readonly ReviewChannel[];
}): AccessReview {
  const out = emptyReview();
  const members = [...new Set(o.members)].filter((pk) => pk !== o.ownerHex && !o.banned?.has(pk));
  for (const ch of o.channels) {
    const keyed = ch.wasPrivate && ch.isPrivate;
    for (const pk of members) {
      const now = views(o.after, o.ownerHex, pk, ch.idHex, ch.isPrivate);
      if (ch.isPrivate && !ch.wasPrivate) {
        if (now) out.keeps.push({ member: pk, channelIdHex: ch.idHex, road: viewRoad(o.after, o.ownerHex, pk, ch.idHex, true), keyed: true });
        continue;
      }
      // Going public opens it to whoever `@everyone` lets in: said once, not per member.
      if (!ch.isPrivate && ch.wasPrivate) continue;
      const was = views(o.before, o.ownerHex, pk, ch.idHex, ch.wasPrivate);
      if (now && !was) {
        const reads = (channelPermissions(o.after, o.ownerHex, pk, ch.idHex, ch.isPrivate) & Permissions.READ_MESSAGE_HISTORY) !== 0n;
        const fresh = keyed && o.after.everyone !== undefined && !reads;
        out.gains.push({ member: pk, channelIdHex: ch.idHex, road: viewRoad(o.after, o.ownerHex, pk, ch.idHex, ch.isPrivate), keyed, ...(fresh ? { fresh } : {}) });
      } else if (was && !now) {
        out.losses.push({ member: pk, channelIdHex: ch.idHex, road: viewRoad(o.before, o.ownerHex, pk, ch.idHex, ch.wasPrivate), keyed });
      }
    }
  }
  return out;
}

/** Whether a review has anything to show before the change is written. */
export const reviewMoves = (r: AccessReview): boolean => r.gains.length > 0 || r.losses.length > 0 || r.keeps.length > 0;

/**
 * The key work a reviewed change sets off (CORD-03 §5): the Channels to rotate
 * and the members to send a key to. Whoever makes the change moves no key of
 * their own, as in `planSettle`.
 */
export function keyWork(review: AccessReview, me?: string): { rotate: string[]; send: string[] } {
  const others = (moves: AccessMove[]) => moves.filter((m) => m.keyed && m.member !== me);
  const gains = others(review.gains);
  return {
    rotate: [...new Set([...others(review.losses), ...gains.filter((m) => m.fresh)].map((m) => m.channelIdHex))],
    send: [...new Set(gains.filter((m) => !m.fresh).map((m) => m.member))],
  };
}
