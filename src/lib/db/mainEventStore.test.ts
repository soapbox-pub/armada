import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const { ARMADA_TENANTS, getArmadaDB } = await import("@/lib/db/armadaDB");
const { appEventStore } = await import("@/lib/db/mainEventStore");

import type { NostrEvent } from "@nostrify/nostrify";

const pk = (n: number) => n.toString(16).padStart(64, "0");
const event = (n: number, author: number, kind = 0, tags: string[][] = []): NostrEvent => ({
  id: pk(1000 + n),
  pubkey: pk(author),
  kind,
  created_at: 1_700_000_000 + n,
  tags,
  content: `{"name":"p${author}"}`,
  sig: "0".repeat(128),
});

describe("the main event store's single-author reads", () => {
  it("answer concurrent callers with one read, each its own author's rows and objects", async () => {
    const store = await appEventStore();
    await Promise.all([event(1, 1), event(2, 2), event(3, 3), event(4, 1, 30315, [["d", "general"]])].map((e) => store.event(e)));
    const tenant = getArmadaDB().tenant(ARMADA_TENANTS.main);
    const query = vi.spyOn(tenant.constructor.prototype, "query");
    try {
      const [a, b, again, none] = await Promise.all([
        store.query([{ kinds: [0], authors: [pk(1)] }]),
        store.query([{ kinds: [0], authors: [pk(2)] }]),
        store.query([{ kinds: [0], authors: [pk(1)] }]),
        store.query([{ kinds: [0], authors: [pk(9)] }]),
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(a.map((e) => e.id)).toEqual([pk(1001)]);
      expect(b.map((e) => e.id)).toEqual([pk(1002)]);
      expect(again).toEqual(a);
      expect(again[0]).not.toBe(a[0]);
      expect(none).toEqual([]);

      // A different filter is a different batch; a limit reads as asked.
      const [status, limited] = await Promise.all([
        store.query([{ kinds: [30315], authors: [pk(1)], "#d": ["general"] }]),
        store.query([{ kinds: [0], authors: [pk(3)], limit: 1 }]),
      ]);
      expect(status.map((e) => e.id)).toEqual([pk(1004)]);
      expect(limited.map((e) => e.id)).toEqual([pk(1003)]);
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }
  });

  it("lets one caller's abort reject only that caller", async () => {
    const store = await appEventStore();
    const controller = new AbortController();
    const aborted = store.query([{ kinds: [0], authors: [pk(1)] }], { signal: controller.signal });
    const other = store.query([{ kinds: [0], authors: [pk(2)] }]);
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    expect((await other).map((e) => e.id)).toEqual([pk(1002)]);
  });
});
