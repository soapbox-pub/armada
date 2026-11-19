import type { NostrRumor } from "@/lib/nostrRumor";

import { assembleCIRuns, matchCIRepository, type CIRun } from "@/lib/ci";
import { isNostrId } from "@/lib/nostrId";
import { parseAddr } from "@/lib/parseAddr";
import { normalizeRelayUrl } from "@/lib/platform";

/** NIP-34 repository announcement. */
export const GIT_REPOSITORY_ANNOUNCEMENT_KIND = 30617;
/** NIP-34 pull request. */
export const GIT_PULL_REQUEST_KIND = 1618;
/** NIP-34 issue. */
export const GIT_ISSUE_KIND = 1621;
/** NIP-34 open status. */
export const GIT_STATUS_OPEN_KIND = 1630;
/** NIP-34 applied/resolved status. */
export const GIT_STATUS_APPLIED_KIND = 1631;
/** NIP-34 closed status. */
export const GIT_STATUS_CLOSED_KIND = 1632;
/** NIP-34 draft status. */
export const GIT_STATUS_DRAFT_KIND = 1633;
/** NIP-22 comment. */
export const NIP22_COMMENT_KIND = 1111;
/** NIP-09 deletion request. */
export const EVENT_DELETION_KIND = 5;

export const GIT_STATUS_KINDS = [
  GIT_STATUS_OPEN_KIND,
  GIT_STATUS_APPLIED_KIND,
  GIT_STATUS_CLOSED_KIND,
  GIT_STATUS_DRAFT_KIND,
] as const;

export type GitTicketKind = typeof GIT_ISSUE_KIND | typeof GIT_PULL_REQUEST_KIND;
export type GitStatusKind = (typeof GIT_STATUS_KINDS)[number];
export type GitTicketStatus = "open" | "draft" | "closed" | "merged" | "resolved";

/** A validated NIP-34 repository coordinate. */
export interface GitRepositoryAddress {
  kind: typeof GIT_REPOSITORY_ANNOUNCEMENT_KIND;
  owner: string;
  identifier: string;
  coordinate: string;
  relayHint?: string;
}

/** Parse a canonical `30617:<owner-pubkey>:<d>` repository coordinate. */
export function parseGitRepositoryAddress(value: string | undefined): GitRepositoryAddress | undefined {
  const parsed = parseAddr(value);
  if (
    !parsed ||
    parsed.kind !== GIT_REPOSITORY_ANNOUNCEMENT_KIND ||
    !parsed.identifier ||
    parsed.pubkey !== parsed.pubkey.toLowerCase()
  ) {
    return undefined;
  }

  return {
    kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND,
    owner: parsed.pubkey,
    identifier: parsed.identifier,
    coordinate: `${GIT_REPOSITORY_ANNOUNCEMENT_KIND}:${parsed.pubkey}:${parsed.identifier}`,
  };
}

export interface GitRepositoryAnnouncement {
  event: NostrRumor;
  address: GitRepositoryAddress;
  owner: string;
  identifier: string;
  name: string;
  description?: string;
  relays: string[];
  maintainers: string[];
  cloneUrls: string[];
  webUrls: string[];
  createdAt: number;
}

/** Parse a NIP-34 repository announcement, returning undefined for malformed events. */
export function parseGitRepositoryAnnouncement(event: NostrRumor): GitRepositoryAnnouncement | undefined {
  if (event.kind !== GIT_REPOSITORY_ANNOUNCEMENT_KIND || !isNostrId(event.pubkey)) return undefined;
  const identifier = firstTagValue(event, "d")?.trim();
  if (!identifier) return undefined;

  const address = parseGitRepositoryAddress(`${event.kind}:${event.pubkey}:${identifier}`);
  if (!address) return undefined;

  return {
    event,
    address,
    owner: event.pubkey,
    identifier,
    name: firstTagValue(event, "name")?.trim() || identifier,
    description: firstTagValue(event, "description")?.trim() || undefined,
    relays: normalizedRelays(tagValues(event, "relays")),
    maintainers: unique(tagValues(event, "maintainers").filter((pubkey) => isNostrId(pubkey) && pubkey !== event.pubkey)),
    cloneUrls: httpsUrls(tagValues(event, "clone")),
    webUrls: httpsUrls(tagValues(event, "web")),
    createdAt: event.created_at,
  };
}

