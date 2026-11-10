/**
 * The unpublished rest of a switch to ranked roles (CORD-04 §2), kept until every
 * edition of it has landed. The switch is many editions, and once `@everyone` is out
 * the community counts as ranked, so planning it again is refused: without this, a
 * switch cut short there left its sidebar carry (categories, channel order, the
 * Private Channels' sealed details) undone for good. Keyed per (owner, community) in
 * ArmadaDB KV; await {@link activationPendingReady} before trusting a miss.
 */
import { KvPrefixCache } from "@/lib/db/kvCache";

import type { NostrRumor } from "@/lib/nostrRumor";

const cache = new KvPrefixCache<NostrRumor[]>({ prefix: "c2activate:" });

const id = (me: string, communityIdHex: string) => `${me}:${communityIdHex}`;

export function activationPendingReady(): Promise<void> {
  return cache.ready();
}

export function subscribeActivationPending(listener: () => void): () => void {
  void cache.ready();
  return cache.subscribe(listener);
}

/** The editions still to publish, in order, or undefined. */
export function activationPending(me: string, communityIdHex: string): NostrRumor[] | undefined {
  const rumors = cache.get(id(me, communityIdHex));
  return Array.isArray(rumors) && rumors.length > 0 ? rumors : undefined;
}

export function setActivationPending(me: string, communityIdHex: string, rumors: NostrRumor[]): void {
  if (rumors.length === 0) cache.delete(id(me, communityIdHex));
  else cache.set(id(me, communityIdHex), rumors);
}
