/**
 * A creator's registry (vsk 8, CORD-05 §5) lists their live links.
 *
 * Minting: the registry write runs beside the Invite List write that records the
 * new link, and filters what it lists by that list. Read as the minting render saw
 * it, the list predates the mint, so the new link was dropped — with every other
 * link the stale list lacked — and the registry went out without it.
 *
 * Repair: registries published that way still leave out links that work, so a
 * creator opening the community re-lists them.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex } from "@/concord/lib/derive";
import { buildInviteUrl, mintLinkSigner, mintToken, parseInviteLink, type InviteList } from "@/concord/lib/invite";
import type { NostrRumor } from "@/lib/nostrRumor";

import { inviteListKey, useInviteActions, useLinkFreshnessWatch } from "./useInvites";

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  folded: undefined as unknown,
  editions: [] as NostrRumor[],
}));

const pool = {
  relay: () => ({
    event: async () => undefined,
    // The Invite List's own read never answers, as on a slow account relay.
    query: () => new Promise<never>(() => undefined),
  }),
  group: () => pool.relay(),
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: pool }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: { useAppRelays: false, appRelays: [], useUserRelays: false, relayMetadata: { relays: [], updatedAt: 0 } },
  }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({ useNostrPublish: () => ({ mutateAsync: async () => undefined }) }));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunity: () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded, isLoading: false, isFetching: false }),
  useDissolved: () => ({ data: null }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  foldStoredControl: async () => h.folded,
  withControlWrite: async (_id: string, fn: () => Promise<void>) => fn(),
  publishEdition: async (_nostr: unknown, _community: unknown, _signer: unknown, rumor: NostrRumor) => {
    h.editions.push(rumor);
  },
}));

const RELAY = "wss://relay.test";

beforeEach(() => {
  h.editions = [];
});

/** A creator holding `held` live links in their Invite List, `registered` of them in their registry. */
function creatorWith(held: number, registered: number) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  h.user = {
    pubkey,
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: { encrypt: async () => "", decrypt: async () => "" },
    },
  };
  const { community } = mintCommunity("Fleet", pubkey, [RELAY]);
  const links = Array.from({ length: held }, () => mintLinkSigner());
  const list: InviteList = {
    entries: links.map((link, i) => {
      const token = mintToken();
      return {
        token: bytesToHex(token),
        signer_sk: bytesToHex(link.sk),
        community_id: community.idHex,
        url: buildInviteUrl("https://armada.test", link.pk, token, [RELAY]),
        created_at: i + 1,
      };
    }),
    tombstones: [],
  };
  const registry = links.slice(0, registered).map((l) => l.pk);
  h.folded = {
    ownerHex: pubkey,
    roster: { roles: [], grants: [] },
    channels: new Map(),
    heads: new Map(),
    metadata: { name: "Fleet" },
    registriesByCreator: new Map([[pubkey, registry]]),
    liveInviteLinks: new Set(registry),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(inviteListKey(pubkey), list);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { community, links, wrapper };
}

describe("createLink", () => {
  it("lists the new link in the registry beside the links already there", { timeout: 15_000 }, async () => {
    const { community, links, wrapper } = creatorWith(1, 1);
    const { result } = renderHook(() => useInviteActions(community), { wrapper });

    let url = "";
    await act(async () => {
      url = await result.current.createLink({});
    });
    await vi.waitFor(() => expect(h.editions).toHaveLength(1), { timeout: 5_000 });

    const minted = parseInviteLink(url)!.linkSigner;
    expect(JSON.parse(h.editions[0].content)).toEqual([links[0].pk, minted]);
  });
});

describe("opening the community as a link creator", () => {
  it("re-lists the live links the registry leaves out", { timeout: 15_000 }, async () => {
    const { community, links, wrapper } = creatorWith(3, 1);
    renderHook(() => useLinkFreshnessWatch(community), { wrapper });
    await vi.waitFor(() => expect(h.editions).toHaveLength(1), { timeout: 5_000 });
    expect(new Set(JSON.parse(h.editions[0].content))).toEqual(new Set(links.map((l) => l.pk)));
  });

  it("publishes nothing when the registry already lists every live link", { timeout: 15_000 }, async () => {
    const { community, wrapper } = creatorWith(2, 2);
    renderHook(() => useLinkFreshnessWatch(community), { wrapper });
    await new Promise((r) => setTimeout(r, 500));
    expect(h.editions).toHaveLength(0);
  });
});
