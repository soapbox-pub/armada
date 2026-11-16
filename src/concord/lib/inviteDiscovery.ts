/**
 * Invite discovery — the community announcement event (kind 3314).
 *
 * An Armada convention, not a CORD kind: a bare regular event signed by the
 * sharer whose content is the full invite link (secret included) and nothing
 * else. Name/icon/channels come from the bundle the link resolves to, and the
 * bundle's `community_id` self-certifies where a tag couldn't. Anyone who finds
 * it can join, so publishing is always an explicit user action.
 */

import { nip19 } from "nostr-tools";

import { parseInviteLink, type InviteBundle } from "@/concord/lib/invite";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Community announcement: regular event, the invite link as the content. */
export const KIND_COMMUNITY_ANNOUNCEMENT = 3314;

/** An invite link mined from a community announcement. */
export interface DiscoveredInvite {
  inviteUrl: string;
  /**
   * The link-signer pubkey — the de-dup key. Cross-link duplicates of one
   * community are folded at render time, once bundles resolve.
   */
  linkSigner: string;
  source: NostrRumor;
  /** Older standing announcements of the same link: boosts name announcements, so theirs count here. */
  copies?: string[];
}

/** An invite with another announcement of its link folded in as a copy. */
export function withCopy(invite: DiscoveredInvite, other: DiscoveredInvite): DiscoveredInvite {
  const ids = new Set([...(invite.copies ?? []), other.source.id, ...(other.copies ?? [])]);
  ids.delete(invite.source.id);
  return ids.size === (invite.copies?.length ?? 0) ? invite : { ...invite, copies: [...ids].sort() };
}

/** Every announcement id an invite stands for: its own and its copies'. */
export function listingIdsOf(invite: DiscoveredInvite): string[] {
  return invite.copies?.length ? [invite.source.id, ...invite.copies] : [invite.source.id];
}

/**
 * Matches a full invite URL (`https://…/invite/naddr1…#fragment`) or the bare
 * `naddr1…#fragment` form embedded in free text. The naddr body is bech32
 * (lowercase a-z0-9); the fragment is base64url.
 */
const INVITE_URL_RE =
  /(?:https?:\/\/[^\s]+?\/invite\/naddr1[0-9a-z]+#[A-Za-z0-9_-]+)|(?:naddr1[0-9a-z]+#[A-Za-z0-9_-]+)/gi;

/** Every valid, secret-carrying invite link in free text, de-duplicated by link-signer. */
export function extractInviteUrls(text: string): string[] {
  const matches = text.match(INVITE_URL_RE);
  if (!matches) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const parsed = parseInviteLink(m);
    if (!parsed || seen.has(parsed.linkSigner)) continue;
    seen.add(parsed.linkSigner);
    out.push(m);
  }
  return out;
}

/** Parse an announcement into a {@link DiscoveredInvite}, or null if it lacks a valid invite link. */
export function announcementFromEvent(event: NostrRumor): DiscoveredInvite | null {
  const [url] = extractInviteUrls(event.content);
  if (!url) return null;
  const parsed = parseInviteLink(url);
  if (!parsed) return null;
  return { inviteUrl: url, linkSigner: parsed.linkSigner, source: event };
}

/**
 * Whether the sharer may list this link: the community's owner, or the link's
 * creator (`creator_npub`, writable only by the link signer's holder).
 */
export function listingAuthorized(bundle: Pick<InviteBundle, "owner" | "creator_npub">, sharer: string): boolean {
  if (sharer === bundle.owner) return true;
  return !!bundle.creator_npub && creatorHex(bundle.creator_npub) === sharer;
}

/** What a resolved, authorized Discover listing reports, so one card stands per community. */
export interface ListingStanding {
  communityId: string;
  owner: string;
  /** The bundle's root epoch. */
  epoch: number;
  /** Who shared it: 0 the owner, 1 staff, 2 any other link creator. */
  sharerRank: number;
  /** Rotated out: its epoch was refounded past. */
  retired: boolean;
}

/**
 * The listings Discover hides: every retired one, and all but one per community.
 * The one shown is on the newest epoch (a sibling on an older one is rotated out
 * whether or not that is known yet), then shared by the most senior sharer, then
 * the newest announcement. Listings not yet resolved aren't judged.
 */
