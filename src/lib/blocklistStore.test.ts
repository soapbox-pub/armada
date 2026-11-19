import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

const kv = new Map<string, unknown>();
vi.mock("@/lib/db/armadaDB", () => ({
  getArmadaDB: () => ({
    kv: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => void kv.set(key, value),
    },
  }),
}));

const sk = generateSecretKey();
const pk = getPublicKey(sk);
vi.mock("@/lib/blocklist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blocklist")>();
  return { ...actual, BLOCKLIST_AUTHORS: [...actual.BLOCKLIST_AUTHORS, pk] };
});

const { blocklistHash, BLOCKLIST_KIND } = await import("@/lib/blocklist");
const {
  applyBlocklistSetting,
  blocklistAuthors,
  checkUserBan,
  isBlockedNow,
  refreshBlocklist,
  resetBlocklistForTests,
  setBlocklistAuthors,
} = await import("@/lib/blocklistStore");
const { isUserBannedNow } = await import("@/lib/bannedUsers");

const SCRAMTOWN = "ef9453dbfeda7afa8e6b48bf5e2b8e8bc5bf6ed8175204ddb54e80249d33158b";
const OTHER = "11".repeat(32);

/** Through JSON, as from a relay: nostr-tools caches a verification on the object itself. */
function entry(id: string, status: string, createdAt: number, scope: "community" | "user" = "community"): NostrEvent {
  return JSON.parse(JSON.stringify(finalizeEvent({
    kind: BLOCKLIST_KIND,
    created_at: createdAt,
    tags: [["d", blocklistHash(id, scope)], ["scope", scope], ["status", status], ["v", "1"]],
    content: "",
  }, sk)));
}

function pool(result: NostrEvent[] | Error) {
  const query = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { query, pool: { group: () => ({ query }) } };
}

describe("blocklistStore", () => {
  beforeEach(() => {
    kv.clear();
    resetBlocklistForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("blocks nothing before the first fetch", () => {
    expect(isBlockedNow(SCRAMTOWN)).toBe(false);
  });

  it("isn't fooled by what isn't a community id", () => {
    expect(isBlockedNow("not-an-id")).toBe(false);
  });

  it("blocks what it fetches, and caches it", async () => {
    await refreshBlocklist(pool([entry(SCRAMTOWN, "blocked", 100)]).pool);
    expect(isBlockedNow(SCRAMTOWN)).toBe(true);
    expect(isBlockedNow(OTHER)).toBe(false);
    expect(kv.get("blocklist:events")).toHaveLength(1);
  });

  it("lets a newer lift undo a block", async () => {
    await refreshBlocklist(pool([entry(SCRAMTOWN, "blocked", 100)]).pool);
    await refreshBlocklist(pool([entry(SCRAMTOWN, "lifted", 200)]).pool, { force: true });
    expect(isBlockedNow(SCRAMTOWN)).toBe(false);
    expect(kv.get("blocklist:events")).toHaveLength(1);
  });

  it("keeps what it holds when the relays fail", async () => {
    await refreshBlocklist(pool([entry(SCRAMTOWN, "blocked", 100)]).pool);
    await refreshBlocklist(pool(new Error("offline")).pool, { force: true });
    expect(isBlockedNow(SCRAMTOWN)).toBe(true);
  });

  it("restores the last session's fetch from the cache", async () => {
    kv.set("blocklist:events", [entry(OTHER, "blocked", 100)]);
    await refreshBlocklist(pool(new Error("offline")).pool);
    expect(isBlockedNow(OTHER)).toBe(true);
  });

  it("doesn't fetch again while fresh, unless forced", async () => {
    const { query, pool: p } = pool([]);
    await refreshBlocklist(p);
    await refreshBlocklist(p);
    expect(query).toHaveBeenCalledTimes(1);
    await refreshBlocklist(p, { force: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("bans the users it fetches, and only them", async () => {
    await refreshBlocklist(pool([entry(OTHER, "blocked", 100, "user")]).pool);
    expect(isUserBannedNow(OTHER)).toBe(true);
    expect(isUserBannedNow(SCRAMTOWN)).toBe(false);
    expect(isBlockedNow(OTHER)).toBe(false);
  });

  it("fetches a user's own entry by its hash, once while fresh", async () => {
    const { query, pool: p } = pool([entry(OTHER, "blocked", 100, "user")]);
    await checkUserBan(p, OTHER);
    await checkUserBan(p, OTHER);
    expect(query).toHaveBeenCalledTimes(1);
    expect((query.mock.calls[0] as unknown[])[0]).toMatchObject([{ "#d": [blocklistHash(OTHER, "user")] }]);
    expect(isUserBannedNow(OTHER)).toBe(true);
    expect(kv.get("blocklist:events")).toHaveLength(1);
  });

  it("stops counting a removed key's entries at once", async () => {
    await refreshBlocklist(pool([entry(SCRAMTOWN, "blocked", 100), entry(OTHER, "blocked", 100, "user")]).pool);
    setBlocklistAuthors([]);
    expect(isBlockedNow(SCRAMTOWN)).toBe(false);
    expect(isUserBannedNow(OTHER)).toBe(false);
    expect(kv.get("blocklist:events")).toHaveLength(0);
  });

  it("fetches nothing with no keys", async () => {
    setBlocklistAuthors([]);
    const { query, pool: p } = pool([]);
    await refreshBlocklist(p);
    await checkUserBan(p, OTHER);
    expect(query).not.toHaveBeenCalled();
  });

  it("fetches a new key's entries even while fresh", async () => {
    const { query, pool: p } = pool([]);
    await refreshBlocklist(p);
    const other = "22".repeat(32);
    setBlocklistAuthors([other]);
    await refreshBlocklist(p);
    expect(query).toHaveBeenCalledTimes(2);
    expect((query.mock.calls[1] as unknown[])[0]).toMatchObject([{ authors: [other] }]);
  });

  it("ignores a fetch that finishes after the keys change", async () => {
    let resolve: ((events: NostrEvent[]) => void) | undefined;
    const p = { group: () => ({ query: () => new Promise<NostrEvent[]>((r) => (resolve = r)) }) };
    const pending = refreshBlocklist(p);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    if (!resolve) return;
    setBlocklistAuthors(["22".repeat(32), pk]);
    resolve([entry(SCRAMTOWN, "blocked", 100)]);
    await pending;
    expect(isBlockedNow(SCRAMTOWN)).toBe(false);
  });

  it("applies the user's setting on the web", () => {
    applyBlocklistSetting("none");
    expect(blocklistAuthors()).toEqual([]);
    applyBlocklistSetting("");
    expect(blocklistAuthors()).toContain(pk);
  });
});
