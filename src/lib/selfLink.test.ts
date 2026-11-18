// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { parseSelfLink, resolvePastedPubkey } from "@/lib/selfLink";

/**
 * jsdom's own origin stands in for a self-hosted deployment here, and
 * `PUBLIC_WEB_ORIGIN` (armada.buzz, the default) for the public one — the two
 * halves of "ours" that a native-built link and a web-built link land on.
 */

const NPUB = "npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p";
const MSG = "9eb8fee9fc77aad33f7957bee461417b882b565958ada1f8f1d3bdccfe1e7da8";

describe("parseSelfLink", () => {
  it("resolves a DM message link on the public origin", () => {
    const link = parseSelfLink(`https://armada.buzz/dm/${NPUB}/m/${MSG}`);
    expect(link).toEqual({
      kind: "chat",
      route: { kind: "dm", peer: NPUB, messageId: MSG },
      path: `/dm/${NPUB}/m/${MSG}`,
    });
  });

  it("resolves a link on the page's own origin", () => {
    const link = parseSelfLink(`${window.location.origin}/c/abc123/general`);
    expect(link).toEqual({
      kind: "chat",
      route: { kind: "concord", communityId: "abc123", channelId: "general" },
      path: "/c/abc123/general",
    });
  });

  it("keeps the search and hash on the routed path", () => {
    const link = parseSelfLink("https://armada.buzz/c/abc123/general?x=1#y");
    expect(link).toMatchObject({ kind: "chat", path: "/c/abc123/general?x=1#y" });
  });

  it("reads a bare npub path as a profile", () => {
    expect(parseSelfLink(`https://armada.buzz/${NPUB}`)).toEqual({
      kind: "profile",
      pubkey: "0461fcbecc4c3374439932d6b8f11269ccdb7cc973ad7a50ae362db135a474dd",
    });
  });

  it("refuses another host", () => {
    expect(parseSelfLink(`https://example.com/dm/${NPUB}/m/${MSG}`)).toBeNull();
  });

  it("refuses a path that names no chat location", () => {
    expect(parseSelfLink("https://armada.buzz/settings")).toBeNull();
    expect(parseSelfLink("https://armada.buzz/")).toBeNull();
  });

  it("refuses a protocol-relative path", () => {
    expect(parseSelfLink("https://armada.buzz//evil.example/dm/x")).toBeNull();
  });

  it("refuses a non-http scheme", () => {
    expect(parseSelfLink("javascript:alert(1)")).toBeNull();
    expect(parseSelfLink("not a url")).toBeNull();
  });
});

describe("resolvePastedPubkey", () => {
  const HEX = "0461fcbecc4c3374439932d6b8f11269ccdb7cc973ad7a50ae362db135a474dd";

  it("accepts a bare or nostr: npub", () => {
    expect(resolvePastedPubkey(NPUB)).toBe(HEX);
    expect(resolvePastedPubkey(`nostr:${NPUB}`)).toBe(HEX);
  });

  it("accepts a profile share link, with or without a scheme", () => {
    expect(resolvePastedPubkey(`https://armada.buzz/${NPUB}`)).toBe(HEX);
    expect(resolvePastedPubkey(` armada.buzz/${NPUB} `)).toBe(HEX);
    expect(resolvePastedPubkey(`${window.location.origin}/${NPUB}`)).toBe(HEX);
  });

  it("refuses names, other hosts and non-profile links", () => {
    expect(resolvePastedPubkey("alice")).toBeUndefined();
    expect(resolvePastedPubkey(`https://example.com/${NPUB}`)).toBeUndefined();
    expect(resolvePastedPubkey(`https://armada.buzz/dm/${NPUB}`)).toBeUndefined();
  });
});
