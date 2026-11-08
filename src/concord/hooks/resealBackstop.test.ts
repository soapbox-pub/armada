/**
 * The reseal backstop (CORD-03 §2, Vector `reseal_backstop`) is a Control write like
 * any other: one at a time per community, and chained from the head this device
 * stores, which its own publishes reach before the rendered fold does (Vector `follow_lock`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FoldedControl } from "@/concord/lib/control";
import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({ stored: undefined as unknown, editions: [] as NostrRumor[], order: [] as string[] }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  foldStoredControl: async () => h.stored,
  citationFor: () => undefined,
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => {
    h.editions.push(rumor);
    h.order.push("reseal");
  },
}));

const { resealBackstop } = await import("@/concord/hooks/useAccessDuty");
const { withControlWrite } = await import("@/concord/hooks/useControlPlane");
const { mintCommunity } = await import("@/concord/lib/community");
const { bytesToHex, hex32 } = await import("@/concord/lib/derive");
const { parsedOf } = await import("@/concord/lib/rankedWrites");

afterEach(() => vi.restoreAllMocks());

const OWNER = "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47";

describe("the reseal backstop", () => {
  it("waits for a Control write in flight, then reseals from the stored head", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const key = { id: hex32("33".repeat(32)), key: hex32("44".repeat(32)), epoch: 1n, name: "secret" };
    const idHex = bytesToHex(key.id);
    const { community: minted } = mintCommunity("Fleet", OWNER, ["wss://relay.test"]);
    const community = { ...minted, privateChannels: [key] };
    // Still plain at its head: the backstop owes it a seal.
    const foldAt = (version: bigint, hash: string) => ({
      rankedRoster: true,
      ownerHex: OWNER,
      roster: { roles: [], grants: [], everyone: 0n },
      channels: new Map([[idHex, { channelIdHex: idHex, name: "secret", isPrivate: true, deleted: false, metadata: { name: "secret", private: true } }]]),
      heads: new Map([[idHex, { version, hash: hex32(hash) }]]),
      headEditions: new Map(),
      incomplete: [],
    }) as unknown as FoldedControl;
    // The rendered fold lags this device's own write, which the store already holds.
    const rendered = foldAt(1n, "55".repeat(32));
    h.stored = foldAt(2n, "66".repeat(32));
    const held = withControlWrite(community.idHex, async () => {
      await new Promise((r) => setTimeout(r, 200));
      h.order.push("other write");
    });
    const user = { pubkey: OWNER, signer: { signEvent: async () => { throw new Error("unused"); } } };
    await resealBackstop({} as never, () => ({ community, folded: rendered }), user as never, new AbortController().signal);
    await held;
    expect(h.order).toEqual(["other write", "reseal"]);
    const edition = parsedOf(h.editions[0] as never);
    expect(edition.version).toBe(3n);
    expect(bytesToHex(edition.prevHash!)).toBe("66".repeat(32));
  });
});
