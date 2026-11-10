import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useControlEvents } from "@/concord/hooks/useControlPlane";
import { suspiciousActivity, type SuspiciousActor } from "@/concord/lib/auditLog";
import { openControlEditions, type FoldedControl } from "@/concord/lib/control";
import {
  controlSweepAnswered,
  controlSweepQuorum,
  controlSweepTruncated,
  controlSweepUnreadable,
  subscribeSweepVerdicts,
  sweepVerdictRevision,
} from "@/concord/lib/planeSync";
import { Permissions, isAuthorized } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { nowSecs } from "@/lib/relayClock";

/**
 * Watchdog lookback. Also bounds a false positive: authority is judged as of
 * TODAY, so a demoted admin's whole history would otherwise read as an attack.
 */
const WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Unreadable events tolerated before they alone raise the alarm. They can't be
 * attributed (the wrap author is the shared plane key), but junk is the cheapest
 * way to inflate the plane and only a key rotation fixes it.
 */
const UNREADABLE_ALERT_THRESHOLD = 10;

/**
 * What a dismissal remembers. The timestamp silences named actors; the
 * unreadable tally has no timestamps, so it needs its own high-water mark.
 */
interface Dismissal {
  at: number;
  unreadable: number;
  /** Whether the plane was already unreadably deep when they acknowledged it. */
  flooded?: boolean;
}

const NO_DISMISSAL: Dismissal = { at: 0, unreadable: 0, flooded: false };

/**
 * Dismissal watermarks per (account, community) in KV behind a sync cache, never
 * evicted. Reads before warm-up report "never dismissed"; the hook re-reads
 * after {@link dismissals.ready}.
 */
const dismissals = new KvPrefixCache<Partial<Dismissal> | number>({ prefix: "cp-watchdog:" });

const dismissId = (me: string, idHex: string) => `${me}:${idHex}`;

function readDismissal(me: string, idHex: string): Dismissal {
  const stored = dismissals.get(dismissId(me, idHex));
  if (stored === undefined) return NO_DISMISSAL;
  // Older builds stored a bare timestamp.
  if (typeof stored === "number") return { at: stored, unreadable: 0, flooded: false };
  if (typeof stored !== "object" || stored === null) return NO_DISMISSAL;
  return {
    at: Number(stored.at) || 0,
    unreadable: Number(stored.unreadable) || 0,
    flooded: stored.flooded === true,
  };
}

function writeDismissal(me: string, idHex: string, next: Dismissal): void {
  if (me && idHex) dismissals.set(dismissId(me, idHex), next);
}

/**
 * Members writing control editions the fold refuses for lack of authority,
 * visible from their first attempt. Reported only to viewers who can act, and
 * only after a sweep completes (a cut-off sweep may not have fetched someone's grant).
 * `folded` is passed in because re-folding is expensive.
 */
export function useSuspiciousActivity(
  community: Community | undefined,
  folded: FoldedControl | undefined,
  active = true,
) {
  const { user } = useCurrentUser();
  const control = useControlEvents(community, active);
  const me = user?.pubkey ?? "";
  const idHex = community?.idHex ?? "";
  // Re-read per (account, community): the banner stays mounted across switches,
  // so a lazy initializer would carry one community's dismissal into the next.
  const [dismissed, setDismissed] = useState<Dismissal>(() =>
    me && idHex ? readDismissal(me, idHex) : NO_DISMISSAL,
  );

  // Re-read once the KV cache warms, adopting only a value AHEAD of the current
  // one so a dismissal made meanwhile isn't rolled back.
  useEffect(() => {
    if (!me || !idHex) return;
    let cancelled = false;
    void dismissals.ready().then(() => {
      if (cancelled) return;
      const stored = readDismissal(me, idHex);
      setDismissed((prev) =>
        stored.at > prev.at || stored.unreadable > prev.unreadable ? stored : prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [me, idHex]);
  // State, not a ref: a discarded render would keep a ref mutation and skip the re-read.
  const watermarkKey = `${me}:${idHex}`;
  const [lastKey, setLastKey] = useState(watermarkKey);
  if (lastKey !== watermarkKey) {
    setLastKey(watermarkKey);
    setDismissed(me && idHex ? readDismissal(me, idHex) : NO_DISMISSAL);
  }

  const canAct = Boolean(
    folded && me && isAuthorized(folded.roster, me, folded.ownerHex, Permissions.BAN),
  );

  // Verdicts live in module state a sweep mutates after mount.
  const verdicts = useSyncExternalStore(subscribeSweepVerdicts, sweepVerdictRevision);

  const { actors, unreadable, flooded } = useMemo<{
    actors: SuspiciousActor[];
    unreadable: number;
    flooded: boolean;
  }>(() => {
    const none = { actors: [], unreadable: 0, flooded: false };
    if (!community || !folded || !control.data || !canAct) return none;
    void verdicts;
    if (!controlSweepAnswered(community)) return none;
    // A read cut short by our budget IS the alarm (someone inflating the plane);
    // suppressing on it would hand the attacker a mute button.
    const short = controlSweepTruncated(community);
    // But a short read (or no quorum) forbids NAMING anyone: we can't tell
    // "roleless" from "grant not yet read", and this alert is one click from a ban.
    const nameable = !short && controlSweepQuorum(community);
    const since = Math.max(dismissed.at, nowSecs() - WINDOW_SECONDS);
    return {
      flooded: short,
      actors: nameable
        ? suspiciousActivity(openControlEditions(control.data), folded, community.id, {
            since,
            opened: control.data,
          })
        : [],
      // Only wraps that would NOT open; junk that opened is counted on its author's row.
      unreadable: controlSweepUnreadable(community),
    };
  }, [community, folded, control.data, canAct, dismissed.at, verdicts]);

  // Ratchet the junk watermark DOWN as floods recede (`unreadable` is per-sweep),
  // or one dismissal at 500 would silence the signal forever.
  useEffect(() => {
    if (unreadable >= dismissed.unreadable && (flooded || !dismissed.flooded)) return;
    const next = { ...dismissed, unreadable: Math.min(unreadable, dismissed.unreadable), flooded };
    writeDismissal(me, idHex, next);
    setDismissed(next);
  }, [unreadable, flooded, dismissed, me, idHex]);

  const dismiss = useCallback(() => {
    const next: Dismissal = { at: nowSecs(), unreadable, flooded };
    writeDismissal(me, idHex, next);
    setDismissed(next);
  }, [me, idHex, unreadable, flooded]);

  // Junk alone raises the alarm, but must exceed the dismissed level again, not
  // just the threshold, or a standing flood makes the banner permanent.
  const alert =
    actors.length > 0 ||
    unreadable - dismissed.unreadable >= UNREADABLE_ALERT_THRESHOLD ||
    (flooded && !dismissed.flooded);

  return { actors, unreadable, flooded, alert, dismiss, canAct };
}
