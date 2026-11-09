/**
 * NIP-17 direct messages — sync, thread, and conversation hooks (beside the legacy
 * kind-4 engine). Wire format: `src/lib/nip17/protocol.ts`; store: `dm17Store.ts`.
 * - INBOX SYNC: throttled `{kinds:[1059], "#p":[me]}` top-up, since-scoped per relay
 *   watermark; the 2-day NIP-59 backdate slack is paid on full scans only. Ciphertext
 *   is never persisted.
 * - THREAD: local-first store read; older history pages the global `#p` stream.
 * - SEND: rumor → seals → wraps to each peer's kind-10050 relays + our own DM relays.
 *   Optimistic: the rumor id is computable synchronously.
 */

import { useNostr } from "@nostrify/react";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { useDmRelayList, useDmRelaysForAll } from "@/hooks/useDmRelayList";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { useResumeEpoch } from "@/hooks/useResumeEpoch";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { normalizeRelayUrl } from "@/lib/platform";
import { isRelayUnreachable } from "@/lib/relayHealth";
import { nativeDmCoverage } from "@/lib/nativeNotifications";
import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { getDecryptConsent } from "@/lib/decryptConsent";
import { isDmSynced, markDmSynced } from "@/lib/dmSynced";
import { invalidateOnce } from "@/lib/invalidateOnce";
import { STORE_READ } from "@/lib/storeQuery";
import { logSync } from "@/lib/syncLog";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import {
  buildDmEditRumors,
  buildDmRumor,
  DM_RUMOR_KINDS,
  dmChatTags,
  dmDeleteTags,
  dmReactionTags,
  dmTimerTags,
  dmWebxdcTags,
  expirationOf,
  isExpired,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_FILE,
  KIND_DM_PEER_SIGNAL,
  KIND_DM_REACTION,
  KIND_DM_TIMER,
  KIND_DM_WEBXDC,
  KIND_DM_WRAP,
  MAX_WRAP_BACKDATE_SECS,
  openDmWrap,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
  type DmWebxdcMeta,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { dmConvKey, dmConvPeers } from "@/lib/nip17/conversation";
import type { NostrRumor } from "@/lib/nostrRumor";
import {
  DM17_SEEN_CAP,
  drainLiveDmWraps,
  hasBufferedLiveDmWraps,
  mergeFreshDm17,
  onFreshDm17,
  queryDm17Conversations,
  queryDm17Rumor,
  queryDm17Thread,
  queryDm17Timer,
  readDm17Cursor,
  readDm17SeenWrapIds,
  rebufferLiveDmWraps,
  sweepExpiredDm17Rumors,
  updateDm17Cursor,
  writeDm17Rumors,
  writeDm17SeenWrapIds,
  type Dm17ConversationRow,
  type Dm17Cursor,
} from "@/lib/nip17/dm17Store";
import { persistDm17ThreadSnapshot, prewarmDm17ThreadSnapshot } from "@/lib/nip17/threadSnapshot";
import {
  parseDmPeerSignal,
  peerSignalContent,
  type PeerSignalEvent,
} from "@/lib/webxdcRealtime";
import { invalidateSyncTopic, registerSyncTopic, syncHalted, want } from "@/sync/syncManager";
import { useWireScopes } from "@/wire/useWireScopes";
import { dmThreadScope, emitWireScopes } from "@/wire/bus";
import { dm17NotifyCandidates, feedNotifyCandidates, noteWrapsOpened } from "@/wire/notify";
import type { SendStatus } from "@/hooks/useSendStatusMap";
import { shareByRumorId } from "@/lib/shareRows";
import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";
import { t } from "@/i18n";

const SYNC_MIN_INTERVAL_MS = 30_000;
/** Wraps are backdated ≤ 2 days; a FULL scan re-reads this far behind the cursor. */
const RESYNC_SLACK_SECS = MAX_WRAP_BACKDATE_SECS + 3600;
/**
 * Slack for routine polls between full scans. Live delivery is the wire's standing
 * sub; a backdated wrap missed while it was deaf is caught by the next full scan.
 */
const NARROW_RESYNC_SLACK_SECS = 10 * 60;
const FULL_SCAN_INTERVAL_MS = 15 * 60_000;
const lastFullScanAt = new Map<string, number>();
/** Minimum time away for a return to count as a resume (vs. an alt-tab). */
const RESUME_MIN_AWAY_MS = 30_000;
const FOREGROUND_SYNC_MIN_MS = 30_000;
const lastForegroundSyncAt = new Map<string, number>();
const INBOX_PAGE = 500;
const DECRYPT_WAVE = 4;
const THREAD_WINDOW = 300;
const SWEEP_MIN_INTERVAL_MS = 60_000;

let lastSweepAt = 0;

/** Drop rumors whose NIP-40 deadline passed. Throttled; reads filter expired rumors anyway. */
function sweepExpiredSoon(self: string): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepExpiredDm17Rumors(self).catch(() => undefined);
}

export function useDm17Support(): boolean {
  const { user } = useCurrentUser();
  return !!user?.signer.nip44;
}

type NostrPool = ReturnType<typeof useNostr>["nostr"];

interface SyncCtx {
  nostr: NostrPool;
  signer: NostrSigner;
  self: string;
  method: string | undefined;
  relays: string[];
}

interface SyncOpts {
  force?: boolean;
  interactive?: boolean;
  /** Rewind every relay through the full NIP-59 backdate window. */
  full?: boolean;
  /** Called as each relay's page with something new in it has been stored (this pass only). */
  onPageStored?: () => void;
}

const lastSyncAt = new Map<string, number>();
const lastSyncDeclined = new Map<string, boolean>();
const inflightSync = new Map<string, { pass: Promise<boolean>; full: boolean; firstPage: Promise<void> }>();

/**
 * Settles once the running inbox pass has stored its first page with anything new in it, or
 * ended; at once with none running. What the DM list shows first, whichever caller started it.
 */
export function whenDm17InboxFirstPage(self: string | undefined): Promise<void> {
  return (self ? inflightSync.get(self)?.firstPage : undefined) ?? Promise.resolve();
}

const seenWrapIds = new Map<string, Set<string>>();
const seenWrapsLoaded = new Map<string, Promise<void>>();

/**
 * Drops per-account sync bookkeeping and Mini App peer signals held in memory; for
 * logout's purge, after which a stale seen-set would skip wraps whose rumors are gone.
 */
export function clearDm17SessionState(): void {
  lastFullScanAt.clear();
  lastForegroundSyncAt.clear();
  lastSyncAt.clear();
  lastSyncDeclined.clear();
  seenWrapIds.clear();
  seenWrapsLoaded.clear();
  walkedWrapIds.clear();
  for (const timer of historyPauses.values()) clearTimeout(timer);
  historyPauses.clear();
  historyCtxs.clear();
  dmPeerSignalStore.clear();
}

function seenSetFor(self: string): Set<string> {
  let set = seenWrapIds.get(self);
  if (!set) seenWrapIds.set(self, (set = new Set()));
  return set;
}

/**
 * Must complete before any `seenSetFor` filter, or a cold launch re-decrypts the whole
 * slack window.
 */
function loadSeenWraps(self: string): Promise<void> {
  let p = seenWrapsLoaded.get(self);
  if (!p) {
    p = readDm17SeenWrapIds(self)
      .then((ids) => {
        if (!ids) return;
        const seen = seenSetFor(self);
        for (const id of ids) seen.add(id);
      })
      .catch(() => undefined);
    seenWrapsLoaded.set(self, p);
  }
  return p;
}

/** Gated behind the load so a write can't clobber persisted ids with a partial set. */
function persistSeenWraps(self: string): void {
  void loadSeenWraps(self).then(() => {
    const seen = seenSetFor(self);
    if (seen.size > DM17_SEEN_CAP) {
      let drop = seen.size - (DM17_SEEN_CAP >> 1);
      for (const id of seen) {
        if (drop-- <= 0) break;
        seen.delete(id);
      }
    }
    return writeDm17SeenWrapIds(self, seen);
  }).catch(() => undefined);
}

// Mini App peer signals (Vector's DM realtime discovery): kind-30078 rumors inside gift
// wraps naming an iroh node address. Live data, never stored; a bare (unwrapped) 30078 is
// never admitted, since anyone could put a node into our dial set.

export function dmWebxdcPeerScope(conversation: string, topic: string): string {
  return `dm:webxdc-peer:${conversation}:${topic}`;
}

export const DM_WEBXDC_PEER_SCOPE = "dm:webxdc-peer";

const dmPeerSignalStore = new Map<string, PeerSignalEvent[]>();
const DM_PEER_SIGNAL_MAX = 100;
/** Conversation×topic keys kept; the least recently signalled is dropped past it. */
const DM_PEER_SIGNAL_KEYS_MAX = 256;

