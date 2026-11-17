import { useEffect, useRef, useState } from "react";

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
 * A count that moves only when an entry this mount hasn't seen before appears, for
 * {@link useOwedReread}'s `sig`: what is owed growing says a delivery is on its way,
 * while what is owed shrinking (something landed) or staying unfillable says nothing.
 * Undefined while `entries` is (the caller's inputs still loading).
 */
export function useNewlyOwed(entries: readonly string[] | undefined): string | undefined {
  // A ref updated in render: the count only grows and is read back from the ref, so a
  // discarded or repeated render can't make it disagree with itself.
  const seen = useRef({ entries: new Set<string>(), generation: 0 });
  if (!entries) return undefined;
  let grew = false;
  for (const e of entries) {
    if (seen.current.entries.has(e)) continue;
    seen.current.entries.add(e);
    grew = true;
  }
  if (grew) seen.current.generation++;
  return String(seen.current.generation);
}

/**
 * Read again while something is owed: at once when a wrap lands on one of `pks` (heard
 * live under `owner`), and on {@link OWED_REREAD_MS} from each change of `sig`, so a
 * delivery published just after a read is picked up in seconds rather than at the next
 * periodic read. The schedule ends as soon as `pending` does, or {@link OWED_WINDOW_MS}
 * after `sig` last moved, leaving the live watch and the caller's own periodic read; a
 * `sig` whose window has run never opens one again, so it must name everything owed.
 *
 * Without `onMount`, the first `sig` (undefined until the caller's inputs are loaded) is
 * only the baseline: something owed since before mount may never be delivered, and only
 * a change says a delivery is on its way.
 */
export function useOwedReread(o: {
  owner: string | undefined;
  relays: readonly string[];
  pks: readonly string[];
  pending: boolean;
  sig: string | undefined;
  refetch: () => void;
  onMount?: boolean;
}): void {
  const { owner, pending, sig, refetch, onMount = true } = o;
  const relaysKey = o.relays.join(",");
  const pksKey = o.pks.join(",");
  // The sig no schedule runs for: the baseline, then each whose window has run.
  const [quiet, setQuiet] = useState<string | undefined>(onMount ? undefined : sig);
  if (!onMount && quiet === undefined && sig !== undefined) setQuiet(sig);
  const live = pending && sig !== undefined && sig !== quiet && (onMount || quiet !== undefined);

  useEffect(() => {
    if (!owner || !pending) return;
    setWatched(owner, o.relays, o.pks);
    return () => setWatched(owner, [], []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, pending, relaysKey, pksKey]);

  useWireScopes((scopes) => {
    if (pending && o.pks.some((pk) => scopes.has(`c2park:${pk}`))) refetch();
  });

  useEffect(() => {
    if (!live) return;
    refetch();
    const timers = OWED_REREAD_MS.map((ms) => setTimeout(refetch, ms));
    timers.push(setTimeout(() => setQuiet(sig), OWED_WINDOW_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, sig]);
}
