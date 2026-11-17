/**
 * A Roster write and the Channel keys it moves, as one step (CORD-03 §5, Vector
 * `settle_access`): the stored fold is read before and after the write, inside
 * the Community's key settle, and the mounted settler moves what changed between
 * them. With none mounted the write still lands, and the access duty settles it.
 */

import { foldStoredControl } from "@/concord/hooks/useControlPlane";
import { channelDisplayName } from "@/concord/lib/community";
import type { FoldedControl } from "@/concord/lib/control";
import { rosterSettler, withKeySettle, type SettleReport, type SettleWatch } from "@/concord/lib/keySettle";
import type { Community } from "@/concord/lib/types";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n/intl";
import { logSync } from "@/lib/syncLog";

/** How a settle ended: its report, or why it stopped. Neither when no settler is mounted. */
export interface SettleOutcome {
  report?: SettleReport;
  error?: string;
  after?: FoldedControl;
}

/** A caller showing the settle as it runs, in place of the toasts. */
export interface SettleFollow {
  watch?: SettleWatch;
  onSettled: (outcome: SettleOutcome) => void;
}

/** Run `write`, then settle the keys it moved; the report is undefined when nothing could settle it. */
export function settledScope<T>(community: Community, write: () => Promise<T>, watch?: SettleWatch): Promise<{ result: T } & SettleOutcome> {
  return withKeySettle(community.idHex, async () => {
    const settle = rosterSettler(community.idHex);
    const before = settle ? await foldStoredControl(community).catch(() => undefined) : undefined;
    const result = await write();
    if (!settle || !before) return { result };
    try {
      const after = await foldStoredControl(community);
      return { result, report: await settle(before, after, watch), after };
    } catch (e) {
      // The write stands; the access duty's settle pass is the backstop.
      const error = e instanceof Error ? e.message : String(e);
      logSync("access", `${community.idHex.slice(0, 8)}: settling a Roster change failed: ${error}`);
      return { result, error };
    }
  });
}

/** {@link settledScope}, reporting what the settle couldn't do as toasts, or to `follow` when someone is showing it. */
export async function settledWrite<T>(community: Community, write: () => Promise<T>, follow?: SettleFollow): Promise<T> {
  const { result, report, error, after } = await settledScope(community, write, follow?.watch);
  if (follow) follow.onSettled({ report, error, after });
  else if (report) toastSettle(report, (id) => channelDisplayName(community, after, id));
  return result;
}

export function toastSettle(report: SettleReport, nameOf: (channelIdHex: string) => string): void {
  const listNames = (ids: string[]) => ids.map((id) => `#${nameOf(id)}`).join(", ");
  if (report.sent.length > 0 && report.members.length === 1 && report.sendFailed === undefined) {
    toast({
      title: t({ id: "concordPage.keys.sent", defaultMessage: "Channel keys sent" }),
      description: t(
        {
          id: "concordPage.keys.sentDescription",
          defaultMessage: "The member received {count, plural, one {# private channel key} other {# private channel keys}}.",
        },
        { count: report.sent.length },
      ),
    });
  }
  if (report.sendFailed !== undefined) {
    toast({
      title: t({ id: "concordPage.keys.sendFailed", defaultMessage: "Couldn't send the channel keys" }),
      description: report.sendFailed
        ? t(
            {
              id: "concordPage.keys.sendFailedDetail",
              defaultMessage:
                "The role was granted, but delivering its private channel keys failed: {error} Toggle the role off and on to retry.",
            },
            { error: report.sendFailed },
          )
        : t({
            id: "concordPage.keys.sendFailedDescription",
            defaultMessage:
              "The role was granted, but delivering its private channel keys failed. Toggle the role off and on to retry.",
          }),
      variant: "destructive",
    });
  }
  // Only a key holder can vend; whoever was let in waits until one does.
  if (report.unheldGained.length > 0) {
    toast({
      title: t({ id: "concordPage.keys.someUnsent", defaultMessage: "Some channel keys weren't sent" }),
      description: t(
        {
          id: "concordPage.keys.someUnsentDescription",
          defaultMessage:
            "You don't hold the key to {channels}, so a member who does has to share it before they can read {count, plural, one {that channel} other {those channels}}.",
        },
        { channels: listNames(report.unheldGained), count: report.unheldGained.length },
      ),
    });
  }
  // A revoke that cuts nobody is the failure to hear about.
  if (report.unheldLost.length > 0) {
    toast({
      title: t({ id: "concordPage.keys.notRevoked", defaultMessage: "Channel access not revoked" }),
      description: t(
        {
          id: "concordPage.keys.notRevokedDescription",
          defaultMessage: "You don't hold the key to {channels}, so they keep reading until a member who does rotates it.",
        },
        { channels: listNames(report.unheldLost) },
      ),
      variant: "destructive",
    });
  }
  if (report.notRotated.length > 0) {
    toast({
      title: t({ id: "concordPage.keys.notRotated", defaultMessage: "Channel keys not rotated" }),
      description: t({
        id: "concordPage.keys.notRotatedDescription",
        defaultMessage:
          "They lost access to a private channel, but rotating its key needs the Manage channels permission. Ask an admin to rotate it.",
      }),
      variant: "destructive",
    });
  }
  for (const { channelIdHex, error } of report.rotationFailed) {
    toast({
      title: t({ id: "concordPage.keys.rotationFailed", defaultMessage: "Channel key rotation failed" }),
      description: t(
        { id: "concordPage.keys.rotationFailedDetail", defaultMessage: "They may still read #{channel} until it succeeds: {error}" },
        { channel: nameOf(channelIdHex), error },
      ),
      variant: "destructive",
    });
  }
}
