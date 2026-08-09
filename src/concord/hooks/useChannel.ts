import { useNostr } from "@nostrify/react";
import { hashKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { citationFor, dissolvedAt, useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { persistTimelineSnapshot, prewarmTimelineSnapshot } from "@/concord/hooks/timelineSnapshot";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSendStatusMap, useSendStatusMapValue, type SendStatusMap } from "@/hooks/useSendStatusMap";
import {
  buildConcordCommentTags,
  filterEpochCutoff,
  foldTimeline,
  forgetChatSkips,
  openChatBatch,
  type ChatModeration,
  type FoldedTimeline,
  type OpenedChat,
} from "@/concord/lib/chat";
import { backfillStore, LOAD_OLDER_MAX_PAGES, setChannelSyncContext } from "@/concord/lib/channelSync";
import { KIND_COMMENT, KIND_DELETE, KIND_MESSAGE, KIND_POLL, KIND_REACTION, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import {
  clearChannelExhausted,
  queryChannelFirstSeen,
  queryChannelRumors,
  readChannelCursor,
  sweepExpiredCommunityRumors,
  updateChannelCursor,
  writeRumors,
  peekPendingWraps,
  ackPendingWraps,
} from "@/concord/lib/rumorStore";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  rememberQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { citationToTag, type AuthorityCitation } from "@/concord/lib/edition";
import { citationSatisfied } from "@/concord/lib/control";
import { useActivePause } from "@/concord/hooks/usePause";
import { canActOnMember, isAuthorized, isStaff, Permissions } from "@/concord/lib/roles";
import { chatExpiresAt, messageExpirationOf } from "@/concord/lib/disappearing";
import { consumeSend, isRateLimitedKind, SendRateLimitError } from "@/concord/lib/sendRateLimit";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Channel, Community } from "@/concord/lib/types";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { logSync, sinceMs } from "@/lib/syncLog";
import { STORE_READ } from "@/lib/storeQuery";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import { invalidateSyncTopic } from "@/sync/syncManager";
import { useSyncTopic } from "@/sync/useSyncTopic";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";
import { channelWriteGroup } from "@/concord/lib/community";

/** Query key for a channel's RAW opened-event set (all chat-plane kinds). */
export const channelKey = (channelIdHex: string | null) => ["concord", "channel", channelIdHex] as const;
const statusKey = (channelIdHex: string | null) => ["concord", "msg-status", channelIdHex] as const;
const deletedKey = (channelIdHex: string | null) => ["concord", "msg-deleted", channelIdHex] as const;

/**
 * Every chat-plane kind rides an identical kind-1059 wrap, so the relay can't
 * pre-filter messages from reactions — the decode window must absorb both.
 * Sized accordingly; the rumor cache serves re-reads with no decrypt.
 */
const WINDOW_SIZE = 100;

/**
 * How far back the flood detector's channel-history read looks, and its row cap
 * (see `queryChannelFirstSeen`).
 *
 * A time window rather than a row count, because what the detector needs is the
 * QUIET before a flood, and a row count spends itself on the flood. Seven days
 * so a weekend-quiet channel still has its regulars on the map when a Monday
 * flood arrives; the cap then bounds the cost on a genuinely busy channel,
 * where losing the map's oldest end costs a protection, never grants immunity.
 */
const FLOOD_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FLOOD_HISTORY_MAX_ROWS = 4000;

const EMPTY_RAW: OpenedChat[] = [];

/** Upsert opened events into the raw set, deduped by rumor id, sorted by ms. */
export function upsertOpenedChat(old: OpenedChat[] | undefined, incoming: OpenedChat[]): OpenedChat[] {
  const byId = new Map<string, OpenedChat>();
  for (const m of old ?? []) byId.set(m.rumorId, m);
  let changed = false;
  for (const m of incoming) {
    if (!byId.has(m.rumorId)) {
      byId.set(m.rumorId, m);
      changed = true;
    }
  }
  if (!changed && old) return old;
  return [...byId.values()].sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.rumorId < b.rumorId ? -1 : 1));
}

/** Local shorthand. */
const upsert = upsertOpenedChat;

