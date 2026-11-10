import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { useChannelRules } from "@/concord/hooks/useChannelRules";
import { ruledOut } from "@/concord/lib/channelJudges";
import { filterEpochCutoff, type OpenedChat } from "@/concord/lib/chat";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { readStreamCursor, SEARCH_SCAN_LIMIT, searchRumors } from "@/concord/lib/rumorStore";
import { useWireScopes } from "@/wire/useWireScopes";
import { searchDateBounds, searchIsActive, searchText, type SearchFilters } from "@/concord/lib/search";
import type { Channel, Community } from "@/concord/lib/types";

import type { ChatMsg } from "@/components/chat/transport";

const NO_RESULTS: ChatMsg[] = [];

/** Results per page; "Show more" raises the limit by this much. */
const SEARCH_PAGE = 100;

interface SearchPage {
  rows: OpenedChat[];
  hasMore: boolean;
}

/** The timeline's retirement cutoff, per channel: search reads the same rows. */
function applyEpochCutoffs(rumors: OpenedChat[], channels: Channel[]): OpenedChat[] {
  const byId = new Map(channels.map((c) => [c.idHex, c]));
  const groups = new Map<string, OpenedChat[]>();
  for (const r of rumors) {
    const group = groups.get(r.channelIdHex);
    if (group) group.push(r);
    else groups.set(r.channelIdHex, [r]);
  }
  const keep = new Set<OpenedChat>();
  for (const [idHex, group] of groups) {
    const channel = byId.get(idHex);
    for (const r of channel ? filterEpochCutoff(group, channel) : group) keep.add(r);
  }
  return rumors.filter((r) => keep.has(r));
}

/**
 * Community-wide search over the local decrypted rumor store (Concord chat is
 * E2E encrypted, so there's no relay query). Text is debounced 300ms; results
 * are newest-first and carry their `channel` tag.
 *
 * @param channels default scope when the filter selects no channels, and the
 *   epoch cutoffs every result is checked against.
 */
export function useConcordSearch(
  community: Community | undefined,
  channels: Channel[],
  filters: SearchFilters,
) {
  const communityIdHex = community?.idHex;
  const allChannelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  const debouncedQuery = useDebounce(searchText(filters.query), 300);

  const channelIds = filters.channelIds.length > 0 ? filters.channelIds : allChannelIds;

  const effective: SearchFilters = { ...filters, query: debouncedQuery };
  // Activation waits for the debounced query, but deactivation is immediate:
  // stale debounced text after closing search would keep the results pane mounted.
  const active = searchIsActive(filters) && searchIsActive(effective);

  const channelsKey = [...channelIds].sort().join(",");
  const authorsKey = [...filters.authors].sort().join(",");
  // Re-filter when a rotation lands: the cutoffs are part of the answer.
  const cutoffsKey = channels
    .flatMap((c) => c.streams.flatMap((s) => (s.retiredAt === undefined ? [] : [`${c.idHex}:${s.epoch}:${s.retiredAt}`])))
    .join(",");
  const { since, until } = searchDateBounds(filters);

  // The page count belongs to one search: any change to it starts over at one page.
  const searchKey = [
    communityIdHex ?? "",
    channelsKey,
    authorsKey,
    filters.media,
    since ?? "",
    until ?? "",
    debouncedQuery,
  ].join("|");
  const [paging, setPaging] = useState({ key: searchKey, limit: SEARCH_PAGE });
  const limit = paging.key === searchKey ? paging.limit : SEARCH_PAGE;

  const search = useQuery<SearchPage>({
    queryKey: [
      "concord",
      "search",
      communityIdHex ?? null,
      channelsKey,
      authorsKey,
      cutoffsKey,
      filters.media,
      since ?? null,
      until ?? null,
      debouncedQuery,
      limit,
    ],
    enabled: !!communityIdHex && active && channelIds.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const rumors = await searchRumors(communityIdHex!, channelIds, {
        query: debouncedQuery,
        authors: filters.authors,
        media: filters.media,
        since,
        until,
        limit,
        signal,
      });
      return {
        rows: applyEpochCutoffs(rumors, channels),
        // Judged before the cutoffs and moderation drops: a full page means more may match.
        hasMore: rumors.length >= limit && limit < SEARCH_SCAN_LIMIT,
      };
    },
  });
  const hasMore = !search.isPlaceholderData && (search.data?.hasMore ?? false);
  const loadMore = useCallback(() => {
    if (!hasMore) return;
    setPaging({ key: searchKey, limit: Math.min(limit + SEARCH_PAGE, SEARCH_SCAN_LIMIT) });
  }, [hasMore, searchKey, limit]);

  // Search reads only this device, so say when some searched channel's history
  // hasn't been walked to its start yet (the background walk is still on it).
  const coverage = useQuery<boolean>({
    queryKey: ["concord", "search-coverage", channelsKey],
    enabled: active && channelIds.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const cursors = await Promise.all(channelIds.map((id) => readStreamCursor(id)));
      return cursors.some((c) => !c?.exhausted || c.bridge !== undefined);
    },
  });
  const refetchCoverage = coverage.refetch;
  useWireScopes((scopes) => {
    if (!active) return;
    for (const s of scopes) {
      if (s.startsWith("c2cur:") && channelIds.includes(s.slice("c2cur:".length))) {
        void refetchCoverage();
        return;
      }
    }
  });

  // Search bypasses the timeline, so every drop the fold performs must be repeated
  // here — notably the Banlist: a mod delete never removes the row (NIP-09), and
  // CORD-04 §4 requires dropping every event from a banned npub.
  const { mutedPubkeys } = useMutedPubkeys();
  const moderation = useChatModeration(community);
  const rulesFor = useChannelRules(community, channels, active);
  // A flood the fold quarantined must not be reachable through search.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);
  const channelsSig = channelIds.join(",");
  const results = useMemo(() => {
    void memoryRev;
    if (!moderation.ready) return NO_RESULTS;
    const rows = (search.data?.rows ?? []).filter(
      (r) => !mutedPubkeys.has(r.author) && !moderation.banned.has(r.author) && !ruledOut(rulesFor(r.channelIdHex), r),
    );
    if (rows.length === 0) return NO_RESULTS;
    let list = rows.map(openedToChatMsg);
    if (communityIdHex) {
      let quarantined: Set<string> | undefined;
      for (const idHex of channelIds) {
        const remembered = recallQuarantined(communityIdHex, idHex);
        if (!remembered) continue;
        quarantined ??= new Set();
        for (const id of remembered) quarantined.add(id);
      }
      if (quarantined && quarantined.size > 0) list = list.filter((m) => !quarantined.has(m.id));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data, mutedPubkeys, moderation, communityIdHex, channelsSig, memoryRev, rulesFor]);

  return {
    results,
    isLoading: (search.isFetching || (active && !moderation.ready)) && results.length === 0,
    active,
    historyIncomplete: coverage.data ?? false,
    hasMore,
    loadingMore: limit > SEARCH_PAGE && search.isFetching && search.isPlaceholderData && results.length > 0,
    loadMore,
  };
}
