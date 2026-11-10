/**
 * What Armada PUBLISHES in a Community on the vsk-13 Roster, against CORD-03/04
 * at concord#25 and Vector v0.5.0-3: the Channel, Grant and Banlist writers run
 * against a real fold of synthetic editions, and every edition they hand to
 * `publishEdition` is captured. `it.fails` marks what Armada still gets wrong.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openChannelSeal, sealChannelMetadata } from "@/concord/lib/channelSeal";
import { foldControlState, readChannelContent, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { isRankKey } from "@/concord/lib/rankKey";
import { arrangedBefore, dropChanges, planChannelDrop } from "@/concord/lib/channelArrangement";
import { Permissions } from "@/concord/lib/roles";
import type { Community, PrivateChannelKey } from "@/concord/lib/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";

import { hexKey, heldCommunity, rankedCommunity } from "@/test/concordEditions";

const env = vi.hoisted(() => ({
  folded: undefined as FoldedControl | undefined,
  published: [] as NostrRumor[],
  guestbook: [] as Array<{ type: string; target?: string; ms?: number }>,
  coalesced: new Map<string, { pubkey: string; state: string; ms: number; rumorId: string; fromSnapshot: boolean }>(),
  user: { pubkey: "", signer: {} as unknown },
  rotations: [] as Array<{ recipients: string[] }>,
  readWhole: true,
  failVsk: undefined as string | undefined,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { relay: () => ({ event: async () => undefined, query: async () => [] }) } }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: env.user }) }));
vi.mock("@/hooks/useRemoveRailKey", () => ({ useRemoveRailKey: () => () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: env.folded, isLoading: false }),
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => {
    if (env.failVsk !== undefined && rumor.tags.some((t) => t[0] === "vsk" && t[1] === env.failVsk)) throw new Error("no relay took it");
    env.published.push(rumor);
  },
  invalidateControl: () => undefined,
  readControlWhole: async () => (env.readWhole && env.folded ? { folded: env.folded, served: undefined } : undefined),
  foldStoredControl: async () => env.folded,
}));
vi.mock("@/concord/hooks/useCommunityList", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useCommunityList")>()),
  useUpdateCommunityList: () => ({ mutateAsync: async () => undefined }),
  useCommunityEntry: () => undefined,
}));
vi.mock("@/concord/hooks/useGuestbook", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useGuestbook")>()),
  useGuestbook: () => ({ data: [], coalesced: env.coalesced, timeouts: new Map(), nicknames: new Map() }),
  guestbookWalked: () => true,
  useGuestbookPublisher: () => ({
    mutateAsync: async (a: { type: string; target?: string }) => {
      env.guestbook.push(a);
    },
  }),
}));
vi.mock("@/concord/hooks/useRekey", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useRekey")>()),
  useRefound: () => ({ refound: async () => undefined, canRefound: true }),
  useChannelRekey: () => ({ rekeyChannel: async () => undefined, canRekeyChannel: true }),
}));
vi.mock("@/concord/lib/channelRotation", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/channelRotation")>()),
  publishChannelRotation: async (_n: unknown, _c: unknown, _u: unknown, o: { recipients: string[] }) => {
    env.rotations.push(o);
  },
}));
vi.mock("@/concord/lib/readCutPending", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/readCutPending")>()),
  addReadCutPending: async () => undefined,
  clearReadCutPending: () => undefined,
}));

const { useCommunityManagement } = await import("@/concord/hooks/useCommunityActions");
const { useRoles } = await import("@/concord/hooks/useRoles");
const { useRankedRoles } = await import("@/concord/hooks/useRankedRoles");
const { useModeration } = await import("@/concord/hooks/useModeration");

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

const vskOf = (r: NostrRumor) => r.tags.find((t) => t[0] === "vsk")?.[1];
const channelEditions = () => env.published.filter((r) => vskOf(r) === "2");

beforeEach(() => {
  env.failVsk = undefined;
  env.readWhole = true;
  env.rotations = [];
  env.published = [];
  env.guestbook = [];
  env.coalesced = new Map();
});

/** An admin holding MANAGE_CHANNELS and MANAGE_ROLES, a sealed Private Channel they hold the key for, and a public one. */
function signerOf(sk: Uint8Array) {
  return {
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    nip44: { encrypt: async (pk: string, plain: string) => nip44Encrypt(plain, getConversationKey(sk, pk)) },
  };
}

