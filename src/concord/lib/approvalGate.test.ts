import { describe, expect, it } from "vitest";

import {
  awaitingApproval,
  carriedOver,
  freeGateRoleId,
  GATE_BITS,
  gateRoleId,
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

/** A ranked Community with the gate on: Verified at rank "m", `@everyone` without posting. */
function gated(adminBits = Permissions.MANAGE_ROLES | GATE_BITS) {
  const r = rankedCommunity(adminBits);
  const verified = gateRoleId(r.c.idHex, 0);
  const everyone = r.c.everyone(EVERYONE_DEFAULT & ~GATE_BITS, { prev: r.everyone });
  const role = r.c.role(verified, "m", GATE_BITS, { name: "Verified" });
  return { ...r, verified, editions: [...r.base, everyone, role] };
}

describe("approval gate", () => {
  it("is off on a fresh Community, and on once @everyone loses posting to Verified", () => {
    const r = rankedCommunity(Permissions.MANAGE_ROLES);
    expect(gateState(foldControlState(r.base, r.c.id, r.c.owner), r.c.idHex).on).toBe(false);

    const g = gated();
    const state = gateState(foldControlState(g.editions, g.c.id, g.c.owner), g.c.idHex);
    expect(state.on).toBe(true);
    expect(state.role?.roleId).toBe(g.verified);
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
    const role = gateState(folded, g.c.idHex).role;
    expect(mayApprove(folded, g.c.owner, role)).toBe(true);
    expect(mayApprove(folded, g.admin, role)).toBe(true);
    expect(mayApprove(folded, hexKey(), role)).toBe(false);

    const weak = gated(GATE_BITS | Permissions.KICK);
    const weakFold = foldControlState(weak.editions, weak.c.id, weak.c.owner);
    expect(mayApprove(weakFold, weak.admin, gateState(weakFold, weak.c.idHex).role)).toBe(false);
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

  it("mints the next slot's id when a Verified Role was deleted", () => {
    const g = gated();
    const deleted = g.c.edition({ vsk: "13", eid: g.verified, prev: g.editions.at(-1), author: g.c.owner, content: { role_id: g.verified, rank: "m", deleted: true } });
    const folded = foldControlState([...g.editions, deleted], g.c.id, g.c.owner);
    expect(gateState(folded, g.c.idHex).role).toBeUndefined();
    expect(freeGateRoleId(folded, g.c.idHex)).toBe(gateRoleId(g.c.idHex, 1));
  });
});
