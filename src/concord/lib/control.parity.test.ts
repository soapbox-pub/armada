/**
 * Behavioral parity with Vector v0.5.0-3 and CORD-02/03/04 at concord#25 for the
 * Control fold around the vsk-13 Roster: the Banlist, Tenure seals, floors, and
 * Channel and Category editions. `it.fails` marks what Armada still gets wrong.
 */
import { describe, expect, it } from "vitest";

import { foldControlState, storedControlOf, type EntityHead } from "@/concord/lib/control";
import { channelsView, mintCommunity } from "@/concord/lib/community";
import { bytesToHex, hex32, inviteLinksLocator } from "@/concord/lib/derive";
import { VSK_INVITE_REGISTRY } from "@/concord/lib/kinds";
import type { ParsedEdition } from "@/concord/lib/edition";
import { Permissions, roleToJSON, rolesOf, tierMoves } from "@/concord/lib/roles";
import { eidHex, headFloor, hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

function floorsOf(...heads: ParsedEdition[]): Map<string, EntityHead> {
  return new Map(heads.map((h) => [eidHex(h), headFloor(h)]));
}

describe("the Banlist", () => {
  it("baseline: a moderator's ban stands while they hold BAN", () => {
    const { c, admin, base, grant } = rankedCommunity(Permissions.BAN | Permissions.MANAGE_ROLES);
    const target = hexKey();
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: admin, cite: grant, content: [target] });
    expect(foldControlState([...base, ban], c.id, c.owner).banned.has(target)).toBe(true);
  });

  it("keeps a demoted moderator's bans that their Tenure seals (CORD-04 §9; Vector `a_sealed_banlist_keeps_its_bans_after_its_editor_is_demoted`)", () => {
    const { c, admin, everyone, role, grant } = rankedCommunity(Permissions.BAN | Permissions.MANAGE_ROLES);
    const target = hexKey();
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: admin, cite: grant, content: [target] });
    // The owner demotes the moderator and seals what they decided.
    const tenure = c.edition({
      vsk: "16",
      eid: c.tenureEid(admin, c.owner),
      author: c.owner,
      content: { member: admin, sealed: [{ rank: "a", permissions: (Permissions.BAN | Permissions.MANAGE_ROLES).toString(), heads: [bytesToHex(ban.selfHash)] }] },
    });
    const strip = c.grant(admin, [], { prev: grant });
    const folded = foldControlState([everyone, role, grant, strip, tenure, ban], c.id, c.owner);
    expect(folded.roster.grants.find((g) => g.member === admin)).toBeUndefined();
    expect(folded.tenure?.get(admin)?.length).toBe(1);
    expect(folded.banned.has(target)).toBe(true);
  });

  it("refuses a Banlist edition whose array holds a non-string, rather than reading the strings (CORD-04 §4)", () => {
    const { c, base } = rankedCommunity(Permissions.BAN);
    const a = hexKey();
    const b = hexKey();
    const v1 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [a] });
    const v2 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, prev: v1, content: [b, 5] });
    const folded = foldControlState([...base, v1, v2], c.id, c.owner);
    expect([...folded.banned]).toEqual([a]);
  });

  it("keeps only the first 500 entries that stand (CORD-04 §4, Vector `MAX_BANLIST`)", () => {
    const { c, base } = rankedCommunity(Permissions.BAN);
    const list = Array.from({ length: 501 }, () => hexKey());
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: list });
    expect(foldControlState([...base, ban], c.id, c.owner).banned.size).toBe(500);
  });

  /** The owner's admin (rank "a") and a moderator (rank "m") holding BAN. */
  function withModerator() {
    const k = rankedCommunity(Permissions.BAN | Permissions.MANAGE_ROLES);
    const mod = hexKey();
    const modRole = hexKey();
    const role = k.c.role(modRole, "m", Permissions.BAN);
    const modGrant = k.c.grant(mod, [modRole]);
    return { ...k, mod, modGrant, base: [...k.base, role, modGrant] };
  }

  it("lets a newer head drop an entry its author doesn't outrank: removals aren't rank-checked (CORD-04 §2, Vector `fold_authority`)", () => {
    const { c, admin, mod, modGrant, base } = withModerator();
    const v1 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [admin] });
    const v2 = c.edition({ vsk: "4", eid: c.banlistHex(), author: mod, cite: modGrant, prev: v1, content: [] });
    expect(foldControlState([...base, v1], c.id, c.owner).banned.has(admin)).toBe(true);
    expect(foldControlState([...base, v1, v2], c.id, c.owner).banned.has(admin)).toBe(false);
  });

  it("counts entries that aren't keys toward the 500 cap, as serde reads them (Vector `parse_banlist_content`)", () => {
    const { c, base } = rankedCommunity(Permissions.BAN);
    const target = hexKey();
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [...Array.from({ length: 500 }, (_, i) => `junk${i}`), target] });
    const folded = foldControlState([...base, ban], c.id, c.owner);
    expect(folded.banned.has(target)).toBe(false);
    expect([...folded.banned].every((pk) => /^[0-9a-f]{64}$/.test(pk))).toBe(true);
  });

  it("refuses a Banlist whose JSON holds a lone surrogate, as serde does", () => {
    const { c, base } = rankedCommunity(Permissions.BAN);
    const a = hexKey();
    const v1 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [a] });
    const v2 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, prev: v1, content: `["${hexKey()}","\\ud800"]` });
    expect([...foldControlState([...base, v1, v2], c.id, c.owner).banned]).toEqual([a]);
  });

  it("refuses a Banlist edition by a member this reader holds banned (Vector `persisted_banned`)", () => {
    const { c, mod, modGrant, base } = withModerator();
    const v1 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [mod] });
    const held = foldControlState([...base, v1], c.id, c.owner);
    const v2 = c.edition({ vsk: "4", eid: c.banlistHex(), author: mod, cite: modGrant, prev: v1, content: [] });
    expect(foldControlState([...base, v1, v2], c.id, c.owner, floorsOf(...base, v1), undefined, storedControlOf(held)).banned.has(mod)).toBe(true);
  });

  it("keeps the Banlist head pass 1 chose when the ban takes away its author's support (Vector `banlist_head`)", () => {
    const { c, admin, grant, base } = withModerator();
    // The admin grants a second moderator BAN; the owner then bans the admin.
    const mod2 = hexKey();
    const modRole2 = hexKey();
    const role2 = c.role(modRole2, "z", Permissions.BAN);
    const grant2 = c.grant(mod2, [modRole2], { author: admin, cite: grant });
    const v1 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [admin] });
    const v2 = c.edition({ vsk: "4", eid: c.banlistHex(), author: mod2, cite: grant2, prev: v1, content: [admin, hexKey()] });
    const folded = foldControlState([...base, role2, grant2, v1, v2], c.id, c.owner);
    expect(folded.heads.get(c.banlistHex())?.version).toBe(2n);
  });

  it("keeps the held Banlist when its head is withheld (Vector retains `persisted_banned`)", () => {
    const { c, base } = rankedCommunity(Permissions.BAN);
    const target = hexKey();
    const v1 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [target] });
    const other = hexKey();
    const v2 = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, prev: v1, content: [target, other] });
    const held = foldControlState([...base, v1, v2], c.id, c.owner);
    // This reader settled on v2; a relay now serves only v1.
    const folded = foldControlState([...base, v1], c.id, c.owner, floorsOf(...base, v2), undefined, storedControlOf(held));
    expect([...folded.banned].sort()).toEqual([target, other].sort());
  });
});

