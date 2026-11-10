/**
 * Concord channel history sync — the `c2:` sync-topic handler. The wire delivers
 * LIVE wraps; this pulls history the wire's `since` window never covered (cold
 * opens, offline gaps) as a three-pass relay round into the rumor store. The sync
 * scheduler decides WHEN; this module only knows HOW.
 *
 * A round needs context the topic string can't carry (pool, relays, stream keys),
 * registered first via {@link setChannelSyncContext}; a run without it fails loudly
 * so the scheduler retries. Results reach the UI via `writeRumors`' bus ring.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { openChatBatch } from "@/concord/lib/chat";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { notePlaneWrapsSeen, unseenPlaneWraps, whenAuthSettled } from "@/concord/lib/planeSync";
import {
  clearStreamExhausted,
  queryChannelRumors,
  readStreamCursor,
  resetStreamCursor,
  updateStreamCursor,
  writeRumors,
  type StreamBridge,
} from "@/concord/lib/rumorStore";
import type { Channel, Community } from "@/concord/lib/types";
import { isRelayUnreachable } from "@/lib/relayHealth";
import { perfMark } from "@/lib/perf";
import { beginSyncTask } from "@/lib/syncActivity";
import { t } from "@/i18n/intl";
import { invalidateSyncTopic, registerSyncTopic } from "@/sync/syncManager";
import { emitWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

/** Minimal relay-capable Nostr client the round needs (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
    /** Like `query`, but rejects when the relay CLOSEs the REQ (the batcher's relay handles). */
    queryStrict?(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Relay backfill page size. */
const BACKFILL_PAGE = 50;
/** EOSE race grace once the fastest relay returns a page. */
const BACKFILL_EOSE_GRACE_MS = 500;
/**
 * Older-history pages per round; the saved cursor resumes the rest later or on
 * `loadOlder`.
 */
const BACKFILL_MAX_PAGES = 20;
/** Pages per `loadOlder` scroll-up when the local store is exhausted. */
export const LOAD_OLDER_MAX_PAGES = 6;
/** Older-history pages a background round reads; deeper history is the scroll-up's job. */
const ROUND_OLDER_PAGES = 2;
/** Overlap behind the saved `newest` for the newest pass (publisher clock skew; CORD-01: no backdating). */
const NEWEST_OVERLAP_SECS = 10 * 60;
/** How far ahead of the clock a wrap's `created_at` may still become a cursor. */
const MAX_CURSOR_AHEAD_SECS = 10 * 60;
/**
 * Relays older history is paged from. A community's wraps are published to all
 * its relays, so the rest return the same pages again.
 */
const HISTORY_RELAYS = 2;

/** The relays to page a community's older history from: its first reachable few. */
export function historyRelays(community: Pick<Community, "relays">): string[] {
  const live = community.relays.filter((url) => !isRelayUnreachable(url));
  return (live.length > 0 ? live : community.relays).slice(0, HISTORY_RELAYS);
}

/**
 * Floor between two rounds for one channel, and the freshness stamp's max age
 * for a standing view. Durable in KV, so a quick switch-and-back is a store read.
 */
export const CHANNEL_SYNC_MIN_INTERVAL_MS = 30_000;
export const CHANNEL_SYNC_STALE_AFTER_MS = 5 * 60_000;

/**
 * The relay filter for one channel page — ONE filter, so the single per-relay
 * `until` cursor stays a sound frontier.
 *
 * `authors` is the only unforgeable relay-side dimension. Retired streams are
 * asked for until history is verifiably swept to the bottom, then
 * (`freezeRetired`) dropped entirely; the local store is the archive from then on
 * (CORD-03 §3). Not split into a live + `until`-capped retired filter: two
 * filters sharing one cursor would skip the newer filter's unread region.
 */
export function channelFilters(
  channel: Channel,
  opts: { limit: number; cursor?: number; since?: number; freezeRetired?: boolean },
): NostrFilter[] {
  const authors: string[] = [];
  for (const s of channel.streams) {
    if (s.retiredAt !== undefined && opts.freezeRetired) continue;
    authors.push(s.group.pk);
  }
  if (authors.length === 0) return [];
  const f: NostrFilter = { kinds: [KIND_WRAP], authors, limit: opts.limit };
  if (opts.cursor !== undefined) f.until = opts.cursor;
  if (opts.since !== undefined) f.since = opts.since;
  return [f];
}

/**
 * Backfill wraps with `until` pagination and per-relay cursors (a relay ignoring
 * `until` is culled after one non-progressing page). Returns oldest/newest
 * `created_at`, collected wraps, whether history is exhausted, and whether any
 * relay FAILED — failure must never count as exhaustion or advance a cursor past
 * the failed region. `since` bounds a pass from below (the bridge pass).
 *
 * Kind-1059 wraps are never mirrored into `armada-events`
 * (`NostrBatcher.cacheEvents` drops gift wraps); only decrypted rumors persist.
 */
export async function backfillStore(
  nostr: NostrLike,
  relays: string[],
  channel: Channel,
  signal: AbortSignal,
  opts: {
    until?: number;
    since?: number;
    maxPages?: number;
    freezeRetired?: boolean;
    beforeRelay?: (url: string) => Promise<void>;
    /** Consume each page's wraps as it lands (so the timeline paints progressively) instead of accumulating. */
    onPage?: (events: NostrEvent[]) => Promise<void>;
    /**
     * After each page, the timestamp down to which EVERY still-paging relay has been
     * read. Not called once any relay has failed.
     */
    onProgress?: (coveredDownTo: number) => Promise<void>;
    /** An all-empty answer is conclusive (a `since`-bounded read of a quiet channel). */
    emptyOk?: boolean;
  } = {},
): Promise<BackfillResult> {
  const maxPages = opts.maxPages ?? BACKFILL_MAX_PAGES;
  let oldest: number | undefined;
  let newest: number | undefined;
  let active = relays.map((url) => ({ url, cursor: opts.until }));
  const collected: NostrEvent[] = [];
  let count = 0;
  let failed = false;
  let pages = 0;

  for (let page = 0; page < maxPages && active.length > 0; page++) {
    if (signal.aborted) break;
    pages++;
    const pageController = new AbortController();
    const pageSignal = AbortSignal.any([signal, pageController.signal]);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const armGrace = () => {
      graceTimer ??= setTimeout(() => pageController.abort(), BACKFILL_EOSE_GRACE_MS);
    };

    const results = await Promise.all(
      active.map(async (relay) => {
        const filters = channelFilters(channel, {
          limit: BACKFILL_PAGE,
          cursor: relay.cursor,
          since: opts.since,
          freezeRetired: opts.freezeRetired,
        });
        if (filters.length === 0) return { relay, events: [] as NostrEvent[], ok: true };
        try {
          // Per-relay auth gate: each relay waits only for ITS OWN stream AUTHs.
          await opts.beforeRelay?.(relay.url);
          if (pageSignal.aborted) return { relay, events: [] as NostrEvent[], ok: false };
          const handle = nostr.relay(relay.url);
          const querySignal = AbortSignal.any([pageSignal, AbortSignal.timeout(8000)]);
          // A CLOSED page ("too many subscriptions", rate-limited) must fail, not
          // read as an empty one: that would seal the channel's history as exhausted.
          const events = handle.queryStrict
            ? await handle.queryStrict(filters, { signal: querySignal })
            : await handle.query(filters, { signal: querySignal });
          // Only a relay that HAS events starts the race clock; an instant empty EOSE must
          // not abort relays still mid-AUTH.
          if (events.length > 0) armGrace();
          return { relay, events, ok: true };
        } catch {
          return { relay, events: [] as NostrEvent[], ok: false };
        }
      }),
    );
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    const next: typeof active = [];
    const pageEvents: NostrEvent[] = [];
    for (const { relay, events, ok } of results) {
      if (!ok) {
        // This relay's region was NOT read: block exhaustion/cursor advancement; retry later.
        failed = true;
        continue;
      }
      pageEvents.push(...events);
      let relayOldest = Infinity;
      let progressed = 0;
      for (const ev of events) {
        if (newest === undefined || ev.created_at > newest) newest = ev.created_at;
        if (relay.cursor === undefined || ev.created_at < relay.cursor) {
          progressed += 1;
          if (ev.created_at < relayOldest) relayOldest = ev.created_at;
        }
      }
      if (Number.isFinite(relayOldest)) {
        if (oldest === undefined || relayOldest < oldest) oldest = relayOldest;
      }
      if (progressed > 0 && events.length >= BACKFILL_PAGE && relayOldest > 0) {
        next.push({ url: relay.url, cursor: relayOldest - 1 });
      }
    }
    count += pageEvents.length;
    if (opts.onPage) {
      // Hand over each page as it lands; memory stays one page.
      if (pageEvents.length > 0) await opts.onPage(pageEvents);
    } else {
      collected.push(...pageEvents);
    }
    active = next;
    if (opts.onProgress && !failed && next.length > 0 && !signal.aborted) {
      await opts.onProgress(Math.max(...next.map((relay) => (relay.cursor ?? 0) + 1)));
    }
  }
  // `exhausted` = verifiably reached the bottom after seeing history. An all-empty
  // run is INCONCLUSIVE (pre-AUTH empty answers, stale cursor) and must not seal
  // the channel, so it's treated as a failure.
  const reachedBottom = active.length === 0 && !failed;
  const exhausted = reachedBottom && count > 0;
  // The shallowest relay still paging bounds what EVERY relay has been read down to;
  // `oldest` is the deepest any one relay reached, which is no frontier at all.
  let coveredDownTo: number | undefined;
  if (!failed) {
    if (reachedBottom) coveredDownTo = oldest;
    else if (active.every((relay) => relay.cursor !== undefined)) {
      coveredDownTo = Math.max(...active.map((relay) => relay.cursor! + 1));
    }
  }
  return {
    oldest,
    newest,
    coveredDownTo,
    events: collected,
    count,
    pages,
    reachedBottom,
    exhausted,
    failed: failed || (reachedBottom && count === 0 && !opts.emptyOk),
  };
}

export interface BackfillResult {
  /** Deepest `created_at` any relay returned. */
  oldest?: number;
  newest?: number;
  /** Pages asked for, the budget a caller shares between passes. */
  pages: number;
  /** Every relay ran out of history (down to `since`, when given) and none failed. */
  reachedBottom: boolean;
  /**
   * Down to which `created_at` every relay has been read — the only value that
   * may become a cursor. Absent once any relay failed.
   */
  coveredDownTo?: number;
  events: NostrEvent[];
  count: number;
  exhausted: boolean;
  failed: boolean;
}

/** Floor between two bus rings from one round's older-history pages. */
const OLDER_RING_MS = 1_500;
/** The same floor for every page of a background round, none of which is on screen. */
const BACKGROUND_RING_MS = 5_000;
/**
 * Floor between two community-wide `c2:` rings owed by background rounds, across
 * every channel: each re-runs the mention and per-channel scans over the whole
 * tenant, for pages of history that rarely change what they show.
 */
const BACKGROUND_WIDE_RING_MS = 60_000;

interface ThrottledRing {
  /** Rings now if the floor has passed, else once it does. */
  ring(): void;
  /** Ring now if a write is still unannounced. */
  flush(): void;
}

/** Call `emit` at most once per `floorMs`, never dropping the last write. */
function throttledRing(emit: () => void, floorMs: number): ThrottledRing {
  let last = 0;
  let owed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!owed) return;
    owed = false;
    last = Date.now();
    emit();
  };
  return {
    ring() {
      owed = true;
      const wait = last + floorMs - Date.now();
      if (wait <= 0) fire();
      else timer ??= setTimeout(fire, wait);
    },
    flush: fire,
  };
}

