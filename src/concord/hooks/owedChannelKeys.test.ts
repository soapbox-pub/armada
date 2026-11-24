/**
 * Which Private Channel keys a member waits for on the access plane (Vector v0.5.2
 * `owed_channel_keys`): one the Roster lets them read, with its history. Without history
 * the key comes in a fresh epoch's rotation; on the legacy Roster nothing is owed so.
 */
import { describe, expect, it } from "vitest";

import { owedChannelKeys } from "@/concord/hooks/useChannelAccess";
import { foldControlState, type FoldedControl } from "@/concord/lib/control";
import { Permissions } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { hexKey, rankedCommunity, TestCommunity } from "@/test/concordEditions";

function withPrivate(folded: FoldedControl, ch: string): FoldedControl {
  const channels = new Map(folded.channels);
  channels.set(ch, { channelIdHex: ch, name: "", isPrivate: true, deleted: false, metadata: { name: "", private: true } });
  return { ...folded, channels };
}

describe("a Private Channel key owed on the access plane", () => {
  it("is owed only where the member may read the Channel's history, and never on the legacy Roster", () => {
    const { c, base } = rankedCommunity(0n);
    const [ch, member] = [hexKey(), hexKey()];
    const rule = (allow: bigint) => {
      const o = { scope: ch, target: { kind: "member" as const, id: member }, allow, deny: 0n };
      return c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    };
    const withHistory = withPrivate(foldControlState([...base, rule(Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY)], c.id, c.owner), ch);
    expect(owedChannelKeys(withHistory, new Set(), member)).toEqual([ch]);
    expect(owedChannelKeys(withHistory, new Set([ch]), member)).toEqual([]);
    expect(owedChannelKeys(withHistory, new Set(), hexKey())).toEqual([]);

    const hist = Permissions.READ_MESSAGE_HISTORY;
    const viewOnly = { scope: ch, target: { kind: "member" as const, id: member }, allow: Permissions.VIEW_CHANNEL, deny: hist };
    const noHistory = withPrivate(foldControlState([...base, c.edition({ vsk: "14", eid: overwriteLocator(c.id, viewOnly), author: c.owner, content: overwriteToJSON(viewOnly) })], c.id, c.owner), ch);
    expect(owedChannelKeys(noHistory, new Set(), member)).toEqual([]);

    const legacy = new TestCommunity();
    expect(owedChannelKeys(withPrivate(foldControlState([], legacy.id, legacy.owner), ch), new Set(), member)).toEqual([]);
  });
});
