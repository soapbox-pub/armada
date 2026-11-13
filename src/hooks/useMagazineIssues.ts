import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { byPublishedDesc, MAGAZINE_ISSUE_KIND, magazineCoordinate } from "@/lib/publications";

import type { NostrEvent } from "@nostrify/nostrify";

/** A magazine's issues (kind 39731), newest first. Only its own author's issues count. */
export function useMagazineIssues(pubkey: string, identifier: string, enabled = true) {
  const { nostr } = useNostr();

  return useQuery<NostrEvent[]>({
    queryKey: ["magazine-issues", pubkey, identifier],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [MAGAZINE_ISSUE_KIND], authors: [pubkey], "#a": [magazineCoordinate(pubkey, identifier)], limit: 50 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );
      return events.filter((e) => e.pubkey === pubkey).sort(byPublishedDesc);
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