/** Channels whose background writes still owe the community-wide `c2:` ring. */
const wideOwed = new Set<string>();
const wideRing = throttledRing(() => {
  const ids = [...wideOwed];
  wideOwed.clear();
  emitWireScopes(ids.map((id) => `c2:${id}`));
}, BACKGROUND_WIDE_RING_MS);

/**
 * A background round's pages: `c2old:` at once for the channel's own open
 * timeline, `c2:` for everything community-wide on the slower shared floor.
 */
function backgroundRing(idHex: string): ThrottledRing {
  return throttledRing(() => {
    emitWireScopes([`c2old:${idHex}`]);
    wideOwed.add(idHex);
    wideRing.ring();
  }, BACKGROUND_RING_MS);
}

/**
 * Channels whose last round fetched wraps but decrypted none (a stranded invite,
 * an un-adopted rekey), so the timeline doesn't present "No messages yet" as a
 * verdict. In-memory; cleared once any round decrypts something.
 */
const decodeDeadEnds = new Set<string>();

/** Whether the channel's last sync round returned wraps none of which opened. */
export function channelDecodeDeadEnd(channelIdHex: string): boolean {
  return decodeDeadEnds.has(channelIdHex);
}

/** What a round needs beyond the topic string. Registered by the live view. */
export interface ChannelSyncContext {
  nostr: NostrLike;
  community: Community;
  channel: Channel;
}

