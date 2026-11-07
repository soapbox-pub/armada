import { describe, expect, it } from "vitest";

import {
  adminRole,
  byDisplayOrder,
  canActOnMember,
  canActOnPosition,
  colorToHex,
  effectivePermissions,
  effectivePermissionsIn,
  hexToColor,
  isAuthorizedIn,
  moderatorRole,
  normalizeOrder,
  Permissions,
  projectReorder,
  roleFromJSON,
  roleToJSON,
  stockTierOf,
  tierMoves,
  type CommunityRoles,
  type Role,
} from "./roles";

const OWNER = "f".repeat(64);
const MOD = "a".repeat(64);
const CHANNEL = "1".repeat(64);
const OTHER_CHANNEL = "2".repeat(64);

const serverRole: Role = {
  roleId: "b".repeat(64),
  name: "Greeter",
  position: 5,
  permissions: Permissions.CREATE_INVITE,
  scope: { kind: "server" },
  color: 0,
};

const channelRole: Role = {
  roleId: "c".repeat(64),
  name: "Channel Mod",
  position: 4,
  permissions: Permissions.MANAGE_MESSAGES,
  scope: { kind: "channel", channelId: CHANNEL },
  color: 0,
};

const roster: CommunityRoles = {
  roles: [serverRole, channelRole],
  grants: [{ member: MOD, roleIds: [serverRole.roleId, channelRole.roleId] }],
};

describe("channel-scoped effective permissions (CORD-04 §2 scope)", () => {
  it("a channel-scoped role's bits count only inside its channel", () => {
    expect(effectivePermissionsIn(roster, MOD, CHANNEL)).toBe(
      Permissions.CREATE_INVITE | Permissions.MANAGE_MESSAGES,
    );
    expect(effectivePermissionsIn(roster, MOD, OTHER_CHANNEL)).toBe(Permissions.CREATE_INVITE);
  });

  it("server-scope roles count in every channel", () => {
    expect(effectivePermissionsIn(roster, MOD, OTHER_CHANNEL) & Permissions.CREATE_INVITE).toBe(
      Permissions.CREATE_INVITE,
    );
  });

  it("the scope-agnostic union is unchanged (the fold's view)", () => {
    expect(effectivePermissions(roster, MOD)).toBe(
      Permissions.CREATE_INVITE | Permissions.MANAGE_MESSAGES,
    );
  });

  it("isAuthorizedIn gates per channel; the owner is supreme everywhere", () => {
    expect(isAuthorizedIn(roster, MOD, OWNER, CHANNEL, Permissions.MANAGE_MESSAGES)).toBe(true);
    expect(isAuthorizedIn(roster, MOD, OWNER, OTHER_CHANNEL, Permissions.MANAGE_MESSAGES)).toBe(false);
    expect(isAuthorizedIn(roster, OWNER, OWNER, OTHER_CHANNEL, Permissions.MANAGE_MESSAGES)).toBe(true);
  });

  it("a roleless member holds nothing anywhere", () => {
    expect(effectivePermissionsIn(roster, "d".repeat(64), CHANNEL)).toBe(0n);
  });
});

describe("hoist flag wire format (Armada display extension)", () => {
  it("writes display only when true and round-trips it", () => {
    const plain = JSON.parse(roleToJSON(serverRole)) as Record<string, unknown>;
    expect("display" in plain).toBe(false);
    const hoisted = roleFromJSON(roleToJSON({ ...serverRole, display: true }));
    expect(hoisted?.display).toBe(true);
    // A non-boolean from a foreign writer reads as un-hoisted, never a throw.
    expect(roleFromJSON(JSON.stringify({ ...plain, display: "yes" }))?.display).toBeUndefined();
  });
});

