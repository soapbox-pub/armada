/**
 * Behavioral parity with Vector v0.5.0-3 (`fold_authority` / `select_authorized`,
 * `roles.rs`) and CORD-04 at concord#25, for the vsk-13 Roster fold. Each case is
 * a divergence the review of the ranked-roles PR found; `it.fails` marks the ones
 * Armada still gets wrong, so fixing one turns its case red until it's flipped.
 */
import { describe, expect, it, vi } from "vitest";

import { foldControlState, type EntityHead } from "@/concord/lib/control";
import { EVERYONE_DEFAULT, Permissions, grantFromJSON, roleFromJSON } from "@/concord/lib/roles";
import { AUTHORITY_VSKS, foldRankedRoster, parseEveryone, rankedRoleToJSON, tenureToJSON, parseOverwrite, parseRankedRole, parseSync, parseTenure } from "@/concord/lib/roster";
import { hex32 } from "@/concord/lib/derive";
import { TestCommunity, eidHex, headFloor, hexKey } from "@/test/concordEditions";

const ADMIN_BITS = Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS | Permissions.BAN;

/** Owner, `@everyone`, an admin Role granted to `admin`. */
function ranked() {
  const c = new TestCommunity();
  const admin = hexKey();
  const adminRole = hexKey();
  const everyone = c.everyone(EVERYONE_DEFAULT);
  const role = c.role(adminRole, "a", ADMIN_BITS);
  const grant = c.grant(admin, [adminRole]);
  return { c, admin, adminRole, everyone, role, grant };
}

function floorsOf(...heads: Parameters<typeof headFloor>[0][]): Map<string, EntityHead> {
  return new Map(heads.map((h) => [eidHex(h), headFloor(h)]));
}

