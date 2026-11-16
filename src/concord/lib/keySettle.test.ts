/**
 * A member whose Role gating several Private Channels is taken away and given back
 * (CORD-03 §5, CORD-06 §2, Vector `change_member_roles` / `settle_access`). A rotation
 * that leaves out a member a later Grant let back in, once that Grant's key is out,
 * is unrecoverable by design: no holder serves a member the rotation of the epoch
 * cut. So a change settles whole before the next begins, and a duty rotates only
 * on what the store says now.
 */
import { describe, expect, it } from "vitest";

import { dutyMayAct, planChannelDuty, planSettle, rotationRecipients, stillShutOut, withGrant, type MintingRotation } from "@/concord/lib/accessDuty";
import { accessDeliveryAdmits, type ParsedDelivery } from "@/concord/lib/delivery";
import { judgeCatchUpChannels } from "@/concord/lib/catchUpAdoption";
import { isEntitled } from "@/concord/lib/channelAccess";
import type { CommunityListEntry } from "@/concord/lib/communityList";
import { foldControlState, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { heldMembershipOf } from "@/concord/lib/directInvite";
import { parseEdition, type ParsedEdition } from "@/concord/lib/edition";
import { withKeySettle } from "@/concord/lib/keySettle";
import { planCreateRole, planOverwrite } from "@/concord/lib/rankedWrites";
import { myLocator } from "@/concord/lib/rekey";
import { EVERYONE_DEFAULT, Permissions } from "@/concord/lib/roles";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { hexKey, TestCommunity } from "@/test/concordEditions";

const parsed = (r: NostrRumor): ParsedEdition =>
  parseEdition({ rumorId: r.id, author: r.pubkey, kind: r.kind, content: r.content, tags: r.tags, ms: r.created_at * 1000, createdAt: r.created_at } as OpenedEvent);

/** Owner O, member U, and a "Testers" Role allowed VIEW_CHANNEL on Private Channels A, B, C. */
function world(rolePermissions = 0n) {
  const c = new TestCommunity();
  const U = hexKey();
  const ids = [random32(), random32(), random32()].map(bytesToHex);
  let all: ParsedEdition[] = [c.everyone(EVERYONE_DEFAULT), ...ids.map((id, i) => c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: `p${i}`, private: true } }))];
  const fold = () => foldControlState(all, c.id, c.owner);
  const role = planCreateRole(fold(), c.id, c.owner, { name: "Testers", color: 0, permissions: rolePermissions });
  all = [...all, parsed(role.rumor)];
  for (const id of ids) all = [...all, parsed(planOverwrite(fold(), c.id, c.owner, new Set(ids), id, { kind: "role", id: role.roleId }, Permissions.VIEW_CHANNEL, 0n))];
  let lastGrant: ParsedEdition | undefined;
  const setRole = (on: boolean, createdAt?: number): FoldedControl => {
    lastGrant = c.grant(U, on ? [role.roleId] : [], { prev: lastGrant, createdAt });
    all = [...all, lastGrant];
    return fold();
  };
  return { c, U, O: c.owner, ids, roleId: role.roleId, fold, setRole, root: bytesToHex(random32()) };
}

const rotation = (rotator: string, channel: string, epoch: bigint, to: string[], at?: number): MintingRotation => ({
  rotator,
  ...(at !== undefined ? { at } : {}),
  blobs: to.map((pk) => ({ locator: myLocator(rotator, pk, channel, epoch), wrapped: "" })),
});

const delivery = (deliverer: string, channel: string, epoch: bigint, to: string[]): ParsedDelivery => ({
  deliverer,
  form: "access",
  scopeIdHex: channel,
  newEpoch: epoch,
  certs: [],
  blobs: to.map((pk) => ({ locator: myLocator(deliverer, pk, channel, epoch), wrapped: "" })),
});

function entryOf(root: string, cid: string, channels: Record<string, number>, cuts: Record<string, number> = {}): CommunityListEntry {
  const current = {
    community_id: cid,
    owner: "o",
    owner_salt: "s",
    community_root: root,
    root_epoch: 0,
    relays: [],
    name: "",
    channels: Object.entries(channels).map(([id, epoch]) => ({ id, key: `${id.slice(0, 8)}${epoch}`.padEnd(64, "0"), epoch, name: "" })),
  };
  const cutList = Object.entries(cuts).map(([id, epoch]) => ({ id, epoch }));
  return { community_id: cid, seed: current, current, added_at: 1, ...(cutList.length ? { channel_cuts: cutList } : {}) };
}

const bundleOf = (root: string, channels: Record<string, number>) => ({
  root_epoch: 0,
  community_root: root,
  channels: Object.entries(channels).map(([id, epoch]) => ({ id, key: `${id.slice(0, 8)}${epoch}`.padEnd(64, "0"), epoch, name: "" })),
});

