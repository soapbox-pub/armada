import { useCurrentUser } from "@/hooks/useCurrentUser";
import { clockNowMs } from "@/lib/relayClock";
import { queryPlane, withGuestbookStreams } from "@/concord/lib/rumorStore";
import { communityNicknames, runningTimeouts } from "@/concord/lib/channelJudges";
import { currentGuestbookGroup } from "@/concord/lib/guestbook";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useEffect, useMemo, useRef } from "react";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { useIsBlocked } from "@/lib/blocklistStore";
import { readLivePause } from "@/concord/hooks/useControlPlane";
import { canonicalJson, rehydrateCommunity, liveEntries, removedCommunityIds } from "@/concord/lib/communityList";
import { buildConcordSubs, type ConcordSub } from "@/concord/lib/concordNotifications";
import { readControlFold } from "@/concord/lib/control";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import { onWireScopes } from "@/wire/bus";

/**
 * Concord native-notification subscriptions for EVERY live community: per
 * channel, the kind-1059 stream addresses (across held epochs), the keys that
 * open their wraps, and names/ids for the notification + deep link.
 *
 * Built from persisted control-fold snapshots ({@link readControlFold}), no
 * relay fan-out. A never-opened community contributes only its join bundle's
 * private channels. Stream keys are registered for NIP-42 so the WebView can
 * answer AUTH for the native service's REQs.
 */
export interface ConcordSubsState {
  /** Last complete derived subscription snapshot (empty is authoritative when ready). */
  subs: ConcordSub[];
  /**
   * True only once membership and the control-fold derivation for that exact
   * list have both completed. Callers that REPLACE persisted/native config or
   * PRUNE remote records must wait: `subs: []` while false means "not known yet".
   */
  ready: boolean;
  /**
   * Safe to replace the sealed decrypt config (a complete persisted fold is
   * trusted last-good data). Only `ready` may authorize gateway pruning.
   */
  configReady: boolean;
  /**
   * Communities the list says the member left. Valid whether `ready` or not: a
   * controller that only merges while unready must still drop these.
   */
  left: string[];
  /** The read which prevented this snapshot becoming authoritative, if any. */
  error?: unknown;
}

/**
 * The subscriptions together with their completeness. Background controllers
 * use this before replacing durable state; render-only callers use {@link useConcordSubs}.
 */
export function useConcordSubsState(): ConcordSubsState {
  const communityList = useCommunityList();
  const { data } = communityList;
  const queryClient = useQueryClient();
  const viewer = useCurrentUser().user?.pubkey;

  // Keyed on membership identity + epoch, so unrelated list churn is free. A
  // blocked community gets no subscription, and no native notifications.
  const isBlocked = useIsBlocked();
  const entries = useMemo(
    () => (data ? liveEntries(data.list).filter((e) => !isBlocked(e.community_id)) : []),
    [data, isBlocked],
  );
  // Keyed on ids, so a refetch that leaves nobody new doesn't hand the native
  // controller a fresh array.
  const leftSig = data && !data.decryptFailed
    ? removedCommunityIds(data.list).sort().join(",")
    : "";
  const left = useMemo(() => (leftSig ? leftSig.split(",") : []), [leftSig]);

  // A pause/lift arrives on the GLOBAL c2ctl sub for every community; recompute
  // so a background community's notifications stop promptly. Checked against the
  // live list first, since a re-run re-reads every fold.
  const liveIdsRef = useRef<Set<string>>(new Set());
  liveIdsRef.current = useMemo(() => new Set(entries.map((e) => e.community_id.toLowerCase())), [entries]);
  useEffect(
    () =>
      onWireScopes((scopes) => {
        for (const s of scopes) {
          if (s.startsWith("c2ctl:") && liveIdsRef.current.has(s.slice("c2ctl:".length).toLowerCase())) {
            void queryClient.invalidateQueries({ queryKey: ["concord", "notif-subs"] });
            return;
          }
        }
      }),
    [queryClient],
  );
  const listSig = useMemo(
    // Full membership material, not a count: a swapped key or relay would otherwise
    // reuse the previous query's success as readiness.
    () => bytesToHex(sha256(new TextEncoder().encode(canonicalJson(
      [...entries].sort((a, b) => a.community_id.localeCompare(b.community_id)),
    )))),
    [entries],
  );

  // An undecryptable list is public-only, not authoritative. Boot/cache seeds omit
  // `repairPending`; only an explicit `false` from syncCommunityList authorizes pruning.
  const membershipReady = data !== undefined
    && !data.decryptFailed
    && data.repairPending === false;
  const membershipUsable = data !== undefined && !data.decryptFailed;

  const query = useQuery<{ subs: ConcordSub[]; foldsReady: boolean }>({
    queryKey: ["concord", "notif-subs", listSig, viewer ?? null],
    enabled: membershipUsable && entries.length > 0,
    staleTime: 30_000,
    // Fold snapshots update out-of-band; re-read to pick up new channels.
    refetchInterval: 60_000,
    queryFn: async () => {
      const subs: ConcordSub[] = [];
      let foldsReady = true;
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community) {
          foldsReady = false;
          continue;
        }
        const folded = await readControlFold(community.idHex);
        // A cache miss is not an empty fold: public channels exist only in the
        // persisted fold, so pruning before it appears would silently remove them.
        if (folded === undefined) foldsReady = false;
        // A paused community (CORD-04 §8) drops its chat plane from the background
        // service too, staff included. `readLivePause` reads the CURRENT pause (the fold
        // may be hours stale). The control plane stays subscribed so the lift lands;
        // the missed window is caught up via the same IOU WireSync uses.
        if (await readLivePause(community, Math.floor(Date.now() / 1000))) continue;
        // Silence and names are extras: a failure to read them costs those, never the subs.
        let timeouts: ReturnType<typeof runningTimeouts> = [];
        let nicknames: Record<string, string> = {};
        try {
          const guestbook = await withGuestbookStreams(community, await queryPlane(community.idHex, "guestbook"));
          timeouts = runningTimeouts(guestbook, folded, community.id, clockNowMs());
          nicknames = communityNicknames(guestbook, folded, community.id, currentGuestbookGroup(community).pk, clockNowMs());
        } catch {
          // keep none
        }
        const built = buildConcordSubs(community, folded, entry.added_at, viewer, timeouts, nicknames);
        subs.push(...built.subs);
        // NIP-42, scoped per relay: the native service bridges AUTH challenges to the
        // WebView, which signs a kind-22242 per stream key (see useNativeNotifications).
        registerStreamKeys(built.streamKeys, community.relays);
      }
      return { subs, foldsReady };
    },
  });

  const ready = membershipReady && (entries.length === 0
    || (query.isSuccess && query.data.foldsReady));
  // An absent/error-seeded empty membership is not an authoritative empty config;
  // a non-empty list whose folds are all persisted is trusted last-good.
  const configReady = ready || (entries.length > 0
    && query.isSuccess
    && query.data.foldsReady);
  const error = communityList.error ?? query.error ?? undefined;
  return {
    subs: query.data?.subs ?? [],
    ready,
    configReady,
    left,
    ...(error ? { error } : {}),
  };
}

/** For consumers that don't persist or prune; background controllers use {@link useConcordSubsState}. */
export function useConcordSubs(): ConcordSub[] {
  return useConcordSubsState().subs;
}
