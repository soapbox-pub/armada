import { describe, expect, it } from "vitest";

import { emptyReview, keyWork, reviewAccess, reviewMoves, viewRoad, views, withRules } from "./accessReview";
import { EVERYONE_DEFAULT, Permissions, type CommunityRoles, type Role } from "./roles";

const OWNER = "f".repeat(64);
const ANA = "1".repeat(64);
const BEN = "2".repeat(64);
const CAT = "3".repeat(64);

const VAULT = "aa".repeat(32);
const LOBBY = "bb".repeat(32);
const SHELF = "cc".repeat(32);

const MODS = "a".repeat(64);
const DECK = "b".repeat(64);

const VIEW = Permissions.VIEW_CHANNEL;
const HISTORY = Permissions.READ_MESSAGE_HISTORY;

const role = (roleId: string, name: string, position: number, scope: Role["scope"] = { kind: "server" }): Role => ({
  roleId,
  name,
  position,
  permissions: 0n,
  scope,
  color: 0,
});

const ranked = (over: Partial<CommunityRoles> = {}): CommunityRoles => ({
  roles: [role(MODS, "Mods", 1), role(DECK, "Deckhand", 2)],
  grants: [
    { member: ANA, roleIds: [MODS] },
    { member: BEN, roleIds: [DECK] },
  ],
  everyone: EVERYONE_DEFAULT,
  overwrites: [],
  syncs: {},
  ...over,
});

const allow = (scope: string, target: NonNullable<CommunityRoles["overwrites"]>[number]["target"], bits = VIEW | HISTORY) => ({
  scope,
  target,
  allow: bits,
  deny: 0n,
});

describe("views / viewRoad", () => {
  it("lets everyone into a public channel through @everyone", () => {
    const roster = ranked();
    expect(views(roster, OWNER, CAT, LOBBY, false)).toBe(true);
    expect(viewRoad(roster, OWNER, CAT, LOBBY, false)).toEqual({ kind: "everyone" });
  });

  it("closes a private channel to all but the roles and members its rules name", () => {
    const roster = ranked({
      overwrites: [allow(VAULT, { kind: "role", id: MODS }), allow(VAULT, { kind: "member", id: CAT })],
    });
    expect(viewRoad(roster, OWNER, ANA, VAULT, true)).toEqual({ kind: "role", id: MODS });
    expect(viewRoad(roster, OWNER, CAT, VAULT, true)).toEqual({ kind: "member" });
    expect(views(roster, OWNER, BEN, VAULT, true)).toBe(false);
    expect(viewRoad(roster, OWNER, BEN, VAULT, true)).toBeUndefined();
  });

  it("names the role that lets a member past a hidden public channel", () => {
    const roster = ranked({
      overwrites: [{ scope: LOBBY, target: { kind: "everyone" }, allow: 0n, deny: VIEW }, allow(LOBBY, { kind: "role", id: DECK }, VIEW)],
    });
    expect(views(roster, OWNER, ANA, LOBBY, false)).toBe(false);
    expect(viewRoad(roster, OWNER, BEN, LOBBY, false)).toEqual({ kind: "role", id: DECK });
  });

  it("reads a synced channel through its category's rules", () => {
    const roster = ranked({ syncs: { [VAULT]: SHELF }, overwrites: [allow(SHELF, { kind: "role", id: DECK })] });
    expect(viewRoad(roster, OWNER, BEN, VAULT, true)).toEqual({ kind: "role", id: DECK });
  });

  it("uses channel-scoped roles on a legacy roster", () => {
    const roster: CommunityRoles = {
      roles: [role(DECK, "Deckhand", 2, { kind: "channel", channelId: VAULT })],
      grants: [{ member: BEN, roleIds: [DECK] }],
    };
    expect(viewRoad(roster, OWNER, BEN, VAULT, true)).toEqual({ kind: "role", id: DECK });
    expect(views(roster, OWNER, ANA, VAULT, true)).toBe(false);
    expect(viewRoad(roster, OWNER, ANA, LOBBY, false)).toEqual({ kind: "everyone" });
  });
});

describe("withRules", () => {
  it("replaces the named targets and leaves the scope's other rules", () => {
    const roster = ranked({
      overwrites: [allow(VAULT, { kind: "role", id: MODS }), allow(VAULT, { kind: "role", id: DECK }), allow(LOBBY, { kind: "role", id: DECK })],
    });
    const next = withRules(roster, VAULT, {
      overwrites: [
        { target: { kind: "role", id: DECK }, allow: 0n, deny: 0n },
        { target: { kind: "member", id: CAT }, allow: VIEW, deny: 0n },
      ],
    });
    expect(next.overwrites).toEqual([
      allow(VAULT, { kind: "role", id: MODS }),
      allow(LOBBY, { kind: "role", id: DECK }),
      { scope: VAULT, target: { kind: "member", id: CAT }, allow: VIEW, deny: 0n },
    ]);
    expect(roster.overwrites).toHaveLength(3);
  });

  it("sets and clears the scope's sync", () => {
    const synced = withRules(ranked(), VAULT, { sync: { category: SHELF }, overwrites: [] });
    expect(synced.syncs).toEqual({ [VAULT]: SHELF });
    expect(withRules(synced, VAULT, { sync: { category: undefined }, overwrites: [] }).syncs).toEqual({});
  });
});

