/**
 * `useControlEvents` network ownership (companion to useChannel.test.tsx).
 *
 * The hook holds NO standing socket and runs NO poll. Live control editions
 * arrive through the wire's `c2ctl` subscription; the slow catch-up is the
 * global {@link syncControlPlane} sweep. The only network the hook itself
 * issues is a SINGLE on-open catch-up sweep (shared, single-flight,
 * cursor-gated via sweepControl) so navigating into a community surfaces
 * anything the live sub missed while offline.
 *
 * This test pins that on-open sweep: mounting the hook for an active community
 * fetches the control plane once and folds it into the query cache — without
 * opening any `req()` subscription. The issue-#19 late-arriving-older-edition
 * HEAL now lives at the sweep layer (per-relay cursors) and is covered by
 * planeSync.test.ts + controlPlaneSync.test.ts.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { bytesToHex, controlGroupKey } from "@/concord/lib/derive";
import { KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import { sealDissolved } from "@/concord/lib/control";
import { buildRumor, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

import {
  _forgetDissolvedMemoForTests,
  dissolvedAt,
  markDissolvedLocally,
  probeCommunityDissolved,
  publishEdition,
  useControlEvents,
  useControlFold,
  useDissolved,
} from "./useControlPlane";

import {
  _configureAuthWaitForTests,
  _configureSweepPagingForTests,
  _resetPlaneSweepMemoForTests,
  controlSweepTruncated,
} from "@/concord/lib/planeSync";

// These tests exercise the on-open sweep, not planeSync's NIP-42 auth gate
// (planeSync.test.ts owns that) — let the sweep's REQs fly immediately.
beforeAll(() => {
  _configureAuthWaitForTests({ maxWaitMs: 0 });
});

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

class FakeRelay {
  events: NostrEvent[] = [];
  queries: Filter[] = [];
  reqCount = 0;

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.queries.push(...filters);
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      for (const ev of this.events) {
        const ok =
          (!f.kinds || f.kinds.includes(ev.kind)) &&
          (!f.authors || f.authors.includes(ev.pubkey)) &&
          (f.since === undefined || ev.created_at >= f.since) &&
          (f.until === undefined || ev.created_at <= f.until);
        if (ok) out.set(ev.id, ev);
      }
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at).slice(0, filters[0]?.limit);
  }

  /** The hook must NOT open a standing subscription — assert this stays 0. */
  // eslint-disable-next-line require-yield
  async *req(_filters: Filter[], opts?: { signal?: AbortSignal }): AsyncGenerator<unknown> {
    this.reqCount++;
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) return resolve();
      opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async event(): Promise<void> {}
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/** A control-plane edition wrap with a controlled outer `created_at`. */
async function editionWrapAt(
  control: ReturnType<typeof controlGroupKey>,
  s: ReturnType<typeof signer>,
  eid: string,
  createdAt: number,
): Promise<{ wrap: NostrEvent; rumor: NostrRumor }> {
  const rumor = buildRumor({
    kind: 3308,
    content: "{}",
    tags: [["vsk", "0"], ["eid", eid], ["ev", "1"]],
    pubkey: s.pubkey,
    ms: null,
    createdAtSecs: createdAt,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, s);
  const w = await wrapSeal(seal, control);
  const wrap = finalizeEvent(
    { kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt },
    control.sk,
  );
  return { wrap, rumor };
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function communityOf(fill: number, owner: string): Community {
  const root = new Uint8Array(32).fill(fill);
  const id = new Uint8Array(32).fill(fill + 1);
  return {
    id,
    idHex: bytesToHex(id),
    owner,
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: [RELAY_A, RELAY_B],
    name: "test",
  } as Community;
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useControlEvents — on-open sweep (no standing socket)", () => {
  it("fetches the control plane once on open and folds it, opening no req()", { timeout: 30_000 }, async () => {
    const owner = signer();
    const community = communityOf(21, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);

    const now = Math.floor(Date.now() / 1000);
    const edition = await editionWrapAt(control, owner, "ab".repeat(32), now - 1000);

    const relayA = new FakeRelay();
    relayA.events = [edition.wrap];
    const relayB = new FakeRelay();
    h.pool = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useControlEvents(community), { wrapper });

    // The on-open sweep pulls the edition into the query cache.
    await waitFor(
      () => {
        expect((result.current.data ?? []).map((e) => e.rumorId)).toContain(edition.rumor.id);
      },
      { timeout: 10_000 },
    );

    // Crucially, the hook opened NO standing subscription — liveness is the
    // wire's job now.
    expect(relayA.reqCount, "hook must not open a standing req()").toBe(0);
    expect(relayB.reqCount, "hook must not open a standing req()").toBe(0);
  });

  it("an inactive community (rail button) issues no on-open sweep", { timeout: 30_000 }, async () => {
    const owner = signer();
    const community = communityOf(41, owner.pubkey);

    const relayA = new FakeRelay();
    const relayB = new FakeRelay();
    h.pool = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };

    const { wrapper } = makeWrapper();
    renderHook(() => useControlEvents(community, false), { wrapper });

    // Give any (unwanted) async sweep a chance to fire.
    await new Promise((r) => setTimeout(r, 200));

    expect(relayA.queries.length + relayB.queries.length, "inactive hook must not sweep").toBe(0);
    expect(relayA.reqCount + relayB.reqCount).toBe(0);
  });
});

