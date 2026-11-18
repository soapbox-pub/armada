/**
 * "Leave community" — the two background halves the leave no longer waits
 * for, when one of them fails.
 *
 * `useCommunityManagement().leave` tombstones the community locally, then fires
 * the Guestbook Leave publish and the vault write side by side and returns.
 * Both are fire-and-forget:
 *
 *  - The Guestbook Leave is `.catch(() => undefined)`. If every community
 *    relay refuses it, nothing records that it is owed and nothing publishes
 *    it later, so the other members keep seeing the user in the member list.
 *  - The rail-arrangement key (`c2:<id>`) is purged in the vault mutation's
 *    `onSuccess`, so a vault write that fails leaves the key in `railLayout`
 *    and a later rejoin reappears inside the folder it used to live in — even
 *    though the community HAS been left, locally and durably.
 *
 * This drives the REAL leave, guestbook publisher and list mutation (and the
 * real `useRemoveRailKey` over a recorded config) against a relay pool mock.
 */

import { NSecSigner } from "@nostrify/nostrify";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { addToList, EMPTY_COMMUNITY_LIST, isLive, type JoinMaterial } from "@/concord/lib/communityList";
import { bytesToHex } from "@/concord/lib/derive";
import { currentGuestbookGroup } from "@/concord/lib/guestbook";
import { openPlaneWraps } from "@/concord/lib/planeSync";
import type { Community } from "@/concord/lib/types";
import { flattenLayout, type RailLayoutNode } from "@/lib/railLayout";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { ListData } from "./useCommunityList";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  nostr: undefined as unknown,
  user: undefined as unknown,
  folded: new Map<string, unknown>(),
  config: { appRelays: [] as string[], railLayout: [] as unknown[] },
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: h.config,
    updateConfig: (fn: (c: typeof h.config) => typeof h.config) => {
      h.config = fn(h.config);
    },
  }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/AppContext")>()),
  selfStateRelays: () => [SELF_RELAY],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [] }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
// On-disk state is this map; it outlives `vi.resetModules()` (process death).
vi.mock("@/lib/foldedCache", () => ({
  readFolded: async (key: string) => h.folded.get(key),
  readFoldedShared: async (key: string) => h.folded.get(key),
  writeFolded: async (key: string, value: unknown) => {
    h.folded.set(key, value);
  },
}));
vi.mock("@/concord/lib/rumorStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/rumorStore")>()),
  writeOpened: async () => undefined,
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => undefined,
  markDissolvedLocally: async () => undefined,
  probeCommunityDissolved: async () => undefined,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELF_RELAY = "wss://self.test/";
const COMMUNITY_RELAY = "wss://community.test/";
/** Relay URLs reach the pool with or without a trailing slash. */
const norm = (url: string) => url.replace(/\/+$/, "");

interface Pool {
  /** Every EVENT a relay ACCEPTED, by relay URL. */
  accepted: Array<{ url: string; event: NostrEvent }>;
  /** Relays whose EVENTs are refused. */
  refuseEvents: Set<string>;
  /** Relays whose REQs fail. */
  refuseReads: Set<string>;
}

function pool(): Pool {
  const p: Pool = { accepted: [], refuseEvents: new Set(), refuseReads: new Set() };
  h.nostr = {
    query: async () => [],
    event: async () => undefined,
    relay: (url: string) => ({
      query: async (_f: NostrFilter[]) => {
        if (p.refuseReads.has(norm(url))) throw new Error(`${url} unreachable`);
        return [];
      },
      event: async (event: NostrEvent) => {
        if (p.refuseEvents.has(norm(url))) throw new Error(`${url} refused`);
        p.accepted.push({ url: norm(url), event });
      },
    }),
  };
  return p;
}

function setup() {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  h.user = { pubkey, signer: new NSecSigner(sk) };
  const { community } = mintCommunity("Fleet", getPublicKey(generateSecretKey()), [COMMUNITY_RELAY]);
  const material = {
    community_id: community.idHex,
    owner: community.owner,
    owner_salt: bytesToHex(community.ownerSalt),
    community_root: bytesToHex(community.root),
    root_epoch: 0,
    channels: [],
    relays: [COMMUNITY_RELAY],
    name: "Fleet",
  } as unknown as JoinMaterial;
  const list = addToList(EMPTY_COMMUNITY_LIST, {
    community_id: community.idHex,
    seed: material,
    current: material,
    added_at: 1_000,
  });
  // The rail arrangement: the community sits in a folder with a NIP-29 server.
  h.config = {
    appRelays: [],
    railLayout: [
      { type: "folder", id: "f1", name: "Work", keys: [`c2:${community.idHex}`, "wss://nip29.test/"] },
    ] satisfies RailLayoutNode[],
  };
  h.folded.set(`concord2-list:${pubkey}`, { event: null, list });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: "always" } },
  });
  client.setQueryData<ListData>(["concord", "list", pubkey], { event: null, list });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, community, pubkey, wrapper };
}

function railKeys(): string[] {
  return flattenLayout(h.config.railLayout as RailLayoutNode[]);
}

/** Guestbook Leave wraps a relay accepted for this community. */
function guestbookLeaves(p: Pool, community: Community): NostrEvent[] {
  const group = currentGuestbookGroup(community);
  return p.accepted
    .filter((a) => a.url === norm(COMMUNITY_RELAY))
    .map((a) => a.event)
    .filter((wrap) => openPlaneWraps([wrap], [group]).some((o) => o.content === "leave"));
}

