/**
 * How far a Refounding (CORD-06 §3) got, kept until it is whole. The root roll is
 * its commit: from then on every keeper adopts the new epoch, so what follows it —
 * carrying the Control Plane's state into the new address, the new Guestbook's
 * snapshot, each Private Channel's rotation — has to be finished, at the SAME
 * epoch, rather than retried as a fresh Refounding off a half-carried one. Written
 * before the roll; keyed per (rotator, community) in ArmadaDB KV, so it survives a
 * closed tab. Await {@link refoundJournalReady} before trusting a miss.
 */
import { KvPrefixCache } from "@/lib/db/kvCache";

import type { JoinMaterial } from "@/concord/lib/communityList";

export interface RefoundJournal {
  /** The epoch the roll mints, and the one it rolls from (decimal strings). */
  newEpoch: string;
  priorEpoch: string;
  /** The prior epoch's Control address, whose snapshot bounds the state to carry. */
  priorSnapPk?: string;
  /** Whether the prior epoch had a split Control Plane (CORD-02 §2). */
  priorControlPk?: string;
  recipients: string[];
  exclude: string[];
  /** The roll's publish time: the prior root's read cutoff. */
  rotatedAtMs: number;
  /** Each held Private Channel's epoch before the Refounding (one past it is this run's). */
  channelBase: Record<string, string>;
  /** The Control Plane's heads landed at the new address. */
  carried?: boolean;
  guestbook?: boolean;
  /** Channels rotated so far, as written to the list. */
  channels: JoinMaterial["channels"];
}

const cache = new KvPrefixCache<RefoundJournal>({ prefix: "c2refound:" });

const id = (me: string, communityIdHex: string) => `${me}:${communityIdHex}`;

export function refoundJournalReady(): Promise<void> {
  return cache.ready();
}

export function subscribeRefoundJournal(listener: () => void): () => void {
  void cache.ready();
  return cache.subscribe(listener);
}

export function refoundJournal(me: string, communityIdHex: string): RefoundJournal | undefined {
  const j = cache.get(id(me, communityIdHex));
  return j && typeof j.newEpoch === "string" && Array.isArray(j.recipients) ? j : undefined;
}

export function writeRefoundJournal(me: string, communityIdHex: string, journal: RefoundJournal): void {
  cache.set(id(me, communityIdHex), journal);
}

export function clearRefoundJournal(me: string, communityIdHex: string): void {
  cache.delete(id(me, communityIdHex));
}
