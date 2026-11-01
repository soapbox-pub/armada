import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_SEAL_ENCRYPTED, KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import { subscribeEphemeral } from "@/concord/lib/ephemeralSub";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
} from "@/concord/lib/stream";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import {
  communityAvBrokers,
  fetchAvTokenFromAny,
  foldVoicePresence,
  heartbeatDelayMs,
  parsePresence,
  parseReaction,
  presenceTags,
  probeAvBroker,
  reactionTag,
  rendezvousCandidates,
  VOICE_STALE_MS,
  type AvToken,
  type VoicePresenceEntry,
  type VoicePresenceFold,
  type VoiceReactionEntry,
} from "@/concord/lib/voice";
import type { Channel, Community } from "@/concord/lib/types";
import { CONCORD_AV_SERVERS } from "@/lib/platform";
import { effectiveAvServers } from "@/lib/voiceDevices";

import type { NostrEvent } from "@nostrify/nostrify";
import { t } from "@/i18n";

/** The stable empty fold (so idle rows keep constant props). */
const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map(), otherTransport: [] };

function sameClaims(left: Map<string, string[]>, right: Map<string, string[]>): boolean {
  if (left.size !== right.size) return false;
  for (const [identity, authors] of left) {
    const next = right.get(identity);
    if (!next || next.length !== authors.length) return false;
    if (authors.some((author, index) => author !== next[index])) return false;
  }
  return true;
}

/**
 * Shared presence memory per channel wrap address (author → latest entry).
 * Presence is ephemeral, so a new subscriber (the call room) seeds from what
 * another instance (the sidebar roster) learned rather than waiting a 30s
 * heartbeat with tiles "Unverified". Pruned at recompute time.
 */
const sharedLatest = new Map<string, Map<string, VoicePresenceEntry>>();

function latestFor(currentPk: string): Map<string, VoicePresenceEntry> {
  let map = sharedLatest.get(currentPk);
  if (!map) {
    map = new Map();
    sharedLatest.set(currentPk, map);
  }
  return map;
}

/**
 * Live voice presence for one channel (CORD-07 §4): ephemeral kind-23313 rumors
 * in 21059 wraps at the channel's current address, sealed under the channel key.
 * Never stored; a `joined` older than 90s counts as absent.
 */
