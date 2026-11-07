/**
 * Parity for logic that lives in hooks: collecting delivered Private Channel keys
 * (CORD-03 §5) and folding Timeouts and Nicknames off the Guestbook (CORD-04 §8,
 * §10), against concord#25 and Vector v0.5.0-3. `it.fails` marks what Armada
 * still gets wrong.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sealChannelMetadata } from "@/concord/lib/channelSeal";
import { foldControlState, type FoldedControl } from "@/concord/lib/control";
import { accessPlane } from "@/concord/lib/delivery";
import { bytesToHex, guestbookGroupKey, random32 } from "@/concord/lib/derive";
import { KIND_NICKNAME, KIND_REKEY, KIND_SEAL_ENCRYPTED, KIND_TIMEOUT } from "@/concord/lib/kinds";
import { bytesToBase64, encodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { Permissions } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { buildRumor, sealRumor, wrapSeal, type OpenedEvent } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { resetClockOffset, syncClockWithRelays } from "@/lib/relayClock";
import { hexKey, heldCommunity, rankedCommunity, TestCommunity } from "@/test/concordEditions";

const env = vi.hoisted(() => ({
  folded: undefined as FoldedControl | undefined,
  user: undefined as unknown,
  relayEvents: [] as NostrEvent[],
  queries: [] as unknown[],
  listWrites: [] as Array<{ channels?: Array<{ id: string; key: string; epoch: number }> }>,
  stored: [] as OpenedEvent[],
  sent: [] as NostrEvent[],
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async ([f]: Array<{ authors?: string[]; until?: number; limit?: number }>) => {
          env.queries.push(f);
          return env.relayEvents
            .filter((e) => !f.authors || f.authors.includes(e.pubkey))
            .filter((e) => f.until === undefined || e.created_at <= f.until)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, f.limit ?? Infinity);
        },
        event: async (e: NostrEvent) => void env.sent.push(e),
      }),
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: env.user }) }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: env.folded }),
  useDissolved: () => ({ data: undefined }),
}));
vi.mock("@/concord/hooks/useCommunityList", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useCommunityList")>()),
  useUpdateCommunityList: () => ({
    mutateAsync: async (a: { channels?: Array<{ id: string; key: string; epoch: number }> }) => {
      env.listWrites.push(a);
    },
  }),
  useCommunityEntry: () => ({ current: { channels: [] }, added_at: 1 }),
}));
vi.mock("@/concord/lib/rumorStore", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rumorStore")>()),
  queryPlane: async () => env.stored,
  writeOpened: async () => undefined,
}));
vi.mock("@/concord/lib/planeSync", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/planeSync")>()),
  sweepGuestbook: async () => undefined,
}));

const { useChannelAccess } = await import("@/concord/hooks/useChannelAccess");
const { useGuestbook, useMemberStanding } = await import("@/concord/hooks/useGuestbook");
const { openWrap } = await import("@/concord/lib/stream");

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

function signerOf(sk: Uint8Array) {
  return {
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    nip44: {
      encrypt: async (pk: string, plain: string) => nip44Encrypt(plain, getConversationKey(sk, pk)),
      decrypt: async (pk: string, payload: string) => (await import("nostr-tools/nip44")).decrypt(payload, getConversationKey(sk, pk)),
    },
  };
}

beforeEach(() => {
  env.relayEvents = [];
  env.queries = [];
  env.listWrites = [];
  env.stored = [];
});

describe("collecting a delivered Private Channel key (CORD-03 §5)", () => {
  /** A sealed Private Channel at epoch 1 the owner let `member` into by an overwrite. */
  function setup() {
    const ownerSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const owner = getPublicKey(ownerSk);
    const member = getPublicKey(memberSk);
    const { c, base } = rankedCommunity(0n, { owner });
    const id = random32();
    const key = random32();
    const channel = c.edition({ vsk: "2", eid: id, author: owner, content: sealChannelMetadata({ name: "lounge", private: true }, key, id, 1n, undefined) });
    const o = { scope: bytesToHex(id), target: { kind: "member" as const, id: member }, allow: Permissions.VIEW_CHANNEL, deny: 0n };
    const allow = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: owner, content: overwriteToJSON(o) });
    env.folded = foldControlState([...base, channel, allow], c.id, owner);
    const community: Community = heldCommunity(c);
    env.user = { pubkey: member, signer: signerOf(memberSk) };
    const deliver = async (epoch: bigint, k: Uint8Array) => {
      const plane = accessPlane(community, id);
      const wrapped = nip44Encrypt(bytesToBase64(encodeWrappedKey(id, epoch, k)), getConversationKey(ownerSk, member));
      const blobs = [{ locator: myLocator(owner, member, bytesToHex(id), epoch), wrapped }];
      const rumor = buildRumor({ kind: KIND_REKEY, content: JSON.stringify(blobs), tags: [["delivery", "access"], ["scope", bytesToHex(id)], ["newepoch", epoch.toString()]], pubkey: owner, ms: Date.now() });
      return wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, plane, signerOf(ownerSk)), plane);
    };
    return { c, community, id, idHex: bytesToHex(id), key, deliver };
  }

  it("baseline: adopts the key a trusted deliverer handed over", async () => {
    const { community, idHex, key, deliver } = setup();
    env.relayEvents = [await deliver(1n, key)];
    renderHook(() => useChannelAccess(community), { wrapper });
    await waitFor(() => expect(env.listWrites.length).toBeGreaterThan(0));
    expect(env.listWrites[0].channels?.find((ch) => ch.id === idHex)?.key).toBe(bytesToHex(key));
  });

  it("refuses a key delivered for an epoch past the one its walk reached or the next (CORD-03 §5; Vector `collect_access`)", async () => {
    const { community, idHex, key, deliver } = setup();
    env.relayEvents = [await deliver(1n, key), await deliver(1024n, random32())];
    renderHook(() => useChannelAccess(community), { wrapper });
    await waitFor(() => expect(env.listWrites.length).toBeGreaterThan(0));
    const adopted = env.listWrites.at(-1)!.channels!.find((ch) => ch.id === idHex)!;
    expect(adopted.epoch).toBe(1);
    expect(adopted.key).toBe(bytesToHex(key));
  });

  it("pages past a flood of junk on the access plane (Vector `fetch_plane_deliveries`, 6×200)", async () => {
    const { community, id, key, deliver } = setup();
    const real = await deliver(1n, key);
    const plane = accessPlane(community, id);
    const junkSeal = finalizeEvent({ kind: KIND_SEAL_ENCRYPTED, content: "junk", tags: [], created_at: real.created_at }, generateSecretKey());
    const junk = await Promise.all(Array.from({ length: 200 }, () => wrapSeal(junkSeal, plane)));
    env.relayEvents = [real, ...junk.map((e) => ({ ...e, created_at: real.created_at + 100 }))];
    renderHook(() => useChannelAccess(community), { wrapper });
    await waitFor(() => expect(env.queries.length).toBeGreaterThan(0));
    await waitFor(() => expect(env.listWrites.length).toBeGreaterThan(0), { timeout: 2000 });
  }, 15_000);
});

