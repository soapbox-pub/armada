import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { quickReactionRow, useFrequentReactionTable, type QuickReactionSlot } from "@/hooks/useFrequentReactions";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { t } from "@/i18n";
import { newestCanonicalSelfList, readStoredCanonicalSelfLists } from "@/lib/canonicalSelfList";
import { queryExplicitRelaysWithStatus } from "@/lib/nip65";
import { nextQuickReactionTags, parseQuickReactions, type QuickReaction } from "@/lib/quickReactions";
import { KIND_QUICK_REACTIONS } from "@/lib/selfSyncKinds";

import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

export interface QuickReactionListQuery {
  event: NostrRumor | null;
  reactions: QuickReaction[];
}

const NONE: QuickReaction[] = [];

/**
 * The user's kind-10077 list, read from ArmadaDB only: the standing self-state
 * REQ (and the Android service) store every new version there and invalidate
 * this key, so a row hovered on every message never waits on a relay.
 */
export function useQuickReactionList(): QuickReactionListQuery & { isFetched: boolean } {
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const pubkey = user?.pubkey;

  const query = useQuery<QuickReactionListQuery>({
    queryKey: ["quick-reactions", pubkey],
    enabled: !!pubkey,
    queryFn: async ({ signal }) => {
      const stored = await readStoredCanonicalSelfLists(eventStore, pubkey!, [KIND_QUICK_REACTIONS], signal);
      const event = newestCanonicalSelfList(stored.events, pubkey!, KIND_QUICK_REACTIONS) ?? null;
      return { event, reactions: parseQuickReactions(event) };
    },
    staleTime: Infinity,
  });

  return {
    event: query.data?.event ?? null,
    reactions: query.data?.reactions ?? NONE,
    isFetched: query.isFetched,
  };
}

/** The quick-reaction row for `pubkey`, `limit` slots long: the pinned list, then the most-used. */
export function useQuickReactions(pubkey: string | undefined, limit = 3): QuickReactionSlot[] {
  const stored = useFrequentReactionTable(pubkey);
  const { reactions } = useQuickReactionList();
  return useMemo(() => quickReactionRow(stored, reactions, limit), [stored, reactions, limit]);
}

/** Thrown when the list moved since the row the user edited was shown. */
export class QuickReactionsChangedError extends Error {
  constructor() {
    super(t({ id: "useQuickReactionList.changedElsewhere", defaultMessage: "Your quick reactions changed on another device. Check them and try again." }));
  }
}

/**
 * Publish `reactions` as the user's whole quick-reaction list. A user action
 * only (AGENTS.md): the row the user edited was derived from `basis` (the
 * event id it showed, or null for none), so a newer list on the relays, or a
 * read no relay answered, refuses rather than replacing what the user can't see.
 */
export function usePublishQuickReactions() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ reactions, basis }: { reactions: QuickReaction[]; basis: string | null }) => {
      if (!user) throw new Error(t({ id: "useQuickReactionList.signIn", defaultMessage: "Sign in to choose quick reactions." }));
      const queryKey = ["quick-reactions", user.pubkey];
      const deadline = AbortSignal.timeout(8_000);
      const filter = { kinds: [KIND_QUICK_REACTIONS], authors: [user.pubkey], limit: 1 };
      const [response, stored] = await Promise.all([
        queryExplicitRelaysWithStatus(nostr, selfStateRelays(config, user.pubkey), [filter], deadline),
        readStoredCanonicalSelfLists(eventStore, user.pubkey, [KIND_QUICK_REACTIONS], deadline),
      ]);
      if (response.answered.length === 0) {
        throw new Error(t({ id: "useQuickReactionList.unreachable", defaultMessage: "Couldn't reach your relays to check your quick reactions. Nothing was changed." }));
      }
      const cached = queryClient.getQueryData<QuickReactionListQuery>(queryKey);
      const prev = newestCanonicalSelfList(
        [...response.events, ...stored.events, ...(cached?.event ? [cached.event] : [])],
        user.pubkey,
        KIND_QUICK_REACTIONS,
      ) ?? null;

      if ((prev?.id ?? null) !== basis) {
        queryClient.setQueryData<QuickReactionListQuery>(queryKey, { event: prev, reactions: parseQuickReactions(prev) });
        throw new QuickReactionsChangedError();
      }

      const now = nowSecs();
      await publishEvent({
        kind: KIND_QUICK_REACTIONS,
        content: prev?.content ?? "",
        tags: nextQuickReactionTags(prev, reactions),
        created_at: prev ? Math.max(now, prev.created_at + 1) : now,
        prev: prev ?? undefined,
        relays: response.answered,
        inheritPendingTargets: false,
        onSigned: (event) => {
          queryClient.setQueryData<QuickReactionListQuery>(queryKey, {
            event,
            reactions: parseQuickReactions(event),
          });
        },
      });
    },
  });
}