/** The moderation context resolved from the community's control fold. */
export function useChatModeration(community: Community | undefined): ChatModeration {
  const { data: folded } = useControlFold(community);
  const { data: dissolvedAtMs } = useDissolved(community);
  return useMemo(
    () => ({
      banned: folded?.banned ?? new Set<string>(),
      canDelete: (deleter: string, author: string, action?: { citation?: AuthorityCitation; ms: number }) => {
        if (!folded || !community) return false;
        // Death wins every race (CORD-02 §9), but it is an ORDERING rule, not a
        // switch: the fold replays history, so a global "is dissolved" test
        // would retroactively un-hide every moderation delete this community
        // ever honored, including ones published years before the tombstone.
        // Only actions published AFTER the tombstone are refused. The seal
        // leaves SELF-deletes open regardless; they short-circuit in the fold
        // before reaching here.
        if (dissolvedAtMs !== null && dissolvedAtMs !== undefined && action && action.ms > dissolvedAtMs) {
          return false;
        }
        // Authorization, resolved against the CURRENT roster. The citation is a
        // completeness floor and never a grant of rank, so a since-demoted actor
        // is refused here no matter what they cited (CORD-04 §5).
        if (!canActOnMember(folded.roster, deleter, folded.ownerHex, author, Permissions.MANAGE_MESSAGES)) {
          return false;
        }
        // …then the sync floor: have we read enough of their Grant to trust the
        // verdict above? Uncited means we have not, so the delete parks.
        return citationSatisfied(folded, community.id, deleter, action?.citation);
      },
      // A timer notice is believed only from a MANAGE_METADATA holder
      // (CORD-08 §4). False until the fold lands: an unverifiable notice is
      // hidden, never trusted on faith.
      canSetTimer: (author: string) =>
        Boolean(folded && isAuthorized(folded.roster, author, folded.ownerHex, Permissions.MANAGE_METADATA)),
      isStaff: (author: string) => Boolean(folded && isStaff(folded.roster, author, folded.ownerHex)),
    }),
    [folded, community, dissolvedAtMs],
  );
}

/**
 * One channel's timeline: the RAW opened-event set (messages, reactions,
 * edits, deletes — all sharing the wrap kind) read local-first from the
 * decrypted rumor cache, refreshed by a live subscription plus a resumable
 * relay backfill, then folded (with moderation) in memory.
 *
 * Wraps are never persisted: incoming kind-1059 wraps are decrypted once and
 * the recovered rumors are written to the rumor store, which the timeline reads
 * back with an ordinary `{ kinds, "#channel" }` query and no decrypt. A
 * per-channel sync cursor (persisted in the folded cache) lets a cold launch
 * resume where it left off instead of re-paging the newest window.
 *
 * LOCAL-FIRST IS THE LOADING CONTRACT. The queryFn resolves on the store read
 * and returns; the park drain and every relay pass run behind that return and
 * repaint through `setQueryData` as they land. So `isLoading` — the caller's
 * skeleton — covers the ArmadaDB read alone, and network catch-up is reported
 * on the sync-activity signal instead. Holding the skeleton until a relay
 * round settled meant a conversation whose entire history was already on disk
 * still opened on a placeholder for as long as the relays took.
 */
