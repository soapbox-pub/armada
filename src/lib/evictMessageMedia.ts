import { blobHashOf, forgetBlob } from "@/lib/mediaCache";
import { evictAttachment } from "@/lib/encryptedMedia";

/** Fields of an `imeta` entry naming a blob this device may hold. */
const URL_FIELDS = new Set(["url", "thumb", "image", "fallback"]);
const HASH_FIELDS = new Set(["x", "ox"]);

export interface MediaRefs {
  urls: Set<string>;
  hashes: Set<string>;
}

/** Every URL and blob hash a message's `imeta` and body name. */
export function mediaRefs(tags: readonly string[][], content: string, into: MediaRefs = { urls: new Set(), hashes: new Set() }): MediaRefs {
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    for (const part of tag.slice(1)) {
      const space = part.indexOf(" ");
      if (space <= 0) continue;
      const field = part.slice(0, space);
      const value = part.slice(space + 1).trim();
      if (URL_FIELDS.has(field)) into.urls.add(value);
      else if (HASH_FIELDS.has(field) && /^[0-9a-f]{64}$/i.test(value)) into.hashes.add(value.toLowerCase());
    }
  }
  for (const match of content.matchAll(/https?:\/\/\S+/g)) into.urls.add(match[0]);
  for (const url of into.urls) {
    const hash = blobHashOf(url);
    if (hash) into.hashes.add(hash);
  }
  return into;
}

/** A message whose media stays: still shown, so its copies are in use. */
export interface KeptMessage {
  tags: readonly string[][];
  content: string;
}

/**
 * Forget this device's copies of a removed message's media (decrypted object
 * URLs and cached blobs, by URL and `imeta` hash), except what a `kept` message
 * also names: a forward on screen still shows it.
 */
export function evictMessageMedia(tags: readonly string[][], content = "", kept: Iterable<KeptMessage> = []): void {
  const refs = mediaRefs(tags, content);
  let inUse: MediaRefs | undefined;
  for (const msg of kept) inUse = mediaRefs(msg.tags, msg.content, inUse);
  for (const url of refs.urls) if (!inUse?.urls.has(url)) evictAttachment(url);
  for (const hash of refs.hashes) if (!inUse?.hashes.has(hash)) forgetBlob(hash);
}

/** The media a profile shows: its picture and banner, as URLs in a body. */
function profileMedia(content: string): string {
  try {
    const metadata = JSON.parse(content) as { picture?: unknown; banner?: unknown };
    return [metadata.picture, metadata.banner].filter((url) => typeof url === "string").join(" ");
  } catch {
    return "";
  }
}

/** {@link evictMessageMedia} for a stored row of any kind, a kind-0 profile's picture and banner included. */
export function evictRowMedia(row: { kind: number; tags: readonly string[][]; content: string }): void {
  evictMessageMedia(row.tags, row.kind === 0 ? profileMedia(row.content) : row.content);
}

/** Removed messages whose media was already evicted; rumor ids, so cleared on logout. */
const evicted = new Set<string>();

/**
 * {@link evictMessageMedia} once per removed message id. `alsoInUse` adds the
 * store's other users of its media; if it fails nothing is evicted.
 */
export async function evictRemovedMessageMedia(
  id: string,
  tags: readonly string[][],
  content = "",
  kept: Iterable<KeptMessage> = [],
  alsoInUse?: () => Promise<Iterable<KeptMessage>>,
): Promise<void> {
  if (evicted.has(id)) return;
  evicted.add(id);
  const keep = [...kept];
  if (alsoInUse) {
    try {
      keep.push(...await alsoInUse());
    } catch {
      evicted.delete(id);
      return;
    }
  }
  evictMessageMedia(tags, content, keep);
}

export function clearEvictedMediaMemory(): void {
  evicted.clear();
}
