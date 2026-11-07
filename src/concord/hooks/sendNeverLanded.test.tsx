/**
 * Joins and messages that never reach a relay must not read as joined/sent.
 * These drive the real join and send hooks against a fake network whose relays
 * can keep, reject, hang on, or ack-and-drop a publish, and a signer that can
 * refuse or never answer, like a bunker.
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

/**
 * How a relay answers a publish. Reads always work: the reported member could
 * see everyone else's messages.
 *  keep        OK true, stored
 *  reject      OK false
 *  hang        never answers (a dead socket, or a tab frozen in the background)
 *  ackAndDrop  OK true, never stored (a lossy relay)
 */
type PublishMode = "keep" | "reject" | "hang" | "ackAndDrop";

class FakeRelay {
  stored: NostrEvent[] = [];
  attempts: NostrEvent[] = [];
  mode: PublishMode = "keep";

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    return this.stored.filter((ev) => matchFilters(filters, ev));
  }

  event(ev: NostrEvent): Promise<void> {
    this.attempts.push(ev);
    switch (this.mode) {
      case "keep":
        if (!this.stored.some((e) => e.id === ev.id)) this.stored.push(ev);
        return Promise.resolve();
      case "ackAndDrop":
        return Promise.resolve();
      case "reject":
        return Promise.reject(new Error("blocked: rejected"));
      case "hang":
        return new Promise(() => undefined);
    }
  }
}

const h = vi.hoisted(() => ({
  relays: new Map<string, unknown>(),
  user: undefined as unknown,
}));

