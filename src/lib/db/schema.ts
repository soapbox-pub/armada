/**
 * ArmadaDB's data-schema version (CONTENT shape: tagging, KV key spelling,
 * tenant layout) and its migrations, stored in KV. Distinct from IndexedDB
 * store-layout versions (`KV_DB_VERSION`). To change the stored shape, add a
 * {@link SchemaMigration} and bump {@link ARMADA_DB_VERSION} — don't make readers
 * cope with two shapes.
 */
import { guestbookAddrKey, SNAPSHOT_PREFIX, snapshotKey } from "@/concord/lib/rumorStore";

import { getArmadaDB } from "./armadaDB";

/**
 * The shape this build writes and expects.
 * 1 — initial ArmadaDB layout.
 * 2 — unbounded localStorage key spaces move into KV (`KvPrefixCache`).
 * 3 — NIP-29 moves from `main` to per-relay tenants; `provenance:` KV dropped.
 * 4 — a Guestbook rumor's address is a key of its own (`c2gbaddr:`), not an id in a per-address array (`c2gbpk:`).
 * 5 — likewise a Control snapshot entry (`c2snap:<community>:<address>:<rumor>`), not an id in `c2snap:<community>:<address>`.
 * 6 — the plane sweeps' wrap memos and Guestbook cursors start over: builds before
 *     the Guestbook took Timeouts and Nicknames (v0.69.0) memoized and read past them.
 * 7 — a Guestbook relay's read state is `folded:plane-read:<scope>` (`planeRead.ts`);
 *     the forward cursors written since v6 say nothing about how deep a read went.
 */
export const ARMADA_DB_VERSION = 7;

export const SCHEMA_VERSION_KEY = "db:version";

export interface SchemaMigration {
  /** Version reached by running this; unique and ascending. */
  to: number;
  label: string;
  /**
   * Runs once per logged-in account with `self`. Must be safe to leave un-run
   * for an account (later logins arrive already stamped).
   */
  perAccount?: boolean;
  /**
   * Whether there is anything to convert (default yes); tells a fresh install
   * (unstamped) from a pre-version-key one, keeping fresh installs quiet.
   */
  needed?(): Promise<boolean>;
  run(self: string | undefined): Promise<void>;
}

const OLD_GUESTBOOK_PREFIX = "c2gbpk:";

/** Ordered by `to`, ascending. */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    to: 4,
    label: "Guestbook addresses",
    needed: async () => (await getArmadaDB().kv.list({ prefix: OLD_GUESTBOOK_PREFIX }, { limit: 1 })).length > 0,
    async run() {
      const kv = getArmadaDB().kv;
      for (const { key, value } of await kv.list<unknown>({ prefix: OLD_GUESTBOOK_PREFIX })) {
        // `c2gbpk:<community>:<address>` → the ids that arrived there.
        const [communityIdHex, pk] = key.slice(OLD_GUESTBOOK_PREFIX.length).split(":");
        if (communityIdHex && pk && Array.isArray(value)) {
          await Promise.all(value.filter((id): id is string => typeof id === "string").map((id) => kv.set(guestbookAddrKey(communityIdHex, id, pk), 1)));
        }
        await kv.delete(key);
      }
    },
  },
  {
    to: 5,
    label: "Control snapshots",
    needed: async () => (await oldSnapshotSets()).length > 0,
    async run() {
      const kv = getArmadaDB().kv;
      for (const { key, communityIdHex, pk, ids } of await oldSnapshotSets()) {
        await Promise.all(ids.map((id) => kv.set(snapshotKey(communityIdHex, pk, id), 1)));
        await kv.delete(key);
      }
    },
  },
  {
    to: 6,
    label: "Plane sweep memos",
    needed: async () => {
      const kv = getArmadaDB().kv;
      for (const prefix of SWEEP_MEMO_PREFIXES) if ((await kv.list({ prefix }, { limit: 1 })).length > 0) return true;
      return false;
    },
    async run() {
      // The memo says "stored", and the cursor "read up to here", of wraps whose rumors
      // the old rules dropped: both go, so the next sweep reads and files them again.
      // The chat planes' memo entries go too; their rows are skipped at the store instead.
      const kv = getArmadaDB().kv;
      for (const prefix of SWEEP_MEMO_PREFIXES) {
        for (const { key } of await kv.list({ prefix })) await kv.delete(key);
      }
    },
  },
  {
    to: 7,
    label: "Guestbook read state",
    needed: async () => (await getArmadaDB().kv.list({ prefix: GUESTBOOK_CURSOR_PREFIX }, { limit: 1 })).length > 0,
    async run() {
      // A cursor vouches for the newest page only, so none becomes a read state:
      // each relay starts with a whole read.
      const kv = getArmadaDB().kv;
      for (const { key } of await kv.list({ prefix: GUESTBOOK_CURSOR_PREFIX })) await kv.delete(key);
    },
  },
];

