import { describe, expect, it } from "vitest";

import type { CoalescedMember } from "@/concord/lib/guestbook";
import {
  buildMemberRows,
  filterMemberRows,
  hoistSuspicious,
  type MemberDirectoryRow,
  sortMemberRows,
} from "@/concord/lib/memberDirectory";
import type { CommunityRoles } from "@/concord/lib/roles";

const OWNER = "aa".repeat(32);
const ADMIN = "bb".repeat(32);
const MOD = "cc".repeat(32);
const PLAIN = "dd".repeat(32);
const GHOST = "ee".repeat(32); // observed-only, no guestbook entry
const REJOINED = "ff".repeat(32); // left, then seen posting again

function joined(pubkey: string, ms: number, extra?: Partial<CoalescedMember>): [string, CoalescedMember] {
  return [pubkey, { pubkey, state: "join", ms, rumorId: "r".repeat(64), fromSnapshot: false, ...extra }];
}

const roster: CommunityRoles = {
  roles: [
    { roleId: "role-admin", name: "Admin", position: 1, permissions: 0n, scope: { kind: "server" }, color: 0 },
    { roleId: "role-mod", name: "Mod", position: 2, permissions: 0n, scope: { kind: "server" }, color: 0 },
  ],
  grants: [
    { member: ADMIN, roleIds: ["role-admin"] },
    { member: MOD, roleIds: ["role-mod"] },
  ],
};

function build(): MemberDirectoryRow[] {
  return buildMemberRows({
    members: new Set([OWNER, ADMIN, MOD, PLAIN, GHOST, REJOINED]),
    coalesced: new Map<string, CoalescedMember>([
      joined(OWNER, 1_000),
      joined(ADMIN, 2_000, { invite: { creator: OWNER, label: "friends" } }),
      joined(MOD, 3_000, { fromSnapshot: true }),
      joined(PLAIN, 4_000),
      [REJOINED, { pubkey: REJOINED, state: "leave", ms: 5_000, rumorId: "r".repeat(64), fromSnapshot: false }],
    ]),
    observedEpochOf: new Map([
      [ADMIN, 2n],
      [PLAIN, 1n], // behind
      [GHOST, 2n],
    ]),
    observedSeenMs: new Map([
      [ADMIN, 9_000],
      [PLAIN, 8_000],
      [GHOST, 7_000],
      [REJOINED, 6_000],
    ]),
    roster,
    currentEpoch: 2n,
    ownerHex: OWNER,
    selfHex: ADMIN,
  });
}

describe("buildMemberRows", () => {
  it("derives provenance, epoch health, roles, and flags", () => {
    const rows = new Map(build().map((r) => [r.pubkey, r]));
    expect(rows.size).toBe(6);

    expect(rows.get(OWNER)).toMatchObject({ joinKind: "join", joinMs: 1_000, isOwner: true, lastSeenMs: 0, behind: false });
    expect(rows.get(ADMIN)).toMatchObject({
      joinKind: "join",
      invite: { creator: OWNER, label: "friends" },
      highestPosition: 1,
      isSelf: true,
      behind: false,
    });
    expect(rows.get(MOD)).toMatchObject({ joinKind: "snapshot", joinMs: 3_000, highestPosition: 2 });
    expect(rows.get(PLAIN)).toMatchObject({ joinKind: "join", behind: true, epoch: 1n, highestPosition: undefined });
    expect(rows.get(GHOST)).toMatchObject({ joinKind: "observed", joinMs: undefined, lastSeenMs: 7_000 });
    // A winning Leave means the old Join time is gone — membership is observed.
    expect(rows.get(REJOINED)).toMatchObject({ joinKind: "observed", joinMs: undefined });
  });
});