export function useVoicePresence(
  community: Community | undefined,
  channel: Channel | undefined,
): VoicePresenceFold {
  const { nostr } = useNostr();
  const [fold, setFold] = useState<VoicePresenceFold>(EMPTY_FOLD);
  const latest = useRef(new Map<string, VoicePresenceEntry>());

  const channelIdHex = channel?.idHex ?? null;
  const currentPk = channel?.current.group.pk;

  useEffect(() => {
    setFold(EMPTY_FOLD);
    if (!community || !channel || !channelIdHex || !currentPk) {
      latest.current = new Map();
      return;
    }
    // Seed from the shared per-channel memory (see `sharedLatest`).
    latest.current = latestFor(currentPk);
    const group = channel.current.group;
    const epoch = channel.current.epoch;

    const recompute = () => {
      const now = Date.now();
      // Prune long-stale entries; anything they could out-rank is even older.
      for (const [author, entry] of latest.current) {
        if (now - entry.ms > VOICE_STALE_MS) latest.current.delete(author);
      }
      const next = foldVoicePresence([...latest.current.values()], now);
      setFold((prev) => {
        if (
          prev.present.length === next.present.length &&
          prev.present.every(
            (p, i) =>
              p.author === next.present[i].author &&
              p.identity === next.present[i].identity &&
              p.broker === next.present[i].broker &&
              p.hand === next.present[i].hand &&
              p.recording === next.present[i].recording &&
              p.noRecord === next.present[i].noRecord &&
              p.screenShareIdentities.join("\0") ===
                next.present[i].screenShareIdentities.join("\0"),
          ) &&
          sameClaims(prev.claims, next.claims) &&
          prev.otherTransport.length === next.otherTransport.length &&
          prev.otherTransport.every(
            (p, i) => p.author === next.otherTransport[i].author && p.transport === next.otherTransport[i].transport,
          )
        ) {
          return prev;
        }
        return next;
      });
    };

    const apply = (event: NostrEvent) => {
      try {
        const opened = openWrap(event, group);
        if (opened.kind !== KIND_VOICE_PRESENCE) return;
        checkChannelBinding(opened, channelIdHex, epoch);
        const entry = parsePresence(opened);
        if (!entry) return;
        // Reject far-future stamps so a forged date can't squat "latest".
        if (entry.ms > Date.now() + 60_000) return;
        const prev = latest.current.get(entry.author);
        if (!prev || entry.ms > prev.ms || (entry.ms === prev.ms && entry.rumorId < prev.rumorId)) {
          latest.current.set(entry.author, entry);
        }
        recompute();
      } catch {
        // not ours / malformed
      }
    };

    // Publish the seeded view immediately.
    recompute();

    // One shared 21059 REQ per relay across channels (see `ephemeralSub.ts`).
    const unsubs = community.relays.map((url) => subscribeEphemeral(nostr, url, currentPk, apply));

    // Staleness decay: three missed heartbeats age a participant out.
    const decay = setInterval(recompute, VOICE_STALE_MS / 6);
    return () => {
      for (const unsub of unsubs) unsub();
      clearInterval(decay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, channelIdHex, currentPk]);

  return fold;
}

/**
 * Announce own call presence (§4): `joined` (SFU identity + broker hint) now and
 * every 30s while `identity` is set, best-effort `left` on teardown.
 * Also carries Armada extensions (see voice.ts): the sticky `hand`, `norecord`
 * and `recording` states, and `sendReaction` on an off-cycle `joined` — additive
 * tags on the same kind-23313 rumor, so no new frozen kind (CORD-02 §6).
 */
export function useVoiceHeartbeat(
  community: Community | undefined,
  channel: Channel | undefined,
  identity: string | undefined,
  broker: string | undefined,
  handRaised = false,
  additionalIdentities: readonly string[] = [],
  noRecord = false,
): {
  sendReaction: (emoji: string) => void;
  announceAdditionalIdentities: (identities: readonly string[]) => Promise<void>;
  announceRecording: (recording: boolean) => Promise<boolean>;
} {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  // Read hand state through a ref so a toggle doesn't re-arm the heartbeat (a
  // transient `left` would flicker every remote roster).
  const handRef = useRef(handRaised);
  handRef.current = handRaised;
  const noRecordRef = useRef(noRecord);
  noRecordRef.current = noRecord;
  // Set only through `announceRecording`, whose caller must see the delivery.
  const recordingRef = useRef(false);
  const additionalIdentitiesRef = useRef(additionalIdentities);
  additionalIdentitiesRef.current = additionalIdentities;
  const additionalIdentitiesKey = additionalIdentities.join("\0");

  const publish = useCallback(
    async (
      status: "joined" | "left",
      id?: string,
      origin?: string,
      reaction?: { emoji: string; nonce: string },
    ) => {
      if (!user || !community || !channel) return false;
      const rumor = buildRumor({
        kind: KIND_VOICE_PRESENCE,
        content: status,
        tags: [
          ...channelBindingTags(channel.idHex, channel.current.epoch),
          ...presenceTags(status, id, origin, {
            hand: handRef.current,
            recording: recordingRef.current,
            noRecord: noRecordRef.current,
            additionalIdentities: additionalIdentitiesRef.current,
          }),
          ...(reaction ? [reactionTag(reaction.emoji, reaction.nonce)] : []),
        ],
        pubkey: user.pubkey,
        ms: Date.now(),
      });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = await wrapSeal(seal, channel.current.group, { ephemeral: true });
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
      );
      return results.some((result) => result.status === "fulfilled");
    },
    [nostr, user, community, channel],
  );

  useEffect(() => {
    if (!identity || !broker || !user || !community || !channel) return;
    void publish("joined", identity, broker).catch(() => undefined);
    // Self-rescheduling so each hop re-jitters (see `heartbeatDelayMs`).
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        void publish("joined", identity, broker).catch(() => undefined);
        schedule();
      }, heartbeatDelayMs());
    };
    schedule();
    return () => {
      clearTimeout(timer);
      void publish("left").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, broker, user?.pubkey, community?.idHex, channel?.idHex]);

  // Republish immediately on hand toggle; skip mount (the join heartbeat has it).
  const mounted = useRef(false);
  useEffect(() => {
    if (!identity || !broker) return;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void publish("joined", identity, broker).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handRaised, noRecord, identity, broker]);

  // Separate from the main heartbeat effect, whose teardown would emit a `left`.
  const identitiesMounted = useRef(false);
  useEffect(() => {
    if (!identity || !broker) return;
    if (!identitiesMounted.current) {
      identitiesMounted.current = true;
      return;
    }
    void publish("joined", identity, broker).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [additionalIdentitiesKey, identity, broker]);

  const sendReaction = useCallback(
    (emoji: string) => {
      if (!identity || !broker) return;
      const nonce =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      void publish("joined", identity, broker, { emoji, nonce }).catch(() => undefined);
    },
    [publish, identity, broker],
  );

  const announceAdditionalIdentities = useCallback(
    async (identities: readonly string[]) => {
      additionalIdentitiesRef.current = identities;
      if (!identity || !broker) return;
      const delivered = await publish("joined", identity, broker);
      if (identities.length > 0 && !delivered) {
        throw new Error(
          t({ id: "useVoice.h265AnnounceFailed", defaultMessage: "Could not announce the H.265 publisher identity to a community relay." }),
        );
      }
    },
    [broker, identity, publish],
  );

  /** Resolves whether a relay took the announcement; a recorder captures only after `true`. */
  const announceRecording = useCallback(
    async (recording: boolean) => {
      recordingRef.current = recording;
      if (!identity || !broker) return false;
      try {
        return await publish("joined", identity, broker);
      } catch {
        return false;
      }
    },
    [broker, identity, publish],
  );

  return { sendReaction, announceAdditionalIdentities, announceRecording };
}

