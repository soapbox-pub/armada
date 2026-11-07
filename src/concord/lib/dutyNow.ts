/**
 * Ask the access and writer duties to run at once for a Community: the member who
 * just changed its Roster settles what that change moved itself, unstaggered and
 * undamped, as Vector's `settle_writers` does in the same action.
 */

import type { FoldedControl } from "@/concord/lib/control";

const listeners = new Map<string, Set<(before: FoldedControl | undefined) => void>>();

/** `before` is the fold the change was made on: settling touches only what moved from it. */
export function requestDutyNow(communityIdHex: string, before?: FoldedControl): void {
  for (const l of listeners.get(communityIdHex) ?? []) l(before);
}

export function onDutyNow(communityIdHex: string, listener: (before: FoldedControl | undefined) => void): () => void {
  let set = listeners.get(communityIdHex);
  if (!set) listeners.set(communityIdHex, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(communityIdHex);
  };
}
