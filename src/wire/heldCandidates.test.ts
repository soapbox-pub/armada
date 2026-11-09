/** A candidate held for its date is judged again when due (CORD-03 §3, CORD-04 §4, §8). */
import { describe, expect, it } from "vitest";

import { KIND_MESSAGE, KIND_REACTION } from "@/concord/lib/kinds";
import { concordCandidateRings, postSilenced } from "@/wire/ingest";
import { candidateStillRings, registerCandidateRecheck, type NotifyCandidate } from "@/wire/notify";
import type { WireSpec } from "@/wire/spec";

const CH = "ee".repeat(32);
const CID = "ab".repeat(32);
const ANA = "a".repeat(64);
const BEN = "b".repeat(64);
const NOW = 1_700_000_000_000;

function cand(over: Partial<NotifyCandidate> = {}): NotifyCandidate {
  return {
    plane: "c2",
    author: ANA,
    createdAt: NOW / 1000,
    ms: NOW,
    mention: true,
    kind: KIND_MESSAGE,
    roomKey: `c2:${CH}`,
    readKey: CH,
    path: "",
    channelIdHex: CH,
    ...over,
  };
}

function spec(o: { banned?: string[]; silence?: Parameters<typeof postSilenced>[0] } = {}): WireSpec {
  return {
    concordCommunityByChannel: new Map([[CH, CID]]),
    concordBannedByCommunity: new Map(o.banned ? [[CID, new Set(o.banned)]] : []),
    concordSilenceByChannel: new Map(o.silence ? [[CH, o.silence]] : []),
  } as unknown as WireSpec;
}

describe("concordCandidateRings", () => {
  it("rings while nothing silences it", () => {
    expect(concordCandidateRings(spec(), cand(), NOW)).toBe(true);
  });

  it("is silenced by a ban, a send deny, or a Timeout covering its time that landed since", () => {
    expect(concordCandidateRings(spec({ banned: [ANA] }), cand(), NOW)).toBe(false);
    expect(concordCandidateRings(spec({ silence: { sendDenied: new Set([ANA]) } }), cand(), NOW)).toBe(false);
    const timeout = { pk: ANA, fromSecs: NOW / 1000 - 10, until: NOW / 1000 + 600 };
    expect(concordCandidateRings(spec({ silence: { timeouts: [timeout] } }), cand(), NOW)).toBe(false);
  });

  it("is silenced on a restricted Channel unless its author posts there, reactions aside", () => {
    const restricted = spec({ silence: { postAuthors: new Set([BEN]) } });
    expect(concordCandidateRings(restricted, cand(), NOW)).toBe(false);
    expect(concordCandidateRings(restricted, cand({ author: BEN }), NOW)).toBe(true);
    expect(concordCandidateRings(restricted, cand({ kind: KIND_REACTION, reaction: true }), NOW)).toBe(true);
  });

  it("leaves other planes, and a page with no spec yet, as they were", () => {
    expect(concordCandidateRings(spec({ banned: [ANA] }), cand({ plane: "dm", channelIdHex: undefined }), NOW)).toBe(true);
    expect(concordCandidateRings(undefined, cand(), NOW)).toBe(true);
  });
});

describe("postSilenced", () => {
  it("counts a Timeout only while it runs and over its window", () => {
    const silence = { timeouts: [{ pk: ANA, fromSecs: NOW / 1000, until: NOW / 1000 + 60 }] };
    expect(postSilenced(silence, ANA, KIND_MESSAGE, NOW, NOW)).toBe(true);
    expect(postSilenced(silence, ANA, KIND_MESSAGE, NOW - 1, NOW)).toBe(false);
    expect(postSilenced(silence, ANA, KIND_MESSAGE, NOW, NOW + 60_000)).toBe(false);
  });
});

describe("candidateStillRings", () => {
  it("asks the registered recheck, and rings as it arrived when none is registered", () => {
    expect(candidateStillRings(cand())).toBe(true);
    const unregister = registerCandidateRecheck((c) => concordCandidateRings(spec({ banned: [ANA] }), c, NOW));
    expect(candidateStillRings(cand())).toBe(false);
    expect(candidateStillRings(cand({ author: BEN }))).toBe(true);
    unregister();
    expect(candidateStillRings(cand())).toBe(true);
  });
});