export function suppressedListings(
  invites: readonly DiscoveredInvite[],
  standings: Readonly<Record<string, ListingStanding>>,
): Set<string> {
  const suppressed = new Set<string>();
  const best = new Map<string, { invite: DiscoveredInvite; standing: ListingStanding }>();
  const outranks = (a: { invite: DiscoveredInvite; standing: ListingStanding }, b: typeof a) =>
    a.standing.epoch !== b.standing.epoch
      ? a.standing.epoch > b.standing.epoch
      : a.standing.sharerRank !== b.standing.sharerRank
        ? a.standing.sharerRank < b.standing.sharerRank
        : a.invite.source.created_at > b.invite.source.created_at;
  for (const invite of invites) {
    const standing = standings[invite.linkSigner];
    if (!standing) continue;
    if (standing.retired) {
      suppressed.add(invite.linkSigner);
      continue;
    }
    const candidate = { invite, standing };
    const held = best.get(standing.communityId);
    if (!held) best.set(standing.communityId, candidate);
    else if (outranks(candidate, held)) {
      suppressed.add(held.invite.linkSigner);
      best.set(standing.communityId, candidate);
    } else suppressed.add(invite.linkSigner);
  }
  return suppressed;
}

/**
 * The announcements whose boosts count for each listing: its own and its copies,
 * and those of every listing resolving to the same community, since a boost vouches
 * for the community whichever of its links it was cast on. Unresolved listings
 * keep their own.
 */
export function boostListingsBySigner(
  invites: readonly DiscoveredInvite[],
  standings: Readonly<Record<string, Pick<ListingStanding, "communityId">>>,
): Map<string, string[]> {
  const byCommunity = new Map<string, Set<string>>();
  for (const invite of invites) {
    const communityId = standings[invite.linkSigner]?.communityId;
    if (!communityId) continue;
    const ids = byCommunity.get(communityId) ?? byCommunity.set(communityId, new Set()).get(communityId)!;
    for (const id of listingIdsOf(invite)) ids.add(id);
  }
  const out = new Map<string, string[]>();
  for (const invite of invites) {
    const communityId = standings[invite.linkSigner]?.communityId;
    const shared = communityId ? byCommunity.get(communityId) : undefined;
    out.set(invite.linkSigner, shared ? [...shared].sort() : listingIdsOf(invite));
  }
  return out;
}

/** The hex pubkey of a link's creator, as its bundle names it. */
export function linkCreator(bundle: Pick<InviteBundle, "creator_npub">): string | undefined {
  return bundle.creator_npub ? creatorHex(bundle.creator_npub) : undefined;
}

function creatorHex(creator: string): string | undefined {
  if (/^[0-9a-f]{64}$/.test(creator)) return creator;
  try {
    const decoded = nip19.decode(creator);
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** Build the "share to Discover" announcement; null if the URL isn't a valid invite link. */
export function buildCommunityAnnouncement(input: { inviteUrl: string }): EventTemplate | null {
  if (!parseInviteLink(input.inviteUrl)) return null;
  return {
    kind: KIND_COMMUNITY_ANNOUNCEMENT,
    content: input.inviteUrl.trim(),
    tags: [],
  };
}

/**
 * The NIP-09 un-listing. Always `k`-tagged: Discover reads deletions by
 * `#k: ["3314"]`, so an untagged delete would never be seen.
 */
export function buildAnnouncementDeletion(announcementIds: string[]): EventTemplate {
  return {
    kind: 5,
    content: "",
    tags: [...announcementIds.map((id) => ["e", id]), ["k", String(KIND_COMMUNITY_ANNOUNCEMENT)]],
  };
}

/** Every link, for reads that narrow by author alone. */
export const ANY_LINK = "any";

/**
 * Standing announcements (not deleted by their own author) whose link is in
 * `linkSigners`, newest first. Keeps EVERY copy, since un-listing must delete
 * all of them or an older copy resurfaces.
 */
export function announcementsForLinks(
  events: NostrRumor[],
  linkSigners: ReadonlySet<string> | typeof ANY_LINK,
): DiscoveredInvite[] {
  const byId = new Map<string, NostrRumor>();
  for (const e of events) if (e.kind === KIND_COMMUNITY_ANNOUNCEMENT) byId.set(e.id, e);
  const deleted = new Set<string>();
  for (const e of events) {
    if (e.kind !== 5) continue;
    for (const [n, id] of e.tags) {
      if (n === "e" && byId.get(id)?.pubkey === e.pubkey) deleted.add(id);
    }
  }
  const out: DiscoveredInvite[] = [];
  for (const e of byId.values()) {
    if (deleted.has(e.id)) continue;
    const invite = announcementFromEvent(e);
    if (invite && (linkSigners === ANY_LINK || linkSigners.has(invite.linkSigner))) out.push(invite);
  }
  return out.sort((a, b) => b.source.created_at - a.source.created_at);
}

/**
 * Convert an invite URL to a local route (`/invite/<naddr>#…`) so "Join" stays
 * in-app instead of navigating to the origin baked into a native link.
 */
export function inviteUrlToLocalRoute(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    if (u.pathname.startsWith("/invite/")) return `${u.pathname}${u.hash}`;
  } catch {
    // Not an absolute URL — fall through to the bare naddr#fragment form.
  }
  const m = /^(naddr1[a-z0-9]+)#(.+)$/i.exec(trimmed);
  if (m) return `/invite/${m[1]}#${m[2]}`;
  return trimmed;
}
