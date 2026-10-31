// @vitest-environment node
/**
 * One conformance suite, run against BOTH ArmadaDB adapters — the IndexedDB
 * one (fake-indexeddb) and the SQLite one (real SQLite via node:sqlite). The
 * whole point of the interface is that a caller can't tell which it got, so
 * every behavioral claim is asserted twice, in the same words.
 */
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import { SqliteArmadaDB } from "./SqliteArmadaDB";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";
import type { ArmadaDB } from "./types";

/** The whole driver contract, over Node's built-in SQLite. */
class NodeSqlDriver implements ArmadaSqlDriver {
  private readonly db = new DatabaseSync(":memory:");

  run(sql: string, params: SqlValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    return this.db.prepare(sql).all(...params) as SqlRow[];
  }

  close(): void {
    this.db.close();
  }
}

let seq = 0;

/** A minimal fake rumor (ids only need to be unique + ordered for ties). */
function rumor(partial: Partial<NostrRumor> = {}): NostrRumor {
  seq++;
  return {
    id: partial.id ?? `id-${String(seq).padStart(4, "0")}`,
    pubkey: "pk-default",
    kind: 1,
    created_at: 1000 + seq,
    content: "",
    tags: [],
    ...partial,
  };
}

interface Backend {
  name: string;
  create(): ArmadaDB & { close(): Promise<void> };
}

let dbSeq = 0;

const backends: Backend[] = [
  {
    name: "IndexedDBArmadaDB",
    create() {
      // A fresh factory (and a fresh name) per instance, so no test can see
      // another's databases.
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      return new IndexedDBArmadaDB(`armada-test-${++dbSeq}`);
    },
  },
  {
    name: "SqliteArmadaDB",
    create: () => new SqliteArmadaDB(new NodeSqlDriver()),
  },
];

