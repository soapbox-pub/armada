import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { settledWrite } from "@/concord/hooks/rosterSettle";
import { citationFor, foldStoredControl, invalidateControl, publishEdition, readControlWhole, useControlFold, withControlWrite } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { controlWrapOwed, useRoles } from "@/concord/hooks/useRoles";
import { adoptableRoles, awaitingApproval, carriedOver, GATE_BITS, gateState, keepsPosting, mayApprove, maySwitchGate, outranksMemberForGrant, welcomeChannels } from "@/concord/lib/approvalGate";
import { buildGrantEdition, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, grantLocator, hex32 } from "@/concord/lib/derive";
import { planCreateRole, planEditRole, planMemberRoles, planOverwrite, planSetEveryone, withRole } from "@/concord/lib/rankedWrites";
import { rolesMakeStaff, type Role } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { t } from "@/i18n";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface GateSwitchOn {
  /** Every current member; who keeps posting is chosen from them (`carriedOver`). */
  members: readonly string[];
  /** author → newest post seen (ms). */
  observed: ReadonlyMap<string, number>;
  /** Members seen posting since this keep posting; the rest wait for approval. */
  activeSinceMs: number;
  /** A Channel `@everyone` may still post in, for newcomers to reach the moderators. */
  welcomeChannel?: string;
  /** The Role that lets members post: an existing plain one, given posting, or a new Verified. */
  role: { adopt: string } | { create: true };
}

/**
 * "Require approval to post" (`approvalGate.ts`): its state, the switch, and approving a
 * member. Turning it on publishes, in order, the approval Role (made, or an existing one
 * given posting), a Grant of it to every member who keeps posting, the welcome Channel's
 * overwrite, and `@everyone` without posting, all planned before the first is published;
 * a run cut short is simply run again. The writer duty mints and delivers each restricted
 * Channel's keys.
 */
