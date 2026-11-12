// @vitest-environment node
/**
 * The `c2:` sync-topic handler: a round pulls a channel's wraps from its
 * relays, decrypts them into the rumor store, and advances the persisted
 * cursor — and the scheduler stamps the topic fresh ONLY when the round stood
 * a chance (an unreachable relay set or a missing context fails the run, so a
 * later pass retries instead of reading as a permanently empty room).
 *
 * The full three-pass behavior (bridge gap, EOSE-grace race) stays pinned by
 * `useChannel.test.tsx` through the hook.
 */
import { IDBFactory } from "fake-indexeddb";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "./kinds";
import type { Channel, Community } from "./types";

/** The community every channel here belongs to (the rumor-store tenant). */
const CID = "dd".repeat(32);
const RELAY = "wss://relay.test";
const root = new Uint8Array(32).fill(7);

/** A fresh module graph: scheduler, stores, and the handler registration. */
async function freshModules() {
  vi.resetModules();
  const manager = await import("@/sync/syncManager");
  const channelSync = await import("./channelSync");
  const rumorStore = await import("./rumorStore");
  const derive = await import("./derive");
  const stream = await import("./stream");
  const planeSync = await import("./planeSync");
  // No live sockets in these tests — don't let the NIP-42 gate poll its cap.
  planeSync._configureAuthWaitForTests({ maxWaitMs: 0 });
  return { ...manager, ...channelSync, ...rumorStore, ...derive, ...stream };
}
type Modules = Awaited<ReturnType<typeof freshModules>>;

let nextChannelByte = 1;
function makeChannel(m: Modules): Channel {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const group = m.channelGroupKey(root, channelId, 0);
  const streamKey = { epoch: 0n, group };
  return {
    id: channelId,
    idHex: m.bytesToHex(channelId),
    name: "general",
    isPrivate: false,
    voice: { room: m.voiceGroupKey(root, channelId, 0), mediaKey: m.voiceMediaKey(root, channelId, 0) },
    streams: [streamKey],
    current: streamKey,
  } as Channel;
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/** A chat wrap with a controlled outer `created_at` (see useChannel.test). */
async function wrapChatAt(
  m: Modules,
  channel: Channel,
  s: ReturnType<typeof signer>,
  content: string,
  createdAt: number,
): Promise<NostrEvent> {
  const rumor = m.buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [...m.channelBindingTags(channel.idHex, 0n)],
    pubkey: s.pubkey,
    ms: createdAt * 1000,
  });
  const seal = await m.sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, s);
  const w = await m.wrapSeal(seal, channel.current.group);
  return finalizeEvent(
    { kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt },
    channel.current.group.sk,
  );
}

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/** An in-memory relay honoring kinds/authors/since/until/limit, newest-first. */
class FakeRelay {
  events: NostrEvent[] = [];
  fail = false;
  asked: Filter[] = [];

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.asked.push(...filters);
    if (this.fail) throw new Error("relay down");
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      let evs = this.events.filter(
        (ev) =>
          (!f.kinds || f.kinds.includes(ev.kind)) &&
          (!f.authors || f.authors.includes(ev.pubkey)) &&
          (f.since === undefined || ev.created_at >= f.since) &&
          (f.until === undefined || ev.created_at <= f.until),
      );
      evs = [...evs].sort((a, b) => b.created_at - a.created_at);
      if (f.limit !== undefined) evs = evs.slice(0, f.limit);
      for (const ev of evs) out.set(ev.id, ev);
    }
    return [...out.values()];
  }
}

function makePool(relays: Record<string, FakeRelay>) {
  return { relay: (url: string) => relays[url] };
}

/**
 * A relay that answers `refuse` REQs with CLOSED ("too many subscriptions"),
 * shaped like a batcher relay handle: `query()` resolves `[]` for it exactly as
 * for an empty answer (NRelay1), and `queryStrict()` rejects.
 */
class RefusingRelay extends FakeRelay {
  refuse = new Set<number>();
  private reqs = 0;

  override async query(filters: Filter[]): Promise<NostrEvent[]> {
    if (this.refuse.has(this.reqs++)) return [];
    return super.query(filters);
  }

  async queryStrict(filters: Filter[]): Promise<NostrEvent[]> {
    if (this.refuse.has(this.reqs++)) throw new Error("Relay closed the subscription before EOSE");
    return super.query(filters);
  }
}

