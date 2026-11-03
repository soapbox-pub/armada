/**
 * Encrypted community images (icon / banner) — CORD-02 §6. Each is AES-256-GCM
 * encrypted under a fresh key; the Control Plane carries only `{url, key, nonce, hash}`
 * and the plaintext SHA-256 is verified on fetch, so a swapped blob fails closed.
 * The pointer has no mime, so decrypted bytes are sniffed for display.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { APP_BLOSSOM_SERVERS, mediaCandidates } from "@/lib/blossom";
import { decryptBuffer, fetchCapped } from "@/lib/encryptedMedia";
import { defaultMediaPolicy, routeMediaCandidates, type MediaPolicy } from "@/lib/mediaPolicy";
import { notificationIconDataUrl } from "@/lib/notificationIcon";

import type { ImagePointer } from "@/concord/lib/types";

/** 16-byte (128-bit) nonce, matching Vector's AES-GCM parameters. */
const NONCE_BYTES = 16;

/** Ceiling on a community icon/banner read. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

const CACHE_NAME = "concord-images";

/** Longest edge an uploaded community icon is stored at; it is never shown larger. */
export const COMMUNITY_ICON_EDGE = 512;

/** Longest edge an uploaded community banner is stored at. */
export const COMMUNITY_BANNER_EDGE = 1500;

function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);
  return view;
}

/** Best-effort mime from magic bytes (display only). */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes[0] === 0x3c) return "image/svg+xml"; // '<' — svg-ish
  return "application/octet-stream";
}

/** AES-GCM encrypt file bytes; returns ciphertext + the pointer fields to seal in metadata. */
export async function encryptImageBlob(
  file: File | Blob,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; key: string; nonce: string; hash: string }> {
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const cryptoKey = await crypto.subtle.importKey("raw", buf(keyBytes), "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonceBytes) }, cryptoKey, buf(plaintext));
  return {
    ciphertext: new Uint8Array(ct),
    key: bytesToHex(keyBytes),
    nonce: bytesToHex(nonceBytes),
    hash: bytesToHex(sha256(plaintext)),
  };
}

async function readCached(hash: string): Promise<Blob | undefined> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(`/${hash}`);
    return res ? await res.blob() : undefined;
  } catch {
    return undefined;
  }
}

async function writeCached(hash: string, plaintext: Uint8Array, mime: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(`/${hash}`, new Response(buf(plaintext), { headers: { "Content-Type": mime } }));
  } catch {
    // best-effort
  }
}

/** Settings › Storage: images held, and their bytes. */
export async function communityImageCacheUsage(): Promise<{ entries: number; bytes: number }> {
  if (typeof caches === "undefined" || !(await caches.has(CACHE_NAME))) return { entries: 0, bytes: 0 };
  const cache = await caches.open(CACHE_NAME);
  let bytes = 0;
  const requests = await cache.keys();
  for (const request of requests) {
    const res = await cache.match(request);
    if (res) bytes += (await res.blob()).size;
  }
  return { entries: requests.length, bytes };
}

/** Settings › Storage: drop every cached icon and banner; each decrypts again on next view. */
export async function clearCommunityImageCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  await caches.delete(CACHE_NAME);
}

/**
 * Fetch + decrypt an {@link ImagePointer} to an object URL (caller revokes).
 * Verifies SHA-256; content-addressed Cache Storage skips re-fetch across reloads.
 */
export async function decryptImagePointer(
  pointer: ImagePointer,
  signal?: AbortSignal,
  servers?: readonly string[],
  policy?: MediaPolicy,
): Promise<string> {
  const cached = await readCached(pointer.hash);
  if (cached) return URL.createObjectURL(cached);
  const { bytes, mime } = await decryptImageBytes(pointer, signal, servers, policy);
  return URL.createObjectURL(new Blob([buf(bytes)], { type: mime }));
}

/**
 * {@link decryptImagePointer} stopping at plaintext bytes, for the push service
 * worker (no `URL.createObjectURL` there). Walks `servers` since the ciphertext
 * is mirrored (BUD-04), and honours the viewer's media policy/proxy.
 */
export async function decryptImageBytes(
  pointer: ImagePointer,
  signal?: AbortSignal,
  servers: readonly string[] = APP_BLOSSOM_SERVERS,
  policy: MediaPolicy = defaultMediaPolicy(),
): Promise<{ bytes: Uint8Array; mime: string }> {
  const cached = await readCached(pointer.hash);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    return { bytes, mime: cached.type || sniffImageMime(bytes) };
  }

  // Runs unprompted (incl. in the push worker), so cap the read.
  const { sources } = routeMediaCandidates(mediaCandidates(pointer.url, undefined, servers), policy);
  const ciphertext = await fetchCapped(sources, {
    signal,
    maxBytes: MAX_IMAGE_BYTES,
  });

  const pt = await decryptBuffer(ciphertext, pointer.key, pointer.nonce);
  const plaintext = new Uint8Array(pt);

  if (bytesToHex(sha256(plaintext)) !== pointer.hash.toLowerCase()) {
    throw new Error("image integrity check failed");
  }
  const mime = sniffImageMime(plaintext);
  void writeCached(pointer.hash, plaintext, mime);
  return { bytes: plaintext, mime };
}

/**
 * A community icon as a small `data:` URL for a notification: a host draws it
 * from the URL alone, and can neither fetch a `blob:` nor afford the original.
 * Undefined when it can't be fetched, decrypted or made small enough.
 */
export async function decryptNotificationIcon(
  pointer: ImagePointer,
  servers: readonly string[] = APP_BLOSSOM_SERVERS,
  policy: MediaPolicy = defaultMediaPolicy(),
): Promise<string | undefined> {
  try {
    const { bytes, mime } = await decryptImageBytes(pointer, undefined, servers, policy);
    return await notificationIconDataUrl(bytes, mime);
  } catch {
    return undefined;
  }
}