export function useChannelTimeline(
  community: Community | undefined,
  channel: Channel | undefined,
  /**
   * The channel id the CALLER already knows (the URL names it on the first
   * render), so the persisted last-painted window can seed the cache before
   * the key-derivation chain produces a {@link Channel}. Only ever used for
   * the cache key and the snapshot; the query stays disabled until `channel`.
   */
  routeChannelIdHex?: string | null,
) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const moderation = useChatModeration(community);
  // Only so the flood heuristic can leave the reader's own messages alone.
  const { user: readingUser } = useCurrentUser();
  // The community's active pause (CORD-04 §8), so the fold collapses non-staff
  // messages posted while it holds — the read side of the pause signal. Via
  // `useActivePause`, which schedules the `until` expiry: without the wake, a
  // bounded pause would keep collapsing long after it lapsed, since nothing
  // else re-renders this timeline on its behalf.
  // Only the enactment time enters the fold, and taking it as a scalar keeps
  // the memo from re-running on every render — `activePause` builds a fresh
  // object each time, so depending on the pause itself would defeat it.
  const pauseSince = useActivePause(community)?.since;

  const channelIdHex = channel?.idHex ?? routeChannelIdHex ?? null;
  // Cutoffs ride the signature too: a merge can teach this device an epoch's
  // retirement without changing the epoch set, and the store must re-read.
  const epochSig = channel?.streams.map((s) => `${s.epoch}:${s.retiredAt ?? ""}`).join(",") ?? "";
  const queryKey = channelKey(channelIdHex);

  // Seed the cache from the persisted last-painted window the moment the
  // channel id is known — before the fold chain resolves a Channel — so a
  // warm reload paints messages instead of a skeleton. Stale-seeded, so the
  // real store read still runs and replaces it (see timelineSnapshot).
  useEffect(() => {
    if (channelIdHex) void prewarmTimelineSnapshot(queryClient, channelIdHex, channelKey(channelIdHex));
  }, [channelIdHex, queryClient]);

  // Physically purge expired disappearing messages (CORD-08 §3). Hiding them
  // is the read filter's job; the plaintext leaving the store is this one's.
  // Fire-and-forget — the sweep self-gates to one walk per community per
  // interval, so channel switches never re-scan.
  useEffect(() => {
    if (community?.idHex) void sweepExpiredCommunityRumors(community.idHex).catch(() => undefined);
  }, [community?.idHex]);

  const windowLimitRef = useRef(WINDOW_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  useEffect(() => {
    windowLimitRef.current = WINDOW_SIZE;
    setHasMore(true);
    setIsLoadingOlder(false);
  }, [channelIdHex]);

  // A caught-up rekey changes the held stream set: forget remembered decode
  // failures, clear the exhaustion flag and force a sync round (a new stream
  // key may unlock history a fresh stamp would skip), and re-read.
  useEffect(() => {
    if (!channelIdHex) return;
    forgetChatSkips();
    void clearChannelExhausted(channelIdHex);
    invalidateSyncTopic(`c2:${channelIdHex}`);
    queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // The catch-up pull (cold opens, offline gaps, deep history) is owned by
  // the sync scheduler: this view registers the context a `c2:` round needs
  // (pool handle, community relays, stream keys), then declares standing
  // interest in the topic. Freshness is a durable stamp, so switching back to
  // a recently-synced channel is a pure store read — the per-mount throttle
  // this replaces re-paged every relay on every switch. The context effect is
  // declared BEFORE the want, so a round never starts without it.
  useEffect(() => {
    if (!community || !channel) return;
    return setChannelSyncContext(channel.idHex, { nostr, community, channel });
  }, [nostr, community, channel]);
  useSyncTopic(community && channel ? `c2:${channel.idHex}` : undefined);

  // Live updates come from the wire: WireSync holds the standing kind-1059
  // subscription for EVERY channel, decrypts with our stream keys, writes the
  // rumor store, and announces `c2:<idHex>` on the bus. We just re-read.
  // (Relay catch-up lives behind the sync scheduler, so a bus invalidation is
  // a cheap local read, not a network round.)
  //
  // `c2park:<streamPk>` covers the wire's blind spot: a wrap for one of OUR
  // stream addresses that the wire couldn't decrypt (its spec hadn't refreshed
  // past a rekey yet) is parked, not stored — re-reading drains the park via
  // the queryFn's peekPendingWraps pass, so the message paints now instead of
  // after the next poll.
  useWireScopes((scopes) => {
    if (!channelIdHex) return;
    const mine =
      scopes.has(`c2:${channelIdHex}`) ||
      (channel?.streams.some((s) => scopes.has(`c2park:${s.group.pk}`)) ?? false);
    if (mine) {
      void queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    }
  });

  const query = useQuery<OpenedChat[]>({
    queryKey,
    // The queryFn resolves on the ArmadaDB read (see its comment), so this is a
    // store read and takes the store-read policy: no pausing while the browser
    // claims to be offline, no backoff ladder held at `isPending` — both of
    // which this query's `isLoading` is a skeleton over.
    ...STORE_READ,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Keep the previous render's messages painted ONLY when they belong to
    // THIS channel (the previous query has the same key), never the outgoing
    // channel's timeline during a switch. Decided from the previous query's
    // own key (race-free), NOT a ref updated by an effect: this inline closure
    // defeats TanStack's placeholder memoization, so it re-runs on EVERY
    // render while the new channel's first read is pending, and a ref would
    // already point at the new channel by the second render.
    placeholderData: (prev, prevQuery) =>
      prevQuery && hashKey(prevQuery.queryKey) === hashKey(queryKey) ? prev : undefined,
    // No refetch timer: live messages arrive over the wire's standing
    // subscription, and periodic catch-up/healing is the sync scheduler's
    // (its staleness interval re-runs the `c2:` round while this view holds
    // its want, and every store write rings the bus back into this query).
    queryFn: async ({ signal }) => {
      const cursorKeyId = channelIdHex ?? "";

      // Fold in any wraps the native service parked (it can't decrypt) so a
      // notification's message lands from this read. Runs AFTER the store
      // paint, not serially before it: the peek opens a second IndexedDB
      // database and, with wraps parked, decrypts a notification batch —
      // ahead of the store read that used to tax every channel-switch paint.
      // writeRumors rings the bus once the drained rumors commit, so the
      // timeline re-reads and paints them right after. Decode WITHOUT the
      // query's abort signal (the batch is notification-sized) and acknowledge
      // only what actually decoded — an interrupted or key-less decode leaves
      // the wraps parked for the next read instead of destroying them.
      const drainParked = async () => {
        const parked = await peekPendingWraps(channel!.streams.map((s) => s.group.pk));
        if (parked.length === 0) return;
        const opened = await openChatBatch(parked, channel!);
        // ACK only once the rumors are actually stored. The ack DELETES the
        // parked wrap, so acking over a failed write destroys the only copy of
        // a message the user was already notified about.
        if (!(await writeRumors(community!.idHex, opened))) return;
        const openedWrapIds = new Set(opened.map((o) => o.wrapId));
        ackPendingWraps(parked.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
      };

      const composeFromStore = async (extra?: OpenedChat[]): Promise<OpenedChat[]> => {
        // hasMore: the local rumor window is full OR relays may have more
        // (the persisted cursor — the scheduler's round writes it — isn't
        // exhausted). Read alongside the rumors, not serially.
        const [rumors, saved] = await Promise.all([
          queryChannelRumors(community!.idHex, channelIdHex!, {
            limit: windowLimitRef.current,
            signal,
          }),
          readChannelCursor(cursorKeyId),
        ]);
        setHasMore(rumors.length >= windowLimitRef.current || !saved?.exhausted);
        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        // Fold in freshly-decrypted events directly rather than racing the
        // fire-and-forget rumor write. The epoch-cutoff filter re-applies the
        // ingest rule to rows persisted before the rotation was known locally.
        return filterEpochCutoff(upsert(prev, extra ? upsert(rumors, extra) : rumors), channel!);
      };

      const existing = queryClient.getQueryData<OpenedChat[]>(queryKey);

      // No relay round starts here: the scheduler owns the `c2:` catch-up
      // (wanted above), so a wire-bus invalidation is a cheap local re-read,
      // never a network round. The round's writes ring the bus back into this
      // queryFn, and its progress surfaces on the sync-activity signal and
      // the topic's sync state — never on `isLoading`.

      if (existing && existing.length > 0) {
        // Warm: paint what we have; heal in the background.
        void (async () => {
          if (signal.aborted) return;
          queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore());
          await drainParked();
        })().catch(() => undefined);
        return existing;
      }

      // The store read is the whole of the first load. An empty result is NOT
      // authoritative for Concord — history is decrypted by the scheduler's
      // backfill, not the wire's live `since` window — but that is a SYNC
      // state, not a loading one: the park drain runs behind this return, the
      // relay round runs in the scheduler, and both repaint through the bus
      // as they land.
      const local = await composeFromStore();
      void drainParked().catch(() => undefined);
      return local;
    },
  });

  // Keep the persisted window current. Content-compared inside, so repaint
  // churn does not rewrite it.
  useEffect(() => {
    if (channelIdHex && query.data && query.data.length > 0) {
      void persistTimelineSnapshot(channelIdHex, query.data);
    }
  }, [channelIdHex, query.data]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!hasMore || isLoadingOlder) return 0;
    const before = query.data?.filter((m) => m.kind === KIND_MESSAGE || m.kind === KIND_POLL).length ?? 0;
    const cursorKeyId = channelIdHex ?? "";
    setIsLoadingOlder(true);
    try {
      // If the rumor cache still has more than the current window, just widen
      // the window (a re-read, no network, no decrypt). Otherwise the cache is
      // exhausted, so page deeper history from the relays directly.
      const inCache = await queryChannelRumors(community!.idHex, channelIdHex!, {
        limit: windowLimitRef.current + 1,
      });
      const localHasMore = inCache.length > windowLimitRef.current;

      windowLimitRef.current += WINDOW_SIZE;

      const saved = localHasMore ? undefined : await readChannelCursor(cursorKeyId);
      if (!localHasMore && !saved?.exhausted) {
        const controller = new AbortController();
        const older = await backfillStore(nostr, community!.relays, channel!, controller.signal, {
          until: saved?.oldest,
          maxPages: LOAD_OLDER_MAX_PAGES,
        });
        const opened = await openChatBatch(older.events, channel!);
        writeRumors(community!.idHex, opened);

        // Deep-history paging never touches `newest` (that's the scheduler
        // round's bridge job); the persisted merge is monotonic (`oldest`
        // only recedes, `exhausted` sticky) and serialized per scope inside
        // `updateStreamCursor`, so a scheduler round writing the same cursor
        // concurrently merges with this rather than reading around it.
        void updateChannelCursor(cursorKeyId, {
          oldest: older.oldest,
          exhausted: older.exhausted ? true : undefined,
        });

        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        queryClient.setQueryData<OpenedChat[]>(queryKey, upsert(prev, opened));
      }

      const result = await query.refetch();
      const after = result.data?.filter((m) => m.kind === KIND_MESSAGE || m.kind === KIND_POLL).length ?? 0;
      return Math.max(0, after - before);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasMore, isLoadingOlder, query, nostr, community, channel, channelIdHex, queryClient, queryKey]);

  // The folded view (moderation + edits + reaction tallies), plus the
  // optimistic-delete overlay.
  const optimisticDeleted = useQuery<string[]>({
    queryKey: deletedKey(channelIdHex),
    // This query is never fetched — the overlay is populated imperatively via
    // setQueryData in deleteMessage. The no-op queryFn only exists to satisfy
    // React Query's "no queryFn" dev warning; enabled:false keeps it from running.
    queryFn: () => [],
    enabled: false,
    initialData: [],
  }).data;

  // Who was already in this CHANNEL, which the rendered window cannot say: a
  // flood large enough to matter fills `WINDOW_SIZE` completely and every
  // author in it then reads as new-together (see `queryChannelFirstSeen`).
  // One indexed range read per channel open. It does NOT need to chase the
  // flood live — new arrivals are dated by the batch itself, and an author's
  // first-seen only ever moves earlier — but a slow refresh keeps a long
  // session's map from aging out entirely.
  const firstSeen = useQuery({
    ...STORE_READ,
    queryKey: ["concord-channel-first-seen", community?.idHex ?? null, channelIdHex],
    queryFn: ({ signal }) =>
      queryChannelFirstSeen(community!.idHex, channelIdHex!, {
        sinceMs: Date.now() - FLOOD_HISTORY_WINDOW_MS,
        limit: FLOOD_HISTORY_MAX_ROWS,
        signal,
      }),
    enabled: !!community?.idHex && !!channelIdHex,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  }).data;

  // Re-fold when the persisted quarantine warms or grows (see quarantineMemory.ts).
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  // A lower bound on when this room existed, for the drown rule's precedent
  // (see FloodOptions.establishedSinceMs) — what lets a TOTAL nuke fold, whose
  // every early speaker is itself a drowner so the speaker source is empty.
  // Two sources, oldest wins:
  //   1. The oldest control-plane rotation time we hold (`HeldRoot.retiredAt`,
  //      epoch-seconds → ms). Unforgeable — only a staff rekey publishes one —
  //      but often absent (never-rekeyed community, or roots retired before the
  //      field existed).
  //   2. The earliest channel activity the STORE has observed (min over the
  //      7-day `firstSeen` map). Always available once history loads; a channel
  //      that already had messages this long ago is not launching now. It is
  //      chat-plane-derived, so best-effort: a flood can push it EARLIER (which
  //      only adds precedent), and evading needs every message's `created_at`
  //      clamped into one sub-10-min window — which collapses the wave's own
  //      timespan the pace gate reads. Preferred source is (1) when present.
  const establishedSinceMs = useMemo(() => {
    let oldest: number | undefined;
    for (const r of community?.heldRoots ?? []) {
      if (typeof r.retiredAt === "number") {
        const ms = r.retiredAt * 1000;
        if (oldest === undefined || ms < oldest) oldest = ms;
      }
    }
    if (firstSeen) for (const ms of firstSeen.values()) if (oldest === undefined || ms < oldest) oldest = ms;
    return oldest;
  }, [community?.heldRoots, firstSeen]);

  const folded: FoldedTimeline = useMemo(() => {
    void memoryRev;
    const result = foldTimeline(query.data ?? [], moderation, {
      ...(readingUser?.pubkey !== undefined ? { self: readingUser.pubkey } : {}),
      ...(firstSeen ? { firstSeen } : {}),
      ...(establishedSinceMs !== undefined ? { establishedSinceMs } : {}),
      ...(pauseSince !== undefined ? { pauseSince } : {}),
    });
    // What past sessions remember folding here. The live rules re-derive from
    // whatever context this session holds, and after a refresh that is only
    // the newest window — the memory is what keeps yesterday's wall folded.
    const remembered = community?.idHex && channelIdHex
      ? recallQuarantined(community.idHex, channelIdHex)
      : undefined;
    let quarantined = result.quarantined;
    if (remembered) {
      quarantined = new Set(quarantined);
      for (const id of remembered) quarantined.add(id);
      // A remembered verdict can predate the roster (or come from the badge
      // path, which folds without one), so re-assert staff/self immunity over
      // the merged set: a moderator's — or the reader's own — message must
      // never be in the rendered quarantine, whatever a past session stored.
      // (The fold already cleared them; this covers only the recall merge.)
      const immune = (a: string) => a === readingUser?.pubkey || Boolean(moderation?.isStaff?.(a));
      for (const m of result.messages) if (quarantined.has(m.rumorId) && immune(m.author)) quarantined.delete(m.rumorId);
    }
    const merged = quarantined === result.quarantined ? result : { ...result, quarantined };
    if (optimisticDeleted && optimisticDeleted.length > 0) {
      const hidden = new Set(optimisticDeleted);
      return { ...merged, messages: merged.messages.filter((m) => !hidden.has(m.rumorId)) };
    }
    return merged;
  }, [query.data, moderation, optimisticDeleted, readingUser?.pubkey, firstSeen, establishedSinceMs, pauseSince, community?.idHex, channelIdHex, memoryRev]);

  // Remember what this fold decided (merge-only), so the verdict survives the
  // session even when its evidence — history, arrival order, the wave around
  // a message — won't be reloaded by the next one.
  //
  // PAUSE-collapsed ids are excluded, and the distinction is the whole reason
  // the fold reports them separately. The memory exists for verdicts whose
  // evidence won't come back; a pause's evidence is its folded head, which is
  // always there and correctly STOPS applying the moment the pause lifts.
  // Storing them here would make a transient directive permanent — the memory
  // is merge-only and outlives the lift, so ordinary messages would stay
  // collapsed forever, which is the "MUST NOT drop" of CORD-04 §8 reached by
  // a slower route.
  useEffect(() => {
    if (!community?.idHex || !channelIdHex || folded.quarantined.size === 0) return;
    const entries: Array<[string, number]> = [];
    for (const m of query.data ?? []) {
      if (folded.quarantined.has(m.rumorId) && !folded.paused.has(m.rumorId)) entries.push([m.rumorId, m.ms]);
    }
    if (entries.length > 0) rememberQuarantined(community.idHex, channelIdHex, entries);
  }, [folded.quarantined, folded.paused, query.data, community?.idHex, channelIdHex]);

  return {
    /** The folded, moderated timeline + reaction tallies. */
    folded,
    /**
     * The RAW opened rows, pre-fold. The fold consumes Edits, deletes and
     * reactions into their targets, so they exist nowhere else — and a Pin
     * needs the Edit rumor itself to prove a revision (CORD-04 §7).
     */
    raw: query.data ?? EMPTY_RAW,
    // Loading skeleton gate: the LOCAL read, and nothing else. `isPending` is
    // true from the moment the query mounts until its queryFn resolves, and
    // that queryFn resolves on the rumor-store read — so a channel whose
    // history is already in ArmadaDB paints as soon as IndexedDB answers,
    // rather than sitting behind a relay round it doesn't need. Everything
    // after that read (park drain, backfill, gap bridge) is network catch-up
    // and surfaces as sync activity (`beginSyncTask` → SyncStatusIndicator and
    // the timeline's `syncing` affordance), not as a loading state.
    //
    // Gated on `channel` so a query that is merely DISABLED (the community's
    // channels haven't folded yet, or never will) reads as not-loading instead
    // of hanging on a skeleton forever — `isPending` alone stays true for a
    // disabled query.
    isLoading: Boolean(channel) && query.isPending,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Send one chat-plane rumor: build (with the channel/epoch binding),
 * optimistically insert IMMEDIATELY, then sign the seal with the user's real
 * identity (a remote round-trip for NIP-46 logins), wrap under the CURRENT
 * epoch's stream key, and broadcast fire-and-forget. No pending spinner
 * the message is treated as sent the moment it renders —
 * clearing a spinner on the full broadcast meant awaiting every relay's OK,
 * so one dead relay held it for the whole publish timeout. A sign OR
 * broadcast failure marks the message "failed" (retry/discard) — it never
 * silently vanishes.
 */
export function useSendMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));
  // The community's disappearing-messages timer (CORD-08), read from the
  // folded metadata at send time. A fold that hasn't landed reads as OFF —
  // the tag as signed governs, so a client behind the head simply sends what
  // it last knew, exactly the mixed-client behavior the CORD specifies.
  const { data: folded } = useControlFold(community);
  const timerSecs = messageExpirationOf(folded?.metadata);

  const broadcast = useCallback(
    async (wrap: NostrEvent) => {
      // Budget scaled to the signer: an auth-gating relay can demand a NIP-42
      // sign (a bunker round-trip for NIP-46 logins) inside this await (#51).
      const timeout = publishTimeoutMs(user?.method);
      const started = Date.now();
      const results = await Promise.allSettled(
        community!.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(timeout) })),
      );
      results.forEach((r, i) => {
        logSync(
          "send",
          `wrap ${wrap.id.slice(0, 8)} → ${community!.relays[i]}: ${r.status === "fulfilled" ? "accepted" : `FAILED (${r.reason instanceof Error ? r.reason.message : r.reason})`} in ${sinceMs(started)}`,
        );
      });
      if (!results.some((r) => r.status === "fulfilled")) throw new Error("No relay accepted the message.");
    },
    [nostr, community, user?.method],
  );

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_MESSAGE,
      replyTo,
      target,
      targetKind,
      targetPubkey,
      extraTags,
      ms,
      bypassRateLimit,
    }: {
      content: string;
      /** 9 message (default), 7 reaction, 5 delete, 3302 edit, 1111 thread reply. */
      kind?: number;
      /**
       * Thread parent. Present ⇒ this rumor is a NIP-22 kind-1111 comment, tagged
       * with `K`/`E`/`P` (root) + `k`/`e`/`p` (parent) by {@link buildConcordCommentTags}
       * — NOT a kind-9 `q` (that's reserved for inline quote-replies, NIP-C7).
       */
      replyTo?: { id: string; kind: number; pubkey: string; tags: string[][] };
      /** `e`-target for reactions / deletes / edits. */
      target?: string;
      /** Kind of the `e`-target for deletes (NIP-09 `k` tag); defaults to message. */
      targetKind?: number;
      /**
       * Author of the `e`-target, for a NIP-25 `p` tag on reactions. Lives on
       * the NIP-44-encrypted rumor (never the wrap), so it leaks nothing to the
       * relay while making the reacted-to author recoverable to channel members.
       */
      targetPubkey?: string;
      /** Extra rumor tags appended verbatim (NIP-30 emoji, NIP-92 imeta, …). */
      extraTags?: string[][];
      /**
       * Override the rumor's millisecond timestamp (e.g. an edit republishes
       * with the original's `ms` so it keeps its place in the timeline).
       * Defaults to the current time.
       */
      ms?: number;
      /**
       * Skip the community send budget. Set by `retry`: re-sending a message a
       * relay hiccup already failed is recovery, not new content, and a burst
       * of failures must not spend the budget its own repair needs.
       */
      bypassRateLimit?: boolean;
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");
      // Death is one-way (CORD-02 §9). Gated at the PUBLISH, not just in the
      // UI: `canWrite` is derived from a query that is undefined on its first
      // tick, so a composer can be live for a moment before the verdict lands.
      // This read is local and sticky — once dissolved, never writable again.
      if ((await dissolvedAt(community.idHex)) !== undefined) {
        throw new Error("This community has been dissolved; it accepts no new messages.");
      }

      // A threaded reply is a NIP-22 comment (kind 1111), not a kind-9 message.
      const effectiveKind = replyTo ? KIND_COMMENT : kind;
      // Client-side spam speed bump, per community. Refused BEFORE the
      // optimistic insert and the seal, so a blocked send leaves nothing in the
      // timeline or the store to reconcile. The composer runs the same check
      // (without spending) before it clears itself, so this throw is the
      // backstop for the paths that don't — polls, thread replies, bots.
      if (!bypassRateLimit && isRateLimitedKind(effectiveKind)) {
        const waitMs = consumeSend(community.idHex);
        if (waitMs > 0) throw new SendRateLimitError(waitMs);
      }
      const effectiveMs = ms ?? Date.now();
      const tags: string[][] = [...channelBindingTags(channel.idHex, channel.current.epoch)];
      if (replyTo) tags.push(...buildConcordCommentTags(replyTo));
      if (target) tags.push(["e", target]);
      // NIP-25: a reaction SHOULD carry a `p` for the reacted-to author. Safe
      // in Concord — the tag lives on the NIP-44-encrypted rumor, never the wrap.
      if (kind === KIND_REACTION && targetPubkey) tags.push(["p", targetPubkey]);
      if (kind === KIND_DELETE && target) tags.push(["k", String(targetKind ?? KIND_MESSAGE)]);
      if (extraTags) tags.push(...extraTags);
      // CORD-08 §2: while the timer is set, every durable chat rumor except
      // deletes (and timer notices) commits its NIP-40 deadline — send time
      // plus the timer — inside the signed rumor; the wrap repeats it below so
      // relays purge the ciphertext too.
      const expiresAt = chatExpiresAt(effectiveKind, effectiveMs, timerSecs);
      if (expiresAt !== undefined) tags.push(["expiration", String(expiresAt)]);

      const rumor: NostrRumor = buildRumor({ kind: effectiveKind, content, tags, pubkey: user.pubkey, ms: effectiveMs });
      // The message renders IMMEDIATELY — before the seal, which for a
      // NIP-46 login is a remote round-trip that can take seconds — and with
      // NO pending spinner: the broadcast is near-instant in
      // reality, and gating the spinner on the full broadcast meant one dead
      // relay held it for the whole publish timeout. A message the user typed
      // must never silently vanish: sign or broadcast failure flips it to
      // "failed" (retry/discard affordance) instead of eating it.
      const isVisible = effectiveKind === KIND_MESSAGE || effectiveKind === KIND_COMMENT || effectiveKind === KIND_POLL;
      const opened: OpenedChat = {
        rumorId: rumor.id,
        author: user.pubkey,
        kind: effectiveKind,
        content,
        tags,
        ms: effectiveMs,
        createdAt: rumor.created_at,
        // Placeholders until sealed — the entry is re-upserted (same rumorId)
        // with the real seal/wrap below, and is NOT persisted before that.
        wrapId: "",
        streamPk: channel.current.group.pk,
        sealKind: KIND_SEAL_ENCRYPTED,
        seal: {
          id: "",
          pubkey: user.pubkey,
          kind: KIND_SEAL_ENCRYPTED,
          content: "",
          tags: [],
          created_at: rumor.created_at,
          sig: "",
        },
        channelIdHex: channel.idHex,
        epoch: channel.current.epoch,
      };
      if (isVisible) {
        queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [opened]));
      }

      logSync("send", `sealing rumor ${rumor.id.slice(0, 8)} (kind ${effectiveKind}) — signer: ${user.method}`);
      const sealStarted = Date.now();
      let seal: NostrEvent;
      try {
        seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      } catch (err) {
        logSync("send", `sealing ${rumor.id.slice(0, 8)} FAILED in ${sinceMs(sealStarted)}: ${err instanceof Error ? err.message : String(err)}`);
        if (isVisible) {
          // The message stays in the timeline as failed — retryable.
          setStatus(rumor.id, "failed");
          return { rumorId: rumor.id, wrap: undefined };
        }
        throw err; // reactions/edits/deletes: callers own the rollback
      }
      logSync("send", `sealed ${rumor.id.slice(0, 8)} in ${sinceMs(sealStarted)} — wrapping + broadcasting to ${community.relays.length} relay(s)`);
      const wrap = wrapSeal(seal, channelWriteGroup(channel), expiresAt !== undefined ? { expiration: expiresAt } : undefined);

      // The wrap is authored by the channel stream key rather than the user,
      // so identify this exact relay event as local before its push can arrive.
      await markOwnWebPushEvent(wrap.id);

      const sealed: OpenedChat = { ...opened, seal, wrapId: wrap.id, streamPk: wrap.pubkey };
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [sealed]));
      // Persist to the rumor cache so a refresh mid-flight keeps the message
      // (and a self-delete removes its target via the store's NIP-09).
      writeRumors(community.idHex, [sealed]);

      void broadcast(wrap).catch(() => {
        if (isVisible) setStatus(rumor.id, "failed");
      });

      return { rumorId: rumor.id, wrap: wrap as NostrEvent | undefined };
    },
  });
}

