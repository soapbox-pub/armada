/**
 * The {@link ArmadaDB} adapter for platforms whose SQLite store lives outside
 * the web layer — a transport only; planning, NIP-09 and supersession happen on
 * the other side:
 *  - Android: Capacitor plugin → Kotlin (`buzz.armada.app.db.SqliteArmadaDb`),
 *    the same file the notification service writes into.
 *  - iOS: Capacitor plugin → Swift (`ios/ArmadaDB`), file in the App Group container.
 *  - Desktop: Electron IPC → `SqliteArmadaDB` on `node:sqlite` (`ElectronArmadaDB.ts`).
 * One shared class so the batching/ordering is written once.
 *
 * Everything crosses as JSON text: Capacitor can't tell integer from float
 * `kind`, and one string is far cheaper than thousands of marshalled objects.
 * Writes are coalesced per tenant into one crossing and one transaction.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

import { perfCount, perfKvWrite, perfMark, perfTime } from "@/lib/perf";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type {
  ArmadaDB,
  ArmadaKV,
  ArmadaKVEntry,
  ArmadaKVListOptions,
  ArmadaKVSelector,
  NRumorStore,
} from "./types";

import { resolveKvRange, tenantClass } from "./types";
import { WrittenIds } from "./writtenIds";

/** The native surface, as `ArmadaDbPlugin.kt` exposes it. */
export interface ArmadaDBPlugin {
  /** Rumors matching any filter, newest-first, as a JSON array string. */
  query(options: { tenant: string; filters: string }): Promise<{ rumors: string }>;
  /** Store a JSON array of rumors in one transaction. */
  event(options: { tenant: string; rumors: string }): Promise<void>;
  count(options: { tenant: string; filters: string }): Promise<{ count: number; approximate: boolean }>;
  remove(options: { tenant: string; filters: string }): Promise<void>;
  /** Every tenant ever written to, as a JSON array string. */
  tenants(): Promise<{ tenants: string }>;
  /** The stored JSON text for a key; `value` is absent when unset. */
  kvGet(options: { key: string }): Promise<{ value?: string }>;
  kvSet(options: { key: string; value: string }): Promise<void>;
  kvDelete(options: { key: string }): Promise<void>;
  /**
   * Entries as a JSON array of `{ key, value }`, `value` being the stored JSON
   * TEXT (only this side parses, so number spelling can't change).
   */
  kvList(
    options: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean },
  ): Promise<{ entries: string }>;
  /**
   * A KV burst as ONE crossing: JSON array of `{ op, ... }` run in order in one
   * native transaction; `results` aligned with `ops` (text|null for get, null
   * for set/delete, `{ key, value }[]` for list).
   */
  kvOps(options: { ops: string }): Promise<{ results: string }>;
  /** Empty every table (logout purge). The file and its schema survive. */
  wipe(): Promise<void>;
  /** `ArmadaDB.forget`: `ids` is a JSON array string. */
  forget(options: { ids: string }): Promise<void>;
}

let bridge: ArmadaDBPlugin | undefined;

/** The plugin handle, registered lazily: `registerPlugin` throws on a second call (test module resets). */
function ArmadaDBBridge(): ArmadaDBPlugin {
  return (bridge ??= registerPlugin<ArmadaDBPlugin>("ArmadaDB"));
}

/** The platforms that ship a native ArmadaDB implementation. */
const NATIVE_DB_PLATFORMS = new Set(["android", "ios"]);

/**
 * Whether the native store is present. Gate on implementing platforms, never
 * `isNativePlatform()` (AGENTS.md); the plugin check covers build skew (falls
 * back to IndexedDB instead of rejecting every read).
 */
export function hasNativeArmadaDB(): boolean {
  return NATIVE_DB_PLATFORMS.has(Capacitor.getPlatform()) &&
    Capacitor.isPluginAvailable("ArmadaDB");
}

export class NativeArmadaDB implements ArmadaDB {
  private readonly stores = new Map<string, NativeRumorStore>();
  private readonly bridge: ArmadaDBPlugin;
  readonly kv: ArmadaKV;

  /**
   * @param bridge Transport to the native store; defaults to the Capacitor
   * plugin. Electron passes its IPC bridge (see `ElectronArmadaDB.ts`).
   */
  constructor(bridge?: ArmadaDBPlugin) {
    this.bridge = bridge ?? ArmadaDBBridge();
    this.kv = new NativeKV(this.bridge);
  }

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      perfMark("db.tenant open", id);
      store = new NativeRumorStore(id, this.bridge);
      this.stores.set(id, store);
    }
    return store;
  }

  /** Every tenant the native store has ever been written to. */
  async tenantIds(): Promise<string[]> {
    const { tenants } = await this.bridge.tenants();
    return JSON.parse(tenants) as string[];
  }

  /** A write still queued here crosses after this and is refused natively. */
  async forget(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await perfTime("db.forget", () => this.bridge.forget({ ids: JSON.stringify([...ids]) }));
  }

  /** Empty every table. Unlike the IndexedDB purge this keeps the connection. */
  async wipe(): Promise<void> {
    await this.bridge.wipe();
  }

  /** Nothing to close: the native store owns the connection, for the service too. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.toStringTag] = "NativeArmadaDB";
}

/** A rumor queued for the next batched write, with its caller's settlers. */
interface PendingWrite {
  rumor: NostrRumor;
  resolve(): void;
  reject(error: unknown): void;
}

