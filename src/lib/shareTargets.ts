/**
 * "Last outgoing message" ledger ranking Android Direct Share suggestions by
 * when the viewer last SENT to a room, keyed by route (the shortcut id). Local
 * KV only, never NIP-78: publishing a user's room list is forbidden
 * (AGENTS.md). For DMs, `useShareShortcuts` also uses `distinct:convmine` and
 * takes the newer.
 */

import { KvPrefixCache } from "@/lib/db/kvCache";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import { nowSecs } from "@/lib/relayClock";

/** One room the viewer has sent to. */
export interface LastSentEntry {
  /** Unix SECONDS the viewer last sent here — the same clock as `created_at`. */
  sentAt: number;
  /**
   * Room name captured at send time (MainLayout has no community/group state to
   * resolve it). DMs omit it; they resolve from kind-0 profiles.
   */
  label?: string;
  /** Room avatar (community image / group picture) to fetch native-side. */
  iconUrl?: string;
}

/** Bounded: `KvPrefixCache` holds the whole prefix in memory. */
const MAX_ROOMS = 32;

const cache = new KvPrefixCache<LastSentEntry>({ prefix: "share-sent:" });

/**
 * `<pubkey>:<route>`. Account-scoped because switching accounts doesn't purge
 * KV; hex pubkeys make the first colon the split point.
 */
function entryId(self: string, route: string): string {
  return `${self}:${route}`;
}

function splitId(id: string): { self: string; route: string } | null {
  const cut = id.indexOf(":");
  if (cut <= 0) return null;
  return { self: id.slice(0, cut), route: id.slice(cut + 1) };
}

/**
 * Note that `self` just sent to `route` (a ROOM path, no `/t/` or `/m/`
 * focus). Fire-and-forget.
 */
export function recordSent(
  self: string,
  route: string,
  meta?: { label?: string; iconUrl?: string },
): void {
  if (!self || !route) return;
  const entry: LastSentEntry = { sentAt: nowSecs() };
  if (meta?.label) entry.label = meta.label;
  if (meta?.iconUrl) entry.iconUrl = meta.iconUrl;
  cache.set(entryId(self, route), entry);
  // Prune after warm; briefly exceeding the cap is harmless.
  void cache.ready().then(() => prune(self)).catch(() => undefined);
}

/** Drop this account's oldest entries past {@link MAX_ROOMS}. */
function prune(self: string): void {
  const mine = readAll(self);
  if (mine.length <= MAX_ROOMS) return;
  for (const { route } of mine.slice(MAX_ROOMS)) cache.delete(entryId(self, route));
}

/** This account's rooms, newest send first. Synchronous; empty before the warm. */
function readAll(self: string): { route: string; entry: LastSentEntry }[] {
  const rows: { route: string; entry: LastSentEntry }[] = [];
  for (const id of cache.ids()) {
    const parts = splitId(id);
    if (!parts || parts.self !== self) continue;
    const entry = cache.get(id);
    if (!entry || typeof entry.sentAt !== "number") continue;
    rows.push({ route: parts.route, entry });
  }
  return rows.sort((a, b) => b.entry.sentAt - a.entry.sentAt);
}

/**
 * This account's rooms, newest send first; empty until {@link warmSentRooms}.
 * Routes are canonicalized via `chatRoute` and deduped, since older rows name
 * DMs in hex and would yield duplicate shortcut ids.
 */
export function sentRooms(self: string): { route: string; entry: LastSentEntry }[] {
  if (!self) return [];
  const byRoute = new Map<string, LastSentEntry>();
  // Newest first, so the first to claim a route wins.
  for (const { route, entry } of readAll(self)) {
    const parsed = parseChatRoute(route);
    const canonical = parsed ? chatRoute(parsed) : route;
    if (!byRoute.has(canonical)) byRoute.set(canonical, entry);
  }
  return [...byRoute].map(([route, entry]) => ({ route, entry }));
}

/** Fill the ledger from KV. Idempotent and shared by concurrent callers. */
export function warmSentRooms(): Promise<void> {
  return cache.ready();
}

/** Re-publish on ledger change (written outside render, so not via React state). */
export function subscribeSentRooms(listener: () => void): () => void {
  return cache.subscribe(listener);
}
