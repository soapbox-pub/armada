import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { useEventStore } from "@/hooks/useEventStore";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import {
  addToList,
  assertListBounds,
  communityListFoldKey,
  EMPTY_COMMUNITY_LIST,
  isExcluded,
  isLive,
  liveEntries,
  markExcluded,
  mergeCommunityLists,
  refreshChannels,
  refreshCurrent,
  refreshRelays,
  rehydrateCommunity,
  removeFromList,
  setControlRoot,
  type CommunityList,
  type PersistedCommunityList,
  type CommunityListEntry,
  type JoinMaterial,
} from "@/concord-v2/lib/communityList";
import { STOCK_RELAYS } from "@/concord-v2/lib/invite";
import { KIND_COMMUNITY_LIST } from "@/concord-v2/lib/kinds";
import { NIP44_MAX_PLAINTEXT } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { logSync } from "@/lib/syncLog";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * The user's Concord V2 Community List — the kind-13302 replaceable event,
 * NIP-44-encrypted to self (CORD-02 §8). This entry IS the vault: it holds the
 * community_root and private-channel keys, so it is the only durable record of
 * V2 membership. Read-merge-written deterministically so devices converge.
 *
 * Mirrors V1's `useConcordList` discipline: plaintext-first boot from the
 * folded cache (no signer round-trip), decrypt-once memoization, never letting
 * an undecryptable read clobber a populated list, serialized mutations with
 * strictly-increasing `created_at`.
 */

export type ListData = { event: NostrRumor | null; list: CommunityList; decryptFailed?: boolean };
export type PersistedList = PersistedCommunityList;

export const listQueryKey = (pubkey: string | undefined) => ["concord2", "list", pubkey] as const;
const foldKeyOf = communityListFoldKey;

/** Decode-once memo for the list decrypt, keyed by event id. */
const listDecryptMemo = new Map<string, Promise<{ list: CommunityList; decryptFailed: boolean }>>();

async function readListEvent(
  event: NostrRumor | null,
  signer: NUser["signer"] | undefined,
  selfPubkey: string,
): Promise<{ list: CommunityList; decryptFailed: boolean }> {
  if (!event?.content) return { list: EMPTY_COMMUNITY_LIST, decryptFailed: false };
  if (!signer?.nip44) return { list: EMPTY_COMMUNITY_LIST, decryptFailed: true };

  const cached = listDecryptMemo.get(event.id);
  if (cached) return cached;

  const nip44 = signer.nip44;
  const work = (async () => {
    try {
      const decrypted = await nip44.decrypt(selfPubkey, event.content);
      const parsed = JSON.parse(decrypted) as Partial<CommunityList>;
      return {
        list: {
          ...parsed,
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
        } as CommunityList,
        decryptFailed: false,
      };
    } catch (err) {
      console.warn("Failed to decrypt Concord V2 community list:", err);
      listDecryptMemo.delete(event.id); // let a later call retry a transient failure
      return { list: EMPTY_COMMUNITY_LIST, decryptFailed: true };
    }
  })();
  listDecryptMemo.set(event.id, work);
  return work;
}

/**
 * Fetch the newest kind-13302 list event and merge it into the cached list.
 * Shared by the hook's queryFn and the post-login gate. Merge-never-replace
 * so a short relay read can't drop rooms; persists the merged plaintext to
 * the folded cache.
 */
export async function syncCommunityList2(
  nostr: {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
    group?(relays: string[]): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> };
  },
  user: NUser,
  queryClient: QueryClient,
  signal?: AbortSignal,
): Promise<ListData> {
  const queryKey = listQueryKey(user.pubkey);
  const listFilter: NostrFilter[] = [{ kinds: [KIND_COMMUNITY_LIST], authors: [user.pubkey], limit: 1 }];
  let events = await nostr.query(
    listFilter,
    { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]) },
  );
  if (events.length === 0 && nostr.group) {
    // The vault can live only on the stock CORD relays when the user's own
    // relays refuse kind 13302 (see useUpdateCommunityList2's publish
    // fallback), so an empty pool read checks them before concluding there
    // is no list.
    events = await nostr.group([...STOCK_RELAYS])
      .query(listFilter, { signal: AbortSignal.timeout(8000) })
      .catch(() => []);
  }
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const prev = queryClient.getQueryData<ListData>(queryKey);

  if (latest && prev?.event?.id === latest.id && !prev.decryptFailed) return prev;

  const { list, decryptFailed } = await readListEvent(latest, user.signer, user.pubkey);
  logSync(
    "list2",
    `relay fetch: event=${latest ? latest.id.slice(0, 8) : "none"} entries=${list.entries.length} decryptFailed=${decryptFailed}`,
  );
  if (decryptFailed) {
    // Never let an undecryptable read clobber a populated list (the keys
    // live here; a wrongful empty would vanish the rooms).
    return prev ?? { event: latest, list: EMPTY_COMMUNITY_LIST, decryptFailed: true };
  }

  // Merge, never replace: a transient short relay read can't drop rooms;
  // the deterministic merge still honors genuine tombstones.
  const merged = prev ? mergeCommunityLists(prev.list, list) : list;
  const next: ListData = { event: latest, list: merged, decryptFailed: false };
  if (latest) void writeFolded(foldKeyOf(user.pubkey), { event: latest, list: merged } satisfies PersistedList);
  return next;
}

