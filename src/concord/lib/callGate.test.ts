import { describe, expect, it } from "vitest";

import { callAllowance, callGain, callGateFor, DUCK_GAIN, mayConnect, setCallGate, setPrioritySpeaking } from "@/concord/lib/callGate";
import { foldControlState } from "@/concord/lib/control";
import type { FoldedTimeout } from "@/concord/lib/guestbook";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { Permissions } from "@/concord/lib/roles";
import { hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

const NOW = 1_700_000_000_000;
const running = (until: number): FoldedTimeout => ({ by: hexKey(), fromSecs: Math.floor(NOW / 1000) - 60, until, ms: NOW - 60_000, rumorId: hexKey() });

describe("who a call lets be heard and seen (Vector `may_speak`, `may_video`)", () => {
  it("follows SPEAK and VIDEO in the Channel on the vsk-13 Roster", () => {
    const { c, base } = rankedCommunity(0n);
    const ch = hexKey();
    const member = hexKey();
    const o = { scope: ch, target: { kind: "member" as const, id: member }, allow: 0n, deny: Permissions.SPEAK };
    const deny = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "voice", private: false } });
    const folded = foldControlState([...base, channel, deny], c.id, c.owner);
    expect(callAllowance(folded, ch, false, member, new Map(), NOW)).toEqual({ speak: false, video: true });
    expect(callAllowance(folded, ch, false, hexKey(), new Map(), NOW)).toEqual({ speak: true, video: true });
  });

  it("silences and hides a member while their Timeout runs, on any Roster", () => {
    const c = new TestCommunity();
    const member = hexKey();
    const folded = foldControlState([], c.id, c.owner);
    const timeouts = new Map([[member, running(Math.floor(NOW / 1000) + 600)]]);
    expect(callAllowance(folded, hexKey(), false, member, timeouts, NOW)).toEqual({ speak: false, video: false });
    expect(callAllowance(folded, hexKey(), false, member, timeouts, NOW + 3_600_000)).toEqual({ speak: true, video: true });
  });
});

describe("who may be in a call at all (CORD-07 §1, Vector `may_connect`)", () => {
  function denied(bit: bigint) {
    const { c, base } = rankedCommunity(0n);
    const ch = hexKey();
    const member = hexKey();
    const o = { scope: ch, target: { kind: "member" as const, id: member }, allow: 0n, deny: bit };
    const deny = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "voice", private: false } });
    return { c, ch, member, folded: foldControlState([...base, channel, deny], c.id, c.owner) };
  }

  it("needs View and Connect in the Channel on the vsk-13 Roster", () => {
    const connect = denied(Permissions.CONNECT);
    expect(mayConnect(connect.folded, connect.ch, false, connect.member)).toBe(false);
    expect(mayConnect(connect.folded, connect.ch, false, hexKey())).toBe(true);
    const view = denied(Permissions.VIEW_CHANNEL);
    expect(mayConnect(view.folded, view.ch, false, view.member)).toBe(false);
  });

  it("keeps a member without Connect out of everyone's call: not heard, not seen", () => {
    const { ch, member, folded } = denied(Permissions.CONNECT);
    expect(callGateFor(folded, ch, false, new Map(), [], undefined, NOW)(member)).toMatchObject({ speak: false, video: false, connect: false });
  });

  it("refuses a banned member, and on a legacy Roster a Private Channel's outsider", () => {
    const c = new TestCommunity();
    const ch = hexKey();
    const member = hexKey();
    const priv = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "staff", private: true } });
    const folded = foldControlState([priv], c.id, c.owner);
    expect(mayConnect(folded, ch, true, member)).toBe(false);
    expect(mayConnect(folded, ch, true, c.owner)).toBe(true);
    expect(mayConnect(folded, hexKey(), false, member)).toBe(true);
    expect(mayConnect({ ...folded, banned: new Set([member]) }, hexKey(), false, member)).toBe(false);
  });
});

describe("a moderator's mute or deafen in the call gate (CORD-07 §7, Vector `may_speak`)", () => {
  const [a, b, me] = [hexKey(), hexKey(), hexKey()];
  const gate = (present: { author: string; serverMuted?: boolean; serverDeafened?: boolean }[], viewer = me) =>
    callGateFor(undefined, hexKey(), false, new Map(), present, viewer, 0);

  it("silences a server-muted or server-deafened member to everyone", () => {
    const g = gate([{ author: a, serverMuted: true }, { author: b, serverDeafened: true }, { author: me }]);
    expect(g(a).speak).toBe(false);
    expect(g(b).speak).toBe(false);
    expect(g(a).video).toBe(true);
  });

  it("plays nobody to a deafened viewer", () => {
    const g = gate([{ author: a }, { author: me, serverDeafened: true }]);
    expect(g(a).speak).toBe(false);
    expect(gate([{ author: a }, { author: me }])(a).speak).toBe(true);
  });
});

describe("PRIORITY_SPEAKER ducks the rest while they talk (CORD-07 §7, Vector `DUCK_GAIN`)", () => {
  it("plays others at the duck gain, and other priority speakers and the silenced as before", () => {
    const { c, base, admin } = rankedCommunity(Permissions.PRIORITY_SPEAKER | Permissions.SPEAK);
    const ch = hexKey();
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "voice", private: false } });
    const folded = foldControlState([...base, channel], c.id, c.owner);
    const member = hexKey();
    expect(callAllowance(folded, ch, false, admin, new Map(), NOW).priority).toBe(true);
    expect(callAllowance(folded, ch, false, member, new Map(), NOW).priority).toBeUndefined();

    setCallGate(callGateFor(folded, ch, false, new Map(), [], undefined, NOW));
    try {
      expect(callGain(member)).toBe(1);
      setPrioritySpeaking(true);
      expect(callGain(member)).toBe(DUCK_GAIN);
      expect(callGain(admin)).toBe(1);
    } finally {
      setPrioritySpeaking(false);
      setCallGate(undefined);
    }
  });
});