describe("byDisplayOrder (CORD-04 §3 display rule)", () => {
  const role = (roleId: string, position: number): Role => ({
    roleId,
    name: roleId.slice(0, 4),
    position,
    permissions: 0n,
    scope: { kind: "server" },
    color: 0,
  });

  it("orders by position, lower first (lower position = higher authority)", () => {
    const sorted = [role("cc".repeat(32), 5), role("aa".repeat(32), 1)].sort(byDisplayOrder);
    expect(sorted.map((r) => r.position)).toEqual([1, 5]);
  });

  it("breaks a tie by the LOWER role_id, so every client renders one order", () => {
    // CORD-04 §3: "Two Roles MAY share a position — they are peers ... and a
    // display list breaks the tie by the lower role_id". Without it the order
    // is fold-insertion order, which differs per client and makes an
    // index-based reorder act on an arbitrary pair.
    const bb = role("bb".repeat(32), 2);
    const aa = role("aa".repeat(32), 2);
    expect([bb, aa].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([aa.roleId, bb.roleId]);
    expect([aa, bb].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([aa.roleId, bb.roleId]);
  });

  it("is a total order: sorting is stable whatever the input order", () => {
    const roles = [role("dd".repeat(32), 2), role("aa".repeat(32), 2), role("cc".repeat(32), 1)];
    const forward = [...roles].sort(byDisplayOrder).map((r) => r.roleId);
    const backward = [...roles].reverse().sort(byDisplayOrder).map((r) => r.roleId);
    expect(forward).toEqual(backward);
  });
});

// ── Reorder algebra and colour ───────────────────────────────────────────────

const R_OWNER = "0".repeat(64);
const R_ADMIN = "a".repeat(64);
const R_MOD = "b".repeat(64);
const R_PLAIN = "c".repeat(64);

const mkRole = (roleId: string, position: number, permissions: bigint, color = 0): Role => ({
  roleId,
  name: `r${position}`,
  position,
  permissions,
  scope: { kind: "server" },
  color,
});

describe("projectReorder", () => {
  const A = mkRole("a".repeat(64), 3, 0n);
  const B = mkRole("b".repeat(64), 3, 0n);
  const C = mkRole("c".repeat(64), 5, 0n);
  const current = [A, B, C]; // already in byDisplayOrder order

  it("reuses the existing positions rather than renumbering 1..N", () => {
    // Renumbering would claim position 1, which an actor ranked at 1 may not
    // write; the multiset {3,3,5} is reassigned in the requested order instead.
    const { landing } = projectReorder(current, [A, C, B]);
    expect(landing.map((r) => r.position)).toEqual([3, 3, 5]);
  });

  it("renders a satisfiable move exactly as requested", () => {
    const { rendered } = projectReorder(current, [A, C, B]);
    expect(rendered.map((r) => r.roleId)).toEqual([A.roleId, C.roleId, B.roleId]);
  });

  it("reports that a drop across an equal-position pair does NOT land there", () => {
    // Drag C to the top of A(3) B(3) C(5). C takes 3 and B takes 5, both legal
    // publishes, but the §3 tie-break renders A, C, B — C never reaches the
    // top, so this must be caught before anything is published.
    const { landing, rendered } = projectReorder(current, [C, A, B]);
    expect(landing.map((r) => [r.roleId, r.position])).toEqual([
      [C.roleId, 3],
      [A.roleId, 3],
      [B.roleId, 5],
    ]);
    expect(rendered.map((r) => r.roleId)).toEqual([A.roleId, C.roleId, B.roleId]);
    expect(rendered.map((r) => r.roleId)).not.toEqual([C.roleId, A.roleId, B.roleId]);
  });

  it("reports a peer-only shuffle as unsatisfiable too", () => {
    // Swapping two peers changes no position at all: the wire is identical.
    const { landing, rendered } = projectReorder(current, [B, A, C]);
    expect(landing.every((r, i) => r.position === current[i].position)).toBe(true);
    expect(rendered.map((r) => r.roleId)).toEqual([A.roleId, B.roleId, C.roleId]);
  });

  it("leaves the input arrays untouched", () => {
    projectReorder(current, [C, A, B]);
    expect(current.map((r) => r.position)).toEqual([3, 3, 5]);
    expect(C.position).toBe(5);
  });
});

describe("normalizeOrder", () => {
  const A = mkRole("a".repeat(64), 3, 0n);
  const B = mkRole("b".repeat(64), 3, 0n);
  const C = mkRole("c".repeat(64), 5, 0n);

  it("escapes the all-tied roster, which has no reachable order at all", () => {
    // Every role on one position: projectReorder is the identity for every
    // permutation, and RoleEditor has no position control — the dead end.
    const tied = [mkRole("a".repeat(64), 4, 0n), mkRole("b".repeat(64), 4, 0n), mkRole("c".repeat(64), 4, 0n)];
    const plan = normalizeOrder([tied[2], tied[0], tied[1]], 1)!;
    expect(plan.map((r) => r.position)).toEqual([4, 5, 6]);
    // And the requested order now actually renders.
    expect([...plan].sort(byDisplayOrder).map((r) => r.roleId)).toEqual(plan.map((r) => r.roleId));
  });

  it("makes the refused C-to-the-top drag reachable", () => {
    // C could not lead because the only free position tied with A.
    const plan = normalizeOrder([C, A, B], 1)!;
    expect(plan.map((r) => [r.roleId, r.position])).toEqual([
      [C.roleId, 3],
      [A.roleId, 4],
      [B.roleId, 5],
    ]);
    expect([...plan].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([C.roleId, A.roleId, B.roleId]);
  });

  it("never claims a position at or above the actor's own rank", () => {
    // Actor ranked 5, so the floor is 6 (§3: no edition claims a position at or
    // above its own signer). The roster sits below the floor in authority.
    const [x, y, z] = [mkRole("a".repeat(64), 8, 0n), mkRole("b".repeat(64), 8, 0n), mkRole("c".repeat(64), 9, 0n)];
    const plan = normalizeOrder([z, x, y], 6)!;
    expect(plan.map((r) => r.position)).toEqual([8, 9, 10]);
    expect(plan.every((r) => r.position >= 6)).toBe(true);
  });

  it("leaves roles the actor cannot rewrite alone, at the front", () => {
    const boss = mkRole("0".repeat(63) + "1", 2, 0n); // above an actor ranked 3
    const lo = [mkRole("a".repeat(64), 5, 0n), mkRole("b".repeat(64), 5, 0n), mkRole("c".repeat(64), 7, 0n)];
    const plan = normalizeOrder([boss, lo[2], lo[0], lo[1]], 4)!;
    expect(plan[0]).toEqual(boss); // untouched, position and all
    expect(plan.slice(1).map((r) => r.position)).toEqual([5, 6, 7]);
  });

  it("refuses to overtake a role the actor cannot rewrite", () => {
    const boss = mkRole("0".repeat(63) + "1", 2, 0n);
    const lo = mkRole("c".repeat(64), 7, 0n);
    // Leading means writing a position below 4, which this actor may not claim
    // — a rank refusal, not something evening out can fix.
    expect(normalizeOrder([lo, boss], 4)).toBeNull();
  });

  it("plans for a non-owner on a spread roster, rewriting only below their rank", () => {
    // A(2) B(5) C(5), actor ranked 2 so the floor is 3. Their own role A leads
    // and is left alone; only B's position changes, and it changes to a
    // position they outrank. A caller that gates the WHOLE plan on "may I
    // rewrite this position?" refuses this — A sits at exactly their rank —
    // so the gate belongs on the entries that actually change.
    const a = mkRole("a".repeat(64), 2, 0n);
    const b = mkRole("b".repeat(64), 5, 0n);
    const c = mkRole("c".repeat(64), 5, 0n);
    const next = [a, c, b];
    const plan = normalizeOrder(next, 3)!;
    expect(plan.map((r) => [r.roleId, r.position])).toEqual([
      [a.roleId, 2],
      [c.roleId, 5],
      [b.roleId, 6],
    ]);
    const changed = plan.filter((r, i) => r.position !== next[i].position);
    expect(changed.map((r) => r.roleId)).toEqual([b.roleId]);
    // Every rewrite is strictly below the actor in authority, at both ends.
    expect(changed.every((r) => r.position >= 3)).toBe(true);
    expect(changed.every((r) => next[plan.indexOf(r)].position >= 3)).toBe(true);
    expect([...plan].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([a.roleId, c.roleId, b.roleId]);
  });

  it("gives up when the actor may rewrite nothing in the roster", () => {
    // Every role outranks this actor, so there is no escape to offer — the
    // caller must say that rather than showing a button that cannot work.
    const above = [mkRole("a".repeat(64), 9, 0n), mkRole("b".repeat(64), 9, 0n)];
    expect(normalizeOrder(above, 12)).toBeNull();
  });

  it("does not mutate its input", () => {
    normalizeOrder([C, A, B], 1);
    expect([A.position, B.position, C.position]).toEqual([3, 3, 5]);
  });
});

describe("color <-> u32 (CORD-04 §2)", () => {
  it("round-trips a packed RGB value", () => {
    expect(hexToColor("#ff8800")).toBe(0xff8800);
    expect(colorToHex(0xff8800)).toBe("#ff8800");
  });

  it("pads a value whose high bytes are zero", () => {
    expect(colorToHex(0x0000ff)).toBe("#0000ff");
  });

  it("treats 0 as theme default, not black", () => {
    expect(colorToHex(0)).toBeUndefined();
    expect(hexToColor("#000000")).toBe(0);
  });

  it("rejects junk as theme default", () => {
    expect(hexToColor("nonsense")).toBe(0);
    expect(hexToColor("#ff88")).toBe(0);
  });

  it("survives the wire round-trip", () => {
    const r = mkRole("a".repeat(64), 2, Permissions.KICK, hexToColor("#3ba55d"));
    const back = roleFromJSON(roleToJSON(r));
    expect(back?.color).toBe(0x3ba55d);
    expect(colorToHex(back!.color)).toBe("#3ba55d");
  });

  it("refuses a Role whose wire colour isn't a u32 (serde, as Vector)", () => {
    const wire = (color: unknown) =>
      JSON.stringify({
        role_id: "a".repeat(64),
        name: "r",
        position: 2,
        permissions: "0",
        scope: { kind: "server" },
        color,
      });
    expect(roleFromJSON(wire(0xff0000))?.color).toBe(0xff0000);
    expect(roleFromJSON(wire(1.5))).toBeUndefined();
    expect(roleFromJSON(wire(-1))).toBeUndefined();
    expect(roleFromJSON(wire(0x1_0000_0000))).toBeUndefined();
    expect(roleFromJSON(wire("#ff0000"))).toBeUndefined();
  });

  it("does not write a malformed colour back onto the wire", () => {
    const bad = { ...mkRole("a".repeat(64), 2, 0n), color: -5 };
    expect(JSON.parse(roleToJSON(bad)).color).toBe(0);
    expect(JSON.parse(roleToJSON({ ...bad, color: 2.7 })).color).toBe(2);
  });

  it("carries a foreign u32 through serialization untouched", () => {
    // The spec field is a u32. Merely reading and rewriting a role — which the
    // reorder path does to every role it moves — must not eat a high byte
    // another client put there.
    expect(roleFromJSON(roleToJSON({ ...mkRole("a".repeat(64), 2, 0n), color: 0xff123456 }))?.color).toBe(
      0xff123456,
    );
  });

  it("narrows a foreign u32 to 24-bit RGB once the picker edits it", () => {
    // The colour picker only speaks #RRGGBB, so this is the one place the high
    // byte is lost, and only on an explicit edit. Asserted so the asymmetry
    // with the round-trip above is deliberate rather than an accident.
    const shown = colorToHex(0xff123456);
    expect(shown).toBe("#123456");
    expect(hexToColor(shown!)).toBe(0x123456);
  });

  it("drops a field neither CORD-04 nor the display extension models", () => {
    // `display` is modelled (the Armada hoist extension); `hoist` is not, and a
    // Role round-trips with unmodelled fields erased — the reason a client
    // cannot invent, say, a `deleted` flag on a Role.
    const wire = JSON.parse(
      roleToJSON({ ...mkRole("a".repeat(64), 2, 0n), hoist: true } as Role & { hoist: boolean }),
    );
    expect(wire).not.toHaveProperty("hoist");
  });
});

describe("grant authority (CORD-04 §3 strict outrank)", () => {
  const grantRoster: CommunityRoles = {
    roles: [
      mkRole("1".repeat(64), 1, Permissions.MANAGE_ROLES),
      mkRole("2".repeat(64), 2, Permissions.MANAGE_ROLES | Permissions.KICK),
      mkRole("3".repeat(64), 3, 0n),
    ],
    grants: [
      { member: R_ADMIN, roleIds: ["1".repeat(64)] },
      { member: R_MOD, roleIds: ["2".repeat(64)] },
      { member: R_PLAIN, roleIds: ["3".repeat(64)] },
    ],
  };

  it("lets an admin act on a lower-ranked member", () => {
    expect(canActOnMember(grantRoster, R_ADMIN, R_OWNER, R_MOD, Permissions.MANAGE_ROLES)).toBe(true);
  });

  it("refuses equal-rank action", () => {
    const peers: CommunityRoles = {
      roles: [mkRole("1".repeat(64), 2, Permissions.MANAGE_ROLES)],
      grants: [
        { member: R_ADMIN, roleIds: ["1".repeat(64)] },
        { member: R_MOD, roleIds: ["1".repeat(64)] },
      ],
    };
    expect(canActOnMember(peers, R_ADMIN, R_OWNER, R_MOD, Permissions.MANAGE_ROLES)).toBe(false);
  });

  it("never lets anyone act on the owner", () => {
    expect(canActOnMember(grantRoster, R_ADMIN, R_OWNER, R_OWNER, Permissions.MANAGE_ROLES)).toBe(false);
  });

  it("refuses a member without MANAGE_ROLES even when they outrank", () => {
    const noBit: CommunityRoles = {
      roles: [mkRole("1".repeat(64), 1, Permissions.KICK), mkRole("3".repeat(64), 3, 0n)],
      grants: [
        { member: R_ADMIN, roleIds: ["1".repeat(64)] },
        { member: R_PLAIN, roleIds: ["3".repeat(64)] },
      ],
    };
    expect(canActOnMember(noBit, R_ADMIN, R_OWNER, R_PLAIN, Permissions.MANAGE_ROLES)).toBe(false);
  });

  it("blocks granting a role at or above the actor's own rank", () => {
    // The moderator sits at position 2 and may not hand out position 1 or 2.
    expect(canActOnPosition(grantRoster, R_MOD, R_OWNER, 1, Permissions.MANAGE_ROLES)).toBe(false);
    expect(canActOnPosition(grantRoster, R_MOD, R_OWNER, 2, Permissions.MANAGE_ROLES)).toBe(false);
    expect(canActOnPosition(grantRoster, R_MOD, R_OWNER, 3, Permissions.MANAGE_ROLES)).toBe(true);
  });

  it("lets the owner act on anything", () => {
    expect(canActOnMember(grantRoster, R_OWNER, R_OWNER, R_ADMIN, Permissions.MANAGE_ROLES)).toBe(true);
    expect(canActOnPosition(grantRoster, R_OWNER, R_OWNER, 1, Permissions.MANAGE_ROLES)).toBe(true);
  });
});

describe("tierMoves (stock Admin/Moderator)", () => {
  const admin = adminRole("1".repeat(64));
  const mod = moderatorRole("2".repeat(64));
  const tiered: CommunityRoles = {
    roles: [admin, mod],
    grants: [
      { member: R_ADMIN, roleIds: [admin.roleId] },
      { member: R_MOD, roleIds: [mod.roleId] },
    ],
  };

  it("offers the owner every promotion of a roleless member, even before the roles exist", () => {
    expect(tierMoves(tiered, R_OWNER, R_OWNER, R_PLAIN)).toEqual(["admin", "moderator"]);
    expect(tierMoves({ roles: [], grants: [] }, R_OWNER, R_OWNER, R_PLAIN)).toEqual(["admin", "moderator"]);
  });

  it("offers demotion and removal of an admin to the owner", () => {
    expect(stockTierOf(tiered, R_ADMIN)).toBe("admin");
    expect(tierMoves(tiered, R_OWNER, R_OWNER, R_ADMIN)).toEqual(["moderator", null]);
  });

  it("lets an admin make or unmake moderators but never admins", () => {
    expect(tierMoves(tiered, R_ADMIN, R_OWNER, R_PLAIN)).toEqual(["moderator"]);
    expect(tierMoves(tiered, R_ADMIN, R_OWNER, R_MOD)).toEqual([null]);
  });

  it("offers nothing against the owner, a peer, or without MANAGE_ROLES", () => {
    expect(tierMoves(tiered, R_ADMIN, R_OWNER, R_OWNER)).toEqual([]);
    expect(tierMoves(tiered, R_MOD, R_OWNER, R_PLAIN)).toEqual([]);
    expect(tierMoves(tiered, R_PLAIN, R_OWNER, R_MOD)).toEqual([]);
  });
});
