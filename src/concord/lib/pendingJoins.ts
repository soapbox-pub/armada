/**
 * Optimistic pending joins: membership entries for communities whose join chain
 * (bundle resolve → ban check → vault write) is still running, so the page can
 * open immediately. Nothing here is published; the Community List stays the
 * durable record.
 *
 * Persisted per account in the folded KV cache so an app closed mid-chain
 * resumes it (`useResumePendingJoins`). Transient failures retry, bounded by
 * {@link PENDING_JOIN_MAX_AGE_MS} / {@link PENDING_JOIN_MAX_ATTEMPTS} (a vanished
 * bundle looks like slow relays, so it's retried under the same bound).
 */
import { readFolded, writeFolded } from "@/lib/foldedCache";

import type { CommunityListEntry } from "@/concord/lib/communityList";

/** Folded-cache key holding one account's pending joins. */
export const pendingJoinsKey = (pubkey: string) => `concord2-pending-joins:${pubkey}`;

/** A pending join older than this is given up on, however its runs failed. */
export const PENDING_JOIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Failure-count bound, counted once per session (a launch), not per retry: a
 * session retries on every return to the tab. The age bound is the real one;
 * this backstops a clock moving backwards.
 */
export const PENDING_JOIN_MAX_ATTEMPTS = 25;

/** Retry bookkeeping for one pending join, kept beside (not inside) the entry. */
interface PendingJoinMeta {
  firstSeenAt: number;
  attempts: number;
}

/** The on-disk form: the entry with its bookkeeping inlined. */
type StoredPendingJoin = CommunityListEntry & {
  pending_first_seen?: number;
  pending_attempts?: number;
};

const entries = new Map<string, CommunityListEntry>();
const listeners = new Set<() => void>();
const EMPTY: CommunityListEntry[] = [];
let snapshot: CommunityListEntry[] = EMPTY;
let owner: string | undefined;
/** Per account, the one load of its persisted entries this session. */
const hydrations = new Map<string, Promise<void>>();
/** Ids forgotten this session, so a load that lands late can't resurrect them. */
const forgotten = new Set<string>();
/** `<pubkey>:<id>` joins whose chain already ran (or is running) this session. */
const runs = new Set<string>();
const meta = new Map<string, PendingJoinMeta>();
/** Joins whose failure this session has already counted. */
const counted = new Set<string>();
/** Joins a load found past their bound and dropped, awaiting {@link takeExpiredPendingJoins}. */
let expired: CommunityListEntry[] = [];
let writes: Promise<void> = Promise.resolve();

function notify(): void {
  snapshot = [...entries.values()];
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener must never break the store for the others.
    }
  }
}

/** Point the in-memory store at `pubkey`, dropping another account's entries. */
function ownBy(pubkey: string): void {
  if (owner === pubkey) return;
  owner = pubkey;
  forgotten.clear();
  meta.clear();
  counted.clear();
  expired = [];
  if (entries.size > 0) {
    entries.clear();
    notify();
  }
}

export function addPendingJoin(entry: CommunityListEntry): void {
  entries.set(entry.community_id, entry);
  notify();
}

export function removePendingJoin(communityId: string): void {
  meta.delete(communityId);
  if (entries.delete(communityId)) notify();
}

function isExpired(m: PendingJoinMeta, now: number): boolean {
  return now - m.firstSeenAt > PENDING_JOIN_MAX_AGE_MS || m.attempts >= PENDING_JOIN_MAX_ATTEMPTS;
}

export function pendingJoinEntries(): CommunityListEntry[] {
  return snapshot;
}

/** The entries belonging to `pubkey` — empty for any other account. */
export function pendingJoinEntriesFor(pubkey: string | undefined): CommunityListEntry[] {
  return pubkey !== undefined && owner === pubkey ? snapshot : EMPTY;
}

/** Whether a join for this community is still pending (not landed, not abandoned). */
export function hasPendingJoin(pubkey: string, communityId: string): boolean {
  return owner === pubkey && entries.has(communityId);
}

/** The pending entry as recorded at click time (`added_at` = when the user joined). */
export function pendingJoinEntry(pubkey: string, communityId: string): CommunityListEntry | undefined {
  return owner === pubkey ? entries.get(communityId) : undefined;
}

export function subscribePendingJoins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Load `pubkey`'s persisted pending joins once per session; in-memory entries
 * win. Entries past their bound are dropped (on disk too) and queued for
 * {@link takeExpiredPendingJoins}.
 */
