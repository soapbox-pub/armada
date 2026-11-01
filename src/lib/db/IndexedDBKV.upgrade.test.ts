import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";

import { IndexedDBArmadaDB } from "@/lib/db/IndexedDBArmadaDB";

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

const settled = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => "settled" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

describe("IndexedDB KV upgrade", () => {
  it("doesn't leave storage waiting on an older tab that holds the KV open", async () => {
    // A tab still on the previous build: the v3 KV, open, with no `blocking` handler.
    const old = await openDB("armada:kv", 3, {
      upgrade(db) {
        db.createObjectStore("kv");
        db.createObjectStore("tenants");
        db.createObjectStore("termed");
      },
    });
    await old.put("kv", "kept", "k");

    const db = new IndexedDBArmadaDB("armada");
    expect(await settled(db.kv.get("k"), 3000)).toBe("settled");
    expect(await db.kv.get("k")).toBe("kept");
    // Removal still works on the shared v3 layout, and both contexts see it.
    await db.forget(["a".repeat(64)]);
    expect(await db.kv.removedAmong(["a".repeat(64), "b".repeat(64)])).toEqual(new Set(["a".repeat(64)]));
    old.close();
  });

  it("opens a KV a newer build already moved to a later layout", async () => {
    const newer = await openDB("armada:kv", 4, {
      upgrade(db) {
        for (const store of ["kv", "tenants", "termed", "removed"]) db.createObjectStore(store);
      },
    });
    await newer.put("kv", "kept", "k");
    newer.close();

    const db = new IndexedDBArmadaDB("armada");
    expect(await db.kv.get("k")).toBe("kept");
  });

  it("releases its own KV for a newer build's upgrade", async () => {
    const db = new IndexedDBArmadaDB("armada");
    await db.kv.set("k", "v");

    const newer = openDB("armada:kv", 99, { upgrade() {} });
    expect(await settled(newer, 3000)).toBe("settled");
    (await newer).close();
  });

  it("keeps answering after releasing its KV to a newer build's upgrade", async () => {
    const db = new IndexedDBArmadaDB("armada");
    await db.kv.set("k", "v");

    const newer = await openDB("armada:kv", 99, { upgrade() {} });
    await newer.put("kv", "theirs", "k2");
    newer.close();

    // Reopened on the later layout rather than left closed.
    expect(await db.kv.get("k")).toBe("v");
    expect(await db.kv.get("k2")).toBe("theirs");
    await db.kv.set("k3", "w");
    expect(await db.kv.get("k3")).toBe("w");
  });
});