describe("Roster fold: what a relay withholds", () => {
  it("baseline: with everything served, the admin's Role X and @everyone stand", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const x = hexKey();
    const roleX = c.role(x, "m", Permissions.MANAGE_CHANNELS, { author: admin, cite: grant });
    const folded = foldRankedRoster([everyone, role, grant, roleX], c.id, c.owner, floorsOf(everyone, role, grant, roleX));
    expect(folded.roles.roles.map((r) => r.roleId)).toContain(x);
    expect(folded.roles.everyone).toBe(EVERYONE_DEFAULT);
  });

  it("carries a held Role its signer's rank can't be judged for while another tracked head is withheld (Vector `complete`, CORD-04 §1)", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const x = hexKey();
    const roleX = c.role(x, "m", Permissions.MANAGE_CHANNELS, { author: admin, cite: grant });
    // This reader settled on the admin's Grant and on Role X, and stored them; the Grant is now withheld.
    const floors = floorsOf(everyone, role, grant, roleX);
    const folded = foldRankedRoster([everyone, role, roleX], c.id, c.owner, floors, new Set(), { roleIds: [eidHex(role), x], grantees: [admin] });
    // Vector: not `complete`, so the held head is Carried rather than refused.
    expect(folded.roles.roles.map((r) => r.roleId)).toContain(x);
  });

  it("judges the fold whole when the only withheld head is one it doesn't track (Vector `complete_of`)", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const x = hexKey();
    const roleX = c.role(x, "m", Permissions.MANAGE_CHANNELS, { author: admin, cite: grant });
    // Nothing served or stored names the Grant, so its withheld floor doesn't make the fold partial.
    const floors = floorsOf(everyone, role, grant, roleX);
    expect(foldRankedRoster([everyone, role, roleX], c.id, c.owner, floors).complete).toBe(true);
    expect(foldRankedRoster([everyone, role, roleX], c.id, c.owner, floors, new Set(), { grantees: [admin] }).complete).toBe(false);
  });

  it("tracks the Tenure of a member whose only floored head is an overwrite or a sync (Vector `FLOOR_AUTHORITY`)", () => {
    for (const vsk of ["14", "17"]) {
      const { c, admin, everyone, role, grant } = ranked();
      const tenure = c.edition({ vsk: "16", eid: c.tenureEid(admin, c.owner), author: c.owner, content: tenureToJSON(admin, [{ rank: "a", permissions: ADMIN_BITS, heads: [hexKey()] }]) });
      const typed = (p: Parameters<typeof headFloor>[0]) => [eidHex(p), { ...headFloor(p), vsk: p.vsk }] as const;
      // The admin's own head on this reader's floors is an overwrite (or sync) of theirs, and the owner's Tenure of them is withheld.
      const floors = new Map<string, EntityHead>([
        ...[everyone, role, grant, tenure].map(typed),
        [hexKey(), { version: 1n, hash: hex32(hexKey()), rumorId: hexKey(), author: admin, vsk }],
      ]);
      expect(foldRankedRoster([everyone, role, grant], c.id, c.owner, floors).complete, vsk).toBe(false);
    }
  });

  it("an overwrite's floor floors no Channel at its coordinate, and a Channel's no overwrite (Vector `floor_family`)", () => {
    expect(AUTHORITY_VSKS.has("14")).toBe(true);
    expect(AUTHORITY_VSKS.has("17")).toBe(true);
    expect(AUTHORITY_VSKS.has("2")).toBe(false);
  });

  it("keeps @everyone's bits when its held head is withheld (Vector `authorized.everyone = stored.everyone`)", () => {
    const { c, role, grant } = ranked();
    const v1 = c.everyone(EVERYONE_DEFAULT);
    const v2 = c.everyone(EVERYONE_DEFAULT | Permissions.CREATE_INVITE, { prev: v1 });
    const floors = floorsOf(v2, role, grant);
    // The reader's last fold held v2's bits.
    const folded = foldRankedRoster([v1, role, grant], c.id, c.owner, floors, new Set(), { everyone: EVERYONE_DEFAULT | Permissions.CREATE_INVITE });
    expect(folded.roles.everyone).toBe(EVERYONE_DEFAULT | Permissions.CREATE_INVITE);
  });

  it("keeps the legacy Channel list it held when the switching edition stops being served (CORD-04 §2)", () => {
    const c = new TestCommunity();
    const l1 = hexKey();
    const l2 = hexKey();
    const v1 = c.everyone(EVERYONE_DEFAULT, { legacy: [l1] });
    const v2 = c.everyone(EVERYONE_DEFAULT, { legacy: [l2], prev: v1 });
    expect(foldRankedRoster([v1, v2], c.id, c.owner, new Map()).roles.legacyChannels).toEqual([l1]);
    // After a compaction only the head is served.
    const first = foldRankedRoster([v1, v2], c.id, c.owner, new Map());
    const later = foldRankedRoster([v2], c.id, c.owner, floorsOf(v2), new Set(), { legacyChannels: first.roles.legacyChannels });
    expect(later.roles.legacyChannels).toEqual([l1]);
  });

  it("takes the switch's list from the lowest owner @everyone that PARSES (Vector filters to Everyone candidates)", () => {
    const c = new TestCommunity();
    const l1 = hexKey();
    const l2 = hexKey();
    const junk = c.edition({ vsk: "13", eid: c.everyoneHex, author: c.owner, content: { permissions: "x" } });
    const v1 = c.everyone(EVERYONE_DEFAULT, { legacy: [l1] });
    const v2 = c.everyone(EVERYONE_DEFAULT, { legacy: [l2], prev: v1 });
    expect(foldRankedRoster([junk, v1, v2], c.id, c.owner, new Map()).roles.legacyChannels).toEqual([l1]);
  });

  it("flags a withheld held head as a gap even when a newer edition above it is served (Vector `gapped |= !held_served`)", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const x = hexKey();
    const v1 = c.role(x, "m", 0n);
    const v2 = c.role(x, "m", Permissions.SEND_MESSAGES, { prev: v1 });
    const v3 = c.role(x, "m", Permissions.BAN, { prev: v2, author: admin, cite: grant });
    const floors = floorsOf(everyone, role, grant, v2);
    const folded = foldControlState([everyone, role, grant, v1, v3], c.id, c.owner, floors);
    expect(folded.incomplete).toContain(x);
  });

  it("keeps a Grant's floor when a Channel edition squats its coordinate (Vector floors by family; CORD-03 §2 `taken_by`)", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const squat = c.edition({ vsk: "2", eid: eidHex(grant), version: 5n, author: admin, cite: grant, content: { name: "squat", private: false } });
    const first = foldControlState([everyone, role, grant, squat], c.id, c.owner);
    expect(first.channels.has(eidHex(grant)), "a Channel aimed at a Grant is no Channel").toBe(false);
    expect(first.heads.get(eidHex(grant))?.version).toBe(1n);
    const next = foldControlState([everyone, role, grant, squat], c.id, c.owner, first.heads);
    expect(next.roster.grants.find((g) => g.member === admin)?.roleIds).toEqual([eidHex(role)]);
  });
});

