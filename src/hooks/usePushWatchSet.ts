import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useConcordSubsState } from "@/concord/hooks/useConcordSubs";
import { normalizeRelayUrl } from "@/lib/platform";
import type { PushPrefs } from "@/lib/pushPrefs";
import {
  buildPushSubscriptions,
  type PushSubscriptionSpec,
} from "@/lib/pushSubscriptions";
import type { ConcordSub } from "@/concord/lib/concordNotifications";
import {
  notificationPolicyIsAuthoritative,
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";

/**
 * What a content-blind push controller watches — the same set as the Android service.
 * Shared by `useNostrPush` and `useIosPush` (only one is mounted) so they can't drift. `specs` is all
 * registration needs; the rest feeds the sealed decrypt config.
 */
export interface PushWatchSet {
  specs: PushSubscriptionSpec[];
  /**
   * Current-epoch Concord channels. `mentionOnly`/`muted` let the device suppress after decrypt
   * (the gateway is content-blind). Muted channels stay in the sealed config but aren't subscribed, so a
   * lingering subscription's wrap is dropped rather than shown generically.
   */
  concord: Array<ConcordSub & { mentionOnly: boolean; muted: boolean }>;
  /** Peers whose DMs are not requests, including authored synced conversations. */
  dmKnownPeers: string[];
  /** Exact pinned/authored NIP-17 rooms, without promoting group members to 1:1 trust. */
  dmKnownConversationKeys: string[];
  /** Peers whose presence suppresses their whole DM conversation. */
  dmMutedPeers: string[];
  /** Keyed by canonical NIP-17 conversation key; group keys are never widened per participant. */
  dmLevels: Record<string, NotifLevel>;
  /** The timed mutes the device judges itself (see {@link TimedMutesOnDevice}), by room key. */
  roomMutes: Record<string, number>;
  /** nsec logins ONLY; bunker/extension keys stay off-device. */
  dmSk?: string;
  /**
   * A bunker's client key (not the account key; revocable) so the iOS extension's
   * `Nip46Client` can ask the bunker to decrypt. Deliberately not given to the web worker.
   */
  dmBunker?: { clientSk: string; bunkerPubkey: string; relays: string[] };
  /** Render-only; background replacement must use `dmPeersReady`. */
  dmPeersLoading: boolean;
  /** Follows, mutes, and the encrypted conversation index are authoritative. */
  dmPeersReady: boolean;
  /** Concord membership and every current control-fold derivation settled. */
  concordReady: boolean;
  /** AppConfig's notification slice is an authoritative chosen policy. */
  notificationSettingsReady: boolean;
  dmConfigReady: boolean;
  concordConfigReady: boolean;
  /** Whether NIP-29 records may be removed/replaced from this snapshot. */
  groupPlaneReady: boolean;
  dmPlaneReady: boolean;
  concordPlaneReady: boolean;
  /**
   * Every field in the sealed decrypt config is authoritative. NIP-29 and DM relays affect only
   * gateway filters, so their outages mustn't hold keys stale.
   */
  configReady: boolean;
  /** Only then may a controller replace durable/native config or mutate registrations. */
  watchSetReady: boolean;
  /**
   * Callers that PRUNE must wait for this: sources load at different speeds, and pruning from a
   * partial set deletes records for everything not yet loaded.
   */
  watchSetLoading: boolean;
}

export function explicitDmNotificationLevels(
  levels: Record<string, NotifLevel>,
): Record<string, NotifLevel> {
  return Object.fromEntries(
    Object.entries(levels)
      .flatMap(([scope, level]) => {
        if (!scope.startsWith("dm:")) return [];
        const key = scope.slice(3);
        const peers = key.split(",");
        if (peers.length === 0
          || peers.some((peer) => !/^[0-9a-f]{64}$/.test(peer))
          || [...new Set(peers)].sort().join(",") !== key) return [];
        return [[key, level] as const];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Never expose specs derived from a fresh account's unauthoritative defaults. */
export function policyAuthorizedPushSpecs(
  ready: boolean,
  specs: PushSubscriptionSpec[],
): PushSubscriptionSpec[] {
  return ready ? specs : [];
}

/**
 * Fail closed per encrypted plane without withholding NIP-29 watches; the worker gets the
 * same readiness flags.
 */
export function readyPlanePushSpecs(
  specs: PushSubscriptionSpec[],
  dmReady: boolean,
  concordReady: boolean,
): PushSubscriptionSpec[] {
  return specs.filter((spec) => {
    if (spec.id.startsWith("armada-dm")) return dmReady;
    if (spec.id.startsWith("armada-c2-")) return concordReady;
    return true;
  });
}

/**
 * Which timed mutes the device judges itself (`roomMutes`), staying subscribed so
 * the mute lifts with the app closed. The web worker can drop a push outright, so
 * `all`; iOS cannot hide one it was handed, so only DMs, whose inbox it watches
 * either way — a muted room's subscription would show "Messages synced" through
 * the mute, so it is left out until the app sees the mute end.
 */
export type TimedMutesOnDevice = "all" | "dms";

export function usePushWatchSet(prefs: PushPrefs, onDevice: TimedMutesOnDevice): PushWatchSet {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const groupListQuery = useUserGroupList();
  const { data: groupList } = groupListQuery;
  const {
    knownPeers: dmKnownPeers,
    knownConversationKeys: dmKnownConversationKeys,
    mutedPeers: dmMutedPeers,
    isLoading: dmPeersLoading,
    authoritativeReady: dmPeersReady,
    configurationReady: dmPeersConfigReady,
  } = useKnownDmPeers();
  const { logins } = useNostrLogin();
  const notifLevels = useNotifLevels();
  const { channelLevel, concordChannelLevel } = onDevice === "all" ? notifLevels.standing : notifLevels;
  const levels = notifLevels.standing.levels;
  const allRoomMutes = notifLevels.roomMutes;
  const roomMutes = useMemo(
    () => (onDevice === "all"
      ? allRoomMutes
      : Object.fromEntries(Object.entries(allRoomMutes).filter(([key]) => key.startsWith("dm:")))),
    [allRoomMutes, onDevice],
  );
  const {
    relays: publishedDmRelays,
    isReady: dmRelayListReady,
  } = useDmRelayList();
  const {
    subs: allConcordSubs,
    ready: concordReady,
    configReady: concordConfigReady,
  } = useConcordSubsState();
  const durableNotificationSettingsReady = useNotificationSettingsReady(user?.pubkey);
  const notificationSettingsReady = notificationPolicyIsAuthoritative(
    durableNotificationSettingsReady,
    config.automaticSettingsSync,
  );

  const dmLevels = useMemo<Record<string, NotifLevel>>(
    () => explicitDmNotificationLevels(levels),
    [levels],
  );

  const nip29Groups = useMemo(() => {
    const byRoom = new Map<string, {
      relay: string;
      groupId: string;
      level: "all" | "mentions";
    }>();
    for (const g of groupList?.groups ?? []) {
      const relay = normalizeRelayUrl(g.relay);
      if (!relay || !g.id) continue;
      const level = channelLevel(relay, g.id);
      if (level === "nothing") continue;
      byRoom.set(`${relay}\0${g.id}`, { relay, groupId: g.id, level });
    }
    return [...byRoom.values()].sort((a, b) =>
      a.relay.localeCompare(b.relay) || a.groupId.localeCompare(b.groupId));
  }, [groupList, channelLevel]);

  // `dmsDisabled` → empty → no DM specs registered.
  const dmRelays = useMemo(() => {
    if (config.dmsDisabled) return [];
    const set = new Set<string>();
    for (const url of [...effectiveDmRelays(config), ...publishedDmRelays]) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config, publishedDmRelays]);

  // `dmFollows` is the historical field name; it carries the full established-peer roster.
  const dmFollows = dmKnownPeers;

  const dmSk = useMemo(() => {
    const login = logins[0];
    try {
      if (login?.type === "nsec") {
        const decoded = nip19.decode(login.data.nsec);
        if (decoded.type === "nsec") return bytesToHex(decoded.data);
      }
    } catch {
      // Malformed login data — no key, and DM push stays generic.
    }
    return undefined;
  }, [logins]);

  const dmBunker = useMemo(() => {
    const login = logins[0];
    try {
      if (login?.type === "bunker") {
        const decoded = nip19.decode(login.data.clientNsec);
        if (decoded.type !== "nsec") return undefined;
        const relays = login.data.relays.filter((url: string) => Boolean(url));
        if (relays.length === 0) return undefined;
        return {
          clientSk: bytesToHex(decoded.data),
          bunkerPubkey: login.data.bunkerPubkey,
          relays,
        };
      }
    } catch {
      // Malformed login data — no bunker, and DM push stays generic.
    }
    return undefined;
  }, [logins]);

  const concord = useMemo(
    () =>
      allConcordSubs
        .map((sub) => ({
          sub,
          level: concordChannelLevel("c2", sub.communityId, sub.channelId),
        }))
        // Enforcement on device: `nothing` channels stay in the sealed config (dropped from the
        // gateway by `buildPushSubscriptions`) so lingering wraps are dropped, not shown.
        .map(({ sub, level }) => ({
          ...sub,
          mentionOnly: level === "mentions",
          muted: level === "nothing",
        })),
    [allConcordSubs, concordChannelLevel],
  );

  const dmConfigReady = dmPeersConfigReady;
  const specs = useMemo(() => {
    if (!user) return [];
    return policyAuthorizedPushSpecs(
      notificationSettingsReady,
      readyPlanePushSpecs(buildPushSubscriptions({
        pubkey: user.pubkey,
        nip29Groups,
        prefs,
        dmRelays,
        dmFollows,
        dmLevels,
        concord,
      }), dmConfigReady, concordConfigReady),
    );
  }, [
    user,
    notificationSettingsReady,
    nip29Groups,
    prefs,
    dmRelays,
    dmFollows,
    dmLevels,
    concord,
    dmConfigReady,
    concordConfigReady,
  ]);

  // Data presence, not `isLoading`, distinguishes an authoritative empty result from a failure;
  // a decrypt-failed list must never prune.
  const groupListReady = groupList !== undefined
    && !groupList.decryptFailed
    && groupList.wireReady === true;
  const configReady = notificationSettingsReady
    && dmConfigReady
    && concordConfigReady;
  const groupPlaneReady = notificationSettingsReady && groupListReady;
  const dmPlaneReady = notificationSettingsReady
    && dmConfigReady
    && dmRelayListReady;
  const concordPlaneReady = notificationSettingsReady && concordReady;
  const watchSetReady = groupPlaneReady && dmPlaneReady && concordPlaneReady;
  const watchSetLoading = !watchSetReady;

  return {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    roomMutes,
    dmSk,
    dmBunker,
    dmPeersLoading,
    dmPeersReady,
    concordReady,
    notificationSettingsReady,
    dmConfigReady,
    concordConfigReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    configReady,
    watchSetReady,
    watchSetLoading,
  };
}
