/**
 * Clearing a deleted Channel (CORD-03 §2) is remembered per account: the next account
 * signed in on this device holds its own copy, and its own uploads, to clear.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ purged: [] as string[] }));
vi.mock("@/concord/lib/channelPurge", () => ({
  purgeDeletedChannel: async (_c: unknown, _ch: unknown, pubkey: string) => {
    h.purged.push(pubkey);
    return { uploads: [], queued: 0 };
  },
  queuedWrapScrubs: () => [],
  drainWrapScrubs: async () => undefined,
}));
vi.mock("@/concord/lib/community", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/community")>()),
  deletedChannels: () => [{ idHex: "22".repeat(32) }],
}));

const { purgeDeletedChannels } = await import("@/wire/WireSync");

describe("purging deleted Channels", () => {
  it("purges for the next account on this device too", async () => {
    const community = { idHex: "11".repeat(32) } as never;
    const ctx = (pubkey: string) => ({ user: { pubkey, signer: {} } as never, secret: undefined, nostr: {} as never });
    await purgeDeletedChannels(community, undefined, ctx("aa".repeat(32)));
    await purgeDeletedChannels(community, undefined, ctx("aa".repeat(32)));
    await purgeDeletedChannels(community, undefined, ctx("bb".repeat(32)));
    expect(h.purged).toEqual(["aa".repeat(32), "bb".repeat(32)]);
  });
});
