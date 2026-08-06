/**
 * The Control Plane write gate — the staff-held control_root split
 * (CORD-01 Write-Restricted Streams; CORD-02 §2/§5; CORD-04 §3; CORD-06 §1/§3).
 */

import { getConversationKey } from "nostr-tools/nip44";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { mintCommunity } from "@/concord-v2/lib/community";
import { rehydrateCommunity, setControlRoot, toJoinMaterial, type CommunityListEntry } from "@/concord-v2/lib/communityList";
import {
  canWriteControl,
  controlGroups,
  currentControlGroup,
  currentControlWriteGroup,
  openControlWraps,
  sealEdition,
  buildMetadataEdition,
} from "@/concord-v2/lib/control";
import { bytesToHex, controlGroupKey, controlSignerGroupKey, random32 } from "@/concord-v2/lib/derive";
import {
  base64ToBytes,
  bytesToBase64,
  decodeControlWrap,
  decodeWrappedBaseKey,
  encodeControlWrap,
  encodeWrappedBaseKey,
  encodeWrappedKey,
} from "@/concord-v2/lib/rekey";
import { grantFromJSON, grantToJSON, isStaff, rolesMakeStaff, Permissions, STAFF_MASK, type CommunityRoles } from "@/concord-v2/lib/roles";
import { openWrap, StreamError, wrapSeal } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";

function member(sk = generateSecretKey()) {
  return {
    sk,
    pubkey: getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  };
}

/** A member's view of `c`: the address and read key, never the write secret. */
function memberView(c: CommunityV2): CommunityV2 {
  const entry: CommunityListEntry = {
    community_id: c.idHex,
    seed: toJoinMaterial(c),
    current: { ...toJoinMaterial(c) },
    added_at: 1,
  };
  delete entry.current.control_root;
  return rehydrateCommunity(entry)!;
}

describe("control_root split (CORD-02 §2)", () => {
  it("derives the signer from a different label than the read key (never collides)", () => {
    const secret = random32();
    const id = random32();
    expect(controlSignerGroupKey(secret, id, 0n).pk).not.toBe(controlGroupKey(secret, id, 0n).pk);
  });

  it("mintCommunity mints the split: address = signer pk, owner holds the secret", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    expect(community.controlPk).toBe(controlSignerGroupKey(community.controlRoot!, community.id, 0n).pk);
    expect(community.heldRoots[0].controlPk).toBe(community.controlPk);
    expect(canWriteControl(community)).toBe(true);
    expect(currentControlWriteGroup(community).pk).toBe(community.controlPk);
  });

  it("a member holds the address but cannot mint the write group", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const alice = memberView(community);
    expect(alice.controlPk).toBe(community.controlPk);
    expect(alice.controlRoot).toBeUndefined();
    expect(canWriteControl(alice)).toBe(false);
    expect(() => currentControlWriteGroup(alice)).toThrow(/staff/i);
  });

  it("a held secret that does not derive to the held address fails closed to read-only", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const corrupt = { ...community, controlRoot: random32() };
    expect(canWriteControl(corrupt)).toBe(false);
  });

  it("a staff wrap opens for a member; a member-forged wrap at the address is refused", async () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const alice = memberView(community);

    const rumor = buildMetadataEdition(community.id, { name: "Fleet", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const wrap = await sealEdition(rumor, currentControlWriteGroup(community), owner);

    // Alice reads it under the split view (address + read conv key).
    const [edition] = openControlWraps([wrap], controlGroups(alice));
    expect(edition).toBeDefined();
    expect(edition.author).toBe(owner.pubkey);

    // A member holds the read key, so they can BUILD a wrap whose content
    // decrypts — but they cannot sign it as the address. A forgery signed with
    // a key of their own fails the write-restricted signature check (the
    // forged wrap's author is not the plane's address at all; and one that
    // LIES about its author carries an unverifiable signature).
    const mallorySigner = controlGroupKey(alice.root, alice.id, alice.rootEpoch); // the legacy derivation — the best a member can do
    const seal = await (async () => {
      const forgedRumor = buildMetadataEdition(community.id, { name: "Pwned", relays: [] }, { actorPubkey: alice.owner, version: 2n });
      return finalizeEvent(
        { kind: 20014, content: JSON.stringify(forgedRumor), tags: [], created_at: forgedRumor.created_at },
        generateSecretKey(),
      );
    })();
    const forged = wrapSeal(seal, {
      sk: mallorySigner.sk,
      pk: community.controlPk!, // claim the split address…
      get convKey() {
        return currentControlGroup(alice).convKey;
      },
    });
    // …but the signature was made with a key that is not the address's.
    expect(() => openWrap(forged, currentControlGroup(alice))).toThrow(StreamError);
    expect(openControlWraps([forged], controlGroups(alice))).toEqual([]);
  });

  it("a community without controlPk keys the plane by the legacy derivation (pre-split epochs)", async () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const legacy: CommunityV2 = {
      ...community,
      controlPk: undefined,
      controlRoot: undefined,
      heldRoots: [{ epoch: 0n, key: community.root }],
    };
    const legacyGroup = controlGroupKey(legacy.root, legacy.id, 0n);
    expect(currentControlGroup(legacy).pk).toBe(legacyGroup.pk);
    expect(canWriteControl(legacy)).toBe(true); // every member holds the legacy plane whole
    const rumor = buildMetadataEdition(legacy.id, { name: "Fleet", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const wrap = await sealEdition(rumor, currentControlWriteGroup(legacy), owner);
    expect(openControlWraps([wrap], controlGroups(legacy)).length).toBe(1);
  });
});