describe("Roster fold: bans", () => {
  it("baseline: unbanned, the owner's v3 on top of the admin's v2 stands", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const x = hexKey();
    const v1 = c.role(x, "m", 0n);
    const v2 = c.role(x, "m", Permissions.MANAGE_CHANNELS, { prev: v1, author: admin, cite: grant });
    const v3 = c.role(x, "m", Permissions.ADD_REACTIONS, { prev: v2 });
    const folded = foldControlState([everyone, role, grant, v1, v2, v3], c.id, c.owner, floorsOf(everyone, role, grant, v1));
    expect(folded.roster.roles.find((r) => r.roleId === x)?.permissions).toBe(Permissions.ADD_REACTIONS);
  });

  it("still links a banned admin's edition into the chain an owner edition builds on (Vector keeps it as a refused candidate)", () => {
    const { c, admin, everyone, role, grant } = ranked();
    const x = hexKey();
    const v1 = c.role(x, "m", 0n);
    const v2 = c.role(x, "m", Permissions.MANAGE_CHANNELS, { prev: v1, author: admin, cite: grant });
    const v3 = c.role(x, "m", Permissions.ADD_REACTIONS, { prev: v2 });
    const ban = c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [admin] });
    const folded = foldControlState([everyone, role, grant, v1, v2, v3, ban], c.id, c.owner, floorsOf(everyone, role, grant, v1));
    expect(folded.banned.has(admin)).toBe(true);
    expect(folded.roster.roles.find((r) => r.roleId === x)?.permissions).toBe(Permissions.ADD_REACTIONS);
  });
});

