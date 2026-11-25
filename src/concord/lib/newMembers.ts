/**
 * The Manage community Overview's "New members" list: recent firsthand Joins, with
 * the hints that tell a returning banned member from a newcomer. Every hint is
 * advisory — a Join's invite attribution is written by the joiner themselves.
 */

import type { CoalescedMember } from "@/concord/lib/guestbook";
import { KIND_JOIN_LEAVE } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";

/** How far back a Join still asks for a look. */
export const REVIEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** A Join this soon after a ban is worth pointing out. */
export const AFTER_BAN_MS = 24 * 60 * 60 * 1000;

export interface NewMember {
  pubkey: string;
  joinedMs: number;
  /** The invite the joiner says they used. */
  invite?: { creator: string; label?: string };
  /** How long after the nearest earlier ban they joined, when within {@link AFTER_BAN_MS}. */
  afterBanMs?: number;
  /** Whether a banned member said they joined through the same labelled invite. */
  sameLinkAsBanned: boolean;
}

const linkKey = (invite: { creator: string; label?: string }) => `${invite.creator}\u0000${invite.label}`;

export function newMembersToReview(input: {
  coalesced: ReadonlyMap<string, CoalescedMember>;
  /** The Guestbook as read: the fold drops banned authors' Joins, which the link hint needs. */
  guestbook: readonly OpenedEvent[];
  banned: ReadonlySet<string>;
  /** Unix SECONDS, as the control fold keeps them. */
  bannedAt: ReadonlyMap<string, number>;
  ownerHex: string;
  self?: string;
  nowMs: number;
  reviewed: (pubkey: string, joinedMs: number) => boolean;
}): NewMember[] {
  const { coalesced, guestbook, banned, bannedAt, ownerHex, self, nowMs, reviewed } = input;

  // Only a labelled link: one owner's unlabelled default would flag everyone who used it.
  const bannedLinks = new Set<string>();
  for (const ev of guestbook) {
    if (ev.kind !== KIND_JOIN_LEAVE || ev.content !== "join" || !banned.has(ev.author)) continue;
    const tag = ev.tags.find((t) => t[0] === "invite" && t.length >= 3);
    if (tag && tag[2]) bannedLinks.add(linkKey({ creator: tag[1], label: tag[2] }));
  }
  const banTimes = [...bannedAt.values()].map((s) => s * 1000).sort((a, b) => a - b);

  const out: NewMember[] = [];
  for (const m of coalesced.values()) {
    if (m.state !== "join" || m.fromSnapshot) continue;
    if (m.pubkey === ownerHex || m.pubkey === self || banned.has(m.pubkey)) continue;
    if (m.ms < nowMs - REVIEW_WINDOW_MS || m.ms > nowMs + AFTER_BAN_MS) continue;
    if (reviewed(m.pubkey, m.ms)) continue;
    let lastBan: number | undefined;
    for (const at of banTimes) {
      if (at > m.ms) break;
      lastBan = at;
    }
    const afterBanMs = lastBan !== undefined && m.ms - lastBan <= AFTER_BAN_MS ? m.ms - lastBan : undefined;
    out.push({
      pubkey: m.pubkey,
      joinedMs: m.ms,
      ...(m.invite ? { invite: m.invite } : {}),
      ...(afterBanMs !== undefined ? { afterBanMs } : {}),
      sameLinkAsBanned: Boolean(m.invite?.label && bannedLinks.has(linkKey(m.invite))),
    });
  }
  // Flagged first, then newest.
  const flags = (n: NewMember) => Number(n.afterBanMs !== undefined) + Number(n.sameLinkAsBanned);
  return out.sort((a, b) => flags(b) - flags(a) || b.joinedMs - a.joinedMs);
}
