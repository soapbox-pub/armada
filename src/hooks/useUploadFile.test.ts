import { describe, expect, it } from "vitest";

import { padNostrAuthorization, repairDoubledScheme } from "./useUploadFile";

describe("repairDoubledScheme", () => {
  it("collapses a doubled scheme with the second colon missing", () => {
    expect(
      repairDoubledScheme("https://https//blossom.dreamith.to/3c25.png"),
    ).toBe("https://blossom.dreamith.to/3c25.png");
  });

  it("collapses a doubled scheme with the second colon intact", () => {
    expect(
      repairDoubledScheme("https://https://blossom.dreamith.to/3c25.png"),
    ).toBe("https://blossom.dreamith.to/3c25.png");
  });

  it("collapses a doubled http scheme", () => {
    expect(repairDoubledScheme("http://http//host/x")).toBe("http://host/x");
  });

  it("normalizes the surviving scheme to lowercase", () => {
    expect(repairDoubledScheme("HTTPS://HTTPS//host/x")).toBe("https://host/x");
  });

  it("leaves a well-formed URL untouched", () => {
    expect(repairDoubledScheme("https://blossom.dreamith.to/3c25.png")).toBe(
      "https://blossom.dreamith.to/3c25.png",
    );
  });

  it("does not touch a host that merely starts with the scheme name", () => {
    expect(repairDoubledScheme("https://httpsworld.example/x")).toBe(
      "https://httpsworld.example/x",
    );
  });
});

describe("padNostrAuthorization", () => {
  it("adds one padding character when needed", () => {
    const headers = padNostrAuthorization({
      Authorization: "Nostr abc",
    });

    expect(headers.get("Authorization")).toBe("Nostr abc=");
  });

  it("adds two padding characters when needed", () => {
    const headers = padNostrAuthorization({
      Authorization: "Nostr ab",
    });

    expect(headers.get("Authorization")).toBe("Nostr ab==");
  });

  it("leaves already aligned base64 unchanged", () => {
    const headers = padNostrAuthorization({
      Authorization: "Nostr abcd",
    });

    expect(headers.get("Authorization")).toBe("Nostr abcd");
  });

  it("leaves non-Nostr authorization headers unchanged", () => {
    const headers = padNostrAuthorization({
      Authorization: "Bearer abc",
    });

    expect(headers.get("Authorization")).toBe("Bearer abc");
  });
});
