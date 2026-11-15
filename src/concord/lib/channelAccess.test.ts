/**
 * Read access to a Private Channel, derived from the CORD-04 §2 Role scope
 * that CORD-03 and CORD-06 §1 both point at — not from any client-private
 * side channel. The property that matters is that every conforming client
 * computes the same answer from the same folded Roster: a vend on grant and
 * the keep-set of a rekey on revoke are both required of ANY Concord client
 * (CORD-03, CORD-06), so an access list only this client can read is one no
 * other client can honour.
 */

import { describe, expect, it } from "vitest";

import { planSettle, withGrant } from "./accessDuty";
import { banChannelCuts, channelRoleIds, isEntitled, vendableChannels } from "./channelAccess";
import { bytesToHex } from "./derive";
import { EVERYONE_DEFAULT, Permissions, type CommunityRoles, type Role } from "./roles";

const hexToBytes32 = (prefix: string) =>
  Uint8Array.from((prefix.repeat(64).slice(0, 64)).match(/.{2}/g)!.map((b) => parseInt(b, 16)));

const OWNER = "f".repeat(64);
const HOLDER = "1".repeat(64);
const OUTSIDER = "2".repeat(64);

const CH_SECRET = "aa".repeat(32);
const CH_OPEN = "bb".repeat(32);
const CH_OTHER = "cc".repeat(32);

const ROLE_TESTER = "a".repeat(64); // scoped to CH_SECRET — CORD-06 §1's example pair
const ROLE_AUDIT = "b".repeat(64); // also scoped to CH_SECRET
const ROLE_MODS = "c".repeat(64); // server-scope: rank, never a key
const ROLE_ELSEWHERE = "d".repeat(64); // scoped to a DIFFERENT channel

const role = (roleId: string, name: string, position: number, scope: Role["scope"]): Role => ({
  roleId,
  name,
  position,
  permissions: 0n,
  scope,
  color: 0,
});

const roster: CommunityRoles = {
  roles: [
    role(ROLE_TESTER, "Tester", 5, { kind: "channel", channelId: CH_SECRET }),
    role(ROLE_AUDIT, "Auditor", 4, { kind: "channel", channelId: CH_SECRET }),
    { ...role(ROLE_MODS, "Mods", 3, { kind: "server" }), permissions: Permissions.MANAGE_MESSAGES },
    role(ROLE_ELSEWHERE, "Otherfolk", 6, { kind: "channel", channelId: CH_OTHER }),
  ],
  grants: [{ member: HOLDER, roleIds: [ROLE_TESTER] }],
};

describe("channelRoles (CORD-04 §2 scope is the access list)", () => {
  it("names the roles scoped to the channel, in display order", () => {
    // Auditor is position 4, Tester 5 — CORD-04 §3 order, lower first.
    expect(channelRoleIds(roster, CH_SECRET)).toEqual([ROLE_AUDIT, ROLE_TESTER]);
  });

  it("excludes server-scope roles: rank is not a key (CORD-04 §2)", () => {
    // "A Role is a named bundle of permissions at a position. It mints no
    // key, so granting it hands a member rank, never a secret." A server-scope
    // role confers authority everywhere and read access nowhere.
    expect(channelRoleIds(roster, CH_SECRET)).not.toContain(ROLE_MODS);
  });

  it("excludes roles scoped to a different channel", () => {
    expect(channelRoleIds(roster, CH_OTHER)).toEqual([ROLE_ELSEWHERE]);
    expect(channelRoleIds(roster, CH_OPEN)).toEqual([]);
  });

  it("matches the channel id case-insensitively", () => {
    expect(channelRoleIds(roster, CH_SECRET.toUpperCase())).toEqual([ROLE_AUDIT, ROLE_TESTER]);
  });
});