export interface GitPullRequestBranches {
  name?: string;
  base?: string;
  head?: string;
}

export interface GitTicket {
  event: NostrRumor;
  id: string;
  kind: GitTicketKind;
  type: "issue" | "pull-request";
  subject: string;
  content: string;
  labels: string[];
  /**
   * The FIRST tagged repository; tag order is meaningless, so prefer
   * {@link matchGitTicketRepository} to test membership.
   */
  repositoryAddress?: GitRepositoryAddress;
  repositoryAddresses: GitRepositoryAddress[];
  branches?: GitPullRequestBranches;
  author: string;
  createdAt: number;
}

/**
 * The ticket's repository that `known` holds. Tickets carry an `a` tag per
 * fork/maintainer announcement, so checking only the first misses real activity.
 */
export function matchGitTicketRepository(
  ticket: GitTicket,
  known: { has(coordinate: string): boolean },
): GitRepositoryAddress | undefined {
  return ticket.repositoryAddresses.find((address) => known.has(address.coordinate));
}

/**
 * Each event's parse, by object: a community's activity is built once per channel
 * over the same events, and the wire spec re-reads its roots on every rebuild.
 */
const parsedTickets = new WeakMap<NostrRumor, GitTicket | null>();

export function parseGitTicket(event: NostrRumor): GitTicket | undefined {
  let ticket = parsedTickets.get(event);
  if (ticket === undefined) parsedTickets.set(event, (ticket = parseTicket(event) ?? null));
  return ticket ?? undefined;
}

function parseTicket(event: NostrRumor): GitTicket | undefined {
  if (!isGitTicketKind(event.kind) || !isNostrId(event.pubkey)) return undefined;

  const branchName = firstTagValue(event, "branch-name")?.trim();
  const base = firstTagValue(event, "base")?.trim();
  const head = firstTagValue(event, "head")?.trim();
  const branches = event.kind === GIT_PULL_REQUEST_KIND && (branchName || base || head)
    ? { name: branchName || undefined, base: base || undefined, head: head || undefined }
    : undefined;

  const repositoryAddresses = event.tags
    .filter(([name]) => name === "a")
    .map(([, coordinate, relayHint]) => {
      const address = parseGitRepositoryAddress(coordinate);
      if (!address) return undefined;
      const normalizedRelayHint = normalizeRelayUrl(relayHint ?? "");
      return normalizedRelayHint ? { ...address, relayHint: normalizedRelayHint } : address;
    })
    .filter((address): address is GitRepositoryAddress => Boolean(address));

  return {
    event,
    id: event.id,
    kind: event.kind,
    type: event.kind === GIT_ISSUE_KIND ? "issue" : "pull-request",
    subject: firstTagValue(event, "subject")?.trim() || firstContentLine(event.content) || "(no subject)",
    content: event.content,
    labels: unique(tagValues(event, "t").map((label) => label.trim().toLowerCase()).filter(Boolean)),
    repositoryAddress: repositoryAddresses[0],
    repositoryAddresses,
    branches,
    author: event.pubkey,
    createdAt: event.created_at,
  };
}

export interface GitStatusEvent {
  event: NostrRumor;
  kind: GitStatusKind;
  ticketId: string;
  author: string;
  createdAt: number;
}

/** Parse a status event that roots itself in a regular issue or pull request event. */
export function parseGitStatusEvent(event: NostrRumor): GitStatusEvent | undefined {
  if (!isGitStatusKind(event.kind) || !isNostrId(event.pubkey)) return undefined;
  const ticketId = statusTicketId(event);
  if (!ticketId || !isNostrId(ticketId)) return undefined;
  return { event, kind: event.kind, ticketId, author: event.pubkey, createdAt: event.created_at };
}

