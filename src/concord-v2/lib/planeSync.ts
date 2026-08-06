/**
 * Plane sweeps — the ONE fetch/decrypt/cursor discipline for a community's
 * kind-1059 planes (control, guestbook), shared by the per-community hooks
 * and the global background sweep.
 *
 * - AUTH-GATED: holds every REQ until the scopes' stream keys are
 *   NIP-42-registered and (on a challenged socket) their AUTHs are ACKED by
 *   the relay, with a hard cap so a key that never registers can't stall
 *   sync. The ack is the relay's own `OK` — no settle-timer guesswork.
 * - BATCHED: same-relay scopes coalesce into one REQ (one filter per scope,
 *   each with its own cursor and limit — per-filter isolation prevents the
 *   issue-#19 since-skip).
 * - SINGLE-FLIGHT: overlapping sweeps of the same scope join the in-flight
 *   fetch instead of re-paying the full history.
 *
 * Two completeness modes, chosen per plane:
 *
 * - COMPLETE (Control): correctness-critical and compaction-bounded. A
 *   PERSISTED forward cursor here silently starves the fold: the cursor key
 *   outlives a leave/ban/rejoin and the held-epoch set it was minted under,
 *   so any edition below the high-water mark that was never ingested (an
 *   unban published while the client was out, a compaction re-wrap under a
 *   newly-held epoch) stays invisible forever — the client then folds a STALE
 *   banlist/roster and mis-renders membership. So the cadence is TWO-TIER,
 *   with the delta floor held only in SESSION memory: the first sweep of a
 *   scope each session re-fetches the WHOLE plane — no `since`, paging past
 *   the relay's per-filter limit — as does every sweep once the floor ages
 *   out, after a truncated read, for a snapshot rebuild, for an exhaustive
 *   (Refounding) read, and after the fold reports `incomplete`
 *   ({@link markControlPlaneStale}). Sweeps between ride a short-overlap
 *   `since` off the last clean full read: wraps are immutable and Concord
 *   does NOT backdate them (CORD-01), so the overlap only has to cover
 *   publisher clock skew — and the full-plane re-fetch every 5 minutes was
 *   the client's single largest steady-state download. The "while the client
 *   was out" starvation cases are exactly what the session-start full sweep
 *   re-reads, and an epoch change renames the scope (controlScopeKey) so a
 *   rotation never inherits a floor. Repeat full sweeps stay decrypt-cheap:
 *   a persisted seen-wrap memo skips the re-decrypt (the folds re-read the
 *   opened-event store), and `onFresh` fires only for wraps not yet
 *   processed.
 * - FORWARD (Guestbook): append-mostly and unbounded, so it keeps the
 *   persisted `since` cursor — but the cursor scope is keyed by the newest
 *   held epoch, so an epoch advance (rejoin, rekey adoption) re-baselines
 *   with one full backfill instead of trusting a cursor minted under a
 *   different read scope.
 *
 * WHAT A SWEEP DOES NOT KNOW: whether it read everything. Page size is the
 * relay's own policy, an empty answer is indistinguishable from a dropped REQ,
 * and a relay withholding the tail replies exactly like an exhausted one. So
 * nothing here asserts completeness. It reports only facts about ITSELF —
 * `controlSweepTruncated` (we stopped on our own event budget) and
 * `controlSweepQuorum` (how many relays answered at all) — and the question "is the
 * state we folded self-consistent" is answered locally by the fold instead,
 * via `FoldedControl.incomplete`.
 */

import { currentControlGroup } from "@/concord-v2/lib/control";
import { guestbookGroups } from "@/concord-v2/lib/guestbook";
import { KIND_WRAP, type Plane } from "@/concord-v2/lib/kinds";
import { readControlSnapshot, readStreamCursor, updateStreamCursor, writeOpened } from "@/concord-v2/lib/rumorStore";
import { isStreamPubkey, streamAuthsSettled } from "@/concord-v2/lib/streamAuth";
import { openWrap, type OpenedEvent, type OpenedWireEvent } from "@/concord-v2/lib/stream";
import type { StreamKeyView } from "@/concord-v2/lib/derive";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { beginSyncTask } from "@/lib/syncActivity";
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
 * Wait until `url` has ACKED the AUTHs for every group — but only if the relay
 * actually challenged this socket (an unchallenged relay isn't auth-gating, or
 * its lazy challenge will be triggered by the REQ itself and covered by the
 * pool's auth-retry). Same cap/test seam as the sweep gate.
 *
 * This is the gate for NON-sweep reads (channel backfills, the login warm-up's
 * newest-page pulls): a kind-1059 REQ racing NIP-42 gets CLOSED by the relay
 * and reads back as a clean empty page — which is how a fresh login used to
 * "complete" with zero messages and drop the user into hollow rooms.
 */
export async function whenAuthSettled(url: string, groupsOf: () => StreamKeyView[]): Promise<void> {
  const deadline = Date.now() + authWait.maxWaitMs;
  for (;;) {
    if (streamAuthsSettled(url, groupsOf().map((g) => g.pk)) || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, deadline - Date.now()))));
  }
}