describe("useControlFold — a short sweep still folds", () => {
  /**
   * Render the fold hook, wait for its sweep to settle, and hand back a
   * re-render trigger.
   */
  async function renderFold(community: Community, relay: FakeRelay) {
    h.pool = { relay: () => relay };
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useControlFold(community), { wrapper });
    await waitFor(() => expect(relay.queries.length).toBeGreaterThan(0), { timeout: 10_000 });
    return result;
  }

  it("folds normally when the sweep read the plane comfortably", { timeout: 30_000 }, async () => {
    _resetPlaneSweepMemoForTests();
    _configureSweepPagingForTests({ pageLimit: 500, maxEvents: 15_000 });
    const owner = signer();
    const community = communityOf(61, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = [(await editionWrapAt(control, owner, "ab".repeat(32), now - 100)).wrap];

    const result = await renderFold(community, relay);
    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
  });

  it("still folds when the sweep hit its budget", { timeout: 30_000 }, async () => {
    // Anyone can inflate the plane past any budget, so refusing to fold a
    // short read hands every member a lockup switch. The plane is procedural:
    // fold what arrived, converge on later sweeps. What a short read DOES
    // forfeit is the durable snapshot (loginWarmup) and the right to compact
    // (useRekey) — not the ability to see the community at all.
    _resetPlaneSweepMemoForTests();
    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 2 });
    const owner = signer();
    const community = communityOf(62, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay();
    relay.events = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (i) =>
        (await editionWrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)).wrap,
      ),
    );

    const result = await renderFold(community, relay);
    await waitFor(() => expect(controlSweepTruncated(community)).toBe(true), { timeout: 10_000 });
    await waitFor(() => expect(result.current.data, "a member must still see the community").toBeDefined(), { timeout: 10_000 });

    _configureSweepPagingForTests({ pageLimit: 500, maxEvents: 15_000 });
  });
});


describe("useDissolved — death is one-way (CORD-02 §9)", () => {
  it("stays dissolved when every relay later fails", async () => {
    // The reported unlock: the verdict was re-derived each round, and the
    // network branch swallows relay errors — so ONE bad round answered "alive"
    // and the composer came back on a community the owner had torn down.
    const owner = signer();
    const community = communityOf(70, owner.pubkey);
    const tombstone = await sealDissolved(community.id, owner.pubkey, owner);

    const live = new FakeRelay();
    live.events = [tombstone];
    h.pool = { relay: () => live };

    const first = makeWrapper();
    const a = renderHook(() => useDissolved(community), { wrapper: first.wrapper });
    await waitFor(() => expect(a.result.current.data).toBeTruthy());

    // Every relay now fails. A fresh QueryClient means no cached answer to
    // lean on — only the persisted verdict can carry it.
    const dead = { query: async () => { throw new Error("relay down"); } } as unknown as FakeRelay;
    h.pool = { relay: () => dead };

    const second = makeWrapper();
    const b = renderHook(() => useDissolved(community), { wrapper: second.wrapper });
    await waitFor(() => expect(b.result.current.data).toBeTruthy());
    expect(b.result.current.data, "a dead community must never read as alive again").toBeTruthy();
  });

  it("survives a restart — the verdict is persisted, not just memoized", async () => {
    // The session memo alone would carry the case above. Across a reload only
    // the persisted marker can, and that is the case where the relays are also
    // most likely to be cold.
    const owner = signer();
    const community = communityOf(74, owner.pubkey);
    const live = new FakeRelay();
    live.events = [await sealDissolved(community.id, owner.pubkey, owner)];
    h.pool = { relay: () => live };

    const first = makeWrapper();
    const a = renderHook(() => useDissolved(community), { wrapper: first.wrapper });
    await waitFor(() => expect(a.result.current.data).toBeTruthy());

    // Restart: session memory gone, every relay down.
    _forgetDissolvedMemoForTests();
    h.pool = { relay: () => ({ query: async () => { throw new Error("relay down"); } }) };

    expect(await dissolvedAt(community.idHex), "the persisted verdict stands alone").toBeTypeOf("number");
  });

  it("exposes the verdict to the send and wire gates without a network round", async () => {
    const owner = signer();
    const community = communityOf(72, owner.pubkey);
    expect(await dissolvedAt(community.idHex), "alive until proven otherwise").toBeUndefined();

    const relay = new FakeRelay();
    relay.events = [await sealDissolved(community.id, owner.pubkey, owner)];
    h.pool = { relay: () => relay };
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDissolved(community), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());

    expect(await dissolvedAt(community.idHex), "local, sticky, no network").toBeTypeOf("number");
  });
});

