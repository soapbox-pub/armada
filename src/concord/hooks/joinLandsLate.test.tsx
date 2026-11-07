/**
 * A Join that reaches the community's relays long after the click it is dated
 * to. `completeJoin` publishes the Join only after the membership-list (kind
 * 33302) write succeeds; a list write that fails transiently (here the signer's
 * NIP-44) leaves a pending join that shows the community and lets the member
 * post, while the Join waits for a later launch's resume. Readers that act on a
 * Join's arrival (a welcome bot) then see it after messages it is dated before.
 *
 * Cases marked REPRO assert the current behavior; a fix inverts them.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import type { NUser } from "@nostrify/react/login";

// ── Fake network ─────────────────────────────────────────────────────────────

class FakeRelay {
  stored: NostrEvent[] = [];

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    return this.stored.filter((ev) => matchFilters(filters, ev));
  }

  async event(ev: NostrEvent): Promise<void> {
    if (!this.stored.some((e) => e.id === ev.id)) this.stored.push(ev);
  }
}

const h = vi.hoisted(() => ({
  relays: new Map<string, unknown>(),
  user: undefined as unknown,
  /** Every publish the network kept, in arrival order. */
  arrivals: [] as Array<{ url: string; id: string }>,
}));

function relayAt(url: string): FakeRelay {
  let relay = h.relays.get(url) as FakeRelay | undefined;
  if (!relay) {
    relay = new FakeRelay();
    const event = relay.event.bind(relay);
    relay.event = async (ev: NostrEvent) => {
      h.arrivals.push({ url, id: ev.id });
      return event(ev);
    };
    h.relays.set(url, relay);
  }
  return relay;
}