const contexts = new Map<string, ChannelSyncContext>();

/**
 * Register the live context for `c2:<channelIdHex>` rounds. Returns a release;
 * an older mount's teardown never clobbers a newer registration.
 */
export function setChannelSyncContext(channelIdHex: string, ctx: ChannelSyncContext): () => void {
  contexts.set(channelIdHex, ctx);
  return () => {
    if (contexts.get(channelIdHex) === ctx) contexts.delete(channelIdHex);
  };
}

/** How many pages a round may spend on each pass below the newest page. */
export interface RoundBudget {
  bridgePages: number;
  olderPages: number;
  /**
   * An empty older answer below held history seals the channel. Without it a
   * walk whose last page ended exactly at the bottom could never finish, since
   * an all-empty run is otherwise inconclusive.
   */
  sealOnEmpty?: boolean;
  /**
   * Background: no sync task (the in-chat indicator means "this conversation is
   * catching up", and every task change re-renders its readers) and every write
   * announced through one throttled ring, since each `c2:` ring re-runs the
   * community-wide readers.
   */
  background?: boolean;
}

/** The open channel's round: a burst is bridged now, deep history is left to scrolling and the walker. */
const LIVE_ROUND: RoundBudget = { bridgePages: BACKFILL_MAX_PAGES, olderPages: ROUND_OLDER_PAGES };

