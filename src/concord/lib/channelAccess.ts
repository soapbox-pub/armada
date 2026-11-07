/**
 * Who may read a Private Channel (CORD-03/04/06). The Roles scoped to a channel
 * (CORD-04 §2 `scope: {kind:"channel", channel_id}`) ARE its access list. Read
 * access is still enforced by key possession alone (CORD-04 §1); this decides who
 * a key is delivered TO on grant and who a rekey keeps on revoke.
 */

import { bytesToHex } from "@/concord/lib/derive";
import { byDisplayOrder, channelPermissions, Permissions, rolesOf, type CommunityRoles, type Role } from "@/concord/lib/roles";
import { t } from "@/i18n/intl";

/**
 * The Roles conferring read access to `channelIdHex`, in display order. A Private
 * Channel with none is degenerate (readable only by the owner and existing key
 * holders); clients shouldn't create one, but it still reads correctly.
 */
export function channelRoles(roster: CommunityRoles | undefined, channelIdHex: string): Role[] {
  const wanted = channelIdHex.toLowerCase();
  return (roster?.roles ?? [])
    .filter((r) => r.scope.kind === "channel" && r.scope.channelId.toLowerCase() === wanted)
    .sort(byDisplayOrder);
}

/** {@link channelRoles}, by id. */
export function channelRoleIds(roster: CommunityRoles | undefined, channelIdHex: string): string[] {
  return channelRoles(roster, channelIdHex).map((r) => r.roleId);
}

/**
 * Is `memberHex` entitled to `channelIdHex`'s key? The owner always is (CORD-04 §2);
 * on a legacy Roster, the Roles scoped to the Channel decide.
 * `withRoleIds`/`withoutRoleIds` overlay a just-published Grant the fold lags.
 */
export function isEntitled(
  roster: CommunityRoles | undefined,
  ownerHex: string | undefined,
  memberHex: string,
  channelIdHex: string,
  overlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] },
): boolean {
  if (memberHex === ownerHex) return true;
  if (!roster) return false;
  const held = new Set(rolesOf(roster, memberHex).map((r) => r.roleId));
  for (const id of overlay?.withRoleIds ?? []) held.add(id);
  for (const id of overlay?.withoutRoleIds ?? []) held.delete(id);
  // On ranked roles the key follows View Channel as the Channel resolves it (CORD-03 §5).
  if (roster.everyone !== undefined) {
    return (channelPermissions(roster, ownerHex, memberHex, channelIdHex, true, [...held]) & Permissions.VIEW_CHANNEL) !== 0n;
  }
  return channelRoleIds(roster, channelIdHex).some((id) => held.has(id));
}

/**
 * Whether `memberHex` may read `channelIdHex`'s history from before their access
 * began, under the same overlay as {@link isEntitled}. A legacy Roster has no such bit.
 */
export function readsHistory(
  roster: CommunityRoles,
  ownerHex: string | undefined,
  memberHex: string,
  channelIdHex: string,
  overlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] },
): boolean {
  if (roster.everyone === undefined) return true;
  const held = new Set(rolesOf(roster, memberHex).map((r) => r.roleId));
  for (const id of overlay?.withRoleIds ?? []) held.add(id);
  for (const id of overlay?.withoutRoleIds ?? []) held.delete(id);
  return (channelPermissions(roster, ownerHex, memberHex, channelIdHex, true, [...held]) & Permissions.READ_MESSAGE_HISTORY) !== 0n;
}

/**
 * Who an invite bundle is FOR, which bounds the Private Channel keys it may carry.
 * A **link** has no recipient and holds no Role (CORD-05 §2), so gets none. A
 * **member** gets exactly the channels their roles grant; `overlay` accounts for
 * a Grant just published.
 */
export type VendAudience =
  | { kind: "link" }
  | {
      kind: "member";
      roster: CommunityRoles | undefined;
      ownerHex: string | undefined;
      memberHex: string;
      overlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] };
    };

/**
 * The held Private Channel keys an invite bundle may carry (CORD-05 §1).
 * Entitlement (CORD-03 §1, CORD-04 §2) is the ceiling; `only`/`exclude` narrow
 * beneath it. That CORD-05 §6 can't PREVENT an unentitled whisper doesn't make
 * one right. An unloaded roster throws rather than vending nothing.
 */
