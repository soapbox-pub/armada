/**
 * Finding and taking down a community's Discover listings.
 *
 * An announcement names its link only inside its content, so a relay can only
 * narrow a listing read by author — and a deletion is found by the ids it
 * deletes, so an old delete of an old listing is never lost behind the newest
 * page of every Discover deletion. Taking listings down deletes only the
 * viewer's own: nobody honors a NIP-09 delete from anyone else.
 */

import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { buildInviteUrl, mintLinkSigner, mintToken, type InviteBundle } from "@/concord/lib/invite";
import { KIND_COMMUNITY_ANNOUNCEMENT, announcementFromEvent, type DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import { forgetDiscoverAnnouncements } from "@/hooks/useDiscover";

import { DiscoverUnansweredError, fetchLinkAnnouncements, fetchResolvedCommunityAnnouncements, useUnlistAnnouncements } from "./useDiscoverListings";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  published: [] as Array<{ kind: number; tags: string[][] }>,
  pool: undefined as unknown,
  config: { appRelays: ["wss://discover.test"] } as {
    appRelays: string[];
    relayMetadata?: { relays: { url: string; read: boolean; write: boolean }[]; updatedAt: number; pubkey?: string };
  },
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.pool }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({
    mutateAsync: async (t: { kind: number; tags: string[][] }) => {
      h.published.push(t);
    },
  }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({ useControlFold: () => ({ data: undefined }) }));

const RELAY = "wss://relay.test";

function linkUrl() {
  const link = mintLinkSigner();
  return { signer: link.pk, url: buildInviteUrl("https://armada.test", link.pk, mintToken(), [RELAY]) };
}

function announce(sk: Uint8Array, url: string, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: KIND_COMMUNITY_ANNOUNCEMENT, content: url, tags: [], created_at: createdAt }, sk);
}

function deletion(sk: Uint8Array, ids: string[], createdAt: number): NostrEvent {
  return finalizeEvent(
    { kind: 5, content: "", tags: [...ids.map((id) => ["e", id]), ["k", "3314"]], created_at: createdAt },
    sk,
  );
}

/**
 * A relay that answers filters honestly, `limit` included, and logs them.
 * `fail(round)` makes a read round reject (0 = listings, 1 = deletions), the
 * way a relay that is offline or out of time does.
 */
function relayOf(events: NostrEvent[], fail: (round: number) => boolean = () => false) {
  const filters: NostrFilter[][] = [];
  const matches = (f: NostrFilter, e: NostrEvent) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f["#e"] || e.tags.some((t) => t[0] === "e" && f["#e"]!.includes(t[1])));
  const pool = {
    relay: () => ({
      query: async (fs: NostrFilter[]) => {
        const round = filters.length;
        filters.push(fs);
        if (fail(round)) throw new Error("offline");
        const out = new Map<string, NostrEvent>();
        for (const f of fs) {
          const hit = events.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at);
          for (const e of hit.slice(0, f.limit ?? Infinity)) out.set(e.id, e);
        }
        return [...out.values()];
      },
    }),
  };
  return { pool, filters };
}

beforeEach(() => {
  h.published = [];
  h.config = { appRelays: ["wss://discover.test"] };
});

describe("fetchResolvedCommunityAnnouncements", () => {
  // A registry omits links that work, so a community's listings are also found by
  // what their bundles open — kept only where the sharer may list that link.
  it("keeps a sharer's listing whose link opens the community, and nothing else", async () => {
    const owner = generateSecretKey();
    const staff = generateSecretKey();
    const COMMUNITY = "c1".repeat(32);
    const known = linkUrl();
    const unregistered = linkUrl();
    const borrowed = linkUrl();
    const elsewhere = linkUrl();
    const listings = [
      announce(owner, known.url, 40),
      announce(staff, unregistered.url, 30),
      // The owner re-sharing staff's link: the owner may list any link of theirs.
      announce(owner, unregistered.url, 25),
      // Staff sharing a link someone else made: not theirs to list.
      announce(staff, borrowed.url, 20),
      announce(staff, elsewhere.url, 10),
    ];
    const bundleOf = (communityId: string, creator: Uint8Array): InviteBundle =>
      ({ community_id: communityId, owner: getPublicKey(owner), creator_npub: getPublicKey(creator) }) as InviteBundle;
    const bundles = new Map<string, InviteBundle>([
      [unregistered.signer, bundleOf(COMMUNITY, staff)],
      [borrowed.signer, bundleOf(COMMUNITY, generateSecretKey())],
      [elsewhere.signer, bundleOf("d2".repeat(32), staff)],
    ]);
    const resolved: string[] = [];
    const { pool } = relayOf(listings);

    const found = await fetchResolvedCommunityAnnouncements(
      pool as never,
      ["wss://discover.test"],
      COMMUNITY,
      [getPublicKey(owner), getPublicKey(staff)],
      new Set([known.signer]),
      async (invite) => {
        resolved.push(invite.linkSigner);
        return bundles.get(invite.linkSigner);
      },
    );

    expect(found.map((f) => f.invite.source.id).sort()).toEqual([listings[1].id, listings[2].id].sort());
    expect(found.every((f) => f.creator === getPublicKey(staff))).toBe(true);
    // A link the registry already names is never resolved, and each other link once.
    expect(resolved.sort()).toEqual([unregistered.signer, borrowed.signer, elsewhere.signer].sort());
  });
});

