import { useMemo } from "react";
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { queryRumorsByChannel } from "@/concord/lib/rumorStore";
import { useBootGateOpen } from "@/lib/bootGate";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";

import type { OpenedChat } from "@/concord/lib/chat";

/** Newest rumors read per channel; sized for thread reconstruction. */
const PER_CHANNEL = 200;

/**
 * The single shared read of a community's cached rumors, grouped by channel, for
 * the derived views that need only each channel's newest window (unread badges,
 * Threads) — one transaction instead of one per channel per view. Mentions
 * deliberately don't use it (see `useConcordMentions`).
 *
 * Keyed by the channel SET, not read state, so opening a channel never re-reads
 * the store; read-dependent bits are derived downstream.
 */
export function useCommunityRumors(
  communityIdHex: string | undefined,
  channelIds: string[],
): {
  byChannel: Map<string, OpenedChat[]>;
  isLoading: boolean;
} {
  const queryClient = useQueryClient();
  const bootGateOpen = useBootGateOpen();

  const channelSig = channelIds.join(",");
  const idSet = useMemo(() => new Set(channelIds), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryKey = useMemo(
    () => ["concord-community-rumors", communityIdHex ?? null, channelSig] as const,
    [communityIdHex, channelSig],
  );

  const { data, isLoading } = useQuery<Map<string, OpenedChat[]>>({
    ...STORE_READ,
    queryKey,
    queryFn: ({ signal }) =>
      queryRumorsByChannel(communityIdHex!, channelIds, { perChannel: PER_CHANNEL, signal }),
    // After first paint: every joined community's read at once queued the open channel's
    // own first read behind them, and these only feed badges and side views.
    enabled: bootGateOpen && !!communityIdHex && channelIds.length > 0,
    // No refetch interval: the wire bus is the complete live path (every community
    // rumor write rings `c2:<channel>`, pinned in rumorStore.test.ts) and is
    // mirrored across tabs over a BroadcastChannel. Polling here meant N periodic
    // full scans for power users.
    staleTime: Infinity,
  });

  // Re-scan ONLY the channels that changed and patch them into the cached map;
  // the bus coalesces a burst into one flush.
  useWireScopes((scopes) => {
    const changed: string[] = [];
    for (const s of scopes) {
      if (s.startsWith("c2:") && idSet.has(s.slice(3))) changed.push(s.slice(3));
    }
    if (changed.length === 0 || !communityIdHex) return;
    scheduleDelta(queryClient, queryKey, communityIdHex, changed);
  });

  return { byChannel: data ?? EMPTY, isLoading };
}

const EMPTY: Map<string, OpenedChat[]> = new Map();

/**
 * Delta reads pending this microtask, per query key. Every consumer mounts its
 * own copy of this hook and the bus rings them all at once; coalescing makes it
 * one store read and one cache replacement.
 */
const pendingDeltas = new Map<string, Set<string>>();

function scheduleDelta(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  communityIdHex: string,
  changed: string[],
): void {
  const key = hashKey(queryKey);
  const pending = pendingDeltas.get(key);
  if (pending) {
    for (const id of changed) pending.add(id);
    return;
  }
  const channels = new Set(changed);
  pendingDeltas.set(key, channels);
  queueMicrotask(() => {
    pendingDeltas.delete(key);
    const ids = [...channels];
    void queryRumorsByChannel(communityIdHex, ids, { perChannel: PER_CHANNEL })
      .then((delta) => {
        queryClient.setQueryData<Map<string, OpenedChat[]>>(queryKey, (old) => {
          // The pending initial full scan will include this delta's rows.
          if (!old) return undefined;
          let next: Map<string, OpenedChat[]> | undefined;
          for (const id of ids) {
            const rows = delta.get(id);
            const prev = old.get(id);
            // Unchanged rows keep the old arrays (and the old Map), so nothing re-renders.
            if (rows ? prev !== undefined && sameRows(prev, rows) : prev === undefined) continue;
            next ??= new Map(old);
            if (rows) next.set(id, rows);
            else next.delete(id);
          }
          return next ?? old;
        });
      })
      .catch(() => undefined);
  });
}

/** Same rumors, same order — rumors are immutable, so the id says it all. */
function sameRows(a: OpenedChat[], b: OpenedChat[]): boolean {
  return a.length === b.length && a.every((row, i) => row.rumorId === b[i].rumorId);
}
