import { useEffect, useState } from "react";

import { REREAD_BACKOFF_MS } from "@/concord/lib/quorum";
import { useWireScopes } from "@/wire/useWireScopes";
import { setWatched } from "@/wire/watched";

/** How often a reader still owed something reads again, once the backoff is spent. */
export const OWED_RECHECK_MS = 10_000;
/** How long after the owed set last moved that reader keeps checking at that pace. */
export const OWED_WINDOW_MS = 3 * 60_000;

/** The backoff, then every {@link OWED_RECHECK_MS} to the end of the window. */
export const OWED_REREAD_MS: readonly number[] = (() => {
  const last = REREAD_BACKOFF_MS[REREAD_BACKOFF_MS.length - 1];
  const steady = Array.from({ length: Math.floor((OWED_WINDOW_MS - last) / OWED_RECHECK_MS) }, (_, i) => last + (i + 1) * OWED_RECHECK_MS);
  return [...REREAD_BACKOFF_MS, ...steady];
})();

/**
 * Read again while something is owed: at once when a wrap lands on one of `pks` (heard
 * live under `owner`), and on {@link OWED_REREAD_MS} from each change of `sig`, so a
 * delivery published just after a read is picked up in seconds rather than at the next
 * periodic read. Ends as soon as `pending` does, or {@link OWED_WINDOW_MS} after `sig` last
 * moved, leaving the caller's own periodic read.
 */
export function useOwedReread(o: {
  owner: string | undefined;
  relays: readonly string[];
  pks: readonly string[];
  pending: boolean;
  sig: string;
  refetch: () => void;
}): void {
  const { owner, pending, sig, refetch } = o;
  const relaysKey = o.relays.join(",");
  const pksKey = o.pks.join(",");
  const [lapsed, setLapsed] = useState<string | undefined>(undefined);
  const live = pending && lapsed !== sig;

  useEffect(() => {
    if (!owner || !live) return;
    setWatched(owner, o.relays, o.pks);
    return () => setWatched(owner, [], []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, live, relaysKey, pksKey]);

  useWireScopes((scopes) => {
    if (live && o.pks.some((pk) => scopes.has(`c2park:${pk}`))) refetch();
  });

  useEffect(() => {
    if (!pending) return;
    refetch();
    const timers = OWED_REREAD_MS.map((ms) => setTimeout(refetch, ms));
    timers.push(setTimeout(() => setLapsed(sig), OWED_WINDOW_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sig]);
}