/** Query the latest V2 Community List, plaintext-cache-first. */
export function useCommunityList2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = listQueryKey(user?.pubkey);
  const foldKey = user ? foldKeyOf(user.pubkey) : null;

  // Plaintext-first boot: read the previously-decrypted list without a signer
  // (a remote signer's nip44 can be unavailable for seconds on reopen and the
  // rail must not blank meanwhile). Falls back to a one-time decrypt of the
  // locally-mirrored event once the signer is ready.
  useEffect(() => {
    if (!user || !foldKey) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const persisted = await readFolded<PersistedList>(foldKey);
      if (cancelled) return;
      if (persisted) {
        logSync("list2", `boot from folded cache: ${persisted.list.entries.length} entry(ies)`);
        queryClient.setQueryData<ListData>(queryKey, { event: persisted.event ?? null, list: persisted.list });
        return;
      }
      if (!user.signer.nip44) return;
      const store = await eventStore;
      const [cached] = await store.query([{ kinds: [KIND_COMMUNITY_LIST], authors: [user.pubkey] }]);
      if (cancelled || !cached) return;
      const { list, decryptFailed } = await readListEvent(cached, user.signer, user.pubkey);
      if (cancelled || decryptFailed) return;
      if (!queryClient.getQueryData(queryKey)) {
        queryClient.setQueryData<ListData>(queryKey, { event: cached, list });
      }
      void writeFolded(foldKey, { event: cached, list } satisfies PersistedList);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, user?.signer.nip44, eventStore, queryClient]);

  return useQuery<ListData>({
    queryKey,
    enabled: Boolean(user?.signer.nip44),
    staleTime: 30_000,
    queryFn: ({ signal }) => syncCommunityList2(nostr, user!, queryClient, signal),
  });
}

/** A mutation against the list (read-modify-write, deterministic, serialized). */
export type CommunityListAction =
  | { type: "add"; entry: CommunityListEntry }
  | { type: "remove"; communityId: string; removedAt?: number }
  | { type: "exclude"; communityId: string; epoch: number }
  | { type: "refresh-current"; current: JoinMaterial }
  | {
      type: "refresh-channels";
      communityId: string;
      channels: JoinMaterial["channels"];
      /** Channels a rotation cut me out of, with the epoch that did it. */
      cuts?: CommunityListEntry["channel_cuts"];
    }
  | { type: "refresh-relays"; communityId: string; relays: string[] }
  | {
      /** A verified `control_wrap` adoption (CORD-04 §3) — see {@link setControlRoot}. */
      type: "set-control-root";
      communityId: string;
      epoch: number;
      controlRootHex: string;
    };

function applyAction(list: CommunityList, action: CommunityListAction): CommunityList {
  switch (action.type) {
    case "add":
      return addToList(list, action.entry);
    case "remove":
      return removeFromList(list, action.communityId, action.removedAt ?? Date.now());
    case "exclude":
      return markExcluded(list, action.communityId, action.epoch);
    case "refresh-current":
      return refreshCurrent(list, action.current);
    case "refresh-channels":
      return refreshChannels(list, action.communityId, action.channels, action.cuts);
    case "refresh-relays":
      return refreshRelays(list, action.communityId, action.relays);
    case "set-control-root":
      return setControlRoot(list, action.communityId, action.epoch, action.controlRootHex);
  }
}

