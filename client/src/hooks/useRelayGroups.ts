import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  buildRelayGroups,
  KIND_GROUP_METADATA,
  relayGroupCacheFilters,
} from "@/lib/nip29";
import { eventIdsForRelay } from "@/lib/relayProvenance";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Fetch all groups hosted on a server (relay).
 *
 * Group metadata events (kind 39000) MUST be signed by the relay's own key.
 * When the relay advertises that key via NIP-11 (`self` or `pubkey`), the
 * query filters by `authors` so forged metadata from other publishers is
 * never trusted.
 *
 * Relays may hide closed/private groups from open-ended listings, so the
 * ids remembered in the user's kind 10009 list are queried explicitly by
 * `d` tag and merged in.
 *
 * The channel list is one of the most STABLE things in the app: it's
 * relay-signed metadata that changes only when an admin creates/edits/deletes
 * a channel. So this query is deliberately quiet — no polling, a long
 * staleTime, an IndexedDB seed so it renders instantly on reload, and explicit
 * invalidation (see useGroupModeration / useCreateGroup) for the rare real
 * changes. The query KEY is just the relay URL: `relaySelf` and the remembered
 * ids are read inside the queryFn for filtering, but kept OUT of the key so a
 * resolving NIP-11 doc or a churning kind-10009 list can't swap the cache
 * entry and force a refetch from scratch.
 */
export function useRelayGroups(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { data: relayInfo, isLoading: infoLoading, isError: infoError } = useRelayInfo(relayUrl);
  const { data: userList } = useUserGroupList();

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const rememberedIds = (userList?.groups ?? [])
    .filter((ref) => ref.relay === relayUrl)
    .map((ref) => ref.id)
    .sort();

  const queryKey = ["nip29", "groups", relayUrl];

  // Read THIS relay's cached kind-39000 metadata from the local event store,
  // scoped by relay PROVENANCE (which relay actually served each event), not
  // just by signing key. Author-scoping alone can't isolate relays that share a
  // key — e.g. zooid ships a shared relay identity, so two servers advertise the
  // same NIP-11 pubkey and their channels would otherwise bleed into each other
  // (phantom rooms that "don't exist" when opened). Provenance is recorded by
  // NostrBatcher when it serves directory events from a specific relay.
  //
  // If provenance has entries for this relay, ONLY those events are returned. If
  // it has none yet (nothing fetched from this relay this install), we return
  // nothing from cache and let the live single-relay network read populate it —
  // the network read is correctly isolated, so this never shows bled channels.
  async function readScopedCache(): Promise<NostrEvent[]> {
    const filters = relayGroupCacheFilters(relaySelf, rememberedIds);
    if (filters.length === 0) return [];
    const [store, provenance] = await Promise.all([eventStore, eventIdsForRelay(relayUrl!)]);
    if (provenance.size === 0) return [];
    const candidates = await store.query(filters);
    return candidates.filter((e) => provenance.has(e.id));
  }

  // Cache-first seed: hydrate the channel list from IndexedDB (where the relay's
  // kind-39000 metadata is persisted by NostrBatcher) so it renders instantly on
  // a fresh mount/reload instead of going blank while the relay round-trips.
  // Reads are scoped to THIS relay by provenance so one server's channels never
  // bleed into another's — even when relays share a signing key.
  useEffect(() => {
    if (!relayUrl) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const cached = await readScopedCache();
      if (cancelled || cached.length === 0) return;
      if (queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, buildRelayGroups(cached, relayUrl));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, relaySelf, rememberedIds.join(","), eventStore, queryClient]);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const authors = relaySelf ? { authors: [relaySelf] } : {};
      const filters: NostrFilter[] = [
        { kinds: [KIND_GROUP_METADATA], ...authors, limit: 500 },
      ];
      if (rememberedIds.length > 0) {
        filters.push({ kinds: [KIND_GROUP_METADATA], "#d": rememberedIds, ...authors });
      }

      const events = await nostr.relay(relayUrl!).query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });

      // Merge with the relay's PROVENANCE-scoped cached metadata so a sparse or
      // empty relay read never DROPS channels we already knew about — without
      // re-introducing the cross-relay bleed for same-key relays. The fresh
      // network events (correctly isolated to this relay) also get their
      // provenance recorded by NostrBatcher, so subsequent reads stay scoped.
      const cached = await readScopedCache();
      return buildRelayGroups([...cached, ...events], relayUrl!);
    },
    enabled: Boolean(relayUrl) && !infoLoading,
    // Relay-signed, rarely-changing data. Keep it fresh for the whole session
    // and rely on explicit invalidation for the rare real change.
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    // An all-reads-AUTH relay (zooid) can CLOSE the first REQ with
    // `auth-required` before NIP-42 AUTH settles, so the very first fetch on a
    // cold connection may resolve empty. nostrify re-subscribes after AUTH, but
    // the initial query() promise can already have resolved on the CLOSED/EOSE.
    // Don't let that transient empty result freeze for the hour-long staleTime:
    // retry a few times (this only re-runs while the result is empty, since a
    // populated cache satisfies the query), and allow a refetch on mount.
    retry: (failureCount) => failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    refetchOnMount: true,
    refetchOnReconnect: false,
  });

  // The first fetch against an all-reads-AUTH relay can win EOSE before AUTH
  // completes and come back empty (zooid CLOSES the pre-AUTH REQ). react-query
  // treats an empty array as success, so a one-shot empty wouldn't otherwise be
  // retried. Schedule a single delayed refetch when we have a logged-in user, a
  // resolved relay key, and an empty result — by then AUTH is warm and the
  // retried subscription yields the metadata.
  const emptyResult = query.data?.length === 0;
  useEffect(() => {
    if (!relayUrl || !emptyResult || !relaySelf) return;
    const t = setTimeout(() => void query.refetch(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, emptyResult, relaySelf]);

  // The remembered ids (private/closed channels from the kind-10009 list) are
  // not part of the query key — that list churns constantly and we don't want it
  // swapping the cache entry. But if the user joins a channel the open listing
  // hides, its id won't be in the current result; refetch ONCE in that case so
  // the newly-joined channel shows up. Steady state (every remembered id already
  // present) stays quiet.
  const data = query.data;
  useEffect(() => {
    if (!relayUrl || !data) return;
    const known = new Set(data.map((g) => g.id));
    if (rememberedIds.some((id) => !known.has(id))) {
      void query.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, data, rememberedIds.join(",")]);

  // While the NIP-11 info doc is still loading AND we have no channel data yet,
  // surface that as "loading" — otherwise a stuck/slow info fetch would read as
  // a non-loading, empty result. But once we have groups (live or seeded from
  // IndexedDB), a slow/failed NIP-11 fetch must NOT mark the channel list as
  // loading/errored: the channel list is its own stable thing and shouldn't
  // blank just because the relay's name/avatar fetch hiccuped on a shaky
  // connection. So info state only matters when there's no group data at all.
  const haveGroups = Boolean(query.data);
  const isLoading = query.isLoading || (infoLoading && !haveGroups);
  const isError = query.isError || (infoError && !haveGroups);

  return { ...query, isLoading, isError, relayInfo };
}
