/**
 * Plane sweeps — the one fetch/decrypt/cursor discipline for a community's
 * kind-1059 planes (control, guestbook).
 *
 * - AUTH-GATED: REQs wait until stream keys are NIP-42-registered and their
 *   AUTHs acked by the relay (capped, so a stuck key can't stall sync).
 * - BATCHED: same-relay scopes share one REQ, one filter per scope with its own
 *   cursor/limit (a shared `since` would skip what a lagging scope still owes).
 * - SINGLE-FLIGHT: overlapping sweeps of a scope join the in-flight fetch.
 *
 * COMPLETE mode (Control): never a persisted forward cursor — it outlives
 * leave/ban/rejoin and epoch changes and would hide editions below it forever.
 * Instead the first sweep each session (and after floor age-out, truncation,
 * snapshot rebuild, exhaustive reads, or {@link markControlPlaneStale}) re-reads
 * the whole plane; sweeps between use a short-overlap `since` off a SESSION-only
 * floor (Concord wraps aren't backdated, CORD-01). A persisted seen-wrap memo
 * keeps repeat full sweeps decrypt-cheap.
 *
 * PAGED mode (Guestbook): each relay is read by pages to the end of the plane,
 * whole once a day and from its own cursor between (see `planeRead.ts`). Its
 * read state is keyed by newest held epoch, so an epoch advance starts whole.
 *
 * A sweep never claims it read everything (relay page sizes, dropped REQs and
 * withheld tails are indistinguishable). It reports only facts about itself —
 * `controlSweepTruncated`, `controlSweepQuorum` — and the fold judges its own
 * consistency via `FoldedControl.incomplete`.
 */

import { currentControlGroup } from "@/concord/lib/control";
import { guestbookGroups } from "@/concord/lib/guestbook";
import { KIND_WRAP, type Plane } from "@/concord/lib/kinds";
import { afterRead, planRead, type ReadPlan, type RelayRead } from "@/concord/lib/planeRead";
import { readControlSnapshot, writeOpened } from "@/concord/lib/rumorStore";
import { isStreamPubkey, streamAuthsSettled } from "@/concord/lib/streamAuth";
import { openWrap, type OpenedEvent, type OpenedWireEvent } from "@/concord/lib/stream";
import type { StreamKeyView } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { IdLog } from "@/lib/db/idLog";
import { readFolded, readFoldedShared, writeFolded } from "@/lib/foldedCache";
import { nowSecs } from "@/lib/relayClock";
import { beginSyncTask } from "@/lib/syncActivity";
import { t } from "@/i18n/intl";
import { logSync, sinceMs } from "@/lib/syncLog";
import type { NostrRumor } from "@/lib/nostrRumor";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the sweeps need (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Auth gate timing (test seam via {@link _configureAuthWaitForTests}). */
const authWait = {
  /** Hard cap so a key that never registers/acks can't stall sync. */
  maxWaitMs: 8_000,
};

/** Test seam: shrink (or zero) the auth gate so sweeps run immediately. */
export function _configureAuthWaitForTests(cfg: Partial<typeof authWait>): void {
  Object.assign(authWait, cfg);
}

/**
 * Resolve once every group is registered AND its AUTH is acked on `url` (or
 * the relay never challenged — then there's nothing to wait for), or the cap
 * expires. Ack state comes from the relay's own `OK` replies (streamAuth).
 */
async function whenAuthReady(url: string, groupsOf: () => StreamKeyView[]): Promise<void> {
  const deadline = Date.now() + authWait.maxWaitMs;
  for (;;) {
    const pks = groupsOf().map((g) => g.pk);
    const registered = pks.every((pk) => isStreamPubkey(pk));
    if ((registered && streamAuthsSettled(url, pks)) || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, deadline - Date.now()))));
  }
}

/**
 * Wait until `url` has ACKED the AUTHs for every group, only if it challenged
 * this socket. Gate for non-sweep reads (backfills, login warm-up): a kind-1059
 * REQ racing NIP-42 is CLOSED and reads back as an empty page.
 */
export async function whenAuthSettled(url: string, groupsOf: () => StreamKeyView[]): Promise<void> {
  const deadline = Date.now() + authWait.maxWaitMs;
  for (;;) {
    if (streamAuthsSettled(url, groupsOf().map((g) => g.pk)) || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, deadline - Date.now()))));
  }
}

/** One community-plane on one relay: a filter + its persisted read state. */
export interface PlaneScope {
  /** Single-flight identity, and (paged mode) the persisted read state's key. */
  scope: string;
  /**
   * The rumor-store tenant for this plane's events. Explicit rather than parsed
   * from {@link scope}, whose format may change — a wrong tenant cross-writes
   * communities.
   */
  communityIdHex: string;
  /** Which plane this scope reads, for `writeOpened`'s kind check. Set with `groups`. */
  plane: Plane;
  /**
   * Whether the community has ever rotated its root; only then is the store's
   * per-address snapshot id set needed (see `noteControlSnapshot`).
   */
  refounded: boolean;
  /** The stream keys whose addresses this plane's wraps are authored by. */
  groups: StreamKeyView[];
  /** COMPLETE mode (see module doc). Reserved for Control. */
  complete?: boolean;
  /** Called with this scope's decrypted events once they're committed. */
  onFresh?: (fresh: OpenedEvent[]) => void;
  /** COMPLETE only: the pager stopped on its own event budget. */
  onTruncated?: () => void;
  /**
   * Fired once this relay ANSWERED, so a caller tallies its own sweep instead of
   * reading the shared map a concurrent sweep may reset. A paged scope fires it
   * only when its read ran to the end of the plane.
   */
  onReached?: () => void;
  /**
   * COMPLETE only: page until the relay stops, ignoring the budget. For a
   * Refounding, where compacting a partial read loses data.
   */
  exhaustive?: boolean;
}

