// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const folds = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/concord/lib/control", async (orig) => {
  const real = await orig<typeof import("@/concord/lib/control")>();
  return {
    ...real,
    foldControlState: (...args: Parameters<typeof real.foldControlState>) => (folds.count++, real.foldControlState(...args)),
  };
});
const plane = vi.hoisted(() => ({ rows: [] as Array<{ rumorId: string }> }));
vi.mock("@/concord/lib/rumorStore", async (orig) => {
  const real = await orig<typeof import("@/concord/lib/rumorStore")>();
  return { ...real, queryPlane: async () => plane.rows };
});

import { readLivePause } from "@/concord/hooks/useControlPlane";
import { emitWireScopes } from "@/wire/bus";

import type { Community } from "@/concord/lib/types";

const ring = async (idHex: string) => {
  emitWireScopes([`c2ctl:${idHex}`]);
  await new Promise((resolve) => setTimeout(resolve, 100));
};

describe("readLivePause", () => {
  it("re-folds after a Control ring only when what it folds changed", async () => {
    const idHex = "6b".repeat(32);
    const community = {
      id: new Uint8Array(32).fill(0x6b), idHex, owner: "c".repeat(64), ownerSalt: new Uint8Array(32),
      root: new Uint8Array(32).fill(1), rootEpoch: 0n, heldRoots: [], privateChannels: [], relays: [], name: "",
    } as unknown as Community;
    await readLivePause(community, 0);
    expect(folds.count).toBe(1);
    // A ring that stored nothing new (a sweep's duplicate) folds nothing.
    await ring(idHex);
    await readLivePause(community, 0);
    expect(folds.count).toBe(1);
    // A ring that stored an edition does.
    plane.rows = [{ rumorId: "e".repeat(64) }];
    await ring(idHex);
    await readLivePause(community, 0);
    expect(folds.count).toBe(2);
  });
});
