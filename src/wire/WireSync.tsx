import { App as CapacitorApp } from "@capacitor/app";
import { restrictedPostersIn, restrictedWritersIn, sendDeniedIn } from "@/concord/lib/channelJudges";
import { storedGuestbookExtras, type GuestbookExtras } from "@/concord/lib/guestbookExtras";
import { accountClockRelays, CLOCK_RESYNC_MS, nowSecs, syncClock } from "@/lib/relayClock";
import { drainWrapScrubs, purgeDeletedChannel, queuedWrapScrubs } from "@/concord/lib/channelPurge";
import { useAccountSecret } from "@/hooks/useAccountSecret";
import { deleteBlobs } from "@/lib/blossomDelete";
import { heldRoleMentions, roleMentionAuthors, type HeldRoleMention } from "@/concord/lib/roleMentions";
import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { isBackgroundQuiet, onBackgroundQuiet } from "@/lib/backgroundQuiet";
import { isRelayUnreachable, onRelayHealthChange, relayHealthVersion } from "@/lib/relayHealth";
import { useBootGateOpen } from "@/lib/bootGate";

import { useJoinedCommunities } from "@/concord/hooks/useCommunityList";
import { dissolvedAt, readLivePause } from "@/concord/hooks/useControlPlane";
import { openChatBatch } from "@/concord/lib/chat";
import { channelsView, deletedChannels, signingStreams } from "@/concord/lib/community";
import { concordScope, isScopeActivated, markScopeLive, nip29Scope, onActivation } from "@/wire/activation";
import { readControlFold, type FoldedControl } from "@/concord/lib/control";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
import { heldChannelKeys, rehydrateCommunity, type CommunityListEntry } from "@/concord/lib/communityList";
import { controlGroups } from "@/concord/lib/control";
import { guestbookGroups } from "@/concord/lib/guestbook";
import { isTitledPost } from "@/concord/lib/forum";
import { forumAsChatIds, showsAsFeed } from "@/concord/lib/forumPresentation";
import { KIND_MESSAGE } from "@/concord/lib/kinds";
import { warmupCommunities } from "@/concord/lib/loginWarmup";
import { openPlaneWrapsChunked } from "@/concord/lib/planeSync";
import { ackPendingWraps, peekPendingWraps, queryRumorsByChannel, writeOpened, writeRumors } from "@/concord/lib/rumorStore";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import { channelReadKey, concordReadKey, useReadState } from "@/hooks/useReadState";
import { NIP29_ACTIVITY_KINDS } from "@/hooks/useRelayUnread";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useWireGitTicketRoots } from "@/hooks/useWireGitTicketRoots";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { appEventStore } from "@/lib/db/mainEventStore";
import { onFoldedWrite } from "@/lib/foldedCache";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { forgetDm17Arrivals } from "@/lib/nip17/dm17Store";
import { NIP29_PAGE_SIZE } from "@/lib/nip29Sync";
import { hasNativeNotificationService, normalizeRelayUrl } from "@/lib/platform";
import { onRelayReopened } from "@/lib/relayReopen";
import { logSync } from "@/lib/syncLog";
import { perfCount, perfMark } from "@/lib/perf";
import { emitWireScopes, onWireScopes } from "@/wire/bus";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";
import { concordCandidateRings, ingestWireEvents } from "@/wire/ingest";
import { registerCandidateRecheck, registerPushedEventIngest } from "@/wire/notify";
import { verifyEventOnce } from "@/lib/verifyCache";
import { bootLedgers, isLedgerFilter, partitionByLedger, recordLedger, type BootLedger } from "@/wire/bootLedger";
import { filtersWiden, PROBE_FILTER, PROBE_TIMEOUT_MS, roundWatch, settleDue } from "@/wire/roundWatch";
import { buildWireSpec, stampRoundSince, type WireSpec } from "@/wire/spec";
import type { GitRepositoryWireInput } from "@/wire/spec";

import type { GroupKey, StreamKeyView } from "@/concord/lib/derive";
import type { Channel, Community } from "@/concord/lib/types";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** `since` floor with no cursor (fresh device); deeper history comes from hydration pulls. */
const FRESH_LOOKBACK_SECONDS = 5 * 60;
/** Oldest a persisted cursor may reach (a month-off device resumes at a week). */
const MAX_CURSOR_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Overlap subtracted from a resumed cursor (clock skew / borderline events). */
const CURSOR_OVERLAP_SECONDS = 60;
/**
 * Relays whose DM wrap replay already ran this session, so a loop restarted
 * by a spec change doesn't replay the first-round cap again.
 */
const replayedRelays = new Set<string>();
/** How often a round's silence is re-checked against roundWatch's deadlines. */
const WATCHDOG_TICK_MS = 5_000;
/**
 * Max pre-EOSE replay events batched into one ingest call (per-event awaits
 * defeat the store's burst batching). Post-EOSE live events ingest immediately.
 */
const REPLAY_BATCH_MAX = 200;

/**
 * Per-relay resume cursors in KV (one per relay ever contacted, never
 * evicted). Reads before {@link cursors.ready} fall back to the fresh lookback.
 */
const cursors = new KvPrefixCache<number>({ prefix: "wire-cursor:" });