class NativeRumorStore implements NRumorStore {
  private pending: PendingWrite[] = [];
  /**
   * A drain is in flight. Only ONE ever is: writes arriving meanwhile join
   * {@link pending} for its next lap. Per-write crossings would each take the
   * single plugin thread and native lock, starving reads during ingest storms.
   */
  private draining = false;
  /**
   * Settles once the NEWEST batch (queued, else in flight) has crossed; laps are
   * sequential, so every earlier write committed too. Deliberately not "drain
   * idle", which never happens under steady ingest.
   */
  private tail: Promise<void> = Promise.resolve();
  /** Settles {@link tail} for the batch currently queued; null when none is. */
  private settleQueued: (() => void) | null = null;

  /** Profiler label — the tenant's class, see {@link tenantClass}. */
  private readonly label: string;
  /** Ids already committed, so the relay cache's re-writes cost nothing. */
  private readonly written = new WrittenIds();

  constructor(private readonly id: string, private readonly bridge: ArmadaDBPlugin) {
    this.label = tenantClass(id);
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    // Read-your-writes: commit writes queued before this read.
    await this.settleWrites(opts?.signal);
    // Bridge calls serialize on the plugin thread and native lock (shared with
    // the service), so call count matters as much as total time.
    const { rumors } = await perfTime(`db.query ${this.label}`, () =>
      this.bridge.query({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
    opts?.signal?.throwIfAborted();
    return perfTime(
      `db.parse ${this.label}`,
      async () => JSON.parse(rumors) as NostrRumor[],
      (rows) => rows.length,
    );
  }

  event(event: NostrRumor): Promise<void> {
    // See `writtenIds.ts`: re-writes store nothing new, and skipping one saves a
    // bridge hop and a native lock turn.
    if (this.written.has(event.id)) {
      perfCount(`db.write ${this.label} (skipped)`, 0, 1, "events");
      return Promise.resolve();
    }
    // Strip `sig` to keep the bridge payload small.
    const { sig: _sig, ...rumor } = event as NostrRumor & { sig?: string };

    return new Promise<void>((resolve, reject) => {
      this.pending.push({ rumor, resolve, reject });
      // First write into an empty queue opens a new batch for readers to wait on.
      if (this.settleQueued === null) {
        this.tail = new Promise<void>((settle) => (this.settleQueued = settle));
      }
      this.scheduleFlush();
    });
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    await this.settleWrites(opts?.signal);
    const result = await perfTime(`db.count ${this.label}`, () =>
      this.bridge.count({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
    return { count: result.count, approximate: result.approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    // Commit queued writes first so the remove is ordered after them.
    await this.settleWrites(opts?.signal);
    // A removed event must be storable again.
    this.written.forget();
    await perfTime(`db.remove ${this.label}`, () =>
      this.bridge.remove({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
  }

  private scheduleFlush(): void {
    // A running drain picks `pending` up on its next lap.
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  /**
   * Wait until writes queued before this call have crossed (at most in-flight
   * plus queued). Honours `signal` so abandoned reads don't wait on the stream.
   */
  private settleWrites(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.draining) return Promise.resolve();
    if (!signal) return this.tail;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.tail.then(() => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      });
    });
  }

  /** Drain {@link pending}, one crossing (one transaction) per lap, until empty. */
  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const writes = this.pending;
        const settle = this.settleQueued;
        this.pending = [];
        this.settleQueued = null;

        try {
          await perfTime(
            `db.write ${this.label}`,
            () =>
              this.bridge.event({
                tenant: this.id,
                rumors: JSON.stringify(writes.map((write) => write.rumor)),
              }),
            () => writes.length,
          );
        } catch (error) {
          for (const write of writes) write.reject(error);
          // Release waiting readers either way.
          settle?.();
          continue;
        }

        // Settled after the native commit, so resolved means durable.
        for (const write of writes) {
          this.written.add(write.rumor.id);
          write.resolve();
        }
        settle?.();
      }
    } finally {
      // If a lap escaped with a throw, reschedule anything queued meanwhile.
      this.draining = false;
      if (this.pending.length > 0) this.scheduleFlush();
    }
  }

  [Symbol.toStringTag] = "NativeRumorStore";
}

type PendingKvOp =
  | { op: "get"; key: string; resolve: (value: unknown) => void }
  | { op: "set"; key: string; value: string; resolve: () => void; reject: (error: unknown) => void }
  | { op: "delete"; key: string; resolve: () => void; reject: (error: unknown) => void }
  | {
    op: "list";
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
    reverse?: boolean;
    resolve: (entries: ArmadaKVEntry<unknown>[]) => void;
  };

/** A stored value that no longer parses is a miss, so one corrupt row can't fail its batch. */
function parseStored(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * KV carried as JSON text, coalesced into ONE ordered `kvOps` crossing per
 * burst: per-op calls would each pay a plugin-thread hop and native lock turn, and
 * Capacitor doesn't guarantee call order across its thread pool.
 */
class NativeKV implements ArmadaKV {
  private pendingOps: PendingKvOp[] = [];
  /** A drain is in flight; see {@link NativeRumorStore}. Gets/lists share the ordered queue. */
  private draining = false;

  constructor(private readonly bridge: ArmadaDBPlugin) {}

  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  /** Drain {@link pendingOps} to the bridge, one crossing per lap, until empty. */
  private async drain(): Promise<void> {
    try {
      while (this.pendingOps.length > 0) {
        const ops = this.pendingOps;
        this.pendingOps = [];
        await this.crossing(ops);
      }
    } finally {
      // As in `NativeRumorStore.drain`.
      this.draining = false;
      if (this.pendingOps.length > 0) this.schedule();
    }
  }

  /** One `kvOps` crossing for a burst, settling each op against its result. */
  private async crossing(ops: PendingKvOp[]): Promise<void> {
    let results: Array<string | null | Array<{ key: string; value: string }>>;
    // A key read more than once in a burst crosses once: boot mounts dozens of
    // readers of the same fold at once, and each copy is re-serialized on the
    // way back (measured: one 107 KB fold sent 28 times in a single crossing).
    // A write to the key ends the sharing, so later reads still see it.
    const wire: object[] = [];
    const slot: number[] = [];
    const readAt = new Map<string, number>();
    for (const op of ops) {
      if (op.op === "get") {
        const shared = readAt.get(op.key);
        if (shared !== undefined) {
          slot.push(shared);
          continue;
        }
        readAt.set(op.key, wire.length);
        slot.push(wire.length);
        wire.push({ op: op.op, key: op.key });
        continue;
      }
      slot.push(wire.length);
      if (op.op === "delete") {
        readAt.delete(op.key);
        wire.push({ op: op.op, key: op.key });
      } else if (op.op === "set") {
        readAt.delete(op.key);
        wire.push({ op: op.op, key: op.key, value: op.value });
      } else {
        const { resolve: _resolve, ...listOp } = op;
        wire.push(listOp);
      }
    }
    try {
      const response = await perfTime(
        "kv.ops",
        () => this.bridge.kvOps({ ops: JSON.stringify(wire) }),
        () => wire.length,
        "ops",
      );
      results = JSON.parse(response.results) as typeof results;
    } catch (error) {
      // Failed reads are misses; failed writes reject.
      for (const op of ops) {
        if (op.op === "get") op.resolve(undefined);
        else if (op.op === "list") op.resolve([]);
        else op.reject(error);
      }
      return;
    }

    for (const [i, op] of ops.entries()) {
      if (op.op === "get") {
        const value = results[slot[i]!];
        op.resolve(typeof value === "string" ? parseStored(value) : undefined);
      } else if (op.op === "list") {
        const result = results[slot[i]!];
        const entries = Array.isArray(result) ? (result as Array<{ key: string; value: string }>) : [];
        op.resolve(entries.map(({ key, value }) => ({ key, value: parseStored(value) })));
      } else {
        op.resolve();
      }
    }
  }

  get<T>(key: string): Promise<T | undefined> {
    return perfTime("kv.get", () =>
      new Promise<T | undefined>((resolve) => {
        this.pendingOps.push({ op: "get", key, resolve: resolve as (value: unknown) => void });
        this.schedule();
      }));
  }

  set<T>(key: string, value: T): Promise<void> {
    if (import.meta.env.VITE_PROFILE === "1") perfKvWrite(key, value);
    return perfTime("kv.set", () =>
      new Promise<void>((resolve, reject) => {
        // Values without a JSON form are normalized to null, like the other adapters.
        this.pendingOps.push({ op: "set", key, value: JSON.stringify(value) ?? "null", resolve, reject });
        this.schedule();
      }));
  }

  delete(key: string): Promise<void> {
    return perfTime("kv.delete", () =>
      new Promise<void>((resolve, reject) => {
        this.pendingOps.push({ op: "delete", key, resolve, reject });
        this.schedule();
      }));
  }

  async list<T>(
    selector: ArmadaKVSelector = {},
    opts: ArmadaKVListOptions = {},
  ): Promise<ArmadaKVEntry<T>[]> {
    // Resolved natively (Kotlin `KvRange`); resolved here only so an invalid
    // selector throws the same TypeError on every platform.
    if (resolveKvRange(selector).empty) return [];

    return perfTime(
      "kv.list",
      () =>
        new Promise<ArmadaKVEntry<T>[]>((resolve) => {
          this.pendingOps.push({
            op: "list",
            ...selector,
            ...opts,
            resolve: resolve as (entries: ArmadaKVEntry<unknown>[]) => void,
          });
          this.schedule();
        }),
      (entries) => entries.length,
      "entries",
    );
  }
}
