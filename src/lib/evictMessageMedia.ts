import { blobHashOf, forgetBlob } from "@/lib/mediaCache";
import { evictAttachment } from "@/lib/encryptedMedia";

/** Fields of an `imeta` entry naming a blob this device may hold. */
const URL_FIELDS = new Set(["url", "thumb", "image", "fallback"]);
const HASH_FIELDS = new Set(["x", "ox"]);

interface MediaRefs {
  urls: Set<string>;
  hashes: Set<string>;
}

/** Every URL and blob hash a message's `imeta` and body name. */
function mediaRefs(tags: readonly string[][], content: string, into: MediaRefs = { urls: new Set(), hashes: new Set() }): MediaRefs {
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
 * Forget every copy this device keeps of a removed message's media: the
 * decrypted object URLs and the cached blobs, under each URL it names and each
 * hash its `imeta` declares. Media a `kept` message also names stays, or a
 * forward still on screen would lose it. Relays and media servers still hold
 * their copies.
 */
export function evictMessageMedia(tags: readonly string[][], content = "", kept: Iterable<KeptMessage> = []): void {
  const refs = mediaRefs(tags, content);
  let inUse: MediaRefs | undefined;
  for (const msg of kept) inUse = mediaRefs(msg.tags, msg.content, inUse);
  for (const url of refs.urls) if (!inUse?.urls.has(url)) evictAttachment(url);
  for (const hash of refs.hashes) if (!inUse?.hashes.has(hash)) forgetBlob(hash);
}

/** Removed messages whose media was already evicted; rumor ids, so cleared on logout. */
const evicted = new Set<string>();

/** {@link evictMessageMedia} once per removed message id. */
export function evictRemovedMessageMedia(
  id: string,
  tags: readonly string[][],
  content = "",
  kept: Iterable<KeptMessage> = [],
): void {
  if (evicted.has(id)) return;
  evicted.add(id);
  evictMessageMedia(tags, content, kept);
}

export function clearEvictedMediaMemory(): void {
  evicted.clear();
}
