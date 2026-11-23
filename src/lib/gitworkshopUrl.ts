import { nip19 } from "nostr-tools";

import { GIT_REPOSITORY_ANNOUNCEMENT_KIND, type GitTicket } from "@/lib/gitActivity";
import { normalizeRelayUrl, routeParamToRelay } from "@/lib/platform";

const GITWORKSHOP_ORIGIN = "https://gitworkshop.dev";

/**
 * One GitWorkshop route segment for a relay. wss relays omit the scheme;
 * ws relays keep a slash-free `ws:` marker.
 */
export function gitworkshopRelaySegment(relayUrl: string): string | undefined {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return undefined;
  if (normalized.startsWith("wss://")) {
    return encodeURIComponent(normalized.slice("wss://".length));
  }
  return encodeURIComponent(`ws:${normalized.slice("ws://".length)}`);
}

/** Build a GitWorkshop repository route from independently encoded segments. */
export function gitworkshopRepositoryPath(
  identity: string,
  identifier: string,
  relayHint?: string,
): string {
  const relaySegment = relayHint ? gitworkshopRelaySegment(relayHint) : undefined;
  const repositorySegment = encodeURIComponent(identifier);
  return relaySegment
    ? `/${identity}/${relaySegment}/${repositorySegment}/`
    : `/${identity}/${repositorySegment}/`;
}

/** Build an issue or pull-request link from its NIP-34 repository reference. */
export function gitworkshopTicketUrl(ticket: GitTicket): string | undefined {
  const address = ticket.repositoryAddress;
  if (!address) return undefined;
  try {
    const identity = nip19.npubEncode(address.owner);
    const event = nip19.neventEncode({
      id: ticket.id,
      author: ticket.author,
      kind: ticket.kind,
    });
    const repositoryPath = gitworkshopRepositoryPath(
      identity,
      address.identifier,
      address.relayHint,
    );
    const collection = ticket.type === "issue" ? "issues" : "prs";
    return `${GITWORKSHOP_ORIGIN}${repositoryPath}${collection}/${event}`;
  } catch {
    return undefined;
  }
}

/** GitWorkshop page for a repository announcement. */
export function gitworkshopRepositoryUrl(owner: string, identifier: string, relayHint?: string): string | undefined {
  try {
    return `${GITWORKSHOP_ORIGIN}${gitworkshopRepositoryPath(nip19.npubEncode(owner), identifier, relayHint)}`;
  } catch {
    return undefined;
  }
}

/**
 * ngit's `nostr://<npub>[/<relay>]/<identifier>` remote. Only a bare wss host
 * becomes the relay segment; anything else is left out rather than mis-spelled,
 * since the remote resolves without one.
 */
export function ngitCloneUrl(owner: string, identifier: string, relayHint?: string): string | undefined {
  let npub: string;
  try {
    npub = nip19.npubEncode(owner);
  } catch {
    return undefined;
  }
  const relay = relayHint ? normalizeRelayUrl(relayHint) : undefined;
  const host = relay?.startsWith("wss://") ? relay.slice("wss://".length).replace(/\/$/, "") : undefined;
  const relaySegment = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${host}/` : "";
  return `nostr://${npub}/${relaySegment}${encodeURIComponent(identifier)}`;
}

/** What a GitWorkshop page shows: a repository, its issue or PR lists, or one ticket. */
export type GitworkshopView = "repository" | "issues" | "pull-requests" | "issue" | "pull-request";

/** A repository page on GitWorkshop, as read off its URL. */
export interface GitworkshopTarget {
  /** Hex pubkey of the owner, when the URL names them by npub/nprofile/naddr (not NIP-05). */
  owner?: string;
  identifier: string;
  relays: string[];
  view: GitworkshopView;
  /** The issue or PR, when the URL names one. */
  ticket?: { id: string; author?: string; relays: string[] };
}

const TICKET_SECTIONS: Record<string, ["issues" | "pull-requests", "issue" | "pull-request"]> = {
  issues: ["issues", "issue"],
  prs: ["pull-requests", "pull-request"],
};

/** Sections a repository page has; a second segment named so is never a relay. */
const REPOSITORY_SECTIONS = new Set(["issues", "prs", "tree", "commits", "actions", "releases", "about"]);

/** A relay route segment (`relay.ngit.dev`, `host%2Fpath`, `ws:host`), not a repository name. */
function relayFromSegment(segment: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (!/^(ws:)?(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/\S*)?$/i.test(decoded)) return undefined;
  return routeParamToRelay(segment);
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The ticket a `nevent`/`note` segment names. */
function ticketFromSegment(segment: string | undefined): GitworkshopTarget["ticket"] {
  if (!segment) return undefined;
  try {
    const decoded = nip19.decode(segment);
    if (decoded.type === "note") return { id: decoded.data, relays: [] };
    if (decoded.type === "nevent") {
      return { id: decoded.data.id, author: decoded.data.author, relays: decoded.data.relays ?? [] };
    }
  } catch {
    // not an event id
  }
  return undefined;
}

/**
 * Read a `gitworkshop.dev` repository URL: `/<npub|nprofile|nip05>[/<relay>]/<identifier>[/…]`
 * or `/<naddr>[/…]`, with `issues`/`prs` (and an optional ticket id) after it.
 */
export function parseGitworkshopUrl(url: string): GitworkshopTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.hostname !== "gitworkshop.dev" && u.hostname !== "www.gitworkshop.dev")) return null;
  const segments = u.pathname.split("/").filter(Boolean);
  const identity = segments[0];
  if (!identity) return null;

  let owner: string | undefined;
  let identifier: string | undefined;
  let relays: string[] = [];
  let rest: string[];

  let decoded: ReturnType<typeof nip19.decode> | undefined;
  try {
    decoded = /^(npub1|nprofile1|naddr1)/.test(identity) ? nip19.decode(identity) : undefined;
  } catch {
    return null;
  }
  if (decoded?.type === "naddr") {
    if (decoded.data.kind !== GIT_REPOSITORY_ANNOUNCEMENT_KIND || !decoded.data.identifier) return null;
    owner = decoded.data.pubkey;
    identifier = decoded.data.identifier;
    relays = decoded.data.relays ?? [];
    rest = segments.slice(1);
  } else {
    if (decoded?.type === "npub") owner = decoded.data;
    else if (decoded?.type === "nprofile") {
      owner = decoded.data.pubkey;
      relays = decoded.data.relays ?? [];
    } else if (!/^([a-z0-9._-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(decodeSegment(identity) ?? "")) {
      // Neither a key nor a NIP-05 name: one of GitWorkshop's own pages.
      return null;
    }
    const relay = segments[2] && !REPOSITORY_SECTIONS.has(segments[2]) ? relayFromSegment(segments[1]) : undefined;
    if (relay) relays = [relay, ...relays];
    const idSegment = relay ? segments[2] : segments[1];
    identifier = idSegment ? decodeSegment(idSegment) : undefined;
    rest = segments.slice(relay ? 3 : 2);
  }
  if (!identifier) return null;

  const section = TICKET_SECTIONS[rest[0] ?? ""];
  const ticket = section ? ticketFromSegment(rest[1]) : undefined;
  return {
    owner,
    identifier,
    relays,
    view: section ? section[ticket ? 1 : 0] : "repository",
    ticket,
  };
}