function setup() {
  const adminSk = generateSecretKey();
  const k = rankedCommunity(Permissions.MANAGE_CHANNELS | Permissions.MANAGE_ROLES | Permissions.BAN | Permissions.KICK, { admin: getPublicKey(adminSk), owner: getPublicKey(generateSecretKey()) });
  const { c, admin, grant, base } = k;
  const id = random32();
  const key = random32();
  const sealed = c.edition({ vsk: "2", eid: id, author: admin, cite: grant, content: sealChannelMetadata({ name: "staff-room", private: true, topic: "plans" }, key, id, 1n, undefined, { creator: admin }) });
  const pub = random32();
  const general = c.edition({ vsk: "2", eid: pub, author: c.owner, content: { name: "general", private: false, position: "m" } });
  const cat = hexKey();
  const category = c.edition({ vsk: "15", eid: cat, author: c.owner, content: { name: "Text", position: "a" } });
  const held: PrivateChannelKey = { id, key, epoch: 1n, name: "" };
  env.folded = foldControlState([...base, sealed, general, category], c.id, c.owner);
  env.user = { pubkey: admin, signer: signerOf(adminSk) };
  const community: Community = heldCommunity(c, [held]);
  return { ...k, community, sealedId: bytesToHex(id), held, publicId: bytesToHex(pub), cat };
}

/** Every Channel edition a writer published for a sealed Channel stays sealed (CORD-03 §2). */
function expectSealed(held: PrivateChannelKey) {
  const editions = channelEditions();
  for (const r of editions) {
    const read = readChannelContent(r.content);
    expect(read?.sealed, r.content).toBeDefined();
    expect(openChannelSeal({ ...read!.sealed!, prevHex: r.tags.find((t) => t[0] === "ep")?.[1] }, held)).toBeDefined();
  }
}

async function attempt(run: () => Promise<unknown>) {
  await act(async () => {
    await run().catch(() => undefined);
  });
}

describe("editing a sealed Private Channel (CORD-03 §2: never publish a seal built from metadata it couldn't read)", () => {
  for (const [label, run] of [
    ["rename", (m: ReturnType<typeof useCommunityManagement>, id: string) => m.renameChannel({ channelIdHex: id, name: "renamed" })],
    ["file into a Category", (m: ReturnType<typeof useCommunityManagement>, id: string) => m.setChannelCategory({ channelIdHex: id, category: "Text" })],
    ["change its view", (m: ReturnType<typeof useCommunityManagement>, id: string) => m.setChannelView({ channelIdHex: id, view: "forum" })],
    ["arrange", (m: ReturnType<typeof useCommunityManagement>, id: string) => m.arrangeChannels([{ idHex: id, position: 3, category: undefined }])],
  ] as const) {
    it(`${label} keeps the edition sealed under the Channel's key`, async () => {
      const { community, sealedId, held } = setup();
      const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
      await attempt(() => run(result.current, sealedId));
      expect(channelEditions().length).toBeGreaterThan(0);
      expectSealed(held);
    });
  }

  it("deleting it keeps the head's fields it doesn't know (Vector `sealed_tombstone`)", async () => {
    const { c, base, community, sealedId, held } = setup();
    const head = env.folded!.headEditions.get(sealedId)!;
    const withExtra = c.edition({ vsk: "2", eid: sealedId, author: c.owner, prev: head, content: { ...JSON.parse(sealChannelMetadata({ name: "staff-room", private: true }, held.key, held.id, held.epoch, bytesToHex(head.selfHash))), future: "kind" } });
    env.folded = foldControlState([...base, ...[...env.folded!.headEditions.values()].filter((e) => !base.includes(e)), withExtra], c.id, c.owner);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.deleteChannel({ channelIdHex: sealedId }));
    const content = JSON.parse(channelEditions()[0].content) as Record<string, unknown>;
    expect(content.deleted).toBe(true);
    expect(content.future).toBe("kind");
  });

  it("deleting it carries the head's seal verbatim beside \"deleted\": true", async () => {
    const { community, sealedId } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.deleteChannel({ channelIdHex: sealedId }));
    const content = JSON.parse(channelEditions()[0].content) as Record<string, unknown>;
    expect(content.deleted).toBe(true);
    expect(content.sealed).toBe(env.folded!.channels.get(sealedId)!.sealed!.sealed);
  });

  it("making it public publishes the details it opened, not the placeholder the fold holds", async () => {
    const { community, sealedId } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.publiciseChannel({ channelIdHex: sealedId }));
    const meta = readChannelContent(channelEditions()[0].content)?.metadata;
    expect(meta?.private).toBe(false);
    expect(meta?.name).toBe("staff-room");
    expect(meta?.topic).toBe("plans");
  });

  it("rename keeps the sealed creator, topic and the new name", async () => {
    const { community, sealedId, held, admin } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.renameChannel({ channelIdHex: sealedId, name: "renamed" }));
    const r = channelEditions()[0];
    const read = readChannelContent(r.content)!;
    const opened = openChannelSeal({ ...read.sealed!, prevHex: r.tags.find((t) => t[0] === "ep")?.[1] }, held);
    expect(opened?.metadata.name).toBe("renamed");
    expect(opened?.metadata.topic).toBe("plans");
    expect(opened?.creator).toBe(admin);
  });
});