describe.each(backends)("$name", ({ create }) => {
  let db: ArmadaDB & { close(): Promise<void> };

  beforeEach(() => {
    db = create();
  });

  afterEach(async () => {
    await db.close().catch(() => undefined);
  });

  describe("tenant stores", () => {
    it("stores a rumor and reads it back without a signature", async () => {
      const r = rumor({ kind: 1, content: "hello" });
      await db.tenant("c2:abc").event(r);

      const [got] = await db.tenant("c2:abc").query([{ kinds: [1] }]);

      expect(got).toEqual(r);
      expect(Object.keys(got)).not.toContain("sig");
    });

    it("returns the same store for the same tenant id", async () => {
      expect(db.tenant("c2:abc")).toBe(db.tenant("c2:abc"));
    });

    it("queries by a multi-letter tag", async () => {
      const channelId = "chan-1";
      const inChannel = rumor({ tags: [["channel", channelId]] });
      await db.tenant("c2:abc").event(inChannel);
      await db.tenant("c2:abc").event(rumor({ tags: [["channel", "chan-2"]] }));

      const events = await db.tenant("c2:abc").query([{ "#channel": [channelId] }]);

      expect(events).toEqual([inChannel]);
    });

    it("isolates tenants sharing a rumor id", async () => {
      const a = rumor({ id: "shared", content: "in a" });
      const b = { ...a, content: "in b" };
      await db.tenant("c2:a").event(a);
      await db.tenant("c2:b").event(b);

      expect(await db.tenant("c2:a").query([{}])).toEqual([a]);
      expect(await db.tenant("c2:b").query([{}])).toEqual([b]);
      expect(await db.tenant("c2:c").query([{}])).toEqual([]);
    });

    it("keeps a tag index in one tenant out of another", async () => {
      await db.tenant("c2:a").event(rumor({ tags: [["channel", "chan-1"]] }));

      expect(await db.tenant("c2:b").query([{ "#channel": ["chan-1"] }])).toEqual([]);
    });

    it("filters by ids, authors, kinds and time bounds", async () => {
      const store = db.tenant("t");
      const target = rumor({ id: "wanted", pubkey: "alice", kind: 7, created_at: 500 });
      await store.event(target);
      await store.event(rumor({ pubkey: "bob", kind: 7, created_at: 500 }));
      await store.event(rumor({ pubkey: "alice", kind: 1, created_at: 500 }));
      await store.event(rumor({ pubkey: "alice", kind: 7, created_at: 100 }));
      await store.event(rumor({ pubkey: "alice", kind: 7, created_at: 900 }));

      expect(await store.query([{ ids: ["wanted"] }])).toEqual([target]);
      expect(await store.query([{ authors: ["alice"], kinds: [7], since: 500, until: 500 }]))
        .toEqual([target]);
    });

    it("matches content substrings with search", async () => {
      const store = db.tenant("t");
      const hit = rumor({ content: "the quick brown fox" });
      await store.event(hit);
      await store.event(rumor({ content: "nothing here" }));

      expect(await store.query([{ search: "brown" }])).toEqual([hit]);
      expect(await store.query([{ search: "%" }])).toEqual([]);
    });

    it("matches nothing for a search that names nothing it can match", async () => {
      const store = db.tenant("t");
      const a = rumor({ content: "the quick brown fox" });
      const b = rumor({ content: "nothing here" });
      await store.event(a);
      await store.event(b);

      // Neither is a keyword either adapter can honor — the first is a NIP-50
      // extension nobody implements, the second is punctuation. Dropping the
      // constraint would answer a narrowing query with the whole tenant.
      expect(await store.query([{ search: "domain:example.com" }])).toEqual([]);
      expect(await store.query([{ search: '""' }])).toEqual([]);

      // Asking for nothing constrains nothing, which is not the same thing.
      expect(await store.query([{ search: "" }])).toHaveLength(2);
    });

    it("returns rumors newest first, ties broken by smaller id", async () => {
      const store = db.tenant("t");
      const newest = rumor({ id: "c", created_at: 300 });
      const tieA = rumor({ id: "a", created_at: 200 });
      const tieB = rumor({ id: "b", created_at: 200 });
      for (const r of [tieB, newest, tieA]) await store.event(r);

      expect(await store.query([{}])).toEqual([newest, tieA, tieB]);
    });

    it("applies limit per filter and unions filters without duplicates", async () => {
      const store = db.tenant("t");
      const a = rumor({ id: "a", kind: 1, created_at: 300 });
      const b = rumor({ id: "b", kind: 1, created_at: 200 });
      const c = rumor({ id: "c", kind: 2, created_at: 100 });
      for (const r of [a, b, c]) await store.event(r);

      expect(await store.query([{ limit: 2 }])).toEqual([a, b]);
      // `a` matches both filters but is returned once.
      expect(await store.query([{ kinds: [1] }, { ids: ["a", "c"] }])).toEqual([a, b, c]);
    });

    it("matches nothing for an empty array constraint", async () => {
      const store = db.tenant("t");
      await store.event(rumor());

      expect(await store.query([{ kinds: [] }])).toEqual([]);
      expect(await store.query([{ authors: [] }])).toEqual([]);
    });

    it("does not index oversized tag values", async () => {
      const store = db.tenant("t");
      const long = "x".repeat(200);
      await store.event(rumor({ tags: [["blob", long]] }));

      expect(await store.query([{ "#blob": [long] }])).toEqual([]);
    });

    it("counts matching rumors", async () => {
      const store = db.tenant("t");
      await store.event(rumor({ kind: 1, tags: [["channel", "chan-1"]] }));
      await store.event(rumor({ kind: 1, tags: [["channel", "chan-1"]] }));
      await store.event(rumor({ kind: 1, tags: [["channel", "chan-2"]] }));

      expect(await store.count([{ "#channel": ["chan-1"] }])).toEqual({
        count: 2,
        approximate: false,
      });
      expect(await store.count([{ kinds: [1] }])).toEqual({ count: 3, approximate: false });
      expect(await store.count([{ kinds: [99] }])).toEqual({ count: 0, approximate: false });
    });

    it("removes matching rumors, including their tag index", async () => {
      const store = db.tenant("t");
      const keep = rumor({ kind: 1, tags: [["channel", "chan-1"]] });
      const drop = rumor({ kind: 2, tags: [["channel", "chan-1"]] });
      await store.event(keep);
      await store.event(drop);

      await store.remove([{ kinds: [2] }]);

      expect(await store.query([{}])).toEqual([keep]);
      expect(await store.query([{ "#channel": ["chan-1"] }])).toEqual([keep]);
    });

    it("never stores ephemeral kinds", async () => {
      const store = db.tenant("t");
      await store.event(rumor({ kind: 20001 }));

      expect(await store.query([{}])).toEqual([]);
    });
  });

  /**
   * The derived term index: facts a policy computes from a rumor, queried as
   * NIP-50 extension tokens. Nothing here is NIP-17-shaped — the engines never
   * interpret a term — so the policy under test is a stand-in for any of them.
   */
  describe("derived terms", () => {
    /** Files each rumor under the sorted set of its `p` tags. */
    const peers = (rumor: NostrRumor): string[] => {
      const set = [...new Set(rumor.tags.filter(([n]) => n === "p").map(([, v]) => v))].sort();
      return set.length > 0 ? [`conv:${set.join("")}`] : [];
    };

    /** Every `p` tag as its own term, so one rumor carries several. */
    const each = (rumor: NostrRumor): string[] =>
      rumor.tags.filter(([n]) => n === "p").map(([, v]) => `with:${v}`);

    it("selects exactly the rumors a policy filed under a term", async () => {
      const store = db.tenant("t", { terms: peers });
      const pair = rumor({ id: "pair", tags: [["p", "ana"], ["p", "ben"]] });
      const ana = rumor({ id: "ana", tags: [["p", "ana"]] });
      const ben = rumor({ id: "ben", tags: [["p", "ben"]] });
      for (const r of [pair, ana, ben]) await store.event(r);

      // The exact set, and neither of the 1:1s that share its members — which
      // is the whole thing a tag filter cannot express.
      expect(await store.query([{ search: "conv:anaben" }])).toEqual([pair]);
      expect(await store.query([{ search: "conv:ana" }])).toEqual([ana]);
      expect(await store.query([{ search: "conv:ben" }])).toEqual([ben]);
    });

    it("requires every term a filter names", async () => {
      const store = db.tenant("t", { terms: each });
      const both = rumor({ id: "both", created_at: 200, tags: [["p", "ana"], ["p", "ben"]] });
      const one = rumor({ id: "one", created_at: 100, tags: [["p", "ana"]] });
      for (const r of [both, one]) await store.event(r);

      expect(await store.query([{ search: "with:ana" }])).toEqual([both, one]);
      // Conditions within a filter AND, terms included.
      expect(await store.query([{ search: "with:ana with:ben" }])).toEqual([both]);
      expect(await store.query([{ search: "with:ana with:cy" }])).toEqual([]);
    });

    it("matches nothing for a term in a tenant that derives none", async () => {
      const store = db.tenant("t");
      await store.event(rumor({ tags: [["p", "ana"]] }));

      // Fails closed, exactly like an unsupported NIP-50 extension: a narrowing
      // query that can't be honored answers with nothing, never everything.
      expect(await store.query([{ search: "conv:ana" }])).toEqual([]);
      expect(await store.count([{ search: "conv:ana" }])).toEqual({ count: 0, approximate: false });
    });

    it("cannot be forged by a tag the sender wrote", async () => {
      const store = db.tenant("t", { terms: peers });
      const real = rumor({ id: "real", tags: [["p", "ana"]] });
      // A sender spelling the index's own namespace, and claiming a term for a
      // conversation they are not in.
      const fake = rumor({ id: "fake", tags: [["~", "conv:ana"], ["conv", "ana"]] });
      for (const r of [real, fake]) await store.event(r);

      expect(await store.query([{ search: "conv:ana" }])).toEqual([real]);
    });

    it("narrows alongside the filter's other constraints", async () => {
      const store = db.tenant("t", { terms: peers });
      const kept = rumor({ id: "kept", kind: 14, pubkey: "ana", tags: [["p", "ana"]] });
      for (const r of [
        kept,
        rumor({ id: "wrongkind", kind: 7, pubkey: "ana", tags: [["p", "ana"]] }),
        rumor({ id: "wrongauthor", kind: 14, pubkey: "ben", tags: [["p", "ana"]] }),
        rumor({ id: "wrongconv", kind: 14, pubkey: "ana", tags: [["p", "ben"]] }),
      ]) await store.event(r);

      expect(await store.query([{ search: "conv:ana", kinds: [14], authors: ["ana"] }]))
        .toEqual([kept]);
    });

    it("applies the limit to the term's own rows", async () => {
      const store = db.tenant("t", { terms: peers });
      // Interleaved, so a limit applied before the term would come back short.
      for (let i = 0; i < 6; i++) {
        await store.event(rumor({ id: `ana-${i}`, created_at: 100 + i * 2, tags: [["p", "ana"]] }));
        await store.event(rumor({ id: `ben-${i}`, created_at: 101 + i * 2, tags: [["p", "ben"]] }));
      }

      const got = await store.query([{ search: "conv:ana", limit: 3 }]);
      expect(got.map((r) => r.id)).toEqual(["ana-5", "ana-4", "ana-3"]);
    });

    it("finds a match far below a term's newest rows", async () => {
      const store = db.tenant("t", { terms: peers });
      // One matching rumor, underneath a term's whole history. An adapter that
      // narrows in memory has to read down to it — and one that pages while
      // doing so must page until the range is EXHAUSTED, not until some budget
      // is: a search budget dressed as a page limit turns a rumor that exists
      // into one the store denies having.
      await store.event(rumor({ id: "deep", created_at: 100, content: "needle", tags: [["p", "ana"]] }));
      await Promise.all(Array.from({ length: 200 }, (_, i) =>
        store.event(rumor({ id: `hay-${i}`, created_at: 200 + i, content: "hay", tags: [["p", "ana"]] }))));

      const got = await store.query([{ search: "conv:ana needle", limit: 1 }]);
      expect(got.map((r) => r.id)).toEqual(["deep"]);
    });

    it("finds a match among more rumors than a page, all at one timestamp", async () => {
      const store = db.tenant("t", { terms: peers });
      // Every rumor shares a `created_at`, so a pager walking a time bound can
      // never advance past them — the whole second is one boundary. Reading a
      // page and stepping below its oldest row would skip the rest of it.
      await Promise.all(Array.from({ length: 200 }, (_, i) =>
        store.event(rumor({ id: `tie-${i}`, created_at: 500, content: "hay", tags: [["p", "ana"]] }))));
      await store.event(rumor({ id: "zz-buried", created_at: 500, content: "needle", tags: [["p", "ana"]] }));

      const got = await store.query([{ search: "conv:ana needle", limit: 1 }]);
      expect(got.map((r) => r.id)).toEqual(["zz-buried"]);
    });

    it("counts and removes by term", async () => {
      const store = db.tenant("t", { terms: peers });
      const ben = rumor({ id: "ben", tags: [["p", "ben"]] });
      for (const r of [rumor({ id: "ana", tags: [["p", "ana"]] }), ben]) await store.event(r);

      expect(await store.count([{ search: "conv:ana" }])).toEqual({ count: 1, approximate: false });
      await store.remove([{ search: "conv:ana" }]);
      expect(await store.query([{}])).toEqual([ben]);
    });

    it("indexes writes made through a handle that named no policy", async () => {
      // The policy is bound to the TENANT, which is what covers a writer that
      // doesn't know terms exist — on the native engines, the notification
      // service writing while the app is dead.
      db.tenant("t", { terms: peers });
      const bare = db.tenant("t");
      const written = rumor({ id: "written", tags: [["p", "ana"]] });
      await bare.event(written);

      expect(await db.tenant("t").query([{ search: "conv:ana" }])).toEqual([written]);
    });

    it("indexes rows that were already stored when the policy arrived", async () => {
      const before = db.tenant("t");
      const old = rumor({ id: "old", created_at: 100, tags: [["p", "ana"]] });
      await before.event(old);

      const store = db.tenant("t", { terms: peers });
      const fresh = rumor({ id: "fresh", created_at: 200, tags: [["p", "ana"]] });
      await store.event(fresh);

      expect(await store.query([{ search: "conv:ana" }])).toEqual([fresh, old]);
    });

    it("forgets a term when its rumor is deleted", async () => {
      const store = db.tenant("t", { terms: peers });
      await store.event(rumor({ id: "gone", pubkey: "ana", tags: [["p", "ana"]] }));
      await store.event(rumor({ kind: 5, pubkey: "ana", tags: [["e", "gone"]] }));

      expect(await store.query([{ search: "conv:ana" }])).toEqual([]);
    });

    it("keeps a term inside its own tenant", async () => {
      const mine = rumor({ id: "mine", tags: [["p", "ana"]] });
      await db.tenant("a", { terms: peers }).event(mine);
      await db.tenant("b", { terms: peers }).event(rumor({ id: "theirs", tags: [["p", "ana"]] }));

      expect(await db.tenant("a").query([{ search: "conv:ana" }])).toEqual([mine]);
    });

    it("combines a term with a keyword", async () => {
      const store = db.tenant("t", { terms: peers });
      const hit = rumor({ id: "hit", content: "the quick brown fox", tags: [["p", "ana"]] });
      for (const r of [
        hit,
        rumor({ id: "otherconv", content: "the quick brown fox", tags: [["p", "ben"]] }),
        rumor({ id: "othertext", content: "nothing here", tags: [["p", "ana"]] }),
      ]) await store.event(r);

      expect(await store.query([{ search: "brown conv:ana" }])).toEqual([hit]);
    });

    it("re-derives every term when the generation changes", async () => {
      // Written before any policy is installed, so the first install's backfill
      // is a real pass and records the generation that made it. (A tenant with
      // no rows yet has nothing to record the fact against, and is walked again
      // next time — which is why this doesn't start from an empty one.)
      const stored = rumor({ id: "stored", tags: [["p", "ana"]] });
      await db.tenant("t").event(stored);

      const store = db.tenant("t", { terms: peers, termsGeneration: 1 });
      expect(await store.query([{ search: "conv:ana" }])).toEqual([stored]);

      // The same rows, a different derivation. Both halves matter: the new term
      // has to reach rows written before it, and the old one has to STOP
      // matching — an index that only ever gains terms would keep answering a
      // lookup no policy derives any more.
      const renamed = db.tenant("t", { terms: each, termsGeneration: 2 });
      expect(await renamed.query([{ search: "with:ana" }])).toEqual([stored]);
      expect(await renamed.query([{ search: "conv:ana" }])).toEqual([]);
    });

    it("leaves the index alone when the generation is unchanged", async () => {
      const stored = rumor({ id: "stored", created_at: 100, tags: [["p", "ana"]] });
      await db.tenant("t").event(stored);
      await db.tenant("t", { terms: peers, termsGeneration: 1 }).query([{ search: "conv:ana" }]);

      // A different policy at the SAME generation: the marker says this tenant
      // is done, so the pass doesn't run and the stored row keeps the terms it
      // was written with. That is what makes the backfill once-per-file rather
      // than once-per-boot — the generation is the only thing that reopens it.
      const same = db.tenant("t", { terms: each, termsGeneration: 1 });
      const later = rumor({ id: "later", created_at: 200, tags: [["p", "ana"]] });
      await same.event(later);

      expect(await same.query([{ search: "conv:ana" }])).toEqual([stored]);
      expect(await same.query([{ search: "with:ana" }])).toEqual([later]);
    });

    it("pins the term generation to the other ports", async () => {
      // One number, written into a file three engines share: two ports that
      // disagree would each read the other's as stale and rebuild the index on
      // every open. `TermPolicies.GENERATION` (Kotlin) and
      // `TermPolicies.generation` (Swift) are this literal.
      const { TERM_GENERATION } = await import("./termPolicies");
      expect(TERM_GENERATION).toBe(3);
    });
  });

  describe("derived terms: collapsing a read with distinct:", () => {
    /**
     * Files each rumor under the sorted set of its `p` tags, in two namespaces:
     * `conv:` covers every kind and `msg:` only kind 1. That is the shape the DM
     * list uses — a collapse can then name the newest MESSAGE of a conversation
     * without any engine reading a rumor's kind.
     */
    const conv = (rumor: NostrRumor): string[] => {
      const set = [...new Set(rumor.tags.filter(([n]) => n === "p").map(([, v]) => v))].sort();
      if (set.length === 0) return [];
      const key = set.join("");
      return rumor.kind === 1 ? [`conv:${key}`, `msg:${key}`] : [`conv:${key}`];
    };

    const opened = () => db.tenant("t", { terms: conv, termsGeneration: 1 });

    it("returns the newest rumor of every group", async () => {
      const s = opened();
      const anaOld = rumor({ id: "ana-old", created_at: 100, tags: [["p", "ana"]] });
      const anaNew = rumor({ id: "ana-new", created_at: 300, tags: [["p", "ana"]] });
      const ben = rumor({ id: "ben", created_at: 200, tags: [["p", "ben"]] });
      const group = rumor({ id: "group", created_at: 150, tags: [["p", "ana"], ["p", "ben"]] });
      for (const r of [anaOld, anaNew, ben, group]) await s.event(r);

      // One row per participant SET, ordered by that row — not the newest rumors,
      // which is what an ungrouped read with a limit would have given.
      expect(await s.query([{ search: "distinct:conv" }])).toEqual([anaNew, ben, group]);
    });

    it("counts groups against the limit, not rows", async () => {
      const s = opened();
      // A busy conversation, and a quiet one older than every message in it.
      for (let i = 0; i < 5; i++) {
        await s.event(rumor({ id: `busy-${i}`, created_at: 200 + i, tags: [["p", "ana"]] }));
      }
      const quiet = rumor({ id: "quiet", created_at: 100, tags: [["p", "ben"]] });
      await s.event(quiet);

      // The old shape's bug in one assertion: the newest two ROWS are two
      // messages of the busy thread and no sign of the quiet one.
      const rows = await s.query([{ search: "distinct:conv", limit: 2 }]);
      expect(rows.map((r) => r.id)).toEqual(["busy-4", "quiet"]);
    });

    it("excludes a rumor with no term in the namespace", async () => {
      const s = opened();
      const listed = rumor({ id: "listed", tags: [["p", "ana"]] });
      await s.event(listed);
      // In a conversation, but not in the `msg:` grouping.
      await s.event(rumor({ id: "reaction", kind: 7, tags: [["p", "ana"]] }));
      // In no conversation at all.
      await s.event(rumor({ id: "orphan" }));

      expect(await s.query([{ search: "distinct:msg" }])).toEqual([listed]);
    });

    it("names one namespace, whatever the delimiter", async () => {
      const s = opened();
      const ana = rumor({ id: "ana", tags: [["p", "ana"]] });
      await s.event(ana);

      // `conv` and `conv:` are the same namespace, and neither reaches `msg:`.
      expect(await s.query([{ search: "distinct:conv" }])).toEqual([ana]);
      expect(await s.query([{ search: "distinct:conv:" }])).toEqual([ana]);
    });

    it("applies the rest of the filter before collapsing", async () => {
      const s = opened();
      const mine = rumor({ id: "mine", pubkey: "me", created_at: 100, tags: [["p", "ana"]] });
      const theirs = rumor({ id: "theirs", pubkey: "ana", created_at: 200, tags: [["p", "ana"]] });
      for (const r of [mine, theirs]) await s.event(r);

      // The newest rumor of the group is theirs; the newest MATCHING one is mine.
      // Collapsing first and filtering after would answer with nothing.
      expect(await s.query([{ search: "distinct:conv", authors: ["me"] }])).toEqual([mine]);
      expect(await s.query([{ search: "distinct:conv", kinds: [7] }])).toEqual([]);
    });

    it("bounds the window before collapsing too", async () => {
      const s = opened();
      const early = rumor({ id: "early", created_at: 100, tags: [["p", "ana"]] });
      const late = rumor({ id: "late", created_at: 300, tags: [["p", "ana"]] });
      for (const r of [early, late]) await s.event(r);

      expect(await s.query([{ search: "distinct:conv", until: 200 }])).toEqual([early]);
      expect(await s.query([{ search: "distinct:conv", since: 200 }])).toEqual([late]);
      expect(await s.query([{ search: "distinct:conv", since: 400 }])).toEqual([]);
    });

    it("combines a collapse with a term", async () => {
      const s = opened();
      const ana = rumor({ id: "ana", tags: [["p", "ana"]] });
      const ben = rumor({ id: "ben", tags: [["p", "ben"]] });
      for (const r of [ana, ben]) await s.event(r);

      // The collapse says one row per conversation; the term says which one.
      expect(await s.query([{ search: "distinct:conv conv:ana" }])).toEqual([ana]);
    });

    it("counts the groups", async () => {
      const s = opened();
      for (const r of [
        rumor({ tags: [["p", "ana"]] }),
        rumor({ tags: [["p", "ana"]] }),
        rumor({ tags: [["p", "ben"]] }),
      ]) await s.event(r);

      expect(await s.count([{ search: "distinct:conv" }])).toEqual({
        count: 2,
        approximate: false,
      });
    });

    it("counts groups when the filter narrows the rows too", async () => {
      const s = opened();
      for (const r of [
        rumor({ tags: [["p", "ana"]] }),
        rumor({ tags: [["p", "ana"]] }),
        rumor({ tags: [["p", "ben"]] }),
        rumor({ kind: 7, tags: [["p", "cat"]] }),
      ]) await s.event(r);

      // A row condition the index can't test inside the grouping (here `kinds`)
      // makes the collapse happen while scanning instead — and a count that
      // reads its answer out of the index would then count ROWS, reporting a
      // conversation list as the number of messages in it. `count` and
      // `query().length` are one number.
      const filter = { search: "distinct:conv", kinds: [1] };
      expect(await s.count([filter])).toEqual({ count: 2, approximate: false });
      expect((await s.query([filter])).length).toBe(2);
    });

    it("collapses rows that were already stored when the policy arrived", async () => {
      // The pass that indexes a tenant's existing rows is triggered by a read
      // that reaches the term index — and a collapse reaches it while naming no
      // term of its own. An engine that waits only on a filter's parsed TERMS
      // therefore groups over an index nothing has built yet, which is the DM
      // list of every install that upgrades into the feature.
      const before = db.tenant("t");
      const anaOld = rumor({ id: "ana-old", created_at: 100, tags: [["p", "ana"]] });
      const anaNew = rumor({ id: "ana-new", created_at: 300, tags: [["p", "ana"]] });
      const ben = rumor({ id: "ben", created_at: 200, tags: [["p", "ben"]] });
      for (const r of [anaOld, anaNew, ben]) await before.event(r);

      expect(await opened().query([{ search: "distinct:conv" }])).toEqual([anaNew, ben]);
    });

    it("refuses to remove by a collapse", async () => {
      const s = opened();
      const older = rumor({ id: "older", created_at: 100, tags: [["p", "ana"]] });
      const newer = rumor({ id: "newer", created_at: 200, tags: [["p", "ana"]] });
      for (const r of [older, newer]) await s.event(r);

      // "Delete one rumor per conversation" is not a deletion anyone should be
      // able to ask for, so it deletes nothing rather than the newest message of
      // every thread.
      await s.remove([{ search: "distinct:conv" }]);
      expect(await s.query([{ search: "conv:ana" }])).toEqual([newer, older]);
    });

    it("matches nothing in a tenant that derives no terms", async () => {
      const bare = db.tenant("bare");
      await bare.event(rumor({ tags: [["p", "ana"]] }));

      // Failing closed: there is no grouping to apply, and answering the read
      // without the collapse would hand back the whole tenant.
      expect(await bare.query([{ search: "distinct:conv" }])).toEqual([]);
    });

    it("refuses two collapses rather than picking one", async () => {
      const s = opened();
      await s.event(rumor({ tags: [["p", "ana"]] }));

      // A term names one dimension, so grouping by a pair is not answerable.
      expect(await s.query([{ search: "distinct:conv distinct:msg" }])).toEqual([]);
    });

    it("refuses a namespace that isn't one", async () => {
      const s = opened();
      await s.event(rumor({ tags: [["p", "ana"]] }));

      // A whole term is not a namespace. Naming one group's key is `conv:ana` on
      // its own, and reading it as a namespace would silently answer a different
      // question.
      expect(await s.query([{ search: "distinct:conv:ana" }])).toEqual([]);
    });
  });

  describe("replaceable rumors", () => {
    it("supersedes an older version at the same coordinate", async () => {
      const store = db.tenant("t");
      const old = rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 });
      const fresh = rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 });
      await store.event(old);
      await store.event(fresh);

      expect(await store.query([{ kinds: [10002] }])).toEqual([fresh]);
    });

    it("ignores a stale write", async () => {
      const store = db.tenant("t");
      const fresh = rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 });
      const old = rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 });
      await store.event(fresh);
      await store.event(old);

      expect(await store.query([{ kinds: [10002] }])).toEqual([fresh]);
    });

    it("keeps addressable versions with different d tags apart", async () => {
      const store = db.tenant("t");
      const one = rumor({ id: "one", kind: 30078, pubkey: "alice", tags: [["d", "a"]] });
      const two = rumor({ id: "two", kind: 30078, pubkey: "alice", tags: [["d", "b"]] });
      const newerA = rumor({
        id: "three",
        kind: 30078,
        pubkey: "alice",
        created_at: 9999,
        tags: [["d", "a"]],
      });
      for (const r of [one, two, newerA]) await store.event(r);

      const got = await store.query([{ kinds: [30078] }]);
      expect(got.map((r) => r.id).sort()).toEqual(["three", "two"]);
    });

    it("scopes supersession to the tenant", async () => {
      const old = rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 });
      const fresh = rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 });
      await db.tenant("a").event(old);
      await db.tenant("b").event(fresh);

      expect(await db.tenant("a").query([{}])).toEqual([old]);
      expect(await db.tenant("b").query([{}])).toEqual([fresh]);
    });
  });

  describe("NIP-09 deletion", () => {
    it("deletes the author's own rumors and keeps the request", async () => {
      const store = db.tenant("t");
      const mine = rumor({ id: "mine", pubkey: "alice", created_at: 100 });
      const theirs = rumor({ id: "theirs", pubkey: "bob", created_at: 100 });
      await store.event(mine);
      await store.event(theirs);

      const request = rumor({
        id: "req",
        kind: 5,
        pubkey: "alice",
        created_at: 200,
        tags: [
          ["e", "mine"],
          ["e", "theirs"],
        ],
      });
      await store.event(request);

      const got = await store.query([{}]);
      expect(got.map((r) => r.id).sort()).toEqual(["req", "theirs"]);
    });

    it("deletes an addressable coordinate up to the request time", async () => {
      const store = db.tenant("t");
      await store.event(
        rumor({ id: "a", kind: 30078, pubkey: "alice", created_at: 100, tags: [["d", "x"]] }),
      );
      await store.event(
        rumor({
          id: "req",
          kind: 5,
          pubkey: "alice",
          created_at: 200,
          tags: [["a", "30078:alice:x"]],
        }),
      );

      expect(await store.query([{ kinds: [30078] }])).toEqual([]);
    });
  });

  describe("forget (removed from this device)", () => {
    it("deletes the id from every tenant and leaves the rest", async () => {
      const gone = rumor({ id: "gone" });
      const kept = rumor({ id: "kept" });
      await db.tenant("a").event(gone);
      await db.tenant("a").event(kept);
      await db.tenant("b").event(gone);

      await db.forget(["gone"]);

      expect((await db.tenant("a").query([{}])).map((r) => r.id)).toEqual(["kept"]);
      expect(await db.tenant("b").query([{}])).toEqual([]);
    });

    it("refuses the id afterwards in any tenant, in a batch and alone", async () => {
      await db.forget(["gone"]);
      const gone = rumor({ id: "gone" });
      const other = rumor({ id: "other" });
      await Promise.all([db.tenant("a").event(gone), db.tenant("a").event(other)]);
      await db.tenant("never-opened").event(gone);

      expect((await db.tenant("a").query([{}])).map((r) => r.id)).toEqual(["other"]);
      expect(await db.tenant("never-opened").query([{}])).toEqual([]);
    });

    it("refuses a removed replaceable without superseding the stored version", async () => {
      const store = db.tenant("t");
      const old = rumor({ id: "old", kind: 10000, pubkey: "alice", created_at: 100 });
      await store.event(old);
      await db.forget(["newer"]);

      await store.event(rumor({ id: "newer", kind: 10000, pubkey: "alice", created_at: 200 }));

      expect(await store.query([{ kinds: [10000] }])).toEqual([old]);
    });

    it("the wipe forgets what was removed", async () => {
      if (!("wipe" in db)) return; // IndexedDB's logout deletes the databases instead.
      await db.forget(["gone"]);
      await (db as unknown as { wipe(): Promise<void> }).wipe();
      await db.tenant("t").event(rumor({ id: "gone" }));
      expect((await db.tenant("t").query([{}])).map((r) => r.id)).toEqual(["gone"]);
    });

    it("refuses a write queued before the call", async () => {
      const queued = db.tenant("t").event(rumor({ id: "racing" }));
      await db.forget(["racing"]);
      await queued;
      expect(await db.tenant("t").query([{ ids: ["racing"] }])).toEqual([]);
    });
  });

  describe("kv", () => {
    it("returns undefined for a key that was never set", async () => {
      expect(await db.kv.get("missing")).toBeUndefined();
    });

    it("round-trips JSON values", async () => {
      await db.kv.set("cursor", { since: 123, relays: ["wss://a"], done: false });

      expect(await db.kv.get("cursor")).toEqual({
        since: 123,
        relays: ["wss://a"],
        done: false,
      });
    });

    it("round-trips primitives, including falsy ones", async () => {
      await db.kv.set("n", 0);
      await db.kv.set("s", "");
      await db.kv.set("b", false);
      await db.kv.set("nil", null);

      expect(await db.kv.get("n")).toBe(0);
      expect(await db.kv.get("s")).toBe("");
      expect(await db.kv.get("b")).toBe(false);
      expect(await db.kv.get("nil")).toBeNull();
    });

    it("overwrites an existing key", async () => {
      await db.kv.set("k", "first");
      await db.kv.set("k", "second");

      expect(await db.kv.get("k")).toBe("second");
    });

    it("is independent of tenant data", async () => {
      await db.kv.set("t", "kv value");
      await db.tenant("t").event(rumor());

      expect(await db.kv.get("t")).toBe("kv value");
      expect((await db.tenant("t").query([{}])).length).toBe(1);
    });

    it("deletes a key", async () => {
      await db.kv.set("gone", "here");
      await db.kv.delete("gone");

      expect(await db.kv.get("gone")).toBeUndefined();
    });

    it("deleting a key that was never set is a no-op", async () => {
      await expect(db.kv.delete("never")).resolves.toBeUndefined();
    });

    it("lists every entry when no selector is given", async () => {
      await db.kv.set("a", 1);
      await db.kv.set("b", 2);

      const all = [{ key: "a", value: 1 }, { key: "b", value: 2 }];
      expect(await db.kv.list()).toEqual(all);
      expect(await db.kv.list({})).toEqual(all);
      expect(await db.kv.list({ prefix: "" })).toEqual(all);
    });

    it("lists a value with its key, so no follow-up read is needed", async () => {
      await db.kv.set("p:1", { since: 7 });
      await db.kv.set("p:2", null);

      expect(await db.kv.list({ prefix: "p:" })).toEqual([
        { key: "p:1", value: { since: 7 } },
        { key: "p:2", value: null },
      ]);
    });

    it("lists only the entries under a prefix", async () => {
      await db.kv.set("p:1", 1);
      await db.kv.set("p:2", 2);
      await db.kv.set("q:1", 3);

      expect(await db.kv.list({ prefix: "p:" })).toEqual([
        { key: "p:1", value: 1 },
        { key: "p:2", value: 2 },
      ]);
    });

    it("treats the prefix as a boundary, not a substring match", async () => {
      // `p` is a prefix of `pp`, so a bound that ran to the wrong successor
      // would drag `pp:1` in. It must not.
      await db.kv.set("p:1", 1);
      await db.kv.set("pp:1", 2);
      await db.kv.set("op:1", 3);

      expect(await db.kv.list({ prefix: "p:" })).toEqual([{ key: "p:1", value: 1 }]);
      expect(await db.kv.list({ prefix: "pp" })).toEqual([{ key: "pp:1", value: 2 }]);
    });

    it("lists nothing under an unmatched prefix", async () => {
      await db.kv.set("a:1", 1);

      expect(await db.kv.list({ prefix: "z:" })).toEqual([]);
    });

    it("stops listing an entry once it is deleted", async () => {
      await db.kv.set("d:1", 1);
      await db.kv.set("d:2", 2);
      await db.kv.delete("d:1");

      expect(await db.kv.list({ prefix: "d:" })).toEqual([{ key: "d:2", value: 2 }]);
    });

    it("scans a prefix ending in the maximal code unit", async () => {
      // \uffff has no successor code unit, so the range degrades to open-ended
      // and the prefix filter is the only thing keeping `x` out.
      await db.kv.set("k\uffff:1", 1);
      await db.kv.set("x", 2);

      expect(await db.kv.list({ prefix: "k\uffff" })).toEqual([{ key: "k\uffff:1", value: 1 }]);
    });

    it("scans a half-open range", async () => {
      for (const key of ["a", "b", "c", "d"]) await db.kv.set(key, key);

      // `start` inclusive, `end` exclusive.
      expect(await db.kv.list({ start: "b", end: "d" })).toEqual([
        { key: "b", value: "b" },
        { key: "c", value: "c" },
      ]);
      expect(await db.kv.list({ start: "c" })).toEqual([
        { key: "c", value: "c" },
        { key: "d", value: "d" },
      ]);
      expect(await db.kv.list({ end: "b" })).toEqual([{ key: "a", value: "a" }]);
    });

    it("resumes a prefix scan from a cursor", async () => {
      // The reason ranges exist here: a key space with an ordered suffix can be
      // read forward from where the last pass stopped.
      for (const n of [1, 2, 3, 4]) await db.kv.set(`log:${n}`, n);

      expect(await db.kv.list({ prefix: "log:", start: "log:3" })).toEqual([
        { key: "log:3", value: 3 },
        { key: "log:4", value: 4 },
      ]);
      expect(await db.kv.list({ prefix: "log:", end: "log:3" })).toEqual([
        { key: "log:1", value: 1 },
        { key: "log:2", value: 2 },
      ]);
    });

    it("keeps a range bound inside its prefix", async () => {
      await db.kv.set("p:1", 1);
      await db.kv.set("q:1", 2);

      // A bound outside the prefix narrows to nothing rather than escaping it:
      // `q:` is past the end of `p:`, and `a` is before its start.
      expect(await db.kv.list({ prefix: "p:", start: "q:" })).toEqual([]);
      expect(await db.kv.list({ prefix: "p:", end: "a" })).toEqual([]);
      expect(await db.kv.list({ prefix: "p:", start: "a" })).toEqual([{ key: "p:1", value: 1 }]);
    });

    it("lists nothing when the bounds cross", async () => {
      await db.kv.set("b", 1);

      expect(await db.kv.list({ start: "z", end: "a" })).toEqual([]);
      expect(await db.kv.list({ start: "b", end: "b" })).toEqual([]);
    });

    it("refuses a prefix given both bounds", async () => {
      // The bounds already describe the range; a prefix on top of them is either
      // redundant or a contradiction, and Deno.KV rejects the same shape.
      await expect(db.kv.list({ prefix: "p:", start: "p:1", end: "p:9" })).rejects.toThrow(TypeError);
    });

    it("takes the first entries under a limit", async () => {
      for (const n of [1, 2, 3]) await db.kv.set(`p:${n}`, n);

      expect(await db.kv.list({ prefix: "p:" }, { limit: 2 })).toEqual([
        { key: "p:1", value: 1 },
        { key: "p:2", value: 2 },
      ]);
      // A limit past the end is not an error, and 0 asks for nothing.
      expect((await db.kv.list({ prefix: "p:" }, { limit: 9 })).length).toBe(3);
      expect(await db.kv.list({ prefix: "p:" }, { limit: 0 })).toEqual([]);
    });

    it("walks the key order backwards", async () => {
      for (const n of [1, 2, 3]) await db.kv.set(`p:${n}`, n);

      expect((await db.kv.list({ prefix: "p:" }, { reverse: true })).map((e) => e.key))
        .toEqual(["p:3", "p:2", "p:1"]);
      // A limit takes from the front of the order it was asked for, so reversing
      // makes it the LAST entries.
      expect(await db.kv.list({ prefix: "p:" }, { reverse: true, limit: 1 })).toEqual([
        { key: "p:3", value: 3 },
      ]);
    });

    it("limits a scan whose range over-admits", async () => {
      // An open-ended prefix scan (see above) reads past its own matches, so the
      // limit cannot be handed to the engine — it has to apply to what SURVIVES
      // the filter, or a full page would come back short.
      await db.kv.set("k\uffff:1", 1);
      await db.kv.set("k\uffff:2", 2);
      await db.kv.set("x", 3);

      expect(await db.kv.list({ prefix: "k\uffff" }, { limit: 2 })).toEqual([
        { key: "k\uffff:1", value: 1 },
        { key: "k\uffff:2", value: 2 },
      ]);
    });
  });
});