describe("floors", () => {
  it("folds again when only a floor's hash, id, author or kind changed", () => {
    const { c, base, everyone } = rankedCommunity(Permissions.BAN);
    const floors = floorsOf(...base);
    const first = foldControlState(base, c.id, c.owner, floors);
    const moved = new Map(floors);
    moved.set(eidHex(everyone), { ...floors.get(eidHex(everyone))!, hash: new Uint8Array(32).fill(7), rumorId: hexKey() });
    expect(foldControlState(base, c.id, c.owner, moved)).not.toBe(first);
  });

  it("reports a step-down below a held head so the floor can be lowered (Vector `FoldedHead.rebased` → `rebase`)", () => {
    const { c, admin, everyone, role, grant } = rankedCommunity(Permissions.MANAGE_ROLES);
    const x = hexKey();
    const v1 = c.role(x, "m", 0n);
    const v2 = c.role(x, "m", Permissions.MANAGE_ROLES, { prev: v1, author: admin, cite: grant });
    const strip = c.grant(admin, [], { prev: grant });
    // Held: v2 of X. The admin's strip refuses it, so the fold steps down to v1.
    const folded = foldControlState([everyone, role, grant, strip, v1, v2], c.id, c.owner, floorsOf(everyone, role, strip, v2));
    const head = folded.heads.get(x) as (EntityHead & { rebased?: boolean }) | undefined;
    expect(head?.version).toBe(1n);
    // useControlFold only ever RAISES a floor (useControlPlane.ts:275-278); without a
    // signal it keeps v2, and once v2 stops being served X reads as nothing at all.
    const rebased = head?.rebased === true || (folded as { rebased?: Set<string> }).rebased?.has(x) === true;
    expect(rebased).toBe(true);
  });
});

