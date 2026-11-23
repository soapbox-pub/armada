import { useQuery } from "@tanstack/react-query";

import { fetchVectorHub, VECTOR_HUB_URL, type VectorHubListing } from "@/concord/lib/vectorHub";
import { useAppContext } from "@/hooks/useAppContext";

const NO_LISTINGS: VectorHubListing[] = [];

/** Whether Discover reads the Vector Hub: the deployment has one and the user hasn't turned it off. */
export function useVectorHubEnabled(): boolean {
  const { config } = useAppContext();
  return !!VECTOR_HUB_URL && config.discoverVectorHub;
}

/**
 * The Vector Hub's listings, in its order, while `enabled`. Empty while loading,
 * off or unreachable: the hub only ever adds to Discover, so it never errors it.
 */
export function useVectorHubListings(enabled: boolean): { listings: VectorHubListing[]; isLoading: boolean } {
  const on = useVectorHubEnabled() && enabled;
  const query = useQuery({
    queryKey: ["discover", "vector-hub", VECTOR_HUB_URL],
    enabled: on,
    // The response inlines every icon (megabytes), and the list changes on review, not by the minute.
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
    queryFn: ({ signal }) => fetchVectorHub(VECTOR_HUB_URL, signal),
  });
  return { listings: on ? query.data ?? NO_LISTINGS : NO_LISTINGS, isLoading: on && query.isLoading };
}
