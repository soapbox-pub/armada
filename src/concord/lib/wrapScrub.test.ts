/** Deleting one's own giftwraps by their derived owner (CORD-01 §Deletions, Vector `message_delete.rs`). */
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { matchFilters } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { channelGroupKey, random32 } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import { canScrub, ownWrapOwner, scrubbedDeleteExpiry, scrubOwnWraps, sendWrapOwner, WRAP_DELETION_EXPIRY_SECS, type ScrubPool } from "@/concord/lib/wrapScrub";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

const CHANNEL = random32();
const group = channelGroupKey(random32(), CHANNEL, 0);

function relay(events: NostrEvent[]): ScrubPool & { published: NostrEvent[] } {
  const published: NostrEvent[] = [];
  return {
    published,
    query: async (_url: string, filters: NostrFilter[]) => events.filter((e) => matchFilters(filters, e)),
    publish: async (_url: string, event: NostrEvent) => void published.push(event),
  };
}

async function message(author: ReturnType<typeof signer>, text: string, owner?: Uint8Array) {
  const rumor = buildRumor({ kind: KIND_MESSAGE, content: text, tags: channelBindingTags("ab".repeat(32), 0n), pubkey: author.pubkey });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, author);
  return { rumor, wrap: await wrapSeal(seal, group, owner ? { ephemeralSk: owner } : undefined) };
}

describe("scrubOwnWraps", () => {
  it("finds the account's wraps by their derived owner and deletes each by it, and by the plane key", async () => {
    const me = signer();
    const mine = await message(me, "mine");
    const { wrap } = await message(me, "mine", ownWrapOwner(me.sk, group.pk, mine.rumor.id));
    // A wrap of the same message sent with a random `p` (a remote signer) can't be claimed.
    const pool = relay([wrap, mine.wrap]);
    const scrubbed = await scrubOwnWraps(pool, ["wss://r.test"], [group], [mine.rumor.id], me.sk, { nowSecs: 1_000 });
    expect(scrubbed).toEqual({ byOwner: true, byPlane: true, settled: true });
    const owner = getPublicKey(ownWrapOwner(me.sk, group.pk, mine.rumor.id)!);
    expect(pool.published.map((d) => d.pubkey).sort()).toEqual([owner, group.pk].sort());
    for (const d of pool.published) {
      expect(d.kind).toBe(5);
      expect(d.tags).toContainEqual(["e", wrap.id]);
      expect(d.tags).not.toContainEqual(["e", mine.wrap.id]);
      expect(d.tags).toContainEqual(["k", "1059"]);
      expect(d.tags).toContainEqual(["expiration", String(1_000 + WRAP_DELETION_EXPIRY_SECS)]);
    }
  });

  it("deletes nothing when no wrap carries a derived owner", async () => {
    const me = signer();
    const { rumor, wrap } = await message(me, "random owner");
    const pool = relay([wrap]);
    expect(await scrubOwnWraps(pool, ["wss://r.test"], [group], [rumor.id], me.sk)).toEqual({ byOwner: false, byPlane: false, settled: true });
    expect(pool.published).toEqual([]);
  });
});

describe("scrubbedDeleteExpiry", () => {
  it("lets the in-plane delete expire only once its wraps left every way, 30 days on or with the message", () => {
    const now = 1_000_000;
    expect(scrubbedDeleteExpiry({ byOwner: true, byPlane: false }, undefined, now)).toBeNull();
    expect(scrubbedDeleteExpiry({ byOwner: true, byPlane: true }, undefined, now)).toBe(now + 30 * 86_400);
    expect(scrubbedDeleteExpiry({ byOwner: true, byPlane: true }, now + 60, now)).toBe(now + 60);
  });
});

describe("a remote-signer account's kept owners", () => {
  it("keeps the random owner a send used, deletes by it, and drops it once deleted", async () => {
    const me = signer();
    const { rumor } = await message(me, "from a bunker");
    const owner = await sendWrapOwner(undefined, group.pk, rumor.id);
    expect(await sendWrapOwner(undefined, group.pk, rumor.id)).toEqual(owner);
    expect(await canScrub(undefined, rumor.id)).toBe(true);
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, me);
    const wrap = await wrapSeal(seal, group, { ephemeralSk: owner });
    const pool = relay([wrap]);
    expect(await scrubOwnWraps(pool, ["wss://r.test"], [group], [rumor.id], undefined)).toEqual({ byOwner: true, byPlane: true, settled: true });
    expect(pool.published.some((d) => d.pubkey === getPublicKey(owner))).toBe(true);
    expect(await canScrub(undefined, rumor.id)).toBe(false);
  });

  it("drops a kept owner when a relay answered and holds none of its wraps", async () => {
    const me = signer();
    const { rumor } = await message(me, "already gone");
    await sendWrapOwner(undefined, group.pk, rumor.id);
    expect(await scrubOwnWraps(relay([]), ["wss://r.test"], [group], [rumor.id], undefined)).toEqual({ byOwner: false, byPlane: false, settled: true });
    expect(await canScrub(undefined, rumor.id)).toBe(false);
  });
});