export interface RoundOutcome {
  /** History remains unread below `oldest` or inside an unfinished bridge. */
  more: boolean;
  /** The round moved the channel's cursor. */
  progressed: boolean;
  /** A relay or a store write failed somewhere in the round. */
  failed: boolean;
  /**
   * More of what was fetched failed to open than opened. Wrap signatures are
   * unchecked, so a relay can mint these endlessly to keep a walk "progressing".
   */
  mostlyUnopened: boolean;
}

/** Channels whose store was checked against their cursor this session. */
const storeChecked = new Set<string>();

/** Tests only: a cursor seeded without rows in the store is taken at its word. */
export function _trustCursorForTests(idHex: string): void {
  storeChecked.add(idHex);
}

/** A channel's stream addresses, order-free: what its cursor was read over. */
export function streamSetSig(channel: Channel): string {
  const pks = [...new Set(channel.streams.map((s) => s.group.pk))].sort();
  return bytesToHex(sha256(new TextEncoder().encode(pks.join(","))));
}

const ABORTED: RoundOutcome = { more: true, progressed: false, failed: false, mostlyUnopened: false };

/**
 * One catch-up round: the newest page first (painted immediately), then the
 * BRIDGE between the saved cursor's `newest` and that page (else an offline burst
 * leaves a permanent hole), then bounded older paging from the saved `oldest`.
 */
