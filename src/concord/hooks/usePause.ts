import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { citationFor, foldStoredControl, invalidateControl, publishEdition, useControlFold, withControlWrite } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { activePause, buildSignalsEdition, type ActivePause } from "@/concord/lib/control";
import { bytesToHex, signalLocator } from "@/concord/lib/derive";
import { SIGNAL_PAUSE } from "@/concord/lib/kinds";
import { isAuthorized, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/** `setTimeout`'s ceiling — anything larger fires immediately, so long waits re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Pause durations offered; each `label` is formatted when read, in the current language. Bounded by default: CORD-04 §8's `until` lets a raid
 * response survive the pauser going offline, and a full freeze leaves everyone
 * without chat until lifted. `undefined` is the explicit open-ended choice.
 */
export const PAUSE_DURATIONS: ReadonlyArray<{ label: string; secs?: number }> = [
  {
    get label() {
      return t({ id: "usePause.duration.minutes15", defaultMessage: "15 minutes" });
    },
    secs: 15 * 60,
  },
  {
    get label() {
      return t({ id: "usePause.duration.hour1", defaultMessage: "1 hour" });
    },
    secs: 60 * 60,
  },
  {
    get label() {
      return t({ id: "usePause.duration.hours8", defaultMessage: "8 hours" });
    },
    secs: 8 * 60 * 60,
  },
  {
    get label() {
      return t({ id: "usePause.duration.untilResumed", defaultMessage: "Until I resume it" });
    },
  },
];

/**
 * The community's active pause, re-evaluated when its `until` passes.
 * CORD-04 §8 requires honoring `until` locally, so the expiry must be
 * SCHEDULED — nothing else re-renders on its behalf.
 */
export function useActivePause(community: Community | undefined): ActivePause | undefined {
  const { data: folded } = useControlFold(community);
  const [tick, setTick] = useState(0);
  const pause = activePause(folded, nowSecs());
  const until = pause?.until;

  useEffect(() => {
    if (until === undefined) return;
    // +1s so the wake lands strictly PAST the boundary: `activePause` clears at
    // `nowSec >= until`, and firing a few ms early would re-arm in a loop.
    const ms = until * 1000 - Date.now() + 1000;
    if (ms <= 0) return; // already inert; `pause` is undefined and this won't run
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(ms, MAX_TIMEOUT_MS));
    return () => clearTimeout(t);
    // `tick` re-arms the clamped case (until beyond setTimeout's range); the wake
    // that clears `until` ends the loop.
  }, [until, tick]);

  return pause;
}

/**
 * The community-wide PAUSE signal (CORD-04 §8, `signal_id` "pause"): a
 * MANAGE_CHANNELS holder closes the room to non-staff. Enforced by reader-side
 * fold (`activePause` + `foldTimeline`), never an author drop. Optional `until`
 * (seconds) self-clears.
 */
export function useCommunityPause(community: Community | undefined): {
  /** Holds MANAGE_CHANNELS. */
  canPause: boolean;
  pause: ActivePause | undefined;
  isPaused: boolean;
  /** Optionally until `untilSecs` (unix seconds). */
  setPaused: ReturnType<typeof useMutation<void, Error, { untilSecs?: number }>>;
  clearPause: ReturnType<typeof useMutation<void, Error, void>>;
} {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);

  const canPause = Boolean(
    user && folded && isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.MANAGE_CHANNELS),
  );
  const pause = useActivePause(community);

  const publishPause = async (content: Record<string, unknown>): Promise<void> => {
    if (!user || !community) throw new Error(t({ id: "usePause.notReady", defaultMessage: "Not ready." }));
    if (!folded || !isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.MANAGE_CHANNELS)) {
      throw new Error(t({ id: "usePause.noPermission", defaultMessage: "You don't have permission to pause this community." }));
    }
    const c = community;
    const u = user;
    // One write at a time, from the store's fold: the rendered one lags this device's last write.
    await withControlWrite(c.idHex, async () => {
      const now = await foldStoredControl(c).catch(() => folded);
      const head = now.heads.get(bytesToHex(signalLocator(c.id, SIGNAL_PAUSE)));
      await publishEdition(
        nostr,
        c,
        u.signer,
        buildSignalsEdition(c.id, SIGNAL_PAUSE, content, {
          actorPubkey: u.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(c, now, u.pubkey),
        }),
      );
    });
    invalidateControl(queryClient, community.idHex);
  };

  const setPaused = useMutation<void, Error, { untilSecs?: number }>({
    mutationFn: ({ untilSecs }) =>
      publishPause({ paused: true, ...(untilSecs !== undefined ? { until: untilSecs } : {}) }),
    onError: (e) => toast({ title: t({ id: "usePause.pauseFailed", defaultMessage: "Couldn't pause the community" }), description: e.message }),
  });
  const clearPause = useMutation<void, Error, void>({
    mutationFn: () => publishPause({ paused: false }),
    onError: (e) => toast({ title: t({ id: "usePause.resumeFailed", defaultMessage: "Couldn't resume the community" }), description: e.message }),
  });

  return { canPause, pause, isPaused: Boolean(pause), setPaused, clearPause };
}
