import { useNostr } from '@nostrify/react';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect } from 'react';

import { MutedPubkeysContext } from '@/contexts/MutedPubkeysContext';
import { useEventStore } from '@/hooks/useEventStore';
import { authorQueryKey, parseAuthorEvent, type AuthorResult } from '@/lib/authorCache';
import { isUserBannedNow } from '@/lib/bannedUsers';
import { useIsUserBanned } from '@/lib/blocklistStore';
import { markProfileSettled } from '@/lib/profileLoading';
import { demandProfiles, hasProfileStamp } from '@/sync/profileSync';

type EventStore = ReturnType<typeof useEventStore>;

/**
 * Shared query options for a pubkey's kind-0 (`['author', pubkey]`). STORE-FIRST:
 * reads ArmadaDB only; the network side is the `profiles` sync topic
 * (`src/sync/profileSync.ts`), which pushes updates via `seedAuthorCache` — hence
 * no polling.
 */
export function authorQueryOptions(
  queryClient: QueryClient,
  eventStore: EventStore,
  pubkey: string | undefined,
) {
  return {
    queryKey: authorQueryKey(pubkey ?? ''),
    queryFn: async (): Promise<AuthorResult> => {
      if (!pubkey || isUserBannedNow(pubkey)) {
        return {};
      }

      const store = await eventStore;
      const [cached] = await store.query([{ kinds: [0], authors: [pubkey] }]);

      // Never downgrade: sync may have seeded a fresher profile meanwhile.
      const existing = queryClient.getQueryData<AuthorResult>(authorQueryKey(pubkey));
      if (existing?.event && (!cached || existing.event.created_at >= cached.created_at)) {
        return existing;
      }
      // A found profile settles when profileSync seeds it, after its data is in the cache.
      if (!cached && await hasProfileStamp(pubkey)) markProfileSettled(pubkey);
      return cached ? parseAuthorEvent(cached) : {};
    },
    enabled: !!pubkey,
    // Updates are pushed via `seedAuthorCache`; invalidation still forces a re-read.
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  };
}

/** A banned user's profile: nothing, whatever was cached before the ban. */
const BANNED: AuthorResult = {};
const asBanned = (): AuthorResult => BANNED;

/** A blocked user's profile without its images: their picture and banner are theirs to choose. */
function asBlocked(data: AuthorResult): AuthorResult {
  const metadata = data.metadata;
  if (!metadata?.picture && !metadata?.banner && !data.imeta) return data;
  const stripped = metadata && { ...metadata };
  delete stripped?.picture;
  delete stripped?.banner;
  return { ...data, metadata: stripped, imeta: undefined };
}

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const banned = useIsUserBanned()(pubkey);
  const blocked = useContext(MutedPubkeysContext).mutedPubkeys.has(pubkey ?? '');

  // Declare demand to the profile sync topic for the life of the mount.
  useEffect(() => {
    if (!pubkey) return;
    return demandProfiles([pubkey], { nostr, queryClient });
  }, [pubkey, nostr, queryClient]);

  return useQuery<AuthorResult>({
    ...authorQueryOptions(queryClient, eventStore, pubkey),
    select: banned ? asBanned : blocked ? asBlocked : undefined,
  });
}
