import { useQuery } from "@tanstack/react-query";

import type { Reachability } from "@/hooks/useRelayReachable";

/** A hash no one has uploaded: a live server answers 404, a proxy over a dead one 5xx. */
const PROBE_HASH = "0".repeat(64);

/**
 * Whether a Blossom server answers right now. A BUD-01 HEAD for a missing blob,
 * since the root of many servers is a static page that stays up when the blob
 * store behind it is down.
 */
export function useBlossomReachable(server: string): Reachability {
  const { data, status } = useQuery({
    queryKey: ["blossom-reachable", server],
    queryFn: async ({ signal }) => {
      const started = performance.now();
      const res = await fetch(`${server}${PROBE_HASH}`, {
        method: "HEAD",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
      return { alive: res.status < 500, ms: Math.round(performance.now() - started) };
    },
    staleTime: 60_000,
    retry: false,
  });
  if (status === "error") return { alive: false };
  if (!data) return { alive: undefined };
  return data.alive ? data : { alive: false };
}
