import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { metadataSchema, seedAuthorCache } from "@/lib/authorCache";

import type { NostrMetadata } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface SearchProfile {
  pubkey: string;
  metadata: NostrMetadata;
  event: NostrRumor;
}

/** Every query word must appear somewhere in name + display_name + nip05 (any order, any field). */
export function profileMatches(p: SearchProfile, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const haystack = [
    p.metadata.name,
    p.metadata.display_name,
    p.metadata.nip05,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

/** How a query word hit a profile, best (0) to none (5). */
function tokenRank(token: string, names: string[], nip05Local: string, haystack: string): number {
  if (names.some((n) => n.startsWith(token))) return 0;
  if (names.some((n) => n.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(token)))) return 1;
  if (nip05Local.startsWith(token)) return 2;
  if (names.some((n) => n.includes(token))) return 3;
  return haystack.includes(token) ? 4 : 5;
}

/**
 * Relevance of `p` to `query`, lower is better: a name that starts with the query outranks one
 * that merely contains it, and both outrank a hit on the NIP-05 domain alone.
 */
export function profileMatchRank(p: SearchProfile, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const names = [p.metadata.name, p.metadata.display_name]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  const nip05 = (p.metadata.nip05 ?? "").toLowerCase();
  const nip05Local = nip05.includes("@") && !nip05.startsWith("_@") ? nip05.split("@")[0] : "";
  const haystack = [...names, nip05].join(" ");
  return tokens.reduce((sum, t) => sum + tokenRank(t, names, nip05Local, haystack), 0);
}

function sortName(p: SearchProfile): string {
  return (p.metadata.name || p.metadata.display_name || p.pubkey).toLowerCase();
}

function unnamed(p: SearchProfile): number {
  return p.metadata.name || p.metadata.display_name ? 0 : 1;
}

/** Sorts in place by relevance to `query`, then named before bare keys, then alphabetically. */
function sortByRelevance(profiles: SearchProfile[], query: string): SearchProfile[] {
  const rank = new Map(profiles.map((p) => [p.pubkey, profileMatchRank(p, query)]));
  return profiles.sort((a, b) =>
    (rank.get(a.pubkey)! - rank.get(b.pubkey)!) || unnamed(a) - unnamed(b) || sortName(a).localeCompare(sortName(b)));
}

/** Scan cached ['author', pubkey] entries; by relevance, then follows, then alphabetical. */
function searchCachedProfiles(
  queryClient: ReturnType<typeof useQueryClient>,
  query: string,
  followedPubkeys: Set<string>,
  limit: number = 10,
): SearchProfile[] {
  const lowerQuery = query.toLowerCase();
  const results: SearchProfile[] = [];

  const cache = queryClient.getQueryCache().findAll({ queryKey: ["author"] });

  for (const entry of cache) {
    const data = entry.state.data as { event?: NostrRumor; metadata?: NostrMetadata } | undefined;
    if (!data?.event || !data?.metadata) continue;

    const profile: SearchProfile = { pubkey: data.event.pubkey, metadata: data.metadata, event: data.event };
    if (profileMatches(profile, lowerQuery)) results.push(profile);
  }

  const rank = new Map(results.map((p) => [p.pubkey, profileMatchRank(p, lowerQuery)]));
  results.sort((a, b) => {
    const byRank = rank.get(a.pubkey)! - rank.get(b.pubkey)!;
    if (byRank !== 0) return byRank;
    const aFollowed = followedPubkeys.has(a.pubkey) ? 0 : 1;
    const bFollowed = followedPubkeys.has(b.pubkey) ? 0 : 1;
    if (aFollowed !== bFollowed) return aFollowed - bFollowed;
    return sortName(a).localeCompare(sortName(b));
  });

  return results.slice(0, limit);
}

/** Authors per relay REQ when filling in missing kind-0s; relays cap a filter's author list. */
const PROFILE_FETCH_CHUNK = 500;

/**
 * Prefetch `pubkeys`' kind-0s (store first, then batched relay queries) so local name matching
 * works even when NIP-50 relays don't return them, and the author cache is seeded for each row.
 * Keyed on the set only.
 */
function useProfilesOf(cacheKey: string, pubkeys: string[], enabled = true) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const key = useMemo(() => [...pubkeys].sort().join(","), [pubkeys]);

  return useQuery<SearchProfile[]>({
    queryKey: [cacheKey, key],
    queryFn: async ({ signal }) => {
      if (pubkeys.length === 0) return [];
      const store = await eventStore;

      const cached = await store.query([{ kinds: [0], authors: pubkeys }]);
      const byPubkey = new Map<string, NostrRumor>();
      for (const ev of cached) {
        const prev = byPubkey.get(ev.pubkey);
        if (!prev || ev.created_at > prev.created_at) byPubkey.set(ev.pubkey, ev);
      }

      const missing = pubkeys.filter((pk) => !byPubkey.has(pk));
      if (missing.length > 0) {
        try {
          const chunks: string[][] = [];
          for (let i = 0; i < missing.length; i += PROFILE_FETCH_CHUNK) chunks.push(missing.slice(i, i + PROFILE_FETCH_CHUNK));
          const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
          const fresh = (await Promise.all(chunks.map((authors) =>
            nostr.query([{ kinds: [0], authors }], { signal: timeout }).catch(() => []),
          ))).flat();
          for (const ev of fresh) {
            const prev = byPubkey.get(ev.pubkey);
            if (!prev || ev.created_at > prev.created_at) {
              byPubkey.set(ev.pubkey, ev);
              void store.event(ev);
            }
          }
        } catch {
          // Relay miss — the cached subset still powers local matches.
        }
      }

      const profiles: SearchProfile[] = [];
      for (const [pubkey, event] of byPubkey) {
        try {
          const metadata = metadataSchema.parse(event.content);
          profiles.push({ pubkey, metadata, event });
          // Newest-wins, never downgrading a fresher profile.
          seedAuthorCache(queryClient, pubkey, event);
        } catch {
          // Skip unparseable metadata.
        }
      }
      return profiles;
    },
    enabled: enabled && pubkeys.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

function useFollowProfiles(followedPubkeys: string[], enabled = true) {
  return useProfilesOf("follow-profiles", followedPubkeys, enabled);
}

/**
 * NIP-50 profile search for @-mention autocomplete and the invite picker. Follows are matched
 * LOCALLY and merged ahead of relay results, so they appear even when relays don't index them.
 */
export function useSearchProfiles(query: string) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { mutedPubkeys } = useMutedPubkeys();
  const { data: followData } = useFollowList();
  const followedPubkeys = useMemo(
    () => new Set(followData?.pubkeys ?? []),
    [followData?.pubkeys],
  );
  const { data: followProfiles } = useFollowProfiles(followData?.pubkeys ?? []);

  const debouncedQuery = useDebounce(query, 300);

  const relayResults = useQuery<SearchProfile[]>({
    queryKey: ["search-profiles", debouncedQuery],
    queryFn: async ({ signal }) => {
      if (!debouncedQuery.trim()) return [];

      // Relays without NIP-50 ignore `search`.
      const events = await nostr.query(
        [{ kinds: [0], search: `${debouncedQuery.trim()} autocomplete:true sort:top`, limit: 10 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );

      const profiles: SearchProfile[] = [];

      for (const event of events) {
        try {
          const metadata = metadataSchema.parse(event.content);
          profiles.push({ pubkey: event.pubkey, metadata, event });
        } catch {
          // Skip invalid metadata
        }
      }

      const seen = new Map<string, SearchProfile>();
      for (const profile of profiles) {
        const existing = seen.get(profile.pubkey);
        if (!existing || profile.event.created_at > existing.event.created_at) {
          seen.set(profile.pubkey, profile);
        }
      }

      return Array.from(seen.values());
    },
    enabled: debouncedQuery.trim().length >= 1,
    staleTime: 30 * 1000,
    placeholderData: (prev) => prev,
  });

  // Follows first, then relay results; falls back to a cache-wide scan when nothing matches.
  const data = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (q.length < 1) return relayResults.data;

    const followMatches = sortByRelevance((followProfiles ?? []).filter((p) => profileMatches(p, q)), q);

    const relayData = relayResults.data ?? [];

    if (followMatches.length === 0 && relayData.length === 0) {
      return searchCachedProfiles(queryClient, q, followedPubkeys);
    }

    const merged: SearchProfile[] = [...followMatches];
    const have = new Set(followMatches.map((p) => p.pubkey));
    for (const p of relayData) {
      if (!have.has(p.pubkey)) {
        merged.push(p);
        have.add(p.pubkey);
      }
    }
    // Stable: within a relevance tier, follows stay ahead and relays keep their order.
    const rank = new Map(merged.map((p) => [p.pubkey, profileMatchRank(p, q)]));
    return merged.sort((a, b) => rank.get(a.pubkey)! - rank.get(b.pubkey)!);
  }, [relayResults.data, followProfiles, followedPubkeys, debouncedQuery, queryClient]);

  // Muting applied to the MERGED result so no source path can reintroduce a muted person.
  const visible = useMemo(
    () => (mutedPubkeys.size === 0 ? data : data?.filter((p) => !mutedPubkeys.has(p.pubkey))),
    [data, mutedPubkeys],
  );

  return {
    ...relayResults,
    data: visible,
    followedPubkeys,
  };
}

/**
 * Followed people matching `query`, by relevance then alphabetical. Local only (no NIP-50 round-trip), so it can
 * filter on every keystroke; `enabled` defers fetching the follows' profiles until needed.
 */
export function useFollowSearch(query: string, enabled = true, limit = 20): SearchProfile[] {
  const { mutedPubkeys } = useMutedPubkeys();
  const { data: followData } = useFollowList();
  const { data: followProfiles } = useFollowProfiles(followData?.pubkeys ?? EMPTY, enabled);

  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!enabled || !q || !followProfiles) return EMPTY_PROFILES;
    return sortByRelevance(
      followProfiles.filter((p) => !mutedPubkeys.has(p.pubkey) && profileMatches(p, q)),
      q,
    ).slice(0, limit);
  }, [query, enabled, followProfiles, mutedPubkeys, limit]);
}

