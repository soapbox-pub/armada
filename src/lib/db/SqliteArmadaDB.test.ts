// @vitest-environment node
/**
 * SQLite-specific tests: the parts of the adapter the shared conformance suite
 * (ArmadaDB.test.ts) can't see — the time-encoded rowid, the token index the
 * planner drives tag queries off, its paged and split scans, the NIP-50 search
 * paths, and the invariant that no index row (token, coordinate or full-text)
 * outlives the rumor it describes.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteArmadaDB } from "./SqliteArmadaDB";

import type { SqliteArmadaDBOpts } from "./SqliteArmadaDB";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

/** A driver that also records the SELECTs it ran, so plans can be inspected. */
class RecordingDriver implements ArmadaSqlDriver {
  readonly db = new DatabaseSync(":memory:");
  readonly selects: Array<{ sql: string; params: SqlValue[] }> = [];

  run(sql: string, params: SqlValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    if (sql.startsWith("SELECT")) this.selects.push({ sql, params });
    return this.db.prepare(sql).all(...params) as SqlRow[];
  }

  close(): void {
    this.db.close();
  }

  /** The `EXPLAIN QUERY PLAN` detail lines for every recorded SELECT. */
  plans(): string[] {
    return this.selects.flatMap(({ sql, params }) => {
      const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      return (rows as Array<{ detail: string }>).map((row) => row.detail);
    });
  }
}

const drivers: RecordingDriver[] = [];

function makeDb(opts: SqliteArmadaDBOpts = {}): { db: SqliteArmadaDB; driver: RecordingDriver } {
  const driver = new RecordingDriver();
  drivers.push(driver);
  return { db: new SqliteArmadaDB(driver, opts), driver };
}

afterEach(() => {
  for (const driver of drivers.splice(0)) {
    try {
      driver.close();
    } catch {
      // already closed
    }
  }
});

let seq = 0;

function rumor(partial: Partial<NostrRumor> = {}): NostrRumor {
  seq++;
  return {
    id: partial.id ?? `id-${String(seq).padStart(6, "0")}`,
    pubkey: "pk-default",
    kind: 1,
    created_at: 1000 + seq,
    content: "",
    tags: [],
    ...partial,
  };
}

/** Rows straight out of the tables, bypassing the store. */
function rows(driver: RecordingDriver, sql: string): SqlRow[] {
  return driver.db.prepare(sql).all() as SqlRow[];
}

describe("SqliteArmadaDB — rowid encoding", () => {
  it("stores rumors at a rowid that orders by created_at", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ id: "older", created_at: 100 }));
    await db.tenant("t").event(rumor({ id: "newer", created_at: 200 }));

    const stored = rows(driver, "SELECT id, seq, created_at FROM rumors ORDER BY seq");

    expect(stored.map((row) => row.id)).toEqual(["older", "newer"]);
    // created_at × 2²⁰, so a scan of the table IS a scan by time.
    expect(stored.map((row) => Number(row.seq))).toEqual([100 * 2 ** 20, 200 * 2 ** 20]);
  });

  it("gives rumors sharing a timestamp adjacent rowids", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    await store.event(rumor({ id: "a", created_at: 100 }));
    await store.event(rumor({ id: "b", created_at: 100 }));

    expect(rows(driver, "SELECT seq FROM rumors ORDER BY seq").map((row) => Number(row.seq)))
      .toEqual([100 * 2 ** 20, 100 * 2 ** 20 + 1]);
  });

  it("keeps time bounds exact for timestamps the encoding must clamp", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    // Beyond 2106, so every such rumor lands in the same clamped bucket and
    // only the `created_at` re-check can tell them apart.
    const early = rumor({ id: "early", created_at: 0x100000000 });
    const late = rumor({ id: "late", created_at: 0x200000000 });
    await store.event(early);
    await store.event(late);

    expect(await store.query([{ since: 0x180000000 }])).toEqual([late]);
    expect(await store.query([{ until: 0x180000000 }])).toEqual([early]);
  });
});

