import type { CoalescedMember, GuestbookHistory } from "@/concord/lib/guestbook";
import { type CommunityRoles, highestPosition, rolesOf } from "@/concord/lib/roles";

/** Row building for the Members tab — pure data derived from existing folds. */

/**
 * Join-time provenance (why the UI says "estimated"): "join" = their own Join
 * rumor; "snapshot" = seeded by a Refounding (time is the refound); "observed" =
 * inferred from posting, join time unknown.
 */
export type JoinKind = "join" | "snapshot" | "observed";

export interface MemberDirectoryRow {
  pubkey: string;
  /** Millisecond join time; undefined for observed-only members. */
  joinMs?: number;
  joinKind: JoinKind;
  /** Invite attribution from the winning Join, when it carried one. */
  invite?: { creator: string; label?: string };
  /** Newest activity ms observed (0 = never seen posting). */
  lastSeenMs: number;
  /** Newest epoch observed for their posts; undefined if never seen posting. */
  epoch?: bigint;
  /** Seen posting under an epoch older than the community's current root. */
  behind: boolean;
  roleIds: string[];
  /** Lowest position among their roles (lower = higher authority); undefined if roleless. */
  highestPosition?: number;
  isOwner: boolean;
  isSelf: boolean;
  /** Flagged by the control-plane watchdog: attempted unauthorized changes. */
  suspicious: boolean;
  /**
   * Not a member now: Joined when the community last rotated its keys, and absent
   * from that rotation's snapshot (CORD-02 §5) without having been banned.
   */
  omitted: boolean;
}

export function buildMemberRows(input: {
  members: ReadonlySet<string>;
  coalesced: Map<string, CoalescedMember>;
  /** Every member's entries, winner last: where an omitted member's own Join is read from. */
  history?: GuestbookHistory;
  /** Banned npubs, who get no omitted row: a rotation leaves them out on purpose. */
  banned?: ReadonlySet<string>;
  observedEpochOf: Map<string, bigint>;
  observedSeenMs: Map<string, number>;
  roster: CommunityRoles | undefined;
  currentEpoch: bigint;
  ownerHex: string | undefined;
  selfHex: string | undefined;
  /** Watchdog-flagged authors; flagged NON-members still get a row. */
  suspicious?: ReadonlySet<string>;
}): MemberDirectoryRow[] {
  const { members, coalesced, history, banned, observedEpochOf, observedSeenMs, roster, currentEpoch, ownerHex, selfHex, suspicious } = input;
  const rows: MemberDirectoryRow[] = [];
  const everyone = new Set(members);
  for (const pk of suspicious ?? []) everyone.add(pk);
  const omitted = new Set<string>();
  for (const [pk, m] of coalesced) {
    if (m.state === "refounded" && !members.has(pk) && !banned?.has(pk)) omitted.add(pk);
  }
  for (const pk of omitted) everyone.add(pk);
  for (const pubkey of everyone) {
    const m = coalesced.get(pubkey);
    // Only a winning Join carries a usable join time; an omitted member's is the one the rotation set aside.
    const joined = m?.state === "join" ? m : omitted.has(pubkey) ? history?.get(pubkey)?.findLast((e) => e.state === "join") : undefined;
    const epoch = observedEpochOf.get(pubkey);
    const roleIds = roster ? rolesOf(roster, pubkey).map((r) => r.roleId) : [];
    rows.push({
      pubkey,
      joinMs: joined?.ms,
      joinKind: joined ? (joined.fromSnapshot ? "snapshot" : "join") : "observed",
      invite: joined?.invite,
      lastSeenMs: observedSeenMs.get(pubkey) ?? 0,
      epoch,
      behind: epoch !== undefined && epoch < currentEpoch,
      roleIds,
      highestPosition: roster ? highestPosition(roster, pubkey) : undefined,
      isOwner: pubkey === ownerHex,
      isSelf: pubkey === selfHex,
      suspicious: suspicious?.has(pubkey) ?? false,
      omitted: omitted.has(pubkey),
    });
  }
  return rows;
}

export type MemberSortKey = "role" | "name" | "joined-newest" | "joined-oldest" | "seen";

/**
 * Deterministic sort (pubkey as the final tiebreak); returns a new array. `byName`
 * orders pubkeys for "name" (the profile cache lives in the view).
 */
