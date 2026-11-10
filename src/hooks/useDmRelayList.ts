import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { accountDataRelays, effectiveDmRelays, selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import {
  newestCanonicalSelfList,
  readStoredCanonicalSelfLists,
} from "@/lib/canonicalSelfList";
import { normalizeRelayUrl } from "@/lib/platform";
import {
  KIND_RELAY_LIST,
  newestRelayList,
  parseRelayList,
  queryExplicitRelays,
  queryExplicitRelaysWithStatus,
  uniqueRelayUrls,
} from "@/lib/nip65";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/** NIP-17 DM relay list: a plain replaceable event whose `relay` tags hold the URLs. */
export const KIND_DM_RELAYS = 10050;

export function parseDmRelays(event: { tags: string[][] } | undefined): string[] {
  if (!event) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const [name, url] of event.tags) {
    if (name !== "relay" || !url) continue;
    const n = normalizeRelayUrl(url);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    urls.push(n);
  }
  return urls;
}

export interface DmRelayListQuery {
  event: NostrRumor | null;
  relays: string[];
  /** True only when every current self-state relay completed the wire read. */
  wireReady?: boolean;
}

type DmRelayQueryClient = Parameters<typeof queryExplicitRelays>[0];

/**
 * Per-round budget: the rounds are sequential, and a shared deadline would let a slow app
 * relay starve the round that looks beyond the app relays.
 */
const DISCOVERY_ROUND_MS = 6000;

/** Newest kind-10050 event for one peer, using NIP-01 replaceable ordering. */
function newestDmRelayList(events: NostrEvent[], peer: string): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === KIND_DM_RELAYS && event.pubkey === peer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/**
 * Discover a peer's NIP-17 inbox: query configured discovery relays independently, then
 * (only when `followPeerRelays`) the peer's NIP-65 write relays; newest event wins, and a
 * newer empty list is authoritative.
 * `followPeerRelays` is a disclosure decision: dialing peer-named relays answers NIP-42 with
 * the viewer's key, revealing IP + pubkey to them.
 */
export async function discoverDmRelaysFor(
  nostr: DmRelayQueryClient,
  peer: string,
  discoveryRelays: Iterable<string>,
  signal: AbortSignal,
  { followPeerRelays }: { followPeerRelays: boolean },
): Promise<string[]> {
  const round = () => AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_ROUND_MS)]);

  const discoveryEvents = await queryExplicitRelays(
    nostr,
    discoveryRelays,
    [
      { kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 },
      { kinds: [KIND_RELAY_LIST], authors: [peer], limit: 1 },
    ],
    round(),
  );

  const relayList = followPeerRelays
    ? newestRelayList(discoveryEvents.filter((event) => event.pubkey === peer))
    : undefined;
  const peerWriteRelays = relayList
    ? parseRelayList(relayList).filter((relay) => relay.write).map((relay) => relay.url)
    : [];
  const peerEvents = peerWriteRelays.length > 0
    ? await queryExplicitRelays(
        nostr,
        peerWriteRelays,
        [{ kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 }],
        round(),
      )
    : [];

  return parseDmRelays(newestDmRelayList([...discoveryEvents, ...peerEvents], peer));
}

