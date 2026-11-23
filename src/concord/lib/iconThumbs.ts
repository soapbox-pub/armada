/**
 * Small decrypted community icons in localStorage, read synchronously so the rail
 * paints a community's icon on its first frame instead of after the persisted
 * fold, the Cache Storage read and the decode. Keyed by the icon's plaintext hash,
 * so a changed icon is a miss. The `armada:` prefix gets it purged on logout.
 */

import { decryptImageBytes } from "@/concord/lib/image";
import type { ImagePointer } from "@/concord/lib/types";
import type { MediaPolicy } from "@/lib/mediaPolicy";
import { notificationIconDataUrl } from "@/lib/notificationIcon";

/** v1 thumbs drawn under a fingerprint blocker hold its noise under the right hash. */
const PREFIX = "armada:c2icon:v2:";
const STALE_PREFIX = "armada:c2icon:v1:";
const INDEX_KEY = "armada:c2icon:index";
const MAX_THUMBS = 64;
/** A 48px rail icon at the densest phone screens. */
const THUMB_EDGE = 128;

export interface IconThumb {
  hash: string;
  url: string;
}

/** Includes misses, so a render never re-reads storage for an absent icon. */
const memory = new Map<string, IconThumb | null>();

export function clearIconThumbMemory(): void {
  memory.clear();
}

export function readIconThumb(communityId: string): IconThumb | undefined {
  const known = memory.get(communityId);
  if (known !== undefined) return known ?? undefined;
  let thumb: IconThumb | null = null;
  try {
    const raw = localStorage.getItem(PREFIX + communityId);
    const parsed = raw ? (JSON.parse(raw) as Partial<IconThumb>) : undefined;
    if (typeof parsed?.hash === "string" && typeof parsed.url === "string" && parsed.url.startsWith("data:image/")) {
      thumb = { hash: parsed.hash, url: parsed.url };
    }
  } catch {
    // unavailable or corrupt: a miss
  }
  memory.set(communityId, thumb);
  return thumb ?? undefined;
}

function readIndex(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function writeIconThumb(communityId: string, thumb: IconThumb): void {
  memory.set(communityId, thumb);
  try {
    localStorage.setItem(PREFIX + communityId, JSON.stringify(thumb));
    localStorage.removeItem(STALE_PREFIX + communityId);
    const index = readIndex().filter((id) => id !== communityId);
    index.push(communityId);
    while (index.length > MAX_THUMBS) {
      const evicted = index.shift();
      if (evicted) {
        localStorage.removeItem(PREFIX + evicted);
        memory.delete(evicted);
      }
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // best-effort (quota)
  }
}

export function deleteIconThumb(communityId: string): void {
  memory.set(communityId, null);
  try {
    localStorage.removeItem(PREFIX + communityId);
    localStorage.removeItem(STALE_PREFIX + communityId);
    localStorage.setItem(INDEX_KEY, JSON.stringify(readIndex().filter((id) => id !== communityId)));
  } catch {
    // best-effort
  }
}

/** The icon redrawn at rail size as a `data:` URL, or undefined. */
export async function makeIconThumb(
  pointer: ImagePointer,
  servers: readonly string[],
  policy: MediaPolicy,
): Promise<string | undefined> {
  try {
    const { bytes, mime } = await decryptImageBytes(pointer, undefined, servers, policy);
    return await notificationIconDataUrl(bytes, mime, THUMB_EDGE);
  } catch {
    return undefined;
  }
}
