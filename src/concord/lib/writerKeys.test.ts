/** What a member holds as a writer, and drops on leaving (CORD-03 §1). */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const { forgetWriterKeys, mintedSecrets, postableSince, writerKeysReady } = await import("@/concord/lib/writerKeys");
const { bytesToHex } = await import("@/concord/lib/derive");

describe("leaving a Community", () => {
  it("drops every writer and certifier secret held there, and nothing held elsewhere", async () => {
    await writerKeysReady();
    const [left, kept, ch] = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
    const before = bytesToHex(mintedSecrets(left, ch, 1).secret);
    const other = bytesToHex(mintedSecrets(kept, ch, 1).secret);
    expect(bytesToHex(mintedSecrets(left, ch, 1).secret)).toBe(before);
    postableSince(left, ch, true, 1000);
    await forgetWriterKeys(left);
    expect(bytesToHex(mintedSecrets(left, ch, 1).secret)).not.toBe(before);
    expect(bytesToHex(mintedSecrets(kept, ch, 1).secret)).toBe(other);
    expect(postableSince(left, ch, true, 2000)).toBe(2000);
  });
});

describe("who may send in an open Channel (CORD-04 §8, Vector `send_chat_message_at`)", () => {
  it("needs Send Messages in the Channel on the vsk-13 Roster, owner aside", async () => {
    const { canPostIn } = await import("@/concord/lib/writerKeys");
    const { foldControlState } = await import("@/concord/lib/control");
    const { overwriteLocator, overwriteToJSON } = await import("@/concord/lib/roster");
    const { Permissions } = await import("@/concord/lib/roles");
    const { hexKey, rankedCommunity } = await import("@/test/concordEditions");
    const { c, base } = rankedCommunity(0n);
    const ch = hexKey();
    const member = hexKey();
    const o = { scope: ch, target: { kind: "member" as const, id: member }, allow: 0n, deny: Permissions.SEND_MESSAGES };
    const deny = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "general", private: false } });
    const folded = foldControlState([...base, channel, deny], c.id, c.owner);
    expect(canPostIn(folded, c.id, ch, member)).toBe(false);
    expect(canPostIn(folded, c.id, ch, hexKey())).toBe(true);
    expect(canPostIn(folded, c.id, ch, c.owner)).toBe(true);
  });
});
