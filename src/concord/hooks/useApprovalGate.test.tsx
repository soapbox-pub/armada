/**
 * What turning approval to post on and off, picking the welcome Channel and approving
 * a member PUBLISH, against a real fold of synthetic editions: every edition handed to
 * `publishEdition` is captured, and folded back in as the store would hold it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GATE_BITS, GATE_EXTRAS, GATE_TAKES } from "@/concord/lib/approvalGate";
import { mayConnect } from "@/concord/lib/callGate";
import { reactionIgnored } from "@/concord/lib/channelJudges";
import { foldControlState, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import type { ParsedEdition } from "@/concord/lib/edition";
import { everyoneLocked, EVERYONE_DEFAULT, Permissions, roleToJSON } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import type { Community } from "@/concord/lib/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";

import { heldCommunity, hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

const env = vi.hoisted(() => ({
  c: undefined as unknown as { id: Uint8Array; owner: string },
  editions: [] as unknown[],
  /** What this device's store folds to; refolded from `editions` as each write lands. */
  folded: undefined as FoldedControl | undefined,
  /** What the page rendered, when it lags the store. */
  rendered: undefined as FoldedControl | undefined,
  /** What the store folds to, when it differs from the plane read whole. */
  stored: undefined as FoldedControl | undefined,
  published: [] as NostrRumor[],
  user: { pubkey: "", signer: {} as unknown },
  readWhole: true,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { relay: () => ({ event: async () => undefined, query: async () => [] }) } }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: env.user }) }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => {
  const actual = await orig<typeof import("@/concord/hooks/useControlPlane")>();
  const { parsedOf } = await import("@/concord/lib/rankedWrites");
  const { foldControlState } = await import("@/concord/lib/control");
  return {
    ...actual,
    useControlFold: () => ({ data: env.rendered ?? env.folded, isLoading: false }),
    publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => {
      env.published.push(rumor);
      env.editions.push(parsedOf(rumor));
      env.folded = foldControlState(env.editions as ParsedEdition[], env.c.id, env.c.owner);
      env.stored = undefined;
    },
    invalidateControl: () => undefined,
    readControlWhole: async () => (env.readWhole && env.folded ? { folded: env.folded, served: new Set<string>() } : undefined),
    foldStoredControl: async () => env.stored ?? env.folded,
  };
});
vi.mock("@/concord/hooks/useGuestbook", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useGuestbook")>()),
  useGuestbook: () => ({ data: [], coalesced: new Map(), timeouts: new Map(), nicknames: new Map(), history: new Map() }),
}));

const { useApprovalGate } = await import("@/concord/hooks/useApprovalGate");

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function signerOf(sk: Uint8Array) {
  return {
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    nip44: { encrypt: async (pk: string, plain: string) => nip44Encrypt(plain, getConversationKey(sk, pk)) },
  };
}

const vskOf = (r: NostrRumor) => r.tags.find((t) => t[0] === "vsk")?.[1];
const everyoneEditions = () => env.published.filter((r) => vskOf(r) === "13" && "permissions" in JSON.parse(r.content) && !("role_id" in JSON.parse(r.content)));
const grantEditions = () => env.published.filter((r) => vskOf(r) === "3");

async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  let error: unknown;
  await act(async () => {
    await run().catch((e: unknown) => {
      error = e;
    });
  });
  return error;
}

function load(c: TestCommunity, editions: ParsedEdition[], signer: { pubkey: string; sk: Uint8Array }) {
  env.c = c;
  env.editions = [...editions];
  env.folded = foldControlState(editions, c.id, c.owner);
  env.user = { pubkey: signer.pubkey, signer: signerOf(signer.sk) };
}

beforeEach(() => {
  env.published = [];
  env.rendered = undefined;
  env.stored = undefined;
  env.readWhole = true;
});

const NOW = 1_700_000_000_000;

