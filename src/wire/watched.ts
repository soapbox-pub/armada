/**
 * Addresses a hook wants heard live with no key the wire could open them with: a
 * Private Channel's next rekey addresses and the access planes of Channels a member
 * is owed (Vector `rekey_authors`). The wire holds them in its standing subscription;
 * an arrival is parked and rings `c2park:<pk>`, which wakes the hook to read them.
 */

import { useSyncExternalStore } from "react";

export interface WatchedAddresses {
  relays: string[];
  pks: string[];
}

const byOwner = new Map<string, WatchedAddresses>();
const listeners = new Set<() => void>();
let snapshot: WatchedAddresses[] = [];

function publish(): void {
  snapshot = [...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, w]) => w);
  for (const l of listeners) l();
}

/** Set what `owner` watches; an empty set stops it. Unchanged sets don't resubscribe. */
export function setWatched(owner: string, relays: readonly string[], pks: readonly string[]): void {
  const next = { relays: [...new Set(relays)].sort(), pks: [...new Set(pks)].sort() };
  const prev = byOwner.get(owner);
  if (next.pks.length === 0 || next.relays.length === 0) {
    if (prev && byOwner.delete(owner)) publish();
    return;
  }
  if (prev && prev.relays.join() === next.relays.join() && prev.pks.join() === next.pks.join()) return;
  byOwner.set(owner, next);
  publish();
}

export function useWatchedAddresses(): WatchedAddresses[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
  );
}
