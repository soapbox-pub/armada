/**
 * Whether a pubkey's kind 0 is still being looked for, so the UI can draw a
 * skeleton instead of the "Anonymous" fallback. A pubkey is SETTLED once its
 * kind 0 is known (store or network) or a profile round has come back without
 * one (now or in an earlier session, per profileSync's durable stamps).
 */
import { useCallback, useSyncExternalStore } from "react";

/** Past this, a pubkey still unsettled shows its fallback: a stalled sync must not leave skeletons forever. */
const PENDING_MAX_MS = 20_000;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

const settled = new Set<string>();
const armed = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function notify(pubkey: string): void {
  for (const listener of listeners.get(pubkey) ?? []) listener();
}

/**
 * Deferred a task, so react-query (which notifies its observers on a timer) has
 * delivered a just-seeded profile before the fallback could render in its place.
 */
export function markProfileSettled(pubkey: string): void {
  if (settled.has(pubkey)) return;
  setTimeout(() => {
    if (settled.has(pubkey)) return;
    settled.add(pubkey);
    notify(pubkey);
  }, 0);
}

export function isProfilePending(pubkey: string | undefined): boolean {
  return !!pubkey && HEX_PUBKEY.test(pubkey) && !settled.has(pubkey);
}

function arm(pubkey: string): void {
  if (armed.has(pubkey)) return;
  armed.add(pubkey);
  setTimeout(() => markProfileSettled(pubkey), PENDING_MAX_MS);
}

/** True while `pubkey`'s profile has neither loaded nor been found missing. */
export function useProfilePending(pubkey: string | undefined): boolean {
  return useProfilesPending(pubkey ? [pubkey] : NONE);
}

const NONE: readonly string[] = [];

/** True while any of `pubkeys` is {@link useProfilePending}. */
export function useProfilesPending(pubkeys: readonly string[]): boolean {
  const key = pubkeys.join(",");
  const subscribe = useCallback((listener: () => void) => {
    const pks = key ? key.split(",") : [];
    for (const pk of pks) {
      let set = listeners.get(pk);
      if (!set) listeners.set(pk, (set = new Set()));
      set.add(listener);
      if (isProfilePending(pk)) arm(pk);
    }
    return () => {
      for (const pk of pks) {
        const set = listeners.get(pk);
        set?.delete(listener);
        if (set?.size === 0) listeners.delete(pk);
      }
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => pubkeys.some(isProfilePending));
}

/** Logout: the next account starts from its own stamps. */
export function clearProfileLoading(): void {
  settled.clear();
  armed.clear();
  for (const pubkey of listeners.keys()) {
    arm(pubkey);
    notify(pubkey);
  }
}
