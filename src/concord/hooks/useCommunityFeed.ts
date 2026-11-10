import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useChatModeration } from "@/concord/hooks/useChannel";
import { useFloodPolicy } from "@/concord/hooks/useFloodPolicy";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import { foldTimeline } from "@/concord/lib/chat";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { CHAT_ROW_KINDS, queryRumorsByChannel } from "@/concord/lib/rumorStore";
import { AppContext } from "@/contexts/AppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";

/** Rumors read per channel per page. Widened by `loadOlder`, never narrowed. */
const PAGE = 100;
/** Ceiling on the per-channel window (40 channels at the cap is a 20k-row scan). */
const MAX_WINDOW = 1000;

/** Stable empties, so a never-read pane hands out constant identities. */
const NO_MESSAGES: ChatMsg[] = [];
const NO_ROWS: Map<string, OpenedChat[]> = new Map();

const ROW_KINDS = new Set(CHAT_ROW_KINDS);

export interface CommunityFeed {
  /** Every channel's messages, NEWEST FIRST. */
  messages: ChatMsg[];
  isLoading: boolean;
  /** Whether an older page exists (see the completeness watermark). */
  hasMore: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
}

/**
 * Every message in every channel of a community, merged into one feed (the
 * "All messages" pane). Purely local: reads the decrypted rumor cache, no relay
 * query. `active` gates the read so it doesn't contend with the open channel's
 * timeline read when the pane isn't on screen.
 *
 * Per-channel windows merge into a ragged tail (a busy channel reaches back
 * hours, a quiet one a year), so the feed is cut at the newest point where it is
 * COMPLETE: the latest oldest-row among truncated channels. `loadOlder` widens
 * the window so that watermark recedes; `hasMore` means "a channel was truncated".
 *
 * Each channel is folded on its own before the merge, since the flood detector
 * judges a batch as a cohort. Quarantined messages are dropped (as in Mentions),
 * not collapsed: this is an aggregate catch-up surface.
 */
export function useCommunityFeed(
  community: Community | undefined,
  channels: Channel[],
  active: boolean,
): CommunityFeed {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const moderation = useChatModeration(community, active);
  const communityIdHex = community?.idHex;

  // Recomputed only when the channel SET changes, so the query key doesn't churn.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const [windowSize, setWindow] = useState(PAGE);
  useEffect(() => setWindow(PAGE), [communityIdHex]);

  const queryKey = useMemo(
    () => ["concord-community-feed", communityIdHex ?? null, channelSig, windowSize] as const,
    [communityIdHex, channelSig, windowSize],
  );

  const { data: byChannel = NO_ROWS, isPending, isFetching } = useQuery<Map<string, OpenedChat[]>>({
    ...STORE_READ,
    queryKey,
    queryFn: ({ signal }) =>
      queryRumorsByChannel(communityIdHex!, channelIds, { perChannel: windowSize, signal }),
    enabled: active && !!communityIdHex && channelIds.length > 0,
    // Backstop for writes from another tab; the wire bus below is the live path.
    refetchInterval: 60_000,
    staleTime: Infinity,
  });

  // Re-fold when the persisted quarantine memory warms or grows.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);
  const floodPolicy = useFloodPolicy();
  const foldSimilar = useContext(AppContext)?.config.foldSimilarMessages ?? true;

  // Kept outside the query so a mute/fold/roster change re-derives without re-scanning.
  const { messages, hasMore } = useMemo(() => {
    void memoryRev;
    // Withheld until the Banlist is folded (see `ChatModerationState.ready`).
    if (byChannel.size === 0 || !moderation.ready) return { messages: NO_MESSAGES, hasMore: false };

    const merged: OpenedChat[] = [];
    // Oldest point back to which EVERY channel has been read (see watermark above).
    let completeSince = 0;

    for (const [idHex, rows] of byChannel) {
      const folded = foldTimeline(rows, moderation, {
        ...(user?.pubkey !== undefined ? { self: user.pubkey } : {}),
        policy: floodPolicy,
      });
      // With folding off, only a pause and the Roster still hide rows (as in the channel).
      const dropped = new Set(foldSimilar ? folded.quarantined : [...folded.paused, ...folded.ruled]);
      const remembered = foldSimilar && communityIdHex ? recallQuarantined(communityIdHex, idHex) : undefined;
      if (remembered) for (const id of remembered) dropped.add(id);
      for (const m of folded.messages) if (!dropped.has(m.rumorId)) merged.push(m);

      // Truncation is a property of the RAW read, not the fold: count rows the limit
      // applied to (side events carry their own budget).
      let count = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        if (!ROW_KINDS.has(r.kind)) continue;
        count++;
        if (r.ms < oldest) oldest = r.ms;
      }
      if (count >= windowSize && oldest < Number.POSITIVE_INFINITY && oldest > completeSince) {
        completeSince = oldest;
      }
    }

    let list = completeSince > 0 ? merged.filter((m) => m.ms >= completeSince) : merged;
    if (mutedPubkeys.size > 0) list = list.filter((m) => !mutedPubkeys.has(m.author));
    list.sort((a, b) => b.ms - a.ms || (a.rumorId < b.rumorId ? 1 : -1));

    return {
      messages: list.map(openedToChatMsg),
      hasMore: completeSince > 0 && windowSize < MAX_WINDOW,
    };
  }, [byChannel, moderation, user?.pubkey, mutedPubkeys, communityIdHex, windowSize, memoryRev, floodPolicy, foldSimilar]);

  // Full re-scan rather than a per-channel delta patch: the fold needs each
  // channel's whole window, and this only runs while the pane is open.
  useWireScopes((scopes) => {
    if (!active) return;
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord-community-feed", communityIdHex ?? null] });
        return;
      }
    }
  });

  const loadOlder = useCallback(() => {
    setWindow((w) => Math.min(w + PAGE, MAX_WINDOW));
  }, []);

  return useMemo(
    () => ({
      messages,
      // `isPending` alone stays true for a disabled query.
      isLoading: active && !!communityIdHex && channelIds.length > 0 && (isPending || !moderation.ready),
      hasMore,
      isLoadingOlder: isFetching && !isPending,
      loadOlder,
    }),
    [messages, active, communityIdHex, channelIds, isPending, moderation.ready, hasMore, isFetching, loadOlder],
  );
}
