import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { accountDataRelays, type AppConfig } from "@/contexts/AppContext";
import {
  listQueryKey,
  type FragSet,
  type ListData,
  type PersistedList,
} from "@/concord/hooks/useCommunityList";
import {
  decodeInviteListEvents,
  inviteListFoldKey,
  inviteListKey,
  readPersistedInviteList,
  type PersistedInviteList,
} from "@/concord/hooks/useInvites";
import {
  communityListFoldKey,
  mergeCommunityLists,
} from "@/concord/lib/communityList";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";
import { mergeInviteLists, type InviteList } from "@/concord/lib/invite";
import { useAppContext } from "@/hooks/useAppContext";
import { t } from "@/i18n";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import { markConfigSynced } from "@/hooks/useConfigDocSync";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNip65RelaySetup } from "@/hooks/useNip65RelaySetup";
import {
  fetchPortableWireState,
  newestPortableAddressableEvents,
} from "@/hooks/usePublishPortableSetup";
import {
  decodeDmConversationIndexEvents,
  dmConversationIndexSyncQueryKey,
  type DecodedDmConversationIndex,
} from "@/hooks/useDmConversationIndexSync";
import { hydrateDmConversationIndexRecords } from "@/hooks/useDmConversationIndex";
import {
  decodeFavoriteGifEvents,
  favoriteGifsSyncQueryKey,
  type DecodedFavoriteGifs,
} from "@/hooks/useFavoriteGifsSync";
import { hydrateFavoriteGifRecords } from "@/hooks/useFavoriteGifs";
import {
  readSettingsDocChecked,
  readSettingsDocSources,
  settingsDocQueryKey,
  type SettingsDocQueryData,
} from "@/hooks/useSettingsDoc";
import { settingsKeysQueryKey } from "@/hooks/useSettingsKeys";
import {
  resolveGroupListRead,
  type UserGroupListQuery,
} from "@/hooks/useUserGroupList";
import { parseBlossomServerList } from "@/lib/blossom";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import { groupListFoldKey, type PersistedGroupList } from "@/lib/nip29ServerCache";
import {
  parseRelayList,
  queryExplicitRelays,
  uniqueRelayUrls,
} from "@/lib/nip65";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_KIND,
  type SettingsDocName,
} from "@/lib/settingsDocs";
import { docToConfigPatch, CONFIG_KEYS_BY_DOC, type ConfigDocName } from "@/lib/syncedConfig";
import { SELF_SYNC_TOPIC_TAGS } from "@/lib/selfSyncKinds";
import { derivedDocOf, type SettingsKeyring } from "@/lib/settingsKeys";
import { newestSettingsRoot } from "@/lib/settingsRoot";
import { resolveSettingsKeys, type SettingsKeys } from "@/lib/settingsRootStore";
import type { NostrRumor } from "@/lib/nostrRumor";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import type { MetadataDoc } from "@/lib/schemas";

const PULL_TIMEOUT_MS = 8_000;

export interface PortableSetupPullResult {
  /** Distinct portable records found, including the NIP-65 map. */
  records: number;
  sources: number;
  /** Whether the metadata document carried the Voice-page server. */
  voiceServer: boolean;
  /** The signer can't decrypt, so private records (10009, 10007, settings) weren't read. */
  publicOnly: boolean;
}

interface PulledSettingsDoc {
  name: SettingsDocName;
  event: NostrEvent;
  doc: Record<string, unknown>;
}

function newest(
  events: NostrEvent[],
  pubkey: string,
  kind: number,
): NostrEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey && event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export function nip01VersionIsNewer(
  candidate: Pick<NostrEvent, "created_at" | "id">,
  current: Pick<NostrEvent, "created_at" | "id"> | undefined,
): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

