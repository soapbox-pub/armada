// @vitest-environment node
/**
 * The `profiles` sync topic: on-screen demand is drained in batched rounds
 * that ask the general pool AND the relays a mounted community registered as
 * hints, write the newest copy into `main`, and seed the shared
 * `['author', pubkey]` cache — while the durable per-pubkey stamps keep a
 * relaunch inside the window off the network entirely.
 */
import { IDBFactory } from "fake-indexeddb";
import { QueryClient } from "@tanstack/react-query";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { AuthorResult } from "@/lib/authorCache";

/** A fresh module graph: scheduler, KV stamps, store handle, and the topic. */
async function freshModules() {
  vi.resetModules();
  const manager = await import("./syncManager");
  const profileSync = await import("./profileSync");
  const { appEventStore } = await import("@/lib/db/mainEventStore");
  const { isProfilePending } = await import("@/lib/profileLoading");
  return { ...manager, ...profileSync, appEventStore, isProfilePending };
}

const sk1 = generateSecretKey();
const sk2 = generateSecretKey();
const PK1 = getPublicKey(sk1);
const PK2 = getPublicKey(sk2);

function profile(sk: Uint8Array, name: string, created_at: number): NostrEvent {
  return finalizeEvent({ kind: 0, content: JSON.stringify({ name }), tags: [], created_at }, sk);
}

type Responder = (authors: string[]) => NostrEvent[];

/** A pool whose per-relay and pool-wide kind-0 answers are scripted per test. */
function makeNostr(opts: { pool?: Responder; relays?: Record<string, Responder | "throw"> }) {
  const queries: { url?: string; authors: string[] }[] = [];
  const authorsOf = (filters: NostrFilter[]) => filters[0]?.authors ?? [];
  const nostr = {
    async query(filters: NostrFilter[]) {
      const authors = authorsOf(filters);
      queries.push({ authors });
      return opts.pool?.(authors) ?? [];
    },
    relay(url: string) {
      return {
        async query(filters: NostrFilter[]) {
          const authors = authorsOf(filters);
          queries.push({ url, authors });
          const responder = opts.relays?.[url];
          if (responder === "throw") throw new Error("relay down");
          return responder?.(authors) ?? [];
        },
      };
    },
  };
  return { nostr, queries };
}

/** Every pubkey asked about, across the pool pass and every hint relay. */
const asked = (queries: { url?: string; authors: string[] }[], url?: string) =>
  new Set(queries.filter((q) => q.url === url).flatMap((q) => q.authors));

const settled = async (m: Awaited<ReturnType<typeof freshModules>>) => {
  await vi.waitFor(() => expect(m.syncState("profiles").status).toBe("settled"), {
    timeout: 15_000,
  });
};

