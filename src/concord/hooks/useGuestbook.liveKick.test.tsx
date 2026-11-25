/**
 * The KICK live-delivery path, end to end through the real chain — a regression
 * guard for the bug that made a kick take "at least a minute" on both sides and
 * ~20s longer to actually remove the kickee.
 *
 * A kick rotates no key and publishes no control edition, so its ONLY prompt
 * delivery is the wire's standing `c2gb` subscription: a guestbook wrap is
 * ingested (`ingestWireEvents`) into the opened-event store and rings
 * `c2gb:<idHex>`; `useGuestbook` listens on that scope and re-reads.
 *
 * THE BUG had two halves, both from the guestbook query conflating a store read
 * with a network sweep — where the control plane keeps them separate:
 *
 *   - `useControlEvents` (useControlPlane.ts): the `c2ctl` bus wake runs a PURE
 *     STORE READ (`queryPlane` → `setQueryData`), and its `queryFn` is a pure
 *     store read too, with the sweep on a SEPARATE effect. The edition ingest
 *     just wrote surfaces with no network.
 *   - `useGuestbook` (before the fix): the `c2gb` wake called
 *     `invalidateQueries`, and the `queryFn` did `await sweepGuestbook(...)` — a
 *     NETWORK round-trip (NIP-42 auth gate + a 25s query timeout) — BEFORE it
 *     ever read the store. So (a) the member-list flip was stranded behind the
 *     sweep (both sides waited out the `refetchInterval: 60_000` tick), and
 *     (b) `useSelfRemove`'s confirming `guestbook.refetch()` — which gates the
 *     kickee's teardown on `isFetching` clearing — waited out the same sweep,
 *     the ~20s that remained on the kickee AFTER their member list had flipped.
 *
 * The fix makes the guestbook query match the control plane: the `c2gb` wake is
 * a store-only `setQueryData`, and the `queryFn` returns the store read while
 * the sweep runs in the BACKGROUND. Both tests below HOLD the sweep (a slow /
 * auth-gated relay) to prove neither half waits on it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { bytesToHex, guestbookGroupKey } from "@/concord/lib/derive";
import { buildJoinRumor, buildKickRumor, buildSnapshotRumors, sealGuestbook } from "@/concord/lib/guestbook";
import type { FoldedControl } from "@/concord/lib/control";
import type { Community } from "@/concord/lib/types";
import {
  _configureAuthWaitForTests,
  _resetPlaneSweepMemoForTests,
} from "@/concord/lib/planeSync";

import { ingestWireEvents, type WireEventStore } from "@/wire/ingest";
import { resetWireBus } from "@/wire/bus";
import type { WireSpec } from "@/wire/spec";

import { useGuestbook } from "./useGuestbook";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  folded: undefined as FoldedControl | undefined,
  dissolvedAtMs: undefined as number | undefined,
}));

// The guestbook query's `queryFn` runs `sweepGuestbook` against this relay.
//
// The FIRST sweep (the mount baseline) answers empty and settles. Every LATER
// sweep — the one the `c2gb` bus wake triggers by invalidating the query —
// models a slow / NIP-42-gated relay: it does not resolve within the test
// window. The kick is ALREADY in the opened-event store by the time that sweep
// runs (ingest wrote it), so a wake that read the STORE (as the control plane's
// `c2ctl` wake does) would surface it without this round-trip at all.
let sweepCalls = 0;
let releaseHeldSweep: (() => void) | undefined;

const nostr = {
  relay: () => ({
    query: async (
      _filters: unknown,
      opts?: { signal?: AbortSignal },
    ): Promise<NostrEvent[]> => {
      sweepCalls += 1;
      if (sweepCalls === 1) return []; // mount baseline settles empty
      // The wake's sweep is held: this is the network the kick is stranded
      // behind. Resolves only on release (afterEach) or the sweep's own abort.
      return new Promise<NostrEvent[]>((resolve) => {
        releaseHeldSweep = () => resolve([]);
        opts?.signal?.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
    // eslint-disable-next-line require-yield
    async *req() {
      return;
    },
    event: async () => undefined,
  }),
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
  useDissolved: () => ({ data: h.dissolvedAtMs }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const root = new Uint8Array(32).fill(9);

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

function communityOf(fill: number, owner: string): Community {
  const id = new Uint8Array(32).fill(fill);
  return {
    id,
    idHex: bytesToHex(id),
    owner,
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: ["wss://relay.test"],
    name: "test",
  } as unknown as Community;
}

/** A minimal folded control plane. The owner is authorized to kick anyone
 *  (canActOnMember + citationSatisfied both short-circuit true for the owner),
 *  so no roster/grant plumbing is needed to exercise the delivery path. */
