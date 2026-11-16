/**
 * syncCommunityList — the §8 fragment sync's write half: the reconcile.
 *
 * Seeding only covers an account whose fragment read is CONFIRMED empty. The
 * migration population this guards is the other half: an account whose Vector
 * client already seeded kind-33302 from ITS holds, while this device's
 * memberships were recorded under the retired single-event list and exist only
 * in the folded cache. The wire is non-empty, so the seed never fires — and
 * with no membership edit left to make, nothing else would ever publish them
 * (CORD-02 §8's stranding trap). The reconcile publishes the union whenever a
 * COMPLETE read yields different bytes than the wire, and stays silent once
 * converged.
 */

import { Buffer } from "node:buffer";

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunityList, CommunityListEntry, JoinMaterial } from "@/concord/lib/communityList";
import { isLive } from "@/concord/lib/communityList";
import { fragment, parseFragList, serializeFragList, type FragList } from "@/concord/lib/listFrag";
import { KIND_COMMUNITY_LIST_FRAG } from "@/concord/lib/kinds";
import { STOCK_RELAYS } from "@/concord/lib/stockRelays";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { NUser } from "@nostrify/react/login";
import type { NostrRelayCLOSED, NostrRelayEOSE } from "@nostrify/types";

const h = vi.hoisted(() => ({
  readFolded: vi.fn(),
  writeFolded: vi.fn(),
}));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));
vi.mock("@/lib/publishOutbox", () => ({
  queueSignedEvent: vi.fn(async () => undefined),
  recordQueuedPublishAttempt: vi.fn(async () => undefined),
}));

const SELF = "ab".repeat(32);
const b64of = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

/** Reversible fake NIP-44: ciphertext is `enc:` + plaintext. */
const nip44 = {
  encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
  decrypt: async (_pk: string, ciphertext: string) => {
    if (!ciphertext.startsWith("enc:")) throw new Error("bad ciphertext");
    return ciphertext.slice(4);
  },
};

let idCounter = 0;
/** Globally unique ids — the fragment decrypt memo is module-level. */
const nextId = () => `${(++idCounter).toString(16).padStart(8, "0")}`.padEnd(64, "e");

const user = {
  pubkey: SELF,
  signer: {
    nip44,
    signEvent: async (t: { kind: number; content: string; tags: string[][]; created_at: number }) => ({
      ...t,
      id: nextId(),
      pubkey: SELF,
      sig: "f".repeat(128),
    }),
  },
} as unknown as NUser;

function jm(cidByte: string, name: string): JoinMaterial {
  return {
    community_id: cidByte.repeat(32),
    owner: "11".repeat(32),
    owner_salt: "22".repeat(32),
    community_root: "33".repeat(32),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.example.com"],
    name,
  };
}

function entry(cidByte: string, name: string): CommunityListEntry {
  const m = jm(cidByte, name);
  return { community_id: m.community_id, seed: structuredClone(m), current: m, added_at: 1_719_800_000_000 };
}

function fragEvent(frag: FragList, index: number, createdAt = 1_722_000_000): NostrRumor {
  return {
    id: nextId(),
    pubkey: SELF,
    kind: KIND_COMMUNITY_LIST_FRAG,
    content: `enc:${serializeFragList(frag)}`,
    tags: [["d", String(index)]],
    created_at: createdAt,
  } as NostrRumor;
}

function fakeNostr(wire: NostrRumor[], hardLimit?: number) {
  const published: NostrRumor[] = [];
  const queryWire = async (filters: Array<{ kinds?: number[]; "#d"?: string[] }>) => {
    const matching = wire.filter((event) => filters.some((filter) =>
      (!filter.kinds || filter.kinds.includes(event.kind))
      && (!filter["#d"] || filter["#d"]!.includes(
        event.tags.find(([name]) => name === "d")?.[1] ?? "",
      )),
    ));
    return hardLimit ? matching.slice(0, hardLimit) : matching;
  };
  return {
    published,
    nostr: {
      query: queryWire,
      group: () => ({ query: async () => [] as NostrRumor[] }),
      relay: (url: string) => ({
        query: queryWire,
        event: async (event: NostrRumor) => {
          // Capture one copy of a fan-out publish, not one per destination.
          if (url.includes("self.example")) published.push(event);
        },
      }),
    },
  };
}

async function runSync(wire: NostrRumor[], localList: CommunityList | undefined) {
  const { syncCommunityList } = await import("./useCommunityList");
  h.readFolded.mockImplementation(async (key: string) =>
    key.startsWith("concord2-list:") && localList ? { event: null, list: localList } : undefined,
  );
  const { published, nostr } = fakeNostr(wire);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data = await syncCommunityList(nostr, user, queryClient, undefined, ["wss://self.example.com"]);
  return { data, published };
}

beforeEach(async () => {
  (await import("./useCommunityList"))._resetReconcilePublishClock();
  h.readFolded.mockReset();
  h.writeFolded.mockReset().mockResolvedValue(undefined);
});

