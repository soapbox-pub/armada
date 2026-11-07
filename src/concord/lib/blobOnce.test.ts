/** A blob that won't open costs one decrypt a session, not one a poll (Vector `OpenedHistory`, `OpenedDeliveries`). */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const { adoptHistoryDeliveries, historyLocator, historyViewsReady } = await import("@/concord/lib/history");
const { clearRefusedBlobs } = await import("@/concord/lib/blobOnce");

describe("a junk blob at this member's locator", () => {
  it("is decrypted once, and again only after the memo clears", async () => {
    await historyViewsReady();
    const [community, channel, me, deliverer] = ["aa", "bb", "cc", "dd"].map((x) => x.repeat(32));
    const deliveries = [{ deliverer, epoch: 0n, blobs: [{ locator: historyLocator(deliverer, me, channel, 0n), wrapped: "junk" }] }];
    let decrypts = 0;
    const o = {
      communityIdHex: community,
      channelIdHex: channel,
      me,
      currentEpoch: 1n,
      heldEpochs: new Set<bigint>(),
      trusted: () => true,
      decrypt: async () => {
        decrypts++;
        throw new Error("bad mac");
      },
    };
    await adoptHistoryDeliveries(deliveries, o);
    await adoptHistoryDeliveries(deliveries, o);
    expect(decrypts).toBe(1);
    clearRefusedBlobs();
    await adoptHistoryDeliveries(deliveries, o);
    expect(decrypts).toBe(2);
  });
});
