import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { blobHashOf, cachedBlob, storeBlob } from "@/lib/mediaCache";

import type { ImetaEncryption } from "@/lib/imeta";

/**
 * Client-encrypted Blossom attachments (Vector / 0xChat): AES-256-GCM before
 * upload, blob = `ciphertext || 16-byte tag` (WebCrypto's layout), key and
 * 16-byte nonce in the NIP-92 `imeta` (`decryption-key` / `decryption-nonce`).
 *
 * Decrypts are cached as object URLs per (url, key, nonce), bounded by total
 * BYTES (LRU, not count — iOS Safari OOMs otherwise), with revocation deferred
 * so mounted elements can re-resolve. AES-GCM can't stream, so single reads are
 * also capped ({@link readCapped}) and decrypts run behind a semaphore.
 */

/** Max total decrypted bytes to keep alive as object URLs (~192 MB). */
const MAX_CACHED_BYTES = 192 * 1024 * 1024;
/** How long to keep a revoked entry's object URL alive after eviction. */
const REVOKE_GRACE_MS = 30_000;

/**
 * Ciphertext cap for automatic inline decrypts (sender-chosen size). Past it
 * the UI offers "decrypt anyway" ({@link FileTooLargeError}).
 */
export const MAX_DECRYPT_BYTES = 64 * 1024 * 1024;

/** Cap for explicitly requested decrypts; still bounded since `size` is sender-controlled. */
export const MAX_EXPLICIT_DECRYPT_BYTES = 512 * 1024 * 1024;

/** Thrown when a body exceeds the caller's `maxBytes` budget. */
export class FileTooLargeError extends Error {
  /** Size in bytes: from Content-Length, or what had been read when we bailed. */
  readonly byteSize: number;

  constructor(byteSize: number) {
    super(`encrypted attachment is too large to decrypt: ${byteSize} bytes`);
    this.name = "FileTooLargeError";
    this.byteSize = byteSize;
  }
}

/**
 * Read a body, refusing to buffer more than `maxBytes`: Content-Length is
 * checked first, then enforced on the stream (the header can lie).
 * Preallocates when the length is known, keeping peak memory at one copy.
 * `onProgress` gets the fraction read, only when the length is declared.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const header = res.headers.get("content-length");
  const declared = header === null ? NaN : Number(header);
  const hasDeclared = Number.isFinite(declared) && declared >= 0;

  if (hasDeclared && declared > maxBytes) throw new FileTooLargeError(declared);

  if (!res.body) {
    // No streaming (older WebViews).
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new FileTooLargeError(buffer.byteLength);
    return buffer;
  }

  const reader = res.body.getReader();
  const limit = hasDeclared ? Math.min(declared, maxBytes) : maxBytes;
  const preallocated = hasDeclared ? new Uint8Array(declared) : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel();
      throw new FileTooLargeError(total + value.byteLength);
    }
    if (preallocated) preallocated.set(value, total);
    else chunks.push(value);
    total += value.byteLength;
    if (hasDeclared && declared > 0) onProgress?.(Math.min(1, total / declared));
  }

  if (preallocated) {
    // A short body is legal.
    return total === preallocated.byteLength ? preallocated.buffer : preallocated.buffer.slice(0, total);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

/** Limit concurrent decrypts, so a screenful of attachments can't all buffer at once. */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

const withDecryptSlot = createSemaphore(3);

/**
 * Fetch a blob with a byte ceiling, walking same-content mirror URLs
 * ({@link mediaCandidates} order) on network/HTTP errors. Aborts and
 * {@link FileTooLargeError} end the walk immediately.
 */
