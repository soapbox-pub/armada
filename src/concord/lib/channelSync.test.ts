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
import { channelWriteGroup } from "@/concord/lib/community";

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
    isAnnouncement: false,
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
  const seal = await m.sealRumor(rumor, KIND_SEAL_ENCRYPTED, channelWriteGroup(channel), s);
  const w = m.wrapSeal(seal, channelWriteGroup(channel));
  return finalizeEvent(
    { kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt },
    channelWriteGroup(channel).sk,
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

  async query(filters: Filter[]): Promise<NostrEvent[]> {
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
    const cursor = await m.readChannelCursor(channel.idHex);
    // Pass 1 read everything (short page, no failures), so `newest` sealed at
    // the top; the older pass came back empty, which is inconclusive — never
    // recorded as exhaustion.
    expect(cursor?.newest).toBe(now - 98);
    expect(cursor?.exhausted).toBe(false);
    expect(m.syncState(topic).lastSyncedAt).toBeTypeOf("number");
    release();
  });

  it("rings the channel's bus scope even when the round decrypts nothing", { timeout: 30_000 }, async () => {
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
      await vi.waitFor(() => expect(rings).toContain(topic), { timeout: 15_000 });
    } finally {
      off();
      release();
    }
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
      { kinds: [1059], authors: [channelWriteGroup(channel).pk, oldGroup.pk], limit: 50 },
    ]);

    // Paging and the bridge pass apply to that one filter uniformly — no
    // filter can be handed a `since` above its own `until`.
    expect(m.channelFilters(withRetired, { limit: 50, cursor: 300, since: 100 })).toEqual([
      { kinds: [1059], authors: [channelWriteGroup(channel).pk, oldGroup.pk], limit: 50, until: 300, since: 100 },
    ]);

    // FROZEN (history swept to exhaustion): the retired address leaves the
    // author set entirely — the only spam-proof filter dimension is not asking.
    expect(m.channelFilters(withRetired, { limit: 50, freezeRetired: true })).toEqual([
      { kinds: [1059], authors: [channelWriteGroup(channel).pk], limit: 50 },
    ]);
  });
});
