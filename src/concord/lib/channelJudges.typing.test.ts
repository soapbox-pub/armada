import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { typingSilenced } from "@/concord/lib/channelJudges";
import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { foldTimeouts, type CoalescedMember, type GuestbookHistory } from "@/concord/lib/guestbook";
import { KIND_TIMEOUT } from "@/concord/lib/kinds";
import { Permissions } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { hexKey, rankedCommunity } from "@/test/concordEditions";

const point = () => bytesToHex(schnorr.getPublicKey(random32()));
const NOW = 1_700_000_000_000;

function entry(pubkey: string, state: CoalescedMember["state"], ms: number): CoalescedMember {
  return { pubkey, state, ms, rumorId: hexKey(), fromSnapshot: false };
}

function setup() {
  const { c, base } = rankedCommunity(Permissions.SEND_MESSAGES | Permissions.VIEW_CHANNEL);
  const ch = hexKey();
  const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "general", private: false } });
  return { c, base, ch, channel };
}

describe("typingSilenced", () => {
  it("shows a member in good standing", () => {
    const { c, base, ch, channel } = setup();
    const control = foldControlState([...base, channel], c.id, c.owner);
    expect(typingSilenced(control, ch, new Map(), new Map(), NOW)(point())).toBe(false);
  });

  it("hides a banned member", () => {
    const { c, base, ch, channel } = setup();
    const control = foldControlState([...base, channel], c.id, c.owner);
    const banned = point();
    control.banned.add(banned);
    expect(typingSilenced(control, ch, new Map(), undefined, NOW)(banned)).toBe(true);
  });

  it("hides a member the Guestbook holds kicked, until they join again", () => {
    const { c, base, ch, channel } = setup();
    const control = foldControlState([...base, channel], c.id, c.owner);
    const member = point();
    const kicked: GuestbookHistory = new Map([[member, [entry(member, "join", NOW - 60_000), entry(member, "kick", NOW - 10_000)]]]);
    expect(typingSilenced(control, ch, new Map(), kicked, NOW)(member)).toBe(true);
    const back: GuestbookHistory = new Map([[member, [...kicked.get(member)!, entry(member, "join", NOW - 1_000)]]]);
    expect(typingSilenced(control, ch, new Map(), back, NOW)(member)).toBe(false);
  });

  it("hides a member inside a running Timeout", () => {
    const { c, base, ch, channel } = setup();
    const control = foldControlState([...base, channel], c.id, c.owner);
    const member = point();
    const timeout = { rumorId: hexKey(), author: c.owner, kind: KIND_TIMEOUT, content: "", tags: [["p", member], ["until", String(Math.floor(NOW / 1000) + 3600)]], ms: NOW - 60_000, createdAt: Math.floor(NOW / 1000) - 60 };
    const timeouts = foldTimeouts([timeout], { nowMs: NOW, ownerHex: c.owner, mayTimeout: () => true });
    expect(typingSilenced(control, ch, timeouts, undefined, NOW)(member)).toBe(true);
  });

  it("hides a member who can't send in the Channel", () => {
    const { c, base, ch, channel } = setup();
    const member = point();
    const o = { scope: ch, target: { kind: "member" as const, id: member }, allow: 0n, deny: Permissions.SEND_MESSAGES };
    const deny = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    const control = foldControlState([...base, channel, deny], c.id, c.owner);
    expect(typingSilenced(control, ch, new Map(), undefined, NOW)(member)).toBe(true);
  });

  it("never hides the owner", () => {
    const { c, base, ch, channel } = setup();
    const control = foldControlState([...base, channel], c.id, c.owner);
    expect(typingSilenced(control, ch, new Map(), undefined, NOW)(c.owner)).toBe(false);
  });
});
