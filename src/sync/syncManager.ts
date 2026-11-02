/**
 * Sync scheduler: hooks declare interest in a TOPIC (a wire-bus scope string
 * like `c2:<channelIdHex>`) and read the local store; this alone decides when
 * a topic's handler (registered per key prefix) hits the network. Results
 * reach readers via the wire bus.
 *
 * Centralizes throttles (`minIntervalMs` floor, `staleAfterMs` re-run age),
 * durable freshness stamps in KV (`sync-fresh:<topic>`, surviving remounts and
 * relaunches), and scheduling (single-flight, lane capacity, paused while
 * hidden or boot-gated).
 *
 * Readers: skeleton iff the local read was empty AND the topic never settled.
 * A want for an unregistered topic idles until `registerSyncTopic` re-schedules.
 */
import { isBackgroundQuiet, onBackgroundQuiet } from "@/lib/backgroundQuiet";
import { isBootGateOpen, onBootGateOpen } from "@/lib/bootGate";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { isMeteredNetwork, onMeteredNetworkChange } from "@/lib/meteredNetwork";
import { logSync } from "@/lib/syncLog";

export type SyncPriority = "visible" | "background" | "prefetch";

export type SyncStatus = "idle" | "pending" | "settled" | "error";

export interface SyncState {
  status: SyncStatus;
  /** When this topic's last run completed (ms epoch), if ever. Durable. */
  lastSyncedAt?: number;
}

export interface SyncCtx {
  topic: string;
  /** Aborted when the last interest releases (component unmounts). */
  signal: AbortSignal;
}

export interface TopicPolicy {
  /** Hard floor between two runs of one topic, however demanded. */
  minIntervalMs: number;
  /** Stamp age before a standing interest re-runs the topic. */
  staleAfterMs: number;
  /** Fetch and write into ArmadaDB. Results reach readers via the wire bus. */
  handler: (ctx: SyncCtx) => Promise<void>;
  /** Deferrable bulk work: held (and an in-flight run aborted) while the connection is metered. */
  unmeteredOnly?: boolean;
  /**
   * Share of wall time (0..1] the prefix's topics may spend running, TOGETHER:
   * after a run of `d` ms, none of them starts for `d × (1/duty − 1)`. Per-topic
   * `minIntervalMs` can't bound bulk work fanned out over many topics, which
   * would otherwise run back to back. Self-scaling: a slower device rests longer.
   */
  dutyCycle?: number;
}

export interface WantOpts {
  /** Bypass the staleness check once (still subject to `minIntervalMs`). */
  force?: boolean;
}

/** How many `visible`-priority topics may run concurrently. */
const MAX_VISIBLE_RUNS = 3;
/** How many `background`/`prefetch` topics may run concurrently (combined). */
const MAX_DEFERRED_RUNS = 1;
/** Ceiling on the failure backoff. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** Floor on any scheduled wake-up, coalescing bursts of near-term deadlines. */
const MIN_WAKE_MS = 50;

const PRIORITY_RANK: Record<SyncPriority, number> = { visible: 2, background: 1, prefetch: 0 };

const IDLE: SyncState = Object.freeze({ status: "idle" });

interface Want {
  priority: SyncPriority;
}

interface TopicRuntime {
  wants: Set<Want>;
  run?: { controller: AbortController; priority: SyncPriority; startedAt: number };
  /** Min-interval / failure-backoff floor: no run starts before this. */
  nextEligibleAt: number;
  failures: number;
  /** One-shot staleness bypass, consumed by the next run. */
  forced: boolean;
  /** Published snapshot. Replaced, never mutated (useSyncExternalStore). */
  state: SyncState;
  listeners: Set<() => void>;
}

/** Registered policies, by topic-key prefix. Longest matching prefix wins. */
const policies = new Map<string, TopicPolicy>();

const topics = new Map<string, TopicRuntime>();

/** Per duty-cycled policy, when its topics may run again (ms epoch). */
const restUntil = new Map<TopicPolicy, number>();