const pool = {
  relay: (url: string) => relayAt(url),
  group: (urls: string[]) => ({
    query: async (filters: Filter[]) => (await Promise.all(urls.map((u) => relayAt(u).query(filters)))).flat(),
    event: async (ev: NostrEvent) => {
      await Promise.any(urls.map((u) => relayAt(u).event(ev)));
    },
  }),
  query: async (filters: Filter[]) =>
    (await Promise.all([...h.relays.values()].map((r) => (r as FakeRelay).query(filters)))).flat(),
  event: async (ev: NostrEvent) => {
    await Promise.any([...h.relays.values()].map((r) => (r as FakeRelay).event(ev)));
  },
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: pool }) }));
vi.mock("@/hooks/useAccountSecret", () => ({ useAccountSecret: () => undefined }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://app.test"], communityRelays: [] } }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selfStateRelays: () => [SELF_RELAY],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [], event: async () => undefined }),
}));
vi.mock("@/hooks/useRemoveRailKey", () => ({ useRemoveRailKey: () => () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: null }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELF_RELAY = "wss://self.test";
const BOOTSTRAP = "wss://bootstrap.test";
const COMMUNITY_RELAYS = ["wss://one.test", "wss://two.test"];
const OWNER_SK = generateSecretKey();
const OWNER = getPublicKey(OWNER_SK);
// Fresh per case: pending joins and list records persist in KV across cases.
let MEMBER_SK = generateSecretKey();
let MEMBER = getPublicKey(MEMBER_SK);

/**
 * The member's signer. With `nip44Broken` it still signs (the chat plane only
 * needs signatures) but its NIP-44 fails, which the membership list needs.
 */
function memberUser(nip44Broken: boolean): NUser {
  const sk = MEMBER_SK;
  const pubkey = MEMBER;
  const nip44 = (op: () => string) => async () => {
    if (nip44Broken) throw new Error("signer did not answer nip44_encrypt");
    return op();
  };
  return {
    pubkey,
    method: "bunker",
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {
        encrypt: (pk: string, plaintext: string) =>
          nip44(() => nip44Encrypt(plaintext, getConversationKey(sk, pk)))(),
        decrypt: (pk: string, ciphertext: string) =>
          nip44(() => nip44Decrypt(ciphertext, getConversationKey(sk, pk)))(),
      },
    },
  } as unknown as NUser;
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const freshClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function publishInvite() {
  const { mintCommunity } = await import("@/concord/lib/community");
  const { toJoinMaterial } = await import("@/concord/lib/communityList");
  const { buildMetadataEdition, currentControlWriteGroup, sealEdition } = await import("@/concord/lib/control");
  const { buildBundleEvent, bundleNaddr, mintLinkSigner, mintToken } = await import("@/concord/lib/invite");
  const { community } = mintCommunity("Soapbox Community", OWNER, COMMUNITY_RELAYS);
  const genesis = await sealEdition(
    buildMetadataEdition(
      community.id,
      { name: community.name, relays: community.relays },
      { actorPubkey: OWNER, version: 1n },
    ),
    currentControlWriteGroup(community),
    { signEvent: async (t: EventTemplate) => finalizeEvent(t, OWNER_SK) },
  );
  for (const url of COMMUNITY_RELAYS) relayAt(url).stored.push(genesis);
  const jm = toJoinMaterial(community, { relays: community.relays });
  const bundle = { ...jm, channels: [], relays: community.relays, name: "Soapbox Community" };
  const link = mintLinkSigner();
  const token = mintToken();
  relayAt(BOOTSTRAP).stored.push(await buildBundleEvent(bundle, token, link.sk));
  const invite = { linkSigner: link.pk, token, bootstrapRelays: [BOOTSTRAP], naddr: bundleNaddr(link.pk) };
  return { community, invite };
}

async function channelOf(community: { root: Uint8Array }) {
  const { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } = await import("@/concord/lib/derive");
  const id = new Uint8Array(32).fill(0x9a);
  const group = channelGroupKey(community.root, id, 0);
  const stream = { epoch: 0n, group };
  return {
    id,
    idHex: bytesToHex(id),
    name: "general",
    isPrivate: false,
    voice: { room: voiceGroupKey(community.root, id, 0), mediaKey: voiceMediaKey(community.root, id, 0) },
    streams: [stream],
    current: stream,
  };
}

type Minted = Awaited<ReturnType<typeof publishInvite>>["community"];

/** The member's guestbook Joins on the first community relay, opened. */
async function joinsOnRelay(community: Minted) {
  const { currentGuestbookGroup } = await import("@/concord/lib/guestbook");
  const { openWrap } = await import("@/concord/lib/stream");
  const gb = currentGuestbookGroup(community);
  return relayAt(COMMUNITY_RELAYS[0]!).stored
    .filter((e) => e.kind === 1059 && e.pubkey === gb.pk)
    .map((wrap) => ({ wrap, opened: openWrap(wrap, gb) }))
    .filter(({ opened }) => opened.author === MEMBER && opened.content === "join");
}

/** Arrival position of an event on the first community relay. */
function arrivalIndex(id: string): number {
  return h.arrivals.findIndex((a) => a.url === COMMUNITY_RELAYS[0] && a.id === id);
}

beforeEach(() => {
  MEMBER_SK = generateSecretKey();
  MEMBER = getPublicKey(MEMBER_SK);
  h.relays.clear();
  h.arrivals.length = 0;
});

afterEach(() => {
  vi.resetModules();
});

describe("a join whose membership-list write fails", { timeout: 30_000 }, () => {
  async function joinWith(user: NUser) {
    h.user = user;
    const { community, invite } = await publishInvite();
    const { useCommunityActions } = await import("@/concord/hooks/useCommunityActions");
    const { useLiveCommunities } = await import("@/concord/hooks/useCommunityList");
    const hook = renderHook(() => ({ actions: useCommunityActions(), live: useLiveCommunities() }), {
      wrapper: wrapperFor(freshClient()),
    });
    // The invite page's Accept: the optimistic path, with the preview's bundle.
    const preview = await hook.result.current.actions.preview({ invite });
    await hook.result.current.actions.join({ invite, bundle: preview.bundle });
    await waitFor(() => expect(hook.result.current.live.map((e) => e.community_id)).toContain(community.idHex));
    // Let the background chain (list write, then Join) run to its end.
    await new Promise((r) => setTimeout(r, 300));
    return { community, hook };
  }

  async function postIn(community: Minted, content: string) {
    const channel = await channelOf(community);
    const { useSendMessage } = await import("@/concord/hooks/useChannel");
    const { result } = renderHook(() => useSendMessage(community, channel as never), {
      wrapper: wrapperFor(freshClient()),
    });
    let rumorId = "";
    await act(async () => {
      ({ rumorId } = await result.current.mutateAsync({ content }));
    });
    const { channelGroupKey } = await import("@/concord/lib/derive");
    const streamPk = channelGroupKey(community.root, channel.id, 0).pk;
    await waitFor(() =>
      expect(relayAt(COMMUNITY_RELAYS[0]!).stored.some((e) => e.pubkey === streamPk)).toBe(true),
    );
    const wrap = relayAt(COMMUNITY_RELAYS[0]!).stored.find((e) => e.pubkey === streamPk)!;
    const { openWrap } = await import("@/concord/lib/stream");
    return { rumorId, wrap, opened: openWrap(wrap, { pk: streamPk, convKey: channelGroupKey(community.root, channel.id, 0).convKey } as never) };
  }

  it("control: a working signer lands the list and the Join at the click", async () => {
    const { community } = await joinWith(memberUser(false));
    expect(relayAt(SELF_RELAY).stored.some((e) => e.kind === 33302)).toBe(true);
    await waitFor(async () => expect(await joinsOnRelay(community)).toHaveLength(1));
  });

  it("REPRO: the community works and the member posts, with no Join on any relay", async () => {
    const { community, hook } = await joinWith(memberUser(true));

    // On the member's screen they are in: the community is on the rail…
    expect(hook.result.current.live.map((e) => e.community_id)).toContain(community.idHex);
    // …and their message reaches the community relays.
    const message = await postIn(community, "No way, it's me");
    expect(message.opened.author).toBe(MEMBER);

    // But the list write failed, so the Join was never sent. FIX: the Join
    // should not wait on the member's own list write.
    expect(relayAt(SELF_RELAY).stored.some((e) => e.kind === 33302)).toBe(false);
    expect(await joinsOnRelay(community)).toHaveLength(0);
  });

  it("REPRO: the next launch's resume lands the Join after messages it is dated before", async () => {
    const { community, hook } = await joinWith(memberUser(true));
    const message = await postIn(community, "No way, it's me");
    hook.unmount();

    // A later launch with a working signer (the member switched to Amber).
    await new Promise((r) => setTimeout(r, 250)); // pending record's KV write
    vi.resetModules();
    h.user = memberUser(false);
    const { useResumePendingJoins } = await import("@/concord/hooks/useCommunityActions");
    renderHook(() => useResumePendingJoins(), { wrapper: wrapperFor(freshClient()) });
    await waitFor(async () => expect(await joinsOnRelay(community)).toHaveLength(1));

    const [join] = await joinsOnRelay(community);
    // The Join is dated to the original click, before the member's message…
    expect(join!.opened.ms).toBeLessThanOrEqual(message.opened.ms);
    // …yet reaches the relay after it, as a reader acting on arrival sees a
    // fresh join by someone already talking. FIX: invert with the one above.
    expect(arrivalIndex(join!.wrap.id)).toBeGreaterThan(arrivalIndex(message.wrap.id));
  });
});
