import type { NostrEvent, NostrFilter } from "@nostrify/types";
import type { NPool } from "@nostrify/nostrify";
import { describe, expect, it, vi } from "vitest";

import { detachableClient, NostrBatcher } from "@/lib/NostrBatcher";

function statusEvent(pubkey: string, content: string, d = "general"): NostrEvent {
  return {
    id: `${pubkey}-${d}`,
    pubkey,
    kind: 30315,
    created_at: 1000,
    content,
    tags: [["d", d]],
    sig: "sig",
  };
}

/** Minimal NPool stub that records the filters passed to `query`. */
function makePool(events: NostrEvent[]) {
  const calls: NostrFilter[][] = [];
  const pool = {
    query: vi.fn(async (filters: NostrFilter[]) => {
      calls.push(filters);
      // Emulate a relay: return events whose author is requested and d matches.
      const f = filters[0];
      const authors = new Set(f.authors ?? []);
      const dTags = new Set((f as Record<string, unknown>)["#d"] as string[] | undefined);
      return events.filter(
        (e) => authors.has(e.pubkey) && dTags.has(e.tags.find(([n]) => n === "d")?.[1] ?? ""),
      );
    }),
  } as unknown as NPool;
  return { pool, calls };
}

describe("NostrBatcher — NIP-38 status batching", () => {
  it("merges concurrent per-author kind-30315 queries into one REQ", async () => {
    const events = [
      statusEvent("alice", "🏖️ on vacation"),
      statusEvent("bob", "heads down"),
    ];
    const { pool, calls } = makePool(events);
    const batcher = new NostrBatcher(pool);

    // Three rows mount in the same tick: alice, bob, and carol (no status).
    const [a, b, c] = await Promise.all([
      batcher.query([{ kinds: [30315], authors: ["alice"], "#d": ["general"], limit: 1 }]),
      batcher.query([{ kinds: [30315], authors: ["bob"], "#d": ["general"], limit: 1 }]),
      batcher.query([{ kinds: [30315], authors: ["carol"], "#d": ["general"], limit: 1 }]),
    ]);

    // One combined REQ for all three authors.
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0][0].authors)).toEqual(new Set(["alice", "bob", "carol"]));

    // Each caller gets back only its own author's event.
    expect(a[0]?.content).toBe("🏖️ on vacation");
    expect(b[0]?.content).toBe("heads down");
    expect(c).toEqual([]);
  });

  it("keeps different d-tags (general vs music) in separate batches", async () => {
    const events = [
      statusEvent("alice", "working", "general"),
      statusEvent("alice", "lofi beats", "music"),
    ];
    const { pool, calls } = makePool(events);
    const batcher = new NostrBatcher(pool);

    const [general, music] = await Promise.all([
      batcher.query([{ kinds: [30315], authors: ["alice"], "#d": ["general"], limit: 1 }]),
      batcher.query([{ kinds: [30315], authors: ["alice"], "#d": ["music"], limit: 1 }]),
    ]);

    expect(calls).toHaveLength(2);
    expect(general[0]?.content).toBe("working");
    expect(music[0]?.content).toBe("lofi beats");
  });
});

function wrapEvent(id: string): NostrEvent {
  return { id, pubkey: "stream", kind: 1059, created_at: 1000, content: "", tags: [], sig: "sig" };
}

/**
 * A pool whose `relay(url)`/`group(urls)` handles record every `.query()` and
 * `.req()` call, so we can assert coalescing collapses identical concurrent
 * traffic onto one upstream request/subscription.
 */