/** One community-plane on one relay: a filter + its persisted cursor. */
export interface PlaneScope {
  /** The scope key: single-flight identity, and (forward mode) the persisted cursor key. */
  scope: string;
  /**
   * The community this plane belongs to — which rumor-store tenant its opened
   * events are written to.
   *
   * A structured field rather than something parsed back out of {@link scope}:
   * `scope` is also the cursor key and the single-flight identity, so its
   * format is free to change, and getting a tenant wrong writes one community's
   * plane into another's database. Set by the scope factories, which each
   * already take the community.
   */
  communityIdHex: string;
  /**
   * Which plane this scope reads — the store's write-side check that a rumor
   * arriving on these stream keys is one this plane may carry (see
   * `writeOpened`). Set by the scope factories alongside `groups`, so the two
   * cannot drift apart.
   */
  plane: Plane;
  /**
   * Whether this community has ever rotated its root. Only a Refounded one has
   * a compaction snapshot to tell from old-root fragments, so only a Refounded
   * one needs the store's per-address id set — see `noteControlSnapshot`.
   * Read straight off the community by the scope factories.
   */
  refounded: boolean;
  /** The stream keys whose addresses this plane's wraps are authored by. */
  groups: StreamKeyView[];
  /**
   * COMPLETE mode (see the module docstring): the plane is re-fetched whole
   * rather than trusting a persisted forward cursor — full at session start /
   * floor age-out, short-overlap delta between. Reserved for planes that are
   * both correctness-critical and compaction-bounded (Control).
   */
  complete?: boolean;
  /** Called with this scope's decrypted events once they're committed. */
  onFresh?: (fresh: OpenedEvent[]) => void;
  /**
   * COMPLETE mode only: fired when the pager stopped on its own event budget,
   * leaving older events unfetched this round.
   */
  onTruncated?: () => void;
  /**
   * COMPLETE mode only: fired once this relay has ANSWERED. Lets a caller
   * tally its OWN sweep's reach instead of reading the shared verdict map
   * after its await — where a background sweep starting on another relay can
   * invalidate an entry between the sweep finishing and the caller checking.
   */
  onReached?: () => void;
  /**
   * COMPLETE mode only: page until the relay stops sending, ignoring the event
   * budget. Plane depth is attacker-controlled — any member can mint wraps —
   * so the budget exists to stop a routine sweep spending a launch on a flood.
   * A Refounding opts in and pays whatever the depth costs, because compacting
   * is the one operation where reading less than everything loses data.
   */
  exhaustive?: boolean;
}

/**
 * The scope key for one community's Control Plane on one relay.
 *
 * EPOCH-KEYED: a Refounding changes which plane address this scope reads, so
 * carrying the same key across the rotation would let the new epoch's sweep
 * join the old epoch's in-flight fetch, and would leave the previous epoch's
 * truncation/reach verdicts standing over a plane they say nothing about.
 */
export const controlScopeKey = (community: CommunityV2, relayUrl: string) =>
  `control:${community.idHex}@${community.rootEpoch}|${relayUrl}`;

/**
 * Forget the two-tier delta floors for one community's control scopes, so its
 * NEXT sweep re-reads the whole plane. Called when the fold reports
 * `incomplete` — a floored entity the served editions can't account for is
 * exactly the "an edition below the floor never arrived" case a delta sweep
 * cannot heal.
 */
export function markControlPlaneStale(community: CommunityV2): void {
  for (const url of community.relays) completeFloors.delete(controlScopeKey(community, url));
}

/**
 * One community's Control Plane on one relay. COMPLETE: the fold that hangs
 * off this plane (roster, banlist, channels, registries) must never run on a
 * silently-truncated edition set — see the module docstring.
 *
 * CURRENT EPOCH ONLY. Concord's control plane is compaction-bounded: a
 * Refounding re-wraps every entity's head into the new epoch, so the current
 * plane is a complete snapshot and prior ones are dead weight — history, not
 * authority. Sweeping them too would mean a plane any member can inflate
 * follows the community across every future rotation, which is exactly what
 * rotating was supposed to escape. Old roots stay held (and stream-auth
 * registered) for chat history; only this fetch narrows.
 */
