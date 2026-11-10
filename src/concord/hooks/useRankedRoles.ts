import { useState, useSyncExternalStore } from "react";
import { useNostr } from "@nostrify/react";

type NostrClient = ReturnType<typeof useNostr>["nostr"];
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { citationFor, foldStoredControl, invalidateControl, publishEdition, readControlWhole, useControlFold, withControlWrite } from "@/concord/hooks/useControlPlane";
import { controlWrapOwed } from "@/concord/hooks/useRoles";
import { buildGrantEdition, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, grantLocator, hex32 } from "@/concord/lib/derive";
import {
  carryForward,
  planActivation,
  planCreateCategory,
  planCreateRole,
  planDeleteCategory,
  planDeleteRole,
  planEditRole,
  planMoveCategory,
  planMoveRole,
  planOverwrite,
  planRenameCategory,
  planReorder,
  planSetEveryone,
  planSync,
  type RoleFields,
} from "@/concord/lib/rankedWrites";
import { rolesMakeStaff, type OverwriteTarget } from "@/concord/lib/roles";
import { planTenure, tenureRefusal } from "@/concord/lib/tenure";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { activationPending, activationPendingReady, setActivationPending, subscribeActivationPending } from "@/concord/lib/activationPending";
import { t } from "@/i18n";
import type { NostrRumor } from "@/lib/nostrRumor";

/** How long a write that seals nothing waits for the plane read whole before planning on the store. */
const WHOLE_READ_BUDGET_MS = 6000;

/** A write that must read the plane whole couldn't: a network problem, not a refusal. */
const needsWhole = () =>
  t({ id: "useRankedRoles.switchNeedsWhole", defaultMessage: "The community couldn't be read in full; try again once the relays answer." });

/**
 * Publish the switch to the vsk-13 Roster planned on `folded` (CORD-04 §2), the
 * sidebar carried across with it; the Private Channels left unfiled come back.
 */
export async function publishActivation(
  nostr: NostrClient,
  community: Community,
  user: { pubkey: string; signer: Parameters<typeof publishEdition>[2] },
  folded: FoldedControl,
  everyone?: bigint,
  onPublished?: () => void,
): Promise<string[]> {
  const { rumors, unfiled } = planActivation(folded, community.id, user.pubkey, everyone, community.privateChannels);
  await activationPendingReady();
  setActivationPending(user.pubkey, community.idHex, rumors);
  await publishPendingActivation(nostr, community, user, onPublished);
  return unfiled;
}

/**
 * Publish what is left of a switch cut short (`activationPending.ts`), one edition at
 * a time, recording each as it lands so a second interruption resumes after it.
 */
export async function publishPendingActivation(
  nostr: NostrClient,
  community: Community,
  user: { pubkey: string; signer: Parameters<typeof publishEdition>[2] },
  onPublished?: () => void,
): Promise<void> {
  await activationPendingReady();
  let left = activationPending(user.pubkey, community.idHex) ?? [];
  while (left.length > 0) {
    await publishEdition(nostr, community, user.signer, left[0]);
    left = left.slice(1);
    setActivationPending(user.pubkey, community.idHex, left);
    onPublished?.();
  }
}

/**
 * The vsk-13 Roster's editors (CORD-03 §4, CORD-04 §2, §3, §8): Roles, `@everyone`,
 * Channel and Category rules, Categories, and the owner's switch from the legacy
 * Roster. Each write is planned on a fresh whole read where one lands, and on the
 * held fold otherwise; a write that takes authority away needs the whole read, so
 * its holders' Tenures are sealed first (CORD-04 §9). Keys follow through the
 * access duty `publishEdition` wakes.
 */
