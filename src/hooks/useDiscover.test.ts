/**
 * The Communities tab's read: announcements by the allow-list's authors, then
 * the un-publishes of exactly the announcements found, by id. Never every
 * deletion of a kind, which a flood of anyone's deletions would crowd an
 * author's own out of, and which relays that keep deletions private refuse.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { buildInviteUrl, mintLinkSigner, mintToken } from "@/concord/lib/invite";
import { KIND_COMMUNITY_ANNOUNCEMENT } from "@/concord/lib/inviteDiscovery";
import { fetchCommunityAnnouncements, fetchDiscoverPage } from "@/hooks/useDiscover";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const RELAY = "wss://relay.test";

function inviteUrl() {
  return buildInviteUrl("https://armada.test", mintLinkSigner().pk, mintToken(), [RELAY]);
}

function announce(sk: Uint8Array, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: KIND_COMMUNITY_ANNOUNCEMENT, content: inviteUrl(), tags: [], created_at: createdAt }, sk);
}

function deletion(sk: Uint8Array, ids: string[], createdAt: number): NostrEvent {
  return finalizeEvent(
    { kind: 5, content: "", tags: [...ids.map((id) => ["e", id]), ["k", "3314"]], created_at: createdAt },
    sk,
  );
}

/** A relay that answers filters honestly, `limit` included, and logs them. */
function relayOf(events: NostrEvent[]) {
  const filters: NostrFilter[] = [];
  const matches = (f: NostrFilter, e: NostrEvent) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f["#e"] || e.tags.some((t) => t[0] === "e" && f["#e"]!.includes(t[1])));
  const nostr = {
    relay: () => ({
      query: async (fs: NostrFilter[]) => {
        filters.push(...fs);
        const out = new Map<string, NostrEvent>();
        for (const f of fs) {
          const hit = events.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at);
          for (const e of hit.slice(0, f.limit ?? Infinity)) out.set(e.id, e);
        }
        return [...out.values()];
      },
    }),
  };
  return { nostr: nostr as unknown as Parameters<typeof fetchCommunityAnnouncements>[0], filters };
}

const signal = () => new AbortController().signal;

describe("fetchCommunityAnnouncements", () => {
  const curated = generateSecretKey();
  const spammer = generateSecretKey();
  const kept = announce(curated, 1_000);
  const unlisted = announce(curated, 900);
  const unlist = deletion(curated, [unlisted.id], 1_001);
  const spam = announce(spammer, 2_000);
  // Newer deletions by someone else, of the curated author's listing too:
  // nobody's delete but the author's counts.
  const flood: NostrEvent[] = [];
  for (let i = 0; i < 150; i++) {
    flood.push({ ...deletion(spammer, [kept.id], 5_000 + i), sig: "" });
  }
  const events = [kept, unlisted, unlist, spam, ...flood];

  it("reads the allow-list's announcements, and their own un-publishes by id", async () => {
    const { nostr, filters } = relayOf(events);
    const { invites } = await fetchCommunityAnnouncements(nostr, [RELAY], [getPublicKey(curated)], signal());

    expect(invites.map((i) => i.source.id)).toEqual([kept.id]);
    expect(filters).toEqual([
      { kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: 100, authors: [getPublicKey(curated)] },
      { kinds: [5], authors: [getPublicKey(curated)], "#e": [kept.id, unlisted.id] },
    ]);
  });

  it("sends nothing at all for an empty allow-list", async () => {
    const { nostr, filters } = relayOf(events);
    const result = await fetchCommunityAnnouncements(nostr, [RELAY], [], signal());

    expect(result).toEqual({ invites: [], cursor: undefined, found: 0 });
    expect(filters).toEqual([]);
  });

  it("drops announcements a relay returns from outside the allow-list", async () => {
    const lax = {
      relay: () => ({ query: async () => [kept, spam] }),
    } as unknown as Parameters<typeof fetchCommunityAnnouncements>[0];
    const { invites } = await fetchCommunityAnnouncements(lax, [RELAY], [getPublicKey(curated)], signal());

    expect(invites.map((i) => i.source.id)).toEqual([kept.id]);
  });

  it("splits a large allow-list across REQs, each naming its authors", async () => {
    const { nostr, filters } = relayOf(events);
    const many = [getPublicKey(curated), ...Array.from({ length: 700 }, () => getPublicKey(generateSecretKey()))];
    await fetchCommunityAnnouncements(nostr, [RELAY], many, signal());

    const reads = filters.filter((f) => f.kinds?.includes(KIND_COMMUNITY_ANNOUNCEMENT));
    expect(reads).toHaveLength(3);
    expect(reads.every((f) => f.authors && f.authors.length > 0 && f.authors.length <= 300)).toBe(true);
    expect(reads.flatMap((f) => f.authors).sort()).toEqual([...many].sort());
  });

  it("asks for no un-publishes when there's nothing to un-publish", async () => {
    const { nostr, filters } = relayOf(events);
    const result = await fetchCommunityAnnouncements(nostr, [RELAY], [getPublicKey(generateSecretKey())], signal());

    expect(result).toEqual({ invites: [], cursor: undefined, found: 0 });
    expect(filters).toHaveLength(1);
  });
});

describe("fetchDiscoverPage", () => {
  it("never sends a filter without authors", async () => {
    const { nostr, filters } = relayOf([]);
    await fetchDiscoverPage(nostr, [RELAY], 30030, "cats", [getPublicKey(generateSecretKey())], signal(), undefined);
    await fetchDiscoverPage(nostr, [RELAY], 30030, "", [], signal(), undefined);

    expect(filters).toHaveLength(2);
    expect(filters.every((f) => f.authors?.length === 1)).toBe(true);
  });
});