function makeCoalescePool() {
  const queryCalls: { url: string; filters: NostrFilter[] }[] = [];
  const reqCalls: { url: string; filters: NostrFilter[] }[] = [];
  /** url → the async pusher feeding that relay's open `req` stream. */
  const feeders = new Map<string, (msg: NostrEvent) => void>();
  const closers = new Map<string, () => void>();

  const makeHandle = (url: string) => ({
    query: vi.fn(async (filters: NostrFilter[]) => {
      queryCalls.push({ url, filters });
      return [wrapEvent(`${url}-ev`)];
    }),
    req: vi.fn((filters: NostrFilter[]) => {
      reqCalls.push({ url, filters });
      const queue: NostrEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      feeders.set(url, (msg) => {
        queue.push(msg);
        wake?.();
      });
      closers.set(url, () => {
        done = true;
        wake?.();
      });
      return (async function* () {
        for (;;) {
          while (queue.length > 0) yield ["EVENT", "sub", queue.shift()!];
          if (done) return;
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      })();
    }),
  });

  const pool = {
    relay: vi.fn((url: string) => makeHandle(url)),
    group: vi.fn((urls: string[]) => makeHandle(urls.join(","))),
  } as unknown as NPool;

  return { pool, queryCalls, reqCalls, feeders, closers };
}

describe("NostrBatcher — relay()/group() query coalescing", () => {
  it("queryStrict rejects a REQ the relay CLOSEs, which query() reads as empty", async () => {
    const closing = {
      query: vi.fn(async () => []),
      req: vi.fn(() => (async function* () {
        yield ["CLOSED", "sub", "error: too many subscriptions"];
      })()),
    };
    const batcher = new NostrBatcher({ relay: () => closing } as unknown as NPool);
    const filter = [{ kinds: [1059], authors: ["s"], until: 100, limit: 50 }];

    await expect(batcher.relay("wss://r1").query(filter)).resolves.toEqual([]);
    await expect(
      (batcher.relay("wss://r1") as unknown as { queryStrict: (f: NostrFilter[]) => Promise<NostrEvent[]> }).queryStrict(filter),
    ).rejects.toThrow("closed the subscription");
  });

  it("collapses concurrent identical relay().query() onto one upstream REQ", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], authors: ["s"], since: 100 }];

    const [a, b, c] = await Promise.all([
      batcher.relay("wss://r1").query(filter),
      batcher.relay("wss://r1").query(filter),
      batcher.relay("wss://r1").query(filter),
    ]);

    const r1 = queryCalls.filter((c) => c.url === "wss://r1");
    expect(r1).toHaveLength(1); // one upstream call for three identical readers
    expect(a[0]?.id).toBe("wss://r1-ev");
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("does not coalesce different filters or different relays", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);

    await Promise.all([
      batcher.relay("wss://r1").query([{ kinds: [1059], since: 100 }]),
      batcher.relay("wss://r1").query([{ kinds: [1059], since: 200 }]), // different since
      batcher.relay("wss://r2").query([{ kinds: [1059], since: 100 }]), // different relay
    ]);

    expect(queryCalls).toHaveLength(3);
  });

  it("keys are order-insensitive (filter-entry and array order don't split a match)", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);

    await Promise.all([
      batcher.relay("wss://r1").query([{ kinds: [1, 2], authors: ["a", "b"] }]),
      batcher.relay("wss://r1").query([{ authors: ["b", "a"], kinds: [2, 1] }]),
    ]);

    expect(queryCalls.filter((c) => c.url === "wss://r1")).toHaveLength(1);
  });

  it("aborting one caller rejects only that caller, not the shared request", async () => {
    const { pool } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], since: 100 }];

    const ac = new AbortController();
    const aborted = batcher.relay("wss://r1").query(filter, { signal: ac.signal });
    const live = batcher.relay("wss://r1").query(filter);
    ac.abort(new Error("caller gone"));

    await expect(aborted).rejects.toThrow("caller gone");
    await expect(live).resolves.toEqual([wrapEvent("wss://r1-ev")]);
  });

  it("a fresh query after the shared one settled opens a new upstream", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], since: 100 }];

    await batcher.relay("wss://r1").query(filter);
    await batcher.relay("wss://r1").query(filter);

    expect(queryCalls.filter((c) => c.url === "wss://r1")).toHaveLength(2);
  });
});

