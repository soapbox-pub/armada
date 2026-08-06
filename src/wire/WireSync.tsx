import { App as CapacitorApp } from "@capacitor/app";
import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useBootGateOpen } from "@/lib/bootGate";

import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { buildConcordSubs, buildConcordControlSubs } from "@/concord-v1/lib/concordNotifications";
import { useCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { dissolvedAt } from "@/concord-v2/hooks/useControlPlane2";
import { openChatBatch } from "@/concord-v2/lib/chat";
import { channelsView } from "@/concord-v2/lib/community";
import { concord2Scope, isScopeActivated, markScopeLive, nip29Scope, onActivation } from "@/wire/activation";
import { readControlFold } from "@/concord-v2/lib/control";
import { channelGitRepositoryAttachments } from "@/concord-v2/lib/types";
import { heldChannelKeys, liveEntries, rehydrateCommunity, type CommunityListEntry } from "@/concord-v2/lib/communityList";
import { controlGroups } from "@/concord-v2/lib/control";
import { KIND_MESSAGE } from "@/concord-v2/lib/kinds";
import { warmupCommunities2 } from "@/concord-v2/lib/loginWarmup";
import { openPlaneWrapsChunked } from "@/concord-v2/lib/planeSync";
import { ackPendingWraps, peekPendingWraps, queryRumorsByChannel, writeOpened, writeRumors } from "@/concord-v2/lib/rumorStore";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import { channelReadKey, concord2ReadKey, useReadState } from "@/hooks/useReadState";
import { NIP29_ACTIVITY_KINDS } from "@/hooks/useRelayUnread";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { useWireGitTicketRoots } from "@/hooks/useWireGitTicketRoots";
import { hasNativeNotificationService } from "@/hooks/useNativeNotifications";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { appEventStore } from "@/lib/db/mainEventStore";
import { onFoldedWrite } from "@/lib/foldedCache";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { NIP29_PAGE_SIZE } from "@/lib/nip29Sync";
import { normalizeRelayUrl } from "@/lib/platform";
import { onRelayReopened } from "@/lib/relayReopen";
import { logSync } from "@/lib/syncLog";
import { perfCount, perfMark } from "@/lib/perf";
import { emitWireScopes } from "@/wire/bus";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";
import { ingestWireEvents } from "@/wire/ingest";
import { buildWireSpec, stampRoundSince, type WireSpec } from "@/wire/spec";
import type { GitRepositoryWireInput } from "@/wire/spec";

import type { GroupKey, StreamKeyView } from "@/concord-v2/lib/derive";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Floor for a relay's `since` when we have no cursor yet (fresh device): a
 * short overlap window; deeper history arrives via hydration pulls.
 */
const FRESH_LOOKBACK_SECONDS = 5 * 60;
/**
 * Ceiling for how far back a persisted cursor may reach: a device off for a
 * month resumes at a week, not the epoch. Older history backfills on demand.
 */
const MAX_CURSOR_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Overlap subtracted from a resumed cursor (clock skew / borderline events). */
const CURSOR_OVERLAP_SECONDS = 60;
/**
 * Watchdog on a fresh REQ round: a healthy relay answers with SOMETHING
 * almost immediately (events, or at least EOSE — even an auth-gated relay
 * settles its NIP-42 handshake well inside this). A round that has yielded
 * NOTHING by the deadline is presumed swallowed (a REQ held behind a wedged
 * AUTH exchange, a half-open socket) and is aborted so the loop re-issues it
 * — without this, the `for await` blocks forever and the wire silently dies
 * until an app relaunch (the "I log in and nothing is here" wedge).
 */
const SILENT_REQ_TIMEOUT_MS = 30_000;
/**
 * Rotation ceiling on a QUIET established round: once a round has yielded
 * something, a long silence is usually just a quiet channel — but it is
 * indistinguishable from a subscription that silently died (a relay that
 * dropped its sub state without CLOSED, a re-issued REQ swallowed by the
 * NIP-42 race on a reconnected socket — see relayReopen.ts for the eager
 * path). So a round silent this long is torn down and re-REQ'd from the
 * cursor. Rotation is lossless (the cursor + overlap replays the boundary)
 * and cheap (one REQ frame; an empty replay on a truly quiet relay), and it
 * bounds "live went deaf" to this window instead of "until app relaunch".
 */
const QUIET_ROTATE_MS = 90_000;
/** How often a round's silence is re-checked against the deadlines above. */
const WATCHDOG_TICK_MS = 5_000;
/**
 * Max events buffered from a round's stored replay (pre-EOSE) before they're
 * flushed through ingest as ONE batch. Awaiting `ingestWireEvents` per event
 * defeats the store's burst batching (see the ingest.ts write-path comment):
 * an N-event catch-up replay becomes N idle-scheduled single-event
 * transactions plus N bus emissions — the post-resume main-thread chug.
 * Batching restores the single-transaction burst write and one bus ring per
 * batch; the cap bounds memory and keeps the cursor advancing. Post-EOSE
 * (live) events still ingest immediately for notification latency.
 */
const REPLAY_BATCH_MAX = 200;

/**
 * Per-relay resume cursors, in ArmadaDB's KV behind a synchronous cache.
 *
 * One entry per relay ever contacted, never evicted, which is what made this
 * worth moving off localStorage. A read before {@link cursors.ready} resolves
 * just resumes from the fresh lookback, so the relay loop awaits it once
 * before its first round rather than re-reading the whole backlog.
 */
const cursors = new KvPrefixCache<number>({ prefix: "wire-cursor:" });

function readCursor(relay: string): number | undefined {
  const n = cursors.get(relay);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function writeCursor(relay: string, createdAt: number): void {
  // Clamp against the local clock: an event stamped in the future (a
  // member's skewed clock, a hostile timestamp) must not drag the cursor
  // past `now` — every later REQ would open with `since > now` and the wire
  // would go deaf on this relay (persistently — the cursor is durable)
  // while everyone else's correctly-stamped messages stop matching.
  const next = Math.min(createdAt, Math.floor(Date.now() / 1000));
  const prev = readCursor(relay) ?? 0;
  if (next > prev) cursors.set(relay, next);
}

/**
 * Newest-rumor window scanned per channel when judging a community's unread
 * dot. Smaller than the rail's own 200-rumor scan, deliberately: a kind-9
 * found unread inside this window is unread inside the rail's larger window
 * too, so the wire never defers a community whose rail button isn't visibly
 * dotted — a miss merely keeps the community syncing (the safe direction).
 */
const DOT_SCAN_WINDOW = 50;

/**
 * Communities the wire is deferring under the unread-dot rule, persisted so
 * the fact survives a reload: the per-relay wire cursor keeps advancing on
 * other traffic while a community's filters are excluded, so a deferred
 * community's missed region can never be recovered from cursor replay alone.
 * The flag is the durable IOU — whichever path brings the community back
 * live (navigation, a remote read clearing the dot, this session or a later
 * one) must run its catch-up ({@link catchUpCommunity} /
 * {@link catchUpNip29Server}) before the standing subscription can be
 * trusted again.
 *
 * Keyed by activation scope (`c2:<idHex>`, `nip29:<relay>` — see
 * wire/activation.ts). Entries written before the scoped spelling were bare
 * Concord idHexes; the Concord read still honors those so a community
 * deferred under the old key isn't silently treated as live without its
 * catch-up.
 */
const deferredFlags = new KvPrefixCache<number>({ prefix: "wire-deferred:" });

/** Single-flight guard for the per-scope catch-up pull. */
const catchUpsInFlight = new Set<string>();

/** What the dot judgment needs from React context, snapshotted per spec run. */
interface DotContext {
  pubkey: string | undefined;
  readState: Record<string, number>;
  isMuted: (protocol: "c1" | "c2", communityId: string, channelIdHex: string) => boolean;
}

/**
 * Whether the community's rail button currently shows an unread indicator,
 * judged from the local rumor store the way the rail judges it
 * (useConcord2Unread + the rail's mute rule): a non-self kind-9 newer than
 * its channel's read stamp lights the dot unless the channel is muted, and a
 * p-tag mention lights the badge regardless of mute.
 */
async function communityDotted(communityIdHex: string, channels: ChannelV2[], ctx: DotContext): Promise<boolean> {
  if (!ctx.pubkey || channels.length === 0) return false;
  const byChannel = await queryRumorsByChannel(
    communityIdHex,
    channels.map((c) => c.idHex),
    { perChannel: DOT_SCAN_WINDOW },
  );
  for (const [idHex, rumors] of byChannel) {
    const lastRead = ctx.readState[concord2ReadKey(idHex)] ?? 0;
    const muted = ctx.isMuted("c2", communityIdHex, idHex);
    for (const r of rumors) {
      if (r.kind !== KIND_MESSAGE) continue;
      if (r.author === ctx.pubkey) continue;
      if (r.createdAt <= lastRead) continue;
      if (!muted) return true;
      if (r.tags.some(([name, value]) => name === "p" && value === ctx.pubkey)) return true;
    }
  }
  return false;
}

/**
 * Bring a previously-deferred community's stores current: sweep its planes
 * and pull the newest page of every channel (the login warm-up, scoped to
 * one community). Heals the region the shared per-relay cursor skipped past
 * while the community was deferred; anything deeper than a newest page is
 * bridged by the channel's own `c2:` round when it is viewed.
 */
function catchUpCommunity(
  nostr: Parameters<typeof warmupCommunities2>[0],
  entry: CommunityListEntry,
  idHex: string,
): void {
  if (catchUpsInFlight.has(idHex)) return;
  catchUpsInFlight.add(idHex);
  logSync("wire", `community ${idHex.slice(0, 8)} back on the wire — pulling newest pages`);
  void warmupCommunities2(nostr, [entry], { pruneSnapshots: false })
    .catch(() => undefined)
    .finally(() => {
      catchUpsInFlight.delete(idHex);
    });
}

/**
 * Concord V2 channels for every live community in the membership list, with
 * their stream GroupKeys (rehydrated bundle + persisted control-fold snapshot,
 * local reads only). Registers every stream key for NIP-42 stream auth so the
 * wire's kind-1059 REQs pass auth-gating relays. Mirrors useConcord2Subs, but
 * keeps the full ChannelV2 (the wire decrypts; the native service can't).
 *
 * NOT every community, though: one whose rail button already shows the unread
 * dot is DEFERRED — its channel filters leave the wire until the user
 * navigates in (or the dot clears via a read synced from another device),
 * because a binary dot can't get more lit and its history is pulled on
 * activation anyway ({@link catchUpCommunity}). This is the bandwidth rule
 * that keeps a pageload from replaying every busy-but-ignored community's
 * traffic. Control planes are deliberately NOT deferred (cheap, and they keep
 * the fold current for the moment the community comes back).
 */
function useWireConcord2Channels(): Array<{ relays: string[]; channel: ChannelV2; communityIdHex: string; gitAttachments: ReturnType<typeof channelGitRepositoryAttachments> }> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { readState } = useReadState();
  const { isConcordChannelMuted } = useMutes();
  const { data } = useCommunityList2();
  const entries = useMemo(() => (data ? liveEntries(data.list) : []), [data]);
  const listSig = useMemo(
    () =>
      entries
        .map((e) => `${e.community_id}:${e.current.root_epoch}:${heldChannelKeys(e.current.channels).length}`)
        .sort()
        .join(","),
    [entries],
  );

  // Deferral inputs, read through a ref so read-state churn (every markRead
  // in the open channel) doesn't rebuild the spec. Changes that matter to the
  // dot verdict are picked up by the 2-minute refetch below — for the one
  // case that needs it (a remote read clearing a deferred community's dot),
  // minutes of extra deferral cost nothing but a slightly later catch-up.
  const dotCtxRef = useRef<DotContext>({ pubkey: undefined, readState: {}, isMuted: () => false });
  dotCtxRef.current = { pubkey: user?.pubkey, readState, isMuted: isConcordChannelMuted };

  // Navigating into a community must re-run the spec NOW (its filters rejoin
  // the wire and its catch-up starts), not on the next poll.
  const [activationEpoch, setActivationEpoch] = useState(0);
  useEffect(() => onActivation(() => setActivationEpoch((n) => n + 1)), []);

  // `listSig` only moves on a new community, a rotated epoch, or a channel
  // count change — a control edition that alters neither (attaching a
  // repository, renaming a channel) leaves the key identical, so the spec would
  // keep its stale view until the poll below. The fold snapshot IS this query's
  // input, so re-read the moment one lands.
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onFoldedWrite((key) => {
        if (!key.startsWith("concord2-fold:")) return;
        void queryClient.invalidateQueries({ queryKey: ["wire", "concord2-channels"] });
      }),
    [queryClient],
  );

  const query = useQuery<Array<{ relays: string[]; channel: ChannelV2; communityIdHex: string; gitAttachments: ReturnType<typeof channelGitRepositoryAttachments> }>>({
    queryKey: ["wire", "concord2-channels", listSig, activationEpoch],
    enabled: entries.length > 0,
    staleTime: 30_000,
    // Fold snapshots update out-of-band (community open / control sync) —
    // re-read periodically to pick up new channels and rotated epochs. This is
    // a local (IndexedDB) read, but there's no reason to run it while hidden.
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      // The first run must see the persisted deferral flags, or a reload
      // would treat every deferred community as live and skip the catch-up
      // its cursor gap requires.
      await deferredFlags.ready();
      const out: Array<{ relays: string[]; channel: ChannelV2; communityIdHex: string; gitAttachments: ReturnType<typeof channelGitRepositoryAttachments> }> = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community || community.relays.length === 0) continue;
        // A dissolved community is a grave: no subscriptions, so nothing new is
        // received, processed or ingested for it (CORD-02 §9). Local + sticky,
        // so a relay outage can't quietly resurrect the feed.
        if ((await dissolvedAt(community.idHex)) !== undefined) continue;
        const folded = await readControlFold(community.idHex);
        const channels: ChannelV2[] = [];
        for (const channel of channelsView(community, folded)) {
          if (channel.streams.length === 0) continue;
          channels.push(channel);
        }

        // The unread-dot deferral (see wire/activation.ts). Every path back
        // to live runs the catch-up, because the shared per-relay cursor
        // advanced past this community's traffic while it was excluded.
        const scope = concord2Scope(community.idHex);
        const wasDeferred = (deferredFlags.get(scope) ?? deferredFlags.get(community.idHex) ?? 0) > 0;
        const clearFlag = () => {
          deferredFlags.delete(scope);
          deferredFlags.delete(community.idHex); // pre-scope legacy spelling
        };
        if (isScopeActivated(scope)) {
          // Navigated into (this session): live for good.
          if (wasDeferred) {
            clearFlag();
            catchUpCommunity(nostr, entry, community.idHex);
          }
        } else if (await communityDotted(community.idHex, channels, dotCtxRef.current)) {
          if (!wasDeferred) deferredFlags.set(scope, Math.floor(Date.now() / 1000));
          continue;
        } else if (wasDeferred) {
          // The dot cleared while deferred — a read synced back from another
          // device. Pin it live for the session: re-deferring on the next
          // unread would oscillate catch-up pulls against a standing
          // subscription that costs less.
          markScopeLive(scope);
          clearFlag();
          catchUpCommunity(nostr, entry, community.idHex);
        }

        const keys: GroupKey[] = [];
        for (const channel of channels) {
          out.push({
            relays: community.relays,
            channel,
            communityIdHex: community.idHex,
            gitAttachments: channelGitRepositoryAttachments(folded?.channels.get(channel.idHex)?.metadata ?? { name: channel.name, private: channel.isPrivate }),
          });
          keys.push(...channel.streams.map((s) => s.group));
        }
        // Scoped per community, so a relay's NIP-42 challenge only signs the
        // stream keys it actually hosts (see streamAuth.ts).
        registerStreamKeys(keys, community.relays);
      }
      return out;
    },
  });

  return query.data ?? [];
}

