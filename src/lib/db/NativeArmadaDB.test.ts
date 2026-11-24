// @vitest-environment node
/**
 * The native bridge adapter, against a stand-in for the native store.
 *
 * What is under test here is the TRANSPORT, not the query engine: the engine is
 * Kotlin on Android and Swift on iOS, and `ArmadaDbTest.kt` / `ArmadaDbTests.swift`
 * run the conformance suite against each directly. What can go wrong on this
 * side is everything around it — a filter that doesn't survive
 * `JSON.stringify`, a burst that crosses the bridge a thousand times instead of
 * once, a KV value that comes back as a string.
 *
 * The stand-in is the TypeScript SQLite adapter, which is the same design and
 * the same schema, so a protocol mismatch shows up as a wrong answer rather than
 * as a passing test against a mock that agrees with whatever it was handed.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

/**
 * A stand-in for `ArmadaDbPlugin.kt`, speaking the same JSON-text protocol.
 * Hoisted because `vi.mock`'s factory runs before the module body.
 */
const native = vi.hoisted(() => {
  const calls = { query: 0, event: 0, count: 0, remove: 0, kvSet: 0, kvOps: 0 };
  /** Every `kvOps` batch as sent, for asserting what crossed. */
  const kvBatches: Array<Array<{ op: string; key?: string }>> = [];
  let store: {
    tenant(id: string): {
      query(filters: NostrFilter[]): Promise<NostrRumor[]>;
      event(rumor: NostrRumor): Promise<void>;
      count(filters: NostrFilter[]): Promise<{ count: number; approximate: boolean }>;
      remove(filters: NostrFilter[]): Promise<void>;
    };
    kv: {
      get<T>(key: string): Promise<T | undefined>;
      set<T>(key: string, value: T): Promise<void>;
      delete(key: string): Promise<void>;
      list<T>(
        selector?: { prefix?: string; start?: string; end?: string },
        opts?: { limit?: number; reverse?: boolean },
      ): Promise<{ key: string; value: T }[]>;
    };
  };

  return {
    calls,
    kvBatches,
    /** Mutable so the adapter's platform gate can be tested on both natives. */
    platform: "android" as string,
    pluginAvailable: true,
    use(next: typeof store) {
      store = next;
      for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
    },
    plugin: {
      async query({ tenant, filters }: { tenant: string; filters: string }) {
        calls.query++;
        const rumors = await store.tenant(tenant).query(JSON.parse(filters) as NostrFilter[]);
        return { rumors: JSON.stringify(rumors) };
      },
      async event({ tenant, rumors }: { tenant: string; rumors: string }) {
        calls.event++;
        const batch = JSON.parse(rumors) as NostrRumor[];
        await Promise.all(batch.map((rumor) => store.tenant(tenant).event(rumor)));
      },
      async count({ tenant, filters }: { tenant: string; filters: string }) {
        calls.count++;
        return await store.tenant(tenant).count(JSON.parse(filters) as NostrFilter[]);
      },
      async remove({ tenant, filters }: { tenant: string; filters: string }) {
        calls.remove++;
        await store.tenant(tenant).remove(JSON.parse(filters) as NostrFilter[]);
      },
      async tenants() {
        return { tenants: JSON.stringify([]) };
      },
      // The native side stores opaque JSON TEXT, so the stand-in has to as
      // well: a stub that kept the live value would hide a serialization bug.
      async kvGet({ key }: { key: string }) {
        const value = await store.kv.get<string>(key);
        return value === undefined ? {} : { value };
      },
      async kvSet({ key, value }: { key: string; value: string }) {
        calls.kvSet++;
        await store.kv.set(key, value);
      },
      async kvDelete({ key }: { key: string }) {
        await store.kv.delete(key);
      },
      async kvList(
        { prefix, start, end, limit, reverse }: {
          prefix?: string;
          start?: string;
          end?: string;
          limit?: number;
          reverse?: boolean;
        },
      ) {
        // Values cross as the JSON TEXT they are stored as, which for this
        // stand-in means the string the backing store handed back.
        const entries = await store.kv.list<string>({ prefix, start, end }, { limit, reverse });
        return { entries: JSON.stringify(entries) };
      },
      // The batched KV crossing (see `NativeKV.flush`): ops in arrival order,
      // results aligned positionally, values still opaque JSON TEXT.
      async kvOps({ ops }: { ops: string }) {
        calls.kvOps++;
        kvBatches.push(JSON.parse(ops));
        const batch = JSON.parse(ops) as Array<
          | { op: "get"; key: string }
          | { op: "set"; key: string; value: string }
          | { op: "delete"; key: string }
          | { op: "list"; prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean }
        >;
        const results: Array<string | null | Array<{ key: string; value: string }>> = [];
        for (const op of batch) {
          if (op.op === "get") {
            const value = await store.kv.get<string>(op.key);
            results.push(value === undefined ? null : value);
          } else if (op.op === "set") {
            calls.kvSet++;
            await store.kv.set(op.key, op.value);
            results.push(null);
          } else if (op.op === "delete") {
            await store.kv.delete(op.key);
            results.push(null);
          } else {
            const { prefix, start, end, limit, reverse } = op;
            results.push(await store.kv.list<string>({ prefix, start, end }, { limit, reverse }));
          }
        }
        return { results: JSON.stringify(results) };
      },
      async wipe() {},
    },
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isPluginAvailable: () => native.pluginAvailable,
    isNativePlatform: () => native.platform !== "web",
  },
  registerPlugin: () => native.plugin,
}));