/** How long a received reaction floats before it's aged out. */
const REACTION_TTL_MS = 4000;

/**
 * In-call emoji reactions (Armada extension, see voice.ts): the `react` tag on
 * ephemeral kind-23313 rumors, fired once per unseen nonce. Own reactions echo
 * back through the same subscription.
 */
export function useVoiceReactions(
  community: Community | undefined,
  channel: Channel | undefined,
): VoiceReactionEntry[] {
  const { nostr } = useNostr();
  const [reactions, setReactions] = useState<VoiceReactionEntry[]>([]);
  const seen = useRef(new Set<string>());

  const channelIdHex = channel?.idHex ?? null;
  const currentPk = channel?.current.group.pk;

  useEffect(() => {
    seen.current = new Set();
    setReactions([]);
    if (!community || !channel || !channelIdHex || !currentPk) return;
    const group = channel.current.group;
    const epoch = channel.current.epoch;

    const decay = () => {
      const cutoff = Date.now() - REACTION_TTL_MS;
      setReactions((prev) => {
        const live = prev.filter((r) => r.ms > cutoff);
        return live.length === prev.length ? prev : live;
      });
    };

    const apply = (event: NostrEvent) => {
      try {
        const opened = openWrap(event, group);
        if (opened.kind !== KIND_VOICE_PRESENCE) return;
        checkChannelBinding(opened, channelIdHex, epoch);
        const entry = parseReaction(opened);
        if (!entry) return;
        // Fire once per nonce; drop replays and anything already expired.
        if (seen.current.has(entry.nonce)) return;
        if (Date.now() - entry.ms > REACTION_TTL_MS) return;
        seen.current.add(entry.nonce);
        // Bound the dedup memory over a long call.
        if (seen.current.size > 512) {
          seen.current = new Set([...seen.current].slice(-256));
        }
        setReactions((prev) => [...prev, entry]);
      } catch {
        // not ours / malformed / a plain heartbeat
      }
    };

    // Shares the presence hook's per-relay 21059 REQ (see `ephemeralSub.ts`).
    const unsubs = community.relays.map((url) => subscribeEphemeral(nostr, url, currentPk, apply));

    const timer = setInterval(decay, REACTION_TTL_MS / 2);
    return () => {
      for (const unsub of unsubs) unsub();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, channelIdHex, currentPk]);

  return reactions;
}

/**
 * This client's default AV servers: Settings → Voice server if set (a
 * replacement, not additive), else build-time defaults. Used only when no
 * community publishes brokers (§5), and alone for DM calls.
 */
export function ownAvServers(): string[] {
  return effectiveAvServers(CONCORD_AV_SERVERS);
}

/**
 * The community's brokers (CORD-02 §6) from the Control fold, not a join-time
 * snapshot. Callers holding the fold should use `communityAvBrokers` directly.
 */
export function useCommunityAvBrokers(community: Community | undefined): string[] {
  const { data: folded } = useControlFold(community);
  return useMemo(() => communityAvBrokers(folded?.metadata), [folded?.metadata]);
}

/**
 * Imperatively resolve a reachable broker (as `useVoiceBroker` does), for join
 * time when the cached value is missing or stale.
 */
export async function resolveVoiceBroker(
  roomHex: string,
  communityBrokers: string[] = [],
  signal?: AbortSignal,
): Promise<string | null> {
  for (const origin of rendezvousCandidates(roomHex, ownAvServers(), communityBrokers)) {
    if (await probeAvBroker(origin, signal)) return origin;
  }
  return null;
}

/**
 * The broker to join through: the community's own if it publishes any, else this
 * client's config — never one a member's presence points at (see
 * `rendezvousCandidates`). First to answer `GET /.well-known/concord/av` → 204
 * wins. Takes no presence fold, so idle rows don't re-resolve per heartbeat.
 */
export function useVoiceBroker(
  channel: Channel | undefined,
  communityBrokers: string[] = [],
): { data: string | null | undefined; isLoading: boolean } {
  const roomHex = channel?.voice.room.pk;
  // Keyed by CONTENT, since callers may pass fresh array literals.
  const brokersKey = communityBrokers.join(",");
  const candidates = useMemo(
    () => (roomHex ? rendezvousCandidates(roomHex, ownAvServers(), brokersKey ? brokersKey.split(",") : []) : []),
    [roomHex, brokersKey],
  );
  // The probe is about an ORIGIN; keying on the channel would repeat identical
  // probes per channel.
  const candidatesKey = candidates.join(",");

  return useQuery<string | null>({
    queryKey: ["concord", "av-broker", candidatesKey],
    enabled: Boolean(roomHex),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      for (const origin of candidates) {
        if (await probeAvBroker(origin, signal)) return origin;
      }
      return null;
    },
  });
}

/**
 * Mint an SFU token from the blind broker (§2). It embeds the member's
 * broker-assigned identity, so a refetch would change who we are mid-call —
 * never auto-refetch.
 */
export function useAvToken(
  channel: Channel | undefined,
  broker: string | undefined,
  enabled: boolean,
  /**
   * Further §5 candidates if `broker` can't mint. Not in the query key: presence
   * churn would remint a new identity mid-call.
   */
  fallbacks: readonly string[] = [],
) {
  return useQuery<AvToken>({
    // Key on the room pubkey, not the epoch: a refounding can reuse an epoch number,
    // and the SFU rejects a token for another room. Matches callSync's rejoin test.
    queryKey: ["concord", "av-token", channel?.idHex ?? null, channel?.voice?.room.pk ?? null, broker],
    enabled: enabled && Boolean(channel?.voice && broker),
    queryFn: async () => fetchAvTokenFromAny([broker!, ...fallbacks], channel!.voice.room),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}
