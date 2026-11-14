import { useQueryClient, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";

/** The ids each batched query last asked about, held on the cache entry so a remount sees them too. */
const askedByQuery = new WeakMap<Query, ReadonlySet<string>>();

/** Call at the top of a batched queryFn with the ids it is about to ask for. */
export function recordAskedIds(queryClient: QueryClient, queryKey: QueryKey, ids: readonly string[]): void {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (query) askedByQuery.set(query, new Set(ids));
}

/**
 * Refetches a batched per-message query when the visible set gains ids it never asked about.
 * The key leaves the ids out so a new message doesn't blank the map, but then a message that
 * joins after the first paint (a sync after standby or a reload) would never be asked about,
 * and the live subscription's `since` misses anything older.
 */
export function useRefetchOnNewIds(queryKey: QueryKey, idsSig: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  const hash = JSON.stringify(queryKey);

  useEffect(() => {
    if (!enabled || !idsSig) return;
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (!query) return;
    const asked = askedByQuery.get(query);
    if (!asked) {
      if (query.state.fetchStatus === "idle") void queryClient.invalidateQueries({ queryKey, exact: true });
      return;
    }
    if (idsSig.split(",").some((id) => !asked.has(id))) {
      // A first fetch still in flight would be deduplicated rather than replaced; cancel it.
      void queryClient
        .cancelQueries({ queryKey, exact: true })
        .then(() => queryClient.invalidateQueries({ queryKey, exact: true }));
    }
    // `hash` stands in for queryKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, hash, idsSig, enabled]);
}
