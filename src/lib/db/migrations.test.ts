// @vitest-environment node
/** The schema runner only advances the version over data that actually converted. */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SchemaMigration } from "./schema";

const A = "a".repeat(64);
const B = "b".repeat(64);

async function freshModules() {
  vi.resetModules();
  const migrations = await import("./migrations");
  const schema = await import("./schema");
  const { getArmadaDB } = await import("./armadaDB");
  return { ...migrations, ...schema, kv: getArmadaDB().kv };
}

describe("schema migrations", { timeout: 30_000 }, () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("stamps the current version after a clean run", async () => {
    const { runMigrations, kv, ARMADA_DB_VERSION, SCHEMA_VERSION_KEY } = await freshModules();
    await runMigrations([A]);
    expect(await kv.get(SCHEMA_VERSION_KEY)).toBe(ARMADA_DB_VERSION);
  });

  it("runs a per-account step for every account, then stamps it", async () => {
    const mod = await freshModules();
    const seen: Array<string | undefined> = [];
    const step: SchemaMigration = {
      to: mod.ARMADA_DB_VERSION,
      label: "Test step",
      perAccount: true,
      run: (self) => {
        seen.push(self);
        return Promise.resolve();
      },
    };
    mod.SCHEMA_MIGRATIONS.push(step);
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, mod.ARMADA_DB_VERSION - 1);

    expect((await mod.pendingUpgrades()).schema).toEqual([step]);
    await mod.runMigrations([A, B]);

    expect(seen).toEqual([A, B]);
    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(mod.ARMADA_DB_VERSION);
  });

  it("leaves the version unstamped when a step fails, so the next launch retries", async () => {
    const mod = await freshModules();
    mod.SCHEMA_MIGRATIONS.push({
      to: mod.ARMADA_DB_VERSION,
      label: "Failing step",
      run: () => Promise.reject(new Error("disk on fire")),
    });
    const before = mod.ARMADA_DB_VERSION - 1;
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, before);

    await mod.runMigrations([A]);

    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(before);
  });

  it("converts each Guestbook address array into a key per rumor (v4)", async () => {
    const mod = await freshModules();
    const { readGuestbookAddresses } = await import("@/concord/lib/rumorStore");
    const community = "c".repeat(64);
    const [r1, r2, pk] = ["1".repeat(64), "2".repeat(64), "d".repeat(64)];
    await mod.kv.set(`c2gbpk:${community}:${pk}`, [r1, r2]);
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, 3);

    expect((await mod.pendingUpgrades()).schema.map((m) => m.to)).toEqual([4]);
    await mod.runMigrations([A]);

    expect(await mod.kv.get(`c2gbpk:${community}:${pk}`)).toBeUndefined();
    const addrs = await readGuestbookAddresses(community);
    expect([...addrs.keys()].sort()).toEqual([r1, r2]);
    expect([...addrs.get(r1)!]).toEqual([pk]);
    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(mod.ARMADA_DB_VERSION);
  });

  it("converts each Control snapshot id array into a key per edition (v5), leaving converted entries alone", async () => {
    const mod = await freshModules();
    const { readControlSnapshot } = await import("@/concord/lib/rumorStore");
    const community = "e".repeat(64);
    const [r1, r2, r3, pk] = ["1".repeat(64), "2".repeat(64), "3".repeat(64), "f".repeat(64)];
    await mod.kv.set(`c2snap:${community}:${pk}`, [r1, r2]);
    await mod.kv.set(`c2snap:${community}:${pk}:${r3}`, 1);
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, 4);

    expect((await mod.pendingUpgrades()).schema.map((m) => m.to)).toEqual([5]);
    await mod.runMigrations([A]);

    expect(await mod.kv.get(`c2snap:${community}:${pk}`)).toBeUndefined();
    expect([...((await readControlSnapshot(community, pk)) ?? [])].sort()).toEqual([r1, r2, r3]);
    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(mod.ARMADA_DB_VERSION);
  });

  it("forgets the plane sweeps' wrap memos and Guestbook cursors, so what older rules dropped is read again (v6)", async () => {
    const mod = await freshModules();
    const community = "e".repeat(64);
    const guestbookCursor = `folded:concord2-cursor:guestbook:${community}@0|wss://r.test`;
    const channelCursor = `folded:concord2-cursor:${"c".repeat(64)}`;
    await mod.kv.set("plane-seen-wraps:0", "x".repeat(64));
    await mod.kv.set("plane-junk-wraps:0", "y".repeat(64));
    await mod.kv.set(guestbookCursor, '{"newest":5,"oldest":1,"exhausted":true}');
    await mod.kv.set(channelCursor, '{"newest":5,"oldest":1,"exhausted":true}');
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, 5);

    expect((await mod.pendingUpgrades()).schema.map((m) => m.to)).toEqual([6, 7]);
    await mod.runMigrations([A]);

    expect(await mod.kv.get("plane-seen-wraps:0")).toBeUndefined();
    expect(await mod.kv.get("plane-junk-wraps:0")).toBeUndefined();
    expect(await mod.kv.get(guestbookCursor)).toBeUndefined();
    // Not a Guestbook's: the channel's cursor rechecks itself (`streamSetSig`).
    expect(await mod.kv.get(channelCursor)).toBeDefined();
    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(mod.ARMADA_DB_VERSION);
  });

  it("drops the Guestbook forward cursors, so each relay starts with a whole read (v7)", async () => {
    const mod = await freshModules();
    const community = "e".repeat(64);
    const guestbookCursor = `folded:concord2-cursor:guestbook:${community}@0|wss://r.test`;
    const channelCursor = `folded:concord2-cursor:${"c".repeat(64)}`;
    const readState = `folded:plane-read:guestbook:${community}@0|wss://r.test`;
    await mod.kv.set(guestbookCursor, '{"newest":5,"oldest":0,"exhausted":false}');
    await mod.kv.set(channelCursor, '{"newest":5,"oldest":1,"exhausted":true}');
    await mod.kv.set(readState, '{"cursor":5,"wholeAt":5}');
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, 6);

    expect((await mod.pendingUpgrades()).schema.map((m) => m.to)).toEqual([7]);
    await mod.runMigrations([A]);

    expect(await mod.kv.get(guestbookCursor)).toBeUndefined();
    expect(await mod.kv.get(channelCursor)).toBeDefined();
    expect(await mod.kv.get(readState)).toBeDefined();
    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(7);
  });

  it("leaves data written by a newer build alone", async () => {
    const mod = await freshModules();
    await mod.kv.set(mod.SCHEMA_VERSION_KEY, 999);

    expect((await mod.pendingUpgrades()).future).toBe(true);
    await mod.runMigrations([A]);
    await mod.markUpToDate();

    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(999);
  });

  it("marks a fresh install up to date without creating any retired database", async () => {
    const mod = await freshModules();

    const pending = await mod.pendingUpgrades();
    expect(pending).toEqual({ schema: [], future: false });
    await mod.markUpToDate();
    expect(await mod.kv.get(mod.SCHEMA_VERSION_KEY)).toBe(mod.ARMADA_DB_VERSION);

    // The ordinary read paths must not reopen (and so re-create) a pre-ArmadaDB store.
    const { readFolded } = await import("@/lib/foldedCache");
    const { queryDm17Conversations } = await import("@/lib/nip17/dm17Store");
    const { queryStoredInvites } = await import("@/concord/lib/inviteInbox");
    await readFolded("anything");
    await queryDm17Conversations(A);
    await queryStoredInvites(A);

    const names = (await (indexedDB as IDBFactory).databases()).map((d) => d.name);
    expect(names.filter((n) => n?.startsWith("armada-"))).toEqual([]);
  });
});