export async function syncChannelRound(
  ctx: ChannelSyncContext,
  signal: AbortSignal,
  budget: RoundBudget = LIVE_ROUND,
): Promise<RoundOutcome> {
  const { nostr, community, channel } = ctx;
  const idHex = channel.idHex;
  // Scoped `c2:<id>` so the chat view can tell its own catch-up from other sync.
  const task = budget.background ? undefined : beginSyncTask(`#${channel.name}`, { scope: `c2:${idHex}` });
  const pageRing = budget.background ? backgroundRing(idHex) : undefined;
  if (!budget.background) perfMark("chan.round start", `#${channel.name}`);
  try {
    // Heal a POISONED cursor: `exhausted` with `oldest === 0` was sealed by an
    // all-empty run and never paged; clear it so history gets pulled.
    let saved = await readStreamCursor(idHex);
    if (saved?.exhausted && !saved.oldest) {
      saved = { ...saved, exhausted: false };
      void clearStreamExhausted(idHex);
    }
    // What the cursor read is only true of the addresses it read and the rows the
    // store still holds. A changed address set (a writer window, a rekey, a cursor from
    // before the field) or a store with none of the channel's rows starts the read
    // over, the second also past the seen-wrap memo, which vouches for rows that are gone.
    const streams = streamSetSig(channel);
    let ignoreSeen = false;
    if (saved && saved.streams !== streams) {
      saved = undefined;
      await resetStreamCursor(idHex, streams);
    } else if (saved && !storeChecked.has(idHex)) {
      storeChecked.add(idHex);
      const rows = await queryChannelRumors(community.idHex, idHex, { limit: 1, signal }).catch(() => undefined);
      if (rows?.length === 0) {
        saved = undefined;
        ignoreSeen = true;
        await resetStreamCursor(idHex, streams);
      }
    }
    if (!saved) await updateStreamCursor(idHex, { streams });
    if (signal.aborted) return ABORTED;

    // Retired-epoch freeze: once history reached bottom, retired stream addresses
    // leave every REQ (an ejected keyholder can sign wraps there forever). A rekey
    // adoption clears `exhausted`, so each newly retired epoch gets one final sweep.
    const freezeRetired = Boolean(saved?.exhausted);

    // Hold each relay's pages until THAT relay ACKs our stream AUTHs: a kind-1059
    // REQ racing NIP-42 gets CLOSED and reads as empty.
    const authGate = (url: string) => whenAuthSettled(url, () => channel.streams.map((s) => s.group));
    let synced = 0;
    const tick = () => {
      if (synced > 0) task?.update({
          detail: t(
            { id: "channelSync.messageCount", defaultMessage: "{count, plural, one {# message} other {# messages}}" },
            { count: synced },
          ),
        });
    };
    // Decrypt + commit per page (each write rings the bus). A page that failed to
    // commit must never be covered by a saved cursor.
    let writeFailed = false;
    // Wraps fetched that failed to open: a round of nothing else is no reason to requeue.
    let unopened = 0;
    // Wraps actually tried: those the memo skipped are stored already, not undecryptable.
    let tried = 0;
    /**
     * Writes a page and returns the newest `created_at` among its wraps that are
     * KNOWN good — opened now or earlier. Wrap signatures are never checked, so an
     * unopened one's timestamp is relay-supplied and must not become a cursor.
     */
    const writePage = async (events: NostrEvent[], ring?: ThrottledRing): Promise<number | undefined> => {
      if (signal.aborted) return undefined;
      // Skip wraps whose rumors are already stored (the wire's persisted memo).
      const fresh = ignoreSeen ? events : await unseenPlaneWraps(events);
      if (signal.aborted) return undefined;
      const freshIds = new Set(fresh.map((w) => w.id));
      let top: number | undefined;
      const consider = (createdAt: number) => {
        if (createdAt <= nowSecs() + MAX_CURSOR_AHEAD_SECS && (top === undefined || createdAt > top)) {
          top = createdAt;
        }
      };
      for (const ev of events) if (!freshIds.has(ev.id)) consider(ev.created_at);
      if (fresh.length === 0) return top;
      tried += fresh.length;
      const opened = await openChatBatch(fresh, channel, { signal, remember: !budget.background });
      // Logout's purge aborts the round: nothing decrypted may land after it.
      if (signal.aborted) return undefined;
      unopened += fresh.length - opened.length;
      if (opened.length === 0) return top;
      const openedIds = new Set(opened.flatMap((o) => o.wrapId ?? []));
      for (const ev of fresh) if (openedIds.has(ev.id)) consider(ev.created_at);
      const stored = await writeRumors(community.idHex, opened, { ring: !ring });
      if (stored) {
        ring?.ring();
        // Only wraps that OPENED: a failed one may be readable with a later key.
        notePlaneWrapsSeen(opened.flatMap((o) => o.wrapId ?? []));
      } else writeFailed = true;
      synced += opened.length;
      tick();
      return top;
    };

    // Pass 1: the newest page, committed first — it's what the viewer sees. Past a
    // complete round only what's newer is asked for; the bridge fills a burst.
    const newestSince = saved?.newest ? Math.max(0, saved.newest - NEWEST_OVERLAP_SECS) : undefined;
    let top1: number | undefined;
    const newest = await backfillStore(nostr, community.relays, channel, signal, {
      maxPages: 1,
      since: newestSince,
      emptyOk: newestSince !== undefined,
      freezeRetired,
      beforeRelay: authGate,
      onPage: async (events) => {
        if (!budget.background) perfMark("chan.newest page", `${events.length} wrap(s)`);
        const top = await writePage(events, pageRing);
        if (!budget.background) perfMark("chan.newest committed", `${synced} opened`);
        if (top !== undefined && (top1 === undefined || top > top1)) top1 = top;
      },
    });
    if (signal.aborted) return ABORTED;

    // Pass 2 (the bridge): the region between the saved `newest` and pass 1. A gap
    // too big for the budget is recorded as `bridge` and resumed below its read
    // span next round, so every round makes progress into it.
    const since0 = saved?.newest || undefined;
    let bridgeFailed = false;
    let complete = false;
    let bridgeRecord: StreamBridge | undefined;
    if (!newest.failed) {
      if (since0 === undefined || newest.reachedBottom || newest.coveredDownTo === undefined || top1 === undefined) {
        // First round (pass 1 is the top), or pass 1 itself reached below `newest`.
        complete = since0 === undefined || newest.reachedBottom;
      } else {
        const gap = saved?.bridge && saved.bridge.until > since0 ? saved.bridge : undefined;
        let pages = budget.bridgePages;
        const segment = async (until: number, since: number) => {
          const r = await backfillStore(nostr, community.relays, channel, signal, {
            until,
            since,
            maxPages: pages,
            emptyOk: true,
            freezeRetired,
            beforeRelay: authGate,
            onPage: async (events) => {
              await writePage(events, pageRing);
            },
          });
          pages -= r.pages;
          if (r.failed) bridgeFailed = true;
          return r;
        };
        // Segment A: below pass 1, down to the recorded gap's read span (or `newest`).
        const aFloor = gap ? gap.top : since0;
        let aDone = newest.coveredDownTo <= aFloor;
        if (!aDone && pages > 0) {
          const a = await segment(newest.coveredDownTo - 1, aFloor);
          if (a.reachedBottom) aDone = true;
          else if (!a.failed && a.coveredDownTo !== undefined) bridgeRecord = { top: top1, until: a.coveredDownTo };
        }
        if (aDone) {
          if (!gap) complete = true;
          else {
            // Segment B: the gap's unread remainder, down to `newest`.
            bridgeRecord = { top: top1, until: gap.until };
            if (pages > 0) {
              const b = await segment(gap.until - 1, since0);
              if (b.reachedBottom) {
                complete = true;
                bridgeRecord = undefined;
              } else if (!b.failed && b.coveredDownTo !== undefined) {
                bridgeRecord = { top: top1, until: b.coveredDownTo };
              }
            }
          }
        }
      }
    }
    if (signal.aborted) return ABORTED;

    // Pass 3: older history, from the saved cursor or just below pass 1. `oldest` is
    // saved page by page (`onProgress`), since leaving the channel aborts the round.
    // Rings are throttled to OLDER_RING_MS: these pages are off-screen and every
    // ring re-runs community-wide readers.
    const resumeFrom = saved?.oldest || (newest.coveredDownTo !== undefined ? newest.coveredDownTo - 1 : undefined);
    const olderRing = pageRing ?? throttledRing(() => emitWireScopes([`c2:${idHex}`]), OLDER_RING_MS);
    const sealOnEmpty = Boolean(budget.sealOnEmpty && saved?.oldest);
    let older: BackfillResult = { events: [], count: 0, pages: 0, reachedBottom: true, exhausted: true, failed: false };
    try {
      // Nothing older once the bottom was reached; otherwise the budget's pages.
      if (!saved?.exhausted && budget.olderPages > 0) older = await backfillStore(nostr, historyRelays(community), channel, signal, {
        until: resumeFrom,
        maxPages: budget.olderPages,
        emptyOk: sealOnEmpty,
        freezeRetired,
        beforeRelay: authGate,
        onPage: async (events) => {
          await writePage(events, olderRing);
        },
        onProgress: async (coveredDownTo) => {
          if (!writeFailed) await updateStreamCursor(idHex, { oldest: coveredDownTo });
        },
      });
    } finally {
      olderRing.flush();
    }
    if (signal.aborted) return ABORTED;

    // The cursor merge is monotonic. `newest` advances ONLY when the newest region
    // is verifiably complete, and nothing advances past a page that failed to commit.
    if (!writeFailed) {
      await updateStreamCursor(idHex, {
        newest: complete && top1 !== undefined && top1 > 0 ? top1 : undefined,
        bridge: complete ? null : bridgeRecord,
        oldest: older.coveredDownTo,
        exhausted: older.exhausted || (sealOnEmpty && older.reachedBottom) ? true : undefined,
      });
    }

    // A round that pulled wraps and opened none marks a decode dead end; any opened
    // rumor clears it.
    if (synced > 0) decodeDeadEnds.delete(idHex);
    else if (tried > 0) decodeDeadEnds.add(idHex);

    // Ring once the cursor lands, even with nothing decrypted, so a stale scroll-up
    // affordance updates. On `c2cur:`, not `c2:`: only the timeline reads the
    // cursor, and `c2:` would re-run every community-wide reader.
    emitWireScopes([`c2cur:${idHex}`]);

    // Total failure with nothing decrypted: throw so the scheduler retries rather
    // than stamping a likely-wedged topic fresh.
    if (synced === 0 && newest.failed && older.failed) {
      throw new Error("channel backfill reached no relay");
    }

    const after = await readStreamCursor(idHex);
    return {
      more: !after?.exhausted || after.bridge !== undefined,
      progressed: JSON.stringify(after ?? null) !== JSON.stringify(saved ?? null),
      failed: newest.failed || older.failed || bridgeFailed || writeFailed,
      mostlyUnopened: unopened > synced,
    };
  } finally {
    pageRing?.flush();
    task?.end();
  }
}