describe("malformed editions that stand as the head (CORD-04 §1, CORD-03 §2, §4)", () => {
  it("lets a malformed Channel edition link and stand as the head, applying nothing", () => {
    const { c, admin, base, grant } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const v1 = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "general", private: false } });
    const v2 = c.edition({ vsk: "2", eid: ch, author: admin, cite: grant, prev: v1, content: { name: "", private: false } });
    const folded = foldControlState([...base, v1, v2], c.id, c.owner);
    expect(folded.channels.get(ch)?.name).toBe("general");
    expect(folded.heads.get(ch)?.version).toBe(2n);
  });

  it("lets a malformed Category edition link and stand as the head, applying nothing", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const cat = hexKey();
    const v1 = c.edition({ vsk: "15", eid: cat, author: c.owner, content: { name: "Text", position: "a" } });
    const v2 = c.edition({ vsk: "15", eid: cat, author: c.owner, prev: v1, content: "[]" });
    const folded = foldControlState([...base, v1, v2], c.id, c.owner);
    expect(folded.categories?.get(cat)?.name).toBe("Text");
    expect(folded.heads.get(cat)?.version).toBe(2n);
  });
});

describe("what the member list offers on the vsk-13 Roster", () => {
  it("offers the owner both stock tiers, minted as ranked Roles", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_ROLES);
    const folded = foldControlState(base, c.id, c.owner);
    expect(tierMoves(folded.roster, c.owner, c.owner, hexKey())).toEqual(["admin", "moderator"]);
  });

  it("offers a manager no tier whose template holds bits they lack", () => {
    const { c, admin, base } = rankedCommunity(Permissions.MANAGE_ROLES);
    const folded = foldControlState(base, c.id, c.owner);
    expect(tierMoves(folded.roster, admin, c.owner, hexKey())).toEqual([]);
  });
});

describe("ban marks outlive the fold window (Vector `merge_community_ban_marks`)", () => {
  it("keeps a Ban's time once its editions aged out, at the later time per member", () => {
    const c = new TestCommunity();
    const x = hexKey();
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [x] });
    const lifted = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [], prev: ban });
    const first = foldControlState([ban, lifted], c.id, c.owner);
    expect(first.bannedAt.get(x)).toBe(ban.createdAt);
    const kept = storedControlOf(first);
    expect(kept?.banMarks?.[x]).toBe(ban.createdAt);
    // A compaction left only the lift: the fold window no longer names X.
    const later = foldControlState([lifted], c.id, c.owner, undefined, undefined, kept);
    expect(later.banned.has(x)).toBe(false);
    expect(later.bannedAt.get(x)).toBe(ban.createdAt);
    // Merged to the later time, never dropped.
    expect(storedControlOf(later, { banMarks: { [x]: ban.createdAt + 100 } })?.banMarks?.[x]).toBe(ban.createdAt + 100);
  });
});