/**
 * The Control Plane scope key on one relay. EPOCH-KEYED so a Refounding never
 * joins the old epoch's fetch or inherits its verdicts.
 */
export const controlScopeKey = (community: Community, relayUrl: string) =>
  `control:${community.idHex}@${community.rootEpoch}|${relayUrl}`;

/**
 * Forget one community's delta floors so its next sweep re-reads the whole plane
 * (called when the fold reports `incomplete`).
 */
export function markControlPlaneStale(community: Community): void {
  for (const url of community.relays) completeFloors.delete(controlScopeKey(community, url));
  persistFloors();
}

/**
 * One community's Control Plane on one relay, COMPLETE mode. CURRENT EPOCH ONLY:
 * a Refounding re-wraps every head into the new epoch, so old planes are dead
 * weight (and an inflatable plane mustn't follow the community across rotations).
 */
export function controlScope(
  community: Community,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return {
    scope: controlScopeKey(community, relayUrl),
    communityIdHex: community.idHex,
    plane: "control",
    refounded: community.rootEpoch > 0n,
    groups: [currentControlGroup(community)],
    complete: true,
    onFresh,
  };
}

/** The Guestbook Plane scope key on one relay, keyed by newest held epoch. */
const guestbookScopeKey = (community: Community, relayUrl: string) =>
  `guestbook:${community.idHex}@${community.rootEpoch}|${relayUrl}`;

/**
 * One community's Guestbook Plane on one relay, PAGED mode: every held epoch's
 * address, so a new epoch starts with a whole read.
 */
export function guestbookScope(
  community: Community,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return {
    scope: guestbookScopeKey(community, relayUrl),
    communityIdHex: community.idHex,
    plane: "guestbook",
    refounded: community.rootEpoch > 0n,
    groups: guestbookGroups(community),
    onFresh,
  };
}

/** Merge opened-event sets by rumor id (a partial round must not drop editions). */
export function mergeOpened(...sets: OpenedEvent[][]): OpenedEvent[] {
  const byId = new Map<string, OpenedEvent>();
  for (const set of sets) for (const e of set) byId.set(e.rumorId, e);
  return [...byId.values()];
}

/** Decrypt raw plane wraps under the held groups into opened events. */
export function openPlaneWraps(wraps: NostrRumor[], groups: StreamKeyView[]): OpenedWireEvent[] {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: OpenedWireEvent[] = [];
  for (const wrap of wraps) {
    const group = byPk.get(wrap.pubkey);
    if (!group) continue;
    try {
      out.push(openWrap(wrap, group));
    } catch {
      // not ours / malformed
    }
  }
  return out;
}

/** Max unbroken main-thread decrypt time (ms) before yielding (mirrors chat.ts DECODE_SLICE_MS). */
const PLANE_DECODE_SLICE_MS = 5;

/**
 * Time-sliced {@link openPlaneWraps}: yields every {@link PLANE_DECODE_SLICE_MS},
 * since synchronous NIP-44 + Schnorr over a whole plane freezes a phone's UI.
 */
