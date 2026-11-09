/**
 * How a Channel's timeline judges each post on the vsk-13 Roster: what collapses
 * (CORD-04 §8) and, on a restricted Channel, what its Writers ledger stands behind
 * (CORD-03 §1).
 */

import type { OpenedChat } from "@/concord/lib/chat";
import { citationSatisfied, type FoldedControl } from "@/concord/lib/control";
import type { AuthorityCitation } from "@/concord/lib/edition";
import type { OpenedEvent } from "@/concord/lib/stream";
import { awayAt, foldNicknames, foldTimeouts, inTimeoutWindow, isMemberIn, kickedAwayIn, timeoutRunning, type FoldedTimeout, type GuestbookHistory } from "@/concord/lib/guestbook";
import { canActOnMember, channelPermissions, everyoneSends, hasPermission, mayName, outranksMember, Permissions } from "@/concord/lib/roles";
import { ledgerRestricted, postStands, readAddressTakes, ridesWriterAddress, writerWindows } from "@/concord/lib/writers";

/** Posts inside their author's running Timeout, and, in an open Channel, posts whose author can't send there. */
export function timelineCollapse(
  control: FoldedControl | undefined,
  channelIdHex: string | null,
  timeouts: ReadonlyMap<string, FoldedTimeout>,
  nowMs: number,
  /** When a converted Channel went private (unix ms): a post from before was a public post (CORD-03 §2). */
  publicUntilMs?: number,
): ((m: OpenedChat) => boolean) | undefined {
  if (!control || !channelIdHex) return undefined;
  // A legacy Roster has no channel overwrites, but its Timeouts still run (Vector `post_silenced`).
  if (!control.rankedRoster && timeouts.size === 0) return undefined;
  const isPrivate = control.rankedRoster ? (control.channels.get(channelIdHex)?.isPrivate ?? false) : false;
  const open = control.rankedRoster === true && everyoneSends(control.roster, channelIdHex);
  // A post collapses while its time, or its newest edit's, falls in the window (CORD-04 §8).
  return (m: OpenedChat) =>
    inTimeoutWindow(timeouts.get(m.author), m.ms, nowMs) ||
    (m.editedMs !== undefined && inTimeoutWindow(timeouts.get(m.author), m.editedMs, nowMs)) ||
    (open && !(publicUntilMs !== undefined && m.ms < publicUntilMs) && (channelPermissions(control.roster, control.ownerHex, m.author, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) === 0n);
}

/**
 * May `actor` hide `author`'s message in this Channel (CORD-03 §3)? MANAGE_MESSAGES
 * resolves through the Channel's overwrites on the vsk-13 Roster, server-wide on
 * the legacy one; the outrank is server-wide either way (Vector `can_hide_in_channel`).
 */
export function mayHideIn(control: FoldedControl, actor: string, author: string, channelIdHex: string | undefined): boolean {
  const owner = control.ownerHex;
  if (!control.rankedRoster || !channelIdHex) return canActOnMember(control.roster, actor, owner, author, Permissions.MANAGE_MESSAGES);
  if (author === owner || !outranksMember(control.roster, actor, owner, author)) return false;
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  return (channelPermissions(control.roster, owner, actor, channelIdHex, isPrivate) & Permissions.MANAGE_MESSAGES) !== 0n;
}

/**
 * The members whose posts in an open Channel collapse for lacking SEND_MESSAGES there
 * (CORD-04 §8), for notifiers that can't resolve the Roster: exact, since anyone without
 * a Grant or member overwrite resolves as `@everyone` does, which in an open Channel sends.
 */
export function sendDeniedIn(control: FoldedControl | undefined, channelIdHex: string): string[] {
  if (!control?.rankedRoster || !everyoneSends(control.roster, channelIdHex)) return [];
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  const candidates = new Set<string>(control.roster.grants.map((g) => g.member));
  for (const o of control.roster.overwrites ?? []) if (o.target.kind === "member") candidates.add(o.target.id);
  return [...candidates]
    .filter((pk) => pk !== control.ownerHex && (channelPermissions(control.roster, control.ownerHex, pk, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) === 0n)
    .sort();
}

/**
 * Who may post at a restricted Channel's read address (CORD-03 §1 "Held posts"), for
 * notifiers that listen there and hold no ledger: the owner and the members who manage
 * Channels, as {@link writerJudge} vouches for them. Undefined where the read address
 * takes everyone's posts, or where `@everyone` itself manages Channels. A writer's post
 * crossing a move is left out: it rings nobody, which a held post must never do the other way.
 */
export function restrictedPostersIn(control: FoldedControl | undefined, channelIdHex: string): string[] | undefined {
  if (!control?.writers || !ledgerRestricted(control.writers.get(channelIdHex))) return undefined;
  const manages = (pk: string) => !control.banned.has(pk) && hasPermission(control.roster, pk, Permissions.MANAGE_CHANNELS);
  if (manages("0".repeat(64))) return undefined;
  const out = new Set<string>([control.ownerHex]);
  for (const g of control.roster.grants) if (manages(g.member)) out.add(g.member);
  return [...out].sort();
}

/** The running Timeouts (CORD-04 §8), judged against the Roster as it stands, as {@link useGuestbook} does. */
export function runningTimeouts(
  opened: OpenedEvent[],
  control: FoldedControl | undefined,
  communityId: Uint8Array,
  nowMs: number,
): { pk: string; fromSecs: number; until: number }[] {
  if (!control) return [];
  const folded = foldTimeouts(opened, {
    nowMs,
    ownerHex: control.ownerHex,
    banned: control.banned,
    mayTimeout: (actor, target, citation) =>
      canActOnMember(control.roster, actor, control.ownerHex, target, Permissions.MODERATE_MEMBERS) &&
      citationSatisfied(control, communityId, actor, citation),
  });
  return [...folded].filter(([, t]) => timeoutRunning(t, nowMs)).map(([pk, t]) => ({ pk, fromSecs: t.fromSecs, until: t.until })).sort((a, b) => (a.pk < b.pk ? -1 : 1));
}

/**
 * The Nicknames members go by (CORD-04 §10), as {@link useGuestbook} folds them: only the
 * live epoch's count, judged on the Roster as it stands; for notifiers naming a sender.
 */
export function communityNicknames(
  opened: OpenedEvent[],
  control: FoldedControl | undefined,
  communityId: Uint8Array,
  livePk: string,
  nowMs: number,
): Record<string, string> {
  if (!control) return {};
  const mayTimeout = (actor: string, target: string, citation: AuthorityCitation | undefined) =>
    canActOnMember(control.roster, actor, control.ownerHex, target, Permissions.MODERATE_MEMBERS) &&
    citationSatisfied(control, communityId, actor, citation);
  const timeouts = foldTimeouts(opened, { nowMs, ownerHex: control.ownerHex, banned: control.banned, mayTimeout });
  const nicks = foldNicknames(opened.filter((e) => e.streamPk === livePk), {
    nowMs,
    banned: control.banned,
    timeouts,
    mayName: (actor, target, citation) =>
      mayName(control.roster, actor, control.ownerHex, target) &&
      (actor === target || citationSatisfied(control, communityId, actor, citation)),
  });
  return Object.fromEntries([...nicks].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** How far past the ledger entry that moved an address a post crossing it still stands (CORD-03 §1). */
export const ENTRY_SKEW_MS = 10 * 60_000;

/**
 * A restricted Channel's judge (CORD-03 §1, Vector's `Judge`): a post stands by the
 * ledger, at an address that takes it from a writer who hadn't left, or on the
 * Roster, from a member who manages the Channel or may post there and crossed a
 * move of the ledger. `history` is the Guestbook; while it's unread, membership
 * and departures aren't judged.
 */
export function writerJudge(
  control: FoldedControl | undefined,
  channelIdHex: string | null,
  communityId: Uint8Array | undefined,
  history?: GuestbookHistory,
): { stands: (m: OpenedChat) => boolean } | undefined {
  const ledger = channelIdHex ? control?.writers?.get(channelIdHex) : undefined;
  if (!control || !ledger || !communityId || !channelIdHex) return undefined;
  const owner = control.ownerHex;
  const manages = (pk: string) =>
    pk === owner || (!control.banned.has(pk) && hasPermission(control.roster, pk, Permissions.MANAGE_CHANNELS));
  const member = (pk: string) => history === undefined || isMemberIn(history, pk);
  const departed = (pk: string, at: number) => history !== undefined && awayAt(history, pk, at);
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  const mayPost = (pk: string) =>
    (channelPermissions(control.roster, owner, pk, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) !== 0n;
  const windows = writerWindows(ledger);
  const crossedAMove = (at: number, wepoch: number | undefined) => {
    const justPast = (edge: number) => edge <= at && at - edge < ENTRY_SKEW_MS;
    return windows.some((w) => (wepoch === undefined ? justPast(w.from) : w.epoch === wepoch && w.to !== undefined && justPast(w.to)));
  };
  const byLedger = (m: OpenedChat, wepoch: number | undefined) => {
    const open = readAddressTakes(ledger, m.ms);
    if (wepoch === undefined) return open || !ridesWriterAddress(m.kind);
    if (open) return true;
    const start = windows.find((w) => w.epoch === wepoch)?.from ?? 0;
    return (
      postStands(ledger, communityId, m) &&
      !(history !== undefined && kickedAwayIn(history, m.author, start, m.ms)) &&
      !departed(m.author, m.ms)
    );
  };
  const vouched = (m: OpenedChat, wepoch: number | undefined) => {
    if (m.author === owner) return true;
    const writes = ledgerRestricted(ledger) && crossedAMove(m.ms, wepoch) && mayPost(m.author);
    return (manages(m.author) || writes) && member(m.author) && !departed(m.author, m.ms);
  };
  const stands = (m: OpenedChat) => {
    if (control.banned.has(m.author) && m.author !== owner) return false;
    const tag = m.tags.find((t) => t[0] === "wepoch")?.[1];
    const wepoch = tag === undefined ? undefined : Number(tag);
    return byLedger(m, wepoch) || vouched(m, wepoch);
  };
  return { stands };
}

/**
 * The timeline's rules for a Channel: posts the Roster collapses stay openable, and a
 * restricted Channel's posts its ledger doesn't stand behind are held from every
 * reader, managers included.
 */
export function timelineRules(
  collapse: ((m: OpenedChat) => boolean) | undefined,
  judge: { stands: (m: OpenedChat) => boolean } | undefined,
): { collapse?: (m: OpenedChat) => boolean; hold?: (m: OpenedChat) => boolean } {
  return {
    ...(collapse ? { collapse } : {}),
    ...(judge ? { hold: (m: OpenedChat) => !judge.stands(m) } : {}),
  };
}
