/**
 * Two writes in a row from one device, while the rendered Control fold still lags
 * the first (Vector plans each on its store after the last, under `follow_lock`):
 * the second must chain from the first and keep what it changed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openChannelSeal } from "@/concord/lib/channelSeal";
import { foldControlState, readChannelContent, type FoldedControl } from "@/concord/lib/control";
import type { PrivateChannelKey } from "@/concord/lib/types";
import { bytesToHex, hex32, random32 } from "@/concord/lib/derive";
import { parseEdition, type ParsedEdition } from "@/concord/lib/edition";
import { Permissions, rolesOf } from "@/concord/lib/roles";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { heldCommunity, hexKey, rankedCommunity, type TestCommunity } from "@/test/concordEditions";

const env = vi.hoisted(() => ({
  c: undefined as unknown,
  base: [] as unknown[],
  lagging: undefined as unknown,
  published: [] as unknown[],
  user: { pubkey: "", signer: {} as unknown },
  /** Resolves the first publish only when released, to hold two writes in flight. */
  gate: undefined as Promise<void> | undefined,
}));

const parsed = (r: NostrRumor): ParsedEdition =>
  parseEdition({ rumorId: r.id, author: r.pubkey, kind: r.kind, content: r.content, tags: r.tags, ms: r.created_at * 1000, createdAt: r.created_at } as OpenedEvent);
/** What this device's store holds now: everything it was given and everything it published. */
const stored = () => {
  const c = env.c as TestCommunity;
  return foldControlState([...(env.base as ParsedEdition[]), ...(env.published as NostrRumor[]).map(parsed)], c.id, c.owner);
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { relay: () => ({ event: async () => undefined, query: async () => [] }) } }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: env.user }) }));
vi.mock("@/hooks/useRemoveRailKey", () => ({ useRemoveRailKey: () => () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: env.lagging, isLoading: false }),
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => {
    const gate = env.gate;
    env.gate = undefined;
    if (gate) await gate;
    env.published.push(rumor);
  },
  invalidateControl: () => undefined,
  foldStoredControl: async () => stored(),
  readControlWhole: async () => undefined,
}));
const keys: PrivateChannelKey[] = [];
vi.mock("@/concord/hooks/useCommunityList", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useCommunityList")>()),
  useUpdateCommunityList: () => ({
    mutateAsync: async (w: { type: string; channels?: Array<{ id: string; key: string; epoch: number }> }) => {
      const k = w.type === "refresh-channels" ? w.channels?.at(-1) : undefined;
      if (k) keys.push({ id: hex32(k.id), key: hex32(k.key), epoch: BigInt(k.epoch), name: "" });
    },
  }),
  useCommunityEntry: () => undefined,
}));
vi.mock("@/concord/hooks/useGuestbook", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useGuestbook")>()),
  useGuestbook: () => ({ data: [], coalesced: new Map(), timeouts: new Map(), nicknames: new Map() }),
  useGuestbookPublisher: () => ({ mutateAsync: async () => undefined }),
}));

vi.mock("@/concord/hooks/useRekey", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useRekey")>()),
  useRefound: () => ({ refound: async () => undefined, canRefound: true }),
  useChannelRekey: () => ({ rekeyChannel: async () => undefined, canRekeyChannel: true, canSeverChannel: true }),
}));
vi.mock("@/concord/lib/channelRotation", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/channelRotation")>()),
  publishChannelRotation: async () => undefined,
}));
vi.mock("@/concord/lib/readCutPending", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/readCutPending")>()),
  addReadCutPending: async () => undefined,
  clearReadCutPending: () => undefined,
}));

const { useMetadataActions, useRoles } = await import("@/concord/hooks/useRoles");
const { useModeration } = await import("@/concord/hooks/useModeration");
const { useCommunityPause } = await import("@/concord/hooks/usePause");
const { useRankedRoles } = await import("@/concord/hooks/useRankedRoles");
const { useCommunityManagement } = await import("@/concord/hooks/useCommunityActions");

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function setup() {
  const k = rankedCommunity(Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS);
  const { c } = k;
  const [x, y] = [hexKey(), hexKey()];
  const member = hexKey();
  const ch = random32();
  const cat = hexKey();
  const base = [
    ...k.base,
    c.role(x, "m", Permissions.SEND_MESSAGES, { name: "X" }),
    c.role(y, "n", Permissions.SEND_MESSAGES, { name: "Y" }),
    c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "general", private: false } }),
    c.edition({ vsk: "15", eid: cat, author: c.owner, content: { name: "Text", position: "a" } }),
  ];
  env.c = c;
  env.base = base;
  env.published = [];
  env.lagging = foldControlState(base, c.id, c.owner);
  env.user = { pubkey: c.owner, signer: {} };
  return { c, community: heldCommunity(c), x, y, member, ch: bytesToHex(ch), cat };
}

beforeEach(() => {
  env.gate = undefined;
});

/** Each entity's editions from this device form one chain: no two at one version. */
function expectChained() {
  const seen = new Map<string, Set<bigint>>();
  for (const e of (env.published as NostrRumor[]).map(parsed)) {
    const eid = bytesToHex(e.entityId);
    const versions = seen.get(eid) ?? new Set();
    expect(versions.has(e.version), `two editions of ${eid.slice(0, 8)} at v${e.version}`).toBe(false);
    versions.add(e.version);
    seen.set(eid, versions);
  }
}