describe("SqliteArmadaDB — query plans", () => {
  it("drives a tag query off the token index, never scanning rumors", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ tags: [["channel", "c1"]] }));

    driver.selects.length = 0;
    await db.tenant("t").query([{ "#channel": ["c1"], kinds: [1] }]);

    const plans = driver.plans();
    expect(plans.some((detail) => detail.includes("rumor_tags_fts"))).toBe(true);
    // The rumors table is reached by rowid, one seek per match.
    expect(plans.some((detail) => /SCAN r\b/.test(detail))).toBe(false);
  });

  it("keeps the index driving when conditions are left for the rumors table", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    await store.event(rumor({ kind: 9, content: "treasure map", tags: [["channel", "c1"]] }));

    for (const filters of [
      [{ "#channel": ["c1"], kinds: [9], limit: 10 }],
      [{ kinds: [9], search: "treasure", limit: 10 }],
    ]) {
      driver.selects.length = 0;
      await store.query(filters);

      const plans = driver.plans();
      // Left to itself, SQLite drives from `rumors` and probes the FTS index
      // once per row — which re-runs the MATCH per probe and sorts the result.
      // Measured at 20k rumors, that is ~2900× slower, so the join order is
      // forced and this is what checks it stayed forced.
      expect(plans.some((detail) => /SCAN (rumor_tags_fts|rumors_fts)/.test(detail))).toBe(true);
      expect(plans.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
      expect(plans.some((detail) => /SEARCH r USING/.test(detail) && !detail.includes("INTEGER PRIMARY KEY")))
        .toBe(false);
    }
  });

  it("answers several tag terms with one index lookup", async () => {
    const { db, driver } = makeDb();
    const both = rumor({ tags: [["channel", "c1"], ["reply", "r1"]] });
    await db.tenant("t").event(both);
    await db.tenant("t").event(rumor({ tags: [["channel", "c1"]] }));

    driver.selects.length = 0;
    expect(await db.tenant("t").query([{ "#channel": ["c1"], "#reply": ["r1"] }])).toEqual([both]);

    // One statement, one MATCH — the terms are intersected inside FTS5 rather
    // than by driving on one and filtering by the other.
    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].params[0]).toBe('"t1:channel:c1" AND "t1:reply:r1"');
  });

  it("folds an author constraint into the same match as the tags", async () => {
    const { db, driver } = makeDb();
    const mine = rumor({ pubkey: "alice", tags: [["channel", "c1"]] });
    await db.tenant("t").event(mine);
    await db.tenant("t").event(rumor({ pubkey: "bob", tags: [["channel", "c1"]] }));

    driver.selects.length = 0;
    expect(await db.tenant("t").query([{ "#channel": ["c1"], authors: ["alice"] }])).toEqual([mine]);

    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].params[0]).toBe('"t1:channel:c1" AND "t1:_p:alice"');
  });

  it("scopes tokens to their tenant", async () => {
    const { db, driver } = makeDb();
    await db.tenant("a").event(rumor({ pubkey: "alice", tags: [["channel", "c1"]] }));
    await db.tenant("b").event(rumor({ pubkey: "alice", tags: [["channel", "c1"]] }));

    // The tenant leads every token, so no posting list is ever shared between
    // two tenants — a query never walks past its own namespace.
    expect(rows(driver, "SELECT ord, id FROM tenants")).toEqual([
      { ord: 1, id: "a" },
      { ord: 2, id: "b" },
    ]);
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"t1:channel:c1"'`),
    ).toHaveLength(1);
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"t2:channel:c1"'`),
    ).toHaveLength(1);
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"t3:channel:c1"'`),
    ).toHaveLength(0);
  });

  it("names a tenant by an interned integer, not by its id", async () => {
    const { db, driver } = makeDb();
    // Two ids that a truncated hash could be ground into colliding, and that
    // would be unwieldy to spell out in every token.
    const one = `c2:${"ab".repeat(32)}`;
    const two = `c2:${"cd".repeat(32)}`;
    const hit = rumor({ tags: [["channel", "c1"]] });
    await db.tenant(one).event(hit);
    await db.tenant(two).event(rumor({ tags: [["channel", "c1"]] }));

    expect(rows(driver, "SELECT ord, id FROM tenants")).toEqual([
      { ord: 1, id: one },
      { ord: 2, id: two },
    ]);
    expect(await db.tenant(one).query([{ "#channel": ["c1"] }])).toEqual([hit]);
  });

  it("finds nothing in a tenant that has never been written to", async () => {
    const { db } = makeDb();
    await db.tenant("a").event(rumor({ tags: [["channel", "c1"]] }));

    expect(await db.tenant("unwritten").query([{ "#channel": ["c1"] }])).toEqual([]);
    expect(await db.tenant("unwritten").count([{ "#channel": ["c1"] }])).toEqual({
      count: 0,
      approximate: false,
    });
  });

  it("escapes a tag value the tokenizer would otherwise split or fold", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = rumor({ tags: [["subject", "Hello, World!"]] });
    await store.event(hit);
    await store.event(rumor({ tags: [["subject", "hello"]] }));

    // A verbatim token would be split on the punctuation and folded to
    // lowercase, so `hello` would match both.
    expect(await store.query([{ "#subject": ["Hello, World!"] }])).toEqual([hit]);
    expect(await store.query([{ "#subject": ["hello, world!"] }])).toEqual([]);
  });

  it("forces the pubkey+kind index for an authors+kinds query", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ pubkey: "alice", kind: 7 }));

    driver.selects.length = 0;
    await db.tenant("t").query([{ authors: ["alice"], kinds: [7] }]);

    expect(driver.plans().some((detail) => detail.includes("rumors_pubkey_kind"))).toBe(true);
  });

  it("forces the tenant index for an unconstrained query", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor());

    driver.selects.length = 0;
    await db.tenant("t").query([{ limit: 10 }]);

    expect(driver.plans().some((detail) => detail.includes("rumors_tenant"))).toBe(true);
  });

  it("groups a collapse inside the term index, reading one body per group", async () => {
    const { db, driver } = makeDb();
    const terms = (r: NostrRumor): string[] =>
      r.tags.filter(([n]) => n === "p").map(([, v]) => `conv:${v}`);
    const store = db.tenant("t", { terms, termsGeneration: 1 });
    for (const peer of ["ana", "ben"]) {
      for (let i = 0; i < 3; i++) {
        await store.event(rumor({ created_at: 100 + i, tags: [["p", peer]] }));
      }
    }

    driver.selects.length = 0;
    expect(await store.query([{ search: "distinct:conv" }])).toHaveLength(2);

    // One statement, and the whole grouping happens in `rumor_terms`: its
    // primary key already orders (tenant, term, seq), so SQLite streams the
    // groups out of one ranged walk as a co-routine — no temp b-tree to build
    // them, no message body read to decide which is newest — and `rumors` is
    // then reached by rowid once per group rather than once per message.
    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].sql).toContain("GROUP BY x.term");
    const plans = driver.plans();
    expect(plans.some((detail) => /SEARCH x USING PRIMARY KEY \(tenant=\? AND term>\? AND term<\?\)/.test(detail)))
      .toBe(true);
    expect(plans.some((detail) => detail.includes("CO-ROUTINE"))).toBe(true);
    expect(plans.some((detail) => /SCAN r\b/.test(detail))).toBe(false);
    expect(plans.some((detail) => detail.includes("SEARCH r USING INTEGER PRIMARY KEY"))).toBe(true);
    // The one sort left orders the GROUPS by recency — as many rows as there are
    // conversations, which is the whole point of grouping in the index first.
    expect(plans.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
  });

  it("reads a single covered scan without a second key lookup", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ kind: 1 }));

    driver.selects.length = 0;
    await db.tenant("t").query([{ kinds: [1], limit: 5 }]);

    // One statement, and it reads the bodies inline.
    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].sql).toContain(
      "SELECT id, kind, pubkey, created_at, tags, content FROM rumors INDEXED BY rumors_kind",
    );
  });
});

