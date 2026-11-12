/**
 * CORD-04 conformance ledger.
 *
 * ONE `it` per normative obligation in CORD-04, in spec order, each named with
 * the clause it comes from. This file is a checklist that happens to execute:
 *
 *  - a rule that is verified is an `it` with real assertions;
 *  - a rule that is NOT yet verified is an `it.todo`, so vitest prints the
 *    outstanding count on every run and the gap cannot be forgotten;
 *  - a rule that is verified ELSEWHERE still gets an entry here, because the
 *    index is only useful if it is complete.
 *
 * Why it exists: review passes over this client kept finding "a new" CORD
 * violation each time, because the search was recall-driven — read the diff,
 * flag what catches the eye. A section-level citation ("this test cites
 * CORD-04 §3") reads as coverage while hiding the fact that §3 alone carries
 * ten distinct rules. Enumerating the rules is what makes the search
 * terminate: what is left over after walking this list IS the gap, and a
 * second pass finds nothing new.
 *
 * Numbering (O-n) is stable and local to this file — cite it in review, but
 * the SPEC is the authority. If an obligation here disagrees with
 * `concord/04.md`, the spec wins and this file is the bug.
 */

import type { ParsedEdition } from "@/concord/lib/edition";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildBanlistEdition,
  MAX_BANLIST,
  buildChannelEdition,
  buildGrantEdition,
  buildMetadataEdition,
  buildRegistryEdition,
  buildRoleEdition,
  citationSatisfied,
  foldControlState,
  openControlWraps,
  sealEdition,
} from "./control";
import {
  banlistLocator,
  bytesToHex,
  communityIdOf,
  controlGroupKey,
  grantLocator,
  hex32,
  inviteLinksLocator,
  random32,
  verifyCommunityId,
  type GroupKey,
} from "./derive";
import { buildEditionRumor, citationFromTags, citationToTag } from "./edition";
import { KIND_CONTROL, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "./kinds";
import { sealRumor, wrapSeal } from "./stream";
import { bootstrapHead, editionHash, fold, type Edition } from "./version";
import {
  ADMIN_ALL,
  PERMISSION_LABELS,
  byDisplayOrder,
  canActOnMember,
  canActOnPosition,
  effectivePermissions,
  emptyRoles,
  grantFromJSON,
  grantRefusal,
  grantToJSON,
  highestPosition,
  MAX_ROLES_PER_COMMUNITY,
  MAX_ROLES_PER_MEMBER,
  mintablePosition,
  NAME_MAX_BYTES,
  outranks,
  permsContain,
  Permissions,
  roleById,
  roleFromJSON,
  rolesOf,
  roleToJSON,
  type CommunityRoles,
  type Role,
} from "./roles";

const OWNER = "f".repeat(64);
const ADMIN = "a".repeat(64);
const MOD = "b".repeat(64);
const PLAIN = "c".repeat(64);

const role = (roleId: string, position: number, permissions = 0n): Role => ({
  roleId,
  name: `role-${roleId.slice(0, 4)}`,
  position,
  permissions,
  scope: { kind: "server" },
  color: 0,
});

const R_ADMIN = role("a".repeat(64), 1, ADMIN_ALL);
const R_MOD = role("b".repeat(64), 5, Permissions.MANAGE_MESSAGES | Permissions.KICK);

const roster: CommunityRoles = {
  roles: [R_ADMIN, R_MOD],
  grants: [
    { member: ADMIN, roleIds: [R_ADMIN.roleId] },
    { member: MOD, roleIds: [R_MOD.roleId] },
  ],
};

const editionOpts = { actorPubkey: OWNER, version: 1n };

// ── Harness ──────────────────────────────────────────────────────────────────

function keypair(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/** A community whose owner is proven by the community_id commitment (CORD-02). */
function makeCommunity() {
  const owner = keypair();
  const ownerSalt = random32();
  const communityId = communityIdOf(hex32(owner.pubkey), ownerSalt);
  const root = random32();
  return { owner, communityId, root, control: controlGroupKey(root, communityId, 0) };
}

/** Seal + wrap an edition, then open it back into the parsed form a fold sees. */
async function round(rumor: ReturnType<typeof buildMetadataEdition>, control: GroupKey, by: ReturnType<typeof keypair>) {
  return openControlWraps([await sealEdition(rumor, control, by)], [control])[0];
}

const tagOf = (rumor: { tags: string[][] }, name: string) => rumor.tags.find((t) => t[0] === name);

/** A synthetic fold edition — the pure-`fold` cases need no crypto. */
const ed = (version: bigint, prev: number | undefined, self: number, tiebreak = 0xa0 + Number(version)): Edition => ({
  version,
  prevHash: prev === undefined ? undefined : new Uint8Array(32).fill(prev),
  selfHash: new Uint8Array(32).fill(self),
  createdAt: 100 + Number(version),
  tiebreakId: new Uint8Array(32).fill(tiebreak),
});

// ── §1 Editions ──────────────────────────────────────────────────────────────

describe("CORD-04 §1 — Editions", () => {
  it("O-1: an edition carries entity, version, prev and content", async () => {
    const { owner, communityId, control } = makeCommunity();
    const v1 = await round(
      buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const v2 = await round(
      buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: v1.selfHash }),
      control,
      owner,
    );

    expect(bytesToHex(v2.entityId)).toBe(bytesToHex(communityId));
    expect(v2.version).toBe(2n);
    expect(v2.prevHash && bytesToHex(v2.prevHash)).toBe(bytesToHex(v1.selfHash));
    expect(JSON.parse(v2.content)).toMatchObject({ name: "Two" });
    // Authorship is the SEAL's signature, not a field of the rumor.
    expect(v2.author).toBe(owner.pubkey);
  });

  it("O-2: version starts at 1 and only ever climbs", () => {
    // The "starts at 1" half is an ANCHOR condition, not a build-time refusal:
    // a cold chain walk is contiguous only if its lowest edition is version 1
    // with no prev. A chain that starts at 2 is a gap (which a fresh joiner
    // may still bootstrap past — O-16 — but a tracking client will not).
    expect(fold([ed(1n, undefined, 1), ed(2n, 1, 2)], 0n)).toMatchObject({ head: 1, gap: false });
    expect(fold([ed(2n, undefined, 2), ed(3n, 2, 3)], 0n).gap).toBe(true);

    // "Only ever climbs": the head is the top of the contiguous run, and the
    // publish side always builds at head+1 (useRoles/useCommunityActions).
    const climbing = [ed(1n, undefined, 1), ed(2n, 1, 2), ed(3n, 2, 3)];
    expect(climbing[fold(climbing, 0n).head!].version).toBe(3n);
  });

  it("O-3: prev is absent on the first edition, present thereafter", () => {
    const first = buildEditionRumor({ vsk: "0", entityId: random32(), version: 1n, content: "{}", actorPubkey: OWNER });
    expect(tagOf(first, "ep")).toBeUndefined();

    const prevHash = editionHash(random32(), 1n, undefined, new TextEncoder().encode("{}"));
    const second = buildEditionRumor({ vsk: "0", entityId: random32(), version: 2n, prevHash, content: "{}", actorPubkey: OWNER });
    expect(tagOf(second, "ep")?.[1]).toBe(bytesToHex(prevHash));
  });

  it("O-4: on the wire an edition is a kind 3308 rumor with fields on tags", () => {
    const entityId = random32();
    const prevHash = random32();
    const authority = { entityId: random32(), version: 7n, editionHash: random32() };
    const rumor = buildEditionRumor({ vsk: "3", entityId, version: 4n, prevHash, content: "{}", actorPubkey: OWNER, authority });

    expect(rumor.kind).toBe(KIND_CONTROL);
    expect(KIND_CONTROL).toBe(3308); // frozen
    expect(tagOf(rumor, "vsk")).toEqual(["vsk", "3"]);
    expect(tagOf(rumor, "eid")).toEqual(["eid", bytesToHex(entityId)]);
    expect(tagOf(rumor, "ev")).toEqual(["ev", "4"]);
    expect(tagOf(rumor, "ep")).toEqual(["ep", bytesToHex(prevHash)]);
    expect(tagOf(rumor, "vac")).toEqual(["vac", bytesToHex(authority.entityId), "7", bytesToHex(authority.editionHash)]);
  });

  it("O-5: the Control Plane seals plaintext (kind 20014), never 20013", async () => {
    const { owner, communityId, control } = makeCommunity();
    const rumor = buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const opened = await round(rumor, control, owner);
    expect(opened.opened.sealKind).toBe(KIND_SEAL_PLAINTEXT);

    // The same rumor under an ENCRYPTED seal is refused: it could not survive a
    // compaction re-wrap, so honoring it would mint state that vanishes for
    // every fresh joiner at the next Refounding.
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, control, owner);
    const [encrypted] = openControlWraps([await wrapSeal(seal, control)], [control]);
    expect(encrypted).toBeUndefined(); // dropped before it ever reaches the fold
  });

  it("O-6: vac pins the Grant by coordinate, version AND content hash", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const grantEid = grantLocator(communityId, hex32(admin.pubkey));
    const grant = await round(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const heads = new Map([[bytesToHex(grantEid), { version: 1n, hash: grant.selfHash }]]);
    const folded = { heads, ownerHex: owner.pubkey };
    const cite = (over: Partial<{ entityId: Uint8Array; version: bigint; editionHash: Uint8Array }> = {}) =>
      citationSatisfied(folded, communityId, admin.pubkey, {
        entityId: grantEid,
        version: 1n,
        editionHash: grant.selfHash,
        ...over,
      });

    expect(cite()).toBe(true);
    // All three parts bind: someone else's coordinate, an unheld version, or a
    // hash that isn't the edition we folded at that version.
    expect(cite({ entityId: grantLocator(communityId, hex32(OWNER)) })).toBe(false);
    expect(cite({ version: 2n })).toBe(false);
    expect(cite({ editionHash: random32() })).toBe(false);

    // The tag layout carrying that pin is frozen, and round-trips.
    const tag = citationToTag({ entityId: grantEid, version: 1n, editionHash: grant.selfHash });
    expect(tag).toEqual(["vac", bytesToHex(grantEid), "1", bytesToHex(grant.selfHash)]);
    expect(citationFromTags([tag])?.version).toBe(1n);
  });

  it("O-6b: vac is absent when the owner acts", () => {
    const { owner, communityId } = makeCommunity();
    const folded = { heads: new Map(), ownerHex: owner.pubkey };
    // The owner's rank comes from the community_id, not any fold, so an absent
    // citation is satisfied for them and only them.
    expect(citationSatisfied(folded, communityId, owner.pubkey, undefined)).toBe(true);
    expect(citationSatisfied(folded, communityId, PLAIN, undefined)).toBe(false);
  });

  it("O-7: a verifier blocks until synced to the cited Grant version", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const grantEid = grantLocator(communityId, hex32(admin.pubkey));
    const v1 = await round(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const heads = new Map([[bytesToHex(grantEid), { version: 1n, hash: v1.selfHash }]]);

    // Behind the cited version: PARK (fail closed), don't honor on the strength
    // of the older Grant we happen to hold.
    expect(
      citationSatisfied({ heads, ownerHex: owner.pubkey }, communityId, admin.pubkey, {
        entityId: grantEid,
        version: 5n,
        editionHash: v1.selfHash,
      }),
    ).toBe(false);

    // "Synced AT LEAST that Grant": a LATER head satisfies the floor. (An
    // exact-version index would drop every edition citing a version a
    // compaction has since swept away.)
    const ahead = new Map([[bytesToHex(grantEid), { version: 9n, hash: random32() }]]);
    expect(
      citationSatisfied({ heads: ahead, ownerHex: owner.pubkey }, communityId, admin.pubkey, {
        entityId: grantEid,
        version: 1n,
        editionHash: v1.selfHash,
      }),
    ).toBe(true);
  });

  it("O-8: a cited-but-superseded Grant is dropped, never grandfathered", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const roleId = bytesToHex(random32());

    // Owner mints an Admin role and grants it. The admin renames the community
    // citing that Grant — honored while the Grant stands.
    const roleWrap = buildRoleEdition({ ...R_ADMIN, roleId }, { actorPubkey: owner.pubkey, version: 1n });
    const rolep = await round(roleWrap, control, owner);
    const g1 = await round(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const cite = { entityId: g1.entityId, version: 1n, editionHash: g1.selfHash };
    const rename = await round(
      buildMetadataEdition(communityId, { name: "Renamed", relays: [] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    expect(foldControlState([rolep, g1, rename], communityId, owner.pubkey).metadata?.name).toBe("Renamed");

    // The owner revokes at v2. The rename's citation is now a superseded Grant:
    // the actor's rank re-resolves against the CURRENT roster and the edition
    // drops — the old-but-once-valid citation grandfathers nothing.
    const g2 = await round(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: g1.selfHash }),
      control,
      owner,
    );
    expect(foldControlState([rolep, g1, g2, rename], communityId, owner.pubkey).metadata?.name).toBeUndefined();
  });

  it("O-9: edition_hash matches the length-prefixed domain-separated preimage", () => {
    // The golden vector, shared with Vector (and the retired concord-v1 tree).
    // Renaming the domain label or reordering the preimage re-hashes every
    // chain in existence, so this value is frozen.
    const h = editionHash(new Uint8Array(32).fill(0x11), 1n, undefined, new TextEncoder().encode("hello"));
    expect(bytesToHex(h)).toBe("2daf42e65a6bc259a4c99fac6df754a5d3d92310607cf13e2a1e8c94d42f6303");
  });

  it("O-10: content is hashed as exact wire bytes, never re-serialized", async () => {
    const { owner, communityId, control } = makeCommunity();
    const entityId = random32();
    // Two byte-different spellings of the SAME JSON object. A hash computed
    // over a re-serialization would collapse them; hashing the wire bytes
    // (what a compaction re-wrap preserves) keeps them distinct.
    const compact = '{"a":1,"b":2}';
    const spaced = '{ "a": 1, "b": 2 }';
    expect(JSON.parse(compact)).toEqual(JSON.parse(spaced));
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(bytesToHex(editionHash(entityId, 1n, undefined, enc(compact)))).not.toBe(
      bytesToHex(editionHash(entityId, 1n, undefined, enc(spaced))),
    );

    // And the hash a parsed edition reports is that of its own wire content.
    const opened = await round(
      buildEditionRumor({ vsk: "0", entityId: communityId, version: 1n, content: spaced, actorPubkey: owner.pubkey }),
      control,
      owner,
    );
    expect(bytesToHex(opened.selfHash)).toBe(bytesToHex(editionHash(communityId, 1n, undefined, enc(spaced))));
  });

  it("O-11: every entity coordinate is deterministic (the §1 table)", () => {
    const { owner, communityId } = makeCommunity();
    const o = { actorPubkey: owner.pubkey, version: 1n };
    const eid = (rumor: { tags: string[][] }) => tagOf(rumor, "eid")![1];
    const roleId = bytesToHex(random32());
    const channelId = random32();

    // Community metadata → the community_id itself.
    expect(eid(buildMetadataEdition(communityId, { name: "n", relays: [] }, o))).toBe(bytesToHex(communityId));
    // Role → its own role_id.
    expect(eid(buildRoleEdition({ ...R_ADMIN, roleId }, o))).toBe(roleId);
    // Channel metadata → the channel_id.
    expect(eid(buildChannelEdition(channelId, { name: "c", private: false }, o))).toBe(bytesToHex(channelId));
    // Grant → grant_locator(community_id, member).
    expect(eid(buildGrantEdition(communityId, { member: PLAIN, roleIds: [] }, o))).toBe(
      bytesToHex(grantLocator(communityId, hex32(PLAIN))),
    );
    // Banlist → banlist_locator(community_id).
    expect(eid(buildBanlistEdition(communityId, [], o))).toBe(bytesToHex(banlistLocator(communityId)));
    // Invite Registry → invite_links_locator(community_id, creator).
    expect(eid(buildRegistryEdition(communityId, PLAIN, [], o))).toBe(
      bytesToHex(inviteLinksLocator(communityId, hex32(PLAIN))),
    );
  });

  it("O-12: the fold takes the highest version whose chain is intact", () => {
    // Contiguous: the top of the chain.
    expect(fold([ed(1n, undefined, 1), ed(2n, 1, 2), ed(3n, 2, 3)], 0n)).toMatchObject({ head: 2, gap: false });
    // A hole: stop at the contiguous prefix and report the gap — never skip it.
    const holed = fold([ed(1n, undefined, 1), ed(3n, 2, 3)], 0n);
    expect(holed.head).toBe(0);
    expect(holed.gap).toBe(true);
    // Arrival order is not an input: relays serve arbitrary subsets in any order.
    const linked = (v: number) => ed(BigInt(v), v === 1 ? undefined : v - 1, v);
    expect(fold([linked(3), linked(1), linked(5), linked(2), linked(4)], 0n)).toMatchObject({ head: 2, gap: false });
  });

  it("O-13: refuse-to-downgrade — a lower version is ignored", async () => {
    // The pure rule: below the floor is skipped outright.
    expect(fold([ed(1n, undefined, 1), ed(2n, 1, 2)], 2n, new Uint8Array(32).fill(2))).toMatchObject({ head: 1, gap: false });

    // And the shape it takes on the wire, which is the spec's own example —
    // "a relay replaying a stale Grant or a lifted Ban is rejected". A client
    // that has folded the unban at v2 is served ONLY the v1 that banned.
    const { owner, communityId, control } = makeCommunity();
    const target = keypair();
    const b1 = await round(buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const b2 = await round(
      buildBanlistEdition(communityId, [], { actorPubkey: owner.pubkey, version: 2n, prevHash: b1.selfHash }),
      control,
      owner,
    );
    const synced = foldControlState([b1, b2], communityId, owner.pubkey);
    expect(synced.banned.has(target.pubkey)).toBe(false);

    // Replay the lifted ban alone. The stale edition must not be seated just
    // because it is the only one served: the entity SUSPENDS (fails closed for
    // that entity) and is refetched, rather than re-banning a member the owner
    // unbanned.
    const replayed = foldControlState([b1], communityId, owner.pubkey, synced.heads);
    expect(replayed.banned.has(target.pubkey)).toBe(false);
    expect(replayed.incomplete).toContain(bytesToHex(banlistLocator(communityId)));
  });

  it("O-14: same-version conflicts break by authority, then LOWER rumor id", () => {
    // The id half is the fold's own tiebreak (the authority half runs above it
    // in `authorizeDelegation`, and is covered by the grind-fork cases in
    // control.test.ts — a ground id cannot evict a superior's edition).
    const low = ed(1n, undefined, 1, 0x01);
    const high = ed(1n, undefined, 2, 0x02);
    expect(fold([high, low], 0n).head).toBe(1); // the lower id, whichever way they arrive
    expect(fold([low, high], 0n).head).toBe(0);
  });

  it("O-14c: a planted equal-version sibling cannot break the chain it sits on", () => {
    // The freeze this guards against. `tiebreakId` is the rumor id — a hash of
    // content the publisher chooses — so anyone able to publish at the control
    // address can mint junk at a tracking client's own head version with an id
    // that sorts below the real edition's. If the fold settled the per-version
    // winner by id BEFORE walking the chain, that junk became "the" edition at
    // the floor, its hash would not match the floor we recorded, the anchor
    // would fail, and every candidate above the floor would be dropped —
    // pinning the entity forever, on content that never faced an authority
    // gate. Siblings are carried instead, and the LINK picks the real one.
    const floorHash = new Uint8Array(32).fill(2);
    const real = ed(2n, 1, 2, 0xb0); // the head we already accepted
    const junk = ed(2n, 9, 9, 0x01); // same version, lower id, unrelated hashes
    const next = ed(3n, 2, 3); // links to `real`, not to `junk`

    const attacked = fold([junk, real, next], 2n, floorHash);
    expect(attacked.gap).toBe(false);
    expect(attacked.head).toBe(2); // advanced to v3
    // And identically whichever order the relay serves them in.
    expect(fold([real, junk, next], 2n, floorHash)).toMatchObject({ head: attacked.head, gap: attacked.gap });

    // A cold walk is protected the same way: the junk sibling at v1 has no
    // valid `prev === undefined` anchor, so the real v1 still anchors.
    const cold = fold([ed(1n, 7, 9, 0x01), ed(1n, undefined, 1, 0xb0), ed(2n, 1, 2)], 0n);
    expect(cold.gap).toBe(false);
    expect(cold.head).toBe(2);
  });

  it("O-14d: under a gap, a rival takes the floor's place only by winning the tiebreak against it", async () => {
    // The sibling of O-13. There, the replay was a LOWER version and was
    // refused by refuse-to-downgrade. Here it is the same version number
    // carrying different content — so refuse-to-downgrade never fires, and the
    // only thing standing between a tracking client and the fork is that the
    // surviving floor-version candidate be the edition we actually accepted.
    const { owner, communityId, control } = makeCommunity();
    const target = keypair();
    const b1 = await round(
      buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    // The settled v2 lifts the Ban; of nine such, the median id, so rivals fall on both sides of it.
    const lifts: ParsedEdition[] = [];
    for (let n = 0; n < 9; n++) {
      lifts.push(await round(
        buildBanlistEdition(communityId, [keypair().pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: b1.selfHash }),
        control,
        owner,
      ));
    }
    const b2 = lifts.sort((a, b) => (bytesToHex(a.rumorId) < bytesToHex(b.rumorId) ? -1 : 1))[4];
    const synced = foldControlState([b1, b2], communityId, owner.pubkey);
    expect(synced.banned.has(target.pubkey)).toBe(false);

    // Forks of the head: same entity, same version, same prev — different content,
    // so a different edition hash. Signed by the owner, so authority is equal and
    // only the tiebreak against the settled edition decides (CORD-04 §2): a rival
    // that loses it can't be swapped in by withholding; one that wins it would have
    // won had both been served.
    const forks: ParsedEdition[] = [];
    for (let n = 0; n < 24; n++) {
      forks.push(await round(
        buildBanlistEdition(communityId, [target.pubkey, ...Array.from({ length: n }, () => keypair().pubkey)], {
          actorPubkey: owner.pubkey,
          version: 2n,
          prevHash: b1.selfHash,
        }),
        control,
        owner,
      ));
    }
    const settledId = bytesToHex(b2.rumorId);
    const losing = forks.find((f) => bytesToHex(f.rumorId) > settledId)!;
    const winning = forks.find((f) => bytesToHex(f.rumorId) < settledId)!;
    expect(losing && winning, "random ids fall on both sides of the median").toBeTruthy();

    const attacked = foldControlState([losing], communityId, owner.pubkey, synced.heads);
    expect(attacked.banned.has(target.pubkey)).toBe(false);
    expect(attacked.incomplete).toContain(bytesToHex(banlistLocator(communityId)));
    const won = foldControlState([winning], communityId, owner.pubkey, synced.heads);
    expect(won.banned.has(target.pubkey)).toBe(true);

    // The genuine head, re-served alone, is still accepted: this must reject
    // forks, not every re-serve.
    const reserved = foldControlState([b2], communityId, owner.pubkey, synced.heads);
    expect(reserved.banned.has(target.pubkey)).toBe(false);
    expect(reserved.incomplete).not.toContain(bytesToHex(banlistLocator(communityId)));
  });

  it("O-14b: the tie-break never uses the author-settable timestamp", () => {
    // Same version, same everything but created_at — which an author picks
    // freely, so letting it decide would hand the fork to whoever lies best.
    const lowId = { ...ed(1n, undefined, 1, 0x01), createdAt: 9_999_999 };
    const highId = { ...ed(1n, undefined, 2, 0x02), createdAt: 1 };
    expect(fold([lowId, highId], 0n).head).toBe(0); // newest created_at, but lowest id
    expect(fold([highId, lowId], 0n).head).toBe(1); // oldest created_at loses anyway
  });

  it("O-15: an edition whose signer is not authorized is dropped", async () => {
    const { owner, communityId, control } = makeCommunity();
    const stranger = keypair();
    const mine = await round(
      buildMetadataEdition(communityId, { name: "Mine", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    // A group-key holder can WRITE to the plane (encryption is not authority),
    // so the drop has to happen at the fold: authority is rejection.
    const theirs = await round(
      buildMetadataEdition(communityId, { name: "Theirs", relays: [] }, { actorPubkey: stranger.pubkey, version: 2n, prevHash: mine.selfHash }),
      control,
      stranger,
    );
    expect(foldControlState([mine, theirs], communityId, owner.pubkey).metadata?.name).toBe("Mine");
  });

  it("O-16: a fresh joiner accepts the highest verified head despite a dangling prev", async () => {
    // After a compaction re-wraps each head into the new epoch, that head's
    // prev cites an edition that no longer exists there. A joiner starting from
    // nothing takes it: the signature plus current-authority is the whole test.
    const { owner, communityId, control } = makeCommunity();
    const dangling = await round(
      buildMetadataEdition(communityId, { name: "Compacted", relays: [] }, {
        actorPubkey: owner.pubkey,
        version: 4n,
        prevHash: random32(),
      }),
      control,
      owner,
    );
    const joiner = foldControlState([dangling], communityId, owner.pubkey); // no floor
    expect(joiner.metadata?.name).toBe("Compacted");

    // Same rule in the pure layer: bootstrap ignores contiguity and takes the top.
    const linked = (v: number) => ed(BigInt(v), v === 1 ? undefined : v - 1, v);
    const holed = [1, 2, 3, 4, 6, 7].map(linked);
    expect(holed[bootstrapHead(holed, 0n)!].version).toBe(7n);
  });

  it("O-17: a tracking client treats an unresolvable prev as a gap and suspends that entity", async () => {
    const { owner, communityId, control } = makeCommunity();
    const v1 = await round(
      buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const tracking = foldControlState([v1], communityId, owner.pubkey);
    expect(tracking.metadata?.name).toBe("Real");

    // A hostile relay withholds the middle and serves a higher DANGLING head.
    const v3 = await round(
      buildMetadataEdition(communityId, { name: "Hijacked", relays: [] }, {
        actorPubkey: owner.pubkey,
        version: 3n,
        prevHash: random32(),
      }),
      control,
      owner,
    );
    const held = foldControlState([v1, v3], communityId, owner.pubkey, tracking.heads);
    expect(held.metadata?.name).toBe("Real"); // holds at last-known-good
    expect(held.heads.get(bytesToHex(communityId))?.version).toBe(1n);
    expect(held.incomplete).toContain(bytesToHex(communityId)); // …and refetches
  });
});

// ── §2 The Roster ────────────────────────────────────────────────────────────

describe("CORD-04 §2 — The Roster", () => {
  it("O-18: a Role's wire object carries role_id, name, position, permissions, scope, color", () => {
    const channelId = bytesToHex(random32());
    const scoped: Role = { ...R_MOD, scope: { kind: "channel", channelId } };
    expect(JSON.parse(roleToJSON(scoped))).toEqual({
      role_id: R_MOD.roleId,
      name: R_MOD.name,
      position: R_MOD.position,
      permissions: R_MOD.permissions.toString(),
      scope: { kind: "channel", channel_id: channelId },
      color: 0,
    });
    expect(roleFromJSON(roleToJSON(scoped))).toEqual(scoped);

    // Read as Vector's serde reads it: name, scope, position and permissions are
    // required, colour defaults, and a field of the wrong type refuses the Role.
    const wire = JSON.parse(roleToJSON(scoped)) as Record<string, unknown>;
    expect(roleFromJSON(JSON.stringify({ ...wire, color: undefined }))).toMatchObject({ color: 0 });
    expect(roleFromJSON(JSON.stringify({ ...wire, name: undefined }))).toBeUndefined();
    expect(roleFromJSON(JSON.stringify({ ...wire, scope: undefined }))).toBeUndefined();
    expect(roleFromJSON(JSON.stringify({ ...wire, role_id: "nothex" }))).toBeUndefined();
    expect(roleFromJSON(JSON.stringify({ ...wire, permissions: {} }))).toBeUndefined();
    expect(roleFromJSON(JSON.stringify({ ...wire, position: 1.5 }))).toBeUndefined();
  });

  it("an edit round-trips the fields of a legacy Role it doesn't understand (CORD-02 §6)", () => {
    const wire = { ...(JSON.parse(roleToJSON(R_MOD)) as Record<string, unknown>), icon: "🛡", rules: { slowmode: 5 } };
    const read = roleFromJSON(JSON.stringify(wire));
    expect(read?.extra).toEqual({ icon: "🛡", rules: { slowmode: 5 } });
    const renamed = JSON.parse(roleToJSON({ ...read!, name: "Wardens" })) as Record<string, unknown>;
    expect(renamed).toEqual({ ...wire, name: "Wardens" });
    // A foreign field can't override one Armada writes.
    expect(JSON.parse(roleToJSON({ ...R_MOD, extra: { name: "spoof", position: 99 } }))).toMatchObject({ name: R_MOD.name, position: R_MOD.position });
  });

  it("O-19: a Grant maps member -> role_ids; empty role_ids is a revoke", async () => {
    expect(JSON.parse(grantToJSON({ member: PLAIN, roleIds: [R_MOD.roleId] }))).toEqual({
      member: PLAIN,
      role_ids: [R_MOD.roleId],
    });
    expect(grantFromJSON(JSON.stringify({ member: PLAIN, role_ids: [] }))).toEqual({ member: PLAIN, roleIds: [] });

    // Empty role_ids is not a no-op edition, it is the revoke: the member's
    // rank is gone from the folded roster.
    const { owner, communityId, control } = makeCommunity();
    const member = keypair();
    const roleId = bytesToHex(random32());
    const roleEd = await round(buildRoleEdition({ ...R_MOD, roleId }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const granted = await round(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const withRole = foldControlState([roleEd, granted], communityId, owner.pubkey);
    expect(highestPosition(withRole.roster, member.pubkey)).toBe(R_MOD.position);

    const revoked = await round(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: granted.selfHash }),
      control,
      owner,
    );
    const after = foldControlState([roleEd, granted, revoked], communityId, owner.pubkey);
    expect(highestPosition(after.roster, member.pubkey)).toBeUndefined();
    expect(effectivePermissions(after.roster, member.pubkey)).toBe(0n);
  });

  it("O-20: a Grant is honored only if its signer outranks EVERY Role it hands out", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const target = keypair();
    const adminRoleId = bytesToHex(random32());
    const peerRoleId = bytesToHex(random32());
    const lowerRoleId = bytesToHex(random32());
    const o = (version: bigint, prevHash?: Uint8Array) => ({ actorPubkey: owner.pubkey, version, prevHash });

    // Owner mints an Admin (position 1), a PEER of it (also position 1), and a
    // lower role (position 5), then grants Admin to `admin`.
    const rAdmin = await round(buildRoleEdition({ ...R_ADMIN, roleId: adminRoleId }, o(1n)), control, owner);
    const rPeer = await round(buildRoleEdition({ ...R_ADMIN, roleId: peerRoleId, name: "peer" }, o(1n)), control, owner);
    const rLower = await round(buildRoleEdition({ ...R_MOD, roleId: lowerRoleId }, o(1n)), control, owner);
    const gAdmin = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adminRoleId] }, o(1n)), control, owner);
    const cite = { entityId: gAdmin.entityId, version: 1n, editionHash: gAdmin.selfHash };

    // The admin hands out the LOWER role: honored (they strictly outrank it).
    const ok = await round(
      buildGrantEdition(communityId, { member: target.pubkey, roleIds: [lowerRoleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const honored = foldControlState([rAdmin, rPeer, rLower, gAdmin, ok], communityId, owner.pubkey);
    expect(highestPosition(honored.roster, target.pubkey)).toBe(R_MOD.position);

    // The admin hands out a PEER of their own rank: dropped. Equal cannot act
    // on equal, so a position-1 admin can never mint another position-1 admin.
    const overreach = await round(
      buildGrantEdition(communityId, { member: target.pubkey, roleIds: [peerRoleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const dropped = foldControlState([rAdmin, rPeer, rLower, gAdmin, overreach], communityId, owner.pubkey);
    expect(highestPosition(dropped.roster, target.pubkey)).toBeUndefined();

    // EVERY role, not merely one of them: a grant bundling the allowed role
    // with the peer role is dropped whole, never partially applied.
    const bundled = await round(
      buildGrantEdition(communityId, { member: target.pubkey, roleIds: [lowerRoleId, peerRoleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const both = foldControlState([rAdmin, rPeer, rLower, gAdmin, bundled], communityId, owner.pubkey);
    expect(highestPosition(both.roster, target.pubkey)).toBeUndefined();
  });

  it("O-21: a role name caps at 64 bytes of UTF-8", () => {
    const ok = { ...role("1".repeat(64), 3), name: "a".repeat(NAME_MAX_BYTES) };
    expect(() => buildRoleEdition(ok, editionOpts)).not.toThrow();

    const tooLong = { ...ok, name: "a".repeat(NAME_MAX_BYTES + 1) };
    expect(() => buildRoleEdition(tooLong, editionOpts)).toThrow(/64 bytes/);

    // The cap is BYTES, not characters: a 4-byte emoji blows it at 16 glyphs.
    const multibyte = { ...ok, name: "🚢".repeat(17) };
    expect(() => buildRoleEdition(multibyte, editionOpts)).toThrow(/64 bytes/);
  });

  it("O-22b: a Banlist edition past 500 npubs is refused before it is built (Vector `validate_banlist`)", () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, "0"));
    const cid = random32();
    expect(() => buildBanlistEdition(cid, keys(MAX_BANLIST), editionOpts)).not.toThrow();
    expect(() => buildBanlistEdition(cid, keys(MAX_BANLIST + 1), editionOpts)).toThrow(/at most 500/);
  });

  it("O-22: a member holds at most 64 Roles — a longer grant is truncated on read", () => {
    const ids = Array.from({ length: MAX_ROLES_PER_MEMBER + 10 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const parsed = grantFromJSON(JSON.stringify({ member: PLAIN, role_ids: ids }));
    expect(parsed?.roleIds).toHaveLength(MAX_ROLES_PER_MEMBER);
  });

  it("O-20a (publish side): this client refuses to BUILD a Grant its verifiers would drop", () => {
    // The fold-side rule (O-20) means a non-conforming Grant is dropped
    // network-wide; a conforming client therefore fails the publish at its
    // author with a reason, instead of reporting success on an edition
    // nobody will honor.
    // The owner's grants are always admitted — including one targeting the
    // owner (cosmetic self-grant, CORD.md Role Display).
    expect(grantRefusal(roster, OWNER, OWNER, OWNER, [R_MOD.roleId])).toBeUndefined();
    expect(grantRefusal(roster, OWNER, OWNER, PLAIN, [R_ADMIN.roleId])).toBeUndefined();
    // An admin may grant a role they outrank to a member they outrank…
    expect(grantRefusal(roster, ADMIN, OWNER, PLAIN, [R_MOD.roleId])).toBeUndefined();
    // …but nobody but the owner targets the owner,
    expect(grantRefusal(roster, ADMIN, OWNER, OWNER, [R_MOD.roleId])).toMatch(/outrank/i);
    // an equal cannot act on an equal (the admin's own rank is 1),
    expect(grantRefusal(roster, ADMIN, OWNER, PLAIN, [R_ADMIN.roleId])).toMatch(/outrank/i);
    // a mod cannot edit an admin,
    expect(grantRefusal(roster, MOD, OWNER, ADMIN, [R_MOD.roleId])).toMatch(/outrank/i);
    // and a role the roster doesn't know can't be judged, so it can't be granted.
    expect(grantRefusal(roster, ADMIN, OWNER, PLAIN, ["9".repeat(64)])).toBeTruthy();
  });

  it("O-23: a Community folds the 100 LOWEST role_ids and ignores the rest", async () => {
    const { owner, communityId, control } = makeCommunity();
    const member = keypair();
    // 105 owner-minted roles, ids spread so the cut is unambiguous.
    const ids = Array.from({ length: MAX_ROLES_PER_COMMUNITY + 5 }, (_, i) => i.toString(16).padStart(64, "0"));
    const roleEds = await Promise.all(
      ids.map((roleId) => round(buildRoleEdition({ ...R_MOD, roleId }, { actorPubkey: owner.pubkey, version: 1n }), control, owner)),
    );
    const sorted = [...ids].sort();
    const kept = new Set(sorted.slice(0, MAX_ROLES_PER_COMMUNITY));
    const evicted = sorted[MAX_ROLES_PER_COMMUNITY]; // the lowest id that does NOT fit

    // Grant the member one kept role and the evicted one.
    const grant = await round(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [sorted[0], evicted] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const folded = foldControlState([...roleEds, grant], communityId, owner.pubkey);

    expect(folded.roster.roles).toHaveLength(MAX_ROLES_PER_COMMUNITY);
    expect(folded.roster.roles.every((r) => kept.has(r.roleId))).toBe(true);
    expect(roleById(folded.roster, evicted)).toBeUndefined();
    // The cap is applied after the delegation fixpoint settles, so the grant
    // still NAMES the evicted role — it just confers nothing, because a role
    // outside the fold is a role that does not exist.
    expect(rolesOf(folded.roster, member.pubkey).map((r) => r.roleId)).toEqual([sorted[0]]);
    // 105 sealed rounds is ~2s of real signing alone; under a full parallel
    // suite run that regularly blows the 5s default.
  }, 20_000);

  it("O-24: the Roster is owner-rooted — an entry not tracing to the owner is not authority", async () => {
    const { owner, communityId, control } = makeCommunity();
    const stranger = keypair();
    const roleId = bytesToHex(random32());

    // A group-key holder mints a perfectly well-formed Admin role and grants it
    // to themselves. Every signature verifies; nothing traces to the owner.
    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, { actorPubkey: stranger.pubkey, version: 1n }), control, stranger);
    const selfGrant = await round(
      buildGrantEdition(communityId, { member: stranger.pubkey, roleIds: [roleId] }, { actorPubkey: stranger.pubkey, version: 1n }),
      control,
      stranger,
    );
    const folded = foldControlState([role, selfGrant], communityId, owner.pubkey);
    expect(folded.roster.roles).toHaveLength(0);
    expect(effectivePermissions(folded.roster, stranger.pubkey)).toBe(0n);

    // …and the authority it would have conferred is therefore absent: the
    // stranger's rename is dropped with it.
    const rename = await round(
      buildMetadataEdition(communityId, { name: "Seized", relays: [] }, { actorPubkey: stranger.pubkey, version: 1n }),
      control,
      stranger,
    );
    expect(foldControlState([role, selfGrant, rename], communityId, owner.pubkey).metadata).toBeUndefined();
  });

  it("O-25: the owner is proven by the community_id, sits at position 0, and is unremovable", async () => {
    const owner = keypair();
    const ownerSalt = random32();
    const communityId = communityIdOf(hex32(owner.pubkey), ownerSalt);
    const control = controlGroupKey(random32(), communityId, 0);

    // Proven, not asserted: the id commits to (owner, salt), so an impostor
    // cannot claim ownership of someone else's community.
    expect(verifyCommunityId(bytesToHex(communityId), owner.pubkey, bytesToHex(ownerSalt))).toBe(true);
    expect(verifyCommunityId(bytesToHex(communityId), PLAIN, bytesToHex(ownerSalt))).toBe(false);

    // Position 0 without holding any Role: supremacy comes from the id, not the
    // fold, so it holds even against an empty or unloaded roster.
    const empty = emptyRoles();
    expect(outranks(empty, owner.pubkey, owner.pubkey, 1)).toBe(true);
    expect(canActOnMember(empty, owner.pubkey, owner.pubkey, PLAIN, Permissions.BAN)).toBe(true);
    // …and is never a valid target, so no rank can act on them.
    expect(canActOnMember(roster, ADMIN, owner.pubkey, owner.pubkey, Permissions.BAN)).toBe(false);

    // Unremovable in the fold too: an authorized ban naming the owner neither
    // bans them nor strips their editions.
    const admin = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });
    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const grant = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, o(1n)), control, owner);
    const cite = { entityId: grant.entityId, version: 1n, editionHash: grant.selfHash };
    const banOwner = await round(
      buildBanlistEdition(communityId, [owner.pubkey], { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const named = await round(
      buildMetadataEdition(communityId, { name: "Still Mine", relays: [] }, o(1n)),
      control,
      owner,
    );
    const folded = foldControlState([role, grant, banOwner, named], communityId, owner.pubkey);
    expect(folded.banned.has(owner.pubkey)).toBe(false);
    expect(folded.metadata?.name).toBe("Still Mine");
  });
});

// ── §3 Permissions and Position ──────────────────────────────────────────────

describe("CORD-04 §3 — Permissions and Position", () => {
  it("O-26: effective permissions are the UNION of the member's Roles' bits", () => {
    const multi: CommunityRoles = {
      roles: [R_ADMIN, R_MOD],
      grants: [{ member: PLAIN, roleIds: [R_ADMIN.roleId, R_MOD.roleId] }],
    };
    expect(effectivePermissions(multi, PLAIN)).toBe(ADMIN_ALL | R_MOD.permissions);
  });

  it("O-27: the bit positions are FROZEN", () => {
    // Changing any of these re-labels every prior edition's authority.
    expect(Permissions.MANAGE_ROLES).toBe(1n << 0n);
    expect(Permissions.MANAGE_CHANNELS).toBe(1n << 1n);
    expect(Permissions.MANAGE_METADATA).toBe(1n << 2n);
    expect(Permissions.KICK).toBe(1n << 3n);
    expect(Permissions.BAN).toBe(1n << 4n);
    expect(Permissions.MANAGE_MESSAGES).toBe(1n << 5n);
    expect(Permissions.CREATE_INVITE).toBe(1n << 6n);
    expect(Permissions.VIEW_AUDIT_LOG).toBe(1n << 8n);
    expect(Permissions.MENTION_EVERYONE).toBe(1n << 9n);
  });

  it("O-27b: bit 1<<7 is RETIRED and never reused", () => {
    expect(Object.values(Permissions)).not.toContain(1n << 7n);
    expect(permsContain(ADMIN_ALL, 1n << 7n)).toBe(false);
  });

  it("O-28: there is no all-powerful bit — ADMIN_ALL does not inherit future bits", () => {
    // "a Role granted everything today does not inherit a permission added
    // tomorrow." Still-RESERVED bits must not already be held. 1<<11 was
    // reserved for PIN_MESSAGES and is now claimed (§7), so it belongs to the
    // management union a NEW Admin is minted with — which grants nothing
    // retroactively, since a published Role carries its own frozen bitmask.
    expect(permsContain(ADMIN_ALL, 1n << 10n)).toBe(false); // MANAGE_EMOJI
    expect(permsContain(ADMIN_ALL, 1n << 12n)).toBe(false); // MANAGE_EVENTS
    expect(permsContain(ADMIN_ALL, 1n << 13n)).toBe(false);
    // The claimed bit IS held by a fresh Admin, and a Role minted before it
    // existed still does not hold it.
    expect(permsContain(ADMIN_ALL, Permissions.PIN_MESSAGES)).toBe(true);
    const legacyAdmin = role("e".repeat(64), 1, ADMIN_ALL & ~Permissions.PIN_MESSAGES);
    expect(permsContain(legacyAdmin.permissions, Permissions.PIN_MESSAGES)).toBe(false);
  });

  it("O-28b: every ENFORCED permission is grantable — no bit without a checkbox", () => {
    // A permission this client enforces but the role editor cannot offer is a
    // permission only the OWNER can ever exercise, since owners bypass the bit
    // check entirely. Claiming a bit and forgetting its label ships exactly
    // that, silently.
    //
    // VIEW_AUDIT_LOG is deliberately exempt: it is declared for wire
    // compatibility but gated nowhere in this client (the audit log is open to
    // every member), so a checkbox would promise an enforcement that does not
    // exist. It belongs on the list the day something reads it.
    const UNENFORCED = new Set<bigint>([Permissions.VIEW_AUDIT_LOG]);
    const labelled = new Set(PERMISSION_LABELS.map((l) => l.bit));
    for (const [name, bit] of Object.entries(Permissions)) {
      if (UNENFORCED.has(bit)) continue;
      expect(labelled.has(bit), `${name} is enforced but has no PERMISSION_LABELS entry, so nobody can be granted it`).toBe(true);
    }
  });

  it("O-29: permissions ride the wire as a DECIMAL STRING, and a number still reads", () => {
    // A JSON number is a 64-bit float in JS and corrupts past 2^53.
    const big = role("d".repeat(64), 4, (1n << 62n) | Permissions.BAN);
    const wire = JSON.parse(roleToJSON(big)) as Record<string, unknown>;
    expect(typeof wire.permissions).toBe("string");
    expect(wire.permissions).toBe(big.permissions.toString());
    expect(roleFromJSON(roleToJSON(big))?.permissions).toBe(big.permissions);

    // A reader accepts the legacy number form from an older edition.
    const legacy = roleFromJSON(JSON.stringify({ ...wire, permissions: 24 }));
    expect(legacy?.permissions).toBe(24n);
  });

  it("O-30/O-31: rank is the LOWEST position among a member's Roles; roleless is last", () => {
    expect(highestPosition(roster, ADMIN)).toBe(1);
    expect(highestPosition(roster, MOD)).toBe(5);
    // Roleless: no rank at all, and effectively last for every comparison.
    expect(highestPosition(roster, PLAIN)).toBeUndefined();
    expect(outranks(roster, PLAIN, OWNER, 5)).toBe(false);
    expect(canActOnMember(roster, ADMIN, OWNER, PLAIN, Permissions.MANAGE_ROLES)).toBe(true);
  });

  it("O-32: an actor must hold the bit AND strictly outrank — equal cannot act on equal", () => {
    const peers: CommunityRoles = {
      roles: [R_ADMIN],
      grants: [
        { member: ADMIN, roleIds: [R_ADMIN.roleId] },
        { member: MOD, roleIds: [R_ADMIN.roleId] },
      ],
    };
    // Same position: neither may act on the other.
    expect(canActOnMember(peers, ADMIN, OWNER, MOD, Permissions.MANAGE_ROLES)).toBe(false);
    // Holding the rank without the bit is not authority either.
    expect(canActOnPosition(roster, MOD, OWNER, 9, Permissions.MANAGE_ROLES)).toBe(false);
    // The owner is supreme, and is never a valid target.
    expect(canActOnPosition(roster, OWNER, OWNER, 1, Permissions.MANAGE_ROLES)).toBe(true);
    expect(canActOnMember(roster, ADMIN, OWNER, OWNER, Permissions.MANAGE_ROLES)).toBe(false);
  });

  it("O-33: no edition may claim a position at or above its own SIGNER", () => {
    // The rule that makes self-promotion impossible. A minted Role must sit
    // strictly below the rank of whoever signs it, so the position a client
    // may mint at is a function of the signer's rank — never a constant.
    expect(mintablePosition(roster, OWNER, OWNER)).toBe(1); // owner is position 0
    expect(mintablePosition(roster, ADMIN, OWNER)).toBe(2); // admin at 1 -> 2
    expect(mintablePosition(roster, MOD, OWNER)).toBe(6); // mod at 5 -> 6

    // A signer with NO rank cannot mint any Role: a roleless member is
    // effectively last, so every position is at or above them. Defaulting
    // such a signer to rank 0 mints an edition every verifier drops, and the
    // minting client sees success.
    expect(mintablePosition(roster, PLAIN, OWNER)).toBeUndefined();

    // Same for an unresolved roster (the fold has not loaded yet) — absence
    // of evidence of rank is not evidence of supremacy.
    expect(mintablePosition(undefined, ADMIN, OWNER)).toBeUndefined();
  });

  it("O-34: no Role may EVER claim position 0 — that is the owner's alone", () => {
    // "no Role may ever claim position 0, or an owner could create a peer
    // nobody outranks." Refused at build time, like the name cap.
    expect(() => buildRoleEdition(role("e".repeat(64), 0), editionOpts)).toThrow(/position/i);
    expect(() => buildRoleEdition(role("e".repeat(64), 1), editionOpts)).not.toThrow();
  });

  it("O-35: two Roles MAY share a position; a display list breaks the tie by LOWER role_id", () => {
    const aa = role("aa".repeat(32), 2);
    const bb = role("bb".repeat(32), 2);
    expect([bb, aa].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([aa.roleId, bb.roleId]);
    expect([aa, bb].sort(byDisplayOrder).map((r) => r.roleId)).toEqual([aa.roleId, bb.roleId]);
    // Lower position still wins over the id tie-break.
    expect([bb, role("00".repeat(32), 1)].sort(byDisplayOrder)[0].position).toBe(1);
  });
});

// ── §4 The Banlist ───────────────────────────────────────────────────────────

describe("CORD-04 §4 — The Banlist", () => {
  it("O-36: the Banlist is one community-wide entity at banlist_locator(community_id)", async () => {
    const { owner, communityId, control } = makeCommunity();
    const a = keypair();
    const b = keypair();
    const eid = bytesToHex(banlistLocator(communityId));

    // Two different admins banning two different members do NOT get an entity
    // each: both editions land on the one community-wide coordinate, which is
    // why they collide and why §4 needs re-heal at all.
    const first = await round(buildBanlistEdition(communityId, [a.pubkey], { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const second = await round(
      buildBanlistEdition(communityId, [a.pubkey, b.pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: first.selfHash }),
      control,
      owner,
    );
    expect(bytesToHex(first.entityId)).toBe(eid);
    expect(bytesToHex(second.entityId)).toBe(eid);

    const folded = foldControlState([first, second], communityId, owner.pubkey);
    expect(folded.heads.get(eid)?.version).toBe(2n);
    expect([...folded.banned].sort()).toEqual([a.pubkey, b.pubkey].sort());
  });

  it("O-37: its content is the whole list, replaced entire on every edit", async () => {
    const { owner, communityId, control } = makeCommunity();
    const a = keypair();
    const b = keypair();
    const v1 = await round(buildBanlistEdition(communityId, [a.pubkey], { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    // v2 names only B. It is a replacement, not a delta, so A is unbanned by
    // omission — the exact collision §4's re-heal exists to repair.
    const v2 = await round(
      buildBanlistEdition(communityId, [b.pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: v1.selfHash }),
      control,
      owner,
    );
    const folded = foldControlState([v1, v2], communityId, owner.pubkey);
    expect(folded.banned.has(b.pubkey)).toBe(true);
    expect(folded.banned.has(a.pubkey)).toBe(false);
  });

  it("O-38: a Banlist edition is honored only if its signer holds BAN", async () => {
    const { owner, communityId, control } = makeCommunity();
    const roleKeeper = keypair();
    const target = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });

    // A role with MANAGE_ROLES but NOT BAN, granted to `roleKeeper`.
    const role = await round(
      buildRoleEdition({ ...R_MOD, roleId, permissions: Permissions.MANAGE_ROLES }, o(1n)),
      control,
      owner,
    );
    const grant = await round(buildGrantEdition(communityId, { member: roleKeeper.pubkey, roleIds: [roleId] }, o(1n)), control, owner);
    const cite = { entityId: grant.entityId, version: 1n, editionHash: grant.selfHash };
    const ban = await round(
      buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: roleKeeper.pubkey, version: 1n, authority: cite }),
      control,
      roleKeeper,
    );

    // Fail closed: an unauthorized head leaves the banlist EMPTY rather than
    // seating the attacker's list.
    const folded = foldControlState([role, grant, ban], communityId, owner.pubkey);
    expect(folded.banned.size).toBe(0);
  });

  it("O-39: every event from a banned npub is dropped — message, reaction, edit, authority", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });

    // A real admin (MANAGE_METADATA), who renames the community…
    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const grant = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, o(1n)), control, owner);
    const cite = { entityId: grant.entityId, version: 1n, editionHash: grant.selfHash };
    const rename = await round(
      buildMetadataEdition(communityId, { name: "By Admin", relays: [] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    expect(foldControlState([role, grant, rename], communityId, owner.pubkey).metadata?.name).toBe("By Admin");

    // …and is then banned by the owner. The AUTHORITY half of "every event":
    // their editions drop wholesale, not merely their future ones.
    const ban = await round(buildBanlistEdition(communityId, [admin.pubkey], o(1n)), control, owner);
    const folded = foldControlState([role, grant, rename, ban], communityId, owner.pubkey);
    expect(folded.banned.has(admin.pubkey)).toBe(true);
    expect(folded.metadata?.name).toBeUndefined();
    // (The message/reaction/edit half runs in the chat fold, which skips any
    // event whose author is in this same set — chat.ts `moderation.banned`.)
  });

  // NOT IMPLEMENTED (not merely unverified): nothing bounds a Banlist edition
  // against its NIP-44 envelope. `useModeration.ban` publishes the whole list
  // unchecked, so past the ~500-npub ceiling the edit fails at the relay (or
  // worse, silently truncates a plane read) instead of being refused with a
  // reason at its author.
  it.todo("O-40: a client refuses a Banlist edit that would not fit its NIP-44 envelope");
  // NOT IMPLEMENTED: `useModeration.ban` publishes the banlist and stops. Two
  // admins banning different members at the same version means one addition is
  // dropped until someone re-applies it by hand; §4 requires re-folding after
  // the publish and re-applying an addition that lost.
  it.todo("O-41: re-heal — after publishing, re-fold and re-apply an addition that lost");
});

// ── §5 Authorizing an Action ─────────────────────────────────────────────────

describe("CORD-04 §5 — Authorizing an Action", () => {
  it("O-42: the seal is verified first, learning the actor's real npub", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const opened = await round(
      buildMetadataEdition(communityId, { name: "n", relays: [] }, { actorPubkey: admin.pubkey, version: 1n }),
      control,
      admin,
    );
    // The wrap is signed by the stream key every member holds; authorship is
    // the SEAL's signature inside it. Reading the actor off the wrap would make
    // every member indistinguishable from every other.
    expect(opened.author).toBe(admin.pubkey);
    expect(opened.author).not.toBe(control.pk); // the wrap signer, not the actor
    expect(opened.author).not.toBe(owner.pubkey);
  });

  it("O-43: the Roster is folded and the actor's permissions/position resolved", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });
    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const grant = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, o(1n)), control, owner);

    const { roster } = foldControlState([role, grant], communityId, owner.pubkey);
    expect(effectivePermissions(roster, admin.pubkey)).toBe(ADMIN_ALL);
    expect(highestPosition(roster, admin.pubkey)).toBe(R_ADMIN.position);
  });

  it("O-44: the actor must hold the bit and strictly outrank, traced to the owner", () => {
    // Both halves are required, and neither substitutes for the other.
    expect(canActOnMember(roster, MOD, OWNER, PLAIN, Permissions.KICK)).toBe(true);
    expect(canActOnMember(roster, MOD, OWNER, PLAIN, Permissions.BAN)).toBe(false); // rank, no bit
    expect(canActOnMember(roster, ADMIN, OWNER, ADMIN, Permissions.KICK)).toBe(false); // bit, no rank over a peer
    // This predicate judges a roster it is HANDED; "traced to the owner" is
    // enforced upstream, when the fold decides which Roles and Grants enter
    // that roster at all (O-24). Handed nothing, it grants nothing — which is
    // why an unresolved fold must never be passed as an empty one.
    expect(canActOnMember(emptyRoles(), ADMIN, OWNER, PLAIN, Permissions.KICK)).toBe(false);
  });

  it("O-45/O-46: an unsynced OR hash-mismatched citation parks the action alike", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });
    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const grant = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, o(1n)), control, owner);

    const rename = async (authority: { entityId: Uint8Array; version: bigint; editionHash: Uint8Array }) =>
      round(
        buildMetadataEdition(communityId, { name: "Renamed", relays: [] }, { actorPubkey: admin.pubkey, version: 1n, authority }),
        control,
        admin,
      );
    const nameAfter = (edition: Awaited<ReturnType<typeof rename>>) =>
      foldControlState([role, grant, edition], communityId, owner.pubkey).metadata?.name;

    // The honest citation resolves.
    expect(nameAfter(await rename({ entityId: grant.entityId, version: 1n, editionHash: grant.selfHash }))).toBe("Renamed");
    // A version we haven't synced to parks…
    expect(nameAfter(await rename({ entityId: grant.entityId, version: 99n, editionHash: grant.selfHash }))).toBeUndefined();
    // …and a HASH that isn't the edition we hold at that version parks
    // identically, so a forged or forked citation never resolves.
    expect(nameAfter(await rename({ entityId: grant.entityId, version: 1n, editionHash: random32() }))).toBeUndefined();
  });

  it("O-47/O-48: parking is per-action — reads and other actors are unaffected", async () => {
    const { owner, communityId, control } = makeCommunity();
    const good = keypair();
    const absurd = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });

    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const gGood = await round(buildGrantEdition(communityId, { member: good.pubkey, roleIds: [roleId] }, o(1n)), control, owner);
    const gAbsurd = await round(buildGrantEdition(communityId, { member: absurd.pubkey, roleIds: [roleId] }, o(1n)), control, owner);

    const chGood = random32();
    const chAbsurd = random32();
    const goodChannel = await round(
      buildChannelEdition(chGood, { name: "good", private: false }, {
        actorPubkey: good.pubkey,
        version: 1n,
        authority: { entityId: gGood.entityId, version: 1n, editionHash: gGood.selfHash },
      }),
      control,
      good,
    );
    // A citation naming a version that will never resolve.
    const parkedChannel = await round(
      buildChannelEdition(chAbsurd, { name: "parked", private: false }, {
        actorPubkey: absurd.pubkey,
        version: 1n,
        authority: { entityId: gAbsurd.entityId, version: 4_000_000n, editionHash: gAbsurd.selfHash },
      }),
      control,
      absurd,
    );
    const named = await round(buildMetadataEdition(communityId, { name: "Fine", relays: [] }, o(1n)), control, owner);

    const folded = foldControlState([role, gGood, gAbsurd, goodChannel, parkedChannel, named], communityId, owner.pubkey);
    // The absurd citation griefs nobody but its own author…
    expect(folded.channels.has(bytesToHex(chAbsurd))).toBe(false);
    expect(folded.channels.get(bytesToHex(chGood))?.name).toBe("good");
    // …and reads never block: the rest of the plane paints normally.
    expect(folded.metadata?.name).toBe("Fine");
    expect(folded.roster.roles).toHaveLength(1);
  });
});

