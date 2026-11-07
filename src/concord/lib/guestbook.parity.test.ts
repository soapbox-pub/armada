/**
 * Behavioral parity with Vector v0.5.0-3 (`guestbook.rs`, `service.rs`) and
 * CORD-04 §8/§10 at concord#25 for Timeouts and Nicknames. `it.fails` marks what
 * Armada still gets wrong.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { timelineCollapse } from "@/concord/lib/channelJudges";
import { foldTimeline, type OpenedChat } from "@/concord/lib/chat";
import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { foldNicknames, foldTimeouts } from "@/concord/lib/guestbook";
import { KIND_EDIT, KIND_NICKNAME, KIND_TIMEOUT } from "@/concord/lib/kinds";
import { Permissions } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import type { OpenedEvent } from "@/concord/lib/stream";
import { hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

const point = () => bytesToHex(schnorr.getPublicKey(random32()));
const NOW = 1_700_000_000_000;

function gb(kind: number, author: string, tags: string[][], ms: number, content = ""): OpenedEvent {
  return { rumorId: hexKey(), author, kind, content, tags, ms, createdAt: Math.floor(ms / 1000) };
}

const anyone = { nowMs: NOW, ownerHex: hexKey(), mayTimeout: () => true };

describe("Timeouts (kind 3314)", () => {
  it("collapses a post whose newest edit falls inside its author's running Timeout (CORD-04 §8)", () => {
    const { c, base } = rankedCommunity(Permissions.MODERATE_MEMBERS);
    const ch = hexKey();
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "general", private: false } });
    const control = foldControlState([...base, channel], c.id, c.owner);
    const author = point();
    const before = NOW - 60 * 60_000;
    const timeout = gb(KIND_TIMEOUT, c.owner, [["p", author], ["until", String(Math.floor(NOW / 1000) + 3600)]], NOW - 60_000);
    const timeouts = foldTimeouts([timeout], { nowMs: NOW, ownerHex: c.owner, mayTimeout: () => true });
    const original: OpenedChat = { ...gb(9, author, [], before, "fine"), channelIdHex: ch, epoch: 0n };
    const edit: OpenedChat = { ...gb(KIND_EDIT, author, [["e", original.rumorId]], NOW, "now abusive"), channelIdHex: ch, epoch: 0n };
    const collapse = timelineCollapse(control, ch, timeouts, NOW)!;
    const timeline = foldTimeline([original, edit], undefined, { collapse });
    expect(timeline.messages[0].content).toBe("now abusive");
    expect(timeline.quarantined.has(original.rumorId)).toBe(true);
  });

  it("collapses a timed-out member's post on a legacy Roster too (Vector `post_silenced` has no Roles v2 gate)", () => {
    const c = new TestCommunity();
    const ch = hexKey();
    const control = foldControlState([], c.id, c.owner);
    const author = point();
    const timeout = gb(KIND_TIMEOUT, c.owner, [["p", author], ["until", String(Math.floor(NOW / 1000) + 3600)]], NOW - 60_000);
    const timeouts = foldTimeouts([timeout], { nowMs: NOW, ownerHex: c.owner, mayTimeout: () => true });
    const collapse = timelineCollapse(control, ch, timeouts, NOW)!;
    expect(collapse({ ...gb(9, author, [], NOW - 1000, "hi"), channelIdHex: ch, epoch: 0n })).toBe(true);
    expect(collapse({ ...gb(9, hexKey(), [], NOW - 1000, "hi"), channelIdHex: ch, epoch: 0n })).toBe(false);
  });

  it("leaves a post from before the Channel went private standing (Vector: `wasPublic` posts never 'nosend')", () => {
    const { c, base } = rankedCommunity(Permissions.SEND_MESSAGES | Permissions.VIEW_CHANNEL);
    const ch = hexKey();
    const author = point();
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "general", private: false } });
    const o = { scope: ch, target: { kind: "member" as const, id: author }, allow: 0n, deny: Permissions.SEND_MESSAGES };
    const deny = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    const control = foldControlState([...base, channel, deny], c.id, c.owner);
    const collapse = timelineCollapse(control, ch, new Map(), NOW, NOW - 5_000)!;
    expect(collapse({ ...gb(9, author, [], NOW - 10_000, "from the public era"), channelIdHex: ch, epoch: 0n })).toBe(false);
    expect(collapse({ ...gb(9, author, [], NOW - 1_000, "after"), channelIdHex: ch, epoch: 0n })).toBe(true);
  });

  it("reads an `until` with leading zeros (Vector parses any run of digits)", () => {
    const target = point();
    const until = `00${Math.floor(NOW / 1000) + 600}`;
    const t = foldTimeouts([gb(KIND_TIMEOUT, hexKey(), [["p", target], ["until", until]], NOW - 1000)], anyone);
    expect(t.get(target)?.until).toBe(Math.floor(NOW / 1000) + 600);
  });

  it("ignores a bare `[\"p\"]` beside the real one (Vector counts tags with a value only)", () => {
    const target = point();
    const t = foldTimeouts([gb(KIND_TIMEOUT, hexKey(), [["p"], ["p", target], ["until", String(Math.floor(NOW / 1000) + 600)]], NOW - 1000)], anyone);
    expect(t.has(target)).toBe(true);
  });

  it("drops a Timeout whose `p` isn't a public key (Vector `PublicKey::from_hex`)", () => {
    // 64 hex digits, but no point on the curve has x = 2^256 - 1.
    const notAPoint = "f".repeat(64);
    const t = foldTimeouts([gb(KIND_TIMEOUT, hexKey(), [["p", notAPoint], ["until", String(Math.floor(NOW / 1000) + 600)]], NOW - 1000)], anyone);
    expect(t.has(notAPoint)).toBe(false);
  });
});

describe("Nicknames (kind 3315)", () => {
  it("drops a Nickname whose `p` isn't a public key (CORD-04 §10)", () => {
    const notAPoint = "f".repeat(64);
    const n = foldNicknames([gb(KIND_NICKNAME, notAPoint, [["p", notAPoint]], NOW - 1000, "nick")], { nowMs: NOW, mayName: () => true });
    expect(n.has(notAPoint)).toBe(false);
  });

  it("ignores a bare `[\"p\"]` beside the real one", () => {
    const target = point();
    const n = foldNicknames([gb(KIND_NICKNAME, target, [["p"], ["p", target]], NOW - 1000, "nick")], { nowMs: NOW, mayName: () => true });
    expect(n.get(target)).toBe("nick");
  });
});