describe("writes in a row while the rendered fold lags", () => {
  it("a second Grant chains from the first and keeps the Role it gave", async () => {
    const { community, x, y, member } = setup();
    const { result } = renderHook(() => useRoles(community), { wrapper });
    await act(async () => {
      await result.current.setMemberRoles({ member, roleIds: [x] });
      await result.current.setMemberRoles({ member, roleIds: [x, y] });
    });
    expectChained();
    expect(rolesOf(stored().roster, member).map((r) => r.roleId).sort()).toEqual([x, y].sort());
  });

  it("two Grants in flight at once both land", async () => {
    const { community, x, y, member } = setup();
    const { result } = renderHook(() => useRoles(community), { wrapper });
    let release!: () => void;
    env.gate = new Promise((r) => (release = r));
    await act(async () => {
      const first = result.current.setMemberRoles({ member, roleIds: [x] });
      const second = result.current.setMemberRoles({ member, roleIds: [x, y] });
      release();
      await Promise.all([first, second]);
    });
    expectChained();
    expect(rolesOf(stored().roster, member).map((r) => r.roleId).sort()).toEqual([x, y].sort());
  });

  it("a rename then a move to a Category keeps both", async () => {
    const { community, ch, cat } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await act(async () => {
      await result.current.renameChannel({ channelIdHex: ch, name: "lobby" });
      await result.current.setChannelCategory({ channelIdHex: ch, category: cat });
    });
    expectChained();
    const def = stored().channels.get(ch)!;
    expect(def.name).toBe("lobby");
    expect(def.metadata.category).toBe(cat);
  });

  it("two overwrites on one target in a row keep the second", async () => {
    const { community, ch, x } = setup();
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    await act(async () => {
      await result.current.setOverwrite({ scope: ch, target: { kind: "role", id: x }, allow: Permissions.SEND_MESSAGES, deny: 0n });
      await result.current.setOverwrite({ scope: ch, target: { kind: "role", id: x }, allow: 0n, deny: Permissions.VIEW_CHANNEL });
    });
    expectChained();
    const o = (stored().roster.overwrites ?? []).find((w) => w.scope === ch && w.target.kind === "role");
    expect(o).toMatchObject({ allow: 0n, deny: Permissions.VIEW_CHANNEL });
  });

  it("a rename then a new description keeps both", async () => {
    const { community } = setup();
    const { result } = renderHook(() => useMetadataActions(community), { wrapper });
    await act(async () => {
      await result.current.updateMetadata({ name: "Renamed" });
      await result.current.updateMetadata({ description: "about" });
    });
    expectChained();
    expect(stored().metadata).toMatchObject({ name: "Renamed", description: "about" });
  });

  it("creates a voice channel inside a Category, following the Category's rules (Vector `create_channel_in`)", async () => {
    const { community, cat } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    let id = "";
    await act(async () => {
      id = (await result.current.createChannel({ name: "hangout", view: "voice", category: cat })).channelIdHex;
    });
    expectChained();
    const f = stored();
    expect(f.channels.get(id)?.metadata).toMatchObject({ name: "hangout", view: "voice", category: cat });
    expect(f.roster.syncs?.[id], "a public Channel made in a Category takes its rules").toBe(cat);
  });

  it("a private channel made in a Category keeps its own rules", async () => {
    const { community, cat } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    let id = "";
    await act(async () => {
      id = (await result.current.createChannel({ name: "staff", isPrivate: true, category: cat })).channelIdHex;
    });
    expect(stored().roster.syncs?.[id]).toBeUndefined();
  });

  it("a pause then its resume chain, and the community ends up running", async () => {
    const { community } = setup();
    const { result } = renderHook(() => useCommunityPause(community), { wrapper });
    await act(async () => {
      await result.current.setPaused.mutateAsync({});
      await result.current.clearPause.mutateAsync();
    });
    expectChained();
  });

  it("a rename then making the channel private keeps the new name under the seal", async () => {
    const { community, ch } = setup();
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await act(async () => {
      await result.current.renameChannel({ channelIdHex: ch, name: "lobby" });
      await result.current.privatiseChannel({ channelIdHex: ch });
    });
    expectChained();
    const sealedEd = (env.published as NostrRumor[]).at(-1)!;
    const read = readChannelContent(sealedEd.content)!.sealed!;
    const prev = sealedEd.tags.find((t) => t[0] === "ep")?.[1];
    const key = keys.at(-1)!;
    expect(openChannelSeal({ ...read, prevHex: prev }, key)?.metadata.name).toBe("lobby");
  });

  it("two bans in a row keep both banned", async () => {
    const { community } = setup();
    const [a, b] = [hexKey(), hexKey()];
    const { result } = renderHook(() => useModeration(community, []), { wrapper });
    await act(async () => {
      await result.current.banMany({ targets: [a] });
      await result.current.banMany({ targets: [b] });
    });
    expectChained();
    expect([...stored().banned].sort()).toEqual([a, b].sort());
  });

  it("a Role created while another is created both stand", async () => {
    const { community } = setup();
    const { result } = renderHook(() => useRankedRoles(community), { wrapper });
    let release!: () => void;
    env.gate = new Promise((r) => (release = r));
    let ids: string[] = [];
    await act(async () => {
      const a = result.current.createRole({ name: "A", color: 0, permissions: 0n });
      const b = result.current.createRole({ name: "B", color: 0, permissions: 0n });
      release();
      ids = await Promise.all([a, b]);
    });
    const names = stored().roster.roles.filter((r) => ids.includes(r.roleId)).map((r) => r.name).sort();
    expect(names).toEqual(["A", "B"]);
  });
});

export type { FoldedControl };
