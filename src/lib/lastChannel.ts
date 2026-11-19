import { useSyncExternalStore } from "react";

import { getActivePubkey, subscribeActivePubkey } from "@/lib/activeAccount";

/**
 * The channel last open per community or server, per account and device. Not in
 * the app config: a config write replaces the context nearly every component
 * reads, and this one landed on every channel switch, re-rendering the whole app
 * (~1.5 s on a phone, just as the reader started scrolling).
 */

const KEY_PREFIX = "armada:last-channel:";
const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

let cached: { pubkey: string | null; value: Readonly<Record<string, string>> } | undefined;
const listeners = new Set<() => void>();

function keyFor(pubkey: string | null): string {
  return `${KEY_PREFIX}${pubkey ?? ""}`;
}

/** The map for the active account. Stable between writes. */
export function getLastChannels(): Readonly<Record<string, string>> {
  const pubkey = getActivePubkey();
  if (cached?.pubkey === pubkey) return cached.value;
  let value = EMPTY;
  try {
    const raw = localStorage.getItem(keyFor(pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      value = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
  } catch {
    // Unreadable reads as nothing remembered.
  }
  cached = { pubkey, value };
  return value;
}

/** Remember `channel` as the last open in `scope`. A no-op when it already is. */
export function rememberLastChannel(scope: string, channel: string): void {
  const current = getLastChannels();
  if (current[scope] === channel) return;
  const pubkey = getActivePubkey();
  const value = { ...current, [scope]: channel };
  cached = { pubkey, value };
  try {
    localStorage.setItem(keyFor(pubkey), JSON.stringify(value));
  } catch {
    // Quota/private mode: remembered for this session only.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const offAccount = subscribeActivePubkey(listener);
  return () => {
    listeners.delete(listener);
    offAccount();
  };
}

/** {@link getLastChannels}, re-rendering only the callers when it changes. */
export function useLastChannels(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, getLastChannels, getLastChannels);
}

/** Test seam. */
export function _resetLastChannelsForTests(): void {
  cached = undefined;
  listeners.clear();
}
