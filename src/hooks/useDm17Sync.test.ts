import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

const coverage = vi.hoisted(() => ({ map: new Map<string, number>() }));
vi.mock("@/lib/nativeNotifications", () => ({ nativeDmCoverage: async () => coverage.map }));

import {
  dm17InboxFilter,
  pageForwardRest,
  queryWrapsPerRelay,
  relayScanWatermarks,
  serviceCovered,
  syncDm17Inbox,
  walkDm17History,
  whenDm17InboxFirstPage,
} from "@/hooks/useDm17";
import { onFreshDm17, readDm17Cursor, updateDm17Cursor } from "@/lib/nip17/dm17Store";
import { buildDmRumor, dmChatTags, KIND_DM_CHAT, MAX_WRAP_BACKDATE_SECS, sealDmRumor, wrapDmSeal } from "@/lib/nip17/protocol";
import { NSecSigner } from "@nostrify/nostrify";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

// Mirrors of useDm17's module-private slack constants.
const RESYNC_SLACK_SECS = MAX_WRAP_BACKDATE_SECS + 3600;
const NARROW_RESYNC_SLACK_SECS = 10 * 60;

const event = (id: string, createdAt: number): NostrEvent => ({
  id: id.padEnd(64, "0"),
  pubkey: "1".repeat(64),
  created_at: createdAt,
  kind: 1059,
  tags: [["p", "2".repeat(64)]],
  content: "ciphertext",
  sig: "3".repeat(128),
});

