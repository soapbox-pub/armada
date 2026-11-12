import type { AuthorityCitation } from "@/concord/lib/edition";
import { useNostr } from "@nostrify/react";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { citationFor, useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { KIND_NICKNAME, KIND_TIMEOUT } from "@/concord/lib/kinds";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  banDeparturesOwed,
  buildJoinRumor,
  buildKickRumor,
  buildNicknameRumor,
  buildTimeoutRumor,
  cleanNickname,
  nextGuestbookMs,
  nicknameToCarry,
  TIMEOUT_MAX_SECS,
  timeoutRunning,
  buildLeaveRumor,
  coalesceGuestbook,
  foldNicknames,
  foldTimeouts,
  completeMemberlist,
  currentGuestbookGroup,
  openGuestbookOpened,
  sealGuestbook,
  liveRefound,
  guestbookHistory,
  joinToRestore,
  type CoalescedMember,
  type FoldedTimeout,
  type GuestbookHistory,
  type Refound,
} from "@/concord/lib/guestbook";
import { guestbookFoldOptions, type GuestbookFoldOptions } from "@/concord/lib/memberlist";
import { mergeOpened, openPlaneWraps, sweepGuestbook } from "@/concord/lib/planeSync";
import { heldPostAfter, queryPlane, withGuestbookStreams, writeOpened } from "@/concord/lib/rumorStore";
import { clockNowMs } from "@/lib/relayClock";
import type { OpenedEvent } from "@/concord/lib/stream";
import { citationSatisfied, type FoldedControl } from "@/concord/lib/control";
import { canActOnMember, mayName, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { queueSignedEvent, recordQueuedPublishAttempt } from "@/lib/publishOutbox";
import { attemptGuestbookJoin, getPendingGuestbookJoin, queueGuestbookJoin } from "@/concord/lib/pendingGuestbookJoin";
import { logSync } from "@/lib/syncLog";
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

/** The live Guestbook planes a sweep read to the end on every relay that answered, this session (CORD-02 §5's "read the whole plane"). */
const walkedPlanes = new Set<string>();
const walkedListeners = new Set<() => void>();

function guestbookPlaneKey(community: Community): string {
  return `${community.idHex}@${community.rootEpoch}`;
}

function markGuestbookWalked(key: string): void {
  if (walkedPlanes.has(key)) return;
  walkedPlanes.add(key);
  for (const l of walkedListeners) l();
}

/** Whether this session read a Community's live Guestbook up to now (Vector `guestbook_walked_this_session`). */
export function guestbookWalked(community: Community): boolean {
  return walkedPlanes.has(guestbookPlaneKey(community));
}

function useGuestbookWalked(community: Community | undefined): boolean {
  return useSyncExternalStore(
    (l) => {
      walkedListeners.add(l);
      return () => walkedListeners.delete(l);
    },
    () => Boolean(community && walkedPlanes.has(guestbookPlaneKey(community))),
  );
}

/** Planes this session already restored a Join on: once a session per plane (Vector `JoinAnnounced`). */
const restoredPlanes = new Set<string>();

/**
 * Restore this member's lost Join (CORD-02 §5): once the live Guestbook was read
 * up to now and holds no state of theirs, queue a Join dated by the plane, re-sent
 * as the same signed event until a relay holds it.
 */
export function useRestoreJoin(community: Community | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data, coalesceOpts } = useGuestbook(community);
  const walked = useGuestbookWalked(community);
  useEffect(() => {
    if (!community || !user || !walked || !data || !coalesceOpts) return;
    const key = guestbookPlaneKey(community);
    if (restoredPlanes.has(key) || getPendingGuestbookJoin(user.pubkey, community.idHex)) return;
    const ms = joinToRestore(data, coalesceOpts, user.pubkey, community.owner);
    if (ms === undefined) return;
    restoredPlanes.add(key);
    logSync("guestbook", `${community.idHex.slice(0, 8)}: no Join of ours stands on this plane; restoring it`);
    queueGuestbookJoin({ viewer: user.pubkey, communityIdHex: community.idHex, ms });
    void attemptGuestbookJoin(nostr, community, user.signer, user.pubkey);
  }, [community, user, walked, data, coalesceOpts, nostr]);
}

/** Planes this session already healed lifted Bans' departures on (Vector `BanDeparturesHealed`). */
const healedPlanes = new Set<string>();
/** Planes this session already carried this member's own Nickname onto. */
const carriedPlanes = new Set<string>();