export async function fetchCapped(
  urls: string | readonly string[],
  opts: { signal?: AbortSignal; maxBytes?: number; onProgress?: (fraction: number) => void } = {},
): Promise<ArrayBuffer> {
  const list = typeof urls === "string" ? [urls] : urls;
  if (list.length === 0) throw new Error("attachment fetch failed: no source");
  // Mirrors hold the same blob, so the first URL's hash names them all.
  const hash = blobHashOf(list[0]);
  if (hash) {
    const cached = await cachedBlob(hash);
    if (cached && cached.size <= (opts.maxBytes ?? MAX_DECRYPT_BYTES)) return cached.arrayBuffer();
  }
  let lastError: unknown;
  for (const url of list) {
    try {
      const res = await fetch(url, { signal: opts.signal });
      if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`);
      const body = await readCapped(res, opts.maxBytes ?? MAX_DECRYPT_BYTES, opts.onProgress);
      if (hash) void storeBlob(hash, body, res.headers.get("content-type") ?? "");
      return body;
    } catch (e) {
      if (opts.signal?.aborted || e instanceof FileTooLargeError) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

interface Entry {
  promise: Promise<string>;
  /** Decrypted byte size (0 until resolved). */
  bytes: number;
  url?: string;
  /** Evicted or cleared before it resolved: its object URL is revoked as it lands. */
  dropped?: boolean;
}

/** key = `${url}\n${key}\n${nonce}`; insertion order = LRU order. */
const cache = new Map<string, Entry>();
let totalBytes = 0;

function cacheKey(url: string, enc: ImetaEncryption | undefined): string {
  return enc ? `${url}\n${enc.key}\n${enc.nonce}` : `${url}\nplain`;
}

function touch(k: string, entry: Entry): void {
  cache.delete(k);
  cache.set(k, entry);
}

function evictToBudget(keep: string): void {
  for (const [k, entry] of cache) {
    if (totalBytes <= MAX_CACHED_BYTES) break;
    if (k === keep) continue; // never evict the entry we just resolved
    cache.delete(k);
    totalBytes -= entry.bytes;
    // Defer revocation so still-mounted elements can re-resolve.
    const url = entry.url;
    if (url) setTimeout(() => URL.revokeObjectURL(url), REVOKE_GRACE_MS);
  }
}

/**
 * Drop every cached decrypt of `url` (whatever key opened it) and revoke its
 * object URL now: a moderator removed the message it came in.
 */
export function evictAttachment(url: string): void {
  for (const [k, entry] of cache) {
    if (!k.startsWith(`${url}\n`)) continue;
    cache.delete(k);
    totalBytes -= entry.bytes;
    entry.dropped = true;
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

/**
 * Drop every cached decrypt and revoke its object URL now (logout): these are
 * the previous account's plaintext. A decrypt still in flight is revoked as it lands.
 */
export function clearAttachmentCache(): void {
  for (const entry of cache.values()) {
    entry.dropped = true;
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  cache.clear();
  totalBytes = 0;
}

/** Copy bytes into a fresh ArrayBuffer-backed view (WebCrypto wants `ArrayBuffer`, not `ArrayBufferLike`). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);
  return view;
}

/**
 * Verify decrypted bytes against the sender's `ox` (plaintext SHA-256), so a
 * swapped/truncated blob on an unauthenticated server fails closed. Skipped
 * without `ox` (forwards may lack it).
 */
export async function verifyPlaintextHash(plaintext: Uint8Array, ox: string | undefined): Promise<void> {
  if (!ox) return;
  if ((await sha256Hex(plaintext)) !== ox.toLowerCase()) {
    throw new Error("decrypted attachment does not match its `ox` hash");
  }
}

/** SHA-256 via native WebCrypto (off main thread); pure-JS fallback in insecure contexts. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    // Hash in place; `buf` would copy a whole video.
    const view = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : buf(bytes);
    return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", view)));
  }
  return bytesToHex(sha256(bytes));
}

/**
 * The already-resolved object URL, or `undefined`. Lets remounts paint on the
 * FIRST frame (a resolved promise still costs a commit). Counts as an LRU use.
 */
export function peekAttachmentObjectURL(url: string, enc: ImetaEncryption): string | undefined {
  const k = cacheKey(url, enc);
  const entry = cache.get(k);
  if (!entry?.url) return undefined;
  touch(k, entry);
  return entry.url;
}

/**
 * Seed the cache with a file this device just uploaded, so rendering it (tray,
 * timeline, lightbox) reads the bytes in hand instead of downloading them back.
 * `enc` is the upload's encryption, or `undefined` for a plain blob.
 */
export function primeAttachment(url: string, enc: ImetaEncryption | undefined, plaintext: Blob): void {
  const k = cacheKey(url, enc);
  if (cache.get(k)?.url) return;
  const objectUrl = URL.createObjectURL(plaintext);
  cache.set(k, { promise: Promise.resolve(objectUrl), bytes: plaintext.size, url: objectUrl });
  totalBytes += plaintext.size;
  evictToBudget(k);
}

/** A {@link primeAttachment}ed object URL for a reference, or `undefined`. Counts as an LRU use. */
export function peekPrimedAttachment(url: string, enc: ImetaEncryption | undefined): string | undefined {
  const k = cacheKey(url, enc);
  const entry = cache.get(k);
  if (!entry?.url) return undefined;
  touch(k, entry);
  return entry.url;
}

/**
 * Fetch + AES-GCM-decrypt an attachment into an object URL (`mime` is display
 * only). Throws on failure; {@link FileTooLargeError} is retryable with a
 * bigger budget. `alternates` are mirrors of the same ciphertext; the cache is
 * keyed on the primary URL.
 */
export async function decryptAttachmentToObjectURL(
  url: string,
  enc: ImetaEncryption,
  mime: string | undefined,
  opts: { signal?: AbortSignal; maxBytes?: number; alternates?: readonly string[] } = {},
): Promise<string> {
  const k = cacheKey(url, enc);
  const existing = cache.get(k);
  if (existing) {
    touch(k, existing);
    return existing.promise;
  }

  const entry: Entry = { promise: Promise.resolve(""), bytes: 0 };

  entry.promise = withDecryptSlot(async () => {
    const ciphertext = await fetchCapped([url, ...(opts.alternates ?? [])], opts);
    // Pass ArrayBuffers through to avoid two full copies of a video.
    const plaintext = await decryptBuffer(ciphertext, enc.key, enc.nonce);
    await verifyPlaintextHash(new Uint8Array(plaintext), enc.ox);
    const blob = new Blob([plaintext], { type: mime || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    if (entry.dropped) {
      URL.revokeObjectURL(objectUrl);
      return objectUrl;
    }
    if (cache.get(k) === entry) {
      entry.bytes = plaintext.byteLength;
      entry.url = objectUrl;
      totalBytes += entry.bytes;
      evictToBudget(k);
    }
    return objectUrl;
  });

    // Share in-flight work; drop on failure so it can be retried.
  cache.set(k, entry);
  entry.promise.catch(() => {
    if (cache.get(k) === entry) {
      cache.delete(k);
      totalBytes -= entry.bytes;
    }
  });

  return entry.promise;
}

export interface EncryptedUpload {
  /** `ciphertext || 16-byte GCM tag`, ready to upload. */
  file: File;
  key: string;
  /** 16-byte GCM nonce as hex (0xChat / Vector compatible). */
  nonce: string;
  /** Plaintext SHA-256 hex, published as imeta `ox`. */
  originalHash: string;
}

/**
 * Encrypt a file for a client-encrypted Blossom upload, matching Vector /
 * 0xChat (random 32-byte key, 16-byte nonce). Keeps the original MIME: many
 * Blossom servers reject `application/octet-stream`.
 */
export async function encryptFileForUpload(file: File): Promise<EncryptedUpload> {
  return encryptFileWithParams(
    file,
    bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  );
}

/**
 * Encrypt under given params: NIP-17 companion blobs (`thumb`, `fallback`)
 * use the same key and nonce as their file.
 */
export async function encryptFileWithParams(
  file: File,
  key: string,
  nonce: string,
): Promise<EncryptedUpload> {
  const plaintext = new Uint8Array(await file.arrayBuffer());

  const ciphertext = await encryptBytes(plaintext, key, nonce);

  const encryptedFile = new File([ciphertext], file.name, {
    type: file.type || "application/octet-stream",
  });

  return {
    file: encryptedFile,
    key,
    nonce,
    originalHash: bytesToHex(sha256(plaintext)),
  };
}

/** AES-256-GCM encrypt (`ciphertext || tag`, cross-client compatible). Exported for testing. */
export async function encryptBytes(
  plaintext: Uint8Array,
  keyHex: string,
  nonceHex: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", buf(hexToBytes(keyHex)), "AES-GCM", false, ["encrypt"]);
  const ctBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(hexToBytes(nonceHex)) },
    cryptoKey,
    buf(plaintext),
  );
  return new Uint8Array(ctBuffer);
}

/** AES-256-GCM decrypt, ArrayBuffer in/out (avoids copying video on the media path). */
export async function decryptBuffer(
  ciphertext: BufferSource,
  keyHex: string,
  nonceHex: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", buf(hexToBytes(keyHex)), "AES-GCM", false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(hexToBytes(nonceHex)) }, cryptoKey, ciphertext);
}

/** {@link decryptBuffer} for the callers that want bytes. Exported for testing. */
export async function decryptBytes(
  ciphertext: Uint8Array,
  keyHex: string,
  nonceHex: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await decryptBuffer(buf(ciphertext), keyHex, nonceHex));
}