function knownWriteRelays(config: AppConfig, pubkey: string): string[] {
  if (config.relayMetadata.pubkey !== pubkey) return [];
  return config.relayMetadata.relays
    .filter((relay) => relay.write)
    .map((relay) => relay.url);
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Explicitly re-read portable setup from NIP-65 relays (the read half of
 * {@link usePublishPortableSetup}). Never signs or publishes; decrypts everything before writing
 * anything (atomic); an empty read clears nothing.
 */
export function usePullPortableSetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { discover, adopt } = useNip65RelaySetup();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const [isPending, setIsPending] = useState(false);

  const pull = useCallback(async (): Promise<PortableSetupPullResult> => {
    if (!user) throw new Error(t({ id: "usePullPortableSetup.notLoggedIn", defaultMessage: "Not logged in" }));
    const { signer } = user;
    // Without NIP-44, still restore the public records.
    const canDecrypt = Boolean(signer.nip44);

    setIsPending(true);
    try {
      const store = await eventStore;
      let localCanonical: NostrEvent[] = [];
      try {
        localCanonical = (await store.query([{
          kinds: [10002, KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
          authors: [user.pubkey],
        }])) as NostrEvent[];
      } catch {
        // The explicit pull still works from wire-only state when ArmadaDB is
        // temporarily unavailable.
      }
      const currentWriteRelays = knownWriteRelays(config, user.pubkey);
      const localRelayEvent = newest(localCanonical, user.pubkey, 10002);
      const localRelayWriteRelays = localRelayEvent
        ? parseRelayList(localRelayEvent)
            .filter((relay) => relay.write)
            .map((relay) => relay.url)
        : [];
      const discovered = await discover([...currentWriteRelays, ...localRelayWriteRelays]);
      const pointerEvent = newest(
        [
          ...localCanonical.filter((event) => event.kind === 10002),
          ...(discovered ? [discovered.event] : []),
        ],
        user.pubkey,
        10002,
      );
      const pointerRelays = pointerEvent ? parseRelayList(pointerEvent) : [];
      const discovery = pointerEvent && pointerRelays.length > 0
        ? { event: pointerEvent, relays: pointerRelays }
        : discovered;
      const discoveredWriteRelays = discovery?.relays
        .filter((relay) => relay.write)
        .map((relay) => relay.url) ?? [];
      const sources = uniqueRelayUrls([
        ...accountDataRelays(config, user.pubkey),
        ...currentWriteRelays,
        ...discoveredWriteRelays,
      ]);
      if (sources.length === 0) {
        throw new Error(t({ id: "usePullPortableSetup.noWriteRelays", defaultMessage: "No NIP-65 write relays are available to pull from" }));
      }

      let communityEvents: NostrEvent[] = [];
      let communitySet: FragSet | null = null;
      let events: NostrEvent[];
      let keys: SettingsKeys = { keyring: null, previous: [] };
      let settingsEditions: NostrEvent[] = [];
      if (canDecrypt) {
        keys = await resolveSettingsKeys(store, signer, user.pubkey);
        const wire = await fetchPortableWireState(
          nostr,
          user,
          sources,
          AbortSignal.timeout(PULL_TIMEOUT_MS),
          [],
          true,
          [],
          keys.keyring?.authors,
        );
        events = wire.events;
        communityEvents = wire.communityEvents;
        communitySet = wire.communitySet;
        // The root may be new to this device, and it addresses documents not yet read.
        const root = newestSettingsRoot(events, user.pubkey);
        if (root) {
          await store.event(root).catch(() => undefined);
          const heldKeyring = keys.keyring?.id;
          keys = await resolveSettingsKeys(store, signer, user.pubkey);
          if (!keys.keyring) {
            throw new Error(t({ id: "usePullPortableSetup.rootDecryptFailed", defaultMessage: "Your settings root could not be decrypted; nothing was restored" }));
          }
          if (keys.keyring.id !== heldKeyring) {
            events = [...events, ...await queryExplicitRelays(
              nostr,
              sources,
              [{ kinds: [SETTINGS_KIND], authors: keys.keyring.authors }],
              AbortSignal.timeout(PULL_TIMEOUT_MS),
            )];
          }
        }
        const keyrings = [keys.keyring, ...keys.previous].filter((k): k is SettingsKeyring => !!k);
        settingsEditions = events.filter((event) => event.kind === SETTINGS_KIND
          && (event.pubkey === user.pubkey || keyrings.some((keyring) => derivedDocOf(keyring, event))));
      } else {
        const filters: NostrFilter[] = [{
          kinds: [KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
          authors: [user.pubkey],
        }];
        events = await queryExplicitRelays(
          nostr,
          sources,
          filters,
          AbortSignal.timeout(PULL_TIMEOUT_MS),
        );
      }

      const canonicalCandidates = [...events, ...localCanonical];
      const groupEvent = canDecrypt ? newest(events, user.pubkey, KIND_USER_GROUPS) : undefined;
      const searchEvent = canDecrypt
        ? newest(canonicalCandidates, user.pubkey, KIND_SEARCH_RELAYS)
        : undefined;
      const dmEvent = newest(canonicalCandidates, user.pubkey, KIND_DM_RELAYS);
      const blossomEvent = newest(canonicalCandidates, user.pubkey, KIND_BLOSSOM_SERVERS);

      const inviteEvents = canDecrypt
        ? events.filter((event) => event.kind === KIND_INVITE_LIST && event.pubkey === user.pubkey)
        : [];
      const inviteRead = inviteEvents.length > 0
        ? await decodeInviteListEvents(inviteEvents, user)
        : undefined;
      const persistedInvites = canDecrypt
        ? await readPersistedInviteList(user.pubkey)
        : undefined;
      if (inviteRead?.unreadable) {
        throw new Error(t({ id: "usePullPortableSetup.inviteDecryptFailed", defaultMessage: "Your creator invite records could not be decrypted; nothing was restored" }));
      }

      const ctx = { signer, pubkey: user.pubkey, keys };
      const familyOf = (event: NostrRumor) => [keys.keyring, ...keys.previous]
        .map((keyring) => keyring && derivedDocOf(keyring, event))
        .find(Boolean)?.ref.family;
      const topicEditions = settingsEditions.filter((event) =>
        (event.pubkey === user.pubkey && event.tags.some(
          ([name, value]) => name === "t" && SELF_SYNC_TOPIC_TAGS.includes(value),
        ))
        || (familyOf(event) !== undefined && familyOf(event) !== "settings"));
      const topicHeads = newestPortableAddressableEvents(topicEditions, SETTINGS_KIND);
      let decodedDmIndex: DecodedDmConversationIndex | undefined;
      let decodedFavoriteGifs: DecodedFavoriteGifs | undefined;
      if (topicEditions.length > 0) {
        decodedDmIndex = await decodeDmConversationIndexEvents(topicEditions, ctx);
        if (decodedDmIndex.unreadable.size > 0) {
          throw new Error(t({ id: "usePullPortableSetup.dmIndexDecryptFailed", defaultMessage: "Your DM conversation index could not be decrypted completely; nothing was restored" }));
        }
        decodedFavoriteGifs = await decodeFavoriteGifEvents(topicEditions, ctx);
        if (decodedFavoriteGifs.headUnreadable) {
          throw new Error(t({ id: "usePullPortableSetup.gifFavoritesDecryptFailed", defaultMessage: "Your GIF favorites could not be decrypted completely; nothing was restored" }));
        }
      }

      // Decode every private record before changing any cache (atomicity).
      let groupList: UserGroupListQuery | undefined;
      if (groupEvent) {
        const previous = queryClient.getQueryData<UserGroupListQuery>([
          "nip29", "user-groups", user.pubkey,
        ]);
        const persisted = await readFolded<PersistedGroupList>(groupListFoldKey(user.pubkey));
        groupList = await resolveGroupListRead(
          events.filter((event) =>
            event.kind === KIND_USER_GROUPS && event.pubkey === user.pubkey),
          signer,
          previous,
          persisted,
        );
        if (groupList.decryptFailed) {
          throw new Error(t({ id: "usePullPortableSetup.serverListDecryptFailed", defaultMessage: "Your server list could not be decrypted; nothing was restored" }));
        }
      }

      const searchList = searchEvent
        ? await readSearchRelayList(searchEvent, signer)
        : undefined;
      if (searchList?.decryptFailed) {
        throw new Error(t({ id: "usePullPortableSetup.searchRelaysDecryptFailed", defaultMessage: "Your search-relay list could not be decrypted; nothing was restored" }));
      }

      // What was on disk before this pull: a document is applied only if the pull brought a newer one.
      const storedBefore = new Set<string>();
      if (canDecrypt) {
        const settingsCtx = { store, signer, pubkey: user.pubkey, keys };
        for (const name of SETTINGS_DOC_NAMES) {
          const before = await readSettingsDocChecked(settingsCtx, name).catch(() => undefined);
          if (before?.stored) storedBefore.add(before.stored.event.id);
        }
      }
      // Into the store so one read arbitrates every source; the caches still change only below.
      for (const event of settingsEditions) {
        if (event.tags.some(([name]) => name === "t")) continue; // topic editions, persisted later
        await store.event(event).catch(() => undefined);
      }

      const settingsDocs: PulledSettingsDoc[] = [];
      const settingsSources = new Map<SettingsDocName, SettingsDocQueryData<SettingsDocName>>();
      let settingsFound = 0;
      for (const name of canDecrypt ? SETTINGS_DOC_NAMES : []) {
        const settingsCtx = { store, signer, pubkey: user.pubkey, keys };
        const { stored, unreadable } = await readSettingsDocChecked(settingsCtx, name);
        if (unreadable) {
          throw new Error(
            t({ id: "usePullPortableSetup.settingsDecryptFailed", defaultMessage: "Your private Armada settings ({name}) could not be decrypted; nothing was restored" }, { name }),
          );
        }
        if (!stored) continue;
        settingsFound += 1;
        if (storedBefore.has(stored.event.id)) continue;
        settingsDocs.push({ name, event: stored.event as NostrEvent, doc: stored.doc as Record<string, unknown> });
        settingsSources.set(name, { ...stored, sources: await readSettingsDocSources(settingsCtx, name) });
      }

      let pulledCommunity: ListData | undefined;
      if (communitySet) {
        const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
        const persisted = await readFolded<PersistedList>(communityListFoldKey(user.pubkey));
        const local = cached?.list ?? persisted?.list;
        pulledCommunity = {
          event: communitySet.newestEvent,
          list: local
            ? mergeCommunityLists(local, communitySet.list)
            : communitySet.list,
          decryptFailed: false,
        };
      }

      let pulledInvites: InviteList | undefined;
      let pulledInviteCreatedAt = 0;
      if (inviteRead) {
        const cached = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey));
        pulledInvites = persistedInvites
          ? mergeInviteLists(inviteRead.list, persistedInvites.list)
          : inviteRead.list;
        if (cached) pulledInvites = mergeInviteLists(pulledInvites, cached);
        pulledInviteCreatedAt = Math.max(
          inviteRead.newestCreatedAt,
          persistedInvites?.newestCreatedAt ?? 0,
        );
      }

      const recordCount = Number(Boolean(discovery))
        + Number(Boolean(groupEvent))
        + Number(Boolean(searchEvent))
        + Number(Boolean(dmEvent))
        + Number(Boolean(blossomEvent))
        + communityEvents.length
        + Number(Boolean(inviteRead?.newestEvent))
        + topicHeads.length
        + settingsFound;
      if (recordCount === 0) {
        throw new Error(t({ id: "usePullPortableSetup.notFound", defaultMessage: "No portable setup was found on your account relays" }));
      }

      // Adopt the relay map FIRST: `adopt` schedules invalidation of the keys seeded below; yield
      // past it, then seed.
      if (discovery) {
        adopt(discovery);
        await nextMacrotask();
      }

      if (groupList?.event) {
        queryClient.setQueryData(["nip29", "user-groups", user.pubkey], {
          event: groupList.event,
          groups: groupList.groups,
          servers: groupList.servers,
          decryptFailed: false,
        });
        await writeFolded(groupListFoldKey(user.pubkey), {
          event: groupList.event,
          groups: groupList.groups,
          servers: groupList.servers,
        } satisfies PersistedGroupList).catch(() => undefined);
      }
      if (searchEvent && searchList) {
        queryClient.setQueryData<SearchRelayListQuery>(
          ["search-relay-list", user.pubkey],
          { event: searchEvent, ...searchList },
        );
      }
      if (dmEvent) {
        queryClient.setQueryData<DmRelayListQuery>(["dm-relay-list", user.pubkey], {
          event: dmEvent,
          relays: parseDmRelays(dmEvent),
        });
      }
      if (blossomEvent) {
        queryClient.setQueryData<BlossomServerListQuery>(
          ["blossom-server-list", user.pubkey],
          { event: blossomEvent, servers: parseBlossomServerList(blossomEvent) },
        );
      }

      // Persist exact wire records before exposing their decrypted folds.
      for (const event of [...communityEvents, ...inviteEvents, ...topicEditions]) {
        await store.event(event).catch(() => undefined);
      }
      if (pulledCommunity) {
        await writeFolded(communityListFoldKey(user.pubkey), {
          event: pulledCommunity.event,
          list: pulledCommunity.list,
        } satisfies PersistedList).catch(() => undefined);
        queryClient.setQueryData(listQueryKey(user.pubkey), pulledCommunity);
      }
      if (pulledInvites) {
        await writeFolded(inviteListFoldKey(user.pubkey), {
          list: pulledInvites,
          newestCreatedAt: pulledInviteCreatedAt,
        } satisfies PersistedInviteList);
        queryClient.setQueryData(inviteListKey(user.pubkey), pulledInvites);
      }
      if (decodedDmIndex) {
        await hydrateDmConversationIndexRecords(user.pubkey, decodedDmIndex.sets);
        void queryClient.invalidateQueries({ queryKey: [...dmConversationIndexSyncQueryKey, user.pubkey] });
      }
      if (decodedFavoriteGifs) {
        hydrateFavoriteGifRecords(user.pubkey, decodedFavoriteGifs.sets);
        void queryClient.invalidateQueries({ queryKey: [...favoriteGifsSyncQueryKey, user.pubkey] });
      }

      // Stored above; now visible.
      queryClient.setQueryData(settingsKeysQueryKey(user.pubkey), keys);
      for (const [name, data] of settingsSources) {
        queryClient.setQueryData(settingsDocQueryKey(name, user.pubkey), data);
      }

      // One AppConfig update; `useConfigDocSync` only applies docs while auto sync is on, which is
      // the case this action exists for.
      const metadata = settingsDocs.find((entry) => entry.name === "metadata");
      updateConfig((current) => {
        let next: AppConfig = current;
        if (searchList) next = { ...next, searchRelays: searchList.relays };
        if (dmEvent) next = { ...next, dmRelays: parseDmRelays(dmEvent) };
        if (blossomEvent && nip01VersionIsNewer(blossomEvent, {
          created_at: current.blossomServerMetadata.updatedAt,
          id: current.blossomServerMetadata.eventId ?? "\uffff",
        })) {
          next = {
            ...next,
            blossomServerMetadata: {
              servers: parseBlossomServerList(blossomEvent),
              updatedAt: blossomEvent.created_at,
              eventId: blossomEvent.id,
            },
          };
        }
        for (const { name, doc, event } of settingsDocs) {
          if (!(name in CONFIG_KEYS_BY_DOC)) continue;
          next = { ...next, ...docToConfigPatch(name as ConfigDocName, doc, next, event) };
        }
        // Not a user edit, so the publish watcher must not echo it.
        markConfigSynced(next);
        return next;
      });

      return {
        records: recordCount,
        sources: sources.length,
        voiceServer: Boolean((metadata?.doc as MetadataDoc | undefined)?.preferredVoiceServer),
        publicOnly: !canDecrypt,
      };
    } finally {
      setIsPending(false);
    }
  }, [adopt, config, discover, eventStore, nostr, queryClient, updateConfig, user]);

  return { pull, isPending };
}
