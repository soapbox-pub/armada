import { useCallback, useMemo } from "react";

import { channelReadKey } from "@/contexts/ReadStateContext";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { MUTE_FOREVER } from "@/lib/notifRecords";
import { normalizeRelayUrl } from "@/lib/platform";

/** Normalized relay URL for NIP-29, `c2:${communityId}` for Concord — the rail key scheme. */
export function communityMuteKey(relayUrlOrRailKey: string): string {
  if (relayUrlOrRailKey.startsWith("c2:")) {
    return relayUrlOrRailKey;
  }
  return normalizeRelayUrl(relayUrlOrRailKey) ?? relayUrlOrRailKey;
}

/** `${relayUrl}::${groupId}` with the URL normalized, like read state. */
export function channelMuteKey(relayUrl: string, groupId: string): string {
  return channelReadKey(normalizeRelayUrl(relayUrl) ?? relayUrl, groupId);
}

/** `c2:${communityId}::${channelIdHex}`, mirroring the NIP-29 shape. */
export function concordChannelMuteKey(
  protocol: "c2",
  communityId: string,
  channelIdHex: string,
): string {
  return `${protocol}:${communityId}::${channelIdHex}`;
}

export interface UseMutesReturn {
  /** Community scope keys whose own level in force is `nothing`. */
  mutedCommunities: Set<string>;
  /** Channel scope keys whose own level in force is `nothing`. */
  mutedChannels: Set<string>;
  isCommunityMuted: (railKey: string) => boolean;
  /** Individually or via its whole server. */
  isChannelMuted: (relayUrl: string, groupId: string) => boolean;
  /** Individually or via its whole community. */
  isConcordChannelMuted: (
    protocol: "c2",
    communityId: string,
    channelIdHex: string,
  ) => boolean;
  /**
   * Until when the scope itself is silenced: a running mute's end, or `MUTE_FOREVER`
   * for one with no end or a chosen `nothing` level. Undefined when it isn't.
   */
  mutedUntil: (scopeKey: string) => number | undefined;
  /** Mute until `until` (epoch seconds, or `MUTE_FOREVER`). */
  mute: (scopeKey: string, until: number) => void;
  unmute: (scopeKey: string) => void;
}

/**
 * Mutes over {@link useNotifLevels}: "muted" is a level of `nothing` in force,
 * whether from a running mute or a chosen level, and unmuting clears both.
 */
export function useMutes(): UseMutesReturn {
  const { levels, getLevel, muteUntil, setMute, unmute } = useNotifLevels();

  const { mutedCommunities, mutedChannels } = useMemo(() => {
    const communities = new Set<string>();
    const channels = new Set<string>();
    for (const [scope, level] of Object.entries(levels)) {
      if (level !== "nothing" || scope.startsWith("dm:")) continue;
      (scope.includes("::") ? channels : communities).add(scope);
    }
    return { mutedCommunities: communities, mutedChannels: channels };
  }, [levels]);

  // Explicit `nothing` at the scope or inherited from the community — NOT the global-prefs
  // fallback, so turning off a global toggle never silences every badge.
  const isCommunityMuted = useCallback(
    (railKey: string) => getLevel(communityMuteKey(railKey)) === "nothing",
    [getLevel],
  );

  const isChannelMuted = useCallback(
    (relayUrl: string, groupId: string) =>
      getLevel(channelMuteKey(relayUrl, groupId)) === "nothing" ||
      getLevel(communityMuteKey(relayUrl)) === "nothing",
    [getLevel],
  );

  const isConcordChannelMuted = useCallback(
    (protocol: "c2", communityId: string, channelIdHex: string) =>
      getLevel(concordChannelMuteKey(protocol, communityId, channelIdHex)) === "nothing" ||
      getLevel(`${protocol}:${communityId}`) === "nothing",
    [getLevel],
  );

  const mutedUntil = useCallback(
    (scopeKey: string) =>
      muteUntil(scopeKey) ?? (getLevel(scopeKey) === "nothing" ? MUTE_FOREVER : undefined),
    [muteUntil, getLevel],
  );

  return {
    mutedCommunities,
    mutedChannels,
    isCommunityMuted,
    isChannelMuted,
    isConcordChannelMuted,
    mutedUntil,
    mute: setMute,
    unmute,
  };
}