describe("editing a Private Channel whose head is plain, on the vsk-13 Roster (CORD-03 §2, Vector `channel_edition_content`)", () => {
  function withPlainPrivate(holdKey: boolean) {
    const s = setup();
    const id = random32();
    const plain = s.c.edition({ vsk: "2", eid: id, author: s.c.owner, content: { name: "old-private", private: true } });
    env.folded = foldControlState([...s.base, plain], s.c.id, s.c.owner);
    const held: PrivateChannelKey = { id, key: random32(), epoch: 1n, name: "" };
    const community = heldCommunity(s.c, holdKey ? [held] : []);
    return { community, id: bytesToHex(id), held };
  }

  it("seals the edition under the Channel's key", async () => {
    const { community, id, held } = withPlainPrivate(true);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.renameChannel({ channelIdHex: id, name: "renamed" }));
    expect(channelEditions().length).toBe(1);
    expectSealed(held);
    const r = channelEditions()[0];
    const read = readChannelContent(r.content)!;
    expect(openChannelSeal({ ...read.sealed!, prevHex: r.tags.find((t) => t[0] === "ep")?.[1] }, held)?.metadata.name).toBe("renamed");
  });

  it("publishes nothing without the key", async () => {
    const { community, id } = withPlainPrivate(false);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.renameChannel({ channelIdHex: id, name: "renamed" }));
    expect(channelEditions()).toEqual([]);
  });
});

describe("creating Private Channels on the vsk-13 Roster (CORD-03 §2, CORD-04 §2)", () => {
  it("mints no vsk-1 access Role, which stands for nothing on Roles v2", async () => {
    const { community } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.createChannel({ name: "secret", isPrivate: true }));
    expect(env.published.filter((r) => vskOf(r) === "1")).toEqual([]);
  });

  it("publishes a sealed first edition at channel epoch 1 naming its creator", async () => {
    const { community, admin } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    let minted: PrivateChannelKey | undefined;
    await attempt(async () => {
      minted = (await result.current.createChannel({ name: "secret", isPrivate: true })).minted;
    });
    const r = channelEditions()[0];
    const read = readChannelContent(r.content);
    expect(read?.sealed?.epoch).toBe(1n);
    expect(minted?.epoch).toBe(1n);
    expect(openChannelSeal({ ...read!.sealed!, prevHex: undefined }, minted!)?.creator).toBe(admin);
  });

  it("privatising a Channel hands its key to no banned member (Vector `access_candidates`)", async () => {
    const { c, base, community, publicId, adminRole } = setup();
    const banned = hexKey();
    const bannedGrant = c.grant(banned, [adminRole]);
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [banned] });
    const general = env.folded!.headEditions.get(publicId)!;
    env.folded = foldControlState([...base, general, bannedGrant, ban], c.id, c.owner);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.privatiseChannel({ channelIdHex: publicId }));
    expect(env.rotations).toHaveLength(1);
    expect(env.rotations[0].recipients).not.toContain(banned);
  });

  it("privatising a Channel mints no vsk-1 access Role either", async () => {
    const { community, publicId } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.privatiseChannel({ channelIdHex: publicId }));
    expect(env.published.filter((r) => vskOf(r) === "1")).toEqual([]);
  });
});