describe("SqliteArmadaDB — scans", () => {
  it("pages a scan whose conditions discard rows", async () => {
    const { db } = makeDb();

    // The content index carries no tenant, so a keyword-driven scan finds
    // another tenant's rows and has to discard them — a page can come back
    // short of the limit, and the scan must keep going.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 600; i++) {
      const store = db.tenant(i % 2 === 0 ? "mine" : "theirs");
      writes.push(store.event(rumor({ content: `shared word ${i}` })));
    }
    await Promise.all(writes);

    const got = await db.tenant("mine").query([{ search: "shared" }]);

    expect(got).toHaveLength(300);
    expect(new Set(got.map((r) => r.id)).size).toBe(300);
    expect(got[0].created_at).toBeGreaterThan(got[got.length - 1].created_at);
  });

  it("pages a scan that SQL can't fully express", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // More kinds than are worth binding (MAX_PUSHDOWN), so the token scan
    // can't carry them and they post-filter in memory, paging by rowid.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 600; i++) {
      writes.push(store.event(rumor({ kind: i % 2 === 0 ? 1 : 7, tags: [["channel", "c1"]] })));
    }
    await Promise.all(writes);

    const kinds = [1, ...Array.from({ length: 200 }, (_, i) => 1000 + i)];
    const got = await store.query([{ "#channel": ["c1"], kinds }]);

    expect(got).toHaveLength(300);
    expect(got.every((r) => r.kind === 1)).toBe(true);
    expect(new Set(got.map((r) => r.id)).size).toBe(300);
    expect(got[0].created_at).toBeGreaterThan(got[got.length - 1].created_at);
  });

  it("merges a scan split across statements by a long kind list", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // One kind in each half of the split, plus one outside the list entirely.
    const wanted = [rumor({ kind: 1 }), rumor({ kind: 600 })];
    await store.event(rumor({ kind: 900 }));
    await Promise.all(wanted.map((r) => store.event(r)));

    // 600 kinds > MAX_IN, so the scan runs as two statements and is merged.
    const kinds = Array.from({ length: 600 }, (_, i) => i + 1);
    const got = await store.query([{ kinds }]);

    expect(got.map((r) => r.id).sort()).toEqual(wanted.map((r) => r.id).sort());
  });

  it("merges a match split across statements by a long tag value list", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // One value in each half of the split.
    const wanted = [
      rumor({ tags: [["channel", "c1"]] }),
      rumor({ tags: [["channel", "c600"]] }),
    ];
    await store.event(rumor({ tags: [["channel", "c900"]] }));
    await Promise.all(wanted.map((r) => store.event(r)));

    // 600 values > MAX_OR, so the MATCH is split into two and merged.
    const values = Array.from({ length: 600 }, (_, i) => `c${i + 1}`);
    const got = await store.query([{ "#channel": values }]);

    expect(got.map((r) => r.id).sort()).toEqual(wanted.map((r) => r.id).sort());
  });

  it("honors a limit on a tag scan", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.event(rumor({ created_at: 5000 + i, tags: [["channel", "c1"]] }))),
    );

    driver.selects.length = 0;
    const got = await store.query([{ "#channel": ["c1"], limit: 10 }]);

    expect(got).toHaveLength(10);
    expect(got[0].created_at).toBe(5049);
    // The whole filter is in the index, so the limit is too: one statement,
    // ten rows read.
    expect(driver.selects).toHaveLength(1);
  });
});

