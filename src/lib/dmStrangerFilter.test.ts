import { describe, expect, it } from "vitest";

import { containsLink, dmOpenerOf, strangerDmFiltered } from "@/lib/dmStrangerFilter";

describe("containsLink", () => {
  it("finds scheme and bare-domain links the renderer would link", () => {
    expect(containsLink("free nitro https://spam.example/claim")).toBe(true);
    expect(containsLink("HTTP://SPAM.EXAMPLE")).toBe(true);
    expect(containsLink("go to spam.example/claim now")).toBe(true);
    expect(containsLink("[click](https://spam.example)")).toBe(true);
  });

  it("ignores text without one", () => {
    expect(containsLink("hey, are you coming tonight?")).toBe(false);
    expect(containsLink("see you at 8.30")).toBe(false);
    expect(containsLink("example.com")).toBe(false);
  });
});

describe("dmOpenerOf", () => {
  it("counts a link only in a chat message: a file message's content is its URL", () => {
    expect(dmOpenerOf({ author: "a", kind: 14, content: "https://x.example/y" }).link).toBe(true);
    expect(dmOpenerOf({ author: "a", kind: 15, content: "https://blossom.example/abc" }).link).toBe(false);
  });
});

describe("strangerDmFiltered", () => {
  const member = "m".repeat(64);
  const outsider = "o".repeat(64);
  const policy = (blockNonMembers: boolean) => ({ communityPeers: new Set([member]), blockNonMembers });

  it("filters an outsider who opened with a link", () => {
    expect(strangerDmFiltered({ author: outsider, link: true }, policy(false))).toBe(true);
    expect(strangerDmFiltered({ author: outsider, link: false }, policy(false))).toBe(false);
  });

  it("never filters a community member", () => {
    expect(strangerDmFiltered({ author: member, link: true }, policy(false))).toBe(false);
    expect(strangerDmFiltered({ author: member, link: false }, policy(true))).toBe(false);
  });

  it("filters every outsider when non-members are blocked", () => {
    expect(strangerDmFiltered({ author: outsider, link: false }, policy(true))).toBe(true);
  });

  it("is off until both the opener and the memberships are known", () => {
    expect(strangerDmFiltered(undefined, policy(true))).toBe(false);
    expect(strangerDmFiltered({ author: outsider, link: true }, undefined)).toBe(false);
  });
});
