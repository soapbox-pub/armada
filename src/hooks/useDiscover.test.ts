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
import {
  fetchAnnouncementsById,
  fetchCommunityAnnouncements,
  fetchDiscoverBoosts,
  fetchDiscoverPage,
  fetchFollowPacks,
} from "@/hooks/useDiscover";
import { BOOST_POW_BITS, buildBoostLabel, buildBoostWithdrawal } from "@/lib/discoverBoost";
import { minePow } from "@/lib/pow";

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
  const tagged = (f: NostrFilter, e: NostrEvent, name: string) => {
    const want = f[`#${name}` as `#${string}`];
    return !want || e.tags.some((t) => t[0] === name && want.includes(t[1]));
  };
  const matches = (f: NostrFilter, e: NostrEvent) =>
    (!f.ids || f.ids.includes(e.id)) &&
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    ["e", "L", "l"].every((name) => tagged(f, e, name));
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

  it("reads anyone's announcements under the none switch, still honouring only their own un-publishes", async () => {
    const { nostr, filters } = relayOf(events);
    const { invites } = await fetchCommunityAnnouncements(nostr, [RELAY], null, signal());

    expect(invites.map((i) => i.source.id).sort()).toEqual([kept.id, spam.id].sort());
    expect(filters[0]).toEqual({ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: 100 });
    expect(filters.slice(1).every((f) => f.authors && f.authors.length > 0)).toBe(true);
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

  it("sends one author-less read under the none switch", async () => {
    const { nostr, filters } = relayOf([]);
    await fetchDiscoverPage(nostr, [RELAY], 30030, "", null, signal(), undefined);

    expect(filters).toEqual([{ kinds: [30030], limit: 100 }]);
  });
});

describe("boosts", () => {
  const booster = generateSecretKey();
  const lister = generateSecretKey();
  const listing = announce(lister, 1_000);
  const now = Math.floor(Date.now() / 1000);
  const sign = async (sk: Uint8Array, t: { kind: number; tags: string[][]; content: string }, mine = true) => {
    const template = { ...t, created_at: now - 60 };
    const ready = mine ? await minePow(template, getPublicKey(sk), BOOST_POW_BITS) : template;
    return finalizeEvent(ready, sk);
  };

  it("reads every boost on shown listings: with its work, withdrawals honoured", async () => {
    const kept = await sign(booster, buildBoostLabel([listing.id]));
    const taken = await sign(lister, buildBoostLabel([listing.id]));
    const lazy = await sign(generateSecretKey(), buildBoostLabel([listing.id]), false);
    const { nostr, filters } = relayOf([kept, taken, lazy, await sign(lister, buildBoostWithdrawal([taken.id]), false)]);
    const { boosts } = await fetchDiscoverBoosts(nostr, [RELAY], signal(), { listings: [listing.id] });

    expect(boosts.get(listing.id)!.map((b) => b.pubkey)).toEqual([getPublicKey(booster)]);
    expect(filters[0]).toMatchObject({ kinds: [1985], "#L": ["armada.discover"], "#l": ["boost"], "#e": [listing.id] });
  }, 60_000);

  it("reads boosts only by the web of trust it is given", async () => {
    const trusted = await sign(booster, buildBoostLabel([listing.id]));
    const stranger = await sign(generateSecretKey(), buildBoostLabel([listing.id]));
    const { nostr, filters } = relayOf([trusted, stranger]);
    const { boosts } = await fetchDiscoverBoosts(nostr, [RELAY], signal(), { authors: [getPublicKey(booster)] });

    expect(boosts.get(listing.id)!.map((b) => b.pubkey)).toEqual([getPublicKey(booster)]);
    expect(filters[0].authors).toEqual([getPublicKey(booster)]);
  }, 60_000);

  it("asks nothing with nobody to trust", async () => {
    const { nostr, filters } = relayOf([]);
    expect((await fetchDiscoverBoosts(nostr, [RELAY], signal(), { authors: [] })).boosts.size).toBe(0);
    expect(filters).toEqual([]);
  });

  it("fetches the boosted listings by id, minus their author's un-publish", async () => {
    const gone = announce(lister, 900);
    const { nostr } = relayOf([listing, gone, deletion(lister, [gone.id], 901)]);
    const invites = await fetchAnnouncementsById(nostr, [RELAY], [listing.id, gone.id], signal());

    expect(invites.map((i) => i.source.id)).toEqual([listing.id]);
  });
});

describe("fetchFollowPacks", () => {
  it("reads every seed's follows in one request, counting each seed itself", async () => {
    const seeds = Array.from({ length: 5 }, () => generateSecretKey());
    const followed = getPublicKey(generateSecretKey());
    const lists = seeds.slice(0, 2).map((sk, i) =>
      finalizeEvent({ kind: 3, content: "", tags: [["p", followed]], created_at: 10 + i }, sk),
    );
    const { nostr, filters } = relayOf(lists);
    const sources = seeds.map((sk) => ({ type: "follows" as const, pubkey: getPublicKey(sk), relays: [] }));
    const members = await fetchFollowPacks(nostr, [RELAY], sources, signal());

    expect(filters).toHaveLength(1);
    expect(filters[0].authors).toHaveLength(5);
    expect(new Set(members)).toEqual(new Set([...seeds.map((sk) => getPublicKey(sk)), followed]));
  });
});
