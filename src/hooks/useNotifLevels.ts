import { useCallback, useMemo } from "react";

import { channelReadKey } from "@/contexts/ReadStateContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useMuteNow } from "@/hooks/useMuteNow";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/pushPrefs";
import {
  effectiveLevels,
  isMuteActive,
  MUTE_OFF,
  nextStamp,
  notifFields,
  recordsOf,
  roomMutes,
  type NotifLevel,
  type NotifRecords,
} from "@/lib/notifRecords";
import { normalizeRelayUrl } from "@/lib/platform";
import { clockNowMs } from "@/lib/relayClock";

import type { AppConfig } from "@/contexts/AppContext";

/**
 * Per-conversation notification levels (Discord model): all / mentions / nothing,
 * plus mutes, timed or until turned off, which read as `nothing` while they run.
 * Channel cascade: channel → community → global prefs (`allGroupMessages` ⇒ all,
 * else `mentions` ⇒ mentions, else nothing). DMs (`mentions` ≡ `all`) fall back to
 * `directMessages`. Stored as per-scope records (`lib/notifRecords.ts`) under the
 * scope keys below.
 */

export type { NotifLevel };

// Stable scope keys (same scheme as useMutes).

export function communityScopeKey(relayUrlOrRailKey: string): string {
  if (relayUrlOrRailKey.startsWith("c2:")) {
    return relayUrlOrRailKey;
  }
  return normalizeRelayUrl(relayUrlOrRailKey) ?? relayUrlOrRailKey;
}

export function channelScopeKey(relayUrl: string, groupId: string): string {
  return channelReadKey(normalizeRelayUrl(relayUrl) ?? relayUrl, groupId);
}

export function concordChannelScopeKey(
  protocol: "c2",
  communityId: string,
  channelIdHex: string,
): string {
  return `${protocol}:${communityId}::${channelIdHex}`;
}

export function dmScopeKey(pubkey: string): string {
  return `dm:${pubkey}`;
}

function globalChannelLevel(prefs: PushPrefs): NotifLevel {
  if (prefs.allGroupMessages) return "all";
  if (prefs.mentions) return "mentions";
  return "nothing";
}

function globalDmLevel(prefs: PushPrefs): NotifLevel {
  return prefs.directMessages ? "all" : "nothing";
}

/** Resolvers over one level map; the same cascade with or without mutes. */
export interface NotifLevelResolvers {
  /** Resolved via channel → server → global. */
  channelLevel: (relayUrl: string, groupId: string) => NotifLevel;
  /** Channel → community → global. */
  concordChannelLevel: (
    protocol: "c2",
    communityId: string,
    channelIdHex: string,
  ) => NotifLevel;
  communityLevel: (railKey: string) => NotifLevel;
  dmLevel: (pubkey: string) => NotifLevel;
}

export interface UseNotifLevelsReturn extends NotifLevelResolvers {
  /** Explicit level in force (a running mute reads as `nothing`), or undefined (inherit). */
  getLevel: (scopeKey: string) => NotifLevel | undefined;
  setLevel: (scopeKey: string, level: NotifLevel | undefined) => void;
  /** Every explicit level in force, mutes included: what delivery paths act on. */
  levels: Record<string, NotifLevel>;
  /** The levels chosen, ignoring mutes: what a level menu ticks. */
  chosen: NotifLevelResolvers;
  /**
   * The levels with only mutes that have no end applied, for a background
   * notifier handed {@link roomMutes}: it stays subscribed through a timed mute
   * and judges its end itself, so the mute lifts while the app is closed.
   */
  standing: NotifLevelResolvers & { levels: Record<string, NotifLevel> };
  /** The running timed mutes by background room key (`roomMuteKey`), with their ends. */
  roomMutes: Record<string, number>;
  /** The scope's own running mute: epoch seconds, or `MUTE_FOREVER`; undefined when not muted. */
  muteUntil: (scopeKey: string) => number | undefined;
  /** Mute until `until` (epoch seconds, or `MUTE_FOREVER`). */
  setMute: (scopeKey: string, until: number) => void;
  /** End the scope's mute, and a `nothing` level chosen for it. */
  unmute: (scopeKey: string) => void;
}

function resolvers(map: ReadonlyMap<string, NotifLevel>, prefs: PushPrefs): NotifLevelResolvers {
  return {
    communityLevel: (railKey) => map.get(communityScopeKey(railKey)) ?? globalChannelLevel(prefs),
    channelLevel: (relayUrl, groupId) =>
      map.get(channelScopeKey(relayUrl, groupId))
      ?? map.get(communityScopeKey(relayUrl))
      ?? globalChannelLevel(prefs),
    concordChannelLevel: (protocol, communityId, channelIdHex) =>
      map.get(concordChannelScopeKey(protocol, communityId, channelIdHex))
      ?? map.get(`${protocol}:${communityId}`)
      ?? globalChannelLevel(prefs),
    dmLevel: (pubkey) => map.get(dmScopeKey(pubkey)) ?? globalDmLevel(prefs),
  };
}