describe("base rekey blob forms (CORD-06 §1)", () => {
  const communityId = random32();
  const newRoot = random32();
  const controlRoot = random32();
  const epoch = 3n;
  const controlPkHex = controlSignerGroupKey(controlRoot, communityId, epoch).pk;
  const controlPk = Uint8Array.from(controlPkHex.match(/../g)!.map((b) => parseInt(b, 16)));

  it("104-byte member blob round-trips root + control_pk, no secret", () => {
    const plain = encodeWrappedBaseKey(epoch, newRoot, controlPk);
    expect(plain.length).toBe(104);
    const decoded = decodeWrappedBaseKey(plain, communityId, epoch);
    expect(bytesToHex(decoded.newRoot)).toBe(bytesToHex(newRoot));
    expect(decoded.controlPk).toBe(controlPkHex);
    expect(decoded.controlRoot).toBeUndefined();
  });

  it("136-byte staff blob carries the secret, verified against its own pk", () => {
    const plain = encodeWrappedBaseKey(epoch, newRoot, controlPk, controlRoot);
    expect(plain.length).toBe(136);
    const decoded = decodeWrappedBaseKey(plain, communityId, epoch);
    expect(bytesToHex(decoded.controlRoot!)).toBe(bytesToHex(controlRoot));
    expect(decoded.controlPk).toBe(controlPkHex);
  });

  it("a mismatched control pair is refused whole, not partially adopted", () => {
    const plain = encodeWrappedBaseKey(epoch, newRoot, controlPk, random32());
    expect(() => decodeWrappedBaseKey(plain, communityId, epoch)).toThrow(/derive/i);
  });

  it("a legacy 72-byte base blob yields the root alone", () => {
    const plain = encodeWrappedKey(new Uint8Array(32), epoch, newRoot);
    const decoded = decodeWrappedBaseKey(plain, communityId, epoch);
    expect(bytesToHex(decoded.newRoot)).toBe(bytesToHex(newRoot));
    expect(decoded.controlPk).toBeUndefined();
  });

  it("any other width is malformed and dropped", () => {
    expect(() => decodeWrappedBaseKey(new Uint8Array(100), communityId, epoch)).toThrow(/72, 104 or 136/);
    expect(() => decodeWrappedBaseKey(new Uint8Array(137), communityId, epoch)).toThrow(/72, 104 or 136/);
  });

  it("the scope and epoch bind inside the ciphertext (unspliceable)", () => {
    const plain = encodeWrappedBaseKey(epoch, newRoot, controlPk);
    expect(() => decodeWrappedBaseKey(plain, communityId, epoch + 1n)).toThrow(/epoch/);
    const channelScoped = encodeWrappedKey(random32(), epoch, newRoot);
    expect(() => decodeWrappedBaseKey(channelScoped, communityId, epoch)).toThrow(/scope/);
  });
});

describe("the Grant's control_wrap (CORD-04 §3)", () => {
  it("epoch_be[8] ‖ control_root[32] round-trips through the pairwise wrap", () => {
    const granter = member();
    const promotee = member();
    const controlRoot = random32();
    const plain = encodeControlWrap(7n, controlRoot);
    expect(plain.length).toBe(40);

    // One ECDH either side can compute (the NIP-46 bunker path).
    const wrapped = nip44Encrypt(bytesToBase64(plain), getConversationKey(granter.sk, promotee.pubkey));
    const opened = base64ToBytes(nip44Decrypt(wrapped, getConversationKey(promotee.sk, granter.pubkey)));
    const decoded = decodeControlWrap(opened);
    expect(decoded.epoch).toBe(7n);
    expect(bytesToHex(decoded.controlRoot)).toBe(bytesToHex(controlRoot));
  });

  it("a wrong width is malformed", () => {
    expect(() => decodeControlWrap(new Uint8Array(39))).toThrow(/40 bytes/);
    expect(() => decodeControlWrap(new Uint8Array(72))).toThrow(/40 bytes/);
  });

  it("grant JSON carries control_wrap and round-trips; garbage is dropped", () => {
    const grant = { member: "ab".repeat(32), roleIds: [], controlWrap: "aGVsbG8=" };
    const parsed = grantFromJSON(grantToJSON(grant))!;
    expect(parsed.controlWrap).toBe("aGVsbG8=");
    // Absent stays absent (no `control_wrap: undefined` spelled onto the wire).
    expect(grantToJSON({ member: "ab".repeat(32), roleIds: [] })).not.toContain("control_wrap");
    // An oversize wrap is dropped, not carried.
    const bloated = JSON.stringify({ member: "ab".repeat(32), role_ids: [], control_wrap: "x".repeat(2000) });
    expect(grantFromJSON(bloated)!.controlWrap).toBeUndefined();
  });
});

