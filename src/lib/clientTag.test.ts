// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientNameOf, clientTag, parseClientTag, setClientTagEnabled, withClientTag } from "@/lib/clientTag";

const FALLBACK = ["client", "Armada"];

afterEach(() => {
  delete (window as { ENV?: unknown }).ENV;
  setClientTagEnabled(true);
  vi.restoreAllMocks();
});

describe("parseClientTag", () => {
  it("falls back when unset", () => {
    expect(parseClientTag(undefined, FALLBACK)).toEqual(FALLBACK);
  });

  it("reads an explicit empty value as no tag", () => {
    expect(parseClientTag("", FALLBACK)).toBeNull();
    expect(parseClientTag("  ", FALLBACK)).toBeNull();
  });

  it("accepts a full NIP-89 tag", () => {
    const tag = ["client", "My Armada", "31990:abc:def", "wss://relay.example"];
    expect(parseClientTag(JSON.stringify(tag), FALLBACK)).toEqual(tag);
  });

  it("falls back on anything that isn't a client tag", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["Armada", "[\"client\"]", "[\"t\",\"x\"]", "[\"client\",\" \"]", "[\"client\",1]", "{}"]) {
      expect(parseClientTag(raw, FALLBACK)).toEqual(FALLBACK);
    }
  });
});

describe("withClientTag", () => {
  it("replaces a carried-forward client tag with this build's", () => {
    expect(withClientTag([["p", "x"], ["client", "Other"]])).toEqual([["p", "x"], ["client", "Armada"]]);
  });

  it("follows window.ENV", () => {
    (window as { ENV?: unknown }).ENV = { CLIENT_TAG: "[\"client\",\"Fleet\",\"31990:pk:fleet\"]" };
    expect(clientTag()).toEqual(["client", "Fleet", "31990:pk:fleet"]);
    (window as { ENV?: unknown }).ENV = { CLIENT_TAG: "" };
    expect(withClientTag([["client", "Other"]])).toEqual([]);
  });

  it("strips every client tag when the user turns it off", () => {
    setClientTagEnabled(false);
    expect(clientTag()).toBeNull();
    expect(withClientTag([["e", "y"], ["client", "Other"]])).toEqual([["e", "y"]]);
  });
});

describe("clientNameOf", () => {
  it("reads the first client tag's name", () => {
    expect(clientNameOf([["client", "Armada"], ["client", "Other"]])).toBe("Armada");
    expect(clientNameOf([["p", "x"]])).toBeUndefined();
    expect(clientNameOf([["client"]])).toBeUndefined();
  });

  it("collapses whitespace, drops control characters and caps the length", () => {
    expect(clientNameOf([["client", " Some\n\u0007 App "]])).toBe("Some App");
    expect(clientNameOf([["client", "\u0000\t "]])).toBeUndefined();
    const long = clientNameOf([["client", "x".repeat(200)]]);
    expect(long).toHaveLength(48);
    expect(long?.endsWith("…")).toBe(true);
  });
});