// ── §6 The Three Removals ────────────────────────────────────────────────────

describe("CORD-04 §6 — The Three Removals", () => {
  it("O-49: Role Removal strips the Grant; pending vac citations die with it", async () => {
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint, prevHash?: Uint8Array) => ({ actorPubkey: owner.pubkey, version, prevHash });

    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const grant = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, o(1n)), control, owner);
    const cite = { entityId: grant.entityId, version: 1n, editionHash: grant.selfHash };

    // Two actions by the admin, both citing that one Grant.
    const channelId = random32();
    const channel = await round(
      buildChannelEdition(channelId, { name: "theirs", private: false }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const rename = await round(
      buildMetadataEdition(communityId, { name: "Theirs", relays: [] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const live = foldControlState([role, grant, channel, rename], communityId, owner.pubkey);
    expect(live.channels.get(bytesToHex(channelId))?.name).toBe("theirs");
    expect(live.metadata?.name).toBe("Theirs");

    // The strip: a Grant edition with empty role_ids. They remain a MEMBER —
    // this removes authority only — but every citation of the dead Grant dies
    // with it, both of them, not just the ones published after.
    const strip = await round(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, o(2n, grant.selfHash)),
      control,
      owner,
    );
    const stripped = foldControlState([role, grant, strip, channel, rename], communityId, owner.pubkey);
    expect(highestPosition(stripped.roster, admin.pubkey)).toBeUndefined();
    expect(stripped.channels.has(bytesToHex(channelId))).toBe(false);
    expect(stripped.metadata?.name).toBeUndefined();
    // …and they are NOT banned by it: Role Removal is the lightest removal.
    expect(stripped.banned.has(admin.pubkey)).toBe(false);
  });

  it("O-52: each layer validates independently — a partial removal degrades, never breaks", async () => {
    // The Banlist lands but the Grant strip is lost in flight. The result must
    // be a WEAKER removal (silenced, still ranked on paper), never a broken
    // one — so the ban alone still drops every edition of theirs.
    const { owner, communityId, control } = makeCommunity();
    const admin = keypair();
    const roleId = bytesToHex(random32());
    const o = (version: bigint) => ({ actorPubkey: owner.pubkey, version });

    const role = await round(buildRoleEdition({ ...R_ADMIN, roleId }, o(1n)), control, owner);
    const grant = await round(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [roleId] }, o(1n)), control, owner);
    const cite = { entityId: grant.entityId, version: 1n, editionHash: grant.selfHash };
    const rename = await round(
      buildMetadataEdition(communityId, { name: "Theirs", relays: [] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
      control,
      admin,
    );
    const ban = await round(buildBanlistEdition(communityId, [admin.pubkey], o(1n)), control, owner);

    // Banlist only — the Grant still stands in the served set.
    const partial = foldControlState([role, grant, rename, ban], communityId, owner.pubkey);
    expect(partial.banned.has(admin.pubkey)).toBe(true);
    expect(partial.metadata?.name).toBeUndefined(); // silenced regardless of the un-stripped Grant
  });

  // Covered outside the ledger, in the layers that own them: the Kick's
  // KICK-bit-and-outrank gate is `canKick` in guestbook.ts (guestbook.test.ts),
  // and the Ban's Banlist → strip → Refounding ordering is the phased
  // `useModeration.ban` (useModeration hook tests). Both belong here as real
  // assertions; neither has one yet.
  it.todo("O-50: a Kick is honored only if its signer holds KICK and outranks the target");
  it.todo("O-51: a Ban composes Banlist -> Grant strip -> Refounding, in that order");
});
