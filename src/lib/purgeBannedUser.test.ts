// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
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

import { KIND_CONTROL } from "@/concord/lib/kinds";
import { withoutBannedChat } from "@/concord/lib/rumorStore";
import { authorQueryKey } from "@/lib/authorCache";
import { isUserBannedNow, resetBannedUsers, setBannedUserHashes } from "@/lib/bannedUsers";
import { blocklistHash } from "@/lib/blocklist";
import { getArmadaDB, purgeArmadaDB } from "@/lib/db/armadaDB";
import { appEventStore } from "@/lib/db/mainEventStore";
import { clearFoldedMemory } from "@/lib/foldedCache";
import { getDisplayName } from "@/lib/getDisplayName";
import { dm17Store, withoutBannedDms } from "@/lib/nip17/dm17Store";
import { knownBannedUsers, purgeBannedUser } from "@/lib/purgeBannedUser";

import type { NostrRumor } from "@/lib/nostrRumor";

const BANNED = "35c31660dee483851cd155027c6543d4f404451970d5b7f9e8760f1587007584";
const OTHER = "b".repeat(64);
const SELF = "c".repeat(64);
const COMMUNITY = "d".repeat(64);
const BLOB = "a1".repeat(32);
const URL = `https://blossom.example/${BLOB}.jpg`;

let n = 0;
const rumor = (extra: Partial<NostrRumor> = {}): NostrRumor => ({
  id: (++n).toString(16).padStart(64, "0"), pubkey: BANNED, created_at: 1, kind: 9, tags: [], content: "hi", ...extra,
});

beforeEach(async () => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await purgeArmadaDB();
  clearFoldedMemory();
  localStorage.clear();
  resetBannedUsers();
  evicted.urls.length = 0;
  evicted.hashes.length = 0;
});

const ban = () => setBannedUserHashes(new Set([blocklistHash(BANNED, "user")]));

describe("bannedUsers", () => {
  it("knows a banned pubkey only by its entry's hash", () => {
    expect(isUserBannedNow(BANNED)).toBe(false);
    ban();
    expect(isUserBannedNow(BANNED)).toBe(true);
    expect(isUserBannedNow(OTHER)).toBe(false);
    expect(isUserBannedNow("not a pubkey")).toBe(false);
  });

  it("names a banned user nothing of their own", () => {
    ban();
    expect(getDisplayName({ name: "yummy" }, BANNED)).toBe("Unavailable account");
    expect(getDisplayName({ name: "Alice" }, OTHER)).toBe("Alice");
  });
});

describe("the stores", () => {
  it("keep a banned user's chat row as a tombstone, and drop what decorates one", () => {
    ban();
    const opened = (kind: number, author = BANNED) => ({
      author, kind, content: "abuse", tags: [["channel", "x"], ["imeta", `url ${URL}`], ["e", "y"]],
    });
    const [row, ...rest] = withoutBannedChat([opened(9), opened(7), opened(9, OTHER)]);
    expect(row).toMatchObject({ content: "", tags: [["channel", "x"], ["e", "y"]] });
    expect(rest).toEqual([opened(9, OTHER)]);
  });

  it("keep a banned user's DM as a tombstone in its conversation", () => {
    ban();
    const [dm] = withoutBannedDms([{ author: BANNED, kind: 14, content: "abuse", tags: [["p", SELF], ["imeta", `url ${URL}`]] }]);
    expect(dm).toMatchObject({ content: "", tags: [["p", SELF]] });
    expect(withoutBannedDms([{ author: BANNED, kind: 7, content: "+", tags: [] }])).toEqual([]);
  });

  it("don't cache anything else of theirs", async () => {
    ban();
    const store = await appEventStore();
    await store.event({ ...rumor({ kind: 1 }), sig: "" });
    expect(await getArmadaDB().tenant("main").query([{ authors: [BANNED] }])).toEqual([]);
  });
});

describe("purgeBannedUser", () => {
  it("does nothing for someone not banned", async () => {
    const note = rumor({ kind: 1 });
    await getArmadaDB().tenant("main").event(note);
    await purgeBannedUser(SELF, BANNED);
    expect(await getArmadaDB().tenant("main").query([{ ids: [note.id] }])).toHaveLength(1);
  });

  it("tombstones their messages, deletes the rest of theirs, and evicts their media", async () => {
    const db = getArmadaDB();
    const c2 = db.tenant(`c2:${COMMUNITY}`);
    const dm = dm17Store(SELF);
    const main = db.tenant("main");
    const chat = rumor({ tags: [["channel", "x"], ["imeta", `url ${URL}`, `x ${BLOB}`]], content: `look ${URL}` });
    const reaction = rumor({ kind: 7, tags: [["e", chat.id]], content: "+" });
    const control = rumor({ kind: KIND_CONTROL, tags: [], content: "" });
    const theirs = rumor({ kind: 14, tags: [["p", SELF]], content: "abuse" });
    const profile = rumor({ kind: 0, content: JSON.stringify({ name: "yummy", picture: "https://cdn.example/face.png" }) });
    const note = rumor({ kind: 1, content: "abuse" });
    const someoneElses = rumor({ pubkey: OTHER, tags: [["channel", "x"]], content: "hello" });
    for (const row of [chat, reaction, control, someoneElses]) await c2.event(row);
    await dm.event(theirs);
    for (const row of [profile, note]) await main.event(row);

    const queryClient = new QueryClient();
    queryClient.setQueryData(["concord", "timeline"], [{ ...chat, author: BANNED }, someoneElses]);
    queryClient.setQueryData(authorQueryKey(BANNED), { metadata: { name: "yummy" } });

    ban();
    await purgeBannedUser(SELF, BANNED, { queryClient });

    expect(await c2.query([{ ids: [chat.id] }])).toEqual([{ ...chat, content: "", tags: [["channel", "x"]] }]);
    expect(await c2.query([{ ids: [reaction.id] }])).toEqual([]);
    expect(await c2.query([{ ids: [control.id] }])).toHaveLength(1);
    expect(await c2.query([{ ids: [someoneElses.id] }])).toEqual([someoneElses]);
    expect(await dm.query([{ ids: [theirs.id] }])).toEqual([{ ...theirs, content: "" }]);
    expect(await main.query([{ authors: [BANNED] }])).toEqual([]);
    // Refused if a writer that doesn't ask the blocklist delivers it again.
    await main.event(note);
    expect(await main.query([{ ids: [note.id] }])).toEqual([]);

    expect(evicted.urls).toEqual(expect.arrayContaining([URL, "https://cdn.example/face.png"]));
    expect(evicted.hashes).toContain(BLOB);

    const [row, kept] = queryClient.getQueryData<NostrRumor[]>(["concord", "timeline"])!;
    expect(row.content).toBe("");
    expect(kept).toBe(someoneElses);
    expect(queryClient.getQueryData(authorQueryKey(BANNED))).toEqual({});
    expect(await knownBannedUsers()).toEqual([BANNED]);
  });
});