describe("NIP-17 per-relay inbox queries", () => {
  it("keeps successful empty relays distinct from failed relays", async () => {
    const fastQuery = vi.fn().mockResolvedValue([]);
    const slowQuery = vi.fn().mockRejectedValue(new Error("timeout"));
    const nostr = {
      relay: (url: string) => ({ query: url.includes("fast") ? fastQuery : slowQuery }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://fast.example", "wss://slow.example"],
      { kinds: [1059], "#p": ["2".repeat(64)] },
      new AbortController().signal,
    );

    expect(result.pages).toEqual([{ url: "wss://fast.example", events: [] }]);
    expect(result.failed).toEqual(["wss://slow.example"]);
  });

  it("reports no successful pages when every relay fails", async () => {
    const nostr = {
      relay: () => ({ query: vi.fn().mockRejectedValue(new Error("offline")) }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://one.example", "wss://two.example"],
      { kinds: [1059] },
      new AbortController().signal,
    );

    expect(result.pages).toEqual([]);
    expect(result.failed).toEqual(["wss://one.example", "wss://two.example"]);
  });

  it("returns each relay's events without collapsing relay provenance", async () => {
    const first = event("a", 100);
    const second = event("b", 200);
    const nostr = {
      relay: (url: string) => ({
        query: vi.fn().mockResolvedValue(url.includes("one") ? [first] : [second]),
      }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://one.example", "wss://two.example"],
      (url) => ({ kinds: [1059], since: url.includes("one") ? 10 : 20 }),
      new AbortController().signal,
    );

    expect(result.pages).toEqual([
      { url: "wss://one.example", events: [first] },
      { url: "wss://two.example", events: [second] },
    ]);
  });
});

describe("NIP-17 per-relay inbox filters", () => {
  const self = "2".repeat(64);

  it("does not inherit a legacy global cursor for an unscanned relay", () => {
    const filter = dm17InboxFilter(
      self,
      { newest: 50_000, oldest: 1, exhausted: false },
      "wss://new.example",
      false,
    );

    expect(filter.since).toBeUndefined();
  });

  it("asks for gift wraps and nothing else", () => {
    // A Mini App peer signal rides INSIDE a wrap like every other DM rumor, so
    // there is no second filter to ask for. A bare kind-30078 addressed to us
    // is an event any author can publish — asking for it would admit an
    // unauthenticated node address into the dial set, and put a non-backdated
    // event into the page `relayScanWatermarks` reads.
    const filter = dm17InboxFilter(self, undefined, "wss://a.example", false);
    expect(filter.kinds).toEqual([1059]);
  });

  it("uses each relay's own cursor for narrow and full recovery windows", () => {
    const cursor = {
      newest: 50_000,
      oldest: 1,
      exhausted: false,
      relayNewest: {
        "wss://fast.example": 50_000,
        "wss://slow.example": 40_000,
      },
    };

    expect(dm17InboxFilter(self, cursor, "wss://fast.example", false).since).toBe(49_400);
    expect(dm17InboxFilter(self, cursor, "wss://slow.example", false).since).toBe(39_400);
    expect(dm17InboxFilter(self, cursor, "wss://fast.example", true).since).toBe(0);
  });
});

describe("relayScanWatermarks", () => {
  const viewer = "2".repeat(64);
  const nowSecs = 100 * MAX_WRAP_BACKDATE_SECS;
  const floor = nowSecs - MAX_WRAP_BACKDATE_SECS;

  it("advances an empty page to the backdate floor, never to wall clock", () => {
    expect(relayScanWatermarks([{ url: "wss://a.example", events: [] }], nowSecs))
      .toEqual({ "wss://a.example": floor });
  });

  it("raises to the newest wrap when the page outruns the floor", () => {
    const pages = [{ url: "wss://a.example", events: [event("a", floor + 500), event("b", floor + 100)] }];
    expect(relayScanWatermarks(pages, nowSecs)["wss://a.example"]).toBe(floor + 500);
  });

  it("never leaves the watermark below the floor on a page of old wraps", () => {
    const pages = [{ url: "wss://a.example", events: [event("a", floor - 5_000)] }];
    expect(relayScanWatermarks(pages, nowSecs)["wss://a.example"]).toBe(floor);
  });

  it("is not moved by an event that is not a gift wrap", () => {
    // The floor is sound ONLY because every event counted is backdated by at
    // most the horizon. An event published at wall clock — a bare kind-30078
    // Mini App peer signal is the one that nearly shipped — would carry the
    // watermark a full two days past where a wrap still in flight will land,
    // and the next narrow poll would simply not select it. A silently lost DM.
    const bare: NostrEvent = { ...event("c", nowSecs), kind: 30078 };
    const pages = [{ url: "wss://a.example", events: [bare] }];
    expect(relayScanWatermarks(pages, nowSecs)["wss://a.example"]).toBe(floor);

    // And the consequence the floor exists for: a wrap published now, backdated
    // the full two days, stays inside the next narrow poll's window.
    const cursor = {
      newest: floor,
      oldest: 1,
      exhausted: false,
      relayNewest: { "wss://a.example": floor },
    };
    const since = dm17InboxFilter(viewer, cursor, "wss://a.example", false).since ?? 0;
    expect(since).toBeLessThanOrEqual(nowSecs - MAX_WRAP_BACKDATE_SECS);
  });
});

// ── syncDm17Inbox against a controllable pool ────────────────────────────────

interface PendingQuery {
  url: string;
  filter: NostrFilter;
  resolve: (events: NostrEvent[]) => void;
  reject: (error: unknown) => void;
}

/** A pool whose per-relay queries stay pending until the test settles them. */
function deferredPool() {
  const queries: PendingQuery[] = [];
  const pool = {
    relay: (url: string) => ({
      query: (filters: NostrFilter[]) =>
        new Promise<NostrEvent[]>((resolve, reject) => {
          queries.push({ url, filter: filters[0], resolve, reject });
        }),
    }),
  };
  return { pool, queries };
}

function syncCtx(pool: unknown, self: string, relays: string[], method: string | undefined = "nsec") {
  return {
    nostr: pool as never,
    signer: { nip44: {} } as never,
    self,
    method,
    relays,
  };
}

describe("syncDm17Inbox", () => {
  it("fetches nothing in the background for an approval-gated signer the user has not allowed", async () => {
    // Nothing could be opened, so a fetch would only re-download the same page
    // every poll (the cursor cannot advance past wraps it did not open).
    const self = getPublicKey(generateSecretKey());
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, ["wss://inbox.example"], "bunker");
    await expect(syncDm17Inbox(ctx, { force: true })).resolves.toBe(false);
    expect(queries).toHaveLength(0);
  });


  it("seeds an empty first scan's watermark at the backdate floor so the next poll still covers backdated wraps", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://quiet.example";
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    const before = Math.floor(Date.now() / 1000);
    const pass = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    // No cursor yet: the first scan is unbounded.
    expect(queries[0].filter.since).toBeUndefined();
    queries[0].resolve([]);
    await expect(pass).resolves.toBe(true);
    const after = Math.floor(Date.now() / 1000);

    const cursor = await readDm17Cursor(self);
    const watermark = cursor?.relayNewest?.[url];
    expect(watermark).toBeGreaterThanOrEqual(before - MAX_WRAP_BACKDATE_SECS);
    expect(watermark).toBeLessThanOrEqual(after - MAX_WRAP_BACKDATE_SECS);
    // A wrap published a moment later, backdated the full two days, is inside
    // the next narrow poll's window.
    const since = dm17InboxFilter(self, cursor, url, false).since;
    expect(since).toBeLessThanOrEqual(after - MAX_WRAP_BACKDATE_SECS);
  });

  it("prunes the persisted watermark of a relay no longer in the sync set", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://kept.example";
    await updateDm17Cursor(self, {
      newest: 100,
      oldest: 50,
      exhausted: false,
      relayNewest: { [url]: 100, "wss://removed.example": 90 },
    });
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    const pass = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    queries[0].resolve([]);
    await expect(pass).resolves.toBe(true);

    const cursor = await readDm17Cursor(self);
    expect(cursor?.relayNewest?.["wss://removed.example"]).toBeUndefined();
    expect(cursor?.relayNewest?.[url]).toBeGreaterThanOrEqual(100);
  });

  it("runs a full recovery queued behind an in-flight narrow pass exactly once", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://dm.example";
    // A far-future watermark so the real clock's backdate floor cannot
    // overtake it, making narrow vs full windows distinguishable.
    const newest = 5_000_000_000;
    await updateDm17Cursor(self, {
      newest,
      oldest: 1,
      exhausted: false,
      relayNewest: { [url]: newest },
    });
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    // First pass of the session pays the full window by cadence.
    const a = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    expect(queries[0].filter.since).toBe(newest - RESYNC_SLACK_SECS);
    queries[0].resolve([]);
    await expect(a).resolves.toBe(true);

    // A routine narrow poll, left in flight.
    const b = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(2));
    expect(queries[1].filter.since).toBe(newest - NARROW_RESYNC_SLACK_SECS);

    // A resume recovery arrives while the narrow pass is in flight: it must
    // let that pass finish, then pay the full window in a NEW pass.
    const c = syncDm17Inbox(ctx, { full: true });
    queries[1].resolve([]);
    await expect(b).resolves.toBe(true);
    await vi.waitFor(() => expect(queries.length).toBe(3));
    expect(queries[2].filter.since).toBe(newest - RESYNC_SLACK_SECS);

    // Another full caller while the full pass is in flight coalesces onto it
    // rather than paying the window again.
    const d = syncDm17Inbox(ctx, { full: true });
    queries[2].resolve([]);
    await expect(c).resolves.toBe(true);
    await expect(d).resolves.toBe(true);
    expect(queries.length).toBe(3);
  });

  it("stores what a fast relay holds without waiting on a slow one, opening a wrap both hold once", async () => {
    const sk = generateSecretKey();
    const self = getPublicKey(sk);
    const sender = new NSecSigner(generateSecretKey());
    const senderPk = await sender.getPublicKey();
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "from the fast relay", tags: dmChatTags([self]), pubkey: senderPk, createdAt: Math.floor(Date.now() / 1000) });
    const wrap = await wrapDmSeal(await sealDmRumor(rumor, self, sender), self);
    const { pool, queries } = deferredPool();
    const ctx = { ...syncCtx(pool, self, ["wss://fast.example", "wss://slow.example"]), signer: new NSecSigner(sk) as never };
    const heard: string[] = [];
    const off = onFreshDm17(self, (fresh) => heard.push(...fresh.map((o) => o.rumorId)));
    try {
      const stored = vi.fn();
      const pass = syncDm17Inbox(ctx, { force: true, onPageStored: stored });
      // Any caller, not just the one that started the pass, can wait for its first page.
      let firstPageIn = false;
      void whenDm17InboxFirstPage(self).then(() => (firstPageIn = true));
      await vi.waitFor(() => expect(queries.length).toBe(2));
      queries.find((q) => q.url.includes("fast"))!.resolve([wrap]);
      // Stored while the slow relay hasn't answered, and reported as such.
      await vi.waitFor(() => expect(heard).toEqual([rumor.id]));
      await vi.waitFor(() => expect(stored).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(firstPageIn).toBe(true));
      queries.find((q) => q.url.includes("slow"))!.resolve([wrap]);
      await expect(pass).resolves.toBe(true);
      expect(heard).toEqual([rumor.id]);
      // The slow relay's copy was already held: nothing new, so no second report.
      expect(stored).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("does not ask a relay the background service has covered since its last full read", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://covered.example";
    const newest = 5_000_000_000;
    const lastFull = Date.now() - 60 * 60_000; // past the 15-minute cadence
    await updateDm17Cursor(self, {
      newest,
      oldest: 1,
      exhausted: false,
      relayNewest: { [url]: newest },
      relayFullScanAt: { [url]: lastFull },
    });
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    // Live since before our last full read: the relay isn't asked at all.
    coverage.map = new Map([[url, lastFull - 1_000]]);
    await expect(syncDm17Inbox(ctx, { force: true, full: true })).resolves.toBe(true);
    expect(queries).toHaveLength(0);

    // The service reconnected after it: a routine poll reads the full window
    // once to close the gap…
    coverage.map = new Map([[url, lastFull + 1_000]]);
    const full = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    expect(queries[0].filter.since).toBe(newest - RESYNC_SLACK_SECS);
    queries[0].resolve([]);
    await expect(full).resolves.toBe(true);
    // …and the relay is left alone from then on.
    await expect(syncDm17Inbox(ctx, { force: true })).resolves.toBe(true);
    expect(queries).toHaveLength(1);
    coverage.map = new Map();
  });
});

