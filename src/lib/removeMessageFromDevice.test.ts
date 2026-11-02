// @vitest-environment jsdom
import { NSecSigner } from "@nostrify/nostrify";
import { QueryClient } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

const evicted = vi.hoisted(() => ({ urls: [] as string[], hashes: [] as string[] }));
vi.mock("@/lib/encryptedMedia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/encryptedMedia")>()),
  evictAttachment: (url: string) => evicted.urls.push(url),
}));
vi.mock("@/lib/mediaCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mediaCache")>()),
  forgetBlob: (hash: string) => evicted.hashes.push(hash),
}));

import { persistTimelineSnapshot } from "@/concord/hooks/timelineSnapshot";
import { openChatBatch } from "@/concord/lib/chat";
import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { queryChannelRumors, readStoredSeal, writeRumors } from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import { setActivePubkey } from "@/lib/activeAccount";
import { AppSigner } from "@/lib/AppSigner";
import { getArmadaDB, purgeArmadaDB } from "@/lib/db/armadaDB";
import { clearFoldedMemory, listFoldedKeys, readFolded } from "@/lib/foldedCache";
import { buildDmRumor, dmChatTags, KIND_DM_CHAT, openDmWrap, sealDmRumor, wrapDmSeal } from "@/lib/nip17/protocol";
import { persistDm17ThreadSnapshot } from "@/lib/nip17/threadSnapshot";
import { evictRemovedMessageMedia } from "@/lib/evictMessageMedia";
import { otherUsersOfMedia, removeMessageFromDevice } from "@/lib/removeMessageFromDevice";
import { getRemovedMessageIds } from "@/lib/removedMessages";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel } from "@/concord/lib/types";
import type { OpenedDm } from "@/lib/nip17/protocol";
import type { NostrRumor } from "@/lib/nostrRumor";

const viewerSk = generateSecretKey();
const viewer = getPublicKey(viewerSk);
const rumor = (id: string, extra: Partial<NostrRumor> = {}): NostrRumor => ({
  id, pubkey: "a".repeat(64), created_at: 1, kind: 9, tags: [], content: id, ...extra,
});

beforeEach(async () => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await purgeArmadaDB();
  clearFoldedMemory();
  localStorage.clear();
  setActivePubkey(viewer);
  evicted.urls.length = 0;
  evicted.hashes.length = 0;
});

