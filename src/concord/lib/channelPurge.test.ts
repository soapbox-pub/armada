/** A deleted Channel leaves this device (CORD-03 §2, Vector `purge_deleted_channel`). */
import { IDBFactory } from "fake-indexeddb";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { matchFilters } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { drainWrapScrubs, purgeDeletedChannel, queuedWrapScrubs } from "@/concord/lib/channelPurge";
import { openChatBatch } from "@/concord/lib/chat";
import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { queryChannelRumors, writeRumors } from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import { ownWrapOwner } from "@/concord/lib/wrapScrub";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const root = new Uint8Array(32).fill(4);
const CID = "cd".repeat(32);
const community = { idHex: CID, relays: ["wss://r.test"] } as unknown as Community;

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

function makeChannel(byte: number): Channel {
  const id = new Uint8Array(32).fill(byte);
  const stream = { epoch: 0n, group: channelGroupKey(root, id, 0) };
  return { id, idHex: bytesToHex(id), name: "gone", isPrivate: false, voice: { room: voiceGroupKey(root, id, 0), mediaKey: voiceMediaKey(root, id, 0) }, streams: [stream], current: stream };
}

async function post(channel: Channel, who: ReturnType<typeof signer>, text: string, extra: string[][] = [], owner?: Uint8Array) {
  const rumor = buildRumor({ kind: KIND_MESSAGE, content: text, tags: [...channelBindingTags(channel.idHex, 0n), ...extra], pubkey: who.pubkey });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, who);
  return { rumor, wrap: await wrapSeal(seal, channel.current.group, owner ? { ephemeralSk: owner } : undefined) };
}