const EMPTY: string[] = [];
const EMPTY_PROFILES: SearchProfile[] = [];

/**
 * A roster's kind-0s, from the store then relays, for `useMemberProfiles`'s `loaded`: names
 * then match members whose profile no row has rendered yet.
 */
export function useRosterProfiles(pubkeys: string[], enabled: boolean): SearchProfile[] | undefined {
  return useProfilesOf("member-profiles", enabled ? pubkeys : EMPTY, enabled).data;
}

/**
 * A fixed member set for scoped autocomplete (@-mentions, search's `from:`); members without
 * metadata still match by npub/hex. `loaded` fills in members missing from the author cache.
 */
export function useMemberProfiles(
  pubkeys: string[],
  query: string,
  { limit = 10, loaded }: { limit?: number; loaded?: SearchProfile[] } = {},
) {
  const queryClient = useQueryClient();
  const { mutedPubkeys } = useMutedPubkeys();

  return useMemo<SearchProfile[]>(() => {
    const lowerQuery = query.trim().toLowerCase();
    const loadedBy = new Map((loaded ?? EMPTY_PROFILES).map((p) => [p.pubkey, p]));

    const profiles: SearchProfile[] = pubkeys.filter((pk) => !mutedPubkeys.has(pk)).map((pubkey) => {
      // `getQueryData` hashes once; `getQueryCache().find` stringifies every key, which is
      // too hot for a per-keystroke scan.
      const data = queryClient.getQueryData(["author", pubkey]) as
        | { event?: NostrRumor; metadata?: NostrMetadata }
        | undefined;
      if (!data?.metadata) {
        const fetched = loadedBy.get(pubkey);
        if (fetched) return fetched;
      }
      return {
        pubkey,
        metadata: data?.metadata ?? {},
        event: data?.event ?? ({ pubkey, tags: [], content: "", kind: 0, created_at: 0, id: "" } satisfies NostrRumor),
      };
    });

    const matched = lowerQuery
      ? profiles.filter(
          (p) => profileMatches(p, lowerQuery) || p.pubkey.startsWith(lowerQuery),
        )
      : profiles;

    return sortByRelevance(matched, lowerQuery).slice(0, limit);
  }, [pubkeys, query, queryClient, mutedPubkeys, loaded, limit]);
}
