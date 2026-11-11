/**
 * The Guestbook fold as the Control Plane judges it: one set of options for the
 * member list on screen and for the recipients of a Refounding, so the two can't
 * disagree about whose Kick or snapshot counts.
 */
import { citationSatisfied, type FoldedControl } from "@/concord/lib/control";
import {
  coalesceGuestbook,
  completeMemberlist,
  liveRefound,
  openGuestbookOpened,
  snapshotAuthorities,
  snapshotEpochs,
} from "@/concord/lib/guestbook";
import { canActOnMember, Permissions } from "@/concord/lib/roles";
import { queryPlane, withGuestbookStreams } from "@/concord/lib/rumorStore";
import type { Community } from "@/concord/lib/types";
import { clockNowMs } from "@/lib/relayClock";

export type GuestbookFoldOptions = Parameters<typeof coalesceGuestbook>[1];

export function guestbookFoldOptions(
  community: Community,
  folded: FoldedControl | undefined,
  dissolvedAtMs?: number | null,
): GuestbookFoldOptions {
  // A snapshot is honored only from the npub whose Refounding minted its epoch
  // (CORD-02 §5): judged per epoch where its address is known, else against the set
  // of every held epoch's minter.
  const epochs = snapshotEpochs(community);
  return {
    nowMs: clockNowMs(),
    canKick: (actor, target, citation, atMs) =>
      Boolean(
        // Death wins every race (CORD-02 §9) — an ORDERING rule: only a kick published
        // AFTER the tombstone is refused, or dissolving would un-kick everyone.
        !(dissolvedAtMs != null && atMs > dissolvedAtMs) &&
          folded &&
          // A lifted Ban writes its departure as a Kick from a BAN holder (CORD-04 §6).
          (canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK) ||
            canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.BAN)) &&
          // …and the CORD-04 §5 sync floor, so a kick from an admin whose
          // demotion we haven't read yet parks instead of landing.
          citationSatisfied(folded, community.id, actor, citation),
      ),
    snapshotAuthorities: snapshotAuthorities(community),
    snapshotAuthorityOf: epochs.authorityOf,
    live: epochs.live,
    banned: folded?.banned,
  };
}

/** Who the Guestbook held on this device says is a member now (Vector `stored_memberlist`). */
export async function storedMemberlist(community: Community, folded: FoldedControl): Promise<Set<string>> {
  const opened = openGuestbookOpened(await withGuestbookStreams(community, await queryPlane(community.idHex, "guestbook")));
  const opts = guestbookFoldOptions(community, folded);
  return completeMemberlist(coalesceGuestbook(opened, opts), new Map(), folded.banned, folded.bannedAt, liveRefound(opened, opts));
}
