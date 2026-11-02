import { useNostr } from "@nostrify/react";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  buildJoinRumor,
  buildKickRumor,
  buildLeaveRumor,
  coalesceGuestbook,
  foldNicknames,
  foldTimeouts,
  completeMemberlist,
  currentGuestbookGroup,
  openGuestbookOpened,
  sealGuestbook,
  snapshotAuthorities,
  type CoalescedMember,
  type FoldedTimeout,
} from "@/concord/lib/guestbook";
import { mergeOpened, openPlaneWraps, sweepGuestbook } from "@/concord/lib/planeSync";
import { queryPlane, writeOpened } from "@/concord/lib/rumorStore";
import type { OpenedEvent } from "@/concord/lib/stream";
import { citationSatisfied } from "@/concord/lib/control";
import { canActOnMember, mayName, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { queueSignedEvent, recordQueuedPublishAttempt } from "@/lib/publishOutbox";
import { emitWireScopes, onWireScopes } from "@/wire/bus";
import { t } from "@/i18n";

/**
 * The Guestbook Plane (CORD-02 §5): membership motion, coalesced flat.
 * Off-consensus, so it polls lazily via {@link sweepGuestbook}; the poll is the
 * floor, live wraps arrive via the wire's `c2gb` sub and ring `c2gb:<idHex>`
 * (which matters for a KICK, which rotates no key and has no control edition).
 */
interface GuestbookWakeEntry {
  refs: number;
  teardown: () => void;
}

/**
 * One refcounted `c2gb` bus listener per (queryClient, query key), so N mounts
 * do one store re-read per ring. WeakMap-keyed so test clients never share listeners.
 *
 * The wake is a STORE-ONLY read merged into the cache, NOT an invalidate: the
 * queryFn starts a network sweep, and awaiting it would strand an
 * already-stored kick behind auth + a 25s timeout.
 */
const guestbookWakeRegistries = new WeakMap<QueryClient, Map<string, GuestbookWakeEntry>>();

function acquireGuestbookWake(
  queryClient: QueryClient,
  idHex: string,
  queryKey: readonly unknown[],
): () => void {
  let registry = guestbookWakeRegistries.get(queryClient);
  if (!registry) {
    registry = new Map();
    guestbookWakeRegistries.set(queryClient, registry);
  }
  const key = JSON.stringify(queryKey);
  const existing = registry.get(key);
  if (existing) {
    existing.refs++;
    return () => releaseGuestbookWake(registry, key);
  }

  const scope = `c2gb:${idHex}`;
  const unsubscribe = onWireScopes((scopes) => {
    if (!scopes.has(scope)) return;
    void queryPlane(idHex, "guestbook").then((stored) => {
      if (stored.length === 0) return;
      queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], stored));
    });
  });
  registry.set(key, { refs: 1, teardown: unsubscribe });
  return () => releaseGuestbookWake(registry, key);
}

function releaseGuestbookWake(registry: Map<string, GuestbookWakeEntry>, key: string): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.teardown();
    registry.delete(key);
  }
}

export function useGuestbook(community: Community | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const { data: dissolvedAtMs } = useDissolved(community);

  const queryKey = useMemo(
    () => ["concord", "guestbook", community?.idHex ?? null, community?.rootEpoch.toString() ?? ""] as const,
    [community?.idHex, community?.rootEpoch],
  );

  const query = useQuery<OpenedEvent[]>({
    queryKey,
    enabled: Boolean(community),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      // Return the STORE read; the network sweep runs in the background and merges
      // via onFresh. Awaiting it stranded reads (incl. useSelfRemove's refetch)
      // behind relay round-trips of up to ~30s.
      const stored = await queryPlane(community!.idHex, "guestbook");
      const merged = mergeOpened(queryClient.getQueryData<OpenedEvent[]>(queryKey) ?? [], stored);
      void sweepGuestbook(nostr, community!, {
        onFresh: (fresh) => {
          if (fresh.length === 0) return;
          queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], fresh));
        },
      }).catch(() => {
        // Best-effort: the live sub and the 5-minute background sweep cover a miss.
      });
      return merged;
    },
  });

  // Refcounted store re-read on `c2gb:<idHex>` (see acquireGuestbookWake).
  const idHex = community?.idHex;
  useEffect(() => {
    if (!idHex) return;
    return acquireGuestbookWake(queryClient, idHex, queryKey);
  }, [idHex, queryKey, queryClient]);

  const coalesced = useMemo(() => {
    if (!community || !query.data) return new Map<string, CoalescedMember>();
    const opened = openGuestbookOpened(query.data);
    // A snapshot is honored only from the npub whose Refounding minted its epoch
    // (CORD-02 §5). The sweep spans every held epoch, so authority is the set of
    // recorded refounders; an epoch with none accepts no snapshot (no owner fallback).
    const authorities = snapshotAuthorities(community);
    return coalesceGuestbook(opened, {
      nowMs: Date.now(),
      canKick: (actor, target, citation, atMs) =>
        Boolean(
          // Death wins every race (CORD-02 §9) — an ORDERING rule: only a kick published
          // AFTER the tombstone is refused, or dissolving would un-kick everyone.
          !(dissolvedAtMs != null && atMs > dissolvedAtMs) &&
            folded &&
            // A lifted Ban writes its departure as a Kick from a BAN holder (CORD-04 §6).
            (canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK) ||
              canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.BAN)) &&
            // …and the CORD-04 §5 sync floor, so a kick from an admin whose
            // demotion we haven't read yet parks instead of landing.
            citationSatisfied(folded, community.id, actor, citation),
        ),
      snapshotAuthorities: authorities,
      banned: folded?.banned,
    });
  }, [community, query.data, folded, dissolvedAtMs]);

  // Timeouts and Nicknames (CORD-04 §8, §10), judged against the Roster as it stands.
  const timeouts = useMemo(() => {
    if (!community || !query.data || !folded?.rankedRoster) return new Map<string, FoldedTimeout>();
    return foldTimeouts(query.data, {
      nowMs: Date.now(),
      ownerHex: folded.ownerHex,
      banned: folded.banned,
      mayTimeout: (actor, target, citation) =>
        canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.MODERATE_MEMBERS) &&
        citationSatisfied(folded, community.id, actor, citation),
    });
  }, [community, query.data, folded]);
  const nicknames = useMemo(() => {
    if (!community || !query.data || !folded?.rankedRoster) return new Map<string, string>();
    return foldNicknames(query.data, {
      nowMs: Date.now(),
      banned: folded.banned,
      timeouts,
      mayName: (actor, target, citation) =>
        mayName(folded.roster, actor, folded.ownerHex, target) &&
        (actor === target || citationSatisfied(folded, community.id, actor, citation)),
    });
  }, [community, query.data, folded, timeouts]);

  return { ...query, coalesced, timeouts, nicknames };
}

