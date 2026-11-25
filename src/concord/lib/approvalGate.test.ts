import { describe, expect, it } from "vitest";

import {
  adoptableRoles,
  awaitingApproval,
  carriedOver,
  GATE_BITS,
  gateState,
  keepsPosting,
  mayApprove,
  maySwitchGate,
  welcomeChannels,
} from "@/concord/lib/approvalGate";
import { foldControlState } from "@/concord/lib/control";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { EVERYONE_DEFAULT, Permissions } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { hexKey, rankedCommunity } from "@/test/concordEditions";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function joined(...pks: string[]): Map<string, CoalescedMember> {
  return new Map(pks.map((pubkey) => [pubkey, { pubkey, state: "join", ms: NOW, rumorId: pubkey, fromSnapshot: false }]));
}

/** A ranked Community with the gate on: a plain Verified at rank "m", `@everyone` without posting. */
function gated(adminBits = Permissions.MANAGE_ROLES | EVERYONE_DEFAULT) {
  const r = rankedCommunity(adminBits);
  const verified = hexKey();
  const everyone = r.c.everyone(EVERYONE_DEFAULT & ~GATE_BITS, { prev: r.everyone });
  const role = r.c.role(verified, "m", GATE_BITS, { name: "Verified" });
  return { ...r, verified, editions: [...r.base, everyone, role] };
}