function readCursor(relay: string): number | undefined {
  const n = cursors.get(relay);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function writeCursor(relay: string, createdAt: number): void {
  // Clamp to now: a future-stamped event would push `since > now` and make the
  // relay durably deaf.
  const next = Math.min(createdAt, nowSecs());
  const prev = readCursor(relay) ?? 0;
  if (next > prev) cursors.set(relay, next);
}

/**
 * Newest rumors scanned per channel for the dot. Smaller than the rail's 200,
 * so a miss only keeps a community syncing (the safe direction).
 */
const DOT_SCAN_WINDOW = 50;

/**
 * Deferred scopes (`c2:<idHex>`, `nip29:<relay>`), persisted: the per-relay
 * cursor keeps advancing on other traffic while a scope is excluded, so this
 * is the durable IOU that its catch-up ({@link catchUpCommunity} /
 * {@link catchUpNip29Server}) must run before going live. Legacy entries are
 * bare Concord idHexes, still honored.
 */
const deferredFlags = new KvPrefixCache<number>({ prefix: "wire-deferred:" });

/** Single-flight guard for the per-scope catch-up pull. */
const catchUpsInFlight = new Set<string>();

/** What the dot judgment needs from React context, snapshotted per spec run. */
interface DotContext {
  pubkey: string | undefined;
  readState: Record<string, number>;
  isMuted: (protocol: "c2", communityId: string, channelIdHex: string) => boolean;
  /**
   * Whether a channel's resolved level (`all`/`mentions`) would ever fire. Only
   * communities that notify about NOTHING may be deferred, or notifications are
   * silently dropped.
   */
  notifies: (communityIdHex: string, channelIdHex: string) => boolean;
}

/**
 * Whether the community's rail dot is lit, judged like the rail
 * (useConcordUnread + mute rule; mentions light it regardless of mute).
 */
async function communityDotted(communityIdHex: string, channels: Channel[], ctx: DotContext): Promise<boolean> {
  if (!ctx.pubkey || channels.length === 0) return false;
  const byChannel = await queryRumorsByChannel(
    communityIdHex,
    channels.map((c) => c.idHex),
    { perChannel: DOT_SCAN_WINDOW },
  );
  const asChat = forumAsChatIds();
  const feedOnly = new Set(channels.filter((c) => showsAsFeed(c, asChat)).map((c) => c.idHex));
  for (const [idHex, rumors] of byChannel) {
    const lastRead = ctx.readState[concordReadKey(idHex)] ?? 0;
    const muted = ctx.isMuted("c2", communityIdHex, idHex);
    const titledOnly = feedOnly.has(idHex);
    for (const r of rumors) {
      if (r.kind !== KIND_MESSAGE) continue;
      if (titledOnly && !isTitledPost(r)) continue;
      if (r.author === ctx.pubkey) continue;
      if (r.createdAt <= lastRead) continue;
      if (!muted) return true;
      if (r.tags.some(([name, value]) => name === "p" && value === ctx.pubkey)) return true;
    }
  }
  return false;
}

/**
 * Catch up a previously-deferred community: sweep its planes and pull each
 * channel's newest page, healing what the shared cursor skipped.
 */
function catchUpCommunity(
  nostr: Parameters<typeof warmupCommunities>[0],
  entry: CommunityListEntry,
  idHex: string,
): void {
  if (catchUpsInFlight.has(idHex)) return;
  catchUpsInFlight.add(idHex);
  logSync("wire", `community ${idHex.slice(0, 8)} back on the wire — pulling newest pages`);
  void warmupCommunities(nostr, [entry], { pruneSnapshots: false })
    .catch(() => undefined)
    .finally(() => {
      catchUpsInFlight.delete(idHex);
    });
}

/**
 * Concord channels (with stream keys, from local reads) for every live
 * community, registering keys for NIP-42 stream auth. Mirrors useConcordSubs
 * but keeps the full Channel (the wire decrypts).
 *
 * A SILENCED community (would notify about nothing) whose dot is already lit is
 * DEFERRED until activated — a binary dot can't get more lit, and history is
 * pulled on activation. The silenced qualifier is load-bearing: the wire is the
 * only live-notification path. Control planes are never deferred.
 */
/** Deleted Channels this session already cleared, by account, community and channel id. */
const purgedChannels = new Set<string>();

/** Forget which deleted Channels were cleared, so the next account clears its own. */
export function clearPurgedChannelsMemory(): void {
  purgedChannels.clear();
}

/** Clear what this device holds of each deleted Channel (CORD-03 §2), then delete its own uploads and wraps there. */
export async function purgeDeletedChannels(
  community: Community,
  folded: FoldedControl | undefined,
  ctx: { user: ReturnType<typeof useCurrentUser>["user"]; secret: Uint8Array | undefined; nostr: ReturnType<typeof useNostr>["nostr"] },
): Promise<void> {
  const { user, secret, nostr } = ctx;
  if (!user) return;
  let queued = false;
  for (const channel of deletedChannels(community, folded)) {
    const key = `${user.pubkey}:${community.idHex}:${channel.idHex}`;
    if (purgedChannels.has(key)) continue;
    purgedChannels.add(key);
    try {
      const result = await purgeDeletedChannel(community, channel, user.pubkey, secret);
      if (result.uploads.length > 0) void deleteBlobs(user.signer, result.uploads).catch(() => undefined);
      queued ||= result.queued > 0;
    } catch {
      purgedChannels.delete(key);
    }
  }
  if (queued || queuedWrapScrubs().length > 0) {
    void drainWrapScrubs({
      query: (url, filters, signal) => nostr.relay(url).query(filters, { signal }),
      publish: (url, event, signal) => nostr.relay(url).event(event, { signal }),
    }, secret);
  }
}

type WireConcordChannel = { relays: string[]; channel: Channel; communityIdHex: string; banned: Set<string>; roleMentions?: HeldRoleMention[]; roleMentionAuthors?: Set<string>; sendDenied?: Set<string>; postAuthors?: Set<string>; timeouts?: { pk: string; fromSecs: number; until: number }[]; nicknames?: Record<string, string>; gitAttachments: ReturnType<typeof channelGitRepositoryAttachments> };

function useWireConcordChannels(): WireConcordChannel[] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const secret = useAccountSecret();
  // Read in the query through refs: a deleted Channel is cleared off the fold it reads.
  const purgeRef = useRef({ user, secret, nostr });
  purgeRef.current = { user, secret, nostr };
  const { readState } = useReadState();
  const { isConcordChannelMuted } = useMutes();
  const { concordChannelLevel } = useNotifLevels();
  const entries = useJoinedCommunities();
  // Keep the clock by the relays the account uses (CORD-03 §3), now and again hourly;
  // with none, the device's own clock.
  const { config } = useAppContext();
  const relaySig = accountClockRelays(config.relayMetadata, config.dmRelays, user?.pubkey).join(" ");
  useEffect(() => {
    const sample = () => void syncClock(relaySig ? relaySig.split(" ") : []);
    const first = setTimeout(sample, 5_000);
    const timer = setInterval(sample, CLOCK_RESYNC_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [relaySig]);
  const listSig = useMemo(
    () =>
      entries
        .map((e) => `${e.community_id}:${e.current.root_epoch}:${heldChannelKeys(e.current.channels).length}`)
        .sort()
        .join(","),
    [entries],
  );

  // Via a ref so read-state churn doesn't rebuild the spec; the 2-minute
  // refetch catches dot changes that matter.
  const dotCtxRef = useRef<DotContext>({ pubkey: undefined, readState: {}, isMuted: () => false, notifies: () => true });
  dotCtxRef.current = {
    pubkey: user?.pubkey,
    readState,
    isMuted: isConcordChannelMuted,
    notifies: (communityIdHex, channelIdHex) =>
      concordChannelLevel("c2", communityIdHex, channelIdHex) !== "nothing",
  };

  // Activation must re-run the spec NOW, not on the next poll.
  const [activationEpoch, setActivationEpoch] = useState(0);
  useEffect(() => onActivation(() => setActivationEpoch((n) => n + 1)), []);

  // `listSig` misses control editions that change neither epoch nor channel
  // count (repo attach, rename); re-read when a fold snapshot lands.
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onFoldedWrite((key) => {
        if (!key.startsWith("concord2-fold:")) return;
        void queryClient.invalidateQueries({ queryKey: ["wire", "concord-channels"] });
      }),
    [queryClient],
  );
  // A background pause (CORD-04 §8) persists no fold, so also re-run on
  // `c2ctl:` for communities this wire carries (others would waste the reads).
  const liveIdsRef = useRef<Set<string>>(new Set());
  liveIdsRef.current = useMemo(() => new Set(entries.map((e) => e.community_id.toLowerCase())), [entries]);
  useEffect(
    () =>
      onWireScopes((scopes) => {
        for (const s of scopes) {
          if (s.startsWith("c2ctl:") && liveIdsRef.current.has(s.slice("c2ctl:".length).toLowerCase())) {
            void queryClient.invalidateQueries({ queryKey: ["wire", "concord-channels"] });
            return;
          }
        }
      }),
    [queryClient],
  );

  const query = useQuery<WireConcordChannel[]>({
    queryKey: ["wire", "concord-channels", listSig, activationEpoch],
    enabled: entries.length > 0,
    // While a new key reads, the spec keeps the last one's channels: an empty one
    // would restart every relay's subscription, twice.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    // Picks up out-of-band fold updates (new channels, rotated epochs).
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      // Deferral flags must be loaded, or a reload skips owed catch-ups.
      await deferredFlags.ready();
      const out: WireConcordChannel[] = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community || community.relays.length === 0) continue;
        // Dissolved (CORD-02 §9): no subscriptions; local and sticky.
        if ((await dissolvedAt(community.idHex)) !== undefined) continue;
        const folded = await readControlFold(community.idHex);
        void purgeDeletedChannels(community, folded, purgeRef.current);
        const channels: Channel[] = [];
        for (const channel of channelsView(community, folded)) {
          if (channel.streams.length === 0) continue;
          channels.push(channel);
        }

        // Pause and unread-dot deferral both drop chat filters and owe the same
        // durable catch-up IOU (see `deferredFlags`).
        const scope = concordScope(community.idHex);
        const wasDeferred = (deferredFlags.get(scope) ?? deferredFlags.get(community.idHex) ?? 0) > 0;
        const defer = () => {
          if (!wasDeferred) deferredFlags.set(scope, nowSecs());
        };
        const clearFlag = () => {
          deferredFlags.delete(scope);
          deferredFlags.delete(community.idHex); // pre-scope legacy spelling
        };

        // Paused (CORD-04 §8): chat streams leave the wire for everyone (staff
        // lift the pause first); control stays subscribed so the lift lands.
        // `readLivePause` reads the CURRENT pause, not a possibly stale fold.
        // `defer()` makes the resume a catch-up.
        if (await readLivePause(community, nowSecs())) {
          defer();
          continue;
        }

        // Unread-dot deferral (wire/activation.ts), only for SILENCED
        // communities; `notifies` short-circuits the dot scan.
        const notifies = channels.some((c) =>
          dotCtxRef.current.notifies(community.idHex, c.idHex),
        );
        if (isScopeActivated(scope)) {
          if (wasDeferred) {
            clearFlag();
            catchUpCommunity(nostr, entry, community.idHex);
          }
        } else if (!notifies && await communityDotted(community.idHex, channels, dotCtxRef.current)) {
          defer();
          continue;
        } else if (wasDeferred) {
          // Dot cleared remotely: pin live for the session (re-deferring would oscillate).
          markScopeLive(scope);
          clearFlag();
          catchUpCommunity(nostr, entry, community.idHex);
        }

        const keys: GroupKey[] = [];
        // The Roles this viewer holds, so a Role mention notifies (CORD-04 §8).
        const roleMentions = folded && user ? heldRoleMentions(folded.roster, user.pubkey) : [];
        const roleMentionAuthorSet = folded && roleMentions.length > 0 ? new Set(roleMentionAuthors(folded.roster, folded.ownerHex)) : undefined;
        for (const channel of channels) {
          const denied = sendDeniedIn(folded, channel.idHex);
          const posters = restrictedPostersIn(folded, channel.idHex);
          const writers = restrictedWritersIn(folded, channel.idHex);
          out.push({
            relays: community.relays,
            channel,
            communityIdHex: community.idHex,
            // Banned set (CORD-04) so ingest keeps banned members off the notifier.
            banned: folded?.banned ?? new Set<string>(),
            ...(roleMentionAuthorSet ? { roleMentions, roleMentionAuthors: roleMentionAuthorSet } : {}),
            ...(denied.length > 0 ? { sendDenied: new Set(denied) } : {}),
            ...(posters ? { postAuthors: new Set(posters) } : {}),
            ...(writers ? { writerAuthors: new Set(writers) } : {}),
            gitAttachments: channelGitRepositoryAttachments(folded?.channels.get(channel.idHex)?.metadata ?? { name: channel.name, private: channel.isPrivate }),
          });
          keys.push(...signingStreams(channel));
        }
        // Per community, so a relay's NIP-42 challenge signs only keys it hosts (streamAuth.ts).
        registerStreamKeys(keys, community.relays);
      }
      return out;
    },
  });

  // Timeouts and Nicknames only judge what rings, so they never hold the subscriptions
  // back: read beside them, every community at once, and merged in when they land.
  // Under the same key prefix, so whatever re-reads the channels re-reads these.
  const subscribedIds = useMemo(() => [...new Set((query.data ?? []).map((c) => c.communityIdHex))].sort(), [query.data]);
  const extras = useQuery({
    queryKey: ["wire", "concord-channels", "guestbook", listSig, subscribedIds.join(",")],
    enabled: subscribedIds.length > 0,
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const byId = new Map(entries.map((e) => [e.community_id.toLowerCase(), e]));
      const read = await Promise.all(
        subscribedIds.map(async (idHex) => {
          const entry = byId.get(idHex);
          const community = entry ? rehydrateCommunity(entry) : undefined;
          return [idHex, community ? await storedGuestbookExtras(community, await readControlFold(idHex)) : undefined] as const;
        }),
      );
      return new Map(read.filter((r): r is readonly [string, GuestbookExtras] => r[1] !== undefined));
    },
  });

  return useMemo(() => {
    const channels = query.data ?? [];
    if (!extras.data) return channels;
    return channels.map((c) => {
      const x = extras.data.get(c.communityIdHex);
      if (!x || (x.timeouts.length === 0 && Object.keys(x.nicknames).length === 0)) return c;
      return {
        ...c,
        ...(x.timeouts.length > 0 ? { timeouts: x.timeouts } : {}),
        ...(Object.keys(x.nicknames).length > 0 ? { nicknames: x.nicknames } : {}),
      };
    });
  }, [query.data, extras.data]);
}

