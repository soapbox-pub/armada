import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { buildInviteUrl, parseInviteLink } from "@/concord/lib/invite";

import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementsForLinks,
  buildAnnouncementDeletion,
  listingAuthorized,
  boostListingsBySigner,
  listingIdsOf,
  suppressedListings,
  withCopy,
  type DiscoveredInvite,
  type ListingStanding,
} from "@/concord/lib/inviteDiscovery";

import type { NostrRumor } from "@/lib/nostrRumor";

const LINK_A = "a".repeat(64);
const LINK_B = "b".repeat(64);
const ALICE = "1".repeat(64);
const BOB = "2".repeat(64);

function urlFor(linkSigner: string): string {
  return buildInviteUrl("https://armada.buzz", linkSigner, new Uint8Array(16), ["wss://relay.test"]);
}

let n = 0;
function announcement(author: string, linkSigner: string, createdAt: number): NostrRumor {
  return {
    id: (++n).toString(16).padStart(64, "0"),
    pubkey: author,
    kind: KIND_COMMUNITY_ANNOUNCEMENT,
    content: urlFor(linkSigner),
    tags: [],
    created_at: createdAt,
  };
}

function deletion(author: string, ids: string[]): NostrRumor {
  return {
    id: (++n).toString(16).padStart(64, "0"),
    pubkey: author,
    ...buildAnnouncementDeletion(ids),
    created_at: 9999,
  } as NostrRumor;
}

describe("announcementsForLinks", () => {
  it("fixture links parse", () => {
    expect(parseInviteLink(urlFor(LINK_A))?.linkSigner).toBe(LINK_A);
  });

  it("keeps every standing copy of the named links, newest first", () => {
    const older = announcement(ALICE, LINK_A, 100);
    const newer = announcement(ALICE, LINK_A, 200);
    const other = announcement(BOB, LINK_B, 300);
    const out = announcementsForLinks([older, newer, other], new Set([LINK_A]));
    // Both copies: deleting only the newest would promote the older one back
    // onto Discover, which keeps the newest per link.
    expect(out.map((i) => i.source.id)).toEqual([newer.id, older.id]);
  });

  it("honors a deletion only from the announcement's own author", () => {
    const mine = announcement(ALICE, LINK_A, 100);
    const theirs = announcement(BOB, LINK_A, 200);
    const out = announcementsForLinks(
      [mine, theirs, deletion(ALICE, [mine.id]), deletion(ALICE, [theirs.id])],
      new Set([LINK_A]),
    );
    expect(out.map((i) => i.source.id)).toEqual([theirs.id]);
  });

  it("tags the deletion by kind, which is how Discover reads deletions", () => {
    expect(buildAnnouncementDeletion(["ff".repeat(32)]).tags).toContainEqual([
      "k",
      String(KIND_COMMUNITY_ANNOUNCEMENT),
    ]);
  });
});

describe("listingAuthorized", () => {
  const owner = "a".repeat(64);
  const creator = "b".repeat(64);
  const holder = "c".repeat(64);

  it("lets the owner list any link", () => {
    expect(listingAuthorized({ owner }, owner)).toBe(true);
  });

  it("lets the link's own creator list it, by hex or npub", () => {
    expect(listingAuthorized({ owner, creator_npub: creator }, creator)).toBe(true);
    expect(listingAuthorized({ owner, creator_npub: nip19.npubEncode(creator) }, creator)).toBe(true);
  });

  it("refuses someone who merely holds the link", () => {
    expect(listingAuthorized({ owner, creator_npub: creator }, holder)).toBe(false);
    expect(listingAuthorized({ owner }, holder)).toBe(false);
    expect(listingAuthorized({ owner, creator_npub: "garbage" }, holder)).toBe(false);
  });
});