describe("sortMemberRows", () => {
  it("role: owner first, ranked ascending, roleless last, longest-standing tiebreak", () => {
    const order = sortMemberRows(build(), "role").map((r) => r.pubkey);
    expect(order.slice(0, 3)).toEqual([OWNER, ADMIN, MOD]);
    // Roleless tier ordered by joinMs asc (PLAIN 4000), unknown join sinks.
    expect(order[3]).toBe(PLAIN);
    expect(new Set(order.slice(4))).toEqual(new Set([GHOST, REJOINED]));
  });

  it("joined-newest / joined-oldest sink unknown joins; seen sinks the never-seen", () => {
    const newest = sortMemberRows(build(), "joined-newest").map((r) => r.pubkey);
    expect(newest.slice(0, 4)).toEqual([PLAIN, MOD, ADMIN, OWNER]);
    expect(new Set(newest.slice(4)), "unknown joins last").toEqual(new Set([GHOST, REJOINED]));

    const oldest = sortMemberRows(build(), "joined-oldest").map((r) => r.pubkey);
    expect(oldest.slice(0, 4)).toEqual([OWNER, ADMIN, MOD, PLAIN]);

    // Never-seen (0) sinks; the tie between them breaks on pubkey.
    const seen = sortMemberRows(build(), "seen").map((r) => r.pubkey);
    expect(seen).toEqual([ADMIN, PLAIN, GHOST, REJOINED, OWNER, MOD]);
  });

  it("is deterministic and does not mutate its input", () => {
    const rows = build();
    const before = rows.map((r) => r.pubkey);
    const a = sortMemberRows(rows, "seen").map((r) => r.pubkey);
    const b = sortMemberRows(rows, "seen").map((r) => r.pubkey);
    expect(a).toEqual(b);
    expect(rows.map((r) => r.pubkey)).toEqual(before);
  });
});

describe("filterMemberRows", () => {
  it("filters by role, including the roleless bucket", () => {
    const rows = build();
    expect(filterMemberRows(rows, { roleIds: ["role-admin"] }).map((r) => r.pubkey)).toEqual([ADMIN]);
    const rolelessOrAdmin = filterMemberRows(rows, { roleIds: ["role-admin"], noRole: true }).map((r) => r.pubkey);
    expect(new Set(rolelessOrAdmin)).toEqual(new Set([ADMIN, OWNER, PLAIN, GHOST, REJOINED]));
    expect(filterMemberRows(rows, {}).length, "no filter keeps everyone").toBe(6);
  });

  it("filters by epoch health and invite attribution", () => {
    const rows = build();
    expect(filterMemberRows(rows, { behindOnly: true }).map((r) => r.pubkey)).toEqual([PLAIN]);
    expect(filterMemberRows(rows, { viaInvite: true }).map((r) => r.pubkey)).toEqual([ADMIN]);
    // By a SPECIFIC link creator: only Joins crediting that inviter.
    expect(filterMemberRows(rows, { inviter: OWNER }).map((r) => r.pubkey)).toEqual([ADMIN]);
    expect(filterMemberRows(rows, { inviter: MOD })).toEqual([]);
  });

  it("matches a query by injected name match or pubkey prefix", () => {
    const rows = build();
    const names = new Map([[ADMIN, "sillie bear"]]);
    const nameMatch = (pk: string, q: string) => names.get(pk)?.includes(q) ?? false;
    expect(filterMemberRows(rows, { query: "bear", nameMatch }).map((r) => r.pubkey)).toEqual([ADMIN]);
    expect(filterMemberRows(rows, { query: "cc", nameMatch }).map((r) => r.pubkey)).toEqual([MOD]);
    expect(filterMemberRows(rows, { query: "CC", nameMatch }), "query lowercased for prefix match").toHaveLength(1);
    expect(filterMemberRows(rows, { query: "   ", nameMatch }).length, "blank query keeps everyone").toBe(6);
  });
});

describe("suspicious members", () => {
  const OUTSIDER = "ab".repeat(32); // watchdog-flagged, NOT in the member list

  function buildWithSuspicion(): MemberDirectoryRow[] {
    return buildMemberRows({
      members: new Set([OWNER, ADMIN, PLAIN]),
      coalesced: new Map<string, CoalescedMember>([joined(OWNER, 1_000), joined(ADMIN, 2_000), joined(PLAIN, 3_000)]),
      observedEpochOf: new Map(),
      observedSeenMs: new Map(),
      roster,
      currentEpoch: 0n,
      ownerHex: OWNER,
      selfHex: undefined,
      suspicious: new Set([PLAIN, OUTSIDER]),
    });
  }

  it("flags rows and conjures a row for a flagged non-member", () => {
    const rows = new Map(buildWithSuspicion().map((r) => [r.pubkey, r]));
    expect(rows.size, "the outsider joins the list").toBe(4);
    expect(rows.get(PLAIN)?.suspicious).toBe(true);
    expect(rows.get(ADMIN)?.suspicious).toBe(false);
    expect(rows.get(OUTSIDER)).toMatchObject({ suspicious: true, joinKind: "observed", joinMs: undefined });
  });

  it("hoistSuspicious is a stable partition on top of any sort", () => {
    const sorted = sortMemberRows(buildWithSuspicion(), "role");
    const order = hoistSuspicious(sorted).map((r) => r.pubkey);
    // Flagged first (keeping their sorted order: PLAIN joined, OUTSIDER unknown-join sinks)...
    expect(order.slice(0, 2)).toEqual([PLAIN, OUTSIDER]);
    // ...then the rest still in role order.
    expect(order.slice(2)).toEqual([OWNER, ADMIN]);
    // No flags → the same array shape, untouched order.
    const clean = sortMemberRows(build(), "role");
    expect(hoistSuspicious(clean).map((r) => r.pubkey)).toEqual(clean.map((r) => r.pubkey));
  });

  it("suspiciousOnly filters to the flagged", () => {
    const rows = buildWithSuspicion();
    expect(new Set(filterMemberRows(rows, { suspiciousOnly: true }).map((r) => r.pubkey))).toEqual(
      new Set([PLAIN, OUTSIDER]),
    );
  });
});