describe("removeMessageFromDevice", () => {
  it("deletes every stored copy, and no tenant stores it again", async () => {
    const target = rumor("e".repeat(64));
    const kept = rumor("f".repeat(64));
    const dm = getArmadaDB().tenant(`dm17:${viewer}`);
    const main = getArmadaDB().tenant("main");
    await dm.event(target);
    await dm.event(kept);
    await main.event(target);

    await removeMessageFromDevice(viewer, target);

    expect(getRemovedMessageIds(viewer).has(target.id)).toBe(true);
    expect((await dm.query([{ ids: [target.id, kept.id] }])).map((r) => r.id)).toEqual([kept.id]);
    expect(await main.query([{ ids: [target.id] }])).toEqual([]);
    await dm.event(target);
    await getArmadaDB().tenant("c2:never-opened").event(target);
    expect(await dm.query([{ ids: [target.id] }])).toEqual([]);
    expect(await getArmadaDB().tenant("c2:never-opened").query([{}])).toEqual([]);
  });

  it("forgets the author's edits of it too, and refuses them if re-delivered", async () => {
    const target = rumor("e".repeat(64));
    const edit = rumor("d".repeat(64), { kind: 3302, content: "edited abuse", tags: [["e", target.id]] });
    const foreign = rumor("c".repeat(64), { kind: 3302, pubkey: "b".repeat(64), tags: [["e", target.id]] });
    const store = getArmadaDB().tenant("c2:a");
    await store.event(target);
    await store.event(edit);
    await store.event(foreign);

    await removeMessageFromDevice(viewer, target);

    expect((await store.query([{ kinds: [3302] }])).map((r) => r.id)).toEqual([foreign.id]);
    await store.event(edit);
    expect(await store.query([{ ids: [edit.id] }])).toEqual([]);
  });

  it("takes it out of the persisted channel and DM thread snapshots", async () => {
    const row = (rumorId: string) => ({ rumorId, ms: 1000, createdAt: 1, channelIdHex: "c", tags: [], content: rumorId });
    await persistTimelineSnapshot(viewer, "c", [row("gone"), row("kept")] as unknown as OpenedChat[]);
    await persistDm17ThreadSnapshot(viewer, "conv", [row("gone"), row("kept")] as unknown as OpenedDm[]);

    await removeMessageFromDevice(viewer, rumor("gone"));

    for (const prefix of ["c2-timeline-snap:", "dm17-thread-snap:"]) {
      const [key] = await listFoldedKeys(prefix);
      expect((await readFolded<{ rumorId: string }[]>(key))?.map((m) => m.rumorId)).toEqual(["kept"]);
    }
  });

  it("forgets the signer's cached rumor and seal plaintext, and a re-delivered wrap caches nothing", async () => {
    const senderSk = generateSecretKey();
    const sender = getPublicKey(senderSk);
    const signer = new AppSigner(new NSecSigner(viewerSk), viewer);
    const send = async (content: string) => {
      const dm = buildDmRumor({ kind: KIND_DM_CHAT, content, tags: dmChatTags([viewer]), pubkey: sender });
      return { dm, wrap: await wrapDmSeal(await sealDmRumor(dm, viewer, new NSecSigner(senderSk)), viewer) };
    };
    const target = await send("abuse");
    const other = await send("hello");
    await openDmWrap(target.wrap, signer, viewer);
    await openDmWrap(other.wrap, signer, viewer);
    const cached = async () => (await getArmadaDB().kv.list<string>({ prefix: "decrypt:" })).map((e) => e.value);
    expect((await cached()).some((v) => v.includes("abuse"))).toBe(true);

    await removeMessageFromDevice(viewer, { ...target.dm, kind: KIND_DM_CHAT });

    const left = await cached();
    expect(left).toHaveLength(2); // `other`'s seal and rumor
    expect(left.some((v) => v.includes("abuse"))).toBe(false);
    expect(await openDmWrap(target.wrap, signer, viewer)).toBeUndefined();
    expect(await cached()).toHaveLength(2);
  });

  it("deletes the stored Concord seal the message could be opened from again", async () => {
    const community = "ab".repeat(32);
    const root = new Uint8Array(32).fill(3);
    const channelId = new Uint8Array(32).fill(7);
    const idHex = bytesToHex(channelId);
    const stream = { epoch: 0n, group: channelGroupKey(root, channelId, 0) };
    const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
    const channel: Channel = { id: channelId, idHex, name: "general", isPrivate: false, voice, streams: [stream], current: stream };
    const authorSk = generateSecretKey();
    const author = { pubkey: getPublicKey(authorSk), signEvent: (t: Parameters<NSecSigner["signEvent"]>[0]) => new NSecSigner(authorSk).signEvent(t) };
    const message = buildRumor({ kind: KIND_MESSAGE, content: "abuse", tags: channelBindingTags(idHex, 0n), pubkey: author.pubkey, ms: 1000 });
    const wrap = await wrapSeal(await sealRumor(message, KIND_SEAL_ENCRYPTED, stream.group, author), stream.group);
    await writeRumors(community, await openChatBatch([wrap], channel));
    const until = Date.now() + 2000;
    while (!(await readStoredSeal(community, message.id)) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(await readStoredSeal(community, message.id)).toBeDefined();
    expect(await queryChannelRumors(community, idHex, { limit: 10 })).toHaveLength(1);

    await removeMessageFromDevice(viewer, message);

    expect(await queryChannelRumors(community, idHex, { limit: 10 })).toHaveLength(0);
    expect(await readStoredSeal(community, message.id)).toBeUndefined();

    // Re-delivered after a restart (no session memo of seals written): the store
    // refuses the rumor, and its seal isn't kept either.
    vi.resetModules();
    (await import("@/lib/activeAccount")).setActivePubkey(viewer);
    const store = await import("@/concord/lib/rumorStore");
    const chat = await import("@/concord/lib/chat");
    store.writeRumors(community, await chat.openChatBatch([wrap], channel));
    await new Promise((r) => setTimeout(r, 200));
    expect(await store.readStoredSeal(community, message.id)).toBeUndefined();
  });

  it("drops it from cached queries: timeline rows, pages, and a lookup of the message itself", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["timeline"], [{ rumorId: "gone" }, { rumorId: "kept" }]);
    queryClient.setQueryData(["pages"], { pages: [[{ id: "gone" }, { id: "kept" }]], pageParams: [0] });
    queryClient.setQueryData(["event", "gone"], { id: "gone", content: "abuse" });

    await removeMessageFromDevice(viewer, rumor("gone"), { queryClient });

    expect(queryClient.getQueryData(["timeline"])).toEqual([{ rumorId: "kept" }]);
    expect(queryClient.getQueryData(["pages"])).toEqual({ pages: [[{ id: "kept" }]], pageParams: [0] });
    expect(queryClient.getQueryData(["event", "gone"])).toBeNull();
  });

  it("keeps media another stored message still names, and evicts the rest", async () => {
    const shared = `https://blossom.example/${"1".repeat(64)}.jpg`;
    const own = `https://blossom.example/${"2".repeat(64)}.jpg`;
    const target = rumor("gone", { tags: [["imeta", `url ${shared}`], ["imeta", `url ${own}`]] });
    const forward = rumor("forward", { tags: [["imeta", `url ${shared}`]] });
    await getArmadaDB().tenant("c2:a").event(target);
    await getArmadaDB().tenant("c2:b").event(forward);

    await removeMessageFromDevice(viewer, target);

    expect(evicted.urls).toEqual([own]);
    expect(evicted.hashes).toEqual(["2".repeat(64)]);
  });

  it("keeps a non-Blossom image another message links in its body", async () => {
    const shared = "https://images.example/cat.jpg";
    const target = rumor("gone", { content: `look ${shared}` });
    const other = rumor("other", { content: `same cat ${shared}` });
    await getArmadaDB().tenant("c2:a").event(target);
    await getArmadaDB().tenant("c2:b").event(other);

    await removeMessageFromDevice(viewer, target);

    expect(evicted.urls).toEqual([]);
  });

  it("a moderator's delete keeps media a message outside the loaded channel still names", async () => {
    const shared = `https://blossom.example/${"4".repeat(64)}.jpg`;
    const deleted = rumor("deleted", { tags: [["imeta", `url ${shared}`]] });
    await getArmadaDB().tenant("c2:a").event(deleted);
    await getArmadaDB().tenant("c2:b").event(rumor("forward", { tags: [["imeta", `url ${shared}`]] }));

    // As useChannel calls it: the survivors are the open channel's loaded window, which lacks the forward.
    await evictRemovedMessageMedia(deleted.id, deleted.tags, deleted.content, [], () => otherUsersOfMedia(getArmadaDB(), deleted));

    expect(evicted.urls).toEqual([]);
    expect(evicted.hashes).toEqual([]);
  });
});