/** Forget what this session read and wrote on the Guestbook, so the next account starts fresh (Vector's session scope). */
export function clearGuestbookSessionMemory(): void {
  walkedPlanes.clear();
  restoredPlanes.clear();
  healedPlanes.clear();
  carriedPlanes.clear();
  for (const l of walkedListeners) l();
}

/**
 * Once a session, the owner writes the departure of every Ban lifted before an unban
 * wrote its own: a member whose Ban this device remembers, still standing on a pre-ban
 * Join and silent since (Vector `heal_ban_departures`). Owner-only, so one signer writes
 * it and each member gets one rumor. `observed` is each author's newest post, in ms.
 */
export function useHealBanDepartures(community: Community | undefined, observed: ReadonlyMap<string, number>): void {
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data, coalesced } = useGuestbook(community);
  const walked = useGuestbookWalked(community);
  const publish = useGuestbookPublisher(community);
  const publishRef = useRef(publish.mutateAsync);
  publishRef.current = publish.mutateAsync;
  useEffect(() => {
    if (!community || !user || !folded || !walked || !data || user.pubkey !== community.owner) return;
    const key = guestbookPlaneKey(community);
    if (healedPlanes.has(key)) return;
    healedPlanes.add(key);
    void (async () => {
      const owed = await banDeparturesOwed(folded, coalesced, observed, (pk, afterMs) => heldPostAfter(community.idHex, pk, afterMs));
      for (const { pk, ms } of owed) await publishRef.current({ type: "kick", target: pk, ms }).catch(() => undefined);
    })();
  }, [community, user, folded, walked, data, coalesced, observed]);
}

/**
 * Once a session per Guestbook plane, re-issue the Nickname this member went by when the
 * live epoch lacks it (CORD-04 §10, Vector `carry_my_nickname`): a Refounding carries only
 * the Nicknames moderators gave, and each member carries their own.
 */
export function useCarryMyNickname(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data, timeouts } = useGuestbook(community);
  const walked = useGuestbookWalked(community);
  const publish = useGuestbookPublisher(community);
  const publishRef = useRef(publish.mutateAsync);
  publishRef.current = publish.mutateAsync;
  useEffect(() => {
    if (!community || !user || !folded || !walked || !data) return;
    const key = guestbookPlaneKey(community);
    if (carriedPlanes.has(key)) return;
    carriedPlanes.add(key);
    const carry = nicknameToCarry(data, {
      me: user.pubkey,
      livePk: currentGuestbookGroup(community).pk,
      nowMs: clockNowMs(),
      banned: folded.banned,
      timeouts,
      mayName: (actor, target, citation) =>
        mayName(folded.roster, actor, folded.ownerHex, target) && (actor === target || citationSatisfied(folded, community.id, actor, citation)),
    });
    if (carry) void publishRef.current({ type: "nickname", target: user.pubkey, nick: carry.nick, ms: carry.ms }).catch(() => carriedPlanes.delete(key));
  }, [community, user, folded, walked, data, timeouts]);
}

/**
 * Timing members out and naming them (CORD-04 §8, §10, Vector `timeout_member`, `set_nickname`):
 * who this member may act on, and the writes, each dated just after what it replaces.
 */
