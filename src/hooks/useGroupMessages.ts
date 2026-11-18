import { useNostr } from "@nostrify/react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { useSendStatusMap } from "@/hooks/useSendStatusMap";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import {
  NIP29_PAGE_SIZE,
  NIP29_TIMELINE_KINDS,
  nip29PullFull,
  nip29SyncTopic,
  setNip29SyncContext,
} from "@/lib/nip29Sync";
import { KIND_GROUP_ADMINS, parseGroupAdmins } from "@/lib/nip29";
import { isSigned } from "@/lib/nostrRumor";
import { STORE_READ } from "@/lib/storeQuery";
import { nip29SnapshotScope, readTimelineSnapshot } from "@/lib/timelineSnapshot";
import { useSyncTopic } from "@/sync/useSyncTopic";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { shareById } from "@/lib/shareRows";

const KIND_DELETE = 5;

/** Pubkeys in the newest 39001 this relay served, as `useGroup` reads the roster. */
function groupAdmins(lists: NostrRumor[]): Set<string> {
  const newest = lists.reduce<NostrRumor | undefined>(
    (a, b) => (!a || b.created_at > a.created_at ? b : a),
    undefined,
  );
  return new Set(newest ? parseGroupAdmins(newest).map((a) => a.pubkey) : []);
}

/**
 * NIP-09 honours a kind 5 only from the target's author. Group admins' kind-5s are
 * honoured too (the NIP-29 way is a 9005, which the relay applies by dropping the
 * event); any other member's kind 5 is ignored, or it would hide others' messages.
 */
export function withoutDeleted(
  events: NostrRumor[],
  deletes: NostrRumor[],
  admins: ReadonlySet<string>,
): NostrRumor[] {
  const deleters = new Map<string, Set<string>>();
  for (const d of deletes) {
    for (const [n, v] of d.tags) {
      if (n !== "e" || !v) continue;
      let set = deleters.get(v);
      if (!set) deleters.set(v, (set = new Set()));
      set.add(d.pubkey);
    }
  }
  if (deleters.size === 0) return events;
  return events.filter((e) => {
    const by = deleters.get(e.id);
    return !by || !(by.has(e.pubkey) || [...by].some((pk) => admins.has(pk)));
  });
}

/**
 * Max gap (seconds, 6h) before the oldest message is treated as a stale-relay outlier rather
 * than a cursor. Mirrors Ditto's `getPaginationCursor`.
 */
const MAX_GAP_SECONDS = 6 * 60 * 60;

function messagesKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "messages", relayUrl, groupId] as const;
}

function statusKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "msg-status", relayUrl, groupId] as const;
}

export interface GroupMessageFocus {
  messageId?: string;
  threadRoot?: string;
}

/**
 * Sort ascending and dedupe by id; later wins, except a signed copy is never replaced by an
 * unsigned one — the store drops `sig`, and retrying a send needs the signature.
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

/**
 * `until` cursor: oldest `created_at - 1`, or the second-oldest when the oldest is a gap
 * outlier (stale relay). Mirrors Ditto.
 */
function paginationCursor(events: NostrRumor[]): number | undefined {
  if (events.length === 0) return undefined;
  const ascending = [...events].sort((a, b) => a.created_at - b.created_at);
  const oldest = ascending[0].created_at;
  const next = ascending[1]?.created_at;
  if (next !== undefined && next - oldest > MAX_GAP_SECONDS) {
    return next - 1;
  }
  return oldest - 1;
}

/**
 * Chat messages (kind 9) and polls (kind 1068) for a NIP-29 group, read from the store.
 * Holds NO sockets: the wire ingests and rings `nip29:<groupId>`; newest-page top-up is the sync
 * scheduler's `nip29:` topic (`nip29Sync.ts`). The hook only paginates on scroll-up.
 * Optimistic sends share the relay echo's id, so dedupe is automatic.
 */
