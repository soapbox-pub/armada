import { useQuery } from "@tanstack/react-query";

import { relayInfoQueryOptions, relayLatency } from "@/hooks/useRelayInfo";

export interface Reachability {
  /** `undefined` while checking. */
  alive: boolean | undefined;
  /** How long the last answer took, in ms, once one arrived this session. */
  ms?: number;
}

/**
 * Whether a relay answers right now. Rides the NIP-11 query with a shorter staleTime, so a row
 * showing both the relay's identity and this light costs one GET. Its disk seed
 * (`dataUpdatedAt: 0`) is last-known-good and says nothing about the relay being up.
 */
export function useRelayReachable(url: string | undefined): Reachability {
  const { status, dataUpdatedAt } = useQuery({ ...relayInfoQueryOptions(url), staleTime: 60_000 });
  if (status === "error") return { alive: false };
  return dataUpdatedAt > 0 ? { alive: true, ms: relayLatency(url) } : { alive: undefined };
}