describe("Roster content parsing, against serde", () => {
  const role = (fields: string) => `{"role_id":"${"ab".repeat(32)}","rank":"m",${fields}}`;

  it("reads permissions sent as a JSON integer past 2^53 (CORD-04 §3: 'a JSON integer in that range')", () => {
    const r = parseRankedRole(role(`"permissions":1152921504606846976`));
    expect(r?.kind === "live" && r.role.permissions).toBe(1n << 60n);
  });

  it("refuses permissions written as a float (serde u64 rejects `1.0` and `1e3`)", () => {
    expect(parseRankedRole(role(`"permissions":1.0`))).toBeUndefined();
    expect(parseRankedRole(role(`"permissions":1e3`))).toBeUndefined();
  });

  it("reads a null optional field as absent (serde `Option`)", () => {
    expect(parseRankedRole(role(`"name":null,"color":null,"display":null,"mentionable":null,"deleted":null`))?.kind).toBe("live");
  });

  it("refuses a deletion whose other fields break their type (serde parses the whole struct first)", () => {
    expect(parseRankedRole(role(`"deleted":true,"color":-1`))).toBeUndefined();
    expect(parseRankedRole(role(`"deleted":true,"permissions":"x"`))).toBeUndefined();
    expect(parseRankedRole(`{"role_id":"${"ab".repeat(32)}","rank":5,"deleted":true}`)).toBeUndefined();
  });

  it("refuses a float colour (serde u32)", () => {
    expect(parseRankedRole(role(`"color":1.0`))).toBeUndefined();
  });

  it("refuses a lone surrogate in a string field (serde_json rejects it)", () => {
    expect(parseRankedRole(role(`"name":"\\ud800"`))).toBeUndefined();
  });

  it("refuses a Grant whose role_ids holds a non-string (serde `Vec<Text>`)", () => {
    expect(grantFromJSON(`{"member":"${"ab".repeat(32)}","role_ids":["${"cd".repeat(32)}",5]}`)).toBeUndefined();
  });

  it("refuses a Grant whose role_ids isn't an array, rather than reading a strip", () => {
    expect(grantFromJSON(`{"member":"${"ab".repeat(32)}","role_ids":"${"cd".repeat(32)}"}`)).toBeUndefined();
    expect(grantFromJSON(`{"member":"${"ab".repeat(32)}","role_ids":null}`)).toBeUndefined();
  });

  it("refuses a Grant whose control_wrap isn't a string (CORD-04 §2)", () => {
    expect(grantFromJSON(`{"member":"${"ab".repeat(32)}","role_ids":[],"control_wrap":5}`)).toBeUndefined();
  });

  it("refuses a Grant that repeats a field (Vector `duplicate_field`)", () => {
    expect(grantFromJSON(`{"member":"${"ab".repeat(32)}","member":"${"cd".repeat(32)}","role_ids":[]}`)).toBeUndefined();
    expect(grantFromJSON(`{"member":"${"ab".repeat(32)}","role_ids":[],"role_ids":[]}`)).toBeUndefined();
  });

  const legacy = (fields: string) => `{"role_id":"${"ab".repeat(32)}","position":3,"permissions":"1",${fields}}`;

  it("cuts a legacy Role's name past 64 bytes rather than refusing it (Vector `cut_name`)", () => {
    expect(roleFromJSON(legacy(`"name":"${"x".repeat(70)}","scope":{"kind":"server"}`))?.name).toBe("x".repeat(64));
  });

  it("refuses a legacy Role missing name or scope (serde requires both)", () => {
    expect(roleFromJSON(legacy(`"scope":{"kind":"server"}`))).toBeUndefined();
    expect(roleFromJSON(legacy(`"name":"r"`))).toBeUndefined();
  });

  it("refuses a legacy Role's float or negative permissions (serde u64)", () => {
    const base = `{"role_id":"${"ab".repeat(32)}","position":3,"name":"r","scope":{"kind":"server"}`;
    expect(roleFromJSON(`${base},"permissions":-1}`)).toBeUndefined();
    expect(roleFromJSON(`${base},"permissions":1.5}`)).toBeUndefined();
  });

  it("reads @everyone's `legacy: null` as absent (serde `Option`)", () => {
    expect(parseEveryone(`{"permissions":"1","legacy":null}`)).toEqual({ permissions: 1n });
  });

  it("refuses @everyone whose legacy list holds a non-string (serde `BTreeSet<String>`)", () => {
    expect(parseEveryone(`{"permissions":"1","legacy":["${"ab".repeat(32)}",5]}`)).toBeUndefined();
  });

  it("refuses a Role whose permissions are present as null (Vector `perm_decimal_string_opt` takes no null)", () => {
    expect(parseRankedRole(role(`"permissions":null`))).toBeUndefined();
  });

  it("keeps the first 256 legacy ids in the order serde's BTreeSet holds them, before lowercasing (Vector `parse_everyone_content`)", () => {
    const ids = Array.from({ length: 256 }, (_, i) => "a" + i.toString(16).padStart(63, "0"));
    // Upper case sorts before lower case, so Vector keeps this one and drops the last `a…`.
    const legacy = parseEveryone(JSON.stringify({ permissions: "0", legacy: [...ids, "F".repeat(64)] }))?.legacy;
    expect(legacy).toHaveLength(256);
    expect(legacy).toContain("f".repeat(64));
    expect(legacy).not.toContain(ids[255]);
  });

  it("refuses a Tenure entry that repeats a field (Vector `TenureEntry` `duplicate_field`)", () => {
    expect(parseTenure(`{"member":"${"ab".repeat(32)}","sealed":[{"rank":"a","rank":"b","permissions":"1"}]}`)).toBeUndefined();
  });

  const overwrite = (target: string) => `{"scope":"${"cd".repeat(32)}","target":${target},"allow":"1","deny":"0"}`;

  it("refuses an overwrite whose target repeats a field (Vector `OverwriteTarget` `duplicate_field`)", () => {
    expect(parseOverwrite(overwrite(`{"kind":"role","kind":"member","id":"${"ab".repeat(32)}"}`))).toBeUndefined();
    expect(parseOverwrite(overwrite(`{"kind":"role","id":"${"ab".repeat(32)}","id":"${"cd".repeat(32)}"}`))).toBeUndefined();
  });

  it("reads an @everyone overwrite target carrying `id: null` (serde reads a unit variant's null content)", () => {
    expect(parseOverwrite(overwrite(`{"kind":"everyone","id":null}`))?.target).toEqual({ kind: "everyone" });
  });

  it("refuses a sync that repeats a field (Vector `SyncContent` `duplicate_field`)", () => {
    const [ch, cat] = ["cd".repeat(32), "ab".repeat(32)];
    expect(parseSync(`{"channel":"${ch}","sync":"${cat}","sync":"${cat}"}`)).toBeUndefined();
    expect(parseSync(`{"channel":"${ch}","channel":"${ch}"}`)).toBeUndefined();
  });

  it("refuses a sync whose `sync` is neither a string nor null, and reads null or a non-hex string as none (Vector `SyncContent`)", () => {
    const ch = "cd".repeat(32);
    for (const v of ["5", "true", "{}", "[]"]) expect(parseSync(`{"channel":"${ch}","sync":${v}}`)).toBeUndefined();
    expect(parseSync(`{"channel":"${ch}","sync":null}`)).toEqual({ channel: ch });
    expect(parseSync(`{"channel":"${ch}","sync":"xyz"}`)).toEqual({ channel: ch });
  });

  it("refuses a sync holding a lone surrogate (serde_json rejects it)", () => {
    expect(parseSync(`{"channel":"${"cd".repeat(32)}","x":"\\ud800"}`)).toBeUndefined();
  });
});

