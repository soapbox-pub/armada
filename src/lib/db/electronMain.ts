/**
 * The ArmadaDB server in the Electron shell's MAIN process: {@link SqliteArmadaDB}
 * (the engine the conformance suite runs) over one file, dispatching
 * `ArmadaDbPlugin`'s surface method for method with JSON-text payloads so the
 * renderer reuses `NativeArmadaDB` unchanged.
 *
 * Must stay free of Electron imports: `main.js` owns the IPC channel and passes
 * the file path in.
 */
import { SqliteArmadaDB } from "./SqliteArmadaDB";
import { tenantOptsFor } from "./termPolicies";
import { NodeSqlDriver } from "./nodeSqlDriver";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaKVEntry, ArmadaKVListOptions, ArmadaKVSelector } from "./types";

/** One entry as it crosses the bridge: the value is stored JSON TEXT. */
interface WireKvEntry {
  key: string;
  value: string;
}

type WireKvOp =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string }
  | ({ op: "list" } & ArmadaKVSelector & ArmadaKVListOptions);

/** What one `kvOps` entry answers with, aligned by position with the request. */
type WireKvResult = string | null | WireKvEntry[];

export interface ArmadaDbServer {
  /**
   * Run one `ArmadaDbPlugin` method by name with its options object.
   * @throws if `op` is unknown or the operation fails.
   */
  call(op: string, payload?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Open (or create) the ArmadaDB file and return its dispatch table; ops await schema install. */
export function openArmadaDbServer(file: string): ArmadaDbServer {
  const driver = new NodeSqlDriver(file);
  const db = new SqliteArmadaDB(driver);

  /**
   * A tenant's store with its derived-term policy, looked up here from
   * `termPolicies.ts` because functions can't cross IPC (as on Android/iOS).
   */
  function storeFor(id: string) {
    return db.tenant(id, tenantOptsFor(id));
  }

  /** Every tenant the file has held, from the SQLite `tenants` interning table. */
  async function tenantIds(): Promise<string[]> {
    await db.ready;
    const rows = await driver.all(`SELECT id FROM tenants ORDER BY id`);
    return rows.map((row) => String(row.id));
  }

  /**
   * Re-serialize a KV value to JSON text (lossless: it came from
   * `JSON.stringify`). `undefined` is reported as a miss.
   */
  function toWire(value: unknown): string | null {
    const text = JSON.stringify(value);
    return text === undefined ? null : text;
  }

  async function kvList(selector: ArmadaKVSelector, opts: ArmadaKVListOptions): Promise<WireKvEntry[]> {
    const entries = await db.kv.list<unknown>(selector, opts);
    return entries.map(({ key, value }: ArmadaKVEntry<unknown>) => ({
      key,
      value: toWire(value) ?? "null",
    }));
  }

  /**
   * Run a burst of KV ops sequentially, for read-your-writes within a coalesced
   * burst. Not one transaction (unlike Kotlin): a crash can apply a prefix, which
   * is fine since every KV key is independently meaningful.
   */
  async function kvOps(ops: WireKvOp[]): Promise<WireKvResult[]> {
    const results: WireKvResult[] = [];
    for (const op of ops) {
      if (op.op === "get") {
        const value = await db.kv.get<unknown>(op.key);
        results.push(value === undefined ? null : toWire(value));
      } else if (op.op === "set") {
        await db.kv.set(op.key, JSON.parse(op.value) as unknown);
        results.push(null);
      } else if (op.op === "delete") {
        await db.kv.delete(op.key);
        results.push(null);
      } else {
        const { op: _op, limit, reverse, ...selector } = op;
        results.push(await kvList(selector, { limit, reverse }));
      }
    }
    return results;
  }

  const handlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
    async query({ tenant, filters }) {
      const rumors = await storeFor(String(tenant)).query(
        JSON.parse(String(filters)) as NostrFilter[],
      );
      return { rumors: JSON.stringify(rumors) };
    },

    async event({ tenant, rumors }) {
      const store = storeFor(String(tenant));
      const batch = JSON.parse(String(rumors)) as NostrRumor[];
      // No awaits in between, so the batch lands in one store transaction.
      await Promise.all(batch.map((rumor) => store.event(rumor)));
    },

    async count({ tenant, filters }) {
      return await storeFor(String(tenant)).count(JSON.parse(String(filters)) as NostrFilter[]);
    },

    async remove({ tenant, filters }) {
      await storeFor(String(tenant)).remove(JSON.parse(String(filters)) as NostrFilter[]);
    },

    async tenants() {
      return { tenants: JSON.stringify(await tenantIds()) };
    },

    async kvGet({ key }) {
      const value = await db.kv.get<unknown>(String(key));
      // Absent (not null) when unset: null is a legitimate stored value.
      if (value === undefined) return {};
      const text = toWire(value);
      return text === null ? {} : { value: text };
    },

    async kvSet({ key, value }) {
      await db.kv.set(String(key), JSON.parse(String(value)) as unknown);
    },

    async kvDelete({ key }) {
      await db.kv.delete(String(key));
    },

    async kvList({ prefix, start, end, limit, reverse }) {
      const selector: ArmadaKVSelector = {};
      if (typeof prefix === "string") selector.prefix = prefix;
      if (typeof start === "string") selector.start = start;
      if (typeof end === "string") selector.end = end;

      const opts: ArmadaKVListOptions = {};
      if (typeof limit === "number") opts.limit = limit;
      if (typeof reverse === "boolean") opts.reverse = reverse;

      return { entries: JSON.stringify(await kvList(selector, opts)) };
    },

    async kvOps({ ops }) {
      return { results: JSON.stringify(await kvOps(JSON.parse(String(ops)) as WireKvOp[])) };
    },

    async wipe() {
      await db.wipe();
    },

    async forget({ ids }) {
      await db.forget(JSON.parse(String(ids)) as string[]);
    },
  };

  return {
    async call(op: string, payload: Record<string, unknown> = {}) {
      const handler = handlers[op];
      if (!handler) throw new Error(`Unknown ArmadaDB operation: ${op}`);
      const result = await handler(payload);
      // `undefined` can't be carried back over IPC.
      return result ?? null;
    },

    async close() {
      await db.close();
    },
  };
}
