/**
 * CORD-04 §8 at concord#27 (Vector v0.5.2 `channel_react_denied`): a reader doesn't
 * count a reaction whose author lacks ADD_REACTIONS in the Channel, judged on the
 * Roster as it stands, and a Roster that gives the bit back counts it again.
 */
import { describe, expect, it } from "vitest";

import { channelRules, reactionIgnored, reactsIn } from "@/concord/lib/channelJudges";
import { foldTimeline, type OpenedChat } from "@/concord/lib/chat";
import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_REACTION } from "@/concord/lib/kinds";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { Permissions } from "@/concord/lib/roles";
import { hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

let seq = 0;
function opened(channelIdHex: string, author: string, kind: number, content: string, extra: string[][] = []): OpenedChat {
  const ms = 1_700_000_000_000 + seq * 1000;
  return {
    rumorId: (seq++).toString(16).padStart(64, "0"),
    author,
    kind,
    content,
    tags: [["channel", channelIdHex], ...extra],
    ms,
    createdAt: Math.floor(ms / 1000),
    channelIdHex,
    epoch: 0n,
  };
}

function setup() {
  const { c, base, admin } = rankedCommunity(Permissions.SEND_MESSAGES);
  const id = random32();
  const idHex = bytesToHex(id);
  const channel = c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "general", private: false } });
  return { c, base: [...base, channel], admin, idHex };
}

function denyReactions(c: TestCommunity, scope: string, member: string, prev?: ReturnType<TestCommunity["edition"]>) {
  const o = { scope, target: { kind: "member" as const, id: member }, allow: 0n, deny: Permissions.ADD_REACTIONS };
  return c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o), ...(prev ? { prev } : {}) });
}

describe("reactions readers count (CORD-04 §8)", () => {
  it("ignores a reaction whose author lacks ADD_REACTIONS there, and counts it again once the bit is back", () => {
    const { c, base, idHex } = setup();
    const denied = hexKey();
    const allowed = hexKey();
    const msg = opened(idHex, allowed, KIND_MESSAGE, "hi");
    const rows = [msg, opened(idHex, denied, KIND_REACTION, "🔥", [["e", msg.rumorId]]), opened(idHex, allowed, KIND_REACTION, "🔥", [["e", msg.rumorId]])];

    const deny = denyReactions(c, idHex, denied);
    const folded = foldControlState([...base, deny], c.id, c.owner);
    const rules = channelRules(folded, idHex, c.id, new Map(), undefined, Date.now());
    const tally = foldTimeline(rows, undefined, rules).reactions.get(msg.rumorId)?.get("🔥");
    expect([...(tally?.reactors.keys() ?? [])]).toEqual([allowed]);

    const lifted = { scope: idHex, target: { kind: "member" as const, id: denied }, allow: 0n, deny: 0n };
    const lift = c.edition({ vsk: "14", eid: overwriteLocator(c.id, lifted), author: c.owner, content: overwriteToJSON(lifted), prev: deny });
    const again = foldControlState([...base, deny, lift], c.id, c.owner);
    const back = foldTimeline(rows, undefined, channelRules(again, idHex, c.id, new Map(), undefined, Date.now())).reactions.get(msg.rumorId)?.get("🔥");
    expect([...(back?.reactors.keys() ?? [])].sort()).toEqual([allowed, denied].sort());
  });

  it("judges by the Channel: a deny elsewhere doesn't reach it", () => {
    const { c, base, idHex } = setup();
    const member = hexKey();
    const folded = foldControlState([...base, denyReactions(c, hexKey(), member)], c.id, c.owner);
    expect(reactsIn(folded, idHex, member)).toBe(true);
  });

  it("always counts the owner's, and judges nothing on the legacy Roster", () => {
    const { c, base, idHex } = setup();
    const shut = { scope: idHex, target: { kind: "everyone" as const }, allow: 0n, deny: Permissions.ADD_REACTIONS };
    const folded = foldControlState([...base, c.edition({ vsk: "14", eid: overwriteLocator(c.id, shut), author: c.owner, content: overwriteToJSON(shut) })], c.id, c.owner);
    expect(reactsIn(folded, idHex, hexKey())).toBe(false);
    expect(reactsIn(folded, idHex, c.owner)).toBe(true);

    const legacy = new TestCommunity();
    expect(reactionIgnored(foldControlState([], legacy.id, legacy.owner), idHex)).toBeUndefined();
  });
});
