/**
 * A Private Channel key holder's access duty (CORD-03 §5, Vector `access_duty`):
 * deliver the key to every member the Channel lets in who isn't served, with
 * Read Message History the earlier epochs too, and let in by a fresh epoch one who
 * may not read the past; and, as a manager, rotate out anyone who holds the key the
 * Channel no longer lets in. Pure: the hook reads the planes and acts on the plan.
 */

import type { FoldedControl } from "@/concord/lib/control";
import type { ParsedDelivery } from "@/concord/lib/delivery";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { myLocator, type RekeyBlob, type RekeyRotationSet } from "@/concord/lib/rekey";
import { isEntitled, readsHistory } from "@/concord/lib/channelAccess";
import { canActOnMember, channelPermissions, hasPermission, Permissions, type CommunityRoles } from "@/concord/lib/roles";

/** A complete rotation that minted an epoch: its rotator and every blob it carried. */
export interface MintingRotation {
  rotator: string;
  blobs: RekeyBlob[];
}

/** The complete rotations among `sets` minting `epoch` for a Channel (Vector `minting_rotations`). */
export function mintingRotations(sets: readonly RekeyRotationSet[], channelIdHex: string, epoch: bigint): MintingRotation[] {
  return sets
    .filter((s) => s.complete && s.newEpoch === epoch && s.scopeIdHex === channelIdHex)
    .map((s) => ({ rotator: s.rotator, blobs: [...s.chunks.values()].flatMap((list) => list.flatMap((c) => c.blobs)) }));
}

/** Who a reader takes a Channel rotation from (Vector `rotates_channels`): the owner, or an unbanned MANAGE_CHANNELS or BAN holder. */
export function rotatesChannels(control: FoldedControl, rotator: string): boolean {
  return (
    rotator === control.ownerHex ||
    (!control.banned.has(rotator) && (hasPermission(control.roster, rotator, Permissions.MANAGE_CHANNELS) || hasPermission(control.roster, rotator, Permissions.BAN)))
  );
}

/** Everyone a Private Channel's key could be owed to (Vector `access_candidates`): the memberlist, every Grantee and member an overwrite names, minus the banned. */
export function accessCandidates(control: FoldedControl, members: ReadonlyMap<string, CoalescedMember>): string[] {
  const out = new Set<string>();
  for (const [pk, m] of members) if (m.state === "join") out.add(pk);
  for (const g of control.roster.grants) out.add(g.member);
  for (const o of control.roster.overwrites ?? []) if (o.target.kind === "member") out.add(o.target.id);
  return [...out].filter((pk) => /^[0-9a-f]{64}$/.test(pk) && !control.banned.has(pk)).sort();
}

function carries(rotations: readonly MintingRotation[], ok: (rotator: string) => boolean, member: string, channelIdHex: string, epoch: bigint): boolean {
  return rotations.some((r) => ok(r.rotator) && r.blobs.some((b) => b.locator.toLowerCase() === myLocator(r.rotator, member, channelIdHex, epoch)));
}

function servedOnPlane(deliveries: readonly ParsedDelivery[], member: string, channelIdHex: string, epoch: bigint, trusted: (pk: string) => boolean): boolean {
  return deliveries.some(
    (d) => d.form === "access" && d.scopeIdHex === channelIdHex && d.newEpoch === epoch && trusted(d.deliverer) &&
      d.blobs.some((b) => b.locator.toLowerCase() === myLocator(d.deliverer, member, channelIdHex, epoch)),
  );
}

/** What the duty does for one Channel. */
export interface ChannelDuty {
  channelIdHex: string;
  /** The epoch it was judged at: a rotation since makes the plan stale. */
  epoch: bigint;
  /** Unserved members with Read Message History: the key, and every past epoch read-only. */
  deliver: string[];
  /** Unserved members without it, let in by a fresh epoch (a manager's to mint). */
  fresh: string[];
  /** Holders the Channel no longer lets in, for a manager to rotate out. */
  cut: string[];
}

/**
 * Plan the duty for one Private Channel this member holds the key of, at `epoch`.
 * `handled` names members already delivered at this epoch this session.
 */