describe("Roster content parsing, at serde_json's edges", () => {
  const role = (fields: string) => `{"role_id":"${"ab".repeat(32)}","rank":"m",${fields}}`;
  const nested = (n: number) => role(`"x":${"[".repeat(n)}${"]".repeat(n)}`);

  it("refuses `-0` as an integer (serde_json reads it as a float)", () => {
    expect(parseRankedRole(role(`"permissions":-0`))).toBeUndefined();
  });

  it("takes 127 levels of nesting and refuses 128 (serde_json's recursion limit)", () => {
    expect(parseRankedRole(nested(126))?.kind).toBe("live");
    expect(parseRankedRole(nested(127))).toBeUndefined();
  });
});

describe("Roster content parsing, on an engine without JSON.parse source text", () => {
  // iOS 15-18.3 and older Android WebViews: the reviver gets no `context.source`.
  function withoutSource<T>(f: () => T): T {
    const original = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: (this: unknown, k: string, v: unknown) => unknown) =>
      original(text, reviver ? function (this: unknown, k: string, v: unknown) { return reviver.call(this, k, v); } : undefined),
    );
    try {
      return f();
    } finally {
      spy.mockRestore();
    }
  }
  const role = (fields: string) => `{"role_id":"${"ab".repeat(32)}","rank":"m",${fields}}`;

  it("still refuses permissions written as a float (serde u64)", () => {
    withoutSource(() => {
      expect(parseRankedRole(role(`"permissions":1.0`))).toBeUndefined();
      expect(parseRankedRole(role(`"permissions":1e3`))).toBeUndefined();
      expect(parseRankedRole(role(`"color":1.0`))).toBeUndefined();
    });
  });

  it("still reads permissions sent as a JSON integer past 2^53 (CORD-04 §3)", () => {
    withoutSource(() => {
      const r = parseRankedRole(role(`"permissions":9007199254740993`));
      expect(r?.kind === "live" && r.role.permissions).toBe(9007199254740993n);
      expect(parseEveryone(`{"permissions":18446744073709551615}`)?.permissions).toBe(18446744073709551615n);
    });
  });
});

describe("Roster fold: what the stored fold supplies", () => {
  it("takes the stored legacy list when the served switch carries none (Vector `switched.or(stored.legacy_channels)`)", () => {
    const c = new TestCommunity();
    const l1 = hexKey();
    const v1 = c.everyone(EVERYONE_DEFAULT);
    const folded = foldRankedRoster([v1], c.id, c.owner, floorsOf(v1), new Set(), { legacyChannels: [l1] });
    expect(folded.roles.legacyChannels).toEqual([l1]);
  });
});

describe("a vsk-13 Role's unknown fields (CORD-04 §2: unknown fields round-trip)", () => {
  it("carries a field named like an integer one, a float included, as written", () => {
    const id = "ab".repeat(32);
    const parsed = parseRankedRole(`{"role_id":"${id}","name":"r","rank":"m","permissions":"0","color":0,"display":false,"mentionable":false,"position":3,"allow":1.5,"note":"x"}`);
    expect(parsed?.kind).toBe("live");
    const back = JSON.parse(rankedRoleToJSON((parsed as { role: Parameters<typeof rankedRoleToJSON>[0] }).role));
    expect(back).toMatchObject({ position: 3, allow: 1.5, note: "x" });
  });
});