describe("members a key rotation left out", () => {
  const LEFT_OUT = "12".repeat(32); // Joined before the rotation, absent from its snapshot
  const BANNED = "34".repeat(32); // absent from it because they were banned
  const BACK = "56".repeat(32); // absent from it, but seen posting since

  function refounded(pubkey: string): [string, CoalescedMember] {
    return [pubkey, { pubkey, state: "refounded", ms: 9_000, rumorId: "s".repeat(64), fromSnapshot: true }];
  }

  function buildWithOmitted(): MemberDirectoryRow[] {
    return buildMemberRows({
      members: new Set([OWNER, PLAIN, BACK]),
      coalesced: new Map<string, CoalescedMember>([
        joined(OWNER, 1_000),
        joined(PLAIN, 4_000),
        refounded(LEFT_OUT),
        refounded(BANNED),
        refounded(BACK),
      ]),
      history: new Map([
        [LEFT_OUT, [joined(LEFT_OUT, 2_000, { invite: { creator: OWNER, label: "friends" } })[1]]],
        [BANNED, [joined(BANNED, 3_000)[1]]],
        [BACK, [joined(BACK, 3_500)[1]]],
      ]),
      banned: new Set([BANNED]),
      observedEpochOf: new Map([[LEFT_OUT, 1n]]),
      observedSeenMs: new Map([[LEFT_OUT, 5_000]]),
      roster,
      currentEpoch: 2n,
      ownerHex: OWNER,
      selfHex: OWNER,
    });
  }

  it("gives each a row carrying the Join they held, and none to the banned", () => {
    const rows = new Map(buildWithOmitted().map((r) => [r.pubkey, r]));
    expect(rows.get(LEFT_OUT)).toMatchObject({
      omitted: true,
      joinKind: "join",
      joinMs: 2_000,
      invite: { creator: OWNER, label: "friends" },
      lastSeenMs: 5_000,
      epoch: 1n,
    });
    expect(rows.has(BANNED)).toBe(false);
    // Listed again by what they posted since: an ordinary member.
    expect(rows.get(BACK)?.omitted).toBe(false);
    expect(rows.get(PLAIN)?.omitted).toBe(false);
  });

  it("keeps them out of the member list unless asked for", () => {
    const rows = buildWithOmitted();
    expect(new Set(filterMemberRows(rows, {}).map((r) => r.pubkey))).toEqual(new Set([OWNER, PLAIN, BACK]));
    expect(filterMemberRows(rows, { behindOnly: true })).toEqual([]);
    expect(filterMemberRows(rows, { omittedOnly: true }).map((r) => r.pubkey)).toEqual([LEFT_OUT]);
    expect(filterMemberRows(rows, { omittedOnly: true, inviter: MOD })).toEqual([]);
  });
});

describe("sortMemberRows by name", () => {
  it("orders by the injected name comparator", () => {
    const rows = ["c", "a", "b"].map((c) => ({ pubkey: c.repeat(64) }) as unknown as MemberDirectoryRow);
    const names: Record<string, string> = { ["a".repeat(64)]: "Zoe", ["b".repeat(64)]: "amy", ["c".repeat(64)]: "Ben" };
    const sorted = sortMemberRows(rows, "name", (x, y) => names[x].localeCompare(names[y], "en", { sensitivity: "base" }));
    expect(sorted.map((r) => names[r.pubkey])).toEqual(["amy", "Ben", "Zoe"]);
  });
});
