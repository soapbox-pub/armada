import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { stableZapsFor } from "@/components/chat/transport";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { KIND_ZAP_RECEIPT, tallyZaps, type ZapTally } from "@/lib/zaps";

import type { MessageZaps } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";

const zapsKey = (scope: string) => ["zaps", scope] as const;

/** Bucket receipts by their `e` tag (a receipt can carry only one). */
function groupReceiptsByTarget(receipts: NostrEvent[]): Map<string, NostrEvent[]> {
  const map = new Map<string, NostrEvent[]>();
  for (const receipt of receipts) {
    const target = receipt.tags.find((t) => t[0] === "e")?.[1];
    if (!target) continue;
    const bucket = map.get(target);
    if (bucket) bucket.push(receipt);
    else map.set(target, [receipt]);
  }
  return map;
}

/** Merge fresh receipts into the bucketed map, deduping by id. */
function mergeReceipts(
  old: Map<string, NostrEvent[]> | undefined,
  fresh: NostrEvent[],
): Map<string, NostrEvent[]> {
  const merged = new Map(old ?? []);
  for (const receipt of fresh) {
    const target = receipt.tags.find((t) => t[0] === "e")?.[1];
    if (!target) continue;
    const bucket = merged.get(target) ?? [];
    if (!bucket.some((r) => r.id === receipt.id)) {
      merged.set(target, [...bucket, receipt]);
    }
  }
  return merged;
}

/**
 * Load public NIP-57 zap receipts (kind 9735) for a whole timeline in ONE
 * batched `#e` query, mirroring {@link useGroupReactions}' structure exactly:
 * local-first store read, un-awaited pool refresh, one live subscription, and
 * per-id object caching so unchanged rows keep stable props.
 *
 * Receipts are queried from the POOL (app relays) rather than the group's host
 * relay: the 9734 zap request lists the app relays, so that's where providers
 * publish receipts (see useZap).
 */
export function useZapReceipts(
  scope: string | undefined,
  messageIds: string[],
): { zapsFor: (id: string) => MessageZaps | undefined } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const queryKey = zapsKey(scope ?? "");

  const idsSig = useMemo(() => [...messageIds].sort().join(","), [messageIds]);

  const receiptsQuery = useQuery<Map<string, NostrEvent[]>>({
    queryKey: [...queryKey, idsSig],
    queryFn: async ({ signal }) => {
      const ids = idsSig ? idsSig.split(",") : [];
      if (!scope || ids.length === 0) return new Map();
      const store = await eventStore;
      const limit = ids.length * 10;

      // 1. LOCAL-FIRST: mirrored receipts out of IndexedDB immediately.
      const cached = await store.query([{ kinds: [KIND_ZAP_RECEIPT], "#e": ids, limit }]);

      // 2. BACKGROUND refresh from the pool (NOT awaited — never gates render).
      void (async () => {
        if (signal.aborted) return;
        try {
          const fresh = await nostr.query(
            [{ kinds: [KIND_ZAP_RECEIPT], "#e": ids, limit }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          if (signal.aborted || fresh.length === 0) return;
          queryClient.setQueryData<Map<string, NostrEvent[]>>([...queryKey, idsSig], (old) =>
            mergeReceipts(old, fresh),
          );
        } catch {
          // Best-effort; the local-first result already rendered.
        }
      })();

      return groupReceiptsByTarget(cached);
    },
    enabled: Boolean(scope) && Boolean(idsSig),
    staleTime: 15_000,
  });

  // One live subscription for the whole window: a receipt appears the moment
  // the provider publishes it, so the ⚡ chip lands without a poll.
  useEffect(() => {
    if (!scope || !idsSig) return;
    const ids = idsSig.split(",");
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.req(
          [{ kinds: [KIND_ZAP_RECEIPT], "#e": ids, since: Math.floor(Date.now() / 1000) - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          queryClient.setQueryData<Map<string, NostrEvent[]>>([...queryKey, idsSig], (old) =>
            mergeReceipts(old, [event]),
          );
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
    // queryKey derives from scope, already a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, scope, idsSig, queryClient]);

  // Per-message tallies, derived once from the batched receipt map.
  const talliesById = useMemo(() => {
    const out = new Map<string, ZapTally>();
    const map = receiptsQuery.data;
    if (!map) return out;
    for (const [targetId, receipts] of map) {
      const tally = tallyZaps(receipts, targetId, user?.pubkey);
      if (tally.count > 0) out.set(targetId, tally);
    }
    return out;
  }, [receiptsQuery.data, user?.pubkey]);

  // Stable per-id MessageZaps objects (preserves React.memo on rows).
  const zapsFor = useMemo(() => stableZapsFor((id) => talliesById.get(id)), [talliesById]);

  return { zapsFor };
}
