import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { IndexedDBArmadaDB } from "@/lib/db/IndexedDBArmadaDB";

import type { NostrRumor } from "@/lib/nostrRumor";

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

const rumor = (n: number): NostrRumor => ({
  id: n.toString(16).padStart(64, "0"),
  pubkey: "a".repeat(64),
  created_at: 1000 + n,
  kind: 14,
  tags: [],
  content: `m${n}`,
});

describe("IndexedDB forget across contexts", () => {
  it("a write from another context (the service worker) racing a forget never leaves the row behind", async () => {
    // Two adapters on one database: the page and the worker.
    const page = new IndexedDBArmadaDB("race");
    const worker = new IndexedDBArmadaDB("race");
    await page.tenant("dm17:x").query([{ limit: 1 }]);
    await worker.tenant("dm17:x").query([{ limit: 1 }]);

    const survivors: string[] = [];
    for (let n = 1; n <= 60; n++) {
      const r = rumor(n);
      // Stagger the two contexts by a few ticks either way, so the interleavings differ.
      const lag = (n % 7) - 3;
      const after = (ms: number, fn: () => Promise<unknown>) =>
        ms <= 0 ? fn() : new Promise((resolve) => setTimeout(resolve, ms)).then(fn);
      await Promise.all([after(lag, () => worker.tenant("dm17:x").event(r)), after(-lag, () => page.forget([r.id]))]);
    }
    // The writer's own clean-up runs after its commit, so check once both are quiet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ids = Array.from({ length: 60 }, (_, i) => rumor(i + 1).id);
    const fresh = new IndexedDBArmadaDB("race");
    for (const row of await fresh.tenant("dm17:x").query([{ ids }])) survivors.push(row.id);
    expect(survivors).toEqual([]);
  }, 60_000);
});
