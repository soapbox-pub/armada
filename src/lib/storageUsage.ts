/**
 * Settings › Storage: what this device holds for Armada, how big each part is,
 * and clearing the parts that are only caches. Message history is reported but
 * never cleared here: decrypted Concord and NIP-17 history may exist nowhere
 * else, and the `main` tenant is the local copy the list-safety rule reads.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

import { clearCommunityImageCache, communityImageCacheUsage } from "@/concord/lib/image";
import { STAGING_DIR as CALL_RECORDING_STAGING_DIR } from "@/lib/callRecording/protocol";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { clearDesktopWebCache, desktop, getDesktopWebCacheSize } from "@/lib/desktop";
import { clearMediaCache, mediaCacheUsage } from "@/lib/mediaCache";
import { RETIRED_DATABASES, RETIRED_OPFS_DIR } from "@/lib/retiredStorage";

import type { ArmadaDBUsage } from "@/lib/db/types";

/** One line of the breakdown. */
export type StorageRowId =
  | "media"
  | "communityImages"
  | "notificationAvatars"
  | "webCache"
  | "callRecordings"
  | "legacy"
  | "dms"
  | "communities"
  | "servers"
  | "profiles"
  | "otherData"
  | "settings";

export interface StorageRow {
  id: StorageRowId;
  /** Absent where the platform can't measure it. */
  bytes?: number;
  /** Items held (cached files, stored events), where that means something. */
  count?: number;
  clearable: boolean;
  /** What the row is made of, largest first, where it can be told apart (settings and sync state). */
  parts?: StoragePart[];
}

/** One piece of a row: a KV key group (`kvGroupOf`) or {@link LOCAL_STORAGE_PART}. */
export interface StoragePart {
  id: string;
  bytes: number;
  entries?: number;
}

/** The {@link StoragePart} id of the browser's localStorage, where the app's own settings live. */
export const LOCAL_STORAGE_PART = "localStorage";

export interface StorageReport {
  /** Caches and leftovers, each clearable. */
  caches: StorageRow[];
  /** Message history and settings: shown, never cleared here. */
  data: StorageRow[];
  /** Everything above, as best the platform can tell. */
  totalBytes?: number;
  /** The browser's allowance for this site (web only). */
  quotaBytes?: number;
}

/** The native caches outside the WebView (`ArmadaStoragePlugin.java` / `.swift`). */
interface ArmadaStoragePlugin {
  usage(): Promise<{ avatars?: number; webCache?: number }>;
  clear(options: { kind: "avatars" | "webCache" }): Promise<void>;
}

let plugin: ArmadaStoragePlugin | undefined;

function nativeStorage(): ArmadaStoragePlugin | undefined {
  const platform = Capacitor.getPlatform();
  if ((platform !== "android" && platform !== "ios") || !Capacitor.isPluginAvailable("ArmadaStorage")) return undefined;
  return (plugin ??= registerPlugin<ArmadaStoragePlugin>("ArmadaStorage"));
}

type DirHandle = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

async function opfsDir(name: string): Promise<DirHandle | undefined> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return (await root?.getDirectoryHandle(name)) as DirHandle | undefined;
  } catch {
    return undefined;
  }
}

async function dirBytes(dir: DirHandle): Promise<number> {
  let total = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === "file") total += (await (handle as FileSystemFileHandle).getFile()).size;
    else total += await dirBytes(handle as DirHandle);
  }
  return total;
}

async function dirChildren(dir: DirHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name] of dir.entries()) names.push(name);
  return names;
}

async function retiredDatabasesPresent(): Promise<string[]> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return [];
  try {
    const present = new Set((await indexedDB.databases()).map((d) => d.name));
    return RETIRED_DATABASES.filter((name) => present.has(name));
  } catch {
    return [];
  }
}

function localStorageBytes(): number {
  if (typeof localStorage === "undefined") return 0;
  let chars = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) chars += key.length + (localStorage.getItem(key)?.length ?? 0);
    }
  } catch { /* unreadable: report what was counted */ }
  // Browsers hold it as UTF-16.
  return chars * 2;
}

/** The ArmadaDB row a tenant id belongs to (see `relayScope.ts` and `ARMADA_TENANTS`). */
export function tenantRow(id: string): StorageRowId {
  if (id.startsWith("dm17:")) return "dms";
  if (id.startsWith("c2:") || id === "c2park") return "communities";
  if (id.startsWith("nip29:")) return "servers";
  if (id === "main") return "profiles";
  return "otherData";
}