/**
 * Newest store events scanned per relay when judging a server's unread dot.
 * Smaller than the rail's own 300-event scan, deliberately: activity found
 * unread inside this window is unread inside the rail's larger window too, so
 * the wire never defers a server whose rail button isn't visibly dotted — a
 * miss merely keeps the server syncing (the safe direction).
 */
const NIP29_DOT_SCAN_LIMIT = 100;

/** Group filters per catch-up REQ (relays commonly cap filters-per-REQ ~10-20). */
const NIP29_CATCHUP_FILTERS_PER_REQ = 10;

/** What the NIP-29 dot judgment needs from React context, snapshotted per run. */
interface Nip29DotContext {
  pubkey: string | undefined;
  readState: Record<string, number>;
  isMuted: (relayUrl: string, groupId: string) => boolean;
}

/**
 * Whether the server's rail button currently shows an unread indicator,
 * judged from the local event store the way the rail judges it
 * (useRelayUnread + the rail's mute rule): non-self activity newer than its
 * group's read stamp lights the dot unless the group is muted, and a p-tag
 * mention lights the badge regardless of mute.
 */
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
 * Bring a previously-deferred NIP-29 server's store current: the newest page
 * of every group, filed under the serving relay and announced on the bus —
 * the `nip29:` sync round's write path, batched across the server's groups.
 * Heals the region the shared per-relay cursor may have skipped past (the
 * relay can carry DM/git filters that kept its cursor advancing while the
 * server's `#h` filter was excluded); deeper history is the group's own
 * `nip29:` round when it is viewed.
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
      // Filed under the serving relay (the relay-scoped tenant); per-event
      // catch so one duplicate/refused row doesn't fail the page.
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
 * The unread-dot deferral for NIP-29 servers, over the wire's unioned group
 * list: a server whose rail button already shows the dot has its groups'
 * `#h` filters dropped from the wire until the user navigates into it (or
 * the dot clears via a read synced from another device) — the same rule, and
 * the same catch-up IOU, as the Concord V2 deferral above. NIP-29 is
 * relay-per-community, so the unit of deferral is the relay: its rail button
 * and its dot are per-server, and its channels defer and re-activate
 * together.
 */
function useWireNip29Deferral(
  groups: Array<{ id: string; relay: string; buzz?: boolean }>,
): Array<{ id: string; relay: string; buzz?: boolean }> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { readState } = useReadState();
  const { isChannelMuted } = useMutes();
  const eventStore = useEventStore();

  // Deferral inputs through a ref, so read-state churn (every markRead in the
  // open channel) doesn't rebuild the spec; the 2-minute refetch picks up the
  // one change that matters (a remote read clearing a deferred server's dot).
  const dotCtxRef = useRef<Nip29DotContext>({ pubkey: undefined, readState: {}, isMuted: () => false });
  dotCtxRef.current = { pubkey: user?.pubkey, readState, isMuted: isChannelMuted };

  // Navigating into a server must re-run the spec NOW (its filters rejoin
  // the wire and its catch-up starts), not on the next poll.
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
    staleTime: 30_000,
    // A local (IndexedDB) read; the interval re-judges dots that changed
    // out-of-band (a remote read syncing back). No reason to run it hidden.
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      // The first run must see the persisted deferral flags, or a reload
      // would treat every deferred server as live and skip the catch-up its
      // cursor gap may require.
      await deferredFlags.ready();
      const all = groupsRef.current;
      // Grouped under the NORMALIZED relay — the spelling the read-state keys
      // and the store's relay scope use; the entries keep their original
      // relay string for the spec builder (which normalizes again).
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
          // Navigated into (this session): live for good.
          if (wasDeferred) {
            deferredFlags.delete(scope);
            catchUpNip29Server(nostr, relay, ids);
          }
        } else if (await nip29ServerDotted(store, relay, ids, dotCtxRef.current)) {
          if (!wasDeferred) deferredFlags.set(scope, Math.floor(Date.now() / 1000));
          continue;
        } else if (wasDeferred) {
          // The dot cleared while deferred — a read synced back from another
          // device. Pin it live for the session (see the V2 branch above for
          // why re-deferring would oscillate).
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
  channels: Array<{ channel: ChannelV2; communityIdHex: string; gitAttachments: ReturnType<typeof channelGitRepositoryAttachments> }>,
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
 * The Concord V2 CONTROL-plane subscription targets for EVERY live community:
 * per community, its control-stream GroupKeys (across held epochs) and relays.
 * Unlike the channel list, this needs NO fold — control keys derive straight
 * from the rehydrated bundle's held roots — so it's a cheap, stable memo that
 * updates only when membership/epochs change.
 *
 * A standing subscription to these authors is what makes a newly-published
 * channel edition land LIVE for a non-open community, so a member added to a
 * new channel sees it appear in the sidebar without waiting for the slow
 * background control-plane sweep (or for the first message to be posted).
 * Every control stream key is registered for NIP-42 so the wire's kind-1059
 * control REQs pass auth-gating relays.
 */
function useWireConcord2Control(): Array<{
  relays: string[];
  idHex: string;
  groups: StreamKeyView[];
  refounded: boolean;
}> {
  const { data } = useCommunityList2();
  const entries = useMemo(() => (data ? liveEntries(data.list) : []), [data]);

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
      // Scoped per community: a relay's NIP-42 challenge only signs the control
      // stream keys it actually hosts (see streamAuth.ts).
      registerStreamKeys(groups, community.relays);
    }
    return out;
  }, [entries]);
}

