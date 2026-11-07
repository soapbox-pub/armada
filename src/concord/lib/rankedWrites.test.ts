import { describe, expect, it } from "vitest";

import { planChannelDuty, type MintingRotation } from "@/concord/lib/accessDuty";
import { foldControlState, type FoldedControl } from "@/concord/lib/control";
import { channelsView } from "@/concord/lib/community";
import { myLocator } from "@/concord/lib/rekey";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { parseEdition, type ParsedEdition } from "@/concord/lib/edition";
import {
  carryForward,
  categoryOrder,
  planActivation,
  planCreateCategory,
  planCreateRole,
  planDeleteCategory,
  planDeleteRole,
  planEditRole,
  planMoveCategory,
  planMemberRoles,
  planMoveRole,
  planOverwrite,
  planRenameCategory,
  planReorder,
  planRoleSave,
  planSetEveryone,
  planSync,
  rankedOrder,
} from "@/concord/lib/rankedWrites";
import { EVERYONE_DEFAULT, Permissions, roleToJSON, type Role } from "@/concord/lib/roles";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { eidHex, headFloor, heldCommunity, hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

const parsed = (r: NostrRumor): ParsedEdition =>
  parseEdition({ rumorId: r.id, author: r.pubkey, kind: r.kind, content: r.content, tags: r.tags, ms: r.created_at * 1000, createdAt: r.created_at } as OpenedEvent);

/** The fold a reader holds once `rumors` land on top of `held`. */
function after(c: TestCommunity, held: ParsedEdition[], rumors: NostrRumor[]): { folded: FoldedControl; all: ParsedEdition[] } {
  const all = [...held, ...rumors.map(parsed)];
  return { folded: foldControlState(all, c.id, c.owner), all };
}

const MANAGER = Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS | EVERYONE_DEFAULT;

function setup(adminBits = MANAGER) {
  const s = rankedCommunity(adminBits);
  const general = random32();
  const channel = s.c.edition({ vsk: "2", eid: general, author: s.c.owner, content: { name: "general", private: false } });
  const base = [...s.base, channel];
  return { ...s, base, general: bytesToHex(general), folded: foldControlState(base, s.c.id, s.c.owner) };
}

describe("ranked Role writers (Vector create/edit/move/delete_role_v2)", () => {
  it("a created Role lands at the bottom, and readers keep it", () => {
    const { c, base, folded } = setup();
    const { roleId, rumor } = planCreateRole(folded, c.id, c.owner, { name: " Helpers ", color: 0x123456, permissions: Permissions.KICK });
    const next = after(c, base, [rumor]).folded;
    const order = rankedOrder(next);
    expect(order.at(-1)?.roleId).toBe(roleId);
    expect(order.at(-1)?.name).toBe("Helpers");
    expect(order.at(-1)?.permissions).toBe(Permissions.KICK);
  });

  it("an admin can't mint a Role holding a bit they lack", () => {
    const { c, admin, folded } = setup();
    expect(() => planCreateRole(folded, c.id, admin, { name: "x", color: 0, permissions: Permissions.BAN })).toThrow();
  });

  it("an admin's Role stands for readers when it holds only bits they hold", () => {
    const { c, admin, grant, base, folded } = setup();
    const { roleId, rumor } = planCreateRole(folded, c.id, admin, { name: "x", color: 0, permissions: Permissions.SEND_MESSAGES }, { entityId: grant.entityId, version: grant.version, editionHash: grant.selfHash });
    expect(after(c, base, [rumor]).folded.roster.roles.some((r) => r.roleId === roleId)).toBe(true);
  });

  it("an edit keeps the rank and says when it takes bits away", () => {
    const { c, adminRole, base, folded } = setup();
    const before = folded.roster.roles.find((r) => r.roleId === adminRole)!;
    const plan = planEditRole(folded, c.id, c.owner, adminRole, { name: "Staff", color: 7, permissions: Permissions.MANAGE_ROLES, display: true, mentionable: true });
    expect(plan.reduces).toBe(true);
    const role = after(c, base, [plan.rumor]).folded.roster.roles.find((r) => r.roleId === adminRole)!;
    expect(role.rank).toBe(before.rank);
    expect(role.name).toBe("Staff");
    expect(role.mentionable).toBe(true);
    expect(role.display).toBe(true);
  });

  it("an admin can't edit their own Role", () => {
    const { c, admin, adminRole, folded } = setup();
    expect(() => planEditRole(folded, c.id, admin, adminRole, { name: "x", color: 0, permissions: MANAGER, display: false, mentionable: false })).toThrow();
  });

  it("a move reorders, and re-signs the Grants it would orphan", () => {
    const { c, admin, grant, base, folded } = setup();
    const cite = { entityId: grant.entityId, version: grant.version, editionHash: grant.selfHash };
    const made = planCreateRole(folded, c.id, admin, { name: "mods", color: 0, permissions: Permissions.SEND_MESSAGES }, cite);
    let state = after(c, base, [made.rumor]);
    const member = hexKey();
    const mGrant = c.grant(member, [made.roleId], { author: admin, cite: grant });
    state = { all: [...state.all, mGrant], folded: foldControlState([...state.all, mGrant], c.id, c.owner) };
    expect(state.folded.roster.grants.find((g) => g.member === member)?.roleIds).toEqual([made.roleId]);

    const plan = planMoveRole(state.folded, c.id, c.owner, made.roleId, 0);
    expect(plan.lowers).toBe(false);
    expect(plan.resign.map((g) => g.member)).toEqual([member]);
    const moved = after(c, state.all, [plan.rumor]);
    expect(rankedOrder(moved.folded)[0].roleId).toBe(made.roleId);
    expect(moved.folded.roster.grants.find((g) => g.member === member)?.roleIds ?? []).toEqual([]);
    const resigned = c.grant(member, plan.resign[0].roleIds, { prev: mGrant });
    const kept = foldControlState([...moved.all, resigned], c.id, c.owner);
    expect(kept.roster.grants.find((g) => g.member === member)?.roleIds).toEqual([made.roleId]);
  });

  for (const [label, want] of [
    ["one Role to the top", [2, 0, 1]],
    ["a full reversal", [2, 1, 0]],
    ["the bottom two swapped", [0, 2, 1]],
  ] as const) {
    it(`a reorder of ${label} lands in order, each move judged on the one before (Vector reorder_roles_v2)`, () => {
      const { c, base, folded } = setup();
      let state = { folded, all: base };
      const ids: string[] = [];
      for (const name of ["x", "y", "z"]) {
        const made = planCreateRole(state.folded, c.id, c.owner, { name, color: 0, permissions: 0n });
        state = after(c, state.all, [made.rumor]);
        ids.push(made.roleId);
      }
      const top = rankedOrder(state.folded)[0].roleId;
      const ordered = [top, ...want.map((i) => ids[i])];
      const moves = planReorder(state.folded, ordered);
      let view = state.folded;
      const rumors: NostrRumor[] = [];
      for (const m of moves) {
        const plan = planMoveRole(view, c.id, c.owner, m.roleId, m.index);
        rumors.push(plan.rumor);
        view = carryForward(view, [plan.rumor], { roleId: m.roleId, rank: plan.rank });
      }
      expect(rankedOrder(view).map((r) => r.roleId)).toEqual(ordered);
      expect(rankedOrder(after(c, state.all, rumors).folded).map((r) => r.roleId)).toEqual(ordered);
      expect(moves.length).toBe(label === "a full reversal" ? 2 : 1);
    });
  }

  it("an admin can't move a Role above their own", () => {
    const { c, admin, grant, base, folded } = setup();
    const cite = { entityId: grant.entityId, version: grant.version, editionHash: grant.selfHash };
    const made = planCreateRole(folded, c.id, admin, { name: "mods", color: 0, permissions: 0n }, cite);
    const state = after(c, base, [made.rumor]).folded;
    expect(() => planMoveRole(state, c.id, admin, made.roleId, 0, cite)).toThrow();
  });

  it("a deleted Role leaves the Roster and its holders", () => {
    const { c, admin, adminRole, base, folded } = setup();
    const plan = planDeleteRole(folded, c.id, c.owner, adminRole);
    expect(plan.holders).toEqual([admin]);
    const next = after(c, base, [plan.rumor]).folded;
    expect(next.roster.roles.some((r) => r.roleId === adminRole)).toBe(false);
  });

  it("@everyone takes what the owner sets", () => {
    const { c, base, folded } = setup();
    const next = after(c, base, [planSetEveryone(folded, c.id, c.owner, Permissions.VIEW_CHANNEL)]).folded;
    expect(next.roster.everyone).toBe(Permissions.VIEW_CHANNEL);
  });
});

describe("Channel rules (Vector set_overwrite, set_channel_sync)", () => {
  it("an overwrite stands for readers, and clearing it removes it", () => {
    const { c, adminRole, general, base, folded } = setup();
    const set = planOverwrite(folded, c.id, c.owner, new Set(), general, { kind: "role", id: adminRole }, 0n, Permissions.SEND_MESSAGES);
    const one = after(c, base, [set]);
    expect(one.folded.roster.overwrites?.find((o) => o.scope === general)?.deny).toBe(Permissions.SEND_MESSAGES);
    const clear = planOverwrite(one.folded, c.id, c.owner, new Set(), general, { kind: "role", id: adminRole }, 0n, 0n);
    expect(after(c, one.all, [clear]).folded.roster.overwrites?.some((o) => o.scope === general) ?? false).toBe(false);
  });

  it("refuses a non-channel bit, and an admin's rule on their own Role", () => {
    const { c, admin, adminRole, general, folded } = setup();
    expect(() => planOverwrite(folded, c.id, c.owner, new Set(), general, { kind: "everyone" }, Permissions.BAN, 0n)).toThrow();
    expect(() => planOverwrite(folded, c.id, admin, new Set(), general, { kind: "role", id: adminRole }, 0n, Permissions.SEND_MESSAGES)).toThrow();
  });

  it("refuses a private Channel this device can't key", () => {
    const s = rankedCommunity(MANAGER);
    const secret = random32();
    const ch = s.c.edition({ vsk: "2", eid: secret, author: s.c.owner, content: { name: "x", private: true } });
    const folded = foldControlState([...s.base, ch], s.c.id, s.c.owner);
    expect(() => planOverwrite(folded, s.c.id, s.c.owner, new Set(), bytesToHex(secret), { kind: "everyone" }, Permissions.VIEW_CHANNEL, 0n)).toThrow();
  });

  it("a sync files the Channel under its Category's rules", () => {
    const { c, general, base, folded } = setup();
    const cat = planCreateCategory(folded, c.id, c.owner, "Text");
    const one = after(c, base, [cat.rumor]);
    const sync = planSync(one.folded, c.id, c.owner, new Set(), general, cat.idHex);
    expect(after(c, one.all, [sync]).folded.roster.syncs?.[general]).toBe(cat.idHex);
  });
});

describe("Categories (Vector create/rename/move/delete_category)", () => {
  it("create, rename, reorder and delete", () => {
    const { c, base, folded } = setup();
    const a = planCreateCategory(folded, c.id, c.owner, "Alpha");
    let state = after(c, base, [a.rumor]);
    const b = planCreateCategory(state.folded, c.id, c.owner, "Beta");
    state = after(c, state.all, [b.rumor]);
    expect(categoryOrder(state.folded).map((k) => k.name)).toEqual(["Alpha", "Beta"]);

    state = after(c, state.all, planMoveCategory(state.folded, c.id, c.owner, b.idHex, 0));
    expect(categoryOrder(state.folded).map((k) => k.name)).toEqual(["Beta", "Alpha"]);

    state = after(c, state.all, [planRenameCategory(state.folded, c.id, c.owner, a.idHex, "Gamma")]);
    expect(categoryOrder(state.folded).map((k) => k.name)).toEqual(["Beta", "Gamma"]);

    state = after(c, state.all, [planDeleteCategory(state.folded, c.id, c.owner, b.idHex)]);
    expect(categoryOrder(state.folded).map((k) => k.name)).toEqual(["Gamma"]);
  });

  it("needs Manage channels", () => {
    const { c, folded } = setup(Permissions.MANAGE_ROLES);
    const member = hexKey();
    expect(() => planCreateCategory(folded, c.id, member, "x")).toThrow();
  });
});

describe("the switch to ranked roles (Vector activate_roles_v2)", () => {
  it("carries each legacy Role across, peers kept peers, and lists the standing Channels", () => {
    const c = new TestCommunity();
    const [r1, r2, r3, access] = [hexKey(), hexKey(), hexKey(), hexKey()];
    const secret = bytesToHex(random32());
    const legacy = [
      c.edition({ vsk: "1", eid: r1, author: c.owner, content: roleToJSON({ roleId: r1, name: "Admin", position: 1, permissions: Permissions.MANAGE_ROLES | Permissions.BAN, scope: { kind: "server" }, color: 0 }) }),
      c.edition({ vsk: "1", eid: r2, author: c.owner, content: roleToJSON({ roleId: r2, name: "Mod", position: 2, permissions: Permissions.KICK, scope: { kind: "server" }, color: 0 }) }),
      c.edition({ vsk: "1", eid: r3, author: c.owner, content: roleToJSON({ roleId: r3, name: "Mod2", position: 2, permissions: Permissions.KICK, scope: { kind: "server" }, color: 0 }) }),
      c.edition({ vsk: "1", eid: access, author: c.owner, content: roleToJSON({ roleId: access, name: "secret", position: 3, permissions: 0n, scope: { kind: "channel", channelId: secret }, color: 0 }) }),
      c.edition({ vsk: "2", eid: secret, author: c.owner, content: { name: "secret", private: true } }),
    ];
    const folded = foldControlState(legacy, c.id, c.owner);
    expect(folded.rankedRoster).toBeFalsy();
    expect(() => planActivation(folded, c.id, hexKey())).toThrow();

    const plan = planActivation(folded, c.id, c.owner);
    expect(plan.unfiled).toEqual([secret]);
    const next = after(c, legacy, plan.rumors).folded;
    expect(next.rankedRoster).toBe(true);
    expect(next.roster.everyone).toBe(EVERYONE_DEFAULT);
    expect(next.roster.legacyChannels).toEqual([secret]);
    const byId = new Map(next.roster.roles.map((r) => [r.roleId, r]));
    expect(byId.get(r2)?.rank).toBe(byId.get(r3)?.rank);
    expect(byId.get(r1)!.rank! < byId.get(r2)!.rank!).toBe(true);
    expect(byId.get(r1)?.display).toBe(true);
    expect(byId.get(r1)!.permissions & EVERYONE_DEFAULT).toBe(EVERYONE_DEFAULT);
    expect(next.roster.overwrites?.find((o) => o.scope === secret && o.target.kind === "role")?.allow).toBe(Permissions.VIEW_CHANNEL);
  });
});

describe("keys follow a rule change (CORD-03 §5, Vector `settle_access`, done by the access duty)", () => {
  /** A private Channel the owner holds at epoch 1, and a member the Roster names nowhere. */
  function privateChannel() {
    const s = rankedCommunity(MANAGER);
    const secret = random32();
    const ch = s.c.edition({ vsk: "2", eid: secret, author: s.c.owner, content: { name: "x", private: true } });
    const all = [...s.base, ch];
    return { ...s, all, folded: foldControlState(all, s.c.id, s.c.owner), secret: bytesToHex(secret), member: hexKey() };
  }
  const duty = (folded: FoldedControl, me: string, ch: string, candidates: string[], minted: MintingRotation[] = []) =>
    planChannelDuty({ control: folded, me, channelIdHex: ch, epoch: 1n, candidates, deliveries: [], minted, prior: [] });

  it("a member a rule lets in is owed the key", () => {
    const { c, all, folded, secret, member } = privateChannel();
    expect(duty(folded, c.owner, secret, [member])).toBeUndefined();
    const rule = planOverwrite(folded, c.id, c.owner, new Set([secret]), secret, { kind: "member", id: member }, Permissions.VIEW_CHANNEL, 0n);
    expect(duty(after(c, all, [rule]).folded, c.owner, secret, [member])?.deliver).toEqual([member]);
  });

  it("a holder a rule shuts out is rotated away", () => {
    const { c, all, folded, secret, member } = privateChannel();
    const allow = after(c, all, [planOverwrite(folded, c.id, c.owner, new Set([secret]), secret, { kind: "member", id: member }, Permissions.VIEW_CHANNEL, 0n)]);
    const deny = after(c, allow.all, [planOverwrite(allow.folded, c.id, c.owner, new Set([secret]), secret, { kind: "member", id: member }, 0n, Permissions.VIEW_CHANNEL)]);
    const carried: MintingRotation[] = [{ rotator: c.owner, blobs: [{ locator: myLocator(c.owner, member, secret, 1n), wrapped: "" }] }];
    expect(duty(deny.folded, c.owner, secret, [member], carried)?.cut).toEqual([member]);
  });

  it("settling a change rotates away a holder it shut out, with no evidence of how they got the key", () => {
    // A Direct Invite leaves no trace on the access plane or in a rotation, so only the
    // change itself says they held it (Vector `settle_access`: `was && !now`).
    const { c, all, folded, secret, member } = privateChannel();
    const allow = after(c, all, [planOverwrite(folded, c.id, c.owner, new Set([secret]), secret, { kind: "member", id: member }, Permissions.VIEW_CHANNEL, 0n)]);
    const deny = after(c, allow.all, [planOverwrite(allow.folded, c.id, c.owner, new Set([secret]), secret, { kind: "member", id: member }, 0n, Permissions.VIEW_CHANNEL)]);
    const settle = (me: string) =>
      planChannelDuty({ control: deny.folded, me, channelIdHex: secret, epoch: 1n, candidates: [member], deliveries: [], minted: [], prior: [], settledFrom: allow.folded });
    expect(settle(c.owner)?.cut).toEqual([member]);
    expect(duty(deny.folded, c.owner, secret, [member]), "a periodic pass still needs evidence").toBeUndefined();
  });

  it("carries Armada's sidebar across as Categories and rank keys, and drops the old fields", () => {
    const c = new TestCommunity();
    const key = { id: random32(), key: random32(), epoch: 0n, name: "p" };
    const meta = (name: string, position: number, category?: string, extra: object = {}) => ({
      name,
      private: false,
      custom: { "armada.order": { position }, ...(category ? { "armada.category": { name: category } } : {}), ...extra },
      ...extra,
    });
    const ids = { a: random32(), b: random32(), c: random32(), d: random32() };
    const editions = [
      c.edition({ vsk: "2", eid: ids.a, author: c.owner, content: meta("a", 2) }),
      c.edition({ vsk: "2", eid: ids.b, author: c.owner, content: { ...meta("b", 0, "Voice"), custom: { "armada.order": { position: 0 }, "armada.category": { name: "Voice" }, "armada.git": { repositories: [] } } } }),
      c.edition({ vsk: "2", eid: ids.c, author: c.owner, content: meta("c", 1, "Text") }),
      c.edition({ vsk: "2", eid: ids.d, author: c.owner, content: meta("d", 3, "voice") }),
      c.edition({ vsk: "2", eid: key.id, author: c.owner, content: { ...meta("p", 4, "Text"), private: true } }),
    ];
    const folded = foldControlState(editions, c.id, c.owner);
    const plan = planActivation(folded, c.id, c.owner, EVERYONE_DEFAULT, [key]);
    expect(plan.unfiled).toEqual([]);
    const next = after(c, editions, plan.rumors).folded;
    const view = channelsView(heldCommunity(c, [key]), next);
    expect(view.map((ch) => [ch.name, ch.category])).toEqual([["a", undefined], ["b", "Voice"], ["d", "Voice"], ["c", "Text"], ["p", "Text"]]);
    for (const ch of next.channels.values()) {
      const custom = ch.metadata.custom as Record<string, unknown> | undefined;
      expect(custom?.["armada.category"]).toBeUndefined();
      expect(custom?.["armada.order"]).toBeUndefined();
    }
    expect((next.channels.get(bytesToHex(ids.b))!.metadata.custom as Record<string, unknown>)["armada.git"]).toEqual({ repositories: [] });
    expect(next.channels.get(bytesToHex(key.id))!.sealed).toBeDefined();
  });
});

describe("a ranked write on a read that lost `@everyone` (Vector `require_activated`)", () => {
  it("is refused while the fold holds only the stored bits, and goes ahead once the head is served", () => {
    const { c, everyone, role, grant, admin } = rankedCommunity(MANAGER);
    const floors = new Map([[eidHex(everyone), { ...headFloor(everyone), vsk: "13" }]]);
    const withheld = foldControlState([role, grant], c.id, c.owner, floors, undefined, { everyone: EVERYONE_DEFAULT });
    expect(withheld.rankedRoster).toBe(true);
    expect(withheld.roster.everyone, "the stored bits stand in").toBe(EVERYONE_DEFAULT);
    expect(() => planCreateRole(withheld, c.id, admin, { name: "x", color: 0, permissions: 0n })).toThrow(/couldn't be read/);
    const served = foldControlState([everyone, role, grant], c.id, c.owner, floors);
    expect(() => planCreateRole(served, c.id, admin, { name: "x", color: 0, permissions: 0n })).not.toThrow();
  });
});

describe("legacy Role and Grant writers (Vector `create_role`, `edit_role`, `reorder_roles`, `set_member_roles`)", () => {
  const OWNER = hexKey();
  const [ADMIN, MEMBER] = [hexKey(), hexKey()];
  const role = (roleId: string, position: number, permissions = 0n, scope: Role["scope"] = { kind: "server" }): Role => ({ roleId, name: "r", position, permissions, scope, color: 0 });
  const [TOP, LOW, MOD, BIG] = [hexKey(), hexKey(), hexKey(), hexKey()];
  const fold = (o: { roles?: Role[]; grants?: Array<{ member: string; roleIds: string[] }>; banned?: string[]; unserved?: string[] } = {}) =>
    ({
      ownerHex: OWNER,
      banned: new Set(o.banned ?? []),
      roster: {
        roles: o.roles ?? [role(TOP, 1, Permissions.MANAGE_ROLES | Permissions.KICK), role(MOD, 4, Permissions.KICK), role(BIG, 2, Permissions.BAN)],
        grants: o.grants ?? [{ member: ADMIN, roleIds: [TOP] }],
      },
      heads: new Map((o.unserved ?? []).map((eid) => [eid, { version: 1n, hash: new Uint8Array(32) }])),
      headEditions: new Map(),
      channels: new Map(),
    }) as unknown as FoldedControl;

  it("creates a Role beneath everything but the access band, and refuses a nameless one or bits its author lacks", () => {
    const f = fold();
    expect(planRoleSave(f, ADMIN, { ...role(hexKey(), 2), name: "Helpers" }).position).toBe(5);
    expect(() => planRoleSave(f, ADMIN, { ...role(hexKey(), 5), name: "  " })).toThrow(/needs a name/);
    expect(() => planRoleSave(f, ADMIN, { ...role(hexKey(), 5, Permissions.BAN), name: "x" })).toThrow(/don't hold/);
    const full = fold({ roles: Array.from({ length: 100 }, (_, i) => role(hexKey(), i + 1)) });
    expect(() => planRoleSave(full, OWNER, { ...role(hexKey(), 101), name: "x" })).toThrow(/at most/);
  });

  it("edits only Roles beneath its author, within what they hold, and never moves a Role's channel", () => {
    const f = fold();
    expect(planRoleSave(f, ADMIN, { ...role(MOD, 4, Permissions.KICK | Permissions.MANAGE_ROLES), name: "Mods" }).name).toBe("Mods");
    expect(() => planRoleSave(f, ADMIN, { ...role(TOP, 1), name: "Me" })).toThrow(/beneath your own/);
    expect(() => planRoleSave(f, ADMIN, { ...role(MOD, 4, Permissions.BAN), name: "Mods" })).toThrow(/don't hold/);
    expect(() => planRoleSave(f, ADMIN, { ...role(MOD, 4, 0n, { kind: "channel", channelId: hexKey() }), name: "Mods" })).toThrow(/channel can't be changed/);
    expect(() => planRoleSave(fold({ unserved: [MOD] }), ADMIN, { ...role(MOD, 4), name: "Mods" })).toThrow(/couldn't be fetched/);
  });

  it("moves a Role only within its author's reach, carrying bits they hold", () => {
    const f = fold();
    expect(planRoleSave(f, ADMIN, { ...role(MOD, 3, Permissions.KICK), name: "r" }).position).toBe(3);
    expect(() => planRoleSave(f, ADMIN, { ...role(MOD, 1, Permissions.KICK), name: "r" })).toThrow(/beneath your own/);
    expect(() => planRoleSave(f, ADMIN, { ...role(BIG, 5, Permissions.BAN), name: "r" })).toThrow(/don't hold/);
  });

  it("refuses a banned author, and one without Manage Roles", () => {
    expect(() => planRoleSave(fold({ banned: [ADMIN] }), ADMIN, { ...role(MOD, 4), name: "r" })).toThrow(/banned/);
    expect(() => planRoleSave(fold({ grants: [] }), ADMIN, { ...role(MOD, 4), name: "r" })).toThrow(/Manage roles/);
  });

  it("sets a member's Roles on Manage Roles held above the member and each Role it adds", () => {
    const cid = random32();
    const f = fold({ grants: [{ member: ADMIN, roleIds: [TOP] }, { member: MEMBER, roleIds: [MOD] }] });
    expect(planMemberRoles(f, cid, ADMIN, MEMBER, [MOD, MOD.toUpperCase()])).toEqual([MOD]);
    expect(() => planMemberRoles(f, cid, ADMIN, MEMBER, [MOD, TOP])).toThrow(/beneath your own/);
    expect(() => planMemberRoles(f, cid, ADMIN, MEMBER, [hexKey()])).toThrow(/No such role/);
    expect(() => planMemberRoles(f, cid, OWNER, OWNER, [MOD])).toThrow(/owner's standing/);
    expect(() => planMemberRoles(f, cid, ADMIN, ADMIN, [])).toThrow(/members beneath you/);
  });

  it("takes Manage Roles only from Roles above the member, not from any Role held", () => {
    const cid = random32();
    // A bit-less Role at 1 and Manage Roles at 5: nothing above a member at 3 lets the author in.
    const f = fold({ roles: [role(TOP, 1), role(LOW, 5, Permissions.MANAGE_ROLES), role(MOD, 3)], grants: [{ member: ADMIN, roleIds: [TOP, LOW] }, { member: MEMBER, roleIds: [MOD] }] });
    expect(() => planMemberRoles(f, cid, ADMIN, MEMBER, [])).toThrow(/members beneath you/);
  });

  it("carries a held Role this device can't resolve, and caps a member at 64 Roles", () => {
    const cid = random32();
    const unknown = hexKey();
    const f = fold({ grants: [{ member: ADMIN, roleIds: [TOP] }, { member: MEMBER, roleIds: [MOD, unknown] }] });
    expect(planMemberRoles(f, cid, ADMIN, MEMBER, [])).toEqual([unknown]);
    const many = Array.from({ length: 65 }, () => role(hexKey(), 9));
    const big = fold({ roles: [...many, role(TOP, 1, Permissions.MANAGE_ROLES)] });
    expect(() => planMemberRoles(big, cid, ADMIN, MEMBER, many.map((r) => r.roleId))).toThrow(/at most 64/);
  });
});