describe("entitlement", () => {
  it("the owner is always entitled — position 0, with or without roles", () => {
    expect(isEntitled(roster, OWNER, OWNER, CH_SECRET)).toBe(true);
    expect(isEntitled(roster, OWNER, OWNER, CH_OTHER)).toBe(true);
  });

  it("a holder of a scoped role is entitled; everyone else is not", () => {
    expect(isEntitled(roster, OWNER, HOLDER, CH_SECRET)).toBe(true);
    expect(isEntitled(roster, OWNER, OUTSIDER, CH_SECRET)).toBe(false);
    // Holding Tester says nothing about a channel Tester isn't scoped to.
    expect(isEntitled(roster, OWNER, HOLDER, CH_OTHER)).toBe(false);
  });

  it("overlays judge a just-published grant before the fold catches up", () => {
    expect(isEntitled(roster, OWNER, OUTSIDER, CH_SECRET, { withRoleIds: [ROLE_TESTER] })).toBe(true);
    expect(isEntitled(roster, OWNER, HOLDER, CH_SECRET, { withoutRoleIds: [ROLE_TESTER] })).toBe(false);
  });

  it("a channel nobody is scoped to entitles nobody but the owner", () => {
    // Degenerate, not open: a private channel readable by every member is
    // strictly worse than a public one, so this is a configuration to avoid
    // rather than a mode to support. It must never read as "everyone".
    expect(isEntitled(roster, OWNER, HOLDER, CH_OPEN)).toBe(false);
    expect(isEntitled(roster, OWNER, OWNER, CH_OPEN)).toBe(true);
  });
});

describe("vendableChannels (what an invite bundle may carry)", () => {
  // Both are PRIVATE channels the sender holds keys to: CH_SECRET is gated by
  // ROLE_TESTER/ROLE_AUDIT, CH_OTHER by nothing at all.
  const held = [{ id: hexToBytes32("aa") }, { id: hexToBytes32("cc") }];
  const asMember = (memberHex: string, overlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] }) =>
    ({ kind: "member", roster, ownerHex: OWNER, memberHex, overlay }) as const;

  it("carries NOTHING to a link, whose audience holds no Role (CORD-05 §2 / CORD-03 §1)", () => {
    // Anyone the link reaches can join, so its audience is entitled to no
    // Private Channel. Access to one is handed out by granting its scoped
    // Role, which vends the key as a Direct Invite.
    expect(vendableChannels(held, { kind: "link" })).toEqual([]);
  });

  it("carries a channel to a member who holds one of its scoped Roles", () => {
    expect(vendableChannels(held, asMember(HOLDER)).map((c) => bytesToHex(c.id))).toEqual([CH_SECRET]);
  });

  it("carries nothing to a member entitled to none of them", () => {
    expect(vendableChannels(held, asMember(OUTSIDER))).toEqual([]);
  });

  it("carries everything to the owner, entitled with or without any Role", () => {
    expect(vendableChannels(held, asMember(OWNER)).map((c) => bytesToHex(c.id)).sort()).toEqual(
      [CH_SECRET, CH_OTHER].sort(),
    );
  });

  it("judges a just-published Grant through the overlay, not the lagging fold", () => {
    // The grant-driven vend: the Grant is on the wire but the fold has not
    // caught up, so without the overlay the recipient reads as unentitled and
    // is handed nothing at exactly the moment they should be handed the key.
    expect(vendableChannels(held, asMember(OUTSIDER))).toEqual([]);
    expect(
      vendableChannels(held, asMember(OUTSIDER, { withRoleIds: [ROLE_TESTER] })).map((c) => bytesToHex(c.id)),
    ).toEqual([CH_SECRET]);
  });

  it("honours an explicit exclusion beneath the entitlement ceiling", () => {
    expect(vendableChannels(held, asMember(OWNER), { exclude: new Set([CH_SECRET]) }).map((c) => bytesToHex(c.id))).toEqual([
      CH_OTHER,
    ]);
  });

  it("narrows to an explicit grant set — the role-grant vend", () => {
    // Granting a Role hands over the channels that Role opens, not the
    // sender's whole keyring. `only` narrows; it never widens past entitlement.
    expect(vendableChannels(held, asMember(OWNER), { only: new Set([CH_SECRET]) }).map((c) => bytesToHex(c.id))).toEqual([
      CH_SECRET,
    ]);
    expect(vendableChannels(held, asMember(OUTSIDER), { only: new Set([CH_SECRET]) })).toEqual([]);
  });

  it("on ranked roles, carries a key only to a member who may also read the channel's history (CORD-03 §5)", () => {
    const VIP = "e".repeat(64);
    const ranked: CommunityRoles = {
      everyone: EVERYONE_DEFAULT,
      roles: [{ ...role(VIP, "VIP", 2, { kind: "server" }) }],
      grants: [{ member: HOLDER, roleIds: [VIP] }, { member: OUTSIDER, roleIds: [VIP] }],
      overwrites: [
        { scope: CH_SECRET, target: { kind: "role", id: VIP }, allow: Permissions.VIEW_CHANNEL, deny: 0n },
        { scope: CH_SECRET, target: { kind: "member", id: OUTSIDER }, allow: 0n, deny: Permissions.READ_MESSAGE_HISTORY },
      ],
    };
    const to = (memberHex: string) => vendableChannels(held, { kind: "member", roster: ranked, ownerHex: OWNER, memberHex });
    expect(to(HOLDER).map((c) => bytesToHex(c.id))).toEqual([CH_SECRET]);
    expect(to(OUTSIDER), "without Read Message History a key comes only with a fresh epoch").toEqual([]);
  });

  it("THROWS rather than silently vending nothing when the roster has not loaded", () => {
    // "Entitled to nothing" and "I can't tell yet" are different answers, and
    // the silent version gives the sender no signal.
    expect(() => vendableChannels(held, { kind: "member", roster: undefined, ownerHex: OWNER, memberHex: HOLDER })).toThrow(
      /loading/i,
    );
  });

  it("does not throw for a community that genuinely holds no private channels", () => {
    expect(vendableChannels([], { kind: "member", roster: undefined, ownerHex: OWNER, memberHex: HOLDER })).toEqual([]);
  });
});

