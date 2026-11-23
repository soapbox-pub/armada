import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { liveEntries, rehydrateCommunity } from "@/concord/lib/communityList";
import { citationSatisfied, readControlFold } from "@/concord/lib/control";
import {
  coalesceGuestbook,
  completeMemberlist,
  snapshotAuthorities,
} from "@/concord/lib/guestbook";
import { canActOnMember, Permissions } from "@/concord/lib/roles";
import { queryPlane } from "@/concord/lib/rumorStore";
import type { Community } from "@/concord/lib/types";

export interface CommunityMembership {
  name: string;
  members: ReadonlySet<string>;
}

/** As the query holds it: sorted arrays, so an unchanged refetch keeps its identity. */
interface StoredMembership {
  name: string;
  members: string[];
}

/** Guestbooks move slowly and every read is a bridge crossing per community on native. */
const MEMBERSHIP_STALE_MS = 5 * 60_000;

/**
 * The members of each of the viewer's communities, from the decrypted Guestbook Plane in
 * the rumor store (purely local, Concord only). Undefined until the community list and
 * every guestbook are read; `[]` for an account in no community.
 */
export function useCommunityMemberships(enabled = true): CommunityMembership[] | undefined {
  const { data: listData } = useCommunityList();

  const communities = useMemo(() => {
    if (!listData) return undefined;
    const out: Community[] = [];
    for (const entry of liveEntries(listData.list)) {
      const community = rehydrateCommunity(entry);
      if (community) out.push(community);
    }
    return out;
  }, [listData]);

  const communityKey = useMemo(
    () =>
      (communities ?? [])
        .map((c) => `${c.idHex}:${c.heldRoots.map((r) => r.epoch).join("-")}`)
        .sort()
        .join(","),
    [communities],
  );

  const { data } = useQuery<StoredMembership[]>({
    queryKey: ["dm-community-memberships", communityKey],
    enabled: enabled && communities !== undefined,
    staleTime: MEMBERSHIP_STALE_MS,
    refetchOnWindowFocus: false,
    // Independent per-tenant reads, issued concurrently: each is a bridge crossing on native.
    queryFn: () => Promise.all((communities ?? []).map(async (community) => {
      try {
        const events = await queryPlane(community.idHex, "guestbook");
        if (!events.length) return { name: community.name, members: [] };
        // Without a fold nobody is kicked or banned, so it can only over-include.
        const folded = await readControlFold(community.idHex);
        const coalesced = coalesceGuestbook(events, {
          nowMs: Date.now(),
          canKick: (actor, target, citation) =>
            Boolean(
              folded &&
                canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK) &&
                citationSatisfied(folded, community.id, actor, citation),
            ),
          // Snapshots honored only from the epoch's Refounding author. Mirrors useGuestbook.
          snapshotAuthorities: snapshotAuthorities(community),
          banned: folded?.banned,
        });
        // No `observed` healing: the Guestbook alone is enough here.
        const members = completeMemberlist(
          coalesced,
          new Map(),
          folded?.banned ?? new Set(),
          folded?.bannedAt,
        );
        return { name: community.name, members: [...members].sort() };
      } catch {
        // An unreadable guestbook contributes nobody.
        return { name: community.name, members: [] };
      }
    })),
  });

  const memberships = useMemo(
    () => data?.map(({ name, members }) => ({ name, members: new Set(members) })),
    [data],
  );
  return enabled ? memberships : undefined;
}

/** Everyone sharing at least one community with the viewer; undefined while loading. */
export function useCommunityPeers(enabled = true): ReadonlySet<string> | undefined {
  const memberships = useCommunityMemberships(enabled);
  return useMemo(() => {
    if (!memberships) return undefined;
    const peers = new Set<string>();
    for (const { members } of memberships) for (const peer of members) peers.add(peer);
    return peers;
  }, [memberships]);
}

/**
 * Per peer, a community the viewer shares with them ("Also in Foo") for DM requests.
 * Concord only, so coverage is partial.
 */
export function useSharedCommunities(
  peers: string[],
  enabled = true,
): Map<string, string> {
  const memberships = useCommunityMemberships(enabled && peers.length > 0);
  // Keyed on content: `peers` is rebuilt every render.
  const peerKey = [...peers].sort().join(",");
  return useMemo(() => {
    const out = new Map<string, string>();
    if (!memberships) return out;
    // First community wins — the label has room for one.
    for (const peer of peerKey ? peerKey.split(",") : []) {
      const shared = memberships.find(({ members }) => members.has(peer));
      if (shared) out.set(peer, shared.name);
    }
    return out;
  }, [memberships, peerKey]);
}
