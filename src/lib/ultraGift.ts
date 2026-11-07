import { nip19 } from "nostr-tools";

import { tryNpubEncode } from "@/lib/safeNip19";
import { shareOrigin } from "@/lib/shareOrigin";

/**
 * An Armada Ultra gift: `/gift/<gifter's npub>`. Ultra is free and lives in the
 * recipient's own kind 0, so the link carries no secret; it only names who sent
 * it. Redeeming is the recipient's explicit press, like getting Ultra directly.
 */
export const GIFT_PATH_PREFIX = "/gift/";

/** The in-app route for a gift from `pubkey`, or undefined for a bad key. */
export function giftPath(pubkey: string): string | undefined {
  const npub = tryNpubEncode(pubkey);
  return npub ? `${GIFT_PATH_PREFIX}${npub}` : undefined;
}

/** The shareable link for a gift from `pubkey`. */
export function giftUrl(pubkey: string): string | undefined {
  const path = giftPath(pubkey);
  return path ? `${shareOrigin()}${path}` : undefined;
}

/** The gifter named by a `/gift/<npub>` route segment, or undefined. */
export function parseGiftSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    const decoded = nip19.decode(decodeURIComponent(segment).replace(/\/$/, ""));
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    // not a nostr identifier
  }
  return undefined;
}

/**
 * The gifter of a gift URL on any host, as Concord invites are matched: the card
 * routes in-app and never sends the viewer to the link's host.
 */
export function parseGiftUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (!u.pathname.startsWith(GIFT_PATH_PREFIX)) return undefined;
  const rest = u.pathname.slice(GIFT_PATH_PREFIX.length);
  if (rest.replace(/\/$/, "").includes("/")) return undefined;
  return parseGiftSegment(rest);
}
