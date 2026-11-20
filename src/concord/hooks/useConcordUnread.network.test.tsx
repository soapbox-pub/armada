/**
 * `useConcordUnread` network ownership — the rail invariant.
 *
 * The rail mounts this hook ONCE PER JOINED COMMUNITY (`ServerRail`'s buttons,
 * its folder mini icons, its unread probes) plus once more in the desktop badge
 * counter, on every page of the app. Right beside them it passes `active=false`
 * to `useControlFold` precisely so the rail does NOT "fan out a control-plane
 * REQ per relay for every community on pageload" — the invariant
 * `useControlPlane.test.tsx` pins as "an inactive community (rail button)
 * issues no on-open sweep".
 *
 * Resolving the Banlist here (CORD-04 §4) means this hook reaches the same
 * fold, and a single ACTIVE observer lights the shared query key for every
 * passive one. So an ambient mount that forgets the flag silently restores the
 * whole per-community fan-out — a control sweep per relay, plus `useDissolved`'s
 * 5-minute probe — for communities nobody opened. It scaled linearly: ten
 * communities cost forty relay filters at boot.
 *
 * This file must NOT mock `@/concord/hooks/useChannel`. The sibling
 * `useConcordUnread.test.tsx` does (it is testing the scan's logic, not its
 * network), and that mock is exactly what let the regression land green.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { bytesToHex } from "@/concord/lib/derive";
import { _configureAuthWaitForTests } from "@/concord/lib/planeSync";
import type { Community } from "@/concord/lib/types";

const CH = "d".repeat(64);
const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

const h = vi.hoisted(() => ({ pool: undefined as unknown }));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.pool }) }));

// The scan's own inputs only — so the single thing under measurement is what
// the hook graph beneath it activates.
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>() }) }));
vi.mock("@/concord/hooks/useCommunityRumors", () => ({
  useCommunityRumors: () => ({ byChannel: new Map([[CH, []]]), isLoading: false }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunityEntry: () => undefined }));
vi.mock("@/concord/lib/floodCluster", () => ({ quarantinedIn: () => new Set<string>() }));
vi.mock("@/concord/lib/quarantineMemory", () => ({
  quarantineMemoryRevision: () => 0,
  recallQuarantined: () => undefined,
  rememberQuarantined: () => undefined,
  subscribeQuarantineMemory: () => () => undefined,
}));
vi.mock("@/hooks/useReadState", () => ({
  concordReadKey: (idHex: string) => `c2:${idHex}`,
  useReadState: () => ({ readState: {}, getLastRead: () => 0, markRead: vi.fn() }),
  useReadStateSelect: (select: (map: Record<string, number>) => unknown) => select({}),
  useReadStateActions: () => ({ getLastRead: () => 0, markRead: vi.fn() }),
}));

const { useConcordUnread } = await import("@/concord/hooks/useConcordUnread");

beforeAll(() => {
  // Not the NIP-42 auth gate's test (planeSync.test.ts owns that) — let any
  // sweep this mount issues fly immediately, so "no traffic" means no traffic.
  _configureAuthWaitForTests({ maxWaitMs: 0 });
});

class FakeRelay {
  filters: unknown[] = [];
  reqCount = 0;
  async query(filters: unknown[]): Promise<unknown[]> {
    this.filters.push(...filters);
    return [];
  }
  // eslint-disable-next-line require-yield
  async *req(_f: unknown[], opts?: { signal?: AbortSignal }): AsyncGenerator<unknown> {
    this.reqCount++;
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) return resolve();
      opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async event(): Promise<void> {}
}

function communityOf(fill: number): Community {
  const root = new Uint8Array(32).fill(fill);
  const id = new Uint8Array(32).fill(fill + 1);
  return {
    id,
    idHex: bytesToHex(id),
    owner: getPublicKey(generateSecretKey()),
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: [RELAY_A, RELAY_B],
    name: "test",
  } as Community;
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

let relayA: FakeRelay;
let relayB: FakeRelay;

beforeEach(() => {
  relayA = new FakeRelay();
  relayB = new FakeRelay();
  h.pool = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };
});

/** Give any (unwanted) async sweep or probe a generous chance to fire. */
const settle = () => new Promise((r) => setTimeout(r, 400));
const filterCount = () => relayA.filters.length + relayB.filters.length;

describe("useConcordUnread — network ownership", () => {
  it("an ambient mount (rail button, badge counter) issues no relay traffic", async () => {
    renderHook(() => useConcordUnread(communityOf(41), [{ idHex: CH } as never]), {
      wrapper: wrapper(),
    });
    await settle();

    expect(filterCount(), "ambient unread must not sweep the control plane").toBe(0);
    expect(relayA.reqCount + relayB.reqCount, "and must open no subscription").toBe(0);
  });

  it("a rail of ten communities stays silent", async () => {
    const communities = Array.from({ length: 10 }, (_, i) => communityOf(70 + i * 2));
    renderHook(
      () => communities.map((c) => useConcordUnread(c, [{ idHex: CH } as never])),
      { wrapper: wrapper() },
    );
    await settle();

    // The regression cost 4 relay filters per community — 40 here, at boot,
    // plus a 5-minute dissolved probe apiece for as long as the tab is open.
    expect(filterCount(), "unread must not scale relay traffic by community count").toBe(0);
  });

  it("the open community's page still resolves moderation over the network", async () => {
    renderHook(
      () => useConcordUnread(communityOf(61), [{ idHex: CH } as never], new Map(), true),
      { wrapper: wrapper() },
    );
    await settle();

    // The opt-in is what ConcordPage passes; without this the fix would be
    // indistinguishable from deleting the Banlist resolution outright.
    expect(filterCount(), "an active mount must still sweep").toBeGreaterThan(0);
  });
});
