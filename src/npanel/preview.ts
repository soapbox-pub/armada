/**
 * Armada's link previews, for npanel to show crawlers.
 *
 * npanel runs this for a crawler asking for one of the pages `routes` names,
 * in a QuickJS sandbox with an `OffscreenCanvas` that draws text in the
 * gateway's fonts. `vite.config.ts` builds it into
 * `dist/.well-known/npanel/preview.js`. Returning `null` leaves the page as
 * published, with the app's own card.
 *
 * Three kinds of page: a person (`UserPage`), drawn as their avatar over the
 * Armada mark; a Concord invite (CORD-05), drawn as an invitation; and an
 * Armada Ultra gift (`GiftPage`), drawn as a wrapped box from its giver. An
 * invite's community is sealed under the token in the link's `#fragment`,
 * which never reaches a server, so its card names nothing about it.
 */

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NRelay } from "@nostrify/types";
import * as nip19 from "nostr-tools/nip19";

import { KIND_INVITE_BUNDLE } from "@/concord/lib/kinds";
import { getAvatarShape } from "@/lib/avatarShape";
import { config } from "@/lib/env";
import { parseNip05Address } from "@/lib/nip05Address";
import { sanitizeImageSrc, sanitizeUrl } from "@/lib/sanitizeUrl";

import { drawGift, drawInvite, drawProfile } from "./draw";

/** What `preview()` returns to npanel. */
export interface Preview {
  title?: string;
  description?: string;
  body?: string;
  image?: string | Promise<Blob | null>;
  type?: string;
  twitter?: "summary" | "summary_large_image";
  jsonLd?: Record<string, unknown>;
}

interface Context {
  nostr: NRelay;
  signal: AbortSignal;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 200;
const MAX_ABOUT = 2000;

const BECH32 = "[02-9ac-hj-np-z]+";

export default {
  /**
   * URLPattern pathnames, the pages `UserPage` and `InvitePage` answer:
   * `/npub1…`, `/nprofile1…`, `/name@domain` or a bare `/domain` (NIP-05
   * `_@domain`, which a real file like `/og.png` never reaches, since npanel
   * only previews HTML), `/invite/naddr1…`, and `/gift/npub1…` (or an
   * nprofile). Groups are Rust regexes in
   * npanel; `-` is escaped in classes so they also compile as JavaScript's
   * `v`-flag ones.
   */
  routes: [
    String.raw`/:id((?:@|%40)?n(?:pub|profile)1${BECH32}){/}?`,
    String.raw`/:name((?:@|%40)?(?:[\w.+\-]+(?:@|%40))?[\w\-]+(?:\.[\w\-]+)+){/}?`,
    String.raw`/invite/:naddr(naddr1${BECH32}){/}?`,
    String.raw`/gift/:from(n(?:pub|profile)1${BECH32}){/}?`,
  ],

  async preview(request: Request, { nostr, signal }: Context): Promise<Preview | null> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (segments.length === 2 && segments[0] === "invite") {
      return invite(segments[1], url);
    }
    if (segments.length === 2 && segments[0] === "gift") {
      // Only a key: a gift is never a NIP-05 lookup.
      const giver = /^n(?:pub|profile)1/.test(segments[1]) ? await resolve(segments[1], signal) : undefined;
      if (!giver) return null;
      const [event] = await nostr.query([{ kinds: [0], authors: [giver], limit: 1 } satisfies NostrFilter], { signal });
      return gift(giver, event?.kind === 0 && event.pubkey === giver ? event : undefined, url);
    }
    if (segments.length !== 1) return null;

    const pubkey = await resolve(segments[0], signal);
    if (!pubkey) return null;
    const [event] = await nostr.query([{ kinds: [0], authors: [pubkey], limit: 1 } satisfies NostrFilter], { signal });
    return event?.kind === 0 && event.pubkey === pubkey ? profile(event, url) : null;
  },
};

/** The pubkey a path segment names: an npub, an nprofile, or a NIP-05 address. */
async function resolve(segment: string, signal: AbortSignal): Promise<string | undefined> {
  const value = segment.replace(/^@/, "");
  if (/^n(?:pub|profile)1/.test(value)) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === "npub") return decoded.data;
      if (decoded.type === "nprofile") return decoded.data.pubkey;
    } catch { /* not bech32 */ }
    return undefined;
  }
  const address = parseNip05Address(value);
  return address && nip05(address.name, address.domain, signal);
}