/** Newest events scanned per relay for a server's dot (smaller than the rail's 300; misses err safe). */
const NIP29_DOT_SCAN_LIMIT = 100;

/** Group filters per catch-up REQ (relays commonly cap filters-per-REQ ~10-20). */
const NIP29_CATCHUP_FILTERS_PER_REQ = 10;

/** What the NIP-29 dot judgment needs from React context, snapshotted per run. */
interface Nip29DotContext {
  pubkey: string | undefined;
  readState: Record<string, number>;
  isMuted: (relayUrl: string, groupId: string) => boolean;
}

/** Whether a NIP-29 server's rail dot is lit, judged like the rail (useRelayUnread + mute rule). */
async function nip29ServerDotted(
  store: { query(filters: NostrFilter[], opts?: { relay?: string }): Promise<Array<Pick<NostrEvent, "pubkey" | "tags" | "created_at">>> },
  relay: string,
  groupIds: string[],
  ctx: Nip29DotContext,
): Promise<boolean> {
  if (!ctx.pubkey || groupIds.length === 0) return false;
  const activity = await store.query(
    [{ kinds: [...NIP29_ACTIVITY_KINDS], "#h": groupIds, limit: NIP29_DOT_SCAN_LIMIT }],
    { relay },
  );
  const idSet = new Set(groupIds);
  for (const event of activity) {
    if (event.pubkey === ctx.pubkey) continue; // never unread from self
    const h = event.tags.find(([n]) => n === "h")?.[1];
    if (!h || !idSet.has(h)) continue;
    if (event.created_at <= (ctx.readState[channelReadKey(relay, h)] ?? 0)) continue;
    if (!ctx.isMuted(relay, h)) return true;
    if (event.tags.some(([n, v]) => n === "p" && v === ctx.pubkey)) return true;
  }
  return false;
}