describe("arranging Channels on the vsk-13 Roster (CORD-03 §2, §4)", () => {
  it("writes a rank-key position and a Category id, the fields a ranked reader places by", async () => {
    const { community, publicId, cat } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.setChannelCategory({ channelIdHex: publicId, category: cat }));
    await attempt(() => result.current.arrangeChannels([{ idHex: publicId, position: 0, category: cat }]));
    const mine = channelEditions().filter((r) => r.tags.some((t) => t[0] === "eid" && t[1] === publicId));
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) {
      const meta = readChannelContent(r.content)!.metadata;
      expect(meta.category).toBe(cat);
      expect(isRankKey(meta.position)).toBe(true);
    }
  });

  /** Two Categories of two unkeyed Channels each, as a Community migrated from a legacy Roster holds them. */
  function twoGroups() {
    const s = setup();
    const { c, base } = s;
    const [cat1, cat2] = [hexKey(), hexKey()];
    const cats = [cat1, cat2].map((id, i) => c.edition({ vsk: "15", eid: id, author: c.owner, content: { name: `Cat${i}`, position: i === 0 ? "a" : "b" } }));
    const ids = [hexKey(), hexKey(), hexKey(), hexKey()];
    const chans = ids.map((id, i) => c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: `c${i}`, private: false, category: i < 2 ? cat1 : cat2 } }));
    env.folded = foldControlState([...base, ...cats, ...chans], c.id, c.owner);
    return { ...s, cat1, cat2, ids };
  }
  const edited = () => channelEditions().map((r) => r.tags.find((t) => t[0] === "eid")?.[1]);

  it("a drag within one Category writes editions in that Category only (Vector `move_channel`)", async () => {
    const { community, cat1, ids } = twoGroups();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.arrangeChannels([{ idHex: ids[1], position: 0, category: cat1 }]));
    expect(edited().length).toBeGreaterThan(0);
    expect(edited().every((id) => id === ids[0] || id === ids[1])).toBe(true);
  });

  it("a drag into another Category lands where it was dropped, the sidebar's index read as the whole list's", async () => {
    const { community, ids, cat1, cat2 } = twoGroups();
    const before = arrangedBefore(ids.map((idHex, i) => ({ idHex, categoryId: i < 2 ? cat1 : cat2 })), true);
    // c0 dropped just above c2, the first Channel of the second Category.
    const changes = dropChanges(before, planChannelDrop(before, ids[0], 1, cat2), ids[0], true);
    expect(changes).toHaveLength(1);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.arrangeChannels(changes));
    const last = (id: string) => channelEditions().filter((e) => e.tags.some((t) => t[0] === "eid" && t[1] === id)).at(-1);
    const meta = (id: string) => readChannelContent(last(id)!.content)!.metadata;
    expect(meta(ids[0]).category).toBe(env.folded!.channels.get(ids[2])!.metadata.category);
    const key = (id: string) => (last(id) ? meta(id).position : env.folded!.channels.get(id)!.metadata.position) as string;
    expect(key(ids[0]) < key(ids[2])).toBe(true);
    expect(key(ids[2]) < key(ids[3])).toBe(true);
  });

  it("moving a Channel up places it among its own Category's Channels", async () => {
    const { community, ids } = twoGroups();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await attempt(() => result.current.moveChannel({ channelIdHex: ids[3], direction: -1 }));
    expect(edited().every((id) => id === ids[2] || id === ids[3])).toBe(true);
    const key = (id: string) => {
      const r = channelEditions().filter((e) => e.tags.some((t) => t[0] === "eid" && t[1] === id)).at(-1);
      return r ? readChannelContent(r.content)!.metadata.position : undefined;
    };
    expect(key(ids[3])).toBeDefined();
    expect(key(ids[2])).toBeDefined();
    expect(key(ids[3])! < key(ids[2])!).toBe(true);
  });
});

