/**
 * Authenticated media for Buzz relays. Buzz serves Blossom blobs at
 * `https://<host>/media/<sha256>[.thumb][.ext]` with BUD-11 auth REQUIRED on
 * GET, so a plain `<img src>` 401s. For known Buzz hosts only, fetch with a
 * signed kind-24242 header and return an object URL. The token is
 * server-scoped (`["server", host]`, BUD-11 §5), so one per host, cached.
 */

import { N64 } from "@nostrify/nostrify/utils";

import { clockNowMs } from "@/lib/relayClock";

import type { NostrSigner } from "@nostrify/nostrify";

/** Lowercased hosts (e.g. "soapbox.communities.buzz.xyz") known to be Buzz. */
const buzzMediaHosts = new Set<string>();

/** Bumped whenever the host set grows, so hooks can re-evaluate `isBuzzMediaUrl`. */
let hostsVersion = 0;
const hostsListeners = new Set<() => void>();

function hostOf(url: string): string | null {
  try {
    // `new URL` keeps the host for ws(s) and http(s) alike.
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Mark a host (from any ws/http URL on it) as a Buzz media host. Idempotent. */
export function registerBuzzMediaHost(url: string | undefined): void {
  if (!url) return;
  const host = hostOf(url);
  if (!host || buzzMediaHosts.has(host)) return;
  buzzMediaHosts.add(host);
  hostsVersion += 1;
  for (const listener of hostsListeners) listener();
}

export function subscribeBuzzMediaHosts(listener: () => void): () => void {
  hostsListeners.add(listener);
  return () => {
    hostsListeners.delete(listener);
  };
}

export function getBuzzMediaHostsVersion(): number {
  return hostsVersion;
}

/** Buzz media path: `/media/<64-hex>` optionally `.thumb` and/or an extension. */
const MEDIA_PATH_RE = /^\/media\/[0-9a-f]{64}(?:\.thumb)?(?:\.[a-z0-9]+)?$/i;

/** Whether `url` is a media blob on a known Buzz host (so it needs GET auth). */
export function isBuzzMediaUrl(url: string | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  if (!host || !buzzMediaHosts.has(host)) return false;
  try {
    return MEDIA_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * The logged-in user's signer, published once at app root (see NostrSync).
 * `undefined` when logged out; callers then fall back to the plain URL.
 */
let currentSigner: NostrSigner | undefined;

export function setBuzzMediaSigner(signer: NostrSigner | undefined): void {
  currentSigner = signer;
}

/** The relay accepts tokens up to 1h old; re-mint at 30 min for margin. */
const TOKEN_REFRESH_MS = 30 * 60 * 1000;
/** Lifetime stamped into the `expiration` tag (1h). */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

interface CachedToken {
  header: string;
  mintedAt: number;
  /** Pubkey the token was signed by, so a login change re-mints. */
  pubkey: string;
}

const tokenByHost = new Map<string, CachedToken>();

/** In-flight mints, so concurrent image loads on a host share one signature. */
const mintInFlight = new Map<string, Promise<string>>();
/** Bumped by {@link clearBuzzMediaCache}, so a mint signed before it isn't kept. */
let tokenGeneration = 0;

async function mintGetToken(signer: NostrSigner, host: string): Promise<string> {
  const now = clockNowMs();
  const generation = tokenGeneration;
  const event = await signer.signEvent({
    kind: 24242,
    // BUD-11 requires a non-empty, human-readable content string.
    content: "Get media",
    created_at: Math.floor(now / 1000),
    tags: [
      ["t", "get"],
      ["server", host],
      ["expiration", Math.floor((now + TOKEN_LIFETIME_MS) / 1000).toString()],
    ],
  });
  const header = `Nostr ${N64.encodeEvent(event)}`;
  if (generation === tokenGeneration) tokenByHost.set(host, { header, mintedAt: now, pubkey: event.pubkey });
  return header;
}

async function getGetAuthHeader(
  signer: NostrSigner,
  host: string,
  pubkey: string,
): Promise<string> {
  const cached = tokenByHost.get(host);
  if (
    cached &&
    cached.pubkey === pubkey &&
    Date.now() - cached.mintedAt < TOKEN_REFRESH_MS
  ) {
    return cached.header;
  }
  const existing = mintInFlight.get(host);
  if (existing) return existing;
  const promise = mintGetToken(signer, host).finally(() => {
    if (mintInFlight.get(host) === promise) mintInFlight.delete(host);
  });
  mintInFlight.set(host, promise);
  return promise;
}

/** Max total bytes kept alive as object URLs (~96 MB). */
const MAX_CACHED_BYTES = 96 * 1024 * 1024;
/** Keep a revoked URL alive briefly so a still-mounted `<img>` can re-resolve. */
const REVOKE_GRACE_MS = 30_000;

interface Entry {
  promise: Promise<string>;
  bytes: number;
  url?: string;
}

/** url → entry. Insertion order = LRU order. */
const cache = new Map<string, Entry>();
let totalBytes = 0;

function touch(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function evictToBudget(keep: string): void {
  for (const [key, entry] of cache) {
    if (totalBytes <= MAX_CACHED_BYTES) break;
    if (key === keep) continue;
    cache.delete(key);
    totalBytes -= entry.bytes;
    const url = entry.url;
    if (url) setTimeout(() => URL.revokeObjectURL(url), REVOKE_GRACE_MS);
  }
}

/**
 * Drop every cached blob (revoking its object URL now) and every GET token
 * (logout): both belong to the account that fetched them.
 */
export function clearBuzzMediaCache(): void {
  for (const entry of cache.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  cache.clear();
  totalBytes = 0;
  tokenByHost.clear();
  mintInFlight.clear();
  tokenGeneration += 1;
}

/**
 * Fetch a Buzz media blob with BUD-11 GET auth and return a cached object URL.
 * Throws when logged out or on fetch failure.
 */
export async function resolveBuzzMediaObjectURL(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const signer = currentSigner;
  if (!signer) throw new Error("Buzz media: no signer to mint GET auth");

  const existing = cache.get(url);
  if (existing) {
    touch(url, existing);
    return existing.promise;
  }

  const host = hostOf(url);
  if (!host) throw new Error("Buzz media: unparseable URL");

  const entry: Entry = { promise: Promise.resolve(""), bytes: 0 };

  entry.promise = (async () => {
    const pubkey = await signer.getPublicKey();

    const fetchOnce = async (header: string) =>
      fetch(url, { headers: { Authorization: header }, signal });

    let header = await getGetAuthHeader(signer, host, pubkey);
    let res = await fetchOnce(header);
    // 401/403 likely means the cached token drifted out of window: re-mint once.
    if (res.status === 401 || res.status === 403) {
      tokenByHost.delete(host);
      header = await getGetAuthHeader(signer, host, pubkey);
      res = await fetchOnce(header);
    }
    if (!res.ok) throw new Error(`Buzz media fetch failed: HTTP ${res.status}`);

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (cache.get(url) === entry) {
      entry.bytes = blob.size;
      entry.url = objectUrl;
      totalBytes += entry.bytes;
      evictToBudget(url);
    }
    return objectUrl;
  })();

  cache.set(url, entry);
  entry.promise.catch(() => {
    if (cache.get(url) === entry) {
      cache.delete(url);
      totalBytes -= entry.bytes;
    }
  });

  return entry.promise;
}