describe("a Grant's settle (Vector `settle_access`)", () => {
  it("moves exactly what the Grant moved, judged on the Roster it was planned on", () => {
    const w = world();
    const off = w.setRole(false);
    const settle = (before: FoldedControl, on: boolean) =>
      planSettle({ before: before.roster, after: withGrant(before.roster, w.U, on ? [w.roleId] : []), ownerHex: w.O, banned: before.banned, me: w.O, members: [w.U], channels: w.ids });
    expect(settle(off, true).map((s) => s.gained)).toEqual([[w.U], [w.U], [w.U]]);
    const on = w.setRole(true);
    expect(settle(on, false).map((s) => s.lost)).toEqual([[w.U], [w.U], [w.U]]);
    // A repeat moves nothing, and neither the owner nor the actor is ever moved.
    expect(settle(on, true)).toEqual([]);
    expect(planSettle({ before: off.roster, after: withGrant(off.roster, w.O, [w.roleId]), ownerHex: w.O, banned: off.banned, me: w.O, members: [w.O], channels: w.ids })).toEqual([]);
  });

  it("lets a member denied Read Message History in by a fresh epoch rather than the key", () => {
    const w = world();
    const off = w.setRole(false);
    const noHistory = { ...off.roster, everyone: EVERYONE_DEFAULT & ~Permissions.READ_MESSAGE_HISTORY };
    const [s] = planSettle({ before: noHistory, after: withGrant(noHistory, w.U, [w.roleId]), ownerHex: w.O, banned: off.banned, me: w.O, members: [w.U], channels: [w.ids[0]] });
    expect(s).toEqual({ channelIdHex: w.ids[0], gained: [], fresh: [w.U], lost: [] });
  });

  it("toggled off and on, settled one change at a time, leaves U holding every Channel at the new epoch", () => {
    const w = world();
    const F1 = w.setRole(true);
    const F2 = w.setRole(false);
    // OFF settled whole: every Channel rotated to 2 without U, from F1's Roster to F2's.
    for (const id of w.ids) expect(rotationRecipients({ ...F1, roster: withGrant(F1.roster, w.U, []) }, w.O, id, [w.U], [w.U])).toEqual([w.O]);
    const F3 = w.setRole(true);
    // ON starts only after, so its invite carries the keys OFF's rotations left: all at 2.
    const invite = bundleOf(w.root, Object.fromEntries(w.ids.map((id) => [id, 2])));
    // U's rekey watch has cut all three at 2; the invite is at the floor, so it lands.
    const held = heldMembershipOf(entryOf(w.root, w.c.idHex, {}, Object.fromEntries(w.ids.map((id) => [id, 2]))));
    const judged = judgeCatchUpChannels(F3, w.U, w.O, invite, held);
    expect(judged.verdict).toBe("adopt");
    expect([...judged.adopt].sort()).toEqual([...w.ids].sort());
    // And the settle's own access-plane delivery at 2 is one U's reader takes.
    for (const id of w.ids) expect(accessDeliveryAdmits({ roster: F3.roster, ownerHex: w.O, banned: F3.banned }, { epoch: 2n, sealed: "" } as never, id, w.U, w.O, 2n)).toBe(true);
    void F2;
  });
});

describe("the order is what matters: a rotation that misses a later Grant is final", () => {
  it("leaves U with no road back once its invite went out at the epoch before", () => {
    const w = world();
    const [, B] = w.ids;
    w.setRole(true);
    const F3 = (w.setRole(false), w.setRole(true));
    // The invite carried B@1, then a rotation planned before the ON Grant cut U from 2.
    const held = heldMembershipOf(entryOf(w.root, w.c.idHex, {}, { [B]: 2 }));
    expect(isEntitled(F3.roster, w.O, w.U, B)).toBe(true);
    expect(judgeCatchUpChannels(F3, w.U, w.O, bundleOf(w.root, { [B]: 1 }), held).verdict).toBe("nothing-new");
    // CORD-03 §5: served at 1 and left out of 2's rotation is cut, so no holder serves U at 2.
    const duty = planChannelDuty({ control: F3, me: w.O, channelIdHex: B, epoch: 2n, candidates: [w.U], deliveries: [delivery(w.O, B, 1n, [w.U])], minted: [rotation(w.O, B, 2n, [w.O])], prior: [rotation(w.O, B, 1n, [w.O])] });
    expect(duty).toBeUndefined();
  });
});

