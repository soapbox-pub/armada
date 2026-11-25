/**
 * CORD-03 §2 `history` at concord#27 (Vector v0.5.2 `published_history`): a Public
 * Channel's metadata hands every member its earlier planes by their own secrets.
 */
import { describe, expect, it } from "vitest";

import { MAX_HISTORY, mergedHistory, pastRootPlanes, privatePlanes, publishedHistory, withHistory } from "@/concord/lib/channelHistory";
import { channelsView } from "@/concord/lib/community";
import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, channelGroupKey, random32 } from "@/concord/lib/derive";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { everyoneReadsHistory, Permissions } from "@/concord/lib/roles";
import { heldCommunity, rankedCommunity } from "@/test/concordEditions";

const channelId = new Uint8Array(32).fill(1);

describe("a Channel's published history (CORD-03 §2)", () => {
  it("names nothing by a malformed entry", () => {
    const good = channelGroupKey(new Uint8Array(32).fill(7), channelId, 2);
    const secret = bytesToHex(good.sk);
    const got = publishedHistory({
      name: "c",
      private: false,
      history: [[2, secret], [3, "zz"], ["4", secret], [2 ** 53, secret], [5], [6, "00".repeat(32)], [7, secret.toUpperCase()]],
    });
    expect(got.map((p) => [p.epoch, p.group.pk])).toEqual([[2n, good.pk]]);
  });

  it("merges each address once, oldest dropped past the cap, and says when nothing is new", () => {
    const planes = Array.from({ length: MAX_HISTORY + 2 }, (_, i) => ({ epoch: BigInt(i), group: channelGroupKey(random32(), channelId, i) }));
    const merged = mergedHistory(planes.slice(0, 3), planes.slice(1))!;
    expect(merged).toHaveLength(MAX_HISTORY);
    expect(merged[0][0]).toBe(2);
    expect(mergedHistory(planes.slice(0, 3), planes.slice(0, 2))).toBeUndefined();
    // A full list gains nothing from a plane older than all it keeps, so it isn't published again.
    expect(mergedHistory(planes.slice(2), planes.slice(0, 1))).toBeUndefined();
    const meta = withHistory({ name: "c", private: false, topic: "kept" }, planes.slice(0, 1))!;
    expect(meta.topic).toBe("kept");
    expect(publishedHistory(meta).map((p) => p.group.pk)).toEqual([planes[0].group.pk]);
  });

  it("reads a published plane beside the ones a member holds, and signs as it on a relay that asks", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const id = random32();
    const pastRoot = random32();
    const past = channelGroupKey(pastRoot, id, 0);
    const meta = withHistory({ name: "rules", private: false }, [{ epoch: 0n, group: past }])!;
    const folded = foldControlState([...base, c.edition({ vsk: "2", eid: id, author: c.owner, content: meta })], c.id, c.owner);
    // A joiner after the Refounding holds epoch 1 alone.
    const root = random32();
    const joiner = { ...heldCommunity(c, [], root), rootEpoch: 1n, heldRoots: [{ epoch: 1n, key: root }] };
    const ch = channelsView(joiner, folded).find((v) => v.idHex === bytesToHex(id))!;
    const read = ch.streams.find((s) => s.group.pk === past.pk);
    expect(read?.epoch).toBe(0n);
    expect(read?.group.sk).toEqual(past.sk);
    expect(ch.current.epoch).toBe(1n);
    // One that held it already reads it once.
    const holder = { ...joiner, heldRoots: [{ epoch: 1n, key: root }, { epoch: 0n, key: pastRoot }] };
    expect(channelsView(holder, folded).find((v) => v.idHex === bytesToHex(id))!.streams.filter((s) => s.group.pk === past.pk)).toHaveLength(1);
  });

  it("is owed only while @everyone there reads history", () => {
    const { c, base } = rankedCommunity(0n);
    const id = bytesToHex(random32());
    const deny = { scope: id, target: { kind: "everyone" as const }, allow: 0n, deny: Permissions.READ_MESSAGE_HISTORY };
    const folded = foldControlState([...base, c.edition({ vsk: "14", eid: overwriteLocator(c.id, deny), author: c.owner, content: overwriteToJSON(deny) })], c.id, c.owner);
    expect(everyoneReadsHistory(folded.roster, id)).toBe(false);
    expect(everyoneReadsHistory(folded.roster, bytesToHex(random32()))).toBe(true);
    expect(everyoneReadsHistory(foldControlState([], c.id, c.owner).roster, id)).toBe(true);
  });

  it("offers a Private Channel's own epochs, never a plane keyed by the root, and past roots oldest first", () => {
    const { c } = rankedCommunity(0n);
    const root = random32();
    const key = random32();
    const prior = random32();
    const community = {
      ...heldCommunity(c, [{ id: channelId, key, epoch: 2n, name: "", priors: [{ key: prior, epoch: 1n }, { key: root, epoch: 0n }] }], root),
      rootEpoch: 3n,
      heldRoots: [{ epoch: 3n, key: root }, { epoch: 1n, key: random32() }, { epoch: 2n, key: random32() }],
    };
    expect(privatePlanes(community, bytesToHex(channelId)).map((p) => p.epoch)).toEqual([2n, 1n]);
    expect(pastRootPlanes(community, bytesToHex(channelId)).map((p) => p.epoch)).toEqual([1n, 2n]);
    expect(pastRootPlanes(community, bytesToHex(channelId), 2n).map((p) => p.epoch)).toEqual([2n]);
  });
});
