import { useMemo, useSyncExternalStore } from "react";

import type { QuickReaction } from "@/lib/quickReactions";
import { nowSecs } from "@/lib/relayClock";

export interface FrequentReaction {
  /** The display key (emoji, 👍/👎, or `:shortcode:`). */
  key: string;
  url?: string;
  /** emoji-mart id when picked from the composer emoji picker. */
  pickerId?: string;
  count: number;
  /** Unix seconds of last use, as a tie-breaker. */
  usedAt: number;
}

const STORAGE_PREFIX = "armada:frequent-reactions:";

const MAX_STORED = 32;

/** Seeds the quick row until the user has picked enough of their own. */
const DEFAULT_KEYS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

const EMPTY: FrequentReaction[] = [];

/** Cached so `getSnapshot` is referentially stable (`useSyncExternalStore` would loop). */
const cache = new Map<string, FrequentReaction[]>();
const listeners = new Set<() => void>();
/**
 * Only after USER-initiated records, never hydrates — echoing a merge would make every device
 * rewrite the settings event in turn.
 */
const dirtyListeners = new Set<(pubkey: string) => void>();

function load(pubkey: string): FrequentReaction[] {
  const hit = cache.get(pubkey);
  if (hit) return hit;
  let parsed: FrequentReaction[] = EMPTY;
  try {
    const raw = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${pubkey}`) ?? "");
    if (Array.isArray(raw)) {
      parsed = raw.filter(
        (e): e is FrequentReaction => !!e && typeof e.key === "string" && typeof e.count === "number",
      );
    }
  } catch {
    // Unset or corrupt — start empty; the defaults still fill the row.
  }
  cache.set(pubkey, parsed);
  return parsed;
}

function save(pubkey: string, entries: FrequentReaction[]): void {
  cache.set(pubkey, entries);
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${pubkey}`, JSON.stringify(entries));
    // Seed emoji-mart's "Frequently used" store from the account-scoped table so remote
    // hydrates show up in the picker.
    const rawPicker = JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "{}") as Record<string, unknown>;
    const pickerCounts: Record<string, number> = {};
    for (const [id, count] of Object.entries(rawPicker)) {
      if (typeof count === "number" && Number.isFinite(count)) pickerCounts[id] = count;
    }
    for (const entry of entries) {
      if (!entry.pickerId) continue;
      pickerCounts[entry.pickerId] = Math.max(pickerCounts[entry.pickerId] ?? 0, entry.count);
    }
    localStorage.setItem("emoji-mart.frequently", JSON.stringify(pickerCounts));
  } catch {
    // localStorage full/unavailable — the in-memory table still stands.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function byScore(a: FrequentReaction, b: FrequentReaction): number {
  return b.count - a.count || b.usedAt - a.usedAt;
}

/** Call only when ADDING a reaction — retracting shouldn't promote it. */
export function recordReaction(
  pubkey: string | undefined,
  key: string,
  url?: string,
  pickerId?: string,
): void {
  if (!pubkey || !key) return;
  const now = nowSecs();
  const prev = load(pubkey);
  const existing = prev.find((e) => e.key === key);
  const next = existing
    ? prev.map((e) => (e.key === key
      ? { ...e, url: url ?? e.url, pickerId: pickerId ?? e.pickerId, count: e.count + 1, usedAt: now }
      : e))
    : [...prev, { key, url, pickerId, count: 1, usedAt: now }];
  next.sort(byScore);
  save(pubkey, next.slice(0, MAX_STORED));
  for (const listener of dirtyListeners) listener(pubkey);
}

export function getFrequentReactions(pubkey: string): FrequentReaction[] {
  return load(pubkey);
}

export function subscribeFrequentReactions(listener: (pubkey: string) => void): () => void {
  dirtyListeners.add(listener);
  return () => {
    dirtyListeners.delete(listener);
  };
}

/**
 * Union of keys, max count and latest use per key. Counts are monotonic so max-wins converges
 * without a clock (LWW would let a stale device reset the row).
 */
export function hydrateFrequentReactions(pubkey: string, remote: FrequentReaction[]): void {
  if (!pubkey || remote.length === 0) return;
  const prev = load(pubkey);
  const merged = new Map(prev.map((e) => [e.key, e]));
  let changed = false;
  for (const entry of remote) {
    if (!entry?.key || typeof entry.count !== "number") continue;
    const mine = merged.get(entry.key);
    if (!mine) {
      merged.set(entry.key, entry);
      changed = true;
      continue;
    }
    const count = Math.max(mine.count, entry.count);
    const usedAt = Math.max(mine.usedAt, entry.usedAt);
    const url = mine.url ?? entry.url;
    const pickerId = mine.pickerId ?? entry.pickerId;
    if (count === mine.count && usedAt === mine.usedAt && url === mine.url && pickerId === mine.pickerId) continue;
    merged.set(entry.key, { ...mine, url, pickerId, count, usedAt });
    changed = true;
  }
  // A no-op merge must not write: `save` notifies every consumer on each refetch.
  if (!changed) return;
  const next = [...merged.values()].sort(byScore).slice(0, MAX_STORED);
  save(pubkey, next);
}

/** A slot in the quick-reaction row. */
export interface QuickReactionSlot extends QuickReaction {
  /** Chosen by the user (their kind-10077 list), rather than filled from use. */
  pinned: boolean;
}

/**
 * The quick-reaction row: the pinned reactions in order, then the most-used,
 * then defaults, so the row stays full-width and buttons don't shift as it fills in.
 */
export function quickReactionRow(
  stored: FrequentReaction[],
  pinned: readonly QuickReaction[],
  limit: number,
): QuickReactionSlot[] {
  const row: QuickReactionSlot[] = [];
  const seen = new Set<string>();
  const add = (reaction: QuickReaction, pinned: boolean) => {
    if (row.length >= limit || seen.has(reaction.key)) return;
    seen.add(reaction.key);
    row.push({ ...reaction, pinned });
  };
  for (const p of pinned) add(p, true);
  for (const e of [...stored].sort(byScore)) add(e.url ? { key: e.key, url: e.url } : { key: e.key }, false);
  for (const key of DEFAULT_KEYS) add({ key }, false);
  return row;
}

/** The user's reaction-frequency table, live. */
export function useFrequentReactionTable(pubkey: string | undefined): FrequentReaction[] {
  return useSyncExternalStore(
    subscribe,
    () => (pubkey ? load(pubkey) : EMPTY),
    () => EMPTY,
  );
}

const NO_PINS: QuickReaction[] = [];

/** The most-used reactions, padded with defaults; `useQuickReactions` puts the pinned ones first. */
export function useFrequentReactions(pubkey: string | undefined, limit = 3): QuickReactionSlot[] {
  const stored = useFrequentReactionTable(pubkey);
  return useMemo(() => quickReactionRow(stored, NO_PINS, limit), [stored, limit]);
}

/** Cleared on logout by `purgeClientStorage`; also a test seam. */
export function resetFrequentReactionsCache(): void {
  cache.clear();
}