async function eventually<T>(fn: () => Promise<T>, pred: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

describe("purgeDeletedChannel", () => {
  it("drops the Channel's rows, names the own uploads nothing else uses, and queues the own wraps to leave", async () => {
    const [me, other] = [signer(), signer()];
    const gone = makeChannel(31);
    const kept = makeChannel(32);
    const shared = "https://blossom.test/" + "a".repeat(64) + ".png";
    const solo = "https://blossom.test/" + "b".repeat(64) + ".png";
    const mineSolo = await post(gone, me, "solo", [["imeta", `url ${solo}`]]);
    const mineShared = await post(gone, me, "shared", [["imeta", `url ${shared}`]]);
    const theirs = await post(gone, other, "theirs");
    const elsewhere = await post(kept, me, "still here", [["imeta", `url ${shared}`]]);
    writeRumors(CID, await openChatBatch([mineSolo.wrap, mineShared.wrap, theirs.wrap], gone));
    writeRumors(CID, await openChatBatch([elsewhere.wrap], kept));
    await eventually(() => queryChannelRumors(CID, gone.idHex, { limit: 10 }), (r) => r.length === 3);
    await eventually(() => queryChannelRumors(CID, kept.idHex, { limit: 10 }), (r) => r.length === 1);

    const result = await purgeDeletedChannel(community, gone, me.pubkey, me.sk);
    expect(result.removed).toBe(3);
    expect(result.uploads).toEqual([solo]);
    expect(result.queued).toBe(2);
    expect(await eventually(() => queryChannelRumors(CID, gone.idHex, { limit: 10 }), (r) => r.length === 0)).toEqual([]);
    expect(await queryChannelRumors(CID, kept.idHex, { limit: 10 })).toHaveLength(1);
    expect(queuedWrapScrubs().sort()).toEqual([mineSolo.rumor.id, mineShared.rumor.id].sort());
    // A second run finds nothing.
    expect((await purgeDeletedChannel(community, gone, me.pubkey, me.sk)).removed).toBe(0);
  });

  it("names no linked file as an upload, and keeps a blob whose hash is still in use on another server", async () => {
    const me = signer();
    const gone = makeChannel(41);
    const kept = makeChannel(42);
    const hash = "c".repeat(64);
    const linked = await post(gone, me, `see https://elsewhere.test/${"d".repeat(64)}`);
    const mirrored = await post(gone, me, "mirrored", [["imeta", `url https://one.test/${hash}.png`]]);
    // The same blob on another server: a URL check would ask one.test to delete it.
    const elsewhere = await post(kept, me, `same file https://two.test/${hash}.png`);
    writeRumors(CID, await openChatBatch([linked.wrap, mirrored.wrap], gone));
    writeRumors(CID, await openChatBatch([elsewhere.wrap], kept));
    await eventually(() => queryChannelRumors(CID, gone.idHex, { limit: 10 }), (r) => r.length === 2);
    await eventually(() => queryChannelRumors(CID, kept.idHex, { limit: 10 }), (r) => r.length === 1);

    expect((await purgeDeletedChannel(community, gone, me.pubkey, me.sk)).uploads).toEqual([]);
  });

  it("drains the queue, deleting each own wrap by its derived owner", async () => {
    const me = signer();
    const gone = makeChannel(33);
    const msg = await post(gone, me, "bye");
    const owned = await post(gone, me, "bye", [], ownWrapOwner(me.sk, gone.current.group.pk, msg.rumor.id));
    writeRumors(CID, await openChatBatch([msg.wrap], gone));
    await eventually(() => queryChannelRumors(CID, gone.idHex, { limit: 10 }), (r) => r.length === 1);
    await purgeDeletedChannel(community, gone, me.pubkey, me.sk);
    const relay: NostrEvent[] = [owned.wrap];
    const published: NostrEvent[] = [];
    const done = await drainWrapScrubs({
      query: async (_u: string, filters: NostrFilter[]) => relay.filter((e) => matchFilters(filters, e)),
      publish: async (_u: string, e: NostrEvent) => void published.push(e),
    }, me.sk, 0);
    expect(done).toBeGreaterThanOrEqual(1);
    expect(queuedWrapScrubs()).not.toContain(msg.rumor.id);
    expect(published.some((d) => d.kind === 5 && d.tags.some((t) => t[0] === "e" && t[1] === owned.wrap.id))).toBe(true);
  });

  /** One own wrap of a deleted Channel, queued to leave the relays. */
  async function queuedOwnWrap(byte: number) {
    const me = signer();
    const gone = makeChannel(byte);
    const msg = await post(gone, me, "bye");
    const owned = await post(gone, me, "bye", [], ownWrapOwner(me.sk, gone.current.group.pk, msg.rumor.id));
    writeRumors(CID, await openChatBatch([msg.wrap], gone));
    await eventually(() => queryChannelRumors(CID, gone.idHex, { limit: 10 }), (r) => r.length === 1);
    await purgeDeletedChannel(community, gone, me.pubkey, me.sk);
    return { me, msg, owned };
  }

  it("keeps an entry queued when no relay answered the search for its wraps (Vector `drain_scrubs`: one that can't go out stays queued)", async () => {
    const { me, msg } = await queuedOwnWrap(34);
    await drainWrapScrubs({
      query: async () => Promise.reject(new Error("unreachable")),
      publish: async () => undefined,
    }, me.sk, 0);
    expect(queuedWrapScrubs()).toContain(msg.rumor.id);
  });

  it("keeps an entry queued when its owner's deletion reached no relay (Vector `scrub_own` keeps the owner key until `publish_durable` lands)", async () => {
    const { me, msg, owned } = await queuedOwnWrap(35);
    await drainWrapScrubs({
      query: async (_u: string, filters: NostrFilter[]) => [owned.wrap].filter((e) => matchFilters(filters, e)),
      publish: async () => Promise.reject(new Error("blocked")),
    }, me.sk, 0);
    expect(queuedWrapScrubs()).toContain(msg.rumor.id);
  });

  it("sends one that can't go out to the back, so the next drain reaches the rest (Vector `retry`: queued_at moves to now)", async () => {
    const stuck = await queuedOwnWrap(36);
    const other = await queuedOwnWrap(37);
    const stuckFirst = queuedWrapScrubs().indexOf(stuck.msg.rumor.id) < queuedWrapScrubs().indexOf(other.msg.rumor.id);
    expect(stuckFirst).toBe(true);
    // Only `stuck`'s relay search fails; every other wrap goes out.
    const pool = {
      query: async (_u: string, filters: NostrFilter[]) => {
        if (filters.some((f) => f.authors?.includes(stuck.owned.wrap.pubkey))) throw new Error("unreachable");
        return [other.owned.wrap].filter((e) => matchFilters(filters, e));
      },
      publish: async () => undefined,
    };
    await drainWrapScrubs(pool, stuck.me.sk, 0);
    await drainWrapScrubs(pool, other.me.sk, 0);
    expect(queuedWrapScrubs()).toContain(stuck.msg.rumor.id);
    expect(queuedWrapScrubs()).not.toContain(other.msg.rumor.id);
  });
});