describe("reducing a member's authority (CORD-04 §6, §9)", () => {
  /** The admin's own decisions: a Channel they made, so a reduction must seal it. */
  function withModerator() {
    const s = setup();
    const { c, admin, grant } = s;
    const mod = hexKey();
    const modRole = hexKey();
    const role = c.role(modRole, "m", Permissions.MANAGE_CHANNELS | Permissions.KICK);
    const modGrant = c.grant(mod, [modRole], { author: admin, cite: grant });
    const modChannel = c.edition({ vsk: "2", eid: random32(), author: mod, cite: modGrant, content: { name: "mods-made-this", private: false } });
    env.folded = foldControlState([...s.base, role, modGrant, modChannel], c.id, c.owner);
    return { ...s, mod, modRole, modChannel };
  }

  const tenureFirst = (target: string) => {
    const kinds = env.published.map(vskOf);
    const tenure = kinds.indexOf("16");
    const strip = env.published.findIndex((r) => vskOf(r) === "3" && JSON.parse(r.content).member === target);
    return { tenure, strip };
  };

  it("a Kick writes the member's Tenure before stripping their Grant", async () => {
    const { community, mod } = withModerator();
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await attempt(() => result.current.kick({ target: mod }));
    const { tenure, strip } = tenureFirst(mod);
    expect(strip).toBeGreaterThanOrEqual(0);
    expect(tenure).toBeGreaterThanOrEqual(0);
    expect(tenure).toBeLessThan(strip);
  });

  it("a Ban writes the member's Tenure before stripping their Grant", async () => {
    const { community, mod } = withModerator();
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await attempt(() => result.current.ban({ target: mod }));
    const { tenure, strip } = tenureFirst(mod);
    expect(tenure).toBeGreaterThanOrEqual(0);
    expect(tenure).toBeLessThan(strip);
  });

  it("a Ban writes the member's Tenure before the Banlist edition (CORD-04 §9, Vector `ban_many`)", async () => {
    const { community, mod } = withModerator();
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await attempt(() => result.current.ban({ target: mod }));
    const kinds = env.published.map(vskOf);
    expect(kinds.indexOf("16")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("16")).toBeLessThan(kinds.indexOf("4"));
    expect(kinds.filter((k) => k === "16")).toHaveLength(1);
  });

  it("a Ban on a fold short of the plane still seals what it holds, strips and finishes (Vector `Seal::BestEffort`)", async () => {
    const { community, mod } = withModerator();
    env.folded = { ...env.folded!, incomplete: [hexKey()] };
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.ban({ target: mod });
    });
    expect(outcome).toMatchObject({ banned: [mod] });
    const { tenure, strip } = tenureFirst(mod);
    expect(tenure).toBeGreaterThanOrEqual(0);
    expect(tenure).toBeLessThan(strip);
  });

  it("a Ban on a plane it can't read whole seals nothing and still strips and finishes (Vector `Seal::BestEffort`)", async () => {
    const { community, mod } = withModerator();
    env.readWhole = false;
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.ban({ target: mod });
    });
    expect(outcome).toMatchObject({ banned: [mod] });
    const { tenure, strip } = tenureFirst(mod);
    expect(tenure).toBe(-1);
    expect(strip).toBeGreaterThanOrEqual(0);
  });

  it("removing a member's Roles on a plane it can't read whole is refused (Vector `Seal::Strict`)", async () => {
    const { community, mod } = withModerator();
    env.readWhole = false;
    const { result } = renderHook(() => useRoles(community), { wrapper });
    await attempt(() => result.current.setMemberRoles({ member: mod, roleIds: [] }));
    expect(env.published).toEqual([]);
  });

  it("a Kick whose role strip no relay took fails, and kicks nobody (Vector `kick_member`)", async () => {
    const { community, mod } = withModerator();
    env.failVsk = "3";
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    let error: unknown;
    await act(async () => {
      await result.current.kick({ target: mod }).catch((e: unknown) => void (error = e));
    });
    expect(error).toBeInstanceOf(Error);
    expect(env.guestbook.filter((g) => g.type === "kick")).toEqual([]);
  });

  it("a Kick on a fold short of the plane still strips and kicks", async () => {
    const { community, mod } = withModerator();
    env.folded = { ...env.folded!, incomplete: [hexKey()] };
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await act(async () => {
      await result.current.kick({ target: mod });
    });
    expect(tenureFirst(mod).strip).toBeGreaterThanOrEqual(0);
    expect(env.guestbook).toContainEqual(expect.objectContaining({ type: "kick", target: mod }));
  });

  it("removing a member's Roles writes their Tenure first, or is refused", async () => {
    const { community, mod } = withModerator();
    const { result } = renderHook(() => useRoles(community), { wrapper });
    await attempt(() => result.current.setMemberRoles({ member: mod, roleIds: [] }));
    const { tenure, strip } = tenureFirst(mod);
    expect(strip === -1 || (tenure >= 0 && tenure < strip)).toBe(true);
  });

  it("setting a stock tier mints no vsk-1 Role on the vsk-13 Roster", async () => {
    const { community } = withModerator();
    const { result } = renderHook(() => useRoles(community), { wrapper });
    await attempt(() => result.current.setTier({ member: hexKey(), tier: "moderator" }));
    expect(env.published.filter((r) => vskOf(r) === "1")).toEqual([]);
  });
});

