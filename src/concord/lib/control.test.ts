import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  activePause,
  buildBanlistEdition,
  buildChannelEdition,
  buildGrantEdition,
  buildMetadataEdition,
  buildRegistryEdition,
  buildRoleEdition,
  buildSignalsEdition,
  foldControlState,
  storedControlOf,
  isCurrentFoldedControl,
  type FoldedChannel,
  type FoldedControl,
  banShouldRotate,
  banShouldRotateMany,
  hasForeignLiveLinks,
  isCommunityPublic,
  citationSatisfied,
  isDissolved,
  openControlWraps,
  sealDissolved,
  sealEdition,
} from "@/concord/lib/control";
import { bytesToHex, communityIdOf, controlGroupKey, dissolvedGroupKey, grantLocator, hex32, pinsLocator, random32, type GroupKey } from "@/concord/lib/derive";
import { channelCategory } from "@/concord/lib/channelCategory";
import { buildEditionRumor, isTagDecimal } from "@/concord/lib/edition";
import { readPinList } from "@/concord/lib/pins";
import { SIGNAL_PAUSE, VSK_PINS } from "@/concord/lib/kinds";
import { buildRumor, openWrap, rewrapSeal, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import { adminRole, badgeOf, hasPermission, isAdmin, moderatorRole, Permissions, type Overwrite, type Role } from "@/concord/lib/roles";
import { overwriteLocator } from "@/concord/lib/roster";
import { hexKey, rankedCommunity } from "@/test/concordEditions";
import {
  ARMADA_GIT_CHANNEL_METADATA_KEY,
  MAX_CHANNEL_GIT_ATTACHMENTS,
  MAX_CHANNEL_GIT_RELAY_HINTS,
  channelGitRepositoryAttachments,
  normalizeChannelMetadata,
  withChannelGitRepositoryAttachments,
} from "@/concord/lib/types";
import { attachGitRepository, detachGitRepository, parseGitRepositoryAddress } from "@/lib/gitActivity";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/**
 * The `vac` an actor must attach, read back off the wrap that granted them
 * their role (CORD-04 §5). Roles and Grants are authority actions too, so a
 * non-owner minting either has to cite — the same as any other edition.
 */
function citeGrant(grantWrap: NostrEvent, control: GroupKey, version = 1n) {
  const [parsed] = openControlWraps([grantWrap], [control]);
  return { entityId: parsed.entityId, version, editionHash: parsed.selfHash };
}

async function makeCommunity() {
  const owner = signer();
  const ownerSalt = random32();
  const communityId = communityIdOf(hex32(owner.pubkey), ownerSalt);
  const root = random32();
  const control = controlGroupKey(root, communityId, 0);
  return { owner, ownerSalt, communityId, root, control };
}

/**
 * Mint a real edition plus a same-version fork whose rumor id undercuts it —
 * the fold's equal-version tiebreak (lower rumor id) is grindable via
 * created_at, which is exactly what a forger would do to evict the real
 * edition. (Two-sided so a pathologically low real id can't stall the mine.)
 */
async function grindFork(
  control: GroupKey,
  real: { build: (createdAtSecs: number) => NostrRumor; by: ReturnType<typeof signer> },
  forged: { build: (createdAtSecs: number) => NostrRumor; by: ReturnType<typeof signer> },
): Promise<{ realWrap: NostrEvent; forgedWrap: NostrEvent }> {
  let t = 1_800_000_000;
  for (;;) {
    const realWrap = await sealEdition(real.build(t++), control, real.by);
    const [realP] = openControlWraps([realWrap], [control]);
    const realId = bytesToHex(realP.rumorId);
    for (let i = 0; i < 8; i++) {
      const forgedWrap = await sealEdition(forged.build(t++), control, forged.by);
      const [forgedP] = openControlWraps([forgedWrap], [control]);
      if (bytesToHex(forgedP.rumorId) < realId) return { realWrap, forgedWrap };
    }
  }
}

describe("control plane fold (CORD-04)", () => {
  it("round-trips unknown channel/custom/Git fields while normalizing Git attachment intervals", () => {
    const address = parseGitRepositoryAddress(`30617:${"a".repeat(64)}:armada`)!;
    const metadata = normalizeChannelMetadata({
      name: "engineering",
      private: true,
      deleted: false,
      futureChannelField: { keep: true },
      custom: {
        anotherClient: { keep: true },
        [ARMADA_GIT_CHANNEL_METADATA_KEY]: {
          futureGitField: "keep",
          repositories: [{
            address: address.coordinate,
            relayHints: ["wss://relay.example/", "wss://relay.example", "https://not-a-relay.example"],
            attachedAt: 10,
          }],
        },
      },
    });

    const updated = withChannelGitRepositoryAttachments(metadata, channelGitRepositoryAttachments(metadata));
    expect(updated).toMatchObject({
      name: "engineering",
      private: true,
      deleted: false,
      futureChannelField: { keep: true },
      custom: {
        anotherClient: { keep: true },
        [ARMADA_GIT_CHANNEL_METADATA_KEY]: { futureGitField: "keep" },
      },
    });
    expect(channelGitRepositoryAttachments(updated)).toMatchObject([
      { address: { coordinate: address.coordinate }, relayHints: ["wss://relay.example"], attachedAt: 10 },
    ]);
  });

  it("keeps attachment history, makes an active attach idempotent, and bounds hostile extension data", () => {
    const address = parseGitRepositoryAddress(`30617:${"b".repeat(64)}:armada`)!;
    const attached = attachGitRepository([], address, Array.from({ length: MAX_CHANNEL_GIT_RELAY_HINTS + 3 }, (_, i) => `wss://relay-${i}.example`), 10);
    const activeAgain = attached.some((item) => item.address.coordinate === address.coordinate && item.detachedAt === undefined)
      ? attached
      : attachGitRepository(attached, address, [], 11);
    const reattached = attachGitRepository(detachGitRepository(activeAgain, address, 20), address, ["wss://new.example"], 30);
    expect(reattached).toHaveLength(2);
    expect(reattached[0]).toMatchObject({ attachedAt: 10, detachedAt: 20 });
    expect(reattached[1]).toMatchObject({ attachedAt: 30, relayHints: ["wss://new.example"] });

    const hostile = normalizeChannelMetadata({
      name: "engineering",
      private: false,
      custom: {
        [ARMADA_GIT_CHANNEL_METADATA_KEY]: {
          repositories: [
            ...Array.from({ length: MAX_CHANNEL_GIT_ATTACHMENTS + 5 }, (_, i) => ({ address: address.coordinate, relayHints: ["wss://relay.example"], attachedAt: i })),
            { address: "not-a-coordinate", relayHints: [], attachedAt: 1 },
            { address: address.coordinate, relayHints: "not-an-array", attachedAt: 1 },
          ],
        },
      },
    });
    expect(channelGitRepositoryAttachments(hostile)).toHaveLength(MAX_CHANNEL_GIT_ATTACHMENTS);
  });

  it("ignores malformed Git custom metadata and rejects an unauthorized attachment update", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const attacker = signer();
    const channelId = random32();
    const address = parseGitRepositoryAddress(`30617:${"c".repeat(64)}:armada`)!;
    const initial = {
      name: "engineering",
      private: false,
      custom: { [ARMADA_GIT_CHANNEL_METADATA_KEY]: "malformed", unknown: { survive: true } },
    };
    const ownerMetadata = withChannelGitRepositoryAttachments(normalizeChannelMetadata(initial), attachGitRepository([], address, ["wss://relay.example"], 10));
    const ownerWrap = await sealEdition(buildChannelEdition(channelId, ownerMetadata, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const forgedWrap = await sealEdition(
      buildChannelEdition(channelId, withChannelGitRepositoryAttachments(ownerMetadata, detachGitRepository(channelGitRepositoryAttachments(ownerMetadata), address, 20)), {
        actorPubkey: attacker.pubkey,
        version: 2n,
      }),
      control,
      attacker,
    );

    const folded = foldControlState(openControlWraps([ownerWrap, forgedWrap], [control]), communityId, owner.pubkey);
    const channel = folded.channels.get(bytesToHex(channelId))!;
    expect(channel.metadata.custom?.unknown).toEqual({ survive: true });
    expect(channelGitRepositoryAttachments(channel.metadata)).toMatchObject([{ attachedAt: 10 }]);
  });

  it("folds the genesis metadata + #general channel", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const channelId = random32();

    const wraps: NostrEvent[] = [
      await sealEdition(
        buildMetadataEdition(communityId, { name: "Vector", relays: ["wss://a.example"] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      await sealEdition(
        buildChannelEdition(channelId, { name: "general", private: false }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.metadata?.name).toBe("Vector");
    expect(folded.channels.get(bytesToHex(channelId))?.name).toBe("general");
    expect(folded.channels.get(bytesToHex(channelId))?.isPrivate).toBe(false);
  });

  it("admits an admin's edits only through an owner-rooted grant", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const stranger = signer();

    const role = adminRole(bytesToHex(random32()));
    const grantWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [role.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    // The admin must CITE the grant it acts under (CORD-04 §5 `vac`).
    const [grantParsed] = openControlWraps([grantWrap], [control]);
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(role, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      grantWrap,
      // The admin (MANAGE_METADATA holder) renames the community — honored,
      // because it cites its owner-rooted grant.
      await sealEdition(
        buildMetadataEdition(communityId, { name: "Renamed", relays: [] }, {
          actorPubkey: admin.pubkey,
          version: 1n,
          authority: { entityId: grantParsed.entityId, version: 1n, editionHash: grantParsed.selfHash },
        }),
        control,
        admin,
      ),
      // A stranger grants themselves a role — dropped (not owner-rooted).
      await sealEdition(
        buildGrantEdition(communityId, { member: stranger.pubkey, roleIds: [role.roleId] }, { actorPubkey: stranger.pubkey, version: 2n }),
        control,
        stranger,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true);
    expect(hasPermission(folded.roster, stranger.pubkey, Permissions.MANAGE_ROLES)).toBe(false);
    expect(folded.metadata?.name).toBe("Renamed");
  });

  it("drops a non-owner action with a MISSING or FORGED authority citation (CORD-04 §5 vac)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const role = adminRole(bytesToHex(random32()));
    const grantWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [role.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [grantParsed] = openControlWraps([grantWrap], [control]);
    const roleWrap = await sealEdition(buildRoleEdition(role, { actorPubkey: owner.pubkey, version: 1n }), control, owner);

    // (a) No citation at all → parked.
    const noCite = await sealEdition(
      buildMetadataEdition(communityId, { name: "NoCite", relays: [] }, { actorPubkey: admin.pubkey, version: 1n }),
      control,
      admin,
    );
    expect(
      foldControlState(openControlWraps([roleWrap, grantWrap, noCite], [control]), communityId, owner.pubkey).metadata?.name,
    ).not.toBe("NoCite");

    // (b) Forged hash for the (real) grant → parked.
    const forgedHash = await sealEdition(
      buildMetadataEdition(communityId, { name: "ForgedHash", relays: [] }, {
        actorPubkey: admin.pubkey,
        version: 1n,
        authority: { entityId: grantParsed.entityId, version: 1n, editionHash: random32() },
      }),
      control,
      admin,
    );
    expect(
      foldControlState(openControlWraps([roleWrap, grantWrap, forgedHash], [control]), communityId, owner.pubkey).metadata?.name,
    ).not.toBe("ForgedHash");

    // (c) Cites a grant version that never resolves (v5, only v1 present) → parked.
    const unresolved = await sealEdition(
      buildMetadataEdition(communityId, { name: "Unresolved", relays: [] }, {
        actorPubkey: admin.pubkey,
        version: 1n,
        authority: { entityId: grantParsed.entityId, version: 5n, editionHash: grantParsed.selfHash },
      }),
      control,
      admin,
    );
    expect(
      foldControlState(openControlWraps([roleWrap, grantWrap, unresolved], [control]), communityId, owner.pubkey).metadata?.name,
    ).not.toBe("Unresolved");

    // (d) The owner needs no citation — supreme.
    const ownerEdit = await sealEdition(
      buildMetadataEdition(communityId, { name: "OwnerNoCite", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    expect(
      foldControlState(openControlWraps([ownerEdit], [control]), communityId, owner.pubkey).metadata?.name,
    ).toBe("OwnerNoCite");
  });

  it("an admin can mint + grant the stock Moderator (position 2), but not a peer Admin", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const mod = signer();
    const wannabe = signer();

    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32()));
    const peerAdm = adminRole(bytesToHex(random32()));
    const admGrant = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const cite = citeGrant(admGrant, control);
    const wraps: NostrEvent[] = [
      // Owner roots the Admin.
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      admGrant,
      // The admin (position 1) mints Moderator (position 2) and grants it — honored.
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: admin.pubkey, version: 1n, authority: cite }), control, admin),
      await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
        control,
        admin,
      ),
      // The admin mints a PEER Admin (position 1) — dropped (equal cannot act on equal).
      await sealEdition(buildRoleEdition(peerAdm, { actorPubkey: admin.pubkey, version: 1n, authority: cite }), control, admin),
      await sealEdition(
        buildGrantEdition(communityId, { member: wannabe.pubkey, roleIds: [peerAdm.roleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
        control,
        admin,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(badgeOf(folded.roster, admin.pubkey)).toBe("admin");
    expect(badgeOf(folded.roster, mod.pubkey)).toBe("moderator");
    expect(hasPermission(folded.roster, mod.pubkey, Permissions.BAN)).toBe(true);
    expect(hasPermission(folded.roster, mod.pubkey, Permissions.MANAGE_ROLES)).toBe(false);
    expect(badgeOf(folded.roster, wannabe.pubkey)).toBeUndefined();
  });

  it("honors an edition citing a grant version we have SYNCED PAST (CORD-04 §5)", async () => {
    // "until it has synced AT LEAST that Grant" — a later head satisfies the
    // floor. Requiring the exact version instead would break on rotation:
    // compaction re-wraps only each entity's HEAD, so a superseded grant
    // version does not cross into the new epoch, and every edition still citing
    // one would fall out of the fold. That is a community losing its name, or
    // its admins, for having rotated.
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const alice = signer();

    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32()));
    const grantV1 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [g1] = openControlWraps([grantV1], [control]);
    // The admin acts while their grant is at v1, and cites v1.
    const citeV1 = { entityId: g1.entityId, version: 1n, editionHash: g1.selfHash };
    // The owner then re-issues the admin's grant at v2, superseding v1.
    const grantV2 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: g1.selfHash }),
      control,
      owner,
    );

    // Fold WITHOUT v1 present, exactly as a post-compaction epoch would look.
    const folded = foldControlState(
      openControlWraps(
        [
          await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
          grantV2,
          await sealEdition(buildRoleEdition(mrole, { actorPubkey: admin.pubkey, version: 1n, authority: citeV1 }), control, admin),
          await sealEdition(
            buildGrantEdition(communityId, { member: alice.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: citeV1 }),
            control,
            admin,
          ),
        ],
        [control],
      ),
      communityId,
      owner.pubkey,
    );

    expect(
      folded.roster.roles.some((r) => r.roleId === mrole.roleId),
      "a role citing a superseded grant version still folds",
    ).toBe(true);
    expect(badgeOf(folded.roster, alice.pubkey), "and so does the grant it made").toBe("moderator");
  });

  it("seats an UNCITED role or grant from a non-owner that passes the rank gates (CORD-04 §5, Vector `judge`)", async () => {
    // A citation is a sync floor, not the verdict: an uncited edition declared no
    // floor to wait for, and the rank gates judge it all the same.
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const alice = signer();
    const bob = signer();

    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32()));
    const uncitedRole = moderatorRole(bytesToHex(random32()));
    const admGrant = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const cite = citeGrant(admGrant, control);

    const folded = foldControlState(
      openControlWraps(
        [
          await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
          admGrant,
          // CITED — honored.
          await sealEdition(buildRoleEdition(mrole, { actorPubkey: admin.pubkey, version: 1n, authority: cite }), control, admin),
          await sealEdition(
            buildGrantEdition(communityId, { member: alice.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: admin.pubkey, version: 1n, authority: cite }),
            control,
            admin,
          ),
          // UNCITED, same author, same authority — seated on the rank gates alone.
          await sealEdition(buildRoleEdition(uncitedRole, { actorPubkey: admin.pubkey, version: 1n }), control, admin),
          await sealEdition(
            buildGrantEdition(communityId, { member: bob.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: admin.pubkey, version: 1n }),
            control,
            admin,
          ),
        ],
        [control],
      ),
      communityId,
      owner.pubkey,
    );

    expect(badgeOf(folded.roster, alice.pubkey), "the cited grant lands").toBe("moderator");
    expect(badgeOf(folded.roster, bob.pubkey), "the uncited grant lands too").toBe("moderator");
    expect(
      folded.roster.roles.some((r) => r.roleId === uncitedRole.roleId),
      "and so does the uncited role",
    ).toBe(true);
  });

  it("a moderator (no MANAGE_ROLES) cannot grant roles", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const mod = signer();
    const friend = signer();

    const mrole = moderatorRole(bytesToHex(random32()));
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      // The moderator hands their friend the same role — dropped.
      await sealEdition(
        buildGrantEdition(communityId, { member: friend.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: mod.pubkey, version: 1n }),
        control,
        mod,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(badgeOf(folded.roster, mod.pubkey)).toBe("moderator");
    expect(badgeOf(folded.roster, friend.pubkey)).toBeUndefined();
  });

  it("a roleless member cannot revoke a grant (an empty role_ids edition needs authority)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const rando = signer();

    const adm = adminRole(bytesToHex(random32()));
    const roleWrap = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const grantWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    // The forged revoke chains off the REAL head (any member can read the plane).
    const [grantV1] = openControlWraps([grantWrap], [control]);
    const revokeWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: rando.pubkey, version: 2n, prevHash: grantV1.selfHash }),
      control,
      rando,
    );

    const folded = foldControlState(openControlWraps([roleWrap, grantWrap, revokeWrap], [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true); // the revoke was dropped
  });

  it("a lower-ranked MANAGE_ROLES holder cannot strip or demote a grant above their rank", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const lt = signer(); // position 2, holds MANAGE_ROLES
    const admin1 = signer(); // strip target
    const admin2 = signer(); // demote target
    const newbie = signer();

    const adm = adminRole(bytesToHex(random32()));
    const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
    const lowRole: Role = { roleId: bytesToHex(random32()), name: "Helper", position: 3, permissions: 0n, scope: { kind: "server" }, color: 0 };

    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(lowRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];
    // The lieutenant's own authority settles BEFORE the victims' entities, and
    // is what their editions cite.
    const ltGrant = await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const ltCite = citeGrant(ltGrant, control);
    wraps.push(ltGrant);
    const g1 = await sealEdition(buildGrantEdition(communityId, { member: admin1.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const g2 = await sealEdition(buildGrantEdition(communityId, { member: admin2.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const [g1v1] = openControlWraps([g1], [control]);
    const [g2v1] = openControlWraps([g2], [control]);
    wraps.push(
      g1,
      g2,
      // Strip admin1 — dropped (a revoke acts on a rank the lieutenant doesn't outrank).
      await sealEdition(
        buildGrantEdition(communityId, { member: admin1.pubkey, roleIds: [] }, { actorPubkey: lt.pubkey, version: 2n, prevHash: g1v1.selfHash, authority: ltCite }),
        control,
        lt,
      ),
      // Demote admin2 to the Helper role — dropped (outranking the role handed OUT is not enough).
      await sealEdition(
        buildGrantEdition(communityId, { member: admin2.pubkey, roleIds: [lowRole.roleId] }, { actorPubkey: lt.pubkey, version: 2n, prevHash: g2v1.selfHash, authority: ltCite }),
        control,
        lt,
      ),
      // A fresh grant BELOW the lieutenant's rank — honored.
      await sealEdition(
        buildGrantEdition(communityId, { member: newbie.pubkey, roleIds: [lowRole.roleId] }, { actorPubkey: lt.pubkey, version: 1n, authority: ltCite }),
        control,
        lt,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin1.pubkey)).toBe(true);
    expect(badgeOf(folded.roster, admin2.pubkey)).toBe("admin");
    expect(folded.roster.grants.some((g) => g.member === newbie.pubkey && g.roleIds.includes(lowRole.roleId))).toBe(true);
  });

  it("a lower-ranked MANAGE_ROLES holder cannot reposition a role above their rank", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const lt = signer();

    const adm = adminRole(bytesToHex(random32()));
    const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
    const mrole = moderatorRole(bytesToHex(random32())); // minted by the ADMIN (position 2)

    const admGrant = await sealEdition(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const ltGrant = await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const modV1 = await sealEdition(buildRoleEdition(mrole, { actorPubkey: admin.pubkey, version: 1n, authority: citeGrant(admGrant, control) }), control, admin);
    const [modV1Parsed] = openControlWraps([modV1], [control]);
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      admGrant,
      ltGrant,
      modV1,
      // The lieutenant (position 2) shoves the peer Moderator role to position 5 — dropped.
      await sealEdition(
        buildRoleEdition({ ...mrole, position: 5, permissions: 0n }, { actorPubkey: lt.pubkey, version: 2n, prevHash: modV1Parsed.selfHash, authority: citeGrant(ltGrant, control) }),
        control,
        lt,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    const settled = folded.roster.roles.find((r) => r.roleId === mrole.roleId);
    expect(settled?.position).toBe(2);
    expect(settled?.permissions).toBe(mrole.permissions);
  });

  it("an outranking MANAGE_ROLES holder's revoke still lands", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const mod = signer();

    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32()));
    const modGrant = await sealEdition(
      buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [modGrantV1] = openControlWraps([modGrant], [control]);
    const admGrant = await sealEdition(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      admGrant,
      modGrant,
      // The admin (position 1) strips the moderator (rank 2) — honored.
      await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [] }, { actorPubkey: admin.pubkey, version: 2n, prevHash: modGrantV1.selfHash, authority: citeGrant(admGrant, control) }),
        control,
        admin,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(badgeOf(folded.roster, mod.pubkey)).toBeUndefined();
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true);
  });

  it("the standing gate holds regardless of edition arrival order (a delegate-minted target rank)", async () => {
    // The target's rank comes from a role a DELEGATE minted, so that role only
    // reaches the roster in a later fixpoint pass than the delegate's own
    // grant. A lower-ranked MANAGE_ROLES holder's revoke must drop in EVERY
    // ordering — the fold is a function of the edition set, not its arrival
    // order (else clients diverge and the gate is bypassable by reshuffling).
    const build = async () => {
      const { owner, communityId, control } = await makeCommunity();
      const deleg = signer(); // position 1, mints roles
      const lt = signer(); // position 2, holds MANAGE_ROLES (the attacker)
      const target = signer();

      const adm = adminRole(bytesToHex(random32()));
      const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
      // The delegate mints a peer-rank (position 2) role and hands it to the target.
      const mrole: Role = { roleId: bytesToHex(random32()), name: "Peer", position: 2, permissions: Permissions.KICK, scope: { kind: "server" }, color: 0 };

      const admRole = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
      const ltRoleW = await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
      const delegGrant = await sealEdition(buildGrantEdition(communityId, { member: deleg.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
      const ltGrant = await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
      const mroleW = await sealEdition(buildRoleEdition(mrole, { actorPubkey: deleg.pubkey, version: 1n, authority: citeGrant(delegGrant, control) }), control, deleg);
      const targetGrant = await sealEdition(buildGrantEdition(communityId, { member: target.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: deleg.pubkey, version: 1n, authority: citeGrant(delegGrant, control) }), control, deleg);
      const [tgV1] = openControlWraps([targetGrant], [control]);
      // The lieutenant (rank 2) tries to strip the target (rank 2) — equal rank,
      // so it must be dropped: a revoke needs STRICT outrank (CORD-04 §5).
      const revoke = await sealEdition(
        buildGrantEdition(communityId, { member: target.pubkey, roleIds: [] }, { actorPubkey: lt.pubkey, version: 2n, prevHash: tgV1.selfHash, authority: citeGrant(ltGrant, control) }),
        control,
        lt,
      );
      return { owner, communityId, control, target, editions: { admRole, ltRoleW, delegGrant, ltGrant, mroleW, targetGrant, revoke } };
    };

    // Attacker's authority settles BEFORE the target's grant is visited.
    const a = await build();
    const orderA = [a.editions.admRole, a.editions.ltRoleW, a.editions.delegGrant, a.editions.ltGrant, a.editions.mroleW, a.editions.targetGrant, a.editions.revoke];
    const foldedA = foldControlState(openControlWraps(orderA, [a.control]), a.communityId, a.owner.pubkey);

    // The target's grant is visited BEFORE the delegate's role/authority settle.
    const b = await build();
    const orderB = [b.editions.admRole, b.editions.ltRoleW, b.editions.mroleW, b.editions.targetGrant, b.editions.revoke, b.editions.delegGrant, b.editions.ltGrant];
    const foldedB = foldControlState(openControlWraps(orderB, [b.control]), b.communityId, b.owner.pubkey);

    // Both orders must agree: the equal-rank revoke is dropped, target keeps rank.
    expect(foldedA.roster.grants.some((g) => g.member === a.target.pubkey && g.roleIds.length > 0)).toBe(true);
    expect(foldedB.roster.grants.some((g) => g.member === b.target.pubkey && g.roleIds.length > 0)).toBe(true);
  });

  it("an admin's revoke lands even when the revoker's own grant folds last (author-rank deferral)", async () => {
    // The revoke's admissibility depends on the REVOKER's rank, which settles
    // from a different grant entity. If the target's entity is visited first,
    // the fixpoint must WAIT for the revoker's rank — not settle the target's
    // entity with the stale predecessor and drop a legitimate revoke on
    // arrival-order luck.
    const build = async () => {
      const { owner, communityId, control } = await makeCommunity();
      const admin = signer();
      const mod = signer();

      const adm = adminRole(bytesToHex(random32()));
      const mrole = moderatorRole(bytesToHex(random32()));
      const admRole = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
      const modRole = await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
      const adminGrant = await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      );
      const modGrant = await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      );
      const [modGrantV1] = openControlWraps([modGrant], [control]);
      // The admin (position 1) revokes the moderator (rank 2) — always legitimate.
      const revoke = await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [] }, { actorPubkey: admin.pubkey, version: 2n, prevHash: modGrantV1.selfHash, authority: citeGrant(adminGrant, control) }),
        control,
        admin,
      );
      return { owner, communityId, control, admin, mod, editions: { admRole, modRole, adminGrant, modGrant, revoke } };
    };

    // The revoker's own grant arrives (and would naively settle) FIRST.
    const a = await build();
    const orderA = [a.editions.admRole, a.editions.modRole, a.editions.adminGrant, a.editions.modGrant, a.editions.revoke];
    const foldedA = foldControlState(openControlWraps(orderA, [a.control]), a.communityId, a.owner.pubkey);

    // The target's grant entity (incl. the revoke) arrives FIRST.
    const b = await build();
    const orderB = [b.editions.modRole, b.editions.admRole, b.editions.modGrant, b.editions.revoke, b.editions.adminGrant];
    const foldedB = foldControlState(openControlWraps(orderB, [b.control]), b.communityId, b.owner.pubkey);

    for (const [folded, admin, mod] of [
      [foldedA, a.admin, a.mod],
      [foldedB, b.admin, b.mod],
    ] as const) {
      expect(isAdmin(folded.roster, admin.pubkey)).toBe(true);
      expect(badgeOf(folded.roster, mod.pubkey)).toBeUndefined(); // the revoke landed
    }
  });

  it("terminates a revocation cycle: equal-rank admins cannot strip each other", async () => {
    // A revokes B and B revokes A — each entity's gate waits on the other's
    // rank, a genuine cycle. The rank freeze must break the deadlock, and the
    // strict-outrank rule must drop BOTH revokes (equal cannot act on equal).
    const { owner, communityId, control } = await makeCommunity();
    const a = signer();
    const b = signer();

    const adm = adminRole(bytesToHex(random32()));
    const grantA = await sealEdition(
      buildGrantEdition(communityId, { member: a.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const grantB = await sealEdition(
      buildGrantEdition(communityId, { member: b.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [gAv1] = openControlWraps([grantA], [control]);
    const [gBv1] = openControlWraps([grantB], [control]);
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      grantA,
      grantB,
      await sealEdition(
        buildGrantEdition(communityId, { member: b.pubkey, roleIds: [] }, { actorPubkey: a.pubkey, version: 2n, prevHash: gBv1.selfHash }),
        control,
        a,
      ),
      await sealEdition(
        buildGrantEdition(communityId, { member: a.pubkey, roleIds: [] }, { actorPubkey: b.pubkey, version: 2n, prevHash: gAv1.selfHash }),
        control,
        b,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, a.pubkey)).toBe(true);
    expect(isAdmin(folded.roster, b.pubkey)).toBe(true);
  });

  it("a same-version fork with a ground rumor id cannot revoke a superior's grant", async () => {
    // The equal-version tiebreak (lower rumor id) is minable, so a forger can
    // win the fold head at the chain tip. The evicted real edition must stay a
    // candidate: fork siblings settle highest-authority-first, so the
    // lieutenant's empty-grant fork loses to the owner's grant it undercut.
    const { owner, communityId, control } = await makeCommunity();
    const lt = signer(); // position 2, holds MANAGE_ROLES
    const admin = signer();

    const adm = adminRole(bytesToHex(random32()));
    const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
    const { realWrap: adminGrant, forgedWrap: forged } = await grindFork(
      control,
      { build: (t) => buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t }), by: owner },
      { build: (t) => buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: lt.pubkey, version: 1n, createdAtSecs: t }), by: lt },
    );
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      adminGrant,
      forged,
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true); // the fork lost to the real grant
  });

  it("a same-version fork with a ground rumor id cannot gut a superior's role definition", async () => {
    // Same grind against a ROLE entity: the lieutenant forks the owner's
    // position-1 Admin definition down to a powerless position 5. Winning the
    // tiebreak must not evict the real definition — every admin would be
    // demoted at once.
    const { owner, communityId, control } = await makeCommunity();
    const lt = signer();
    const admin = signer();

    const adm = adminRole(bytesToHex(random32()));
    const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
    const { realWrap: admRole, forgedWrap: forged } = await grindFork(
      control,
      { build: (t) => buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t }), by: owner },
      { build: (t) => buildRoleEdition({ ...adm, position: 5, permissions: 0n }, { actorPubkey: lt.pubkey, version: 1n, createdAtSecs: t }), by: lt },
    );
    const wraps: NostrEvent[] = [
      admRole,
      forged,
      await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    const settled = folded.roster.roles.find((r) => r.roleId === adm.roleId);
    expect(settled?.position).toBe(1);
    expect(settled?.permissions).toBe(adm.permissions);
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true);
  });

  it("a same-version banlist fork from a non-BAN holder cannot empty the banlist", async () => {
    // The eviction hole applies to every gated plane: a roleless rando forking
    // the banlist tip with a ground id would previously knock the real list out
    // of candidacy entirely — silently unbanning everyone. The evicted sibling
    // must remain for the authority gate to pick.
    const { owner, communityId, control } = await makeCommunity();
    const rando = signer();
    const target = signer();

    const { realWrap: banlist, forgedWrap: forged } = await grindFork(
      control,
      { build: (t) => buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t }), by: owner },
      { build: (t) => buildBanlistEdition(communityId, [], { actorPubkey: rando.pubkey, version: 1n, createdAtSecs: t }), by: rando },
    );

    const folded = foldControlState(openControlWraps([banlist, forged], [control]), communityId, owner.pubkey);
    expect(folded.banned.has(target.pubkey)).toBe(true);
  });

  it("drops (never deadlocks on) a grant handing out a role that never settles", async () => {
    // The role is minted by a rando who never gains authority, so it never
    // reaches the roster. A grant handing it out defers, then — once no pass
    // can settle that role — is dropped, not left pending forever. The fold
    // must terminate and confer no rank.
    const { owner, communityId, control } = await makeCommunity();
    const rando = signer();
    const target = signer();
    const ghostRole = adminRole(bytesToHex(random32()));

    const wraps: NostrEvent[] = [
      // A role the owner NEVER authorized (rando has no grant).
      await sealEdition(buildRoleEdition(ghostRole, { actorPubkey: rando.pubkey, version: 1n }), control, rando),
      // The owner-signed grant hands out that ghost role — the grant is honored
      // for its signer (owner), but the role behind it never settles.
      await sealEdition(buildGrantEdition(communityId, { member: target.pubkey, roleIds: [ghostRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    // The role never settled → the target holds no effective (settled) role.
    expect(isAdmin(folded.roster, target.pubkey)).toBe(false);
    expect(folded.roster.roles.some((r) => r.roleId === ghostRole.roleId)).toBe(false);
  });

  it("still confers the real role from an owner grant that also names a dead role", async () => {
    // A grant naming one settling role and one role that never settles must not
    // be starved by the dead role: once roles freeze, the grant resolves and
    // the real role still applies.
    const { owner, communityId, control } = await makeCommunity();
    const rando = signer();
    const target = signer();
    const realRole = adminRole(bytesToHex(random32()));
    const ghostRole = moderatorRole(bytesToHex(random32()));

    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(realRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      // Minted by a rando who never gains authority — never settles.
      await sealEdition(buildRoleEdition(ghostRole, { actorPubkey: rando.pubkey, version: 1n }), control, rando),
      await sealEdition(
        buildGrantEdition(communityId, { member: target.pubkey, roleIds: [realRole.roleId, ghostRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, target.pubkey)).toBe(true); // the real Admin role applies
    expect(folded.roster.roles.some((r) => r.roleId === ghostRole.roleId)).toBe(false);
  });

  it("drops a banned npub's authority editions (CORD-04 §4), banlist aside", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();

    const adm = adminRole(bytesToHex(random32()));
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      // The admin renames the community while still trusted.
      await sealEdition(
        buildMetadataEdition(communityId, { name: "By Admin", relays: [] }, { actorPubkey: admin.pubkey, version: 1n }),
        control,
        admin,
      ),
      // The owner bans the admin.
      await sealEdition(buildBanlistEdition(communityId, [admin.pubkey], { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(admin.pubkey)).toBe(true);
    // The banned admin's metadata edition is dropped on the re-fold.
    expect(folded.metadata?.name).toBeUndefined();
    // A Grant to a banned member confers nothing, unstripped or not (Vector `select_authorized`).
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(false);
  });

  it("refuses a control edition carried in an ENCRYPTED seal (CORD-02 §5)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    // Seal a well-formed metadata edition, but with the wrong (encrypted) seal.
    const rumor = buildMetadataEdition(communityId, { name: "Encrypted", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, control, owner);
    const wrap = await wrapSeal(seal, control);

    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);
    expect(folded.metadata).toBeUndefined(); // an encrypted-seal edition never enters the fold
  });

  it("refuses metadata whose name exceeds the 64-byte cap on read (CORD-02 §6)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    // Build a valid edition, then tamper the content past the cap and re-hash
    // (the builder enforces the cap on WRITE; this proves the READ gate too).
    const good = buildMetadataEdition(communityId, { name: "ok", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const tampered = { ...good, content: JSON.stringify({ name: "x".repeat(65), relays: [] }) };
    const rehashed = { ...tampered, id: getEventHash(tampered) };
    const seal = await sealRumor(rehashed, KIND_SEAL_PLAINTEXT, control, owner);
    const wrap = await wrapSeal(seal, control);

    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);
    expect(folded.metadata).toBeUndefined();
  });

  it("refuses a downgrade: a replayed stale banlist never wins", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const target = signer();

    const v1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n });
    const v1Wrap = await sealEdition(v1, control, owner);
    const [v1Parsed] = openControlWraps([v1Wrap], [control]);
    const v2 = buildBanlistEdition(communityId, [], {
      actorPubkey: owner.pubkey,
      version: 2n,
      prevHash: v1Parsed.selfHash,
    });
    const v2Wrap = await sealEdition(v2, control, owner);

    // Both editions present (a relay replaying the stale v1 alongside v2).
    const all = openControlWraps([v1Wrap, v2Wrap], [control]);
    const folded = foldControlState(all, communityId, owner.pubkey);
    expect(folded.banned.has(target.pubkey)).toBe(false); // v2 (the unban) wins
  });

  it("ignores a banlist from a non-BAN holder (fail closed)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const rando = signer();
    const wraps = [
      await sealEdition(buildBanlistEdition(communityId, [owner.pubkey], { actorPubkey: rando.pubkey, version: 1n }), control, rando),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.size).toBe(0);
  });

  /**
   * Banning is acting on a member, so it takes the BAN bit AND a strict
   * outrank — the rule kicks and grants already follow. The gate used to ask
   * only for the bit, and the list "replaces entire", which together let a
   * moderator ban the admins above them, lift bans they could never have
   * issued, and (since a ban does not strip the role) publish the very version
   * that unbanned themselves.
   */
  async function staffedCommunity() {
    const base = await makeCommunity();
    const { owner, communityId, control } = base;
    const admin = signer();
    const mod = signer();
    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32())); // position 2, holds BAN

    const admGrant = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const modGrant = await sealEdition(
      buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      admGrant,
      modGrant,
    ];
    return { ...base, admin, mod, adm, mrole, admGrant, modGrant, wraps };
  }

  it("an equal-version metadata fork cannot grind out the owner's edition", async () => {
    // The banlist is not the only entity whose tie fell to the rumor id: any
    // MANAGE_METADATA holder could fork the owner's edition at the same
    // version and mine an id that sorted first, renaming the community
    // indefinitely without ever outranking them.
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const adm = adminRole(bytesToHex(random32()));
    const admGrant = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const { realWrap, forgedWrap } = await grindFork(
      control,
      {
        build: (t) => buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t }),
        by: owner,
      },
      {
        build: (t) =>
          buildMetadataEdition(communityId, { name: "Hijacked", relays: [] }, {
            actorPubkey: admin.pubkey,
            version: 1n,
            createdAtSecs: t,
            authority: citeGrant(admGrant, control),
          }),
        by: admin,
      },
    );

    const wraps = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      admGrant,
      realWrap,
      forgedWrap,
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.metadata?.name).toBe("Real");
  });

  it("a moderator's banlist cannot name the admins above them", async () => {
    const { owner, communityId, control, admin, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();
    wraps.push(
      await sealEdition(
        buildBanlistEdition(communityId, [admin.pubkey, outsider.pubkey], {
          actorPubkey: mod.pubkey,
          version: 1n,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(admin.pubkey)).toBe(false);
    expect(folded.banned.has(outsider.pubkey)).toBe(true); // honored in part
    // Ban history counts only the names its author may ban, unlike Vector's `banned_at`: a
    // mark of the Admin would have the owner's client Kick them (`banDeparturesOwed`).
    expect(folded.bannedAt.has(admin.pubkey)).toBe(false);
    expect(folded.bannedAt.has(outsider.pubkey)).toBe(true);
  });

  it("a moderator cannot ban a peer moderator (equal does not act on equal)", async () => {
    const { owner, communityId, control, mod, mrole, modGrant, wraps } = await staffedCommunity();
    const peer = signer();
    wraps.push(
      await sealEdition(
        buildGrantEdition(communityId, { member: peer.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      await sealEdition(
        buildBanlistEdition(communityId, [peer.pubkey], { actorPubkey: mod.pubkey, version: 1n, authority: citeGrant(modGrant, control) }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(peer.pubkey)).toBe(false);
  });

  it("a banned moderator cannot publish the version that unbans them", async () => {
    const { owner, communityId, control, mod, modGrant, wraps } = await staffedCommunity();
    const v1 = await sealEdition(
      buildBanlistEdition(communityId, [mod.pubkey], { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [v1Parsed] = openControlWraps([v1], [control]);
    wraps.push(
      v1,
      await sealEdition(
        buildBanlistEdition(communityId, [], {
          actorPubkey: mod.pubkey,
          version: 2n,
          prevHash: v1Parsed.selfHash,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const opened = openControlWraps(wraps, [control]);
    // A reader that held them banned refuses their edition (CORD-04 §4, Vector `persisted_banned`).
    const held = foldControlState(opened.filter((e) => e.version === 1n || e.vsk !== "4"), communityId, owner.pubkey);
    const folded = foldControlState(opened, communityId, owner.pubkey, undefined, undefined, storedControlOf(held));
    expect(folded.banned.has(mod.pubkey)).toBe(true);
  });

  it("a moderator's list lifts a ban the owner issued on someone above them: removals aren't rank-checked (CORD-04 §2)", async () => {
    const { owner, communityId, control, admin, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();
    const v1 = await sealEdition(
      buildBanlistEdition(communityId, [admin.pubkey], { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [v1Parsed] = openControlWraps([v1], [control]);
    wraps.push(
      v1,
      await sealEdition(
        buildBanlistEdition(communityId, [outsider.pubkey], {
          actorPubkey: mod.pubkey,
          version: 2n,
          prevHash: v1Parsed.selfHash,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(admin.pubkey)).toBe(false); // the head's list alone stands
    expect(folded.banned.has(outsider.pubkey)).toBe(true);
  });

  it("the owner still lifts any ban, and a moderator lifts one they issued", async () => {
    const { owner, communityId, control, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();
    const v1 = await sealEdition(
      buildBanlistEdition(communityId, [outsider.pubkey], { actorPubkey: mod.pubkey, version: 1n, authority: citeGrant(modGrant, control) }),
      control,
      mod,
    );
    const [v1Parsed] = openControlWraps([v1], [control]);
    wraps.push(
      v1,
      await sealEdition(
        buildBanlistEdition(communityId, [], { actorPubkey: owner.pubkey, version: 2n, prevHash: v1Parsed.selfHash }),
        control,
        owner,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.size).toBe(0);
  });

  it("an equal-version banlist fork from a BAN holder cannot grind out the owner's ban", async () => {
    const { owner, communityId, control, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();
    // Both siblings are authorized, so the gate cannot separate them and both
    // link to nothing, so neither can the chain: the tiebreak is all there is.
    const { realWrap, forgedWrap } = await grindFork(
      control,
      {
        build: (t) => buildBanlistEdition(communityId, [outsider.pubkey], { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t }),
        by: owner,
      },
      {
        build: (t) =>
          buildBanlistEdition(communityId, [], {
            actorPubkey: mod.pubkey,
            version: 1n,
            createdAtSecs: t,
            authority: citeGrant(modGrant, control),
          }),
        by: mod,
      },
    );

    wraps.push(realWrap, forgedWrap);
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(outsider.pubkey)).toBe(true);
  });

  it("registry: each creator owns exactly their own list; the aggregate is the Public flag", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const linkSigner = bytesToHex(random32());
    const forger = signer();

    const wraps = [
      await sealEdition(buildRegistryEdition(communityId, owner.pubkey, [linkSigner], { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      // A forger publishing at the OWNER's registry coordinate is dropped.
      await sealEdition(buildRegistryEdition(communityId, owner.pubkey, ["ff".repeat(32)], { actorPubkey: forger.pubkey, version: 2n }), control, forger),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.liveInviteLinks.has(linkSigner)).toBe(true);
    expect(folded.liveInviteLinks.has("ff".repeat(32))).toBe(false);
  });

  it("a banned creator's registry drops from the aggregate: the ban itself can flip the mode Private (CORD-05 §5)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const adm = adminRole(bytesToHex(random32()));
    const linkSigner = bytesToHex(random32());

    const authorityWraps = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    // A non-owner edition must cite its own grant (vac), so fold for the head first.
    const grantEid = grantLocator(communityId, hex32(admin.pubkey));
    const grantHead = foldControlState(openControlWraps(authorityWraps, [control]), communityId, owner.pubkey)
      .heads.get(bytesToHex(grantEid))!;
    const preBan = [
      ...authorityWraps,
      await sealEdition(
        buildRegistryEdition(communityId, admin.pubkey, [linkSigner], {
          actorPubkey: admin.pubkey,
          version: 1n,
          authority: { entityId: grantEid, version: grantHead.version, editionHash: grantHead.hash },
        }),
        control,
        admin,
      ),
    ];
    const before = foldControlState(openControlWraps(preBan, [control]), communityId, owner.pubkey);
    expect(before.liveInviteLinks.has(linkSigner)).toBe(true);
    expect(isCommunityPublic(before)).toBe(true);
    // The ban gate's view: judged as if the target's registry were already gone.
    expect(isCommunityPublic(before, admin.pubkey)).toBe(false);

    const wraps = [
      ...preBan,
      await sealEdition(buildBanlistEdition(communityId, [admin.pubkey], { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];
    const after = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(after.liveInviteLinks.has(linkSigner)).toBe(false);
    expect(isCommunityPublic(after)).toBe(false);
  });

  it("isCommunityPublic: no registries and an emptied registry both read Private", async () => {
    const { owner, communityId, control } = await makeCommunity();
    expect(isCommunityPublic(foldControlState([], communityId, owner.pubkey))).toBe(false);

    const emptied = await sealEdition(
      buildRegistryEdition(communityId, owner.pubkey, [], { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const folded = foldControlState(openControlWraps([emptied], [control]), communityId, owner.pubkey);
    expect(isCommunityPublic(folded)).toBe(false);
  });

  it("hasForeignLiveLinks: own links never block a rotation, anyone else's do", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const wraps = [
      await sealEdition(
        buildRegistryEdition(communityId, owner.pubkey, [bytesToHex(random32())], { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);

    // The community reads Public, but every live link is the owner's own —
    // their rotation refreshes their own bundles, so nothing gets stranded.
    expect(isCommunityPublic(folded)).toBe(true);
    expect(hasForeignLiveLinks(folded, owner.pubkey)).toBe(false);

    // Any other rotator would strand the owner's link.
    const otherAdmin = bytesToHex(random32());
    expect(hasForeignLiveLinks(folded, otherAdmin)).toBe(true);
    // ...unless the link creator is the very target of the ban being judged.
    expect(hasForeignLiveLinks(folded, otherAdmin, owner.pubkey)).toBe(false);
  });

  it("pin lists (vsk 11) fold only from a PIN_MESSAGES holder, content carried verbatim", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const stranger = signer();
    const chan = random32();
    const eid = pinsLocator(communityId, chan);
    const eidHex = bytesToHex(eid);
    const content = JSON.stringify({ entries: [] });

    // A roleless stranger's pin list is refused outright.
    const strangerWraps = [
      await sealEdition(
        buildEditionRumor({ vsk: VSK_PINS, entityId: eid, content, actorPubkey: stranger.pubkey, version: 1n }),
        control,
        stranger,
      ),
    ];
    const refused = foldControlState(openControlWraps(strangerWraps, [control]), communityId, owner.pubkey);
    expect(refused.pinLists.has(eidHex)).toBe(false);

    // The owner's folds, and the content rides through untouched.
    const ownerWraps = [
      await sealEdition(
        buildEditionRumor({ vsk: VSK_PINS, entityId: eid, content, actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    const folded = foldControlState(openControlWraps(ownerWraps, [control]), communityId, owner.pubkey);
    expect(folded.pinLists.get(eidHex)).toEqual({ content, author: owner.pubkey });

    // A cap-violating list still FOLDS (CORD-04 §7) — emptiness is a read-side
    // verdict, never a refused edition, or two fold models would disagree.
    const bloated = JSON.stringify({ entries: [], pad: "z".repeat(40_000) });
    const bloatedWraps = [
      await sealEdition(
        buildEditionRumor({ vsk: VSK_PINS, entityId: eid, content: bloated, actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    const withBloat = foldControlState(openControlWraps(bloatedWraps, [control]), communityId, owner.pubkey);
    expect(withBloat.pinLists.get(eidHex)?.content, "folded, not refused").toBe(bloated);
    expect(readPinList(bloated, () => undefined).entries, "but reads empty").toEqual([]);
  });

  it("banShouldRotate: a foreign live link blocks a rotation, but never a forced one", async () => {
    // An ordinary ban must not strand another admin's invite link on a dead
    // epoch. A ban answering control-plane abuse must, because the rotation is
    // the only thing that takes the flooder's root away — a banlist silences
    // them but leaves them minting junk.
    const { owner, communityId, control } = await makeCommunity();
    const wraps = [
      await sealEdition(
        buildRegistryEdition(communityId, owner.pubkey, [bytesToHex(random32())], { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    const otherAdmin = bytesToHex(random32());
    const bystander = bytesToHex(random32());

    expect(banShouldRotate(folded, owner.pubkey, bystander), "my own link is refreshed by the rotation").toBe(true);
    expect(banShouldRotate(folded, otherAdmin, bystander), "someone else's link would be stranded").toBe(false);
    expect(
      banShouldRotate(folded, otherAdmin, bystander, true),
      "a forced rotation accepts that cost",
    ).toBe(true);
    expect(banShouldRotate(undefined, otherAdmin, bystander, true), "no fold, nothing to rotate from").toBe(false);
  });

  it("banShouldRotateMany: judged once for the group, excluding every target's own links", async () => {
    // Two admins each hold a live link. Banning ONE of them still leaves the
    // other's link to strand, so no rotation; banning BOTH removes every
    // foreign registry from the view and the single group rotation may run.
    const { owner, communityId, control } = await makeCommunity();
    const adminA = signer();
    const adminB = signer();
    const adm = adminRole(bytesToHex(random32()));
    const authorityWraps = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: adminA.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      await sealEdition(
        buildGrantEdition(communityId, { member: adminB.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    // Non-owner registry editions must cite their own grant (vac).
    const heads = foldControlState(openControlWraps(authorityWraps, [control]), communityId, owner.pubkey).heads;
    const cite = (adminPubkey: string) => {
      const eid = grantLocator(communityId, hex32(adminPubkey));
      const head = heads.get(bytesToHex(eid))!;
      return { entityId: eid, version: head.version, editionHash: head.hash };
    };
    const wraps = [
      ...authorityWraps,
      await sealEdition(
        buildRegistryEdition(communityId, adminA.pubkey, [bytesToHex(random32())], {
          actorPubkey: adminA.pubkey,
          version: 1n,
          authority: cite(adminA.pubkey),
        }),
        control,
        adminA,
      ),
      await sealEdition(
        buildRegistryEdition(communityId, adminB.pubkey, [bytesToHex(random32())], {
          actorPubkey: adminB.pubkey,
          version: 1n,
          authority: cite(adminB.pubkey),
        }),
        control,
        adminB,
      ),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.registriesByCreator.size, "both admins' registries must actually fold").toBe(2);

    expect(hasForeignLiveLinks(folded, owner.pubkey, [adminA.pubkey])).toBe(true);
    expect(hasForeignLiveLinks(folded, owner.pubkey, [adminA.pubkey, adminB.pubkey])).toBe(false);

    expect(banShouldRotateMany(folded, owner.pubkey, [adminA.pubkey]), "B's link would strand").toBe(false);
    expect(banShouldRotateMany(folded, owner.pubkey, [adminA.pubkey, adminB.pubkey]), "no foreign links survive the group ban").toBe(true);
    expect(banShouldRotateMany(folded, owner.pubkey, [adminA.pubkey], true), "force overrides").toBe(true);
    expect(banShouldRotateMany(undefined, owner.pubkey, [adminA.pubkey], true), "no fold, nothing to rotate from").toBe(false);

    // The single-target form is the [target] delegate — identical verdicts.
    expect(banShouldRotate(folded, owner.pubkey, adminA.pubkey)).toBe(
      banShouldRotateMany(folded, owner.pubkey, [adminA.pubkey]),
    );
  });

  it("a compaction re-wrap folds for a fresh joiner despite the dangling prev", async () => {
    const { owner, communityId, root, control } = await makeCommunity();

    // Two chained metadata editions at epoch 0.
    const m1 = buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const p1 = openControlWraps([await sealEdition(m1, control, owner)], [control])[0];
    const m2 = buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const p2 = openControlWraps([await sealEdition(m2, control, owner)], [control])[0];

    // Refounding: re-wrap ONLY the head into epoch 1 (plaintext seal survives).
    const control1 = controlGroupKey(root, communityId, 1); // (test shortcut: same root, new epoch address)
    const rewrapped = await rewrapSeal(p2.opened.seal!, control1);

    const joinerView = openControlWraps([rewrapped], [control1]);
    const folded = foldControlState(joinerView, communityId, owner.pubkey);
    expect(folded.metadata?.name).toBe("Two"); // accepted despite prev citing an absent edition
  });

  it("a TRACKING client fails closed on a withheld-middle chain — no downgrade to a dangling head (CORD-04 §1)", async () => {
    // The steady-state counterpart to the fresh-joiner case above: a client
    // that already holds v1 must NOT be pushed onto a higher DANGLING edition a
    // hostile relay serves after withholding the middle of the chain. It holds
    // at its last-known-good head and refetches instead.
    const { owner, communityId, control } = await makeCommunity();

    // First fold: the client legitimately advances to v1 "Real".
    const v1 = buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const v1Wrap = await sealEdition(v1, control, owner);
    const firstFold = foldControlState(openControlWraps([v1Wrap], [control]), communityId, owner.pubkey);
    const eid = bytesToHex(communityId); // metadata eid = community_id
    expect(firstFold.metadata?.name).toBe("Real");

    // Attacker serves ONLY a v3 whose prev cites a v2 the client never saw.
    const v3 = buildMetadataEdition(communityId, { name: "Hijacked", relays: [] }, {
      actorPubkey: owner.pubkey,
      version: 3n,
      prevHash: random32(), // dangling
    });
    const v3Wrap = await sealEdition(v3, control, owner);

    // Fed the prior fold's heads as the high-water floor, the tracking client
    // rejects the dangling v3 and keeps v1 "Real".
    const trackingFold = foldControlState(
      openControlWraps([v1Wrap, v3Wrap], [control]),
      communityId,
      owner.pubkey,
      firstFold.heads,
    );
    expect(trackingFold.metadata?.name).toBe("Real");
    expect(trackingFold.heads.get(eid)?.version).toBe(1n);

    // Even if the relay drops v1 entirely and serves only the dangling v3, the
    // floor still holds the entity at v1 (nothing at/above the floor links).
    const onlyDangling = foldControlState(
      openControlWraps([v3Wrap], [control]),
      communityId,
      owner.pubkey,
      firstFold.heads,
    );
    expect(onlyDangling.metadata?.name).not.toBe("Hijacked");
  });

  it("a rejoiner holding partial old roots folds the compacted snapshot, not the stale fragment (CORD-06 §3)", async () => {
    // The chain's middle lives in an epoch the rejoiner never held: they kept
    // epoch 0 (member then), missed epoch 1 (banned), rejoined at epoch 2. The
    // compaction re-wrap is the only readable carrier of the current head.
    const { owner, communityId, root, control } = await makeCommunity();
    const target = signer();

    // e0: v1 bans target (readable — the rejoiner held this root).
    const b1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n });
    const w1 = await sealEdition(b1, control, owner);
    const p1 = openControlWraps([w1], [control])[0];

    // e1 (never held): v2 churn, v3 unban.
    const control1 = controlGroupKey(root, communityId, 1);
    const b2 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const p2 = openControlWraps([await sealEdition(b2, control1, owner)], [control1])[0];
    const b3 = buildBanlistEdition(communityId, [], { actorPubkey: owner.pubkey, version: 3n, prevHash: p2.selfHash });
    const p3 = openControlWraps([await sealEdition(b3, control1, owner)], [control1])[0];

    // e2 Refounding: compaction re-wraps the head (v3) under the new epoch.
    const control2 = controlGroupKey(root, communityId, 2);
    const rewrapped = await rewrapSeal(p3.opened.seal!, control2);

    // The rejoiner's readable view: e0 fragment + e2 snapshot; e1 is dark.
    const view = [...openControlWraps([w1], [control]), ...openControlWraps([rewrapped], [control2])];

    // Without attribution the walk anchors on the old fragment: stale ban.
    const unaware = foldControlState(view, communityId, owner.pubkey);
    expect(unaware.banned.has(target.pubkey)).toBe(true);

    // With the current-epoch snapshot anchoring the fold: the unban wins.
    const snapshotIds = new Set([bytesToHex(p3.rumorId)]);
    const aware = foldControlState(view, communityId, owner.pubkey, undefined, snapshotIds);
    expect(aware.banned.has(target.pubkey)).toBe(false);
    expect(aware.heads.get(bytesToHex(p3.entityId))?.version).toBe(3n);

    // A hostile keyholder re-wraps the OLD banning edition into the current
    // epoch to poison the subset. Version anchoring defeats it: a re-wrap
    // can't raise the version inside the signed seal, so v1 loses to v3.
    const poison = await rewrapSeal(p1.opened.seal!, control2);
    const poisonedView = [...view, ...openControlWraps([poison], [control2])];
    const poisonedSnap = new Set([bytesToHex(p3.rumorId), bytesToHex(p1.rumorId)]);
    const resistant = foldControlState(poisonedView, communityId, owner.pubkey, undefined, poisonedSnap);
    expect(resistant.banned.has(target.pubkey)).toBe(false);
    expect(resistant.heads.get(bytesToHex(p3.entityId))?.version).toBe(3n);
  });

  it("a floor minted off a stale fragment can't wedge the arriving snapshot (version-only refuse-downgrade)", async () => {
    // The rejoiner's FIRST fold runs before the compaction re-wrap arrives:
    // the store seed serves only the old fragment, and its head raises the
    // floor. The snapshot must still win on version when it lands.
    const { owner, communityId, root, control } = await makeCommunity();
    const target = signer();

    const b1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n });
    const w1 = await sealEdition(b1, control, owner);
    const p1 = openControlWraps([w1], [control])[0];
    const control1 = controlGroupKey(root, communityId, 1);
    const b2 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const p2 = openControlWraps([await sealEdition(b2, control1, owner)], [control1])[0];
    const b3 = buildBanlistEdition(communityId, [], { actorPubkey: owner.pubkey, version: 3n, prevHash: p2.selfHash });
    const p3 = openControlWraps([await sealEdition(b3, control1, owner)], [control1])[0];
    const control2 = controlGroupKey(root, communityId, 2);
    const rewrapped = await rewrapSeal(p3.opened.seal!, control2);

    // Fold 1: only the old fragment is readable; no current-epoch editions yet.
    const first = foldControlState(
      openControlWraps([w1], [control]),
      communityId,
      owner.pubkey,
      undefined,
      new Set<string>(),
    );
    expect(first.banned.has(target.pubkey)).toBe(true);

    // Fold 2: the snapshot lands; fold with the stale floor fed back in.
    const view = [...openControlWraps([w1], [control]), ...openControlWraps([rewrapped], [control2])];
    const second = foldControlState(view, communityId, owner.pubkey, first.heads, new Set([bytesToHex(p3.rumorId)]));
    expect(second.banned.has(target.pubkey)).toBe(false);
    expect(second.incomplete).toEqual([]);
  });

  it("a poison-only subset can't outrank a higher head held in the client's own store", async () => {
    // Colluding relays withhold the compacted head's re-wrap and serve only a
    // keyholder's re-wrap of an old edition. An established member's store
    // still holds the full chain — the higher version must win the bootstrap.
    const { owner, communityId, root, control } = await makeCommunity();

    const m1 = buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const p1 = openControlWraps([await sealEdition(m1, control, owner)], [control])[0];
    const m2 = buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const w2 = await sealEdition(m2, control, owner);
    const control1 = controlGroupKey(root, communityId, 1);
    const poison = await rewrapSeal(p1.opened.seal!, control1);

    // View: the store's full e0 chain + the poison; only the poison is
    // current-epoch-attributed.
    const view = [
      ...openControlWraps([await sealEdition(m1, control, owner), w2], [control]),
      ...openControlWraps([poison], [control1]),
    ];
    const folded = foldControlState(view, communityId, owner.pubkey, undefined, new Set([bytesToHex(p1.rumorId)]));
    expect(folded.metadata?.name).toBe("Two");
  });

  it("the snapshot arm still fails closed when the floored head vanishes, and never downgrades below the floor", async () => {
    const { owner, communityId, root, control } = await makeCommunity();

    // e0 chain v1→v2, refounded into e1 carrying the v2 head.
    const m1 = buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const p1 = openControlWraps([await sealEdition(m1, control, owner)], [control])[0];
    const m2 = buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const p2 = openControlWraps([await sealEdition(m2, control, owner)], [control])[0];
    const control1 = controlGroupKey(root, communityId, 1);
    const rewrapV2 = await rewrapSeal(p2.opened.seal!, control1);
    const snapView = openControlWraps([rewrapV2], [control1]);
    const tracked = foldControlState(snapView, communityId, owner.pubkey, undefined, new Set([bytesToHex(p2.rumorId)]));
    expect(tracked.metadata?.name).toBe("Two");

    // The relay then serves only a re-wrap of the OLD v1: nothing at/above the
    // floor remains — the entity holds (no downgrade) and flags incomplete.
    const rewrapV1 = await rewrapSeal(p1.opened.seal!, control1);
    const starved = foldControlState(
      openControlWraps([rewrapV1], [control1]),
      communityId,
      owner.pubkey,
      tracked.heads,
      new Set([bytesToHex(p1.rumorId)]),
    );
    // v2 wasn't served and v1 is below the floor, so the entity is SUSPENDED —
    // not downgraded to "One". Asserting only `not.toBe("Two")` would have
    // passed on the downgrade, which is the whole failure mode.
    expect(starved.metadata).toBeUndefined();
    expect(starved.incomplete).toContain(bytesToHex(communityId));
  });

  it("incomplete excludes a floored entity that was served but authority-rejected (CORD-04 §4)", async () => {
    // The strip flow: a creator's registry legitimately vanishes from the fold
    // when their grant is revoked. That absence is deliberate, not data loss —
    // it must NOT read as incomplete, or the ban→refound flow false-aborts.
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const adm = adminRole(bytesToHex(random32()));

    const authorityWraps = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    const grantEid = grantLocator(communityId, hex32(admin.pubkey));
    const grantHead = foldControlState(openControlWraps(authorityWraps, [control]), communityId, owner.pubkey)
      .heads.get(bytesToHex(grantEid))!;
    const registryWrap = await sealEdition(
      buildRegistryEdition(communityId, admin.pubkey, [bytesToHex(random32())], {
        actorPubkey: admin.pubkey,
        version: 1n,
        authority: { entityId: grantEid, version: grantHead.version, editionHash: grantHead.hash },
      }),
      control,
      admin,
    );
    const first = foldControlState(openControlWraps([...authorityWraps, registryWrap], [control]), communityId, owner.pubkey);
    expect(first.registriesByCreator.has(admin.pubkey)).toBe(true);

    // The owner strips the admin, then the refound-gate fold re-runs with the
    // pre-strip heads as its floor. Everything is served; the registry is
    // rejected on authority alone — the gate must see a complete plane.
    const strip = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: grantHead.hash }),
      control,
      owner,
    );
    const folded = foldControlState(
      openControlWraps([...authorityWraps, registryWrap, strip], [control]),
      communityId,
      owner.pubkey,
      first.heads,
    );
    expect(folded.registriesByCreator.has(admin.pubkey)).toBe(false);
    expect(folded.incomplete).toEqual([]);
  });

  it("incomplete flags a floored entity the served set can't settle (the refound gate)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const m1 = buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const w1 = await sealEdition(m1, control, owner);
    const first = foldControlState(openControlWraps([w1], [control]), communityId, owner.pubkey);
    expect(first.incomplete).toEqual([]);

    // The floored entity's editions vanish from the served set entirely.
    const starved = foldControlState([], communityId, owner.pubkey, first.heads);
    expect(starved.incomplete).toContain(bytesToHex(communityId));

    // Served complete again: the flag clears.
    const healed = foldControlState(openControlWraps([w1], [control]), communityId, owner.pubkey, first.heads);
    expect(healed.incomplete).toEqual([]);
  });

  it("a keyholder's junk edition skipping a version neither freezes the entity nor gates a rotation", async () => {
    // Any member holds the control key, so anyone can seal metadata v3 with no v2.
    // Counted as a withheld middle, it froze the owner's later rename for every
    // tracking client and failed useRefound's completeness check for good.
    const { owner, communityId, control } = await makeCommunity();
    const member = signer();
    const m1 = buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const w1 = await sealEdition(m1, control, owner);
    const p1 = openControlWraps([w1], [control])[0];
    const first = foldControlState([p1], communityId, owner.pubkey);
    const junk = await sealEdition(
      buildMetadataEdition(communityId, { name: "junk", relays: [] }, { actorPubkey: member.pubkey, version: 3n, prevHash: new Uint8Array(32) }),
      control,
      member,
    );

    const gate = foldControlState(openControlWraps([w1, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(gate.incomplete).toEqual([]);
    expect(gate.metadata?.name).toBe("Real");

    const rename = await sealEdition(
      buildMetadataEdition(communityId, { name: "Renamed", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash }),
      control,
      owner,
    );
    const tracking = foldControlState(openControlWraps([w1, rename, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(tracking.metadata?.name).toBe("Renamed");
    expect(tracking.incomplete).toEqual([]);
  });

  it("a member's junk grant edition neither freezes that grant nor gates a rotation", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const member = signer();
    const rando = signer();
    const adm = adminRole(bytesToHex(random32()));
    const role = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const g1 = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const first = foldControlState(openControlWraps([role, g1], [control]), communityId, owner.pubkey);
    expect(isAdmin(first.roster, member.pubkey)).toBe(true);
    const junk = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [] }, { actorPubkey: rando.pubkey, version: 3n, prevHash: new Uint8Array(32) }),
      control,
      rando,
    );

    const gate = foldControlState(openControlWraps([role, g1, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(gate.incomplete).toEqual([]);
    expect(isAdmin(gate.roster, member.pubkey)).toBe(true);

    // The owner's real demotion still lands for a tracking client.
    const p1 = openControlWraps([g1], [control])[0];
    const g2 = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash }),
      control,
      owner,
    );
    const tracking = foldControlState(openControlWraps([role, g1, g2, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(isAdmin(tracking.roster, member.pubkey)).toBe(false);
    expect(tracking.incomplete).toEqual([]);
  });

  it("a demoted admin's junk grant edition is set aside like any member's", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const member = signer();
    const adm = adminRole(bytesToHex(random32()));
    const role = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const a1 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const pa1 = openControlWraps([a1], [control])[0];
    const a2 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: pa1.selfHash }),
      control,
      owner,
    );
    const m1 = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const base = [role, a1, a2, m1];
    const first = foldControlState(openControlWraps(base, [control]), communityId, owner.pubkey);
    expect(isAdmin(first.roster, admin.pubkey)).toBe(false);

    const junk = await sealEdition(
      buildGrantEdition(
        communityId,
        { member: member.pubkey, roleIds: [] },
        { actorPubkey: admin.pubkey, version: 3n, prevHash: new Uint8Array(32), authority: citeGrant(a1, control) },
      ),
      control,
      admin,
    );
    const gate = foldControlState(openControlWraps([...base, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(gate.incomplete).toEqual([]);
    expect(isAdmin(gate.roster, member.pubkey)).toBe(true);
  });

  it("a grant whose real middle edition is withheld still fails closed", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const member = signer();
    const adm = adminRole(bytesToHex(random32()));
    const role = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const grant = (version: bigint, roleIds: string[], prevHash?: Uint8Array) =>
      buildGrantEdition(communityId, { member: member.pubkey, roleIds }, { actorPubkey: owner.pubkey, version, prevHash });
    const g1 = await sealEdition(grant(1n, [adm.roleId]), control, owner);
    const p1 = openControlWraps([g1], [control])[0];
    const p2 = openControlWraps([await sealEdition(grant(2n, [], p1.selfHash), control, owner)], [control])[0];
    const g3 = await sealEdition(grant(3n, [adm.roleId], p2.selfHash), control, owner);
    const first = foldControlState(openControlWraps([role, g1], [control]), communityId, owner.pubkey);

    const starved = foldControlState(openControlWraps([role, g1, g3], [control]), communityId, owner.pubkey, first.heads);
    expect(starved.incomplete).toContain(bytesToHex(grantLocator(communityId, hex32(member.pubkey))));
  });

  it("an edition citing a Grant it doesn't hold is set aside before the gap check, as Vector does", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const adm = adminRole(bytesToHex(random32()));
    const role = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const a1 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const m1 = await sealEdition(
      buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const first = foldControlState(openControlWraps([role, a1, m1], [control]), communityId, owner.pubkey);
    const skip = (authority: ReturnType<typeof citeGrant>) =>
      sealEdition(
        buildMetadataEdition(communityId, { name: "skip", relays: [] }, { actorPubkey: admin.pubkey, version: 3n, prevHash: new Uint8Array(32), authority }),
        control,
        admin,
      );

    const forged = await skip({ ...citeGrant(a1, control), editionHash: random32() });
    const gate = foldControlState(openControlWraps([role, a1, m1, forged], [control]), communityId, owner.pubkey, first.heads);
    expect(gate.incomplete).toEqual([]);

    // A properly citing admin's v3 means a real v2 is missing.
    const cited = await skip(citeGrant(a1, control));
    const withheld = foldControlState(openControlWraps([role, a1, m1, cited], [control]), communityId, owner.pubkey, first.heads);
    expect(withheld.incomplete).toContain(bytesToHex(communityId));
  });

  it("junk at both a promotion and the grant the promoted admin then edited can't roll that edit back", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const mod = signer();
    const rando = signer();
    const adm = adminRole(bytesToHex(random32()));
    const modRole = moderatorRole(bytesToHex(random32()));
    const roles = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(modRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];
    const grant = (member: string, roleIds: string[], version: bigint, actor = owner, prevHash?: Uint8Array, authority?: ReturnType<typeof citeGrant>) =>
      sealEdition(buildGrantEdition(communityId, { member, roleIds }, { actorPubkey: actor.pubkey, version, prevHash, authority }), control, actor);
    const x1 = await grant(admin.pubkey, [], 1n);
    const y1 = await grant(mod.pubkey, [modRole.roleId], 1n);
    const first = foldControlState(openControlWraps([...roles, x1, y1], [control]), communityId, owner.pubkey);
    expect(hasPermission(first.roster, mod.pubkey, Permissions.KICK)).toBe(true);

    // The owner promotes the admin, who then revokes the moderator.
    const [px1, py1] = openControlWraps([x1, y1], [control]);
    const x2 = await grant(admin.pubkey, [adm.roleId], 2n, owner, px1.selfHash);
    const y2 = await grant(mod.pubkey, [], 2n, admin, py1.selfHash, citeGrant(x2, control, 2n));
    const real = [...roles, x1, x2, y1, y2];
    const clean = foldControlState(openControlWraps(real, [control]), communityId, owner.pubkey, first.heads);
    expect(hasPermission(clean.roster, mod.pubkey, Permissions.KICK)).toBe(false);

    // A keyholder's junk skipping versions on both grants.
    const junk = [
      await grant(admin.pubkey, [], 4n, rando, new Uint8Array(32)),
      await grant(mod.pubkey, [modRole.roleId], 4n, rando, new Uint8Array(32)),
    ];
    const tracking = foldControlState(openControlWraps([...real, ...junk], [control]), communityId, owner.pubkey, first.heads);
    expect(isAdmin(tracking.roster, admin.pubkey)).toBe(true);
    expect(hasPermission(tracking.roster, mod.pubkey, Permissions.KICK)).toBe(false);
  });

  it("a withheld head with only junk served above it still fails closed", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const member = signer();
    const w1 = await sealEdition(
      buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const p1 = openControlWraps([w1], [control])[0];
    const w2 = await sealEdition(
      buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash }),
      control,
      owner,
    );
    const first = foldControlState(openControlWraps([w1, w2], [control]), communityId, owner.pubkey);
    expect(first.metadata?.name).toBe("Two");
    const junk = await sealEdition(
      buildMetadataEdition(communityId, { name: "junk", relays: [] }, { actorPubkey: member.pubkey, version: 9n, prevHash: new Uint8Array(32) }),
      control,
      member,
    );

    // The floor head (v2) is withheld; the junk above it must not read as a rejection of it.
    const starved = foldControlState(openControlWraps([w1, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(starved.incomplete).toContain(bytesToHex(communityId));
  });

  it("a gap among authorized editions still fails closed", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const m1 = buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const w1 = await sealEdition(m1, control, owner);
    const p1 = openControlWraps([w1], [control])[0];
    const first = foldControlState([p1], communityId, owner.pubkey);
    const m2 = buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const p2 = openControlWraps([await sealEdition(m2, control, owner)], [control])[0];
    const m3 = buildMetadataEdition(communityId, { name: "Three", relays: [] }, { actorPubkey: owner.pubkey, version: 3n, prevHash: p2.selfHash });
    const w3 = await sealEdition(m3, control, owner);

    // The owner's v2 is withheld: v3 is real, so this is data loss, not junk.
    const starved = foldControlState(openControlWraps([w1, w3], [control]), communityId, owner.pubkey, first.heads);
    expect(starved.incomplete).toContain(bytesToHex(communityId));
    expect(starved.metadata?.name).toBe("One");
  });

  it("a demoted admin's past edition stays a link of the chain an authorized edition built on", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const member = signer();
    const adm = adminRole(bytesToHex(random32()));
    const role = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const a1 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const m1 = await sealEdition(buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const first = foldControlState(openControlWraps([role, a1, m1], [control]), communityId, owner.pubkey);
    const [pm1, pa1] = openControlWraps([m1, a1], [control]);
    const m2 = await sealEdition(
      buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: admin.pubkey, version: 2n, prevHash: pm1.selfHash, authority: citeGrant(a1, control) }),
      control,
      admin,
    );
    const pm2 = openControlWraps([m2], [control])[0];
    const a2 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: pa1.selfHash }),
      control,
      owner,
    );
    const m3 = await sealEdition(
      buildMetadataEdition(communityId, { name: "Three", relays: [] }, { actorPubkey: owner.pubkey, version: 3n, prevHash: pm2.selfHash }),
      control,
      owner,
    );
    const junk = await sealEdition(
      buildMetadataEdition(communityId, { name: "junk", relays: [] }, { actorPubkey: member.pubkey, version: 5n, prevHash: new Uint8Array(32) }),
      control,
      member,
    );

    for (const wraps of [[role, a1, a2, m1, m2, m3], [role, a1, a2, m1, m2, m3, junk]]) {
      const all = openControlWraps(wraps, [control]);
      const fresh = foldControlState(all, communityId, owner.pubkey);
      const tracking = foldControlState(all, communityId, owner.pubkey, first.heads);
      expect(fresh.metadata?.name).toBe("Three");
      expect(tracking.metadata?.name).toBe("Three");
      expect(tracking.incomplete).toEqual([]);
    }
  });

  it("a grant a demoted admin once edited still folds past a junk edition", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const member = signer();
    const rando = signer();
    const adm = adminRole(bytesToHex(random32()));
    const role = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const a1 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const g1 = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const first = foldControlState(openControlWraps([role, a1, g1], [control]), communityId, owner.pubkey);
    const [pg1, pa1] = openControlWraps([g1, a1], [control]);
    const g2 = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [adm.roleId] }, { actorPubkey: admin.pubkey, version: 2n, prevHash: pg1.selfHash, authority: citeGrant(a1, control) }),
      control,
      admin,
    );
    const pg2 = openControlWraps([g2], [control])[0];
    const a2 = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: pa1.selfHash }),
      control,
      owner,
    );
    const g3 = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [] }, { actorPubkey: owner.pubkey, version: 3n, prevHash: pg2.selfHash }),
      control,
      owner,
    );
    const junk = await sealEdition(
      buildGrantEdition(communityId, { member: member.pubkey, roleIds: [adm.roleId] }, { actorPubkey: rando.pubkey, version: 5n, prevHash: new Uint8Array(32) }),
      control,
      rando,
    );

    const tracking = foldControlState(openControlWraps([role, a1, a2, g1, g2, g3, junk], [control]), communityId, owner.pubkey, first.heads);
    expect(tracking.incomplete).toEqual([]);
    expect(tracking.heads.get(bytesToHex(grantLocator(communityId, hex32(member.pubkey))))?.version).toBe(3n);
    expect(isAdmin(tracking.roster, member.pubkey)).toBe(false);
  });

  it("bannedAt records the newest AUTHORIZED ban time per npub; forgeries excluded", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const target = signer();
    const rando = signer();

    const b1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: 1000 });
    const w1 = await sealEdition(b1, control, owner);
    const p1 = openControlWraps([w1], [control])[0];
    // A newer authorized edition still naming the target.
    const b2 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash, createdAtSecs: 2000 });
    const w2 = await sealEdition(b2, control, owner);
    // A forged banlist edition by an unauthorized author, dated far in the future.
    const forged = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: rando.pubkey, version: 3n, createdAtSecs: 9999 });
    const wf = await sealEdition(forged, control, rando);

    const folded = foldControlState(openControlWraps([w1, w2, wf], [control]), communityId, owner.pubkey);
    expect(folded.banned.has(target.pubkey)).toBe(true);
    // Newest AUTHORIZED edition wins (2000), never the forged 9999.
    expect(folded.bannedAt.get(target.pubkey)).toBe(2000);
    // The forger's own edition contributes nothing.
    expect(folded.bannedAt.has(rando.pubkey)).toBe(false);
  });

  it("bannedAt survives an unban (the phantom-suppression signal outlives the ban)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const target = signer();
    const b1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: 1000 });
    const w1 = await sealEdition(b1, control, owner);
    const p1 = openControlWraps([w1], [control])[0];
    const unban = buildBanlistEdition(communityId, [], { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash, createdAtSecs: 2000 });
    const w2 = await sealEdition(unban, control, owner);

    const folded = foldControlState(openControlWraps([w1, w2], [control]), communityId, owner.pubkey);
    expect(folded.banned.has(target.pubkey)).toBe(false); // currently unbanned
    expect(folded.bannedAt.get(target.pubkey)).toBe(1000); // but the ban history remains
  });

  it("bannedAt spans held epochs: a later ban in a DIFFERENT epoch's control group wins", async () => {
    const { owner, communityId, root } = await makeCommunity();
    const target = signer();
    const control0 = controlGroupKey(root, communityId, 0);
    const control1 = controlGroupKey(root, communityId, 1); // (test shortcut: same root, new epoch address)

    const b0 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: 1000 });
    const w0 = await sealEdition(b0, control0, owner);
    const p0 = openControlWraps([w0], [control0])[0];
    // A newer ban published under epoch 1's control group.
    const b1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 2n, prevHash: p0.selfHash, createdAtSecs: 2000 });
    const w1 = await sealEdition(b1, control1, owner);

    // Both epoch groups held → the fold sees both editions; newest ban wins.
    const folded = foldControlState(openControlWraps([w0, w1], [control0, control1]), communityId, owner.pubkey);
    expect(folded.bannedAt.get(target.pubkey)).toBe(2000);
  });

  it("bannedAt never names the owner — an authorized ban of the owner can't durably hide them", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const adm = adminRole(bytesToHex(random32()));
    const authWraps = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];
    const grantEid = grantLocator(communityId, hex32(admin.pubkey));
    const grantHead = foldControlState(openControlWraps(authWraps, [control]), communityId, owner.pubkey)
      .heads.get(bytesToHex(grantEid))!;
    // The admin (BAN authority) publishes a banlist edition naming the OWNER.
    const evil = buildBanlistEdition(communityId, [owner.pubkey], {
      actorPubkey: admin.pubkey,
      version: 1n,
      authority: { entityId: grantEid, version: grantHead.version, editionHash: grantHead.hash },
    });
    const folded = foldControlState(
      openControlWraps([...authWraps, await sealEdition(evil, control, admin)], [control]),
      communityId,
      owner.pubkey,
    );
    expect(folded.bannedAt.has(owner.pubkey)).toBe(false);
  });
});

describe("tag numbers are spec-shaped decimals (CORD-01 §5)", () => {
  // "its decimal form with no leading zeros". BigInt()/Number() accept several
  // shapes that aren't, and a stricter peer drops what we'd honor — a
  // divergence neither side can see, since a declined parse is never logged.
  it("accepts a plain decimal and a bare zero", () => {
    expect(isTagDecimal("4")).toBe(true);
    expect(isTagDecimal("0")).toBe(true);
    expect(isTagDecimal("1099511627776")).toBe(true);
  });

  it("refuses leading zeros, signs, and every non-decimal shape", () => {
    for (const bad of ["04", "007", "00", "+4", "-4", "0x4", "1e2", " 4", "4 ", "", "4.0", "٤"]) {
      expect(isTagDecimal(bad), `${JSON.stringify(bad)} is not decimal form`).toBe(false);
    }
    expect(isTagDecimal(undefined)).toBe(false);
  });
});

describe("citationSatisfied (CORD-04 §5 sync floor)", () => {
  // Mirrors Vector's `authority_citation_satisfied` case for case. The two
  // clients diverging here means one honors a moderation action the other
  // silently ignores, invisibly to both.
  const owner = "0".repeat(64);
  const mod = "1".repeat(64);
  const cid = new Uint8Array(32).fill(7);
  const eid = grantLocator(cid, hex32(mod));
  const hash = new Uint8Array(32).fill(0xaa);

  const foldWith = (heads: Array<[string, { version: bigint; hash: Uint8Array }]>) =>
    ({ ownerHex: owner, heads: new Map(heads) }) as unknown as Parameters<typeof citationSatisfied>[0];

  const cite = (version: bigint, h = hash, entity = eid) => ({ entityId: entity, version, editionHash: h });

  it("the owner cites nothing and is always satisfied", () => {
    expect(citationSatisfied(foldWith([]), cid, owner, undefined)).toBe(true);
  });

  it("a non-owner citing nothing is refused", () => {
    expect(citationSatisfied(foldWith([[bytesToHex(eid), { version: 5n, hash }]]), cid, mod, undefined)).toBe(false);
  });

  it("passes when synced PAST the cited version", () => {
    // Whether they are STILL authorized is the caller's roster check, which
    // already reflects the later head.
    const f = foldWith([[bytesToHex(eid), { version: 9n, hash: new Uint8Array(32).fill(0xbb) }]]);
    expect(citationSatisfied(f, cid, mod, cite(3n))).toBe(true);
  });

  it("at the exact cited version, the hash must be the one that won our fold", () => {
    const f = foldWith([[bytesToHex(eid), { version: 3n, hash }]]);
    expect(citationSatisfied(f, cid, mod, cite(3n))).toBe(true);
    expect(
      citationSatisfied(f, cid, mod, cite(3n, new Uint8Array(32).fill(0xee))),
      "a non-canonical fork of their own Grant",
    ).toBe(false);
  });

  it("PARKS when our head is behind the cited version", () => {
    // Fail closed: we cannot confirm the authority yet. Self-heals on sync.
    const f = foldWith([[bytesToHex(eid), { version: 2n, hash }]]);
    expect(citationSatisfied(f, cid, mod, cite(3n))).toBe(false);
  });

  it("refuses a citation naming someone ELSE's Grant", () => {
    // Completeness can't be borrowed from a foreign edition we happen to hold.
    const foreign = grantLocator(cid, hex32("2".repeat(64)));
    const f = foldWith([
      [bytesToHex(eid), { version: 5n, hash }],
      [bytesToHex(foreign), { version: 5n, hash }],
    ]);
    expect(citationSatisfied(f, cid, mod, cite(5n, hash, foreign))).toBe(false);
  });

  it("refuses when the actor's Grant is absent entirely", () => {
    expect(citationSatisfied(foldWith([]), cid, mod, cite(1n))).toBe(false);
  });
});

describe("dissolution (CORD-02 §9)", () => {
  it("only the owner's tombstone counts", async () => {
    const { owner, communityId } = await makeCommunity();
    const impostor = signer();

    const real = await sealDissolved(communityId, owner.pubkey, owner);
    const fake = await sealDissolved(communityId, impostor.pubkey, impostor);

    expect(isDissolved([fake], communityId, owner.pubkey)).toBe(false);
    expect(isDissolved([fake, real], communityId, owner.pubkey)).toBe(true);
  });

  it("a tombstone cannot be replayed onto another community of the same owner", async () => {
    // The dissolved plane's keypair derives from the community_id with NO
    // secret input, and the id is public (it ships in every invite). So anyone
    // holding two public ids can read one community's dissolved plane and sign
    // at another's — the only thing they lack is an owner-signed vsk-10 rumor.
    //
    // With the frozen §9 all-zero `eid` that rumor names nothing, so an owner's
    // genuine tombstone for X is a working weapon against every OTHER community
    // the same owner runs: lift the plaintext seal, re-wrap it at Y's dissolved
    // address, and Y is dead. No membership, no keys, and no un-dissolve.
    // Committing the community_id inside the signed payload is what stops it.
    const owner = signer();
    const x = communityIdOf(hex32(owner.pubkey), random32());
    const y = communityIdOf(hex32(owner.pubkey), random32());
    expect(bytesToHex(x)).not.toBe(bytesToHex(y));

    const tombstoneX = await sealDissolved(x, owner.pubkey, owner);
    expect(isDissolved([tombstoneX], x, owner.pubkey), "it really does kill X").toBe(true);

    // Lift X's seal and re-wrap it at Y's dissolved address — derivable by
    // anyone from Y's public id, and rewrapSeal is already in the codebase
    // because compaction needs it.
    const openedX = openWrap(tombstoneX, dissolvedGroupKey(x));
    const replayed = await rewrapSeal(openedX.seal, dissolvedGroupKey(y));

    expect(
      isDissolved([replayed], y, owner.pubkey),
      "a seal minted for X must never kill Y",
    ).toBe(false);
  });

  it("refuses an all-zero eid rather than grandfathering it", async () => {
    // Accepting the frozen shape IS the vulnerability, so it is refused rather
    // than kept for compatibility. The failure mode of refusing is a community
    // that reads alive and can simply be re-dissolved; the failure mode of
    // accepting is one that dies permanently with no recovery.
    const { owner, communityId } = await makeCommunity();
    const group = dissolvedGroupKey(communityId);
    const legacy = buildRumor({
      kind: 3308,
      content: "",
      tags: [["vsk", "10"], ["eid", "0".repeat(64)]],
      pubkey: owner.pubkey,
      ms: null,
    });
    const seal = await sealRumor(legacy, KIND_SEAL_PLAINTEXT, group, owner);
    expect(isDissolved([await wrapSeal(seal, group)], communityId, owner.pubkey)).toBe(false);
  });
});

describe("isCurrentFoldedControl", () => {
  /**
   * The fold is persisted whole and rehydrated behind an unchecked `as T`, so a
   * snapshot from a build that predates a field arrives typed as though it has
   * one. `FoldedChannel.metadata` is exactly that field, and its readers
   * dereference it — hence the boundary check rather than a guard per reader.
   */
  it("rejects a snapshot whose channels predate `metadata`", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const channelId = random32();
    const wrap = await sealEdition(
      buildChannelEdition(channelId, normalizeChannelMetadata({ name: "general", private: false }), {
        actorPubkey: owner.pubkey,
        version: 1n,
      }),
      control,
      owner,
    );
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);
    expect(isCurrentFoldedControl(folded)).toBe(true);

    const idHex = bytesToHex(channelId);
    const { metadata: _dropped, ...older } = folded.channels.get(idHex)!;
    folded.channels.set(idHex, older as FoldedChannel);
    expect(isCurrentFoldedControl(folded)).toBe(false);

    // What accepting it would have cost: the readers dereference `metadata`.
    expect(() => channelCategory(folded.channels.get(idHex)!.metadata)).toThrow(TypeError);
  });

  /**
   * The same failure, one field later. This one reached production: a snapshot
   * written before Pins passed every check (`channels` and `heads` were both
   * Maps), and `usePins`'s first read of `pinLists.get()` threw inside a
   * render, taking down the whole React tree for anyone with a cached fold.
   */
  it("rejects a snapshot that predates `pinLists`", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const channelId = random32();
    const wrap = await sealEdition(
      buildChannelEdition(channelId, normalizeChannelMetadata({ name: "general", private: false }), {
        actorPubkey: owner.pubkey,
        version: 1n,
      }),
      control,
      owner,
    );
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);
    expect(isCurrentFoldedControl(folded)).toBe(true);

    const { pinLists: _dropped, ...older } = folded;
    expect(isCurrentFoldedControl(older as FoldedControl)).toBe(false);

    // What accepting it would have cost: a TypeError inside a render memo.
    expect(() => (older as FoldedControl).pinLists.get("aa".repeat(32))).toThrow(TypeError);
  });

  it("rejects a miss, and anything that isn't a fold", () => {
    expect(isCurrentFoldedControl(undefined)).toBe(false);
    expect(isCurrentFoldedControl(null)).toBe(false);
    expect(isCurrentFoldedControl({})).toBe(false);
    // `channels` survives JSON only because the codec revives it as a Map; a
    // plain object here means the snapshot was written by something else.
    expect(isCurrentFoldedControl({ channels: {}, heads: new Map() })).toBe(false);
    // Every Map is load-bearing: missing any one of them is a stale shape.
    expect(isCurrentFoldedControl({ channels: new Map(), heads: new Map() }), "no pinLists").toBe(false);
  });

  it("rejects a snapshot that predates `signals`", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const wrap = await sealEdition(
      buildSignalsEdition(communityId, SIGNAL_PAUSE, { paused: true }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);
    expect(isCurrentFoldedControl(folded)).toBe(true);
    const { signals: _dropped, ...older } = folded;
    expect(isCurrentFoldedControl(older as FoldedControl)).toBe(false);
  });
});

describe("community signals — pause (vsk 12, CORD-04 §8)", () => {
  const pauseWrap = (
    communityId: Uint8Array,
    control: GroupKey,
    by: ReturnType<typeof signer>,
    content: Record<string, unknown>,
    o: { version: bigint; prevHash?: Uint8Array; createdAtSecs?: number; authority?: ReturnType<typeof citeGrant> },
  ) => sealEdition(buildSignalsEdition(communityId, SIGNAL_PAUSE, content, { actorPubkey: by.pubkey, ...o }), control, by);

  it("folds an owner's pause and activePause reports its enactment time", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const wrap = await pauseWrap(communityId, control, owner, { paused: true }, { version: 1n, createdAtSecs: 1000 });
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);

    expect(folded.signals.get(SIGNAL_PAUSE)?.content).toEqual({ paused: true });
    expect(activePause(folded, 1500)).toEqual({ since: 1000, by: owner.pubkey });
  });

  it("honors an optional `until`: active before it, self-clears after", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const wrap = await pauseWrap(communityId, control, owner, { paused: true, until: 2000 }, { version: 1n, createdAtSecs: 1000 });
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);

    expect(activePause(folded, 1999)).toEqual({ since: 1000, until: 2000, by: owner.pubkey });
    // At and past `until` the pause is inert with no clearing edition needed.
    expect(activePause(folded, 2000)).toBeUndefined();
    expect(activePause(folded, 5000)).toBeUndefined();
  });

  it("a later `paused:false` edition clears an active pause", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const v1 = await pauseWrap(communityId, control, owner, { paused: true }, { version: 1n, createdAtSecs: 1000 });
    const prevHash = openControlWraps([v1], [control])[0].selfHash;
    const v2 = await pauseWrap(communityId, control, owner, { paused: false }, { version: 2n, prevHash, createdAtSecs: 1100 });
    const folded = foldControlState(openControlWraps([v1, v2], [control]), communityId, owner.pubkey);

    expect(folded.signals.get(SIGNAL_PAUSE)?.content).toEqual({ paused: false });
    expect(activePause(folded, 1500)).toBeUndefined();
  });

  it("drops a pause from an author without MANAGE_CHANNELS (fail closed)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const stranger = signer();
    // A roleless non-owner has no authority — their pause never folds, and an
    // owner-signed vac they don't hold can't be forged, so `activePause` is empty.
    const wrap = await pauseWrap(communityId, control, stranger, { paused: true }, { version: 1n });
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);

    expect(folded.signals.has(SIGNAL_PAUSE)).toBe(false);
    expect(activePause(folded, 1500)).toBeUndefined();
  });

  it("drops a pause whose `until` is beyond the 30-day bound", async () => {
    const { owner, communityId, control } = await makeCommunity();
    // The mistake this catches: milliseconds written into a seconds field. It
    // is silent (the edition is otherwise well-formed, and folds) and severe
    // (a freeze no expiry ever clears), so the head must fail outright.
    const now = 1_700_000_000;
    const wrap = await pauseWrap(communityId, control, owner, { paused: true, until: now * 1000 }, {
      version: 1n,
      createdAtSecs: now,
    });
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);

    expect(folded.signals.has(SIGNAL_PAUSE)).toBe(false);
    expect(activePause(folded, now + 500)).toBeUndefined();
  });

  it("accepts an `until` at the bound and rejects a non-positive one", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const thirtyDays = 30 * 24 * 60 * 60;
    const ok = await pauseWrap(communityId, control, owner, { paused: true, until: 1000 + thirtyDays }, {
      version: 1n,
      createdAtSecs: 1000,
    });
    expect(
      activePause(foldControlState(openControlWraps([ok], [control]), communityId, owner.pubkey), 1500),
    ).toEqual({ since: 1000, until: 1000 + thirtyDays, by: owner.pubkey });

    const bad = await pauseWrap(communityId, control, owner, { paused: true, until: 0 }, {
      version: 1n,
      createdAtSecs: 1000,
    });
    expect(
      foldControlState(openControlWraps([bad], [control]), communityId, owner.pubkey).signals.has(SIGNAL_PAUSE),
    ).toBe(false);
  });

  it("drops a malformed pause (paused not a boolean)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const wrap = await pauseWrap(communityId, control, owner, { paused: "yes" }, { version: 1n });
    const folded = foldControlState(openControlWraps([wrap], [control]), communityId, owner.pubkey);

    expect(folded.signals.has(SIGNAL_PAUSE)).toBe(false);
  });

  it("lets a MANAGE_CHANNELS admin pause, citing their grant", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const adm = adminRole(bytesToHex(new Uint8Array(32).fill(3)));
    const roleWrap = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const grantWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const pause = await pauseWrap(communityId, control, admin, { paused: true }, {
      version: 1n,
      createdAtSecs: 1000,
      authority: citeGrant(grantWrap, control),
    });
    const folded = foldControlState(
      openControlWraps([roleWrap, grantWrap, pause], [control]),
      communityId,
      owner.pubkey,
    );

    expect(hasPermission(folded.roster, admin.pubkey, Permissions.MANAGE_CHANNELS)).toBe(true);
    expect(activePause(folded, 1500)).toEqual({ since: 1000, by: admin.pubkey });
  });
});

describe("foldControlState memo", () => {
  it("keys a held overwrite's allow and deny apart, so one pair isn't served for another", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_ROLES);
    const scope = hexKey();
    const held = (allow: bigint, deny: bigint): Overwrite => ({ scope, target: { kind: "everyone" }, allow, deny });
    // A floored overwrite the relay no longer serves stands as the reader held it.
    const floors = new Map([[bytesToHex(overwriteLocator(c.id, held(0n, 0n))), { version: 1n, hash: random32() }]]);
    const fold = (o: Overwrite) => foldControlState(base, c.id, c.owner, floors, undefined, { overwrites: [o] }).roster.overwrites;
    expect(fold(held(1n, 23n))).toEqual([held(1n, 23n)]);
    expect(fold(held(12n, 3n))).toEqual([held(12n, 3n)]);
  });
});
