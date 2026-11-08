// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { readLivePause } from "@/concord/hooks/useControlPlane";
import { currentControlGroup } from "@/concord/lib/control";
import { getArmadaDB } from "@/lib/db/armadaDB";

import type { Community } from "@/concord/lib/types";

afterEach(() => vi.restoreAllMocks());

describe("foldFloors", () => {
  it("drops the old epoch's floor map once the community moves to a new epoch", async () => {
    const idHex = "5a".repeat(32);
    // The map is module-private: find it by watching for its `<idHex>@<epoch>` keys.
    const floorMaps = new Set<Map<unknown, unknown>>();
    const realSet = Map.prototype.set;
    vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === "string" && k.startsWith(`${idHex}@`) && v instanceof Map) floorMaps.add(this);
      return realSet.call(this, k, v);
    });

    const base = {
      id: new Uint8Array(32).fill(0x5a), idHex, owner: "b".repeat(64), ownerSalt: new Uint8Array(32),
      root: new Uint8Array(32).fill(1), heldRoots: [], privateChannels: [], relays: [], name: "",
    };
    await readLivePause({ ...base, rootEpoch: 0n } as Community, 0);

    // Epoch 1 is Refounded, so readLivePause needs its compaction snapshot.
    const next = { ...base, root: new Uint8Array(32).fill(2), rootEpoch: 1n } as Community;
    await getArmadaDB().kv.set(`c2snap:${idHex}:${currentControlGroup(next).pk}:x`, 1);
    await readLivePause(next, 0);

    expect(floorMaps.size).toBe(1);
    const foldFloors = [...floorMaps][0];
    expect(foldFloors.has(`${idHex}@1`)).toBe(true);
    expect(foldFloors.has(`${idHex}@0`)).toBe(false);
  });
});