describe("NostrBatcher — relay()/group() req multiplexing", () => {
  it("fans one upstream subscription out to concurrent identical subscribers", async () => {
    const { pool, reqCalls, feeders } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], authors: ["s"], since: 100 }];

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const got1: string[] = [];
    const got2: string[] = [];

    const drain = (stream: AsyncIterable<unknown>, out: string[]) =>
      (async () => {
        for await (const msg of stream) {
          const m = msg as [string, string, NostrEvent];
          if (m[0] === "EVENT") out.push(m[2].id);
        }
      })();

    const p1 = drain(batcher.relay("wss://r1").req(filter, { signal: ac1.signal }), got1);
    const p2 = drain(batcher.relay("wss://r1").req(filter, { signal: ac2.signal }), got2);

    // Let both subscribers attach before the upstream emits.
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls.filter((c) => c.url === "wss://r1")).toHaveLength(1);

    feeders.get("wss://r1")!(wrapEvent("m1"));
    await new Promise((r) => setTimeout(r, 0));

    ac1.abort();
    ac2.abort();
    await Promise.all([p1, p2]);

    expect(got1).toEqual(["m1"]);
    expect(got2).toEqual(["m1"]);
  });

  it("tears down the upstream when the last subscriber detaches, reopening for a new one", async () => {
    const { pool, reqCalls, feeders } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], since: 100 }];

    const drainOnce = async (signal: AbortSignal) => {
      for await (const _msg of batcher.relay("wss://r1").req(filter, { signal })) {
        void _msg;
      }
    };

    const ac1 = new AbortController();
    const p1 = drainOnce(ac1.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls).toHaveLength(1);
    feeders.get("wss://r1"); // upstream open
    ac1.abort();
    await p1;

    // New subscriber after the last one left → a fresh upstream REQ.
    const ac2 = new AbortController();
    const p2 = drainOnce(ac2.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls).toHaveLength(2);
    ac2.abort();
    await p2;
  });
});

describe("NostrBatcher — live tail with a signal-respecting upstream", () => {
  /**
   * A relay handle whose `req` behaves like the REAL NRelay1: it RESPECTS the
   * abort signal (ends when aborted), yields an EOSE up front, and then stays
   * open for live events. The coalesce mock above ignores the signal, so it
   * cannot catch teardown/re-REQ regressions — this one can. Mirrors how
   * WireSync drives its standing rounds (abortable round + re-REQ).
   */
  function makeRealisticPool() {
    const reqCalls: { url: string; filters: NostrFilter[] }[] = [];
    const feeders = new Map<string, (msg: [string, ...unknown[]]) => void>();

    const makeHandle = (url: string) => ({
      query: vi.fn(async () => [] as NostrEvent[]),
      req: vi.fn((filters: NostrFilter[], opts?: { signal?: AbortSignal }) => {
        reqCalls.push({ url, filters });
        const queue: [string, ...unknown[]][] = [];
        let wake: (() => void) | undefined;
        let done = false;
        const signal = opts?.signal;
        const onAbort = () => {
          done = true;
          wake?.();
        };
        if (signal) {
          if (signal.aborted) done = true;
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        feeders.set(url, (msg) => {
          queue.push(msg);
          wake?.();
        });
        return (async function* () {
          try {
            yield ["EOSE", "sub"] as [string, ...unknown[]];
            for (;;) {
              while (queue.length > 0) yield queue.shift()!;
              if (done) return;
              await new Promise<void>((r) => (wake = r));
              wake = undefined;
            }
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
        })();
      }),
    });

    const pool = {
      relay: vi.fn((url: string) => makeHandle(url)),
    } as unknown as NPool;

    return { pool, reqCalls, feeders };
  }

  it("delivers a live event after EOSE on a standing subscription", async () => {
    const { pool, feeders } = makeRealisticPool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], authors: ["stream"], since: 100 }];

    const got: string[] = [];
    const ac = new AbortController();
    const p = (async () => {
      for await (const msg of batcher.relay("wss://r1").req(filter, { signal: ac.signal })) {
        const m = msg as [string, string, NostrEvent];
        if (m[0] === "EVENT") got.push(m[2].id);
      }
    })();

    await new Promise((r) => setTimeout(r, 0));
    // A live message arrives on the standing (post-EOSE) subscription.
    feeders.get("wss://r1")!(["EVENT", "sub", wrapEvent("live-1")]);
    await new Promise((r) => setTimeout(r, 0));

    ac.abort();
    await p;

    expect(got).toEqual(["live-1"]);
  });

  it("a re-REQ after an aborted round still delivers live events (round teardown)", async () => {
    const { pool, feeders, reqCalls } = makeRealisticPool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], authors: ["stream"], since: 100 }];

    const got: string[] = [];
    const drainWith = (signal: AbortSignal) =>
      (async () => {
        for await (const msg of batcher.relay("wss://r1").req(filter, { signal })) {
          const m = msg as [string, string, NostrEvent];
          if (m[0] === "EVENT") got.push(m[2].id);
        }
      })();

    // Round 1: opened, then aborted (WireSync's watchdog/rotation pattern).
    const round1 = new AbortController();
    const p1 = drainWith(round1.signal);
    await new Promise((r) => setTimeout(r, 0));
    round1.abort();
    await p1;

    // Round 2: the loop re-REQs with the SAME filter (cursor didn't advance).
    const round2 = new AbortController();
    const p2 = drainWith(round2.signal);
    await new Promise((r) => setTimeout(r, 0));

    feeders.get("wss://r1")!(["EVENT", "sub", wrapEvent("live-2")]);
    await new Promise((r) => setTimeout(r, 0));

    round2.abort();
    await p2;

    expect(reqCalls).toHaveLength(2); // round 1 closed, round 2 reopened
    expect(got).toEqual(["live-2"]);
  });
});