describe("planSettle on a legacy Roster (which channels a Grant moves)", () => {
  const ids = [CH_SECRET, CH_OTHER];
  const settle = (before: CommunityRoles, after: CommunityRoles, members: string[], banned = new Set<string>()) =>
    planSettle({ before, after, ownerHex: OWNER, banned, me: "f".repeat(64), members, channels: ids });

  it("moves exactly the channel the toggled role scopes", () => {
    const wide: CommunityRoles = {
      roles: [
        role(ROLE_TESTER, "Tester", 5, { kind: "channel", channelId: CH_SECRET }),
        role(ROLE_ELSEWHERE, "Otherfolk", 6, { kind: "channel", channelId: CH_OTHER }),
      ],
      grants: [],
    };
    expect(settle(wide, withGrant(wide, OUTSIDER, [ROLE_TESTER]), [OUTSIDER])).toEqual([{ channelIdHex: CH_SECRET, gained: [OUTSIDER], fresh: [], lost: [] }]);
    expect(settle(withGrant(wide, OUTSIDER, [ROLE_ELSEWHERE]), wide, [OUTSIDER])).toEqual([{ channelIdHex: CH_OTHER, gained: [], fresh: [], lost: [OUTSIDER] }]);
  });

  it("moves nothing for a server-scope role, a channel kept through a second role, or the owner", () => {
    expect(settle(roster, withGrant(roster, OUTSIDER, [ROLE_MODS]), [OUTSIDER])).toEqual([]);
    const both = withGrant(roster, HOLDER, [ROLE_TESTER, ROLE_AUDIT]);
    expect(settle(both, withGrant(both, HOLDER, [ROLE_AUDIT]), [HOLDER])).toEqual([]);
    expect(settle(roster, withGrant(roster, OWNER, [ROLE_TESTER]), [OWNER])).toEqual([]);
  });

  it("a bulk strip cuts only those who lose the channel, and leaves the banned to the ban", () => {
    const SECOND = "3".repeat(64);
    const BANNED = "6".repeat(64);
    const held: CommunityRoles = {
      roles: roster.roles,
      grants: [
        { member: HOLDER, roleIds: [ROLE_TESTER] },
        { member: SECOND, roleIds: [ROLE_TESTER, ROLE_AUDIT] },
        { member: BANNED, roleIds: [ROLE_TESTER] },
      ],
    };
    const stripped = withGrant(withGrant(withGrant(held, HOLDER, []), SECOND, [ROLE_AUDIT]), BANNED, []);
    expect(settle(held, stripped, [HOLDER, SECOND, BANNED], new Set([BANNED]))).toEqual([{ channelIdHex: CH_SECRET, gained: [], fresh: [], lost: [HOLDER] }]);
  });
});

