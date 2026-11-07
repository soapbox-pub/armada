/**
 * The key and writer duties of every joined Community, in the background, as Vector
 * runs them on each follow (CORD-03 §1, §5): collecting the keys, writer secrets and
 * history owed to this member, and the access and writer duties it owes others.
 * Mounted per Community while there may be work: its saved fold keeps the vsk-13 Roster
 * and has a Private Channel or a Writers ledger, this member holds a Private Channel
 * key, or this member manages Channels; or no fold is saved yet.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useAccessDuty } from "@/concord/hooks/useAccessDuty";
import { useChannelAccess, useHistoryAccess } from "@/concord/hooks/useChannelAccess";
import { useJoinedCommunities } from "@/concord/hooks/useCommunityList";
import { useWriterAccess } from "@/concord/hooks/useWriterAccess";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import { controlFoldKey, readControlFold } from "@/concord/lib/control";
import { hasPermission, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useBootGateOpen } from "@/lib/bootGate";
import { onFoldedWrite } from "@/lib/foldedCache";

function Duties({ community }: { community: Community }) {
  useChannelAccess(community);
  useHistoryAccess(community);
  useWriterAccess(community);
  useAccessDuty(community);
  return null;
}

function MaybeDuties({ community, me }: { community: Community; me: string }) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["concord", "duties-owed", community.idHex, me], [community.idHex, me]);
  // Judged again as soon as the saved fold changes (an in-memory read).
  useEffect(() => {
    const key = controlFoldKey(community.idHex);
    return onFoldedWrite((k) => {
      if (k === key) void queryClient.invalidateQueries({ queryKey });
    });
  }, [community.idHex, queryClient, queryKey]);
  const { data: owed } = useQuery({
    queryKey,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const folded = await readControlFold(community.idHex);
      // Nothing saved yet: run, and let the duties' own relay read decide (Vector reads on each follow).
      if (!folded) return true;
      if (!folded.rankedRoster) return false;
      const ledgers = folded.writers instanceof Map ? folded.writers.size : 0;
      const manages = me === folded.ownerHex || (!(folded.banned instanceof Set && folded.banned.has(me)) && hasPermission(folded.roster, me, Permissions.MANAGE_CHANNELS));
      // A member let into a Private Channel collects its key before holding any.
      const privates = folded.channels instanceof Map && [...folded.channels.values()].some((c) => c.isPrivate && !c.deleted);
      return privates || community.privateChannels.length > 0 || ledgers > 0 || manages;
    },
  });
  return owed ? <Duties community={community} /> : null;
}

function CommunityDutiesInner() {
  const entries = useJoinedCommunities();
  const me = useCurrentUser().user?.pubkey;
  const communities = useMemo(() => entries.flatMap((e) => rehydrateCommunity(e) ?? []), [entries]);
  if (!me) return null;
  return (
    <>
      {communities.map((c) => (
        <MaybeDuties key={c.idHex} community={c} me={me} />
      ))}
    </>
  );
}

/** The rows painted just after the boot gate don't wait on the duties' setup; their first pass waits longer anyway. */
const AFTER_GATE_MS = 3_000;

/** Headless; boot-gated so it doesn't compete with first paint. */
export function CommunityDuties() {
  const gateOpen = useBootGateOpen();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!gateOpen) return;
    const timer = setTimeout(() => setReady(true), AFTER_GATE_MS);
    return () => clearTimeout(timer);
  }, [gateOpen]);
  return ready ? <CommunityDutiesInner /> : null;
}
