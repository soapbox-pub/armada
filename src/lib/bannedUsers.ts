/**
 * The users the blocklist bans, as every store and renderer asks: by pubkey,
 * synchronously. A leaf (the service worker bundles the stores that ask), so it
 * holds only the hashes; `blocklistStore.ts` sets them as entries arrive.
 *
 * An entry names a hash of the pubkey, never the pubkey, so a ban is only
 * recognized on meeting the pubkey. Each one met banned is announced once, to
 * whoever purges it from the device (`purgeBannedUser.ts`).
 */
import { blocklistHash } from "@/lib/blocklist";

let banned = new Set<string>();
/** pubkey → its user entry hash. Cleared past {@link MAX_MEMO}, which only costs re-hashing. */
const memo = new Map<string, string>();
const MAX_MEMO = 50_000;
const HEX64 = /^[0-9a-f]{64}$/;

const met = new Set<string>();
const listeners = new Set<(pubkey: string) => void>();

/** Replace the banned users' entry hashes. */
export function setBannedUserHashes(hashes: ReadonlySet<string>): void {
  banned = new Set(hashes);
  for (const pubkey of [...met]) if (!banned.has(hashOf(pubkey))) met.delete(pubkey);
}

function hashOf(pubkey: string): string {
  let hash = memo.get(pubkey);
  if (!hash) {
    if (memo.size >= MAX_MEMO) memo.clear();
    hash = blocklistHash(pubkey, "user");
    memo.set(pubkey, hash);
  }
  return hash;
}

/** Whether the blocklist bans `pubkey`, by what is held right now. Not a pubkey, not banned. */
export function isUserBannedNow(pubkey: string | undefined): boolean {
  if (banned.size === 0 || !pubkey || !HEX64.test(pubkey)) return false;
  if (!banned.has(hashOf(pubkey))) return false;
  if (!met.has(pubkey)) {
    met.add(pubkey);
    // Not from inside whatever render or write asked.
    queueMicrotask(() => {
      for (const listener of listeners) listener(pubkey);
    });
  }
  return true;
}

/** The banned pubkeys met so far this session. */
export function metBannedUsers(): string[] {
  return [...met];
}

/** Called with each banned pubkey the first time it's met. */
export function onBannedUserMet(listener: (pubkey: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A banned user's row as kept in place of theirs: where it goes (its id, kind,
 * time, and the tags in `keep`), none of what it said or showed.
 */
export function tombstoned<T extends { content: string; tags: string[][] }>(row: T, keep: ReadonlySet<string>): T {
  return { ...row, content: "", tags: row.tags.filter((tag) => keep.has(tag[0])) };
}

/** For tests and logout: forget everything. */
export function resetBannedUsers(): void {
  banned = new Set();
  memo.clear();
  met.clear();
}
