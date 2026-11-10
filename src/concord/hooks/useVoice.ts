import { useNostr } from "@nostrify/react";
import { clockNowMs } from "@/lib/relayClock";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_SEAL_ENCRYPTED, KIND_VOICE_DIRECTIVE, KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import { canActOnMember } from "@/concord/lib/roles";
import { subscribeEphemeral } from "@/concord/lib/ephemeralSub";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
} from "@/concord/lib/stream";
import { citationFor, useControlFold } from "@/concord/hooks/useControlPlane";
import { mayConnect } from "@/concord/lib/callGate";
import { citationToTag } from "@/concord/lib/edition";
import {
  applyDirective,
  communityAvBrokers,
  directiveInWindow,
  directivePermission,
  directiveTags,
  fetchAvTokenFromAny,
  foldVoicePresence,
  greetDelayMs,
  directivesToReassert,
  heartbeatDelayMs,
  isNewcomer,
  notePresence,
  parseDirective,
  parsePresence,
  parseReaction,
  presenceTags,
  prunePresence,
  probeAvBroker,
  reactionTag,
  rendezvousCandidates,
  VOICE_STALE_MS,
  type AvToken,
  type VoiceDirective,
  type VoiceDirectiveVerb,
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

/** Drop the decrypted presence this session learned, and the directives this account stood behind. */
export function clearVoicePresenceMemory(): void {
  sharedLatest.clear();
  standingDirectives.clear();
}

/** Per channel wrap address, who answers a newcomer's presence (see `useVoiceHeartbeat`). */
const newcomerListeners = new Map<string, Set<(author: string) => void>>();

function onNewcomer(currentPk: string, listener: (author: string) => void): () => void {
  let set = newcomerListeners.get(currentPk);
  if (!set) newcomerListeners.set(currentPk, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) newcomerListeners.delete(currentPk);
  };
}

/** Per channel wrap address, who acts on an authorized directive (the call obeying its own). */
const directiveListeners = new Map<string, Set<(d: VoiceDirective) => void>>();