describe("probeCommunityDissolved — a non-member's check, from the public identity alone", () => {
  it("finds the owner's grave and remembers it", async () => {
    const owner = signer();
    const community = communityOf(80, owner.pubkey);
    const relay = new FakeRelay();
    relay.events = [await sealDissolved(community.id, owner.pubkey, owner)];
    const pool = { relay: () => relay };

    const at = await probeCommunityDissolved(pool, {
      communityId: community.idHex,
      owner: owner.pubkey,
      relays: [RELAY_A],
    });
    expect(at).toBeTypeOf("number");
    expect(await dissolvedAt(community.idHex), "sticky like every other path to the grave").toBe(at);
  });

  it("ignores a grave someone other than the owner signed", async () => {
    // The dissolved address derives from the public community_id, so anyone
    // can publish there — only the owner's seal makes it a grave.
    const owner = signer();
    const impostor = signer();
    const community = communityOf(82, owner.pubkey);
    const relay = new FakeRelay();
    relay.events = [await sealDissolved(community.id, impostor.pubkey, impostor)];
    const pool = { relay: () => relay };

    const at = await probeCommunityDissolved(pool, {
      communityId: community.idHex,
      owner: owner.pubkey,
      relays: [RELAY_A],
    });
    expect(at).toBeUndefined();
  });
});

describe("probeCommunityDissolved — many at once", () => {
  it("batches a burst into REQs of at most 16 filters, and still finds each grave", async () => {
    const owner = signer();
    const communities = Array.from({ length: 20 }, (_, i) => communityOf(120 + 2 * i, owner.pubkey));
    const relay = new FakeRelay();
    const last = communities[communities.length - 1];
    relay.events = [await sealDissolved(last.id, owner.pubkey, owner)];
    const sizes: number[] = [];
    const query = relay.query.bind(relay);
    relay.query = async (filters) => {
      sizes.push(filters.length);
      return query(filters);
    };

    const verdicts = await Promise.all(
      communities.map((c) =>
        probeCommunityDissolved({ relay: () => relay }, { communityId: c.idHex, owner: owner.pubkey, relays: [RELAY_A] }),
      ),
    );
    expect(sizes.sort((a, b) => b - a)).toEqual([16, 4]);
    expect(verdicts.slice(0, -1).every((at) => at === undefined)).toBe(true);
    expect(verdicts.at(-1)).toBeTypeOf("number");
  });
});