/**
 * Durable freshness stamps. NOT account-scoped: topics name
 * account-independent data, so a switch inherits stamps at most skipping a
 * round. Per-account freshness (read sets, DM inbox) must put the account in
 * the topic key.
 */
const stamps = new KvPrefixCache<number>({ prefix: "sync-fresh:" });

/**
 * Whether the stamp warm has SETTLED; a failed warm degrades to syncing, never
 * to wrongly skipping.
 */
let stampsSettled = false;

let wired = false;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The deadline the armed timer targets (ms epoch); Infinity when none. */
let timerAt = Infinity;
let scheduleQueued = false;

/** Coalesce scheduler passes to one per microtask (per-row wants mount in bursts). */
function requestSchedule(): void {
  if (scheduleQueued) return;
  scheduleQueued = true;
  queueMicrotask(() => {
    scheduleQueued = false;
    schedule();
  });
}

/** Register the handler for a topic-key prefix (e.g. `"c2:"`). */
export function registerSyncTopic(prefix: string, policy: TopicPolicy): void {
  policies.set(prefix, policy);
  requestSchedule();
}

/** Declare interest in a topic; the last release aborts any in-flight run. */
export function want(topic: string, priority: SyncPriority = "visible", opts?: WantOpts): () => void {
  ensureWired();
  const rt = runtime(topic);
  const token: Want = { priority };
  rt.wants.add(token);
  if (opts?.force) rt.forced = true;
  // A higher-priority want upgrades an in-flight run's lane.
  if (rt.run && PRIORITY_RANK[priority] > PRIORITY_RANK[rt.run.priority]) {
    rt.run.priority = priority;
  }
  // Publish `pending` SYNCHRONOUSLY so an empty read renders as "catching up"
  // (never authoritative empty) until the topic settles. Skipped with no policy
  // or when a fresh stamp/error already stands.
  if (rt.state.status === "idle" && policyFor(topic) !== undefined) {
    publish(topic, rt, "pending");
  }
  requestSchedule();
  return () => {
    if (!rt.wants.delete(token)) return;
    if (rt.wants.size === 0) {
      if (rt.run) {
        rt.run.controller.abort();
      } else if (rt.state.status === "pending") {
        // Nothing in flight: resolve the optimistic pending.
        publish(topic, rt, stamps.get(topic) === undefined ? "idle" : "settled");
      }
      rt.forced = false;
    }
    requestSchedule();
  };
}

/** Mark a topic stale NOW (only the min-interval floor applies); no-op if never wanted. */
export function invalidateSyncTopic(topic: string): void {
  const rt = topics.get(topic);
  if (!rt) return;
  rt.forced = true;
  requestSchedule();
}

/** The topic's current state. Stable snapshot identity between changes. */
export function syncState(topic: string): SyncState {
  return topics.get(topic)?.state ?? IDLE;
}

/** Re-render on state change. Returns an unsubscribe. */
export function onSyncState(topic: string, listener: () => void): () => void {
  const rt = runtime(topic);
  rt.listeners.add(listener);
  return () => {
    rt.listeners.delete(listener);
  };
}

function runtime(topic: string): TopicRuntime {
  let rt = topics.get(topic);
  if (!rt) {
    const stamp = stamps.get(topic);
    rt = {
      wants: new Set(),
      nextEligibleAt: 0,
      failures: 0,
      forced: false,
      state: stamp === undefined ? IDLE : { status: "idle", lastSyncedAt: stamp },
      listeners: new Set(),
    };
    topics.set(topic, rt);
  }
  return rt;
}

function publish(topic: string, rt: TopicRuntime, status: SyncStatus): void {
  const lastSyncedAt = stamps.get(topic);
  if (rt.state.status === status && rt.state.lastSyncedAt === lastSyncedAt) return;
  rt.state = lastSyncedAt === undefined ? { status } : { status, lastSyncedAt };
  for (const listener of [...rt.listeners]) {
    try {
      listener();
    } catch {
      // a listener must never break the scheduler
    }
  }
}