const GUESTBOOK_CURSOR_PREFIX = "folded:concord2-cursor:guestbook:";

/** What v6 clears: the seen/junk wrap logs and their legacy values, the complete floors, and Guestbook cursors. */
const SWEEP_MEMO_PREFIXES = [
  "plane-seen-wraps:",
  "plane-junk-wraps:",
  "folded:plane-seen-wraps",
  "folded:plane-junk-wraps",
  "folded:plane-complete-floors",
  GUESTBOOK_CURSOR_PREFIX,
];

/** The `c2snap:<community>:<address>` id arrays, which the per-entry keys sharing their prefix never are. */
async function oldSnapshotSets(): Promise<Array<{ key: string; communityIdHex: string; pk: string; ids: string[] }>> {
  const out: Array<{ key: string; communityIdHex: string; pk: string; ids: string[] }> = [];
  for (const { key, value } of await getArmadaDB().kv.list<unknown>({ prefix: SNAPSHOT_PREFIX })) {
    const parts = key.slice(SNAPSHOT_PREFIX.length).split(":");
    if (parts.length !== 2 || !Array.isArray(value)) continue;
    out.push({ key, communityIdHex: parts[0], pk: parts[1], ids: value.filter((id): id is string => typeof id === "string") });
  }
  return out;
}

/** The version on disk, or `undefined` if it was never stamped. */
export async function readSchemaVersion(): Promise<number | undefined> {
  try {
    const stored = await getArmadaDB().kv.get<number>(SCHEMA_VERSION_KEY);
    return typeof stored === "number" && Number.isInteger(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** Record that the data on disk is now at `version`. */
export async function stampSchemaVersion(version: number = ARMADA_DB_VERSION): Promise<void> {
  await getArmadaDB().kv.set(SCHEMA_VERSION_KEY, version);
}

/**
 * Migrations still owed. Unstamped counts as 0 ({@link SchemaMigration.needed}
 * tells fresh installs apart). A version ahead of this build (downgrade) owes
 * nothing: migrations only run forwards.
 */
export async function pendingSchemaMigrations(
  from: number | undefined,
): Promise<SchemaMigration[]> {
  if (isFutureVersion(from)) return [];
  const at = from ?? 0;
  const candidates = SCHEMA_MIGRATIONS.filter((m) => m.to > at && m.to <= ARMADA_DB_VERSION)
    .sort((a, b) => a.to - b.to);

  const owed: SchemaMigration[] = [];
  for (const m of candidates) {
    // Skipping an unneeded one doesn't strand the version (the caller stamps anyway).
    if (!m.needed || (await m.needed().catch(() => true))) owed.push(m);
  }
  return owed;
}

/** Whether the data on disk was written by a newer build than this one. */
export function isFutureVersion(from: number | undefined): boolean {
  return from !== undefined && from > ARMADA_DB_VERSION;
}