/** Retry / discard a failed optimistic message, and optimistic self-delete. */
export function useMessageActions(community: Community | undefined, channel: Channel | undefined) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // The fold supplies this actor's own Grant head, which a moderation delete
  // cites (CORD-04 §5).
  const { data: folded } = useControlFold(community);
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));
  const { mutateAsync: send } = useSendMessage(community, channel);

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const raw = queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? [];
      const msg = raw.find((m) => m.rumorId === id);
      if (!msg) return;
      // Re-send as a fresh rumor (a new id); drop the failed original. A
      // threaded reply (kind-1111 comment) carries its NIP-22 thread pointers in
      // its own tags, so preserve them verbatim (minus the channel binding,
      // which `send` re-adds) rather than rebuilding from a parent event.
      const isComment = msg.kind === KIND_COMMENT;
      // Also strip the failed attempt's `expiration` — the re-send computes a
      // fresh one from its own send time, and duplicating the tag would make
      // the binding ambiguous.
      const threadTags = isComment
        ? msg.tags.filter(([n]) => n !== "channel" && n !== "epoch" && n !== "expiration")
        : undefined;
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      setStatus(id, undefined);
      void send({
        content: msg.content,
        kind: msg.kind,
        extraTags: threadTags,
        // Repairing a failed send is not new content; a relay outage that
        // failed a burst must not also exhaust the budget for retrying it.
        bypassRateLimit: true,
      }).catch(() => undefined);
    },
    [user, community, channel, channelIdHex, queryClient, setStatus, send],
  );

  const discard = useCallback(
    (id: string) => {
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, channelIdHex, setStatus],
  );

  /** Optimistic delete: hide now, publish the kind-5 in the background. */
  const deleteMessage = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      // A delete of someone ELSE's message is an authority action, so it cites
      // the Grant it acts under (CORD-04 §5) — without it a peer whose roster is
      // one sweep stale cannot tell a moderator from a demoted one, and refuses
      // the delete. A self-delete is not an authority action and never cites.
      const target = (queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? [])
        .find((m) => m.rumorId === id);
      const moderating = Boolean(target && target.author !== user.pubkey);
      const citation = moderating ? citationFor(community, folded, user.pubkey) : undefined;
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );
      void send({
        content: "",
        kind: KIND_DELETE,
        target: id,
        extraTags: citation ? [citationToTag(citation)] : undefined,
      }).catch(() => {
        // Couldn't publish the delete — unhide so the user knows.
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) => old.filter((d) => d !== id));
      });
    },
    [user, community, channel, channelIdHex, queryClient, send, folded],
  );

  return { retry, discard, deleteMessage };
}

/** The optimistic send-status map for a channel. */
export function useSendStatus(channel: Channel | undefined): SendStatusMap {
  return useSendStatusMapValue(statusKey(channel?.idHex ?? null));
}
