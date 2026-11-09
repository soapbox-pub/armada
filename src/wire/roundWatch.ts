/**
 * The wire round's liveness watchdog, as a pure decision (see WireSync).
 */
import type { NostrFilter } from "@nostrify/nostrify";

/**
 * Watchdog for a fresh REQ round: a healthy relay answers (events or EOSE)
 * well within this. A silent round is presumed swallowed (wedged AUTH,
 * half-open socket) and re-issued; otherwise `for await` blocks forever.
 */
export const SILENT_REQ_TIMEOUT_MS = 30_000;
/**
 * Quiet this long, an established round's socket is probed with a REQ that
 * matches nothing: a half-open socket never answers it, and the round is
 * re-issued. Cheaper than re-issuing on a timer, which re-sends every filter
 * (Git ones are tens of KB) and replays the overlap. Inside the ~60s idle
 * timeout some relays (the Git ones) close quiet sockets with, so the probe
 * also keeps those from being redialed and re-subscribed.
 */
export const QUIET_PROBE_MS = 45_000;
/** How long a liveness probe may go unanswered. */
export const PROBE_TIMEOUT_MS = 20_000;
/**
 * Backstop for a sub a relay drops without CLOSED, which a probe on the socket
 * can't see: a quiet round this old is re-issued from the cursor (lossless).
 */
export const QUIET_ROTATE_MS = 15 * 60_000;
/** The probe filter: no event has this id, so the answer is a bare EOSE. */
export const PROBE_FILTER: NostrFilter = { ids: ["0".repeat(64)], limit: 1 };
/** What a round's watchdog does on one tick. */
export type RoundWatch = "none" | "reissue" | "rotate" | "probe";

/**
 * The round watchdog's decision: a round that never answered is re-issued; an
 * established one quiet past {@link QUIET_PROBE_MS} gets a liveness probe, and
 * one that has also run past {@link QUIET_ROTATE_MS} is rotated instead.
 */
export function roundWatch(now: number, startedAt: number, lastMsgAt: number, sawAnything: boolean, probing: boolean): RoundWatch {
  const silentFor = now - lastMsgAt;
  if (!sawAnything) return silentFor >= SILENT_REQ_TIMEOUT_MS ? "reissue" : "none";
  if (silentFor < QUIET_PROBE_MS) return "none";
  if (now - startedAt >= QUIET_ROTATE_MS) return "rotate";
  return probing ? "none" : "probe";
}

/** Quiet the spec must keep before a running loop takes changed filters. */
export const SPEC_SETTLE_MS = 1_500;
/**
 * The same for a change that only widens the filters: the spec filling in at boot, whose
 * every millisecond of settling is a millisecond those streams go unsubscribed.
 */
export const SPEC_WIDEN_SETTLE_MS = 150;
/** Longest a running loop waits on a spec that keeps changing. */
export const SPEC_SETTLE_MAX_MS = 5_000;

/**
 * When a running loop with changed filters restarts: `true` now, else the time
 * to look again. Each change pushes the restart SPEC_SETTLE_MS out
 * (SPEC_WIDEN_SETTLE_MS when every change only widens), never past
 * SPEC_SETTLE_MAX_MS after the first. A re-run at or after the due time (the
 * timer firing) restarts.
 */
export function settleDue(firstAt: number, dueAt: number | undefined, now: number, widening = false): true | number {
  const cap = firstAt + SPEC_SETTLE_MAX_MS;
  if (now >= cap || (dueAt !== undefined && now >= dueAt)) return true;
  return Math.min(cap, now + (widening ? SPEC_WIDEN_SETTLE_MS : SPEC_SETTLE_MS));
}

/** Whether `next` asks for everything `prev` did: each old filter is covered by a new one. */
export function filtersWiden(next: readonly NostrFilter[], prev: readonly NostrFilter[]): boolean {
  return prev.every((old) => next.some((f) => filterCovers(f, old)));
}

/** Same fields, each array a superset of the old one's and every other value equal. */
function filterCovers(f: NostrFilter, old: NostrFilter): boolean {
  const a = f as Record<string, unknown>;
  const b = old as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) && Array.isArray(y)) {
      const have = new Set(x.map((v) => JSON.stringify(v)));
      if (!y.every((v) => have.has(JSON.stringify(v)))) return false;
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      return false;
    }
  }
  return true;
}
