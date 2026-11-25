import { describe, expect, it } from "vitest";

import type { CoalescedMember } from "@/concord/lib/guestbook";
import { KIND_JOIN_LEAVE } from "@/concord/lib/kinds";
import { AFTER_BAN_MS, newMembersToReview, REVIEW_WINDOW_MS } from "@/concord/lib/newMembers";
import type { OpenedEvent } from "@/concord/lib/stream";

const NOW = 1_700_000_000_000;
const OWNER = "0".repeat(64);
const pk = (c: string) => c.repeat(64);

function joined(pubkey: string, ms: number, extra: Partial<CoalescedMember> = {}): [string, CoalescedMember] {
  return [pubkey, { pubkey, state: "join", ms, rumorId: pubkey, fromSnapshot: false, ...extra }];
}

function joinRumor(author: string, ms: number, invite?: [string, string]): OpenedEvent {
  return {
    rumorId: `${author.slice(0, 8)}${ms}`,
    author,
    kind: KIND_JOIN_LEAVE,
    content: "join",
    tags: invite ? [["invite", ...invite]] : [],
    ms,
    createdAt: Math.floor(ms / 1000),
  };
}

function review(input: Partial<Parameters<typeof newMembersToReview>[0]> & { coalesced: Map<string, CoalescedMember> }) {
  return newMembersToReview({
    guestbook: [],
    banned: new Set(),
    bannedAt: new Map(),
    ownerHex: OWNER,
    nowMs: NOW,
    reviewed: () => false,
    ...input,
  });
}

describe("newMembersToReview", () => {
  it("lists recent firsthand joins, newest first, and nobody older than the window", () => {
    const out = review({
      coalesced: new Map([
        joined(pk("a"), NOW - 60_000),
        joined(pk("b"), NOW - 10_000),
        joined(pk("c"), NOW - REVIEW_WINDOW_MS - 1),
      ]),
    });
    expect(out.map((m) => m.pubkey)).toEqual([pk("b"), pk("a")]);
  });

  it("leaves out the owner, the viewer, the banned, departures and snapshot seeds", () => {
    const out = review({
      self: pk("s"),
      banned: new Set([pk("x")]),
      coalesced: new Map([
        joined(OWNER, NOW - 1000),
        joined(pk("s"), NOW - 1000),
        joined(pk("x"), NOW - 1000),
        joined(pk("l"), NOW - 1000, { state: "leave" }),
        joined(pk("r"), NOW - 1000, { fromSnapshot: true }),
        joined(pk("k"), NOW - 1000),
      ]),
    });
    expect(out.map((m) => m.pubkey)).toEqual([pk("k")]);
  });

  it("drops a join marked reviewed, but not the same member's later rejoin", () => {
    const reviewedAt = NOW - 5000;
    const reviewed = (p: string, ms: number) => p === pk("a") && ms === reviewedAt;
    expect(review({ reviewed, coalesced: new Map([joined(pk("a"), reviewedAt)]) })).toEqual([]);
    expect(review({ reviewed, coalesced: new Map([joined(pk("a"), NOW - 1000)]) })).toHaveLength(1);
  });

  it("flags a join soon after a ban, and puts it first", () => {
    const banSecs = Math.floor((NOW - 30 * 60_000) / 1000);
    const out = review({
      banned: new Set([pk("x")]),
      bannedAt: new Map([[pk("x"), banSecs]]),
      coalesced: new Map([
        joined(pk("e"), NOW - 20 * 60_000),
        joined(pk("n"), NOW - 1000),
        joined(pk("o"), banSecs * 1000 - 1000),
      ]),
    });
    // Both joins after the ban are flagged and come first, newest first; the one before it is last.
    expect(out.map((m) => m.pubkey)).toEqual([pk("n"), pk("e"), pk("o")]);
    expect(out[1].afterBanMs).toBe(NOW - 20 * 60_000 - banSecs * 1000);
    expect(out[2].afterBanMs).toBeUndefined();
  });

  it("doesn't flag a join more than a day after the last ban", () => {
    const banSecs = Math.floor((NOW - AFTER_BAN_MS - 60_000) / 1000);
    const [m] = review({ bannedAt: new Map([[pk("x"), banSecs]]), coalesced: new Map([joined(pk("a"), NOW - 1000)]) });
    expect(m.afterBanMs).toBeUndefined();
  });

  it("flags the same labelled invite a banned member joined through, and not an unlabelled one", () => {
    const creator = pk("c");
    const out = review({
      banned: new Set([pk("x"), pk("y")]),
      guestbook: [
        joinRumor(pk("x"), NOW - 9_000_000, [creator, "discord"]),
        joinRumor(pk("y"), NOW - 9_000_000, [creator, ""]),
      ],
      coalesced: new Map([
        joined(pk("a"), NOW - 1000, { invite: { creator, label: "discord" } }),
        joined(pk("b"), NOW - 2000, { invite: { creator, label: "website" } }),
        joined(pk("d"), NOW - 3000, { invite: { creator } }),
      ]),
    });
    expect(Object.fromEntries(out.map((m) => [m.pubkey, m.sameLinkAsBanned]))).toEqual({
      [pk("a")]: true,
      [pk("b")]: false,
      [pk("d")]: false,
    });
  });
});
