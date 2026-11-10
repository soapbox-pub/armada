/**
 * When each self-state read (account × relay × derived-key set) last reached
 * EOSE, so a cold start resumes it with `since` instead of re-reading every
 * stored version of the account's lists and settings documents. Kept in
 * ArmadaDB KV beside the documents it vouches for, so logout wipes both.
 */
import { matchFilters, type Filter } from "nostr-tools/filter";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import { verifyEventOnce } from "@/lib/verifyCache";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

const KEY = "self-sync-read-marks";
/** A mark this old is dropped, as the native service drops its self-state cursor. */
const MAX_AGE_SECS = 30 * 24 * 3600;
const PERSIST_MS = 2_000;

const marks = new Map<string, number>();
let loaded: Promise<void> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Load the persisted marks once per page; later calls share the first load. */
export function loadSelfReadMarks(): Promise<void> {
  loaded ??= readFolded<Record<string, number>>(KEY)
    .then((stored) => {
      const now = nowSecs();
      for (const [readKey, at] of Object.entries(stored ?? {})) {
        // A future mark (clock moved back) would skip documents written meanwhile.
        if (!Number.isFinite(at) || at > now || now - at > MAX_AGE_SECS) continue;
        if (!marks.has(readKey)) marks.set(readKey, at);
      }
    })
    .catch(() => {});
  return loaded;
}

export function selfReadMark(readKey: string): number | undefined {
  return marks.get(readKey);
}

export function noteSelfRead(readKey: string, at: number): void {
  marks.set(readKey, Math.max(marks.get(readKey) ?? 0, at));
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void writeFolded(KEY, Object.fromEntries(marks)).catch(() => {});
  }, PERSIST_MS);
}

/** Test seam: write now, then forget in memory, as a relaunch would. */
export async function _relaunchSelfReadMarksForTests(): Promise<void> {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  await writeFolded(KEY, Object.fromEntries(marks));
  marks.clear();
  loaded = undefined;
}

/**
 * Slack behind a mark: other devices' clocks stamp the documents. Matches the
 * notification service's `SELF_SINCE_SLACK_SEC`.
 */
export const SELF_READ_SLACK_SECS = 600;

/** `filters` resumed from `readKey`'s mark, or as given when there is none. */
export function sinceSelfRead(filters: NostrFilter[], readKey: string): NostrFilter[] {
  const mark = selfReadMark(readKey);
  return mark === undefined ? filters : filters.map((f) => ({ ...f, since: mark - SELF_READ_SLACK_SECS }));
}

/**
 * Store a resumed read's answer, so the store keeps every version the next
 * resumed read skips. Only what verifies and matches what was asked: a relay
 * must not be able to plant a document there.
 */
export async function storeSelfReadEvents(
  store: { event(event: NostrEvent): Promise<unknown> },
  filters: NostrFilter[],
  events: NostrEvent[],
): Promise<void> {
  const wanted = filters.map(({ since: _since, ...f }) => f) as Filter[];
  await Promise.all(events
    .filter((e) => matchFilters(wanted, e) && verifyEventOnce(e))
    .map((e) => store.event(e).catch(() => undefined)));
}
