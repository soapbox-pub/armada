import { useNostr } from "@nostrify/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSendStatusMap, useSendStatusMapValue, type SendStatusMap } from "@/hooks/useSendStatusMap";
import {
  foldTimeline,
  forgetChatSkips,
  openChatBatch,
  type ChatModeration,
  type FoldedTimeline,
  type OpenedChat,
} from "@/concord-v2/lib/chat";
import { KIND_DELETE, KIND_MESSAGE, KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord-v2/lib/kinds";
import {
  clearChannelExhausted,
  queryChannelRumors,
  readChannelCursor,
  updateChannelCursor,
  writeRumors,
  peekPendingWraps,
  ackPendingWraps,
  onWrapsParked,
} from "@/concord-v2/lib/rumorStore";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, type Rumor } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Query key for a channel's RAW opened-event set (all chat-plane kinds). */
const channelKey = (channelIdHex: string | null) => ["concord2", "channel", channelIdHex] as const;
const statusKey = (channelIdHex: string | null) => ["concord2", "msg-status", channelIdHex] as const;
const deletedKey = (channelIdHex: string | null) => ["concord2", "msg-deleted", channelIdHex] as const;

/**
 * Every chat-plane kind rides an identical kind-1059 wrap, so the relay can't
 * pre-filter messages from reactions — the decode window must absorb both.
 * Sized above V1's 30 accordingly; the rumor cache serves re-reads with no decrypt.
 */
const WINDOW_SIZE = 100;
/** Relay backfill page size. */
const BACKFILL_PAGE = 50;
/** EOSE race grace once the fastest relay returns a page. */
const BACKFILL_EOSE_GRACE_MS = 500;
/**
 * Older-history pages walked back-to-back on a cold load. The passes chain
 * without waiting for the 60s poll, so deep history fills promptly rather than
 * one ~300-event chunk per minute. Bounded so a huge channel can't page relays
 * forever in one go — the saved cursor resumes any remainder on later polls or
 * on an explicit `loadOlder`.
 */
const BACKFILL_MAX_PAGES = 20;
/** Pages per `loadOlder` scroll-up when the local store is exhausted. */
const LOAD_OLDER_MAX_PAGES = 6;

function channelFilter(channel: ChannelV2, extra?: Partial<NostrFilter>): NostrFilter {
  return { kinds: [KIND_WRAP], authors: channel.streams.map((s) => s.group.pk), ...extra };
}