describe("the staff set (CORD-04 §3)", () => {
  const roleAt = (roleId: string, permissions: bigint): CommunityRoles["roles"][number] => ({
    roleId,
    name: "r",
    position: 2,
    permissions,
    scope: { kind: "server" },
    color: 0,
  });

  it("KICK and MANAGE_MESSAGES are not staff bits; the six Control-writing bits are", () => {
    expect(STAFF_MASK & Permissions.KICK).toBe(0n);
    expect(STAFF_MASK & Permissions.MANAGE_MESSAGES).toBe(0n);
    for (const bit of [
      Permissions.MANAGE_ROLES,
      Permissions.MANAGE_CHANNELS,
      Permissions.MANAGE_METADATA,
      Permissions.BAN,
      Permissions.CREATE_INVITE,
      Permissions.PIN_MESSAGES,
    ]) {
      expect(STAFF_MASK & bit).toBe(bit);
    }
  });

  it("isStaff: the owner always; a moderation-only member never", () => {
    const ownerHex = "aa".repeat(32);
    const mod = "bb".repeat(32);
    const pinner = "cc".repeat(32);
    const roster: CommunityRoles = {
      roles: [roleAt("11".repeat(32), Permissions.KICK | Permissions.MANAGE_MESSAGES), roleAt("22".repeat(32), Permissions.PIN_MESSAGES)],
      grants: [
        { member: mod, roleIds: ["11".repeat(32)] },
        { member: pinner, roleIds: ["22".repeat(32)] },
      ],
    };
    expect(isStaff(roster, ownerHex, ownerHex)).toBe(true);
    expect(isStaff(roster, mod, ownerHex)).toBe(false);
    expect(isStaff(roster, pinner, ownerHex)).toBe(true);
    expect(rolesMakeStaff(roster, ["11".repeat(32)])).toBe(false);
    expect(rolesMakeStaff(roster, ["22".repeat(32)])).toBe(true);
  });
});

describe("the vault carries the split (CORD-02 §8)", () => {
  it("join material round-trips control_pk and (staff) control_root", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const jm = toJoinMaterial(community);
    expect(jm.control_pk).toBe(community.controlPk);
    expect(jm.control_root).toBe(bytesToHex(community.controlRoot!));
    const back = rehydrateCommunity({ community_id: community.idHex, seed: jm, current: jm, added_at: 1 })!;
    expect(back.controlPk).toBe(community.controlPk);
    expect(bytesToHex(back.controlRoot!)).toBe(bytesToHex(community.controlRoot!));
  });

  it("a control_root that no longer derives to the held address is not rehydrated", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const jm = { ...toJoinMaterial(community), control_root: bytesToHex(random32()) };
    const back = rehydrateCommunity({ community_id: community.idHex, seed: jm, current: jm, added_at: 1 })!;
    expect(back.controlPk).toBe(community.controlPk);
    expect(back.controlRoot).toBeUndefined();
  });

  it("setControlRoot records the secret only at the entry's own epoch", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const jm = toJoinMaterial(memberView(community));
    const list = {
      entries: [{ community_id: community.idHex, seed: jm, current: jm, added_at: 1 }],
      tombstones: [],
    };
    const rootHex = bytesToHex(community.controlRoot!);
    const updated = setControlRoot(list, community.idHex, 0, rootHex);
    expect(updated.entries[0].current.control_root).toBe(rootHex);
    // A stale adoption (the entry advanced meanwhile) is a no-op.
    const stale = setControlRoot(list, community.idHex, 1, rootHex);
    expect(stale.entries[0].current.control_root).toBeUndefined();
  });

  it("toJoinMaterial never inherits a prior snapshot's pair across an epoch change", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const prior = toJoinMaterial(community);
    // A (hypothetical stale) rotation to a legacy epoch must SHED the pair.
    const legacyNext: CommunityV2 = {
      ...community,
      root: random32(),
      rootEpoch: 1n,
      controlPk: undefined,
      controlRoot: undefined,
      heldRoots: [{ epoch: 1n, key: random32() }, ...community.heldRoots],
    };
    const jm = toJoinMaterial(legacyNext, { prior });
    expect(jm.control_pk).toBeUndefined();
    expect(jm.control_root).toBeUndefined();
  });
});
