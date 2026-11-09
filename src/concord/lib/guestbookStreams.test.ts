/**
 * Which Guestbook address each stored rumor arrived at. Vector stores the epoch in the
 * same row as the event (`community_guestbook_events.body`), so it is written with it,
 * atomically; here each (rumor, address) is a KV key of its own, written once.
 */
import { IDBFactory } from "fake-indexeddb";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const { mintCommunity } = await import("@/concord/lib/community");
const { buildJoinRumor, currentGuestbookGroup, sealGuestbook } = await import("@/concord/lib/guestbook");
const { guestbookGroupKey, random32 } = await import("@/concord/lib/derive");
const { openPlaneWraps } = await import("@/concord/lib/planeSync");
const { clearRumorStoreMemory, readGuestbookAddresses, withGuestbookStreams, writeOpened } = await import("@/concord/lib/rumorStore");
const { getArmadaDB } = await import("@/lib/db/armadaDB");

async function joinAt(group: ReturnType<typeof currentGuestbookGroup>, sk = generateSecretKey()) {
  const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
  const wrap = await sealGuestbook(buildJoinRumor(getPublicKey(sk), Date.now()), group, signer);
  return openPlaneWraps([wrap], [group]);
}

describe("the Guestbook address each rumor arrived at", () => {
  it("records every rumor of two batches stored at once, in this session and the next", async () => {
    const { community } = mintCommunity("Fleet", getPublicKey(generateSecretKey()), ["wss://r.test"]);
    const group = currentGuestbookGroup(community);
    await readGuestbookAddresses(community.idHex);
    const [a, b] = await Promise.all([joinAt(group), joinAt(group)]);
    await Promise.all([writeOpened(community.idHex, a, "guestbook"), writeOpened(community.idHex, b, "guestbook")]);
    const ids = [a[0].rumorId, b[0].rumorId].sort();
    expect([...(await readGuestbookAddresses(community.idHex)).keys()].sort()).toEqual(ids);
    clearRumorStoreMemory();
    const reread = await readGuestbookAddresses(community.idHex);
    expect([...reread.keys()].sort()).toEqual(ids);
    expect([...reread.get(ids[0])!]).toEqual([group.pk]);
  });

  it("names the live epoch's address for a rumor that arrived at an older one too", async () => {
    const { community } = mintCommunity("Fleet", getPublicKey(generateSecretKey()), ["wss://r.test"]);
    const old = currentGuestbookGroup(community);
    const sk = generateSecretKey();
    const [atOld] = await joinAt(old, sk);
    await writeOpened(community.idHex, [atOld], "guestbook");
    // Refounded at epoch 1: the same rumor re-wrapped at the new address.
    const root = random32();
    const refounded = { ...community, root, rootEpoch: 1n, heldRoots: [...community.heldRoots, { epoch: 1n, key: root }] };
    const live = guestbookGroupKey(root, community.id, 1n);
    await writeOpened(community.idHex, [{ ...atOld, streamPk: live.pk }], "guestbook");
    const [{ streamPk, ...stored }] = [atOld];
    void streamPk;
    expect((await withGuestbookStreams(refounded, [stored]))[0].streamPk).toBe(live.pk);
    expect((await withGuestbookStreams(community, [stored]))[0].streamPk).toBe(old.pk);
  });

  it("writes nothing for a rumor re-offered at an address already recorded, this session or the next", async () => {
    const { community } = mintCommunity("Fleet", getPublicKey(generateSecretKey()), ["wss://r.test"]);
    const opened = await joinAt(currentGuestbookGroup(community));
    await writeOpened(community.idHex, opened, "guestbook");
    const kv = getArmadaDB().kv;
    const set = vi.spyOn(kv, "set");
    try {
      await writeOpened(community.idHex, opened, "guestbook");
      clearRumorStoreMemory();
      await writeOpened(community.idHex, opened, "guestbook");
      expect(set.mock.calls.filter(([key]) => String(key).startsWith("c2gbaddr:"))).toEqual([]);
    } finally {
      set.mockRestore();
    }
  });

  it("doesn't let a load a session clear superseded swallow a write made after it", async () => {
    const { community } = mintCommunity("Fleet", getPublicKey(generateSecretKey()), ["wss://r.test"]);
    const before = readGuestbookAddresses(community.idHex);
    clearRumorStoreMemory();
    await before;
    const after = readGuestbookAddresses(community.idHex);
    const [fresh] = await joinAt(currentGuestbookGroup(community));
    await writeOpened(community.idHex, [fresh], "guestbook");
    expect([...(await after).keys()]).toEqual([fresh.rumorId]);
  });
});