export function sortMemberRows(
  rows: readonly MemberDirectoryRow[],
  key: MemberSortKey,
  byName?: (a: string, b: string) => number,
): MemberDirectoryRow[] {
  const byPubkey = (a: MemberDirectoryRow, b: MemberDirectoryRow) => (a.pubkey < b.pubkey ? -1 : 1);
  const sorted = [...rows];
  switch (key) {
    case "role":
      // Owner → ranked roles ascending → roleless; longest-standing first within a tier.
      sorted.sort((a, b) => {
        const pa = a.isOwner ? 0 : a.highestPosition ?? Number.MAX_SAFE_INTEGER;
        const pb = b.isOwner ? 0 : b.highestPosition ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        const ja = a.joinMs ?? Number.MAX_SAFE_INTEGER;
        const jb = b.joinMs ?? Number.MAX_SAFE_INTEGER;
        if (ja !== jb) return ja - jb;
        return byPubkey(a, b);
      });
      break;
    case "joined-newest":
      sorted.sort((a, b) => {
        const ja = a.joinMs ?? -1;
        const jb = b.joinMs ?? -1;
        if (ja !== jb) return jb - ja; // unknown (-1) sinks
        return byPubkey(a, b);
      });
      break;
    case "joined-oldest":
      sorted.sort((a, b) => {
        const ja = a.joinMs ?? Number.MAX_SAFE_INTEGER; // unknown sinks
        const jb = b.joinMs ?? Number.MAX_SAFE_INTEGER;
        if (ja !== jb) return ja - jb;
        return byPubkey(a, b);
      });
      break;
    case "name":
      sorted.sort((a, b) => (byName ? byName(a.pubkey, b.pubkey) : byPubkey(a, b)));
      break;
    case "seen":
      sorted.sort((a, b) => {
        if (a.lastSeenMs !== b.lastSeenMs) return b.lastSeenMs - a.lastSeenMs; // never-seen (0) sinks
        return byPubkey(a, b);
      });
      break;
  }
  return sorted;
}

export interface MemberFilter {
  /** Free-text query, matched via `nameMatch` plus pubkey-prefix. */
  query?: string;
  /** Metadata-aware name matching, injected by the view (profile cache lives there). */
  nameMatch?: (pubkey: string, query: string) => boolean;
  /** Keep members holding ANY of these roles; `noRole` additionally keeps the roleless. */
  roleIds?: string[];
  noRole?: boolean;
  behindOnly?: boolean;
  viaInvite?: boolean;
  /** Keep only members whose winning Join credits this link creator (hex). */
  inviter?: string;
  suspiciousOnly?: boolean;
  /** Keep ONLY the members a key rotation left out; without it they are never listed. */
  omittedOnly?: boolean;
}

export function filterMemberRows(
  rows: readonly MemberDirectoryRow[],
  filter: MemberFilter,
): MemberDirectoryRow[] {
  const query = filter.query?.trim().toLowerCase();
  const roleFilterActive = Boolean(filter.roleIds?.length) || Boolean(filter.noRole);
  return rows.filter((row) => {
    if (Boolean(filter.omittedOnly) !== row.omitted) return false;
    if (filter.behindOnly && !row.behind) return false;
    if (filter.viaInvite && !row.invite) return false;
    if (filter.inviter && row.invite?.creator !== filter.inviter) return false;
    if (filter.suspiciousOnly && !row.suspicious) return false;
    if (roleFilterActive) {
      const holdsListed = filter.roleIds?.some((id) => row.roleIds.includes(id)) ?? false;
      const rolelessOk = Boolean(filter.noRole) && row.roleIds.length === 0;
      if (!holdsListed && !rolelessOk) return false;
    }
    if (query) {
      const byName = filter.nameMatch?.(row.pubkey, query) ?? false;
      if (!byName && !row.pubkey.startsWith(query)) return false;
    }
    return true;
  });
}

/**
 * Stable partition: watchdog-flagged rows first, each side keeping its sort
 * order. Applied AFTER sortMemberRows so the alarm outranks every sort key.
 */
export function hoistSuspicious(rows: readonly MemberDirectoryRow[]): MemberDirectoryRow[] {
  const flagged: MemberDirectoryRow[] = [];
  const rest: MemberDirectoryRow[] = [];
  for (const row of rows) (row.suspicious ? flagged : rest).push(row);
  return flagged.length ? [...flagged, ...rest] : rest;
}
