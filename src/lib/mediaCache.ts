/**
 * A persistent cache of content-addressed media (Blossom blobs: the URL names
 * the SHA-256 of the bytes), sized by us rather than by the WebView's HTTP
 * cache, which on Android holds ~20 MB and evicts a scrolled-past channel's
 * images within minutes. Keyed by the hash, so every mirror and proxy of a
 * blob shares one entry, and an entry is stored only once its bytes hash to
 * that name — a host can't plant anything under it.
 *
 * Holds exactly the bytes the network serves: ciphertext for an encrypted
 * attachment, never its plaintext. Cache Storage, so logout's purge deletes it.
 */

const CACHE_NAME = "armada-media-v1";
const INDEX_KEY = "armada:media-cache-index";
/** Total bytes kept; least recently used first out. */
const BUDGET_BYTES = 256 * 1024 * 1024;
/** Larger blobs aren't kept (one video shouldn't flush a channel's images). */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const INDEX_PERSIST_MS = 2_000;

const HASH_RE = /(?:^|[^0-9a-f])([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?(?:$|[?#])/i;

const hashOfUrl = new Map<string, string | undefined>();
const HASH_MEMO_MAX = 4096;

/** The blob hash a URL names (also through a proxy's `?url=`), or undefined. */
export function blobHashOf(url: string): string | undefined {
  // Called per media row per render; `new URL` dominated a channel switch.
  if (hashOfUrl.has(url)) return hashOfUrl.get(url);
  const hash = parseBlobHash(url);
  if (hashOfUrl.size >= HASH_MEMO_MAX) hashOfUrl.clear();
  hashOfUrl.set(url, hash);
  return hash;
}

function parseBlobHash(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const path = HASH_RE.exec(u.pathname)?.[1];
  if (path) return path.toLowerCase();
  for (const value of u.searchParams.values()) {
    if (/^https?:\/\//i.test(value)) return blobHashOf(value);
  }
  return undefined;
}

type Index = Record<string, { b: number; u: number }>;
let index: Index | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function available(): boolean {
  return typeof caches !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

function loadIndex(): Index {
  if (index) return index;
  try {
    index = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}") as Index;
  } catch {
    index = {};
  }
  return index;
}

function persistIndex(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(loadIndex()));
    } catch { /* best effort: an unindexed entry is only harder to evict */ }
  }, INDEX_PERSIST_MS);
}

const keyOf = (hash: string) => `https://media.invalid/${hash}`;

/** Whether `hash` is (as far as the index knows) in the cache — synchronous. */
export function isMediaCached(hash: string): boolean {
  return available() && !!loadIndex()[hash];
}

/** The cached bytes for `hash`, or undefined. */
export async function cachedBlob(hash: string): Promise<Blob | undefined> {
  if (!available() || !loadIndex()[hash]) return undefined;
  try {
    const res = await (await caches.open(CACHE_NAME)).match(keyOf(hash));
    if (!res) {
      delete loadIndex()[hash];
      persistIndex();
      return undefined;
    }
    loadIndex()[hash].u = Date.now();
    persistIndex();
    return await res.blob();
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Hashes forgotten this session: a download already in flight must not store them back. */
const forgotten = new Set<string>();

/** Drop `hash`'s bytes from the cache (its message was removed). */
export function forgetBlob(hash: string): void {
  forgotten.add(hash);
  if (!available() || !loadIndex()[hash]) return;
  delete loadIndex()[hash];
  persistIndex();
  void caches.open(CACHE_NAME).then((cache) => cache.delete(keyOf(hash))).catch(() => undefined);
}

/** Keep `bytes` under `hash` if they are what the hash names. */
export async function storeBlob(hash: string, bytes: ArrayBuffer, type: string): Promise<void> {
  if (!available() || bytes.byteLength === 0 || bytes.byteLength > MAX_ENTRY_BYTES) return;
  const idx = loadIndex();
  if (idx[hash] || forgotten.has(hash)) return;
  try {
    if ((await sha256Hex(bytes)) !== hash) return;
    const cache = await caches.open(CACHE_NAME);
    if (forgotten.has(hash)) return;
    await cache.put(keyOf(hash), new Response(bytes, { headers: { "content-type": type || "application/octet-stream" } }));
    idx[hash] = { b: bytes.byteLength, u: Date.now() };
    let total = 0;
    for (const e of Object.values(idx)) total += e.b;
    if (total > BUDGET_BYTES) {
      for (const [h, e] of Object.entries(idx).sort((a, b) => a[1].u - b[1].u)) {
        if (total <= BUDGET_BYTES) break;
        if (h === hash) continue;
        delete idx[h];
        total -= e.b;
        void cache.delete(keyOf(h));
      }
    }
    persistIndex();
  } catch { /* quota or private mode: just uncached */ }
}

/**
 * After an `<img>` loaded `url`, keep its bytes. The response is still in the
 * HTTP cache it just came through, so `force-cache` reads it from there;
 * only a host without CORS (no readable body) is skipped.
 */
export function captureLoadedMedia(url: string): void {
  const hash = blobHashOf(url);
  if (!hash || !available() || loadIndex()[hash]) return;
  void (async () => {
    try {
      const res = await fetch(url, { cache: "force-cache", mode: "cors", credentials: "omit" });
      if (!res.ok) return;
      await storeBlob(hash, await res.arrayBuffer(), res.headers.get("content-type") ?? "");
    } catch { /* uncached */ }
  })();
}

/** Object URLs handed out for cached blobs, so a remount doesn't re-read the cache. */
const objectUrls = new Map<string, string>();
const MAX_OBJECT_URLS = 200;

/** A synchronous hit from this session's object URLs. */
export function peekCachedMediaUrl(hash: string): string | undefined {
  return objectUrls.get(hash);
}

/** An object URL for a cached blob, or undefined on a miss. */
export async function cachedMediaUrl(hash: string): Promise<string | undefined> {
  const held = objectUrls.get(hash);
  if (held) return held;
  const blob = await cachedBlob(hash);
  if (!blob) return undefined;
  const url = objectUrls.get(hash) ?? URL.createObjectURL(blob);
  objectUrls.set(hash, url);
  if (objectUrls.size > MAX_OBJECT_URLS) {
    const [oldest, oldUrl] = objectUrls.entries().next().value as [string, string];
    objectUrls.delete(oldest);
    // Deferred: a still-mounted element may be showing it.
    setTimeout(() => URL.revokeObjectURL(oldUrl), 30_000);
  }
  return url;
}

/** Logout: drop this session's object URLs (Cache Storage itself is purged with the rest). */
export function clearMediaCacheMemory(): void {
  forgotten.clear();
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  hashOfUrl.clear();
  index = undefined;
  clearTimeout(persistTimer);
  persistTimer = undefined;
}