describe("banChannelCuts (the rekeys a ban owes)", () => {
  const SECOND = "3".repeat(64);
  const BANNED = "6".repeat(64);
  const channels = [
    { idHex: CH_SECRET, heldByMe: true },
    { idHex: CH_OTHER, heldByMe: false },
  ];
  const held: CommunityRoles = {
    roles: roster.roles,
    grants: [
      { member: HOLDER, roleIds: [ROLE_TESTER, ROLE_ELSEWHERE] },
      { member: SECOND, roleIds: [ROLE_AUDIT] },
      { member: OUTSIDER, roleIds: [ROLE_MODS] },
      { member: BANNED, roleIds: [ROLE_AUDIT] },
    ],
  };

  it("cuts the targets from every channel they can read, keeping everyone else entitled", () => {
    const cuts = banChannelCuts(held, OWNER, [HOLDER], channels, new Set([BANNED]));
    expect(cuts).toHaveLength(2);
    const secret = cuts.find((c) => c.channelIdHex === CH_SECRET)!;
    expect(secret).toMatchObject({ heldByMe: true, removed: [HOLDER] });
    expect(secret.keep.sort()).toEqual([OWNER, SECOND].sort());
    expect(cuts.find((c) => c.channelIdHex === CH_OTHER)).toMatchObject({ heldByMe: false, keep: [OWNER], removed: [HOLDER] });
  });

  it("owes nothing for a target with no channel role", () => {
    expect(banChannelCuts(held, OWNER, [OUTSIDER], channels)).toEqual([]);
  });

  it("keeps a reader only a member overwrite lets in (Vector `access_candidates`)", () => {
    const VIP = "e".repeat(64);
    const NEWCOMER = "7".repeat(64);
    const ranked: CommunityRoles = {
      everyone: EVERYONE_DEFAULT,
      roles: [role(VIP, "VIP", 2, { kind: "server" })],
      grants: [{ member: HOLDER, roleIds: [VIP] }],
      overwrites: [
        { scope: CH_SECRET, target: { kind: "role", id: VIP }, allow: Permissions.VIEW_CHANNEL, deny: 0n },
        { scope: CH_SECRET, target: { kind: "member", id: SECOND }, allow: Permissions.VIEW_CHANNEL, deny: 0n },
      ],
    };
    const [cut] = banChannelCuts(ranked, OWNER, [HOLDER], [{ idHex: CH_SECRET, heldByMe: true }], undefined, [NEWCOMER]);
    expect(cut.keep.sort()).toEqual([OWNER, SECOND].sort());
  });

  it("rotates a channel once for several targets", () => {
    const cuts = banChannelCuts(held, OWNER, [HOLDER, SECOND], channels);
    expect(cuts.find((c) => c.channelIdHex === CH_SECRET)).toMatchObject({ removed: [HOLDER, SECOND] });
    expect(cuts.find((c) => c.channelIdHex === CH_SECRET)!.keep.sort()).toEqual([OWNER, BANNED].sort());
  });
});