function peerSignalKey(conversation: string, topic: string): string {
  return `${conversation}\u0000${topic}`;
}

/**
 * Keyed by conversation as well as topic: a signal from one DM must not put its author
 * into a session opened from another.
 */
export function getDmPeerSignals(conversation: string, topic: string): PeerSignalEvent[] {
  return dmPeerSignalStore.get(peerSignalKey(conversation, topic)) ?? [];
}

/**
 * Converts Vector's DM spelling (operation in CONTENT, topic/address in tags) to the
 * canonical fold input shared with Concord.
 */
function dispatchDmPeerSignal(dm: OpenedDm): void {
  const signal = parseDmPeerSignal(dm.content, dm.tags);
  if (!signal) return;
  const conversation = dmConvKey(dm.peers);
  if (!conversation) return;

  const key = peerSignalKey(conversation, signal.topic);
  const existing = dmPeerSignalStore.get(key) ?? [];
  // Re-inserted so Map order is recency order for the key cap.
  dmPeerSignalStore.delete(key);
  existing.push({
    author: dm.author,
    content: peerSignalContent(signal.topic, signal.op === "ad" ? signal.addr : undefined),
    ms: dm.createdAt * 1000,
  });
  if (existing.length > DM_PEER_SIGNAL_MAX) {
    existing.splice(0, existing.length - DM_PEER_SIGNAL_MAX);
  }
  dmPeerSignalStore.set(key, existing);
  while (dmPeerSignalStore.size > DM_PEER_SIGNAL_KEYS_MAX) {
    dmPeerSignalStore.delete(dmPeerSignalStore.keys().next().value!);
  }

  emitWireScopes([dmWebxdcPeerScope(conversation, signal.topic), DM_WEBXDC_PEER_SCOPE]);
}

/**
 * Open wraps (consent-gated) and persist the DM rumors; false when the gate deferred.
 * Background (non-interactive) syncs defer rather than pop the consent prompt.
 */
async function openAndStore(
  ctx: SyncCtx,
  wraps: NostrEvent[],
  interactive: boolean,
  opts?: {
    /** False keeps wraps out of the seen memo and their plaintext out of the signer's decrypt cache. */
    remember?: boolean;
    /** Once aborted nothing is written, and the call reports false. */
    signal?: AbortSignal;
    /** Receives how many wraps opened, peer signals and foreign kinds included. */
    stats?: { opened: number };
  },
): Promise<boolean> {
  const remember = opts?.remember ?? true;
  if (wraps.length === 0) return true;
  const needsApproval = signerNeedsApproval(ctx.method);
  if (!interactive && needsApproval && getDecryptConsent() !== "allowed") {
    lastSyncDeclined.set(ctx.self, true);
    return false;
  }
  const targets = wraps.map((w) => ({ counterparty: w.pubkey, ciphertext: w.content }));
  if (!(await mayBulkDecrypt(ctx.signer, "nip44", targets, needsApproval))) {
    lastSyncDeclined.set(ctx.self, true);
    return false;
  }
  lastSyncDeclined.set(ctx.self, false);

  const seen = seenSetFor(ctx.self);
  const opened: OpenedDm[] = [];
  const peerSignals: OpenedDm[] = [];
  const openedWrapIds: string[] = [];

  // Bounded waves: each wrap costs two synchronous NIP-44 opens, so one big batch blocks
  // the main thread; setTimeout(0) between waves yields.
  for (let i = 0; i < wraps.length; i += DECRYPT_WAVE) {
    await Promise.all(
      wraps.slice(i, i + DECRYPT_WAVE).map(async (wrap) => {
        const dm = await openDmWrap(wrap, ctx.signer as Dm17Signer, ctx.self, remember ? undefined : { cache: false });
        if (remember) seen.add(wrap.id);
        if (!dm) return;
        openedWrapIds.push(wrap.id);
        if (opts?.stats) opts.stats.opened++;
        // Peer signals are live routing, not history: dispatched, not stored.
        if (dm.kind === KIND_DM_PEER_SIGNAL) {
          peerSignals.push(dm);
          return;
        }
        // Foreign rumor kinds (e.g. Concord invites, kind 3313) are handled by their own paths.
        if (DM_RUMOR_KINDS.includes(dm.kind)) opened.push(dm);
      }),
    );
    if (i + DECRYPT_WAVE < wraps.length) await new Promise((r) => setTimeout(r, 0));
    if (opts?.signal?.aborted) return false;
  }

  // Logout's purge halts sync first: nothing decrypted may land after it.
  if (opts?.signal?.aborted || syncHalted()) return false;
  await writeDm17Rumors(ctx.self, opened);
  feedNotifyCandidates(dm17NotifyCandidates(opened, ctx.self));
  noteWrapsOpened(openedWrapIds);
  if (remember) persistSeenWraps(ctx.self);
  for (const signal of peerSignals) dispatchDmPeerSignal(signal);

  return true;
}

let liveDm17Pass: Promise<"consumed" | "empty" | "deferred"> | undefined;

/**
 * Decrypt wraps the wire already buffered from its live sub — no relay round trip.
 * "empty" (nothing buffered) is the only result that should trigger a forced fetch;
 * "deferred" re-buffers for a later retry. Concurrent callers coalesce because the drain
 * is destructive. Interactive surfaces only.
 */
export async function openLiveDm17Wraps(
  ctx: SyncCtx,
  opts?: { interactive?: boolean },
): Promise<"consumed" | "empty" | "deferred"> {
  const prior = liveDm17Pass;
  if (prior) {
    const result = await prior;
    // Drain again if wraps arrived meanwhile; never loop on "deferred" (would spin on consent).
    if (result === "deferred" || !hasBufferedLiveDmWraps()) return result;
    return openLiveDm17Wraps(ctx, opts);
  }
  const pass = runLiveDm17Pass(ctx, opts);
  liveDm17Pass = pass;
  try {
    return await pass;
  } finally {
    liveDm17Pass = undefined;
  }
}

async function runLiveDm17Pass(
  ctx: SyncCtx,
  opts?: { interactive?: boolean },
): Promise<"consumed" | "empty" | "deferred"> {
  if (!ctx.self || !ctx.signer.nip44) return "empty";
  const wraps = drainLiveDmWraps();
  if (wraps.length === 0) return "empty";
  await loadSeenWraps(ctx.self);
  const seen = seenSetFor(ctx.self);
  const fresh = wraps.filter((w) => !seen.has(w.id));
  // Already decrypted elsewhere — handled, not "empty".
  if (fresh.length === 0) return "consumed";
  // On decline, re-buffer so the next interactive pass / poll retries.
  if (!(await openAndStore(ctx, fresh, opts?.interactive ?? false))) {
    rebufferLiveDmWraps(fresh);
    return "deferred";
  }
  // No cursor write: the live buffer carries no relay attribution.
  return "consumed";
}

/** Top up the gift-wrap inbox. A consent decline leaves the cursor unadvanced. */
export async function syncDm17Inbox(ctx: SyncCtx, opts?: SyncOpts): Promise<boolean> {
  if (!ctx.self || !ctx.signer.nip44 || ctx.relays.length === 0) return false;
  // Without consent a background pass would download a full page per relay and then
  // decline at the decrypt gate; don't fetch at all.
  if (!opts?.interactive && signerNeedsApproval(ctx.method) && getDecryptConsent() !== "allowed") {
    lastSyncDeclined.set(ctx.self, true);
    return false;
  }
  // Concurrent callers coalesce onto ONE pass so a first sync never resolves against
  // a half-filled store.
  const inflight = inflightSync.get(ctx.self);
  if (inflight) {
    const result = await inflight.pass;
    // A full recovery must not hide behind an in-flight narrow poll.
    if (opts?.full && !inflight.full) {
      // Await continuations may resume in either order; clear only the pass we awaited.
      if (inflightSync.get(ctx.self) === inflight) inflightSync.delete(ctx.self);
      return syncDm17Inbox(ctx, { ...opts, force: true });
    }
    return result;
  }
  const now = Date.now();
  const last = lastSyncAt.get(ctx.self) ?? 0;
  // Bypass the throttle for a deferred pass only once decrypting can succeed now.
  const retryDeclined =
    (lastSyncDeclined.get(ctx.self) ?? false) &&
    (opts?.interactive || getDecryptConsent() === "allowed" || !signerNeedsApproval(ctx.method));
  if (!opts?.force && !retryDeclined && now - last < SYNC_MIN_INTERVAL_MS) return false;
  lastSyncAt.set(ctx.self, now);

  let pageStored!: () => void;
  const firstPage = new Promise<void>((resolve) => (pageStored = resolve));
  const pass = runInboxSync(ctx, {
    ...opts,
    onPageStored: () => {
      pageStored();
      opts?.onPageStored?.();
    },
  }, now);
  void pass.finally(() => pageStored()).catch(() => undefined);
  inflightSync.set(ctx.self, { pass, full: opts?.full ?? false, firstPage });
  try {
    return await pass;
  } finally {
    if (inflightSync.get(ctx.self)?.pass === pass) inflightSync.delete(ctx.self);
  }
}