export function vendableChannels<T extends { id: Uint8Array }>(
  held: readonly T[],
  audience: VendAudience,
  opts?: { only?: ReadonlySet<string>; exclude?: ReadonlySet<string> },
): T[] {
  if (held.length === 0) return [];
  if (audience.kind === "link") return [];
  if (!audience.roster) {
    throw new Error(
      t({ id: "concordChannelAccess.rolesLoading", defaultMessage: "Still loading this community's roles; try again in a moment." }),
    );
  }
  const { roster, ownerHex, memberHex, overlay } = audience;
  return held.filter((ch) => {
    const idHex = bytesToHex(ch.id);
    if (opts?.exclude?.has(idHex)) return false;
    if (opts?.only && !opts.only.has(idHex)) return false;
    // Without Read Message History, a key comes only with a fresh epoch (CORD-03 §5).
    return isEntitled(roster, ownerHex, memberHex, idHex, overlay) && readsHistory(roster, ownerHex, memberHex, idHex, overlay);
  });
}

/**
 * Channels whose access for `memberHex` HINGES on `roleId`, split by whether this
 * client holds the key. `unheld` channels still need rotating by someone who
 * holds them, or a revoke reports success while the target keeps reading.
 */
export function channelsHingingOn(
  roster: CommunityRoles,
  ownerHex: string | undefined,
  memberHex: string,
  roleId: string,
  channels: ReadonlyArray<{ idHex: string; heldByMe: boolean }>,
): { held: string[]; unheld: string[] } {
  const held: string[] = [];
  const unheld: string[] = [];
  for (const ch of channels) {
    if (!isEntitled(roster, ownerHex, memberHex, ch.idHex, { withRoleIds: [roleId] })) continue;
    if (isEntitled(roster, ownerHex, memberHex, ch.idHex, { withoutRoleIds: [roleId] })) continue;
    (ch.heldByMe ? held : unheld).push(ch.idHex);
  }
  return { held, unheld };
}

/**
 * The channel rekey a bulk role revoke owes (CORD-06 §1): `role`'s private
 * channel, the `stripped` members who lose it, and everyone still entitled.
 * `null` when the role gates no live private channel or nobody is cut.
 */
export function roleRevokeCut(
  roster: CommunityRoles,
  ownerHex: string | undefined,
  role: Role,
  stripped: readonly string[],
  channels: ReadonlyArray<{ idHex: string; heldByMe: boolean }>,
  banned?: ReadonlySet<string>,
): { channelIdHex: string; heldByMe: boolean; keep: string[]; removed: string[] } | null {
  if (role.scope.kind !== "channel") return null;
  const wanted = role.scope.channelId.toLowerCase();
  const channel = channels.find((ch) => ch.idHex.toLowerCase() === wanted);
  if (!channel) return null;
  const strippedSet = new Set(stripped);
  const entitledAfter = (pk: string) =>
    isEntitled(roster, ownerHex, pk, channel.idHex, strippedSet.has(pk) ? { withoutRoleIds: [role.roleId] } : undefined);
  const removed = stripped.filter((pk) => !entitledAfter(pk));
  if (removed.length === 0) return null;
  const candidates = new Set(roster.grants.map((g) => g.member));
  if (ownerHex) candidates.add(ownerHex);
  const keep = [...candidates].filter((pk) => !banned?.has(pk) && entitledAfter(pk));
  return { channelIdHex: channel.idHex, heldByMe: channel.heldByMe, keep, removed };
}

type ChannelCut = { channelIdHex: string; heldByMe: boolean; keep: string[]; removed: string[] };

/**
 * The channel rekeys a ban owes (CORD-06 §1): every live Private Channel a
 * target is entitled to on the PRE-ban roster, keeping everyone else entitled.
 * Judged before the strip, so it holds when the banner can't strip the Grant.
 */
export function banChannelCuts(
  roster: CommunityRoles,
  ownerHex: string | undefined,
  targets: readonly string[],
  channels: ReadonlyArray<{ idHex: string; heldByMe: boolean }>,
  banned?: ReadonlySet<string>,
  /** Members the Roster names nowhere (the Guestbook's), who may still be let in. */
  members: readonly string[] = [],
): ChannelCut[] {
  const cut = new Set(targets);
  const candidates = new Set([...roster.grants.map((g) => g.member), ...members]);
  for (const o of roster.overwrites ?? []) if (o.target.kind === "member") candidates.add(o.target.id);
  if (ownerHex) candidates.add(ownerHex);
  const cuts: ChannelCut[] = [];
  for (const ch of channels) {
    const removed = targets.filter((pk) => isEntitled(roster, ownerHex, pk, ch.idHex));
    if (removed.length === 0) continue;
    const keep = [...candidates].filter(
      (pk) => !cut.has(pk) && !banned?.has(pk) && isEntitled(roster, ownerHex, pk, ch.idHex),
    );
    cuts.push({ channelIdHex: ch.idHex, heldByMe: ch.heldByMe, keep, removed });
  }
  return cuts;
}