export function useApprovalGate(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const { coalesced } = useGuestbook(community);
  const { setMemberRoles } = useRoles(community);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();

  const state = useMemo(() => gateState(folded), [folded]);
  const awaiting = useMemo(
    () => (state.on && folded ? awaitingApproval(folded, coalesced) : new Set<string>()),
    [state.on, folded, coalesced],
  );
  // The approval Roles this viewer may grant; Approve asks which when there are several.
  const grantable = useMemo(
    () => state.roles.filter((r) => mayApprove(folded, user?.pubkey, r)),
    [state.roles, folded, user?.pubkey],
  );
  const welcome = useMemo(() => (folded ? welcomeChannels(folded) : []), [folded]);

  const ready = () => {
    if (!user || !community) throw new Error(t({ id: "useRoles.notReady", defaultMessage: "Not ready." }));
    return { user, community };
  };

  const done = () => {
    setProgress(undefined);
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const turnOn = useMutation<{ granted: number; unreachable: string[] }, Error, GateSwitchOn>({
    mutationFn: ({ members, observed, activeSinceMs, welcomeChannel, role }) => {
      const { user, community: c } = ready();
      return settledWrite(c, () => withControlWrite(c.idHex, async () => {
        // A switch that moves every member's posting is planned on the plane read whole.
        const whole = await readControlWhole(nostr, c);
        if (!whole) throw new Error(t({ id: "useApprovalGate.needsWhole", defaultMessage: "The community couldn't be read in full; try again once the relays answer." }));
        const plane = whole.folded;
        const everyone = readEveryone(plane);
        const adopted = "adopt" in role ? plane.roster.roles.find((r) => r.roleId === role.adopt) : undefined;
        if ("adopt" in role && !adopted) throw new Error(t({ id: "useApprovalGate.roleGone", defaultMessage: "That role is gone; pick another." }));
        if (adopted && !adoptableRoles(plane, user.pubkey).some((r) => r.roleId === adopted.roleId)) {
          throw new Error(t({ id: "useApprovalGate.roleNotAdoptable", defaultMessage: "That role can't be the way in: it has powers over others, ranks above you, or opens a private channel. Pick another." }));
        }
        if (!keepsPosting(plane, user.pubkey, adopted?.roleId)) {
          throw new Error(t({ id: "useApprovalGate.selfSilenced", defaultMessage: "None of your roles can send messages, so this would stop you posting too. Someone ranked above you has to give one of your roles Send messages first." }));
        }
        const authority = citationFor(c, plane, user.pubkey);
        const held = heldKeys(c);

        // Every edition is planned before the first is published, each step judged on the
        // Roster as the ones before it leave it, so a refusal anywhere publishes nothing.
        let view = plane;
        let roleId: string;
        const rumors: NostrRumor[] = [];
        if (adopted) {
          roleId = adopted.roleId;
          if ((adopted.permissions & GATE_BITS) !== GATE_BITS) {
            const permissions = adopted.permissions | GATE_BITS;
            rumors.push(planEditRole(view, c.id, user.pubkey, roleId, {
              name: adopted.name,
              color: adopted.color ?? 0,
              permissions,
              display: Boolean(adopted.display),
              mentionable: Boolean(adopted.mentionable),
            }, authority).rumor);
            view = withRole(view, { ...adopted, permissions });
          }
        } else {
          // Colourless and not displayed: held by nearly everyone, it names nobody.
          const made = planCreateRole(view, c.id, user.pubkey, { name: "Verified", color: 0, permissions: GATE_BITS }, authority);
          roleId = made.roleId;
          rumors.push(made.rumor);
          view = withRole(view, made.role);
        }

        const plan = carriedOver(view, user.pubkey, members, observed, activeSinceMs, roleId);
        for (const member of plan.grant) {
          const current = view.roster.grants.find((g) => g.member === member)?.roleIds ?? [];
          const roleIds = planMemberRoles(view, c.id, user.pubkey, member, [...current, roleId], held);
          const head = view.heads.get(bytesToHex(grantLocator(c.id, hex32(member))));
          const controlWrap = await controlWrapOwed(c, rolesMakeStaff(view.roster, roleIds), user.signer.nip44, member);
          rumors.push(buildGrantEdition(c.id, { member, roleIds, ...(controlWrap ? { controlWrap } : {}) }, {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority,
          }));
        }
        if (welcomeChannel) rumors.push(welcomeOverwrite(view, c, user.pubkey, held, welcomeChannel, true, authority));
        // Last, so nobody kept loses a post along the way.
        rumors.push(planSetEveryone(view, c.id, user.pubkey, everyone & ~GATE_BITS, authority));

        setProgress({ done: 0, total: rumors.length });
        for (const rumor of rumors) {
          await publishEdition(nostr, c, user.signer, rumor);
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        }
        return { granted: plan.grant.length, unreachable: plan.unreachable };
      }));
    },
    onSettled: done,
  });

  const turnOff = useMutation<void, Error, void>({
    mutationFn: () => {
      const { user, community: c } = ready();
      return settledWrite(c, () => withControlWrite(c.idHex, async () => {
        // Written whole over @everyone, so planned on the plane read whole, never a store that may have lost it.
        const whole = await readControlWhole(nostr, c);
        if (!whole) throw new Error(t({ id: "useApprovalGate.needsWhole", defaultMessage: "The community couldn't be read in full; try again once the relays answer." }));
        const view = whole.folded;
        await publishEdition(nostr, c, user.signer, planSetEveryone(view, c.id, user.pubkey, readEveryone(view) | GATE_BITS, citationFor(c, view, user.pubkey)));
      }));
    },
    onSettled: done,
  });

  /** Open `open` as a welcome Channel and close `close`, the one it replaces; `null` opens none. */
  const setWelcome = useMutation<void, Error, { open: string | null; close?: string }>({
    mutationFn: ({ open, close }) => {
      const { user, community: c } = ready();
      return settledWrite(c, () => withControlWrite(c.idHex, async () => {
        const view = await foldStoredControl(c);
        const held = heldKeys(c);
        const authority = citationFor(c, view, user.pubkey);
        const standing = welcomeChannels(view);
        const rumors: NostrRumor[] = [];
        if (close && close !== open && standing.includes(close)) rumors.push(welcomeOverwrite(view, c, user.pubkey, held, close, false, authority));
        if (open && !standing.includes(open)) rumors.push(welcomeOverwrite(view, c, user.pubkey, held, open, true, authority));
        for (const rumor of rumors) await publishEdition(nostr, c, user.signer, rumor);
      }));
    },
    onSettled: done,
  });
  const setWelcomeAsync = setWelcome.mutateAsync;
  const changeWelcome = useCallback((open: string | null, close?: string) => setWelcomeAsync({ open, ...(close ? { close } : {}) }), [setWelcomeAsync]);

  /** Grant `member` the approval Role: `roleId` when there are several, else the one there is. */
  const approve = useMutation<void, Error, { member: string; roleId?: string }>({
    mutationFn: async ({ member, roleId }) => {
      const role: Role | undefined = roleId ? grantable.find((r) => r.roleId === roleId) : grantable.length === 1 ? grantable[0] : undefined;
      if (!role) throw new Error(t({ id: "useApprovalGate.pickRole", defaultMessage: "Pick which role to give them." }));
      await setMemberRoles({ member, add: role.roleId });
    },
  });

  const me = user?.pubkey;
  // Approving changes the member's Grant, which takes outranking them too (CORD-04 §3).
  const mayApproveMember = useCallback((member: string) => Boolean(folded && me && outranksMemberForGrant(folded, me, member)), [folded, me]);

  const approveAsync = approve.mutateAsync;
  const approveMember = useCallback(
    (member: string, roleId?: string) => approveAsync({ member, ...(roleId ? { roleId } : {}) }),
    [approveAsync],
  );

  return {
    on: state.on,
    /** Every Role that lets members post while approval is on; none means nobody can be let in. */
    roles: state.roles,
    /** Those of them this viewer may grant. */
    grantable,
    awaiting,
    canApprove: grantable.length > 0,
    /** Whether this viewer ranks above `member`, as changing their Roles takes. */
    mayApproveMember,
    canSwitch: maySwitchGate(folded, user?.pubkey),
    /** The Channels newcomers waiting for approval can still post in. */
    welcome,
    setWelcome: changeWelcome,
    turnOn: turnOn.mutateAsync,
    turnOff: turnOff.mutateAsync,
    approve: approveMember,
    switching: turnOn.isPending || turnOff.isPending || setWelcome.isPending,
    progress,
  };
}

const heldKeys = (c: Community) => new Set(c.privateChannels.map((k) => bytesToHex(k.id)));

/** `@everyone` as read, refused when the read lost it: a rewrite built on nothing strips every member's basics. */
function readEveryone(view: FoldedControl): bigint {
  if (view.roster.everyone === undefined || view.everyoneServed === false) {
    throw new Error(t({ id: "rankedWrites.unreadable", defaultMessage: "The community's roles couldn't be read; try again." }));
  }
  return view.roster.everyone;
}

/**
 * `channel`'s `@everyone` overwrite with posting allowed (a welcome Channel) or that
 * allow taken back, every other bit it holds kept as it was.
 */
function welcomeOverwrite(
  view: FoldedControl,
  c: Community,
  me: string,
  held: ReadonlySet<string>,
  channel: string,
  open: boolean,
  authority: ReturnType<typeof citationFor>,
): NostrRumor {
  const scope = channel.toLowerCase();
  const existing = view.roster.overwrites?.find((o) => o.scope === scope && o.target.kind === "everyone");
  const allow = existing?.allow ?? 0n;
  const deny = existing?.deny ?? 0n;
  return open
    ? planOverwrite(view, c.id, me, held, scope, { kind: "everyone" }, allow | GATE_BITS, deny & ~GATE_BITS, authority)
    : planOverwrite(view, c.id, me, held, scope, { kind: "everyone" }, allow & ~GATE_BITS, deny, authority);
}
