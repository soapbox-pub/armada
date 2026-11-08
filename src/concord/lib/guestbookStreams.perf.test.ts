// @vitest-environment node
/**
 * Where each Guestbook rumor arrived (its stream address), kept three ways, measured
 * over the stack Android and the desktop run: `NativeArmadaDB`'s KV adapter, which
 * batches a burst into one `kvOps` crossing, over the desktop's real SQLite file
 * (`openArmadaDbServer`). What the Android bridge pays is crossings and bytes, which are
 * re-serialized per byte, so both are counted at the plugin seam beside wall-clock.
 *
 *   A  today (`noteGuestbookStreams`): one id array per address, read, merged and
 *      written back whole; one read per held epoch on load.
 *   B  A with each key's writes chained, and pruned on forget: today's layout, fixed.
 *   C  one key per rumor naming its address: a write never reads, a forget deletes
 *      by id, a load is one prefix list.
 *   C1 C, the value the epoch number rather than the 64-hex address.
 *   D  append-only chunks: each write adds one key holding its batch's ids, so a write
 *      never reads and two never collide; a load lists the chunks and folds many small
 *      ones into one, and a forget rewrites only the chunks naming a forgotten id.
 *   +memo  the loaded map held in memory per community, kept current by every write and
 *      forget through it: a reload costs nothing while the page lives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isPluginAvailable: () => true, isNativePlatform: () => true },
  registerPlugin: () => undefined,
}));

const { openArmadaDbServer } = await import("@/lib/db/electronMain");
const { NativeArmadaDB } = await import("@/lib/db/NativeArmadaDB");
type ArmadaKV = import("@/lib/db/types").ArmadaKV;
type Plugin = import("@/lib/db/NativeArmadaDB").ArmadaDBPlugin;

const CID = "c0".repeat(32);
const hex = (n: number, salt: string) => (salt + n.toString(16)).padStart(64, "0").slice(-64);

interface Ledger {
  note(kv: ArmadaKV, batch: Array<{ streamPk: string; rumorId: string }>): Promise<void>;
  /** `epochs` is the held addresses, index = epoch, as `community.heldRoots` gives them. */
  load(kv: ArmadaKV, epochs: string[]): Promise<Map<string, string>>;
  forget(kv: ArmadaKV, ids: string[]): Promise<void>;
}

const arrayKey = (pk: string) => `c2gbpk:${CID}:${pk}`;

/** A: today's code, verbatim but for the KV handed in. */
const A: Ledger = {
  async note(kv, opened) {
    const byPk = new Map<string, string[]>();
    for (const o of opened) {
      const list = byPk.get(o.streamPk);
      if (list) list.push(o.rumorId);
      else byPk.set(o.streamPk, [o.rumorId]);
    }
    await Promise.all([...byPk].map(async ([pk, ids]) => {
      const key = arrayKey(pk);
      const merged = new Set((await kv.get<string[]>(key)) ?? []);
      const before = merged.size;
      for (const id of ids) merged.add(id);
      if (merged.size !== before) await kv.set(key, [...merged]);
    }));
  },
  async load(kv, epochs) {
    const seen = new Map<string, string>();
    for (const pk of epochs) for (const id of (await kv.get<string[]>(arrayKey(pk))) ?? []) if (!seen.has(id)) seen.set(id, pk);
    return seen;
  },
  async forget() {},
};

/** B: A's layout with each key's read-merge-write chained, and pruned on forget. */
const chains = new Map<string, Promise<unknown>>();
const chained = <T,>(key: string, run: () => Promise<T>): Promise<T> => {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  chains.set(key, next);
  return next;
};
const B: Ledger = {
  async note(kv, opened) {
    const byPk = new Map<string, string[]>();
    for (const o of opened) byPk.set(o.streamPk, [...(byPk.get(o.streamPk) ?? []), o.rumorId]);
    await Promise.all([...byPk].map(([pk, ids]) => chained(arrayKey(pk), async () => {
      const merged = new Set((await kv.get<string[]>(arrayKey(pk))) ?? []);
      const before = merged.size;
      for (const id of ids) merged.add(id);
      if (merged.size !== before) await kv.set(arrayKey(pk), [...merged]);
    })));
  },
  load: A.load,
  async forget(kv, ids) {
    const gone = new Set(ids);
    for (const { key } of await kv.list<string[]>({ prefix: `c2gbpk:${CID}:` })) {
      await chained(key, async () => {
        const held = (await kv.get<string[]>(key)) ?? [];
        const kept = held.filter((id) => !gone.has(id));
        if (kept.length !== held.length) await (kept.length > 0 ? kv.set(key, kept) : kv.delete(key));
      });
    }
  },
};