describe("probeCommunityDissolved — answering fast", () => {
  it("case-folds the community id before touching the marker", async () => {
    const owner = signer();
    const community = communityOf(84, owner.pubkey);
    const relay = new FakeRelay();
    relay.events = [await sealDissolved(community.id, owner.pubkey, owner)];

    const at = await probeCommunityDissolved({ relay: () => relay }, {
      communityId: community.idHex.toUpperCase(),
      owner: owner.pubkey.toUpperCase(),
      relays: [RELAY_A],
    });
    expect(at).toBeTypeOf("number");
    expect(await dissolvedAt(community.idHex), "remembered under the lowercase id every reader uses").toBe(at);
  });

  it("answers from the first relay with a grave, not the slowest relay", async () => {
    const owner = signer();
    const community = communityOf(86, owner.pubkey);
    const fast = new FakeRelay();
    fast.events = [await sealDissolved(community.id, owner.pubkey, owner)];
    const hung = { query: () => new Promise<NostrEvent[]>(() => undefined) };
    const pool = { relay: (url: string) => (url === RELAY_A ? fast : hung) };

    const started = Date.now();
    const at = await probeCommunityDissolved(pool as never, {
      communityId: community.idHex,
      owner: owner.pubkey,
      relays: [RELAY_A, RELAY_B],
    });
    expect(at).toBeTypeOf("number");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up within its budget when no relay answers, and does not reuse that as a verdict", async () => {
    const owner = signer();
    const community = communityOf(88, owner.pubkey);
    let asked = 0;
    const hung = {
      query: () => {
        asked += 1;
        return new Promise<NostrEvent[]>(() => undefined);
      },
    };
    const target = { communityId: community.idHex, owner: owner.pubkey, relays: [RELAY_A] };

    const started = Date.now();
    expect(await probeCommunityDissolved({ relay: () => hung } as never, target, { budgetMs: 100 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    // No relay answered, so "not found" is no verdict: the join asks again.
    expect(await probeCommunityDissolved({ relay: () => hung } as never, target, { budgetMs: 100 })).toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toBe(2);
  });

  it("reuses a not-found that a relay answered, for the same owner and relays only", async () => {
    const owner = signer();
    const community = communityOf(90, owner.pubkey);
    let asked = 0;
    const empty = {
      query: async () => {
        asked += 1;
        return [] as NostrEvent[];
      },
    };
    const pool = { relay: () => empty } as never;
    const target = { communityId: community.idHex, owner: owner.pubkey, relays: [RELAY_A, RELAY_B] };

    expect(await probeCommunityDissolved(pool, target)).toBeUndefined();
    const askedFirst = asked;
    // Same identity, relays in another order: one probe between them.
    expect(await probeCommunityDissolved(pool, { ...target, relays: [RELAY_B, RELAY_A] })).toBeUndefined();
    expect(asked).toBe(askedFirst);

    // A different owner or relay set is a different question.
    await probeCommunityDissolved(pool, { ...target, owner: signer().pubkey });
    expect(asked).toBeGreaterThan(askedFirst);
    const afterOwner = asked;
    await probeCommunityDissolved(pool, { ...target, relays: [RELAY_A] });
    expect(asked).toBeGreaterThan(afterOwner);
  });

  it("does not let a dead-relay probe hide the grave from a probe that reaches it", async () => {
    const owner = signer();
    const community = communityOf(92, owner.pubkey);
    const live = new FakeRelay();
    live.events = [await sealDissolved(community.id, owner.pubkey, owner)];
    const dead = { query: async () => { throw new Error("offline"); } };
    const target = { communityId: community.idHex, owner: owner.pubkey, relays: [RELAY_A] };

    expect(await probeCommunityDissolved({ relay: () => dead } as never, target)).toBeUndefined();
    expect(await probeCommunityDissolved({ relay: () => live } as never, target)).toBeTypeOf("number");
  });
});

describe("publishEdition — nothing follows the grave", () => {
  it("refuses once the owner's own client has marked the community dissolved", async () => {
    // The dissolving owner never sweeps their own tombstone into the stored
    // control plane before retiring links — the local marker is the only
    // record of the grave they have, and it must be enough.
    const owner = signer();
    const community = communityOf(90, owner.pubkey);
    const sent: NostrEvent[] = [];
    const pool = {
      relay: () => ({
        event: async (e: NostrEvent) => {
          sent.push(e);
        },
      }),
    };
    const { queryClient } = makeWrapper();
    await markDissolvedLocally(queryClient, community.idHex, Date.now());

    const rumor = buildRumor({ kind: 3308, content: "{}", tags: [["vsk", "8"]], pubkey: owner.pubkey, ms: null });
    await expect(
      publishEdition(pool as never, community, owner as never, rumor),
    ).rejects.toThrow(/dissolved/);
    expect(sent, "no wrap reaches any relay").toHaveLength(0);
  });
});