export interface GitComment {
  event: NostrRumor;
  id: string;
  ticketId: string;
  ticketKind: GitTicketKind;
  content: string;
  author: string;
  createdAt: number;
}

export function parseGitComment(event: NostrRumor): GitComment | undefined {
  if (event.kind !== NIP22_COMMENT_KIND || !isNostrId(event.pubkey)) return undefined;
  const ticketId = rootEventId(event, "E");
  const ticketKind = Number(firstTagValue(event, "K"));
  if (!ticketId || !isNostrId(ticketId) || !isGitTicketKind(ticketKind)) return undefined;
  return { event, id: event.id, ticketId, ticketKind, content: event.content, author: event.pubkey, createdAt: event.created_at };
}

/** Map a status event kind to its ticket lifecycle status. */
export function gitStatusFromKind(kind: GitStatusKind | undefined, ticketKind: GitTicketKind): GitTicketStatus {
  if (kind === GIT_STATUS_CLOSED_KIND) return "closed";
  if (kind === GIT_STATUS_DRAFT_KIND) return "draft";
  if (kind === GIT_STATUS_APPLIED_KIND) return ticketKind === GIT_ISSUE_KIND ? "resolved" : "merged";
  return "open";
}

/** Authors whose status events a ticket trusts: its author, the repository owner, and maintainers. */
export function trustedGitStatusAuthors(
  ticket: Pick<GitTicket, "author">,
  repository: Pick<GitRepositoryAnnouncement, "owner" | "maintainers">,
): Set<string> {
  return new Set([ticket.author, repository.owner, ...repository.maintainers]);
}

/** Newest trusted status for a ticket, or undefined when none is valid. */
export function resolveGitTicketStatus(
  ticket: GitTicket,
  repository: Pick<GitRepositoryAnnouncement, "owner" | "maintainers">,
  events: readonly NostrRumor[],
): GitStatusEvent | undefined {
  const trustedAuthors = trustedGitStatusAuthors(ticket, repository);
  return events
    .map(parseGitStatusEvent)
    .filter((status): status is GitStatusEvent => Boolean(status && status.ticketId === ticket.id && trustedAuthors.has(status.author)))
    .sort(compareNewestFirst)[0];
}

export interface GitRepositoryAttachment {
  address: GitRepositoryAddress;
  relayHints: string[];
  attachedAt: number;
  detachedAt?: number;
}

/** True when an event timestamp falls within an attachment's half-open interval. */
export function isGitRepositoryAttachedAt(attachment: GitRepositoryAttachment, createdAt: number): boolean {
  return attachment.attachedAt <= createdAt && (attachment.detachedAt === undefined || createdAt < attachment.detachedAt);
}

