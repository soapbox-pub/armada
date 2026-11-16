/**
 * A persisted pending join must not outlive every retry forever.
 *
 * `join({ invite, bundle })` records a pending entry on disk at click time
 * (pendingJoins.ts) and `useResumePendingJoins` re-runs its chain on every
 * launch. Only a VERDICT (`isJoinRejected`: banned, dissolved, unusable relays,
 * an `InviteError`) drops the record; anything else — a relay that never
 * answers, or a bundle that is simply not on its relays any more ("Couldn't
 * find that invite on its relays.", a plain `Error`) — keeps it "for the next
 * launch". A join that can never complete is therefore on the rail, opening a
 * community page with no vault entry behind it, on every launch for good.
 *
 * This drives the real hooks through a click, then a week and more of launches
 * whose resume keeps failing the same transient way, and expects the record to
 * have been given up on by the end: gone from the persisted pending set and no
 * longer surfaced by `useLiveCommunities`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import type { NUser } from "@nostrify/react/login";

const SELF = "ab".repeat(32);
const OWNER = "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47";
const LINK_SIGNER = "cd".repeat(32);
const DAY = 24 * 60 * 60 * 1000;

type Relay = {
  query: (filters: Array<{ authors?: string[] }>, opts?: unknown) => Promise<unknown[]>;
  event: (...args: unknown[]) => Promise<unknown>;
};

const h = vi.hoisted(() => ({
  relay: undefined as unknown as Relay,
  user: undefined as unknown,
  folded: new Map<string, unknown>(),
  store: Promise.resolve({ query: async () => [], event: async () => undefined }),
  toasts: [] as Array<{ title?: unknown; description?: unknown }>,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => h.relay,
      query: (...a: unknown[]) => h.relay.query(...(a as Parameters<Relay["query"]>)),
      event: (...a: unknown[]) => h.relay.event(...a),
      group: () => h.relay,
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.test"], communityRelays: [] } }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selfStateRelays: () => ["wss://self.example"],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => h.store,
}));
vi.mock("@/hooks/useRemoveRailKey", () => ({
  useRemoveRailKey: () => () => undefined,
}));
vi.mock("@/hooks/useToast", () => ({
  toast: (t: { title?: unknown; description?: unknown }) => h.toasts.push(t),
}));
// On-disk state is this map; it outlives `vi.resetModules()` (process death).
vi.mock("@/lib/foldedCache", () => ({
  readFolded: async (key: string) => h.folded.get(key),
  writeFolded: async (key: string, value: unknown) => {
    h.folded.set(key, structuredClone(value));
  },
}));

h.user = {
  pubkey: SELF,
  signer: {
    nip44: {
      encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
      decrypt: async (_pk: string, ciphertext: string) => ciphertext.slice(4),
    },
    signEvent: async (t: Record<string, unknown>) => ({ ...t, id: "e".repeat(64), pubkey: SELF, sig: "f".repeat(128) }),
  },
} as unknown as NUser;

/** Every relay is reachable at the socket level but has lost the invite bundle. */
let bundleQueries = 0;
const bundleGoneRelay: Relay = {
  query: async (filters) => {
    if (filters.some((f) => f.authors?.includes(LINK_SIGNER))) bundleQueries += 1;
    return [];
  },
  event: async () => undefined,
};
/** Every relay is down: a network failure on every read and write. */
const downRelay: Relay = {
  query: async (filters) => {
    if (filters.some((f) => f.authors?.includes(LINK_SIGNER))) bundleQueries += 1;
    throw new Error("network down");
  },
  event: async () => {
    throw new Error("network down");
  },
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.folded = new Map();
  h.toasts = [];
  bundleQueries = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

async function clickJoin(): Promise<string> {
  const { mintCommunity } = await import("@/concord/lib/community");
  const { toJoinMaterial } = await import("@/concord/lib/communityList");
  const { bundleNaddr } = await import("@/concord/lib/invite");
  const { useCommunityActions } = await import("@/concord/hooks/useCommunityActions");

  const { community } = mintCommunity("Fleet", OWNER, ["wss://home.example"]);
  const jm = toJoinMaterial(community, { relays: community.relays });
  const bundle = { ...jm, channels: [], relays: community.relays, name: "Fleet" };
  const invite = {
    linkSigner: LINK_SIGNER,
    token: new Uint8Array(16).fill(7),
    bootstrapRelays: ["wss://bootstrap.example"],
    naddr: bundleNaddr(LINK_SIGNER),
  };
  const session = renderHook(() => useCommunityActions(), { wrapper });
  await session.result.current.join({ invite, bundle });
  // The click's own chain fails the same transient way.
  await waitFor(() => expect(bundleQueries).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
  session.unmount();
  return jm.community_id;
}

/** One cold launch: the resume hook runs, its chain fails transiently, the app closes. */
async function launch(communityId: string): Promise<void> {
  vi.resetModules();
  const before = bundleQueries;
  const { useResumePendingJoins } = await import("@/concord/hooks/useCommunityActions");
  const { useLiveCommunities } = await import("@/concord/hooks/useCommunityList");
  const session = renderHook(
    () => {
      useResumePendingJoins();
      return useLiveCommunities();
    },
    { wrapper },
  );
  // Either the resume re-ran the chain, or the record was already given up on.
  await waitFor(() =>
    expect(
      bundleQueries > before || !session.result.current.some((e) => e.community_id === communityId),
    ).toBe(true),
  );
  await new Promise((r) => setTimeout(r, 50));
  session.unmount();
}

async function persistedIds(): Promise<string[]> {
  const { pendingJoinsKey } = await import("@/concord/lib/pendingJoins");
  const stored = h.folded.get(pendingJoinsKey(SELF)) as Array<{ community_id: string }> | undefined;
  return stored?.map((e) => e.community_id) ?? [];
}

async function coldStartLive(): Promise<string[]> {
  vi.resetModules();
  const { useLiveCommunities } = await import("@/concord/hooks/useCommunityList");
  const session = renderHook(() => useLiveCommunities(), { wrapper });
  // Let hydration from disk land.
  await new Promise((r) => setTimeout(r, 100));
  const ids = session.result.current.map((e) => e.community_id);
  session.unmount();
  return ids;
}

describe("a pending join retried within one session", () => {
  // A session retries on every return to the tab. Counting each of those toward the
  // bound gave up on the join within minutes of tab switching, dropping the community
  // the member was reading for "You don't have access" (a signer whose NIP-44 failed).
  it("is not given up on however many times the tab is revisited", { timeout: 30_000 }, async () => {
    h.relay = downRelay;
    const communityId = await clickJoin();
    const { useResumePendingJoins } = await import("@/concord/hooks/useCommunityActions");
    const { useLiveCommunities } = await import("@/concord/hooks/useCommunityList");
    const session = renderHook(
      () => {
        useResumePendingJoins();
        return useLiveCommunities();
      },
      { wrapper },
    );

    for (let i = 0; i < 40; i++) {
      const before = bundleQueries;
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(bundleQueries).toBeGreaterThan(before));
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(session.result.current.map((e) => e.community_id)).toContain(communityId);
    expect(await persistedIds()).toContain(communityId);
    session.unmount();
  });
});

describe.each([
  ["the invite bundle is no longer on its relays", () => bundleGoneRelay],
  ["every relay is unreachable", () => downRelay],
])("a pending join whose chain keeps failing because %s", (_label, relayFor) => {
  it("is given up on after a week of failed launches", { timeout: 30_000 }, async () => {
    h.relay = relayFor();
    const communityId = await clickJoin();

    // Sanity: a transient failure keeps the record for the next launch.
    expect(await persistedIds()).toContain(communityId);

    // Launch every other day for a bit over two weeks; every resume fails.
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(Date.now() + 2 * DAY);
      await launch(communityId);
    }

    expect(await persistedIds(), "pending join dropped from disk").not.toContain(communityId);
    expect(await coldStartLive(), "pending join no longer on the rail").not.toContain(communityId);
  });
});

describe("a click whose join chain fails transiently", () => {
  it("names the failure in the retry toast", async () => {
    h.relay = bundleGoneRelay;
    await clickJoin();
    await waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0].title).toBe("Couldn't finish joining Fleet");
    expect(h.toasts[0].description).toBe(
      "Couldn't find that invite on its relays. Armada will try again the next time it starts.",
    );
  });
});
