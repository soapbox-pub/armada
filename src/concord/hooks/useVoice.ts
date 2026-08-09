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
import {
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
import { preferredVoiceServerOrigin } from "@/lib/voiceDevices";

import type { NostrEvent } from "@nostrify/nostrify";
import { channelWriteGroup } from "@/concord/lib/community";

/** The stable empty fold (so idle rows keep constant props). */
const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map() };

/**
 * Shared presence memory, keyed by the channel's current wrap address (one map
 * of author → latest entry per channel+epoch). Presence is ephemeral — never
 * stored on relays — so a freshly-mounted subscription starts blind and waits
 * up to a full heartbeat (30s) to re-learn who is in the call. Sharing the
 * latest-entry map across hook instances lets a new subscriber (the call room
 * mounted on join) seed instantly from what another instance (the sidebar
 * roster, which was necessarily mounted to click "join") already learned —
 * without it, every remote tile rendered "Unverified" and media keys stayed
 * withheld for the opening seconds of a call. Stale entries are pruned at
 * recompute time, so the maps stay bounded by live-ish participants.
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
 * Live voice presence for one Concord channel (CORD-07 §4): ephemeral kind-23313
 * rumors in 21059 wraps at the channel's current address, sealed under the
 * channel key — relays and brokers never learn who is in a call. Presence is
 * subscription-only (never stored); a `joined` older than 90s counts as
 * absent, so a missed `left` heals by staleness.
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
    // Seed from the shared per-channel memory (see `sharedLatest`) so a
    // freshly-mounted subscriber starts from everything already learned.
    latest.current = latestFor(currentPk);
    const group = channel.current.group;
    const epoch = channel.current.epoch;

    const recompute = () => {
      const now = Date.now();
      // Prune long-stale entries so the shared map stays bounded. Anything a
      // pruned entry could out-rank (latest-wins) is even older, so dropping
      // it never lets an older presence re-assert.
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
              p.hand === next.present[i].hand,
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

    // Publish the seeded view immediately — don't wait for the first live
    // event to fold what the shared memory already knows.
    recompute();

    // One shared 21059 REQ per relay across every mounted channel — see
    // `ephemeralSub.ts`.
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
 * Announce this member's own call presence (§4): a `joined` (carrying the
 * broker-assigned SFU identity + the broker rendezvous hint) immediately and
 * every 30s while `identity` is set, and a best-effort `left` on teardown — a
 * missed one heals by staleness. Sealed under the channel key like every Chat
 * rumor, with the channel/epoch binding.
 *
 * It also carries the two Armada client extensions (see voice.ts): the sticky
 * `hand` state on every heartbeat, republished off-cycle the instant it
 * toggles; and `sendReaction`, which fires a transient emoji on an off-cycle
 * `joined` (doubling as a heartbeat). Both ride additive tags on the same
 * kind-23313 rumor, so they inherit its blindness — brokers/relays never see
 * them — with no new frozen kind (CORD-02 §6).
 */