/** Normalize relay hints and remove duplicate attachment intervals. */
export function normalizeGitRepositoryAttachments(
  attachments: readonly GitRepositoryAttachment[],
): GitRepositoryAttachment[] {
  const seen = new Set<string>();
  return attachments
    .filter((attachment) => attachment.detachedAt === undefined || attachment.detachedAt >= attachment.attachedAt)
    .map((attachment) => ({ ...attachment, relayHints: normalizedRelays(attachment.relayHints) }))
    .sort((a, b) => a.attachedAt - b.attachedAt || a.address.coordinate.localeCompare(b.address.coordinate))
    .filter((attachment) => {
      const key = `${attachment.address.coordinate}\u0000${attachment.attachedAt}\u0000${attachment.detachedAt ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Close each currently-active matching attachment at `detachedAt`. */
export function detachGitRepository(
  attachments: readonly GitRepositoryAttachment[],
  address: GitRepositoryAddress,
  detachedAt: number,
): GitRepositoryAttachment[] {
  return attachments.map((attachment) =>
    attachment.address.coordinate === address.coordinate && attachment.detachedAt === undefined
      ? { ...attachment, detachedAt: Math.max(detachedAt, attachment.attachedAt) }
      : attachment,
  );
}

/** Add a new interval, allowing a repository to be reattached after detachment. */
export function attachGitRepository(
  attachments: readonly GitRepositoryAttachment[],
  address: GitRepositoryAddress,
  relayHints: readonly string[],
  attachedAt: number,
): GitRepositoryAttachment[] {
  return normalizeGitRepositoryAttachments([
    ...attachments,
    { address, relayHints: normalizedRelays(relayHints), attachedAt },
  ]);
}

export interface GitEventTemplate {
  kind: number;
  content: string;
  tags: string[][];
}

/** Top-level NIP-22 comment on a ticket (root and parent coincide). `media` → NIP-92 imeta tags. */
export function buildGitCommentTemplate(
  ticket: GitTicket,
  content: string,
  relayHint = "",
  media: readonly string[][] = [],
): GitEventTemplate {
  return {
    kind: NIP22_COMMENT_KIND,
    content,
    tags: [
      ["E", ticket.id, relayHint, ticket.author],
      ["K", String(ticket.kind)],
      ["P", ticket.author],
      ["e", ticket.id, relayHint, ticket.author],
      ["k", String(ticket.kind)],
      ["p", ticket.author],
      ...media.map((tag) => [...tag]),
    ],
  };
}

/** A NIP-34 issue against a repository, addressed to its owner and maintainers. */
export function buildGitIssueTemplate(
  repository: { address: GitRepositoryAddress; maintainers: readonly string[] },
  subject: string,
  body: string,
  relayHint = "",
  media: readonly string[][] = [],
  labels: readonly string[] = [],
): GitEventTemplate {
  const recipients = [...new Set([repository.address.owner, ...repository.maintainers])].filter(isNostrId);
  return {
    kind: GIT_ISSUE_KIND,
    content: body,
    tags: [
      ["a", repository.address.coordinate, relayHint],
      ["subject", subject],
      ["alt", `git repository issue: ${subject}`],
      ...recipients.map((pubkey) => ["p", pubkey]),
      ...normalizeGitLabels(labels).map((label) => ["t", label]),
      ...media.map((tag) => [...tag]),
    ],
  };
}

/** Longest label we will publish; longer entries are meaningless as filters. */
export const MAX_GIT_LABEL_LENGTH = 40;
export const MAX_GIT_LABELS = 8;

/** Lowercase, dedupe, collapse whitespace, and cap length/count (matches how `parseGitTicket` reads them). */
export function normalizeGitLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of labels) {
    const label = value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_GIT_LABEL_LENGTH);
    if (label) seen.add(label);
    if (seen.size >= MAX_GIT_LABELS) break;
  }
  return [...seen];
}

/** A NIP-09 deletion request for one of the user's own git events. */
export function buildGitDeletionTemplate(target: Pick<NostrRumor, "id" | "kind">): GitEventTemplate {
  return {
    kind: EVENT_DELETION_KIND,
    content: "",
    tags: [
      ["e", target.id],
      ["k", String(target.kind)],
    ],
  };
}

/** Deleted ids by requester; only self-deletions count since anyone can publish a kind 5. */
export function collectGitDeletions(events: readonly NostrRumor[]): Map<string, Set<string>> {
  const deletions = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== EVENT_DELETION_KIND || !isNostrId(event.pubkey)) continue;
    for (const [name, value] of event.tags) {
      if (name !== "e" || !value || !isNostrId(value)) continue;
      const requesters = deletions.get(value);
      if (requesters) requesters.add(event.pubkey);
      else deletions.set(value, new Set([event.pubkey]));
    }
  }
  return deletions;
}

export function isGitEventDeleted(deletions: ReadonlyMap<string, ReadonlySet<string>>, id: string, author: string): boolean {
  return deletions.get(id)?.has(author) ?? false;
}

/** A NIP-34 status change rooted in a ticket. Display trust stays with `resolveGitTicketStatus`. */
export function buildGitStatusTemplate(
  ticket: GitTicket,
  repository: { address: GitRepositoryAddress; maintainers: readonly string[] },
  statusKind: GitStatusKind,
  relayHint = "",
): GitEventTemplate {
  const recipients = [...new Set([ticket.author, repository.address.owner, ...repository.maintainers])].filter(isNostrId);
  return {
    kind: statusKind,
    content: "",
    tags: [
      ["e", ticket.id, relayHint, "root"],
      ["a", repository.address.coordinate, relayHint],
      ["alt", `git ${ticket.type === "issue" ? "issue" : "pull request"} status`],
      ...recipients.map((pubkey) => ["p", pubkey]),
    ],
  };
}

export type GitTimelineActivity =
  | { type: "ticket-opened"; ticket: GitTicket; repository: GitRepositoryAddress; createdAt: number }
  | { type: "comment"; comment: GitComment; ticket: GitTicket; repository: GitRepositoryAddress; createdAt: number }
  | { type: "status-change"; status: GitStatusEvent; ticket: GitTicket; repository: GitRepositoryAddress; createdAt: number }
  | { type: "ci-run"; run: CIRun; repository: GitRepositoryAddress; createdAt: number };

/**
 * Build a channel's render-ready Git activity from one batched store read.
 * Root discovery is intentionally independent of display intervals; every
 * displayed child must nevertheless occur inside one of its repo's intervals.
 */
export function buildGitTimelineActivities(
  events: readonly NostrRumor[],
  attachments: readonly GitRepositoryAttachment[],
  repositories: readonly Pick<GitRepositoryAnnouncement, "address" | "owner" | "maintainers" | "createdAt">[] = [],
): GitTimelineActivity[] {
  const attached = new Map<string, GitRepositoryAttachment[]>();
  for (const attachment of attachments) {
    const list = attached.get(attachment.address.coordinate);
    if (list) list.push(attachment);
    else attached.set(attachment.address.coordinate, [attachment]);
  }
  const deletions = collectGitDeletions(events);
  const tickets = new Map<string, GitTicket>();
  // A ticket tags every fork that adopted it, so match the attached one, not the first `a`.
  const ticketRepository = new Map<string, GitRepositoryAddress>();
  for (const event of events) {
    const ticket = parseGitTicket(event);
    if (!ticket) continue;
    if (isGitEventDeleted(deletions, ticket.id, ticket.author)) continue;
    const repository = matchGitTicketRepository(ticket, attached);
    if (!repository) continue;
    tickets.set(ticket.id, ticket);
    ticketRepository.set(ticket.id, repository);
  }
  // Newest announcement wins regardless of order, so a stale one can't restore a removed maintainer.
  const repositoryByAddress = new Map<string, (typeof repositories)[number]>();
  for (const repository of repositories) {
    const existing = repositoryByAddress.get(repository.address.coordinate);
    if (!existing || repository.createdAt > existing.createdAt) {
      repositoryByAddress.set(repository.address.coordinate, repository);
    }
  }
  const activity: GitTimelineActivity[] = [];
  for (const ticket of tickets.values()) {
    const repository = ticketRepository.get(ticket.id)!;
    const intervals = attached.get(repository.coordinate)!;
    if (intervals.some((interval) => isGitRepositoryAttachedAt(interval, ticket.createdAt))) {
      activity.push({ type: "ticket-opened", ticket, repository, createdAt: ticket.createdAt });
    }
  }
  for (const event of events) {
    const comment = parseGitComment(event);
    if (comment) {
      if (isGitEventDeleted(deletions, comment.id, comment.author)) continue;
      const ticket = tickets.get(comment.ticketId);
      const repository = ticket && ticketRepository.get(ticket.id);
      if (ticket && repository && attached.get(repository.coordinate)?.some((interval) => isGitRepositoryAttachedAt(interval, comment.createdAt))) {
        activity.push({ type: "comment", comment, ticket, repository, createdAt: comment.createdAt });
      }
      continue;
    }
    const status = parseGitStatusEvent(event);
    if (!status) continue;
    if (isGitEventDeleted(deletions, status.event.id, status.author)) continue;
    const ticket = tickets.get(status.ticketId);
    const repository = ticket && ticketRepository.get(ticket.id);
    if (!ticket || !repository || !attached.get(repository.coordinate)?.some((interval) => isGitRepositoryAttachedAt(interval, status.createdAt))) continue;
    const announced = repositoryByAddress.get(repository.coordinate);
    const trust = new Set([ticket.author, announced?.owner ?? repository.owner, ...(announced?.maintainers ?? [])]);
    if (trust.has(status.author)) activity.push({ type: "status-change", status, ticket, repository, createdAt: status.createdAt });
  }
  // CI runs are assembled across events, then interval-gated. Not trust-filtered:
  // no on-relay signer designation exists, so the signer is shown (see lib/ci.ts).
  for (const run of assembleCIRuns(events)) {
    const repository = matchCIRepository(run, attached);
    if (!repository) continue;
    if (!attached.get(repository.coordinate)?.some((interval) => isGitRepositoryAttachedAt(interval, run.createdAt))) continue;
    activity.push({ type: "ci-run", run, repository, createdAt: run.createdAt });
  }
  return sortAndDedupeGitTimelineActivities(activity);
}

/** Sort newest first and remove duplicate underlying Nostr events deterministically. */
export function sortAndDedupeGitTimelineActivities(
  activities: readonly GitTimelineActivity[],
): GitTimelineActivity[] {
  const seen = new Set<string>();
  return [...activities]
    .sort((a, b) => b.createdAt - a.createdAt || activityId(a).localeCompare(activityId(b)))
    .filter((activity) => {
      const id = activityId(activity);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function activityId(activity: GitTimelineActivity): string {
  switch (activity.type) {
    case "ticket-opened": return activity.ticket.id;
    case "comment": return activity.comment.id;
    case "ci-run": return activity.run.id;
    default: return activity.status.event.id;
  }
}

function compareNewestFirst(a: { createdAt: number; event: NostrRumor }, b: { createdAt: number; event: NostrRumor }): number {
  return b.createdAt - a.createdAt || a.event.id.localeCompare(b.event.id);
}

function isGitTicketKind(kind: number): kind is GitTicketKind {
  return kind === GIT_ISSUE_KIND || kind === GIT_PULL_REQUEST_KIND;
}

function isGitStatusKind(kind: number): kind is GitStatusKind {
  return GIT_STATUS_KINDS.includes(kind as GitStatusKind);
}

function firstTagValue(event: NostrRumor, name: string): string | undefined {
  return event.tags.find(([tagName]) => tagName === name)?.[1];
}

function tagValues(event: NostrRumor, name: string): string[] {
  return event.tags.filter(([tagName]) => tagName === name).flatMap(([, ...values]) => values.filter(Boolean));
}

function firstContentLine(content: string): string | undefined {
  return content.split("\n").find((line) => line.trim())?.trim();
}

function rootEventId(event: NostrRumor, tagName = "e"): string | undefined {
  // NIP-22 root tags are uppercase; the fourth value is the root author's pubkey, not a marker.
  const roots = event.tags.filter(([name]) => name === tagName);
  return roots.length === 1 ? roots[0][1] : undefined;
}

function statusTicketId(event: NostrRumor): string | undefined {
  const targets = event.tags.filter(([name, , , marker]) => name === "e" && (marker === "root" || marker === undefined));
  return targets.length === 1 ? targets[0][1] : undefined;
}

function normalizedRelays(values: readonly string[]): string[] {
  return unique(
    values
      .filter((value) => /^wss?:\/\//i.test(value.trim()))
      .map(normalizeRelayUrl)
      .filter((value): value is string => Boolean(value)),
  );
}

function httpsUrls(values: readonly string[]): string[] {
  return unique(values.flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? [url.href] : [];
    } catch {
      return [];
    }
  }));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