describe("lifting a Ban (CORD-04 §6, concord#25 7c64a24)", () => {
  it("writes the banned member's departure, a Kick dated at the Ban, before the Banlist edition", async () => {
    const { c, base, community } = setup();
    const target = hexKey();
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [target] });
    env.folded = foldControlState([...base, ban], c.id, c.owner);
    env.user = { pubkey: c.owner, signer: {} };
    // Their standing Join predates the Ban.
    env.coalesced.set(target, { pubkey: target, state: "join", ms: (ban.createdAt - 60) * 1000, rumorId: hexKey(), fromSnapshot: false });
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await attempt(() => result.current.unban({ target }));
    expect(env.guestbook).toContainEqual(expect.objectContaining({ type: "kick", target, ms: ban.createdAt * 1000 }));
  });

  it("writes no departure for a member who rejoined after the Ban (Vector `publish_ban_departures`)", async () => {
    const { c, base, community } = setup();
    const target = hexKey();
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [target] });
    env.folded = foldControlState([...base, ban], c.id, c.owner);
    env.user = { pubkey: c.owner, signer: {} };
    env.coalesced.set(target, { pubkey: target, state: "join", ms: (ban.createdAt + 10) * 1000, rumorId: hexKey(), fromSnapshot: false });
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await attempt(() => result.current.unban({ target }));
    expect(env.guestbook.filter((g) => g.type === "kick")).toEqual([]);
  });
});

