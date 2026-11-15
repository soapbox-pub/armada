/**
 * Move Private Channel keys to match a member's Grant (CORD-03 §5, Vector
 * `settle_access`): judged on the Roster the Grant was planned on against the one
 * it leaves, never on a fold that lags or leads it. Rotations first, then the key
 * of every Channel the member gained, by Direct Invite and on its access plane,
 * each read from the list as the rotations left it. The caller holds the
 * Community's key settle (`withKeySettle`), so the next change starts from here.
 */

import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { deliverKeysOnPlane } from "@/concord/hooks/useAccessDuty";
import { cachedCommunity } from "@/concord/hooks/useCommunityList";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useChannelRekey } from "@/concord/hooks/useRekey";
import { planSettle, rotationRecipients, withGrant } from "@/concord/lib/accessDuty";
import type { FoldedControl } from "@/concord/lib/control";
import { bytesToHex } from "@/concord/lib/derive";
import { hasPermission, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { logSync } from "@/lib/syncLog";

export interface SettleReport {
  /** Channels whose key reached the member by at least one path. */
  sent: string[];
  /** Why a gained key reached them by neither path. */
  sendFailed?: string;
  /** Channels the member gained or lost whose key this device doesn't hold. */
  unheldGained: string[];
  unheldLost: string[];
  /** Channels the member lost that this device may not rotate. */
  notRotated: string[];
  rotationFailed: Array<{ channelIdHex: string; error: string }>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useRoleSettle(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { rekeyChannel } = useChannelRekey(community);
  const { sendDirectInvite } = useInviteActions(community);

  return useCallback(
    async (before: FoldedControl, member: string, roleIds: string[], members: readonly string[]): Promise<SettleReport> => {
      const report: SettleReport = { sent: [], unheldGained: [], unheldLost: [], notRotated: [], rotationFailed: [] };
      if (!community || !user || member === before.ownerHex) return report;
      const now = () => cachedCommunity(queryClient, user.pubkey, community.idHex) ?? community;
      const after = withGrant(before.roster, member, roleIds);
      const afterFold: FoldedControl = { ...before, roster: after };
      const owner = before.ownerHex;
      const mayRotate = user.pubkey === owner || hasPermission(after, user.pubkey, Permissions.MANAGE_CHANNELS);
      const privateIds = [...before.channels.values()].filter((c) => c.isPrivate && !c.deleted).map((c) => c.channelIdHex);
      const plans = planSettle({ before: before.roster, after, ownerHex: owner, banned: before.banned, me: user.pubkey, members: [member], channels: privateIds });
      const heldIds = () => new Set(now().privateChannels.map((c) => bytesToHex(c.id)));
      const keepFrom = [...new Set([...members, ...after.grants.map((g) => g.member), member])];

      const gained: string[] = [];
      for (const p of plans) {
        if (!heldIds().has(p.channelIdHex)) {
          report.unheldGained.push(...(p.gained.length || p.fresh.length ? [p.channelIdHex] : []));
          if (p.lost.length) report.unheldLost.push(p.channelIdHex);
          continue;
        }
        if (p.gained.length) gained.push(p.channelIdHex);
        if (!p.lost.length && !p.fresh.length) continue;
        if (!mayRotate) {
          // A fresh epoch waits for a manager's duty; a cut someone must hear about.
          if (p.lost.length) report.notRotated.push(p.channelIdHex);
          continue;
        }
        try {
          await rekeyChannel({
            channelIdHex: p.channelIdHex,
            keepRecipients: rotationRecipients(afterFold, user.pubkey, p.channelIdHex, keepFrom, p.lost),
            removedTargets: p.lost,
            community: now(),
          });
        } catch (e) {
          report.rotationFailed.push({ channelIdHex: p.channelIdHex, error: message(e) });
        }
      }
      if (gained.length === 0) return report;

      // Both roads, from the keys as the rotations left them: the invite is what Vector
      // sends, the access plane is where every client already looks for a key it lacks.
      const errors: string[] = [];
      const reached = new Set<string>();
      const c = now();
      for (const idHex of gained) {
        const ch = c.privateChannels.find((k) => bytesToHex(k.id) === idHex);
        if (!ch) continue;
        try {
          await deliverKeysOnPlane(nostr, c, ch, [member], user);
          reached.add(idHex);
        } catch (e) {
          errors.push(message(e));
        }
      }
      try {
        await sendDirectInvite({ recipientPubkey: member, onlyChannelIdHexes: new Set(gained), source: c, roster: after, alsoRelays: c.relays });
        for (const id of gained) reached.add(id);
      } catch (e) {
        errors.push(message(e));
      }
      report.sent = gained.filter((id) => reached.has(id));
      if (report.sent.length < gained.length) report.sendFailed = errors.join(" ");
      logSync("access", `${community.idHex.slice(0, 8)}: settled ${member.slice(0, 8)}'s Grant: ${report.sent.length} key(s) sent, ${plans.reduce((n, p) => n + p.lost.length, 0)} cut`);
      return report;
    },
    [community, user, queryClient, nostr, rekeyChannel, sendDirectInvite],
  );
}