/** C: one key per rumor, its value the address. */
const rowKey = (id: string) => `c2gbaddr:${CID}:${id}`;
const C: Ledger = {
  async note(kv, opened) {
    await Promise.all(opened.map((o) => kv.set(rowKey(o.rumorId), o.streamPk)));
  },
  async load(kv) {
    const prefix = `c2gbaddr:${CID}:`;
    return new Map((await kv.list<string>({ prefix })).map(({ key, value }) => [key.slice(prefix.length), value]));
  },
  async forget(kv, ids) {
    await Promise.all(ids.map((id) => kv.delete(rowKey(id))));
  },
};

/** C1: one key per rumor, its value the epoch number. */
const epochKey = (id: string) => `c2gbep:${CID}:${id}`;
const C1: Ledger = {
  async note(kv, opened) {
    await Promise.all(opened.map((o) => kv.set(epochKey(o.rumorId), EPOCHS.indexOf(o.streamPk))));
  },
  async load(kv, epochs) {
    const prefix = `c2gbep:${CID}:`;
    const out = new Map<string, string>();
    for (const { key, value } of await kv.list<number>({ prefix })) {
      const pk = epochs[value];
      if (pk) out.set(key.slice(prefix.length), pk);
    }
    return out;
  },
  async forget(kv, ids) {
    await Promise.all(ids.map((id) => kv.delete(epochKey(id))));
  },
};

