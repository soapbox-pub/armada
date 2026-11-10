import { channelDisplayName } from "@/concord/lib/community";
import { useNostr } from "@nostrify/react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useControlFold, citationFor, foldStoredControl, invalidateControl, publishEdition, readControlWhole, withControlWrite } from "@/concord/hooks/useControlPlane";
import { useGuestbook, useGuestbookPublisher } from "@/concord/hooks/useGuestbook";
import { useChannelRekey, useRefound } from "@/concord/hooks/useRekey";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { banChannelCuts } from "@/concord/lib/channelAccess";
import { banShouldRotateMany, buildBanlistEdition, buildGrantEdition, hasForeignLiveLinks } from "@/concord/lib/control";
import { banlistLocator, bytesToHex, grantLocator, hex32 } from "@/concord/lib/derive";
import {
  addReadCutPending,
  clearReadCutPending,
  readCutPending,
  readCutPendingReady,
} from "@/concord/lib/readCutPending";
import { canActOnMember, isAuthorized, Permissions } from "@/concord/lib/roles";
import { planTenure, tenureRefusal } from "@/concord/lib/tenure";
import type { Community } from "@/concord/lib/types";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";

/**
 * The Three Removals, ordered by when their guarantees arrive (CORD-04 §6):
 *
 *   - KICK: grant strip, then the cooperative Guestbook directive (re-joinable).
 *   - BAN: the targets' Tenures, then the Banlist edition (instant silencing), grant strip alongside,
 *     Refounding LAST — and only in a Private community. A Public ban keeps the
 *     community keys (CORD-05 §5): live links would strand joiners on a dead
 *     epoch. It still rotates the targets' Private Channels, which no link vends.
 *   - UNBAN: a Banlist edition dropping the npub (access needs a re-invite).
 *
 * Plus `rotateKeys`: a Refounding with an empty exclusion set. `recipients` is
 * who KEEPS access after a Refounding.
 */
/** The ban's steps, in execution order, for progress UI. */
export type BanPhase = "silence" | "roles" | "rekey";

/** Stable fallback so a fold-less render doesn't mint a fresh Set identity. */
const NO_BANNED = new Set<string>();