/** Fold a store's usage into its rows; a row is sized only when every tenant in it is. */
export function dataRows(usage: ArmadaDBUsage, settingsBytes: number): StorageRow[] {
  const rows = new Map<StorageRowId, StorageRow>();
  for (const id of ["dms", "communities", "servers", "profiles", "otherData"] as const) {
    rows.set(id, { id, count: 0, bytes: 0, clearable: false });
  }
  for (const tenant of usage.tenants) {
    const row = rows.get(tenantRow(tenant.id))!;
    row.count! += tenant.rumors;
    row.bytes = row.bytes === undefined || tenant.bytes === undefined ? undefined : row.bytes + tenant.bytes;
  }
  const out = [...rows.values()].filter((row) => row.id !== "otherData" || row.count! > 0);
  const groups = usage.kv?.groups;
  const parts = groups
    ? [{ id: LOCAL_STORAGE_PART, bytes: settingsBytes }, ...groups.map((g) => ({ id: g.group, bytes: g.bytes, entries: g.entries }))]
      .filter((part) => part.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
    : undefined;
  out.push({ id: "settings", bytes: settingsBytes + (usage.kv?.bytes ?? 0), clearable: false, ...(parts ? { parts } : {}) });
  return out;
}

const settle = <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);

export async function measureStorage(): Promise<StorageReport> {
  const native = nativeStorage();
  const platform = Capacitor.getPlatform();
  const [estimate, dbUsage, communityImages, nativeUsage, desktopWebCache, staging, retiredOpfs, retiredDbs] =
    await Promise.all([
      settle(navigator.storage?.estimate?.() ?? Promise.resolve(undefined), undefined),
      settle(getArmadaDB().usage(), { tenants: [] } as ArmadaDBUsage),
      settle(communityImageCacheUsage(), { entries: 0, bytes: 0 }),
      native ? settle(native.usage(), {}) : Promise.resolve(undefined),
      getDesktopWebCacheSize(),
      opfsDir(CALL_RECORDING_STAGING_DIR),
      opfsDir(RETIRED_OPFS_DIR),
      retiredDatabasesPresent(),
    ]);

  const media = mediaCacheUsage();
  const caches: StorageRow[] = [
    { id: "media", bytes: media.bytes, count: media.entries, clearable: media.entries > 0 },
    { id: "communityImages", bytes: communityImages.bytes, count: communityImages.entries, clearable: communityImages.entries > 0 },
  ];
  if (nativeUsage?.avatars !== undefined) {
    caches.push({ id: "notificationAvatars", bytes: nativeUsage.avatars, clearable: nativeUsage.avatars > 0 });
  }
  // iOS can clear WKWebView's cache but not size it, so the row is Android and desktop only.
  const webCache = platform === "android" ? nativeUsage?.webCache : (desktopWebCache ?? undefined);
  if (webCache !== undefined) caches.push({ id: "webCache", bytes: webCache, clearable: webCache > 0 });

  if (staging) {
    const takes = await settle(dirChildren(staging), []);
    if (takes.length > 0) {
      caches.push({ id: "callRecordings", bytes: await settle(dirBytes(staging), 0), count: takes.length, clearable: true });
    }
  }
  if (retiredOpfs || retiredDbs.length > 0) {
    const bytes = retiredOpfs ? await settle(dirBytes(retiredOpfs), 0) : 0;
    // IndexedDB can't size a single database, so retired ones are unsized.
    caches.push({ id: "legacy", bytes: retiredDbs.length > 0 ? undefined : bytes, clearable: true });
  }

  const data = dataRows(dbUsage, localStorageBytes());

  // `estimate()` covers the origin's own storage; the SQLite file and the
  // native caches sit outside it.
  const outside = (dbUsage.fileBytes ?? 0) + (nativeUsage?.avatars ?? 0) + (webCache ?? 0);
  const totalBytes = estimate?.usage !== undefined ? estimate.usage + outside : undefined;
  const onWeb = platform === "web" && !desktop();
  return { caches, data, totalBytes, quotaBytes: onWeb ? estimate?.quota : undefined };
}

async function clearCallRecordings(): Promise<void> {
  const staging = await opfsDir(CALL_RECORDING_STAGING_DIR);
  if (!staging) return;
  for (const name of await dirChildren(staging)) {
    try {
      // A take still recording holds its files open, and is refused.
      await staging.removeEntry(name, { recursive: true });
    } catch { /* in use */ }
  }
}

async function clearLegacy(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(RETIRED_OPFS_DIR, { recursive: true });
  } catch { /* absent or held open */ }
  if (typeof indexedDB === "undefined") return;
  await Promise.all(
    RETIRED_DATABASES.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}

/** Clear one clearable row. */
export async function clearStorage(id: StorageRowId): Promise<void> {
  switch (id) {
    case "media":
      return clearMediaCache();
    case "communityImages":
      return clearCommunityImageCache();
    case "notificationAvatars":
      return nativeStorage()?.clear({ kind: "avatars" });
    case "webCache":
      if (Capacitor.getPlatform() === "android") return nativeStorage()?.clear({ kind: "webCache" });
      return clearDesktopWebCache();
    case "callRecordings":
      return clearCallRecordings();
    case "legacy":
      return clearLegacy();
    default:
      throw new Error(`${id} is not a cache`);
  }
}