describe("fetchLinkAnnouncements", () => {
  it("reads the named authors deep, and finds their old deletions by id", async () => {
    const creator = generateSecretKey();
    const stranger = generateSecretKey();
    const mine = linkUrl();
    const old = announce(creator, mine.url, 1_000);
    const older = announce(creator, mine.url, 900);
    const oldDelete = deletion(creator, [older.id], 1_001);
    // A flood of newer unrelated announcements AND deletions: an unscoped
    // newest-500 read would see neither of the creator's old events.
    // Unsigned, since signing 1200 is slow (and verification drops them).
    const strangerPk = getPublicKey(stranger);
    const strangerUrl = linkUrl().url;
    const flood: NostrEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const at = 10_000 + i;
      flood.push({ id: `a${i}`, pubkey: strangerPk, kind: KIND_COMMUNITY_ANNOUNCEMENT, content: strangerUrl, tags: [], created_at: at, sig: "" });
      flood.push({ id: `d${i}`, pubkey: strangerPk, kind: 5, content: "", tags: [["e", "ff".repeat(32)], ["k", "3314"]], created_at: at, sig: "" });
    }
    const { pool, filters } = relayOf([old, older, oldDelete, ...flood]);

    const found = await fetchLinkAnnouncements(pool as never, ["wss://discover.test"], new Set([mine.signer]), {
      authors: [getPublicKey(creator)],
      includeRecent: true,
    });

    expect(found.map((a) => a.source.id)).toEqual([old.id]);
    // The listing read names the author; the deletion read names the ids.
    expect(filters[0].some((f) => f.authors?.includes(getPublicKey(creator)))).toBe(true);
    expect(filters[1].every((f) => f.kinds?.[0] === 5 && f["#e"]?.includes(older.id))).toBe(true);
  });

  it("asks for no deletions when nothing carries the links", async () => {
    const { pool, filters } = relayOf([announce(generateSecretKey(), linkUrl().url, 1)]);
    expect(await fetchLinkAnnouncements(pool as never, ["wss://discover.test"], new Set([linkUrl().signer]))).toEqual([]);
    expect(filters).toHaveLength(1);
  });

  it("ignores a deletion from anyone but the announcement's author", async () => {
    const creator = generateSecretKey();
    const mine = linkUrl();
    const listing = announce(creator, mine.url, 1_000);
    const { pool } = relayOf([listing, deletion(generateSecretKey(), [listing.id], 1_001)]);
    const found = await fetchLinkAnnouncements(pool as never, ["wss://discover.test"], new Set([mine.signer]));
    expect(found.map((a) => a.source.id)).toEqual([listing.id]);
  });

  it("throws rather than answer \"not listed\" when no relay answered the listings read", async () => {
    const creator = generateSecretKey();
    const mine = linkUrl();
    const { pool } = relayOf([announce(creator, mine.url, 1_000)], () => true);
    await expect(fetchLinkAnnouncements(pool as never, ["wss://discover.test"], new Set([mine.signer]))).rejects.toThrow(
      DiscoverUnansweredError,
    );
  });

  it("gives the deletions read its own deadline, not what the listings read left of one", async () => {
    const creator = generateSecretKey();
    const mine = linkUrl();
    const listing = announce(creator, mine.url, 1_000);
    const { pool: honest } = relayOf([listing, deletion(creator, [listing.id], 1_001)]);
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      deadlines.push(c);
      return c.signal;
    });
    try {
      let round = 0;
      const pool = {
        relay: () => ({
          query: async (fs: NostrFilter[], o: { signal: AbortSignal }) => {
            if (o.signal.aborted) throw new Error("aborted");
            const out = await honest.relay().query(fs);
            // The listings read lands just as its deadline runs out.
            if (round++ === 0) deadlines[0].abort();
            return out;
          },
        }),
      };
      const found = await fetchLinkAnnouncements(pool as never, ["wss://discover.test"], new Set([mine.signer]), {
        strict: true,
      });
      // The deletion was read, so the deleted listing is not shown as live.
      expect(found).toEqual([]);
      expect(deadlines).toHaveLength(2);
    } finally {
      timeout.mockRestore();
    }
  });

  it("strict: an unanswered deletions read throws; otherwise the listing is shown as standing", async () => {
    const creator = generateSecretKey();
    const mine = linkUrl();
    const listing = announce(creator, mine.url, 1_000);
    const events = [listing, deletion(creator, [listing.id], 1_001)];

    const strict = relayOf(events, (round) => round === 1);
    await expect(
      fetchLinkAnnouncements(strict.pool as never, ["wss://discover.test"], new Set([mine.signer]), { strict: true }),
    ).rejects.toThrow(DiscoverUnansweredError);

    const display = relayOf(events, (round) => round === 1);
    const shown = await fetchLinkAnnouncements(display.pool as never, ["wss://discover.test"], new Set([mine.signer]));
    expect(shown.map((a) => a.source.id)).toEqual([listing.id]);
  });
});