export function useModeration(community: Community | undefined, recipients: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const guestbook = useGuestbookPublisher(community);
  const { coalesced, data: guestbookRead } = useGuestbook(community);
  const { refound, canRefound } = useRefound(community);
  const { rekeyChannel, canSeverChannel } = useChannelRekey(community);

  const canActOn = (target: string, permission: bigint): boolean =>
    Boolean(user && folded && canActOnMember(folded.roster, user.pubkey, folded.ownerHex, target, permission));

  const invalidate = () => {
    if (community) {
      invalidateControl(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord", "guestbook", community.idHex] });
    }
  };

  /**
   * Publish the whole banlist, replaced entire: `change` applied to the list this device
   * stores now, which holds its own last ban (the rendered fold lags it), one write at a time.
   */
  const publishBanlist = async (change: (banned: Set<string>) => void) => {
    if (!user || !community) throw new Error(t({ id: "useModeration.notReady", defaultMessage: "Not ready." }));
    const c = community;
    const u = user;
    await withControlWrite(c.idHex, async () => {
      const now = await foldStoredControl(c).catch(() => folded);
      const banned = new Set(now?.banned ?? []);
      change(banned);
      const head = now?.heads.get(bytesToHex(banlistLocator(c.id)));
      await publishEdition(
        nostr,
        c,
        u.signer,
        buildBanlistEdition(c.id, [...banned], {
          actorPubkey: u.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(c, now, u.pubkey),
        }),
      );
    });
  };

  /**
   * The members' Tenures, so what they decided keeps standing past a removal (CORD-04 §6, §9),
   * sealed on the plane read whole again; a removal never waits on a read (Vector `Seal::BestEffort`).
   */
  const sealStanding = async (targets: string[]) => {
    if (!user || !community || !folded?.rankedRoster) return;
    const whole = await readControlWhole(nostr, community);
    if (!whole) return;
    for (const target of targets) {
      const plan = planTenure(whole.folded, community.id, user.pubkey, target, true, citationFor(community, whole.folded, user.pubkey), whole.served);
      if (plan.kind === "refuse") throw new Error(tenureRefusal());
      if (plan.kind === "write") await publishEdition(nostr, community, user.signer, plan.rumor);
    }
  };

  /**
   * Strip every role from a member. Skipped when the fold would drop it (needs
   * MANAGE_ROLES + strict outrank, CORD-04 §5); one attempted and lost is an error,
   * since going on would leave the member their rank (Vector `kick_member`). `sealed` when the
   * member's Tenure already went out in this action.
   */
  const stripRoles = async (target: string, sealed = false) => {
    if (!user || !community) return;
    const hasGrant = folded?.roster.grants.some((g) => g.member === target && g.roleIds.length > 0);
    if (!hasGrant) return;
    if (!canActOn(target, Permissions.MANAGE_ROLES)) return;
    if (!sealed) await sealStanding([target]);
    const c = community;
    const u = user;
    await withControlWrite(c.idHex, async () => {
      const now = await foldStoredControl(c).catch(() => folded);
      const head = now?.heads.get(bytesToHex(grantLocator(c.id, hex32(target))));
      await publishEdition(
        nostr,
        c,
        u.signer,
        buildGrantEdition(
          c.id,
          { member: target, roleIds: [] },
          {
            actorPubkey: u.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(c, now, u.pubkey),
          },
        ),
      );
    });
  };

  /** Every live Private Channel, flagged by whether I hold its key. */
  const privateChannels = () => {
    const held = new Set(community?.privateChannels.map((ch) => bytesToHex(ch.id)) ?? []);
    return [...(folded?.channels.values() ?? [])]
      .filter((c) => c.isPrivate && !c.deleted)
      .map((c) => ({ idHex: c.channelIdHex, heldByMe: held.has(c.channelIdHex) }));
  };

  /** Rotate each channel away from the banned; toast the ones that still leak. */
  const cutChannels = async (cuts: ReturnType<typeof banChannelCuts>, targets: string[]) => {
    const leaked: string[] = [];
    for (const cut of cuts) {
      const name = `#${channelDisplayName(community, folded, cut.channelIdHex)}`;
      if (!cut.heldByMe || !canSeverChannel) {
        leaked.push(name);
        continue;
      }
      try {
        await rekeyChannel({ channelIdHex: cut.channelIdHex, keepRecipients: cut.keep, removedTargets: cut.removed, forBan: true });
      } catch {
        leaked.push(name);
      }
    }
    if (leaked.length === 0) return;
    toast({
      title: t({ id: "useModeration.channelsNotCut.title", defaultMessage: "Private channel keys not rotated" }),
      description: t(
        {
          id: "useModeration.channelsNotCut.description",
          defaultMessage:
            "{count, plural, one {The banned member can} other {The banned members can}} still read {channels} until someone who holds the key and can manage channels rotates it.",
        },
        { count: targets.length, channels: leaked.join(", ") },
      ),
      variant: "destructive",
    });
  };

  const banMany = useMutation<
    { rekeyed: boolean; publicBan: boolean; banned: string[]; skipped: string[] },
    Error,
    {
      targets: string[];
      onPhase?: (phase: BanPhase) => void;
      onStripProgress?: (done: number, total: number) => void;
      forceRotate?: boolean;
    }
  >({
    mutationFn: async ({ targets, onPhase, onStripProgress, forceRotate }) => {
      if (!user || !community) throw new Error(t({ id: "useModeration.notReady", defaultMessage: "Not ready." }));
      const unique = [...new Set(targets)];
      const eligible = unique.filter((t) => canActOn(t, Permissions.BAN));
      const skipped = unique.filter((t) => !canActOn(t, Permissions.BAN));
      if (eligible.length === 0) {
        throw new Error(
          unique.length === 1
            ? t({ id: "useModeration.banNoPermissionOne", defaultMessage: "You don't have permission to ban this member." })
            : t({ id: "useModeration.banNoPermissionMany", defaultMessage: "You don't have permission to ban any of these members." }),
        );
      }

      // Fail fast BEFORE publishing: a rotating ban needs a NIP-44 signer, or the
      // banlist lands with no read-cut coming. `forceRotate` is for control-plane
      // abuse, where the rotation (stranding the flooder's root) is the remedy.
      const willRotate = banShouldRotateMany(folded, user.pubkey, eligible, forceRotate);
      if (willRotate && !canRefound) {
        throw new Error(
          t({ id: "useModeration.banNeedsEncryption", defaultMessage: "Banning from a private community rotates the community keys, which your signer can't do. Ask an admin whose signer supports encryption to carry out the ban." }),
        );
      }

      // Judged on the pre-strip roster: once the Grants land, nobody holds the role to cut.
      const joined = [...coalesced].filter(([, m]) => m.state === "join").map(([pk]) => pk);
      const channelCuts = folded ? banChannelCuts(folded.roster, folded.ownerHex, eligible, privateChannels(), folded.banned, joined) : [];

      // 0. Their Tenures before the Banlist: a ban drops every edition no Tenure lists (CORD-04 §9).
      onPhase?.("silence");
      await sealStanding(eligible);

      // 1. Banlist (instant); it replaces entire (CORD-04 §4), so one edition.
      await publishBanlist((banned) => {
        for (const t of eligible) banned.add(t);
      });

      // 2. Role removal alongside — per-member entities, so per-member editions.
      onPhase?.("roles");
      let stripped = 0;
      for (const t of eligible) {
        await stripRoles(t, true);
        stripped += 1;
        onStripProgress?.(stripped, eligible.length);
      }

      // 3. The Refounding last — never while a FOREIGN live link exists (only its
      // creator can refresh its bundle); our own links are refreshed by the refound.
      // Judged for the whole group: one rotation, never one per target.
      if (folded && !banShouldRotateMany(folded, user.pubkey, eligible, forceRotate)) {
        // No link vends a Private Channel key (CORD-05 §2), so the channels can
        // still be rotated away from the targets without stranding anyone.
        if (channelCuts.length > 0) onPhase?.("rekey");
        await cutChannels(channelCuts, eligible);
        return { rekeyed: false, publicBan: true, banned: eligible, skipped };
      }
      if (!canRefound) return { rekeyed: false, publicBan: false, banned: eligible, skipped };
      onPhase?.("rekey");
      // Durable intent: mark BEFORE the attempt with the keep-list captured now
      // (roster warm), clear on success; a lost rotation retries from this list.
      const excluded = new Set(eligible);
      const keep = recipients.filter((pk) => !excluded.has(pk));
      for (const t of eligible) await addReadCutPending(user.pubkey, community.idHex, t, keep);
      try {
        await refound({ keep, exclude: eligible });
        clearReadCutPending(user.pubkey, community.idHex);
        return { rekeyed: true, publicBan: false, banned: eligible, skipped };
      } catch {
        return { rekeyed: false, publicBan: false, banned: eligible, skipped };
      }
    },
    onSuccess: invalidate,
  });

  /**
   * The Refounding alone: rotate community keys with nobody removed (CORD-06 §3,
   * empty exclusion set). Destructive — members who never adopt are stranded until
   * re-invited — so use it for suspect keys, not routine hygiene.
   *
   * Unlike a ban's rotation: foreign live links don't veto (refusing would leave
   * the suspect key live; the caller warns), and no read-cut intent is persisted
   * (nothing is severed, so the staffer can just retry).
   */
  const rotateKeys = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!user || !community) throw new Error(t({ id: "useModeration.notReady", defaultMessage: "Not ready." }));
      // An unsettled fold would rotate to a THIN recipient set and cut live members.
      if (!folded) throw new Error(t({ id: "useModeration.stillSyncing", defaultMessage: "Still syncing this community; try again shortly." }));
      // CORD-06 Refounder authority, checked before the sweep; rank is vacuous with
      // nothing excluded.
      if (!isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.BAN)) {
        throw new Error(t({ id: "useModeration.rotateNoPermission", defaultMessage: "You don't have permission to rotate this community's keys." }));
      }
      if (!canRefound) {
        throw new Error(
          t({ id: "useModeration.rotateNeedsEncryption", defaultMessage: "Rotating the community keys needs a signer that supports encryption, which yours doesn't. Ask an admin whose signer does." }),
        );
      }
      await refound({ keep: recipients, exclude: [] });
    },
    onSuccess: invalidate,
  });

  const unban = useMutation<void, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!canActOn(target, Permissions.BAN)) throw new Error(t({ id: "useModeration.noPermission", defaultMessage: "You don't have permission." }));
      // The Ban's departure first: a Kick dated at the Ban, or the pre-ban Join would
      // count them again. A Join after the Ban outranks it (CORD-04 §6).
      const bannedAt = folded?.bannedAt.get(target);
      // Only for a member whose standing Join predates the Ban (CORD-04 §6, Vector `publish_ban_departures`);
      // with the Guestbook not yet read, write it anyway: a spare Kick is outranked by a later Join.
      const standing = coalesced.get(target);
      const predates = (at: number) => !guestbookRead || (standing?.state === "join" && standing.ms <= at * 1000);
      if (bannedAt !== undefined && community && user && predates(bannedAt)) {
        const citation = citationFor(community, folded, user.pubkey);
        const vac = citation
          ? { eid: bytesToHex(citation.entityId), version: citation.version, hash: bytesToHex(citation.editionHash) }
          : undefined;
        await guestbook.mutateAsync({ type: "kick", target, vac, ms: bannedAt * 1000 });
      }
      await publishBanlist((banned) => void banned.delete(target));
    },
    onSuccess: invalidate,
  });

  const kickMany = useMutation<
    { kicked: string[]; failed: { target: string; message: string }[]; skipped: string[] },
    Error,
    { targets: string[]; onProgress?: (done: number, total: number) => void }
  >({
    mutationFn: async ({ targets, onProgress }) => {
      if (!community || !user) throw new Error(t({ id: "useModeration.notReady", defaultMessage: "Not ready." }));
      const unique = [...new Set(targets)];
      const eligible = unique.filter((t) => canActOn(t, Permissions.KICK));
      const skipped = unique.filter((t) => !canActOn(t, Permissions.KICK));
      if (eligible.length === 0) {
        throw new Error(
          unique.length === 1
            ? t({ id: "useModeration.kickNoPermissionOne", defaultMessage: "You don't have permission to kick this member." })
            : t({ id: "useModeration.kickNoPermissionMany", defaultMessage: "You don't have permission to kick any of these members." }),
        );
      }
      const citation = citationFor(community, folded, user.pubkey);
      const vac = citation
        ? { eid: bytesToHex(citation.entityId), version: citation.version, hash: bytesToHex(citation.editionHash) }
        : undefined;
      const kicked: string[] = [];
      const failed: { target: string; message: string }[] = [];
      let done = 0;
      for (const target of eligible) {
        try {
          // Strip first, so rank is gone before the departure lands.
          await stripRoles(target);
          await guestbook.mutateAsync({ type: "kick", target, vac });
          kicked.push(target);
        } catch (e) {
          // Keep going: landing 9 of 10 beats aborting at #2.
          failed.push({ target, message: e instanceof Error ? e.message : t({ id: "useModeration.kickFailed", defaultMessage: "Kick failed." }) });
        }
        done += 1;
        onProgress?.(done, eligible.length);
      }
      if (kicked.length === 0) throw new Error(failed[0]?.message ?? t({ id: "useModeration.kickFailed", defaultMessage: "Kick failed." }));
      return { kicked, failed, skipped };
    },
    // Settled, not success: a partial batch still moved the guestbook.
    onSettled: invalidate,
  });

  return {
    banned: folded?.banned ?? NO_BANNED,
    canRekey: canRefound,
    ban: (input: { target: string; onPhase?: (phase: BanPhase) => void; forceRotate?: boolean }) =>
      banMany.mutateAsync({ targets: [input.target], onPhase: input.onPhase, forceRotate: input.forceRotate }),
    banMany: banMany.mutateAsync,
    isBanning: banMany.isPending,
    rotateKeys: () => rotateKeys.mutateAsync(),
    isRotatingKeys: rotateKeys.isPending,
    /** Gate for the standalone rotation's UI; the mutation re-checks it. */
    canRotateKeys: Boolean(
      canRefound &&
      user &&
      folded &&
      isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.BAN),
    ),
    unban: unban.mutateAsync,
    kick: async (input: { target: string }) => {
      await kickMany.mutateAsync({ targets: [input.target] });
    },
    kickMany: kickMany.mutateAsync,
    isKicking: kickMany.isPending,
    canBan: (target: string) => canActOn(target, Permissions.BAN),
    canKick: (target: string) => canActOn(target, Permissions.KICK),
  };
}