describe("SqliteArmadaDB — search", () => {
  // A chat kind, so these exercise the content index rather than the in-memory match.
  const chat = (partial: Partial<NostrRumor> = {}) => rumor({ kind: 9, ...partial });

  it("matches keywords case- and accent-insensitively", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = chat({ content: "Ahoy Matelot" });
    await store.event(hit);
    await store.event(chat({ content: "nothing here" }));

    expect(await store.query([{ kinds: [9], search: "ahoy" }])).toEqual([hit]);
    expect(await store.query([{ kinds: [9], search: "MATELOT" }])).toEqual([hit]);
    expect(await store.query([{ kinds: [9], search: "matelôt" }])).toEqual([hit]);
  });

  it("requires every keyword and honors negation", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const both = chat({ content: "red boat" });
    await store.event(both);
    await store.event(chat({ content: "red anchor" }));

    expect(await store.query([{ kinds: [9], search: "red boat" }])).toEqual([both]);
    expect(await store.query([{ kinds: [9], search: "red -anchor" }])).toEqual([both]);
    expect(await store.query([{ kinds: [9], search: "red boat anchor" }])).toEqual([]);
  });

  it("combines search with other constraints", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = chat({ pubkey: "alice", content: "treasure map" });
    await store.event(hit);
    await store.event(chat({ pubkey: "bob", content: "treasure map" }));

    expect(await store.query([{ kinds: [9], search: "treasure", authors: ["alice"] }])).toEqual([hit]);
    expect(await store.query([{ search: "treasure", kinds: [1068] }])).toEqual([]);
  });

  it("intersects keywords with a tag-driven scan", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = chat({ content: "treasure map", tags: [["channel", "c1"]] });
    await store.event(hit);
    await store.event(chat({ content: "treasure map", tags: [["channel", "c2"]] }));
    await store.event(chat({ content: "nothing here", tags: [["channel", "c1"]] }));

    expect(await store.query([{ kinds: [9], search: "treasure", "#channel": ["c1"] }])).toEqual([hit]);
  });

  it("keeps search results inside their tenant", async () => {
    const { db } = makeDb();
    const mine = chat({ content: "shared word" });
    await db.tenant("a").event(mine);
    await db.tenant("b").event(chat({ content: "shared word" }));

    expect(await db.tenant("a").query([{ kinds: [9], search: "shared" }])).toEqual([mine]);
  });

  it("counts matches without reading rumor bodies", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    await Promise.all(
      Array.from({ length: 1100 }, (_, i) =>
        store.event(chat({ created_at: 5000 + i, content: `common message ${i}` }))),
    );
    await store.event(chat({ created_at: 9999, content: "unrelated" }));

    const got = await store.query([{ kinds: [9], search: "common", limit: 5 }]);

    expect(got).toHaveLength(5);
    expect(got.every((r) => r.content.includes("common"))).toBe(true);
    expect(await store.count([{ kinds: [9], search: "common" }])).toEqual({
      count: 1100,
      approximate: false,
    });
  });

  it("still matches keywords with the index turned off", async () => {
    const { db, driver } = makeDb({ search: false });
    const store = db.tenant("t");
    const hit = chat({ content: "the quick brown fox" });
    await store.event(hit);
    await store.event(chat({ content: "nothing here" }));

    expect(await store.query([{ kinds: [9], search: "BROWN" }])).toEqual([hit]);
    expect(await store.query([{ kinds: [9], search: "quick -fox" }])).toEqual([]);
    // Tags stay queryable — only the content index is optional.
    expect(rows(driver, "SELECT name FROM sqlite_master WHERE name = 'rumors_fts'")).toHaveLength(0);
    expect(
      rows(driver, "SELECT name FROM sqlite_master WHERE name = 'rumor_tags_fts'"),
    ).toHaveLength(1);
  });

  it("indexes only the content kinds, and matches the rest in memory", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    const message = chat({ content: "harbour lights" });
    const setting = rumor({ kind: 30078, pubkey: "alice", tags: [["d", "x"]], content: "harbour lights" });
    await store.event(message);
    await store.event(setting);

    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(1);
    expect(await store.query([{ kinds: [9], search: "harbour" }])).toEqual([message]);
    // A kind the index doesn't hold is still found, by substring.
    expect(await store.query([{ kinds: [30078], search: "arbou" }])).toEqual([setting]);
    expect(await store.query([{ search: "harbour" }])).toHaveLength(2);
  });

  it("limits an existing file's content index on open, and lets old entries leave with their rumors", async () => {
    const { db, driver } = makeDb();
    await db.ready;
    // The insert trigger every file carried before the kind restriction.
    driver.run("DROP TRIGGER rumors_fts_insert");
    driver.run(`CREATE TRIGGER rumors_fts_insert AFTER INSERT ON rumors BEGIN
      INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, new.content); END`);
    await db.tenant("t").event(rumor({ id: "v1", kind: 30078, pubkey: "alice", created_at: 100, tags: [["d", "x"]] }));
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(1);

    const reopened = new SqliteArmadaDB(driver);
    await reopened.ready;
    const [trigger] = rows(driver, "SELECT sql FROM sqlite_master WHERE name = 'rumors_fts_insert'");
    expect(String(trigger.sql)).toMatch(/WHEN new\.kind IN \(9, 14, 15, 1068, 1111\)/);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(1);

    await reopened.tenant("t").event(rumor({ id: "v2", kind: 30078, pubkey: "alice", created_at: 200, tags: [["d", "x"]] }));
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(0);
  });

  it("matches a keyword still being typed as a word prefix", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = chat({ content: "lighthouse keeper" });
    await store.event(hit);

    expect(await store.query([{ kinds: [9], search: "lighth" }])).toEqual([hit]);
    expect(await store.query([{ kinds: [9], search: "kee light" }])).toEqual([hit]);
    expect(await store.query([{ kinds: [9], search: "house" }])).toEqual([]);
  });

  it("stops finding a rumor once it is removed", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    await store.event(chat({ content: "ephemeral phrase" }));

    await store.remove([{ kinds: [9], search: "ephemeral" }]);

    expect(await store.query([{ kinds: [9], search: "ephemeral" }])).toEqual([]);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(0);
  });
});

