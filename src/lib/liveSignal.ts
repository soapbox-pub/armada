import { clockNowMs } from "@/lib/relayClock";

/**
 * How far a short-lived signal's own date (typing, …) may sit from the corrected clock
 * and still be taken as live: CORD-07 §4's bounds for a presence. Inside them it is
 * timed from when it ARRIVED, so a sender whose clock is off is neither aged out on
 * arrival nor kept on past its window; outside them it is a replay or a squat.
 */
export const SIGNAL_AHEAD_MS = 60_000;
export const SIGNAL_BEHIND_MS = 5 * 60_000;

/** Whether a signal dated `ms` can be live now. */
export function isPlausiblyLive(ms: number, nowMs: number = clockNowMs()): boolean {
  return ms <= nowMs + SIGNAL_AHEAD_MS && ms >= nowMs - SIGNAL_BEHIND_MS;
}

/** A live-signal subscription's `since`: far enough back that a relay still forwards a slow sender's. */
export function liveSignalSince(nowMs: number = clockNowMs()): number {
  return Math.floor((nowMs - SIGNAL_BEHIND_MS) / 1000);
}