/** The background vault write (the `concord-list` mutation) has settled. */
async function vaultWriteSettled(client: QueryClient, status: "success" | "error"): Promise<void> {
  await waitFor(() =>
    expect(
      client.getMutationCache().getAll().filter((m) => m.options.scope?.id === "concord-list").map((m) => m.state.status),
    ).toContain(status),
  );
}

beforeEach(() => {
  h.folded = new Map();
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Leave community, background halves", () => {
  // Control: with every relay healthy the harness observes both the Guestbook
  // Leave and the rail-key purge, so the failures below are the leave's.
  it("control: healthy relays get the Guestbook Leave and purge the rail key", { timeout: 20_000 }, async () => {
    const p = pool();
    const { client, community, wrapper } = setup();
    const { useCommunityManagement } = await import("./useCommunityActions");
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await act(() => result.current.leave());
    await vaultWriteSettled(client, "success");
    await waitFor(() => expect(guestbookLeaves(p, community).length).toBeGreaterThan(0));
    expect(railKeys()).not.toContain(`c2:${community.idHex}`);
    expect(railKeys()).toContain("wss://nip29.test/");
  });

  it(
    "a Guestbook Leave every community relay refused is published on the next launch",
    { timeout: 20_000 },
    async () => {
      const p = pool();
      p.refuseEvents.add(norm(COMMUNITY_RELAY));
      const { client, community, pubkey, wrapper } = setup();
      const { useCommunityManagement } = await import("./useCommunityActions");
      const session1 = renderHook(() => useCommunityManagement(community), { wrapper });

      await act(() => session1.result.current.leave());
      await vaultWriteSettled(client, "success");
      // Give the guestbook publish every chance to have run and failed.
      await new Promise((r) => setTimeout(r, 200));
      expect(isLive(client.getQueryData<ListData>(["concord", "list", pubkey])!.list, community.idHex)).toBe(false);
      expect(guestbookLeaves(p, community), "sanity: the relay refused the first Leave").toHaveLength(0);
      session1.unmount();

      // ── Restart: the community relay is reachable again ─────────────────
      vi.resetModules();
      p.refuseEvents.clear();
      const { PublishOutbox } = await import("@/components/PublishOutbox");
      const { useResumePendingJoins } = await import("./useCommunityActions");
      const { useLiveCommunities } = await import("./useCommunityList");
      const client2 = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always" } } });
      // What a signed-in launch mounts: the publish outbox, the Concord
      // resume hook and the rail's list.
      const session2 = renderHook(
        () => {
          useResumePendingJoins();
          return useLiveCommunities();
        },
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client2}>
              <PublishOutbox />
              {children}
            </QueryClientProvider>
          ),
        },
      );

      await new Promise((r) => setTimeout(r, 1_500));
      expect(session2.result.current.map((e) => e.community_id), "sanity: still left after restart").not.toContain(community.idHex);
      expect(guestbookLeaves(p, community).length, "the owed Guestbook Leave reached the community relay").toBeGreaterThan(0);
      session2.unmount();
    },
  );

  it("the rail-arrangement key is purged even when the vault write fails", { timeout: 20_000 }, async () => {
    const p = pool();
    p.refuseReads.add(norm(SELF_RELAY)); // the vault RMW can't confirm its read → throws
    const { client, community, pubkey, wrapper } = setup();
    const { useCommunityManagement } = await import("./useCommunityActions");
    expect(railKeys()).toContain(`c2:${community.idHex}`);

    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await act(() => result.current.leave());
    await vaultWriteSettled(client, "error");

    // Left locally and durably (on disk), so the arrangement must follow.
    expect(isLive(client.getQueryData<ListData>(["concord", "list", pubkey])!.list, community.idHex)).toBe(false);
    const fold = h.folded.get(`concord2-list:${pubkey}`) as { list: ListData["list"] };
    expect(isLive(fold.list, community.idHex), "sanity: tombstone is on disk").toBe(false);
    expect(railKeys(), "rail key for the left community").not.toContain(`c2:${community.idHex}`);
    expect(railKeys(), "unrelated rail keys untouched").toContain("wss://nip29.test/");
  });

  it(
    "the rail-arrangement key is purged by the sync that later republishes the tombstone",
    { timeout: 20_000 },
    async () => {
      const p = pool();
      p.refuseReads.add(norm(SELF_RELAY));
      const { client, community, wrapper } = setup();
      const { useCommunityManagement } = await import("./useCommunityActions");
      const { useCommunityList } = await import("./useCommunityList");

      const { result } = renderHook(
        () => ({ manage: useCommunityManagement(community), list: useCommunityList() }),
        { wrapper },
      );
      await act(() => result.current.manage.leave());
      await vaultWriteSettled(client, "error");

      // The account-state relay comes back; the next sync's reconcile is what
      // "republishes it" per the leave's own comment.
      p.refuseReads.clear();
      const sentBefore = p.accepted.filter((a) => a.url === norm(SELF_RELAY)).length;
      await act(async () => {
        await result.current.list.refetch();
      });
      await waitFor(() =>
        expect(p.accepted.filter((a) => a.url === norm(SELF_RELAY)).length, "sanity: the sync republished the vault").toBeGreaterThan(sentBefore),
      );
      await new Promise((r) => setTimeout(r, 200));

      expect(railKeys(), "rail key for the left community").not.toContain(`c2:${community.idHex}`);
    },
  );
});