export function planChannelDuty(o: {
  control: FoldedControl;
  me: string;
  channelIdHex: string;
  epoch: bigint;
  candidates: readonly string[];
  deliveries: readonly ParsedDelivery[];
  /** The complete rotations minting `epoch`, and `epoch - 1` (none when that is 0). */
  minted: readonly MintingRotation[];
  prior: readonly MintingRotation[];
  handled?: ReadonlySet<string>;
  /** The fold before a change this pass settles: whoever it let in and `control` doesn't is cut, evidence or not (Vector `settle_access`). */
  settledFrom?: FoldedControl;
}): ChannelDuty | undefined {
  const { control, me, channelIdHex, epoch } = o;
  const owner = control.ownerHex;
  const permsOf = (pk: string) => channelPermissions(control.roster, owner, pk, channelIdHex, true);
  const entitledHere = (pk: string) => pk === owner || (!control.banned.has(pk) && (permsOf(pk) & Permissions.VIEW_CHANNEL) !== 0n);
  // Readers adopt only from a deliverer their fold entitles.
  if (!entitledHere(me)) return undefined;
  const mayRotate = me === owner || hasPermission(control.roster, me, Permissions.MANAGE_CHANNELS);
  const rotatorOk = (r: string) => rotatesChannels(control, r);
  const entitled = o.candidates.filter((pk) => pk !== me && entitledHere(pk) && !o.handled?.has(pk));
  if (entitled.length === 0 && !mayRotate) return undefined;
  const prev = epoch > 0n ? epoch - 1n : 0n;
  const before = o.settledFrom;
  const wasEntitled = (pk: string) =>
    before !== undefined && (pk === owner || (channelPermissions(before.roster, owner, pk, channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n);

  let cut: string[] = [];
  if (mayRotate) {
    cut = [...new Set([...o.candidates, ...control.banned])]
      .filter((pk) => pk !== me && !entitledHere(pk))
      .filter((pk) => wasEntitled(pk) || carries(o.minted, rotatorOk, pk, channelIdHex, epoch) || servedOnPlane(o.deliveries, pk, channelIdHex, epoch, entitledHere))
      .filter((pk) => me === owner || canActOnMember(control.roster, me, owner, pk, Permissions.MANAGE_CHANNELS))
      .sort();
    // Whoever is owed the Channel is owed its next epoch: the next run serves them.
    if (cut.length > 0) return { channelIdHex, epoch, deliver: [], fresh: [], cut };
  }

  const anyMinted = o.minted.some((r) => rotatorOk(r.rotator));
  const unserved = entitled.filter((pk) => {
    const carried = carries(o.minted, rotatorOk, pk, channelIdHex, epoch);
    const wasCut = !carried && anyMinted && (carries(o.prior, rotatorOk, pk, channelIdHex, prev) || servedOnPlane(o.deliveries, pk, channelIdHex, prev, entitledHere));
    return !carried && !wasCut && !servedOnPlane(o.deliveries, pk, channelIdHex, epoch, entitledHere);
  });
  // With Read Message History they take this epoch and every past one; without, only a fresh epoch.
  const readsHistory = (pk: string) => (permsOf(pk) & Permissions.READ_MESSAGE_HISTORY) !== 0n;
  const deliver = unserved.filter(readsHistory);
  const fresh = mayRotate ? unserved.filter((pk) => !readsHistory(pk)) : [];
  if (deliver.length === 0 && fresh.length === 0) return undefined;
  return { channelIdHex, epoch, deliver, fresh, cut: [] };
}

/** What one Roster change moves in one Private Channel (Vector `settle_access`). */
export interface ChannelSettle {
  channelIdHex: string;
  /** Let in with Read Message History: the key, by Direct Invite and on the access plane. */
  gained: string[];
  /** Let in without it: a fresh epoch, minted by a manager. */
  fresh: string[];
  /** Shut out: a rotation that leaves them out. */
  lost: string[];
}

/**
 * Judged on the change itself, `before` against `after`, never on a fold that may
 * lag or lead it: the actor knows exactly whom its own change moved. The owner and
 * the actor are never moved; a banned member is the ban's to cut.
 */
export function planSettle(o: {
  before: CommunityRoles;
  after: CommunityRoles;
  ownerHex: string;
  banned: ReadonlySet<string>;
  me: string;
  members: readonly string[];
  channels: readonly string[];
}): ChannelSettle[] {
  const out: ChannelSettle[] = [];
  for (const channelIdHex of o.channels) {
    const s: ChannelSettle = { channelIdHex, gained: [], fresh: [], lost: [] };
    for (const pk of new Set(o.members)) {
      if (pk === o.me || pk === o.ownerHex || o.banned.has(pk)) continue;
      const was = isEntitled(o.before, o.ownerHex, pk, channelIdHex);
      const now = isEntitled(o.after, o.ownerHex, pk, channelIdHex);
      if (now && !was) (readsHistory(o.after, o.ownerHex, pk, channelIdHex) ? s.gained : s.fresh).push(pk);
      else if (was && !now) s.lost.push(pk);
    }
    if (s.gained.length || s.fresh.length || s.lost.length) out.push(s);
  }
  return out;
}

/** `roster` with `member`'s Grant replaced by `roleIds`: the Roster a Grant leaves. */
export function withGrant(roster: CommunityRoles, member: string, roleIds: readonly string[]): CommunityRoles {
  return { ...roster, grants: [...roster.grants.filter((g) => g.member !== member), { member, roleIds: [...roleIds] }] };
}

/**
 * The members of `cut` the store's fold still shuts out of the Channel. A duty plans
 * on the fold it read; a change this device made since (a Grant that let them back
 * in) is in the store, and rotating them out after its key went out strands them.
 */
export function stillShutOut(stored: FoldedControl, channelIdHex: string, cut: readonly string[]): string[] {
  return cut.filter((pk) => pk !== stored.ownerHex && (stored.banned.has(pk) || !isEntitled(stored.roster, stored.ownerHex, pk, channelIdHex)));
}

/**
 * Whether the duty has anything to do for a Channel before it reads a plane (Vector
 * `access_duty`): a manager may owe a cut, anyone else only a member it may serve.
 */
export function dutyMayAct(control: FoldedControl, me: string, channelIdHex: string, candidates: readonly string[], handled: ReadonlySet<string>): boolean {
  const owner = control.ownerHex;
  const entitledHere = (pk: string) => pk === owner || (!control.banned.has(pk) && (channelPermissions(control.roster, owner, pk, channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n);
  if (!entitledHere(me)) return false;
  if (me === owner || hasPermission(control.roster, me, Permissions.MANAGE_CHANNELS)) return true;
  return candidates.some((pk) => pk !== me && !handled.has(pk) && entitledHere(pk));
}

/** Everyone a Channel rotation hands the new key (Vector `rekey_channel_at`): this member, the owner, and every candidate the Channel lets in, but `removed`. */
export function rotationRecipients(control: FoldedControl, me: string, channelIdHex: string, candidates: readonly string[], removed: readonly string[]): string[] {
  const out = new Set([me, control.ownerHex]);
  for (const pk of candidates) {
    if (removed.includes(pk) || pk === control.ownerHex) continue;
    if ((channelPermissions(control.roster, control.ownerHex, pk, channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n && !control.banned.has(pk)) out.add(pk);
  }
  for (const pk of removed) out.delete(pk);
  return [...out];
}