/** Upsert opened events into the raw set, deduped by rumor id, sorted by ms. */
function upsert(old: OpenedChat[] | undefined, incoming: OpenedChat[]): OpenedChat[] {
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

/**
 * Backfill wraps from the relays with `until` pagination and per-relay cursors
 * (a relay ignoring `until` is culled after one non-progressing page). Returns
 * the oldest and newest `created_at` seen, every raw wrap collected across the
 * passes (so the caller can decrypt them into the rumor cache directly),
 * whether history is exhausted (no relay had a full page left to page past),
 * and whether any relay FAILED (error/abort) — a failed relay's events may be
 * missing, so failure must never be recorded as exhaustion and must block
 * cursor advancement past the failed region.
 *
 * `since` bounds a pass from below (the bridge pass uses it to fetch exactly
 * the region between the saved cursor and the newest page).
 *
 * The kind-1059 wraps these reads return are NEVER mirrored into the shared
 * `armada-events` store — `NostrBatcher.cacheEvents` drops all gift-wrap kinds
 * unconditionally. Only the decrypted rumors are persisted (see rumorStore.ts).
 */
async function backfillStore(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  channel: ChannelV2,
  signal: AbortSignal,
  opts: { until?: number; since?: number; maxPages?: number } = {},
): Promise<{ oldest?: number; newest?: number; events: NostrEvent[]; exhausted: boolean; failed: boolean }> {
  const maxPages = opts.maxPages ?? BACKFILL_MAX_PAGES;
  let oldest: number | undefined;
  let newest: number | undefined;
  let active = relays.map((url) => ({ url, cursor: opts.until }));
  const collected: NostrEvent[] = [];
  let failed = false;

  for (let page = 0; page < maxPages && active.length > 0; page++) {
    if (signal.aborted) break;
    const pageController = new AbortController();
    const pageSignal = AbortSignal.any([signal, pageController.signal]);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const armGrace = () => {
      graceTimer ??= setTimeout(() => pageController.abort(), BACKFILL_EOSE_GRACE_MS);
    };

    const results = await Promise.all(
      active.map(async (relay) => {
        const filter = channelFilter(channel, { limit: BACKFILL_PAGE });
        if (relay.cursor !== undefined) filter.until = relay.cursor;
        if (opts.since !== undefined) filter.since = opts.since;
        try {
          const events = await nostr
            .relay(relay.url)
            .query([filter], {
              signal: AbortSignal.any([pageSignal, AbortSignal.timeout(8000)]),
            });
          // Only a relay that actually HAS events may start the race clock. An
          // instant empty EOSE (e.g. a relay that stores no wraps) must never
          // abort relays still mid-answer — cold NIP-42 AUTH costs extra
          // round-trips, and losing that race silently drops their messages
          // (issue #19: the platform relay answered empty in ~0ms and starved
          // the real community relays on every cold open).
          if (events.length > 0) armGrace();
          return { relay, events, ok: true };
        } catch {
          return { relay, events: [] as NostrEvent[], ok: false };
        }
      }),
    );
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    const next: typeof active = [];
    for (const { relay, events, ok } of results) {
      if (!ok) {
        // Error or aborted — this relay's region was NOT read. Track the
        // failure (blocks exhaustion/cursor advancement) and drop it for this
        // run; a later poll retries it.
        failed = true;
        continue;
      }
      collected.push(...events);
      let relayOldest = Infinity;
      let progressed = 0;
      for (const ev of events) {
        if (newest === undefined || ev.created_at > newest) newest = ev.created_at;
        if (relay.cursor === undefined || ev.created_at < relay.cursor) {
          progressed += 1;
          if (ev.created_at < relayOldest) relayOldest = ev.created_at;
        }
      }
      if (Number.isFinite(relayOldest)) {
        if (oldest === undefined || relayOldest < oldest) oldest = relayOldest;
      }
      if (progressed > 0 && events.length >= BACKFILL_PAGE && relayOldest > 0) {
        next.push({ url: relay.url, cursor: relayOldest - 1 });
      }
    }
    active = next;
  }
  return { oldest, newest, events: collected, exhausted: active.length === 0 && !failed, failed };
}

/** The moderation context resolved from the community's control fold. */
export function useChatModeration2(community: CommunityV2 | undefined): ChatModeration {
  const { data: folded } = useControlFold2(community);
  return useMemo(
    () => ({
      banned: folded?.banned ?? new Set<string>(),
      canDelete: (deleter: string, author: string) =>
        Boolean(
          folded &&
            canActOnMember(folded.roster, deleter, folded.ownerHex, author, Permissions.MANAGE_MESSAGES),
        ),
    }),
    [folded],
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
 */
export function useChannelTimeline2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const moderation = useChatModeration2(community);

  const channelIdHex = channel?.idHex ?? null;
  const epochSig = channel?.streams.map((s) => s.epoch.toString()).join(",") ?? "";
  const queryKey = channelKey(channelIdHex);

  const windowLimitRef = useRef(WINDOW_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // In-memory mirror of the persisted per-channel cursor (created_at bounds +
  // exhausted flag), loaded on channel change and written through on progress.
  // `newest` is the top of CONTIGUOUSLY-synced history: it only advances when
  // a backfill's bridge pass has verifiably fetched everything between the old
  // `newest` and the newest page (see backfillAndRefresh), so a hole can never
  // be sealed over.
  const cursor = useRef<Map<string, { newest?: number; oldest?: number; exhausted: boolean }>>(new Map());
  const initialLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    windowLimitRef.current = WINDOW_SIZE;
    setHasMore(true);
    setIsLoadingOlder(false);
    initialLoadedRef.current = null;
    // Hydrate the in-memory cursor from the persisted one for this channel.
    if (channelIdHex) {
      void readChannelCursor(channelIdHex).then((c) => {
        if (c) cursor.current.set(channelIdHex, { newest: c.newest, oldest: c.oldest, exhausted: c.exhausted });
      });
    }
  }, [channelIdHex]);

  // A caught-up rekey changes the held stream set: forget remembered decode
  // failures, clear the exhaustion flag (a new stream key may unlock history),
  // and re-read.
  useEffect(() => {
    if (!channelIdHex) return;
    forgetChatSkips();
    const c = cursor.current.get(channelIdHex);
    if (c) c.exhausted = false;
    void clearChannelExhausted(channelIdHex);
    queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // Live subscription: new wraps land the moment a relay forwards them. The
  // decrypted rumors are written to the rumor cache and the newest cursor
  // advances so a later cold launch resumes from here.
  useEffect(() => {
    if (!community || !channel || !channelIdHex) return;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    const pending: NostrEvent[] = [];
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const isReady = () =>
      initialLoadedRef.current === channelIdHex ||
      (queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0;

    const fold = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      const opened = await openChatBatch(events, channel);
      if (opened.length === 0) return;
      writeRumors(opened);
      // A decoded wrap's rumor is now safely stored; clear any parked copy of
      // it (native delivery parks every wrap) so the next cold read doesn't
      // re-decode it. No-op for wraps that were never parked.
      ackPendingWraps(opened.map((m) => m.wrapId));
      // NOTE: live events do NOT advance the persisted `newest` cursor — that
      // would seal over any not-yet-bridged offline gap below them. Only a
      // completed backfill bridge advances `newest` (see backfillAndRefresh).
      queryClient.setQueryData<OpenedChat[]>(queryKey, (old) => upsert(old, opened));
      // Clear optimistic pending/failed for anything echoed back.
      queryClient.setQueryData<SendStatusMap>(statusKey(channelIdHex), (s = {}) => {
        let touched = false;
        const next = { ...s };
        for (const m of opened) {
          if (m.rumorId in next) {
            delete next[m.rumorId];
            touched = true;
          }
        }
        return touched ? next : s;
      });
    };

    const apply = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      if (!isReady()) {
        // Buffer until the initial store read resolves, so a live message
        // can't paint a lonely single row over the loading skeleton.
        pending.push(...events);
        readyTimer ??= setInterval(() => {
          if (controller.signal.aborted) {
            clearInterval(readyTimer);
            readyTimer = undefined;
            return;
          }
          if (isReady()) {
            clearInterval(readyTimer);
            readyTimer = undefined;
            void fold(pending.splice(0, pending.length));
          }
        }, 100);
        return;
      }
      await fold(events);
    };

    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req([channelFilter(channel, { since })], {
            signal: controller.signal,
          })) {
            if (msg[0] === "EVENT") await apply([msg[2] as NostrEvent]);
          }
        } catch {
          // Subscription ended — the poll covers gaps.
        }
      })();
    }

    // Live fold for natively-delivered wraps. On Android the background
    // service receives wraps over its own sockets and feeds them through
    // useNativeEventFeed → parkPendingWraps — including exactly when the
    // WebView's relay subscriptions above are down (backgrounded app, silent
    // reconnect). Folding them here the moment they're parked is V2's
    // equivalent of V1's `concordMessage` bridge; without it the message a
    // notification announced didn't render until a cold read or the 60s poll.
    const streamPks = new Set(channel.streams.map((s) => s.group.pk));
    const offParked = onWrapsParked((wraps) => {
      const mine = wraps.filter((w) => streamPks.has(w.pubkey));
      if (mine.length > 0) void apply(mine);
    });

    return () => {
      controller.abort();
      offParked();
      if (readyTimer !== undefined) clearInterval(readyTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community, channelIdHex, epochSig, queryClient]);

  const query = useQuery<OpenedChat[]>({
    queryKey,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const cursorKeyId = channelIdHex ?? "";

      // Fold in any wraps the native service parked (it can't decrypt) so a
      // notification's message is present on cold read. Decode WITHOUT the
      // query's abort signal (the batch is notification-sized) and acknowledge
      // only what actually decoded — an interrupted or key-less decode leaves
      // the wraps parked for the next read instead of destroying them.
      const parked = await peekPendingWraps(channel!.streams.map((s) => s.group.pk));
      if (parked.length > 0) {
        const opened = await openChatBatch(parked, channel!);
        writeRumors(opened);
        const openedWrapIds = new Set(opened.map((o) => o.wrapId));
        ackPendingWraps(parked.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
      }

      // hasMore is true if the local rumor window is full OR relays may have more.
      const refreshHasMore = (localFull: boolean) => {
        setHasMore(localFull || !cursor.current.get(cursorKeyId)?.exhausted);
      };

      const composeFromStore = async (extra?: OpenedChat[]): Promise<OpenedChat[]> => {
        const rumors = await queryChannelRumors(channelIdHex!, {
          limit: windowLimitRef.current,
          signal,
        });
        refreshHasMore(rumors.length >= windowLimitRef.current);
        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        // Fold in freshly-decrypted events directly rather than racing the
        // fire-and-forget rumor write.
        return upsert(prev, extra ? upsert(rumors, extra) : rumors);
      };

      const backfillAndRefresh = async () => {
        if (signal.aborted) return;
        // Pass 1: pull the newest page (no `until`) so live-adjacent history
        // lands first.
        const newest = await backfillStore(nostr, community!.relays, channel!, signal, { maxPages: 1 });
        if (signal.aborted) return;

        const saved = cursor.current.get(cursorKeyId);

        // Pass 2 (the bridge): fetch the REGION BETWEEN the saved `newest` and
        // pass 1's oldest. Without it, an offline burst larger than one page
        // leaves a permanent hole — pass 3 resumes BELOW already-seen history
        // and the advanced cursor seals the gap forever (issue #19).
        let bridge: Awaited<ReturnType<typeof backfillStore>> = {
          events: [],
          exhausted: true,
          failed: false,
        };
        if (saved?.newest && newest.oldest !== undefined && newest.oldest > saved.newest) {
          bridge = await backfillStore(nostr, community!.relays, channel!, signal, {
            until: newest.oldest - 1,
            since: saved.newest,
          });
          if (signal.aborted) return;
        }

        // Pass 3: page OLDER history back-to-back. Resume from the saved
        // cursor if we have one; otherwise (cold channel) resume from just
        // below pass 1's newest page rather than re-fetching that page.
        const resumeFrom = saved?.oldest ?? (newest.oldest !== undefined ? newest.oldest - 1 : undefined);
        const older = await backfillStore(nostr, community!.relays, channel!, signal, { until: resumeFrom });
        if (signal.aborted) return;

        // Decrypt every wrap collected across the passes into the rumor cache.
        const opened = await openChatBatch(
          [...newest.events, ...bridge.events, ...older.events],
          channel!,
          { signal },
        );
        writeRumors(opened);

        // Advance the persisted cursor: `oldest` back, `exhausted` sticky, and
        // `newest` forward ONLY when the newest region is verifiably complete —
        // pass 1 had no relay failures and the bridge ran to exhaustion. An
        // incomplete round leaves `newest` where it was, so the next poll
        // re-bridges the same region instead of sealing a hole.
        const c = cursor.current.get(cursorKeyId) ?? { exhausted: false };
        if (older.oldest !== undefined && (c.oldest === undefined || older.oldest < c.oldest)) {
          c.oldest = older.oldest;
        }
        if (older.exhausted) c.exhausted = true;
        const complete = !newest.failed && bridge.exhausted;
        if (complete) {
          const top = Math.max(newest.newest ?? 0, bridge.newest ?? 0, c.newest ?? 0);
          if (top > 0) c.newest = top;
        }
        cursor.current.set(cursorKeyId, c);
        void updateChannelCursor(cursorKeyId, {
          newest: complete ? c.newest : undefined,
          oldest: c.oldest,
          exhausted: c.exhausted,
        });

        queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore(opened));
      };

      const existing = queryClient.getQueryData<OpenedChat[]>(queryKey);
      if (existing && existing.length > 0) {
        // Warm: paint what we have; heal in the background.
        initialLoadedRef.current = channelIdHex;
        void (async () => {
          if (signal.aborted) return;
          queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore());
          await backfillAndRefresh();
        })().catch(() => undefined);
        return existing;
      }

      const local = await composeFromStore();
      initialLoadedRef.current = channelIdHex;
      void backfillAndRefresh().catch(() => undefined);
      return local;
    },
  });

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!hasMore || isLoadingOlder) return 0;
    const before = query.data?.filter((m) => m.kind === KIND_MESSAGE).length ?? 0;
    const cursorKeyId = channelIdHex ?? "";
    setIsLoadingOlder(true);
    try {
      // If the rumor cache still has more than the current window, just widen
      // the window (a re-read, no network, no decrypt). Otherwise the cache is
      // exhausted, so page deeper history from the relays directly.
      const inCache = await queryChannelRumors(channelIdHex!, { limit: windowLimitRef.current + 1 });
      const localHasMore = inCache.length > windowLimitRef.current;

      windowLimitRef.current += WINDOW_SIZE;

      if (!localHasMore && !cursor.current.get(cursorKeyId)?.exhausted) {
        const controller = new AbortController();
        const resumeFrom = cursor.current.get(cursorKeyId)?.oldest;
        const older = await backfillStore(nostr, community!.relays, channel!, controller.signal, {
          until: resumeFrom,
          maxPages: LOAD_OLDER_MAX_PAGES,
        });
        const opened = await openChatBatch(older.events, channel!);
        writeRumors(opened);

        const c = cursor.current.get(cursorKeyId) ?? { exhausted: false };
        if (older.oldest !== undefined && (c.oldest === undefined || older.oldest < c.oldest)) {
          c.oldest = older.oldest;
        }
        if (older.exhausted) c.exhausted = true;
        cursor.current.set(cursorKeyId, c);
        // Deep-history paging never touches `newest` (that's the bridge's job).
        void updateChannelCursor(cursorKeyId, {
          oldest: c.oldest,
          exhausted: c.exhausted,
        });

        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        queryClient.setQueryData<OpenedChat[]>(queryKey, upsert(prev, opened));
      }

      const result = await query.refetch();
      const after = result.data?.filter((m) => m.kind === KIND_MESSAGE).length ?? 0;
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

  const folded: FoldedTimeline = useMemo(() => {
    const result = foldTimeline(query.data ?? [], moderation);
    if (optimisticDeleted && optimisticDeleted.length > 0) {
      const hidden = new Set(optimisticDeleted);
      return { ...result, messages: result.messages.filter((m) => !hidden.has(m.rumorId)) };
    }
    return result;
  }, [query.data, moderation, optimisticDeleted]);

  return {
    /** The folded, moderated timeline + reaction tallies. */
    folded,
    isLoading: query.isLoading,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Send one chat-plane rumor: build (with the channel/epoch binding), sign the
 * seal with the user's real identity, wrap under the CURRENT epoch's stream
 * key, optimistically insert, and broadcast fire-and-forget. Only a total
 * broadcast failure marks it failed (retryable).
 */
export function useSendMessage2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));

  const broadcast = useCallback(
    async (wrap: NostrEvent) => {
      const results = await Promise.allSettled(
        community!.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) throw new Error("No relay accepted the message.");
    },
    [nostr, community],
  );

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_MESSAGE,
      replyTo,
      target,
      extraTags,
    }: {
      content: string;
      /** 9 message (default), 7 reaction, 5 delete, 3302 edit. */
      kind?: number;
      /** Reply parent: `["q", id, "", author]` per NIP-C7. */
      replyTo?: { id: string; author: string };
      /** `e`-target for reactions / deletes / edits. */
      target?: string;
      /** Extra rumor tags appended verbatim (NIP-30 emoji, NIP-92 imeta, …). */
      extraTags?: string[][];
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");

      const ms = Date.now();
      const tags: string[][] = [...channelBindingTags(channel.idHex, channel.current.epoch)];
      if (replyTo) tags.push(["q", replyTo.id, "", replyTo.author]);
      if (target) tags.push(["e", target]);
      if (kind === KIND_DELETE && target) tags.push(["k", KIND_MESSAGE.toString()]);
      if (extraTags) tags.push(...extraTags);

      const rumor: Rumor = buildRumor({ kind, content, tags, pubkey: user.pubkey, ms });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = wrapSeal(seal, channel.current.group);

      // Optimistic insert (messages/edits render; reactions/deletes fold in).
      const opened: OpenedChat = {
        rumorId: rumor.id,
        author: user.pubkey,
        kind,
        content,
        tags,
        ms,
        createdAt: rumor.created_at,
        wrapId: wrap.id,
        streamPk: wrap.pubkey,
        sealKind: KIND_SEAL_ENCRYPTED,
        seal,
        channelIdHex: channel.idHex,
        epoch: channel.current.epoch,
      };
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [opened]));
      // Persist to the rumor cache so a refresh mid-flight keeps the message
      // (and a self-delete removes its target via the store's NIP-09).
      writeRumors([opened]);

      void broadcast(wrap).catch(() => {
        if (kind === KIND_MESSAGE) setStatus(rumor.id, "failed");
      });

      return { rumorId: rumor.id, wrap };
    },
  });
}

/** Retry / discard a failed optimistic message, and optimistic self-delete. */
export function useMessageActions2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));
  const { mutateAsync: send } = useSendMessage2(community, channel);

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const raw = queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? [];
      const msg = raw.find((m) => m.rumorId === id);
      if (!msg) return;
      setStatus(id, "pending");
      // Re-send as a fresh rumor (a new id); drop the failed original.
      const replyTag = msg.tags.find((t) => t[0] === "q");
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      setStatus(id, undefined);
      void send({
        content: msg.content,
        kind: msg.kind,
        replyTo: replyTag ? { id: replyTag[1], author: replyTag[3] ?? "" } : undefined,
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
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );
      void send({ content: "", kind: KIND_DELETE, target: id }).catch(() => {
        // Couldn't publish the delete — unhide so the user knows.
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) => old.filter((d) => d !== id));
      });
    },
    [user, community, channel, channelIdHex, queryClient, send],
  );

  return { retry, discard, deleteMessage };
}

/** The optimistic send-status map for a channel. */
export function useSendStatus2(channel: ChannelV2 | undefined): SendStatusMap {
  return useSendStatusMapValue(statusKey(channel?.idHex ?? null));
}
