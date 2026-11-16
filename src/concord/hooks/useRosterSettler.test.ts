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

import { settleRoster } from "./useRosterSettler";

const parsed = (r: NostrRumor): ParsedEdition =>
  parseEdition({ rumorId: r.id, author: r.pubkey, kind: r.kind, content: r.content, tags: r.tags, ms: r.created_at * 1000, createdAt: r.created_at } as OpenedEvent);

/** Owner, two members, a Role allowed VIEW_CHANNEL on Private Channels A, B, C; this device holds A and B. */
function world() {
  const c = new TestCommunity();
  const [U, V] = [hexKey(), hexKey()];
  const ids = [random32(), random32(), random32()].map(bytesToHex);
  let all: ParsedEdition[] = [c.everyone(EVERYONE_DEFAULT), ...ids.map((id) => c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "p", private: true } }))];
  const fold = () => foldControlState(all, c.id, c.owner);
  const role = planCreateRole(fold(), c.id, c.owner, { name: "Testers", color: 0, permissions: 0n });
  all = [...all, parsed(role.rumor)];
  for (const id of ids) all = [...all, parsed(planOverwrite(fold(), c.id, c.owner, new Set(ids), id, { kind: "role", id: role.roleId }, Permissions.VIEW_CHANNEL, 0n))];
  const last = new Map<string, ParsedEdition>();
  const setRole = (member: string, on: boolean): FoldedControl => {
    const g = c.grant(member, on ? [role.roleId] : [], { prev: last.get(member) });
    last.set(member, g);
    all = [...all, g];
    return fold();
  };
  const community = heldCommunity(c, ids.slice(0, 2).map((id) => ({ id: hex32(id), key: random32(), epoch: 1n, name: "p" })));
  return { c, U, V, ids, setRole, community };
}

/** A device acting as `me`, recording each step; a rotation moves the list one epoch on. */
/** `deps` with `step` held open until `release`, counting the calls under way. */
function held<D extends Parameters<typeof settleRoster>[0]>(deps: D, step: "rekey" | "deliver") {
  let gate!: () => void;
  const open = new Promise<void>((r) => (gate = r));
  let n = 0;
  const inner = deps[step] as (...a: unknown[]) => Promise<unknown>;
  return {
    deps: { ...deps, [step]: async (...a: unknown[]) => { n++; await open; return inner(...a); } } as D,
    started: () => n,
    release: () => gate(),
  };
}

function device(w: ReturnType<typeof world>, me: string) {
  const steps: Array<[string, Record<string, unknown>]> = [];
  let held: Community = w.community;
  const deps = {
    community: w.community,
    user: { pubkey: me, signer: {} as never },
    members: new Map(),
    rekey: async (v: { channelIdHex: string; community?: Community }) => {
      steps.push(["rekey", v as never]);
      held = { ...held, privateChannels: held.privateChannels.map((k) => (bytesToHex(k.id) === v.channelIdHex ? { ...k, key: random32(), epoch: k.epoch + 1n } : k)) };
    },
    invite: async (v: unknown) => void steps.push(["invite", v as never]),
    deliver: async (_c: Community, ch: Community["privateChannels"][number], to: string[]) => void steps.push(["plane", { channel: bytesToHex(ch.id), epoch: ch.epoch, to }]),
    now: () => held,
  };
  return { steps, deps: deps as unknown as Parameters<typeof settleRoster>[0] };
}

describe("settleRoster (Vector `settle_access`)", () => {
  it("rotates each Channel a member lost, all at once", async () => {
    const w = world();
    const on = w.setRole(w.U, true);
    const off = w.setRole(w.U, false);
    const d = device(w, w.c.owner);
    const { deps, started, release } = held(d.deps, "rekey");
    const settled = settleRoster(deps, on, off);
    // Both under way before either lands: one after another, the last cut landed a rotation per Channel late.
    await vi.waitFor(() => expect(started()).toBe(2));
    release();
    const report = await settled;
    const rotations = d.steps.filter(([s]) => s === "rekey").map(([, v]) => v);
    expect(rotations.map((v) => v.channelIdHex).sort()).toEqual(w.ids.slice(0, 2).sort());
    for (const v of rotations) expect(v).toMatchObject({ removedTargets: [w.U], keepRecipients: [w.c.owner] });
    expect(report.unheldLost).toEqual([w.ids[2]]);
  });

  it("hands every member let in each gained key from the keys the rotations left, on the plane and by invite", async () => {
    const w = world();
    w.setRole(w.V, true);
    const before = w.setRole(w.U, false);
    const after = w.setRole(w.U, true);
    const d = device(w, w.c.owner);
    const { deps, started, release } = held(d.deps, "deliver");
    const settled = settleRoster(deps, before, after);
    // Each Channel's key goes out at once, so one long history doesn't hold up the rest.
    await vi.waitFor(() => expect(started()).toBe(2));
    release();
    const report = await settled;
    // V held the Role before and after: only U moved.
    const planes = d.steps.filter(([s]) => s === "plane").map(([, v]) => v);
    expect(planes.map((p) => p.channel).sort()).toEqual(w.ids.slice(0, 2).sort());
    for (const p of planes) expect(p.to).toEqual([w.U]);
    const invites = d.steps.filter(([s]) => s === "invite").map(([, v]) => v);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ recipientPubkey: w.U, alsoRelays: w.community.relays });
    expect([...(invites[0].onlyChannelIdHexes as Set<string>)].sort()).toEqual(w.ids.slice(0, 2).sort());
    expect(report).toMatchObject({ members: [w.U], unheldGained: [w.ids[2]] });
    expect(report.sent.sort()).toEqual(w.ids.slice(0, 2).sort());
  });

  it("reports a cut it may not make and makes none", async () => {
    const w = world();
    const on = w.setRole(w.U, true);
    const off = w.setRole(w.U, false);
    const d = device(w, hexKey());
    const report = await settleRoster(d.deps, on, off);
    expect(d.steps).toEqual([]);
    expect(report.notRotated.sort()).toEqual(w.ids.slice(0, 2).sort());
  });

  it("does nothing for a change that moves no key", async () => {
    const w = world();
    const f = w.setRole(w.U, true);
    const d = device(w, w.c.owner);
    expect(await settleRoster(d.deps, f, f)).toMatchObject({ sent: [], unheldLost: [], notRotated: [] });
    expect(d.steps).toEqual([]);
  });
});
