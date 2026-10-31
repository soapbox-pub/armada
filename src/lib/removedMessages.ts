/**
 * Messages removed from this device (a report's "Also remove it from this
 * device"): per-account, permanent, no undo, wiped with the rest of
 * localStorage on logout. The stores refuse these ids on their own
 * (`ArmadaDB.forget`); this synchronous copy is for what runs before or
 * outside them: the timelines (`useHiddenMessages`), the thread snapshots, and
 * the NIP-17 opener, which must not cache a removed message's plaintext again.
 */
import { getActivePubkey } from "@/lib/activeAccount";

const REMOVED_LIMIT = 5000;

const storageKey = (pubkey: string) => `armada:removed-messages:${pubkey}`;

const EMPTY: ReadonlySet<string> = new Set();

let cachedKey: string | null = null;
let cachedOrder: string[] = [];
let cachedIds: ReadonlySet<string> = EMPTY;

const listeners = new Set<() => void>();

function loadInto(key: string): void {
  cachedKey = key;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cachedOrder = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // No localStorage (the service worker): nothing is known removed there.
    cachedOrder = [];
  }
  cachedIds = new Set(cachedOrder);
}

/** Removed message ids for one account. */
export function getRemovedMessageIds(pubkey: string | null | undefined): ReadonlySet<string> {
  if (!pubkey) return EMPTY;
  const key = storageKey(pubkey);
  if (cachedKey !== key) loadInto(key);
  return cachedIds;
}

/** Whether the active account removed `id` from this device. */
export function isRemovedMessageId(id: string): boolean {
  const ids = getRemovedMessageIds(getActivePubkey());
  return ids.size > 0 && ids.has(id);
}

export function addRemovedMessageId(pubkey: string, id: string): void {
  const key = storageKey(pubkey);
  if (cachedKey !== key) loadInto(key);
  if (cachedIds.has(id)) return;
  cachedOrder = [...cachedOrder, id].slice(-REMOVED_LIMIT);
  cachedIds = new Set(cachedOrder);
  try {
    localStorage.setItem(key, JSON.stringify(cachedOrder));
  } catch {
    // Storage unavailable — the removal holds for the session only.
  }
  for (const listener of listeners) listener();
}

export function subscribeRemovedMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
