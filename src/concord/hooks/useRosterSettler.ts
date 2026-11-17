/**
 * Move Private Channel keys to match a Roster change (CORD-03 §5, Vector
 * `settle_access`), as the member who made it: judged on the stored fold before
 * the write against the one after, never on a fold that lags or leads it.
 * Rotations first, then the key of every Channel someone was let into, on its
 * access plane and by Direct Invite, each read from the list as the rotations
 * left it. Registered per Community for `settledWrite`, which holds the
 * Community's key settle around the write and this.
 */

import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { deliverKeysOnPlane } from "@/concord/hooks/useAccessDuty";
import { cachedCommunity } from "@/concord/hooks/useCommunityList";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useChannelRekey } from "@/concord/hooks/useRekey";
import { accessCandidates, planSettle, rotationRecipients } from "@/concord/lib/accessDuty";
import type { FoldedControl } from "@/concord/lib/control";
import { bytesToHex } from "@/concord/lib/derive";
import { emptySettleReport, registerRosterSettler, type SettleReport, type SettleWatch } from "@/concord/lib/keySettle";
import { hasPermission, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { logSync } from "@/lib/syncLog";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Deps = {
  community: Community;
  user: { pubkey: string; signer: Parameters<typeof deliverKeysOnPlane>[4]["signer"] };
  members: Parameters<typeof accessCandidates>[1];
  rekey: ReturnType<typeof useChannelRekey>["rekeyChannel"];
  invite: ReturnType<typeof useInviteActions>["sendDirectInvite"];
  deliver: (c: Community, ch: Community["privateChannels"][number], to: string[]) => Promise<unknown>;
  /** The community as the list holds it now: a rotation lands there before a render. */
  now: () => Community;
};

/** The settle itself, hook-free (the hook below only gathers what it needs). */
export async function settleRoster(d: Deps, before: FoldedControl, after: FoldedControl, watch?: SettleWatch): Promise<SettleReport> {
  const report = emptySettleReport();
  const me = d.user.pubkey;
  const owner = after.ownerHex;
  const mayRotate = me === owner || (!after.banned.has(me) && hasPermission(after.roster, me, Permissions.MANAGE_CHANNELS));
  const members = [...new Set([...accessCandidates(before, d.members), ...accessCandidates(after, d.members)])];
  const channels = [...after.channels.values()].filter((c) => c.isPrivate && !c.deleted).map((c) => c.channelIdHex);
  const plans = planSettle({ before: before.roster, after: after.roster, ownerHex: owner, banned: after.banned, me, members, channels });
  if (plans.length === 0) return report;
  const heldIds = () => new Set(d.now().privateChannels.map((c) => bytesToHex(c.id)));

  const gained = new Map<string, string[]>();
  const rotations: Promise<void>[] = [];
  for (const p of plans) {
    if (!heldIds().has(p.channelIdHex)) {
      if (p.gained.length || p.fresh.length) report.unheldGained.push(p.channelIdHex);
      if (p.lost.length) report.unheldLost.push(p.channelIdHex);
      continue;
    }
    if (p.gained.length) gained.set(p.channelIdHex, p.gained);
    if (!p.lost.length && !p.fresh.length) continue;
    if (!mayRotate) {
      // A fresh epoch waits for a manager's duty; a cut is a failure to hear about.
      if (p.lost.length) report.notRotated.push(p.channelIdHex);
      continue;
    }
    // Each Channel is its own rotation; one after another, the last landed a rotation per Channel late.
    rotations.push(
      d.rekey({
        channelIdHex: p.channelIdHex,
        keepRecipients: rotationRecipients(after, me, p.channelIdHex, [...members, ...p.fresh], p.lost),
        removedTargets: p.lost,
        community: d.now(),
      }).then(
        () => undefined,
        (e) => void report.rotationFailed.push({ channelIdHex: p.channelIdHex, error: message(e) }),
      ),
    );
  }
  if (rotations.length > 0) watch?.("rotate");
  await Promise.all(rotations);
  if (gained.size === 0) return report;
  watch?.("send");

  // Both roads, from the keys the rotations left: the access plane is where every
  // client looks for a key it lacks, the invite is what Vector sends.
  const c = d.now();
  const errors: string[] = [];
  const reached = new Map<string, Set<string>>();
  const mark = (id: string, pk: string) => (reached.get(id) ?? reached.set(id, new Set()).get(id)!).add(pk);
  await Promise.all(
    [...gained].map(async ([idHex, to]) => {
      const ch = c.privateChannels.find((k) => bytesToHex(k.id) === idHex);
      if (!ch) return;
      try {
        await d.deliver(c, ch, to);
        for (const pk of to) mark(idHex, pk);
      } catch (e) {
        errors.push(message(e));
      }
    }),
  );
  const byMember = new Map<string, string[]>();
  for (const [idHex, to] of gained) for (const pk of to) byMember.set(pk, [...(byMember.get(pk) ?? []), idHex]);
  for (const [pk, ids] of byMember) {
    try {
      await d.invite({ recipientPubkey: pk, onlyChannelIdHexes: new Set(ids), source: c, roster: after.roster, alsoRelays: c.relays });
      for (const id of ids) mark(id, pk);
    } catch (e) {
      errors.push(message(e));
    }
  }
  report.sent = [...gained].filter(([id, to]) => to.every((pk) => reached.get(id)?.has(pk))).map(([id]) => id);
  report.members = [...byMember.keys()];
  if (report.sent.length < gained.size) report.sendFailed = [...new Set(errors)].join(" ");
  logSync("access", `${c.idHex.slice(0, 8)}: settled a Roster change: ${report.sent.length} Channel key(s) sent, ${plans.reduce((n, p) => n + p.lost.length, 0)} cut`);
  return report;
}

export function useRosterSettler(community: Community | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { coalesced } = useGuestbook(community, { poll: false });
  const { rekeyChannel } = useChannelRekey(community);
  const { sendDirectInvite } = useInviteActions(community);
  const latest = useRef({ community, user, coalesced, rekeyChannel, sendDirectInvite });
  latest.current = { community, user, coalesced, rekeyChannel, sendDirectInvite };

  useEffect(() => {
    if (!community) return;
    return registerRosterSettler(community.idHex, (before, after, watch) => {
      const l = latest.current;
      if (!l.community || !l.user?.signer.nip44) return Promise.resolve(emptySettleReport());
      const c = l.community;
      const u = l.user;
      return settleRoster(
        {
          community: c,
          user: u,
          members: l.coalesced,
          rekey: l.rekeyChannel,
          invite: l.sendDirectInvite,
          deliver: (at, ch, to) => deliverKeysOnPlane(nostr, at, ch, to, u),
          now: () => cachedCommunity(queryClient, u.pubkey, c.idHex) ?? c,
        },
        before,
        after,
        watch,
      );
    });
  }, [community?.idHex, nostr, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps
}