/** A ranked Community whose admin Role holds `adminBits`, with one public Channel and a member who posted recently. */
function community(adminBits: bigint) {
  const adminSk = generateSecretKey();
  const k = rankedCommunity(adminBits, { admin: getPublicKey(adminSk) });
  const general = bytesToHex(random32());
  const channel = k.c.edition({ vsk: "2", eid: general, author: k.c.owner, content: { name: "general", private: false } });
  const member = hexKey();
  const editions = [...k.base, channel];
  load(k.c, editions, { pubkey: k.admin, sk: adminSk });
  return { ...k, editions, general, member, community: heldCommunity(k.c) };
}

describe("turning approval on", () => {
  it("is offered only to a switcher who could finish it: one missing an @everyone bit can't", () => {
    // Manage roles and posting, but not Video, which @everyone holds.
    const { community: c } = community(Permissions.MANAGE_ROLES | (EVERYONE_DEFAULT & ~Permissions.VIDEO));
    const { result } = renderHook(() => useApprovalGate(c), { wrapper });
    expect(result.current.canSwitch).toBe(false);
  });

  it("publishes nothing when its last step would be refused, rather than a Role and every Grant", async () => {
    const { community: c, member } = community(Permissions.MANAGE_ROLES | (EVERYONE_DEFAULT & ~Permissions.VIDEO));
    const { result } = renderHook(() => useApprovalGate(c), { wrapper });
    const error = await attempt(() =>
      result.current.turnOn({ members: [member], observed: new Map([[member, NOW]]), activeSinceMs: 0, role: { create: true } }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(env.published).toEqual([]);
  });

  it("publishes the Role, the Grants and then @everyone without posting, when the switcher holds what it takes", async () => {
    const { community: c, member } = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const { result } = renderHook(() => useApprovalGate(c), { wrapper });
    await attempt(() => result.current.turnOn({ members: [member], observed: new Map([[member, NOW]]), activeSinceMs: 0, role: { create: true } }));
    expect(env.published.map(vskOf)).toEqual(["13", "3", "13"]);
    expect(env.folded!.roster.everyone).toBe(EVERYONE_DEFAULT & ~GATE_TAKES);
    expect(result.current.on).toBe(true);
  });

  it("holds reactions and calls back with posting: a member waiting isn't counted or let in, one kept is", async () => {
    const { community: c, member, general } = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const waiting = hexKey();
    const { result } = renderHook(() => useApprovalGate(c), { wrapper });
    await attempt(() => result.current.turnOn({ members: [member, waiting], observed: new Map([[member, NOW]]), activeSinceMs: NOW - 1, role: { create: true } }));
    const ignored = reactionIgnored(env.folded, general)!;
    expect(ignored(waiting)).toBe(true);
    expect(ignored(member)).toBe(false);
    expect(mayConnect(env.folded, general, false, waiting)).toBe(false);
    expect(mayConnect(env.folded, general, false, member)).toBe(true);
    // Nothing left for @everyone to write there, so the Channel is the writer key's (CORD-03 §1).
    expect(everyoneLocked(env.folded!.roster, general)).toBe(true);
    expect(result.current.leaves).toBe(0n);
  });

  it("gives the Role to a member whose own Role posts without all the gate takes", async () => {
    const k = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const helper = hexKey();
    const helpers = hexKey();
    const editions = [...k.editions, k.c.role(helpers, "n", Permissions.SEND_MESSAGES, { name: "Helpers" }), k.c.grant(helper, [helpers])];
    env.editions = [...editions];
    env.folded = foldControlState(editions, k.c.id, k.c.owner);
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    await attempt(() => result.current.turnOn({ members: [helper], observed: new Map(), activeSinceMs: NOW, role: { create: true } }));
    expect(grantEditions()).toHaveLength(1);
    expect(mayConnect(env.folded, k.general, false, helper)).toBe(true);
    expect(reactionIgnored(env.folded, k.general)!(helper)).toBe(false);
  });
});

describe("approval on a Community moved from the legacy Roster", () => {
  /**
   * The owner moves a legacy Community holding a Private Channel and its access Role
   * across (CORD-04 §2); the access Role comes over as a plain ranked Role the Private
   * Channel lets through. The legacy admin doesn't hold that Channel's key.
   */
  async function upgraded() {
    const ownerSk = generateSecretKey();
    const adminSk = generateSecretKey();
    const c = new TestCommunity(getPublicKey(ownerSk));
    const admin = getPublicKey(adminSk);
    const [adminRole, access] = [hexKey(), hexKey()];
    const secret = bytesToHex(random32());
    const general = bytesToHex(random32());
    const legacy = [
      c.edition({ vsk: "1", eid: adminRole, author: c.owner, content: roleToJSON({ roleId: adminRole, name: "Admin", position: 1, permissions: Permissions.MANAGE_ROLES | Permissions.BAN, scope: { kind: "server" }, color: 0 }) }),
      c.edition({ vsk: "1", eid: access, author: c.owner, content: roleToJSON({ roleId: access, name: "secret", position: 3, permissions: 0n, scope: { kind: "channel", channelId: secret }, color: 0 }) }),
      c.edition({ vsk: "2", eid: secret, author: c.owner, content: { name: "secret", private: true } }),
      c.edition({ vsk: "2", eid: general, author: c.owner, content: { name: "general", private: false } }),
      c.grant(admin, [adminRole]),
    ];
    load(c, legacy, { pubkey: c.owner, sk: ownerSk });
    const { planActivation } = await import("@/concord/lib/rankedWrites");
    const { publishEdition } = await import("@/concord/hooks/useControlPlane");
    for (const rumor of planActivation(env.folded!, c.id, c.owner).rumors) await publishEdition(undefined as never, undefined as never, undefined as never, rumor);
    env.published = [];
    env.user = { pubkey: admin, signer: signerOf(adminSk) };
    return { c, admin, access, secret, community: heldCommunity(c) };
  }

  it("lets the carried-over admin turn it on with a new Verified role", async () => {
    const { community: c } = await upgraded();
    expect(env.folded!.rankedRoster).toBe(true);
    const member = hexKey();
    const { result } = renderHook(() => useApprovalGate(c), { wrapper });
    expect(result.current.canSwitch).toBe(true);
    const error = await attempt(() => result.current.turnOn({ members: [member], observed: new Map([[member, NOW]]), activeSinceMs: 0, role: { create: true } }));
    expect(error).toBeUndefined();
    expect(env.folded!.roster.everyone).toBe(EVERYONE_DEFAULT & ~GATE_TAKES);
  });

  it("doesn't offer a former access Role as the way in: approving would let every newcomer into its Private Channel", async () => {
    const { community: c, access } = await upgraded();
    const { adoptableRoles } = await import("@/concord/lib/approvalGate");
    expect(adoptableRoles(env.folded!, env.user.pubkey).map((r) => r.roleId)).not.toContain(access);
    const member = hexKey();
    const { result } = renderHook(() => useApprovalGate(c), { wrapper });
    const error = await attempt(() => result.current.turnOn({ members: [member], observed: new Map([[member, NOW]]), activeSinceMs: 0, role: { adopt: access } }));
    expect(error).toBeInstanceOf(Error);
    expect(env.published).toEqual([]);
  });
});

describe("turning approval off", () => {
  /** The gate on: a Verified Role posting, @everyone without the gate's bits. */
  function gatedOn(everyoneBefore = EVERYONE_DEFAULT) {
    const k = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const verified = hexKey();
    const everyone = k.c.everyone(everyoneBefore & ~GATE_BITS, { prev: k.everyone });
    const role = k.c.role(verified, "m", GATE_BITS, { name: "Verified" });
    const editions = [...k.editions, everyone, role];
    env.editions = [...editions];
    env.folded = foldControlState(editions, k.c.id, k.c.owner);
    return { ...k, verified };
  }

  it("reads @everyone off the plane read whole: a store that lost it can't strip every member's basics", async () => {
    const ownerSk = generateSecretKey();
    const k = gatedOn();
    env.user = { pubkey: k.c.owner, signer: signerOf(ownerSk) };
    env.stored = { ...env.folded!, roster: { ...env.folded!.roster, everyone: undefined } };
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    await attempt(() => result.current.turnOff(GATE_BITS));
    for (const r of everyoneEditions()) {
      expect(BigInt(JSON.parse(r.content).permissions) & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    }
  });

  it("refuses when @everyone can't be read at all", async () => {
    const ownerSk = generateSecretKey();
    const k = gatedOn();
    env.user = { pubkey: k.c.owner, signer: signerOf(ownerSk) };
    env.readWhole = false;
    env.stored = { ...env.folded!, roster: { ...env.folded!.roster, everyone: undefined } };
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    const error = await attempt(() => result.current.turnOff(GATE_BITS));
    expect(error).toBeInstanceOf(Error);
    expect(env.published).toEqual([]);
  });

  it("gives @everyone back Send messages and only the other gate bits picked", async () => {
    const k = gatedOn(EVERYONE_DEFAULT & ~Permissions.ATTACH_FILES);
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    await attempt(() => result.current.turnOff(Permissions.SEND_IN_THREADS));
    expect(env.folded!.roster.everyone! & GATE_BITS).toBe(Permissions.SEND_MESSAGES | Permissions.SEND_IN_THREADS);
  });
});

describe("a gate that left @everyone reacting and joining calls", () => {
  /** On, with a Verified Role that only posts, a member holding it, one posting through another Role and a welcome Channel. */
  function reacting() {
    const k = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const [verified, helpers, helper] = [hexKey(), hexKey(), hexKey()];
    const welcome = bytesToHex(random32());
    const o = { scope: welcome, target: { kind: "everyone" as const }, allow: GATE_BITS, deny: 0n };
    const editions = [
      ...k.editions,
      k.c.everyone(EVERYONE_DEFAULT & ~GATE_BITS, { prev: k.everyone }),
      k.c.role(verified, "m", GATE_BITS, { name: "Verified" }),
      k.c.grant(k.member, [verified]),
      // Posts, but manages messages: staff's, so not a Role the gate approves through.
      k.c.role(helpers, "n", Permissions.SEND_MESSAGES | Permissions.MANAGE_MESSAGES, { name: "Helpers" }),
      k.c.grant(helper, [helpers]),
      k.c.edition({ vsk: "2", eid: welcome, author: k.c.owner, content: { name: "welcome", private: false } }),
      k.c.edition({ vsk: "14", eid: overwriteLocator(k.c.id, o), author: k.c.owner, content: overwriteToJSON(o) }),
    ];
    env.editions = [...editions];
    env.folded = foldControlState(editions, k.c.id, k.c.owner);
    return { ...k, verified, helper, welcome, waiting: hexKey() };
  }

  it("is still on, and says what members waiting can do", () => {
    const k = reacting();
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    expect(result.current.on).toBe(true);
    expect(result.current.leaves).toBe(GATE_EXTRAS);
    expect(reactionIgnored(env.folded, k.general)!(k.waiting)).toBe(false);
    expect(mayConnect(env.folded, k.general, false, k.waiting)).toBe(true);
  });

  it("gives the approval Role, whoever posts without it and the welcome Channel what it takes, then takes it from @everyone", async () => {
    const k = reacting();
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    const error = await attempt(() => result.current.tighten());
    expect(error).toBeUndefined();
    expect(env.published.map(vskOf)).toEqual(["13", "3", "14", "13"]);
    expect(everyoneEditions()).toEqual([env.published[3]]);
    expect(env.folded!.roster.everyone).toBe(EVERYONE_DEFAULT & ~GATE_TAKES);
    expect(result.current.on).toBe(true);
    expect(result.current.leaves).toBe(0n);
    expect(env.folded!.roster.grants.find((g) => g.member === k.helper)?.roleIds).toContain(k.verified);

    const general = reactionIgnored(env.folded, k.general)!;
    expect(general(k.waiting)).toBe(true);
    expect(general(k.member)).toBe(false);
    expect(general(k.helper)).toBe(false);
    expect(reactionIgnored(env.folded, k.welcome)!(k.waiting)).toBe(false);
    // The welcome Channel opens posting and reacting, never its call.
    for (const channel of [k.general, k.welcome]) {
      expect(mayConnect(env.folded, channel, false, k.waiting)).toBe(false);
      expect(mayConnect(env.folded, channel, false, k.member)).toBe(true);
      expect(mayConnect(env.folded, channel, false, k.helper)).toBe(true);
    }
    expect(everyoneLocked(env.folded!.roster, k.general)).toBe(true);
    expect(everyoneLocked(env.folded!.roster, k.welcome)).toBe(false);
  });

  it("publishes nothing when the approval Role isn't the switcher's to edit", async () => {
    const k = reacting();
    const outsider = generateSecretKey();
    env.user = { pubkey: getPublicKey(outsider), signer: signerOf(outsider) };
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    const error = await attempt(() => result.current.tighten());
    expect(error).toBeInstanceOf(Error);
    expect(env.published).toEqual([]);
  });
});

describe("the welcome Channel", () => {
  it("closes only the one it replaces, not every Channel open to @everyone", async () => {
    const k = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const [welcome, announcements, next] = [bytesToHex(random32()), bytesToHex(random32()), bytesToHex(random32())];
    const channel = (eid: string) => k.c.edition({ vsk: "2", eid, author: k.c.owner, content: { name: eid.slice(0, 6), private: false } });
    const open = (scope: string) => {
      const o = { scope, target: { kind: "everyone" as const }, allow: Permissions.SEND_MESSAGES, deny: 0n };
      return k.c.edition({ vsk: "14", eid: overwriteLocator(k.c.id, o), author: k.c.owner, content: overwriteToJSON(o) });
    };
    const editions = [...k.editions, channel(welcome), channel(announcements), channel(next), open(welcome), open(announcements)];
    env.editions = [...editions];
    env.folded = foldControlState(editions, k.c.id, k.c.owner);
    const { result } = renderHook(() => useApprovalGate(k.community), { wrapper });
    await attempt(() => result.current.setWelcome(next, welcome));
    const touched = env.published.map((r) => JSON.parse(r.content).scope as string);
    expect(touched.sort()).toEqual([next, welcome].sort());
  });
});

describe("approving a member", () => {
  it("adds the approval Role to the Roles the member holds as stored, not as last rendered", async () => {
    const k = community(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    const verified = hexKey();
    const artists = hexKey();
    const editions = [
      ...k.editions,
      k.c.everyone(EVERYONE_DEFAULT & ~GATE_BITS, { prev: k.everyone }),
      k.c.role(verified, "m", GATE_BITS, { name: "Verified" }),
      k.c.role(artists, "n", 0n, { name: "Artists" }),
    ];
    env.rendered = foldControlState(editions, k.c.id, k.c.owner);
    // Another moderator gave them Artists since the page last rendered.
    const withArtists = [...editions, k.c.grant(k.member, [artists])];
    env.editions = [...withArtists];
    env.folded = foldControlState(withArtists, k.c.id, k.c.owner);
    const { result } = renderHook(() => useApprovalGate(k.community as Community), { wrapper });
    await attempt(() => result.current.approve(k.member));
    const [grant] = grantEditions();
    expect(JSON.parse(grant.content).role_ids.sort()).toEqual([artists, verified].sort());
  });
});