function policyFor(topic: string): TopicPolicy | undefined {
  let best: TopicPolicy | undefined;
  let bestLen = -1;
  for (const [prefix, policy] of policies) {
    if (prefix.length > bestLen && topic.startsWith(prefix)) {
      best = policy;
      bestLen = prefix.length;
    }
  }
  return best;
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  void stamps.ready().finally(() => {
    stampsSettled = true;
    requestSchedule();
  });
  // Stamp changes update published snapshots and re-evaluate staleness.
  stamps.subscribe(() => {
    for (const [topic, rt] of topics) publish(topic, rt, rt.state.status);
    requestSchedule();
  });
  onBootGateOpen(requestSchedule);
  onBackgroundQuiet(() => {
    if (isBackgroundQuiet()) suspendRuns(() => true);
    requestSchedule();
  });
  onMeteredNetworkChange(() => {
    if (isMeteredNetwork()) suspendRuns((topic) => policyFor(topic)?.unmeteredOnly === true);
    requestSchedule();
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", requestSchedule);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", requestSchedule);
    window.addEventListener("online", requestSchedule);
  }
}

/** Set by {@link haltSyncManager}; only a reload clears it. */
let halted = false;

/**
 * Abort every run and start no more: logout's purge calls this first, so no
 * round decrypts or writes into the store it is emptying. One-way; the page
 * reloads after.
 */
export function haltSyncManager(): void {
  halted = true;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  timerAt = Infinity;
  for (const rt of topics.values()) rt.run?.controller.abort();
}

/** Whether {@link haltSyncManager} ran: a handler's late write must not land. */
export function syncHalted(): boolean {
  return halted;
}

/**
 * Going quiet (or metered) stops in-flight runs too, not just new ones: a history
 * round pages on for minutes over a radio the native service is otherwise letting
 * sleep. An abort leaves no stamp, and `forced` re-runs each topic once allowed.
 */
function suspendRuns(match: (topic: string) => boolean): void {
  for (const [topic, rt] of topics) {
    if (!rt.run || !match(topic)) continue;
    rt.forced = true;
    rt.run.controller.abort();
  }
}

function paused(): boolean {
  if (halted) return true;
  if (!isBootGateOpen()) return true;
  if (!stampsSettled) return true;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  // Android WebView `visibilityState` is unreliable when backgrounded (see backgroundQuiet.ts).
  if (isBackgroundQuiet()) return true;
  return false;
}

function topicPriority(rt: TopicRuntime): SyncPriority {
  let best: SyncPriority = "prefetch";
  for (const w of rt.wants) {
    if (PRIORITY_RANK[w.priority] > PRIORITY_RANK[best]) best = w.priority;
  }
  return best;
}

/** When this topic is next allowed AND due to run. */
function dueAt(topic: string, rt: TopicRuntime, policy: TopicPolicy): number {
  const floor = Math.max(rt.nextEligibleAt, restUntil.get(policy) ?? 0);
  if (rt.forced) return floor;
  const stamp = stamps.get(topic) ?? 0;
  return Math.max(floor, stamp + policy.staleAfterMs);
}

