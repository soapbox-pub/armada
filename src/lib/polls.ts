/**
 * Transport-agnostic NIP-88 poll logic for NIP-29 and Concord (CORD.md "Polls").
 * Poll: kind 1068, `["option", id, label]` tags. Vote: kind 1018 `e`-tagging
 * the poll with `["response", id]`. Pure, so both transports tally identically.
 */

import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/** NIP-88 poll kind (the poll itself; renders as a timeline message). */
export const KIND_POLL = 1068;
/** NIP-88 poll vote kind (an `e`-referencing side event, tallied per poll). */
export const KIND_POLL_VOTE = 1018;

export type PollType = "singlechoice" | "multiplechoice";

export interface PollOption {
  id: string;
  label: string;
}

export interface ParsedPoll {
  options: PollOption[];
  pollType: PollType;
  /** Unix seconds after which votes are ignored, or undefined for no end. */
  endsAt: number | undefined;
}

/** One voter's choice, normalized across NostrEvent (NIP-29) and sealed rumors (Concord). */
export interface PollVote {
  pubkey: string;
  /** Selected option ids (filtered against the poll's valid ids by the tally). */
  optionIds: string[];
  /** Ordering timestamp in epoch milliseconds — latest vote per pubkey wins. */
  ms: number;
}

/** The tallied result of a poll's votes. */
export interface PollTally {
  /** option id → distinct voters. */
  counts: Map<string, number>;
  /** Distinct voters (percentages are per-voter, so multi-choice can sum >100%). */
  totalVoters: number;
  /** The current user's own selected option ids, or undefined if they haven't voted. */
  myVote: Set<string> | undefined;
}

/** Parse a kind-1068 poll into its options and settings. */
export function parsePoll(event: { tags: string[][] }): ParsedPoll {
  const options: PollOption[] = [];
  let pollType: PollType = "singlechoice";
  let endsAt: number | undefined;

  for (const tag of event.tags) {
    if (tag[0] === "option" && tag[1] && tag[2]) {
      options.push({ id: tag[1], label: tag[2] });
    } else if (tag[0] === "polltype" && tag[1] === "multiplechoice") {
      pollType = "multiplechoice";
    } else if (tag[0] === "endsAt" && tag[1]) {
      const parsed = Number.parseInt(tag[1], 10);
      if (Number.isFinite(parsed)) endsAt = parsed;
    }
  }

  return { options, pollType, endsAt };
}

/**
 * Deterministic tally: latest vote per pubkey wins, votes after `endsAt` and
 * undeclared options are dropped.
 */
export function tallyPollVotes(
  votes: PollVote[],
  options: PollOption[],
  endsAt: number | undefined,
  selfPubkey: string | undefined,
): PollTally {
  const latest = new Map<string, PollVote>();
  for (const vote of votes) {
    if (endsAt !== undefined && vote.ms / 1000 > endsAt) continue;
    const existing = latest.get(vote.pubkey);
    if (!existing || vote.ms > existing.ms) latest.set(vote.pubkey, vote);
  }

  const counts = new Map<string, number>();
  const validIds = new Set(options.map((o) => o.id));
  for (const vote of latest.values()) {
    const responses = new Set(vote.optionIds.filter((id) => validIds.has(id)));
    for (const optionId of responses) {
      counts.set(optionId, (counts.get(optionId) ?? 0) + 1);
    }
  }

  const mine = selfPubkey ? latest.get(selfPubkey) : undefined;
  const myVote = mine ? new Set(mine.optionIds) : undefined;

  return { counts, totalVoters: latest.size, myVote };
}

/** Descriptive poll tags shared by both transports; each prepends its own channel binding. */
export function buildPollTags(
  question: string,
  options: PollOption[],
  pollType: PollType,
  durationDays: number,
): string[][] {
  const tags: string[][] = [];
  for (const opt of options) tags.push(["option", opt.id, opt.label.trim()]);
  tags.push(["polltype", pollType]);
  if (durationDays > 0) {
    tags.push(["endsAt", String(nowSecs() + durationDays * 86_400)]);
  }
  tags.push(["alt", `Poll: ${question}`]);
  return tags;
}

/** Whether a poll with this `endsAt` (unix seconds) has closed. */
export function isPollEnded(endsAt: number | undefined): boolean {
  return endsAt !== undefined && endsAt < nowSecs();
}

/** Format an `endsAt` timestamp as a short relative string ("in 3d"). */
export function formatEndsAt(endsAt: number): string {
  const diff = endsAt - nowSecs();
  if (diff < 3600) return t({ id: "polls.endsInMinutes", defaultMessage: "in {count}m" }, { count: Math.max(1, Math.floor(diff / 60)) });
  if (diff < 86400) return t({ id: "polls.endsInHours", defaultMessage: "in {count}h" }, { count: Math.floor(diff / 3600) });
  return t({ id: "polls.endsInDays", defaultMessage: "in {count}d" }, { count: Math.floor(diff / 86400) });
}
