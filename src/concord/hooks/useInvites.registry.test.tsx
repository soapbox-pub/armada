/**
 * Minting a link lists it in the creator's registry (vsk 8, CORD-05 §5).
 *
 * The registry write runs beside the Invite List write that records the new
 * link, and filters what it lists by that list. Read as the minting render saw
 * it, the list predates the mint, so the new link was dropped — with every other
 * link the stale list lacked — and the registry went out without it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex } from "@/concord/lib/derive";
import { buildInviteUrl, mintLinkSigner, mintToken, parseInviteLink, type InviteList } from "@/concord/lib/invite";
import type { NostrRumor } from "@/lib/nostrRumor";

import { inviteListKey, useInviteActions } from "./useInvites";

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

describe("createLink", () => {
  it("lists the new link in the registry beside the links already there", { timeout: 15_000 }, async () => {
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
    const held = mintLinkSigner();
    const token = mintToken();
    const list: InviteList = {
      entries: [{
        token: bytesToHex(token),
        signer_sk: bytesToHex(held.sk),
        community_id: community.idHex,
        url: buildInviteUrl("https://armada.test", held.pk, token, [RELAY]),
        created_at: 1,
      }],
      tombstones: [],
    };
    h.folded = {
      ownerHex: pubkey,
      roster: { roles: [], grants: [] },
      channels: new Map(),
      heads: new Map(),
      registriesByCreator: new Map([[pubkey, [held.pk]]]),
      liveInviteLinks: new Set([held.pk]),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    queryClient.setQueryData(inviteListKey(pubkey), list);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInviteActions(community), { wrapper });

    let url = "";
    await act(async () => {
      url = await result.current.createLink({});
    });
    await vi.waitFor(() => expect(h.editions).toHaveLength(1), { timeout: 5_000 });

    const minted = parseInviteLink(url)!.linkSigner;
    expect(JSON.parse(h.editions[0].content)).toEqual([held.pk, minted]);
  });
});
