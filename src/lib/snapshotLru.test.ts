// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  const folded = await import("@/lib/foldedCache");
  const { SnapshotLru } = await import("@/lib/snapshotLru");
  return { ...folded, SnapshotLru };
}

describe("SnapshotLru", { timeout: 30_000 }, () => {
  beforeEach(() => vi.resetModules());

  it("keeps the most recently persisted snapshots and deletes the rest", async () => {
    const { SnapshotLru, writeFolded, readFolded } = await fresh();
    const lru = new SnapshotLru("snap:", "snap-recent", 2);
    for (const k of ["snap:a", "snap:b", "snap:a", "snap:c"]) {
      await writeFolded(k, [k]);
      await lru.touch(k);
    }
    expect(await readFolded("snap:a")).toEqual(["snap:a"]);
    expect(await readFolded("snap:c")).toEqual(["snap:c"]);
    expect(await readFolded("snap:b")).toBeUndefined();
    expect(await readFolded("snap-recent")).toEqual(["snap:c", "snap:a"]);
  });

  it("adopts snapshots written before there was an index, and lets them go first", async () => {
    const { SnapshotLru, writeFolded, readFolded, listFoldedKeys } = await fresh();
    await writeFolded("snap:old1", [1]);
    await writeFolded("snap:old2", [2]);
    const lru = new SnapshotLru("snap:", "snap-recent", 2);
    await writeFolded("snap:new", [3]);
    await lru.touch("snap:new");
    expect((await listFoldedKeys("snap:")).sort()).toEqual(["snap:new", "snap:old1"]);
    expect(await readFolded("snap-recent")).toEqual(["snap:new", "snap:old1"]);
  });
});