function foldedFor(owner: string): FoldedControl {
  return {
    roster: { roles: [], grants: [] },
    ownerHex: owner,
    metadata: undefined,
    channels: new Map(),
    banned: new Set(),
    liveInviteLinks: new Set(),
    registriesByCreator: new Map(),
    pinLists: new Map(),
    signals: new Map(),
    heads: new Map(),
    headEditions: new Map(),
    incomplete: [],
    bannedAt: new Map(),
  } as unknown as FoldedControl;
}

class FakeStore implements WireEventStore {
  events: NostrEvent[] = [];
  async event(): Promise<void> {}
}

function wireSinks(spec: Partial<WireSpec>) {
  const full: WireSpec = {
    subs: [],
    concordByPk: new Map(),
    concordCommunityByChannel: new Map(),
    concordBannedByCommunity: new Map(),
    concordCtlByPk: new Map(),
    concordGbByPk: new Map(),
    gitByRepository: new Map(),
    gitRootById: new Map(),
    gitRootAuthorById: new Map(),
    sig: "",
    ...spec,
  } as WireSpec;
  return { eventStore: Promise.resolve(new FakeStore()), getSpec: () => full };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  _configureAuthWaitForTests({ maxWaitMs: 0 });
  _resetPlaneSweepMemoForTests();
  h.dissolvedAtMs = undefined;
  sweepCalls = 0;
  releaseHeldSweep = undefined;
});

afterEach(() => {
  releaseHeldSweep?.(); // let the held sweep settle so nothing dangles
  resetWireBus();
  vi.useRealTimers();
});

// ── Test ─────────────────────────────────────────────────────────────────────