registerSyncTopic("c2:", {
  minIntervalMs: CHANNEL_SYNC_MIN_INTERVAL_MS,
  staleAfterMs: CHANNEL_SYNC_STALE_AFTER_MS,
  handler: async ({ topic, signal }) => {
    const ctx = contexts.get(topic.slice("c2:".length));
    // A missing context is an ordering bug (it's registered before the want).
    if (!ctx) throw new Error(`no channel sync context for ${topic}`);
    await syncChannelRound(ctx, signal);
  },
});

/**
 * A background history round's budget. Bounded so one deep channel can't hold
 * the scheduler's single background lane; the topic re-queues itself instead.
 */
// Short rounds, so the topic's duty cycle rests in short gaps rather than
// after minutes of solid paging.
const HISTORY_ROUND: RoundBudget = { bridgePages: 10, olderPages: 4, sealOnEmpty: true, background: true };

const historyContexts = new Map<string, ChannelSyncContext>();

/** Drop every registered context: each holds a channel's stream secrets. Logout's purge. */
export function clearChannelSyncContexts(): void {
  contexts.clear();
  historyContexts.clear();
}

/**
 * Register the context for `c2hist:<channelIdHex>`, the background walk that
 * reads every channel's history down to the bottom whether or not it is ever
 * opened, so local search covers it. Same release rule as the live context.
 */
