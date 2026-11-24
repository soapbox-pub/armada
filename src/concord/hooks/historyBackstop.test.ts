/**
 * The history backstop (CORD-03 §2, Vector `history_backstop`): after a Refounding a
 * manager publishes each past root plane the Channel wrote under, once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({ editions: [] as NostrRumor[], carrying: new Set<string>(), stored: undefined as unknown }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  foldStoredControl: async () => h.stored,
  citationFor: () => undefined,
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => void h.editions.push(rumor),
}));
vi.mock("@/concord/lib/planeSync", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/planeSync")>()),
  whenAuthSettled: async () => {},
}));

const { historyBackstop, resetHistoryBackstop } = await import("@/concord/hooks/historyBackstop");
const { publishedHistory } = await import("@/concord/lib/channelHistory");
const { foldControlState } = await import("@/concord/lib/control");
const { bytesToHex, channelGroupKey, random32 } = await import("@/concord/lib/derive");
const { heldCommunity, rankedCommunity } = await import("@/test/concordEditions");

const nostr = {
  relay: () => ({
    query: async (filters: { authors: string[] }[]) => (filters[0].authors.some((a) => h.carrying.has(a)) ? [{ id: "x" }] : []),
  }),
} as never;

afterEach(() => {
  h.editions = [];
  h.carrying.clear();
  resetHistoryBackstop();
  vi.restoreAllMocks();
});

function setup() {
  const { c, base } = rankedCommunity(0n);
  const id = random32();
  const folded = foldControlState([...base, c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "rules", private: false } })], c.id, c.owner);
  h.stored = folded;
  const [past, quiet, root] = [random32(), random32(), random32()];
  const community = { ...heldCommunity(c, [], root), rootEpoch: 2n, heldRoots: [{ epoch: 2n, key: root }, { epoch: 1n, key: past }, { epoch: 0n, key: quiet }] };
  return { c, id, folded, community, pastPlane: channelGroupKey(past, id, 1) };
}

describe("the history backstop", () => {
  it("publishes a past root plane that holds something, and not one that holds nothing", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { c, folded, community, pastPlane } = setup();
    h.carrying.add(pastPlane.pk);
    const published = await historyBackstop(nostr, () => ({ community, folded }), { pubkey: c.owner, signer: {} as never }, new AbortController().signal);
    expect(published).toBe(1);
    const meta = JSON.parse(h.editions[0].content);
    expect(publishedHistory(meta).map((p) => [p.epoch, p.group.pk])).toEqual([[1n, pastPlane.pk]]);
  });

  it("is a manager's alone, and looks at a Channel again only after the period or a rotation", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { c, folded, community, pastPlane } = setup();
    h.carrying.add(pastPlane.pk);
    const signal = new AbortController().signal;
    expect(await historyBackstop(nostr, () => ({ community, folded }), { pubkey: bytesToHex(random32()), signer: {} as never }, signal)).toBe(0);
    expect(await historyBackstop(nostr, () => ({ community, folded }), { pubkey: c.owner, signer: {} as never }, signal)).toBe(1);
    expect(await historyBackstop(nostr, () => ({ community, folded }), { pubkey: c.owner, signer: {} as never }, signal)).toBe(0);
  });
});
