// @vitest-environment node
/**
 * The sync scheduler's contract: a want runs a topic's handler single-flight,
 * a fresh durable stamp answers a want without a run (and survives a reload),
 * lanes bound concurrency, and a released or failing topic doesn't spin.
 */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SyncCtx } from "./syncManager";

type SyncModule = typeof import("./syncManager");

/** A fresh module graph, so the scheduler and the KV singleton are new. */
async function freshModule(): Promise<SyncModule> {
  vi.resetModules();
  return await import("./syncManager");
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("syncManager", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("runs the handler on first want, stamps the topic, and settles", async () => {
    const m = await freshModule();
    const seen: string[] = [];
    const handler = vi.fn(async ({ topic }: SyncCtx) => {
      seen.push(topic);
    });
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const release = m.want("t:a");
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("settled"));

    expect(seen).toEqual(["t:a"]);
    expect(m.syncState("t:a").lastSyncedAt).toBeTypeOf("number");
    release();
  });

  it("answers a re-want from the fresh stamp without a second run", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const r1 = m.want("t:a");
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("settled"));
    r1();

    const r2 = m.want("t:a");
    await sleep(20);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(m.syncState("t:a").status).toBe("settled");
    r2();
  });

  it("freshness survives a reload via the durable stamp", async () => {
    const first = await freshModule();
    const h1 = vi.fn(async () => {});
    first.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler: h1 });
    const r1 = first.want("t:a");
    await vi.waitFor(() => expect(first.syncState("t:a").status).toBe("settled"));
    r1();
    // Give the fire-and-forget stamp write a turn to land in KV.
    await sleep(20);

    const second = await freshModule();
    const h2 = vi.fn(async () => {});
    second.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler: h2 });
    const r2 = second.want("t:a");
    await vi.waitFor(() => expect(second.syncState("t:a").status).toBe("settled"));

    expect(h2).not.toHaveBeenCalled();
    expect(second.syncState("t:a").lastSyncedAt).toBeTypeOf("number");
    r2();
  });

  it("single-flights concurrent wants for one topic", async () => {
    const m = await freshModule();
    const gate = deferred();
    const handler = vi.fn(() => gate.promise);
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const r1 = m.want("t:a");
    const r2 = m.want("t:a", "background");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await sleep(20);
    expect(handler).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("settled"));
    r1();
    r2();
  });

  it("runs one background/prefetch topic at a time", async () => {
    const m = await freshModule();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const handler = vi.fn(({ topic }: SyncCtx) => {
      const d = deferred();
      gates.set(topic, d);
      return d.promise;
    });
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const ra = m.want("t:a", "background");
    const rb = m.want("t:b", "prefetch");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await sleep(20);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(m.syncState("t:b").status).toBe("pending"); // queued, not dropped

    gates.get("t:a")!.resolve();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    gates.get("t:b")!.resolve();
    await vi.waitFor(() => expect(m.syncState("t:b").status).toBe("settled"));
    ra();
    rb();
  });

  it("caps visible topics at three concurrent runs", async () => {
    const m = await freshModule();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const handler = vi.fn(({ topic }: SyncCtx) => {
      const d = deferred();
      gates.set(topic, d);
      return d.promise;
    });
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const releases = ["t:a", "t:b", "t:c", "t:d"].map((t) => m.want(t));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    await sleep(20);
    expect(handler).toHaveBeenCalledTimes(3);

    gates.get("t:a")!.resolve();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(4));
    for (const gate of gates.values()) gate.resolve();
    for (const release of releases) release();
  });

  it("aborts the run when the last want releases, without marking an error", async () => {
    const m = await freshModule();
    let signal: AbortSignal | undefined;
    const handler = vi.fn(
      (ctx: SyncCtx) =>
        new Promise<void>((_, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const release = m.want("t:a");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    release();

    expect(signal?.aborted).toBe(true);
    // Never stamped, so the topic returns to idle — not error, not settled.
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("idle"));
    expect(m.syncState("t:a").lastSyncedAt).toBeUndefined();
  });

  it("halting aborts in-flight runs and starts no more", async () => {
    const m = await freshModule();
    let signal: AbortSignal | undefined;
    const handler = vi.fn(
      (ctx: SyncCtx) =>
        new Promise<void>((resolve) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => resolve());
        }),
    );
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const release = m.want("t:a");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    m.haltSyncManager();
    expect(signal?.aborted).toBe(true);
    expect(m.syncHalted()).toBe(true);

    const releaseB = m.want("t:b", "visible", { force: true });
    await sleep(100);
    expect(handler).toHaveBeenCalledTimes(1);
    release();
    releaseB();
  });

  it("marks a failed run error and backs off instead of spinning", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {
      throw new Error("relay down");
    });
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 0, handler });

    const release = m.want("t:a");
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("error"));
    const calls = handler.mock.calls.length;
    await sleep(100);
    expect(handler.mock.calls.length).toBe(calls); // backoff floor (≥1s) holds
    release();
  });

  it("re-runs a standing want when the stamp goes stale", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 30, handler });

    const release = m.want("t:a");
    await vi.waitFor(() => expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    release();
  });

  it("a want for an unregistered topic sits idle until registration picks it up", async () => {
    const m = await freshModule();
    const release = m.want("x:unknown");
    await sleep(20);
    expect(m.syncState("x:unknown").status).toBe("idle");

    const handler = vi.fn(async () => {});
    m.registerSyncTopic("x:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });
    await vi.waitFor(() => expect(m.syncState("x:unknown").status).toBe("settled"));
    expect(handler).toHaveBeenCalledTimes(1);
    release();
  });

  it("publishes pending synchronously on a want for a registered topic", async () => {
    const m = await freshModule();
    const gate = deferred();
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler: () => gate.promise });

    // Before the stamp warm, before any run: the reader's coverage guarantee
    // (an empty store read renders as catching-up, not as an empty verdict).
    const release = m.want("t:a");
    expect(m.syncState("t:a").status).toBe("pending");

    gate.resolve();
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("settled"));
    release();
  });

  it("resolves the optimistic pending when the last want releases without a run", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    // Want and release synchronously, before the stamp warm lets anything
    // run: the optimistic pending must resolve (to idle — never synced), not
    // stick forever for read-only observers of the topic.
    const release = m.want("t:a");
    expect(m.syncState("t:a").status).toBe("pending");
    release();
    expect(m.syncState("t:a").status).toBe("idle");

    await sleep(20);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invalidateSyncTopic re-runs a fresh topic with a standing want", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const release = m.want("t:a");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    m.invalidateSyncTopic("t:a");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    release();
  });

  it("a forced want re-runs a fresh topic", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const r1 = m.want("t:a");
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("settled"));
    r1();

    const r2 = m.want("t:a", "visible", { force: true });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    r2();
  });

  it("notifies state subscribers as a run progresses", async () => {
    const m = await freshModule();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const statuses: string[] = [];
    const unsubscribe = m.onSyncState("t:a", () => {
      statuses.push(m.syncState("t:a").status);
    });
    const release = m.want("t:a");
    await vi.waitFor(() => expect(m.syncState("t:a").status).toBe("settled"));

    expect(statuses).toContain("pending");
    expect(statuses).toContain("settled");
    unsubscribe();
    release();
  });

  it("going quiet aborts an in-flight run without stamping it, and resuming re-runs it", async () => {
    let quiet = false;
    const quietListeners = new Set<() => void>();
    vi.doMock("@/lib/backgroundQuiet", () => ({
      isBackgroundQuiet: () => quiet,
      onBackgroundQuiet: (listener: () => void) => {
        quietListeners.add(listener);
        return () => quietListeners.delete(listener);
      },
    }));
    const setQuiet = (next: boolean) => {
      quiet = next;
      for (const listener of quietListeners) listener();
    };
    try {
      const m = await freshModule();
      const signals: AbortSignal[] = [];
      const handler = vi.fn(({ signal }: SyncCtx) => {
        signals.push(signal);
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      });
      m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60 * 60_000, handler });

      const release = m.want("t:a", "background");
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      setQuiet(true);
      expect(signals[0]!.aborted).toBe(true);
      await sleep(20);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(m.syncState("t:a").lastSyncedAt).toBeUndefined();

      setQuiet(false);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      release();
    } finally {
      vi.doUnmock("@/lib/backgroundQuiet");
    }
  });

  it("holds an unmetered-only topic on a metered connection and aborts it when one starts", async () => {
    let metered = false;
    const networkListeners = new Set<() => void>();
    vi.doMock("@/lib/meteredNetwork", () => ({
      isMeteredNetwork: () => metered,
      onMeteredNetworkChange: (listener: () => void) => {
        networkListeners.add(listener);
        return () => networkListeners.delete(listener);
      },
    }));
    const setMetered = (next: boolean) => {
      metered = next;
      for (const listener of networkListeners) listener();
    };
    try {
      const m = await freshModule();
      const signals: AbortSignal[] = [];
      const bulk = vi.fn(({ signal }: SyncCtx) => {
        signals.push(signal);
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      });
      const live = vi.fn(async () => {});
      m.registerSyncTopic("bulk:", { minIntervalMs: 0, staleAfterMs: 60 * 60_000, handler: bulk, unmeteredOnly: true });
      m.registerSyncTopic("live:", { minIntervalMs: 0, staleAfterMs: 60 * 60_000, handler: live });

      const releaseBulk = m.want("bulk:a", "prefetch");
      await vi.waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));

      setMetered(true);
      expect(signals[0]!.aborted).toBe(true);
      const releaseLive = m.want("live:a");
      await vi.waitFor(() => expect(live).toHaveBeenCalledTimes(1));
      await sleep(20);
      expect(bulk).toHaveBeenCalledTimes(1);

      setMetered(false);
      await vi.waitFor(() => expect(bulk).toHaveBeenCalledTimes(2));
      releaseBulk();
      releaseLive();
    } finally {
      vi.doUnmock("@/lib/meteredNetwork");
    }
  });

  it("rests a duty-cycled prefix in proportion to its runs, across its topics, without holding other topics", async () => {
    const m = await freshModule();
    const spans: Array<{ topic: string; start: number; end: number }> = [];
    const bulk = vi.fn(async ({ topic }: SyncCtx) => {
      const start = Date.now();
      await sleep(200);
      spans.push({ topic, start, end: Date.now() });
    });
    const other = vi.fn(async () => {});
    m.registerSyncTopic("bulk:", { minIntervalMs: 0, staleAfterMs: 60 * 60_000, handler: bulk, dutyCycle: 0.5 });
    m.registerSyncTopic("other:", { minIntervalMs: 0, staleAfterMs: 60 * 60_000, handler: other });

    const ra = m.want("bulk:a", "prefetch");
    const rb = m.want("bulk:b", "prefetch");
    await vi.waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(spans).toHaveLength(1), { interval: 5 });
    // The lane is free while bulk rests: another prefix's topic runs at once.
    const ro = m.want("other:a", "prefetch");
    await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1), { interval: 5 });
    expect(bulk).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(spans).toHaveLength(2), { timeout: 3000 });
    const [first, second] = spans;
    expect(second.topic).not.toBe(first.topic);
    // duty 0.5 → rest ≈ the run's own length (timer slack allowed).
    expect(second.start - first.end).toBeGreaterThanOrEqual(150);
    ra();
    rb();
    ro();
  });
});