describe("syncCommunityList — reconcile", () => {
  /**
   * Relays that each answer the list read with their own copy, and record what
   * is published to them. `hideFuture`: Ditto-family relays leave events dated
   * after now out of query results, while still accepting and broadcasting them.
   */
  function perRelayNostr(copies: Record<string, NostrRumor[]>, hideFuture: string[] = []) {
    const published: Array<{ url: string; event: NostrRumor }> = [];
    return {
      published,
      nostr: {
        query: async () => [] as NostrRumor[],
        group: () => ({ query: async () => [] as NostrRumor[] }),
        relay: (url: string) => ({
          query: async (filters: Array<{ kinds?: number[] }>) => {
            const now = Math.floor(Date.now() / 1000);
            const held = [...(copies[url] ?? []), ...published.filter((p) => p.url === url).map((p) => p.event)]
              .filter((e) => filters.some((f) => !f.kinds || f.kinds.includes(e.kind)));
            return hideFuture.includes(url) ? held.filter((e) => e.created_at <= now) : held;
          },
          event: async (event: NostrRumor) => { published.push({ url, event }); },
        }),
      },
    };
  }

  it("does not chase an edition a relay hides for being dated ahead of the clock", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const list: CommunityList = { entries: [entry("aa", "Joined")], tombstones: [] };
    const [frag] = fragment(structuredClone(list));
    const ahead = fragEvent(frag, 0, Math.floor(Date.now() / 1000) + 35);
    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-list:") ? { event: null, list: structuredClone(list) } : undefined,
    );
    const self = "wss://self.example.com";
    const copies: Record<string, NostrRumor[]> = { [self]: [ahead] };
    for (const url of STOCK_RELAYS) copies[url] = [ahead];
    const { nostr, published } = perRelayNostr(copies, [self]);

    const data = await syncCommunityList(nostr, user, new QueryClient(), undefined, [self]);

    expect(published).toEqual([]);
    expect(data.repairPending).toBe(true);
  });

  it("publishes a reconcile at most once a minute however often it re-runs", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const list: CommunityList = { entries: [entry("aa", "Joined")], tombstones: [] };
    const [frag] = fragment(structuredClone(list));
    const old = fragEvent(frag, 0, 1_722_000_000);
    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-list:") ? { event: null, list: structuredClone(list) } : undefined,
    );
    const self = "wss://self.example.com";
    const stale = "wss://stale.example.com";
    const copies: Record<string, NostrRumor[]> = { [self]: [old] };
    for (const url of STOCK_RELAYS) copies[url] = [old];
    // A relay that answers but never shows what it was sent.
    const { nostr, published } = perRelayNostr(copies, []);
    const blind = {
      ...nostr,
      relay: (url: string) => url === stale
        ? { query: async () => [] as NostrRumor[], event: async (event: NostrRumor) => { published.push({ url, event }); } }
        : nostr.relay(url),
    };

    for (let i = 0; i < 5; i++) {
      await syncCommunityList(blind, user, new QueryClient(), undefined, [self, stale]);
    }

    expect(published.filter((p) => p.url === stale)).toHaveLength(1);
  });

  it("doubles the spacing between reconciles a relay never confirms, and resets once converged", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const list: CommunityList = { entries: [entry("aa", "Joined")], tombstones: [] };
    const [frag] = fragment(structuredClone(list));
    const old = fragEvent(frag, 0, 1_722_000_000);
    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-list:") ? { event: null, list: structuredClone(list) } : undefined,
    );
    const self = "wss://self.example.com";
    const stale = "wss://stale.example.com";
    const copies: Record<string, NostrRumor[]> = { [self]: [old] };
    for (const url of STOCK_RELAYS) copies[url] = [old];
    const { nostr, published } = perRelayNostr(copies, []);
    let blind = true;
    const relay = {
      ...nostr,
      relay: (url: string) => url === stale && blind
        ? { query: async () => [] as NostrRumor[], event: async (event: NostrRumor) => { published.push({ url, event }); } }
        : nostr.relay(url),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const sentToStaleAt: number[] = [];
    try {
      // One sync a minute for 30 minutes.
      for (let minute = 0; minute <= 30; minute++) {
        vi.setSystemTime(start + minute * 60_000);
        const before = published.filter((p) => p.url === stale).length;
        await syncCommunityList(relay, user, new QueryClient(), undefined, [self, stale]);
        if (published.filter((p) => p.url === stale).length > before) sentToStaleAt.push(minute);
      }
      expect(sentToStaleAt).toEqual([0, 1, 3, 7, 15]);

      // The relay starts holding what it is sent: the wire converges and the next
      // stale read is answered at once.
      blind = false;
      vi.setSystemTime(start + 31 * 60_000);
      await syncCommunityList(relay, user, new QueryClient(), undefined, [self, stale]);
      blind = true;
      const before = published.filter((p) => p.url === stale).length;
      vi.setSystemTime(start + 32 * 60_000);
      await syncCommunityList(relay, user, new QueryClient(), undefined, [self, stale]);
      expect(published.filter((p) => p.url === stale).length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signs an update when every explicit community-list source fails", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const signEvent = vi.fn(user.signer.signEvent.bind(user.signer));
    const guardedUser = {
      ...user,
      signer: { ...user.signer, signEvent },
    } as NUser;
    const relayEvent = vi.fn();
    const offline = {
      query: vi.fn(async () => []),
      relay: () => ({
        query: vi.fn(async () => { throw new Error("offline"); }),
        event: relayEvent,
      }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await expect(updateCommunityList(
      offline,
      guardedUser,
      queryClient,
      ["wss://self.example.com"],
      { type: "add", entry: entry("aa", "Offline join") },
    )).rejects.toThrow(/an account-state relay/i);

    expect(signEvent).not.toHaveBeenCalled();
    expect(relayEvent).not.toHaveBeenCalled();
  });

  it("does not fall back to an older readable fragment when the coordinate head is unreadable", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const [oldFrag] = fragment({ entries: [entry("aa", "Old readable")], tombstones: [] });
    const older = fragEvent(oldFrag, 0, 100);
    const unreadableHead = { ...fragEvent(oldFrag, 0, 101), content: "not-our-ciphertext" };
    const relayEvent = vi.fn();
    const nostr = {
      query: vi.fn(async () => []),
      relay: () => ({
        query: vi.fn(async () => [older, unreadableHead]),
        event: relayEvent,
      }),
    };

    await expect(updateCommunityList(
      nostr,
      user,
      new QueryClient(),
      ["wss://self.example.com"],
      { type: "add", entry: entry("bb", "Must not publish") },
    )).rejects.toThrow(/decryption failed/i);
    expect(relayEvent).not.toHaveBeenCalled();
  });

  it("uses the readable head for ordering while CRDT-unioning richer older relay editions", async () => {
    const { decodeCommunityListFragments } = await import("./useCommunityList");
    const [olderFrag] = fragment({
      entries: [entry("aa", "Recovered from lagging relay")],
      tombstones: [{ community_id: "cc".repeat(32), removed_at: 1_800_000_000_000 }],
    });
    const [newerFrag] = fragment({
      entries: [entry("bb", "Newer partial head")],
      tombstones: [],
    });
    const older = { ...fragEvent(olderFrag, 0, 100), id: "c".repeat(64) };
    const head = { ...fragEvent(newerFrag, 0, 101), id: "b".repeat(64) };

    const decoded = await decodeCommunityListFragments([head, older], user);

    expect(decoded.unreadable).toBe(false);
    expect(decoded.set?.winningEvents.get(0)?.id).toBe(head.id);
    expect(decoded.set?.createdAt.get(0)).toBe(101);
    expect(decoded.set?.readFrags.get(0)).toEqual(newerFrag);
    expect(decoded.set?.list.entries.map((item) => item.community_id).sort()).toEqual([
      "aa".repeat(32),
      "bb".repeat(32),
    ]);
    expect(decoded.set?.list.tombstones.map((item) => item.community_id)).toEqual([
      "cc".repeat(32),
    ]);
  });

  it("publishes a fresh CRDT rewrite only to relays that completed its base read", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const unavailable = STOCK_RELAYS[0]!;
    const delivered: string[] = [];
    const nostr = {
      query: vi.fn(async () => []),
      relay: (url: string) => ({
        query: vi.fn(async () => {
          if (url === unavailable) throw new Error("offline");
          return [];
        }),
        event: vi.fn(async () => { delivered.push(url); }),
      }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await updateCommunityList(
      nostr,
      user,
      queryClient,
      ["wss://self.example.com"],
      { type: "add", entry: entry("aa", "Safe join") },
    );

    expect(delivered).toContain("wss://self.example.com");
    expect(delivered).not.toContain(unavailable);
    for (const relay of STOCK_RELAYS.slice(1)) expect(delivered).toContain(relay);
  });

  it("publishes through a client whose relay() needs its own receiver", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const delivered: string[] = [];
    // The real client is a NostrBatcher INSTANCE, where `relay` is a method
    // reading `this.pool`. Every other double in this file is an object literal
    // of standalone functions, which cannot catch a lost receiver — so this one
    // is a class, and its `relay` fails the same way the batcher's does when
    // the method is copied off the instance.
    class MethodClient {
      private pool = {
        relay: (url: string) => ({
          query: async () => [] as NostrRumor[],
          event: async () => { delivered.push(url); },
        }),
      };
      async query() { return [] as NostrRumor[]; }
      relay(url: string) { return this.pool.relay(url); }
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await updateCommunityList(
      new MethodClient(),
      user,
      queryClient,
      ["wss://self.example.com"],
      { type: "add", entry: entry("aa", "Receiver-bound join") },
    );

    expect(delivered).toContain("wss://self.example.com");
  });

  it("keeps a joined community folded and visible when every delivery is queued", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const nostr = {
      query: vi.fn(async () => []),
      relay: () => ({
        query: vi.fn(async () => []),
        event: vi.fn(async () => { throw new Error("offline after EOSE"); }),
      }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await expect(updateCommunityList(
      nostr,
      user,
      queryClient,
      ["wss://self.example.com"],
      { type: "add", entry: entry("aa", "Joined; sync pending") },
    )).resolves.toMatchObject({
      entries: [expect.objectContaining({ community_id: "aa".repeat(32) })],
    });

    expect(queryClient.getQueryData<{ list: CommunityList }>(["concord", "list", SELF])?.list.entries)
      .toEqual([expect.objectContaining({ community_id: "aa".repeat(32) })]);
    expect(h.writeFolded).toHaveBeenCalledWith(
      `concord2-list:${SELF}`,
      expect.objectContaining({
        list: expect.objectContaining({
          entries: [expect.objectContaining({ community_id: "aa".repeat(32) })],
        }),
      }),
    );
  });

  it("automatically backfills only a returning relay's stale or missing coordinates", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const relayA = "wss://state-a.example.com";
    const relayB = "wss://state-b.example.com";
    const current: CommunityList = { entries: [entry("aa", "Current")], tombstones: [] };
    const [currentFrag] = fragment(current);
    const headA = fragEvent(currentFrag, 0, 100);
    let relayBOnline = false;
    let headB: NostrRumor | undefined;
    const deliveries: Array<{ url: string; event: NostrRumor }> = [];

    // Keep this test on the fragmented-list path; the retired-list rescue is
    // orthogonal and would add another query round to the relay trace.
    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-retired-list-rescued:") ? true : undefined,
    );
    const nostr = {
      query: vi.fn(async () => [] as NostrRumor[]),
      relay: (url: string) => ({
        query: vi.fn(async (filters: Array<{ kinds?: number[] }>) => {
          if (!filters.some((filter) => filter.kinds?.includes(KIND_COMMUNITY_LIST_FRAG))) return [];
          if (url === relayB) {
            if (!relayBOnline) throw new Error("temporarily unavailable");
            return headB ? [headB] : [];
          }
          return [headA];
        }),
        event: vi.fn(async (event: NostrRumor) => {
          deliveries.push({ url, event });
          if (url === relayB) headB = event;
        }),
      }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const first = await syncCommunityList(
      nostr,
      user,
      queryClient,
      undefined,
      [relayA, relayB],
    );
    expect(first.repairPending).toBe(true);
    expect(deliveries).toHaveLength(0);

    // This is the refetch the hook's repairPending interval drives. A's
    // aggregate-current head must no longer conceal B's confirmed-empty read.
    relayBOnline = true;
    const repaired = await syncCommunityList(
      nostr,
      user,
      queryClient,
      undefined,
      [relayA, relayB],
    );

    expect(deliveries.map(({ url }) => url)).toEqual([relayB]);
    expect(new Set(deliveries.map(({ event }) => event.id)).size).toBe(1);
    expect(parseFragList(deliveries[0]!.event.content.slice(4)).entries.map((item) => item.community_id))
      .toEqual([b64of("aa".repeat(32))]);
    // One read-back stays armed after EVENT acceptance. Once B exposes the
    // exact head, the automatic interval can stop without another publish.
    expect(repaired.repairPending).toBe(true);
    deliveries.length = 0;
    const confirmed = await syncCommunityList(
      nostr,
      user,
      queryClient,
      undefined,
      [relayA, relayB],
    );
    expect(deliveries).toHaveLength(0);
    expect(confirmed.repairPending).toBe(false);
  });

  it("merges a returning relay's richer state before writing any answered relay", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const relayA = "wss://state-a.example.com";
    const relayB = "wss://state-b.example.com";
    const [headAFrag] = fragment({ entries: [entry("aa", "Held by A")], tombstones: [] });
    const [headBFrag] = fragment({ entries: [entry("bb", "Recovered from B")], tombstones: [] });
    const headA = fragEvent(headAFrag, 0, 100);
    const headB = fragEvent(headBFrag, 0, 101);
    let relayBOnline = false;
    const operations: string[] = [];
    const deliveries: Array<{ url: string; event: NostrRumor }> = [];

    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-retired-list-rescued:") ? true : undefined,
    );
    const nostr = {
      query: vi.fn(async () => [] as NostrRumor[]),
      relay: (url: string) => ({
        query: vi.fn(async (filters: Array<{ kinds?: number[] }>) => {
          if (!filters.some((filter) => filter.kinds?.includes(KIND_COMMUNITY_LIST_FRAG))) return [];
          operations.push(`query:${url}`);
          if (url === relayB) {
            if (!relayBOnline) throw new Error("temporarily unavailable");
            return [headB];
          }
          return [headA];
        }),
        event: vi.fn(async (event: NostrRumor) => {
          operations.push(`event:${url}`);
          deliveries.push({ url, event });
        }),
      }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await syncCommunityList(nostr, user, queryClient, undefined, [relayA, relayB]);
    expect(deliveries).toHaveLength(0);
    operations.length = 0;
    relayBOnline = true;

    await syncCommunityList(nostr, user, queryClient, undefined, [relayA, relayB]);

    expect(operations.indexOf(`query:${relayB}`)).toBeLessThan(
      operations.findIndex((operation) => operation.startsWith("event:")),
    );
    expect(deliveries.some(({ url }) => url === relayA)).toBe(true);
    expect(deliveries.some(({ url }) => url === relayB)).toBe(true);
    // One canonical signed coordinate fans to every stale relay; none receives
    // A's stale snapshot before B's disjoint fact has joined the CRDT union.
    expect(new Set(deliveries.map(({ event }) => event.id)).size).toBe(1);
    for (const { event } of deliveries) {
      expect(parseFragList(event.content.slice(4)).entries.map((item) => item.community_id).sort())
        .toEqual([b64of("aa".repeat(32)), b64of("bb".repeat(32))].sort());
    }
  });

  it("merges a returning relay's richer tombstone before ever writing back to it", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const returning = STOCK_RELAYS[0]!;
    const tombstone = fragEvent({
      frags: 1,
      entries: [],
      tombstones: [{
        community_id: b64of("aa".repeat(32)),
        removed_at: 1_800_000_000_000,
        extra: {},
      }],
      extra: {},
    }, 0, 1_722_000_100);
    let round = 1;
    const delivered: Array<{ round: number; url: string; event: NostrRumor }> = [];
    const nostr = {
      query: vi.fn(async () => []),
      relay: (url: string) => ({
        query: vi.fn(async () => {
          if (url !== returning) return [];
          if (round === 1) throw new Error("offline");
          return [tombstone];
        }),
        event: vi.fn(async (event: NostrRumor) => { delivered.push({ round, url, event }); }),
      }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await updateCommunityList(
      nostr,
      user,
      queryClient,
      ["wss://self.example.com"],
      { type: "add", entry: entry("aa", "Joined while rescue was offline") },
    );
    expect(delivered.some((delivery) => delivery.round === 1 && delivery.url === returning)).toBe(false);

    round = 2;
    await updateCommunityList(
      nostr,
      user,
      queryClient,
      ["wss://self.example.com"],
      { type: "add", entry: entry("bb", "Second join") },
    );

    const rewritten = delivered.find((delivery) =>
      delivery.round === 2 && delivery.url === returning)?.event;
    expect(rewritten).toBeDefined();
    const decoded = parseFragList(rewritten!.content.slice(4));
    expect(decoded.entries.map((item) => item.community_id)).not.toContain(b64of("aa".repeat(32)));
    expect(decoded.tombstones.map((item) => item.community_id)).toContain(b64of("aa".repeat(32)));
  });

  describe("a replayed add (a pending join settled after its click)", () => {
    const CLICK = 1_719_800_000_000;
    const replay = async (wireList: CommunityList, cached?: CommunityList) => {
      const { updateCommunityList, listQueryKey } = await import("./useCommunityList");
      const { published, nostr } = fakeNostr(fragment(wireList).map((f, i) => fragEvent(f, i)));
      const queryClient = new QueryClient();
      if (cached) queryClient.setQueryData(listQueryKey(SELF), { event: null, list: cached });
      const list = await updateCommunityList(
        nostr,
        user,
        queryClient,
        ["wss://self.example.com"],
        { type: "add", entry: { ...entry("aa", "Clicked"), added_at: CLICK }, replay: true },
      );
      return { list, published };
    };

    it("publishes nothing over a Leave taken after the click", async () => {
      const { list, published } = await replay({
        entries: [entry("bb", "Other")],
        tombstones: [{ community_id: "aa".repeat(32), removed_at: CLICK + 60_000 }],
      });
      expect(published).toHaveLength(0);
      expect(isLive(list, "aa".repeat(32))).toBe(false);
    });

    it("honors a removal held only locally (a kick not yet on the wire)", async () => {
      const { list, published } = await replay(
        { entries: [entry("bb", "Other")], tombstones: [] },
        { entries: [], tombstones: [{ community_id: "aa".repeat(32), removed_at: CLICK + 1 }] },
      );
      expect(published).toHaveLength(0);
      expect(isLive(list, "aa".repeat(32))).toBe(false);
    });

    it("publishes nothing when the earlier run's write already landed", async () => {
      const { list, published } = await replay({ entries: [{ ...entry("aa", "Clicked"), added_at: CLICK }], tombstones: [] });
      expect(published).toHaveLength(0);
      expect(isLive(list, "aa".repeat(32))).toBe(true);
    });

    it("writes a join that predates the only removal, dated by its click", async () => {
      const { list, published } = await replay({
        entries: [entry("bb", "Other")],
        tombstones: [{ community_id: "aa".repeat(32), removed_at: CLICK - 60_000 }],
      });
      expect(published.length).toBeGreaterThan(0);
      expect(isLive(list, "aa".repeat(32))).toBe(true);
      expect(list.entries.find((e) => e.community_id === "aa".repeat(32))?.added_at).toBe(CLICK);
    });
  });

  it("bases a mutation on a newer ArmadaDB fragment even when reachable wire is stale", async () => {
    const { updateCommunityList } = await import("./useCommunityList");
    const [staleFrag] = fragment({
      entries: [entry("aa", "Stale wire fact")],
      tombstones: [],
    });
    const [localFrag] = fragment({
      entries: [entry("bb", "Newer local fact")],
      tombstones: [],
    });
    const stale = fragEvent(staleFrag, 0, 100);
    // Deliberately unsigned: ArmadaDB rumors are valid CRDT/timestamp input,
    // but must never be treated as exact bytes suitable for mirroring.
    const local = fragEvent(localFrag, 0, 101);
    const delivered: NostrRumor[] = [];
    const nostr = {
      query: vi.fn(async () => []),
      relay: () => ({
        query: vi.fn(async () => [stale]),
        event: vi.fn(async (wireEvent: NostrRumor) => { delivered.push(wireEvent); }),
      }),
    };

    await updateCommunityList(
      nostr,
      user,
      new QueryClient(),
      ["wss://self.example"],
      { type: "add", entry: entry("cc", "New action") },
      [local],
    );

    const decoded = parseFragList(delivered[0]!.content.slice(4));
    expect(decoded.entries.map((item) => item.community_id).sort()).toEqual([
      b64of("aa".repeat(32)),
      b64of("bb".repeat(32)),
      b64of("cc".repeat(32)),
    ].sort());
    expect(delivered[0]!.created_at).toBeGreaterThan(101);
  });

  it("repairs stale wire when a newer ArmadaDB snapshot already equals the desired union", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const staleList: CommunityList = {
      entries: [entry("aa", "Already on wire")],
      tombstones: [],
    };
    const localList: CommunityList = {
      entries: [
        entry("aa", "Already on wire"),
        entry("bb", "Only in ArmadaDB"),
      ],
      tombstones: [],
    };
    const wire = fragment(staleList).map((frag, index) => fragEvent(frag, index, 100));
    const local = fragment(localList).map((frag, index) => fragEvent(frag, index, 101));
    const { published, nostr } = fakeNostr(wire);

    await syncCommunityList(
      nostr,
      user,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      undefined,
      ["wss://self.example.com"],
      local,
    );

    expect(published).toHaveLength(1);
    expect(published[0]!.created_at).toBeGreaterThan(101);
    const repaired = parseFragList(published[0]!.content.slice(4));
    expect(repaired.entries.map((item) => item.community_id).sort()).toEqual([
      b64of("aa".repeat(32)),
      b64of("bb".repeat(32)),
    ].sort());
  });

  it("keeps a leave taken during the retired-list read in the persisted list", async () => {
    const { syncCommunityList, listQueryKey } = await import("./useCommunityList");
    const cid = "aa".repeat(32);
    const wire = fragment({ entries: [entry("aa", "Left mid-sync")], tombstones: [] }).map((f, i) => fragEvent(f, i));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const before: CommunityList = { entries: [entry("aa", "Left mid-sync")], tombstones: [] };
    queryClient.setQueryData(listQueryKey(SELF), { event: null, list: before, decryptFailed: false });
    h.readFolded.mockResolvedValue(undefined);

    const { nostr } = fakeNostr(wire);
    const queryWire = nostr.relay("wss://self.example.com").query;
    // The user leaves while the retired-list rescue is on the network: the
    // leave tombstones the query cache (removeCommunityLocally).
    const racing = {
      ...nostr,
      relay: (url: string) => ({
        ...nostr.relay(url),
        query: async (filters: Array<{ kinds?: number[] }>) => {
          if (filters.some((f) => f.kinds?.includes(13302))) {
            queryClient.setQueryData(listQueryKey(SELF), {
              event: null,
              list: { entries: before.entries, tombstones: [{ community_id: cid, removed_at: Date.now() }] },
              decryptFailed: false,
            });
          }
          return queryWire(filters);
        },
      }),
    };

    const data = await syncCommunityList(racing, user, queryClient, undefined, ["wss://self.example.com"]);

    expect(isLive(data.list, cid)).toBe(false);
    const persisted = h.writeFolded.mock.calls
      .filter(([key]) => String(key).startsWith("concord2-list:"))
      .map(([, value]) => (value as { list: CommunityList }).list);
    expect(persisted.length).toBeGreaterThan(0);
    for (const list of persisted) expect(isLive(list, cid)).toBe(false);
  });

  it("publishes the union when the folded cache holds memberships the wire lacks", async () => {
    // Vector seeded §8 from ITS holds (community B only); this device recorded
    // A under the retired single-event list. The union must reach the wire
    // without waiting for a membership edit that may never come.
    const wire = fragment({ entries: [entry("bb", "From Vector")], tombstones: [] }).map((f, i) => fragEvent(f, i));
    const local: CommunityList = { entries: [entry("aa", "From Old Armada"), entry("bb", "From Vector")], tombstones: [] };

    const { data, published } = await runSync(wire, local);

    expect(isLive(data.list, "aa".repeat(32))).toBe(true);
    expect(isLive(data.list, "bb".repeat(32))).toBe(true);
    expect(published.length).toBeGreaterThan(0);
    const republished = parseFragList(published[0].content.slice(4));
    const cids = republished.entries.map((e) => e.community_id);
    expect(cids).toContain(b64of("aa".repeat(32)));
    expect(cids).toContain(b64of("bb".repeat(32)));
    // Nothing re-stamped: the local entry keeps its own added_at.
    expect(republished.entries.every((e) => e.added_at === 1_719_800_000_000)).toBe(true);
  });

  it("seeds only the answered stock cohort when one public rescue relay is offline", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const unavailable = STOCK_RELAYS[0]!;
    const local: CommunityList = { entries: [entry("aa", "Legacy local")], tombstones: [] };
    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-list:") ? { event: null, list: local } : undefined,
    );
    const delivered: string[] = [];
    const nostr = {
      query: vi.fn(async () => []),
      relay: (url: string) => ({
        query: vi.fn(async () => {
          if (url === unavailable) throw new Error("offline");
          return [];
        }),
        event: vi.fn(async () => { delivered.push(url); }),
      }),
    };

    await syncCommunityList(nostr, user, new QueryClient(), undefined, []);

    expect(delivered).not.toContain(unavailable);
    for (const relay of STOCK_RELAYS.slice(1)) expect(delivered).toContain(relay);
  });

  it("defers seeding when a relay CLOSED the per-relay empty confirmation", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const local: CommunityList = { entries: [entry("aa", "Must not seed")], tombstones: [] };
    const run = async (refuseConfirm: boolean) => {
      h.readFolded.mockImplementation(async (key: string) =>
        key.startsWith("concord2-list:") ? { event: null, list: local } : undefined,
      );
      const delivered: string[] = [];
      const nostr = {
        query: vi.fn(async () => []),
        relay: (url: string) => ({
          query: vi.fn(async () => []),
          // `query()` resolves [] on a CLOSED; only `req()` can tell it apart.
          async *req(filters: Array<{ limit?: number }>): AsyncGenerator<NostrRelayEOSE | NostrRelayCLOSED> {
            if (refuseConfirm && filters.some((f) => f.limit === 1)) {
              yield ["CLOSED", "sub", "rate-limited: slow down"];
              return;
            }
            yield ["EOSE", "sub"];
          },
          event: vi.fn(async () => { delivered.push(url); }),
        }),
      };
      await syncCommunityList(nostr, user, new QueryClient(), undefined, ["wss://self.example.com"]);
      return delivered;
    };

    expect(await run(true)).toEqual([]);
    // Control: the same wire answering EOSE confirms the empty read and seeds.
    expect(await run(false)).toContain("wss://self.example.com");
  });

  it("defers legacy seeding when no authoritative retired-list rescue source answers", async () => {
    const { syncCommunityList } = await import("./useCommunityList");
    const local: CommunityList = { entries: [entry("aa", "Must not latch")], tombstones: [] };
    h.readFolded.mockImplementation(async (key: string) =>
      key.startsWith("concord2-list:") ? { event: null, list: local } : undefined,
    );
    const relayEvent = vi.fn();
    const nostr = {
      query: vi.fn(async () => []),
      relay: () => ({
        query: vi.fn(async () => { throw new Error("offline"); }),
        event: relayEvent,
      }),
    };

    await syncCommunityList(nostr, user, new QueryClient(), undefined, []);

    expect(relayEvent).not.toHaveBeenCalled();
    expect(h.writeFolded).not.toHaveBeenCalledWith(
      `concord2-list-seeded:${SELF}`,
      true,
    );
  });

  it("unifies a DISJOINT split — each client's communities survive, neither clobbers", async () => {
    // The partial-migration split: Vector knows only B, this Armada knows only
    // A. The outcome must be the union on both sides — A published for Vector
    // to adopt, B adopted here and republished byte-unchanged, nothing lost.
    const wire = fragment({ entries: [entry("bb", "Vector Only")], tombstones: [] }).map((f, i) => fragEvent(f, i));
    const local: CommunityList = { entries: [entry("aa", "Armada Only")], tombstones: [] };

    const { data, published } = await runSync(wire, local);

    expect(isLive(data.list, "aa".repeat(32))).toBe(true); // mine kept
    expect(isLive(data.list, "bb".repeat(32))).toBe(true); // theirs adopted
    expect(published.length).toBeGreaterThan(0);
    const republished = parseFragList(published[0].content.slice(4));
    const cids = republished.entries.map((e) => e.community_id);
    expect(cids).toContain(b64of("aa".repeat(32)));
    expect(cids).toContain(b64of("bb".repeat(32)));
    // The adopted entry rides byte-identically: same snapshot, same added_at —
    // adoption is never re-authored, so Vector's copy can't lose a tiebreak to
    // a mangled echo of itself.
    const theirs = republished.entries.find((e) => e.community_id === b64of("bb".repeat(32)));
    const original = fragment({ entries: [entry("bb", "Vector Only")], tombstones: [] })[0].entries[0];
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(original));
  });

  it("stays silent once converged — identical bytes publish nothing", async () => {
    const list: CommunityList = { entries: [entry("aa", "Same"), entry("bb", "Same2")], tombstones: [] };
    const wire = fragment(list).map((f, i) => fragEvent(f, i));

    const { data, published } = await runSync(wire, structuredClone(list));

    expect(isLive(data.list, "aa".repeat(32))).toBe(true);
    expect(published).toHaveLength(0);
  });

  it("a tombstone on the wire is honored, not resurrected by the old local copy", async () => {
    // The other client LEFT community A after this device's stale local copy
    // was written. The union keeps the tombstone; the reconcile must not
    // resurrect the membership (added_at is never re-stamped).
    const wireList: CommunityList = {
      entries: [entry("bb", "Kept")],
      tombstones: [{ community_id: "aa".repeat(32), removed_at: 1_722_000_000_000 }],
    };
    const wire = fragment(wireList).map((f, i) => fragEvent(f, i));
    const local: CommunityList = { entries: [entry("aa", "Left Elsewhere"), entry("bb", "Kept")], tombstones: [] };

    const { data, published } = await runSync(wire, local);

    expect(isLive(data.list, "aa".repeat(32))).toBe(false);
    for (const e of published) {
      const frag = parseFragList(e.content.slice(4));
      // The retired entry's snapshots stay off the wire; its tombstone rides.
      expect(frag.entries.map((x) => x.community_id)).not.toContain(b64of("aa".repeat(32)));
    }
  });

  it("a fragment declaring an insane frags count cannot wedge or crash the sync", async () => {
    // `frags` is wire-declared and only integer-checked: a corrupt fragment
    // declaring 2^40 must not allocate its way to a tab crash on every sync —
    // it reads as junk (incomplete → read-only), and the sync still returns.
    const [frag0] = fragment({ entries: [entry("bb", "Corrupt Count")], tombstones: [] });
    frag0.frags = 2 ** 40;
    const local: CommunityList = { entries: [entry("aa", "Local")], tombstones: [] };

    const { data, published } = await runSync([fragEvent(frag0, 0)], local);

    expect(isLive(data.list, "bb".repeat(32))).toBe(true); // still readable
    expect(published).toHaveLength(0); // never writable
  });

  it("a same-second collision uses the lowest-id head while CRDT-merging every readable edition", async () => {
    const [winnerFrag] = fragment({ entries: [entry("bb", "Winner")], tombstones: [] });
    const [loserFrag] = fragment({ entries: [entry("bb", "Loser")], tombstones: [] });
    const winner = { ...fragEvent(winnerFrag, 0, 1_722_000_000), id: "0".repeat(64) };
    const loser = { ...fragEvent(loserFrag, 0, 1_722_000_000), id: "f".repeat(64) };

    const { decodeCommunityListFragments } = await import("./useCommunityList");
    const decoded = await decodeCommunityListFragments([loser, winner], user);
    expect(decoded.set?.winningEvents.get(0)?.id).toBe(winner.id);
    // The coordinate head controls readFrag/timestamp. Plaintext still obeys
    // the Community List's canonical merge law across every readable copy;
    // at the same epoch "Loser" has the lower canonical bytes here.
    expect(decoded.set?.list.entries[0]?.current.name).toBe("Loser");

    // Order of arrival must not matter.
    const a = await runSync([loser, winner], undefined);
    expect(a.data.list.entries[0]?.current.name).toBe("Loser");
    const b = await runSync([winner, loser], undefined);
    expect(b.data.list.entries[0]?.current.name).toBe("Loser");
  });

  it("a frags disagreement at equal age resolves to the LARGER count", async () => {
    // Index 0 (declaring 1) and index 2 (declaring 3) share a created_at. The
    // larger count governs — index 1 is missing, so the read is INCOMPLETE and
    // refuses to write. Resolving to the smaller count would instead call this
    // read complete and rewrite over the fragment we can't see.
    const [frag0] = fragment({ entries: [entry("bb", "B")], tombstones: [] });
    frag0.frags = 1;
    const [frag2] = fragment({ entries: [entry("cc", "C")], tombstones: [] });
    frag2.frags = 3;
    const wire = [fragEvent(frag0, 0, 1_722_000_000), fragEvent(frag2, 2, 1_722_000_000)];
    const local: CommunityList = { entries: [entry("aa", "Local")], tombstones: [] };

    const { published } = await runSync(wire, local);

    expect(published).toHaveLength(0);
  });

  it("a stale fossil index above the declared count is emptied in ONE pass", async () => {
    // Relays evicted the middle of an old lattice; a non-empty index 9
    // survives above declared=1. Left alone it is dormant, not inert — any
    // later growth past index 9 re-reads its stale memberships. The reconcile
    // must empty the ACTUAL read index now, not one count-step per sync.
    const [frag0] = fragment({ entries: [entry("bb", "Current")], tombstones: [] });
    const [fossil] = fragment({ entries: [entry("cc", "Fossil")], tombstones: [] });
    fossil.frags = 10;
    const wire = [fragEvent(frag0, 0, 1_722_000_100), fragEvent(fossil, 9, 1_722_000_000)];
    const local: CommunityList = { entries: [entry("aa", "Local")], tombstones: [] };

    const { published } = await runSync(wire, local);

    const nine = published.find((e) => e.tags.find((t) => t[0] === "d")?.[1] === "9");
    expect(nine).toBeDefined();
    expect(parseFragList(nine!.content.slice(4))).toEqual({ frags: 1, entries: [], tombstones: [], extra: {} });
  });

  it("publishes the TOP index first, so an interrupted grow never wedges completeness", async () => {
    // Ascending order is a deadlock: fragment 0 (declaring the new total)
    // lands, the network dies before the brand-new top index exists, and every
    // later read is incomplete forever — while the incomplete-read refusal
    // blocks the only write that could repair it.
    const entries: CommunityListEntry[] = [];
    for (let i = 0; i < 200; i++) {
      const cid = i.toString(16).padStart(2, "0").padStart(64, "0").slice(0, 64);
      const m = { ...jm("00", `community ${i}`), community_id: cid };
      entries.push({ community_id: cid, seed: structuredClone(m), current: m, added_at: 1_719_800_000_000 });
    }
    const local: CommunityList = { entries, tombstones: [] };
    const wire = fragment({ entries: [entries[0]], tombstones: [] }).map((f, i) => fragEvent(f, i));

    const { published } = await runSync(wire, local);

    const dTags = published.map((e) => Number(e.tags.find((t) => t[0] === "d")?.[1]));
    expect(dTags.length).toBeGreaterThan(1); // 200 memberships must span fragments
    const sorted = [...dTags].sort((a, b) => b - a);
    expect(dTags).toEqual(sorted); // descending — top index lands first
  });

  it("refuses to write over a SHORT read — the missing fragment may hold anything", async () => {
    // Fragment 0 declares a two-fragment List but index 1 never arrived; the
    // union knows more than what was read, and publishing would rewrite a set
    // we haven't fully seen (CORD-02 §8's one write refusal).
    const [frag0] = fragment({ entries: [entry("bb", "From Vector")], tombstones: [] });
    frag0.frags = 2;
    const wire = [fragEvent(frag0, 0)];
    const local: CommunityList = { entries: [entry("aa", "Local Only")], tombstones: [] };

    const { published } = await runSync(wire, local);

    expect(published).toHaveLength(0);
  });

  it("recovers coordinates beyond a relay's 64-event response cap", async () => {
    const width = 70;
    const wire = Array.from({ length: width }, (_, index) => fragEvent({
      frags: width,
      entries: index === width - 1 ? fragment({ entries: [entry("bb", "Last")], tombstones: [] })[0].entries : [],
      tombstones: [],
      extra: {},
    }, index));
    const { fetchCommunityListFragments } = await import("./useCommunityList");
    const { nostr } = fakeNostr(wire, 64);

    const result = await fetchCommunityListFragments(
      nostr,
      user,
      ["wss://self.example.com"],
    );

    expect(result.set?.complete).toBe(true);
    expect(result.set?.createdAt.size).toBe(width);
    expect(result.set?.list.entries[0]?.current.name).toBe("Last");
  });
});

