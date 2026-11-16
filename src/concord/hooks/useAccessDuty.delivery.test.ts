import { beforeEach, describe, expect, it, vi } from "vitest";

import { hexKey, heldCommunity, TestCommunity } from "@/test/concordEditions";
import { random32 } from "@/concord/lib/derive";
import type { PrivateChannelKey } from "@/concord/lib/types";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Each publish, by what it carried; history ones wait on `historyGate`. */
const published: Array<{ what: "access" | "history"; epoch: string }> = [];
let historyGate: Promise<void> = Promise.resolve();
vi.mock("@/concord/lib/quorum", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/quorum")>()),
  publishDurable: async (_n: unknown, _r: unknown, wrap: NostrRumor) => {
    const what = wrap.tags.some((t) => t[0] === "delivery" && t[1] === "access") ? "access" : "history";
    if (what === "history") await historyGate;
    published.push({ what, epoch: wrap.tags.find((t) => t[0] === "newepoch" || t[0] === "epoch")?.[1] ?? "?" });
  },
}));
vi.mock("@/concord/lib/stream", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/stream")>()),
  sealRumor: async (r: NostrRumor) => r,
  wrapSeal: async (r: NostrRumor) => r,
}));
vi.mock("@/concord/lib/history", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/history")>()),
  historyViewsReady: async () => {},
  heldHistoryViews: () => [],
}));

import { clearAccessDutyMemory, deliverKeysOnPlane, historyDeliveriesSettled } from "./useAccessDuty";

function setup(pastEpochs: number) {
  const c = new TestCommunity();
  const ch: PrivateChannelKey = {
    id: random32(),
    key: random32(),
    epoch: BigInt(pastEpochs + 1),
    name: "p",
    priors: Array.from({ length: pastEpochs }, (_, i) => ({ key: random32(), epoch: BigInt(i + 1) })),
  };
  const community = heldCommunity(c, [ch]);
  const user = { pubkey: c.owner, signer: { nip44: { encrypt: async () => "sealed", decrypt: async () => "" } } } as never;
  return { community, ch, user };
}

describe("deliverKeysOnPlane", () => {
  beforeEach(() => {
    clearAccessDutyMemory();
    published.length = 0;
    historyGate = Promise.resolve();
  });

  it("hands over the key without waiting on the history behind it", async () => {
    const { community, ch, user } = setup(40);
    let open!: () => void;
    historyGate = new Promise((r) => (open = r));
    const past = await deliverKeysOnPlane({} as never, community, ch, [hexKey()], user);
    // Returned with the key out and every past epoch still held back.
    expect(past).toBe(40);
    expect(published).toEqual([{ what: "access", epoch: "41" }]);
    open();
    await historyDeliveriesSettled();
    expect(published.filter((p) => p.what === "history")).toHaveLength(40);
  });

  it("sends a member only the past epochs this session hasn't already sent them", async () => {
    const { community, ch, user } = setup(5);
    const member = hexKey();
    await deliverKeysOnPlane({} as never, community, ch, [member], user);
    await historyDeliveriesSettled();
    published.length = 0;

    // Re-added one rotation on: the key, plus the one epoch they never had.
    const next = { ...ch, key: random32(), epoch: ch.epoch + 1n, priors: [{ key: ch.key, epoch: ch.epoch }, ...ch.priors!] };
    expect(await deliverKeysOnPlane({} as never, community, next, [member], user)).toBe(1);
    await historyDeliveriesSettled();
    expect(published.map((p) => p.what)).toEqual(["access", "history"]);
  });
});
