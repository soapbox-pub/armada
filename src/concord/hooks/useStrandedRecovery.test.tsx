/**
 * useStrandedRecovery — the stranded joiner's self-heal (CORD-05 §2).
 *
 * A stale public invite drops a joiner onto a superseded epoch (see
 * useRekeyWatch's `stranded`). The recovery re-resolves the SAME link the
 * member joined through (persisted as `entry.invite_ref`) and, once the
 * creator has refreshed the bundle to a higher epoch, merges it forward via
 * the epoch-monotonic list `add`. A still-stale bundle must be a no-op.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { describe, expect, it, vi } from "vitest";

import { useStrandedRecovery } from "./useCommunityActions";
import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import {
  buildBundleEvent,
  bundleNaddr,
  encodeFragment,
  mintLinkSigner,
  mintToken,
  type InviteBundle,
} from "@/concord/lib/invite";
import type { Community } from "@/concord/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/pure";
import type { NUser } from "@nostrify/react/login";
import type { ReactNode } from "react";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  user: undefined as unknown,
  entry: undefined as unknown,
  updateList: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: [] } }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => h.entry,
  useUpdateCommunityList: () => ({ mutateAsync: h.updateList }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => undefined,
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbookPublisher: () => ({ mutateAsync: async () => undefined }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY = "wss://relay.test";

class FakeRelay {
  events: NostrEvent[] = [];
  published: NostrEvent[] = [];

  async query(filters: Array<{ kinds?: number[]; authors?: string[] }>): Promise<NostrEvent[]> {
    return this.events.filter((ev) =>
      filters.some(
        (f) => (!f.kinds || f.kinds.includes(ev.kind)) && (!f.authors || f.authors.includes(ev.pubkey)),
      ),
    );
  }

  async event(ev: NostrEvent): Promise<void> {
    this.published.push(ev);
  }
}

function makeUser() {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    signer: {
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {
        encrypt: async (pk: string, pt: string) => nip44Encrypt(pt, getConversationKey(sk, pk)),
        decrypt: async (pk: string, ct: string) => nip44Decrypt(ct, getConversationKey(sk, pk)),
      },
    },
  } as unknown as NUser;
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper };
}

/** A community held at epoch 1, plus its live link whose bundle vends `bundleEpoch`. */
async function setup(bundleEpoch: number) {
  const ownerSk = generateSecretKey();
  const owner = getPublicKey(ownerSk);
  const { community: minted } = mintCommunity("Fleet", owner, [RELAY]);
  const held: Community = { ...minted, rootEpoch: 1n, root: random32() };

  const link = mintLinkSigner();
  const token = mintToken();
  const bundle: InviteBundle = {
    community_id: held.idHex,
    owner: held.owner,
    owner_salt: bytesToHex(held.ownerSalt),
    community_root: bytesToHex(random32()),
    root_epoch: bundleEpoch,
    channels: [],
    relays: [RELAY],
    name: "Fleet",
    creator_npub: owner,
  };
  const inviteRef = `${bundleNaddr(link.pk)}#${encodeFragment(token, [RELAY])}`;

  const relay = new FakeRelay();
  relay.events = [await buildBundleEvent(bundle, token, link.sk)];
  h.pool = { relay: () => relay };
  h.user = makeUser();
  h.updateList = vi.fn(async () => {});
  h.entry = {
    community_id: held.idHex,
    seed: {},
    current: {},
    added_at: Date.now(),
    invite_ref: inviteRef,
  };
  return { held, relay, inviteRef };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useStrandedRecovery (stranded self-heal, CORD-05 §2)", () => {
  it("a refreshed bundle at a HIGHER epoch merges forward and keeps the link ref", async () => {
    const { held, relay, inviteRef } = await setup(2);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStrandedRecovery(held, true), { wrapper });
    expect(result.current.canRecover).toBe(true);

    const healed = await result.current.checkNow();
    expect(healed).toBe(true);
    expect(h.updateList).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "add",
        entry: expect.objectContaining({
          community_id: held.idHex,
          invite_ref: inviteRef, // the anchor survives the catch-up
          current: expect.objectContaining({ root_epoch: 2 }),
        }),
      }),
    );

    // No Join is posted here: the new epoch's Guestbook may already seed us, so the
    // Join is restored once it is read and holds no state of ours (CORD-02 §5, `useRestoreJoin`).
    expect(relay.published).toEqual([]);
  });

  it("a bundle still vending my epoch (or older) is a no-op", async () => {
    const { held } = await setup(1); // equal to what I hold — creator hasn't refreshed

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStrandedRecovery(held, true), { wrapper });

    const healed = await result.current.checkNow();
    expect(healed).toBe(false);
    expect(h.updateList).not.toHaveBeenCalled();
  });

  it("is inert without a stored link ref (direct-invite joins, legacy entries)", async () => {
    const { held } = await setup(2);
    h.entry = { ...(h.entry as Record<string, unknown>), invite_ref: undefined };

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStrandedRecovery(held, true), { wrapper });
    expect(result.current.canRecover).toBe(false);
  });
});