describe("holdLocally (a key is held the moment it is decided, as Vector's local store holds it)", () => {
  const CH = "cc".repeat(32);
  const primed = (list: CommunityList, extra: Record<string, unknown> = {}) => {
    const queryClient = new QueryClient();
    return { queryClient, key: ["concord", "list", SELF] as const, set: () => queryClient.setQueryData(["concord", "list", SELF], { event: null, list, ...extra }) };
  };
  const held = (): CommunityList => ({ entries: [entry("aa", "A")], tombstones: [] });

  it("applies an upsert of channel keys or a cut to the cache and the fold now", async () => {
    const { holdLocally } = await import("./useCommunityList");
    const p = primed(held());
    p.set();
    h.writeFolded.mockClear();
    const cid = jm("aa", "A").community_id;
    const list = holdLocally(p.queryClient, SELF, { type: "refresh-channels", communityId: cid, channels: [{ id: CH, key: "dd".repeat(32), epoch: 3, name: "" }], upsert: true })!;
    expect(list.entries[0].current.channels).toEqual([expect.objectContaining({ id: CH, epoch: 3 })]);
    expect((p.queryClient.getQueryData(p.key) as { list: CommunityList }).list).toEqual(list);
    expect(h.writeFolded).toHaveBeenCalled();
    const cut = holdLocally(p.queryClient, SELF, { type: "refresh-channels", communityId: cid, channels: [], upsert: true, cuts: [{ id: CH, epoch: 4 }] })!;
    expect(cut.entries[0].current.channels).toEqual([]);
  });

  it("leaves a join, a full replacement, a replayed add and an unreadable list to the wire", async () => {
    const { holdLocally } = await import("./useCommunityList");
    const p = primed(held());
    p.set();
    const fresh = { community_id: jm("bb", "B").community_id, seed: jm("bb", "B"), current: jm("bb", "B"), added_at: 2 };
    expect(holdLocally(p.queryClient, SELF, { type: "add", entry: fresh })).toBeUndefined();
    expect(holdLocally(p.queryClient, SELF, { type: "refresh-channels", communityId: jm("aa", "A").community_id, channels: [] })).toBeUndefined();
    expect(holdLocally(p.queryClient, SELF, { type: "add", entry: { ...fresh, community_id: jm("aa", "A").community_id }, replay: true })).toBeUndefined();
    const broken = primed(held(), { decryptFailed: true });
    broken.set();
    expect(holdLocally(broken.queryClient, SELF, { type: "refresh-channels", communityId: jm("aa", "A").community_id, channels: [], upsert: true })).toBeUndefined();
  });

  it("adds a catch-up's keys to a membership already held", async () => {
    const { holdLocally } = await import("./useCommunityList");
    const p = primed(held());
    p.set();
    const entry = { community_id: jm("aa", "A").community_id, seed: jm("aa", "A"), current: { ...jm("aa", "A"), channels: [{ id: CH, key: "ee".repeat(32), epoch: 2, name: "" }] }, added_at: 1 };
    expect(holdLocally(p.queryClient, SELF, { type: "add", entry })!.entries[0].current.channels).toEqual([expect.objectContaining({ id: CH, epoch: 2 })]);
  });
});