describe("SqliteArmadaDB — index upkeep", () => {
  it("leaves no token or coordinate rows behind when a version is superseded", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await store.event(
      rumor({
        id: "v1",
        kind: 30078,
        pubkey: "alice",
        created_at: 100,
        tags: [["d", "x"], ["channel", "c1"]],
      }),
    );
    await store.event(
      rumor({
        id: "v2",
        kind: 30078,
        pubkey: "alice",
        created_at: 200,
        tags: [["d", "x"], ["channel", "c2"]],
      }),
    );

    expect(rows(driver, "SELECT id FROM rumors").map((r) => r.id)).toEqual(["v2"]);
    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(1);
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"t:channel:c1"'`),
    ).toHaveLength(0);
    expect(rows(driver, "SELECT coord, id FROM rumor_coords")).toEqual([
      { coord: "30078:alice:x", id: "v2" },
    ]);
    // Settings are not a content kind; the superseded version took nothing with it.
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(0);
  });

  it("leaves no rows behind when a rumor is removed", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await store.event(
      rumor({ id: "gone", kind: 10002, pubkey: "alice", tags: [["channel", "c1"]] }),
    );
    await store.remove([{ ids: ["gone"] }]);

    expect(rows(driver, "SELECT id FROM rumors")).toHaveLength(0);
    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(0);
    expect(rows(driver, "SELECT coord FROM rumor_coords")).toHaveLength(0);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(0);
  });

  it("does not free a coordinate a stale write failed to take", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await store.event(rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 }));
    await store.event(rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 }));

    expect(rows(driver, "SELECT id FROM rumors").map((r) => r.id)).toEqual(["new"]);
    expect(rows(driver, "SELECT id FROM rumor_coords").map((r) => r.id)).toEqual(["new"]);
  });

  it("indexes a re-delivered rumor exactly once", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    const again = rumor({ id: "twice", kind: 9, tags: [["channel", "c1"]] });

    await store.event(again);
    await store.event({ ...again });

    expect(rows(driver, "SELECT id FROM rumors")).toHaveLength(1);
    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(1);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(1);
  });

  it("commits a burst of writes as one transaction", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    const writes = [store.event(rumor()), store.event(rumor()), store.event(rumor())];
    driver.selects.length = 0;
    await Promise.all(writes);

    expect(rows(driver, "SELECT id FROM rumors")).toHaveLength(3);
  });

  it("wipes every table", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ kind: 10002, tags: [["channel", "c1"]] }));
    await db.kv.set("cursor", 1);

    await db.wipe();

    for (const table of ["rumors", "rumor_coords", "tenants", "kv"]) {
      expect(rows(driver, `SELECT * FROM ${table}`)).toHaveLength(0);
    }
    for (const table of ["rumor_tags_fts", "rumors_fts"]) {
      expect(rows(driver, `SELECT rowid FROM ${table}`)).toHaveLength(0);
    }
  });

  it("rejects a write whose transaction fails", async () => {
    const { db, driver } = makeDb();
    driver.close();

    await expect(db.tenant("t").event(rumor())).rejects.toThrow();
  });
});