describe("serviceCovered()", () => {
  it("needs coverage from before the last full read, on the normalized URL", () => {
    const cov = new Map([["wss://a.example", 1_000]]);
    expect(serviceCovered(cov, "wss://a.example/", 2_000)).toBe(true);
    expect(serviceCovered(cov, "wss://a.example", 500)).toBe(false);
    expect(serviceCovered(cov, "wss://b.example", 2_000)).toBe(false);
    expect(serviceCovered(cov, "wss://a.example", 0), "never read in full").toBe(false);
  });
});

// ── Paging to the bottom ─────────────────────────────────────────────────────

/** A relay honoring since/until/limit newest-first, capping `limit` at `cap`. */
function pagingRelay(events: NostrEvent[], cap = Infinity) {
  const asked: NostrFilter[] = [];
  const query = async (filters: NostrFilter[]) => {
    const f = filters[0];
    asked.push(f);
    const out = events
      .filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
      .sort((a, b) => b.created_at - a.created_at);
    return out.slice(0, Math.min(f.limit ?? Infinity, cap));
  };
  return { asked, query };
}

const series = (prefix: string, n: number, from: number) =>
  Array.from({ length: n }, (_, i) => event(`${prefix}${i.toString(16).padStart(4, "0")}`, from + i));

describe("pageForwardRest", () => {
  it("follows a capped burst down to its since instead of stopping at the first page", async () => {
    const relay = pagingRelay(series("a", 250, 10_000), 100);
    const filter: NostrFilter = { kinds: [1059], "#p": ["2".repeat(64)], since: 10_000, limit: 500 };
    const first = await relay.query([filter]);
    const rest = await pageForwardRest({ relay: () => relay } as never, "wss://a.example", filter, first);
    expect(rest.complete).toBe(true);
    expect(new Set(rest.events.map((e) => e.id)).size).toBe(250);
  });
});

