import { describe, expect, it } from "vitest";

import { webxdcSubdomain } from "./iframeSubdomain";

describe("webxdcSubdomain", () => {
  const key = { key: "aa".repeat(32), nonce: "bb".repeat(16) };

  it("is stable for the same app in the same chat", () => {
    expect(webxdcSubdomain("dm|x", "topic", "https://b/1.xdc", key))
      .toBe(webxdcSubdomain("dm|x", "topic", "https://b/1.xdc", key));
  });

  it("gives a reused topic a fresh origin in another chat or for other bytes", () => {
    const base = webxdcSubdomain("dm|x", "topic", "https://b/1.xdc", key);
    expect(webxdcSubdomain("dm|y", "topic", "https://b/1.xdc", key)).not.toBe(base);
    expect(webxdcSubdomain("dm|x", "topic", "https://b/2.xdc", key)).not.toBe(base);
    expect(webxdcSubdomain("dm|x", "topic", "https://b/1.xdc", { ...key, key: "cc".repeat(32) })).not.toBe(base);
    expect(webxdcSubdomain("dm|x", "topic", "https://b/1.xdc")).not.toBe(base);
  });

  it("is a valid DNS label", () => {
    expect(webxdcSubdomain("dm|x", "t", "u")).toMatch(/^[0-9a-z]{50}$/);
  });
});
