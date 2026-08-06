import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useControlFold2, citationFor, invalidateControl2, publishEdition2 } from "@/concord-v2/hooks/useControlPlane2";
import { useUpdateCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildGrantEdition, buildMetadataEdition, buildRoleEdition } from "@/concord-v2/lib/control";
import { bytesToHex, controlSignerGroupKey, grantLocator, hex32, random32 } from "@/concord-v2/lib/derive";
import { base64ToBytes, bytesToBase64, decodeControlWrap, encodeControlWrap } from "@/concord-v2/lib/rekey";
import { adminRole, canActOnMember, canActOnPosition, emptyRoles, grantRefusal, moderatorRole, Permissions, rolesMakeStaff, STAFF_MASK, type MemberGrant, type Role } from "@/concord-v2/lib/roles";
import type { CommunityMetadata, CommunityV2, ImagePointer } from "@/concord-v2/lib/types";

/**
 * The `control_wrap` a Grant carries when its role set leaves `member` staff
 * (CORD-04 §3): the current epoch's `control_root`, NIP-44-encrypted under the
 * granter↔member pairwise key, `epoch_be[8] ‖ control_root[32]` inside.
 * `undefined` when nothing is owed — a legacy pre-split epoch, or a grant that
 * leaves the member non-staff. Attached on EVERY staff-leaving grant, not just
 * the first: a re-issue with a fresh wrap is the spec's own re-delivery path
 * (a lost key, a head superseded before its member fetched it), and the
 * marginal cost is one ECDH.
 *
 * Throws when a wrap is owed but this signer cannot mint one: a staff-making
 * edition MUST carry a wrap fresh for the current epoch — publishing without
 * it would seat a staffer who cannot write, silently.
 */
async function controlWrapOwed(
  community: CommunityV2,
  makesStaff: boolean,
  nip44: { encrypt(pubkey: string, plaintext: string): Promise<string> } | undefined,
  member: string,
): Promise<string | undefined> {
  if (!community.controlPk || !makesStaff) return undefined;
  if (!community.controlRoot) {
    // Unreachable in practice — publishing the edition itself needs the same
    // secret (publishEdition2's write gate) — but the promotion must not
    // outrun the delivery if that ever changes.
    throw new Error("You don't hold this community's staff write key, so you can't promote to staff yet.");
  }
  if (!nip44) throw new Error("This signer can't deliver the staff write key (NIP-44 unsupported).");
  return await nip44.encrypt(
    member,
    bytesToBase64(encodeControlWrap(community.rootEpoch, community.controlRoot)),
  );
}

/**
 * Metadata mutations (vsk 0, MANAGE_METADATA): edit name / description /
 * icon / banner / relays, version-chained off the held head. Unknown fields
 * (`custom`, vendor extensions) round-trip untouched (CORD-02 §6).
 */
