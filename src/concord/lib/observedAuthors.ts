import type { OpenedChat } from "@/concord/lib/chat";

/**
 * Who the Complete Memberlist counts as observably present (CORD-02 §5): each author
 * seen publishing anywhere in the community, at the newest ms seen. Read across EVERY
 * held channel's newest window, as Vector's `memberlist` does (200 per channel), plus
 * whatever the open channel has paged in beyond it: read off the open channel alone,
 * a member quiet there dropped from the list, and the count changed with every switch.
 */
export function observedAuthors(
  byChannel: ReadonlyMap<string, readonly OpenedChat[]>,
  openChannel: ReadonlyArray<{ pubkey: string; created_at: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const see = (pubkey: string, ms: number) => {
    const prev = out.get(pubkey);
    if (prev === undefined || ms > prev) out.set(pubkey, ms);
  };
  for (const rumors of byChannel.values()) for (const r of rumors) see(r.author, r.ms);
  // Seconds scaled to ms, to compare with Guestbook kick/leave times.
  for (const m of openChannel) see(m.pubkey, m.created_at * 1000);
  return out;
}