/** Hear the authorized, in-window voice directives at one Channel's address (CORD-07 §7). */
export function onVoiceDirective(currentPk: string, listener: (d: VoiceDirective) => void): () => void {
  let set = directiveListeners.get(currentPk);
  if (!set) directiveListeners.set(currentPk, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) directiveListeners.delete(currentPk);
  };
}

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
  const { data: folded } = useControlFold(community);
  const bannedRef = useRef(folded?.banned);
  bannedRef.current = folded?.banned;
  const foldedRef = useRef(folded);
  foldedRef.current = folded;

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
      const now = clockNowMs();
      prunePresence(latest.current, now);
      // A banned author's presence doesn't count (Vector `author_is_banned_here`), nor
      // one the Channel doesn't let connect (Vector `may_connect`).
      const banned = bannedRef.current;
      const control = foldedRef.current;
      const next = foldVoicePresence(
        [...latest.current.values()].filter((e) => !banned?.has(e.author) && mayConnect(control, channelIdHex, channel.isPrivate, e.author)),
        now,
      );
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
              p.muted === next.present[i].muted &&
              p.deafened === next.present[i].deafened &&
              p.screen === next.present[i].screen &&
              p.camera === next.present[i].camera &&
              p.serverMuted === next.present[i].serverMuted &&
              p.serverDeafened === next.present[i].serverDeafened &&
              p.alsoOn === next.present[i].alsoOn &&
              p.bridge === next.present[i].bridge &&
              p.screenShareIdentities.join("\0") ===
                next.present[i].screenShareIdentities.join("\0"),
          ) &&
          sameClaims(prev.claims, next.claims) &&
          prev.otherTransport.length === next.otherTransport.length &&
          prev.otherTransport.every(
            (p, i) =>
              p.author === next.otherTransport[i].author &&
              p.transport === next.otherTransport[i].transport &&
              p.muted === next.otherTransport[i].muted &&
              p.deafened === next.otherTransport[i].deafened &&
              p.serverMuted === next.otherTransport[i].serverMuted &&
              p.serverDeafened === next.otherTransport[i].serverDeafened,
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
        if (opened.sealKind !== KIND_SEAL_ENCRYPTED) return;
        if (opened.kind === KIND_VOICE_DIRECTIVE) {
          checkChannelBinding(opened, channelIdHex, epoch);
          const d = parseDirective(opened);
          const control = foldedRef.current;
          // Judged on arrival by the Roster as it stands, server-wide, never waiting on its `vac` (CORD-07 §7).
          if (!d || !control || control.banned.has(d.author)) return;
          if (!canActOnMember(control.roster, d.author, control.ownerHex, d.target, directivePermission(d.verb))) return;
          const now = clockNowMs();
          if (!directiveInWindow(latest.current.get(d.target), d.ms, now)) return;
          const changed = applyDirective(latest.current, d, now);
          if (changed) recompute();
          // A mute or deafen that lost to a newer one changes nobody's call (Vector `yield_voice_directive`).
          if (!changed && d.verb !== "move" && d.verb !== "disconnect") return;
          for (const listener of directiveListeners.get(currentPk) ?? []) listener(d);
          return;
        }
        if (opened.kind !== KIND_VOICE_PRESENCE) return;
        checkChannelBinding(opened, channelIdHex, epoch);
        const entry = parsePresence(opened);
        if (!entry) return;
        const now = clockNowMs();
        const newcomer = isNewcomer(latest.current.get(entry.author), entry, now);
        if (!notePresence(latest.current, entry, now)) return;
        recompute();
        if (newcomer) for (const listener of newcomerListeners.get(currentPk) ?? []) listener(entry.author);
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

/** Per (Channel address, target), the mutes and deafens this device stands behind (CORD-07 §7). */
const standingDirectives = new Map<string, Set<VoiceDirectiveVerb>>();
/** Per Channel address, the mounted moderation hooks; the first re-asserts, so a rejoin sends once. */
const reasserters = new Map<string, symbol[]>();

/**
 * A moderator's voice directives in one Channel's call (CORD-07 §7): `send` signs one
 * when this member holds its bit server-wide and strictly outranks the target. Mutes
 * and deafens this device sent are re-asserted whenever their target rejoins, dated
 * when sent, until a newer lift from anyone ends them.
 */
export function useVoiceModeration(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const currentPk = channel?.current.group.pk;

  const may = useCallback(
    (target: string, verb: VoiceDirectiveVerb) =>
      Boolean(user && folded && !folded.banned.has(user.pubkey) && canActOnMember(folded.roster, user.pubkey, folded.ownerHex, target, directivePermission(verb))),
    [user, folded],
  );

  const publish = useCallback(
    async (target: string, verb: VoiceDirectiveVerb, to?: string) => {
      if (!user || !community || !channel || !currentPk) return false;
      const citation = citationFor(community, folded, user.pubkey);
      const rumor = buildRumor({
        kind: KIND_VOICE_DIRECTIVE,
        content: "",
        tags: [
          ...channelBindingTags(channel.idHex, channel.current.epoch),
          ...directiveTags(target, verb, to),
          ...(citation ? [citationToTag(citation)] : []),
        ],
        pubkey: user.pubkey,
        ms: clockNowMs(),
      });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = await wrapSeal(seal, channel.current.group, { ephemeral: true });
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
      );
      return results.some((r) => r.status === "fulfilled");
    },
    [nostr, user, community, channel, currentPk, folded],
  );
  const publishRef = useRef(publish);
  publishRef.current = publish;
  const mayRef = useRef(may);
  mayRef.current = may;

  const send = useCallback(
    async (target: string, verb: VoiceDirectiveVerb, to?: string) => {
      if (!currentPk || !may(target, verb)) return false;
      const sent = await publish(target, verb, to);
      if (!sent) return false;
      const key = `${currentPk}|${target}`;
      const set = standingDirectives.get(key) ?? new Set<VoiceDirectiveVerb>();
      if (verb === "mute" || verb === "deafen") set.add(verb);
      else if (verb === "unmute") set.delete("mute");
      else if (verb === "undeafen") set.delete("deafen");
      else set.clear();
      if (set.size > 0) standingDirectives.set(key, set);
      else standingDirectives.delete(key);
      return true;
    },
    [currentPk, may, publish],
  );

  useEffect(() => {
    if (!currentPk) return;
    const me = Symbol(currentPk);
    reasserters.set(currentPk, [...(reasserters.get(currentPk) ?? []), me]);
    // Back in the call: re-send what this device stands behind.
    const stopRejoins = onNewcomer(currentPk, (author) => {
      if (reasserters.get(currentPk)?.[0] !== me) return;
      const key = `${currentPk}|${author}`;
      const standing = standingDirectives.get(key);
      for (const verb of directivesToReassert(standing, author, mayRef.current)) {
        void publishRef.current(author, verb).catch(() => undefined);
      }
      if (standing?.size === 0) standingDirectives.delete(key);
    });
    // A newer lift from anyone ends what this device stood behind.
    const stopLifts = onVoiceDirective(currentPk, (d) => {
      const set = standingDirectives.get(`${currentPk}|${d.target}`);
      if (d.verb === "unmute") set?.delete("mute");
      if (d.verb === "undeafen") set?.delete("deafen");
    });
    return () => {
      stopRejoins();
      stopLifts();
      const rest = (reasserters.get(currentPk) ?? []).filter((h) => h !== me);
      if (rest.length > 0) reasserters.set(currentPk, rest);
      else reasserters.delete(currentPk);
    };
  }, [currentPk]);

  return { may, send };
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
  /** What the call shows of this member (CORD-07 §4), re-sent the moment it changes. */
  media: { muted: boolean; screen: boolean; camera: boolean } = { muted: false, screen: false, camera: false },
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
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const mediaKey = `${media.muted}|${media.screen}|${media.camera}`;
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
            ...mediaRef.current,
          }),
          ...(reaction ? [reactionTag(reaction.emoji, reaction.nonce)] : []),
        ],
        pubkey: user.pubkey,
        ms: clockNowMs(),
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
    // Answer a newcomer within a couple of seconds, jittered, one answer in flight (CORD-07 §4).
    let greet: ReturnType<typeof setTimeout> | undefined;
    const stopGreeting = onNewcomer(channel.current.group.pk, (author) => {
      if (author === user.pubkey || greet !== undefined) return;
      greet = setTimeout(() => {
        greet = undefined;
        void publish("joined", identity, broker).catch(() => undefined);
      }, greetDelayMs());
    });
    return () => {
      clearTimeout(timer);
      clearTimeout(greet);
      stopGreeting();
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
  }, [handRaised, noRecord, mediaKey, identity, broker]);

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