export interface Dm17RelayPage {
  url: string;
  events: NostrEvent[];
}

export interface Dm17RelayQueryResult {
  /** Relays that reached EOSE, including empty results. */
  pages: Dm17RelayPage[];
  /** Failed/timed-out relays. Their cursor must remain untouched. */
  failed: string[];
}

/**
 * Per-relay query results. Not `group(relays).query`: NPool aborts the fan-out 300ms
 * after the first EOSE, cutting off auth-gated relays mid NIP-42 handshake. `NRelay1.query`
 * retries after AUTH, bounded only by `signal`.
 */
export async function queryWrapsPerRelay(
  nostr: NostrPool,
  relays: string[],
  filter: NostrFilter | ((url: string) => NostrFilter),
  signal: AbortSignal,
): Promise<Dm17RelayQueryResult> {
  const settled = await Promise.allSettled(
    relays.map(async (url): Promise<Dm17RelayPage> => ({
      url,
      events: await nostr.relay(url).query(
        [typeof filter === "function" ? filter(url) : filter],
        { signal },
      ),
    })),
  );
  const pages: Dm17RelayPage[] = [];
  const failed: string[] = [];
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") pages.push(result.value);
    else failed.push(relays[i]);
  }
  return { pages, failed };
}

function mergeRelayPages(pages: Dm17RelayPage[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const { events } of pages) {
    for (const event of events) byId.set(event.id, event);
  }
  return [...byId.values()];
}

/**
 * A page at least this long may have been cut short by the relay. Below
 * `INBOX_PAGE` because relays cap `limit` on their own (100 is common), and a
 * capped page reads like a short one.
 */
const CAPPED_PAGE_FLOOR = 100;
/** Pages a scan follows one relay's burst down before leaving it to the next scan. */
const FORWARD_MAX_PAGES = 10;

/**
 * Page a since-bounded relay answer down to its `since` while pages keep coming
 * back full, so a burst wider than one page isn't skipped by the watermark.
 * `complete` is false if the floor wasn't reached.
 */
export async function pageForwardRest(
  nostr: Pick<NostrPool, "relay">,
  relay: string,
  filter: NostrFilter,
  first: NostrEvent[],
): Promise<{ events: NostrEvent[]; complete: boolean }> {
  const events = [...first];
  let page = first;
  for (let n = 1; page.length >= CAPPED_PAGE_FLOOR; n++) {
    if (n >= FORWARD_MAX_PAGES) return { events, complete: false };
    const until = Math.min(...page.map((event) => event.created_at)) - 1;
    if (filter.since !== undefined && until < filter.since) break;
    try {
      page = await nostr.relay(relay).query([{ ...filter, until }], { signal: AbortSignal.timeout(8000) });
    } catch {
      return { events, complete: false };
    }
    events.push(...page);
  }
  return { events, complete: true };
}

/**
 * Per-relay watermark: a scan completed at S proves later wraps have
 * `created_at ≥ S − MAX_WRAP_BACKDATE_SECS`, raised to the newest wrap returned.
 * Only kind 1059 may raise it — a non-backdated event would push it past in-flight
 * wraps and silently lose DMs.
 */
export function relayScanWatermarks(pages: Dm17RelayPage[], nowSecs: number): Record<string, number> {
  const floor = nowSecs - MAX_WRAP_BACKDATE_SECS;
  const out: Record<string, number> = {};
  for (const page of pages) {
    const backdated = page.events.filter((event) => event.kind === KIND_DM_WRAP);
    out[page.url] = Math.max(floor, ...backdated.map((event) => event.created_at));
  }
  return out;
}

/**
 * One relay's top-up filter. Gift wraps only: peer signals ride inside them, and a bare
 * kind-30078 would be unauthenticated and not backdated.
 */
export function dm17InboxFilter(
  self: string,
  cursor: Dm17Cursor | undefined,
  relay: string,
  full: boolean,
): NostrFilter {
  const newest = cursor?.relayNewest?.[relay];
  const filter: NostrFilter = { kinds: [KIND_DM_WRAP], "#p": [self], limit: INBOX_PAGE };
  if (newest !== undefined) {
    const slack = full ? RESYNC_SLACK_SECS : NARROW_RESYNC_SLACK_SECS;
    filter.since = Math.max(0, newest - slack);
  }
  return filter;
}

/** Whether the background service has received everything `relay` got since `since` (ms). */
export function serviceCovered(coverage: ReadonlyMap<string, number>, relay: string, since: number): boolean {
  const from = coverage.get(normalizeRelayUrl(relay) ?? relay);
  return from !== undefined && since > 0 && from <= since;
}

/** True only when the query completed and its wraps were consumed. */
async function runInboxSync(
  ctx: SyncCtx,
  opts: SyncOpts | undefined,
  now: number,
): Promise<boolean> {
  try {
    const [cursor, , covered] = await Promise.all([readDm17Cursor(ctx.self), loadSeenWraps(ctx.self), nativeDmCoverage()]);
    // Full-window cadence is PER RELAY, so a failed relay never inherits another's progress.
    const lastFullOf = (relay: string) =>
      Math.max(lastFullScanAt.get(`${ctx.self}\u0000${relay}`) ?? 0, cursor?.relayFullScanAt?.[relay] ?? 0);
    // Android: a relay the service has held live since our last full read of it
    // is not asked at all — everything published there since is already stored
    // (or in the drain).
    const scan = ctx.relays.filter((relay) =>
      cursor?.relayNewest?.[relay] === undefined || !serviceCovered(covered, relay, lastFullOf(relay)));
    if (scan.length === 0) return true;
    // A relay the service covers only since AFTER our last full read gets one
    // full read now to close that gap, and is skipped from then on.
    const fullRelays = new Set(
      scan.filter((relay) =>
        cursor?.relayNewest?.[relay] === undefined || opts?.full || covered.has(normalizeRelayUrl(relay) ?? relay)
          || now - lastFullOf(relay) >= FULL_SCAN_INTERVAL_MS),
    );
    const filterFor = (relay: string) => dm17InboxFilter(ctx.self, cursor, relay, fullRelays.has(relay));
    const seen = seenSetFor(ctx.self);
    // Each relay's new wraps are opened and stored as that relay answers: a message shouldn't
    // wait on the slowest relay. Claimed here, so a wrap two relays hold opens once.
    const claimed = new Set<string>();
    const stores: Promise<boolean>[] = [];
    const storeNow = (events: NostrEvent[]) => {
      const mine = events.filter((w) => !seen.has(w.id) && !claimed.has(w.id));
      for (const w of mine) claimed.add(w.id);
      if (mine.length === 0) return;
      const stored = openAndStore(ctx, mine, opts?.interactive ?? false);
      stores.push(stored);
      void stored.then((ok) => {
        if (ok) opts?.onPageStored?.();
      });
    };
    const signal = AbortSignal.timeout(8000);
    // A since-bounded page that came back full is the top of a burst, not all of it.
    const unfinished = new Set<string>();
    const result: Dm17RelayQueryResult = { pages: [], failed: [] };
    await Promise.all(scan.map(async (url) => {
      const first = await queryWrapsPerRelay(ctx.nostr, [url], filterFor, signal);
      const page = first.pages[0];
      if (!page) {
        result.failed.push(url);
        return;
      }
      const filter = filterFor(url);
      let events = page.events;
      if (filter.since !== undefined) {
        const rest = await pageForwardRest(ctx.nostr, url, filter, page.events);
        if (!rest.complete) unfinished.add(url);
        events = rest.events;
      }
      result.pages.push({ url, events });
      storeNow(events);
    }));
    if (result.pages.length === 0) {
      logSync("dm", `inbox scan failed on all ${scan.length} relay(s)`);
      return false;
    }
    if (result.failed.length > 0) {
      logSync("dm", `inbox scan reached ${result.pages.length}/${scan.length} relay(s); ${result.failed.length} remain retryable`);
    }

    const wraps = mergeRelayPages(result.pages);
    // Any relay's wraps deferred (no consent yet): retry the whole pass later.
    if (!(await Promise.all(stores)).every(Boolean)) return false;
    if (syncHalted()) return false;
    // Only successful, consumed pages advance their watermark; failed relays stay full-scan
    // candidates.
    const nowSecs = Math.floor(now / 1000);
    // A relay whose burst wasn't read to its floor keeps its watermark, so the next scan retries it.
    const finished = result.pages.filter((page) => !unfinished.has(page.url));
    const relayNewest = relayScanWatermarks(finished, nowSecs);
    const relayFullScanAt: Record<string, number> = {};
    for (const page of finished) {
      if (fullRelays.has(page.url)) {
        lastFullScanAt.set(`${ctx.self}\u0000${page.url}`, now);
        relayFullScanAt[page.url] = now;
      }
    }
    if (wraps.length > 0) {
      const newest = Math.max(...wraps.map((w) => w.created_at));
      const oldest = Math.min(...wraps.map((w) => w.created_at));
      await updateDm17Cursor(ctx.self, {
        newest,
        relayNewest,
        relayFullScanAt,
        // First full scan seeds the backfill floor; a short page means nothing deeper.
        ...(cursor ? {} : {
          oldest,
          exhausted: result.failed.length === 0 && result.pages.every((page) => page.events.length < INBOX_PAGE),
        }),
      }, { pruneRelaysTo: ctx.relays });
    } else {
      await updateDm17Cursor(ctx.self, {
        relayNewest,
        relayFullScanAt,
        ...(cursor ? {} : {
          newest: nowSecs,
          oldest: nowSecs,
          exhausted: result.failed.length === 0,
        }),
      }, { pruneRelaysTo: ctx.relays });
    }
    return true;
  } catch {
    // Best-effort; local-first reads already rendered.
    return false;
  }
}