describe("walkDm17History", () => {
  it("pages each relay down to an empty page, resuming from its own floor, then stops asking", async () => {
    const self = getPublicKey(generateSecretKey());
    // The deep relay holds more than one round reads; the shallow one runs out early.
    const deep = pagingRelay(series("d", 1_200, 1_000), 500);
    const shallow = pagingRelay(series("s", 30, 5_000), 500);
    const pool = { relay: (url: string) => (url.includes("deep") ? deep : shallow) };
    const ctx = syncCtx(pool, self, ["wss://deep.example", "wss://shallow.example"]);
    const signal = new AbortController().signal;

    const first = await walkDm17History(ctx, signal);
    expect(first).toMatchObject({ more: true, progressed: true, failed: false });
    let cursor = await readDm17Cursor(self);
    // Two pages of the deep relay: its floor sits just below the 1000th newest wrap.
    expect(cursor?.relayOldest?.["wss://deep.example"]).toBe(1_000 + 200 - 1);
    expect(cursor?.relayExhaustedAt?.["wss://shallow.example"]).toBeGreaterThan(0);

    const second = await walkDm17History(ctx, signal);
    expect(second.more).toBe(false);
    cursor = await readDm17Cursor(self);
    expect(cursor?.relayExhaustedAt?.["wss://deep.example"]).toBeGreaterThan(0);
    // The resumed page started below the first round's floor, not from the top.
    expect(deep.asked[2].until).toBe(1_199);

    const asks = deep.asked.length + shallow.asked.length;
    await expect(walkDm17History(ctx, signal)).resolves.toMatchObject({ more: false, progressed: false });
    expect(deep.asked.length + shallow.asked.length).toBe(asks);
  });

  it("does nothing in the background for an approval-gated signer the user has not allowed", async () => {
    const self = getPublicKey(generateSecretKey());
    const relay = pagingRelay(series("x", 10, 1_000));
    const ctx = syncCtx({ relay: () => relay }, self, ["wss://inbox.example"], "bunker");
    await expect(walkDm17History(ctx, new AbortController().signal)).resolves.toMatchObject({ progressed: false });
    expect(relay.asked).toHaveLength(0);
  });
});