export function controlScope(
  community: CommunityV2,
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

/**
 * One community's Guestbook Plane on one relay. FORWARD-cursored, but the
 * cursor scope is keyed by the newest held epoch: a rejoin or rekey adoption
 * changes what the member can read, so the first sweep at the new epoch is a
 * full backfill — a cursor minted under the old read scope must never gate it.
 */
export function guestbookScope(
  community: CommunityV2,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return {
    scope: `guestbook:${community.idHex}@${community.rootEpoch}|${relayUrl}`,
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

/** Max unbroken main-thread time (ms) spent decrypting before yielding
 *  (mirrors chat.ts's DECODE_SLICE_MS — see the rationale there). */
const PLANE_DECODE_SLICE_MS = 5;

/**
 * Time-sliced {@link openPlaneWraps}: the same decrypt, but yields the event
 * loop whenever a slice has run past {@link PLANE_DECODE_SLICE_MS}. Each wrap
 * costs a NIP-44 open + Schnorr verify (+ a second NIP-44 open for encrypted
 * seals) — all synchronous noble crypto — so decoding a whole plane in one
 * unbroken loop freezes the UI for the duration on a phone.
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
   * Complete-mode budget: the most wraps one scope may pull in a single sweep.
   * Plane depth is attacker-controlled, so SOMETHING has to bound a routine
   * sweep — but the bound is a fixed event count, not a wall clock. A deadline
   * silently gives a member on fibre a deeper read than the same member on 4G
   * behind Tor, which turns "how much of the community do you see" into a
   * function of connection quality. A count is the same everywhere and can be
   * matched by other clients.
   *
   * Sized far above any honest compacted plane (a real one is hundreds of
   * editions), so hitting it means a flood, not a busy community.
   */
  maxEvents: 15_000,
  /**
   * Limit for the single wide ask that drains a same-second wall. Deliberately
   * far past a normal page: the question is not "give me a page of this
   * second", it is "hand over the whole second".
   */
  wallPage: 10_000,
  /**
   * Hard ceiling for an EXHAUSTIVE sweep. Exhaustive exists to pay whatever a
   * deep plane costs, but "pay anything" and "never terminate" are different
   * promises: without this, a relay serving unique junk forever hangs a
   * Refounding with no abort and an unbounded id set.
   */
  exhaustiveCeiling: 500_000,
  /**
   * Per-REQ deadline. Generous on purpose: a multi-hop VPN over Tor on one bar
   * of 4G is a supported way to use this, and a tight timeout there reads as a
   * dead relay rather than a slow one.
   */
  queryTimeoutMs: 25_000,
};

/** Test seam: shrink the page size so the pager is exercisable with few events. */
export function _configureSweepPagingForTests(cfg: Partial<typeof paging>): void {
  Object.assign(paging, cfg);
}

/**
 * Two-tier cadence knobs for COMPLETE scopes (see the module docstring).
 * Test seam via {@link _configureSweepCadenceForTests}.
 */
const cadence = {
  /** How long a clean full read licenses delta sweeps before the next full one. */
  fullSweepIntervalMs: 6 * 60 * 60_000,
  /** Overlap behind the floor's newest wrap (publisher clock skew — CORD-01
   *  wraps are not backdated, so skew is all the overlap has to cover). */
  deltaOverlapSecs: 3600,
};

/** Test seam: force every sweep full (`fullSweepIntervalMs: 0`) or pin the overlap. */
export function _configureSweepCadenceForTests(cfg: Partial<typeof cadence>): void {
  Object.assign(cadence, cfg);
}

/**
 * Per-scope delta floor for COMPLETE sweeps: the time of the last CLEAN full
 * read (not truncated, relay answered) and the newest wrap `created_at` seen.
 * SESSION-ONLY on purpose — persisting it would recreate the forward-cursor
 * starvation the module docstring forbids; losing it merely costs one full
 * re-read on the next launch, which is the launch's job anyway.
 */
const completeFloors = new Map<string, { fullAt: number; newest: number }>();

/**
 * Wrap ids a COMPLETE scope has already processed (decrypted or judged
 * garbage). Full-plane sweeps re-receive the same wraps every round — the
 * memo keeps repeat sweeps decrypt-free and `onFresh` quiet. Ids are global
 * (a wrap id is content-addressed), so the same wrap arriving from a second
 * relay is also deduped. Insertion-ordered, half-evicted at the cap.
 *
 * PERSISTED (foldedCache): an id is only noted after its decrypted rumor is
 * durably in the opened-event store (or it failed to decrypt under a held key
 * — permanent garbage, since every wrap here matched a held group's address),
 * and the folds re-read the store, so a cold launch can skip re-decrypting
 * the whole plane. A session-only memo made every relaunch re-pay the full
 * NIP-44+Schnorr pass over thousands of control wraps — the main-thread stall
 * on startup. Wiped with the rest of the fold cache on logout; an
 * evicted or lost id merely re-decrypts once.
 */
const seenCompleteWraps = new Set<string>();
const SEEN_WRAPS_CAP = 16_384;
const SEEN_WRAPS_KEY = "plane-seen-wraps";
/** Debounce for the persisted-memo write, so a sweep burst is one write. */
const SEEN_WRAPS_PERSIST_MS = 1_000;

/**
 * Wrap ids that were fetched and would NOT open. Persisted beside the memo:
 * the memo stops junk being re-decrypted, which would otherwise make the tally
 * read zero on every later sweep — blind on exactly the device that needs
 * telling, a returning admin looking at a standing flood.
 */
const junkWraps = new Set<string>();
const JUNK_WRAPS_KEY = "plane-junk-wraps";
/**
 * Capped like the seen-memo, and for a sharper reason: the set exists BECAUSE
 * someone may be pumping unlimited junk, so leaving it unbounded turns the
 * counter that detects a flood into a second, local flood.
 */
const JUNK_WRAPS_CAP = 4_096;

let seenWrapsLoaded: Promise<void> | undefined;
let seenWrapsPersistTimer: ReturnType<typeof setTimeout> | undefined;

/** Union the persisted memo into the session set (once per session). */
function loadSeenWraps(): Promise<void> {
  seenWrapsLoaded ??= Promise.all([readFolded<string[]>(SEEN_WRAPS_KEY), readFolded<string[]>(JUNK_WRAPS_KEY)])
    .then(([seen, junk]) => {
      if (seen) for (const id of seen) seenCompleteWraps.add(id);
      if (junk) for (const id of junk) junkWraps.add(id);
    })
    .catch(() => undefined);
  return seenWrapsLoaded;
}

function schedulePersistSeenWraps(): void {
  if (seenWrapsPersistTimer !== undefined) return;
  seenWrapsPersistTimer = setTimeout(() => {
    seenWrapsPersistTimer = undefined;
    void writeFolded(SEEN_WRAPS_KEY, [...seenCompleteWraps]);
    void writeFolded(JUNK_WRAPS_KEY, [...junkWraps]);
  }, SEEN_WRAPS_PERSIST_MS);
}

/**
 * Mark wrap ids as fetched-but-unopenable. Shared with the wire's control-wrap
 * ingest, which meets the same junk live: without this the sweep's tally reads
 * zero for anything the wire happened to see first, since the shared seen-memo
 * then stops it ever being re-attempted.
 */
export function notePlaneWrapsJunk(ids: string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) junkWraps.add(id);
  schedulePersistSeenWraps();
  if (junkWraps.size > JUNK_WRAPS_CAP) {
    let toDrop = junkWraps.size - JUNK_WRAPS_CAP / 2;
    for (const id of junkWraps) {
      if (toDrop-- <= 0) break;
      junkWraps.delete(id);
    }
  }
}

/**
 * Mark wrap ids as processed. Call only once their rumors are durably in the
 * opened-event store (or they failed under a held key). Shared with the
 * wire's control-wrap ingest path, so a wrap decrypted by either transport is
 * never re-decrypted by the other.
 */
export function notePlaneWrapsSeen(ids: string[]): void {
  const before = seenCompleteWraps.size;
  for (const id of ids) seenCompleteWraps.add(id);
  if (seenCompleteWraps.size > SEEN_WRAPS_CAP) {
    let toDrop = seenCompleteWraps.size - SEEN_WRAPS_CAP / 2;
    for (const id of seenCompleteWraps) {
      if (toDrop-- <= 0) break;
      seenCompleteWraps.delete(id);
    }
  }
  if (seenCompleteWraps.size !== before) schedulePersistSeenWraps();
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
  completeFloors.clear();
  if (seenWrapsPersistTimer !== undefined) {
    clearTimeout(seenWrapsPersistTimer);
    seenWrapsPersistTimer = undefined;
  }
  seenWrapsLoaded = Promise.resolve();
  void writeFolded(SEEN_WRAPS_KEY, []);
  void writeFolded(JUNK_WRAPS_KEY, []);
}

/**
 * Scope keys whose most recent COMPLETE sweep stopped on OUR OWN budget.
 * Module-level so a caller that JOINED an in-flight sweep can still read the
 * verdict after awaiting it — the joiner's own callbacks never fire.
 *
 * Deliberately NOT the inverse: there is no "this scope was read whole" flag,
 * because no client can establish that. A relay's page size is its own policy,
 * an empty answer is indistinguishable from a dropped REQ, and a relay
 * withholding the tail returns exactly what an exhausted one returns. Anything
 * built on inferred exhaustion is a guess wearing a proof's clothes.
 */
const scopeTruncated = new Map<string, boolean>();

/**
 * Verdict revision, bumped whenever a sweep invalidates or publishes one.
 *
 * The verdicts live in module maps that React cannot see. Their consumers'
 * other inputs (the opened-event store, the fold) all settle within a frame of
 * mount, while a sweep takes seconds — and on a warm launch, where every wrap
 * is already memoed, the event set never changes at all. Without a change
 * signal the watchdog would compute once, pre-sweep, and stay frozen at "no
 * sweep has run" forever: silent for exactly the returning admin it exists to
 * warn.
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
 * Whether the last control sweep of this community stopped short on ANY relay:
 * it hit the local event budget, or it stepped over a second too wide to ask
 * for in one go. Either way we KNOW there is plane we did not read.
 *
 * This is the only completeness claim the sweep makes, and it is a claim about
 * this client, not about the relays. It gates the three places where acting on
 * a partial picture is destructive — a Refounding's compaction, persisting a
 * cold fold as the durable baseline, and naming a member as an attacker.
 * Everywhere else, members fold what arrived and converge on later sweeps: the
 * plane is procedural, and the fold has its OWN completeness signal for what
 * actually matters — `incomplete` names floored entities the served editions
 * can't account for, a locally checkable fact rather than an inference about a
 * relay.
 */
export function controlSweepTruncated(community: CommunityV2): boolean {
  return community.relays.some((url) => scopeTruncated.get(controlScopeKey(community, url)) === true);
}

/**
 * Scope keys the last sweep actually got an answer from. Absent = never swept,
 * or every attempt threw.
 */
const scopeReached = new Set<string>();

/** How many of this community's relays answered the last control sweep. */
export function controlSweepReach(community: CommunityV2): { reached: number; total: number } {
  return {
    reached: community.relays.filter((url) => scopeReached.has(controlScopeKey(community, url))).length,
    total: community.relays.length,
  };
}

/**
 * Whether a MAJORITY of this community's relays answered the last control
 * sweep — `floor(n/2) + 1`, so 1-of-1, 2-of-2, 2-of-3, 3-of-4.
 *
 * A coverage heuristic, not a vote. Nothing here is decided by counting
 * relays: a relay that didn't answer isn't outvoted, its unique editions are
 * simply absent from the union. The real check on what we folded is
 * `FoldedControl.incomplete`, which names floored entities the served editions
 * can't account for and aborts a Refounding on its own. This sits on top of
 * that, because an entity we have NEVER seen leaves no floor to notice its
 * absence, and every publish here fans out best-effort (one ack is a success),
 * so an edition really can live on a single relay.
 *
 * Majority rather than unanimity because relays die permanently. Demanding
 * every one of them would wedge rotation on a stale list entry forever — the
 * same hostage shape as letting a flooder block it, just with a dead relay
 * holding the lever instead of an attacker. Two relays is the strict case
 * (2-of-2): with no redundancy there is none to spare.
 */
export function controlSweepQuorum(community: CommunityV2): boolean {
  const { reached, total } = controlSweepReach(community);
  return total > 0 && reached >= Math.floor(total / 2) + 1;
}

/**
 * Whether ANY relay answered the last control sweep — i.e. whether there is a
 * sweep to reason about at all.
 *
 * Deliberately the weakest gate available, and deliberately NOT conjoined with
 * `!controlSweepTruncated`. A short read is the loudest evidence of a flood
 * there is; suppressing the watchdog under one would hand the attacker a mute
 * button for the alert that describes them. What a short read forbids is
 * NAMING someone (see `controlSweepQuorum`), not reporting that the community
 * is being buried.
 */
export function controlSweepAnswered(community: CommunityV2): boolean {
  return community.relays.some((url) => scopeReached.has(controlScopeKey(community, url)));
}

/**
 * Wraps the last COMPLETE sweep fetched but could not open, per scope key.
 *
 * Undecryptable junk is the CHEAPEST way to inflate a plane — no encryption to
 * do, just a signature with a key every member holds — and it is invisible
 * downstream: it never becomes an opened event, so nothing that reads the store
 * can tell it exists. It still spends the fetch budget, so the sweep is the only
 * place that can count it.
 *
 * Counts wraps NOT already in the seen-memo, i.e. junk that ARRIVED this round,
 * which is what "someone is pumping garbage" looks like. A healthy plane is 0.
 */
const unreadableScopes = new Map<string, number>();

/**
 * The worst single relay's tally of unreadable wraps in this community's last
 * control sweep. Max, not sum: the same junk served by several relays is one
 * attack, not several.
 */
export function controlSweepUnreadable(community: CommunityV2): number {
  let worst = 0;
  for (const url of community.relays) {
    worst = Math.max(worst, unreadableScopes.get(controlScopeKey(community, url)) ?? 0);
  }
  return worst;
}

/**
 * Page a COMPLETE scope past the relay's per-filter limit, oldest-ward, until
 * a short page says the relay has no more to give or our own event budget runs
 * out.
 *
 * Pages STREAM to `onPage` and are then dropped; only wrap ids are retained,
 * for the cross-page dedupe. Plane depth is attacker-controlled (any member
 * holds the key that mints wraps), so a deep plane must cost bandwidth and
 * time, never heap — accumulating it here is how a flood becomes an OOM
 * instead of a slow sync.
 *
 * `truncated` means ONE thing: WE stopped — on `paging.maxEvents`, or over a
 * second wider than a single ask can drain. It is never an inference about the
 * relay. A relay's page size is its own
 * policy, an empty answer is indistinguishable from a dropped REQ, and a relay
 * withholding the tail answers exactly like an exhausted one — so "did I read
 * the whole plane" has no honest answer here, and nothing downstream is
 * allowed to depend on one.
 */
async function fetchCompleteScope(
  nostr: NostrLike,
  url: string,
  filter: NostrFilter,
  first: NostrEvent[],
  onPage: (page: NostrEvent[]) => Promise<void>,
  onTruncated?: () => void,
  exhaustive = false,
): Promise<{ total: number; truncated: boolean }> {
  // A relay's answer is NOT the filter we sent. Page one is demuxed by wrap
  // author upstream; every page after it must narrow the same way, or an
  // off-filter event can (a) drag the cursor below the rest of the plane and
  // (b) be memoed as processed, which permanently stops the wrap from ever
  // being decrypted — by this pager OR the live wire, since they share that
  // memo. The created_at bound is enforced for the same reason: a
  // legitimately-authored wrap answered outside the range we asked for would
  // otherwise drag the cursor past everything between.
  const wanted = new Set(filter.authors ?? []);
  const mine = (events: NostrEvent[], until: number) =>
    events.filter((e) => e.kind === KIND_WRAP && wanted.has(e.pubkey) && e.created_at <= until);

  const seen = new Set(first.map((e) => e.id));
  await onPage(first);
  if (first.length === 0) return { total: 0, truncated: false };

  // `until` is INCLUSIVE, so consecutive pages overlap by one timestamp on
  // purpose: the overlap is what steps over a same-second boundary instead of
  // skipping it, and the id dedupe makes it free.
  let cursor = Math.min(...first.map((e) => e.created_at));
  let full = first.length >= paging.pageLimit;
  /** We stepped over part of a second we could not page through. */
  let walled = false;

  while (full) {
    if (exhaustive && seen.size >= paging.exhaustiveCeiling) {
      logSync("sweep", `${url}: exhaustive read hit its ${paging.exhaustiveCeiling}-event ceiling`);
      onTruncated?.();
      return { total: seen.size, truncated: true };
    }
    if (!exhaustive && seen.size >= paging.maxEvents) {
      // Members get highest-reasonable-effort, not a guarantee: fold what
      // arrived and converge on later sweeps. Only a Refounding (which reads
      // exhaustively) may not proceed on a short read.
      logSync("sweep", `${url}: hit the ${paging.maxEvents}-event sweep budget; older plane left for a later round`);
      onTruncated?.();
      return { total: seen.size, truncated: true };
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
      // A full page that didn't move the cursor: every event in it sits AT
      // `cursor`, and `until` is inclusive, so asking again returns the same
      // block forever. That is a same-second wall — more wraps at one
      // timestamp than a page holds, and the cheapest way to stall a pager,
      // since a wrap's created_at is the publisher's to choose. Ask for the
      // whole second in one go.
      const drained = mine(
        await nostr.relay(url).query([{ ...filter, since: cursor, until: cursor, limit: paging.wallPage }], {
          signal: AbortSignal.timeout(paging.queryTimeoutMs),
        }),
        cursor,
      );
      const stillNew = drained.filter((e) => !seen.has(e.id));
      for (const e of stillNew) seen.add(e.id);
      if (stillNew.length > 0) await onPage(stillNew);

      // Did that ask actually EMPTY the second? The answer is only credible in
      // one narrow band: strictly more than a normal page (so the relay is not
      // simply capping us at its usual limit and calling it a second) and
      // strictly fewer than we asked for (so it stopped because it ran out,
      // not because it hit our ceiling).
      //
      // Outside that band we cannot tell "the second holds exactly this" from
      // "the relay will not serve more of it" — a relay capped at 500 answers
      // a 10,000 request with 500 either way. Checking only against the limit
      // we asked for reads that capped relay as a drained one and loses the
      // remainder with NO signal, which is worse than the stall it replaced.
      //
      // Either way the cursor steps below the second: a repeat of the widest
      // ask we can make cannot return more than it just did.
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
 * Run one relay's batch: one filter per scope (cursor-gated for forward
 * scopes, whole-plane for complete ones), ONE query, demuxed by wrap author.
 * Retries once on failure (cursors stay put so the next sweep re-asks). Not
 * abortable by callers — the REQ is shared.
 */
async function runScopes(
  nostr: NostrLike,
  url: string,
  scopes: PlaneScope[],
): Promise<Map<string, OpenedEvent[]>> {
  // The persisted seen-wrap memo must be in the session set before the
  // complete-scope narrowing below, or a cold launch re-decrypts everything.
  await loadSeenWraps();
  // A Refounded control scope whose snapshot id-set has gone missing must
  // re-ingest the plane WITHOUT the seen-memo narrowing. The set is recorded
  // only when a wrap is fresh (`noteControlSnapshot` via writeOpened), so once
  // every wrap is memoed a lost set can never be re-recorded by an ordinary
  // sweep — and the fold then anchors a Refounded community on an empty
  // snapshot, outranking nothing. The set is per-KV-key and unguarded (it can
  // be pruned by another account's warm-up, or simply lost), while the memo is
  // global and persisted; only re-decrypting the plane reunites them. Known
  // junk stays skipped — it never opened, so it never fed the set.
  const rebuildSnapshot = await Promise.all(
    scopes.map(async (s) => {
      if (!s.complete || !s.refounded || s.groups.length === 0) return false;
      return !(await readControlSnapshot(s.communityIdHex, s.groups[0].pk));
    }),
  );
  const cursors = await Promise.all(
    scopes.map((s) => (s.complete ? undefined : readStreamCursor(s.scope))),
  );
  // COMPLETE scopes: a fresh session floor licenses a short-overlap delta
  // read; anything else — no floor, an aged floor, a snapshot rebuild, an
  // exhaustive read — re-fetches the whole plane (see the module docstring).
  const deltaSince = scopes.map((s, i) => {
    if (!s.complete || s.exhaustive || rebuildSnapshot[i]) return undefined;
    const floor = completeFloors.get(s.scope);
    if (!floor || floor.newest <= 0) return undefined;
    if (Date.now() - floor.fullAt >= cadence.fullSweepIntervalMs) return undefined;
    return Math.max(0, floor.newest - cadence.deltaOverlapSecs);
  });
  const filters: NostrFilter[] = scopes.map((s, i) => ({
    kinds: [KIND_WRAP],
    authors: s.groups.map((g) => g.pk),
    limit: paging.pageLimit,
    ...(s.complete
      ? deltaSince[i] !== undefined ? { since: deltaSince[i] } : {}
      : cursors[i]?.newest ? { since: cursors[i]!.newest } : {}),
  }));
  const out = new Map<string, OpenedEvent[]>(scopes.map((s) => [s.scope, []]));

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    // Invalidate at the TOP of each attempt, never once per call: a sweep that
    // throws must leave no verdict standing (or the next caller reads a stale
    // "reached, not truncated" and acts on a picture this sweep never
    // established), and a retry must not stack its junk tally on the partial
    // one attempt 1 left behind, nor inherit its truncation.
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
      // A kind-1059 REQ that raced NIP-42 is CLOSED by the relay and reads back
      // as a clean empty page. Re-ask once behind the gate rather than record
      // that silence as an answer.
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
        // Kind as well as author: a relay that ignores `kinds` could otherwise
        // hand page one an off-kind event signed with the (member-derivable)
        // plane key, and the pager's `until` cursor would start below it.
        if (ev.kind !== KIND_WRAP) continue;
        const i = scopeByPk.get(ev.pubkey);
        if (i !== undefined) perScope[i].push(ev);
      }

      const freshPerScope: OpenedEvent[][] = scopes.map(() => []);
      const totals: number[] = scopes.map((_, i) => perScope[i].length);
      // Newest wrap per scope, read off page one (relays answer newest-first)
      // BEFORE the complete-mode pager consumes it — this is what advances the
      // session delta floor.
      const newestPerScope = perScope.map((evs) =>
        evs.length > 0 ? Math.max(...evs.map((e) => e.created_at)) : undefined,
      );

      // A complete scope STREAMS: decrypt (time-sliced — a cold plane is
      // thousands of synchronous EC ops), store and memo each page, then drop
      // it. The folds read the opened-event store, not this sweep's result, so
      // no page needs to outlive its own iteration.
      for (const [i, s] of scopes.entries()) {
        if (!s.complete) continue;
        const ingest = async (page: NostrEvent[]) => {
          // Narrow by the memo BEFORE advancing it, or nothing ever decrypts.
          const fresh = rebuildSnapshot[i]
            ? page.filter((w) => !junkWraps.has(w.id))
            : page.filter((w) => !seenCompleteWraps.has(w.id));
          const opened = await openPlaneWrapsChunked(fresh, s.groups);
          // Anything attempted that didn't open is junk, remembered so later
          // sweeps can still count it without re-attempting the decrypt.
          const openedIds = new Set(opened.map((e) => e.wrapId));
          notePlaneWrapsJunk(fresh.filter((w) => !openedIds.has(w.id)).map((w) => w.id));
          // Tally over the WHOLE page, from what is known junk — not just this
          // page's new arrivals, or a standing flood would count once and then
          // read zero forever.
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
          // Only the memo advances, and only once the rumors are durably
          // stored — every sweep re-asks for the whole plane, so nothing
          // received can ever become unreachable.
          //
          // Which is exactly why the write's outcome is checked. The memo is
          // what stops a later sweep re-decrypting these wraps, so advancing it
          // over a failed write would leave rumors that never reached the store
          // and are never opened again — the one way a completely-swept plane
          // can lose an event.
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

      // Forward scopes stay one batch — their `since` already narrowed them —
      // then one store write PER COMMUNITY and parallel cursor advances.
      //
      // Per community, not one write for the batch: a relay batch deliberately
      // coalesces scopes from every community that shares this relay (see
      // `enqueue`), so `forwardFresh` is a mixed bag and each community's
      // events have to land in their own tenant. Bucketing keeps it at one
      // write per community rather than one per scope — and a community's
      // guestbook scopes for different relays are different batches anyway, so
      // in practice that is still a single write.
      //
      // Bucketed per (community, PLANE): the write is the plane boundary, so a
      // batch that coalesced two planes' scopes must not hand them to one call
      // — the wrong plane's rules would decide what may be stored.
      const forwardFresh = new Map<
        string,
        { communityIdHex: string; plane: Plane; refounded: boolean; fresh: OpenedWireEvent[] }
      >();
      for (const [i, s] of scopes.entries()) {
        if (s.complete) continue;
        for (const e of await openPlaneWrapsChunked(perScope[i], s.groups)) {
          freshPerScope[i].push(e);
          const key = `${s.communityIdHex}|${s.plane}`;
          const bucket = forwardFresh.get(key);
          if (bucket) bucket.fresh.push(e);
          else {
            forwardFresh.set(key, {
              communityIdHex: s.communityIdHex,
              plane: s.plane,
              refounded: s.refounded,
              fresh: [e],
            });
          }
        }
      }
      await Promise.all(
        [...forwardFresh.values()].map(({ communityIdHex, plane, refounded, fresh }) =>
          writeOpened(communityIdHex, fresh, plane, { refounded }),
        ),
      );
      await Promise.all(
        scopes.map((s, i) => {
          logSync(
            "sweep",
            `${s.scope} → ${totals[i]} event(s), ${freshPerScope[i].length} new in ${sinceMs(started)} (${s.complete ? "full" : `since=${cursors[i]?.newest ?? "∅"}`}, authors×${s.groups.length})`,
          );
          if (s.complete) return undefined; // memoed per page above
          const mine = perScope[i];
          if (mine.length === 0) return undefined;
          return updateStreamCursor(s.scope, { newest: Math.max(...mine.map((e) => e.created_at)) });
        }),
      );
      for (const [i, s] of scopes.entries()) {
        // An empty answer from a relay whose stream AUTHs are still unacked is
        // a CLOSED read, not an exhausted plane — believing it would let the
        // Refounding gate pass on a relay that gave us nothing.
        if (s.complete && (authSettled || totals[i] > 0)) {
          scopeReached.add(s.scope);
          s.onReached?.();
          // Advance the session delta floor: a CLEAN full read (re)establishes
          // the baseline; a truncated one establishes nothing (older plane went
          // unread — the next sweep must re-ask whole); a delta read only
          // raises the floor's high-water mark.
          const prior = completeFloors.get(s.scope);
          const newest = Math.max(newestPerScope[i] ?? 0, prior?.newest ?? 0);
          if (deltaSince[i] === undefined) {
            if (scopeTruncated.get(s.scope) === true) completeFloors.delete(s.scope);
            else completeFloors.set(s.scope, { fullAt: Date.now(), newest });
          } else if (prior) {
            completeFloors.set(s.scope, { fullAt: prior.fullAt, newest });
          }
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
      // Pause, then re-check the auth gate before the retry: a first round
      // lost to a lazy NIP-42 challenge (REQ → CLOSED auth-required → AUTHs
      // sent) passes once the relay has acked the stream AUTHs.
      await new Promise((r) => setTimeout(r, 250));
      await whenAuthReady(url, () => scopes.flatMap((s) => s.groups));
    }
  }
  return out;
}

/** In-flight sweeps by cursor scope (see the single-flight docstring). */
const inflight = new Map<string, Promise<OpenedEvent[]>>();

/** Extra enrollment time for an OPEN gate, so same-render callers coalesce. */
const BATCH_WINDOW_MS = 50;

/** A per-relay batch collecting scopes until the auth gate opens. */
interface RelayBatch {
  scopes: PlaneScope[];
  closed: boolean;
  promise: Promise<Map<string, OpenedEvent[]>>;
}
const batches = new Map<string, RelayBatch>();

/** Build and register a fresh batch; its promise resolves after the auth gate. */
function newBatch(nostr: NostrLike, url: string): RelayBatch {
  const b: RelayBatch = { scopes: [], closed: false, promise: Promise.resolve(new Map()) };
  b.promise = (async () => {
    // The whole batch lifetime — enrollment window, NIP-42 auth gate, the REQ
    // itself — counts as sync activity (the auth hold alone can be seconds).
    const task = beginSyncTask("community updates");
    try {
      await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));
      await whenAuthReady(url, () => b.scopes.flatMap((s) => s.groups));
      b.closed = true;
      if (batches.get(url) === b) batches.delete(url);
      return await runScopes(nostr, url, b.scopes);
    } finally {
      task.end();
    }
  })();
  batches.set(url, b);
  return b;
}

/**
 * Single-flight identity. NOT the scope key: an exhaustive sweep must never
 * JOIN a budgeted one already in flight, or a Refounding silently inherits a
 * capped read of the very plane it is about to compact — the disclosed attack,
 * arriving through the fix for it.
 */
const flightKey = (s: PlaneScope) => (s.exhaustive ? `${s.scope}|exhaustive` : s.scope);

/** Enroll one scope into the relay's open batch (creating one if needed). */
function enqueue(nostr: NostrLike, url: string, scope: PlaneScope): Promise<OpenedEvent[]> {
  const batch = batches.get(url);
  const b = batch && !batch.closed ? batch : newBatch(nostr, url);
  // One entry per scope key per batch. A budgeted and an exhaustive request for
  // the same plane land here together (they deliberately don't share a flight),
  // and running both would have them race to publish the scope's verdict.
  // Collapse to the stronger read and fan the callbacks out from it.
  const twin = b.scopes.find((s) => s.scope === scope.scope);
  if (twin) {
    twin.exhaustive = twin.exhaustive || scope.exhaustive;
    const priorFresh = twin.onFresh;
    const priorTruncated = twin.onTruncated;
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
 * Sweep a set of scopes on ONE relay. Scopes already in flight (any caller)
 * are JOINED, not re-fetched — the joiner still gets the scope's fresh events
 * and its own `onFresh`. New scopes enroll in the relay's open batch behind
 * the auth gate and leave as one REQ (see module docstring).
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
  community: CommunityV2,
  scopeOf: typeof controlScope,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  const results = await Promise.all(
    community.relays.map((url) => sweepRelayScopes(nostr, url, [scopeOf(community, url, opts?.onFresh)])),
  );
  return mergeOpened(...results.map((m) => [...m.values()].flat()));
}

/**
 * Sweep one community's Control Plane (editions across held epochs).
 * `exhaustive` pages to the end of the plane however deep it is — for the
 * Refounding path, which may only compact what it has read whole.
 */
export function sweepControl(
  nostr: NostrLike,
  community: CommunityV2,
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

/** Sweep one community's Guestbook Plane (membership motions). */
export function sweepGuestbook(
  nostr: NostrLike,
  community: CommunityV2,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  return sweepCommunityPlane(nostr, community, guestbookScope, opts);
}
