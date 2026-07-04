import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { DECRYPT_CACHE_DB_NAME } from "@/lib/AppSigner";
import { getTileStore } from "@/lib/map/getTileStore";

/**
 * localStorage keys that must survive a purge. `armada:login` is the nostrify
 * login store: it's mutated by `removeLogin` in the same tick we purge, and
 * blowing it away here would race that update and resurrect a stale session.
 * We clear it (and everything else) only as the final account logs out.
 */
const PRESERVE_LOCAL_STORAGE_KEYS = new Set<string>(["armada:login"]);

/** Best-effort deletion of every IndexedDB database this origin owns. */
async function purgeIndexedDB(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    // `indexedDB.databases()` is unsupported on Firefox; fall back to the
    // known Armada database names so we still wipe the bulk of the data.
    const known = [
      "armada-events",
      "armada-concord-cache",
      "armada-relay-provenance",
      "armada-offline-maps",
      "armada-offline-tiles",
      DECRYPT_CACHE_DB_NAME,
    ];
    const dbs =
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => Boolean(n))
        : known;
    await Promise.all(
      [...new Set([...dbs, ...known])].map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    // best-effort
  }
}

/** Best-effort deletion of every Cache Storage entry this origin owns. */
async function purgeCacheStorage(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // best-effort
  }
}

/** Wipe all Armada localStorage (everything except the preserved keys). */
function purgeLocalStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && !PRESERVE_LOCAL_STORAGE_KEYS.has(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

/** Best-effort deletion of native offline-map tile files (Capacitor). */
async function purgeOfflineMapFiles(): Promise<void> {
  try {
    await getTileStore().clearAll();
  } catch {
    // best-effort (no-op on web, where the tiles live in IndexedDB purged above)
  }
}

/**
 * Purge all client-side persistence so a fresh logout leaves nothing behind:
 * the event cache, Concord caches, the persistent decrypt cache, decrypted
 * image bytes, per-user read-state and drafts, relay-info, voice/notification
 * prefs, theme, offline map tiles, and the added-server list. The in-memory DM
 * render memo is dropped too.
 *
 * `armada:login` is intentionally left for the caller's `removeLogin` to manage
 * in the same tick; everything else (including `armada:app-config`) is wiped so
 * the next session starts truly clean.
 */
export async function purgeClientStorage(): Promise<void> {
  clearRenderedPlaintext();
  purgeLocalStorage();
  await Promise.all([purgeIndexedDB(), purgeCacheStorage(), purgeOfflineMapFiles()]);
}