export function useMetadataActions2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold2(community);

  const updateMetadata = useMutation<
    void,
    Error,
    { name?: string; description?: string; icon?: ImagePointer | null; banner?: ImagePointer | null; relays?: string[]; message_expiration?: number }
  >({
    mutationFn: async (patch) => {
      if (!user || !community) throw new Error("Not ready.");
      const current: CommunityMetadata =
        folded?.metadata ?? ({ name: community.name, relays: community.relays } as CommunityMetadata);

      const next: CommunityMetadata = { ...current }; // round-trips unknown fields
      if (patch.name !== undefined) next.name = patch.name.trim();
      if (patch.description !== undefined) next.description = patch.description.trim() || undefined;
      if (patch.icon !== undefined) next.icon = patch.icon ?? undefined;
      if (patch.banner !== undefined) next.banner = patch.banner ?? undefined;
      if (patch.relays !== undefined) next.relays = patch.relays;
      // CORD-08: off is the field's ABSENCE (absent/0 both read as off, but
      // writing nothing keeps the entity clean for clients that predate it).
      if (patch.message_expiration !== undefined) {
        if (patch.message_expiration > 0) next.message_expiration = Math.floor(patch.message_expiration);
        else delete next.message_expiration;
      }

      // A relay-list change fans out to old ∪ new: members still folding from
      // the old relays must see the edition that moves them.
      const publishRelays =
        patch.relays !== undefined ? [...new Set([...community.relays, ...patch.relays])] : undefined;

      const head = folded?.heads.get(community.idHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(community.id, next, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
        publishRelays ? { relays: publishRelays } : undefined,
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  return {
    metadata: folded?.metadata,
    updateMetadata: updateMetadata.mutateAsync,
    isUpdating: updateMetadata.isPending,
  };
}

/**
 * Roster mutations (vsk 1 Roles + vsk 3 Grants, MANAGE_ROLES): every member's
 * fold re-verifies the owner-rooted delegation chain, so a forged grant is
 * dropped network-wide.
 */
export function useRoles2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded, isLoading } = useControlFold2(community);

  const invalidate = () => {
    if (community) invalidateControl2(queryClient, community.idHex);
  };

  const grantHeadOf = (member: string) =>
    community ? folded?.heads.get(bytesToHex(grantLocator(community.id, hex32(member)))) : undefined;

  /** The stock Admin role id in the current roster, if one exists. */
  const adminRoleId = folded?.roster.roles.find((r) => r.name === "Admin")?.roleId;
  /** The stock Moderator role id in the current roster, if one exists. */
  const moderatorRoleId = folded?.roster.roles.find((r) => r.name === "Moderator")?.roleId;

  const saveRole = useMutation<string, Error, { role: Role }>({
    mutationFn: async ({ role }) => {
      if (!user || !community) throw new Error("Not ready.");
      const head = folded?.heads.get(role.roleId);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildRoleEdition(role, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
      return role.roleId;
    },
    onSuccess: invalidate,
  });

  const setMemberRoles = useMutation<void, Error, { member: string; roleIds: string[] }>({
    mutationFn: async ({ member, roleIds }) => {
      if (!user || !community) throw new Error("Not ready.");
      // The fold's own gate, applied before publishing (CORD-04 §2/§3): a
      // Grant whose signer doesn't outrank the member and every granted Role
      // is dropped by every verifier — fail here with a reason instead. The
      // UI pre-gates too, but a mutation must not rely on its callers.
      const ownerHex = folded?.ownerHex ?? community.owner;
      const refusal = grantRefusal(folded?.roster ?? emptyRoles(), user.pubkey, ownerHex, member, roleIds);
      if (refusal) throw new Error(refusal);
      const head = grantHeadOf(member);
      // A grant that leaves the member staff carries the staff write key in
      // the edition itself (CORD-04 §3) — promotion and delivery are one
      // signed edition.
      const controlWrap = await controlWrapOwed(
        community,
        rolesMakeStaff(folded?.roster ?? emptyRoles(), roleIds),
        user.signer.nip44,
        member,
      );
      const grant: MemberGrant = { member, roleIds, ...(controlWrap ? { controlWrap } : {}) };
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildGrantEdition(community.id, grant, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
    },
    onSuccess: invalidate,
  });

  /**
   * Promote/demote a member to a stock tier: "admin" (position 1, owner-grantable
   * only), "moderator" (position 2, grantable by any strict outranker holding
   * MANAGE_ROLES), or null (revoke — an empty grant). Pre-checks the same
   * authority rules every fold enforces (CORD-04 §3), so an action a verifier
   * would drop fails HERE with a readable error instead of publishing a grant
   * the whole network silently discards.
   */
  const setTier = useMutation<void, Error, { member: string; tier: "admin" | "moderator" | null }>({
    mutationFn: async ({ member, tier }) => {
      if (!user || !community) throw new Error("Not ready.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      const roster = folded?.roster ?? emptyRoles();

      // The fold's gate, applied up-front: changing someone's roles means
      // acting on them (strict outrank), and granting a role means outranking
      // the position it sits at.
      if (!canActOnMember(roster, user.pubkey, ownerHex, member, Permissions.MANAGE_ROLES)) {
        throw new Error("You don't outrank this member.");
      }
      const minted = tier === "admin" ? adminRole(bytesToHex(random32())) : tier === "moderator" ? moderatorRole(bytesToHex(random32())) : undefined;
      if (minted && !canActOnPosition(roster, user.pubkey, ownerHex, minted.position, Permissions.MANAGE_ROLES)) {
        throw new Error(tier === "admin" ? "Only the owner can grant Admin." : "You can't grant a role at this rank.");
      }

      // Ensure the stock role exists (mint + publish if absent).
      let roleId: string | undefined;
      if (minted) {
        roleId = tier === "admin" ? adminRoleId : moderatorRoleId;
        if (!roleId) {
          roleId = minted.roleId;
          await publishEdition2(
            nostr,
            community,
            user.signer,
            buildRoleEdition(minted, {
              actorPubkey: user.pubkey,
              version: 1n,
              authority: citationFor(community, folded, user.pubkey),
            }),
          );
        }
      }

      // A tier change swaps only the stock Admin/Moderator role — custom
      // roles the member holds ride along untouched.
      const stock = new Set([adminRoleId, moderatorRoleId].filter((id): id is string => Boolean(id)));
      const kept = (roster.grants.find((g) => g.member === member)?.roleIds ?? []).filter((id) => !stock.has(id));
      const head = grantHeadOf(member);
      // Both stock tiers hold Control-writing bits, so a promotion is always
      // staff-making (CORD-04 §3) — judged from the tier's own permission
      // bits rather than the roster, which may not have folded the role
      // edition just published above. A demotion to null can still leave the
      // member staff through a KEPT custom role, so check those too.
      const makesStaff =
        (minted !== undefined && (minted.permissions & STAFF_MASK) !== 0n) ||
        rolesMakeStaff(roster, kept);
      const controlWrap = await controlWrapOwed(community, makesStaff, user.signer.nip44, member);
      const grant: MemberGrant = {
        member,
        roleIds: roleId ? [...kept, roleId] : kept,
        ...(controlWrap ? { controlWrap } : {}),
      };
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildGrantEdition(community.id, grant, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
    },
    onSuccess: invalidate,
  });

  return {
    folded,
    isLoading,
    setTier: setTier.mutateAsync,
    isSettingTier: setTier.isPending,
    saveRole: saveRole.mutateAsync,
    isSavingRole: saveRole.isPending,
    setMemberRoles: setMemberRoles.mutateAsync,
    isSettingRoles: setMemberRoles.isPending,
    newRoleId: () => bytesToHex(random32()),
  };
}

/**
 * Adopt the staff write key delivered inside my own Grant (CORD-04 §3).
 *
 * A staff-making Grant carries `control_wrap` — the current `control_root`
 * NIP-44-encrypted under the granter↔me pairwise key. This watches my Grant's
 * folded head (the fold already gated the edition by rank, so a forged grant
 * never reaches here) and, when a wrap is present and I don't already hold the
 * secret, decrypts and verifies it: the plaintext's own epoch must be the one
 * I'm on, and the secret must derive to exactly the `control_pk` I hold for it
 * (CORD-02 §5) — any mismatch is dropped, never adopted. A stale wrap is
 * structural, not hostile: compaction re-wraps a Grant head verbatim across
 * Refoundings, and staff crossing a rotation get the new secret in their
 * 136-byte base blob instead.
 *
 * On success the secret is recorded in the Community List entry (the vault),
 * which is what makes it survive this device and reach the member's others.
 */
export function useStaffKeyWatch2(community: CommunityV2 | undefined): void {
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const queryClient = useQueryClient();
  // One decrypt attempt per (grant edition, epoch) per session: a wrap that
  // fails the checks will fail them identically on every re-fold.
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!community || !user || !folded) return;
    // Nothing to adopt: a legacy epoch has no write key, and a held secret
    // has already been verified against the address by rehydrateCommunity.
    if (!community.controlPk || community.controlRoot) return;
    const nip44 = user.signer.nip44;
    if (!nip44) return;

    const eidHex = bytesToHex(grantLocator(community.id, hex32(user.pubkey)));
    const head = folded.headEditions.get(eidHex);
    if (!head) return;
    const grant = folded.roster.grants.find((g) => g.member === user.pubkey);
    if (!grant?.controlWrap) return;

    const key = `${bytesToHex(head.rumorId)}:${community.rootEpoch}`;
    if (attempted.current.has(key)) return;
    attempted.current.add(key);

    let cancelled = false;
    void (async () => {
      let controlRoot: Uint8Array;
      try {
        // The granter is the head edition's sealed author — the pairwise key's
        // other half (CORD-04 §3: one ECDH either side can compute).
        const plain = base64ToBytes(await nip44.decrypt(head.author, grant.controlWrap!));
        const decoded = decodeControlWrap(plain);
        // The epoch rides INSIDE the ciphertext; adopt only a wrap minted for
        // the epoch I'm on, whose secret derives to the address I hold.
        if (decoded.epoch !== community.rootEpoch) return;
        if (controlSignerGroupKey(decoded.controlRoot, community.id, decoded.epoch).pk !== community.controlPk) return;
        controlRoot = decoded.controlRoot;
      } catch {
        return; // undecryptable / malformed — attributable griefing, nothing worse
      }
      if (cancelled) return;
      await updateList({
        type: "set-control-root",
        communityId: community.idHex,
        epoch: Number(community.rootEpoch),
        controlRootHex: bytesToHex(controlRoot),
      }).catch(() => {
        // The list write never landed; let a later fold retry.
        attempted.current.delete(key);
      });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, community?.controlPk, Boolean(community?.controlRoot), user?.pubkey, folded]);
}
