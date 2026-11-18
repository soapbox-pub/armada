import { useNostr } from "@nostrify/react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BUZZ_AUX_KINDS,
  BUZZ_FORUM_CONTENT_KINDS,
  BUZZ_TIMELINE_CONTENT_KINDS,
  BUZZ_WORKFLOW_EXTRA_KINDS,
  KIND_FORUM_VOTE,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
} from "@/buzz/kinds";
import { foldBuzzTimeline, type BuzzFoldedTimeline } from "@/buzz/protocol";
import { useEventStore } from "@/hooks/useEventStore";
import { useSendStatusMap, type SendStatusMap } from "@/hooks/useSendStatusMap";
import { isSigned } from "@/lib/nostrRumor";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { shareById } from "@/lib/shareRows";

const PAGE_SIZE = 40;
/** Aux (edit/delete/vote) window fetched alongside each content read. */
const AUX_LIMIT = 300;
/** Minimum interval between relay top-up pulls for one room. */
const PULL_MIN_INTERVAL_MS = 30_000;
/** Stale-outlier gap guard for pagination cursors (mirrors useGroupMessages). */
const MAX_GAP_SECONDS = 6 * 60 * 60;

export type { SendStatus } from "@/hooks/useSendStatusMap";

export function buzzMessagesKey(relayUrl: string | undefined, channelId: string | undefined) {
  return ["buzz", "messages", relayUrl, channelId] as const;
}

function statusKey(relayUrl: string | undefined, channelId: string | undefined) {
  return ["buzz", "msg-status", relayUrl, channelId] as const;
}

/**
 * Sort ascending and de-dupe by id; later wins, except a signed copy is never
 * replaced by an unsigned one (the local store drops `sig`, which would break retry).
 */
