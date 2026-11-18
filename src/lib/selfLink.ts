/**
 * Recognize a URL pointing back into this app (a `chatUrl()` link or a bare
 * `<origin>/<npub>` profile link) so it's routed in-app instead of opened
 * externally. "Ours" is the page origin plus the public deployment, which
 * native/desktop builds use in every link (`shareOrigin()`). Never claims a URL
 * it can't route.
 */

import { nip19 } from "nostr-tools";

import { isRouterPath } from "@/lib/deepLinkUrl";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { parseChatRoute, type ChatRoute } from "@/lib/routes";
import { PUBLIC_WEB_ORIGIN, shareOrigin } from "@/lib/shareOrigin";

/** A URL resolved to an in-app destination. */
export type SelfLink =
  /** A chat location — the router path preserves any search/hash. */
  | { kind: "chat"; route: ChatRoute; path: string }
  /** A profile link (`/<npub>` or `/<nprofile>`). */
  | { kind: "profile"; pubkey: string };

/** The origins whose links are ours to route, normalized via `URL`. */
function ownOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const candidate of [shareOrigin(), PUBLIC_WEB_ORIGIN]) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Unparseable origin (e.g. a bad PUBLIC_WEB_ORIGIN) — skip it.
    }
  }
  return origins;
}

/**
 * Parse a URL into the in-app destination it names, or `null` when it isn't
 * one of ours (wrong origin, a static page, an invite — invites have their
 * own card and are matched by path before this runs).
 */
export function parseSelfLink(url: string): SelfLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!ownOrigins().has(u.origin)) return null;

  // `new URL("https://a//x").pathname` is "//x" — protocol-relative to the router.
  const path = u.pathname + u.search + u.hash;
  if (!isRouterPath(path)) return null;

  const route = parseChatRoute(u.pathname);
  if (route) return { kind: "chat", route, path };

  // `/:user`: only npub/nprofile. NIP-05 names would need a fetch, and
  // over-claiming would swallow static pages.
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg.length === 1) {
    try {
      const decoded = nip19.decode(decodeURIComponent(seg[0]));
      if (decoded.type === "npub") return { kind: "profile", pubkey: decoded.data };
      if (decoded.type === "nprofile") return { kind: "profile", pubkey: decoded.data.pubkey };
    } catch {
      // not a nostr identifier
    }
  }

  return null;
}

/**
 * Pubkey named by pasted text: an npub/nprofile/hex (optionally `nostr:`), or
 * one of our profile share links (`<origin>/<npub>`, scheme optional).
 */
export function resolvePastedPubkey(input: string): string | undefined {
  const value = input.trim();
  const direct = resolvePubkey(value.replace(/^nostr:/i, ""));
  if (direct) return direct;
  const link = parseSelfLink(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  return link?.kind === "profile" ? link.pubkey : undefined;
}
