import { useEffect, useSyncExternalStore } from "react";

import { nextMuteExpiry, type MuteRecords } from "@/lib/notifRecords";
import { clockNowMs, nowSecs } from "@/lib/relayClock";

/** `setTimeout`'s ceiling — anything larger fires immediately, so long waits re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647;

// Module-wide, so every caller shares one timer and one notion of "now".
let now = nowSecs();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let armedFor: number | undefined;

function advance(): void {
  const current = nowSecs();
  if (current === now) return;
  now = current;
  for (const listener of listeners) listener();
}

function arm(at: number | undefined): void {
  if (at === armedFor) return;
  if (timer) clearTimeout(timer);
  timer = null;
  armedFor = at;
  if (at === undefined) return;
  const delay = Math.min(Math.max(0, at * 1000 - clockNowMs()), MAX_TIMEOUT_MS);
  timer = setTimeout(() => {
    timer = null;
    armedFor = undefined;
    advance();
  }, delay);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number {
  return now;
}

/**
 * "Now" in epoch seconds for judging mutes, advanced only when one of `mutes`
 * runs out — so what depends on it re-renders at an expiry and not otherwise.
 */
export function useMuteNow(mutes: MuteRecords): number {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    // A mute that ended since `now` last moved (synced in late, a sleeping tab) is judged by the
    // clock; otherwise `now` stays put, so a mounting row doesn't re-render every other one.
    const current = nowSecs();
    if (Object.values(mutes).some(({ until }) => until > now && until <= current)) advance();
    arm(nextMuteExpiry(mutes, now));
  }, [mutes, value]);
  return value;
}
