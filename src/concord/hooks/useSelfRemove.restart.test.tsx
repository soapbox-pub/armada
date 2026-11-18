/**
 * A kick must survive an app restart.
 *
 * `useSelfRemove` tears the local view down the moment a kick against my own
 * npub is confirmed: it tombstones the list entry in the react-query cache and
 * runs the vault write in the background. But the cache is memory. The rail is
 * booted on the next launch from the FOLDED list on disk
 * (`concord2-list:<pubkey>`), and nothing wrote the tombstone there — only the
 * background vault write does, at the end of a network read-modify-write. A
 * kickee whose vault write hasn't landed (offline, a gated account-state relay,
 * the app closed) relaunches with the community back on the rail.
 *
 * This drives the real `useSelfRemove` over the real `useCommunityList`, with
 * the vault write never landing, then cold-starts from what is on disk.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { addToList, EMPTY_COMMUNITY_LIST, isLive, type JoinMaterial } from "@/concord/lib/communityList";
import { bytesToHex } from "@/concord/lib/derive";
import type { FoldedControl } from "@/concord/lib/control";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import type { ListData, PersistedList } from "@/concord/hooks/useCommunityList";
import type { Community } from "@/concord/lib/types";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  folded: new Map<string, unknown>(),
  control: undefined as unknown,
  coalesced: new Map<string, unknown>(),
  guestbookRefetch: (async () => {}) as () => Promise<void>,
  updateList: undefined as unknown as (action: unknown) => Promise<unknown>,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      // Relays that hold nothing: no vault list to restore or to contradict.
      query: async () => [],
      relay: () => ({ query: async () => [], event: async () => undefined }),
      group: () => ({ query: async () => [] }),
      event: async () => undefined,
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: [] }, updateConfig: () => undefined }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/AppContext")>()),
  selfStateRelays: () => ["wss://self.test/"],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [] }),
}));
vi.mock("@/hooks/useRemoveRailKey", () => ({ useRemoveRailKey: () => () => undefined }));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
// On-disk state is this map; it outlives `vi.resetModules()` (process death).
vi.mock("@/lib/foldedCache", () => ({
  readFolded: async (key: string) => h.folded.get(key),
  readFoldedShared: async (key: string) => h.folded.get(key),
  writeFolded: async (key: string, value: unknown) => {
    h.folded.set(key, value);
  },
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => h.control,
  useDissolved: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => undefined,
  markDissolvedLocally: async () => undefined,
  probeCommunityDissolved: async () => undefined,
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbook: () => ({
    coalesced: h.coalesced,
    isLoading: false,
    isFetching: false,
    refetch: h.guestbookRefetch,
  }),
}));
// The real list hooks, except the vault write, which never lands.
vi.mock("@/concord/hooks/useCommunityList", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/hooks/useCommunityList")>()),
  useUpdateCommunityList: () => ({ mutateAsync: h.updateList }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const owner = getPublicKey(generateSecretKey());
const self = getPublicKey(generateSecretKey());
const communityId = new Uint8Array(32).fill(211);
const idHex = bytesToHex(communityId);

function community(): Community {
  return {
    id: communityId,
    idHex,
    owner,
    ownerSalt: new Uint8Array(32),
    root: new Uint8Array(32).fill(9),
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: new Uint8Array(32).fill(9) }],
    privateChannels: [],
    relays: ["wss://relay.test"],
    name: "test",
  } as unknown as Community;
}

function material(): JoinMaterial {
  return {
    community_id: idHex,
    owner,
    owner_salt: bytesToHex(new Uint8Array(32)),
    community_root: bytesToHex(new Uint8Array(32).fill(9)),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.test"],
    name: "test",
  } as unknown as JoinMaterial;
}

const foldKey = () => `concord2-list:${self}`;

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  h.user = { pubkey: self, signer: { nip44: {} } };
  h.control = {
    data: { roster: { roles: [], grants: [] }, ownerHex: owner, banned: new Set<string>(), headEditions: new Map() } as unknown as FoldedControl,
    isLoading: false,
    isFetching: false,
    refetch: async () => {},
  };
  // My coalesced Guestbook state is `kick`, postdating my membership.
  h.coalesced = new Map<string, CoalescedMember>([
    [self, { pubkey: self, state: "kick", ms: 2_000, rumorId: "a".repeat(64), fromSnapshot: false }],
  ]);
  h.guestbookRefetch = async () => {};
  // The vault write is on the network and never lands before the app closes.
  h.updateList = () => new Promise(() => undefined);

  // What a previous session left on disk: the community, live.
  const m = material();
  h.folded = new Map<string, unknown>([
    [foldKey(), {
      event: null,
      list: addToList(EMPTY_COMMUNITY_LIST, { community_id: idHex, seed: m, current: m, added_at: 1_000 }),
    } satisfies PersistedList],
  ]);
});

afterEach(() => {
  vi.resetModules();
});

/** Boot a session from disk, confirm the kick, and let the self-removal fire. */
async function kickSession(): Promise<void> {
  const { useSelfRemove } = await import("./useSelfRemove");
  const { useCommunityList, listQueryKey } = await import("./useCommunityList");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRemoved = vi.fn();
  const session = renderHook(
    () => {
      useCommunityList();
      useSelfRemove(community(), onRemoved);
    },
    { wrapper: wrapperFor(client) },
  );
  // The folded boot seeds the cache; the kick is sighted once, then confirmed
  // on a later pass (fresh refetch identity re-runs the effect).
  await waitFor(() => expect(client.getQueryData(listQueryKey(self))).toBeDefined());
  for (let i = 0; i < 20 && onRemoved.mock.calls.length === 0; i++) {
    h.guestbookRefetch = async () => {};
    session.rerender();
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(onRemoved, "the kick was acted on").toHaveBeenCalledTimes(1);
  expect(isLive(client.getQueryData<ListData>(listQueryKey(self))!.list, idHex), "tombstoned in memory").toBe(false);
  await new Promise((r) => setTimeout(r, 100)); // let any local write land
  session.unmount();
}

describe("a kick against my own npub", () => {
  it("is written to the folded list on disk, not only the query cache", { timeout: 15_000 }, async () => {
    await kickSession();

    const persisted = h.folded.get(foldKey()) as PersistedList;
    expect(isLive(persisted.list, idHex), "folded list on disk still has the community live").toBe(false);
  });

  it("keeps the community off the rail after a cold start", { timeout: 15_000 }, async () => {
    await kickSession();
    vi.resetModules(); // process death

    const fresh = await import("./useCommunityList");
    const session = renderHook(() => fresh.useLiveCommunities(), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    // Let the folded boot and the (empty) relay sync settle.
    await new Promise((r) => setTimeout(r, 500));
    expect(session.result.current.map((e) => e.community_id), "community back on the rail after restart").not.toContain(idHex);
  });

  // Control: with the tombstone on disk the same cold start keeps it off the
  // rail, so the failure above is the missing write, not the harness.
  it("control: a tombstone on disk keeps it off the rail after a cold start", { timeout: 15_000 }, async () => {
    await kickSession();
    const { removeFromList } = await import("@/concord/lib/communityList");
    const persisted = h.folded.get(foldKey()) as PersistedList;
    h.folded.set(foldKey(), { ...persisted, list: removeFromList(persisted.list, idHex, 5_000) });
    vi.resetModules();

    const fresh = await import("./useCommunityList");
    const session = renderHook(() => fresh.useLiveCommunities(), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(session.result.current.map((e) => e.community_id)).not.toContain(idHex);
  });
});
