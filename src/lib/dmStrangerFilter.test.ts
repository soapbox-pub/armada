import { describe, expect, it } from "vitest";

import { containsLink, dmScreenOf, mergeDmScreens, strangerDmFiltered } from "@/lib/dmStrangerFilter";

// Mirrored by StrangerFilterTest.kt and StrangerFilterTests.swift: the three ports
// must agree on what a link is.
const LINK_VECTORS: ReadonlyArray<[string, boolean]> = [
  ["free nitro https://spam.example/claim", true],
  ["HTTP://SPAM.EXAMPLE", true],
  ["wss://relay.example", true],
  ["go to spam.example/claim now", true],
  ["[click](https://spam.example)", true],
  ["<https://spam.example>", true],
  ["||https://spam.example||", true],
  ["hey, are you coming tonight?", false],
  ["see you at 8.30", false],
  ["example.com", false],
  ["https://", false],
  ["https:// spam", false],
  ["https://\u00a0spam", false],
  ["https://\u2028spam", false],
  ["hxxps://spam.example/x", true],
  ["hxxps://spam[.]example", false],
  ["spam[.]example/x", false],
];

describe("containsLink", () => {
  it.each(LINK_VECTORS)("%j → %s", (content, expected) => {
    expect(containsLink(content)).toBe(expected);
  });
});

describe("dmScreenOf", () => {
  const self = "s".repeat(64);
  const a = "a".repeat(64);
  const b = "b".repeat(64);

  it("collects authors and who sent a link, never the viewer", () => {
    expect(dmScreenOf([
      { author: a, kind: 14, content: "hi" },
      { author: b, kind: 14, content: "https://x.example/y" },
      { author: self, kind: 14, content: "https://mine.example/z" },
    ], self)).toEqual({ authors: [a, b], linkAuthors: [b] });
  });

  it("never counts a file message's URL as a link", () => {
    expect(dmScreenOf([{ author: a, kind: 15, content: "https://blossom.example/abc" }], self).linkAuthors).toEqual([]);
  });

  it("treats every author as a link sender past the read window", () => {
    expect(dmScreenOf([{ author: a, kind: 14, content: "hi" }], self, true).linkAuthors).toEqual([a]);
  });

  it("merges by union", () => {
    const one = dmScreenOf([{ author: a, kind: 14, content: "hi" }], self);
    const two = dmScreenOf([{ author: a, kind: 14, content: "spam.example/x" }], self);
    expect(mergeDmScreens(one, two)).toEqual({ authors: [a], linkAuthors: [a] });
  });
});

describe("strangerDmFiltered", () => {
  const member = "m".repeat(64);
  const outsider = "o".repeat(64);
  const policy = (blockNonMembers: boolean) => ({ communityPeers: new Set([member]), blockNonMembers });

  it("filters a conversation where an outsider sent a link", () => {
    expect(strangerDmFiltered({ authors: [outsider], linkAuthors: [outsider] }, policy(false))).toBe(true);
    expect(strangerDmFiltered({ authors: [outsider], linkAuthors: [] }, policy(false))).toBe(false);
  });

  it("never filters for a community member's link", () => {
    expect(strangerDmFiltered({ authors: [member], linkAuthors: [member] }, policy(false))).toBe(false);
    expect(strangerDmFiltered({ authors: [member], linkAuthors: [] }, policy(true))).toBe(false);
  });

  it("filters any outsider in a group, a member beside them notwithstanding", () => {
    expect(strangerDmFiltered({ authors: [member, outsider], linkAuthors: [outsider] }, policy(false))).toBe(true);
  });

  it("filters every outsider when non-members are blocked", () => {
    expect(strangerDmFiltered({ authors: [outsider], linkAuthors: [] }, policy(true))).toBe(true);
  });

  it("is off until both the screen and the memberships are known", () => {
    expect(strangerDmFiltered(undefined, policy(true))).toBe(false);
    expect(strangerDmFiltered({ authors: [outsider], linkAuthors: [outsider] }, undefined)).toBe(false);
  });
});