export async function openPlaneWrapsChunked(wraps: NostrRumor[], groups: StreamKeyView[]): Promise<OpenedWireEvent[]> {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: OpenedWireEvent[] = [];
  let sliceStart = performance.now();
  for (let i = 0; i < wraps.length; i++) {
    const group = byPk.get(wraps[i].pubkey);
    if (group) {
      try {
        out.push(openWrap(wraps[i], group));
      } catch {
        // not ours / malformed
      }
    }
    if (i + 1 < wraps.length && performance.now() - sliceStart >= PLANE_DECODE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return out;
}

/** Paging knobs (test seam via {@link _configureSweepPagingForTests}). */

const paging = {
  /** Per-filter page size, shared by the batch REQ and the complete-mode pager. */
  pageLimit: 500,
  /**
   * Complete-mode budget: max wraps per scope per sweep. A fixed count (not a
   * deadline) so read depth doesn't depend on connection quality. Far above any
   * honest compacted plane.
   */
  maxEvents: 15_000,
  /** Limit for the single wide ask that drains a same-second wall. */
  wallPage: 10_000,
  /** Hard ceiling for an EXHAUSTIVE sweep, so a relay serving endless junk can't hang a Refounding. */
  exhaustiveCeiling: 500_000,
  /** Per-REQ deadline; generous for Tor/VPN on poor mobile links. */
  queryTimeoutMs: 25_000,
};

/** Test seam: shrink the page size so the pager is exercisable with few events. */
export function _configureSweepPagingForTests(cfg: Partial<typeof paging>): void {
  Object.assign(paging, cfg);
}

/** Two-tier cadence knobs for COMPLETE scopes (test seam: {@link _configureSweepCadenceForTests}). */
const cadence = {
  /** How long a clean full read licenses delta sweeps before the next full one. */
  fullSweepIntervalMs: 6 * 60 * 60_000,
  /**
   * Overlap behind the last read's start — covers publisher clock skew only
   * (CORD-01: no backdating), so anything published since that read is caught.
   */
  deltaOverlapSecs: 3600,
};

/** Test seam: force every sweep full (`fullSweepIntervalMs: 0`) or pin the overlap. */
export function _configureSweepCadenceForTests(cfg: Partial<typeof cadence>): void {
  Object.assign(cadence, cfg);
}

/**
 * Per-scope delta floor for COMPLETE sweeps: time of the last CLEAN full read,
 * newest wrap seen, and when the last read that reached the relay started
 * (`readAt`, secs) — the delta's anchor, so an old burst of editions isn't the
 * floor forever. Never a forward cursor: it licenses delta reads only until
 * `fullSweepIntervalMs` after that full read, as within one session, so a cold
 * start inside the window doesn't re-download the plane. Persisted beside the
 * rumors it vouches for (ArmadaDB KV, wiped with them on logout); every
 * invalidation clears the stored copy too.
 */
type CompleteFloor = { fullAt: number; newest: number; readAt?: number };
const completeFloors = new Map<string, CompleteFloor>();
const FLOORS_KEY = "plane-complete-floors";
const FLOORS_PERSIST_MS = 2_000;
let floorsLoaded: Promise<void> | undefined;
let floorsPersistTimer: ReturnType<typeof setTimeout> | undefined;

function loadFloors(): Promise<void> {
  floorsLoaded ??= readFolded<Record<string, CompleteFloor>>(FLOORS_KEY)
    .then((stored) => {
      const now = Date.now();
      for (const [scope, floor] of Object.entries(stored ?? {})) {
        if (completeFloors.has(scope)) continue;
        if (!Number.isFinite(floor?.fullAt) || !Number.isFinite(floor?.newest)) continue;
        // A future stamp (clock moved back) would license deltas indefinitely.
        if (floor.fullAt > now || now - floor.fullAt >= cadence.fullSweepIntervalMs) continue;
        completeFloors.set(scope, floor);
      }
    })
    .catch(() => {});
  return floorsLoaded;
}

/**
 * Where a COMPLETE scope's delta read would start (before the skew overlap), or
 * undefined when its floor licenses none and the next read must be whole. An
 * empty plane's floor (newest 0) licenses a delta once a read has stamped it.
 */
function deltaAnchor(scope: string): number | undefined {
  const floor = completeFloors.get(scope);
  if (!floor || (floor.newest <= 0 && !floor.readAt)) return undefined;
  if (Date.now() - floor.fullAt >= cadence.fullSweepIntervalMs) return undefined;
  return Math.max(floor.newest, floor.readAt ?? 0);
}

/**
 * The relays a routine control sweep of `community` reads: every relay whose
 * plane needs a whole read, plus the `deltaRelays` read longest ago. A
 * community's editions are published to all its relays, so the rest add only
 * duplicates; each relay's delta resumes from its OWN last read, so rotating
 * through them skips nothing, and a withheld edition still surfaces within a
 * few sweeps (and at every whole read, which goes to all of them).
 */
export async function controlSweepRelays(community: Community, deltaRelays: number): Promise<string[]> {
  await loadFloors();
  const whole: string[] = [];
  const delta: Array<{ url: string; anchor: number }> = [];
  for (const url of community.relays) {
    const anchor = deltaAnchor(controlScopeKey(community, url));
    if (anchor === undefined) whole.push(url);
    else delta.push({ url, anchor });
  }
  delta.sort((a, b) => a.anchor - b.anchor || a.url.localeCompare(b.url));
  return [...whole, ...delta.slice(0, deltaRelays).map((d) => d.url)];
}

/** Test seam: write the floors now, then forget them in memory, as a relaunch would. */
export async function _coldStartPlaneFloorsForTests(): Promise<void> {
  clearTimeout(floorsPersistTimer);
  floorsPersistTimer = undefined;
  await writeFolded(FLOORS_KEY, Object.fromEntries(completeFloors));
  completeFloors.clear();
  floorsLoaded = undefined;
}

function persistFloors(): void {
  if (floorsPersistTimer !== undefined) return;
  floorsPersistTimer = setTimeout(() => {
    floorsPersistTimer = undefined;
    void writeFolded(FLOORS_KEY, Object.fromEntries(completeFloors)).catch(() => {});
  }, FLOORS_PERSIST_MS);
}

/**
 * Wrap ids a COMPLETE scope has processed (decrypted or judged garbage), keeping
 * repeat sweeps decrypt-free and `onFresh` quiet. Content-addressed, so global.
 * Persisted: ids are noted only once the rumor is durably stored, so a cold
 * launch skips re-decrypting the plane. Wiped on logout.
 */
const seenCompleteWraps = new Set<string>();
const SEEN_WRAPS_CAP = 16_384;
const SEEN_WRAPS_KEY = "plane-seen-wraps";
/** Debounce for the persisted-memo write, so a sweep burst is one write. */
const SEEN_WRAPS_PERSIST_MS = 5_000;

/**
 * Wrap ids fetched that would NOT open, persisted beside the memo so the junk
 * tally stays accurate after the memo stops re-decrypting them.
 */
const junkWraps = new Set<string>();
const JUNK_WRAPS_KEY = "plane-junk-wraps";
/** Capped: the set exists because someone may pump unlimited junk. */
const JUNK_WRAPS_CAP = 4_096;

// Append-only KV logs (see IdLog) rather than one value rewritten on every note.
const seenWrapsLog = new IdLog(() => getArmadaDB().kv, {
  prefix: "plane-seen-wraps:",
  idChars: 64,
  // Small chunks: the open one is rewritten whole on every flush.
  chunkIds: 256,
  keepChunks: SEEN_WRAPS_CAP / 256,
  flushMs: SEEN_WRAPS_PERSIST_MS,
});
const junkWrapsLog = new IdLog(() => getArmadaDB().kv, {
  prefix: "plane-junk-wraps:",
  idChars: 64,
  chunkIds: 256,
  keepChunks: JUNK_WRAPS_CAP / 256,
  flushMs: SEEN_WRAPS_PERSIST_MS,
});

let seenWrapsLoaded: Promise<void> | undefined;

/** Union the persisted memo into the session set (once per session). */
function loadSeenWraps(): Promise<void> {
  seenWrapsLoaded ??= Promise.all([
    seenWrapsLog.load(),
    junkWrapsLog.load(),
    // Legacy single-value form, carried over once and removed.
    readFolded<string[]>(SEEN_WRAPS_KEY),
    readFolded<string[]>(JUNK_WRAPS_KEY),
  ])
    .then(([seen, junk, legacySeen, legacyJunk]) => {
      for (const id of seen) seenCompleteWraps.add(id);
      for (const id of junk) junkWraps.add(id);
      if (legacySeen?.length) {
        for (const id of legacySeen) if (!seenCompleteWraps.has(id)) noteSeen(id);
        void writeFolded(SEEN_WRAPS_KEY, undefined);
      }
      if (legacyJunk?.length) {
        for (const id of legacyJunk) if (!junkWraps.has(id)) noteJunk(id);
        void writeFolded(JUNK_WRAPS_KEY, undefined);
      }
    })
    .catch(() => undefined);
  return seenWrapsLoaded;
}

function noteSeen(id: string): void {
  seenCompleteWraps.add(id);
  seenWrapsLog.add(id);
  if (seenCompleteWraps.size > SEEN_WRAPS_CAP) {
    const oldest = seenCompleteWraps.values().next();
    if (!oldest.done) seenCompleteWraps.delete(oldest.value);
  }
}

function noteJunk(id: string): void {
  junkWraps.add(id);
  junkWrapsLog.add(id);
  if (junkWraps.size > JUNK_WRAPS_CAP) {
    const oldest = junkWraps.values().next();
    if (!oldest.done) junkWraps.delete(oldest.value);
  }
}

/**
 * Mark wrap ids as fetched-but-unopenable. Shared with the wire's control-wrap
 * ingest so junk it saw first still counts in the sweep's tally.
 */
export function notePlaneWrapsJunk(ids: string[]): void {
  for (const id of ids) if (!junkWraps.has(id)) noteJunk(id);
}

/**
 * Mark wrap ids as processed — only once their rumors are durably stored (or
 * failed under a held key). Shared with the wire's control-wrap ingest.
 */
export function notePlaneWrapsSeen(ids: string[]): void {
  for (const id of ids) if (!seenCompleteWraps.has(id)) noteSeen(id);
}

/** The subset of `wraps` not yet processed (loads the persisted memo first). */
export async function unseenPlaneWraps(wraps: NostrEvent[]): Promise<NostrEvent[]> {
  await loadSeenWraps();
  return wraps.filter((w) => !seenCompleteWraps.has(w.id));
}

/** Test seam: forget which wraps have been processed (session + persisted). */
export function _resetPlaneSweepMemoForTests(): void {
  seenCompleteWraps.clear();
  junkWraps.clear();
  unreadableScopes.clear();
  scopeTruncated.clear();
  scopeReached.clear();
  pagedReads.clear();
  completeFloors.clear();
  floorsLoaded = Promise.resolve();
  clearTimeout(floorsPersistTimer);
  floorsPersistTimer = undefined;
  void writeFolded(FLOORS_KEY, {});
  seenWrapsLoaded = Promise.resolve();
  void seenWrapsLog.clear();
  void junkWrapsLog.clear();
  void writeFolded(SEEN_WRAPS_KEY, []);
  void writeFolded(JUNK_WRAPS_KEY, []);
}

/**
 * Scope keys whose last COMPLETE sweep stopped on OUR OWN budget. Module-level so
 * a joiner of an in-flight sweep can read it. There's deliberately no inverse
 * "read whole" flag: no client can establish that.
 */
const scopeTruncated = new Map<string, boolean>();

/**
 * Verdict revision, bumped on every change. Verdicts live in module maps React
 * can't see; without this the watchdog would compute once pre-sweep and freeze.
 */
let verdictRevision = 0;
const verdictListeners = new Set<() => void>();

function bumpVerdicts(): void {
  verdictRevision++;
  for (const listener of verdictListeners) {
    try {
      listener();
    } catch {
      // A listener must never break a sweep.
    }
  }
}

/** `useSyncExternalStore` pair for the sweep verdicts. */
export function subscribeSweepVerdicts(listener: () => void): () => void {
  verdictListeners.add(listener);
  return () => {
    verdictListeners.delete(listener);
  };
}
export function sweepVerdictRevision(): number {
  return verdictRevision;
}

/**
 * Whether the last control sweep of this community KNOWINGLY stopped short on
 * any relay (event budget, or an undrainable same-second wall). Gates the
 * destructive actions: Refounding compaction, persisting a cold fold as baseline,
 * and naming an attacker. Otherwise members fold what arrived.
 */
export function controlSweepTruncated(community: Community): boolean {
  return community.relays.some((url) => scopeTruncated.get(controlScopeKey(community, url)) === true);
}

/**
 * Scope keys the last sweep actually got an answer from. Absent = never swept,
 * or every attempt threw.
 */
const scopeReached = new Set<string>();

/** How many of this community's relays answered the last control sweep. */
export function controlSweepReach(community: Community): { reached: number; total: number } {
  return {
    reached: community.relays.filter((url) => scopeReached.has(controlScopeKey(community, url))).length,
    total: community.relays.length,
  };
}

/** Per-relay form of {@link controlSweepReach} (for the history audit). */
export function controlSweepRelayReached(community: Community, url: string): boolean {
  return scopeReached.has(controlScopeKey(community, url));
}

/**
 * Whether a MAJORITY (`floor(n/2) + 1`) of this community's relays answered the
 * last control sweep. A coverage heuristic on top of `FoldedControl.incomplete`,
 * since an entity never seen leaves no floor and a publish may reach only one
 * relay. Majority, not unanimity, so a dead relay can't wedge rotation.
 */
export function controlSweepQuorum(community: Community): boolean {
  const { reached, total } = controlSweepReach(community);
  return total > 0 && reached >= Math.floor(total / 2) + 1;
}

/**
 * Whether ANY relay answered the last control sweep. Deliberately not conjoined
 * with `!controlSweepTruncated`: a flood mustn't be able to mute the watchdog.
 * A short read forbids NAMING someone (see `controlSweepQuorum`), not reporting.
 */
export function controlSweepAnswered(community: Community): boolean {
  return community.relays.some((url) => scopeReached.has(controlScopeKey(community, url)));
}

/**
 * Wraps the last COMPLETE sweep fetched but couldn't open, per scope key — the
 * cheapest plane inflation, invisible downstream, so only the sweep can count
 * it. A healthy plane is 0.
 */
const unreadableScopes = new Map<string, number>();

/** Worst single relay's unreadable tally (max, not sum: the same junk everywhere is one attack). */
export function controlSweepUnreadable(community: Community): number {
  let worst = 0;
  for (const url of community.relays) {
    worst = Math.max(worst, unreadableScopes.get(controlScopeKey(community, url)) ?? 0);
  }
  return worst;
}

/**
 * Paged scope keys the last sweep got an answer for: whether that read ran to the
 * end of the plane. Absent = never swept, or the last attempt went unanswered.
 */
const pagedReads = new Map<string, boolean>();

/**
 * The last Guestbook sweep of this community, per relay: how many answered, and
 * how many of those stopped short of the plane's end.
 */
export function guestbookSweepReach(community: Community): { answered: number; unread: number } {
  const ends = community.relays.map((url) => pagedReads.get(guestbookScopeKey(community, url)));
  return { answered: ends.filter((end) => end !== undefined).length, unread: ends.filter((end) => end === false).length };
}

const planeReadKey = (scope: string) => `plane-read:${scope}`;

/** Record how a paged scope's read ended. */
async function savePlaneRead(scope: string, plan: ReadPlan, stopped: number | undefined): Promise<void> {
  const held = await readFoldedShared<RelayRead>(planeReadKey(scope));
  await writeFolded(planeReadKey(scope), afterRead(held, plan, stopped));
}

/**
 * Page a scope oldest-ward past the relay's per-filter limit until a short page
 * or our event budget. Pages STREAM to `onPage` and are dropped (only ids kept),
 * so a flooded plane costs time, not heap. `truncated` means only that WE stopped
 * (budget or an undrainable same-second wall); `stoppedAt` is where the budget
 * ran out, for a read that goes on from there.
 */
async function fetchCompleteScope(
  nostr: NostrLike,
  url: string,
  filter: NostrFilter,
  first: NostrEvent[],
  onPage: (page: NostrEvent[]) => Promise<void>,
  onTruncated?: () => void,
  exhaustive = false,
): Promise<{ total: number; truncated: boolean; stoppedAt?: number }> {
  // A relay's answer isn't the filter sent: narrow every page by author and
  // created_at range, or an off-filter event drags the cursor and gets memoed
  // (never decrypted, by this pager or the wire).
  const wanted = new Set(filter.authors ?? []);
  const mine = (events: NostrEvent[], until: number) =>
    events.filter((e) => e.kind === KIND_WRAP && wanted.has(e.pubkey) && e.created_at <= until);

  const seen = new Set(first.map((e) => e.id));
  await onPage(first);
  if (first.length === 0) return { total: 0, truncated: false };

  // `until` is INCLUSIVE: pages overlap by one timestamp on purpose (id dedupe makes it free).
  let cursor = Math.min(...first.map((e) => e.created_at));
  let full = first.length >= paging.pageLimit;
  /** We stepped over part of a second we could not page through. */
  let walled = false;

  while (full) {
    if (exhaustive && seen.size >= paging.exhaustiveCeiling) {
      logSync("sweep", `${url}: exhaustive read hit its ${paging.exhaustiveCeiling}-event ceiling`);
      onTruncated?.();
      return { total: seen.size, truncated: true, stoppedAt: cursor };
    }
    if (!exhaustive && seen.size >= paging.maxEvents) {
      // Members fold what arrived; only a Refounding (exhaustive) can't proceed on a short read.
      logSync("sweep", `${url}: hit the ${paging.maxEvents}-event sweep budget; older plane left for a later round`);
      onTruncated?.();
      return { total: seen.size, truncated: true, stoppedAt: cursor };
    }
    const page = mine(
      await nostr.relay(url).query([{ ...filter, until: cursor }], {
        signal: AbortSignal.timeout(paging.queryTimeoutMs),
      }),
      cursor,
    );
    full = page.length >= paging.pageLimit;
    const fresh = page.filter((e) => !seen.has(e.id));
    if (fresh.length > 0) {
      for (const e of fresh) seen.add(e.id);
      await onPage(fresh);
    }
    const lowest = page.length > 0 ? Math.min(...page.map((e) => e.created_at)) : cursor;
    if (lowest < cursor) {
      cursor = lowest;
    } else if (full) {
      // A full page that didn't move the cursor is a same-second wall (created_at
      // is publisher-chosen). Ask for the whole second in one go.
      const drained = mine(
        await nostr.relay(url).query([{ ...filter, since: cursor, until: cursor, limit: paging.wallPage }], {
          signal: AbortSignal.timeout(paging.queryTimeoutMs),
        }),
        cursor,
      );
      const stillNew = drained.filter((e) => !seen.has(e.id));
      for (const e of stillNew) seen.add(e.id);
      if (stillNew.length > 0) await onPage(stillNew);

      // The drain is credible only strictly between pageLimit and wallPage —
      // otherwise a capped relay is indistinguishable from an emptied second.
      // Either way the cursor steps below the second.
      const emptied = drained.length > paging.pageLimit && drained.length < paging.wallPage;
      if (!emptied) {
        logSync("sweep", `${url}: cannot prove second ${cursor} was read whole (${drained.length} served)`);
        walled = true;
      }
      cursor -= 1;
    } else {
      break;
    }
  }
  if (walled) onTruncated?.();
  return { total: seen.size, truncated: walled };
}

/**
 * Run one relay's batch: one filter per scope, ONE query, demuxed by wrap author.
 * Retries once. Not abortable (the REQ is shared).
 */
async function runScopes(
  nostr: NostrLike,
  url: string,
  scopes: PlaneScope[],
): Promise<Map<string, OpenedEvent[]>> {
  // Load the seen-memo before narrowing, or a cold launch re-decrypts everything.
  await Promise.all([loadSeenWraps(), loadFloors()]);
  // A Refounded control scope whose snapshot id-set is missing must re-ingest
  // WITHOUT the memo narrowing: the set is only recorded for fresh wraps, so
  // otherwise the fold anchors on an empty snapshot. Known junk stays skipped.
  const rebuildSnapshot = await Promise.all(
    scopes.map(async (s) => {
      if (!s.complete || !s.refounded || s.groups.length === 0) return false;
      return !(await readControlSnapshot(s.communityIdHex, s.groups[0].pk));
    }),
  );
  // PAGED scopes: each relay's own plan, whole when due.
  const now = nowSecs();
  const plans = await Promise.all(
    scopes.map(async (s) =>
      s.complete ? undefined : planRead(await readFoldedShared<RelayRead>(planeReadKey(s.scope)), now),
    ),
  );
  // COMPLETE scopes: a fresh session floor licenses a delta read; otherwise full plane.
  const deltaSince = scopes.map((s, i) => {
    if (!s.complete || s.exhaustive || rebuildSnapshot[i]) return undefined;
    const anchor = deltaAnchor(s.scope);
    return anchor === undefined ? undefined : Math.max(0, anchor - cadence.deltaOverlapSecs);
  });
  const filters: NostrFilter[] = scopes.map((s, i) => ({
    kinds: [KIND_WRAP],
    authors: s.groups.map((g) => g.pk),
    limit: paging.pageLimit,
    ...(s.complete
      ? deltaSince[i] !== undefined ? { since: deltaSince[i] } : {}
      : {
          ...(plans[i]!.since > 0 ? { since: plans[i]!.since } : {}),
          ...(plans[i]!.until !== undefined ? { until: plans[i]!.until } : {}),
        }),
  }));
  const out = new Map<string, OpenedEvent[]>(scopes.map((s) => [s.scope, []]));

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    // Invalidate at the TOP of each attempt so a throw leaves no stale verdict
    // and a retry doesn't stack on attempt 1's tallies.
    for (const s of scopes) {
      if (!s.complete) continue;
      scopeTruncated.delete(s.scope);
      scopeReached.delete(s.scope);
      unreadableScopes.set(s.scope, 0);
    }
    bumpVerdicts();
    try {
      const events = await nostr.relay(url).query(filters, {
        signal: AbortSignal.timeout(paging.queryTimeoutMs),
      });
      // A REQ that raced NIP-42 reads back empty; re-ask once behind the gate.
      const authSettled = streamAuthsSettled(url, scopes.flatMap((s) => s.groups.map((g) => g.pk)));
      if (!authSettled && events.length === 0 && attempt < 2) {
        logSync("sweep", `${url}: empty page before the AUTHs settled — re-asking`);
        await whenAuthReady(url, () => scopes.flatMap((s) => s.groups));
        continue;
      }

      // Demux by wrap author: every scope's stream addresses are distinct.
      const scopeByPk = new Map<string, number>();
      scopes.forEach((s, i) => s.groups.forEach((g) => scopeByPk.set(g.pk, i)));
      const perScope: NostrEvent[][] = scopes.map(() => []);
      for (const ev of events) {
        // Check kind too: an off-kind event from a relay ignoring `kinds` could drag the cursor.
        if (ev.kind !== KIND_WRAP) continue;
        const i = scopeByPk.get(ev.pubkey);
        if (i !== undefined) perScope[i].push(ev);
      }

      const freshPerScope: OpenedEvent[][] = scopes.map(() => []);
      const totals: number[] = scopes.map((_, i) => perScope[i].length);
      // Newest wrap per scope from page one (newest-first), before the pager
      // consumes it — advances the session delta floor.
      const newestPerScope = perScope.map((evs) =>
        evs.length > 0 ? Math.max(...evs.map((e) => e.created_at)) : undefined,
      );

      // A complete scope STREAMS: decrypt (time-sliced), store and memo each page, then drop it.
      for (const [i, s] of scopes.entries()) {
        if (!s.complete) continue;
        const ingest = async (page: NostrEvent[]) => {
          // Narrow by the memo BEFORE advancing it, or nothing ever decrypts.
          const fresh = rebuildSnapshot[i]
            ? page.filter((w) => !junkWraps.has(w.id))
            : page.filter((w) => !seenCompleteWraps.has(w.id));
          const opened = await openPlaneWrapsChunked(fresh, s.groups);
          // Remember junk so later sweeps count it without re-decrypting.
          const openedIds = new Set(opened.map((e) => e.wrapId));
          notePlaneWrapsJunk(fresh.filter((w) => !openedIds.has(w.id)).map((w) => w.id));
          // Tally over the WHOLE page, or a standing flood reads zero after one round.
          unreadableScopes.set(
            s.scope,
            (unreadableScopes.get(s.scope) ?? 0) + page.filter((w) => junkWraps.has(w.id)).length,
          );

          let stored = true;
          if (opened.length > 0) {
            stored = await writeOpened(s.communityIdHex, opened, s.plane, {
              refounded: s.refounded,
            });
            for (const e of opened) freshPerScope[i].push(e);
          }
          // Advance the memo only if the write succeeded, or unstored rumors
          // are never opened again.
          if (stored) notePlaneWrapsSeen(page.map((w) => w.id));
        };
        const swept = await fetchCompleteScope(
          nostr,
          url,
          filters[i],
          perScope[i],
          ingest,
          () => s.onTruncated?.(),
          s.exhaustive,
        );
        totals[i] = swept.total;
        if (swept.truncated) scopeTruncated.set(s.scope, true);
        perScope[i] = [];
      }

      // A paged scope streams the same way, down to the end of the plane or its budget.
      const stopped: Array<number | undefined> = scopes.map(() => undefined);
      const unstored: boolean[] = scopes.map(() => false);
      for (const [i, s] of scopes.entries()) {
        if (s.complete) continue;
        const ingest = async (page: NostrEvent[]) => {
          const fresh = page.filter((w) => !seenCompleteWraps.has(w.id));
          const opened = await openPlaneWrapsChunked(fresh, s.groups);
          if (opened.length > 0) {
            for (const e of opened) freshPerScope[i].push(e);
            if (!(await writeOpened(s.communityIdHex, opened, s.plane, { refounded: s.refounded }))) {
              unstored[i] = true;
              return;
            }
          }
          notePlaneWrapsSeen(fresh.map((w) => w.id));
        };
        const swept = await fetchCompleteScope(nostr, url, filters[i], perScope[i], ingest);
        totals[i] = swept.total;
        // A same-second wall is stepped past, not a place to resume from (Vector `page_relay`).
        stopped[i] = swept.stoppedAt;
        perScope[i] = [];
      }
      await Promise.all(
        scopes.map((s, i) => {
          const plan = plans[i];
          logSync(
            "sweep",
            `${s.scope} → ${totals[i]} event(s), ${freshPerScope[i].length} new in ${sinceMs(started)} (${s.complete ? (deltaSince[i] === undefined ? "full" : `delta since=${deltaSince[i]}`) : `since=${plan?.since || "∅"}${plan?.until !== undefined ? ` until=${plan.until}` : ""}${stopped[i] !== undefined ? `, stopped at ${stopped[i]}` : ""}`}, authors×${s.groups.length})`,
          );
          // An empty answer with AUTHs unacked is a CLOSED read, and a page that wasn't
          // stored wasn't read: either way the relay keeps its place.
          if (!plan || unstored[i] || !(authSettled || totals[i] > 0)) return undefined;
          return savePlaneRead(s.scope, plan, stopped[i]);
        }),
      );
      for (const [i, s] of scopes.entries()) {
        if (!s.complete) {
          if (authSettled || totals[i] > 0) {
            const end = stopped[i] === undefined && !unstored[i];
            pagedReads.set(s.scope, end);
            if (end) s.onReached?.();
          } else {
            pagedReads.delete(s.scope);
          }
        }
        // An empty answer with AUTHs unacked is a CLOSED read, not an exhausted plane.
        if (s.complete && (authSettled || totals[i] > 0)) {
          scopeReached.add(s.scope);
          s.onReached?.();
          // Clean full read (re)establishes the floor; truncated establishes
          // nothing; a delta read only raises the high-water mark.
          const prior = completeFloors.get(s.scope);
          const newest = Math.max(newestPerScope[i] ?? 0, prior?.newest ?? 0);
          const readAt = Math.floor(started / 1000);
          if (deltaSince[i] === undefined) {
            if (scopeTruncated.get(s.scope) === true) completeFloors.delete(s.scope);
            else completeFloors.set(s.scope, { fullAt: Date.now(), newest, readAt });
          } else if (prior) {
            completeFloors.set(s.scope, { fullAt: prior.fullAt, newest, readAt });
          }
          persistFloors();
        }
        const fresh = freshPerScope[i];
        if (fresh.length === 0) continue;
        out.set(s.scope, fresh);
        s.onFresh?.(fresh);
      }
      bumpVerdicts();
      return out;
    } catch (err) {
      logSync(
        "sweep",
        `${url} sweep FAILED in ${sinceMs(started)} (${scopes.length} scope(s), attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt >= 2) break;
      // Pause and re-check the auth gate (the first round may have lost to a lazy NIP-42 challenge).
      await new Promise((r) => setTimeout(r, 250));
      await whenAuthReady(url, () => scopes.flatMap((s) => s.groups));
    }
  }
  for (const s of scopes) if (!s.complete) pagedReads.delete(s.scope);
  return out;
}

/** In-flight sweeps by cursor scope (see the single-flight docstring). */
const inflight = new Map<string, Promise<OpenedEvent[]>>();

/** Extra enrollment time for an OPEN gate, so same-render callers coalesce. */
const BATCH_WINDOW_MS = 50;

/**
 * Scopes per batch, each one filter of its REQ. Relays cap filters per REQ and
 * CLOSE the whole REQ past it; a full batch leaves the next scope a new one.
 */
const MAX_FILTERS_PER_REQ = 16;

/** A per-relay batch collecting scopes until the auth gate opens. */
interface RelayBatch {
  scopes: PlaneScope[];
  closed: boolean;
  promise: Promise<Map<string, OpenedEvent[]>>;
}
/** Each relay's batches still taking scopes, oldest first; only the last has room. */
const batches = new Map<string, RelayBatch[]>();

/** Build and register a fresh batch; its promise resolves after the auth gate. */
function newBatch(nostr: NostrLike, url: string): RelayBatch {
  const b: RelayBatch = { scopes: [], closed: false, promise: Promise.resolve(new Map()) };
  b.promise = (async () => {
    // The whole batch lifetime counts as sync activity (auth hold can take seconds).
    const task = beginSyncTask(t({ id: "planeSync.communityUpdates", defaultMessage: "community updates" }));
    try {
      await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));
      await whenAuthReady(url, () => b.scopes.flatMap((s) => s.groups));
      b.closed = true;
      const open = batches.get(url)?.filter((other) => other !== b) ?? [];
      if (open.length > 0) batches.set(url, open);
      else batches.delete(url);
      return await runScopes(nostr, url, b.scopes);
    } finally {
      task.end();
    }
  })();
  batches.set(url, [...(batches.get(url) ?? []), b]);
  return b;
}

/**
 * Single-flight identity. An exhaustive sweep must never JOIN a budgeted one, or
 * a Refounding inherits a capped read of the plane it compacts.
 */
const flightKey = (s: PlaneScope) => (s.exhaustive ? `${s.scope}|exhaustive` : s.scope);

/** Enroll one scope into the relay's open batch (creating one if needed). */
function enqueue(nostr: NostrLike, url: string, scope: PlaneScope): Promise<OpenedEvent[]> {
  // A budgeted and an exhaustive request for one plane collapse to the stronger
  // read here, fanning callbacks out, so they don't race to publish a verdict —
  // in whichever open batch holds it, full or not.
  const open = (batches.get(url) ?? []).filter((batch) => !batch.closed);
  const holder = open.find((batch) => batch.scopes.some((s) => s.scope === scope.scope));
  const last = open.at(-1);
  const b = holder ?? (last && last.scopes.length < MAX_FILTERS_PER_REQ ? last : newBatch(nostr, url));
  const twin = b.scopes.find((s) => s.scope === scope.scope);
  if (twin) {
    twin.exhaustive = twin.exhaustive || scope.exhaustive;
    const priorFresh = twin.onFresh;
    const priorTruncated = twin.onTruncated;
    const priorReached = twin.onReached;
    twin.onReached = () => {
      priorReached?.();
      scope.onReached?.();
    };
    twin.onFresh = (fresh) => {
      priorFresh?.(fresh);
      scope.onFresh?.(fresh);
    };
    twin.onTruncated = () => {
      priorTruncated?.();
      scope.onTruncated?.();
    };
  } else {
    b.scopes.push(scope);
  }
  const one = b.promise.then((m) => m.get(scope.scope) ?? []);
  const key = flightKey(scope);
  inflight.set(key, one);
  void one.finally(() => {
    if (inflight.get(key) === one) inflight.delete(key);
  });
  return one;
}

/**
 * Sweep scopes on ONE relay. In-flight scopes are JOINED (still getting fresh
 * events and `onFresh`); new ones enroll in the relay's batch.
 */
export async function sweepRelayScopes(
  nostr: NostrLike,
  url: string,
  scopes: PlaneScope[],
): Promise<Map<string, OpenedEvent[]>> {
  const results = scopes.map((s) => {
    const existing = inflight.get(flightKey(s));
    if (existing) {
      return existing.then((fresh) => {
        if (fresh.length > 0) s.onFresh?.(fresh);
        return [s.scope, fresh] as const;
      });
    }
    return enqueue(nostr, url, s).then((fresh) => [s.scope, fresh] as const);
  });
  return new Map(await Promise.all(results));
}

/** Sweep one community's plane across its relays; union deduped by rumor id. */
async function sweepCommunityPlane(
  nostr: NostrLike,
  community: Community,
  scopeOf: typeof controlScope,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  const results = await Promise.all(
    community.relays.map((url) => sweepRelayScopes(nostr, url, [scopeOf(community, url, opts?.onFresh)])),
  );
  return mergeOpened(...results.map((m) => [...m.values()].flat()));
}

/**
 * Sweep one community's Control Plane. `exhaustive` pages to the end however
 * deep (for a Refounding, which may only compact what it read whole).
 */
export function sweepControl(
  nostr: NostrLike,
  community: Community,
  opts?: {
    onFresh?: (fresh: OpenedEvent[]) => void;
    exhaustive?: boolean;
    onReached?: () => void;
    onTruncated?: () => void;
  },
): Promise<OpenedEvent[]> {
  const scopeOf: typeof controlScope = (c, url, onFresh) => ({
    ...controlScope(c, url, onFresh),
    exhaustive: opts?.exhaustive,
    onReached: opts?.onReached,
    onTruncated: opts?.onTruncated,
  });
  return sweepCommunityPlane(nostr, community, scopeOf, opts);
}

/**
 * Sweep one community's Guestbook Plane (membership motions). `onWalked` fires
 * when a relay answered and every one that did was read to the end of the plane
 * (Vector `sync_guestbook_pass`): a Join may sit on one relay and nobody else's.
 */
export async function sweepGuestbook(
  nostr: NostrLike,
  community: Community,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void; onWalked?: () => void },
): Promise<OpenedEvent[]> {
  const fresh = await sweepCommunityPlane(nostr, community, guestbookScope, opts);
  const { answered, unread } = guestbookSweepReach(community);
  if (answered > 0 && unread === 0) opts?.onWalked?.();
  return fresh;
}