/** The user's NIP-17 DM relay list (kind 10050), read and written by Settings. */
export function useDmRelayList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["dm-relay-list", user?.pubkey];

  const query = useQuery<DmRelayListQuery>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
      const selfRelays = uniqueRelayUrls(
        selfStateRelays(config, user!.pubkey),
      ).sort();
      const [wireRead, stored] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          selfRelays,
          [{ kinds: [KIND_DM_RELAYS], authors: [user!.pubkey], limit: 1 }],
          deadline,
        ),
        readStoredCanonicalSelfLists(
          eventStore,
          user!.pubkey,
          [KIND_DM_RELAYS],
          deadline,
        ),
      ]);
      const cached = queryClient.getQueryData<DmRelayListQuery>(queryKey);
      const event = newestCanonicalSelfList(
        [
          ...wireRead.events,
          ...stored.events,
          ...(cached?.event ? [cached.event] : []),
        ],
        user!.pubkey,
        KIND_DM_RELAYS,
      ) ?? null;
      const answered = new Set(wireRead.answered);
      return {
        event,
        relays: parseDmRelays(event ?? undefined),
        // A missing relay may hold a newer event, so this snapshot can't authorize pruning.
        wireReady: selfRelays.length > 0
          && selfRelays.every((relay) => answered.has(relay)),
      };
    },
    staleTime: 60_000,
  });

  const publish = useMutation({
    mutationFn: async (relays: string[]) => {
      if (!user) throw new Error(t({ id: "useDmRelayList.notLoggedIn", defaultMessage: "Not logged in" }));
      const urls = relays
        .map((r) => normalizeRelayUrl(r))
        .filter((r): r is string => !!r);
      const targets = uniqueRelayUrls(selfStateRelays(config, user.pubkey)).sort();
      const deadline = AbortSignal.timeout(8_000);
      const [response, stored] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          targets,
          [{ kinds: [KIND_DM_RELAYS], authors: [user.pubkey], limit: 1 }],
          deadline,
        ),
        readStoredCanonicalSelfLists(
          eventStore,
          user.pubkey,
          [KIND_DM_RELAYS],
          deadline,
        ),
      ]);
      if (response.answered.length === 0) {
        throw new Error(
          t({ id: "useDmRelayList.unconfirmed", defaultMessage: "Could not confirm your current DM relay list; no changes were published" }),
        );
      }
      const cached = queryClient.getQueryData<DmRelayListQuery>(queryKey);
      const answered = new Set(response.answered);
      const wireReady = targets.length > 0
        && targets.every((relay) => answered.has(relay));
      const prev = newestCanonicalSelfList(
        [
          ...response.events,
          ...stored.events,
          ...(cached?.event ? [cached.event] : []),
        ],
        user.pubkey,
        KIND_DM_RELAYS,
      ) ?? null;
      const tags = [
        ...(prev?.tags.filter(([name]) => name !== "relay" && name !== "client") ?? []),
        ...urls.map((url) => ["relay", url]),
      ];
      const createdAt = prev
        ? Math.max(nowSecs(), prev.created_at + 1)
        : nowSecs();

      await publishEvent({
        kind: KIND_DM_RELAYS,
        content: prev?.content ?? "",
        tags,
        created_at: createdAt,
        prev: prev ?? undefined,
        relays: response.answered,
        inheritPendingTargets: false,
        onSigned: (event) => {
          queryClient.setQueryData<DmRelayListQuery>(queryKey, {
            event,
            relays: urls,
            wireReady,
          });
        },
      });
      // A partial read must not stay fresh as though it authorized pruning; refetch now.
      if (!wireReady) {
        void queryClient.invalidateQueries({ queryKey });
      }
      return urls;
    },
  });

  return {
    relays: query.data?.relays ?? [],
    event: query.data?.event ?? null,
    isLoading: query.isLoading,
    /**
     * Whether the relay set is an authoritative result; `isLoading` is also false after an
     * error, which must not become an authoritative empty set.
     */
    isReady: query.data?.wireReady === true,
    hasList: (query.data?.relays.length ?? 0) > 0,
    refetch: query.refetch,
    publish: publish.mutateAsync,
  };
}

/**
 * Another user's kind-10050 inbox relays. Follows their NIP-65 write relays only for
 * KNOWN peers. `[]` when none; callers fall back to their own DM relays.
 */
export function useDmRelaysFor(peer: string | undefined): string[] {
  const peers = useMemo(() => (peer ? [peer] : []), [peer]);
  const byPeer = useDmRelaysForAll(peers);
  return byPeer.get(peer ?? "") ?? EMPTY_RELAYS;
}

/** Stable identity for peerless renders. */
const EMPTY_RELAYS: string[] = [];

/**
 * Every recipient's NIP-17 inbox, keyed by pubkey (a group sends one wrap per inbox).
 * Resolved concurrently under one key; `followPeerRelays` stays per peer — see
 * {@link discoverDmRelaysFor}.
 */
export function useDmRelaysForAll(peers: readonly string[]): Map<string, string[]> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { isKnown } = useKnownDmPeers();
  const discoveryRelays = useMemo(
    () => uniqueRelayUrls([
      ...accountDataRelays(config, user?.pubkey),
      ...effectiveDmRelays(config),
    ]),
    [config, user?.pubkey],
  );
  const relayKey = discoveryRelays.join(",");

  // Sorted for one cache entry per set; known-flags included so a promoted peer re-runs
  // discovery.
  const targets = useMemo(
    () => [...new Set(peers)].filter(Boolean).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peers.join(",")],
  );
  const knownKey = targets.map((peer) => (isKnown(peer, false) ? "1" : "0")).join("");

  const query = useQuery<Record<string, string[]>>({
    queryKey: ["dm-relay-list", "peers", targets.join(","), relayKey, knownKey],
    enabled: targets.length > 0,
    staleTime: 5 * 60 * 1000,
    // Deliberately NOT React Query's `signal`: reading it cancels the query on unmount and
    // discards the result. Rounds are already bounded by DISCOVERY_ROUND_MS.
    queryFn: async () => {
      const signal = new AbortController().signal;
      const settled = await Promise.all(
        targets.map(async (peer) => {
          const relays = await discoverDmRelaysFor(nostr, peer, discoveryRelays, signal, {
            followPeerRelays: isKnown(peer, false),
          }).catch(() => [] as string[]);
          return [peer, relays] as const;
        }),
      );
      return Object.fromEntries(settled);
    },
  });

  return useMemo(() => new Map(Object.entries(query.data ?? {})), [query.data]);
}