export function useVoiceHeartbeat(
  community: Community | undefined,
  channel: Channel | undefined,
  identity: string | undefined,
  broker: string | undefined,
  handRaised = false,
): { sendReaction: (emoji: string) => void } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  // The interval and reaction sender read the live hand state through a ref so a
  // toggle doesn't tear down and re-arm the heartbeat (a transient `left` would
  // flicker every remote roster). The dedicated effect below republishes on the
  // toggle itself for immediacy.
  const handRef = useRef(handRaised);
  handRef.current = handRaised;

  const publish = useCallback(
    async (
      status: "joined" | "left",
      id?: string,
      origin?: string,
      reaction?: { emoji: string; nonce: string },
    ) => {
      if (!user || !community || !channel) return;
      const rumor = buildRumor({
        kind: KIND_VOICE_PRESENCE,
        content: status,
        tags: [
          ...channelBindingTags(channel.idHex, channel.current.epoch),
          ...presenceTags(status, id, origin, { hand: handRef.current }),
          ...(reaction ? [reactionTag(reaction.emoji, reaction.nonce)] : []),
        ],
        pubkey: user.pubkey,
        ms: Date.now(),
      });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = wrapSeal(seal, channelWriteGroup(channel), { ephemeral: true });
      await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
      );
    },
    [nostr, user, community, channel],
  );

  useEffect(() => {
    if (!identity || !broker || !user || !community || !channel) return;
    void publish("joined", identity, broker).catch(() => undefined);
    // Self-rescheduling rather than a fixed interval, so each hop re-jitters
    // (see `heartbeatDelayMs` for why the spread is downward only).
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

  // Republish immediately when the hand toggles (while joined) so others see it
  // without waiting up to 30s for the next heartbeat. Skips the initial mount —
  // the join heartbeat above already carries the starting state.
  const mounted = useRef(false);
  useEffect(() => {
    if (!identity || !broker) return;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void publish("joined", identity, broker).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handRaised, identity, broker]);

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

  return { sendReaction };
}

/** How long a received reaction floats before it's aged out. */
const REACTION_TTL_MS = 4000;

/**
 * Live in-call emoji reactions for one Concord channel (Armada client extension,
 * see voice.ts): the `react` tag on ephemeral kind-23313 rumors. Like typing
 * and presence, this is subscription-only (relays never store the wrap); a
 * live `req()` per relay feeds a decaying list, fired once per unseen nonce.
 * Own reactions echo back through the same subscription, so they animate too
 * without a separate optimistic path.
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

    // Shares the presence hook's per-relay 21059 REQ — same relay, same
    // author — so reactions cost no extra subscription (see `ephemeralSub.ts`).
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
 * The client's own default AV servers, in preference order: the user's
 * Settings → Voice server first (when set), then the deployment's build-time
 * defaults. Consulted only when a room is empty — an occupied room's
 * presence-announced brokers always win the rendezvous (§5).
 */
export function ownAvServers(): string[] {
  const preferred = preferredVoiceServerOrigin();
  return preferred ? [preferred, ...CONCORD_AV_SERVERS] : [...CONCORD_AV_SERVERS];
}

/**
 * Imperatively resolve a reachable broker for a room (the same §5 rendezvous
 * `useVoiceBroker` runs, but live). Used at join time when the cached query
 * value is missing or a previous probe failed — a stale `null` must not block
 * a join that would succeed now.
 */
export async function resolveVoiceBroker(
  roomHex: string,
  fold: VoicePresenceFold,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const origin of rendezvousCandidates(roomHex, fold, ownAvServers())) {
    if (await probeAvBroker(origin, signal)) return origin;
  }
  return null;
}

/**
 * The §5 rendezvous: resolve the broker to join this channel's call through.
 * If anyone is present, their broker wins (tie-break ordered); an empty room
 * falls back to the deployment's own defaults. Every candidate is probed
 * (`GET /.well-known/concord/av` → 204) and the first reachable one is it.
 */
export function useVoiceBroker(
  channel: Channel | undefined,
  fold: VoicePresenceFold,
): { data: string | null | undefined; isLoading: boolean } {
  const roomHex = channel?.voice.room.pk;
  const candidates = useMemo(
    () => (roomHex ? rendezvousCandidates(roomHex, fold, ownAvServers()) : []),
    [roomHex, fold],
  );
  // The probe answers a question about an ORIGIN, not about a channel, and
  // `candidatesKey` already captures everything the queryFn reads (including
  // the room-derived ordering). Keying on the channel too would give every
  // channel in a community its own entry for the same idle-room candidate
  // list — N identical probes to the same broker on every mount.
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
 * Mint an SFU token from the chosen blind broker (§2). The token embeds the
 * broker-assigned random identity, which keys this member's per-sender frame
 * key and rides their presence — so a refetch would change WHO we are
 * mid-call. Never auto-refetch while mounted.
 */
export function useAvToken(
  channel: Channel | undefined,
  broker: string | undefined,
  enabled: boolean,
  /**
   * Further §5 candidates to try if `broker` cannot mint. Deliberately absent
   * from the query key: presence churns the candidate list constantly, and
   * rekeying on it would remint — handing the room a NEW identity mid-call.
   */
  fallbacks: readonly string[] = [],
) {
  return useQuery<AvToken>({
    queryKey: ["concord", "av-token", channel?.idHex ?? null, channel?.current.epoch.toString(), broker],
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
