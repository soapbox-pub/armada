/**
 * The blocklist as the app holds it: the entries last fetched (kept in KV, so
 * a block survives going offline) and a refresh from relays. Entries are
 * verified and folded by `blocklist.ts`; banned users' are handed to
 * `bannedUsers.ts`, which the stores and renderers ask.
 *
 * A failed fetch keeps what is held, and the app doesn't refuse to work
 * because a relay is down. Before the first fetch nothing is blocked.
 */
import { Capacitor } from "@capacitor/core";
import { useMemo, useSyncExternalStore } from "react";

import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import {
  bannedUserHashes,
  BLOCKLIST_AUTHORS,
  BLOCKLIST_KIND,
  blocklistHash,
  foldBlocklist,
  isCommunityBlocked,
  resolveBlocklistAuthors,
  type BlocklistEntry,
} from "@/lib/blocklist";
import { isUserBannedNow, resetBannedUsers, setBannedUserHashes } from "@/lib/bannedUsers";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { DEPLOYMENT_RELAYS } from "@/lib/platform";
import { isStoreInstall } from "@/lib/storeInstall";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** What a refresh needs of the pool. */
export interface BlocklistPool {
  group(relays: string[]): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

const KV_KEY = "blocklist:events";
/** How old a fetch may be before {@link refreshBlocklist} fetches again. */
const FRESH_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
/** Plenty for years of entries; the list is read whole, never by `#d`. */
const FETCH_LIMIT = 1000;

const RELAYS = [...new Set([...STOCK_RELAYS, ...DEPLOYMENT_RELAYS])];

/** The keys in effect: the deployment's until {@link applyBlocklistSetting} says otherwise. */
let authors: readonly string[] = BLOCKLIST_AUTHORS;
let events: NostrEvent[] = [];
let entries: Map<string, BlocklistEntry> = foldBlocklist(events, authors);
let version = 0;
let fetchedAt = 0;
let inflight: Promise<void> | undefined;
let warming: Promise<void> | undefined;
/** Bumped with {@link authors}, so a fetch begun under the old keys doesn't count as fresh. */
let authorsGeneration = 0;
/** Bumped per {@link applyBlocklistSetting}, so only the latest one's async answer applies. */
let settingGeneration = 0;
/** When each user's entry was last fetched on its own, by {@link checkUserBan}. */
const checkedUsers = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Merge `incoming`, keeping only the newest event per entry, and tell subscribers if anything changed. */
function absorb(incoming: NostrEvent[]): boolean {
  const next = foldBlocklist([...events, ...incoming], authors);
  const changed = next.size !== entries.size
    || [...next].some(([hash, entry]) => entries.get(hash)?.id !== entry.id);
  if (!changed) return false;
  const kept = new Set([...next.values()].map((entry) => entry.id));
  events = [...events, ...incoming].filter((event, i, all) => kept.has(event.id) && all.findIndex((e) => e.id === event.id) === i);
  entries = next;
  setBannedUserHashes(bannedUserHashes(entries));
  notify();
  return true;
}

/** The moderation keys whose entries count right now. */
export function blocklistAuthors(): readonly string[] {
  return authors;
}

/**
 * Count only `next`'s entries: what is held is refolded at once (an entry of a
 * dropped key stops counting), and the next refresh fetches whatever is fresh.
 */
export function setBlocklistAuthors(next: readonly string[]): void {
  if (next.length === authors.length && next.every((pk) => authors.includes(pk))) return;
  authors = [...next];
  authorsGeneration++;
  entries = foldBlocklist(events, authors);
  const kept = new Set([...entries.values()].map((entry) => entry.id));
  events = events.filter((event) => kept.has(event.id));
  setBannedUserHashes(bannedUserHashes(entries));
  fetchedAt = 0;
  checkedUsers.clear();
  inflight = undefined;
  notify();
  void getArmadaDB().kv.set(KV_KEY, events).catch(() => undefined);
}

/**
 * Apply the user's `AppConfig.blocklistAuthors`. A store install keeps the
 * deployment's keys whatever the setting says, and until the install is known
 * on Android, so content the store build blocks never shows there.
 */
export function applyBlocklistSetting(setting: string): void {
  const resolved = resolveBlocklistAuthors(setting, BLOCKLIST_AUTHORS);
  const platform = Capacitor.getPlatform();
  const asked = ++settingGeneration;
  if (platform === "ios") return setBlocklistAuthors(BLOCKLIST_AUTHORS);
  if (platform !== "android") return setBlocklistAuthors(resolved);
  void isStoreInstall()
    .catch(() => true)
    .then((store) => {
      if (asked === settingGeneration) setBlocklistAuthors(store ? BLOCKLIST_AUTHORS : resolved);
    });
}

/** Load what the last session fetched. Once. */
function warm(): Promise<void> {
  warming ??= getArmadaDB().kv.get<NostrEvent[]>(KV_KEY)
    .then((cached) => {
      if (Array.isArray(cached)) absorb(cached);
    })
    .catch(() => undefined);
  return warming;
}

/**
 * Fetch the entries from relays, unless a fetch finished in the last
 * {@link FRESH_MS} (`force` skips that). Never throws.
 */
export function refreshBlocklist(pool: BlocklistPool, { force = false } = {}): Promise<void> {
  if (authors.length === 0) return Promise.resolve();
  if (inflight) return inflight;
  if (!force && Date.now() - fetchedAt < FRESH_MS) return warm();
  const generation = authorsGeneration;
  const asked = [...authors];
  const run: Promise<void> = (async () => {
    await warm();
    try {
      const fetched = await pool.group(RELAYS).query(
        [{ kinds: [BLOCKLIST_KIND], authors: asked, limit: FETCH_LIMIT }],
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (generation !== authorsGeneration) return;
      fetchedAt = Date.now();
      if (absorb(fetched)) await getArmadaDB().kv.set(KV_KEY, events).catch(() => undefined);
    } catch {
      // Keep what is held.
    }
  })().finally(() => {
    if (inflight === run) inflight = undefined;
  });
  inflight = run;
  return run;
}

/**
 * Fetch `pubkey`'s own entry, by `#d`, as their profile opens: a ban published
 * since the last full refresh counts before anything of theirs shows. At most
 * once per {@link FRESH_MS} per user. Never throws.
 */
export async function checkUserBan(pool: BlocklistPool, pubkey: string): Promise<void> {
  if (authors.length === 0 || !/^[0-9a-f]{64}$/.test(pubkey)) return;
  const last = checkedUsers.get(pubkey);
  if (last !== undefined && Date.now() - last < FRESH_MS) return;
  checkedUsers.set(pubkey, Date.now());
  const generation = authorsGeneration;
  const asked = [...authors];
  await warm();
  try {
    const fetched = await pool.group(RELAYS).query(
      [{ kinds: [BLOCKLIST_KIND], authors: asked, "#d": [blocklistHash(pubkey, "user")], limit: 10 }],
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (generation !== authorsGeneration) return;
    if (absorb(fetched)) await getArmadaDB().kv.set(KV_KEY, events).catch(() => undefined);
  } catch {
    if (generation === authorsGeneration) checkedUsers.delete(pubkey);
  }
}

/** Whether `communityId` is blocked, by what is held right now. Not an id, not blocked. */
export function isBlockedNow(communityId: string): boolean {
  if (authors.length === 0 || !/^[0-9a-f]{64}$/i.test(communityId)) return false;
  return isCommunityBlocked(entries, communityId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;

/**
 * {@link isBlockedNow}, re-rendering when the held entries change. A new
 * function each change, so memos that depend on it recompute.
 */
export function useIsBlocked(): (communityId: string) => boolean {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => {
    void current;
    return (communityId: string) => isBlockedNow(communityId);
  }, [current]);
}

/**
 * {@link isUserBannedNow}, re-rendering when the held entries change. A new
 * function each change, so memos that depend on it recompute.
 */
export function useIsUserBanned(): (pubkey: string | undefined) => boolean {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => {
    void current;
    return (pubkey: string | undefined) => isUserBannedNow(pubkey);
  }, [current]);
}

/** {@link blocklistAuthors}, re-rendering when they change. */
export function useBlocklistAuthors(): readonly string[] {
  return useSyncExternalStore(subscribe, blocklistAuthors, blocklistAuthors);
}

/** Subscribe to changes in the held entries. */
export function onBlocklistChange(listener: () => void): () => void {
  return subscribe(listener);
}

/** For tests: forget everything. */
export function resetBlocklistForTests(): void {
  authors = BLOCKLIST_AUTHORS;
  authorsGeneration++;
  settingGeneration++;
  events = [];
  entries = foldBlocklist(events, authors);
  resetBannedUsers();
  checkedUsers.clear();
  version++;
  fetchedAt = 0;
  inflight = undefined;
  warming = undefined;
}