describe("NostrBatcher — gift wraps are never cached", () => {
  /** A store stub recording every event handed to `.event()`. */
  function makeStore() {
    const cached: NostrEvent[] = [];
    const store = {
      event: vi.fn(async (event: NostrEvent) => {
        cached.push(event);
      }),
      query: vi.fn(async () => []),
    };
    return { store: Promise.resolve(store) as unknown as Promise<import("@nostrify/nostrify").NStore>, cached };
  }

  /** A pool returning a mix of a gift wrap and a normal event for any query. */
  function makeMixedPool() {
    const normal: NostrEvent = { id: "n1", pubkey: "p", kind: 1, created_at: 1000, content: "hi", tags: [], sig: "s" };
    const wrap: NostrEvent = wrapEvent("w1"); // kind 1059
    const ephemeralWrap: NostrEvent = { ...wrapEvent("w2"), kind: 21059 };
    const pool = {
      query: vi.fn(async () => [normal, wrap, ephemeralWrap]),
    } as unknown as NPool;
    return { pool, normal, wrap, ephemeralWrap };
  }

  it("drops kind 1059/21059 from the cache but keeps other kinds (top-level query)", async () => {
    const { pool } = makeMixedPool();
    const { store, cached } = makeStore();
    const batcher = new NostrBatcher(pool, store);

    const events = await batcher.query([{ kinds: [1, 1059, 21059] }]);
    // The caller still receives everything the relay returned.
    expect(events.map((e) => e.kind).sort()).toEqual([1, 1059, 21059]);
    // Let the fire-and-forget cache write settle.
    await new Promise((r) => setTimeout(r, 0));

    // Only the non-wrap event was cached.
    expect(cached.map((e) => e.kind)).toEqual([1]);
    expect(cached.some((e) => e.kind === 1059 || e.kind === 21059)).toBe(false);
  });

  it("skips the mirror for a group().req() opened with cache: false, on its own upstream", async () => {
    const { pool, reqCalls, feeders } = makeCoalescePool();
    const { store, cached } = makeStore();
    const batcher = new NostrBatcher(pool, store);
    const filter = [{ kinds: [3], authors: ["me"] }];
    const note = (id: string): NostrEvent => ({ ...wrapEvent(id), kind: 3 });

    const drain = async (opts: { signal: AbortSignal; cache?: boolean }) => {
      for await (const _msg of batcher.group(["wss://r1"]).req(filter, opts)) void _msg;
    };
    const uncached = new AbortController();
    const p1 = drain({ signal: uncached.signal, cache: false });
    await new Promise((r) => setTimeout(r, 0));
    feeders.get("wss://r1")!(note("u1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(cached).toEqual([]);

    // A caching subscriber to the same filters is not folded into it.
    const cachedSub = new AbortController();
    const p2 = drain({ signal: cachedSub.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls).toHaveLength(2);
    feeders.get("wss://r1")!(note("c1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(cached.map((e) => e.id)).toEqual(["c1"]);

    uncached.abort();
    cachedSub.abort();
    await Promise.all([p1, p2]);
  });
});

describe("detachableClient — the shared client survives being taken apart", () => {
  /** A pool stub covering the whole client surface, recording what it reaches. */
  function makeFullPool() {
    const seen: string[] = [];
    const handle = { query: vi.fn(async () => []), event: vi.fn(async () => undefined) };
    const pool = {
      query: vi.fn(async () => { seen.push("query"); return []; }),
      event: vi.fn(async () => { seen.push("event"); }),
      req: vi.fn(() => { seen.push("req"); return (async function* () {})(); }),
      relay: vi.fn(() => { seen.push("relay"); return handle; }),
      group: vi.fn(() => { seen.push("group"); return handle; }),
      close: vi.fn(async () => { seen.push("close"); }),
    } as unknown as NPool;
    return { pool, seen };
  }

  const note: NostrEvent = { id: "e1", pubkey: "p", kind: 1, created_at: 1, content: "", tags: [], sig: "s" };

  it("keeps every method working when it is lifted off the client", async () => {
    const { pool, seen } = makeFullPool();
    const client = detachableClient(new NostrBatcher(pool));

    // Exactly how the app treats `nostr`: a bag of functions. That is what
    // `{ relay: nostr.relay }` assumed in useCommunityList, and what every
    // object-literal double in the repo makes look safe.
    const { query, event, req, relay, group, close } = client;
    await query([{ kinds: [1] }]);
    await event(note);
    req([{ kinds: [1] }]);
    relay("wss://r1");
    group(["wss://r1"]);
    await close();

    expect(seen).toEqual(["query", "event", "req", "relay", "group", "close"]);
  });

  it("exposes the pool's open relays live, which useEvent routes hinted lookups by", () => {
    const { pool } = makeFullPool();
    const open = new Map<string, unknown>();
    (pool as unknown as { relays: Map<string, unknown> }).relays = open;
    const client = detachableClient(new NostrBatcher(pool));

    expect(client.relays.has("wss://group.example")).toBe(false);
    open.set("wss://group.example", {});
    expect(client.relays.has("wss://group.example")).toBe(true);
  });

  it("supplies a guarantee the bare instance does not", () => {
    const { pool } = makeFullPool();
    // The hazard itself: a method off the instance arrives with the wrong
    // receiver and cannot reach `this.pool`. Nothing in the types says so.
    const { relay } = new NostrBatcher(pool);
    expect(() => relay("wss://r1")).toThrow();
  });
});


describe("NostrBatcher — d-tag collectors", () => {
  it("drops a (kind, author) collector once its batch has drained", async () => {
    const pool = { query: vi.fn(async () => []) } as unknown as NPool;
    const batcher = new NostrBatcher(pool);
    const collectors = () => (batcher as unknown as { dTagCollectors: Map<string, unknown> }).dTagCollectors;
    const author = (i: number) => i.toString(16).padStart(64, "0");

    for (let i = 0; i < 20; i++) {
      await batcher.query([{ kinds: [30023], authors: [author(i)], "#d": ["post"], limit: 1 }]);
    }
    expect(collectors().size).toBe(0);

    // Concurrent d tags for one author still share one REQ.
    await Promise.all(["a", "b", "c"].map((d) =>
      batcher.query([{ kinds: [30023], authors: [author(1)], "#d": [d], limit: 1 }]),
    ));
    expect(pool.query).toHaveBeenCalledTimes(21);
    expect(collectors().size).toBe(0);
  });
});