describe("approval gate", () => {
  it("is off on a fresh Community, and on once @everyone loses posting, approving through the plain Role that posts", () => {
    const r = rankedCommunity(Permissions.MANAGE_ROLES);
    expect(gateState(foldControlState(r.base, r.c.id, r.c.owner)).on).toBe(false);

    // The admin's Role posts too, but it manages roles: staff's, not the way in.
    const g = gated();
    const state = gateState(foldControlState(g.editions, g.c.id, g.c.owner));
    expect(state.on).toBe(true);
    expect(state.roles.map((role) => role.roleId)).toEqual([g.verified]);
  });

  it("lists every plain Role that posts, lowest first, and none when nothing lets anyone in", () => {
    const g = gated();
    const artists = hexKey();
    const several = gateState(foldControlState([...g.editions, g.c.role(artists, "z", Permissions.SEND_MESSAGES, { name: "Artists" })], g.c.id, g.c.owner));
    expect(several.roles.map((role) => role.roleId)).toEqual([artists, g.verified]);

    const r = rankedCommunity(Permissions.MANAGE_ROLES);
    const closed = gateState(foldControlState([...r.base, r.c.everyone(EVERYONE_DEFAULT & ~GATE_BITS, { prev: r.everyone })], r.c.id, r.c.owner));
    expect(closed).toEqual({ on: true, roles: [] });
  });

  it("offers an existing Verified first when adopting, and never a Role with powers or one above the switcher", () => {
    const g = gated();
    const helpers = hexKey();
    const above = hexKey();
    const folded = foldControlState(
      [
        ...g.editions,
        g.c.role(helpers, "y", 0n, { name: "Helpers" }),
        g.c.role(above, "b", Permissions.KICK, { name: "Bouncers" }),
      ],
      g.c.id,
      g.c.owner,
    );
    expect(adoptableRoles(folded, g.c.owner).map((role) => role.name)).toEqual(["Verified", "Helpers"]);
    expect(adoptableRoles(folded, g.admin).map((role) => role.name)).toEqual(["Verified", "Helpers"]);
  });

  it("holds back joined members without posting, and lets the verified and the owner through", () => {
    const g = gated();
    const approved = hexKey();
    const waiting = hexKey();
    const folded = foldControlState([...g.editions, g.c.grant(approved, [g.verified])], g.c.id, g.c.owner);
    expect([...awaitingApproval(folded, joined(approved, waiting, g.c.owner))]).toEqual([waiting]);
  });

  it("lets Manage Roles above Verified approve, and nobody beneath it", () => {
    const g = gated();
    const folded = foldControlState(g.editions, g.c.id, g.c.owner);
    const [role] = gateState(folded).roles;
    expect(mayApprove(folded, g.c.owner, role)).toBe(true);
    expect(mayApprove(folded, g.admin, role)).toBe(true);
    expect(mayApprove(folded, hexKey(), role)).toBe(false);

    const weak = gated(GATE_BITS | Permissions.KICK);
    const weakFold = foldControlState(weak.editions, weak.c.id, weak.c.owner);
    expect(mayApprove(weakFold, weak.admin, gateState(weakFold).roles[0])).toBe(false);
    expect(maySwitchGate(weakFold, weak.admin)).toBe(false);
  });

  it("refuses to let a switcher whose own Roles can't post silence themselves", () => {
    const r = rankedCommunity(Permissions.MANAGE_ROLES);
    const folded = foldControlState(r.base, r.c.id, r.c.owner);
    expect(keepsPosting(folded, r.admin)).toBe(false);
    expect(keepsPosting(folded, r.c.owner)).toBe(true);
  });

  it("carries over recent posters and role holders, leaves the quiet waiting, and skips anyone already verified", () => {
    const g = gated();
    const folded = foldControlState([...g.editions], g.c.id, g.c.owner);
    const active = hexKey();
    const quiet = hexKey();
    const already = hexKey();
    const withVerified = foldControlState([...g.editions, g.c.grant(already, [g.verified])], g.c.id, g.c.owner);
    const observed = new Map([[active, NOW - DAY], [quiet, NOW - 60 * DAY], [already, NOW]]);

    const plan = carriedOver(withVerified, g.c.owner, [g.c.owner, active, quiet, already], observed, NOW - 30 * DAY, g.verified);
    expect(plan.grant).toEqual([active]);
    expect(plan.waiting).toBe(1);

    // The admin holds a Role that already posts, so nobody owes them Verified.
    expect(carriedOver(folded, g.c.owner, [g.admin], observed, 0, g.verified).grant).toEqual([]);
  });

  it("reports members the switcher doesn't outrank instead of granting them", () => {
    const g = gated(Permissions.MANAGE_ROLES);
    const peer = hexKey();
    const folded = foldControlState([...g.editions, g.c.grant(peer, [g.adminRole])], g.c.id, g.c.owner);
    const plan = carriedOver(folded, g.admin, [peer], new Map([[peer, NOW]]), 0, g.verified);
    expect(plan.unreachable).toEqual([peer]);
    expect(plan.grant).toEqual([]);
  });

  it("reads the welcome channel off @everyone's own overwrite allowing posts, and nothing else", () => {
    const g = gated();
    const welcome = hexKey();
    const plain = hexKey();
    const locked = hexKey();
    const channel = (eid: string) => g.c.edition({ vsk: "2", eid, author: g.c.owner, content: { name: eid.slice(0, 6), private: false } });
    const everyoneRule = (scope: string, allow: bigint, deny: bigint) => {
      const o = { scope, target: { kind: "everyone" as const }, allow, deny };
      return g.c.edition({ vsk: "14", eid: overwriteLocator(g.c.id, o), author: g.c.owner, content: overwriteToJSON(o) });
    };
    const folded = foldControlState(
      [
        ...g.editions,
        channel(welcome), channel(plain), channel(locked),
        everyoneRule(welcome, GATE_BITS, 0n),
        everyoneRule(locked, 0n, Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS | Permissions.CONNECT),
      ],
      g.c.id,
      g.c.owner,
    );
    expect(welcomeChannels(folded)).toEqual([welcome]);
  });

  it("doesn't offer a Role that lets its holders into a Private Channel as the way in", () => {
    const g = gated();
    const secret = hexKey();
    const members = hexKey();
    const o = { scope: secret, target: { kind: "role" as const, id: members }, allow: Permissions.VIEW_CHANNEL, deny: 0n };
    const folded = foldControlState(
      [
        ...g.editions,
        g.c.edition({ vsk: "2", eid: secret, author: g.c.owner, content: { name: "secret", private: true } }),
        g.c.role(members, "y", 0n, { name: "Members" }),
        g.c.edition({ vsk: "14", eid: overwriteLocator(g.c.id, o), author: g.c.owner, content: overwriteToJSON(o) }),
      ],
      g.c.id,
      g.c.owner,
    );
    expect(adoptableRoles(folded, g.c.owner).map((role) => role.name)).toEqual(["Verified"]);
  });

  it("can't be switched by an admin who lacks a bit @everyone holds, since @everyone's edit would be refused", () => {
    const r = rankedCommunity(Permissions.MANAGE_ROLES | (EVERYONE_DEFAULT & ~Permissions.VIDEO));
    expect(maySwitchGate(foldControlState(r.base, r.c.id, r.c.owner), r.admin)).toBe(false);
    const full = rankedCommunity(Permissions.MANAGE_ROLES | EVERYONE_DEFAULT);
    expect(maySwitchGate(foldControlState(full.base, full.c.id, full.c.owner), full.admin)).toBe(true);
  });

  it("counts a switcher who already holds the Role being adopted as still posting", () => {
    const r = rankedCommunity(Permissions.MANAGE_ROLES);
    const helpers = hexKey();
    const folded = foldControlState([...r.base, r.c.role(helpers, "m", 0n, { name: "Helpers" }), r.c.grant(r.admin, [r.adminRole, helpers], { prev: r.grant })], r.c.id, r.c.owner);
    expect(keepsPosting(folded, r.admin)).toBe(false);
    expect(keepsPosting(folded, r.admin, helpers)).toBe(true);
  });

  // Nothing beside the Roster says approval was turned on, so a Community that never let
  // @everyone post reads as gated, and every roleless member as awaiting approval.
  it.fails("doesn't report approval on for a read-only Community that never turned it on", () => {
    const r = rankedCommunity(Permissions.MANAGE_ROLES);
    const announcers = hexKey();
    const folded = foldControlState(
      [...r.base, r.c.everyone(EVERYONE_DEFAULT & ~Permissions.SEND_MESSAGES, { prev: r.everyone }), r.c.role(announcers, "m", Permissions.SEND_MESSAGES, { name: "Announcers" })],
      r.c.id,
      r.c.owner,
    );
    expect(gateState(folded).on).toBe(false);
  });
});
