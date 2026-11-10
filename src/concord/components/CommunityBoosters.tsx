import { useMemo, useRef, type ReactNode } from "react";

import { BoostersContext } from "@/components/chat/boostersContext";
import { useCommunityBoosts } from "@/hooks/useDiscover";

import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";

/**
 * The members boosting the community, for the member list's badges. Only members
 * count, so an outsider's boost marks nobody. `enabled` gates the relay reads to
 * while the member list is on screen.
 */
export function CommunityBoosters({
  listings,
  members,
  enabled,
  children,
}: {
  /** The community's Discover listings, read by the page. */
  listings: DiscoveredInvite[];
  members: ReadonlySet<string>;
  enabled: boolean;
  children: ReactNode;
}) {
  const ids = useMemo(() => listings.map((l) => l.source.id), [listings]);
  const { boosts } = useCommunityBoosts(ids, { enabled });
  // Kept while unchanged: every member row reads this.
  const previous = useRef<ReadonlySet<string>>(new Set());
  const boosters = useMemo(() => {
    const next = new Set(boosts.filter((b) => members.has(b.pubkey)).map((b) => b.pubkey));
    const prev = previous.current;
    if (next.size === prev.size && [...next].every((pk) => prev.has(pk))) return prev;
    previous.current = next;
    return next;
  }, [boosts, members]);
  return <BoostersContext.Provider value={boosters}>{children}</BoostersContext.Provider>;
}
