import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { buildInviteUrl, parseInviteLink } from "@/concord/lib/invite";

import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementsForLinks,
  buildAnnouncementDeletion,
  listingAuthorized,
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
