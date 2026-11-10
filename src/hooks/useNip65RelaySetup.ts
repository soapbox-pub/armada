import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { selfStateRelays } from "@/contexts/AppContext";
import { mirrorPortableStateBeforeRelayChange } from "@/hooks/usePublishPortableSetup";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import {
  buildRelayListTags,
  discoverRelayList,
  discoverRelayListWithStatus,
  KIND_RELAY_LIST,
  newestRelayList,
  publishSignedEventToRelays,
  queryExplicitRelaysWithStatus,
  relayListIsNewerThanMetadata,
  type RelayListDiscovery,
  type RelayListPublishResult,
  type RelayPreference,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { queueSignedEvent, recordQueuedPublishAttempt } from "@/lib/publishOutbox";
import { SELF_SYNC_OWNER_QUERY_KEYS } from "@/lib/selfSyncKinds";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import { SETTINGS_KIND } from "@/lib/settingsDocs";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";

import type { RelayMetadata } from "@/contexts/AppContext";
import type { NostrEvent } from "@nostrify/nostrify";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

export function relayPointerChangedDuringPreseed(
  metadata: RelayMetadata,
  pubkey: string,
  candidate: Pick<NostrEvent, "created_at" | "id"> | undefined,
): boolean {
  if (!candidate) return false;
  if (metadata.pubkey !== pubkey) return true;
  return candidate.created_at > metadata.updatedAt
    || (
      candidate.created_at === metadata.updatedAt
      && metadata.eventId !== undefined
      && candidate.id !== metadata.eventId
      && candidate.id < metadata.eventId
    );
}

/** No local NIP-65 list but one exists on the wire: adopt `discovery` instead of shadowing it. */
export class ExistingRelayListError extends Error {
  constructor(readonly discovery: RelayListDiscovery) {
    super(t({ id: "useNip65RelaySetup.existingList", defaultMessage: "Your account already has a NIP-65 relay list; review it instead of creating a new one" }));
    this.name = "ExistingRelayListError";
  }
}

/** No local list and too few relays answered to rule one out. */
export class RelayListAbsenceUnconfirmedError extends Error {
  constructor() {
    super(t({ id: "useNip65RelaySetup.absenceUnconfirmed", defaultMessage: "Couldn't reach enough relays to confirm your account has no saved relay list yet; nothing was published" }));
    this.name = "RelayListAbsenceUnconfirmedError";
  }
}

/**
 * An empty read is fact only if every required relay and a majority of other discovery
 * indexes reached EOSE.
 */
export function relayListAbsenceConfirmed(
  answered: Iterable<string>,
  requiredRelays: string[],
  discoveryRelays: string[] = RELAY_LIST_DISCOVERY_RELAYS,
): boolean {
  const heard = new Set(answered);
  const app = uniqueRelayUrls(requiredRelays);
  const indexes = uniqueRelayUrls(discoveryRelays).filter((url) => !app.includes(url));
  if (app.length + indexes.length === 0) return false;
  if (!app.every((url) => heard.has(url))) return false;
  const indexesHeard = indexes.filter((url) => heard.has(url)).length;
  return indexes.length === 0 || indexesHeard > indexes.length / 2;
}

/**
 * Discovery never signs. Publishing signs once and fans the exact bytes everywhere so
 * replaceable ordering can't diverge.
 */
export function useNip65RelaySetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { keys: settingsKeys } = useSettingsKeys();

  const discoveryRelays = useMemo(
    () => uniqueRelayUrls([...config.appRelays, ...RELAY_LIST_DISCOVERY_RELAYS]),
    [config.appRelays],
  );

  const adopt = useCallback((discovery: RelayListDiscovery) => {
    updateConfig((current) => {
      const sameOwner = current.relayMetadata.pubkey === user?.pubkey;
      if (sameOwner && !relayListIsNewerThanMetadata(
        discovery.event,
        current.relayMetadata,
      )) return current;
      return {
        ...current,
        useUserRelays: true,
        relayMetadata: {
          relays: discovery.relays,
          updatedAt: discovery.event.created_at,
          eventId: discovery.event.id,
          pubkey: user?.pubkey,
        },
      };
    });
    // Invalidate once the pool has changed on the next render.
    setTimeout(() => {
      for (const queryKey of SELF_SYNC_OWNER_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    }, 0);
  }, [queryClient, updateConfig, user?.pubkey]);

  const discover = useCallback(async (bootstrapRelays: string[] = []) => {
    if (!user) throw new Error(t({ id: "useNip65RelaySetup.notLoggedIn", defaultMessage: "User is not logged in" }));
    return discoverRelayList(
      nostr,
      user.pubkey,
      uniqueRelayUrls([...bootstrapRelays, ...discoveryRelays]),
      AbortSignal.timeout(8_000),
    );
  }, [discoveryRelays, nostr, user]);

  /** Also reports which relays reached EOSE. */
  const discoverWithStatus = useCallback(async (bootstrapRelays: string[] = []) => {
    if (!user) throw new Error(t({ id: "useNip65RelaySetup.notLoggedIn", defaultMessage: "User is not logged in" }));
    return discoverRelayListWithStatus(
      nostr,
      user.pubkey,
      uniqueRelayUrls([...bootstrapRelays, ...discoveryRelays]),
      AbortSignal.timeout(8_000),
    );
  }, [discoveryRelays, nostr, user]);

  const publish = useCallback(async (relays: RelayPreference[]): Promise<RelayListPublishResult> => {
    if (!user) throw new Error(t({ id: "useNip65RelaySetup.notLoggedIn", defaultMessage: "User is not logged in" }));
    const tags = buildRelayListTags(relays);
    if (tags.length === 0) throw new Error(t({ id: "useNip65RelaySetup.noValidRelay", defaultMessage: "Add at least one valid relay" }));

    const declared = tags.map((tag) => tag[1]).filter((url): url is string => Boolean(url));
    const proposedWrites = tags
      .filter((tag) => tag[2] !== "read")
      .map((tag) => tag[1])
      .filter((url): url is string => Boolean(url));
    if (proposedWrites.length === 0) {
      throw new Error(t({ id: "useNip65RelaySetup.keepWriteRelay", defaultMessage: "Keep at least one write relay for portable account state" }));
    }
    const oldSelfRelays = selfStateRelays(config, user.pubkey);
    const targets = uniqueRelayUrls([
      ...declared,
      ...oldSelfRelays,
      ...config.appRelays,
      ...RELAY_LIST_DISCOVERY_RELAYS,
    ]);
    const timeout = publishTimeoutMs(user.method);

    // Two-phase rotation: the source set stays authoritative until every new write relay accepts
    // the portable records; only then publish the 10002.
    const sourceRelays = uniqueRelayUrls([
      ...oldSelfRelays,
      ...config.appRelays,
      ...RELAY_LIST_DISCOVERY_RELAYS,
    ]);
    const oldDeclaredWrites = uniqueRelayUrls(
      config.relayMetadata.pubkey === user.pubkey
        ? config.relayMetadata.relays
          .filter((relay) => relay.write)
          .map((relay) => relay.url)
        : [],
    );
    const ownsPointer = config.relayMetadata.pubkey === user.pubkey;

    // Creating a list is sound only once the wire affirmatively has none.
    if (!ownsPointer) {
      const existing = await discoverRelayListWithStatus(
        nostr,
        user.pubkey,
        targets,
        AbortSignal.timeout(8_000),
      );
      if (existing.discovery) throw new ExistingRelayListError(existing.discovery);
      if (!relayListAbsenceConfirmed(
        existing.answered,
        uniqueRelayUrls([...declared, ...config.appRelays]),
      )) {
        throw new RelayListAbsenceUnconfirmedError();
      }
    }

    // A first list replaces no pointer, so phase one is unnecessary.
    let refreshed: RelayListDiscovery | undefined;
    if (ownsPointer) {
      const store = await eventStore;
      const loadLocalPortableState = async () => {
        try {
          return await store.query([{
            kinds: [
              KIND_RELAY_LIST,
              10007,
              KIND_USER_GROUPS,
              10050,
              10063,
              KIND_INVITE_LIST,
              SETTINGS_KIND,
              33302,
            ],
            authors: [user.pubkey],
          }, ...(settingsKeys.keyring
            ? [{ kinds: [SETTINGS_KIND], authors: settingsKeys.keyring.authors }]
            : [])]);
        } catch {
          // Wire-only preseed remains possible when the local store is unavailable.
          return [];
        }
      };
      let localSingletons = await loadLocalPortableState();
      let mirrored = await mirrorPortableStateBeforeRelayChange(
        nostr,
        user,
        sourceRelays,
        proposedWrites,
        oldDeclaredWrites.length > 0 ? oldDeclaredWrites : sourceRelays,
        oldDeclaredWrites.length > 0,
        localSingletons,
        settingsKeys,
      );

      // Re-read until two consecutive snapshots agree, so a sibling write during phase one is
      // re-mirrored rather than stranded.
      const pointerRefreshRelays = uniqueRelayUrls([...sourceRelays, ...proposedWrites]);
      const refreshPointer = async () => {
        const read = await discoverRelayListWithStatus(
          nostr,
          user.pubkey,
          pointerRefreshRelays,
          AbortSignal.timeout(8_000),
        );
        const discovery = read.discovery;
        const answered = new Set(read.answered);
        const sourceComplete = oldDeclaredWrites.length > 0
          ? oldDeclaredWrites.every((url) => answered.has(url))
          : sourceRelays.some((url) => answered.has(url));
        const complete = sourceComplete
          && proposedWrites.every((url) => answered.has(url));
        if (!complete || !discovery) {
          throw new Error(t({ id: "useNip65RelaySetup.refreshFailed", defaultMessage: "Could not refresh the current NIP-65 relay list after copying setup; retry without changing relays" }));
        }
        const baselineId = config.relayMetadata.eventId;
        const isKnownBaseline = baselineId !== undefined
          ? discovery.event.id === baselineId
          : discovery.event.created_at === config.relayMetadata.updatedAt;
        if (!isKnownBaseline && !relayPointerChangedDuringPreseed(
          config.relayMetadata,
          user.pubkey,
          discovery.event,
        )) {
          throw new Error(t({ id: "useNip65RelaySetup.versionUnconfirmed", defaultMessage: "Could not confirm the current NIP-65 relay-list version; retry without changing relays" }));
        }
        if (relayPointerChangedDuringPreseed(
          config.relayMetadata,
          user.pubkey,
          discovery.event,
        )) {
          throw new Error(t({ id: "useNip65RelaySetup.changedElsewhere", defaultMessage: "Your NIP-65 relay list changed on another device; review it and retry" }));
        }
        return discovery;
      };

      await refreshPointer();
      let portableStable = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        localSingletons = await loadLocalPortableState();
        const next = await mirrorPortableStateBeforeRelayChange(
          nostr,
          user,
          sourceRelays,
          proposedWrites,
          oldDeclaredWrites.length > 0 ? oldDeclaredWrites : sourceRelays,
          oldDeclaredWrites.length > 0,
          localSingletons,
          settingsKeys,
        );
        refreshed = await refreshPointer();
        if (next.fingerprint === mirrored.fingerprint) {
          portableStable = true;
          break;
        }
        mirrored = next;
      }
      if (!portableStable) {
        throw new Error(t({ id: "useNip65RelaySetup.stateKeptChanging", defaultMessage: "Portable account state kept changing during relay migration; retry after the other device finishes syncing" }));
      }
    }
    const createdAt = Math.max(
      nowSecs(),
      ownsPointer ? config.relayMetadata.updatedAt + 1 : 0,
      (refreshed?.event.created_at ?? 0) + 1,
    );
    const event = await user.signer.signEvent({
      kind: KIND_RELAY_LIST,
      content: "",
      tags,
      created_at: createdAt,
    });
    if (event.pubkey !== user.pubkey) {
      throw new Error(t({ id: "useNip65RelaySetup.wrongAccount", defaultMessage: "The signer returned a different account" }));
    }
    // Must be durably queued first, or a partial delivery could strand old devices.
    await queueSignedEvent(event, undefined, targets, { inheritPendingTargets: false });
    const result = await publishSignedEventToRelays(nostr, event, targets, timeout);
    await recordQueuedPublishAttempt(event.id, targets, result.rejected).catch(() => undefined);
    if (result.accepted.length === 0) {
      throw new Error(t({ id: "useNip65RelaySetup.noRelayAccepted", defaultMessage: "No relay accepted your signed relay list" }));
    }
    const rejected = new Set(result.rejected);
    // Only the previous pointer's write relays are authoritative; app/discovery relays are
    // best-effort.
    if (oldDeclaredWrites.some((url) => rejected.has(url))) {
      throw new Error(t({ id: "useNip65RelaySetup.relayMissed", defaultMessage: "An existing account-state relay missed the new relay list; retry before switching" }));
    }

    // An ACK doesn't mean we're still the NIP-01 winner; re-read and adopt only if we are.
    const confirmed = await discoverRelayListWithStatus(
      nostr,
      user.pubkey,
      targets,
      AbortSignal.timeout(8_000),
    );
    const answeredAfterPublish = new Set(confirmed.answered);
    const authoritativeTargets = uniqueRelayUrls([
      ...oldDeclaredWrites,
      ...proposedWrites,
    ]);
    if (!authoritativeTargets.every((url) => answeredAfterPublish.has(url))) {
      throw new Error(t({ id: "useNip65RelaySetup.queuedForRetry", defaultMessage: "Could not confirm the new NIP-65 relay list on every account-state relay; it remains queued for retry" }));
    }
    if (confirmed.discovery?.event.id !== event.id) {
      throw new Error(t({ id: "useNip65RelaySetup.newerWon", defaultMessage: "A newer NIP-65 relay list won while this change was publishing; local relay settings were not switched" }));
    }
    const perRelay = await Promise.all(authoritativeTargets.map(async (url) => ({
      url,
      read: await queryExplicitRelaysWithStatus(
        nostr,
        [url],
        [{ kinds: [KIND_RELAY_LIST], authors: [user.pubkey], limit: 1 }],
        AbortSignal.timeout(8_000),
      ),
    })));
    for (const { url, read } of perRelay) {
      const winner = newestRelayList(
        read.events.filter((candidate) => candidate.pubkey === user.pubkey),
      );
      if (!read.answered.includes(url) || winner?.id !== event.id) {
        throw new Error(
          t(
            { id: "useNip65RelaySetup.winnerNotRetained", defaultMessage: "Account-state relay {url} did not retain the new NIP-65 winner; local relay settings were not switched" },
            { url },
          ),
        );
      }
    }

    adopt({ event, relays: tags.map((tag) => ({
      url: tag[1]!,
      read: tag[2] !== "write",
      write: tag[2] !== "read",
    })) });
    return result;
  }, [adopt, config, eventStore, nostr, settingsKeys, user]);

  return {
    discoveryRelays,
    discover,
    discoverWithStatus,
    adopt,
    publish,
  };
}