describe("kick live-delivery through useGuestbook", () => {
  it("surfaces a store-held kick on the c2gb wake WITHOUT waiting on a network sweep", async () => {
    const owner = signer();
    const target = signer();
    const community = communityOf(211, owner.pubkey);
    h.folded = foldedFor(owner.pubkey);

    const gb = guestbookGroupKey(community.root, community.id, 0);
    const kickWrap = (await sealGuestbook(
      buildKickRumor(owner.pubkey, target.pubkey, Date.now()),
      gb,
      owner,
    )) as NostrEvent;

    const { result } = renderHook(() => useGuestbook(community), { wrapper });

    // Baseline: the first (empty) sweep settles and nobody is kicked yet.
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.coalesced.get(target.pubkey)).toBeUndefined();

    // The live wire path: exactly what the standing `c2gb` subscription does —
    // decrypt the kick INTO THE STORE and ring `c2gb:<idHex>`. The kick is now
    // durable and locally readable; nothing more is needed from the network.
    const sinks = wireSinks({
      concordGbByPk: new Map([[kickWrap.pubkey, { idHex: community.idHex, groups: [gb] }]]),
    });
    await ingestWireEvents(sinks, [kickWrap], { live: true, relay: "wss://relay.test" });

    // The store-reading `c2gb` wake flips the member to `kick` promptly, with
    // the wake's sweep still held. Before the fix the wake refetched and the
    // refetch's `queryFn` blocked on that held `sweepGuestbook` before it ever
    // reached `queryPlane`, so the kick sat in the store unseen until the 60s
    // poll — the member-list half of the bug.
    await waitFor(
      () => {
        expect(result.current.coalesced.get(target.pubkey)?.state).toBe("kick");
      },
      { timeout: 2_000 },
    );
  });

  it("settles a refetch from the store while the sweep is held (the kickee-teardown gate)", async () => {
    // The kickee's `useSelfRemove` forces one confirming `guestbook.refetch()`
    // and gates teardown (route away + list write) on `isFetching` clearing.
    // That refetch runs the query's `queryFn`; if the `queryFn` awaits the
    // network `sweepGuestbook`, the gate waits out the auth gate + 25s timeout —
    // the ~20s that remained on the kickee AFTER their member list had flipped.
    // With the sweep held, a refetch must still settle promptly (the kick it
    // reads is already in the store), so teardown is no longer network-bound.
    const owner = signer();
    const target = signer();
    const community = communityOf(212, owner.pubkey);
    h.folded = foldedFor(owner.pubkey);

    const gb = guestbookGroupKey(community.root, community.id, 0);
    const kickWrap = (await sealGuestbook(
      buildKickRumor(owner.pubkey, target.pubkey, Date.now()),
      gb,
      owner,
    )) as NostrEvent;

    const { result } = renderHook(() => useGuestbook(community), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    // The kick is durable in the store (ingest wrote it under this community).
    const sinks = wireSinks({
      concordGbByPk: new Map([[kickWrap.pubkey, { idHex: community.idHex, groups: [gb] }]]),
    });
    await ingestWireEvents(sinks, [kickWrap], { live: true, relay: "wss://relay.test" });
    await waitFor(() => expect(result.current.coalesced.get(target.pubkey)?.state).toBe("kick"));

    // The confirming refetch: it kicks off a held sweep in the background but
    // must SETTLE on the store read, so `isFetching` returns to false without
    // waiting on the network.
    await result.current.refetch();
    await waitFor(() => expect(result.current.isFetching).toBe(false), { timeout: 2_000 });
    // …and the verdict it confirms against still reads `kick`.
    expect(result.current.coalesced.get(target.pubkey)?.state).toBe("kick");
  });
});

describe("the c2gb wake after a Refounding", () => {
  it("keeps a member the snapshot omitted out when another Guestbook entry arrives", async () => {
    const owner = signer();
    const omitted = signer();
    const newcomer = signer();
    const root1 = new Uint8Array(32).fill(10);
    const community = {
      ...communityOf(213, owner.pubkey),
      root: root1,
      rootEpoch: 1n,
      refounder: owner.pubkey,
      heldRoots: [{ epoch: 1n, key: root1, refounder: owner.pubkey }, { epoch: 0n, key: root }],
    } as unknown as Community;
    h.folded = foldedFor(owner.pubkey);

    const gb0 = guestbookGroupKey(root, community.id, 0);
    const gb1 = guestbookGroupKey(root1, community.id, 1);
    const cut = Date.now() - 60_000;
    const wraps: NostrEvent[] = [];
    for (const r of buildSnapshotRumors(owner.pubkey, [owner.pubkey], "ab".repeat(32), cut)) {
      wraps.push((await sealGuestbook(r, gb1, owner)) as NostrEvent);
    }
    // Joined through a link still naming the superseded epoch: after the cut, at the old address.
    wraps.push((await sealGuestbook(buildJoinRumor(omitted.pubkey, cut + 1000), gb0, omitted)) as NostrEvent);
    const entry = { idHex: community.idHex, groups: [gb1, gb0] };
    const sinks = wireSinks({ concordGbByPk: new Map(wraps.map((w) => [w.pubkey, entry])) });
    await ingestWireEvents(sinks, wraps, { live: true, relay: "wss://relay.test" });

    const { result } = renderHook(() => useGuestbook(community), { wrapper });
    await waitFor(() => expect(result.current.coalesced.get(omitted.pubkey)?.state).toBe("refounded"));

    const join = (await sealGuestbook(buildJoinRumor(newcomer.pubkey, Date.now()), gb1, newcomer)) as NostrEvent;
    await ingestWireEvents(sinks, [join], { live: true, relay: "wss://relay.test" });
    await waitFor(() => expect(result.current.coalesced.get(newcomer.pubkey)?.state).toBe("join"));
    expect(result.current.coalesced.get(omitted.pubkey)?.state).toBe("refounded");
  });
});