export function useGroupMessages(
  relayUrl: string | undefined,
  groupId: string | undefined,
  focus?: GroupMessageFocus,
) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const focusIds = useMemo(
    () => [...new Set([focus?.threadRoot, focus?.messageId].filter((id): id is string => Boolean(id)))],
    [focus?.threadRoot, focus?.messageId],
  );
  const focusSig = focusIds.join(",");

  // `hasMore` is false once a page comes back short.
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  // localStorage snapshot: a read cache for the first cold-launch frame, never an ingest source.
  const snapshotScope = relayUrl && groupId ? nip29SnapshotScope(relayUrl, groupId) : undefined;

  useEffect(() => {
    setHasMore(true);
    cursorRef.current = undefined;
  }, [relayUrl, groupId]);

  // The scheduler owns newest-page top-up; the relay is part of the topic key. The context
  // effect is declared BEFORE the want so a round never starts without it.
  const syncTopic = relayUrl && groupId ? nip29SyncTopic(relayUrl, groupId) : undefined;
  useEffect(() => {
    if (!syncTopic) return;
    return setNip29SyncContext(syncTopic, { nostr });
  }, [syncTopic, nostr]);
  const sync = useSyncTopic(syncTopic);

  const query = useQuery<NostrRumor[]>({
    // Pure store read: no retry ladder holding the skeleton.
    ...STORE_READ,
    queryKey: messagesKey(relayUrl, groupId),
    // Keyed: older pages shift every index (see shareRows).
    structuralSharing: shareById,
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      // A queryFn return overwrites, so fold in older pages and optimistic sends.
      const existing = queryClient.getQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId)) ?? [];

      // Scoped to THIS relay's tenant: the same group id elsewhere is an unrelated channel.
      const [cached, deletes, adminLists] = await Promise.all([
        store.query(
          [{ kinds: NIP29_TIMELINE_KINDS, "#h": [groupId!], limit: Math.max(NIP29_PAGE_SIZE, existing.length) }],
          { relay: relayUrl },
        ),
        // The store self-applies same-author NIP-09; admins' kind-5s are applied here.
        store.query([{ kinds: [KIND_DELETE], "#h": [groupId!], limit: 200 }], { relay: relayUrl }),
        store.query([{ kinds: [KIND_GROUP_ADMINS], "#d": [groupId!] }], { relay: relayUrl }),
      ]);
      const local = withoutDeleted(sortDedupe([...existing, ...cached]), deletes, groupAdmins(adminLists));

      // No network here; `hasMore` reflects the last scheduler round's page fullness.
      const full = syncTopic ? nip29PullFull(syncTopic) : undefined;
      if (full !== undefined && !signal.aborted) setHasMore(full);

      // Seed the cursor from local history so backfill works before any pull lands.
      if (cursorRef.current === undefined && local.length > 0) {
        cursorRef.current = paginationCursor(local);
      }
      return local;
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 10_000,
    // Seed from the synchronous localStorage snapshot to skip the IndexedDB cold-open;
    // `initialDataUpdatedAt: 0` keeps it stale so the store read still runs.
    initialData: () => {
      const snap = readTimelineSnapshot<NostrRumor>(snapshotScope);
      // Only events carrying THIS group's `h` tag.
      const own = snap?.filter((e) => e.tags.some(([t, v]) => t === "h" && v === groupId));
      return own && own.length > 0 ? own : undefined;
    },
    initialDataUpdatedAt: 0,
    // No refetch timers: the scheduler re-runs the pull. Keep the previous data only when the
    // previous query's key is THIS room (a ref would already point at the new room on re-render).
    placeholderData: (prev, prevQuery) =>
      prevQuery && hashKey(prevQuery.queryKey) === hashKey(messagesKey(relayUrl, groupId))
        ? prev
        : undefined,
  });

  // Resolve route ids (far-back search hits, a notified thread's root) from the relay tenant,
  // kept outside the query cache so a lone old hit can't drag the pagination cursor.
  const focusQuery = useQuery<NostrRumor[]>({
    ...STORE_READ,
    queryKey: ["nip29", "message-focus", relayUrl, groupId, focusSig],
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      return store.query(
        [{ ids: focusIds, kinds: NIP29_TIMELINE_KINDS, "#h": [groupId!], limit: focusIds.length }],
        { relay: relayUrl, signal },
      );
    },
    enabled: Boolean(relayUrl && groupId && focusIds.length > 0),
    staleTime: Infinity,
  });

  // Not part of `isLoading`: a dead relay must not hold the timeline's skeleton.
  const missingSig = focusQuery.data
    ? focusIds.filter((id) => !focusQuery.data.some((e) => e.id === id)).join(",")
    : "";
  const focusFetch = useQuery<NostrRumor[]>({
    queryKey: ["nip29", "message-focus-fetch", relayUrl, groupId, missingSig],
    queryFn: ({ signal }) => {
      const ids = missingSig.split(",");
      return nostr.relay(relayUrl!).query(
        [{ ids, kinds: NIP29_TIMELINE_KINDS, "#h": [groupId!], limit: ids.length }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
    },
    enabled: Boolean(relayUrl && groupId && missingSig),
    staleTime: Infinity,
    retry: false,
  });

  const focusedData = useMemo(
    () => sortDedupe([...(query.data ?? []), ...(focusQuery.data ?? []), ...(focusFetch.data ?? [])]),
    [query.data, focusQuery.data, focusFetch.data],
  );

  useWireScopes((scopes) => {
    if (groupId && scopes.has(`nip29:${groupId}`)) {
      void queryClient.invalidateQueries({ queryKey: messagesKey(relayUrl, groupId) });
    }
  });

  // Shared with Concord via useSendStatusMap.
  const { status, setStatus } = useSendStatusMap(statusKey(relayUrl, groupId));

  useTimelineSnapshotWriter(snapshotScope, query.data, !query.isPlaceholderData);

  const upsertMessage = useCallback(
    (event: NostrEvent) => {
      queryClient.setQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId), (old = []) => {
        if (old.some((e) => e.id === event.id)) return old;
        return sortDedupe([...old, event]);
      });
    },
    [queryClient, relayUrl, groupId],
  );

  /** Resolves to the number of prepended messages so the caller can preserve scroll. */
  const loadOlder = useCallback(async (): Promise<number> => {
    if (!relayUrl || !groupId) return 0;
    if (loadingRef.current || !hasMore) return 0;
    const until = cursorRef.current;
    if (until === undefined) return 0;

    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const older = await nostr.relay(relayUrl).query(
        [{ kinds: NIP29_TIMELINE_KINDS, "#h": [groupId], until, limit: NIP29_PAGE_SIZE }],
        { signal: AbortSignal.timeout(8000) },
      );

      // The cursor boundary can re-return events.
      const existing = queryClient.getQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId)) ?? [];
      const existingIds = new Set(existing.map((e) => e.id));
      const fresh = older.filter((e) => !existingIds.has(e.id));

      if (older.length < NIP29_PAGE_SIZE) setHasMore(false);
      // From the raw page (pre-dedupe) so an all-overlap page still moves back.
      cursorRef.current = paginationCursor(older) ?? until - 1;

      if (fresh.length === 0) return 0;

      queryClient.setQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId), (old = []) =>
        sortDedupe([...fresh, ...old]),
      );
      return fresh.length;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [nostr, relayUrl, groupId, hasMore, queryClient]);

  const insertOptimistic = useCallback(
    (event: NostrEvent) => {
      upsertMessage(event);
      setStatus(event.id, "pending");
    },
    [upsertMessage, setStatus],
  );

  const markSent = useCallback((id: string) => setStatus(id, undefined), [setStatus]);

  const markFailed = useCallback((id: string) => setStatus(id, "failed"), [setStatus]);

  const removeOptimistic = useCallback(
    (id: string) => {
      queryClient.setQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId), (old = []) =>
        old.filter((e) => e.id !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, relayUrl, groupId, setStatus],
  );

  const helpers = useMemo(
    () => ({
      status,
      insertOptimistic,
      markSent,
      markFailed,
      removeOptimistic,
      loadOlder,
      hasMore,
      isLoadingOlder,
    }),
    [status, insertOptimistic, markSent, markFailed, removeOptimistic, loadOlder, hasMore, isLoadingOlder],
  );

  // An empty store isn't authoritative for NIP-29 until the first newest-page pull settles;
  // settled/errored/fresh topics release the gate.
  const isLoading =
    query.isLoading ||
    (focusIds.length > 0 && focusQuery.isLoading) ||
    ((query.data?.length ?? 0) === 0 && sync.status === "pending");

  return { ...query, ...helpers, data: focusedData, isLoading };
}
