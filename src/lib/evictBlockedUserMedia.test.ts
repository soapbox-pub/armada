// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const evicted = vi.hoisted(() => ({ urls: [] as string[], hashes: [] as string[] }));
vi.mock("@/lib/encryptedMedia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/encryptedMedia")>()),
  evictAttachment: (url: string) => evicted.urls.push(url),
}));
vi.mock("@/lib/mediaCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mediaCache")>()),
  forgetBlob: (hash: string) => evicted.hashes.push(hash),
}));

import { getArmadaDB, purgeArmadaDB } from "@/lib/db/armadaDB";
import { evictNewlyBlockedMedia } from "@/lib/evictBlockedUserMedia";
import { clearFoldedMemory } from "@/lib/foldedCache";

import type { NostrRumor } from "@/lib/nostrRumor";

const BLOCKED = "a".repeat(64);
const OTHER = "b".repeat(64);
const SELF = "c".repeat(64);
const COMMUNITY = "d".repeat(64);
const blob = (c: string) => c.repeat(64);
const url = (c: string) => `https://blossom.example/${blob(c)}.jpg`;

let n = 0;
const rumor = (extra: Partial<NostrRumor> = {}): NostrRumor => ({
  id: (++n).toString(16).padStart(64, "0"), pubkey: BLOCKED, created_at: 1, kind: 9, tags: [], content: "hi", ...extra,
});

beforeEach(async () => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await purgeArmadaDB();
  clearFoldedMemory();
  localStorage.clear();
  evicted.urls.length = 0;
  evicted.hashes.length = 0;
});

describe("evictNewlyBlockedMedia", () => {
  it("drops a blocked user's media and profile images, keeping their rows and everyone else's media", async () => {
    const db = getArmadaDB();
    const chat = rumor({ tags: [["imeta", `url ${url("1")}`, `x ${blob("1")}`]], content: url("1") });
    const profile = rumor({ kind: 0, content: JSON.stringify({ picture: url("2"), banner: url("3") }) });
    const someoneElses = rumor({ pubkey: OTHER, content: url("4") });
    await db.tenant(`c2:${COMMUNITY}`).event(chat);
    await db.tenant(`c2:${COMMUNITY}`).event(someoneElses);
    await db.tenant("main").event(profile);

    await evictNewlyBlockedMedia(SELF, new Set([BLOCKED]));

    expect(new Set(evicted.hashes)).toEqual(new Set([blob("1"), blob("2"), blob("3")]));
    expect(evicted.urls).not.toContain(url("4"));
    expect(await db.tenant(`c2:${COMMUNITY}`).query([{ ids: [chat.id] }])).toHaveLength(1);
  });

  it("evicts once per block, and again after an unblock", async () => {
    await getArmadaDB().tenant("main").event(rumor({ content: url("5") }));

    await evictNewlyBlockedMedia(SELF, new Set([BLOCKED]));
    expect(evicted.hashes).toEqual([blob("5")]);

    await evictNewlyBlockedMedia(SELF, new Set([BLOCKED]));
    expect(evicted.hashes).toEqual([blob("5")]);

    await evictNewlyBlockedMedia(SELF, new Set());
    await evictNewlyBlockedMedia(SELF, new Set([BLOCKED]));
    expect(evicted.hashes).toEqual([blob("5"), blob("5")]);
  });
});