/** The pubkey a NIP-05 name stands for, checked as hex: the domain is untrusted. */
async function nip05(name: string, domain: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, { signal });
    if (!response.ok) return undefined;
    const document = (await response.json()) as { names?: Record<string, unknown> };
    const pubkey = document.names?.[name] ?? document.names?.[name.toLowerCase()];
    return typeof pubkey === "string" && /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : undefined;
  } catch {
    return undefined;
  }
}

/** A kind 0's string fields, trimmed, and the name the app calls its author (`getDisplayName`). */
function person(pubkey: string, content: string | undefined) {
  const fields = content ? parseObject(content) : {};
  const field = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string).trim() || undefined : undefined);
  const npub = nip19.npubEncode(pubkey);
  const name = clamp(field("name") ?? field("display_name") ?? `${npub.slice(0, 12)}…${npub.slice(-6)}`, MAX_NAME);
  return { fields, field, npub, name };
}

function profile(event: NostrEvent, url: URL): Preview {
  const { fields, field, npub, name } = person(event.pubkey, event.content);
  const about = field("about");
  const nip05 = field("nip05");
  const website = sanitizeUrl(field("website"));
  const picture = sanitizeImageSrc(field("picture"));
  const appName = config("APP_NAME") || "Armada";

  // The avatar is in the drawn image; the article names no other host, so
  // the page loads nothing an author chose.
  let body = `<article>\n<header>\n<h1>${escape(name)}</h1>\n`;
  if (nip05) body += `<p>${escape(clamp(nip05.replace(/^_@/, ""), MAX_NAME))}</p>\n`;
  body += "</header>\n";
  if (about) body += paragraphs(truncate(about, MAX_ABOUT));
  if (website) body += `<p><a href="${escape(website)}" rel="me nofollow ugc">${escape(website)}</a></p>\n`;
  body += "</article>\n";

  const description = about ? clamp(about, MAX_DESCRIPTION) || undefined : undefined;
  return {
    title: `${name} on ${appName}`,
    description,
    body,
    image: drawProfile(picture, getAvatarShape(fields), name),
    twitter: "summary_large_image",
    type: "profile",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      url: url.href,
      mainEntity: withoutUndefined({
        "@type": "Person",
        name,
        identifier: npub,
        url: `${url.origin}/${npub}`,
        description,
      }),
    },
  };
}

/** An invite: only its locator reaches us, so the card is the same for every one. */
function invite(segment: string, url: URL): Preview | null {
  try {
    const decoded = nip19.decode(segment);
    if (decoded.type !== "naddr" || decoded.data.kind !== KIND_INVITE_BUNDLE) return null;
  } catch {
    return null;
  }
  const appName = config("APP_NAME") || "Armada";
  const title = `You're invited to a community on ${appName}`;
  const description = "An end-to-end encrypted community. Its name and members are sealed in the link itself — open it to see where it leads.";
  return {
    title,
    description,
    body: `<article>\n<h1>${escape(title)}</h1>\n<p>${escape(description)}</p>\n</article>\n`,
    image: drawInvite(),
    twitter: "summary_large_image",
    jsonLd: { "@context": "https://schema.org", "@type": "WebPage", url: url.href, name: title, description },
  };
}

/**
 * An Ultra gift: who it is from is in the link, and Ultra is free, so the card
 * is the giver and the box. A giver with no profile is named by their npub.
 */
function gift(pubkey: string, event: NostrEvent | undefined, url: URL): Preview {
  const { fields, field, name } = person(pubkey, event?.content);
  const appName = config("APP_NAME") || "Armada";
  const title = `${name} gifted you ${appName} Ultra`;
  const description = "Open the gift to claim a shimmering name, a glowing avatar, profile effects and exclusive themes. Free, forever.";
  return {
    title,
    description,
    body: `<article>\n<h1>${escape(title)}</h1>\n<p>${escape(description)}</p>\n</article>\n`,
    image: drawGift(sanitizeImageSrc(field("picture")), getAvatarShape(fields), name),
    twitter: "summary_large_image",
    jsonLd: { "@context": "https://schema.org", "@type": "WebPage", url: url.href, name: title, description },
  };
}

/** Text made safe for an element's content or a quoted attribute value. */
export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Text as paragraphs, its line breaks kept. */
function paragraphs(text: string): string {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escape(p).replace(/\r?\n/g, "<br>\n")}</p>\n`)
    .join("");
}

/** Text on one line, cut to `max` characters with an ellipsis. */
function clamp(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