function relayAt(url: string): FakeRelay {
  let relay = h.relays.get(url) as FakeRelay | undefined;
  if (!relay) {
    relay = new FakeRelay();
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
const COMMUNITY_RELAYS = ["wss://one.test", "wss://two.test", "wss://three.test"];
const OWNER_SK = generateSecretKey();
const OWNER = getPublicKey(OWNER_SK);
const KIND_SEAL_ENCRYPTED = 20013;

/**
 * A real key behind the NUser signer shape. `refuse` names kinds it won't sign,
 * like a NIP-46 bunker without permission for them.
 */
function memberUser(refuse: number[] = []): NUser {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    method: "nsec",
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (t: EventTemplate) => {
        if (refuse.includes(t.kind)) throw new Error(`signer refused kind ${t.kind}`);
        return finalizeEvent(t, sk);
      },
      nip44: {
        encrypt: async (pk: string, plaintext: string) => nip44Encrypt(plaintext, getConversationKey(sk, pk)),
        decrypt: async (pk: string, ciphertext: string) => nip44Decrypt(ciphertext, getConversationKey(sk, pk)),
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

/**
 * Mint a community the way the owner's client does — genesis metadata edition
 * on the community relays, invite bundle on the bootstrap relay.
 */
async function publishInvite() {
  const { mintCommunity } = await import("@/concord/lib/community");
  const { toJoinMaterial } = await import("@/concord/lib/communityList");
  const { buildMetadataEdition, currentControlWriteGroup, sealEdition } = await import("@/concord/lib/control");
  const { buildBundleEvent, bundleNaddr, mintLinkSigner, mintToken } = await import("@/concord/lib/invite");
  const { community } = mintCommunity("Developer's Quarters", OWNER, COMMUNITY_RELAYS);
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
  const bundle = { ...jm, channels: [], relays: community.relays, name: "Developer's Quarters" };
  const link = mintLinkSigner();
  const token = mintToken();
  relayAt(BOOTSTRAP).stored.push(await buildBundleEvent(bundle, token, link.sk));
  const invite = { linkSigner: link.pk, token, bootstrapRelays: [BOOTSTRAP], naddr: bundleNaddr(link.pk) };
  return { community, invite };
}

/** A public channel of `community`, keyed from its root like the real channel view. */
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

function setPublishMode(mode: PublishMode, urls = COMMUNITY_RELAYS) {
  for (const url of urls) relayAt(url).mode = mode;
}

/** Every kind-1059 the member published that the community relays hold. */
function wrapsOnCommunityRelays(): NostrEvent[] {
  return COMMUNITY_RELAYS.flatMap((url) => relayAt(url).stored.filter((e) => e.kind === 1059 && relayAt(url).attempts.includes(e)));
}

/** The send status of `rumorId` in a client, as the timeline row reads it. */
async function statusIn(client: QueryClient, channel: Awaited<ReturnType<typeof channelOf>>, rumorId: string) {
  const { useSendStatus } = await import("@/concord/hooks/useChannel");
  const { outgoingReady } = await import("@/concord/lib/outgoing");
  await outgoingReady();
  const { result } = renderHook(() => useSendStatus(channel as never), { wrapper: wrapperFor(client) });
  return result.current[rumorId];
}

/** The outgoing record as written to KV (its write is fire-and-forget). */
async function persistedOutgoing(rumorId: string) {
  const { getArmadaDB } = await import("@/lib/db/armadaDB");
  return getArmadaDB().kv.get<{ state: string; wrap?: NostrEvent }>(`c2out:${rumorId}`);
}

beforeEach(() => {
  h.relays.clear();
  relayAt(SELF_RELAY).mode = "keep";
  relayAt(BOOTSTRAP).mode = "keep";
});

afterEach(() => {
  vi.resetModules();
});

// ── Join ─────────────────────────────────────────────────────────────────────

// The first case cold-imports the whole join chain; under a loaded suite that alone can pass 5s.
describe("joining", { timeout: 30_000 }, () => {
  async function joinAs(user: NUser) {
    h.user = user;
    const { community, invite } = await publishInvite();
    const { useCommunityActions } = await import("@/concord/hooks/useCommunityActions");
    const { useLiveCommunities } = await import("@/concord/hooks/useCommunityList");
    const hook = renderHook(() => ({ actions: useCommunityActions(), live: useLiveCommunities() }), {
      wrapper: wrapperFor(freshClient()),
    });
    const joined = await hook.result.current.actions.join({ invite });
    await waitFor(() => expect(hook.result.current.live.map((e) => e.community_id)).toContain(community.idHex));
    // Let the fire-and-forget Join publish run.
    await new Promise((r) => setTimeout(r, 50));
    return { joined, community };
  }

  /** Joins the member published that a community relay holds. */
  const joinsOnRelay = (url: string) => relayAt(url).attempts.filter((e) => relayAt(url).stored.includes(e));

  async function pendingJoin(viewer: string, communityIdHex: string) {
    const lib = await import("@/concord/lib/pendingGuestbookJoin");
    await lib.pendingGuestbookJoinsReady();
    return lib.getPendingGuestbookJoin(viewer, communityIdHex);
  }

  it("control: a healthy signer and relays land the Guestbook Join on every relay", async () => {
    setPublishMode("keep");
    const user = memberUser();
    const { joined, community } = await joinAs(user);
    expect(joined.communityId).toBe(community.idHex);
    await waitFor(() => {
      for (const url of COMMUNITY_RELAYS) expect(joinsOnRelay(url)).toHaveLength(1);
    });
    await waitFor(async () => expect(await pendingJoin(user.pubkey, community.idHex)).toBeUndefined());
  });

  it("a Join the signer refuses is kept and lands once the signer signs it", async () => {
    setPublishMode("keep");
    const refuse = [KIND_SEAL_ENCRYPTED];
    const user = memberUser(refuse);
    const { joined, community } = await joinAs(user);

    // Joined locally, nothing on any relay yet…
    expect(joined.communityId).toBe(community.idHex);
    for (const url of COMMUNITY_RELAYS) expect(relayAt(url).attempts).toHaveLength(0);
    // …but no longer dropped: the Join waits, unsigned, for its retry.
    await waitFor(async () => expect((await pendingJoin(user.pubkey, community.idHex))?.failures).toBe(1));
    expect((await pendingJoin(user.pubkey, community.idHex))?.wrap).toBeUndefined();

    // The user approves the kind in their signer, and taps Retry.
    refuse.length = 0;
    const { attemptGuestbookJoin } = await import("@/concord/lib/pendingGuestbookJoin");
    expect(await attemptGuestbookJoin(pool, community, user.signer, user.pubkey)).toBe(true);
    for (const url of COMMUNITY_RELAYS) expect(joinsOnRelay(url)).toHaveLength(1);
    expect(await pendingJoin(user.pubkey, community.idHex)).toBeUndefined();
  });

  it("a Join every relay rejected is re-sent as the same signed wrap when the browser is back online", async () => {
    setPublishMode("reject");
    const user = memberUser();
    const { joined, community } = await joinAs(user);
    expect(joined.communityId).toBe(community.idHex);

    await waitFor(async () => expect((await pendingJoin(user.pubkey, community.idHex))?.wrap).toBeDefined());
    const sealed = (await pendingJoin(user.pubkey, community.idHex))!.wrap!;
    expect(wrapsOnCommunityRelays()).toHaveLength(0);

    // The resume service, with relays that take it now.
    setPublishMode("keep");
    const { useResumeGuestbookJoins } = await import("@/concord/hooks/usePendingGuestbookJoin");
    renderHook(() => useResumeGuestbookJoins(), { wrapper: wrapperFor(freshClient()) });
    await new Promise((r) => setTimeout(r, 200));
    window.dispatchEvent(new Event("online"));

    await waitFor(() => {
      // The rejected first attempt and the retry are the same wrap: one event per relay.
      for (const url of COMMUNITY_RELAYS) expect([...new Set(joinsOnRelay(url).map((e) => e.id))]).toEqual([sealed.id]);
    });
    await waitFor(async () => expect(await pendingJoin(user.pubkey, community.idHex)).toBeUndefined());
  });

  it("a Join cut off mid-publish by a reload goes out when the next page loads", async () => {
    setPublishMode("hang");
    const user = memberUser();
    const { community } = await joinAs(user);
    await waitFor(async () => expect((await pendingJoin(user.pubkey, community.idHex))?.wrap).toBeDefined());
    const sealed = (await pendingJoin(user.pubkey, community.idHex))!.wrap!;

    // Process death with the publish in flight; the next page's relays answer.
    vi.resetModules();
    setPublishMode("keep");
    const { useResumeGuestbookJoins } = await import("@/concord/hooks/usePendingGuestbookJoin");
    renderHook(() => useResumeGuestbookJoins(), { wrapper: wrapperFor(freshClient()) });

    await waitFor(() => {
      for (const url of COMMUNITY_RELAYS) expect([...new Set(joinsOnRelay(url).map((e) => e.id))]).toEqual([sealed.id]);
    });
  });

  it("leaving forgets an unpublished Join, so it can't go out after the Leave", async () => {
    setPublishMode("keep");
    const user = memberUser([KIND_SEAL_ENCRYPTED]);
    const { community } = await joinAs(user);
    await waitFor(async () => expect(await pendingJoin(user.pubkey, community.idHex)).toBeDefined());

    const { useCommunityManagement } = await import("@/concord/hooks/useCommunityActions");
    const { rehydrateCommunity } = await import("@/concord/lib/communityList");
    const { toJoinMaterial } = await import("@/concord/lib/communityList");
    const entry = { community_id: community.idHex, seed: toJoinMaterial(community, { relays: community.relays }), current: toJoinMaterial(community, { relays: community.relays }), added_at: Date.now() };
    const mgmt = renderHook(() => useCommunityManagement(rehydrateCommunity(entry as never)), { wrapper: wrapperFor(freshClient()) });
    await act(async () => {
      await mgmt.result.current.leave();
    });
    expect(await pendingJoin(user.pubkey, community.idHex)).toBeUndefined();
  });
});

// ── Sending ──────────────────────────────────────────────────────────────────

describe("sending a message", { timeout: 30_000 }, () => {
  async function sendAs(user: NUser, content: string) {
    h.user = user;
    const { mintCommunity } = await import("@/concord/lib/community");
    const { community } = mintCommunity("Developer's Quarters", OWNER, COMMUNITY_RELAYS);
    const channel = await channelOf(community);
    const client = freshClient();
    (await import("@/concord/lib/outgoingVerify"))._setVerifyDelayForTests(50);
    const { useSendMessage } = await import("@/concord/hooks/useChannel");
    const { result } = renderHook(() => useSendMessage(community, channel as never), { wrapper: wrapperFor(client) });
    let rumorId = "";
    await act(async () => {
      ({ rumorId } = await result.current.mutateAsync({ content }));
    });
    return { community, channel, client, rumorId };
  }

  /** Process death (a reload or a discarded background tab): only the store and KV survive. */
  async function afterRestart(communityIdHex: string, channelIdHex: string, { persisted = true } = {}) {
    if (persisted) {
      // The local write lands in milliseconds; let it, as any real tab would.
      const before = await import("@/concord/lib/rumorStore");
      await waitFor(async () =>
        expect((await before.queryChannelRumors(communityIdHex, channelIdHex, { limit: 50 })).length).toBeGreaterThan(0),
      );
    }
    vi.resetModules();
    const { queryChannelRumors } = await import("@/concord/lib/rumorStore");
    return { client: freshClient(), rows: await queryChannelRumors(communityIdHex, channelIdHex, { limit: 50 }) };
  }

  /** The signed-in service that re-broadcasts sealed sends after a reload. */
  async function resumeOutgoing(client: QueryClient) {
    (await import("@/concord/lib/outgoingVerify"))._setVerifyDelayForTests(50);
    const { useResumeOutgoing } = await import("@/concord/hooks/useResumeOutgoing");
    renderHook(() => useResumeOutgoing(), { wrapper: wrapperFor(client) });
  }

  it("control: a healthy send lands on every relay and carries no status", async () => {
    setPublishMode("keep");
    const { channel, client, rumorId } = await sendAs(memberUser(), "Hey Maya here");
    await waitFor(() => expect(wrapsOnCommunityRelays()).toHaveLength(COMMUNITY_RELAYS.length));
    expect(await statusIn(client, channel, rumorId)).toBeUndefined();
    await waitFor(async () => expect(await persistedOutgoing(rumorId)).toBeUndefined());
  });

  it("shows pending once the signer is slower than the grace, and persists it then", async () => {
    setPublishMode("keep");
    const user = memberUser();
    (user.signer as { signEvent: unknown }).signEvent = () => new Promise(() => undefined);
    h.user = user;
    const { mintCommunity } = await import("@/concord/lib/community");
    const { community } = mintCommunity("Developer's Quarters", OWNER, COMMUNITY_RELAYS);
    const channel = await channelOf(community);
    const client = freshClient();
    (await import("@/concord/lib/outgoingVerify"))._setVerifyDelayForTests(50);
    const { useSendMessage } = await import("@/concord/hooks/useChannel");
    const { result } = renderHook(() => useSendMessage(community, channel as never), { wrapper: wrapperFor(client) });
    act(() => void result.current.mutate({ content: "Hey Maya here" }));

    const { outgoingFor } = await import("@/concord/lib/outgoing");
    await waitFor(() => expect(outgoingFor(user.pubkey)).toHaveLength(1));
    const [rec] = outgoingFor(user.pubkey);
    // Quiet inside the grace (a local key answers in it), pending once past it.
    expect(await statusIn(client, channel, rec.rumorId)).toBeUndefined();
    await waitFor(async () => expect(await statusIn(client, channel, rec.rumorId)).toBe("pending"));
    expect((await persistedOutgoing(rec.rumorId))?.state).toBe("signing");
  });

  it("a remote signer's send is persisted at once, so a page dying inside the grace still shows it failed", async () => {
    setPublishMode("keep");
    const user = memberUser();
    (user as { method: string }).method = "bunker";
    (user.signer as { signEvent: unknown }).signEvent = () => new Promise(() => undefined);
    h.user = user;
    const { mintCommunity } = await import("@/concord/lib/community");
    const { community } = mintCommunity("Developer's Quarters", OWNER, COMMUNITY_RELAYS);
    const channel = await channelOf(community);
    (await import("@/concord/lib/outgoingVerify"))._setVerifyDelayForTests(50);
    const { useSendMessage } = await import("@/concord/hooks/useChannel");
    const { result } = renderHook(() => useSendMessage(community, channel as never), { wrapper: wrapperFor(freshClient()) });
    act(() => void result.current.mutate({ content: "Hey Maya here" }));

    // Well inside the 300ms grace, the tab dies.
    const { outgoingFor } = await import("@/concord/lib/outgoing");
    await waitFor(() => expect(outgoingFor(user.pubkey)).toHaveLength(1));
    const [rec] = outgoingFor(user.pubkey);
    // Bounded under the grace, so only the immediate write can satisfy it.
    await waitFor(async () => expect((await persistedOutgoing(rec.rumorId))?.state).toBe("signing"), { timeout: 200 });
    const restarted = await afterRestart(community.idHex, channel.idHex, { persisted: false });
    expect(await statusIn(restarted.client, channel, rec.rumorId)).toBe("failed");
  });

  it("rejected everywhere, it stays failed across a reload instead of reading as sent", async () => {
    setPublishMode("reject");
    const { community, channel, client, rumorId } = await sendAs(memberUser(), "Hey Maya here");

    await waitFor(async () => expect(await statusIn(client, channel, rumorId)).toBe("failed"));
    expect(wrapsOnCommunityRelays()).toHaveLength(0);
    await waitFor(async () => expect((await persistedOutgoing(rumorId))?.state).toBe("failed"));

    const restarted = await afterRestart(community.idHex, channel.idHex);
    expect(restarted.rows.map((r) => r.rumorId)).toContain(rumorId);
    expect(await statusIn(restarted.client, channel, rumorId)).toBe("failed");
  });

  it("a failed send clears the moment its rumor is read back from a relay", async () => {
    setPublishMode("reject");
    const { community, channel, client, rumorId } = await sendAs(memberUser(), "Hey Maya here");
    await waitFor(async () => expect(await statusIn(client, channel, rumorId)).toBe("failed"));

    // The publish was in fact taken (an ACK lost on the way back): any relay read is proof.
    const { queryChannelRumors, writeRumors } = await import("@/concord/lib/rumorStore");
    let row: Awaited<ReturnType<typeof queryChannelRumors>>[number] | undefined;
    await waitFor(async () => {
      [row] = await queryChannelRumors(community.idHex, channel.idHex, { limit: 1 });
      expect(row).toBeDefined();
    });
    await writeRumors(community.idHex, [row!]);
    expect(await statusIn(client, channel, rumorId)).toBeUndefined();
    await waitFor(async () => expect(await persistedOutgoing(rumorId)).toBeUndefined());
  });

  it("a sealed send cut off by a reload is re-broadcast when the records load", async () => {
    setPublishMode("hang");
    const { community, channel, rumorId } = await sendAs(memberUser(), "Hey Maya here");
    for (const url of COMMUNITY_RELAYS) expect(relayAt(url).attempts).toHaveLength(1);
    await waitFor(async () => expect((await persistedOutgoing(rumorId))?.wrap).toBeDefined());

    const restarted = await afterRestart(community.idHex, channel.idHex);
    expect(restarted.rows.map((r) => r.rumorId)).toContain(rumorId);
    setPublishMode("keep");
    await resumeOutgoing(restarted.client);

    await waitFor(() => expect(wrapsOnCommunityRelays()).toHaveLength(COMMUNITY_RELAYS.length));
    expect(await statusIn(restarted.client, channel, rumorId)).toBeUndefined();
    await waitFor(async () => expect(await persistedOutgoing(rumorId)).toBeUndefined());
  });

  it("a relay that says OK but keeps nothing is caught by the read-back: re-sent, then failed", async () => {
    setPublishMode("reject");
    relayAt(COMMUNITY_RELAYS[2]).mode = "ackAndDrop";
    const { channel, client, rumorId } = await sendAs(memberUser(), "Hey Maya here");

    // The OK reads as sent for a moment…
    await waitFor(() => expect(relayAt(COMMUNITY_RELAYS[2]).attempts).toHaveLength(1));
    // …then the read-back finds it nowhere, re-broadcasts once, and gives up.
    await waitFor(() => expect(relayAt(COMMUNITY_RELAYS[2]).attempts).toHaveLength(2));
    await waitFor(async () => expect(await statusIn(client, channel, rumorId)).toBe("failed"));
    expect(wrapsOnCommunityRelays()).toHaveLength(0);
  });

  it("an OK the read-back confirms settles the send", async () => {
    setPublishMode("reject");
    relayAt(COMMUNITY_RELAYS[0]).mode = "keep";
    const { channel, client, rumorId } = await sendAs(memberUser(), "Hey Maya here");
    await waitFor(async () => expect(await persistedOutgoing(rumorId)).toBeUndefined());
    expect(relayAt(COMMUNITY_RELAYS[0]).attempts).toHaveLength(1);
    expect(await statusIn(client, channel, rumorId)).toBeUndefined();
  });

  it("a send whose seal was never signed comes back after a reload as failed, with its text", async () => {
    setPublishMode("keep");
    const { community, channel, client, rumorId } = await sendAs(memberUser([KIND_SEAL_ENCRYPTED]), "Hey Maya here");

    await waitFor(async () => expect(await statusIn(client, channel, rumorId)).toBe("failed"));
    for (const url of COMMUNITY_RELAYS) expect(relayAt(url).attempts).toHaveLength(0);
    await waitFor(async () => expect((await persistedOutgoing(rumorId))?.state).toBe("failed"));

    // Never stored as a message; the timeline restores it from the outgoing record.
    const restarted = await afterRestart(community.idHex, channel.idHex, { persisted: false });
    expect(restarted.rows.map((r) => r.rumorId)).not.toContain(rumorId);
    expect(await statusIn(restarted.client, channel, rumorId)).toBe("failed");
    const { unsealedOutgoingRows } = await import("@/concord/lib/outgoing");
    const rows = unsealedOutgoingRows((h.user as NUser).pubkey, channel.idHex);
    expect(rows.map((r) => [r.rumorId, r.content])).toEqual([[rumorId, "Hey Maya here"]]);
  });
});