/** D: append-only chunks of `[epoch, ...ids]`, folded together on load past {@link FOLD_AT}. */
const chunkPrefix = `c2gbch:${CID}:`;
let chunkSeq = 0;
const newChunkKey = () => `${chunkPrefix}${Date.now().toString(36)}-${(chunkSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const FOLD_AT = 16;
const D: Ledger = {
  async note(kv, opened) {
    const byEpoch = new Map<number, string[]>();
    for (const o of opened) {
      const e = EPOCHS.indexOf(o.streamPk);
      byEpoch.set(e, [...(byEpoch.get(e) ?? []), o.rumorId]);
    }
    await Promise.all([...byEpoch].map(([e, ids]) => kv.set(newChunkKey(), [e, ...ids])));
  },
  async load(kv, epochs) {
    const chunks = await kv.list<[number, ...string[]]>({ prefix: chunkPrefix });
    const out = new Map<string, string>();
    for (const { value: [e, ...ids] } of chunks) for (const id of ids) if (epochs[e]) out.set(id, epochs[e]);
    // Many small chunks fold into one per epoch; an append racing this lands in a key of its own.
    if (chunks.length > FOLD_AT) {
      const byEpoch = new Map<number, string[]>();
      for (const { value: [e, ...ids] } of chunks) byEpoch.set(e, [...(byEpoch.get(e) ?? []), ...ids]);
      await Promise.all([...byEpoch].map(([e, ids]) => kv.set(newChunkKey(), [e, ...ids])));
      await Promise.all(chunks.map(({ key }) => kv.delete(key)));
    }
    return out;
  },
  async forget(kv, ids) {
    const gone = new Set(ids);
    const chunks = await kv.list<[number, ...string[]]>({ prefix: chunkPrefix });
    await Promise.all(chunks.map(async ({ key, value: [e, ...held] }) => {
      const kept = held.filter((id) => !gone.has(id));
      if (kept.length === held.length) return;
      if (kept.length > 0) await kv.set(newChunkKey(), [e, ...kept]);
      await kv.delete(key);
    }));
  },
};

/** `inner` with its loaded map held in memory and kept current by every write and forget. */
function memo(inner: Ledger): Ledger {
  let held: Map<string, string> | undefined;
  return {
    async note(kv, opened) {
      await inner.note(kv, opened);
      if (held) for (const o of opened) held.set(o.rumorId, o.streamPk);
    },
    async load(kv, epochs) {
      return (held ??= await inner.load(kv, epochs));
    },
    async forget(kv, ids) {
      await inner.forget(kv, ids);
      if (held) for (const id of ids) held.delete(id);
    },
  };
}

/** A fresh SQLite file behind the native adapter, its seam counted. */
function stack() {
  const dir = mkdtempSync(join(tmpdir(), "armada-gb-"));
  const server = openArmadaDbServer(join(dir, "armada.db"));
  const counts = { crossings: 0, bytes: 0 };
  const plugin = new Proxy({}, {
    get: (_t, op: string) => async (payload?: Record<string, unknown>) => {
      const result = await server.call(op, payload);
      counts.crossings++;
      counts.bytes += JSON.stringify(payload ?? {}).length + JSON.stringify(result ?? null).length;
      return result;
    },
  }) as Plugin;
  const db = new NativeArmadaDB(plugin);
  return {
    kv: db.kv,
    counts,
    reset: () => Object.assign(counts, { crossings: 0, bytes: 0 }),
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const EPOCHS = ["e1", "e2", "e3"].map((s) => hex(0, s));
/** A community's history: 6,000 Guestbook rumors over three epochs, read in pages of 200. */
const HISTORY = Array.from({ length: 6_000 }, (_, i) => ({ streamPk: EPOCHS[Math.min(2, Math.floor(i / 2_000))], rumorId: hex(i, "h") }));

type Row = { design: string; phase: string; crossings: number; kb: number; ms: number };
const report: Row[] = [];

async function measure(design: string, phase: string, s: ReturnType<typeof stack>, run: () => Promise<void>) {
  s.reset();
  const start = performance.now();
  await run();
  report.push({ design, phase, crossings: s.counts.crossings, kb: Math.round(s.counts.bytes / 1024), ms: Math.round(performance.now() - start) });
}

afterAll(() => {
  for (const r of report) console.log(`BENCH | ${r.design.padEnd(12)} | ${r.phase.padEnd(34)} | ${String(r.crossings).padStart(5)} crossings | ${String(r.kb).padStart(7)} KB | ${String(r.ms).padStart(6)} ms`);
});

const DESIGNS: Array<[string, () => Ledger]> = [
  ["A today", () => A],
  ["B chained", () => B],
  ["C per rumor", () => C],
  ["C1 epoch", () => C1],
  ["D chunks", () => D],
  ["C1+memo", () => memo(C1)],
  ["D+memo", () => memo(D)],
];

describe.each(DESIGNS)("%s", (design, make) => {
  it("sweeps a history, takes live arrivals, loads, forgets, and loses nothing", async () => {
    const ledger = make();
    const s = stack();
    try {
      await measure(design, "sweep 6000 (pages of 200)", s, async () => {
        for (let i = 0; i < HISTORY.length; i += 200) await ledger.note(s.kv, HISTORY.slice(i, i + 200));
      });
      // Live: one rumor at a time at the live address, as ingest delivers them.
      const live = Array.from({ length: 200 }, (_, i) => ({ streamPk: EPOCHS[2], rumorId: hex(i, "l") }));
      await measure(design, "200 live arrivals, one each", s, async () => {
        for (const o of live) await ledger.note(s.kv, [o]);
      });
      // Two relays answering at once.
      const racing = Array.from({ length: 40 }, (_, i) => ({ streamPk: EPOCHS[2], rumorId: hex(i, "r") }));
      await measure(design, "40 batches of 1 at once", s, async () => {
        await Promise.all(racing.map((o) => ledger.note(s.kv, [o])));
      });
      let loaded = new Map<string, string>();
      await measure(design, "load (3 epochs)", s, async () => {
        loaded = await ledger.load(s.kv, EPOCHS);
      });
      await measure(design, "load again", s, async () => {
        loaded = await ledger.load(s.kv, EPOCHS);
      });
      // Each Guestbook event: stored, then the plane read again (`c2gb` wire scope).
      const cycle = Array.from({ length: 50 }, (_, i) => ({ streamPk: EPOCHS[2], rumorId: hex(i, "y") }));
      await measure(design, "50 x (one arrival, then load)", s, async () => {
        for (const o of cycle) {
          await ledger.note(s.kv, [o]);
          loaded = await ledger.load(s.kv, EPOCHS);
        }
      });
      // A copy: a memo hands out the map it keeps current, which the forget below edits.
      const before = new Map(loaded);
      const forgotten = HISTORY.slice(0, 100).map((o) => o.rumorId);
      await measure(design, "forget 100", s, async () => {
        await ledger.forget(s.kv, forgotten);
      });
      const after = await ledger.load(s.kv, EPOCHS);

      const lost = [...HISTORY, ...live, ...racing, ...cycle].filter((o) => before.get(o.rumorId) !== o.streamPk).length;
      const lingering = forgotten.filter((id) => after.has(id)).length;
      report.push({ design, phase: `lost ${lost}, lingering after forget ${lingering}`, crossings: 0, kb: 0, ms: 0 });
      if (design !== "A today") {
        expect(lost).toBe(0);
        expect(lingering).toBe(0);
      }
    } finally {
      await s.close();
    }
  }, 600_000);
});