/**
 * Catch up a previously-deferred NIP-29 server: the newest page of every
 * group, filed under the relay and announced on the bus.
 */
function catchUpNip29Server(
  nostr: { relay(url: string): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> } },
  relay: string,
  groupIds: string[],
): void {
  const scope = nip29Scope(relay);
  if (catchUpsInFlight.has(scope)) return;
  catchUpsInFlight.add(scope);
  logSync("wire", `nip29 server ${relay} back on the wire — pulling newest pages`);
  void (async () => {
    const filters: NostrFilter[] = groupIds.map((id) => ({
      kinds: [...NIP29_ACTIVITY_KINDS],
      "#h": [id],
      limit: NIP29_PAGE_SIZE,
    }));
    const store = await appEventStore();
    const touched = new Set<string>();
    for (let i = 0; i < filters.length; i += NIP29_CATCHUP_FILTERS_PER_REQ) {
      const chunk = filters.slice(i, i + NIP29_CATCHUP_FILTERS_PER_REQ);
      let events: NostrEvent[] = [];
      try {
        events = await nostr.relay(relay).query(chunk, { signal: AbortSignal.timeout(8000) });
      } catch {
        continue; // best-effort; the group's own round retries on open
      }
      // Per-event catch so one refused row doesn't fail the page.
      await Promise.all(events.map((ev) => store.event(ev, { relay }).catch(() => undefined)));
      for (const ev of events) {
        const h = ev.tags.find(([n]) => n === "h")?.[1];
        if (h) touched.add(`nip29:${h}`);
      }
    }
    if (touched.size > 0) emitWireScopes(touched);
  })()
    .catch(() => undefined)
    .finally(() => {
      catchUpsInFlight.delete(scope);
    });
}

/**
 * Unread-dot deferral for NIP-29 servers — same rule and catch-up IOU as
 * Concord, with the relay as the unit.
 */
function useWireNip29Deferral(
  groups: Array<{ id: string; relay: string; buzz?: boolean }>,
): Array<{ id: string; relay: string; buzz?: boolean }> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { readState } = useReadState();
  const { isChannelMuted } = useMutes();
  const eventStore = useEventStore();

  // Via a ref so read-state churn doesn't rebuild the spec.
  const dotCtxRef = useRef<Nip29DotContext>({ pubkey: undefined, readState: {}, isMuted: () => false });
  dotCtxRef.current = { pubkey: user?.pubkey, readState, isMuted: isChannelMuted };

  // Activation must re-run the spec NOW.
  const [activationEpoch, setActivationEpoch] = useState(0);
  useEffect(() => onActivation(() => setActivationEpoch((n) => n + 1)), []);

  const groupsSig = useMemo(
    () => groups.map((g) => `${g.relay}|${g.id}${g.buzz ? "!" : ""}`).sort().join(","),
    [groups],
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const query = useQuery<Array<{ id: string; relay: string; buzz?: boolean }>>({
    queryKey: ["wire", "nip29-deferral", groupsSig, activationEpoch],
    enabled: groups.length > 0,
    // As the Concord channels: never an empty spec between two keys.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      // Deferral flags must be loaded, or a reload skips owed catch-ups.
      await deferredFlags.ready();
      const all = groupsRef.current;
      // Grouped by NORMALIZED relay (read-state/store spelling); entries keep the original.
      const byRelay = new Map<string, typeof all>();
      for (const g of all) {
        const relay = normalizeRelayUrl(g.relay);
        if (!relay) continue;
        const list = byRelay.get(relay);
        if (list) list.push(g);
        else byRelay.set(relay, [g]);
      }
      const store = await eventStore;
      const out: typeof all = [];
      for (const [relay, relayGroups] of byRelay) {
        const scope = nip29Scope(relay);
        const wasDeferred = (deferredFlags.get(scope) ?? 0) > 0;
        const ids = relayGroups.map((g) => g.id);
        if (isScopeActivated(scope)) {
          if (wasDeferred) {
            deferredFlags.delete(scope);
            catchUpNip29Server(nostr, relay, ids);
          }
        } else if (await nip29ServerDotted(store, relay, ids, dotCtxRef.current)) {
          if (!wasDeferred) deferredFlags.set(scope, nowSecs());
          continue;
        } else if (wasDeferred) {
          // Dot cleared remotely: pin live for the session.
          markScopeLive(scope);
          deferredFlags.delete(scope);
          catchUpNip29Server(nostr, relay, ids);
        }
        out.push(...relayGroups);
      }
      return out;
    },
  });

  return query.data ?? [];
}

