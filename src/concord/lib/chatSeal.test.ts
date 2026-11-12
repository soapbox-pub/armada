import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools";

vi.mock("@/concord/lib/rumorStore", () => ({ readStoredSeal: async () => undefined }));

import { fetchChatSeal } from "@/concord/lib/chatSeal";
import { bytesToHex, channelGroupKey, random32 } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRumor, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";

const CHANNEL = random32();
const group = channelGroupKey(random32(), CHANNEL, 0);
const author = (() => {
  const sk = generateSecretKey();
  return { pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
})();

async function wrapped(text: string) {
  const rumor = buildRumor({ kind: KIND_MESSAGE, content: text, tags: [["channel", bytesToHex(CHANNEL)], ["epoch", "0"]], pubkey: author.pubkey });
  const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, author), group);
  return { wrap, opened: openWrap(wrap, group) };
}

const community = { idHex: "c".repeat(64), relays: ["wss://a.test", "wss://b.test"] } as unknown as Community;
const channel = { streams: [{ epoch: 0n, group }] } as unknown as Channel;

function relays(served: Record<string, NostrEvent[]>) {
  const asked: NostrFilter[] = [];
  return {
    asked,
    nostr: {
      relay: (url: string) => ({
        query: async (filters: NostrFilter[]) => {
          asked.push(...filters);
          return served[url] ?? [];
        },
      }),
    },
  };
}

describe("fetchChatSeal", () => {
  it("reads the message's wrap again from a relay that has it, at its epoch's address and around its date", async () => {
    const other = await wrapped("not this one");
    const { wrap, opened } = await wrapped("pin me");
    const { nostr, asked } = relays({ "wss://b.test": [other.wrap, wrap] });
    const { seal: _unused, ...stored } = opened;
    const seal = await fetchChatSeal(nostr, community, channel, stored, 0n);
    expect(seal?.id).toBe(opened.seal?.id);
    expect(asked[0].authors).toEqual([group.pk]);
    expect(asked[0].since).toBeLessThanOrEqual(opened.createdAt);
    expect(asked[0].until).toBeGreaterThanOrEqual(opened.createdAt);
  });

  it("finds nothing when no relay holds it", async () => {
    const { opened } = await wrapped("gone");
    const { nostr } = relays({});
    expect(await fetchChatSeal(nostr, community, channel, opened, 0n)).toBeUndefined();
  });
});
