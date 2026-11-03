// @vitest-environment jsdom
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BLOCKLIST_KIND, bannedUserHashes, blocklistHash, foldBlocklist, isCommunityBlocked, parseBlocklistEntry } from "./blocklist";

const ID = "ef9453dbfeda7afa8e6b48bf5e2b8e8bc5bf6ed8175204ddb54e80249d33158b";
const sk = generateSecretKey();
const pk = getPublicKey(sk);

/** Through JSON, as from a relay: nostr-tools caches a verification on the object itself. */
function entry(status: string, createdAt: number, tags: string[][] = []) {
  const event = finalizeEvent({
    kind: BLOCKLIST_KIND,
    created_at: createdAt,
    tags: [["d", blocklistHash(ID)], ["scope", "community"], ["status", status], ["v", "1"], ...tags],
    content: "",
  }, sk);
  return JSON.parse(JSON.stringify(event));
}

describe("blocklistHash", () => {
  it("matches armada-blocklist's test vector", () => {
    expect(blocklistHash("00".repeat(32))).toBe("cdcb08e5b090621ac90f55b6dfeb124728883c4aded7922ac874e1dd7f415fb2");
  });

  it("ignores case", () => {
    expect(blocklistHash(ID.toUpperCase())).toBe(blocklistHash(ID));
  });

  it("matches armada-blocklist's user test vector", () => {
    expect(blocklistHash("00".repeat(32), "user")).toBe("5651d56b6e1741880b2c3822dfe70dbf1d14ed6497ef26ea5e82b81c29cc1856");
  });
});

describe("user entries", () => {
  const user = (status: string, createdAt: number, hash = blocklistHash(ID, "user")) => JSON.parse(JSON.stringify(finalizeEvent({
    kind: BLOCKLIST_KIND,
    created_at: createdAt,
    tags: [["d", hash], ["scope", "user"], ["status", status], ["v", "1"]],
    content: "",
  }, sk)));

  it("ban a user, and the newest wins", () => {
    expect(bannedUserHashes(foldBlocklist([user("blocked", 1)], [pk]))).toEqual(new Set([blocklistHash(ID, "user")]));
    expect(bannedUserHashes(foldBlocklist([user("blocked", 1), user("lifted", 2)], [pk])).size).toBe(0);
  });

  it("don't block a community, even one listed under the same hash", () => {
    const entries = foldBlocklist([user("blocked", 1, blocklistHash(ID))], [pk]);
    expect(isCommunityBlocked(entries, ID)).toBe(false);
  });

  it("aren't community entries' business", () => {
    expect(bannedUserHashes(foldBlocklist([entry("blocked", 1)], [pk])).size).toBe(0);
  });
});

describe("parseBlocklistEntry", () => {
  it("accepts a signed entry from a pinned author", () => {
    expect(parseBlocklistEntry(entry("blocked", 1), [pk])?.status).toBe("blocked");
  });

  it("ignores other authors", () => {
    expect(parseBlocklistEntry(entry("blocked", 1), ["11".repeat(32)])).toBeUndefined();
  });

  it("ignores a tampered entry", () => {
    const event = entry("lifted", 1);
    event.tags = event.tags.map((t: string[]) => (t[0] === "status" ? ["status", "blocked"] : t));
    expect(parseBlocklistEntry(event, [pk])).toBeUndefined();
  });

  it("ignores an unknown status", () => {
    expect(parseBlocklistEntry(entry("muted", 1), [pk])).toBeUndefined();
  });
});

describe("foldBlocklist", () => {
  it("lets the newest entry win, so a lift undoes a block", () => {
    const entries = foldBlocklist([entry("lifted", 2), entry("blocked", 1)], [pk]);
    expect(isCommunityBlocked(entries, ID)).toBe(false);
    expect(isCommunityBlocked(foldBlocklist([entry("blocked", 3), entry("lifted", 2)], [pk]), ID)).toBe(true);
  });
});

describe("BLOCKLIST_AUTHORS", () => {
  afterEach(() => {
    delete window.ENV;
    vi.resetModules();
  });

  it("defaults to Soapbox's moderation key", async () => {
    expect((await import("./blocklist")).BLOCKLIST_AUTHORS).toEqual([
      "0ddf6c35f61eb040316d01f68ded4d38b579c17423d26715fd489105a981910a",
    ]);
  });

  it("takes window.ENV's keys over the build's", async () => {
    window.ENV = { BLOCKLIST_AUTHORS: ` ${pk.toUpperCase()} , not-a-key` };
    vi.resetModules();
    expect((await import("./blocklist")).BLOCKLIST_AUTHORS).toEqual([pk]);
  });

  it("is off when window.ENV empties it", async () => {
    window.ENV = { BLOCKLIST_AUTHORS: "" };
    vi.resetModules();
    expect((await import("./blocklist")).BLOCKLIST_AUTHORS).toEqual([]);
  });
});
