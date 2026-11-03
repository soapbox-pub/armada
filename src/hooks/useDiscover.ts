import { useNostr } from "@nostrify/react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDebounce } from "@/hooks/useDebounce";
import { useFollowList } from "@/hooks/useFollowList";
import { KIND_EMOJI_SET, emojiPackEntries, emojiPackName } from "@/hooks/useEmojiPacks";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { resolveBundle } from "@/concord/hooks/useCommunityActions";
import {
  activityByLinkSigner,
  discoverActivityBatches,
  type DiscoverActivityTarget,
} from "@/concord/lib/discoverActivity";
import { parseInviteLink } from "@/concord/lib/invite";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { getArmadaDB } from "@/lib/db/armadaDB";
import {
  chunkAuthors,
  packNetwork,
  rankDiscoverNetwork,
  unpackNetwork,
} from "@/lib/discoverNetwork";
import {
  curatedPubkeys,
  curationFilter,
  curationKey,
  isCurationEvent,
  resolveDiscoverCuration,
  resolveDiscoverRelays,
  type DiscoverCuration,
} from "@/lib/discoverSource";
import { normalizeRelayUrl } from "@/lib/platform";
import { THEME_DEFINITION_KIND, isAdoptedTheme, parseDittoTheme } from "@/lib/themeEvent";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Discover feeds: public community listings, NIP-30 emoji packs and themes.
 * Queries app relays directly, per relay, bypassing the pool's search router. With
 * a query, sends both a NIP-50 `search` filter and a plain filter, then filters
 * client-side, so non-NIP-50 relays still return results.
 */

const FETCH_LIMIT = 100;
const NO_AUTHORS: string[] = [];
const TIMEOUT_MS = 6000;

/**
 * Grace for slower relays after the first answers; the pool's 300ms EOSE cut
 * drops slower relays holding most listings.
 */
const RELAY_GRACE_MS = 2500;

/**
 * Run each filter set as its own REQ against each relay separately, so a dead
 * relay costs only its own events. One answer per (relay, set).
 */
async function queryEachRelay(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  filterSets: NostrFilter[][],
  signal: AbortSignal,
  { timeout = TIMEOUT_MS, graceMs = RELAY_GRACE_MS }: { timeout?: number; graceMs?: number } = {},
): Promise<NostrRumor[][]> {
  const grace = new AbortController();
  const settled = AbortSignal.any([signal, grace.signal, AbortSignal.timeout(timeout)]);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const answers: NostrRumor[][] = [];
  await Promise.allSettled(
    relays.flatMap((url) =>
      filterSets.map(async (filters) => {
        const events = await nostr.relay(url).query(filters, { signal: settled });
        answers.push(events);
        graceTimer ??= setTimeout(() => grace.abort(), graceMs);
      }),
    ),
  );
  clearTimeout(graceTimer);
  return answers;
}

/** One filter set per author chunk; none at all for no authors, so nothing is sent. */
function chunkedSets(authors: string[], build: (authors: string[]) => NostrFilter[]): NostrFilter[][] {
  return chunkAuthors(authors).map(build);
}

function mergeAnswers(answers: NostrRumor[][]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const events of answers) for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

/**
 * Oldest `created_at` every relay's answer is complete down to, or `undefined` if
 * no relay filled its `limit`. Cut at the HIGHEST per-relay floor so dense relays
 * aren't skipped when paging.
 */
function windowFloor(
  answers: NostrRumor[][],
  inWindow: (event: NostrRumor) => boolean,
): number | undefined {
  let floor: number | undefined;
  for (const events of answers) {
    const times = events.filter(inWindow).map((e) => e.created_at);
    if (times.length < FETCH_LIMIT) continue;
    times.sort((a, b) => b - a);
    const nth = times[FETCH_LIMIT - 1];
    floor = floor === undefined ? nth : Math.max(floor, nth);
  }
  return floor;
}

/**
 * Warm-load seeds persisted in KV. Written into the cache already stale
 * (`updatedAt: 0`) so the network fetch still runs; never overwrite fetched data.
 */
const PACK_SEED_KV = "discover:seed:pack";
const DIRECTORY_SEED_KV = "discover:seed:directory";