/**
 * Retry an outstanding read-cut (a ban's Refounding lost to an outage) once per
 * visit. Mount ONCE per community (ConcordPage): it rotates from the keep-list
 * PERSISTED at ban time, so a cold surface can't rebuild a thin recipient set.
 * Cleared if a foreign live link has appeared; serialized with user refounds.
 */
export function useReadCutRetry(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const { refound, canRefound } = useRefound(community);
  const refoundsInFlight = useIsMutating({ mutationKey: ["concord-refound", community?.idHex] });
  const retried = useRef(false);

  useEffect(() => {
    if (retried.current || !user || !community || !folded || !canRefound) return;
    if (refoundsInFlight > 0) return; // a user ban is mid-rotation — let it finish

    let cancelled = false;
    void (async () => {
      // Reading before the KV cache warms would report "no cut owed".
      await readCutPendingReady();
      if (cancelled || retried.current) return;

      const pending = readCutPending(user.pubkey, community.idHex);
      if (!pending) return;
      retried.current = true;
      if (hasForeignLiveLinks(folded, user.pubkey)) {
        clearReadCutPending(user.pubkey, community.idHex);
        return;
      }
      refound({ keep: pending.keep, exclude: pending.targets })
        .then(() => {
          clearReadCutPending(user.pubkey, community.idHex);
          if (community) invalidateControl(queryClient, community.idHex);
          toast({ title: t({ id: "useModeration.rotationCompleted.title", defaultMessage: "Key rotation completed" }), description: t({ id: "useModeration.rotationCompleted.description", defaultMessage: "An earlier ban's key rotation has now finished." }) });
        })
        .catch(() => {
          // Still failing — retry again next visit.
        });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, community, folded, canRefound, refoundsInFlight]);
}
