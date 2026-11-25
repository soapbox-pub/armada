import { useCallback, useEffect, useMemo, useState } from "react";

import { useGuestbook } from "@/concord/hooks/useGuestbook";
import type { FoldedControl } from "@/concord/lib/control";
import { newMembersToReview, type NewMember } from "@/concord/lib/newMembers";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { clockNowMs } from "@/lib/relayClock";

/**
 * Joins a moderator marked as looked at, per (account, community, member) → the
 * Join's ms, so the same member joining again comes back. Bounded by clicks.
 */
const reviewed = new KvPrefixCache<number>({ prefix: "member-review:" });

const reviewId = (me: string, idHex: string, pk: string) => `${me}:${idHex}:${pk}`;

/** The Overview's "New members" list, and a way to mark one as looked at on this device. */
export function useNewMembers(community: Community | undefined, folded: FoldedControl | undefined): {
  members: NewMember[];
  markReviewed: (member: NewMember) => void;
} {
  const { user } = useCurrentUser();
  const { coalesced, data: guestbook } = useGuestbook(community);
  const me = user?.pubkey ?? "";
  const idHex = community?.idHex ?? "";

  // Re-derive when the cache warms or a row is marked.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const unsubscribe = reviewed.subscribe(() => setRevision((n) => n + 1));
    void reviewed.ready();
    return unsubscribe;
  }, []);

  const members = useMemo(() => {
    void revision;
    if (!folded || !me || !idHex) return [];
    return newMembersToReview({
      coalesced,
      guestbook: guestbook ?? [],
      banned: folded.banned,
      bannedAt: folded.bannedAt,
      ownerHex: folded.ownerHex,
      self: me,
      nowMs: clockNowMs(),
      reviewed: (pk, joinedMs) => reviewed.get(reviewId(me, idHex, pk)) === joinedMs,
    });
  }, [coalesced, guestbook, folded, me, idHex, revision]);

  const markReviewed = useCallback(
    (member: NewMember) => {
      if (me && idHex) reviewed.set(reviewId(me, idHex, member.pubkey), member.joinedMs);
    },
    [me, idHex],
  );

  return { members, markReviewed };
}