/** Folded channel metadata → canonical repository activity targets for the wire. */
function wireGitRepositories(
  channels: Array<{ channel: Channel; communityIdHex: string; gitAttachments: ReturnType<typeof channelGitRepositoryAttachments> }>,
): GitRepositoryWireInput[] {
  const byAddress = new Map<string, GitRepositoryWireInput>();
  for (const { channel, communityIdHex, gitAttachments } of channels) {
    for (const attachment of gitAttachments) {
      let repository = byAddress.get(attachment.address.coordinate);
      if (!repository) {
        repository = { address: attachment.address.coordinate, relays: [], attachments: [] };
        byAddress.set(repository.address, repository);
      }
      repository.relays.push(...attachment.relayHints);
      repository.attachments.push({ channelId: channel.idHex, communityId: communityIdHex, attachment });
    }
  }
  return [...byAddress.values()]
    .map((repository) => ({
      ...repository,
      relays: [...new Set(repository.relays)].sort(),
      attachments: repository.attachments.sort((a, b) => a.channelId.localeCompare(b.channelId) || a.attachment.attachedAt - b.attachment.attachedAt),
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

/**
 * Concord CONTROL-plane targets for every live community (keys derive from the
 * bundle, no fold needed), so new channel editions land live for non-open
 * communities. Keys are registered for NIP-42.
 */
function useWireConcordControl(): Array<{
  relays: string[];
  idHex: string;
  groups: StreamKeyView[];
  refounded: boolean;
}> {
  const entries = useJoinedCommunities();

  return useMemo(() => {
    const out: Array<{
      relays: string[];
      idHex: string;
      groups: StreamKeyView[];
      refounded: boolean;
    }> = [];
    for (const entry of entries) {
      const community = rehydrateCommunity(entry);
      if (!community || community.relays.length === 0) continue;
      const groups = controlGroups(community);
      if (groups.length === 0) continue;
      out.push({
        relays: community.relays,
        idHex: community.idHex,
        groups,
        refounded: community.rootEpoch > 0n,
      });
      // Per community (streamAuth.ts).
      registerStreamKeys(groups, community.relays);
    }
    return out;
  }, [entries]);
}

/**
 * Concord GUESTBOOK-plane targets for every live community (no fold needed),
 * so a KICK — which touches no control plane — lands promptly. Keys are
 * registered for NIP-42.
 */
function useWireConcordGuestbook(): Array<{
  relays: string[];
  idHex: string;
  groups: StreamKeyView[];
}> {
  const entries = useJoinedCommunities();

  return useMemo(() => {
    const out: Array<{ relays: string[]; idHex: string; groups: StreamKeyView[] }> = [];
    for (const entry of entries) {
      const community = rehydrateCommunity(entry);
      if (!community || community.relays.length === 0) continue;
      const groups = guestbookGroups(community);
      if (groups.length === 0) continue;
      out.push({ relays: community.relays, idHex: community.idHex, groups });
      registerStreamKeys(groups, community.relays);
    }
    return out;
  }, [entries]);
}

/**
 * THE funnel for all standing ingestion: builds the wire spec (same info the
 * APK service gets); on web holds ONE resumable subscription per relay via the
 * pool (NIP-42 handled there); on APK bridges the native service's events and
 * drains its parked Concord wraps. Everything lands in the stores and the bus
 * announces changes; hooks hold no sockets.
 */
export function WireSync() {
  // Mount only once the boot gate opens so the replay doesn't compete with
  // first-paint reads; durable cursors make the later start lossless. Those
  // three small prefix reads start now, so the first round isn't held on them.
  useEffect(() => {
    void cursors.ready();
    void bootLedgers.ready();
    void deferredFlags.ready();
  }, []);
  const bootGateOpen = useBootGateOpen();
  return bootGateOpen ? <WireSyncInner /> : null;
}

function WireSyncInner() {
  useEffect(() => perfMark("wire.mount"), []);
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const { data: groupList } = useUserGroupList();
  const { knownPeers: dmKnownPeers } = useKnownDmPeers();
  const { relays: publishedDmRelays } = useDmRelayList();
  const concord = useWireConcordChannels();
  const concordControl = useWireConcordControl();
  const concordGuestbook = useWireConcordGuestbook();
  const nip29Groups = useWireNip29Groups();
  const gitRepositories = useMemo(() => wireGitRepositories(concord), [concord]);
  const gitTicketRoots = useWireGitTicketRoots(gitRepositories);

  // Directory-discovered groups UNION the 10009 `groups` list (which also
  // carries private channels the directory hides).
  const allNip29Groups = useMemo(() => {
    const byKey = new Map<string, { id: string; relay: string; buzz?: boolean }>();
    for (const g of nip29Groups) {
      if (g.id && g.relay) byKey.set(`${g.relay}\u0000${g.id}`, g);
    }
    for (const g of groupList?.groups ?? []) {
      // Never overwrite a directory entry (it carries the Buzz flag).
      const key = `${g.relay}\u0000${g.id}`;
      if (g.id && g.relay && !byKey.has(key)) byKey.set(key, { id: g.id, relay: g.relay });
    }
    return [...byKey.values()];
  }, [nip29Groups, groupList?.groups]);
  // …minus the servers deferred under the unread-dot rule.
  const groups = useWireNip29Deferral(allNip29Groups);

  // Live gift-wrap relays: MUST match useDm17's inbox scan — effective DM
  // relays UNION the published kind 10050 (where senders deliver); otherwise
  // DMs arrive only via the 60s poll. `dmsDisabled` empties it, dropping every
  // DM filter.
  const dmRelays = useMemo(
    () =>
      config.dmsDisabled
        ? []
        : [...new Set([...effectiveDmRelays(config), ...publishedDmRelays])],
    [config, publishedDmRelays],
  );

  const spec: WireSpec = useMemo(
    () =>
      buildWireSpec({
        pubkey: user?.pubkey,
        groups,
        dmRelays,
        // Historical name kept for native/config compat: all established legacy-DM authors.
        dmFollows: dmKnownPeers,
        concord,
        concordControl,
        concordGuestbook,
        gitRepositories,
        gitTicketRoots,
      }),
    [user?.pubkey, groups, dmRelays, dmKnownPeers, concord, concordControl, concordGuestbook, gitRepositories, gitTicketRoots],
  );

  // Read lazily so long-lived subs decrypt/scope with the latest keys.
  const specRef = useRef(spec);
  specRef.current = spec;
  const sinksRef = useRef({
    eventStore,
    getSpec: () => specRef.current,
    getSelfPubkey: () => user?.pubkey,
  });
  useEffect(() => registerCandidateRecheck((cand) => concordCandidateRings(specRef.current, cand)), []);
  sinksRef.current = {
    eventStore,
    getSpec: () => specRef.current,
    getSelfPubkey: () => user?.pubkey,
  };

  // Web sockets: one REQ per relay from the persisted cursor. Diffed PER RELAY:
  // the spec settles several times at startup, and restarting every relay
  // aborted replays and re-authed identical subscriptions.
  const quiet = useSyncExternalStore(onBackgroundQuiet, isBackgroundQuiet, () => false);
  // Relays that never connect are left alone until their cooldown ends (relayHealth.ts).
  const healthVersion = useSyncExternalStore(onRelayHealthChange, relayHealthVersion, () => 0);
  const loopsRef = useRef(new Map<string, { sig: string; filters: NostrFilter[]; stop: () => void; bump: () => void }>());
  const loopsOwnerRef = useRef<{ nostr: unknown; pubkey?: string } | null>(null);
  // The filters each relay should carry now, for a loop that starts after a wait.
  const desiredRef = useRef(new Map<string, NostrFilter[]>());
  // Explicit-`since` filters (git child / CI bootstraps) whose replay reached
  // EOSE this session; later rounds resume from the cursor.
  const bootstrappedRef = useRef(new Set<string>());
  // This session's bootLedger marks, ahead of the throttled KV copy.
  const sessionLedgersRef = useRef(new Map<string, BootLedger>());
  // A running loop's filters change several times while the spec settles at
  // startup, and a restart re-sends every filter (Git ones are tens of KB), so
  // changes wait for the spec to go quiet; see SPEC_SETTLE_MS.
  const [settleTick, setSettleTick] = useState(0);
  const settleRef = useRef<{ firstAt?: number; dueAt?: number; timer?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => () => clearTimeout(settleRef.current.timer), []);

  useEffect(() => {
    const loops = loopsRef.current;

    const startRelayLoop = (relay: string, initial: NostrFilter[]) => {
      const controller = new AbortController();
      let filters = initial;
      const record = {
        sig: JSON.stringify(initial),
        filters: initial,
        stop: () => controller.abort(),
        bump: () => bumpRound(),
      };
      // Aborts the current round and skips backoff sleep (reopen/visibility).
      let bumpRound = () => {};
      void (async () => {
        // Resubscribe with backoff: a relay CLOSED (e.g. before AUTH lands)
        // ends the generator and nothing else revives it — on desktop there's
        // no native funnel. Each fresh REQ gets a fresh auth retry.
        let backoff = 1_000;
        // Wakes early on teardown or socket reopen.
        let wakeSleep: (() => void) | undefined;
        const sleep = (ms: number) =>
          new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(t);
              controller.signal.removeEventListener("abort", finish);
              wakeSleep = undefined;
              resolve();
            };
            const t = setTimeout(finish, ms);
            wakeSleep = finish;
            controller.signal.addEventListener("abort", finish);
          });
        // Wait for KV cursors, or every launch re-ingests the backlog.
        await Promise.all([cursors.ready(), bootLedgers.ready()]);
        // Nothing sent yet: take the spec as it stands now, rather than restart for it later.
        const latest = desiredRef.current.get(relay);
        if (latest && JSON.stringify(latest) !== record.sig) {
          filters = latest;
          record.filters = latest;
          record.sig = JSON.stringify(latest);
        }
        // Only the first round and anomalies are logged.
        let firstRound = true;
        // Once a round reached EOSE, the DM wrap and Git child filters shrink
        // their replay `limit` (repeats were pure duplicates; see stampRoundSince).
        // A relay read in an earlier session starts there too: the DM inbox scan,
        // whose watermarks persist, is what catches backdated wraps.
        let replayDone = replayedRelays.has(relay) || readCursor(relay) !== undefined;
        while (!controller.signal.aborted) {
          const started = Date.now();
          const now = nowSecs();
          const cursor = readCursor(relay);
          const floor = now - MAX_CURSOR_AGE_SECONDS;
          const since = Math.max(
            cursor !== undefined ? cursor - CURSOR_OVERLAP_SECONDS : now - FRESH_LOOKBACK_SECONDS,
            cursor !== undefined ? floor : 0,
          );
          // Liveness watchdog: silent past SILENT_REQ_TIMEOUT_MS → re-REQ;
          // established but quiet past QUIET_ROTATE_MS → rotate (lossless); a
          // socket reopen bumps immediately (relayReopen).
          const round = new AbortController();
          const roundSignal = AbortSignal.any([controller.signal, round.signal]);
          bumpRound = () => {
            logSync("wire", `${relay}: socket reopened — restarting round`);
            round.abort();
            wakeSleep?.();
          };
          let sawAnything = false;
          // After EOSE events are LIVE; keeps replayed DM wraps from re-notifying.
          let eosed = false;
          let lastMsgAt = started;
          let ingested = 0;
          let rotated = false;
          let probing = false;
          const watchdog = setInterval(() => {
            const action = roundWatch(Date.now(), started, lastMsgAt, sawAnything, probing);
            if (action === "reissue") {
              logSync("wire", `${relay}: round yielded nothing in ${Math.round((Date.now() - lastMsgAt) / 1000)}s — presumed swallowed, re-REQ`);
              round.abort();
            } else if (action === "rotate") {
              rotated = true;
              round.abort();
            } else if (action === "probe") {
              probing = true;
              const probeSignal = AbortSignal.any([roundSignal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
              nostr.relay(relay).query([PROBE_FILTER], { signal: probeSignal })
                .catch(() => {})
                .finally(() => {
                  probing = false;
                  // Any answer (EOSE, even CLOSED) proves the socket; the standing sub rides it.
                  if (!probeSignal.aborted) lastMsgAt = Date.now();
                  else if (!roundSignal.aborted) {
                    logSync("wire", `${relay}: liveness probe unanswered — re-REQ`);
                    rotated = true;
                    round.abort();
                  }
                });
            }
          }, WATCHDOG_TICK_MS);
          if (firstRound) {
            perfMark("wire.round open", `${relay} ${filters.length} filter(s)`);
            logSync("wire", `${relay}: round open (since=${since}, ${filters.length} filter(s))`);
            firstRound = false;
          }
          // Explicit-`since` filters awaiting bootstrap keep their deep timestamp this round;
          // git/CI ones resume per unit from the persisted ledger instead.
          const bootKey = (f: NostrFilter) => `${relay}\u0000${JSON.stringify(f)}`;
          const ledgered = filters.filter(isLedgerFilter);
          const ledgerNow = () => sessionLedgersRef.current.get(relay) ?? bootLedgers.get(relay);
          const pending = [
            ...partitionByLedger(ledgered, ledgerNow(), CURSOR_OVERLAP_SECONDS),
            ...filters.filter((f) => f.since !== undefined && !isLedgerFilter(f) && !bootstrappedRef.current.has(bootKey(f))),
          ];
          const settled = filters.filter((f) => !ledgered.includes(f) && !pending.includes(f));
          // Pre-EOSE replay is batched (REPLAY_BATCH_MAX); live events ingest one by one.
          let replay: NostrEvent[] = [];
          const flushReplay = async () => {
            if (replay.length === 0) return;
            const batch = replay;
            replay = [];
            await ingestWireEvents(sinksRef.current, batch, { live: false, relay });
            ingested += batch.length;
            writeCursor(relay, Math.max(...batch.map((e) => e.created_at)));
          };
          try {
            try {
              for await (const msg of nostr.relay(relay).req(
                [...stampRoundSince(settled, since, now, false, replayDone), ...stampRoundSince(pending, since, now, true, replayDone)],
                { signal: roundSignal },
              )) {
                sawAnything = true;
                lastMsgAt = Date.now();
                if (msg[0] === "EOSE") {
                  await flushReplay();
                  eosed = true;
                  replayDone = true;
                  replayedRelays.add(relay);
                  // Marked only at EOSE, so a torn-down replay retries.
                  for (const f of pending) bootstrappedRef.current.add(bootKey(f));
                  // Every EOSE advances this session's marks; KV only on a real step.
                  const at = nowSecs();
                  const session = recordLedger(ledgerNow(), ledgered, now, at, 0);
                  if (session) sessionLedgersRef.current.set(relay, session);
                  const durable = recordLedger(bootLedgers.get(relay), ledgered, now, at);
                  if (durable) bootLedgers.set(relay, durable);
                }
                if (msg[0] === "EVENT") {
                  backoff = 1_000;
                  const event = msg[2] as NostrEvent;
                  if (eosed) {
                    await ingestWireEvents(sinksRef.current, [event], { live: true, relay });
                    ingested += 1;
                    writeCursor(relay, event.created_at);
                  } else {
                    replay.push(event);
                    if (replay.length >= REPLAY_BATCH_MAX) await flushReplay();
                  }
                }
              }
            } finally {
              // A torn-down round still ingests what it received.
              await flushReplay();
            }
          } catch {
            // aborted or transport error; the loop condition handles it
          } finally {
            clearInterval(watchdog);
            // Release roundSignal's hold on the effect controller.
            round.abort();
          }
          if (controller.signal.aborted) break;
          if (!rotated) {
            logSync(
              "wire",
              `${relay}: round ended after ${Math.round((Date.now() - started) / 1000)}s (${ingested} event(s) ingested)`,
            );
          }
          // Long-lived sessions reset backoff; immediate CLOSEDs back off up to 60s.
          if (Date.now() - started > 60_000) backoff = 1_000;
          await sleep(backoff + Math.floor(Math.random() * 250));
          backoff = Math.min(backoff * 2, 60_000);
        }
      })();
      return record;
    };

    if (loopsOwnerRef.current?.nostr !== nostr || loopsOwnerRef.current?.pubkey !== user?.pubkey) {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
      sessionLedgersRef.current.clear();
      replayedRelays.clear();
      loopsOwnerRef.current = { nostr, pubkey: user?.pubkey };
    }
    // Android background with the native service watching: no loops; resume
    // restarts from cursors losslessly (backgroundQuiet.ts).
    const desired = new Map<string, NostrFilter[]>(
      user && !quiet
        ? spec.subs.filter(({ relay }) => !isRelayUnreachable(relay)).map(({ relay, filters }) => [relay, filters])
        : [],
    );
    desiredRef.current = desired;
    const now = Date.now();
    const settle = settleRef.current;
    const changed: string[] = [];
    let widening = true;
    for (const [relay, loop] of loops) {
      const filters = desired.get(relay);
      if (!filters) {
        loop.stop();
        loops.delete(relay);
      } else if (JSON.stringify(filters) !== loop.sig) {
        changed.push(relay);
        widening &&= filtersWiden(filters, loop.filters);
      }
    }
    if (changed.length === 0) {
      settle.firstAt = undefined;
      settle.dueAt = undefined;
    } else {
      settle.firstAt ??= now;
      const due = settleDue(settle.firstAt, settle.dueAt, now, widening);
      if (due === true) {
        for (const relay of changed) {
          loops.get(relay)?.stop();
          loops.delete(relay);
        }
        settle.firstAt = undefined;
        settle.dueAt = undefined;
      } else {
        settle.dueAt = due;
        clearTimeout(settle.timer);
        settle.timer = setTimeout(() => setSettleTick((t) => t + 1), due - now);
      }
    }
    for (const [relay, filters] of desired) {
      if (!loops.has(relay)) loops.set(relay, startRelayLoop(relay, filters));
    }
    // Loops outlive this effect (the teardown effect owns them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, spec.sig, quiet, healthVersion, settleTick]);

  // Throttled background tabs stretch the watchdog to minutes: kick every
  // relay's round when the tab becomes visible (socket reopens do the same per
  // relay — relayReopen.ts).
  useEffect(() => {
    const offReopen = onRelayReopened((url) => loopsRef.current.get(url)?.bump());
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const loop of loopsRef.current.values()) loop.bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      offReopen();
      for (const loop of loopsRef.current.values()) loop.stop();
      loopsRef.current.clear();
    };
  }, []);

  // Gift wraps a push worker without the signer hands over. Only wraps: they
  // name no relay tenant, and anything else the worker opens itself.
  useEffect(() => registerPushedEventIngest(async (event) => {
    if (event.kind !== 1059 || !verifyEventOnce(event)) return;
    await ingestWireEvents(sinksRef.current, [event], { live: true });
  }), []);

  useEffect(() => {
    if (!hasNativeNotificationService()) return;
    let cancelled = false;

    // One relay per call: NIP-29 data is filed under its serving relay.
    const ingest = (raw: string[], live: boolean, relay: string | undefined): Promise<void> => {
      const events: NostrEvent[] = [];
      for (const json of raw) {
        try {
          events.push(JSON.parse(json) as NostrEvent);
        } catch {
          // malformed line — skip
        }
      }
      if (events.length > 0 && !cancelled) {
        return ingestWireEvents(sinksRef.current, events, { live, relay });
      }
      return Promise.resolve();
    };

    // Drain what the service received while the WebView was down: already in
    // the shared native DB, but it needs an ingest pass (parked wraps, scopes).
    // Acked only after ingest; NOT live (the service already notified).
    let draining = false;
    const drain = async () => {
      if (draining) return; // resume + mount can overlap; pages are sequential
      draining = true;
      try {
        // The service recorded DM arrivals while this page slept.
        forgetDm17Arrivals();
        while (!cancelled) {
          const { events, ids, relay } = await ArmadaNotification.drainEvents();
          if (events.length === 0) break;
          await ingest(events, false, relay);
          if (cancelled) break;
          await ArmadaNotification.ackDrain({ ids, relay });
        }
      } catch {
        // unacked page replays
      } finally {
        draining = false;
      }
    };
    void drain();

    let resumeHandle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void drain();
    })
      .then((h) => {
        if (cancelled) h.remove();
        else resumeHandle = h;
      })
      .catch(() => undefined);

    let liveHandle: { remove: () => void } | undefined;
    ArmadaNotification.addListener("relayEvent", ({ event, relay }) => {
      // Quiet: the service stored/notified it; the resume drain routes it.
      if (isBackgroundQuiet()) return;
      void ingest([event], true, relay);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else liveHandle = h;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      liveHandle?.remove();
      resumeHandle?.remove();
    };
  }, []);

  // Parked-wrap drain (chat → `c2:`, control → `c2ctl:`, guestbook → `c2gb:`):
  // the native service parks wraps it can't open; drain whenever the held key
  // set (spec) changes. The single drain for all three planes.
  useEffect(() => {
    if (spec.concordByPk.size === 0 && spec.concordCtlByPk.size === 0 && spec.concordGbByPk.size === 0) return;
    let cancelled = false;
    // Debounced: spec.sig fires several times at startup.
    const timer = setTimeout(() => {
      void (async () => {
        const drainStart = performance.now();
        try {
          const parked = await peekPendingWraps([
            ...spec.concordByPk.keys(),
            ...spec.concordCtlByPk.keys(),
            ...spec.concordGbByPk.keys(),
          ]);
          if (parked.length === 0 || cancelled) return;
          // Wall clock vs openChatBatch's CPU total shows slicing overhead
          // (setTimeout(0) clamps to ~4ms).
          perfMark("wire.parked drain start", `${parked.length} wrap(s)`);
          const scopes = new Set<string>();
          const acked: string[] = [];

          const byChannel = new Map<Channel, NostrRumor[]>();
          const ctlByCommunity = new Map<
            string,
            { groups: StreamKeyView[]; refounded: boolean; wraps: NostrRumor[] }
          >();
          const gbByCommunity = new Map<string, { groups: StreamKeyView[]; wraps: NostrRumor[] }>();
          for (const wrap of parked) {
            const channel = spec.concordByPk.get(wrap.pubkey);
            if (channel) {
              const list = byChannel.get(channel);
              if (list) list.push(wrap);
              else byChannel.set(channel, [wrap]);
              continue;
            }
            const ctl = spec.concordCtlByPk.get(wrap.pubkey);
            if (ctl) {
              const bucket = ctlByCommunity.get(ctl.idHex);
              if (bucket) bucket.wraps.push(wrap);
              else {
                ctlByCommunity.set(ctl.idHex, {
                  groups: ctl.groups,
                  refounded: ctl.refounded,
                  wraps: [wrap],
                });
              }
              continue;
            }
            const gb = spec.concordGbByPk.get(wrap.pubkey);
            if (gb) {
              const bucket = gbByCommunity.get(gb.idHex);
              if (bucket) bucket.wraps.push(wrap);
              else gbByCommunity.set(gb.idHex, { groups: gb.groups, wraps: [wrap] });
            }
          }

          for (const [channel, wraps] of byChannel) {
            // No community → no tenant: leave parked (never store nor ACK).
            const communityIdHex = spec.concordCommunityByChannel.get(channel.idHex);
            if (!communityIdHex) continue;
            const opened = await openChatBatch(wraps, channel);
            if (opened.length === 0) continue;
            // ACK only what landed: a notified message must never be locally destructible.
            if (!(await writeRumors(communityIdHex, opened))) continue;
            scopes.add(`c2:${channel.idHex}`);
            const openedWrapIds = new Set(opened.map((o) => o.wrapId));
            acked.push(...wraps.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
          }

          for (const [idHex, { groups, refounded, wraps }] of ctlByCommunity) {
            const opened = await openPlaneWrapsChunked(wraps, groups);
            if (opened.length === 0) continue;
            if (!(await writeOpened(idHex, opened, "control", { refounded }))) continue;
            scopes.add(`c2ctl:${idHex}`);
            const openedWrapIds = new Set(opened.map((o) => o.wrapId));
            acked.push(...wraps.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
          }

          for (const [idHex, { groups, wraps }] of gbByCommunity) {
            const opened = await openPlaneWrapsChunked(wraps, groups);
            if (opened.length === 0) continue;
            if (!(await writeOpened(idHex, opened, "guestbook"))) continue;
            scopes.add(`c2gb:${idHex}`);
            const openedWrapIds = new Set(opened.map((o) => o.wrapId));
            acked.push(...wraps.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
          }

          ackPendingWraps(acked);
          if (scopes.size > 0) emitWireScopes(scopes);
        } catch {
          // best-effort; wraps stay parked
        } finally {
          perfCount("wire.parked drain (wall)", performance.now() - drainStart);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.sig]);

  return null;
}