export function useMemberStanding(community: Community | undefined) {
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data, timeouts, nicknames } = useGuestbook(community);
  const publish = useGuestbookPublisher(community);
  const me = user?.pubkey;
  const counts = useCallback(
    (permission: "timeout" | "nickname", target: string) => (actor: string, citation: AuthorityCitation | undefined) => {
      if (!folded || !community) return false;
      const may = permission === "timeout"
        ? canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.MODERATE_MEMBERS)
        : mayName(folded.roster, actor, folded.ownerHex, target);
      return may && (actor === target || citationSatisfied(folded, community.id, actor, citation));
    },
    [folded, community],
  );
  const mayTimeout = useCallback(
    (target: string) => Boolean(me && folded && target !== me && canActOnMember(folded.roster, me, folded.ownerHex, target, Permissions.MODERATE_MEMBERS)),
    [me, folded],
  );
  // A member sits out their own Nickname while timed out (CORD-04 §10).
  const mayNickname = useCallback(
    (target: string) => Boolean(me && folded && mayName(folded.roster, me, folded.ownerHex, target) && !(target === me && timeoutRunning(timeouts.get(me), clockNowMs()))),
    [me, folded, timeouts],
  );
  const timeout = useCallback(
    async (target: string, seconds: number) => {
      if (!community || !folded || !me) throw new Error(t({ id: "useGuestbook.notReady", defaultMessage: "Not ready." }));
      const nowMs = clockNowMs();
      const ms = nextGuestbookMs(data ?? [], KIND_TIMEOUT, target, counts("timeout", target), nowMs);
      // A lift's `until` is past for every reader, however its date runs ahead.
      const until = seconds <= 0 ? 0 : Math.floor(nowMs / 1000) + Math.min(seconds, TIMEOUT_MAX_SECS);
      await publish.mutateAsync({ type: "timeout", target, until, ms, authority: citationFor(community, folded, me) });
    },
    [community, folded, me, data, counts, publish],
  );
  const setNickname = useCallback(
    async (target: string, nick: string) => {
      if (!community || !folded || !me) throw new Error(t({ id: "useGuestbook.notReady", defaultMessage: "Not ready." }));
      const clean = cleanNickname(nick);
      if (clean === undefined) throw new Error(t({ id: "useGuestbook.nicknameInvalid", defaultMessage: "A nickname is at most 32 characters, with no line breaks." }));
      const ms = nextGuestbookMs(data ?? [], KIND_NICKNAME, target, counts("nickname", target), clockNowMs());
      await publish.mutateAsync({ type: "nickname", target, nick: clean, ms, ...(target !== me ? { authority: citationFor(community, folded, me) } : {}) });
    },
    [community, folded, me, data, counts, publish],
  );
  return useMemo(() => ({ timeouts, nicknames, mayTimeout, mayNickname, timeout, setNickname }), [timeouts, nicknames, mayTimeout, mayNickname, timeout, setNickname]);
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
      const stored = await withGuestbookStreams(community!, await queryPlane(community!.idHex, "guestbook"));
      const merged = mergeOpened(queryClient.getQueryData<OpenedEvent[]>(queryKey) ?? [], stored);
      const walked = guestbookPlaneKey(community!);
      void sweepGuestbook(nostr, community!, {
        onWalked: () => markGuestbookWalked(walked),
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

  // Timeouts and Nicknames (CORD-04 §8, §10) are judged again as each running Timeout ends.
  const [timeoutEdge, setTimeoutEdge] = useState(0);
  const fold = useMemo(() => {
    void timeoutEdge;
    return community && query.data ? sharedGuestbookFold(community, query.data, folded, dissolvedAtMs, clockNowMs()) : EMPTY_FOLD;
  }, [community, query.data, folded, dissolvedAtMs, timeoutEdge]);
  const { coalesced, history, refound, opts: coalesceOpts, timeouts, nicknames, validUntil } = fold;
  useEffect(() => {
    if (validUntil === Infinity) return;
    const timer = setTimeout(() => setTimeoutEdge((n) => n + 1), Math.min(validUntil - clockNowMs() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [validUntil]);

  return { ...query, coalesced, history, refound, coalesceOpts, timeouts, nicknames };
}

interface GuestbookFold {
  sig: string;
  folded: FoldedControl | undefined;
  dissolvedAtMs: number | null | undefined;
  coalesced: Map<string, CoalescedMember>;
  history: GuestbookHistory | undefined;
  refound: Refound | undefined;
  opts: GuestbookFoldOptions | undefined;
  timeouts: Map<string, FoldedTimeout>;
  nicknames: Map<string, string>;
  /** When the next running Timeout ends, and with it these Timeouts and Nicknames. */
  validUntil: number;
}

const EMPTY_FOLD: GuestbookFold = {
  sig: "",
  folded: undefined,
  dissolvedAtMs: undefined,
  coalesced: new Map(),
  history: undefined,
  refound: undefined,
  opts: undefined,
  timeouts: new Map(),
  nicknames: new Map(),
  validUntil: Infinity,
};

/** The last fold per shared Guestbook read, so every `useGuestbook` on a community folds it once. */
const foldByData = new WeakMap<OpenedEvent[], GuestbookFold>();

/** What {@link guestbookFoldOptions} reads off a Community; instances rehydrate their own copies. */
function guestbookFoldSig(community: Community): string {
  const roots = community.heldRoots.map((r) => `${r.epoch}/${r.refounder ?? ""}`).join(",");
  return `${community.idHex}:${community.rootEpoch}:${community.refounder ?? ""}:${roots}`;
}

function sharedGuestbookFold(
  community: Community,
  data: OpenedEvent[],
  folded: FoldedControl | undefined,
  dissolvedAtMs: number | null | undefined,
  nowMs: number,
): GuestbookFold {
  const sig = guestbookFoldSig(community);
  const hit = foldByData.get(data);
  const same = hit !== undefined && hit.sig === sig && hit.folded === folded && hit.dissolvedAtMs === dissolvedAtMs;
  if (same && nowMs < hit.validUntil) return hit;

  let { coalesced, history, refound, opts } = same ? hit : EMPTY_FOLD;
  if (!same) {
    const opened = openGuestbookOpened(data);
    opts = guestbookFoldOptions(community, folded, dissolvedAtMs);
    coalesced = coalesceGuestbook(opened, opts);
    history = guestbookHistory(opened, opts);
    refound = liveRefound(opened, opts);
  }

  // Judged against the Roster as it stands; on a legacy one every member still names themselves.
  let timeouts = new Map<string, FoldedTimeout>();
  let nicknames = new Map<string, string>();
  if (folded) {
    timeouts = foldTimeouts(data, {
      nowMs,
      ownerHex: folded.ownerHex,
      banned: folded.banned,
      mayTimeout: (actor, target, citation) =>
        canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.MODERATE_MEMBERS) &&
        citationSatisfied(folded, community.id, actor, citation),
    });
    // Only the live epoch's count: one seen at an older address, or at none recorded, doesn't (Vector `nicknames_on`).
    const live = currentGuestbookGroup(community).pk;
    nicknames = foldNicknames(data.filter((e) => e.streamPk === live), {
      nowMs,
      banned: folded.banned,
      timeouts,
      mayName: (actor, target, citation) =>
        mayName(folded.roster, actor, folded.ownerHex, target) &&
        (actor === target || citationSatisfied(folded, community.id, actor, citation)),
    });
  }
  let validUntil = Infinity;
  for (const t of timeouts.values()) if (t.until * 1000 > nowMs) validUntil = Math.min(validUntil, t.until * 1000);

  const fold: GuestbookFold = { sig, folded, dissolvedAtMs, coalesced, history, refound, opts, timeouts, nicknames, validUntil };
  foldByData.set(data, fold);
  return fold;
}

/**
 * The Complete Memberlist: coalesced Guestbook ∪ observed authors − Banlist.
 * `observed` maps every author seen publishing to the newest ms seen.
 */
export function useMembers(
  community: Community | undefined,
  observed: Map<string, number>,
): { members: Set<string>; coalesced: Map<string, CoalescedMember>; history: GuestbookHistory | undefined } {
  const { coalesced, history, refound } = useGuestbook(community);
  const { data: folded } = useControlFold(community);
  const members = useMemo(
    () => completeMemberlist(coalesced, observed, folded?.banned ?? new Set(), folded?.bannedAt, refound),
    [coalesced, observed, folded, refound],
  );
  return { members, coalesced, history };
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
        /** `ms` dates a Ban's departure at the Ban (CORD-04 §6); now otherwise. */
        | { type: "kick"; target: string; vac?: { eid: string; version: bigint; hash: string }; ms?: number }
        /** A Nickname (CORD-04 §10), dated `ms`; another member's cites the Grant it acts under. */
        | { type: "nickname"; target: string; nick: string; ms?: number; authority?: AuthorityCitation }
        /** A Timeout (CORD-04 §8) running to `until` (unix seconds); a past one lifts. */
        | { type: "timeout"; target: string; until: number; ms?: number; authority?: AuthorityCitation },
    ) => {
      if (!user || !community) throw new Error(t({ id: "useGuestbook.notReady", defaultMessage: "Not ready." }));
      // A dissolved community honors no new authority action (CORD-02 §9); a Leave
      // is self-signed housekeeping and stays allowed.
      if (dissolvedNow != null && (action.type === "kick" || action.type === "timeout" || (action.type === "nickname" && action.target !== user.pubkey))) {
        throw new Error(t({ id: "useGuestbook.dissolved", defaultMessage: "This community has been dissolved; it accepts no new moderation." }));
      }
      const group = currentGuestbookGroup(community);
      const ms = (action.type === "kick" || action.type === "nickname" || action.type === "timeout") && action.ms !== undefined ? action.ms : clockNowMs();
      const rumor =
        action.type === "join"
          ? buildJoinRumor(user.pubkey, ms, action.attribution)
          : action.type === "leave"
            ? buildLeaveRumor(user.pubkey, ms)
            : action.type === "nickname"
              ? buildNicknameRumor(user.pubkey, action.target, action.nick, ms, action.authority)
              : action.type === "timeout"
                ? buildTimeoutRumor(user.pubkey, action.target, action.until, ms, action.authority)
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