function sortDedupe(events: NostrRumor[]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const e of events) {
    const prev = byId.get(e.id);
    if (prev && isSigned(prev) && !isSigned(e)) continue;
    byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function paginationCursor(events: NostrRumor[]): number | undefined {
  if (events.length === 0) return undefined;
  const ascending = [...events].sort((a, b) => a.created_at - b.created_at);
  const oldest = ascending[0].created_at;
  const next = ascending[1]?.created_at;
  if (next !== undefined && next - oldest > MAX_GAP_SECONDS) return next - 1;
  return oldest - 1;
}

export interface BuzzMessages extends BuzzFoldedTimeline {
  /** RAW (unfolded) events: content + aux mixed. */
  raw: NostrRumor[];
  isLoading: boolean;
  status: SendStatusMap;
  insertOptimistic: (event: NostrEvent) => void;
  markSent: (id: string) => void;
  markFailed: (id: string) => void;
  removeOptimistic: (id: string) => void;
  loadOlder: () => Promise<number>;
  hasMore: boolean;
  isLoadingOlder: boolean;
  replyCountFor: (id: string) => number;
  threadRepliesFor: (rootId: string) => NostrRumor[];
  /** Backfill a full thread by `#e` reference (called when a thread opens). */
  fetchThread: (rootId: string) => Promise<void>;
  mergeEvents: (events: NostrRumor[]) => void;
}

/**
 * A Buzz channel's message window: local-first store reads re-triggered by the
 * wire bus (`nip29:<channelId>` scope), throttled relay top-ups and scroll-up
 * pagination, folded per the Buzz protocol (see protocol.ts). `forum` switches
 * to 45001/45003 content and folds votes (45002).
 */
export function useBuzzMessages(
  relayUrl: string | undefined,
  channelId: string | undefined,
  opts?: { forum?: boolean; workflow?: boolean },
): BuzzMessages {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const forum = Boolean(opts?.forum);
  const workflow = Boolean(opts?.workflow);

  const contentKinds = useMemo<number[]>(
    () =>
      forum
        ? [...BUZZ_FORUM_CONTENT_KINDS]
        : workflow
          ? [...BUZZ_TIMELINE_CONTENT_KINDS, ...BUZZ_WORKFLOW_EXTRA_KINDS]
          : [...BUZZ_TIMELINE_CONTENT_KINDS],
    [forum, workflow],
  );
  const auxKinds = useMemo<number[]>(
    () =>
      forum
        ? [...BUZZ_AUX_KINDS, KIND_FORUM_VOTE]
        : [
            ...BUZZ_AUX_KINDS,
            KIND_HUDDLE_PARTICIPANT_JOINED,
            KIND_HUDDLE_PARTICIPANT_LEFT,
            KIND_HUDDLE_ENDED,
          ],
    [forum],
  );

  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);
  const lastPullRef = useRef(0);
  const [firstLoadDone, setFirstLoadDone] = useState(false);

  useEffect(() => {
    lastPullRef.current = 0;
    setHasMore(true);
    cursorRef.current = undefined;
    setFirstLoadDone(false);
  }, [relayUrl, channelId]);

  const queryKey = buzzMessagesKey(relayUrl, channelId);

  const query = useQuery<NostrRumor[]>({
    queryKey,
    // Keyed: older pages shift every index (see shareRows).
    structuralSharing: shareById,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const existing = queryClient.getQueryData<NostrRumor[]>(queryKey) ?? [];

      // Scoped to THIS relay: a channel id names nothing without its relay.
      const [content, aux] = await Promise.all([
        store.query(
          [{ kinds: contentKinds, "#h": [channelId!], limit: Math.max(PAGE_SIZE * 2, existing.length) }],
          { relay: relayUrl },
        ),
        store.query([{ kinds: auxKinds, "#h": [channelId!], limit: AUX_LIMIT }], { relay: relayUrl }),
      ]);
      const local = sortDedupe([...existing, ...content, ...aux]);

      // Throttled background top-up (never gates paint) for history the wire's
      // since-window missed.
      const now = Date.now();
      if (now - lastPullRef.current >= PULL_MIN_INTERVAL_MS) {
        lastPullRef.current = now;
        void (async () => {
          if (signal.aborted) return;
          try {
            const filters: NostrFilter[] = [
              { kinds: contentKinds, "#h": [channelId!], limit: PAGE_SIZE },
              { kinds: auxKinds, "#h": [channelId!], limit: AUX_LIMIT },
            ];
            const events = await nostr.relay(relayUrl!).query(filters, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            });
            const contentOnly = events.filter((e) => contentKinds.includes(e.kind));
            setHasMore(contentOnly.length >= PAGE_SIZE);
            const cursor = paginationCursor(contentOnly);
            if (cursor !== undefined && (cursorRef.current === undefined || cursor < cursorRef.current)) {
              cursorRef.current = cursor;
            }
            if (signal.aborted || events.length === 0) return;
            queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) =>
              sortDedupe([...old, ...events]),
            );
          } catch {
            // Best-effort; the store-hydrated result already rendered.
          } finally {
            if (!signal.aborted) setFirstLoadDone(true);
          }
        })();
      } else if (!signal.aborted) {
        setFirstLoadDone(true);
      }

      const localContent = local.filter((e) => contentKinds.includes(e.kind));
      if (cursorRef.current === undefined && localContent.length > 0) {
        cursorRef.current = paginationCursor(localContent);
      }
      if (localContent.length > 0 && !signal.aborted) setFirstLoadDone(true);
      return local;
    },
    enabled: Boolean(relayUrl && channelId),
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev, prevQuery) =>
      prevQuery && hashKey(prevQuery.queryKey) === hashKey([...queryKey]) ? prev : undefined,
  });

  // Buzz events carry `#h`, so they share the `nip29:<channelId>` scope (see wire/ingest.ts scopeOf).
  useWireScopes((scopes) => {
    if (channelId && scopes.has(`nip29:${channelId}`)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  const { status, setStatus } = useSendStatusMap(statusKey(relayUrl, channelId));

  const mergeEvents = useCallback(
    (events: NostrRumor[]) => {
      if (events.length === 0) return;
      queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => sortDedupe([...old, ...events]));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, relayUrl, channelId],
  );

  const insertOptimistic = useCallback(
    (event: NostrEvent) => {
      mergeEvents([event]);
      setStatus(event.id, "pending");
    },
    [mergeEvents, setStatus],
  );

  const markSent = useCallback((id: string) => setStatus(id, undefined), [setStatus]);
  const markFailed = useCallback((id: string) => setStatus(id, "failed"), [setStatus]);

  const removeOptimistic = useCallback(
    (id: string) => {
      queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => old.filter((e) => e.id !== id));
      setStatus(id, undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, relayUrl, channelId, setStatus],
  );

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!relayUrl || !channelId) return 0;
    if (loadingRef.current || !hasMore) return 0;
    const until = cursorRef.current;
    if (until === undefined) return 0;

    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const older = await nostr.relay(relayUrl).query(
        [
          { kinds: contentKinds, "#h": [channelId], until, limit: PAGE_SIZE },
          { kinds: auxKinds, "#h": [channelId], until, limit: AUX_LIMIT },
        ],
        { signal: AbortSignal.timeout(8000) },
      );
      const contentOnly = older.filter((e) => contentKinds.includes(e.kind));

      const existing = queryClient.getQueryData<NostrRumor[]>(queryKey) ?? [];
      const existingIds = new Set(existing.map((e) => e.id));
      const fresh = older.filter((e) => !existingIds.has(e.id));

      if (contentOnly.length < PAGE_SIZE) setHasMore(false);
      cursorRef.current = paginationCursor(contentOnly) ?? until - 1;

      if (fresh.length === 0) return 0;
      mergeEvents(fresh);
      // Only prepended CONTENT rows, so scroll restoration is accurate.
      return fresh.filter((e) => contentKinds.includes(e.kind)).length;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, relayUrl, channelId, hasMore, queryClient, mergeEvents, contentKinds, auxKinds]);

  /**
   * Marked `e` tags name the root, so a `#e` query returns the whole thread even
   * beyond the loaded `#h` window.
   */
  const fetchThread = useCallback(
    async (rootId: string) => {
      if (!relayUrl || !channelId) return;
      try {
        const events = await nostr.relay(relayUrl).query(
          [
            { kinds: contentKinds, "#e": [rootId], limit: 500 },
            { kinds: auxKinds, "#e": [rootId], limit: AUX_LIMIT },
          ],
          { signal: AbortSignal.timeout(8000) },
        );
        mergeEvents(events);
      } catch {
        // Best-effort; the window's replies still render.
      }
    },
    [nostr, relayUrl, channelId, mergeEvents, contentKinds, auxKinds],
  );

  const raw = useMemo(() => query.data ?? [], [query.data]);

  const folded = useMemo(() => foldBuzzTimeline(raw, contentKinds), [raw, contentKinds]);

  const replyCountFor = useCallback(
    (id: string) => folded.repliesByRoot.get(id)?.length ?? 0,
    [folded.repliesByRoot],
  );
  const threadRepliesFor = useCallback(
    (rootId: string): NostrRumor[] => folded.repliesByRoot.get(rootId) ?? EMPTY_EVENTS,
    [folded.repliesByRoot],
  );

  const isLoading =
    query.isLoading ||
    (folded.timeline.length === 0 && (query.isFetching || query.isFetched) && !firstLoadDone);

  return {
    ...folded,
    raw,
    isLoading,
    status,
    insertOptimistic,
    markSent,
    markFailed,
    removeOptimistic,
    loadOlder,
    hasMore,
    isLoadingOlder,
    replyCountFor,
    threadRepliesFor,
    fetchThread,
    mergeEvents,
  };
}

const EMPTY_EVENTS: NostrRumor[] = [];
