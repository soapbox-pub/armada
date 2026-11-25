import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { settledWrite } from "@/concord/hooks/rosterSettle";
import { citationFor, foldStoredControl, invalidateControl, publishEdition, readControlWhole, useControlFold, withControlWrite } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { controlWrapOwed, useRoles } from "@/concord/hooks/useRoles";
import { awaitingApproval, carriedOver, freeGateRoleId, GATE_BITS, gateState, keepsPosting, mayApprove, maySwitchGate } from "@/concord/lib/approvalGate";
import { buildGrantEdition, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, grantLocator, hex32 } from "@/concord/lib/derive";
import { planCreateRole, planMemberRoles, planOverwrite, planSetEveryone } from "@/concord/lib/rankedWrites";
import { rolesMakeStaff } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { t } from "@/i18n";
import type { NostrRumor } from "@/lib/nostrRumor";

/** A Verified Role's colour: the green Discord uses for its verified badge. */
const VERIFIED_COLOR = 0x3ba55c;

export interface GateSwitchOn {
  /** Every current member; who keeps posting is chosen from them (`carriedOver`). */
  members: readonly string[];
  /** author → newest post seen (ms). */
  observed: ReadonlyMap<string, number>;
  /** Members seen posting since this keep posting; the rest wait for approval. */
  activeSinceMs: number;
  /** A Channel `@everyone` may still post in, for newcomers to reach the moderators. */
  welcomeChannel?: string;
}

/**
 * "Require approval to post" (`approvalGate.ts`): its state, the switch, and approving a
 * member. Turning it on publishes, in order, the Verified Role, a Grant of it to every
 * member who keeps posting, the welcome Channel's overwrite, and `@everyone` without
 * posting — last, so nobody kept loses a post along the way and a run cut short is
 * simply run again. The writer duty mints and delivers each restricted Channel's keys.
 */
export function useApprovalGate(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const { coalesced } = useGuestbook(community);
  const { setMemberRoles } = useRoles(community);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();

  const idHex = community?.idHex ?? "";
  const state = useMemo(() => gateState(folded, idHex), [folded, idHex]);
  const awaiting = useMemo(
    () => (state.on && folded ? awaitingApproval(folded, coalesced) : new Set<string>()),
    [state.on, folded, coalesced],
  );
  const canApprove = mayApprove(folded, user?.pubkey, state.role);

  const ready = () => {
    if (!user || !community) throw new Error(t({ id: "useRoles.notReady", defaultMessage: "Not ready." }));
    return { user, community };
  };

  const done = () => {
    setProgress(undefined);
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const turnOn = useMutation<{ granted: number; unreachable: string[] }, Error, GateSwitchOn>({
    mutationFn: ({ members, observed, activeSinceMs, welcomeChannel }) => {
      const { user, community: c } = ready();
      return settledWrite(c, () => withControlWrite(c.idHex, async () => {
        // A switch that moves every member's posting is planned on the plane read whole.
        const whole = await readControlWhole(nostr, c);
        if (!whole) throw new Error(t({ id: "useApprovalGate.needsWhole", defaultMessage: "The community couldn't be read in full; try again once the relays answer." }));
        let view: FoldedControl = whole.folded;
        if (!keepsPosting(view, user.pubkey)) {
          throw new Error(t({ id: "useApprovalGate.selfSilenced", defaultMessage: "None of your roles can send messages, so this would stop you posting too. Someone ranked above you has to give one of your roles Send messages first." }));
        }
        const authority = () => citationFor(c, view, user.pubkey);
        const publish = async (rumor: NostrRumor) => {
          await publishEdition(nostr, c, user.signer, rumor);
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        };

        let role = gateState(view, c.idHex).role;
        const plan = carriedOver(view, user.pubkey, members, observed, activeSinceMs, role?.roleId);
        setProgress({ done: 0, total: (role ? 0 : 1) + plan.grant.length + (welcomeChannel ? 1 : 0) + 1 });

        if (!role) {
          const id = freeGateRoleId(view, c.idHex);
          if (!id) throw new Error(t({ id: "useApprovalGate.noRoleSlot", defaultMessage: "Too many Verified roles have been deleted in this community to make another." }));
          const made = planCreateRole(view, c.id, user.pubkey, { name: "Verified", color: VERIFIED_COLOR, permissions: GATE_BITS }, authority(), undefined, id);
          await publish(made.rumor);
          view = await foldStoredControl(c);
          role = gateState(view, c.idHex).role;
          if (!role) throw new Error(t({ id: "useApprovalGate.roleMissing", defaultMessage: "The Verified role didn't take; try again." }));
        }

        const held = new Set(c.privateChannels.map((k) => bytesToHex(k.id)));
        for (const member of plan.grant) {
          const current = view.roster.grants.find((g) => g.member === member)?.roleIds ?? [];
          const roleIds = planMemberRoles(view, c.id, user.pubkey, member, [...current, role.roleId], held);
          const head = view.heads.get(bytesToHex(grantLocator(c.id, hex32(member))));
          const controlWrap = await controlWrapOwed(c, rolesMakeStaff(view.roster, roleIds), user.signer.nip44, member);
          await publish(buildGrantEdition(c.id, { member, roleIds, ...(controlWrap ? { controlWrap } : {}) }, {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: authority(),
          }));
        }

        if (welcomeChannel) {
          const scope = welcomeChannel.toLowerCase();
          const existing = view.roster.overwrites?.find((o) => o.scope === scope && o.target.kind === "everyone");
          await publish(planOverwrite(view, c.id, user.pubkey, held, scope, { kind: "everyone" }, (existing?.allow ?? 0n) | GATE_BITS, (existing?.deny ?? 0n) & ~GATE_BITS, authority()));
        }

        await publish(planSetEveryone(view, c.id, user.pubkey, view.roster.everyone! & ~GATE_BITS, authority()));
        return { granted: plan.grant.length, unreachable: plan.unreachable };
      }));
    },
    onSettled: done,
  });

  const turnOff = useMutation<void, Error, void>({
    mutationFn: () => {
      const { user, community: c } = ready();
      return settledWrite(c, () => withControlWrite(c.idHex, async () => {
        const view = await foldStoredControl(c);
        await publishEdition(nostr, c, user.signer, planSetEveryone(view, c.id, user.pubkey, (view.roster.everyone ?? 0n) | GATE_BITS, citationFor(c, view, user.pubkey)));
      }));
    },
    onSettled: done,
  });

  const approve = useMutation<void, Error, string>({
    mutationFn: async (member) => {
      const role = state.role;
      if (!role || !folded) throw new Error(t({ id: "useRoles.notReady", defaultMessage: "Not ready." }));
      const current = folded.roster.grants.find((g) => g.member === member)?.roleIds ?? [];
      if (current.includes(role.roleId)) return;
      await setMemberRoles({ member, roleIds: [...current, role.roleId] });
    },
  });

  return {
    on: state.on,
    role: state.role,
    awaiting,
    canApprove,
    canSwitch: maySwitchGate(folded, user?.pubkey),
    turnOn: turnOn.mutateAsync,
    turnOff: turnOff.mutateAsync,
    approve: approve.mutateAsync,
    switching: turnOn.isPending || turnOff.isPending,
    progress,
  };
}