describe("suppressedListings", () => {
  const LINK_C = "c".repeat(64);
  const COMMUNITY = "d".repeat(64);
  const listing = (linkSigner: string, author: string, createdAt: number): DiscoveredInvite => ({
    inviteUrl: urlFor(linkSigner),
    linkSigner,
    source: announcement(author, linkSigner, createdAt),
  });
  const standing = (over: Partial<ListingStanding> = {}): ListingStanding => ({
    communityId: COMMUNITY,
    owner: ALICE,
    epoch: 3,
    sharerRank: 0,
    retired: false,
    ...over,
  });

  it("hides a retired link even with no sibling to stand in", () => {
    const a = listing(LINK_A, ALICE, 10);
    expect(suppressedListings([a], { [LINK_A]: standing({ retired: true }) })).toEqual(new Set([LINK_A]));
  });

  it("keeps the link on the newest epoch over an older, newer-announced one", () => {
    const old = listing(LINK_A, ALICE, 20);
    const current = listing(LINK_B, BOB, 10);
    const out = suppressedListings([old, current], {
      [LINK_A]: standing({ epoch: 2 }),
      [LINK_B]: standing({ epoch: 3, sharerRank: 2 }),
    });
    expect(out).toEqual(new Set([LINK_A]));
  });

  it("ranks the owner's link over staff's over anyone else's on one epoch", () => {
    const staff = listing(LINK_A, BOB, 30);
    const other = listing(LINK_B, BOB, 40);
    const owner = listing(LINK_C, ALICE, 10);
    const standings = {
      [LINK_A]: standing({ sharerRank: 1 }),
      [LINK_B]: standing({ sharerRank: 2 }),
      [LINK_C]: standing({ sharerRank: 0 }),
    };
    expect(suppressedListings([staff, other, owner], standings)).toEqual(new Set([LINK_A, LINK_B]));
    expect(suppressedListings([staff, other], standings)).toEqual(new Set([LINK_B]));
  });

  it("falls to the next link when the best one is retired", () => {
    const best = listing(LINK_A, ALICE, 20);
    const next = listing(LINK_B, BOB, 10);
    const out = suppressedListings([best, next], {
      [LINK_A]: standing({ retired: true }),
      [LINK_B]: standing({ sharerRank: 1 }),
    });
    expect(out).toEqual(new Set([LINK_A]));
  });

  it("leaves unresolved listings and other communities alone", () => {
    const a = listing(LINK_A, ALICE, 10);
    const b = listing(LINK_B, BOB, 10);
    const c = listing(LINK_C, BOB, 10);
    const out = suppressedListings([a, b, c], {
      [LINK_A]: standing(),
      [LINK_B]: standing({ communityId: "e".repeat(64), owner: BOB }),
    });
    expect(out.size).toBe(0);
  });
});

describe("boosts across a community's listings", () => {
  const LINK_C = "c".repeat(64);
  const listing = (linkSigner: string, createdAt: number): DiscoveredInvite => ({
    inviteUrl: urlFor(linkSigner),
    linkSigner,
    source: announcement(ALICE, linkSigner, createdAt),
  });

  it("folds another announcement of the same link in as a copy, with its own copies", () => {
    const newest = listing(LINK_A, 30);
    const older = withCopy(listing(LINK_A, 20), listing(LINK_A, 10));
    const merged = withCopy(newest, older);
    expect(listingIdsOf(merged).sort()).toEqual([newest.source.id, older.source.id, ...older.copies!].sort());
    // Folding in what is already held changes nothing, identity included.
    expect(withCopy(merged, older)).toBe(merged);
  });

  it("counts every listing that resolves to the same community, copies included", () => {
    const a = withCopy(listing(LINK_A, 30), listing(LINK_A, 10));
    const b = listing(LINK_B, 20);
    const other = listing(LINK_C, 5);
    const out = boostListingsBySigner([a, b, other], {
      [LINK_A]: { communityId: "d".repeat(64) },
      [LINK_B]: { communityId: "d".repeat(64) },
      [LINK_C]: { communityId: "e".repeat(64) },
    });
    const shared = [...listingIdsOf(a), b.source.id].sort();
    expect(out.get(LINK_A)).toEqual(shared);
    expect(out.get(LINK_B)).toEqual(shared);
    expect(out.get(LINK_C)).toEqual([other.source.id]);
  });

  it("keeps an unresolved listing's boosts to its own announcements", () => {
    const a = withCopy(listing(LINK_A, 30), listing(LINK_A, 10));
    expect(boostListingsBySigner([a], {}).get(LINK_A)).toEqual(listingIdsOf(a));
  });
});