/**
 * The Complete Memberlist: coalesced Guestbook ∪ observed authors − Banlist.
 * `observed` maps every author seen publishing to the newest ms seen.
 */
export function useMembers(
  community: Community | undefined,
  observed: Map<string, number>,
): { members: Set<string>; coalesced: Map<string, CoalescedMember> } {
  const { coalesced } = useGuestbook(community);
  const { data: folded } = useControlFold(community);
  const members = useMemo(
    () => completeMemberlist(coalesced, observed, folded?.banned ?? new Set(), folded?.bannedAt),
    [coalesced, observed, folded],
  );
  return { members, coalesced };
}

/** How long a Guestbook Leave no relay has taken stays in the publish outbox. */
export const GUESTBOOK_LEAVE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Publish one guestbook rumor to the community relays. */
export function useGuestbookPublisher(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: dissolvedNow } = useDissolved(community);

  return useMutation({
    mutationFn: async (
      action:
        | { type: "join"; attribution?: { creator: string; label?: string } }
        | { type: "leave" }
        | { type: "kick"; target: string; vac?: { eid: string; version: bigint; hash: string } },
    ) => {
      if (!user || !community) throw new Error(t({ id: "useGuestbook.notReady", defaultMessage: "Not ready." }));
      // A dissolved community honors no new authority action (CORD-02 §9); a Leave
      // is self-signed housekeeping and stays allowed.
      if (dissolvedNow != null && action.type === "kick") {
        throw new Error(t({ id: "useGuestbook.dissolved", defaultMessage: "This community has been dissolved; it accepts no new moderation." }));
      }
      const group = currentGuestbookGroup(community);
      const ms = Date.now();
      const rumor =
        action.type === "join"
          ? buildJoinRumor(user.pubkey, ms, action.attribution)
          : action.type === "leave"
            ? buildLeaveRumor(user.pubkey, ms)
            : buildKickRumor(user.pubkey, action.target, ms, action.vac);
      const wrap = await sealGuestbook(rumor, group, user.signer);
      // The leaver has no screen left to retry from, so the signed wrap goes into
      // the publish outbox FIRST; relays that accept it are struck off and the rest
      // retry later (bounded by GUESTBOOK_LEAVE_RETRY_MS).
      const queued =
        action.type === "leave" &&
        (await queueSignedEvent(wrap, undefined, community.relays, {
          expiresAt: Date.now() + GUESTBOOK_LEAVE_RETRY_MS,
        }).then(
          () => true,
          () => false,
        ));
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (queued) {
        const rejected = community.relays.filter((_, i) => results[i]?.status === "rejected");
        await recordQueuedPublishAttempt(wrap.id, community.relays, rejected).catch(() => undefined);
      }
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error(t({ id: "useGuestbook.noRelayAccepted", defaultMessage: "No relay accepted the update." }));
      }
      // Seed the store with our own rumor (as ingest would) and ring `c2gb`; the
      // publisher gets no echo of its own wrap otherwise.
      const opened = openPlaneWraps([wrap], [group]);
      if (opened.length > 0) await writeOpened(community.idHex, opened, "guestbook");
    },
    onSuccess: () => {
      // Store-only re-read, NOT an invalidate (which awaits the network sweep).
      if (community) emitWireScopes([`c2gb:${community.idHex}`]);
    },
  });
}