const { hasNativeArmadaDB, NativeArmadaDB, READ_PAGE } = await import("./NativeArmadaDB");
const { SqliteArmadaDB } = await import("./SqliteArmadaDB");

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

describe("NativeArmadaDB", () => {
  let backing: InstanceType<typeof SqliteArmadaDB>;
  let db: InstanceType<typeof NativeArmadaDB>;

  beforeEach(() => {
    backing = new SqliteArmadaDB(new NodeSqlDriver());
    native.use(backing);
    db = new NativeArmadaDB();
  });

  afterEach(async () => {
    await backing.close().catch(() => undefined);
  });

  it("is selected on the platforms that implement it, when the plugin is present", () => {
    for (const platform of ["android", "ios"]) {
      native.platform = platform;
      expect(hasNativeArmadaDB()).toBe(true);
    }

    // A platform with no implementation must fall through to IndexedDB rather
    // than reach a `registerPlugin` proxy with nothing behind it.
    for (const platform of ["web", "electron"]) {
      native.platform = platform;
      expect(hasNativeArmadaDB()).toBe(false);
    }

    // And so must a build whose plugin failed to register: answering `true`
    // here would make every read reject instead of opening the web store.
    native.platform = "ios";
    native.pluginAvailable = false;
    expect(hasNativeArmadaDB()).toBe(false);

    native.platform = "android";
    native.pluginAvailable = true;
  });

  it("returns the same store for a tenant id", () => {
    expect(db.tenant("c2:abc")).toBe(db.tenant("c2:abc"));
  });

  it("stores and reads back a rumor", async () => {
    const r = rumor({ tags: [["channel", "chan-1"]] });
    await db.tenant("c2:abc").event(r);

    expect(await db.tenant("c2:abc").query([{ "#channel": ["chan-1"] }])).toEqual([r]);
  });

  it("isolates tenants", async () => {
    await db.tenant("a").event(rumor({ id: "a" }));
    await db.tenant("b").event(rumor({ id: "b" }));

    expect((await db.tenant("a").query([{}])).map((r) => r.id)).toEqual(["a"]);
    expect((await db.tenant("b").query([{}])).map((r) => r.id)).toEqual(["b"]);
  });

  it("strips a signature before it crosses the bridge", async () => {
    const signed = { ...rumor({ id: "a" }), sig: "f".repeat(128) };
    await db.tenant("t").event(signed);

    const [stored] = await db.tenant("t").query([{}]);
    expect(stored).not.toHaveProperty("sig");
  });

  it("crosses the bridge ONCE for a burst of writes", async () => {
    await Promise.all([
      db.tenant("t").event(rumor({ id: "a" })),
      db.tenant("t").event(rumor({ id: "b" })),
      db.tenant("t").event(rumor({ id: "c" })),
    ]);

    expect(native.calls.event).toBe(1);
    expect((await db.tenant("t").query([{}])).length).toBe(3);
  });

  // The other half of the story the write test above tells. Writes fold a
  // same-tick burst into ONE crossing (`flush()`); reads have no such fold, so
  // this pins the cost as a number. It is a characterization, not a wish: the
  // adapter's own comment says "The call count matters as much as the total,"
  // and until there is a coalescing or dedup layer to beat it, these are the
  // baselines it has to beat.
  it("crosses the bridge ONCE PER READ — reads are not coalesced", async () => {
    await db.tenant("t").event(rumor({ id: "a" }));
    native.calls.query = 0;

    // Three reads issued in the same tick, before anyone awaits. Unlike the
    // write burst, each is its own hop onto the single plugin thread and its
    // own turn of the native lock.
    await Promise.all([
      db.tenant("t").query([{ ids: ["a"] }]),
      db.tenant("t").query([{ ids: ["a"] }]),
      db.tenant("t").query([{ ids: ["a"] }]),
    ]);

    expect(native.calls.query).toBe(3);
  });

  it("does not dedup identical in-flight reads — call count scales with fan-out", async () => {
    await db.tenant("t").event(rumor({ id: "a" }));

    // The concrete lever for the perceived lag: a component tree that fans out
    // into N reads pays N crossings, even when the reads are byte-identical and
    // in flight at the same moment. Nothing between `query()` and the bridge
    // collapses them, so the crossing count is exactly the read count — the
    // number a future in-flight cache would drive toward 1.
    for (const fanOut of [1, 5, 20]) {
      native.calls.query = 0;
      await Promise.all(
        Array.from({ length: fanOut }, () => db.tenant("t").query([{ ids: ["a"] }])),
      );
      expect(native.calls.query).toBe(fanOut);
    }
  });

  it("carries every filter term across", async () => {
    await db.tenant("t").event(rumor({ id: "a", pubkey: "alice", kind: 1, created_at: 100 }));
    await db.tenant("t").event(rumor({ id: "b", pubkey: "bob", kind: 7, created_at: 200 }));

    expect((await db.tenant("t").query([{ ids: ["b"] }])).map((r) => r.id)).toEqual(["b"]);
    expect((await db.tenant("t").query([{ authors: ["alice"] }])).map((r) => r.id)).toEqual(["a"]);
    expect((await db.tenant("t").query([{ kinds: [7] }])).map((r) => r.id)).toEqual(["b"]);
    expect((await db.tenant("t").query([{ since: 200 }])).map((r) => r.id)).toEqual(["b"]);
    expect((await db.tenant("t").query([{ until: 100 }])).map((r) => r.id)).toEqual(["a"]);
    expect((await db.tenant("t").query([{ limit: 1 }])).map((r) => r.id)).toEqual(["b"]);
  });

  describe("reads larger than a page", () => {
    /** `n` rows, `perSecond` to each second, oldest at `from`. */
    async function seed(n: number, perSecond = 1, from = 10_000): Promise<void> {
      await Promise.all(Array.from({ length: n }, (_, i) =>
        db.tenant("t").event(rumor({ id: `r${String(i).padStart(6, "0")}`, created_at: from + Math.floor(i / perSecond) }))));
      native.calls.query = 0;
    }

    /** What the engine answers in one unpaged read, for comparison. */
    const whole = (filters: NostrFilter[]) => backing.tenant("t").query(filters);

    it("answers an unlimited read in bounded crossings, identical to one read", async () => {
      await seed(2 * READ_PAGE + 7, 3);
      const got = await db.tenant("t").query([{ kinds: [1] }]);
      expect(got).toEqual(await whole([{ kinds: [1] }]));
      expect(got).toHaveLength(2 * READ_PAGE + 7);
      expect(native.calls.query).toBeGreaterThan(1);
    });

    it("keeps a small unlimited read to one crossing", async () => {
      await seed(10);
      await db.tenant("t").query([{ kinds: [1] }]);
      expect(native.calls.query).toBe(1);
    });

    it("reads a second holding more than a page whole, and moves past it", async () => {
      await seed(READ_PAGE + 50, READ_PAGE + 50, 20_000);
      await db.tenant("t").event(rumor({ id: "older", created_at: 19_999 }));
      const got = await db.tenant("t").query([{}]);
      expect(got).toEqual(await whole([{}]));
      expect(got.at(-1)!.id).toBe("older");
    });

    it("honours a limit above a page, and since/until", async () => {
      await seed(3 * READ_PAGE);
      const limit = READ_PAGE + 123;
      expect(await db.tenant("t").query([{ limit }])).toEqual(await whole([{ limit }]));
      const window = { since: 10_100, until: 10_000 + 2 * READ_PAGE + 5 };
      expect(await db.tenant("t").query([window])).toEqual(await whole([window]));
    });

    it("merges a paged filter with bounded ones, deduped and newest first", async () => {
      await seed(READ_PAGE + 10);
      const filters: NostrFilter[] = [{ ids: ["r000003"] }, { kinds: [1] }, { limit: 5 }];
      expect(await db.tenant("t").query(filters)).toEqual(await whole(filters));
    });
  });

  it("counts and removes", async () => {
    await db.tenant("t").event(rumor({ id: "a", kind: 1 }));
    await db.tenant("t").event(rumor({ id: "b", kind: 7 }));

    expect(await db.tenant("t").count([{}])).toEqual({ count: 2, approximate: false });

    await db.tenant("t").remove([{ kinds: [7] }]);
    expect((await db.tenant("t").query([{}])).map((r) => r.id)).toEqual(["a"]);
  });

  it("round-trips kv values through JSON, not through the bridge's guesses", async () => {
    await db.kv.set("obj", { a: 1, b: ["x"] });
    await db.kv.set("num", 0);
    await db.kv.set("bool", false);
    await db.kv.set("str", "");

    expect(await db.kv.get("obj")).toEqual({ a: 1, b: ["x"] });
    expect(await db.kv.get("num")).toBe(0);
    expect(await db.kv.get("bool")).toBe(false);
    expect(await db.kv.get("str")).toBe("");
    expect(await db.kv.get("missing")).toBeUndefined();
  });

  it("normalizes an out-of-contract value to null rather than throwing", async () => {
    await db.kv.set("undef", undefined);
    expect(await db.kv.get("undef")).toBeNull();
  });

  it("deletes and prefix-scans kv entries", async () => {
    await db.kv.set("a:1", 1);
    await db.kv.set("a:2", 2);
    await db.kv.set("b:1", 3);

    // Values come back with the keys, having crossed the bridge as JSON text.
    expect(await db.kv.list({ prefix: "a:" })).toEqual([
      { key: "a:1", value: 1 },
      { key: "a:2", value: 2 },
    ]);

    await db.kv.delete("a:1");
    expect(await db.kv.list({ prefix: "a:" })).toEqual([{ key: "a:2", value: 2 }]);
    // Deleting a key that was never set is a no-op, not an error.
    await db.kv.delete("a:1");
  });

  it("carries a range selector across the bridge", async () => {
    for (const n of [1, 2, 3, 4]) await db.kv.set(`log:${n}`, n);

    expect(await db.kv.list({ prefix: "log:", start: "log:3" })).toEqual([
      { key: "log:3", value: 3 },
      { key: "log:4", value: 4 },
    ]);
    expect(await db.kv.list({ prefix: "log:" }, { reverse: true, limit: 1 })).toEqual([
      { key: "log:4", value: 4 },
    ]);
  });

  it("a read flushes writes queued but not yet awaited (read-your-writes)", async () => {
    // A write whose promise is never awaited before the read. The read must
    // still observe it: callers rely on program order, not on remembering to
    // await every fire-and-forget write. Before the drain-before-read flush
    // this crossed the bridge for the query BEFORE the write's microtask ran,
    // so the read came back empty.
    db.tenant("t").event(rumor({ id: "a" }));
    expect((await db.tenant("t").query([{}])).map((r) => r.id)).toEqual(["a"]);

    // Same for count and remove: each acts after the writes program-ordered
    // before it.
    db.tenant("t").event(rumor({ id: "b" }));
    expect(await db.tenant("t").count([{}])).toEqual({ count: 2, approximate: false });

    db.tenant("t").event(rumor({ id: "c" }));
    await db.tenant("t").remove([{ ids: ["a"] }]);
    expect((await db.tenant("t").query([{}])).map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("sends a key read several times in one crossing once, and hands each reader its own value", async () => {
    await db.kv.set("dup:list", { entries: [1, 2] });
    native.kvBatches.length = 0;

    const reads = await Promise.all([
      db.kv.get<{ entries: number[] }>("dup:list"),
      db.kv.get<{ entries: number[] }>("dup:list"),
      db.kv.get<{ entries: number[] }>("dup:other"),
      db.kv.get<{ entries: number[] }>("dup:list"),
    ]);

    expect(native.kvBatches).toEqual([[
      { op: "get", key: "dup:list" },
      { op: "get", key: "dup:other" },
    ]]);
    expect(reads).toEqual([{ entries: [1, 2] }, { entries: [1, 2] }, undefined, { entries: [1, 2] }]);
    // Separate parses, so one reader mutating its copy can't reach another's.
    reads[0]!.entries.push(3);
    expect(reads[1]).toEqual({ entries: [1, 2] });
  });

  it("re-reads a key written between two reads of it in one crossing", async () => {
    await db.kv.set("dup:k", "old");
    native.kvBatches.length = 0;

    const [before, , after] = await Promise.all([
      db.kv.get("dup:k"),
      db.kv.set("dup:k", "new"),
      db.kv.get("dup:k"),
    ]);

    expect(before).toBe("old");
    expect(after).toBe("new");
    expect(native.kvBatches[0]!.filter((op) => op.op === "get")).toHaveLength(2);
  });

  it("coalesces a same-tick kv burst into one crossing, in arrival order", async () => {
    // A burst issued before anyone awaits — every op crosses the bridge ONCE,
    // and the list at the end observes every write queued ahead of it.
    const [, , got, listed] = await Promise.all([
      db.kv.set("burst:1", 1),
      db.kv.set("burst:2", 2),
      db.kv.get("burst:1"),
      db.kv.list({ prefix: "burst:" }),
    ]);

    expect(native.calls.kvOps).toBe(1);
    expect(got).toBe(1);
    expect(listed).toEqual([
      { key: "burst:1", value: 1 },
      { key: "burst:2", value: 2 },
    ]);
  });
});

/** Yield a macrotask, so the next enqueue lands in a later turn of the loop. */
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A bridge whose crossings can be STALLED, standing in for the loaded phone:
 * on Android every `event`/`kvOps` call is a hop onto Capacitor's single plugin
 * thread and a turn of one native lock, and under an ingest storm a crossing
 * takes real wall-clock time to return. What matters here is the batch bridge's
 * behaviour while a crossing is in flight — so the fake counts crossings, records
 * each batch's size, and only completes them when the test opens the gate.
 */
function stallableBridge() {
  const eventBatches: number[] = [];
  const kvBatches: number[] = [];
  /** Every crossing in the order the native side actually executed it. */
  const log: string[] = [];
  const rumors = new Map<string, Map<string, NostrRumor>>();
  const kv = new Map<string, string>();

  let open = false;
  let waiters: Array<() => void> = [];
  const gate = () => (open ? Promise.resolve() : new Promise<void>((r) => waiters.push(r)));

  const bridge = {
    async event({ tenant, rumors: json }: { tenant: string; rumors: string }) {
      const batch = JSON.parse(json) as NostrRumor[];
      eventBatches.push(batch.length);
      log.push(`w:${batch.length}`);
      await gate();
      const t = rumors.get(tenant) ?? new Map<string, NostrRumor>();
      for (const r of batch) t.set(r.id, r);
      rumors.set(tenant, t);
    },
    async query({ tenant }: { tenant: string; filters: string }) {
      log.push("r");
      return { rumors: JSON.stringify([...(rumors.get(tenant)?.values() ?? [])]) };
    },
    async kvOps({ ops }: { ops: string }) {
      const batch = JSON.parse(ops) as Array<{ op: string; key?: string; value?: string }>;
      kvBatches.push(batch.length);
      await gate();
      const results: Array<string | null> = [];
      for (const op of batch) {
        if (op.op === "set") {
          kv.set(op.key!, op.value!);
          results.push(null);
        } else if (op.op === "get") {
          results.push(kv.get(op.key!) ?? null);
        } else {
          results.push(null);
        }
      }
      return { results: JSON.stringify(results) };
    },
    async count() {
      return { count: 0, approximate: false };
    },
    async remove() {},
    async tenants() {
      return { tenants: JSON.stringify([]) };
    },
    async kvGet() {
      return {};
    },
    async kvSet() {},
    async kvDelete() {},
    async kvList() {
      return { entries: JSON.stringify([]) };
    },
    async wipe() {},
  };

  return {
    bridge: bridge as unknown as ConstructorParameters<typeof NativeArmadaDB>[0],
    eventBatches,
    kvBatches,
    log,
    /** Complete every stalled crossing and let future ones pass straight through. */
    release() {
      open = true;
      const pending = waiters;
      waiters = [];
      for (const w of pending) w();
    },
  };
}

describe("NativeArmadaDB under a stalled bridge (the loaded device)", () => {
  it("folds writes that arrive during an in-flight crossing into the NEXT single crossing", async () => {
    const { bridge, eventBatches, release } = stallableBridge();
    const db = new NativeArmadaDB(bridge);
    const t = db.tenant("c2:x");

    // First write starts the drain; its crossing stalls (the phone mid-storm).
    const first = t.event(rumor({ id: "a" }));
    await macrotask(); // let the flush microtask run and reach the stalled bridge

    // Three more writes arrive while the first crossing is still outstanding,
    // each in its own macrotask — exactly how relay events land, one per socket
    // message. Before the single-in-flight drain, each spawned its OWN concurrent
    // crossing, so this was four crossings; now they accumulate behind the one
    // in flight.
    const rest: Promise<void>[] = [];
    for (const id of ["b", "c", "d"]) {
      rest.push(t.event(rumor({ id })));
      await macrotask();
    }

    release();
    await Promise.all([first, ...rest]);

    // One crossing for the first write, one for everything that piled up behind
    // it — not one per write.
    expect(eventBatches).toEqual([1, 3]);
    expect((await t.query([{}])).map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("puts a read behind the FOLDED write crossings, not one per write", async () => {
    // The whole case for fixing this in the fold rather than with a second
    // SQLite connection: Capacitor runs every plugin call on ONE background
    // thread (a single FIFO consumer), so a read's latency is however many write
    // crossings sit ahead of it — a second connection cannot dequeue it any
    // sooner. Fold the writes and the read is behind two crossings instead of
    // four; the count of crossings ahead of the read is the thing the fold
    // moves, and it is exactly what the read waits on.
    const { bridge, log, release } = stallableBridge();
    const db = new NativeArmadaDB(bridge);
    const t = db.tenant("c2:x");

    const writes = [t.event(rumor({ id: "a" }))];
    await macrotask();
    for (const id of ["b", "c", "d"]) {
      writes.push(t.event(rumor({ id })));
      await macrotask();
    }

    // A reader arrives while the writes are still outstanding.
    const read = t.query([{}]);
    await macrotask();

    release();
    const rows = await read;
    await Promise.all(writes);

    // Two write crossings precede the read, not four — and read-your-writes
    // still holds across the fold.
    expect(log).toEqual(["w:1", "w:3", "r"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("folds kv ops that arrive during an in-flight crossing the same way", async () => {
    const { bridge, kvBatches, release } = stallableBridge();
    const db = new NativeArmadaDB(bridge);

    const first = db.kv.set("k:a", 1);
    await macrotask();

    const rest: Promise<void>[] = [];
    for (const [k, v] of [["k:b", 2], ["k:c", 3], ["k:d", 4]] as const) {
      rest.push(db.kv.set(k, v));
      await macrotask();
    }

    release();
    await Promise.all([first, ...rest]);

    expect(kvBatches).toEqual([1, 3]);
  });

  it("lets a read cross under a steady write stream instead of waiting for the drain to idle", async () => {
    // A relay backfill is one write per socket message for as long as it
    // lasts, and a crossing that is slower than the arrival rate means the
    // drain never finds `pending` empty. A read must wait only for the writes
    // program-ordered before it — the batch in flight plus the one queued
    // behind it — not for the stream to end.
    const log: string[] = [];
    const bridge = {
      async event({ rumors: json }: { tenant: string; rumors: string }) {
        log.push(`w:${(JSON.parse(json) as unknown[]).length}`);
        await macrotask();
        await macrotask();
      },
      async query() {
        log.push("r");
        return { rumors: "[]" };
      },
    } as unknown as ConstructorParameters<typeof NativeArmadaDB>[0];
    const t = new NativeArmadaDB(bridge).tenant("c2:x");

    void t.event(rumor({ id: "0" }));
    await macrotask();
    let readCrossedAt = -1;
    const read = t.query([{}]).then(() => (readCrossedAt = log.indexOf("r")));

    for (let i = 1; i <= 20; i++) {
      void t.event(rumor({ id: String(i) }));
      await macrotask();
    }
    await read;

    // The read crossed while the stream was still running, behind the two
    // batches ahead of it and no more.
    expect(readCrossedAt).toBeGreaterThan(-1);
    expect(readCrossedAt).toBeLessThanOrEqual(3);
    expect(log.length).toBeGreaterThan(readCrossedAt + 1);
  });

  it("rejects an aborted read promptly while it is waiting on writes", async () => {
    const { bridge } = stallableBridge();
    const db = new NativeArmadaDB(bridge);
    const t = db.tenant("c2:x");

    void t.event(rumor({ id: "a" }));
    await macrotask(); // the crossing is now in flight and stalled

    const ctl = new AbortController();
    const read = t.query([{}], { signal: ctl.signal });
    ctl.abort(new Error("timeout"));

    // The bridge is never released: the read must settle on the abort alone.
    await expect(read).rejects.toThrow("timeout");
  });

  it("does not hold a read behind a write that arrives after it", async () => {
    // Only the FIRST crossing ever completes; every later one stalls forever.
    let releaseFirst: (() => void) | undefined;
    let crossings = 0;
    const bridge = {
      async event() {
        if (crossings++ === 0) await new Promise<void>((r) => (releaseFirst = r));
        else await new Promise<never>(() => {});
      },
      async query() {
        return { rumors: "[]" };
      },
    } as unknown as ConstructorParameters<typeof NativeArmadaDB>[0];
    const t = new NativeArmadaDB(bridge).tenant("c2:x");

    void t.event(rumor({ id: "a" }));
    await macrotask();
    const read = t.query([{}]);
    await macrotask();
    // Queued after the read: not something the read has to wait for, and its
    // crossing will never finish.
    void t.event(rumor({ id: "b" }));

    releaseFirst!();
    await expect(read).resolves.toEqual([]);
  });

  it("settles every kv op in a batch when one stored value no longer parses, and drains what queued behind it", async () => {
    // A row the native side hands back as non-JSON text must cost only ITS
    // get (a miss), not the rest of the batch — and the ops that arrived while
    // that crossing was in flight still cross on the next lap rather than
    // waiting for some unrelated caller to schedule a drain.
    const kvBatches: number[] = [];
    let release: (() => void) | undefined;
    const bridge = {
      async kvOps({ ops }: { ops: string }) {
        const batch = JSON.parse(ops) as Array<{ op: string; key: string }>;
        kvBatches.push(batch.length);
        if (kvBatches.length === 1) await new Promise<void>((r) => (release = r));
        const results = batch.map((op) => (op.op === "get" ? (op.key === "bad" ? "{not json" : '"ok"') : null));
        return { results: JSON.stringify(results) };
      },
    } as unknown as ConstructorParameters<typeof NativeArmadaDB>[0];
    const db = new NativeArmadaDB(bridge);

    const first = Promise.all([db.kv.get("bad"), db.kv.get("good")]);
    await macrotask(); // the first crossing is in flight and stalled
    const later = db.kv.get("good");
    await macrotask();

    release!();
    expect(await first).toEqual([undefined, "ok"]);
    expect(await later).toBe("ok");
    expect(kvBatches).toEqual([2, 1]);
  });
});