export function useUpdateCommunityList2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    // Serialize every list mutation onto one queue so back-to-back joins can't
    // interleave read-modify-writes and drop each other's entries.
    scope: { id: "concord2-list" },
    mutationFn: async (action: CommunityListAction) => {
      if (!user) throw new Error("User is not logged in");
      if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");

      // Read-modify-write against fresh relay state. An empty pool read also
      // checks the stock CORD relays: the publish below falls back to them
      // when the user's own relays refuse the kind, so the newest list may
      // live only there.
      const listFilter: NostrFilter[] = [{ kinds: [KIND_COMMUNITY_LIST], authors: [user.pubkey], limit: 1 }];
      let events = await nostr.query(listFilter, { signal: AbortSignal.timeout(8000) });
      if (events.length === 0) {
        events = await nostr.group([...STOCK_RELAYS])
          .query(listFilter, { signal: AbortSignal.timeout(8000) })
          .catch(() => []);
      }
      const prev = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const { list: relayList, decryptFailed } = await readListEvent(prev, user.signer, user.pubkey);
      if (decryptFailed) {
        throw new Error(
          "Couldn't read your existing communities (decryption failed); not saving to avoid losing room keys.",
        );
      }

      // Fold in the local optimistic cache (replaceable propagation lags).
      const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
      const current = cached ? mergeCommunityLists(cached.list, relayList) : relayList;
      const next = applyAction(current, action);
      assertListBounds(next);

      const plaintext = JSON.stringify(next);
      if (new TextEncoder().encode(plaintext).length > NIP44_MAX_PLAINTEXT) {
        throw new Error("Your community list no longer fits its encrypted envelope; leave a community first.");
      }

      // Force created_at strictly past the previous event: replaceables
      // tie-break on lowest id at equal created_at, not newest content.
      const createdAt = Math.max(Math.floor(Date.now() / 1000), (prev?.created_at ?? 0) + 1);
      const content = await user.signer.nip44.encrypt(user.pubkey, plaintext);
      const event = await user.signer.signEvent({
        kind: KIND_COMMUNITY_LIST,
        content,
        tags: [],
        created_at: createdAt,
      });

      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event, list: next });
      void writeFolded(foldKeyOf(user.pubkey), { event, list: next } satisfies PersistedList);
      try {
        await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      } catch {
        // The pool publish needs only ONE configured relay to accept, but a
        // user whose relays all refuse kind 13302 (kind whitelists, auth
        // gates, outages) would strand every create/join here with a raw
        // "All promises were rejected". The list is the vault, so fall back
        // to the stock CORD relays, which are write-open for Concord kinds.
        const results = await Promise.allSettled(
          STOCK_RELAYS.map((url) => nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error("No relay accepted your community list update.");
        }
      }
      return next;
    },
    onSuccess: (_next, action) => {
      // Leaving purges the rail-arrangement key too, so a later rejoin doesn't
      // reappear inside the folder it used to live in.
      if (action.type === "remove") removeRailKey(`c2:${action.communityId}`);
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
    },
  });
}

/** The LIVE V2 membership entries (tombstoned ones stay in the doc but not here). */
export function useLiveCommunities2(): CommunityListEntry[] {
  const { data } = useCommunityList2();
  return useMemo(() => (data ? liveEntries(data.list) : []), [data]);
}

/**
 * Rehydrate a runtime {@link CommunityV2} from the list entry for `idHex`,
 * verified against the owner commitment, with the deployment's app relays
 * unioned in (community relays first). Stable identity across renders.
 */
export function useCommunity2(idHex: string | undefined): CommunityV2 | undefined {
  const entry = useCommunityEntry2(idHex);
  return useMemo(() => (entry ? rehydrateCommunity(entry) : undefined), [entry]);
}

/**
 * The raw list entry for a community (needed to round-trip unknown fields).
 *
 * Resolves only LIVE memberships. A tombstoned entry stays in the list
 * document forever — that's how a leave propagates — but it must not resolve
 * here, or `/c/<id>` would still mount the full community page for a community
 * the user left, arming every watcher on it. Two of those watchers
 * (`useRekeyWatch2` adopting a Refounding, `useStrandedRecovery2` re-resolving
 * the invite) bump `added_at`, which is exactly what makes a leave undo itself.
 */
export function useCommunityEntry2(idHex: string | undefined): CommunityListEntry | undefined {
  const { data } = useCommunityList2();
  return useMemo(() => {
    if (!idHex || !data) return undefined;
    if (!isLive(data.list, idHex)) return undefined;
    return data.list.entries.find((e) => e.community_id === idHex);
  }, [data, idHex]);
}

/**
 * Whether I've been EXCLUDED (kicked/banned) from this community at its current
 * epoch — the icon stays, but the community is read-only until a Refounding
 * re-includes me or I leave.
 */
export function useIsExcluded2(idHex: string | undefined): boolean {
  const entry = useCommunityEntry2(idHex);
  return useMemo(() => (entry ? isExcluded(entry) : false), [entry]);
}