/**
 * Page the global `#p` gift-wrap stream older than `until` (wrap authors are ephemeral,
 * so there's no per-peer filter). `exhausted` is inferred from a short page and may be a
 * relay capping `limit`, so callers must be able to un-latch it.
 */
async function pageOlderDmWraps(
  ctx: SyncCtx,
  until: number,
  interactive: boolean,
): Promise<{ oldest?: number; exhausted: boolean; scanned: number }> {
  const result = await queryWrapsPerRelay(
    ctx.nostr,
    ctx.relays,
    { kinds: [KIND_DM_WRAP], "#p": [ctx.self], until, limit: INBOX_PAGE },
    AbortSignal.timeout(8000),
  );
  // No successful relay: throw so callers keep `hasMore` open and retry the range.
  if (result.pages.length === 0) throw new Error("DM backfill failed on every relay");
  const wraps = mergeRelayPages(result.pages);
  // Every relay that answered is out: a dead or AUTH-walled one must not keep
  // the view paging forever (the latch resets per conversation).
  if (wraps.length === 0) {
    return { exhausted: true, scanned: 0 };
  }
  const oldest = Math.min(...wraps.map((w) => w.created_at)) - 1;
  await loadSeenWraps(ctx.self);
  const seen = seenSetFor(ctx.self);
  await openAndStore(
    ctx,
    wraps.filter((w) => !seen.has(w.id)),
    interactive,
  );
  await updateDm17Cursor(ctx.self, { oldest });
  return {
    oldest,
    exhausted: result.failed.length === 0 && result.pages.every((page) => page.events.length < INBOX_PAGE),
    scanned: wraps.length,
  };
}

/** Pages one history round reads per relay; the topic re-queues itself until every relay is walked. */
const HISTORY_PAGES_PER_RELAY = 2;
/** Wraps the history walk opened, so another relay's copy isn't opened again. */
const walkedWrapIds = new Set<string>();
const WALKED_WRAP_CAP = 20_000;
/** A remote signer's page: each wrap is two decrypt requests to the bunker or extension. */
const REMOTE_HISTORY_PAGE = 50;
/** Pause between a remote signer's rounds, so the walk never monopolizes the signer. */
const REMOTE_HISTORY_PAUSE_MS = 30_000;
const historyPauses = new Map<string, ReturnType<typeof setTimeout>>();

export interface Dm17HistoryOutcome {
  /** Some relay still has history below its `relayOldest`. */
  more: boolean;
  /** The round read at least one page into the store. */
  progressed: boolean;
  /** A relay errored or the decrypt gate declined. */
  failed: boolean;
  /** More fetched wraps failed to open than opened: not worth an immediate requeue. */
  mostlyUnopened: boolean;
}

/**
 * One round of the background history walk: each relay's `#p` stream is paged
 * down from its own `relayOldest` until a page comes back EMPTY. Not until a
 * short one: relays cap `limit` on their own, so a short page proves nothing.
 * Relays go one after another so a wrap every relay holds is opened once.
 */
export async function walkDm17History(ctx: SyncCtx, signal: AbortSignal): Promise<Dm17HistoryOutcome> {
  const idle: Dm17HistoryOutcome = { more: false, progressed: false, failed: false, mostlyUnopened: false };
  if (!ctx.signer.nip44 || ctx.relays.length === 0) return idle;
  // Background work never prompts.
  if (signerNeedsApproval(ctx.method) && getDecryptConsent() !== "allowed") return idle;
  await loadSeenWraps(ctx.self);
  const cursor = await readDm17Cursor(ctx.self);
  const pending = ctx.relays.filter((relay) => !cursor?.relayExhaustedAt?.[relay] && !isRelayUnreachable(relay));
  if (pending.length === 0) return idle;

  const relayOldest: Record<string, number> = {};
  const relayExhaustedAt: Record<string, number> = {};
  let progressed = false;
  let failed = false;
  let declined = false;
  let opened = 0;
  let unopened = 0;
  // A remote signer answers each decrypt over a relay round trip: small pages.
  const limit = signerNeedsApproval(ctx.method) ? REMOTE_HISTORY_PAGE : INBOX_PAGE;
  const walkRelay = async (relay: string) => {
    let until = cursor?.relayOldest?.[relay];
    for (let n = 0; n < HISTORY_PAGES_PER_RELAY && !signal.aborted; n++) {
      const filter: NostrFilter = { kinds: [KIND_DM_WRAP], "#p": [ctx.self], limit };
      if (until !== undefined) filter.until = until;
      let page: NostrEvent[];
      try {
        page = await ctx.nostr.relay(relay).query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      } catch {
        failed = true;
        return;
      }
      if (signal.aborted) return;
      if (page.length === 0) {
        relayExhaustedAt[relay] = Date.now();
        progressed = true;
        return;
      }
      const seen = seenSetFor(ctx.self);
      const fresh = page.filter((wrap) => !seen.has(wrap.id) && !walkedWrapIds.has(wrap.id));
      // Kept out of the persisted memo, whose eviction would otherwise push out the
      // recent wraps the forward scans rely on it for.
      const stats = { opened: 0 };
      const stored = await openAndStore(ctx, fresh, false, { remember: false, signal, stats });
      if (signal.aborted) return;
      if (!stored) {
        declined = true;
        return;
      }
      if (walkedWrapIds.size + fresh.length > WALKED_WRAP_CAP) walkedWrapIds.clear();
      for (const wrap of fresh) walkedWrapIds.add(wrap.id);
      progressed = true;
      // Wrap signatures are never checked, so a relay can mint pages of junk forever.
      unopened += fresh.length - stats.opened;
      opened += stats.opened;
      until = Math.min(...page.map((wrap) => wrap.created_at)) - 1;
      if (until <= 0) {
        relayExhaustedAt[relay] = Date.now();
        return;
      }
      relayOldest[relay] = until;
    }
  };
  for (const relay of pending) {
    await walkRelay(relay);
    if (declined || signal.aborted) break;
  }
  // The cursor only covers pages already stored, so an ordinary abort keeps it; a
  // halted scheduler means logout's purge has begun.
  if (progressed && !syncHalted()) {
    await updateDm17Cursor(ctx.self, { relayOldest, relayExhaustedAt }, { pruneRelaysTo: ctx.relays });
  }
  const after = await readDm17Cursor(ctx.self);
  return {
    more: ctx.relays.some((relay) => !after?.relayExhaustedAt?.[relay] && !isRelayUnreachable(relay)),
    progressed,
    failed: failed || declined,
    mostlyUnopened: unopened > opened,
  };
}

const historyCtxs = new Map<string, SyncCtx>();

registerSyncTopic("dm17hist:", {
  minIntervalMs: 5_000,
  staleAfterMs: 60 * 60_000,
  handler: async ({ topic, signal }) => {
    const ctx = historyCtxs.get(topic.slice("dm17hist:".length));
    if (!ctx) throw new Error(`no DM history context for ${topic}`);
    const outcome = await walkDm17History(ctx, signal);
    if (signal.aborted) return;
    // A failure that got nowhere backs off through the scheduler rather than spinning.
    if (outcome.failed && !outcome.progressed) throw new Error("DM history walk made no progress");
    // A round that mostly fetched what wouldn't open waits for the stale pass.
    if (!outcome.more || !outcome.progressed || outcome.mostlyUnopened) return;
    if (!signerNeedsApproval(ctx.method)) {
      invalidateSyncTopic(topic);
      return;
    }
    clearTimeout(historyPauses.get(topic));
    historyPauses.set(topic, setTimeout(() => {
      historyPauses.delete(topic);
      invalidateSyncTopic(topic);
    }, REMOTE_HISTORY_PAUSE_MS));
  },
});