describe("a member a rotation cut, let in again", () => {
  const T = 1_800_000_000;
  const plan = (control: FoldedControl, w: ReturnType<typeof world>, B: string) =>
    planChannelDuty({
      control,
      me: w.O,
      channelIdHex: B,
      epoch: 2n,
      candidates: [w.U],
      deliveries: [delivery(w.O, B, 1n, [w.U])],
      minted: [rotation(w.O, B, 2n, [w.O], T * 1000)],
      prior: [rotation(w.O, B, 1n, [w.O])],
      communityId: w.c.id,
    });

  it("is served again once a Grant dated after the cut lets them in, whoever made it", () => {
    // The incident: the granter holds no key, so the holder is the only road back.
    const w = world();
    const [, B] = w.ids;
    w.setRole(true, T - 100);
    w.setRole(false, T - 50);
    expect(plan(w.setRole(true, T + 10), w, B)?.deliver).toEqual([w.U]);
  });

  it("is served again by the device that cut them once its fold lets them in, however the Grant is dated", () => {
    // The device cut on a fold that hadn't yet folded a re-grant made seconds before; the
    // re-grant is dated before the rotation, and still this device's fold moved forward.
    const w = world();
    const [, B] = w.ids;
    w.setRole(true, T - 100);
    w.setRole(false, T - 50);
    const F = w.setRole(true, T - 10);
    expect(planChannelDuty({ control: F, me: w.O, channelIdHex: B, epoch: 2n, candidates: [w.U], deliveries: [delivery(w.O, B, 1n, [w.U])], minted: [rotation(w.O, B, 2n, [w.O], T * 1000)], prior: [rotation(w.O, B, 1n, [w.O])], communityId: w.c.id, cutBySelf: new Set([w.U]) })?.deliver).toEqual([w.U]);
  });

  it("stays cut on a fold that lags the cut: its Grant predates the rotation", () => {
    const w = world();
    const [, B] = w.ids;
    expect(plan(w.setRole(true, T - 100), w, B)).toBeUndefined();
  });

  it("stays cut without the Community to date the Roster by", () => {
    const w = world();
    const [, B] = w.ids;
    w.setRole(true, T - 100);
    w.setRole(false, T - 50);
    const F = w.setRole(true, T + 10);
    expect(planChannelDuty({ control: F, me: w.O, channelIdHex: B, epoch: 2n, candidates: [w.U], deliveries: [delivery(w.O, B, 1n, [w.U])], minted: [rotation(w.O, B, 2n, [w.O], T * 1000)], prior: [rotation(w.O, B, 1n, [w.O])] })).toBeUndefined();
  });
});

describe("a duty's rotation, judged again on the store", () => {
  it("drops a cut its read planned when a Grant this device published since let the member back in", () => {
    const w = world();
    const [, B] = w.ids;
    w.setRole(true);
    const F2 = w.setRole(false);
    const F3 = w.setRole(true);
    // A pass reading F2 finds U served at the current epoch: evidence, so it would cut.
    const plan = planChannelDuty({ control: F2, me: w.O, channelIdHex: B, epoch: 1n, candidates: [w.U], deliveries: [delivery(w.O, B, 1n, [w.U])], minted: [rotation(w.O, B, 1n, [w.O])], prior: [] });
    expect(plan?.cut).toEqual([w.U]);
    // Under the settle lock the store holds the ON Grant: nobody is left to cut.
    expect(stillShutOut(F3, B, plan!.cut)).toEqual([]);
    expect(stillShutOut(F2, B, plan!.cut)).toEqual([w.U]);
  });

  it("cuts a member this device delivered to, when the relays withhold that delivery", () => {
    const w = world();
    const [, B] = w.ids;
    w.setRole(true);
    const F2 = w.setRole(false);
    const plan = planChannelDuty({ control: F2, me: w.O, channelIdHex: B, epoch: 1n, candidates: [w.U], deliveries: [], minted: [rotation(w.O, B, 1n, [w.O])], prior: [], handled: new Set([w.U]) });
    expect(plan?.cut).toEqual([w.U]);
  });

  it("never cuts again at the epoch after: the evidence was the epoch it rotated away", () => {
    const w = world();
    const [, B] = w.ids;
    w.setRole(true);
    const F2 = w.setRole(false);
    const next = planChannelDuty({ control: F2, me: w.O, channelIdHex: B, epoch: 2n, candidates: [w.U], deliveries: [delivery(w.O, B, 1n, [w.U])], minted: [rotation(w.O, B, 2n, [w.O])], prior: [rotation(w.O, B, 1n, [w.O])] });
    expect(next).toBeUndefined();
  });

  it("reads no plane for a Channel it can neither serve nor rotate", () => {
    const w = world();
    const F = w.setRole(true);
    const peer = hexKey();
    expect(dutyMayAct(F, peer, w.ids[0], [w.U], new Set())).toBe(false);
    expect(dutyMayAct(F, w.U, w.ids[0], [w.U], new Set())).toBe(false);
    expect(dutyMayAct(F, w.U, w.ids[0], [w.U, w.O], new Set())).toBe(true);
    expect(dutyMayAct(F, w.U, w.ids[0], [w.U, w.O], new Set([w.O]))).toBe(false);
    expect(dutyMayAct(F, w.O, w.ids[0], [], new Set())).toBe(true);
  });
});

describe("withKeySettle", () => {
  it("runs one settle at a time per Community, in order, and a failure doesn't wedge the next", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withKeySettle("c", async () => {
      order.push("off:start");
      await new Promise<void>((r) => (release = r));
      order.push("off:end");
      throw new Error("relay refused");
    });
    const second = withKeySettle("c", async () => void order.push("on"));
    const elsewhere = withKeySettle("d", async () => void order.push("other"));
    await elsewhere;
    expect(order).toEqual(["off:start", "other"]);
    release();
    await expect(first).rejects.toThrow("relay refused");
    await second;
    expect(order).toEqual(["off:start", "other", "off:end", "on"]);
  });
});