/**
 * The Concord half of the policy as data, for a notifier that must resolve a
 * channel the WebView didn't list (Android's merge of an unready snapshot).
 * Keys are lower-case: `communities[<id>]`, `channels["<id>:<channel>"]`.
 */
export interface ConcordLevelPolicy {
  default: NotifLevel;
  communities: Record<string, NotifLevel>;
  channels: Record<string, NotifLevel>;
}

export function concordLevelPolicy(
  levels: Record<string, NotifLevel>,
  prefs: PushPrefs,
): ConcordLevelPolicy {
  const communities: Record<string, NotifLevel> = {};
  const channels: Record<string, NotifLevel> = {};
  // Sorted, so an unrelated reorder doesn't change the native config.
  const entries = Object.entries(levels)
    .filter(([key]) => key.startsWith("c2:"))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [key, level] of entries) {
    const [community, channel] = key.slice(3).toLowerCase().split("::");
    if (!community) continue;
    if (channel) channels[`${community}:${channel}`] = level;
    else communities[community] = level;
  }
  return { default: globalChannelLevel(prefs), communities, channels };
}

function randomOp(): string {
  return crypto.randomUUID();
}

export function useNotifLevels(): UseNotifLevelsReturn {
  const { config, updateConfig } = useAppContext();
  // Account-scoped AppConfig only; never another account's legacy localStorage mirror.
  const pushPrefs = config.pushPrefs ?? DEFAULT_PUSH_PREFS;

  const { notifLevelRecords, notifMuteRecords, notifLevels, mutedCommunities, mutedChannels } = config;
  const records = useMemo(
    () => recordsOf({ notifLevelRecords, notifMuteRecords, notifLevels, mutedCommunities, mutedChannels }),
    [notifLevelRecords, notifMuteRecords, notifLevels, mutedCommunities, mutedChannels],
  );
  const now = useMuteNow(records.mutes);
  const effective = useMemo(() => effectiveLevels(records, now, "all"), [records, now]);
  const chosenMap = useMemo(() => effectiveLevels(records, now, "none"), [records, now]);
  const standingMap = useMemo(() => effectiveLevels(records, now, "standing"), [records, now]);
  const levels = useMemo(() => Object.fromEntries(effective), [effective]);
  const resolved = useMemo(() => resolvers(effective, pushPrefs), [effective, pushPrefs]);
  const chosen = useMemo(() => resolvers(chosenMap, pushPrefs), [chosenMap, pushPrefs]);
  const standing = useMemo(
    () => ({ ...resolvers(standingMap, pushPrefs), levels: Object.fromEntries(standingMap) }),
    [standingMap, pushPrefs],
  );
  const timedRoomMutes = useMemo(() => roomMutes(records, now), [records, now]);

  const getLevel = useCallback((scopeKey: string) => effective.get(scopeKey), [effective]);

  const muteUntil = useCallback((scopeKey: string) => {
    const mute = records.mutes[scopeKey];
    return isMuteActive(mute, now) ? mute!.until : undefined;
  }, [records, now]);

  // Every edit stamps a record from what is stored NOW, so two quick edits can't share a base.
  const edit = useCallback((change: (current: NotifRecords, at: number, op: string) => NotifRecords) => {
    updateConfig((current: AppConfig) => {
      const base = recordsOf(current);
      return { ...current, ...notifFields(change(base, nextStamp(base, clockNowMs()), randomOp())) };
    });
  }, [updateConfig]);

  const setLevel = useCallback((scopeKey: string, level: NotifLevel | undefined) => {
    edit((current, at, op) => ({
      ...current,
      levels: { ...current.levels, [scopeKey]: level ? { v: level, at, op } : { at, op } },
    }));
  }, [edit]);

  const setMute = useCallback((scopeKey: string, until: number) => {
    edit((current, at, op) => ({
      ...current,
      mutes: { ...current.mutes, [scopeKey]: { until, at, op } },
    }));
  }, [edit]);

  const unmute = useCallback((scopeKey: string) => {
    edit((current, at, op) => ({
      levels: current.levels[scopeKey]?.v === "nothing"
        ? { ...current.levels, [scopeKey]: { at, op } }
        : current.levels,
      mutes: { ...current.mutes, [scopeKey]: { until: MUTE_OFF, at, op } },
    }));
  }, [edit]);

  return useMemo(() => ({
    ...resolved,
    getLevel,
    setLevel,
    levels,
    chosen,
    standing,
    roomMutes: timedRoomMutes,
    muteUntil,
    setMute,
    unmute,
  }), [resolved, getLevel, setLevel, levels, chosen, standing, timedRoomMutes, muteUntil, setMute, unmute]);
}