/** Scheduler pass: start due topics within capacity, answer fresh wants, arm one timer. Idempotent. */
function schedule(): void {
  if (paused()) return; // re-nudged by the gate / warm / visibility listeners

  const now = Date.now();
  let visibleRuns = 0;
  let deferredRuns = 0;
  for (const rt of topics.values()) {
    if (!rt.run) continue;
    if (rt.run.priority === "visible") visibleRuns++;
    else deferredRuns++;
  }

  interface Candidate {
    topic: string;
    rt: TopicRuntime;
    policy: TopicPolicy;
    priority: SyncPriority;
    at: number;
  }
  const candidates: Candidate[] = [];
  const metered = isMeteredNetwork();
  for (const [topic, rt] of topics) {
    if (rt.wants.size === 0 || rt.run) continue;
    const policy = policyFor(topic);
    if (!policy) continue;
    if (policy.unmeteredOnly && metered) continue; // re-nudged by the connection listener
    candidates.push({ topic, rt, policy, priority: topicPriority(rt), at: dueAt(topic, rt, policy) });
  }
  candidates.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.at - b.at);

  let nextWake = Infinity;
  for (const c of candidates) {
    if (c.at > now) {
      nextWake = Math.min(nextWake, c.at);
      // Fresh enough: that ANSWERS the want. Error states wait for the backoff.
      if (c.rt.state.status === "idle" || c.rt.state.status === "pending") {
        if (stamps.get(c.topic) !== undefined) publish(c.topic, c.rt, "settled");
      }
      continue;
    }
    const visibleLane = c.priority === "visible";
    if (visibleLane ? visibleRuns >= MAX_VISIBLE_RUNS : deferredRuns >= MAX_DEFERRED_RUNS) {
      // Capacity-blocked; the finishing run's schedule() picks it up.
      publish(c.topic, c.rt, "pending");
      continue;
    }
    if (visibleLane) visibleRuns++;
    else deferredRuns++;
    startRun(c.topic, c.rt, c.policy, c.priority);
  }

  // Re-arm only when the deadline moved EARLIER (clear/set per pass dominated profiles).
  if (nextWake < Infinity) {
    const fireAt = now + Math.max(MIN_WAKE_MS, nextWake - now);
    if (fireAt < timerAt) {
      clearTimeout(timer);
      timerAt = fireAt;
      timer = setTimeout(() => {
        timer = undefined;
        timerAt = Infinity;
        schedule();
      }, fireAt - now);
    }
  }
}

function startRun(topic: string, rt: TopicRuntime, policy: TopicPolicy, priority: SyncPriority): void {
  const controller = new AbortController();
  rt.run = { controller, priority, startedAt: Date.now() };
  rt.forced = false;
  publish(topic, rt, "pending");
  policy.handler({ topic, signal: controller.signal }).then(
    () => finishRun(topic, rt, policy, true),
    (err) => finishRun(topic, rt, policy, false, err),
  );
}

function finishRun(
  topic: string,
  rt: TopicRuntime,
  policy: TopicPolicy,
  ok: boolean,
  err?: unknown,
): void {
  const aborted = rt.run?.controller.signal.aborted ?? false;
  // Aborted runs did their work too, so they rest the prefix just the same.
  if (rt.run && policy.dutyCycle !== undefined && policy.dutyCycle > 0 && policy.dutyCycle < 1) {
    const now = Date.now();
    const rest = (now - rt.run.startedAt) * (1 / policy.dutyCycle - 1);
    restUntil.set(policy, Math.max(restUntil.get(policy) ?? 0, now + rest));
  }
  rt.run = undefined;
  if (aborted) {
    // Torn down: no verdict, no stamp, and no floor penalty for a remount.
    publish(topic, rt, stamps.get(topic) === undefined ? "idle" : "settled");
  } else if (ok) {
    rt.failures = 0;
    rt.nextEligibleAt = Date.now() + policy.minIntervalMs;
    stamps.set(topic, Date.now());
    publish(topic, rt, "settled");
  } else {
    rt.failures++;
    // Trace it, or handler-contract bugs look like dead relays.
    logSync(
      "sync",
      `topic ${topic} failed (attempt ${rt.failures}): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
    // Not scaled by `minIntervalMs` (a success-spacing rule): retry in seconds.
    rt.nextEligibleAt = Date.now() + Math.min(1000 * 2 ** rt.failures, MAX_BACKOFF_MS);
    publish(topic, rt, "error");
  }
  requestSchedule();
}

/** Test seam: drop all scheduler state (KV stamps are cleared by purge / `resetKvCaches`). */
export function _resetSyncManagerForTests(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  timerAt = Infinity;
  halted = false;
  for (const rt of topics.values()) rt.run?.controller.abort();
  topics.clear();
  policies.clear();
  restUntil.clear();
}
