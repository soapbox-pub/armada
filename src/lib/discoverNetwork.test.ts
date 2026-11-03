import { describe, expect, it } from "vitest";

import {
  chunkAuthors,
  packNetwork,
  rankDiscoverNetwork,
  unpackNetwork,
} from "@/lib/discoverNetwork";

import type { NostrRumor } from "@/lib/nostrRumor";

const pk = (c: string) => c.repeat(64);

function list(pubkey: string, follows: string[], createdAt = 1): NostrRumor {
  return {
    id: `${pubkey}${createdAt}`,
    kind: 3,
    pubkey,
    created_at: createdAt,
    content: "",
    tags: follows.map((p) => ["p", p]),
  } as NostrRumor;
}

describe("rankDiscoverNetwork", () => {
  const me = pk("0");
  const [ana, ben] = [pk("a"), pk("b")];

  it("ranks follows-of-follows by how many follows name them, excluding direct ones", () => {
    const ranked = rankDiscoverNetwork(me, [ana, ben], [
      list(ana, [pk("c"), pk("d"), ben, me]),
      list(ben, [pk("d"), pk("d"), ana]),
    ]);
    expect(ranked).toEqual([pk("d"), pk("c")]);
  });

  it("ignores lists by strangers and all but each follow's newest list", () => {
    const ranked = rankDiscoverNetwork(me, [ana], [
      list(ana, [pk("c")], 1),
      list(ana, [pk("e")], 2),
      list(pk("f"), [pk("9")]),
    ]);
    expect(ranked).toEqual([pk("e")]);
  });

  it("caps the network", () => {
    const ranked = rankDiscoverNetwork(me, [ana], [list(ana, [pk("c"), pk("d"), pk("e")])], 2);
    expect(ranked).toHaveLength(2);
  });
});

describe("chunkAuthors", () => {
  it("splits into bounded chunks and nothing for nobody", () => {
    expect(chunkAuthors([], 2)).toEqual([]);
    expect(chunkAuthors(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("packNetwork", () => {
  it("round-trips and rejects anything malformed", () => {
    const authors = [pk("a"), pk("b")];
    expect(unpackNetwork(packNetwork(authors, 5))).toEqual({ updatedAt: 5, authors });
    expect(unpackNetwork({ updatedAt: 5, authors: "abc" })).toBeNull();
    expect(unpackNetwork({ updatedAt: 5, authors: "Z".repeat(64) })).toBeNull();
    expect(unpackNetwork(undefined)).toBeNull();
  });
});