export function useRankedRoles(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: held } = useControlFold(community);
  const activationLeft = useSyncExternalStore(subscribeActivationPending, () =>
    user && community ? activationPending(user.pubkey, community.idHex)?.length ?? 0 : 0,
  );

  const ready = () => {
    if (!user || !community) throw new Error(t({ id: "useRoles.notReady", defaultMessage: "Not ready." }));
    return { user, community };
  };

  const heldKeys = (c: Community) => new Set(c.privateChannels.map((k) => bytesToHex(k.id)));

  /**
   * The fold to plan on: the plane read whole when the change needs it. A change that
   * needn't seal anything waits at most {@link WHOLE_READ_BUDGET_MS} for one: the store
   * holds every edition the live subscription brought, and one hung relay would
   * otherwise hold the save for its query timeout, twice. The read runs on regardless.
   */
  const read = async (c: Community, strict: boolean): Promise<{ folded: FoldedControl; served?: Set<string>; whole: boolean }> => {
    const reading = readControlWhole(nostr, c);
    const whole = strict
      ? await reading
      : await Promise.race([reading, new Promise<undefined>((resolve) => setTimeout(resolve, WHOLE_READ_BUDGET_MS))]);
    if (whole) return { ...whole, whole: true };
    if (strict) throw new Error(needsWhole());
    // The store's fold, not the rendered one: it holds this device's last write.
    const stored = await foldStoredControl(c).catch(() => held);
    if (!stored) throw new Error(needsWhole());
    return { folded: stored, whole: false };
  };

  /** Editions the running write has published, for its progress line. */
  const [published, setPublished] = useState(0);
  const notePublished = () => setPublished((n) => n + 1);

  /** One write at a time per community (Vector `follow_lock`). */
  const write = <T,>(run: () => Promise<T>): Promise<T> => {
    setPublished(0);
    return community ? withControlWrite(community.idHex, run) : run();
  };

  const publish = async (c: Community, rumors: NostrRumor[]) => {
    const { user } = ready();
    for (const rumor of rumors) {
      await publishEdition(nostr, c, user.signer, rumor);
      notePublished();
    }
  };

  /** Seal each holder's Tenure before a Role they hold loses authority (Vector `Seal::Strict`). */
  const sealHolders = async (c: Community, folded: FoldedControl, served: Set<string> | undefined, holders: string[]) => {
    const { user } = ready();
    for (const member of holders) {
      const plan = planTenure(folded, c.id, user.pubkey, member, false, citationFor(c, folded, user.pubkey), served);
      if (plan.kind === "refuse") throw new Error(tenureRefusal());
      if (plan.kind === "write") {
        await publishEdition(nostr, c, user.signer, plan.rumor);
        notePublished();
      }
    }
  };

  const done = () => {
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const createRole = useMutation<string, Error, Pick<RoleFields, "name" | "color" | "permissions"> & Partial<RoleFields>>({
    mutationFn: (fields) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      const { roleId, rumor } = planCreateRole(folded, community.id, user.pubkey, fields, citationFor(community, folded, user.pubkey));
      await publish(community, [rumor]);
      return roleId;
    }),
    onSuccess: done,
  });

  const editRole = useMutation<void, Error, { roleId: string; fields: RoleFields }>({
    mutationFn: ({ roleId, fields }) => write(async () => {
      const { user, community } = ready();
      const current = held?.roster.roles.find((r) => r.roleId === roleId);
      const { folded, served, whole } = await read(community, current !== undefined && (current.permissions & ~fields.permissions) !== 0n);
      const plan = planEditRole(folded, community.id, user.pubkey, roleId, fields, citationFor(community, folded, user.pubkey));
      if (plan.reduces) {
        if (!whole) throw new Error(needsWhole());
        await sealHolders(community, folded, served, plan.holders);
      }
      await publish(community, [plan.rumor]);
    }),
    onSuccess: done,
  });

  /**
   * One Role move on `view`, then the Grants it would orphan signed again by the mover, a
   * staff one carrying the key from them (CORD-04 §3). Returns the view carried forward.
   */
  const applyMove = async (c: Community, view: FoldedControl, whole: boolean, served: Set<string> | undefined, roleId: string, index: number): Promise<FoldedControl> => {
    const { user } = ready();
    const authority = citationFor(c, view, user.pubkey);
    const plan = planMoveRole(view, c.id, user.pubkey, roleId, index, authority);
    if (plan.lowers) {
      if (!whole) throw new Error(needsWhole());
      await sealHolders(c, view, served, plan.holders);
    }
    // The Grants go first: signed by the mover they stand with the Role where it is and
    // where it goes, so a run that stops partway orphans nobody, and a retry plans only
    // what is left. Published after the move, a failure stripped the Role from the rest
    // and a retry, finding the order already right, never signed them again.
    const grants: NostrRumor[] = [];
    for (const g of plan.resign) {
      const head = view.heads.get(bytesToHex(grantLocator(c.id, hex32(g.member))));
      const controlWrap = await controlWrapOwed(c, rolesMakeStaff(view.roster, g.roleIds), user.signer.nip44, g.member);
      const rumor = buildGrantEdition(c.id, { ...g, ...(controlWrap ? { controlWrap } : {}) }, {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        authority,
      });
      await publish(c, [rumor]);
      grants.push(rumor);
    }
    await publish(c, [plan.rumor]);
    return carryForward(view, [plan.rumor, ...grants], { roleId, rank: plan.rank });
  };

  const moveRole = useMutation<void, Error, { roleId: string; index: number }>({
    mutationFn: ({ roleId, index }) => write(async () => {
      const { community } = ready();
      const { folded, served, whole } = await read(community, false);
      await applyMove(community, folded, whole, served, roleId, index);
    }),
    onSuccess: done,
  });

  /** Reorder the Roles to `ordered`, top first, each move judged on the one before it (Vector `reorder_roles_v2`). */
  const reorderRoles = useMutation<number, Error, { ordered: string[] }>({
    mutationFn: ({ ordered }) => write(async () => {
      const { community } = ready();
      const { folded, served, whole } = await read(community, false);
      let view = folded;
      const moves = planReorder(folded, ordered);
      for (const m of moves) view = await applyMove(community, view, whole, served, m.roleId, m.index);
      return moves.length;
    }),
    onSuccess: done,
  });

  const deleteRole = useMutation<void, Error, { roleId: string }>({
    mutationFn: ({ roleId }) => write(async () => {
      const { user, community } = ready();
      const { folded, served } = await read(community, true);
      const plan = planDeleteRole(folded, community.id, user.pubkey, roleId, citationFor(community, folded, user.pubkey));
      await sealHolders(community, folded, served, plan.holders);
      await publish(community, [plan.rumor]);
    }),
    onSuccess: done,
  });

  const setEveryone = useMutation<void, Error, { permissions: bigint }>({
    mutationFn: ({ permissions }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      await publish(community, [planSetEveryone(folded, community.id, user.pubkey, permissions, citationFor(community, folded, user.pubkey))]);
    }),
    onSuccess: done,
  });

  const setOverwrite = useMutation<void, Error, { scope: string; target: OverwriteTarget; allow: bigint; deny: bigint }>({
    mutationFn: ({ scope, target, allow, deny }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      await publish(community, [planOverwrite(folded, community.id, user.pubkey, heldKeys(community), scope, target, allow, deny, citationFor(community, folded, user.pubkey))]);
    }),
    onSuccess: done,
  });

  const setSync = useMutation<void, Error, { channelIdHex: string; category: string | undefined }>({
    mutationFn: ({ channelIdHex, category }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      await publish(community, [planSync(folded, community.id, user.pubkey, heldKeys(community), channelIdHex, category, citationFor(community, folded, user.pubkey))]);
    }),
    onSuccess: done,
  });

  const createCategory = useMutation<string, Error, { name: string }>({
    mutationFn: ({ name }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      const { idHex, rumor } = planCreateCategory(folded, community.id, user.pubkey, name, citationFor(community, folded, user.pubkey));
      await publish(community, [rumor]);
      return idHex;
    }),
    onSuccess: done,
  });

  const renameCategory = useMutation<void, Error, { idHex: string; name: string }>({
    mutationFn: ({ idHex, name }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      await publish(community, [planRenameCategory(folded, community.id, user.pubkey, idHex, name, citationFor(community, folded, user.pubkey))]);
    }),
    onSuccess: done,
  });

  const moveCategory = useMutation<void, Error, { idHex: string; index: number }>({
    mutationFn: ({ idHex, index }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      await publish(community, planMoveCategory(folded, community.id, user.pubkey, idHex, index, citationFor(community, folded, user.pubkey)));
    }),
    onSuccess: done,
  });

  const deleteCategory = useMutation<void, Error, { idHex: string }>({
    mutationFn: ({ idHex }) => write(async () => {
      const { user, community } = ready();
      const { folded } = await read(community, false);
      await publish(community, [planDeleteCategory(folded, community.id, user.pubkey, idHex, citationFor(community, folded, user.pubkey))]);
    }),
    onSuccess: done,
  });

  /** The switch lists every Channel that stands, so it is planned on the plane read whole. */
  /** Resolves to the Private Channels the switch couldn't file, their keys not held here. */
  const activate = useMutation<string[], Error, { everyone?: bigint }>({
    mutationFn: ({ everyone }) => write(async () => {
      const { user, community } = ready();
      await activationPendingReady();
      // A switch cut short finishes the plan it made rather than planning another.
      if (activationPending(user.pubkey, community.idHex)) {
        await publishPendingActivation(nostr, community, user, notePublished);
        return [];
      }
      const whole = await readControlWhole(nostr, community);
      if (!whole) throw new Error(needsWhole());
      return publishActivation(nostr, community, user, whole.folded, everyone, notePublished);
    }),
    onSuccess: done,
  });

  return {
    folded: held,
    createRole: createRole.mutateAsync,
    editRole: editRole.mutateAsync,
    moveRole: moveRole.mutateAsync,
    reorderRoles: reorderRoles.mutateAsync,
    deleteRole: deleteRole.mutateAsync,
    setEveryone: setEveryone.mutateAsync,
    setOverwrite: setOverwrite.mutateAsync,
    setSync: setSync.mutateAsync,
    createCategory: createCategory.mutateAsync,
    renameCategory: renameCategory.mutateAsync,
    moveCategory: moveCategory.mutateAsync,
    deleteCategory: deleteCategory.mutateAsync,
    activate: activate.mutateAsync,
    isActivating: activate.isPending,
    /** Editions of this owner's switch still unpublished (`activationPending.ts`). */
    activationLeft,
    /** Editions the running write has published so far. */
    published,
    isSaving:
      createRole.isPending || editRole.isPending || moveRole.isPending || reorderRoles.isPending || deleteRole.isPending || setEveryone.isPending || setOverwrite.isPending || setSync.isPending ||
      createCategory.isPending || renameCategory.isPending || moveCategory.isPending || deleteCategory.isPending,
  };
}