describe("channelSync — the c2: topic handler", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("a round decrypts relay history into the rumor store, advances the cursor, and settles the topic", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);

    const relay = new FakeRelay();
    relay.events = await Promise.all(
      [0, 1, 2].map((i) => wrapChatAt(m, channel, alice, `msg-${i}`, now - 100 + i)),
    );
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });

    const rumors = await m.queryChannelRumors(CID, channel.idHex, { limit: 10 });
    expect(rumors.map((r) => r.content).sort()).toEqual(["msg-0", "msg-1", "msg-2"]);
    const cursor = await m.readStreamCursor(channel.idHex);
    // Pass 1 read everything (short page, no failures), so `newest` sealed at
    // the top; the older pass came back empty, which is inconclusive — never
    // recorded as exhaustion.
    expect(cursor?.newest).toBe(now - 98);
    expect(cursor?.exhausted).toBe(false);
    expect(m.syncState(topic).lastSyncedAt).toBeTypeOf("number");
    release();
  });

  it("rings the channel's cursor scope even when the round decrypts nothing", { timeout: 30_000 }, async () => {
    // `writeRumors` rings only for a non-empty batch, and it runs BEFORE the
    // cursor write — so without the handler's own ring, a round whose only
    // result is a cursor verdict (`exhausted`, a moved `newest`) never
    // reaches an already-rendered timeline, which reads `hasMore` from that
    // cursor and would keep a stale scroll-up affordance.
    const m = await freshModules();
    const bus = await import("@/wire/bus");
    const channel = makeChannel(m);
    // Reachable, but holds nothing for this channel: no rumors are written,
    // so the handler is the only thing that can ring.
    const relay = new FakeRelay();
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const topic = `c2:${channel.idHex}`;
    const rings: string[] = [];
    const off = bus.onWireScopes((scopes) => rings.push(...scopes));
    const release = m.want(topic);
    try {
      await vi.waitFor(() => expect(rings).toContain(`c2cur:${channel.idHex}`), { timeout: 15_000 });
      // The rumor store didn't change, so the community-wide `c2:` readers
      // (mentions, unread, threads) must not be woken for it.
      expect(rings).not.toContain(topic);
    } finally {
      off();
      release();
    }
  });

  it("past a complete round, a quiet channel costs one since-bounded ask per relay and settles", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = await Promise.all([0, 1, 2].map((i) => wrapChatAt(m, channel, alice, `old-${i}`, now - 86_400 + i)));
    await m.updateStreamCursor(channel.idHex, { newest: now - 3_600, oldest: now - 90_000, exhausted: true, streams: m.streamSetSig(channel) });
    m._trustCursorForTests(channel.idHex);
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });
    expect(relay.asked).toHaveLength(1);
    expect(relay.asked[0].since).toBe(now - 3_600 - 600);
    expect(relay.asked[0].until).toBeUndefined();
    release();
  });

  it("reads again what a cursor claimed when the store holds none of it, past the seen-wrap memo", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = await Promise.all([0, 1, 2].map((i) => wrapChatAt(m, channel, alice, `kept-${i}`, now - 86_400 + i)));
    // A complete cursor and a memo vouching for every wrap, but no rows: storage lost them.
    await m.updateStreamCursor(channel.idHex, { newest: now - 3_600, oldest: now - 90_000, exhausted: true, streams: m.streamSetSig(channel) });
    const planeSync = await import("./planeSync");
    planeSync.notePlaneWrapsSeen(relay.events.map((e) => e.id));
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const release = m.want(`c2:${channel.idHex}`);
    await vi.waitFor(async () => expect(await m.queryChannelRumors(CID, channel.idHex, { limit: 10 })).toHaveLength(3), { timeout: 15_000 });
    release();
  });

  it("starts over when the channel's stream addresses changed since its cursor was read", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = [await wrapChatAt(m, channel, signer(), "hi", now - 86_400)];
    await m.updateStreamCursor(channel.idHex, { newest: now - 3_600, oldest: now - 90_000, exhausted: true, streams: "an-older-set" });
    m._trustCursorForTests(channel.idHex);
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });
    // A first round again: the newest page unbounded below, not a since-bounded ask.
    expect(relay.asked[0].since).toBeUndefined();
    expect((await m.readStreamCursor(channel.idHex))?.streams).toBe(m.streamSetSig(channel));
    release();
  });

  it("reads a stream again once its cut is lifted: a Private Channel made public again (CORD-03 §2)", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    // Posted at the root after the cut, while this device read the Channel private and
    // its exhausted cursor had dropped the retired root from every REQ.
    relay.events = [await wrapChatAt(m, channel, signer(), "welcome", now - 1_800)];
    const cut = { ...channel, isPrivate: true, streams: channel.streams.map((s) => ({ ...s, retiredAt: now - 7_200 })) };
    await m.updateStreamCursor(channel.idHex, { newest: now - 600, oldest: now - 90_000, exhausted: true, streams: m.streamSetSig(cut) });
    m._trustCursorForTests(channel.idHex);
    expect(m.streamSetSig(cut)).not.toBe(m.streamSetSig(channel));
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const release = m.want(`c2:${channel.idHex}`);
    await vi.waitFor(async () => expect((await m.queryChannelRumors(CID, channel.idHex, { limit: 10 })).map((r) => r.content)).toEqual(["welcome"]), { timeout: 15_000 });
    release();
  });

  it("a restarted read pages down to the history stored before it, then stops", { timeout: 60_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const old = await Promise.all(Array.from({ length: 100 }, (_, i) => wrapChatAt(m, channel, alice, `old-${i}`, now - 200_000 + i)));
    const recent = await Promise.all(Array.from({ length: 300 }, (_, i) => wrapChatAt(m, channel, alice, `new-${i}`, now - 100_000 + i * 60)));
    const relay = new FakeRelay();
    relay.events = old;
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const ctx = { nostr: makePool({ [RELAY]: relay }), community, channel };
    await m.syncChannelRound(ctx, new AbortController().signal);

    // Later: 300 more posts, and a cursor whose addresses no longer match starts the read over.
    relay.events = [...old, ...recent];
    await m.updateStreamCursor(channel.idHex, { streams: "an-older-set" });
    relay.asked = [];
    await m.syncChannelRound(ctx, new AbortController().signal);

    const stored = await m.queryChannelRumors(CID, channel.idHex, { limit: 1000 });
    expect(stored.filter((r) => r.content.startsWith("new-"))).toHaveLength(300);
    // The newest page, then five pages of the stretch and the one that met stored history.
    expect(relay.asked.filter((f) => f.until !== undefined)).toHaveLength(6);
  });

  it("a restarted read over history the store already holds costs no more than a round's older pages", { timeout: 60_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = await Promise.all(Array.from({ length: 300 }, (_, i) => wrapChatAt(m, channel, alice, `h-${i}`, now - 100_000 + i * 60)));
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const ctx = { nostr: makePool({ [RELAY]: relay }), community, channel };
    for (let i = 0; i < 4; i++) await m.syncChannelRound(ctx, new AbortController().signal, { bridgePages: 20, olderPages: 20 });
    expect(await m.queryChannelRumors(CID, channel.idHex, { limit: 1000 })).toHaveLength(300);

    await m.updateStreamCursor(channel.idHex, { streams: "an-older-set" });
    relay.asked = [];
    await m.syncChannelRound(ctx, new AbortController().signal);
    expect(relay.asked.filter((f) => f.until !== undefined)).toHaveLength(2);
  });

  it("pages older history from two relays, two pages a round", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const history = await Promise.all(
      Array.from({ length: 300 }, (_, i) => wrapChatAt(m, channel, alice, `h-${i}`, now - 200_000 + i)),
    );
    const urls = ["wss://r1.test", "wss://r2.test", "wss://r3.test", "wss://r4.test"];
    const relays = Object.fromEntries(urls.map((u) => {
      const r = new FakeRelay();
      r.events = history;
      return [u, r];
    }));
    await m.updateStreamCursor(channel.idHex, { newest: now - 3_600, oldest: now - 199_700, streams: m.streamSetSig(channel) });
    m._trustCursorForTests(channel.idHex);
    const community = { idHex: CID, relays: urls } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool(relays), community, channel });

    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });
    const olderAsks = (u: string) => relays[u].asked.filter((f) => f.until !== undefined).length;
    expect(urls.map(olderAsks)).toEqual([2, 2, 0, 0]);
    release();
  });

  it("a round with no reachable relay marks the topic error, never fresh", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const relay = new FakeRelay();
    relay.fail = true;
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("error"), { timeout: 15_000 });
    expect(m.syncState(topic).lastSyncedAt).toBeUndefined();
    release();
  });

  it("a want without a registered context fails the run instead of stamping it fresh", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const topic = `c2:${"ee".repeat(32)}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("error"), { timeout: 15_000 });
    expect(m.syncState(topic).lastSyncedAt).toBeUndefined();
    release();
  });

  it("a released mount's teardown never clobbers a newer context for the same channel", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const relay = new FakeRelay();
    relay.events = [await wrapChatAt(m, channel, signer(), "hello", Math.floor(Date.now() / 1000) - 50)];
    const pool = makePool({ [RELAY]: relay });

    const releaseOld = m.setChannelSyncContext(channel.idHex, { nostr: pool, community, channel });
    const ctxNew = { nostr: pool, community, channel };
    m.setChannelSyncContext(channel.idHex, ctxNew);
    releaseOld();

    // The newer registration survives: a round now still finds its context.
    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });
    release();
  });

  it("a round aborted mid-history keeps the older pages it already stored", { timeout: 60_000 }, async () => {
    // A round is aborted whenever the reader leaves the channel, and an aborted
    // round is never stamped — so if `oldest` were saved only when a round
    // completes, every return to a deep channel would re-page the same history.
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const at = (i: number) => now - 200 + i;

    // 120 wraps: pass 1 takes the newest 50, pass 3's first page the next 50,
    // and its second page never answers until the round has been abandoned.
    let queries = 0;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    class StallingRelay extends FakeRelay {
      override async query(filters: Filter[]): Promise<NostrEvent[]> {
        if (++queries === 3) await blocked;
        return super.query(filters);
      }
    }
    const relay = new StallingRelay();
    relay.events = await Promise.all(Array.from({ length: 120 }, (_, i) => wrapChatAt(m, channel, alice, `m${i}`, at(i))));
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelSyncContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const topic = `c2:${channel.idHex}`;
    const release = m.want(topic);
    try {
      // The first older page has landed and been accounted for.
      await vi.waitFor(async () => expect((await m.readStreamCursor(channel.idHex))?.oldest).toBe(at(20)), { timeout: 30_000 });
      release();
      expect(m.syncState(topic).lastSyncedAt).toBeUndefined();
      const stored = await m.queryChannelRumors(CID, channel.idHex, { limit: 200 });
      expect(stored).toHaveLength(100);
    } finally {
      unblock();
    }
  });
});

describe("history coverage", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("reports the shallowest relay's frontier as covered, not the deepest page any relay returned", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    // Dense on one relay, sparse on the other: one page reaches t=51 on A but only t=510 on B.
    const dense = new FakeRelay();
    dense.events = await Promise.all(Array.from({ length: 100 }, (_, i) => wrapChatAt(m, channel, alice, `a${i}`, i + 1)));
    const sparse = new FakeRelay();
    sparse.events = await Promise.all(Array.from({ length: 100 }, (_, i) => wrapChatAt(m, channel, alice, `b${i}`, (i + 1) * 10)));
    const r = await m.backfillStore(makePool({ a: dense, b: sparse }), ["a", "b"], channel, new AbortController().signal, { maxPages: 1 });
    expect(r.oldest).toBe(51);
    expect(r.coveredDownTo).toBe(510);
  });

  it("a page the relays refuse with CLOSED is a failure, never the bottom of history", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const wraps = await Promise.all(Array.from({ length: 150 }, (_, i) => wrapChatAt(m, channel, alice, `h${i}`, i + 1)));
    const a = new RefusingRelay();
    const b = new RefusingRelay();
    a.events = wraps;
    b.events = wraps;
    // Both relays share the client's load, so both hit their cap on page two.
    a.refuse.add(1);
    b.refuse.add(1);
    const r = await m.backfillStore(makePool({ a, b }), ["a", "b"], channel, new AbortController().signal, { maxPages: 6 });
    expect(r.count).toBe(100); // page one from each relay
    expect(r.exhausted).toBe(false);
    expect(r.failed).toBe(true);
    expect(r.coveredDownTo).toBeUndefined();
  });

  it("fills an offline gap bigger than one round's budget across rounds, then advances newest", { timeout: 60_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const t0 = now - 10_000;
    const relay = new FakeRelay();
    relay.events = await Promise.all(Array.from({ length: 200 }, (_, i) => wrapChatAt(m, channel, alice, `g${i}`, t0 + 1 + i)));
    await m.updateStreamCursor(channel.idHex, { newest: t0, oldest: t0 - 1_000, exhausted: true, streams: m.streamSetSig(channel) });
    m._trustCursorForTests(channel.idHex);
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const ctx = { nostr: makePool({ [RELAY]: relay }), community, channel };
    const tiny = { bridgePages: 1, olderPages: 0 };

    for (let round = 0; round < 6; round++) {
      await m.syncChannelRound(ctx, new AbortController().signal, tiny);
      if ((await m.readStreamCursor(channel.idHex))?.newest !== t0) break;
    }
    const cursor = await m.readStreamCursor(channel.idHex);
    expect(cursor?.newest).toBe(t0 + 200);
    expect(cursor?.bridge).toBeUndefined();
    expect(await m.queryChannelRumors(CID, channel.idHex, { limit: 500 })).toHaveLength(200);
  });

  it("never takes a cursor from a wrap that didn't open, however far ahead it is dated", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    const real = await Promise.all([0, 1, 2].map((i) => wrapChatAt(m, channel, alice, `r${i}`, now - 100 + i)));
    // Wrap signatures go unchecked, so a relay can serve anything "by" the stream key.
    const junk = finalizeEvent(
      { kind: 1059, content: "not a seal", tags: [], created_at: 2 ** 31 - 1 },
      channel.current.group.sk,
    );
    relay.events = [...real, junk];
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const ctx = { nostr: makePool({ [RELAY]: relay }), community, channel };

    const outcome = await m.syncChannelRound(ctx, new AbortController().signal);
    expect((await m.readStreamCursor(channel.idHex))?.newest).toBe(now - 98);
    expect(outcome.mostlyUnopened).toBe(false);
    expect(await m.queryChannelRumors(CID, channel.idHex, { limit: 10 })).toHaveLength(3);
  });

  it("a round that fetched only wraps that won't open is not requeued at once", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = Array.from({ length: 5 }, (_, i) =>
      finalizeEvent({ kind: 1059, content: `junk-${i}`, tags: [], created_at: now - i }, channel.current.group.sk));
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const outcome = await m.syncChannelRound(
      { nostr: makePool({ [RELAY]: relay }), community, channel },
      new AbortController().signal,
    );
    expect(outcome.mostlyUnopened).toBe(true);
    expect((await m.readStreamCursor(channel.idHex))?.newest || undefined).toBeUndefined();
  });

  it("the background walk reads a never-opened channel to the bottom and seals it", { timeout: 60_000 }, async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = await Promise.all(Array.from({ length: 150 }, (_, i) => wrapChatAt(m, channel, alice, `w${i}`, now - 5_000 + i)));
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    m.setChannelHistoryContext(channel.idHex, { nostr: makePool({ [RELAY]: relay }), community, channel });

    const bus = await import("@/wire/bus");
    const rings: string[] = [];
    const off = bus.onWireScopes((scopes) => rings.push(...scopes));
    const topic = `c2hist:${channel.idHex}`;
    const release = m.want(topic, "prefetch");
    try {
      await vi.waitFor(async () => expect((await m.readStreamCursor(channel.idHex))?.exhausted).toBe(true), { timeout: 30_000 });
      expect(await m.queryChannelRumors(CID, channel.idHex, { limit: 500 })).toHaveLength(150);
      // The open timeline hears every throttled page; the community-wide
      // readers still hear the channel changed, on their own slower floor.
      expect(rings).toContain(`c2old:${channel.idHex}`);
      expect(rings).toContain(`c2:${channel.idHex}`);
    } finally {
      off();
      release();
    }
  });
});

describe("channelFilters (retired-epoch fetch policy)", () => {
  it("asks every held epoch until frozen, then drops retired addresses", async () => {
    const m = await freshModules();
    const channel = makeChannel(m);
    const oldGroup = m.channelGroupKey(root, channel.id, 5);
    const withRetired: Channel = {
      ...channel,
      streams: [channel.current, { epoch: 5n, group: oldGroup, retiredAt: 500 }],
    };

    // ONE filter across every held epoch (CORD-03 §3), so the caller's single
    // per-relay `until` cursor stays a sound frontier. Splitting live from
    // retired and capping the retired half would skip the live region below
    // the cap on any page where both halves came back full.
    expect(m.channelFilters(withRetired, { limit: 50 })).toEqual([
      { kinds: [1059], authors: [channel.current.group.pk, oldGroup.pk], limit: 50 },
    ]);

    // Paging and the bridge pass apply to that one filter uniformly — no
    // filter can be handed a `since` above its own `until`.
    expect(m.channelFilters(withRetired, { limit: 50, cursor: 300, since: 100 })).toEqual([
      { kinds: [1059], authors: [channel.current.group.pk, oldGroup.pk], limit: 50, until: 300, since: 100 },
    ]);

    // FROZEN (history swept to exhaustion): the retired address leaves the
    // author set entirely — the only spam-proof filter dimension is not asking.
    expect(m.channelFilters(withRetired, { limit: 50, freezeRetired: true })).toEqual([
      { kinds: [1059], authors: [channel.current.group.pk], limit: 50 },
    ]);
  });
});
