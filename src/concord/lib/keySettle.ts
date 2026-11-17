/**
 * One key settle at a time per Community (CORD-03 §5, Vector `settle_access`).
 * A Roster write and the Channel keys it moves finish before the next write, or
 * a duty's rotation, begins: a rotation planned on the Roster before a change it
 * never saw cuts a member that change let back in, after the change's key went
 * out, which no holder may repair (CORD-03 §5).
 */

import type { FoldedControl } from "@/concord/lib/control";

const tails = new Map<string, Promise<unknown>>();

export function withKeySettle<T>(communityIdHex: string, run: () => Promise<T>): Promise<T> {
  const prior = tails.get(communityIdHex) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(run);
  const tail = next.catch(() => undefined);
  tails.set(communityIdHex, tail);
  void tail.then(() => {
    if (tails.get(communityIdHex) === tail) tails.delete(communityIdHex);
  });
  return next;
}

/** What settling one Roster change did, for whoever made it. */
export interface SettleReport {
  /** Channels whose key reached every member let in, by at least one road. */
  sent: string[];
  /** The members let into a Channel this device holds. */
  members: string[];
  /** Why a key let in reached a member by neither road. */
  sendFailed?: string;
  /** Channels someone was let into or shut out of whose key this device doesn't hold. */
  unheldGained: string[];
  unheldLost: string[];
  /** Channels someone was shut out of that this device may not rotate. */
  notRotated: string[];
  rotationFailed: Array<{ channelIdHex: string; error: string }>;
}

export const emptySettleReport = (): SettleReport => ({ sent: [], members: [], unheldGained: [], unheldLost: [], notRotated: [], rotationFailed: [] });

/** Told as a settle starts rotating keys, then as it starts sending them: for whoever shows its progress. */
export type SettleWatch = (phase: "rotate" | "send") => void;

/** Moves the keys a change took the Roster from `before` to `after` (CORD-03 §5). */
export type RosterSettler = (before: FoldedControl, after: FoldedControl, watch?: SettleWatch) => Promise<SettleReport>;

const settlers = new Map<string, RosterSettler>();

/** The mounted Community's settler; writers reach it without the hooks that rotate. */
export function registerRosterSettler(communityIdHex: string, settle: RosterSettler): () => void {
  settlers.set(communityIdHex, settle);
  return () => {
    if (settlers.get(communityIdHex) === settle) settlers.delete(communityIdHex);
  };
}

export function rosterSettler(communityIdHex: string): RosterSettler | undefined {
  return settlers.get(communityIdHex);
}