describe("Nicknames and Timeouts off the Guestbook (CORD-04 §8, §10)", () => {
  const nick = (author: string, target: string, ms: number, content: string, streamPk?: string): OpenedEvent => ({
    rumorId: hexKey(),
    author,
    kind: KIND_NICKNAME,
    content,
    tags: [["p", target]],
    ms,
    createdAt: Math.floor(ms / 1000),
    ...(streamPk ? { streamPk } : {}),
  });

  it("lets every member name themselves on a legacy Roster (CORD-04 §10; Vector `may_name`)", async () => {
    const c = new TestCommunity();
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState([], c.id, c.owner);
    const community = heldCommunity(c);
    env.stored = [nick(member, member, Date.now() - 1000, "Newbie", guestbookGroupKey(community.root, c.id, 0n).pk)];
    env.user = { pubkey: member };
    const { result } = renderHook(() => useGuestbook(community), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.nicknames.get(member)).toBe("Newbie");
  });

  it("counts only the live epoch's Nicknames after a Refounding (CORD-04 §10; Vector `standing_nicknames`)", async () => {
    const { c, base } = rankedCommunity(0n);
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState(base, c.id, c.owner);
    const community = heldCommunity(c);
    const oldRoot = community.root;
    community.heldRoots = [{ epoch: 1n, key: random32() }, { epoch: 0n, key: oldRoot }];
    community.root = community.heldRoots[0].key;
    community.rootEpoch = 1n;
    const oldPlane = guestbookGroupKey(oldRoot, c.id, 0n).pk;
    env.stored = [nick(member, member, Date.now() - 1000, "Stale", oldPlane)];
    env.user = { pubkey: member };
    const { result } = renderHook(() => useGuestbook(community), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.nicknames.has(member)).toBe(false);
  });

  it("counts no Nickname whose Guestbook epoch it doesn't know after a Refounding (Vector `nicknames_on` takes `e.epoch == epoch`)", async () => {
    const { c, base } = rankedCommunity(0n);
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState(base, c.id, c.owner);
    const community = heldCommunity(c);
    community.heldRoots = [{ epoch: 1n, key: random32() }, { epoch: 0n, key: community.root }];
    community.root = community.heldRoots[0].key;
    community.rootEpoch = 1n;
    env.stored = [nick(member, member, Date.now() - 1000, "Unplaced")];
    env.user = { pubkey: member };
    const { result } = renderHook(() => useGuestbook(community), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.nicknames.has(member)).toBe(false);
  });

  const timeout = (author: string, target: string, ms: number, until: string): OpenedEvent => ({
    rumorId: hexKey(),
    author,
    kind: KIND_TIMEOUT,
    content: "",
    tags: [["p", target], ["until", until]],
    ms,
    createdAt: Math.floor(ms / 1000),
  });

  it("honors the owner's Timeout on a legacy Roster (Vector `community_timeouts` has no Roles v2 gate; CORD-04 §8)", async () => {
    const c = new TestCommunity();
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState([], c.id, c.owner);
    const now = Date.now();
    env.stored = [timeout(c.owner, member, now - 1000, String(Math.floor(now / 1000) + 3600))];
    env.user = { pubkey: member };
    const { result } = renderHook(() => useGuestbook(heldCommunity(c)), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.timeouts.has(member)).toBe(true);
  });

  it("reads a Timeout's `until` with leading zeros past 20 digits (Vector: all digits, then `u64::parse`)", async () => {
    const { c, base } = rankedCommunity(0n);
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState(base, c.id, c.owner);
    const now = Date.now();
    env.stored = [timeout(c.owner, member, now - 1000, String(Math.floor(now / 1000) + 3600).padStart(24, "0"))];
    env.user = { pubkey: member };
    const { result } = renderHook(() => useGuestbook(heldCommunity(c)), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.timeouts.has(member)).toBe(true);
  });

  it("gives a member back their own Nickname once their Timeout lapses, without waiting for new data (CORD-04 §8, §10)", async () => {
    const c = new TestCommunity();
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState([], c.id, c.owner);
    const community = heldCommunity(c);
    const now = Date.now();
    const until = Math.floor(now / 1000) + 2;
    env.stored = [
      timeout(c.owner, member, now - 1000, String(until)),
      nick(member, member, now - 500, "Newbie", guestbookGroupKey(community.root, c.id, 0n).pk),
    ];
    env.user = { pubkey: member };
    const { result } = renderHook(() => useGuestbook(community), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.nicknames.has(member)).toBe(false);
    await waitFor(() => expect(result.current.nicknames.get(member)).toBe("Newbie"), { timeout: 4_000 });
  }, 10_000);

  it("judges a Timeout's one-hour horizon by the relays' clock (CORD-02 §5; Vector `active_timeouts` takes `now_ms`)", async () => {
    const { c, base } = rankedCommunity(0n);
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState(base, c.id, c.owner);
    // The relays agree this device runs two hours behind: a Timeout dated 90 minutes past
    // the device's clock is half an hour old by theirs.
    await syncClockWithRelays(["wss://a.test", "wss://b.test", "wss://c.test"], async () => ({ date: new Date(Date.now() + 2 * 3600_000).toUTCString() }));
    try {
      const at = Date.now() + 90 * 60_000;
      env.stored = [timeout(c.owner, member, at, String(Math.floor(at / 1000) + 3600))];
      env.user = { pubkey: member };
      const { result } = renderHook(() => useGuestbook(heldCommunity(c)), { wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.timeouts.has(member)).toBe(true);
    } finally {
      resetClockOffset();
    }
  });
});

describe("timing members out and naming them (CORD-04 §8, §10; Vector `timeout_member`, `set_nickname`)", () => {
  function owned() {
    const ownerSk = generateSecretKey();
    const c = new TestCommunity(getPublicKey(ownerSk));
    const member = getPublicKey(generateSecretKey());
    env.folded = foldControlState([c.everyone(Permissions.SEND_MESSAGES | Permissions.CHANGE_NICKNAME)], c.id, c.owner);
    env.user = { pubkey: c.owner, signer: { signEvent: async (t: EventTemplate) => finalizeEvent(t, ownerSk), nip44: { encrypt: async (pk: string, p: string) => nip44Encrypt(p, getConversationKey(ownerSk, pk)) } } };
    env.sent = [];
    const community = heldCommunity(c);
    const gb = guestbookGroupKey(community.root, c.id, 0n);
    return { c, member, community, opened: () => env.sent.map((e) => openWrap(e, gb)) };
  }

  it("times a member out for the length picked, dated after the Timeout it replaces, and lifts one with a past until", async () => {
    const { c, member, community, opened } = owned();
    const later = Date.now() + 30 * 60_000;
    env.stored = [{ rumorId: hexKey(), author: c.owner, kind: KIND_TIMEOUT, content: "", tags: [["p", member], ["until", String(Math.floor(later / 1000) + 60)]], ms: later, createdAt: Math.floor(later / 1000) }];
    const { result } = renderHook(() => useMemberStanding(community), { wrapper });
    await waitFor(() => expect(result.current.timeouts.has(member)).toBe(true));
    await result.current.timeout(member, 600);
    const [t] = opened();
    expect(t.kind).toBe(KIND_TIMEOUT);
    expect(t.ms).toBe(later + 1);
    expect(Number(t.tags.find((x) => x[0] === "until")?.[1])).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 590);
    await result.current.timeout(member, 0);
    expect(opened()[1].tags).toContainEqual(["until", "0"]);
  });

  it("sets a member's Nickname, citing nothing for one's own", async () => {
    const { c, member, community, opened } = owned();
    env.stored = [];
    const { result } = renderHook(() => useMemberStanding(community), { wrapper });
    await waitFor(() => expect(result.current.mayNickname(member)).toBe(true));
    await result.current.setNickname(member, "  Newbie ");
    await result.current.setNickname(c.owner, "Boss");
    expect(opened().map((o) => [o.kind, o.content, o.tags.find((x) => x[0] === "p")?.[1]])).toEqual([[KIND_NICKNAME, "Newbie", member], [KIND_NICKNAME, "Boss", c.owner]]);
    await expect(result.current.setNickname(member, "x".repeat(33))).rejects.toThrow();
  });
});
