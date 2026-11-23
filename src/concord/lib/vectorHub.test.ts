import { describe, expect, it } from "vitest";

import { buildInviteUrl } from "@/concord/lib/invite";
import { parseVectorHub } from "@/concord/lib/vectorHub";

const LINK_A = "a".repeat(64);
const LINK_B = "b".repeat(64);

function urlFor(linkSigner: string): string {
  return buildInviteUrl("https://vectorapp.io", linkSigner, new Uint8Array(16), ["wss://relay.test"]);
}

function raw(over: Record<string, unknown>) {
  return {
    id: 1,
    name: "Some community",
    description: "Shown nowhere",
    category: "General",
    invite_url: urlFor(LINK_A),
    icon_url: "data:image/png;base64,AAAA",
    member_count: 12,
    official: false,
    created_at: 1_700_000_000,
    ...over,
  };
}

describe("parseVectorHub", () => {
  it("reads a listing's link and the hub's own claims, in the hub's order", () => {
    const out = parseVectorHub([raw({ id: 55, official: true }), raw({ id: 34, invite_url: urlFor(LINK_B), member_count: null })]);
    expect(out).toEqual([
      {
        id: 55,
        inviteUrl: urlFor(LINK_A),
        linkSigner: LINK_A,
        category: "General",
        memberCount: 12,
        official: true,
        createdAt: 1_700_000_000,
        rank: 0,
      },
      expect.objectContaining({ id: 34, linkSigner: LINK_B, memberCount: null, official: false, rank: 1 }),
    ]);
  });

  it("drops entries without a joinable invite link, and repeats of a link", () => {
    const out = parseVectorHub([
      raw({ invite_url: "https://vectorapp.io/invite/naddr1nothing" }),
      raw({ invite_url: 42 }),
      null,
      "junk",
      raw({}),
      raw({ id: 2 }),
    ]);
    expect(out.map((l) => [l.id, l.rank])).toEqual([[1, 0]]);
  });

  it("treats only a literal true as official and a malformed count as unknown", () => {
    const [listing] = parseVectorHub([raw({ official: "yes", member_count: -3 })]);
    expect(listing.official).toBe(false);
    expect(listing.memberCount).toBeNull();
  });

  it("reads anything but an array as no listings", () => {
    expect(parseVectorHub({ error: "down" })).toEqual([]);
    expect(parseVectorHub(null)).toEqual([]);
  });
});
