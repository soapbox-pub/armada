import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { stableZapsFor } from "@/components/chat/transport";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { KIND_ONCHAIN_ZAP, KIND_ZAP_RECEIPT, tallyOnchainZaps, tallyZaps, type ZapTally } from "@/lib/zaps";

import type { MessageZaps } from "@/components/chat/transport";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

const zapsKey = (scope: string) => ["zaps", scope] as const;

/** Bucket receipts by their `e` tag (a receipt can carry only one). */
function groupReceiptsByTarget(receipts: NostrRumor[]): Map<string, NostrRumor[]> {
  const map = new Map<string, NostrRumor[]>();
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
  old: Map<string, NostrRumor[]> | undefined,
  fresh: NostrRumor[],
): Map<string, NostrRumor[]> {
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
 * Load NIP-57 zap receipts (kind 9735) and on-chain zaps (kind 8333) for a
 * timeline in one batched `#e` query, structured like {@link useGroupReactions}.
 * Queried from the app-relay pool (not the group relay): that's where the 9734
 * request tells providers to publish, and where on-chain zaps are published.
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

  const receiptsQuery = useQuery<Map<string, NostrRumor[]>>({
    queryKey: [...queryKey, idsSig],
    queryFn: async ({ signal }) => {
      const ids = idsSig ? idsSig.split(",") : [];
      if (!scope || ids.length === 0) return new Map();
      const store = await eventStore;
      const limit = ids.length * 10;

      const cached = await store.query([{ kinds: [KIND_ZAP_RECEIPT, KIND_ONCHAIN_ZAP], "#e": ids, limit }]);

      // Background refresh; never gates render.
      void (async () => {
        if (signal.aborted) return;
        try {
          const fresh = await nostr.query(
            [{ kinds: [KIND_ZAP_RECEIPT, KIND_ONCHAIN_ZAP], "#e": ids, limit }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          if (signal.aborted || fresh.length === 0) return;
          queryClient.setQueryData<Map<string, NostrRumor[]>>([...queryKey, idsSig], (old) =>
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

  // Live subscription so the ⚡ chip lands without a poll.
  useEffect(() => {
    if (!scope || !idsSig) return;
    const ids = idsSig.split(",");
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.req(
          [{ kinds: [KIND_ZAP_RECEIPT, KIND_ONCHAIN_ZAP], "#e": ids, since: nowSecs() - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrRumor;
          queryClient.setQueryData<Map<string, NostrRumor[]>>([...queryKey, idsSig], (old) =>
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

  const talliesById = useMemo(() => {
    const out = new Map<string, ZapTally>();
    const map = receiptsQuery.data;
    if (!map) return out;
    for (const [targetId, events] of map) {
      const lightning = events.filter((e) => e.kind === KIND_ZAP_RECEIPT);
      const onchain = events.filter((e) => e.kind === KIND_ONCHAIN_ZAP);
      const lt = tallyZaps(lightning, targetId, user?.pubkey);
      const ot = tallyOnchainZaps(onchain, targetId, user?.pubkey);
      const all = [...lt.zaps, ...ot.zaps].sort((a, b) => b.sats - a.sats);
      if (all.length > 0) {
        out.set(targetId, {
          totalSats: all.reduce((sum, z) => sum + z.sats, 0),
          count: all.length,
          mine: Boolean(user?.pubkey && all.some((z) => z.pubkey === user.pubkey)),
          zaps: all,
        });
      }
    }
    return out;
  }, [receiptsQuery.data, user?.pubkey]);

  // Stable per-id MessageZaps objects (preserves React.memo on rows).
  const zapsFor = useMemo(() => stableZapsFor((id) => talliesById.get(id)), [talliesById]);

  return { zapsFor };
}
