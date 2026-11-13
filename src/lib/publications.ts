/**
 * PressStr-style digital publications, as Ditto renders them:
 * kind 34609 magazine (parent record), kind 39731 magazine issue, kind 33953 ebook.
 */

import { sanitizeImageSrc } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";

export const MAGAZINE_KIND = 34609;
export const MAGAZINE_ISSUE_KIND = 39731;
export const EBOOK_KIND = 33953;

export interface Publication {
  kind: number;
  event: NostrRumor;
  /** `d` tag identifier. */
  identifier: string;
  title: string;
  /** Sanitized cover image URL. */
  image?: string;
  summary?: string;
  /** Issue number/label (magazine issues only). */
  issue?: string;
  /** Carries a NIP-36 `content-warning`. */
  warned: boolean;
}

function getTag(event: NostrRumor, name: string): string | undefined {
  return event.tags.find(([n]) => n === name)?.[1];
}

export function parsePublication(event: NostrRumor): Publication {
  return {
    kind: event.kind,
    event,
    identifier: getTag(event, "d") ?? "",
    title: getTag(event, "title") ?? "Untitled",
    image: sanitizeImageSrc(getTag(event, "image")),
    summary: getTag(event, "summary"),
    issue: getTag(event, "issue"),
    warned: event.tags.some(([n]) => n === "content-warning"),
  };
}

/** The `#a` value naming a magazine, which its issues carry. */
export function magazineCoordinate(pubkey: string, identifier: string): string {
  return `${MAGAZINE_KIND}:${pubkey}:${identifier}`;
}

/** Newest first, by `published_at` when set. */
export function byPublishedDesc(a: NostrRumor, b: NostrRumor): number {
  const pa = Number(getTag(a, "published_at")) || a.created_at;
  const pb = Number(getTag(b, "published_at")) || b.created_at;
  return pb - pa;
}