export function setChannelHistoryContext(channelIdHex: string, ctx: ChannelSyncContext): () => void {
  historyContexts.set(channelIdHex, ctx);
  return () => {
    if (historyContexts.get(channelIdHex) === ctx) historyContexts.delete(channelIdHex);
  };
}

registerSyncTopic("c2hist:", {
  minIntervalMs: 5_000,
  // Search coverage, not anything on screen: megabytes per round are left for Wi-Fi.
  unmeteredOnly: true,
  // Every channel is its own topic, so without this the walk runs round after
  // round across them, pinning a core until all history is on disk.
  dutyCycle: 0.2,
  // A walked channel is revisited now and then for gaps the wire's lookback skipped.
  staleAfterMs: 3 * 60 * 60_000,
  handler: async ({ topic, signal }) => {
    const idHex = topic.slice("c2hist:".length);
    const ctx = contexts.get(idHex) ?? historyContexts.get(idHex);
    if (!ctx) throw new Error(`no channel history context for ${topic}`);
    let outcome: RoundOutcome;
    try {
      outcome = await syncChannelRound(ctx, signal, HISTORY_ROUND);
    } catch {
      // Unreachable, or an empty channel (an all-empty answer is inconclusive):
      // either way the walk waits for the next stale pass rather than spinning.
      return;
    }
    // Ask again right away while each round still gets somewhere; one that mostly
    // fetched what wouldn't open waits for the stale pass instead.
    if (!signal.aborted && outcome.more && outcome.progressed && !outcome.mostlyUnopened) invalidateSyncTopic(topic);
  },
});
