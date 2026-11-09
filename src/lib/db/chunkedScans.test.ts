import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
(globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange;

const { NIndexedDB } = await import("@nostrify/indexeddb");
const { CHUNKED_MIN_LIMIT, chunkedScansSupported, installChunkedScans } = await import("./chunkedScans");

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const hex = (n: number, width = 64) => n.toString(16).padStart(width, "0");

/**
 * 900 events over two channel tags, three kinds and four authors, three to a second: 300
 * distinct seconds, so a range can span more than one 256-key chunk.
 */
function corpus(): NostrEvent[] {
  return Array.from({ length: 900 }, (_, i) => ({
    id: hex(i + 1),
    pubkey: hex((i % 4) + 1),
    // Every third second holds three events, so chunk boundaries land inside ties.
    created_at: 1_000 + Math.floor(i / 3),
    kind: [9, 7, 1111][i % 3],
    tags: [["channel", i % 5 === 0 ? "b" : "a"]],
    content: `m${i}`,
    sig: "",
  }));
}

const FILTERS: NostrFilter[] = [
  { "#channel": ["a"], limit: 400 },
  { "#channel": ["a"], kinds: [9], limit: 100 },
  // About one match a second: the answer spans past the first 256-key chunk.
  { "#channel": ["a"], kinds: [9], limit: 300 },
  { "#channel": ["a"], kinds: [7, 1111], limit: CHUNKED_MIN_LIMIT },
  { "#channel": ["a", "b"], limit: 300 },
  { "#channel": ["b"], kinds: [9], until: 1_150, limit: 60 },
  { "#channel": ["a"], since: 1_100, until: 1_120, limit: 200 },
  { kinds: [9], limit: 250 },
  { authors: [hex(1), hex(2)], limit: 120 },
  { "#channel": ["a"], limit: 5 },
];

describe("chunked limited scans", () => {
  it("still find the internals they route through", () => {
    expect(chunkedScansSupported()).toBe(true);
  });

  it("answer every limited scan with the newest matches, as the cursor walk does but for ties at the cut", async () => {
    // Index the `channel` tag, as the adapter does (the default indexes single letters only).
    const store = new NIndexedDB("chunked-scans", { indexTags: (e) => e.tags });
    const events = corpus();
    await Promise.all(events.map((e) => store.event(e)));
    const ids = async (f: NostrFilter) => (await store.query([f])).map((e) => e.id);

    const before = await Promise.all(FILTERS.map(ids));
    installChunkedScans();
    const after = await Promise.all(FILTERS.map(ids));

    FILTERS.forEach((f, i) => {
      // The contract: (created_at DESC, id ASC), cut at the limit.
      const want = events
        .filter((e) =>
          (!f["#channel"] || f["#channel"].includes(e.tags[0][1])) &&
          (!f.kinds || f.kinds.includes(e.kind)) &&
          (!f.authors || f.authors.includes(e.pubkey)) &&
          (f.since === undefined || e.created_at >= f.since) &&
          (f.until === undefined || e.created_at <= f.until))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .slice(0, f.limit);
      // Which same-second rows survive a cutting limit was never contract; the rest agrees.
      const cut = want.at(-1)!.created_at;
      const above = (list: string[]) => list.filter((id) => events[parseInt(id, 16) - 1].created_at > cut);
      for (const got of [before[i], after[i]]) {
        expect(above(got), JSON.stringify(f)).toEqual(above(want.map((e) => e.id)));
        expect(got).toHaveLength(want.length);
        // Whatever the cut second contributes, it is that second's rows and nothing else.
        expect(got.filter((id) => events[parseInt(id, 16) - 1].created_at < cut), JSON.stringify(f)).toEqual([]);
      }
    });
    // The chunk-spanning case did span: its answer reaches past the range's first 256 keys
    // (every second here holds a channel-a row, so a second is a key).
    const spanning = after[2].map((id) => events[parseInt(id, 16) - 1].created_at);
    expect(Math.max(...spanning) - Math.min(...spanning) + 1).toBeGreaterThan(256);
  }, 30_000);
});