function useKvQuerySeed<T>(kvKey: string, queryKey: QueryKey | undefined): void {
  const queryClient = useQueryClient();
  // Serialize so the effect re-runs when the key changes by value.
  const keyString = queryKey ? JSON.stringify(queryKey) : "";
  useEffect(() => {
    if (!keyString) return;
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getArmadaDB().kv.get<T>(kvKey);
        if (cancelled || stored === undefined) return;
        const key = JSON.parse(keyString) as QueryKey;
        if (queryClient.getQueryData(key) !== undefined) return;
        queryClient.setQueryData(key, stored, { updatedAt: 0 });
      } catch {
        // Best-effort: an unreadable seed just means a skeleton first paint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kvKey, keyString, queryClient]);
}

function writeSeed(kvKey: string, value: unknown[]): void {
  if (value.length === 0) return; // an empty read may be a miss — keep the last good seed
  getArmadaDB().kv.set(kvKey, value).catch(() => undefined);
}

/** Per curation source, so one source's membership never stands in for another's. */
function packSeedKey(curation: DiscoverCuration): string {
  return `${PACK_SEED_KV}:${curationKey(curation)}`;
}

/**
 * The curation source in effect: the user's override or the build default (Armada
 * team follow pack, kind 39089). Its members seed the authorship of every Discover feed.
 */
export function useDiscoverCuration(): DiscoverCuration {
  const { config } = useAppContext();
  return useMemo(() => resolveDiscoverCuration(config.discoverCuration ?? ""), [config.discoverCuration]);
}

/** Relays named only by the curation source's hints, read for the list event alone. */
function extraCurationRelays(curation: DiscoverCuration, relays: string[]): string[] {
  if (curation.type === "none") return [];
  return curation.relays.filter((url) => !relays.includes(url));
}

function curationMembers(curation: DiscoverCuration, answers: NostrRumor[][]): string[] {
  const [event] = mergeAnswers(answers)
    .filter((e) => isCurationEvent(curation, e))
    .sort((a, b) => b.created_at - a.created_at);
  return curatedPubkeys(event);
}

/** Newest event per addressable coordinate (`kind:pubkey:d`), newest first. */
function newestPerAddr(events: NostrRumor[]): NostrRumor[] {
  const newest = new Map<string, NostrRumor>();
  for (const event of events) {
    const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
    const addr = `${event.kind}:${event.pubkey}:${d}`;
    const prev = newest.get(addr);
    if (!prev || event.created_at > prev.created_at) newest.set(addr, event);
  }
  return [...newest.values()].sort((a, b) => b.created_at - a.created_at);
}

interface DiscoverFeedPage {
  events: NostrRumor[];
  /** `until` for the next page ({@link windowFloor}); inclusive, overlap is deduped. */
  cursor: number | undefined;
}

export async function fetchDiscoverPage(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  kind: number,
  query: string,
  authors: string[],
  signal: AbortSignal,
  until: number | undefined,
): Promise<DiscoverFeedPage> {
  // Every filter names its authors: Discover never reads anyone off a relay unvetted.
  const sets = chunkedSets(authors, (chunk) => {
    const base: NostrFilter = { kinds: [kind], authors: chunk, limit: FETCH_LIMIT };
    if (until !== undefined) base.until = until;
    return query ? [base, { ...base, search: query }] : [base];
  });
  if (sets.length === 0) return { events: [], cursor: undefined };

  const answers = await queryEachRelay(nostr, relays, sets, signal);
  // Judged on raw per-relay counts (pre-dedup) so collapsed pages still page on.
  const cursor = windowFloor(answers, () => true);
  const events = mergeAnswers(answers).filter((e) => cursor === undefined || e.created_at >= cursor);
  return { events: newestPerAddr(events), cursor };
}

/**
 * App relays plus the user's own NIP-65 relays (any marker). Independent of
 * `useUserRelays`, which governs the general pool.
 */
export function useDiscoverRelays(): string[] {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  // Partial configs (test doubles of AppContext) may lack relay metadata.
  const metadata = config.relayMetadata;
  const own = useMemo(() => {
    if (!user || !metadata) return [];
    // A mirror left from a previous account is not this user's list.
    if (metadata.pubkey && metadata.pubkey !== user.pubkey) return [];
    return metadata.relays.map((r) => r.url);
  }, [user, metadata]);
  return useMemo(() => resolveDiscoverRelays(config.appRelays, own), [config.appRelays, own]);
}

/** Where to look for the viewer's own listings; `useNostrPublish` sends them to the app relays. */
export function useListingRelays(): string[] {
  return useDiscoverRelays();
}

function packQueryKey(relays: string[], curation: DiscoverCuration): QueryKey {
  return ["discover", "follow-pack", curationKey(curation), relays];
}

async function fetchFollowPack(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  curation: DiscoverCuration,
  signal: AbortSignal,
): Promise<string[]> {
  const filter = curationFilter(curation);
  if (!filter) return [];
  const answers = await queryEachRelay(
    nostr,
    [...relays, ...extraCurationRelays(curation, relays)],
    [[filter]],
    signal,
  );
  // Newest across relays: a stale version must not win by answering first.
  let pubkeys = curationMembers(curation, answers);
  if (pubkeys.length === 0) {
    // An empty read is a probable miss, and an empty pack would blank painted feeds;
    // carry the last good membership forward.
    const seeded = await getArmadaDB()
      .kv.get<string[]>(packSeedKey(curation))
      .catch(() => undefined);
    if (seeded && seeded.length > 0) pubkeys = seeded;
  }
  writeSeed(packSeedKey(curation), pubkeys);
  return pubkeys;
}

/**
 * Honor un-publishes only from the announcement's own author (NIP-09); keep the
 * newest announcement per link signer.
 */
function foldAnnouncements(anns: NostrRumor[], dels: NostrRumor[]): DiscoveredInvite[] {
  const deleted = new Set<string>();
  const byId = new Map(anns.map((e) => [e.id, e.pubkey]));
  for (const del of dels) {
    for (const [n, id] of del.tags) {
      if (n === "e" && byId.get(id) === del.pubkey) deleted.add(id);
    }
  }
  const byLinkSigner = new Map<string, DiscoveredInvite>();
  for (const event of [...anns].sort((a, b) => b.created_at - a.created_at)) {
    if (deleted.has(event.id)) continue;
    const invite = announcementFromEvent(event);
    if (!invite) continue;
    if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
  }
  return [...byLinkSigner.values()];
}

const isAnnouncement = (e: NostrRumor) => e.kind === KIND_COMMUNITY_ANNOUNCEMENT;

/** Announcements per un-publish REQ (`#e` plus their authors), to keep each a sane size. */
const DELETION_ID_CHUNK = 150;

/**
 * Community announcements by `authors` (the allow-list; empty reads nothing),
 * then the un-publishes of exactly those announcements, by `#e` and their
 * authors, in a second round.
 */
export async function fetchCommunityAnnouncements(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  authors: string[],
  signal: AbortSignal,
  until?: number,
): Promise<{ invites: DiscoveredInvite[]; cursor: number | undefined; found: number }> {
  const sets = chunkedSets(authors, (chunk) => {
    const filter: NostrFilter = { kinds: [KIND_COMMUNITY_ANNOUNCEMENT], authors: chunk, limit: FETCH_LIMIT };
    if (until !== undefined) filter.until = until;
    return [filter];
  });
  if (sets.length === 0) return { invites: [], cursor: undefined, found: 0 };
  const answers = await queryEachRelay(nostr, relays, sets, signal);
  const allowed = new Set(authors);
  const cursor = windowFloor(answers, isAnnouncement);
  const anns = mergeAnswers(answers).filter(
    (e) => isAnnouncement(e) && allowed.has(e.pubkey) && (cursor === undefined || e.created_at >= cursor),
  );
  if (anns.length === 0) return { invites: [], cursor, found: 0 };

  const delSets: NostrFilter[][] = [];
  for (let i = 0; i < anns.length; i += DELETION_ID_CHUNK) {
    const slice = anns.slice(i, i + DELETION_ID_CHUNK);
    delSets.push([{
      kinds: [5],
      authors: [...new Set(slice.map((e) => e.pubkey))],
      "#e": slice.map((e) => e.id),
    }]);
  }
  const dels = mergeAnswers(await queryEachRelay(nostr, relays, delSets, signal));
  return { invites: foldAnnouncements(anns, dels), cursor, found: anns.length };
}

interface CommunitiesPage {
  invites: DiscoveredInvite[];
  cursor: number | undefined;
}

/** The last good first page, painted while the network read runs. */
interface CommunitiesSeed {
  invites: DiscoveredInvite[];
}

async function fetchCommunitiesPage(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  authors: string[],
  until: number | undefined,
  signal: AbortSignal,
): Promise<CommunitiesPage> {
  const { invites, cursor, found } = await fetchCommunityAnnouncements(nostr, relays, authors, signal, until);
  if (until !== undefined) return { invites, cursor };
  if (found === 0) {
    // No announcements at all is a probable miss, not an emptied directory; carry the
    // last good listings forward, without paging on from them.
    const seeded = await getArmadaDB()
      .kv.get<CommunitiesSeed>(DIRECTORY_SEED_KV)
      .catch(() => undefined);
    return { invites: seeded?.invites ?? [], cursor: undefined };
  }
  if (invites.length > 0) {
    getArmadaDB().kv.set(DIRECTORY_SEED_KV, { invites } satisfies CommunitiesSeed).catch(() => undefined);
  }
  return { invites, cursor };
}

/**
 * Local echo of an un-listing: drop it from every cached copy (feed, fallback, seed)
 * so it disappears now and a seed fallback can't paint it back.
 */
export async function forgetDiscoverAnnouncements(
  queryClient: QueryClient,
  announcementIds: Iterable<string>,
): Promise<void> {
  const gone = new Set(announcementIds);
  if (gone.size === 0) return;
  const keep = (invite: DiscoveredInvite) => !gone.has(invite.source.id);
  queryClient.setQueriesData<InfiniteData<CommunitiesPage>>(
    { queryKey: ["discover", "directory-infinite"] },
    (data) =>
      data && { ...data, pages: data.pages.map((page) => ({ ...page, invites: page.invites.filter(keep) })) },
  );
  try {
    const seed = await getArmadaDB().kv.get<CommunitiesSeed>(DIRECTORY_SEED_KV);
    if (seed && seed.invites.some((invite) => !keep(invite))) {
      await getArmadaDB().kv.set(DIRECTORY_SEED_KV, { ...seed, invites: seed.invites.filter(keep) });
    }
  } catch {
    // Best-effort: the next successful read rewrites the seed anyway.
  }
  void queryClient.invalidateQueries({ queryKey: ["discover", "directory-infinite"] });
}

/** By the allow-list it was read under. */
function directoryInfiniteKey(relays: string[], authors: string[]): QueryKey {
  return ["discover", "directory-infinite", relays, authors];
}

/** Shared by the page hook and {@link useWarmDiscover} so both prime the same cache entry. */
function communitiesInfiniteOptions(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  authors: string[],
) {
  return {
    queryKey: directoryInfiniteKey(relays, authors),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) =>
      fetchCommunitiesPage(nostr, relays, authors, pageParam, signal),
    getNextPageParam: (lastPage: CommunitiesPage) => lastPage.cursor,
  };
}

export type DiscoverScope = "you" | "friends" | "network";

const NETWORK_KV = "discover:network";
const NETWORK_TTL_MS = 24 * 60 * 60 * 1000;

function networkQueryKey(pubkey: string): QueryKey {
  return ["discover", "network", pubkey];
}

/** The follows' newest kind 3s, read straight off the Discover relays (not mirrored into the store). */
async function fetchDiscoverNetwork(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  viewer: string,
  follows: string[],
  signal: AbortSignal,
): Promise<string[]> {
  const sets = chunkedSets(follows, (chunk) => [{ kinds: [3], authors: chunk, limit: chunk.length }]);
  const answers = await queryEachRelay(nostr, relays, sets, signal, { timeout: 20_000, graceMs: 8000 });
  const lists = mergeAnswers(answers);
  // A relay outage must not be cached for a day as a tiny network.
  if (lists.length === 0) throw new Error("No follow lists found");
  const authors = rankDiscoverNetwork(viewer, follows, lists);
  getArmadaDB().kv.set(`${NETWORK_KV}:${viewer}`, packNetwork(authors, Date.now())).catch(() => undefined);
  return authors;
}

/**
 * The viewer's one-hop network ({@link rankDiscoverNetwork}), kept a day in KV.
 * `build` gates only the relay read: a stored network is used either way.
 */
function useDiscoverNetwork(build: boolean): string[] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const relays = useDiscoverRelays();
  const followList = useFollowList();
  const queryClient = useQueryClient();
  const follows = followList.data?.pubkeys ?? NO_AUTHORS;
  const pubkey = user?.pubkey;

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    void (async () => {
      try {
        const stored = unpackNetwork(await getArmadaDB().kv.get(`${NETWORK_KV}:${pubkey}`));
        const key = networkQueryKey(pubkey);
        if (cancelled || !stored || queryClient.getQueryData(key) !== undefined) return;
        queryClient.setQueryData(key, stored.authors, { updatedAt: stored.updatedAt });
      } catch {
        // Best-effort: no stored network just means building one.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, queryClient]);

  const network = useQuery<string[]>({
    queryKey: networkQueryKey(pubkey ?? ""),
    enabled: build && !!pubkey && relays.length > 0 && follows.length > 0,
    staleTime: NETWORK_TTL_MS,
    gcTime: Infinity,
    retry: 2,
    queryFn: ({ signal }) => fetchDiscoverNetwork(nostr, relays, pubkey!, follows, signal),
  });
  return pubkey ? network.data ?? NO_AUTHORS : NO_AUTHORS;
}

/**
 * The author allow-list gating every Discover feed, by scope: the viewer alone
 * ("you"), the viewer and their follows ("friends"), or ("network") the curated
 * list's members plus both plus one hop of the viewer's follows' follows.
 * Signed out, "you" and "friends" have nobody in them and read as "network",
 * which is then the curated list alone. There is deliberately no unfiltered
 * mode: empty means show nothing, and callers must NOT query when empty (some
 * relays treat empty `authors` as no filter).
 */
export function useDiscoverAuthors(
  requested: DiscoverScope,
  { buildNetwork = true }: { buildNetwork?: boolean } = {},
): {
  authors: string[];
  /** The curated list's members alone, for ranking. */
  packAuthors: string[];
  /** The viewer and their follows, for ranking. */
  trustedAuthors: string[];
  isLoading: boolean;
} {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const followList = useFollowList();

  const curation = useDiscoverCuration();
  const scope = user ? requested : "network";
  const usesPack = scope === "network" && curation.type !== "none";
  const network = useDiscoverNetwork(scope === "network" && buildNetwork);

  const packKey = packQueryKey(relays, curation);
  useKvQuerySeed<string[]>(packSeedKey(curation), usesPack ? packKey : undefined);

  const pack = useQuery<string[]>({
    queryKey: packKey,
    enabled: relays.length > 0 && usesPack,
    staleTime: 60 * 60 * 1000,
    queryFn: ({ signal }) => fetchFollowPack(nostr, relays, curation, signal),
  });

  const trustedAuthors = useMemo(() => {
    if (!user) return NO_AUTHORS;
    const set = new Set<string>([user.pubkey, ...(followList.data?.pubkeys ?? [])]);
    for (const pk of mutedPubkeys) set.delete(pk);
    return [...set].sort();
  }, [user, followList.data, mutedPubkeys]);

  const authors = useMemo(() => {
    if (scope === "you") return user ? [user.pubkey] : NO_AUTHORS;
    const set = new Set<string>(trustedAuthors);
    if (scope === "network") {
      if (usesPack) for (const pk of pack.data ?? []) set.add(pk);
      for (const pk of network) set.add(pk);
    }
    for (const pk of mutedPubkeys) set.delete(pk);
    // Sorted for a stable react-query key.
    return [...set].sort();
  }, [scope, usesPack, pack.data, network, user, trustedAuthors, mutedPubkeys]);

  return {
    authors,
    packAuthors: usesPack ? pack.data ?? NO_AUTHORS : NO_AUTHORS,
    trustedAuthors,
    // Only the pack read gates the feeds; follows and the network merely widen the
    // list and re-key later (`placeholderData` holds results meanwhile).
    isLoading: usesPack ? pack.isLoading : false,
  };
}

/**
 * Public Concord communities (kind-3314 announcements whose content is an invite link),
 * deduped by link signer, read by the allow-list's authors. No search filter:
 * announcements carry no metadata to match.
 */
export function useDiscoverCommunities(scope: DiscoverScope): DiscoverFeed<DiscoveredInvite> & {
  packAuthors: string[];
  trustedAuthors: string[];
} {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const relays = useDiscoverRelays();
  const queryClient = useQueryClient();
  const { authors, packAuthors, trustedAuthors, isLoading: authorsLoading } = useDiscoverAuthors(scope);

  // Warm load: seed last session's listings as the (stale) first page.
  useEffect(() => {
    if (relays.length === 0 || authors.length === 0) return;
    const key = directoryInfiniteKey(relays, authors);
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getArmadaDB().kv.get<CommunitiesSeed>(DIRECTORY_SEED_KV);
        if (cancelled || !stored?.invites?.length) return;
        if (queryClient.getQueryData(key) !== undefined) return;
        queryClient.setQueryData(
          key,
          { pages: [{ invites: stored.invites, cursor: undefined }], pageParams: [undefined] },
          { updatedAt: 0 },
        );
      } catch {
        // Best-effort: an unreadable seed just means a skeleton first paint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relays, authors, queryClient]);

  const result = useInfiniteQuery({
    ...communitiesInfiniteOptions(nostr, relays, authors),
    enabled: relays.length > 0 && !authorsLoading && authors.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const data = useMemo(() => {
    if (!result.data) return undefined;
    // The read is already by the allow-list; a seed or a held-over page may not be.
    const allowed = new Set(authors);
    const byLinkSigner = new Map<string, DiscoveredInvite>();
    const invites = result.data.pages.flatMap((p) => p.invites);
    for (const invite of invites.sort((a, b) => b.source.created_at - a.source.created_at)) {
      if (mutedPubkeys.has(invite.source.pubkey)) continue;
      if (!allowed.has(invite.source.pubkey)) continue;
      if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
    }
    return [...byLinkSigner.values()];
  }, [result.data, authors, mutedPubkeys]);

  // Error only when there is nothing painted to show.
  return {
    data,
    packAuthors,
    trustedAuthors,
    isLoading: result.isLoading || authorsLoading,
    isError: result.isError && !data,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    pageCount: result.data?.pages.length,
  };
}

/** Chunk warmup fires at 3s. */
const WARM_DELAY_MS = 3500;
const WARM_BUNDLE_COUNT = 12;

/**
 * Best-effort prefetch shortly after boot of the directory and first viewport's
 * invite bundles, under the same keys the page hooks use.
 */
export function useWarmDiscover(): void {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const queryClient = useQueryClient();
  // A stored network is used, but boot never builds one: that waits for the page.
  const { authors, packAuthors, isLoading: authorsLoading } = useDiscoverAuthors("network", { buildNetwork: false });
  const ready = relays.length > 0 && !authorsLoading && authors.length > 0;

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Same infinite-query entry and cursor options the page reads.
          const infinite = await queryClient.fetchInfiniteQuery({
            ...communitiesInfiniteOptions(nostr, relays, authors),
            staleTime: 30_000,
          });
          const invites = infinite.pages[0]?.invites ?? [];
          // Warm pack-authored listings first, matching the tab's ranking; the announcement
          // author stands in for the bundle owner.
          const packSet = new Set(packAuthors);
          const prioritized = [
            ...invites.filter((invite) => packSet.has(invite.source.pubkey)),
            ...invites.filter((invite) => !packSet.has(invite.source.pubkey)),
          ];
          await Promise.allSettled(
            prioritized.slice(0, WARM_BUNDLE_COUNT).map((invite) => {
              const parsed = parseInviteLink(invite.inviteUrl);
              if (!parsed) return Promise.resolve();
              return queryClient.fetchQuery({
                queryKey: ["discover", "invite-bundle", invite.linkSigner],
                staleTime: 5 * 60_000,
                retry: false,
                queryFn: () => resolveBundle(nostr, parsed, parsed.bootstrapRelays),
              });
            }),
          );
        } catch {
          // Warmup is best-effort; the page's own queries remain authoritative.
        }
      })();
    }, WARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [nostr, queryClient, relays, authors, packAuthors, ready]);
}

/** Coalesce Control peeks, each of which expands a card's author set, into one REQ. */
const ACTIVITY_DEBOUNCE_MS = 1000;

/**
 * Batched last-active probe for Discover cards: a `limit: 1` kind-1059 filter per
 * community, one REQ per relay set. Wrap metadata only, no decrypt.
 */
export function useDiscoverCommunityActivity(
  targets: DiscoverActivityTarget[],
): Record<string, number> {
  const { nostr } = useNostr();

  // Stable key: reorders of the same set must not refetch.
  const targetsKey = useMemo(() => {
    const rows = targets
      .filter((t) => t.authors.length > 0 && t.relays.length > 0)
      .map((t) => ({
        linkSigner: t.linkSigner,
        authors: [...t.authors].sort(),
        relays: [...t.relays].map(normalizeRelayUrl).filter(Boolean).sort(),
      }))
      .sort((a, b) => a.linkSigner.localeCompare(b.linkSigner));
    return JSON.stringify(rows);
  }, [targets]);

  const debouncedTargetsKey = useDebounce(targetsKey, ACTIVITY_DEBOUNCE_MS);

  const result = useQuery<Record<string, number>>({
    queryKey: ["discover", "community-activity", debouncedTargetsKey],
    enabled: debouncedTargetsKey !== "[]",
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const parsed = JSON.parse(debouncedTargetsKey) as DiscoverActivityTarget[];
      const now = Math.floor(Date.now() / 1000);
      const batches = discoverActivityBatches(parsed, now);
      if (batches.length === 0) return {};
      // Per relay, so the first to answer can't cut off one holding a newer wrap.
      const pages = await Promise.all(
        batches.map((b) => queryEachRelay(nostr, b.relays, [b.filters], signal)),
      );
      const events = pages.flatMap(mergeAnswers);
      return activityByLinkSigner(parsed, events, now);
    },
  });

  return result.data ?? {};
}

export interface DiscoverFeed<T> {
  data: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** Lets the sentinel auto-fetch page 2 after page 1. */
  pageCount: number | undefined;
}

/** NIP-30 emoji packs (kind 30030), cursor-paginated. */
export function useDiscoverEmojiPacks(query: string, scope: DiscoverScope): DiscoverFeed<NostrRumor> {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const relays = useDiscoverRelays();
  const { authors, isLoading: authorsLoading } = useDiscoverAuthors(scope);
  const debounced = useDebounce(query, 300);
  const q = debounced.trim();

  const result = useInfiniteQuery({
    queryKey: ["discover", "emoji-packs", relays, authors, q],
    enabled: relays.length > 0 && !authorsLoading && authors.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchDiscoverPage(nostr, relays, KIND_EMOJI_SET, q, authors, signal, pageParam),
    getNextPageParam: (lastPage: DiscoverFeedPage) => lastPage.cursor,
  });

  const data = useMemo(() => {
    if (!result.data) return undefined;
    const events = newestPerAddr(result.data.pages.flatMap((p) => p.events));
    let usable = events.filter((e) => emojiPackEntries(e).length > 0);
    if (q) {
      const needle = q.toLowerCase();
      usable = usable.filter((e) => {
        const shortcodes = emojiPackEntries(e).map((x) => x.shortcode).join(" ");
        return `${emojiPackName(e)} ${shortcodes}`.toLowerCase().includes(needle);
      });
    }
    // A held-over page (`placeholderData`) may predate the current allow-list.
    const allowed = new Set(authors);
    return usable.filter((e) => allowed.has(e.pubkey) && !mutedPubkeys.has(e.pubkey));
  }, [result.data, q, authors, mutedPubkeys]);

  return {
    data,
    isLoading: result.isLoading || authorsLoading,
    isError: result.isError && !data,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    pageCount: result.data?.pages.length,
  };
}

/** Shareable theme definitions (Ditto kind 36767), cursor-paginated. */
export function useDiscoverThemes(query: string, scope: DiscoverScope): DiscoverFeed<NostrRumor> {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const relays = useDiscoverRelays();
  const { authors, isLoading: authorsLoading } = useDiscoverAuthors(scope);
  const debounced = useDebounce(query, 300);
  const q = debounced.trim();

  const result = useInfiniteQuery({
    queryKey: ["discover", "themes", relays, authors, q],
    enabled: relays.length > 0 && !authorsLoading && authors.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchDiscoverPage(nostr, relays, THEME_DEFINITION_KIND, q, authors, signal, pageParam),
    getNextPageParam: (lastPage: DiscoverFeedPage) => lastPage.cursor,
  });

  const data = useMemo(() => {
    if (!result.data) return undefined;
    const events = newestPerAddr(result.data.pages.flatMap((p) => p.events));
    // Credited copies kept in someone's library aren't new themes.
    let usable = events.filter((e) => parseDittoTheme(e) !== null && !isAdoptedTheme(e));
    if (q) {
      const needle = q.toLowerCase();
      usable = usable.filter((e) => parseDittoTheme(e)?.title.toLowerCase().includes(needle));
    }
    // A held-over page (`placeholderData`) may predate the current allow-list.
    const allowed = new Set(authors);
    return usable.filter((e) => allowed.has(e.pubkey) && !mutedPubkeys.has(e.pubkey));
  }, [result.data, q, authors, mutedPubkeys]);

  return {
    data,
    isLoading: result.isLoading || authorsLoading,
    isError: result.isError && !data,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    pageCount: result.data?.pages.length,
  };
}