describe("SqliteArmadaDB — injection", () => {
  /** Payloads aimed at SQL, at FTS5's query language, and at the token encoding. */
  const HOSTILE = [
    `'; DROP TABLE rumors; --`,
    `' OR '1'='1`,
    `" OR "1"="1`,
    `x" OR "y`,
    `"`,
    `""`,
    `\\`,
    `*`,
    `^`,
    `(a OR b)`,
    `NEAR(a b, 5)`,
    `a AND b`,
    `{content}`,
    `content:secret`,
    `-negated`,
    `a b`,
    `tab\there`,
    `new\nline`,
    `nul\u0000byte`,
    `emoji🏴‍☠️`,
    `ÜPPER`,
  ];

  it("survives hostile tag values without matching anything else", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    const planted = rumor({ id: "planted", tags: [["channel", "secret"]] });
    await store.event(planted);

    for (const [i, payload] of HOSTILE.entries()) {
      const carrier = rumor({ id: `carrier-${i}`, tags: [["channel", payload]] });
      await store.event(carrier);

      // The value round-trips exactly...
      expect(await store.query([{ "#channel": [payload] }])).toEqual([carrier]);
      // ...and nothing it contains reaches the query as syntax.
      expect(await store.query([{ "#channel": ["secret"] }])).toEqual([planted]);
    }

    expect(rows(driver, "SELECT count(*) AS c FROM rumors")[0].c).toBe(HOSTILE.length + 1);
  });

  it("survives hostile tag names, ids, pubkeys, content and tenant ids", async () => {
    const { db, driver } = makeDb();

    // ENGINE NOTE (node:sqlite): a TEXT column holding a NUL is stored and
    // compared byte-exactly, but older Node releases (22) read it back
    // truncated AT the NUL, while newer ones (24) return it whole. Tags,
    // stored as JSON text where a NUL is escaped, round-trip either way.
    const probe = new DatabaseSync(":memory:");
    const truncates = (probe.prepare("SELECT ? AS v").get("a\u0000b") as { v: string }).v === "a";
    probe.close();
    const trunc = (s: string) => (truncates ? s.split("\u0000")[0] : s);

    for (const [i, payload] of HOSTILE.entries()) {
      const store = db.tenant(`tenant-${payload}`);
      const r = rumor({
        id: `id-${payload}-${i}`,
        pubkey: `pk-${payload}`,
        content: payload,
        tags: [[payload.slice(0, 20), "value"]],
      });
      await store.event(r);

      const stored = { ...r, id: trunc(r.id), pubkey: trunc(r.pubkey), content: trunc(r.content) };

      expect(await store.query([{ ids: [r.id] }])).toEqual([stored]);
      expect(await store.query([{ authors: [r.pubkey] }])).toEqual([stored]);
      expect(await store.query([{ [`#${payload.slice(0, 20)}`]: ["value"] }])).toEqual([stored]);
    }

    // Every table is still there, with exactly what was written.
    expect(rows(driver, "SELECT count(*) AS c FROM rumors")[0].c).toBe(HOSTILE.length);
    expect(rows(driver, "SELECT count(*) AS c FROM tenants")[0].c).toBe(HOSTILE.length);
  });

  it("survives hostile search input", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const secret = rumor({ id: "secret", content: "classified fleet positions" });
    await store.event(secret);

    for (const payload of HOSTILE) {
      const got = await store.query([{ search: payload }]);
      // None of these name a word the rumor has, so the only ones it may
      // answer are the pure negations — which ask for rumors LACKING a word.
      expect(got).toEqual(payload.startsWith("-") ? [secret] : []);
    }

    // Still findable by its own words, so no index was damaged along the way.
    expect(await store.query([{ search: "classified" }])).toEqual([secret]);
  });

  it("fails closed on a search that parses to no keywords", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const secret = rumor({ id: "secret", content: "classified fleet positions" });
    await store.event(secret);

    // Both are consumed entirely by the NIP-50 parse — the first is an
    // extension this store doesn't implement, the second tokenizes to nothing.
    // Dropping the constraint would answer a narrowing query with the whole
    // tenant, so they match nothing instead.
    expect(await store.query([{ search: "domain:example.com" }])).toEqual([]);
    expect(await store.query([{ search: '""' }])).toEqual([]);
    expect(await store.count([{ search: "domain:example.com" }]))
      .toEqual({ count: 0, approximate: false });

    // An absent or blank search asked for nothing, so it constrains nothing.
    expect(await store.query([{ search: "" }])).toEqual([secret]);
    expect(await store.query([{ search: "   " }])).toEqual([secret]);
  });

  it("cannot forge another rumor's author token through a tag", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // A space would end a token, so a value carrying one could append tokens of
    // its own to the row — here, a claim to have been written by `victim`.
    const forger = rumor({
      id: "forger",
      pubkey: "attacker",
      tags: [["channel", "c1 t1:_p:victim"], ["_p", "victim"], ["p", "victim"]],
    });
    await store.event(forger);
    const real = rumor({ id: "real", pubkey: "victim", tags: [["channel", "c1"]] });
    await store.event(real);

    expect(await store.query([{ authors: ["victim"] }])).toEqual([real]);
    expect(await store.query([{ "#channel": ["c1"], authors: ["victim"] }])).toEqual([real]);
    // The forged value is a value, not two tokens.
    expect(await store.query([{ "#channel": ["c1"] }])).toEqual([real]);
    expect(await store.query([{ "#channel": ["c1 t1:_p:victim"] }])).toEqual([forger]);
  });

  it("cannot reach another tenant by forging its token prefix", async () => {
    const { db } = makeDb();
    const mine = rumor({ id: "mine", tags: [["channel", "c1"]] });
    await db.tenant("a").event(mine);

    // `a` is interned as t1, so these are attempts to name it from outside.
    const store = db.tenant("b");
    await store.event(rumor({ id: "probe", tags: [["t1", "channel"], ["channel", "c1"]] }));

    expect(await db.tenant("a").query([{ "#channel": ["c1"] }])).toEqual([mine]);
    expect(await store.query([{ "#channel": ["c1"] }])).toHaveLength(1);
    expect((await store.query([{ "#channel": ["c1"] }]))[0].id).toBe("probe");
  });

  it("cannot delete another author's rumors with a crafted a tag", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    const victim = rumor({
      id: "victim",
      kind: 30078,
      pubkey: "victim",
      created_at: 100,
      tags: [["d", "x"]],
    });
    await store.event(victim);

    // The coordinate is spelled with `:`, so a request whose own pubkey is a
    // prefix of the victim's, or which packs the victim's into a `d` tag, must
    // still not resolve to the victim's coordinate.
    await store.event(rumor({
      id: "req",
      kind: 5,
      pubkey: "attacker",
      created_at: 200,
      tags: [
        ["a", "30078:victim:x"],
        ["a", "30078:attacker:x:30078:victim:x"],
        ["e", "victim"],
      ],
    }));

    expect(await store.query([{ kinds: [30078] }])).toEqual([victim]);
  });

  it("survives a NUL byte in a search, which FTS5 cannot be handed", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = rumor({ id: "hit", content: "hello world" });
    await store.event(hit);

    // FTS5's query parser is NUL-terminated, so a phrase containing one loses
    // its closing quote and the query dies with `unterminated string`. Such
    // keywords are matched in memory instead.
    expect(await store.query([{ search: "hello\u0000" }])).toEqual([]);
    expect(await store.query([{ search: "\u0000" }])).toEqual([]);
    expect(await store.query([{ search: "hello" }])).toEqual([hit]);
  });

  it("survives every control character in every user-controlled string", async () => {
    const { db } = makeDb();

    for (let code = 0; code < 0x20; code++) {
      const payload = `a${String.fromCharCode(code)}b`;
      const store = db.tenant(`tenant${payload}`);

      await store.event(rumor({
        id: `id${payload}`,
        pubkey: `pk${payload}`,
        content: payload,
        tags: [["channel", payload]],
      }));

      // Each of these puts the payload somewhere different: a bound
      // parameter, a token, and an FTS5 query expression.
      expect(await store.query([{ "#channel": [payload] }])).toHaveLength(1);
      expect(await store.query([{ authors: [`pk${payload}`] }])).toHaveLength(1);
      expect(await store.query([{ ids: [`id${payload}`] }])).toHaveLength(1);
      await expect(store.query([{ search: payload }])).resolves.toBeInstanceOf(Array);
    }
  });

  it("survives hostile kv keys", async () => {
    const { db, driver } = makeDb();

    for (const payload of HOSTILE) {
      await db.kv.set(payload, { payload });
      expect(await db.kv.get(payload)).toEqual({ payload });
    }

    expect(rows(driver, "SELECT count(*) AS c FROM kv")[0].c).toBe(HOSTILE.length);
    expect(await db.kv.list({ prefix: "'" })).toEqual([
      { key: `' OR '1'='1`, value: { payload: `' OR '1'='1` } },
      { key: `'; DROP TABLE rumors; --`, value: { payload: `'; DROP TABLE rumors; --` } },
    ]);
  });
});