describe("reviewAccess", () => {
  const members = [OWNER, ANA, BEN, CAT];

  it("lists who a private channel's rules let in and shut out, with the road", () => {
    const before = ranked({ overwrites: [allow(VAULT, { kind: "role", id: DECK })] });
    const after = withRules(before, VAULT, {
      overwrites: [
        { target: { kind: "role", id: DECK }, allow: 0n, deny: 0n },
        { target: { kind: "role", id: MODS }, allow: VIEW | HISTORY, deny: 0n },
        { target: { kind: "member", id: CAT }, allow: VIEW, deny: HISTORY },
      ],
    });
    const review = reviewAccess({ before, after, ownerHex: OWNER, members, channels: [{ idHex: VAULT, wasPrivate: true, isPrivate: true }] });
    expect(review.losses).toEqual([{ member: BEN, channelIdHex: VAULT, road: { kind: "role", id: DECK }, keyed: true }]);
    expect(review.gains).toEqual([
      { member: ANA, channelIdHex: VAULT, road: { kind: "role", id: MODS }, keyed: true },
      { member: CAT, channelIdHex: VAULT, road: { kind: "member" }, keyed: true, fresh: true },
    ]);
    expect(review.keeps).toEqual([]);
    expect(reviewMoves(review)).toBe(true);
  });

  it("reports a hidden public channel as unkeyed losses", () => {
    const before = ranked();
    const after = withRules(before, LOBBY, { overwrites: [{ target: { kind: "role", id: DECK }, allow: 0n, deny: VIEW }] });
    const review = reviewAccess({ before, after, ownerHex: OWNER, members, channels: [{ idHex: LOBBY, wasPrivate: false, isPrivate: false }] });
    expect(review.losses).toEqual([{ member: BEN, channelIdHex: LOBBY, road: { kind: "everyone" }, keyed: false }]);
    expect(review.gains).toEqual([]);
  });

  it("lists who keeps a channel that goes private, and nobody when it goes public", () => {
    const roster = ranked({ overwrites: [allow(VAULT, { kind: "role", id: MODS })] });
    const closing = reviewAccess({ before: roster, after: roster, ownerHex: OWNER, members, channels: [{ idHex: VAULT, wasPrivate: false, isPrivate: true }] });
    expect(closing.keeps).toEqual([{ member: ANA, channelIdHex: VAULT, road: { kind: "role", id: MODS }, keyed: true }]);
    expect(closing.losses).toEqual([]);
    const opening = reviewAccess({ before: roster, after: roster, ownerHex: OWNER, members, channels: [{ idHex: VAULT, wasPrivate: true, isPrivate: false }] });
    expect(reviewMoves(opening)).toBe(false);
  });

  it("skips the owner and the banned, and moves nothing when the rules don't touch view access", () => {
    const before = ranked({ overwrites: [allow(VAULT, { kind: "role", id: DECK })] });
    const cut = withRules(before, VAULT, { overwrites: [{ target: { kind: "role", id: DECK }, allow: 0n, deny: 0n }] });
    const review = reviewAccess({ before, after: cut, ownerHex: OWNER, banned: new Set([BEN]), members, channels: [{ idHex: VAULT, wasPrivate: true, isPrivate: true }] });
    expect(reviewMoves(review)).toBe(false);
    const same = withRules(before, VAULT, { overwrites: [{ target: { kind: "role", id: DECK }, allow: VIEW | HISTORY | Permissions.SEND_MESSAGES, deny: 0n }] });
    expect(reviewMoves(reviewAccess({ before, after: same, ownerHex: OWNER, members, channels: [{ idHex: VAULT, wasPrivate: true, isPrivate: true }] }))).toBe(false);
  });
});

describe("keyWork", () => {
  const move = (member: string, channelIdHex: string, keyed: boolean, fresh?: boolean) => ({ member, channelIdHex, keyed, fresh });

  it("rotates for a keyed loss and a fresh gain, and sends a key for any other keyed gain", () => {
    const review = {
      ...emptyReview(),
      losses: [move(ANA, VAULT, true), move(BEN, VAULT, true), move(ANA, LOBBY, false)],
      gains: [move(CAT, SHELF, true, true), move(CAT, VAULT, true), move(BEN, LOBBY, false)],
    };
    expect(keyWork(review)).toEqual({ rotate: [VAULT, SHELF], send: [CAT] });
  });

  it("moves no key for whoever makes the change", () => {
    const review = { ...emptyReview(), losses: [move(ANA, VAULT, true)], gains: [move(ANA, SHELF, true)] };
    expect(keyWork(review, ANA)).toEqual({ rotate: [], send: [] });
  });
});
