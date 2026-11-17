import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { authorQueryOptions } from "@/hooks/useAuthor";
import { useEventStore } from "@/hooks/useEventStore";
import { profileMatches, type SearchProfile } from "@/hooks/useSearchProfiles";

/** `pubkeys` narrowed to those whose profile or key matches `query`; profiles are resolved in a batch so unrendered rows match too. */
export function useMemberSearch(pubkeys: readonly string[], query: string): string[] {
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const ordered = useMemo(() => [...pubkeys].sort(), [pubkeys]);
  const results = useQueries({ queries: ordered.map((pk) => authorQueryOptions(queryClient, eventStore, pk)) });
  const profileKey = ordered
    .map((pk, i) => `${pk}:${results[i]?.data?.metadata?.name ?? ""}:${results[i]?.data?.metadata?.display_name ?? ""}:${results[i]?.data?.metadata?.nip05 ?? ""}`)
    .join("|");
  const profileOf = useMemo(() => {
    const map = new Map<string, SearchProfile>();
    ordered.forEach((pk, i) => {
      const data = results[i]?.data;
      if (data?.metadata && data.event) map.set(pk, { pubkey: pk, metadata: data.metadata, event: data.event });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((pk) => {
      const p = profileOf.get(pk);
      return (p && profileMatches(p, q)) || pk.startsWith(q);
    });
  }, [ordered, query, profileOf]);
}