describe("useUnlistAnnouncements", () => {
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
  }

  it("deletes only the viewer's own announcements", async () => {
    const me = generateSecretKey();
    h.user = { pubkey: getPublicKey(me) };
    const url = linkUrl().url;
    const mineA = announcementFromEvent(announce(me, url, 1))!;
    const theirs = announcementFromEvent(announce(generateSecretKey(), url, 2))!;

    const { result } = renderHook(() => useUnlistAnnouncements(), { wrapper });
    expect(await result.current.unlist([mineA, theirs])).toBe(1);
    expect(h.published).toHaveLength(1);
    const deleted = h.published[0].tags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(deleted).toEqual([mineA.source.id]);
  });

  it("unlistLinks fails, publishing nothing, when no Discover relay answered", async () => {
    const me = generateSecretKey();
    h.user = { pubkey: getPublicKey(me) };
    const mine = linkUrl();
    h.pool = relayOf([announce(me, mine.url, 1)], () => true).pool;

    const { result } = renderHook(() => useUnlistAnnouncements(), { wrapper });
    await expect(result.current.unlistLinks([mine.signer])).rejects.toThrow(DiscoverUnansweredError);
    expect(h.published).toHaveLength(0);
  });

  it("unlistLinks deletes every copy of the viewer's links it finds", async () => {
    const me = generateSecretKey();
    h.user = { pubkey: getPublicKey(me) };
    const mine = linkUrl();
    const a = announce(me, mine.url, 1);
    const b = announce(me, mine.url, 2);
    h.pool = relayOf([a, b]).pool;

    const { result } = renderHook(() => useUnlistAnnouncements(), { wrapper });
    expect(await result.current.unlistLinks([mine.signer])).toBe(2);
    const deleted = h.published[0].tags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(deleted.sort()).toEqual([a.id, b.id].sort());
  });

  it("unlistLinks also finds listings on the user's own relays", async () => {
    const me = generateSecretKey();
    h.user = { pubkey: getPublicKey(me) };
    // Discover reads the app relays AND the user's NIP-65 relays, so a listing
    // that only reached the user's own relay is still found and unlisted.
    h.config = {
      appRelays: ["wss://discover.test"],
      relayMetadata: {
        relays: [{ url: "wss://mine.test", read: true, write: true }],
        updatedAt: 1,
        pubkey: getPublicKey(me),
      },
    };
    const mine = linkUrl();
    const a = announce(me, mine.url, 1);
    const held = relayOf([a]).pool.relay();
    const empty = relayOf([]).pool.relay();
    h.pool = { relay: (url: string) => (url.includes("mine.test") ? held : empty) };

    const { result } = renderHook(() => useUnlistAnnouncements(), { wrapper });
    expect(await result.current.unlistLinks([mine.signer])).toBe(1);
    expect(h.published[0].tags).toContainEqual(["e", a.id]);
  });

  it("publishes nothing when none of them are the viewer's", async () => {
    h.user = { pubkey: getPublicKey(generateSecretKey()) };
    const theirs = announcementFromEvent(announce(generateSecretKey(), linkUrl().url, 2))!;

    const { result } = renderHook(() => useUnlistAnnouncements(), { wrapper });
    expect(await result.current.unlist([theirs])).toBe(0);
    expect(h.published).toHaveLength(0);
  });
});

describe("forgetDiscoverAnnouncements", () => {
  it("drops the deleted listings from every cached copy of the directory", async () => {
    const sk = generateSecretKey();
    const gone = announcementFromEvent(announce(sk, linkUrl().url, 1))!;
    const kept = announcementFromEvent(announce(sk, linkUrl().url, 2))!;
    const qc = new QueryClient();
    const infiniteKey = ["discover", "directory-infinite", ["wss://discover.test"]];
    qc.setQueryData<InfiniteData<{ invites: DiscoveredInvite[] }>>(infiniteKey, {
      pages: [{ invites: [gone, kept] }],
      pageParams: [undefined],
    });

    await forgetDiscoverAnnouncements(qc, [gone.source.id]);

    const ids = (invites: DiscoveredInvite[] | undefined) => invites?.map((i) => i.source.id);
    const infinite = qc.getQueryData<InfiniteData<{ invites: DiscoveredInvite[] }>>(infiniteKey)!;
    expect(ids(infinite.pages[0].invites)).toEqual([kept.source.id]);
  });
});
