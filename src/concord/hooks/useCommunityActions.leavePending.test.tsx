/**
 * Leaving a community whose optimistic join is still settling.
 *
 * The join chain's vault write can sit behind a slow remote signer for most of
 * a minute, and the user can Leave the pending entry in that window. The leave
 * publishes its Guestbook Leave at once; a Guestbook Join published after it
 * would be the newest entry in the coalesce, and every other member would see
 * the user as joined after they left. So a join walked away from while its
 * vault write was in flight must not announce itself.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex } from "@/concord/lib/derive";
import {
  buildBundleEvent,
  buildInviteUrl,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  type InviteBundle,
} from "@/concord/lib/invite";
import {
  _resetPendingJoinsForTests,
  forgetPendingJoin,
  hasPendingJoin,
  persistPendingJoin,
} from "@/concord/lib/pendingJoins";

import { bundleToEntry, inviteRefOf, useCommunityActions } from "./useCommunityActions";

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  nostr: undefined as unknown,
  published: 0,
  addStarted: undefined as undefined | (() => void),
  releaseAdd: undefined as undefined | ((list?: unknown) => void),
  lastAdd: undefined as undefined | { entry: { added_at: number }; replay?: boolean },
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.test"] } }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => undefined,
  markDissolvedLocally: async () => undefined,
  probeCommunityDissolved: async () => undefined,
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => undefined,
  cachedCommunity: () => undefined,
  AlreadyMemberError: class extends Error {},
  // The vault write: held open until the test lets it land.
  useUpdateCommunityList: () => ({
    mutateAsync: (write: { type: string; entry?: { added_at: number }; replay?: boolean }) =>
      write.type === "add"
        ? new Promise<unknown>((resolve) => {
          h.lastAdd = write as typeof h.lastAdd;
          // Resolves with the list the add produced, as the real write does.
          h.releaseAdd = (list) => resolve(list ?? { entries: [write.entry], tombstones: [] });
          h.addStarted?.();
        })
        : Promise.resolve(),
  }),
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbookPublisher: () => ({ mutateAsync: async () => undefined }),
}));

const RELAY = "wss://relay.test";

function signer() {
  const sk = generateSecretKey();
  return {
    pubkey: getPublicKey(sk),
    signer: {
      getPublicKey: async () => getPublicKey(sk),
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {},
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function liveInvite(ownerPubkey: string) {
  const { community } = mintCommunity("Fleet", ownerPubkey, [RELAY]);
  const bundle: InviteBundle = {
    community_id: community.idHex,
    owner: community.owner,
    owner_salt: bytesToHex(community.ownerSalt),
    community_root: bytesToHex(community.root),
    root_epoch: 0,
    control_pk: community.controlPk,
    channels: [],
    relays: [RELAY],
    name: "Fleet",
  } as InviteBundle;
  const token = mintToken();
  const link = mintLinkSigner();
  const event = await buildBundleEvent(bundle, token, link.sk);
  const invite = parseInviteLink(buildInviteUrl("https://armada.test", link.pk, token, [RELAY]))!;
  h.nostr = {
    relay: () => ({
      query: async () => [event],
      event: async () => {
        h.published += 1;
      },
    }),
  };
  return { invite, bundle };
}

beforeEach(() => {
  _resetPendingJoinsForTests();
  h.published = 0;
  h.releaseAdd = undefined;
  h.lastAdd = undefined;
});

async function joinUntilVaultWrite(leaveMidway: boolean) {
  const me = signer();
  h.user = me;
  const { invite, bundle } = await liveInvite(signer().pubkey);
  const addStarted = new Promise<void>((resolve) => (h.addStarted = resolve));

  const { result } = renderHook(() => useCommunityActions(), { wrapper });
  await result.current.join({ invite, bundle });
  await addStarted;

  // The user leaves the pending entry while the vault write is in flight —
  // the leave's first act (useCommunityManagement.leave).
  if (leaveMidway) await forgetPendingJoin(me.pubkey, bundle.community_id);
  h.releaseAdd!();
  return { me, bundle };
}

describe("a pending join left while its vault write is in flight", () => {
  it("publishes no Guestbook Join", async () => {
    const { me, bundle } = await joinUntilVaultWrite(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.published).toBe(0);
    expect(hasPendingJoin(me.pubkey, bundle.community_id)).toBe(false);
  });

  it("control: a join nobody left still announces itself", async () => {
    await joinUntilVaultWrite(false);
    await waitFor(() => expect(h.published).toBeGreaterThan(0));
  });
});

describe("a pending join resumed after a restart", () => {
  const CLICK = 1_719_800_000_000;

  async function resume() {
    const me = signer();
    h.user = me;
    const { invite, bundle } = await liveInvite(signer().pubkey);
    // The earlier launch recorded the click, then was closed mid-chain.
    await persistPendingJoin(me.pubkey, { ...bundleToEntry(bundle, { inviteRef: inviteRefOf(invite) }), added_at: CLICK });
    const addStarted = new Promise<void>((resolve) => (h.addStarted = resolve));
    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    result.current.settleJoin(invite, bundle.community_id, bundle.name, true);
    await addStarted;
    return { me, bundle };
  }

  it("is written as a replay dated by its click, not by the resume", async () => {
    await resume();
    expect(h.lastAdd?.replay).toBe(true);
    expect(h.lastAdd?.entry.added_at).toBe(CLICK);
  });

  it("announces nothing when a later removal superseded it", async () => {
    const { me, bundle } = await resume();
    h.releaseAdd!({
      entries: [h.lastAdd!.entry],
      tombstones: [{ community_id: bundle.community_id, removed_at: CLICK + 60_000 }],
    });
    await waitFor(() => expect(hasPendingJoin(me.pubkey, bundle.community_id)).toBe(false));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.published).toBe(0);
  });
});