export function hydratePendingJoins(pubkey: string): Promise<void> {
  ownBy(pubkey);
  let loading = hydrations.get(pubkey);
  if (!loading) {
    loading = readFolded<StoredPendingJoin[]>(pendingJoinsKey(pubkey)).then(async (stored) => {
      if (owner !== pubkey || !Array.isArray(stored)) return;
      const now = Date.now();
      let changed = false;
      let rewrite = false;
      for (const record of stored) {
        if (!record || typeof record.community_id !== "string") continue;
        if (entries.has(record.community_id) || forgotten.has(record.community_id)) continue;
        const { pending_first_seen: firstSeen, pending_attempts: attempts, ...entry } = record;
        const known = typeof firstSeen === "number" && Number.isFinite(firstSeen);
        const m: PendingJoinMeta = {
          // A future timestamp is a clock that moved; restart the window.
          firstSeenAt: known && firstSeen <= now ? firstSeen : now,
          attempts: typeof attempts === "number" && attempts >= 0 ? attempts : 0,
        };
        if (m.firstSeenAt !== firstSeen) rewrite = true;
        if (isExpired(m, now)) {
          forgotten.add(entry.community_id);
          expired.push(entry);
          rewrite = true;
          continue;
        }
        meta.set(entry.community_id, m);
        entries.set(entry.community_id, entry);
        changed = true;
      }
      if (changed) notify();
      if (rewrite) await persist(pubkey);
    });
    hydrations.set(pubkey, loading);
  }
  return loading;
}

/** Write `pubkey`'s entries as they stand when the write runs, in call order. */
function persist(pubkey: string): Promise<void> {
  writes = writes.then(async () => {
    if (owner !== pubkey) return;
    const now = Date.now();
    await writeFolded(
      pendingJoinsKey(pubkey),
      [...entries.values()].map((entry): StoredPendingJoin => {
        const m = meta.get(entry.community_id);
        return { ...entry, pending_first_seen: m?.firstSeenAt ?? now, pending_attempts: m?.attempts ?? 0 };
      }),
    );
  });
  return writes;
}

/** Record a pending join in memory and on disk. Resolves once it is written. */
export async function persistPendingJoin(pubkey: string, entry: CommunityListEntry): Promise<void> {
  ownBy(pubkey);
  forgotten.delete(entry.community_id);
  counted.delete(entry.community_id);
  addPendingJoin(entry);
  // A fresh click is a fresh intent: its retry window starts now.
  meta.set(entry.community_id, { firstSeenAt: Date.now(), attempts: 0 });
  await hydratePendingJoins(pubkey);
  await persist(pubkey);
}

/** Forget a pending join — landed, rejected, or walked away from. */
export async function forgetPendingJoin(pubkey: string, communityId: string): Promise<void> {
  if (owner !== pubkey) return;
  forgotten.add(communityId);
  removePendingJoin(communityId);
  await hydratePendingJoins(pubkey);
  await persist(pubkey);
}

/**
 * Count a transient failure, the first one of this session only. Resolves `true`
 * when it is past its bound — it's then forgotten and the caller tells the user.
 */
export async function recordPendingJoinFailure(pubkey: string, communityId: string): Promise<boolean> {
  if (owner !== pubkey) return false;
  await hydratePendingJoins(pubkey);
  const m = meta.get(communityId);
  if (!m || !entries.has(communityId)) return false;
  if (!counted.has(communityId)) {
    counted.add(communityId);
    m.attempts += 1;
  }
  if (isExpired(m, Date.now())) {
    await forgetPendingJoin(pubkey, communityId);
    return true;
  }
  await persist(pubkey);
  return false;
}

/** The joins a load dropped as expired, once; the taker tells the user. */
export function takeExpiredPendingJoins(pubkey: string): CommunityListEntry[] {
  if (owner !== pubkey || expired.length === 0) return EMPTY;
  const taken = expired;
  expired = [];
  return taken;
}

/** Claim this session's one run of a pending join's chain; `false` if already claimed. */
export function claimPendingJoinRun(pubkey: string, communityId: string): boolean {
  const key = `${pubkey}:${communityId}`;
  if (runs.has(key)) return false;
  runs.add(key);
  return true;
}

/** A run that failed transiently gives its claim back, so this session can try again. */
export function releasePendingJoinRun(pubkey: string, communityId: string): void {
  runs.delete(`${pubkey}:${communityId}`);
}

/** Drop everything in memory (via `purgeClientStorage`): entries carry community roots. */
export function clearPendingJoins(): void {
  owner = undefined;
  hydrations.clear();
  forgotten.clear();
  runs.clear();
  meta.clear();
  counted.clear();
  expired = [];
  if (entries.size > 0) {
    entries.clear();
    notify();
  }
}

/** Test helper: drop all entries and listeners. */
export function _resetPendingJoinsForTests(): void {
  clearPendingJoins();
  snapshot = EMPTY;
  listeners.clear();
  writes = Promise.resolve();
}
