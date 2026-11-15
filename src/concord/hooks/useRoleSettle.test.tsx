import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { foldControlState, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, hex32, random32 } from "@/concord/lib/derive";
import { parseEdition, type ParsedEdition } from "@/concord/lib/edition";
import { planCreateRole, planOverwrite } from "@/concord/lib/rankedWrites";
import { EVERYONE_DEFAULT, Permissions } from "@/concord/lib/roles";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import { heldCommunity, hexKey, TestCommunity } from "@/test/concordEditions";

import { useRoleSettle } from "./useRoleSettle";

const h = vi.hoisted(() => ({
  steps: [] as Array<[string, unknown]>,
  cached: undefined as unknown,
  user: undefined as unknown,
  /** What the list holds after a rotation: the rotated channel one epoch on. */
  rotate: (_v: { channelIdHex: string }) => undefined as void,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ cachedCommunity: () => h.cached }));
vi.mock("@/concord/hooks/useRekey", () => ({
  useChannelRekey: () => ({
    rekeyChannel: async (v: { channelIdHex: string; community?: Community }) => {
      h.steps.push(["rekey", v]);
      h.rotate(v);
    },
  }),
}));
vi.mock("@/concord/hooks/useInvites", () => ({
  useInviteActions: () => ({ sendDirectInvite: async (v: unknown) => void h.steps.push(["invite", v]) }),
}));
vi.mock("@/concord/hooks/useAccessDuty", () => ({
  deliverKeysOnPlane: async (_n: unknown, c: Community, ch: { epoch: bigint }, to: string[]) => void h.steps.push(["plane", { epoch: ch.epoch, to, root: c.idHex }]),
}));

const parsed = (r: NostrRumor): ParsedEdition =>
  parseEdition({ rumorId: r.id, author: r.pubkey, kind: r.kind, content: r.content, tags: r.tags, ms: r.created_at * 1000, createdAt: r.created_at } as OpenedEvent);

function world() {
  const c = new TestCommunity();
  const U = hexKey();
  const ids = [random32(), random32(), random32()].map(bytesToHex);
  let all: ParsedEdition[] = [c.everyone(EVERYONE_DEFAULT), ...ids.map((id) => c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "p", private: true } }))];
  const fold = () => foldControlState(all, c.id, c.owner);
  const role = planCreateRole(fold(), c.id, c.owner, { name: "Testers", color: 0, permissions: 0n });
  all = [...all, parsed(role.rumor)];
  for (const id of ids) all = [...all, parsed(planOverwrite(fold(), c.id, c.owner, new Set(ids), id, { kind: "role", id: role.roleId }, Permissions.VIEW_CHANNEL, 0n))];
  let last: ParsedEdition | undefined;
  const setRole = (on: boolean): FoldedControl => {
    last = c.grant(U, on ? [role.roleId] : [], { prev: last });
    all = [...all, last];
    return fold();
  };
  // This device holds A and B; C it can't key.
  const community = heldCommunity(c, ids.slice(0, 2).map((id) => ({ id: hex32(id), key: random32(), epoch: 1n, name: "p" })));
  return { c, U, ids, roleId: role.roleId, setRole, community };
}

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe("useRoleSettle (Vector `settle_access`)", () => {
  it("rotates each Channel the member lost from the list as written, then hands every gained key from the keys those rotations left", async () => {
    const w = world();
    h.user = { pubkey: w.c.owner, signer: { nip44: {} } };
    h.steps = [];
    h.cached = w.community;
    h.rotate = (v) => {
      const c = h.cached as Community;
      h.cached = { ...c, privateChannels: c.privateChannels.map((k) => (bytesToHex(k.id) === v.channelIdHex ? { ...k, key: random32(), epoch: k.epoch + 1n } : k)) };
    };
    const { result } = renderHook(() => useRoleSettle(w.community), { wrapper });
    const [A, B, C] = w.ids;

    const F1 = w.setRole(true);
    const off = await result.current(F1, w.U, [], [w.U]);
    expect(h.steps.map(([s]) => s)).toEqual(["rekey", "rekey"]);
    expect(h.steps.map(([, v]) => (v as { channelIdHex: string }).channelIdHex).sort()).toEqual([A, B].sort());
    for (const [, v] of h.steps) expect(v).toMatchObject({ removedTargets: [w.U], keepRecipients: [w.c.owner] });
    // The second rotation starts from the list the first one wrote.
    expect((h.steps[1][1] as { community: Community }).community.privateChannels.find((k) => bytesToHex(k.id) === (h.steps[0][1] as { channelIdHex: string }).channelIdHex)?.epoch).toBe(2n);
    expect(off.unheldLost).toEqual([C]);

    h.steps = [];
    const F2 = w.setRole(false);
    const on = await result.current(F2, w.U, [w.roleId], [w.U]);
    expect(h.steps.map(([s]) => s)).toEqual(["plane", "plane", "invite"]);
    for (const [, v] of h.steps.slice(0, 2)) expect(v).toMatchObject({ epoch: 2n, to: [w.U] });
    const invite = h.steps[2][1] as { source: Community; alsoRelays: string[]; onlyChannelIdHexes: Set<string>; recipientPubkey: string };
    expect(invite.recipientPubkey).toBe(w.U);
    expect(invite.source.privateChannels.every((k) => k.epoch === 2n)).toBe(true);
    expect(invite.alsoRelays).toEqual(w.community.relays);
    expect([...invite.onlyChannelIdHexes].sort()).toEqual([A, B].sort());
    expect(on.sent.sort()).toEqual([A, B].sort());
    expect(on.unheldGained).toEqual([C]);
  });

  it("reports a cut it may not make, and makes none", async () => {
    const w = world();
    const peer = hexKey();
    h.user = { pubkey: peer, signer: { nip44: {} } };
    h.steps = [];
    h.cached = w.community;
    const { result } = renderHook(() => useRoleSettle(w.community), { wrapper });
    const report = await result.current(w.setRole(true), w.U, [], [w.U]);
    expect(h.steps).toEqual([]);
    expect(report.notRotated.sort()).toEqual(w.ids.slice(0, 2).sort());
  });
});
