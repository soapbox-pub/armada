import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { t } from "@/i18n";
import {
  newestCanonicalSelfList,
  readStoredCanonicalSelfLists,
} from "@/lib/canonicalSelfList";
import { queryExplicitRelays, queryExplicitRelaysWithStatus } from "@/lib/nip65";
import { normalizeRelayUrl } from "@/lib/platform";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
  type SearchRelayList,
} from "@/lib/searchRelayList";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

export interface SearchRelayListQuery extends SearchRelayList {
  event: NostrRumor | null;
}
/** Read and explicitly edit the user's canonical NIP-51 search-relay list. */
export function useSearchRelayList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const queryKey = ["search-relay-list", user?.pubkey];

  const query = useQuery<SearchRelayListQuery>({
    queryKey,
    enabled: Boolean(user),
    queryFn: async ({ signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
      const [wireEvents, stored] = await Promise.all([
        queryExplicitRelays(
          nostr,
          selfStateRelays(config, user!.pubkey),
          [{ kinds: [KIND_SEARCH_RELAYS], authors: [user!.pubkey], limit: 1 }],
          deadline,
        ),
        readStoredCanonicalSelfLists(
          eventStore,
          user!.pubkey,
          [KIND_SEARCH_RELAYS],
          deadline,
        ),
      ]);
      const cached = queryClient.getQueryData<SearchRelayListQuery>(queryKey);
      const event = newestCanonicalSelfList(
        [
          ...wireEvents,
          ...stored.events,
          ...(cached?.event ? [cached.event] : []),
        ],
        user!.pubkey,
        KIND_SEARCH_RELAYS,
      ) ?? null;
      const decoded = await readSearchRelayList(event, user!.signer);
      // A transient signer refusal isn't an empty replacement; keep the last decryptable copy.
      if (decoded.decryptFailed && cached && !cached.decryptFailed) return cached;
      return { event, ...decoded };
    },
    staleTime: 60_000,
  });

  const publish = useMutation({
    mutationFn: async (input: string[]) => {
      if (!user) throw new Error(t({ id: "useSearchRelayList.notLoggedIn", defaultMessage: "Not logged in" }));
      const desired = [...new Set(input
        .map((relay) => normalizeRelayUrl(relay))
        .filter((relay): relay is string => Boolean(relay)))];

      const relays = selfStateRelays(config, user.pubkey);
      const deadline = AbortSignal.timeout(8_000);
      const [response, stored] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          relays,
          [{ kinds: [KIND_SEARCH_RELAYS], authors: [user.pubkey], limit: 1 }],
          deadline,
        ),
        readStoredCanonicalSelfLists(
          eventStore,
          user.pubkey,
          [KIND_SEARCH_RELAYS],
          deadline,
        ),
      ]);
      if (response.answered.length === 0) {
throw new Error(t({ id: "useSearchRelayList.unconfirmed", defaultMessage: "Could not confirm your current search-relay list; no changes were published" }));
      }
      const cached = queryClient.getQueryData<SearchRelayListQuery>(queryKey);
      const prev = newestCanonicalSelfList(
        [
          ...response.events,
          ...stored.events,
          ...(cached?.event ? [cached.event] : []),
        ],
        user.pubkey,
        KIND_SEARCH_RELAYS,
      ) ?? null;

      const current = await readSearchRelayList(prev, user.signer);
      if (current.decryptFailed) {
        throw new Error(t({ id: "useSearchRelayList.decryptFailed", defaultMessage: "Your private search-relay list could not be decrypted; no changes were published" }));
      }

      const oldPublic = new Set(current.publicRelays);
      const oldPrivate = new Set(current.privateRelays);
      const privateByDefault = Boolean(prev?.content) && oldPublic.size === 0;
      const publicRelays: string[] = [];
      const privateRelays: string[] = [];
      for (const relay of desired) {
        if (oldPublic.has(relay)) publicRelays.push(relay);
        else if (oldPrivate.has(relay) || privateByDefault) privateRelays.push(relay);
        else publicRelays.push(relay);
      }

      const tags = [
        ...(prev?.tags.filter(([name]) => name !== "relay" && name !== "client") ?? []),
        ...publicRelays.map((relay) => ["relay", relay]),
      ];
      const privateTags = [
        ...current.privateTags.filter(([name]) => name !== "relay"),
        ...privateRelays.map((relay) => ["relay", relay]),
      ];
      const content = privateTags.length > 0
        ? await user.signer.nip44!.encrypt(user.pubkey, JSON.stringify(privateTags))
        : "";
      const createdAt = prev
        ? Math.max(nowSecs(), prev.created_at + 1)
        : nowSecs();

      let signed: NostrEvent | null = null;
      await publishEvent({
        kind: KIND_SEARCH_RELAYS,
        content,
        tags,
        created_at: createdAt,
        prev: prev ?? undefined,
        relays: response.answered,
        inheritPendingTargets: false,
        onSigned: (event) => {
          signed = event;
          queryClient.setQueryData<SearchRelayListQuery>(queryKey, {
            event,
            relays: desired,
            publicRelays,
            privateRelays,
            privateTags,
            decryptFailed: false,
          });
        },
      });
      return { event: signed, relays: desired };
    },
  });

  return {
    relays: query.data?.relays ?? [],
    event: query.data?.event ?? null,
    decryptFailed: query.data?.decryptFailed ?? false,
    isLoading: query.isLoading,
    refetch: query.refetch,
    publish: publish.mutateAsync,
  };
}