describe("the legacy Roster (Vector `select_authorized` judges both Rosters alike)", () => {
  const legacyRole = (c: TestCommunity, roleId: string, position: number, permissions: bigint, author = c.owner, cite?: ParsedEdition) =>
    c.edition({ vsk: "1", eid: roleId, author, cite, content: roleToJSON({ roleId, name: "r", position, permissions, scope: { kind: "server" }, color: 0 }) });

  it("seats no Grant to a banned member", () => {
    const c = new TestCommunity();
    const role = hexKey();
    const member = hexKey();
    const all = [legacyRole(c, role, 1, Permissions.MANAGE_ROLES | Permissions.BAN), c.grant(member, [role]), c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [member] })];
    const folded = foldControlState(all, c.id, c.owner);
    expect(folded.rankedRoster).toBeFalsy();
    expect(folded.banned.has(member)).toBe(true);
    expect(rolesOf(folded.roster, member)).toEqual([]);
  });

  /** A legacy admin: a Role at `position` holding `bits`, granted by the owner. */
  function withAdmin(position: number, bits: bigint) {
    const c = new TestCommunity();
    const role = hexKey();
    const admin = hexKey();
    const roleEd = legacyRole(c, role, position, bits);
    const grant = c.grant(admin, [role]);
    return { c, admin, base: [roleEd, grant], grant, role };
  }

  it("refuses a Role carrying a permission its author lacks", () => {
    const { c, admin, base, grant } = withAdmin(1, Permissions.MANAGE_ROLES);
    const escalated = hexKey();
    const folded = foldControlState([...base, legacyRole(c, escalated, 5, Permissions.BAN, admin, grant)], c.id, c.owner);
    expect(folded.roster.roles.some((r) => r.roleId === escalated)).toBe(false);
    const fair = hexKey();
    const ok = foldControlState([...base, legacyRole(c, fair, 5, Permissions.MANAGE_ROLES, admin, grant)], c.id, c.owner);
    expect(ok.roster.roles.some((r) => r.roleId === fair)).toBe(true);
  });

  it("takes Manage Roles only from a Role above what the edition touches", () => {
    const c = new TestCommunity();
    const [top, low, admin] = [hexKey(), hexKey(), hexKey()];
    const base = [legacyRole(c, top, 1, 0n), legacyRole(c, low, 3, Permissions.MANAGE_ROLES), c.grant(admin, [top, low])];
    const touched = hexKey();
    const folded = foldControlState([...base, legacyRole(c, touched, 2, 0n, admin, base[2])], c.id, c.owner);
    expect(folded.roster.roles.some((r) => r.roleId === touched)).toBe(false);
  });

  it("folds Vector's Categories and files a Channel under one, the Roster aside (Vector `apply_control_fold`)", () => {
    const c = new TestCommunity();
    const cat = hexKey();
    const ch = hexKey();
    const category = c.edition({ vsk: "15", eid: cat, author: c.owner, content: { name: "Voice", position: "a" } });
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "hangout", private: false, category: cat } });
    const folded = foldControlState([category, channel], c.id, c.owner);
    expect(folded.rankedRoster).toBeFalsy();
    expect(folded.categories?.get(cat)?.name).toBe("Voice");
    const community = { ...mintCommunity("Legacy", c.owner, ["wss://r"]).community, id: c.id, idHex: bytesToHex(c.id) };
    expect(channelsView(community, folded).find((v) => v.idHex === ch)).toMatchObject({ category: "Voice", categoryId: cat });
  });

  it("confers the Roles a Grant names that resolve, and refuses an uncited strip", () => {
    const { c, admin, base, grant } = withAdmin(1, Permissions.MANAGE_ROLES);
    const [mod, member, other] = [hexKey(), hexKey(), hexKey()];
    const modRole = legacyRole(c, mod, 4, 0n);
    const folded = foldControlState([...base, modRole, c.grant(member, [mod, hexKey()], { author: admin, cite: grant })], c.id, c.owner);
    expect(rolesOf(folded.roster, member).map((r) => r.roleId)).toEqual([mod]);
    const held = c.grant(other, [mod]);
    const strip = c.grant(other, [hexKey()], { author: admin, prev: held });
    const stripped = foldControlState([...base, modRole, held, strip], c.id, c.owner);
    expect(rolesOf(stripped.roster, other).map((r) => r.roleId), "an uncited strip names no published Role").toEqual([mod]);
  });
});

describe("invite registries (CORD-05 §5, Vector `live_invite_link_sets`)", () => {
  it("counts an uncited registry from a CREATE_INVITE holder", () => {
    const { c, admin, base, grant } = rankedCommunity(Permissions.CREATE_INVITE);
    const link = hexKey();
    const registry = (cite?: ParsedEdition) =>
      c.edition({ vsk: VSK_INVITE_REGISTRY, eid: bytesToHex(inviteLinksLocator(c.id, hex32(admin))), author: admin, cite, content: [link] });
    expect(foldControlState([...base, registry(grant)], c.id, c.owner).liveInviteLinks.has(link)).toBe(true);
    expect(foldControlState([...base, registry()], c.id, c.owner).liveInviteLinks.has(link)).toBe(true);
  });
});

describe("a read that misses the switch (Vector: a held `@everyone` floor keeps the Roster activated)", () => {
  it("stays on the vsk-13 Roster when the relays answering omit `@everyone`, once this reader held it", () => {
    const { c, role, grant, adminRole } = rankedCommunity(Permissions.MANAGE_ROLES);
    const held = foldControlState([role, grant], c.id, c.owner, undefined, undefined, { everyone: 0x203fe000n });
    expect(held.rankedRoster).toBe(true);
    expect(held.everyoneServed).toBe(false);
    expect(held.roster.roles.map((r) => r.roleId)).toEqual([adminRole]);
    expect(foldControlState([role, grant], c.id, c.owner).rankedRoster, "a reader that never held it can't tell").toBeFalsy();
  });
});