/**
 * THE funnel. One component owns all standing ingestion:
 *
 *   - builds the wire spec (minimal relays + filters — the same information
 *     the APK's persistent notification service is configured with);
 *   - web: holds ONE subscription per relay through the relay pool (which
 *     handles NIP-42 AUTH — user key + Concord V2 stream keys), resuming from
 *     a persisted per-relay cursor so time offline is replayed;
 *   - APK: bridges the native service's buffered/live events into the same
 *     ingest path;
 *   - drains V2 wraps the native service parked while the WebView was down.
 *
 * Everything lands in IndexedDB (armada-events / the V2 rumor store) and the
 * wire bus announces which conversations changed. Hooks hydrate from the
 * stores; none of them hold their own sockets.
 */
export function WireSync() {
  // Boot sequencing: the wire is the highest-volume ingest driver, and its
  // replay used to start the moment the providers mounted — competing, on the
  // one main thread, with the local reads the first paint is made of. The
  // funnel mounts only once the boot gate opens (first local paint, a fresh
  // login, or the gate's short timeout); the durable cursors make the later
  // start lossless.
  const bootGateOpen = useBootGateOpen();
  return bootGateOpen ? <WireSyncInner /> : null;
}

function WireSyncInner() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const { data: groupList } = useUserGroupList();
  const { data: followData } = useFollowList();
  const { data: concordData } = useConcordList();
  const { relays: publishedDmRelays } = useDmRelayList();
  const concord2 = useWireConcord2Channels();
  const concord2Control = useWireConcord2Control();
  const nip29Groups = useWireNip29Groups();
  const gitRepositories = useMemo(() => wireGitRepositories(concord2), [concord2]);
  const gitTicketRoots = useWireGitTicketRoots(gitRepositories);

  // NIP-29 groups to subscribe to: the per-server directory discovery (the
  // primary source — see useWireNip29Groups) UNIONed with the kind-10009
  // `groups` list (which additionally carries private/closed channels the open
  // directory hides). De-duplicated by relay+id.
  const allNip29Groups = useMemo(() => {
    const byKey = new Map<string, { id: string; relay: string; buzz?: boolean }>();
    for (const g of nip29Groups) {
      if (g.id && g.relay) byKey.set(`${g.relay}\u0000${g.id}`, g);
    }
    for (const g of groupList?.groups ?? []) {
      // Never overwrite a directory-discovered entry: it carries the relay's
      // Buzz flag, which the 10009 list doesn't know about.
      const key = `${g.relay}\u0000${g.id}`;
      if (g.id && g.relay && !byKey.has(key)) byKey.set(key, { id: g.id, relay: g.relay });
    }
    return [...byKey.values()];
  }, [nip29Groups, groupList?.groups]);
  // …minus the servers deferred under the unread-dot rule.
  const groups = useWireNip29Deferral(allNip29Groups);

  // The relays to hold the live kind-1059 gift-wrap subscription on. MUST match
  // the set useDm17's inbox scan reads from (useDm17SyncCtx): our effective DM
  // relays UNIONED with our PUBLISHED kind-10050 inbox. NIP-17 senders deliver a
  // wrap to the recipient's published 10050 relays; on a default login
  // (useOwnDmRelays off) effectiveDmRelays is just the app relays, so without the
  // union the wire would listen on the wrong relays and never receive the wrap
  // LIVE — only useDm17's 60s poll (which does union the 10050 relays) would
  // fetch it, which is exactly the "DMs only show up after ~30-60s / a refresh"
  // bug. Deduped.
  const dmRelays = useMemo(
    () => [...new Set([...effectiveDmRelays(config), ...publishedDmRelays])],
    [config, publishedDmRelays],
  );

  const spec: WireSpec = useMemo(
    () =>
      buildWireSpec({
        pubkey: user?.pubkey,
        groups,
        dmRelays,
        dmFollows: followData?.pubkeys ?? [],
        concord1: buildConcordSubs(concordData?.list),
        concord1Control: buildConcordControlSubs(concordData?.list),
        concord2,
        concord2Control,
        gitRepositories,
        gitTicketRoots,
      }),
    [user?.pubkey, groups, dmRelays, followData?.pubkeys, concordData, concord2, concord2Control, gitRepositories, gitTicketRoots],
  );

  // The ingest path reads the spec lazily so long-lived subscriptions always
  // decrypt/scope with the latest keys without resubscribing.
  const specRef = useRef(spec);
  specRef.current = spec;
  const sinksRef = useRef({
    eventStore,
    getSpec: () => specRef.current,
    getSelfPubkey: () => user?.pubkey,
  });
  sinksRef.current = {
    eventStore,
    getSpec: () => specRef.current,
    getSelfPubkey: () => user?.pubkey,
  };

  // ── Web sockets: one REQ per relay, resumed from the persisted cursor ─────
  // Loops are diffed PER RELAY rather than keyed on the whole spec: the spec
  // settles several times during startup as its inputs resolve (groupList,
  // followData, concordData, concord2 folds, git repositories, git ticket
  // roots), and tearing down every relay's standing REQ on each settle aborted
  // catch-up replays mid-flight and re-issued/re-authed every subscription —
  // most with identical filters. Only relays whose own filter set changed are
  // restarted; the rest keep their round and cursor untouched.
  const loopsRef = useRef(new Map<string, { sig: string; stop: () => void; bump: () => void }>());
  const loopsOwnerRef = useRef<{ nostr: unknown; pubkey?: string } | null>(null);
  // Explicit-`since` filters (git child / CI bootstrap timestamps) that have
  // completed a stored replay this session, keyed relay + filter shape.
  // Honoring the deep root-based `since` on EVERY loop start re-downloaded the
  // full comment/status/CI history each time the relay's filters changed; once
  // a bootstrap replay reaches EOSE that history is in the store, and later
  // rounds resume from the relay cursor like every other filter.
  const bootstrappedRef = useRef(new Set<string>());

  useEffect(() => {
    const loops = loopsRef.current;

    const startRelayLoop = (relay: string, filters: NostrFilter[]) => {
      const controller = new AbortController();
      // "Restart your round now": aborts the in-flight round and skips any
      // backoff sleep, so the loop re-REQs immediately. Reassigned each round;
      // driven by the socket-reopen / tab-visibility effect below.
      let bumpRound = () => {};
      void (async () => {
        // Resubscribe with backoff for the loop's lifetime. NRelay1 keeps
        // the SOCKET alive across drops, but a relay-initiated CLOSED (an
        // auth-gating relay rejecting the REQ before AUTH lands, a policy
        // refusal) terminates the req generator and nothing brings the
        // subscription back until a spec change or app relaunch — on desktop,
        // where there is no native-service funnel, that means no live wire
        // until restart. Each fresh REQ gets a new sub id and with it a fresh
        // auth-retry from the pool, so the wire heals as soon as AUTH lands.
        let backoff = 1_000;
        // Signal-aware, bump-aware sleep: loop teardown or a socket reopen
        // resolves it early so the retry never lags behind a live socket.
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
        // The cursors are in KV now, so the first round has to wait for them.
        // Reading an unwarmed cache would resume from the fresh lookback and
        // re-ingest the backlog on every launch.
        await cursors.ready();
        // Routine rotations are silent in the log; only the first round and
        // anomalies (swallowed REQ, reopen restart, early CLOSED) speak.
        let firstRound = true;
        // Whether a round on this loop has completed its stored replay (EOSE).
        // The DM wrap filter re-rewinds the 2-day backdate window every round,
        // so once the window has been replayed ONCE, later rounds (routine
        // quiet rotations, reconnects) shrink its replay `limit` — the bytes
        // were pure duplicates. The DM poll's periodic full scan backstops a
        // burst deeper than the steady cap (see stampRoundSince).
        let wrapReplayDone = false;
        while (!controller.signal.aborted) {
          const started = Date.now();
          // Recompute the resume point each round: the cursor advanced with
          // everything the previous round ingested.
          const now = Math.floor(Date.now() / 1000);
          const cursor = readCursor(relay);
          const floor = now - MAX_CURSOR_AGE_SECONDS;
          const since = Math.max(
            cursor !== undefined ? cursor - CURSOR_OVERLAP_SECONDS : now - FRESH_LOOKBACK_SECONDS,
            cursor !== undefined ? floor : 0,
          );
          // Abortable round, watched for liveness on a recurring tick:
          //   - a round that never yields ANYTHING (no EVENT, no EOSE) inside
          //     SILENT_REQ_TIMEOUT_MS was swallowed — abort and re-REQ;
          //   - an established round silent past QUIET_ROTATE_MS is rotated —
          //     a quiet channel and a silently-dead subscription look
          //     identical from here, and re-REQing from the cursor is
          //     lossless, so never trust one subscription for long;
          //   - a socket reopen bumps the round immediately (see relayReopen).
          const round = new AbortController();
          const roundSignal = AbortSignal.any([controller.signal, round.signal]);
          bumpRound = () => {
            logSync("wire", `${relay}: socket reopened — restarting round`);
            round.abort();
            wakeSleep?.();
          };
          let sawAnything = false;
          // Whether the round's stored replay has finished (EOSE seen): events
          // after it are LIVE arrivals. Ingest uses this to keep replayed DM
          // wraps (the wrap filter's since rewinds the NIP-59 backdate window —
          // see stampRoundSince) from re-firing notifications every round.
          let eosed = false;
          let lastMsgAt = started;
          let ingested = 0;
          let rotated = false;
          const watchdog = setInterval(() => {
            const silentFor = Date.now() - lastMsgAt;
            if (!sawAnything && silentFor >= SILENT_REQ_TIMEOUT_MS) {
              logSync("wire", `${relay}: round yielded nothing in ${Math.round(silentFor / 1000)}s — presumed swallowed, re-REQ`);
              round.abort();
            } else if (sawAnything && silentFor >= QUIET_ROTATE_MS) {
              rotated = true;
              round.abort();
            }
          }, WATCHDOG_TICK_MS);
          if (firstRound) {
            logSync("wire", `${relay}: round open (since=${since}, ${filters.length} filter(s))`);
            firstRound = false;
          }
          // Partition out explicit-`since` filters still awaiting their
          // bootstrap replay: they keep their deep timestamp for this round;
          // everything else — and every filter afterwards — takes the cursor.
          const bootKey = (f: NostrFilter) => `${relay}\u0000${JSON.stringify(f)}`;
          const pending = filters.filter((f) => f.since !== undefined && !bootstrappedRef.current.has(bootKey(f)));
          const settled = pending.length === 0 ? filters : filters.filter((f) => !pending.includes(f));
          // Pre-EOSE events are a stored replay — buffer them and flush in
          // batches (see REPLAY_BATCH_MAX); post-EOSE events are live and
          // ingest one-by-one as they arrive.
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
                [...stampRoundSince(settled, since, now, false, wrapReplayDone), ...stampRoundSince(pending, since, now, true, wrapReplayDone)],
                { signal: roundSignal },
              )) {
                sawAnything = true;
                lastMsgAt = Date.now();
                if (msg[0] === "EOSE") {
                  await flushReplay();
                  eosed = true;
                  wrapReplayDone = true;
                  // Bootstrap replay complete. Marked only at EOSE, so a round
                  // torn down mid-replay retries the deep `since` next round.
                  for (const f of pending) bootstrappedRef.current.add(bootKey(f));
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
              // A round torn down mid-replay (watchdog, reopen bump, effect
              // cleanup) still ingests what it already received.
              await flushReplay();
            }
          } catch {
            // Aborted or transport error — handled by the loop condition.
          } finally {
            clearInterval(watchdog);
            // Release the composite roundSignal's grip on the effect
            // controller (a naturally-CLOSED round never aborted its own).
            round.abort();
          }
          if (controller.signal.aborted) break;
          if (!rotated) {
            logSync(
              "wire",
              `${relay}: round ended after ${Math.round((Date.now() - started) / 1000)}s (${ingested} event(s) ingested)`,
            );
          }
          // A session that lived a while earned a prompt retry; a relay
          // slamming the door (CLOSED right away) backs off up to 60s.
          if (Date.now() - started > 60_000) backoff = 1_000;
          await sleep(backoff + Math.floor(Math.random() * 250));
          backoff = Math.min(backoff * 2, 60_000);
        }
      })();
      return {
        sig: JSON.stringify(filters),
        stop: () => controller.abort(),
        bump: () => bumpRound(),
      };
    };

    // A new pool or user invalidates every loop's captured socket/auth context.
    if (loopsOwnerRef.current?.nostr !== nostr || loopsOwnerRef.current?.pubkey !== user?.pubkey) {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
      loopsOwnerRef.current = { nostr, pubkey: user?.pubkey };
    }
    const desired = new Map<string, NostrFilter[]>(user ? spec.subs.map(({ relay, filters }) => [relay, filters]) : []);
    for (const [relay, loop] of loops) {
      const filters = desired.get(relay);
      if (!filters || JSON.stringify(filters) !== loop.sig) {
        loop.stop();
        loops.delete(relay);
      }
    }
    for (const [relay, filters] of desired) {
      if (!loops.has(relay)) loops.set(relay, startRelayLoop(relay, filters));
    }
    // Loops deliberately outlive this effect (the teardown effect below owns
    // them); re-diff only when the actual subscription set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, spec.sig]);

  // A backgrounded browser tab has its timers throttled and its sockets
  // idled by the engine, so the watchdog's re-REQ (30s/90s) stretches to
  // minutes and a silently-dead subscription isn't noticed until long after
  // the user returns. Kick every relay's round the instant the tab becomes
  // visible again: an immediate re-REQ from the cursor is lossless and
  // drains anything the throttled round missed, so refocus is prompt instead
  // of waiting out a throttled watchdog tick. Socket reopens kick just the
  // affected relay's round the same way (see relayReopen.ts).
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

  // ── APK bridge: the persistent service is a funnel into the same ingest ──
  useEffect(() => {
    if (!hasNativeNotificationService()) return;
    let cancelled = false;

    // One relay's worth of events per call: the store files NIP-29 data under
    // the relay that served it, so a batch spanning relays could not be routed.
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

    // Route what the service received while the WebView was down (open /
    // resume). The events are already IN the store — service and WebView share
    // one native ArmadaDB — so this is not how they become durable; it is how
    // they get a pass through ingest (parked wraps, wire scopes, notification
    // candidates). A page is acked only AFTER ingest completes, so a webview
    // crash mid-page replays instead of dropping the routing. NOT live: the
    // service already notified for these.
    let draining = false;
    const drain = async () => {
      if (draining) return; // resume + mount can overlap; pages are sequential
      draining = true;
      try {
        while (!cancelled) {
          const { events, ids, relay } = await ArmadaNotification.drainEvents();
          if (events.length === 0) break;
          await ingest(events, false, relay);
          if (cancelled) break;
          await ArmadaNotification.ackDrain({ ids, relay });
        }
      } catch {
        // Bridge unavailable / mid-drain failure — the unacked page replays.
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

  // ── Parked-wrap drain: decrypt what the service left us, as keys appear ──
  // Covers BOTH chat wraps (→ rumor store, `c2:` scope) and control-plane wraps
  // (→ opened-event store, `c2ctl:` scope). The native service parks any wrap it
  // can't open; the wire holds the keys, so it drains them here whenever the
  // spec (hence the held key set) changes. useControlEvents2 no longer polls to
  // drain parked control wraps — this is the single drain for both planes.
  useEffect(() => {
    if (spec.v2ByPk.size === 0 && spec.v2CtlByPk.size === 0) return;
    let cancelled = false;
    // Debounce: spec.sig fires 4-6 times during startup as queries resolve
    // (groupList, followData, concordData, concord2, concord2Control). Without
    // a delay each firing kicks off IDB reads + openChatBatch + IDB writes
    // concurrently, monopolising the main thread before the UI is interactive.
    const timer = setTimeout(() => {
      void (async () => {
        const drainStart = performance.now();
        try {
          const parked = await peekPendingWraps([...spec.v2ByPk.keys(), ...spec.v2CtlByPk.keys()]);
          if (parked.length === 0 || cancelled) return;
          // WALL CLOCK for the whole drain, against `crypto.openChatBatch`'s
          // CPU-only total. The gap between the two is the slicing overhead:
          // `setTimeout(0)` is clamped to ~4ms past nesting depth 5, so a
          // thousand wraps at a 5ms slice can spend more time yielding than
          // decrypting. `peekPendingWraps` reads up to 1000 (rumorStore).
          perfMark("wire.parked drain start", `${parked.length} wrap(s)`);
          const scopes = new Set<string>();
          const acked: string[] = [];

          // Chat wraps → rumor store, grouped per owning channel.
          const byChannel = new Map<ChannelV2, NostrRumor[]>();
          // Control wraps → opened-event store, grouped per owning community.
          const ctlByCommunity = new Map<
            string,
            { groups: StreamKeyView[]; refounded: boolean; wraps: NostrRumor[] }
          >();
          for (const wrap of parked) {
            const channel = spec.v2ByPk.get(wrap.pubkey);
            if (channel) {
              const list = byChannel.get(channel);
              if (list) list.push(wrap);
              else byChannel.set(channel, [wrap]);
              continue;
            }
            const ctl = spec.v2CtlByPk.get(wrap.pubkey);
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
            }
          }

          for (const [channel, wraps] of byChannel) {
            // No community for this channel means no tenant to write to, so
            // neither store nor ACK — the wraps stay parked for a later drain
            // (a notified message must never be locally destructible).
            const communityIdHex = spec.v2CommunityByChannel.get(channel.idHex);
            if (!communityIdHex) continue;
            const opened = await openChatBatch(wraps, channel);
            if (opened.length === 0) continue;
            // ACK only what actually landed: a wrap is deleted on the
            // strength of its rumor being stored, and a notified message must
            // never be locally destructible.
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

          ackPendingWraps(acked);
          if (scopes.size > 0) emitWireScopes(scopes);
        } catch {
          // Best-effort — wraps stay parked for the next pass.
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