describe("profileSync — the profiles topic", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it(
    "resolves demanded profiles from the pool, stores them in main, and seeds the author cache",
    { timeout: 30_000 },
    async () => {
      const m = await freshModules();
      const event = profile(sk1, "alice", 1_700_000_000);
      const { nostr, queries } = makeNostr({ pool: (authors) => (authors.includes(PK1) ? [event] : []) });
      const queryClient = new QueryClient();

      const release = m.demandProfiles([PK1], { nostr, queryClient });
      await settled(m);

      expect(asked(queries)).toContain(PK1);
      const store = await m.appEventStore();
      const rows = await store.query([{ kinds: [0], authors: [PK1] }]);
      expect(rows.map((r) => r.id)).toEqual([event.id]);
      expect(queryClient.getQueryData<AuthorResult>(["author", PK1])?.metadata?.name).toBe("alice");

      release();
      m._resetProfileSyncForTests();
      m._resetSyncManagerForTests();
    },
  );

  it(
    "asks the hinted relays, so a profile only the community's relay has still resolves",
    { timeout: 30_000 },
    async () => {
      const m = await freshModules();
      const event = profile(sk1, "only-here", 1_700_000_100);
      const { nostr, queries } = makeNostr({
        // The general pool never heard of this pubkey — the miss this fixes.
        pool: () => [],
        relays: { "wss://community.test": (authors) => (authors.includes(PK1) ? [event] : []) },
      });
      const queryClient = new QueryClient();

      const dropHints = m.addProfileRelayHints(["wss://community.test"]);
      const release = m.demandProfiles([PK1], { nostr, queryClient });
      await settled(m);

      expect(asked(queries, "wss://community.test")).toContain(PK1);
      expect(queryClient.getQueryData<AuthorResult>(["author", PK1])?.metadata?.name).toBe("only-here");

      release();
      dropHints();
      m._resetProfileSyncForTests();
      m._resetSyncManagerForTests();
    },
  );

  it("keeps the newest copy when the pool and a hint relay disagree", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const stale = profile(sk1, "old", 1_700_000_000);
    const fresh = profile(sk1, "new", 1_700_000_500);
    const { nostr } = makeNostr({
      pool: () => [stale],
      relays: { "wss://community.test": () => [fresh] },
    });
    const queryClient = new QueryClient();

    const dropHints = m.addProfileRelayHints(["wss://community.test"]);
    const release = m.demandProfiles([PK1], { nostr, queryClient });
    await settled(m);

    expect(queryClient.getQueryData<AuthorResult>(["author", PK1])?.metadata?.name).toBe("new");
    const store = await m.appEventStore();
    const rows = await store.query([{ kinds: [0], authors: [PK1] }]);
    expect(rows.map((r) => r.id)).toEqual([fresh.id]);

    release();
    dropHints();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it("a dead hint relay costs its chunk, not the round", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const event = profile(sk1, "alice", 1_700_000_000);
    const { nostr } = makeNostr({
      pool: () => [event],
      relays: { "wss://dead.test": "throw" },
    });
    const queryClient = new QueryClient();

    const dropHints = m.addProfileRelayHints(["wss://dead.test"]);
    const release = m.demandProfiles([PK1], { nostr, queryClient });
    await settled(m);

    expect(queryClient.getQueryData<AuthorResult>(["author", PK1])?.metadata?.name).toBe("alice");

    release();
    dropHints();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it("batches the demand of one mounting burst into a single round", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const { nostr, queries } = makeNostr({
      pool: (authors) => authors.map((pk) => (pk === PK1 ? profile(sk1, "a", 1) : profile(sk2, "b", 1))),
    });
    const queryClient = new QueryClient();

    // Two rows mounting in the same flush, as a member list does.
    const r1 = m.demandProfiles([PK1], { nostr, queryClient });
    const r2 = m.demandProfiles([PK2], { nostr, queryClient });
    await settled(m);

    expect(asked(queries)).toEqual(new Set([PK1, PK2]));

    r1();
    r2();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it("an unmounted row's pubkey leaves the demand before the round snapshots it", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const { nostr, queries } = makeNostr({ pool: () => [] });
    const queryClient = new QueryClient();

    const keep = m.demandProfiles([PK1], { nostr, queryClient });
    // Scrolled out of view again before the settle window closed.
    m.demandProfiles([PK2], { nostr, queryClient })();
    await settled(m);

    expect(asked(queries)).toEqual(new Set([PK1]));

    keep();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it(
    "a durable per-pubkey stamp keeps a relaunch inside the window off the network",
    { timeout: 30_000 },
    async () => {
      const first = await freshModules();
      const event = profile(sk1, "alice", 1_700_000_000);
      const one = makeNostr({ pool: () => [event] });
      const r1 = first.demandProfiles([PK1], { nostr: one.nostr, queryClient: new QueryClient() });
      await settled(first);
      expect(asked(one.queries)).toContain(PK1);
      r1();
      first._resetProfileSyncForTests();
      first._resetSyncManagerForTests();

      // Relaunch: new module graph (new scheduler, new stamp cache), same
      // IndexedDB — so both the profile and its freshness stamp are still on
      // disk and the round has nothing to ask about.
      const second = await freshModules();
      const two = makeNostr({ pool: () => [event] });
      const queryClient = new QueryClient();
      const r2 = second.demandProfiles([PK1], { nostr: two.nostr, queryClient });
      await settled(second);

      expect(two.queries).toEqual([]);
      // Still painted, from the store alone: the point of the store-first read.
      expect(queryClient.getQueryData<AuthorResult>(["author", PK1])?.metadata?.name).toBe("alice");

      r2();
      second._resetProfileSyncForTests();
      second._resetSyncManagerForTests();
    },
  );

  it(
    "a newly hinted relay re-asks the profiles that missed, without waiting out their retry",
    { timeout: 60_000 },
    async () => {
      const m = await freshModules();
      const event = profile(sk1, "only-here", 1_700_000_100);
      const { nostr, queries } = makeNostr({
        pool: () => [],
        relays: { "wss://late.test": (authors) => (authors.includes(PK1) ? [event] : []) },
      });
      const queryClient = new QueryClient();

      // Round one: nobody has it, and the miss is stamped.
      const release = m.demandProfiles([PK1], { nostr, queryClient });
      await settled(m);
      expect(queryClient.getQueryData<AuthorResult>(["author", PK1])).toBeUndefined();

      // The community's relays arrive after that round. The miss stamp is far
      // from due (MISS_RETRY_MS is a minute), so only the hint generation can
      // put this pubkey back in a round.
      const dropHints = m.addProfileRelayHints(["wss://late.test"]);
      await vi.waitFor(
        () => expect(queryClient.getQueryData<AuthorResult>(["author", PK1])?.metadata?.name).toBe("only-here"),
        { timeout: 30_000 },
      );
      expect(asked(queries, "wss://late.test")).toContain(PK1);

      release();
      dropHints();
      m._resetProfileSyncForTests();
      m._resetSyncManagerForTests();
    },
  );

  it("backs a repeatedly-missing pubkey off instead of re-asking every minute", { timeout: 30_000 }, async () => {
    // Demand lives for the life of a MOUNT, and the timeline never unmounts a
    // row scrolled past, so a pubkey with no kind-0 anywhere used to keep a REQ
    // going out once a minute for the whole session — per author, growing with
    // every scroll-back. In a flooded room that is most of the authors.
    const m = await freshModules();
    const { nostr } = makeNostr({ pool: () => [] });
    const queryClient = new QueryClient();

    const release = m.demandProfiles([PK1], { nostr, queryClient });
    await settled(m);

    // One empty round recorded, so the next retry is already past the flat minute.
    expect(m._profileMissAttemptsForTests(PK1)).toBe(1);
    expect(m._missRetryDelayMs(m._profileMissAttemptsForTests(PK1))).toBe(60_000);

    release();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it("keeps a profile pending until its round answers, found or missed", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const { nostr } = makeNostr({ pool: (authors) => (authors.includes(PK1) ? [profile(sk1, "alice", 1)] : []) });
    const queryClient = new QueryClient();

    expect(m.isProfilePending(PK1)).toBe(true);
    expect(m.isProfilePending(PK2)).toBe(true);
    const release = m.demandProfiles([PK1, PK2], { nostr, queryClient });
    await settled(m);
    await vi.waitFor(() => {
      expect(m.isProfilePending(PK1)).toBe(false);
      expect(m.isProfilePending(PK2)).toBe(false);
    });

    release();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it("clears the backoff once the profile is finally found", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const { nostr } = makeNostr({ pool: () => [profile(sk1, "alice", 1_700_000_000)] });
    const queryClient = new QueryClient();

    const release = m.demandProfiles([PK1], { nostr, queryClient });
    await settled(m);

    expect(m._profileMissAttemptsForTests(PK1)).toBe(0);

    release();
    m._resetProfileSyncForTests();
    m._resetSyncManagerForTests();
  });

  it("grows the miss retry geometrically, capped", async () => {
    const m = await freshModules();
    expect(m._missRetryDelayMs(1)).toBe(60_000);
    expect(m._missRetryDelayMs(2)).toBe(120_000);
    expect(m._missRetryDelayMs(3)).toBe(240_000);
    // Capped, so a long session still re-checks a profile that appears later.
    expect(m._missRetryDelayMs(20)).toBe(30 * 60_000);
    // Defensive: an unseen pubkey reads as the first attempt, never faster.
    expect(m._missRetryDelayMs(0)).toBe(60_000);
  });
});
