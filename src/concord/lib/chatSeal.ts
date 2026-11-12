import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { KIND_WRAP } from "@/concord/lib/kinds";
import { readStoredSeal } from "@/concord/lib/rumorStore";
import { openWrap, type OpenedEvent } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";

/** How far a wrap is looked for around its message's date: a send is wrapped as it is dated, a retry later. */
const BEFORE_SECS = 10 * 60;
const AFTER_SECS = 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 10_000;

interface RelayReader {
  relay(url: string): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> };
}

/**
 * The seal a message arrived in, which a Pin needs to prove it (CORD-04 §7): the one
 * this session holds, else its wrap read again from the community's relays, at every
 * address the message's epoch posts at.
 */
export async function fetchChatSeal(
  nostr: RelayReader,
  community: Community,
  channel: Channel,
  opened: OpenedEvent,
  epoch: bigint | undefined,
): Promise<NostrEvent | undefined> {
  const held = await readStoredSeal(community.idHex, opened.rumorId);
  if (held) return held;
  const streams = channel.streams.filter((s) => epoch === undefined || s.epoch === epoch);
  if (streams.length === 0) return undefined;
  const byPk = new Map(streams.map((s) => [s.group.pk, s.group]));
  const filter: NostrFilter = {
    kinds: [KIND_WRAP],
    authors: [...byPk.keys()],
    since: opened.createdAt - BEFORE_SECS,
    until: opened.createdAt + AFTER_SECS,
  };
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const found = await Promise.any(community.relays.map(async (url) => {
    for (const wrap of await nostr.relay(url).query([filter], { signal })) {
      const group = byPk.get(wrap.pubkey);
      if (!group) continue;
      try {
        const candidate = openWrap(wrap, group);
        if (candidate.rumorId === opened.rumorId && candidate.seal) return candidate.seal;
      } catch {
        // not this channel's, or malformed
      }
    }
    throw new Error("not on this relay");
  })).catch(() => undefined);
  return found;
}