/**
 * Walk the whole NIP-17 inbox in the background, so local search covers history
 * older than the forward scans ever reached. Only where decrypting is silent:
 * a local key, or bulk-decrypt consent already given. Mounted once by DmSyncLifecycle.
 */
export function useDm17HistoryWalk(): void {
  const ctx = useDm17SyncCtx();
  const { consent } = useDecryptConsent();
  useEffect(() => {
    if (!ctx || ctx.relays.length === 0) return;
    if (signerNeedsApproval(ctx.method) && consent !== "allowed") return;
    historyCtxs.set(ctx.self, ctx);
    const release = want(`dm17hist:${ctx.self}`, "prefetch");
    return () => {
      release();
      if (historyCtxs.get(ctx.self) === ctx) historyCtxs.delete(ctx.self);
    };
  }, [ctx, consent]);
}

/**
 * Whether the history walk still has relays to read, so search can say its
 * answer may be partial. False where the walk doesn't run (decrypting would prompt).
 */
export function useDm17HistoryIncomplete(enabled = true): boolean {
  const ctx = useDm17SyncCtx();
  const { consent } = useDecryptConsent();
  const walks = !!ctx && ctx.relays.length > 0 && (!signerNeedsApproval(ctx.method) || consent === "allowed");
  const query = useQuery<boolean>({
    queryKey: ["dm17", "history-incomplete", ctx?.self, ctx?.relays.join(",")],
    enabled: enabled && walks,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const cursor = await readDm17Cursor(ctx!.self);
      return ctx!.relays.some((relay) => !cursor?.relayExhaustedAt?.[relay] && !isRelayUnreachable(relay));
    },
  });
  return enabled && walks && (query.data ?? false);
}

function useDm17SyncCtx(): SyncCtx | undefined {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  // Union effective DM relays with our published 10050 inbox: senders deliver to the
  // latter even when "use my own DM relays" is off.
  const { relays: publishedRelays } = useDmRelayList();
  // Normalized so one relay can't dial twice or fork its watermark. `dmsDisabled`
  // collapses this to empty (no DM sub, no wrap fetches).
  const relays = useMemo(
    () =>
      config.dmsDisabled
        ? []
        : [...new Set(
            [...effectiveDmRelays(config), ...publishedRelays]
              .map((url) => normalizeRelayUrl(url))
              .filter((url): url is string => url !== undefined),
          )],
    [config, publishedRelays],
  );
  const relayKey = relays.join(",");
  return useMemo(() => {
    if (!user?.pubkey || !user.signer.nip44) return undefined;
    return { nostr, signer: user.signer, self: user.pubkey, method: user.method, relays };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user, relayKey]);
}

/**
 * Recover the DM inbox (full backdate window) when a suspended client resumes or
 * reconnects; the standing socket may be dead. Mounted once by DmSyncLifecycle.
 * Uses useResumeEpoch/focusManager and onlineManager rather than separate listeners.
 */
export function useDm17ForegroundSync(): void {
  const ctx = useDm17SyncCtx();
  const epoch = useResumeEpoch(RESUME_MIN_AWAY_MS);

  useEffect(() => {
    if (!ctx) return;

    const recover = () => {
      const now = Date.now();
      if (now - (lastForegroundSyncAt.get(ctx.self) ?? 0) < FOREGROUND_SYNC_MIN_MS) return;
      lastForegroundSyncAt.set(ctx.self, now);
      void syncDm17Inbox(ctx, { force: true, full: true, interactive: false });
    };

    if (epoch > 0) recover();
    return onlineManager.subscribe((online) => {
      if (online) recover();
    });
  }, [ctx, epoch]);
}

interface PendingRumor {
  opened: OpenedDm;
  /** `undefined` = confirmed but not yet repainted from the store (see the prune effect). */
  status: SendStatus | undefined;
  /** Retried/discarded as one unit (an edit is replacement + kind-5 tombstone). */
  batch?: PendingPublish[];
}

interface PendingPublish {
  rumor: NostrRumor;
  opened: OpenedDm;
  opts?: { firstContact?: boolean };
}

export interface Dm17Thread {
  /** Chat/file rumors, deletes applied, ascending. */
  messages: OpenedDm[];
  reactionsByTarget: Map<string, OpenedDm[]>;
  /** Timer changes inside the loaded window, ascending; one notice row per change. */
  timerChanges: OpenedDm[];
  /** Disappearing-messages timer in seconds; 0/undefined = off. Either side may set it. */
  timer: number | undefined;
  /** The timer for something sent now: waits for the stored one rather than taking undefined as off. */
  resolveTimer: () => Promise<number>;
  /** Both sides' messages then carry `sent_at + seconds` as their NIP-40 expiration. */
  setTimer: (seconds: number) => void;
  isLoading: boolean;
  /**
   * Whether NIP-17's first local paint has resolved (snapshot prewarm settled). The merged
   * timeline holds its skeleton until then so the kind-4 half doesn't paint a frame ahead.
   */
  firstPaintReady: boolean;
  /**
   * Signer does NIP-44 and there's a publish target (peer's 10050, else our relays).
   * When false, callers use kind-4.
   */
  canSend: boolean;
  send: (content: string, extraTags?: string[][]) => Promise<void>;
  /**
   * Publish one Mini App state update (kind 3310) scoped to `uuid`. Metadata is passed as
   * fields so the tags are built correctly here.
   */
  sendWebxdc: (uuid: string, payload: string, meta?: DmWebxdcMeta) => Promise<void>;
  react: (targetId: string, targetKind: number, content: string, emojiUrl?: string) => void;
  removeReaction: (reactionRumorId: string) => void;
  deleteMessage: (targetId: string, targetKind: number) => void;
  /** Edit an own kind-14 using NIP-17's replacement + delete pair. */
  editMessage: (targetId: string, content: string) => Promise<void>;
  sendStatusFor: (id: string) => SendStatus | undefined;
  retry: (id: string) => void;
  discard: (id: string) => void;
  loadOlder: () => Promise<number>;
  hasMore: boolean;
  isLoadingOlder: boolean;
}

/**
 * The decrypted NIP-17 thread for a conversation key (`dmConvKey`: one pubkey, or several
 * comma-joined for a group). `focusedRumorId` is admitted even beyond the window without
 * moving the history cursor.
 */