describe("the vsk-13 Roster's editors (Vector create/edit/move/delete_role_v2)", () => {
  /** The owner signing, an admin at rank "a", and a moderator Role at "m" the admin granted. */
  function withOwner() {
    const ownerSk = generateSecretKey();
    const k = rankedCommunity(Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS, { owner: getPublicKey(ownerSk) });
    const { c, admin, grant, base } = k;
    const mod = hexKey();
    const modRole = hexKey();
    const role = c.role(modRole, "m", Permissions.MANAGE_CHANNELS);
    const modGrant = c.grant(mod, [modRole], { author: admin, cite: grant });
    const modChannel = c.edition({ vsk: "2", eid: random32(), author: mod, cite: modGrant, content: { name: "mods-made-this", private: false } });
    env.folded = foldControlState([...base, role, modGrant, modChannel], c.id, c.owner);
    env.user = { pubkey: c.owner, signer: signerOf(ownerSk) };
    return { ...k, community: heldCommunity(c), mod, modRole };
  }

  it("deleting a Role seals its holders' Tenures first", async () => {
    const { community, modRole } = withOwner();
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await attempt(() => result.current.deleteRole({ roleId: modRole }));
    const kinds = env.published.map(vskOf);
    const deletion = env.published.findIndex((r) => vskOf(r) === "13" && JSON.parse(r.content).deleted === true);
    expect(deletion).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("16")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("16")).toBeLessThan(deletion);
    // Every edition counts toward the progress line, Tenures included.
    await vi.waitFor(() => expect(result.current.published).toBe(env.published.length));
    expect(result.current.planned).toBe(env.published.length);
  });

  it("deleting a Role on a plane it can't read whole publishes nothing", async () => {
    const { community, modRole } = withOwner();
    env.readWhole = false;
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await attempt(() => result.current.deleteRole({ roleId: modRole }));
    expect(env.published).toEqual([]);
  });

  it("moving a Role above its Grant's signer re-signs the Grant as the mover", async () => {
    const { c, community, mod, modRole } = withOwner();
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await attempt(() => result.current.moveRole({ roleId: modRole, index: 0 }));
    const move = env.published.findIndex((r) => vskOf(r) === "13" && JSON.parse(r.content).role_id === modRole);
    const regrant = env.published.findIndex((r) => vskOf(r) === "3" && JSON.parse(r.content).member === mod);
    expect(move).toBeGreaterThanOrEqual(0);
    // Before the move, so a run that stops between them strands no holder.
    expect(regrant).toBeGreaterThanOrEqual(0);
    expect(regrant).toBeLessThan(move);
    expect(env.published[regrant].pubkey).toBe(c.owner);
    expect(JSON.parse(env.published[regrant].content).role_ids).toEqual([modRole]);
  });

  it("a reorder keeps the longest run in place and moves the rest, sealing a lowered Role's holders first", async () => {
    const { community, modRole, adminRole } = withOwner();
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    let moved = 0;
    await act(async () => {
      moved = await result.current.reorderRoles({ ordered: [modRole, adminRole] });
    });
    expect(moved).toBe(1);
    const move = env.published.findIndex((r) => vskOf(r) === "13" && JSON.parse(r.content).role_id === adminRole);
    const tenure = env.published.findIndex((r) => vskOf(r) === "16");
    expect(tenure).toBeGreaterThanOrEqual(0);
    expect(tenure).toBeLessThan(move);
  });

  it("a reorder that lowers a Role on a plane it can't read whole publishes nothing", async () => {
    const { community, modRole, adminRole } = withOwner();
    env.readWhole = false;
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await attempt(() => result.current.reorderRoles({ ordered: [modRole, adminRole] }));
    expect(env.published).toEqual([]);
  });

  it("the switch from the legacy Roster is planned on the plane read whole, or refused", async () => {
    const { community } = withOwner();
    env.folded = { ...env.folded!, rankedRoster: undefined };
    env.readWhole = false;
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await attempt(() => result.current.activate({}));
    expect(env.published).toEqual([]);
  });

  it("a switch cut short after @everyone finishes its own plan on the next attempt", async () => {
    const { community } = withOwner();
    const legacy = { ...env.folded!, rankedRoster: undefined };
    env.folded = legacy;
    env.failVsk = "2";
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await attempt(() => result.current.activate({}));
    const before = env.published.length;
    expect(env.published.some((r) => vskOf(r) === "2")).toBe(false);
    expect(before).toBeGreaterThan(0);
    await vi.waitFor(() => expect(result.current.activationLeft).toBeGreaterThan(0));

    // The community now reads as ranked, so planning again would be refused.
    env.failVsk = undefined;
    env.folded = { ...legacy, rankedRoster: true };
    await attempt(() => result.current.activate({}));
    const resumed = env.published.slice(before);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((r) => vskOf(r) === "2" || vskOf(r) === "17")).toBe(true);
    await vi.waitFor(() => expect(result.current.activationLeft).toBe(0));
  });
});