export function useDm17Thread(
  conversation: string | undefined,
  focusedRumorId?: string,
): Dm17Thread {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const { consent } = useDecryptConsent();
  const support = useDm17Support();
  const eventStore = useEventStore();

  const self = user?.pubkey;
  const peers = useMemo(
    () => (conversation ? dmConvPeers(conversation) : []),
    [conversation],
  );
  // Participants minus us; empty for Note to Self.
  const recipients = useMemo(
    () => peers.filter((peer) => peer !== self),
    [peers, self],
  );
  const inboxRelays = useDmRelaysForAll(recipients);
  // Same relay union the inbox sync uses.
  const myRelays = ctx?.relays ?? effectiveDmRelays(config);

  // Fall back to our own relays when no recipient has a 10050 inbox. A routing fact, not a
  // readiness signal: older clients never published 10050.
  const hasPeerInbox = recipients.some((peer) => (inboxRelays.get(peer)?.length ?? 0) > 0);
  const canSend = support && peers.length > 0 && (hasPeerInbox || myRelays.length > 0);

  const [pending, setPending] = useState<Map<string, PendingRumor>>(new Map());
  useEffect(() => setPending(new Map()), [self, conversation]);

  const queryKey = useMemo(
    () => ["dm17", "thread", self, conversation, consent] as const,
    [self, conversation, consent],
  );

  // The store window only grows as backfill pages land, so refetches don't discard paged
  // history.
  const threadWindowRef = useRef<{
    self: string | undefined;
    conversation: string | undefined;
    limit: number;
  }>({ self, conversation, limit: THREAD_WINDOW });
  if (
    threadWindowRef.current.self !== self ||
    threadWindowRef.current.conversation !== conversation
  ) {
    threadWindowRef.current = { self, conversation, limit: THREAD_WINDOW };
  }

  // Single source for whether NIP-17 can contribute rows (skeleton gate + query).
  const queryEnabled = !!self && peers.length > 0 && support;
  // Which key's snapshot prewarm has settled. Derived at render time: a flag set from an
  // effect lags one render and lets the kind-4 half paint alone.
  const prewarmKey = useMemo(() => JSON.stringify(queryKey), [queryKey]);
  const [prewarmSettledKey, setPrewarmSettledKey] = useState<string | null>(null);

  // Paint the last window from a KV snapshot while the slower store read runs.
  useEffect(() => {
    if (!queryEnabled) return;
    let cancelled = false;
    void prewarmDm17ThreadSnapshot(queryClient, self!, conversation!, queryKey).finally(() => {
      if (!cancelled) setPrewarmSettledKey(prewarmKey);
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient, self, conversation, queryEnabled, queryKey, prewarmKey]);

  const firstPaintReady = !queryEnabled || prewarmSettledKey === prewarmKey;

  const query = useQuery<OpenedDm[]>({
    queryKey,
    // Keyed: older pages shift every index (see shareRows).
    structuralSharing: shareByRumorId,
    // Store read: no retry ladder holding the skeleton over on-disk rumors. See storeQuery.
    ...STORE_READ,
    enabled: queryEnabled,
    queryFn: async ({ signal }) => {
      // LOCAL-FIRST: the inbox scan tops up in the background.
      const window = threadWindowRef.current;
      const before = queryClient.getQueryData<OpenedDm[]>(queryKey) ?? [];
      let rows = await queryDm17Thread(self!, peers, {
        limit: window.limit,
        signal,
      });
      // A full window would evict its oldest row per new live rumor; grow and re-read instead.
      if (before.length >= window.limit) {
        const beforeIds = new Set(before.map((row) => row.rumorId));
        const incoming = rows.reduce(
          (count, row) => count + (beforeIds.has(row.rumorId) ? 0 : 1),
          0,
        );
        if (incoming > 0) {
          window.limit += incoming;
          rows = await queryDm17Thread(self!, peers, { limit: window.limit, signal });
        }
      }
      if (ctx) void syncDm17Inbox(ctx, { interactive: true });
      sweepExpiredSoon(self!);
      return rows.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    },
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // Focused row is merged only into the render fold, so refetches can't drop it and it
  // can't drag the history cursor past the gap.
  const focusedQuery = useQuery<OpenedDm | undefined>({
    queryKey: ["dm17", "thread-focus", self, conversation, focusedRumorId ?? null],
    ...STORE_READ,
    enabled: !!self && peers.length > 0 && !!focusedRumorId && support,
    queryFn: ({ signal }) => queryDm17Rumor(self!, peers, focusedRumorId!, { signal }),
    staleTime: 10_000,
  });

  // Read separately so a timer set beyond the thread window still applies.
  const timerQueryKey = useMemo(
    () => ["dm17", "timer", self, conversation] as const,
    [self, conversation],
  );
  const timerQuery = useQuery<number>({
    queryKey: timerQueryKey,
    enabled: !!self && peers.length > 0 && support,
    queryFn: async ({ signal }) => (await queryDm17Timer(self!, peers, { signal })) ?? 0,
    staleTime: 10_000,
  });
  const timer = timerQuery.data;

  // `dm:wrap` — decrypt buffered live wraps directly (no refetch / NIP-42 re-auth); an
  // empty buffer falls back to a forced fetch.
  // `dm-thread:<peer>` — a durable write changed this conversation; re-read only (decrypting
  // would loop on the write's own ring).
  useWireScopes((scopes) => {
    if (!self || !conversation) return;
    if (ctx && scopes.has("dm:wrap")) {
      void openLiveDm17Wraps(ctx, { interactive: true }).then((result) => {
        if (result === "empty") void syncDm17Inbox(ctx, { force: true, interactive: true });
      });
    }
    // The durable write rings this scope; don't also re-read on `dm:wrap`.
    if (scopes.has(dmThreadScope(conversation))) {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: timerQueryKey });
    }
  });

  // Re-fold exactly when a disappearing message's deadline passes.
  const [expiryTick, setExpiryTick] = useState(0);

  // Store + optimistic rows deduped by id, deletes applied, expired dropped.
  const { messages, reactionsByTarget, timerChanges, nextExpiry } = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const byId = new Map<string, OpenedDm>();
    for (const r of query.data ?? []) byId.set(r.rumorId, r);
    if (focusedQuery.data) byId.set(focusedQuery.data.rumorId, focusedQuery.data);
    for (const p of pending.values()) if (!byId.has(p.opened.rumorId)) byId.set(p.opened.rumorId, p.opened);

    const deleted = new Set<string>();
    for (const r of byId.values()) {
      if (r.kind !== KIND_DM_DELETE) continue;
      for (const [name, value] of r.tags) {
        if (name !== "e" || !value) continue;
        const target = byId.get(value);
        if (!target || target.author === r.author) deleted.add(value);
      }
    }

    const messages: OpenedDm[] = [];
    const reactionsByTarget = new Map<string, OpenedDm[]>();
    const timerChanges: OpenedDm[] = [];
    let nextExpiry: number | undefined;
    for (const r of byId.values()) {
      if (deleted.has(r.rumorId)) continue;
      // Client-side enforcement: an expired rumor is never rendered.
      if (isExpired(r.tags, now)) continue;
      const at = expirationOf(r.tags);
      if (at !== undefined && (nextExpiry === undefined || at < nextExpiry)) nextExpiry = at;
      if (r.kind === KIND_DM_CHAT || r.kind === KIND_DM_FILE) {
        messages.push(r);
      } else if (r.kind === KIND_DM_WEBXDC) {
        // Kind 3310 webxdc updates are read by useDmAppSync, not shown in chat.
      } else if (r.kind === KIND_DM_REACTION) {
        const target = r.tags.find(([n, v]) => n === "e" && v)?.[1];
        if (!target) continue;
        const list = reactionsByTarget.get(target) ?? [];
        list.push(r);
        reactionsByTarget.set(target, list);
      } else if (r.kind === KIND_DM_TIMER) {
        timerChanges.push(r);
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    timerChanges.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    return { messages, reactionsByTarget, timerChanges, nextExpiry };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, focusedQuery.data, pending, expiryTick]);

  // setTimeout clamps at ~24.8 days; longer deadlines re-arm on the next fold.
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const delay = Math.min(nextExpiry * 1000 - Date.now(), 2 ** 31 - 1);
    const id = setTimeout(() => {
      if (self) sweepExpiredSoon(self);
      setExpiryTick((t) => t + 1);
    }, Math.max(0, delay));
    return () => clearTimeout(id);
  }, [nextExpiry, self]);

  const setStatus = useCallback((id: string, status: SendStatus | undefined) => {
    setPending((old) => {
      const entry = old.get(id);
      if (!entry) return old;
      const next = new Map(old);
      next.set(id, { ...entry, status });
      return next;
    });
  }, []);

  const dropPending = useCallback((id: string) => {
    setPending((old) => {
      const entry = old.get(id);
      if (!entry) return old;
      const next = new Map(old);
      for (const item of entry.batch ?? []) next.delete(item.rumor.id);
      next.delete(id);
      return next;
    });
  }, []);

  // Retire confirmed optimistic rows only once the store query contains them; dropping at
  // publish time blinks the row until the debounced repaint.
  useEffect(() => {
    const rows = query.data;
    if (!rows || rows.length === 0) return;
    setPending((old) => {
      if (old.size === 0) return old;
      const stored = new Set(rows.map((r) => r.rumorId));
      let next: Map<string, PendingRumor> | undefined;
      for (const [id, entry] of old) {
        // A failed row is not in the store; it stays until retried or discarded.
        if (entry.status !== undefined || !stored.has(id)) continue;
        next ??= new Map(old);
        next.delete(id);
      }
      return next ?? old;
    });
  }, [query.data]);

  // Snapshot store rows only — a failed send must not come back looking confirmed.
  useEffect(() => {
    if (!self || !conversation) return;
    const rows = query.data;
    if (!rows || rows.length === 0) return;
    void persistDm17ThreadSnapshot(self, conversation, rows);
  }, [self, conversation, query.data]);

  /**
   * Seal + wrap + publish: one copy per recipient to their 10050 relays, plus a best-effort
   * self copy. Seals are SEQUENTIAL (NIP-07 rejects concurrent signEvent). All-or-nothing:
   * any failure fails the send; re-delivery dedupes on rumor id.
   */
  const publishRumor = useCallback(
    async (rumor: NostrRumor, opts?: { firstContact?: boolean }) => {
      if (!user?.signer.nip44 || !self || peers.length === 0) {
        throw new Error("NIP-17 not available");
      }
      const signer = user.signer as unknown as Dm17Signer;

      // The NIP-40 deadline is copied onto the seal and repeated on the wrap for relays.
      const expiresAt = expirationOf(rumor.tags);

      const outgoing: Array<{ wrap: NostrEvent; targets: string[] }> = [];
      for (const recipient of recipients) {
        const seal = await sealDmRumor(rumor, recipient, signer);
        const wrap = await wrapDmSeal(seal, recipient, {
          firstContact: opts?.firstContact,
          expiresAt,
        });
        // Their 10050 inbox unioned with our own DM relays, in case theirs is unreachable.
        outgoing.push({
          wrap,
          targets: [...new Set([...(inboxRelays.get(recipient) ?? []), ...myRelays])],
        });
      }
      const sealSelf = await sealDmRumor(rumor, self, signer);
      const wrapSelf = await wrapDmSeal(sealSelf, self, { expiresAt });

      // Persist our self-wrap BEFORE publishing: on Android the notification service dedupes
      // against this store, and the service worker suppresses this id for web push.
      await markOwnWebPushEvent(wrapSelf.id);
      await eventStore.then((s) => s.event(wrapSelf)).catch(() => undefined);

      // For Note to Self the self copy IS the send; otherwise it's fire-and-forget.
      const selfPublish =
        myRelays.length > 0
          ? nostr.group(myRelays).event(wrapSelf, { signal: AbortSignal.timeout(8000) })
          : Promise.resolve();
      if (recipients.length === 0) {
        await selfPublish;
        return;
      }
      void selfPublish.catch(() => {});

      await Promise.all(
        outgoing.map(({ wrap, targets }) =>
          nostr.group(targets).event(wrap, { signal: AbortSignal.timeout(8000) }),
        ),
      );
    },
    [nostr, user, self, peers, recipients, inboxRelays, myRelays, eventStore],
  );

  /**
   * Optimistically render and publish one logical operation (an edit is replacement +
   * tombstone) as a single retry unit.
   */
  const dispatchBatch = useCallback(
    (items: PendingPublish[], visibleId: string, supersededId?: string) => {
      setPending((old) => {
        const next = new Map(old);
        if (supersededId) next.delete(supersededId);
        for (const item of items) {
          next.set(item.rumor.id, {
            opened: item.opened,
            status: item.rumor.id === visibleId ? "pending" : undefined,
            batch: item.rumor.id === visibleId && items.length > 1 ? items : undefined,
          });
        }
        return next;
      });
      void (async () => {
        try {
          // Sequential: an edit must not race its own tombstone.
          for (const item of items) await publishRumor(item.rumor, item.opts);
          // Keep the optimistic row until the query reads it back (see the prune effect).
          if (self) await writeDm17Rumors(self, items.map((item) => item.opened));
          for (const item of items) setStatus(item.rumor.id, undefined);
        } catch {
          setStatus(visibleId, "failed");
        }
      })();
    },
    [publishRumor, setStatus, self],
  );

  const dispatchRumor = useCallback(
    (rumor: NostrRumor, opened: OpenedDm, opts?: { firstContact?: boolean }) => {
      dispatchBatch([{ rumor, opened, opts }], rumor.id);
    },
    [dispatchBatch],
  );

  const openedOf = useCallback(
    (rumor: NostrRumor): OpenedDm => ({
      rumorId: rumor.id,
      author: rumor.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      createdAt: rumor.created_at,
      peers,
      wrapId: "",
    }),
    [peers],
  );

  // Ref so a send reads the current value, not a stale render's.
  const timerRef = useRef<number | undefined>(undefined);
  timerRef.current = timer;

  /**
   * Never assume "off" before the query lands: a cold IndexedDB read can take seconds, and a
   * fast typist would send a permanent message into a disappearing conversation.
   */
  const resolveTimer = useCallback(async (): Promise<number> => {
    const known = timerRef.current;
    if (known !== undefined) return known;
    if (peers.length === 0 || !self) return 0;
    return (await queryDm17Timer(self, peers).catch(() => undefined)) ?? 0;
  }, [peers, self]);

  /** The NIP-40 deadline for something sent now, or undefined when off. */
  const resolveExpiry = useCallback(async (): Promise<number | undefined> => {
    const seconds = await resolveTimer();
    return seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : undefined;
  }, [resolveTimer]);

  const send = useCallback(
    async (content: string, extraTags?: string[][]) => {
      if (!canSend || !self || peers.length === 0) {
        throw new Error(t({ id: "useDm17.unreachable", defaultMessage: "This conversation isn't reachable over private DMs yet." }));
      }
      const trimmed = content.trim();
      if (!trimmed) return;
      const expiresAt = await resolveExpiry();
      const rumor = buildDmRumor({
        kind: KIND_DM_CHAT,
        content: trimmed,
        tags: dmChatTags(peers, { extraTags, expiresAt }),
        pubkey: self,
      });
      // First contact: add the outer `k` hint so a k-aware receiver can index its cold inbox.
      dispatchRumor(rumor, openedOf(rumor), { firstContact: messages.length === 0 });
    },
    [canSend, self, peers, dispatchRumor, openedOf, messages.length, resolveExpiry],
  );

  /**
   * NIP-17 edit: replace the kind-14 at its original timestamp, then tombstone the old id,
   * as one retry unit.
   */
  const editMessage = useCallback(
    async (targetId: string, content: string) => {
      if (!canSend || !self || peers.length === 0) {
        throw new Error(t({ id: "useDm17.unreachable", defaultMessage: "This conversation isn't reachable over private DMs yet." }));
      }
      const original = messages.find((message) => message.rumorId === targetId);
      if (!original || original.author !== self || original.kind !== KIND_DM_CHAT) {
        throw new Error(t({ id: "useDm17.onlyOwnEditable", defaultMessage: "Only your own NIP-17 chat messages can be edited" }));
      }
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) return;

      const source: NostrRumor = {
        id: original.rumorId,
        kind: original.kind,
        content: original.content,
        tags: original.tags,
        created_at: original.createdAt,
        pubkey: original.author,
      };
      const { replacement, deletion } = buildDmEditRumors(source, peers, trimmed);
      const items: PendingPublish[] = [replacement, deletion].map((rumor) => ({
        rumor,
        opened: openedOf(rumor),
      }));
      // Replacement first: if signing fails, the peer retains the original.
      dispatchBatch(items, replacement.id, original.rumorId);
    },
    [canSend, self, peers, messages, openedOf, dispatchBatch],
  );

  const react = useCallback(
    (targetId: string, targetKind: number, content: string, emojiUrl?: string) => {
      if (!canSend || !self || peers.length === 0) return;
      // Deferred so the reaction gets the same deadline a message sent now would.
      void (async () => {
        const expiresAt = await resolveExpiry();
        const rumor = buildDmRumor({
          kind: KIND_DM_REACTION,
          content,
          tags: dmReactionTags(
            peers,
            targetId,
            targetKind,
            customEmojiReactionTags(content, emojiUrl),
            expiresAt,
          ),
          pubkey: self,
        });
        dispatchRumor(rumor, openedOf(rumor));
      })();
    },
    [canSend, self, peers, dispatchRumor, openedOf, resolveExpiry],
  );

  /**
   * Written locally first, then published wrapped to the peer. Timer rumors carry no
   * expiration of their own — see KIND_DM_TIMER.
   */
  const setTimer = useCallback(
    (seconds: number) => {
      if (!canSend || !self || peers.length === 0) return;
      const next = Math.max(0, Math.floor(seconds));
      void (async () => {
        // Compare against the RESOLVED timer, or "Off" on a cold thread would silently no-op.
        if ((await resolveTimer()) === next) return;
        const rumor = buildDmRumor({
          kind: KIND_DM_TIMER,
          content: "",
          tags: dmTimerTags(peers, next),
          pubkey: self,
        });
        await writeDm17Rumors(self, [openedOf(rumor)]);
        await queryClient.invalidateQueries({ queryKey: timerQueryKey });
        await publishRumor(rumor).catch(() => {});
      })();
    },
    [canSend, self, peers, resolveTimer, openedOf, publishRumor, queryClient, timerQueryKey],
  );

  /**
   * Write the kind-5 locally at once (the store's NIP-09 pass removes the target), publish
   * in the background.
   */
  const sendDelete = useCallback(
    (targetId: string, targetKind: number) => {
      if (!canSend || !self || peers.length === 0) return;
      const rumor = buildDmRumor({
        kind: KIND_DM_DELETE,
        content: "",
        tags: dmDeleteTags(peers, targetId, targetKind),
        pubkey: self,
      });
      // Drop an optimistic target immediately (it may not be in the store yet).
      setPending((old) => {
        if (!old.has(targetId)) return old;
        const next = new Map(old);
        next.delete(targetId);
        return next;
      });
      void writeDm17Rumors(self, [openedOf(rumor)]);
      void publishRumor(rumor).catch(() => {});
    },
    [canSend, self, peers, openedOf, publishRumor],
  );

  const removeReaction = useCallback(
    (reactionRumorId: string) => sendDelete(reactionRumorId, KIND_DM_REACTION),
    [sendDelete],
  );

  const sendStatusFor = useCallback((id: string) => pending.get(id)?.status, [pending]);

  const retry = useCallback(
    (id: string) => {
      const entry = pending.get(id);
      if (!entry || entry.status !== "failed") return;
      if (entry.batch) {
        dispatchBatch(entry.batch, id);
        return;
      }
      const o = entry.opened;
      const rumor: NostrRumor = {
        id: o.rumorId,
        kind: o.kind,
        content: o.content,
        tags: o.tags,
        created_at: o.createdAt,
        pubkey: o.author,
      };
      dispatchRumor(rumor, o);
    },
    [pending, dispatchBatch, dispatchRumor],
  );

  const discard = dropPending;

  /**
   * Publish one Mini App state update (kind 3310). Tags are built here so
   * `info`/`document`/`summary` aren't lost.
   */
  const sendWebxdc = useCallback(
    async (uuid: string, payload: string, meta?: DmWebxdcMeta) => {
      if (!canSend || !self || peers.length === 0) {
        throw new Error(t({ id: "useDm17.unreachable", defaultMessage: "This conversation isn't reachable over private DMs yet." }));
      }
      const expiresAt = await resolveExpiry();
      const rumor = buildDmRumor({
        kind: KIND_DM_WEBXDC,
        content: payload,
        tags: dmWebxdcTags(peers, uuid, { ...meta, expiresAt }),
        pubkey: self,
      });
      dispatchRumor(rumor, openedOf(rumor), { firstContact: messages.length === 0 });
    },
    [canSend, self, peers, resolveExpiry, dispatchRumor, openedOf, messages.length],
  );

  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const oldestRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);
  useEffect(() => {
    oldestRef.current = undefined;
    setHasMore(true);
  }, [self, conversation]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!ctx || !self || peers.length === 0 || loadingRef.current || !hasMore) return 0;
    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const window = threadWindowRef.current;
      const before = queryClient.getQueryData<OpenedDm[]>(queryKey) ?? [];
      // Wraps are backdated ≤ T, so `until` at the oldest WINDOW rumor reaches everything older.
      // A focus hit must not move this cursor.
      const until =
        oldestRef.current ??
        (before.length > 0 ? before[0].createdAt : Math.floor(Date.now() / 1000));
      // A relay the history walk read to an empty page is already wholly in the
      // store, so a thread page there can only re-read it.
      const cursor = await readDm17Cursor(self);
      const unwalked = ctx.relays.filter((relay) => !cursor?.relayExhaustedAt?.[relay]);
      const { oldest, exhausted, scanned } = unwalked.length > 0
        ? await pageOlderDmWraps({ ...ctx, relays: unwalked }, until, true)
        : { oldest: undefined, exhausted: true, scanned: 0 };
      if (oldest !== undefined) oldestRef.current = oldest;

      // Probe deep enough for this conversation's rows beside existing ones, but clamp the new
      // floor to what this conversation returned (the stream is global). Always reach one more
      // THREAD_WINDOW into the store: decrypted history outlives relay-expired wraps.
      const probe = Math.max(window.limit, before.length) + Math.max(scanned, THREAD_WINDOW);
      const after = await queryDm17Thread(self, peers, { limit: probe });
      window.limit = Math.max(window.limit, after.length);
      const beforeIds = new Set(before.map((row) => row.rumorId));
      const added = after.reduce((count, row) => count + (beforeIds.has(row.rumorId) ? 0 : 1), 0);
      // Out of history only when relays are exhausted AND the store had nothing older.
      if (exhausted && added === 0) setHasMore(false);
      queryClient.setQueryData<OpenedDm[]>(queryKey, after.sort(
        (a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1),
      ));
      return added;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [ctx, self, peers, hasMore, queryClient, queryKey]);

  return {
    messages,
    reactionsByTarget,
    timerChanges,
    timer,
    resolveTimer,
    setTimer,
    // Wait for a focused row's local lookup so the permalink hunter doesn't backfill first.
    isLoading: query.isLoading || (Boolean(focusedRumorId) && focusedQuery.isLoading),
    firstPaintReady,
    canSend,
    send,
    sendWebxdc,
    react,
    removeReaction,
    deleteMessage: sendDelete,
    editMessage,
    sendStatusFor,
    retry,
    discard,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

export interface Dm17Backfill {
  /**
   * Resolves the conversation keys NOT listed before the page; callers narrow it to what
   * they show.
   */
  loadOlder: () => Promise<string[]>;
  /** False once a page comes back empty or short THIS session. */
  hasMore: boolean;
  isLoading: boolean;
}

/**
 * Explicit older-history backfill from the conversation list; automatic sync only moves
 * forward, so older-only correspondents are otherwise invisible. Not scroll-driven (two NIP-44
 * opens per wrap). Ignores the persisted `exhausted` flag, which a capped relay can fake.
 */
export function useDm17Backfill(): Dm17Backfill {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const self = user?.pubkey;
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const oldestRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  useEffect(() => {
    oldestRef.current = undefined;
    setHasMore(true);
  }, [self]);

  const loadOlder = useCallback(async (): Promise<string[]> => {
    if (!ctx || !self || loadingRef.current) return [];
    loadingRef.current = true;
    setIsLoading(true);
    try {
      // Resume from the persisted floor on the first press of the session.
      const cursor = oldestRef.current === undefined ? await readDm17Cursor(self) : undefined;
      const until =
        oldestRef.current ??
        (cursor?.oldest ? cursor.oldest - 1 : Math.floor(Date.now() / 1000));
      const before = await queryDm17Conversations(self);
      const known = new Set(before.map((c) => c.key));
      const { oldest, exhausted } = await pageOlderDmWraps(ctx, until, true);
      if (oldest !== undefined) oldestRef.current = oldest;
      if (exhausted) setHasMore(false);
      const after = await queryDm17Conversations(self);
      // Unconditional: a page can add messages without changing the conversation count.
      void queryClient.invalidateQueries({ queryKey: ["dm17", "conversations"] });
      return after.map((c) => c.key).filter((key) => !known.has(key));
    } catch {
      return [];
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [ctx, self, queryClient]);

  return { loadOlder, hasMore, isLoading };
}

export type Dm17Conversation = Dm17ConversationRow;

/**
 * NIP-17 conversations with their newest message, muted peers excluded. Local-first; pass
 * `interactive` from user-facing surfaces so the consent prompt may open. Merged with kind-4
 * at the consumer.
 */
export function useDm17Conversations(opts?: { interactive?: boolean }): {
  conversations: Dm17Conversation[];
  isLoading: boolean;
} {
  const interactive = opts?.interactive ?? false;
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const support = useDm17Support();
  const { consent } = useDecryptConsent();
  const { mutedPubkeys, ready: muteReady } = useMutedPubkeys();
  const self = user?.pubkey;

  const queryKey = useMemo(
    () => ["dm17", "conversations", self, consent, interactive] as const,
    [self, consent, interactive],
  );

  const query = useQuery<Dm17Conversation[]>({
    queryKey,
    enabled: !!self && support,
    queryFn: async ({ signal }) => {
      const rows = await queryDm17Conversations(self!, { signal });
      if (!ctx) return rows;

      // First sync: an empty store means "not synced yet", so wait for the pass and re-read.
      if (isDmSynced("nip17", self)) {
        void syncDm17Inbox(ctx, { interactive });
        return rows;
      }
      // Only as far as the first relay with something new, in this pass or one it joined:
      // the rest arrive through `onFreshDm17`, and a slow relay shouldn't hold the whole list.
      const pass = syncDm17Inbox(ctx, { interactive });
      void pass.then((ok) => {
        if (ok) markDmSynced("nip17", self);
      });
      await Promise.race([pass, whenDm17InboxFirstPage(self)]);
      return await queryDm17Conversations(self!, { signal });
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useWireScopes((scopes) => {
    if (!self) return;
    if (ctx && scopes.has("dm:wrap")) {
      // Interactive surfaces always drain; the non-interactive dot drains only when decryption
      // is silent (never prompts from the rail).
      const silent = !signerNeedsApproval(ctx.method) || getDecryptConsent() === "allowed";
      if (interactive || silent) void openLiveDm17Wraps(ctx, { interactive });
    }
    // Every mounted copy hears the same ring: one refetch, not one per copy.
    if (scopes.has("dm") || scopes.has("dm:wrap")) invalidateOnce(queryClient, queryKey);
  });

  // What a write is about to store shows now; the read its commit rings for follows.
  useEffect(() => {
    if (!self) return;
    return onFreshDm17(self, (fresh) => {
      queryClient.setQueryData<Dm17Conversation[]>(queryKey, (old) => (old ? mergeFreshDm17(old, fresh, self) : old));
    });
  }, [self, queryClient, queryKey]);

  // Hide a conversation if ANY participant is muted — a group has no per-sender filter.
  const conversations = useMemo(() => {
    if (!muteReady) return [];
    return (query.data ?? []).filter((c) => !c.peers.some((peer) => mutedPubkeys.has(peer)));
  }, [query.data, mutedPubkeys, muteReady]);

  return { conversations, isLoading: query.isLoading || !muteReady };
}
