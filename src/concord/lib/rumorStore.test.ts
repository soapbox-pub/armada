import { IDBFactory } from "fake-indexeddb";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { openChatBatch, type OpenedChat } from "@/concord/lib/chat";
import { decryptWithDisclosedKeys, discloseKeysFor } from "@/concord/lib/nip44keys";
import { KIND_DELETE, KIND_MESSAGE, KIND_REACTION, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, openWrap, rewrapSeal, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Channel } from "@/concord/lib/types";
import {
  ackPendingWraps,
  openedToStored,
  parkPendingWraps,
  peekPendingWraps,
  queryChannelFirstSeen,
  queryChannelRumors,
  queryMentionRumors,
  queryPlane,
  queryRumorsByChannel,
  queryWebxdcRumors,
  readControlSnapshot,
  readStoredSeal,
  readStreamCursor,
  storedToOpened,
  storedToOpenedChat,
  sweepExpiredCommunityRumors,
  updateStreamCursor,
  writeOpened,
  writeRumors,
} from "@/concord/lib/rumorStore";
import { channelWriteGroup } from "@/concord/lib/community";

// A clean IndexedDB for the suite (the store singleton opens against it lazily).
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const root = new Uint8Array(32).fill(3);

/**
 * The community whose tenant this suite reads and writes. Every test in the
 * file shares it: the tenant boundary is exercised by `ArmadaDB.test.ts`, while
 * these tests are about the codec, the tag queries, and the write-time
 * validation that still has to hold WITHIN one community.
 */
const CID = "ab".repeat(32);

/** Each test gets a distinct channel id so the shared store can't cross-talk. */
let nextChannelByte = 5;
function makeChannel(): { channel: Channel; idHex: string } {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const idHex = bytesToHex(channelId);
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
  return {
    channel: { id: channelId, idHex, name: "general", isPrivate: false, isAnnouncement: false, voice, streams: [stream], current: stream },
    idHex,
  };
}

/** `finalizeEvent` tags events with a non-enumerable-in-JSON `verified` symbol; strip it. */
function plain(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function wrapChat(rumor: NostrRumor, channel: Channel, s: ReturnType<typeof signer>): Promise<NostrEvent> {
  return wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channelWriteGroup(channel), s), channelWriteGroup(channel));
}

function chatRumor(
  idHex: string,
  s: ReturnType<typeof signer>,
  kind: number,
  content: string,
  ms: number,
  extra: string[][] = [],
): NostrRumor {
  return buildRumor({
    kind,
    content,
    tags: [...channelBindingTags(idHex, 0n), ...extra],
    pubkey: s.pubkey,
    ms,
  });
}

/** Poll until a condition holds (writes flush via requestIdleCallback/timeout). */
async function eventually<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("concord rumor store", () => {
  it("round-trips an OpenedChat through the stored rumor codec", () => {
    const { idHex } = makeChannel();
    const s = signer();
    const rumor = chatRumor(idHex, s, KIND_MESSAGE, "hello", 1234500 /* ms */);
    const opened: OpenedChat = {
      rumorId: rumor.id,
      author: s.pubkey,
      kind: KIND_MESSAGE,
      content: "hello",
      tags: rumor.tags,
      ms: 1234500,
      createdAt: rumor.created_at,
      wrapId: "w",
      streamPk: "sp",
      sealKind: KIND_SEAL_ENCRYPTED,
      seal: {} as NostrEvent,
      channelIdHex: idHex,
      epoch: 0n,
    };
    const stored = openedToStored(opened);
    expect(stored.id).toBe(rumor.id);
    // A rumor, not an event: there is no `sig` field to carry a placeholder in.
    expect("sig" in stored).toBe(false);
    expect(stored.kind).toBe(KIND_MESSAGE);
    expect(stored.pubkey).toBe(s.pubkey);

    const back = storedToOpenedChat(stored, idHex);
    expect(back.rumorId).toBe(rumor.id);
    expect(back.content).toBe("hello");
    expect(back.ms).toBe(1234500);
    expect(back.author).toBe(s.pubkey);
    expect(back.epoch).toBe(0n);
    expect(back.channelIdHex).toBe(idHex);
  });

  it("queries rumors by channel tag with { kinds, #channel }", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const bob = signer();

    const wraps = await Promise.all([
      wrapChat(chatRumor(idHex, alice, KIND_MESSAGE, "first", 1000), channel, alice),
      wrapChat(chatRumor(idHex, bob, KIND_MESSAGE, "second", 2000), channel, bob),
      wrapChat(chatRumor(idHex, alice, KIND_REACTION, "🔥", 2100, [["e", "x"]]), channel, alice),
    ]);
    const opened = await openChatBatch(wraps, channel);
    writeRumors(CID, opened);

    const got = await eventually(
      () => queryChannelRumors(CID, idHex, { limit: 100 }),
      (r) => r.length === 3,
    );
    expect(got.length).toBe(3);
    const msgs = got.filter((m) => m.kind === KIND_MESSAGE).map((m) => m.content).sort();
    expect(msgs).toEqual(["first", "second"]);

    // A different channel id matches nothing.
    const none = await queryChannelRumors(CID, "ff".repeat(32), { limit: 100 });
    expect(none.length).toBe(0);
  });

  it("delete=delete: a self kind-5 physically removes its target", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();

    const msg = chatRumor(idHex, alice, KIND_MESSAGE, "gone soon", 1000);
    const del = chatRumor(idHex, alice, KIND_DELETE, "", 2000, [["e", msg.id], ["k", "9"]]);

    writeRumors(CID, await openChatBatch([await wrapChat(msg, channel, alice)], channel));
    await eventually(() => queryChannelRumors(CID, idHex, { limit: 100 }), (r) => r.length === 1);

    writeRumors(CID, await openChatBatch([await wrapChat(del, channel, alice)], channel));
    // The delete rumor is stored; NIP-09 removes the targeted message.
    const after = await eventually(
      () => queryChannelRumors(CID, idHex, { limit: 100 }),
      (r) => !r.some((m) => m.rumorId === msg.id),
    );
    expect(after.some((m) => m.rumorId === msg.id)).toBe(false);
  });

  it("preserves the full signed seal in KV, not in the stored rumor (control compaction)", async () => {
    const alice = signer();
    const control = channelGroupKey(new Uint8Array(32).fill(9), new Uint8Array(32).fill(1), 0);
    // A plaintext-sealed control-style edition.
    const rumor = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "ab".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, alice);
    const wrap = wrapSeal(seal, control);
    const opened = openWrap(wrap, control);

    // The rumor is stored as its author wrote it: no seal folded into its tags.
    expect(openedToStored(opened).tags.some((t) => t[0] === "seal")).toBe(false);
    expect(openedToStored(opened).tags).toEqual(rumor.tags);

    writeOpened(CID, [opened], "control");
    const back = await eventually(
      () => queryPlane(CID, "control").then((r) => r.find((e) => e.rumorId === opened.rumorId)),
      (e) => !!e,
    );
    expect(back!.author).toBe(alice.pubkey);
    // The envelope is not stored at all: the seal form is implied by the kind
    // and was checked once, at ingest.
    expect(back!.sealKind).toBeUndefined();
    expect(back!.wrapId).toBeUndefined();
    expect(back!.streamPk).toBeUndefined();
    expect(back!.seal).toBeUndefined();

    // The seal read back out of KV is byte-identical and re-wrappable.
    const stored = await eventually(() => readStoredSeal(CID, opened.rumorId), (s) => !!s);
    expect(stored).toEqual(plain(seal));
    const rewrapped = rewrapSeal(stored!, control);
    expect(openWrap(rewrapped, control).rumorId).toBe(opened.rumorId);
  });

  it("keeps a chat message's encrypted seal — a Pin proves a message FROM its seal", async () => {
    // Encrypted seals were once dropped as pure cost: only compaction read
    // them, and it can re-wrap plaintext seals alone. Pins (CORD-04 §7) changed
    // that — a pin carries the original seal verbatim, so a message whose seal
    // was discarded stops being pinnable the moment it leaves memory.
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const rumor = chatRumor(idHex, alice, KIND_MESSAGE, "chat", 1000);

    writeRumors(CID, await openChatBatch([await wrapChat(rumor, channel, alice)], channel));
    await eventually(() => queryChannelRumors(CID, idHex, { limit: 10 }), (r) => r.length === 1);

    const seal = await eventually(
      () => readStoredSeal(CID, rumor.id),
      (s) => s !== undefined,
    );
    expect(seal?.kind).toBe(KIND_SEAL_ENCRYPTED);
    // And it is the real thing: the disclosure opens it back to the message.
    const keys = discloseKeysFor(seal!.content, channelWriteGroup(channel).convKey)!;
    expect(keys).toBeDefined();
    expect(JSON.parse(decryptWithDisclosedKeys(seal!.content, keys)!).content).toBe("chat");
  });

  it("reads back the rumor verbatim, with the envelope absent unless supplied", () => {
    const alice = signer();
    const rumor = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "ef".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    const stored = openedToStored({
      rumorId: rumor.id,
      author: alice.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      ms: rumor.created_at * 1000,
      createdAt: rumor.created_at,
      wrapId: "w",
      streamPk: "sp",
      sealKind: KIND_SEAL_PLAINTEXT,
    });
    // Nothing about the wrap reaches the row…
    expect(stored.tags).toEqual(rumor.tags);
    // …so a row read back claims no envelope AT ALL, rather than inheriting
    // whatever the rumor's own tags happen to spell — or a blank that reads
    // like a real, empty stream address.
    const bare = storedToOpened(stored);
    expect(bare.tags).toEqual(rumor.tags);
    expect([bare.streamPk, bare.wrapId, bare.sealKind]).toEqual([undefined, undefined, undefined]);
  });

  it("parks, peeks (non-destructively), and acks raw wraps", async () => {
    const alice = signer();
    const control = channelGroupKey(new Uint8Array(32).fill(7), new Uint8Array(32).fill(2), 0);
    const rumor = buildRumor({ kind: 3308, content: "{}", tags: [["vsk", "0"], ["eid", "cd".repeat(32)], ["ev", "1"]], pubkey: alice.pubkey, ms: null });
    const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, alice), control);

    parkPendingWraps([wrap]);
    const peeked = await eventually(() => peekPendingWraps([control.pk]), (r) => r.length === 1);
    expect(peeked.map((w) => w.id)).toEqual([wrap.id]);
    // Peeking is non-destructive: an interrupted decode round must be able to
    // find the wrap again (issue #19 — a notified message must never be
    // locally destructible before its rumor is stored).
    const again = await peekPendingWraps([control.pk]);
    expect(again.map((w) => w.id)).toEqual([wrap.id]);
    // Only an explicit ack (after the decoded rumor is safely stored) removes it.
    ackPendingWraps([wrap.id]);
    const after = await eventually(() => peekPendingWraps([control.pk]), (r) => r.length === 0);
    expect(after.length).toBe(0);
  });

  it("peeks wraps parked in a PREVIOUS session (restart before the key arrived)", async () => {
    const alice = signer();
    const control = channelGroupKey(new Uint8Array(32).fill(8), new Uint8Array(32).fill(4), 0);
    const rumor = buildRumor({ kind: 3308, content: "{}", tags: [["vsk", "0"], ["eid", "ef".repeat(32)], ["ev", "1"]], pubkey: alice.pubkey, ms: null });
    const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, alice), control);

    // Session 1: the wrap arrives for a stream we hold no key for and is
    // parked. The app is then killed before the key ever resolves.
    parkPendingWraps([wrap]);
    await eventually(() => peekPendingWraps([control.pk]), (r) => r.length === 1);

    // Session 2: fresh module state (app restart), SAME durable IndexedDB.
    // The key arrives NOW, so the drain peeks — it must still see the wrap
    // parked last session. (Regression: a session-scoped "ever parked" flag
    // made this peek return [] until something new happened to park, leaving
    // last session's wraps invisible even once their key was available.)
    vi.resetModules();
    const fresh = await import("@/concord/lib/rumorStore");
    const parked = await fresh.peekPendingWraps([control.pk]);
    expect(parked.map((w) => w.id)).toEqual([wrap.id]);
  });

  it("preserves the wrap signature a WRITE-RESTRICTED stream verifies on drain", async () => {
    const alice = signer();
    const stream = channelGroupKey(new Uint8Array(32).fill(9), new Uint8Array(32).fill(6), 0);
    const rumor = buildRumor({ kind: 3308, content: "{}", tags: [["vsk", "0"], ["eid", "ab".repeat(32)], ["ev", "1"]], pubkey: alice.pubkey, ms: null });
    const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_PLAINTEXT, stream, alice), stream);

    parkPendingWraps([wrap]);
    const [parked] = await eventually(() => peekPendingWraps([stream.pk]), (r) => r.length === 1);

    // A restricted stream's write gate IS the wrap signature (stream.ts), so a
    // wrap that survives the park without one can never be opened again — it
    // just re-fails every drain until the age-prune deletes it.
    expect(() => openWrap(parked as NostrEvent, { ...stream, restricted: true })).not.toThrow();
  });

  it("surfaces a mention buried DEEPER than the per-channel scan window", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const me = signer();

    // The mention is the OLDEST message, buried under 20 newer ones — deeper
    // than a shallow newest-window scan reaches.
    const rumors = [
      chatRumor(idHex, alice, KIND_MESSAGE, "hey @me", 1000, [["p", me.pubkey]]),
      ...Array.from({ length: 20 }, (_, i) =>
        chatRumor(idHex, alice, KIND_MESSAGE, `chatter ${i}`, 2000 + i * 1000),
      ),
    ];
    const wraps = await Promise.all(rumors.map((r) => wrapChat(r, channel, alice)));
    writeRumors(CID, await openChatBatch(wraps, channel));
    await eventually(() => queryChannelRumors(CID, idHex, { limit: 100 }), (r) => r.length === 21);

    // A newest-window community scan (as used by unread/threads) misses it…
    const windowed = await queryRumorsByChannel(CID, [idHex], { perChannel: 10 });
    expect(windowed.get(idHex)?.some((r) => r.content === "hey @me")).toBe(false);

    // …but the mentions view must still find it: its own index-backed `#p`
    // filter reaches the whole store. (Regression: deriving mentions from the
    // shared per-channel window silently dropped mentions older than a busy
    // channel's newest page.)
    const mentions = await queryMentionRumors(CID, [idHex], me.pubkey, { limit: 200 });
    expect(mentions.map((r) => r.content)).toEqual(["hey @me"]);
    expect(mentions[0].channelIdHex).toBe(idHex);
  });

  // ── Cross-plane splice ────────────────────────────────────────────────────
  //
  // The chat decode path proves a rumor's `channel` tag matches the key that
  // decrypted its wrap (`checkChannelBinding`). The PLANE openers do not — they
  // bind nothing but the stream address and filter no kinds. Since both write
  // into this one store, and chat reads are `{ kinds, #channel }`, a plane
  // rumor carrying a `channel` tag would be served into that channel's timeline.

  it("refuses a plane rumor carrying a channel tag (cross-plane splice)", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const mallory = signer();

    // A legitimate message, so the channel isn't trivially empty.
    writeRumors(
      CID,
      await openChatBatch([await wrapChat(chatRumor(idHex, alice, KIND_MESSAGE, "real", 1000), channel, alice)], channel),
    );
    await eventually(() => queryChannelRumors(CID, idHex, { limit: 100 }), (r) => r.length === 1);

    // Mallory holds a COMMUNITY-wide plane key (control/guestbook/rekey) but no
    // key for this channel. She wraps a chat-kind rumor on her plane, tagged
    // with the victim channel's id.
    const plane = channelGroupKey(new Uint8Array(32).fill(9), new Uint8Array(32).fill(9), 0);
    const spliced = buildRumor({
      kind: KIND_MESSAGE,
      content: "spliced",
      tags: channelBindingTags(idHex, 0n),
      pubkey: mallory.pubkey,
      ms: 9000,
    });
    const wrap = wrapSeal(await sealRumor(spliced, KIND_SEAL_PLAINTEXT, plane, mallory), plane);
    await writeOpened(CID, [openWrap(wrap, plane)], "control");

    const got = await eventually(() => queryChannelRumors(CID, idHex, { limit: 100 }), (r) => r.length > 1);
    expect(got.map((r) => r.content)).toEqual(["real"]);
  });

  it("refuses a rumor whose kind is not one the plane it arrived on may carry", async () => {
    const alice = signer();
    const mallory = signer();
    const control = channelGroupKey(new Uint8Array(32).fill(10), new Uint8Array(32).fill(10), 0);
    const guestbook = channelGroupKey(new Uint8Array(32).fill(11), new Uint8Array(32).fill(11), 0);

    // Mallory holds the GUESTBOOK stream key and wraps a CONTROL edition on it.
    // The read side is a kind query, so nothing downstream could tell the
    // difference: the refusal has to happen here, against the keys that
    // actually opened the wrap.
    const forged = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "ab".repeat(32)], ["ev", "1"]],
      pubkey: mallory.pubkey,
      ms: null,
    });
    await writeOpened(
      CID,
      [openWrap(wrapSeal(await sealRumor(forged, KIND_SEAL_PLAINTEXT, guestbook, mallory), guestbook), guestbook)],
      "guestbook",
    );

    // An honest edition on the control plane, written after, as the barrier
    // that proves the read ran late enough to have seen the forgery.
    const honest = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "ba".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    await writeOpened(
      CID,
      [openWrap(wrapSeal(await sealRumor(honest, KIND_SEAL_PLAINTEXT, control, alice), control), control)],
      "control",
    );

    const got = await eventually(
      () => queryPlane(CID, "control"),
      (r) => r.some((e) => e.rumorId === honest.id),
    );
    expect(got.some((e) => e.rumorId === honest.id)).toBe(true);
    expect(got.some((e) => e.rumorId === forged.id)).toBe(false);
  });

  it("refuses a CHAT rumor whose kind belongs to another plane (the reverse splice)", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const mallory = signer();

    // Mallory is an ordinary member of this channel — she holds its stream key
    // legitimately, and `checkChannelBinding` has nothing to object to. What she
    // wraps is a CONTROL edition, correctly bound to the channel. The plane read
    // is a kind query, and a stored rumor keeps no seal, so `parseEdition` has
    // no seal form left to reject it by: the refusal has to happen at the chat
    // ingress, or this is a control edition anyone in any channel can mint.
    const forged = chatRumor(idHex, mallory, 3308, "{}", 9000, [
      ["vsk", "0"],
      ["eid", "cd".repeat(32)],
      ["ev", "1"],
    ]);
    writeRumors(CID, await openChatBatch([await wrapChat(forged, channel, mallory)], channel));

    // An honest edition on the real control plane, written after, as the
    // barrier proving the read ran late enough to have seen the forgery.
    const control = channelGroupKey(new Uint8Array(32).fill(13), new Uint8Array(32).fill(13), 0);
    const honest = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "dc".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    await writeOpened(
      CID,
      [openWrap(wrapSeal(await sealRumor(honest, KIND_SEAL_PLAINTEXT, control, alice), control), control)],
      "control",
    );

    const got = await eventually(
      () => queryPlane(CID, "control"),
      (r) => r.some((e) => e.rumorId === honest.id),
    );
    expect(got.some((e) => e.rumorId === honest.id)).toBe(true);
    expect(got.some((e) => e.rumorId === forged.id)).toBe(false);

    // Nor does it reach the timeline it was bound to — refused, not relocated.
    const timeline = await queryChannelRumors(CID, idHex, { limit: 100 });
    expect(timeline.some((r) => r.rumorId === forged.id)).toBe(false);
  });

  it("keeps chat kinds the plane sets don't claim, including ones added later", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();

    // The refusal is a denylist of the plane kinds, so a chat kind outside
    // CHAT_KINDS (3310, the WebXDC signal — stored but never in the timeline)
    // still stores. An allowlist would have dropped it.
    const webxdc = chatRumor(idHex, alice, 3310, "state", 1000, [["i", "uuid-1"]]);
    writeRumors(CID, await openChatBatch([await wrapChat(webxdc, channel, alice)], channel));

    const got = await eventually(
      () => queryWebxdcRumors(CID, idHex, "uuid-1"),
      (r) => r.length === 1,
    );
    expect(got.map((r) => r.rumorId)).toEqual([webxdc.id]);
  });

  it("keeps reactions from displacing messages out of the channel window", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const reactor = signer();

    // Five messages, then a newer wall of reactions. Under one shared limit
    // the newest N rumors were all reactions — the flood detector's evidence
    // and the reader's rows displaced by decoration a bot mints for free
    // against its own spam.
    const msgs = Array.from({ length: 5 }, (_, i) =>
      chatRumor(idHex, alice, KIND_MESSAGE, `note ${i}`, 1000 + i * 1000),
    );
    const reacts = Array.from({ length: 12 }, (_, i) =>
      chatRumor(idHex, reactor, KIND_REACTION, "+", 50_000 + i * 1000, [["e", "ab".repeat(32)]]),
    );
    const wraps = [
      ...(await Promise.all(msgs.map((r) => wrapChat(r, channel, alice)))),
      ...(await Promise.all(reacts.map((r) => wrapChat(r, channel, reactor)))),
    ];
    writeRumors(CID, await openChatBatch(wraps, channel));

    const got = await eventually(
      () => queryChannelRumors(CID, idHex, { limit: 6 }),
      (r) => r.filter((x) => x.kind === KIND_MESSAGE).length === 5,
    );
    expect(got.filter((r) => r.kind === KIND_MESSAGE).length).toBe(5);
    // The side-events still ride along, under their own budget.
    expect(got.some((r) => r.kind === KIND_REACTION)).toBe(true);

    // Same guarantee on the community-wide read the badges derive from.
    const grouped = await queryRumorsByChannel(CID, [idHex], { perChannel: 6 });
    expect((grouped.get(idHex) ?? []).filter((r) => r.kind === KIND_MESSAGE).length).toBe(5);
  });

  it("dates an author's channel arrival by visible rows, never by reactions", async () => {
    const { channel, idHex } = makeChannel();
    const reactor = signer();
    const speaker = signer();

    // A reaction renders no row and costs nothing, which is why a warming bot
    // reacts to its own messages: dating keys by it walks a sybil set past
    // every arrival rule before it says a word.
    const react = chatRumor(idHex, reactor, KIND_REACTION, "+", 1_000_000, [["e", "ab".repeat(32)]]);
    const speech = chatRumor(idHex, speaker, KIND_MESSAGE, "hello there", 2_000_000);
    writeRumors(
      CID,
      await openChatBatch(
        [await wrapChat(react, channel, reactor), await wrapChat(speech, channel, speaker)],
        channel,
      ),
    );

    const map = await eventually(
      () => queryChannelFirstSeen(CID, idHex, { sinceMs: 0, limit: 100 }),
      (m) => m.size > 0,
    );
    expect(map.get(speaker.pubkey)).toBe(2_000_000);
    expect(map.has(reactor.pubkey)).toBe(false);
  });

  it("refuses a control edition that did not arrive under a plaintext seal", async () => {
    const alice = signer();
    const mallory = signer();
    const control = channelGroupKey(new Uint8Array(32).fill(12), new Uint8Array(32).fill(12), 0);

    // CORD-02 §5: an encrypted-seal edition could never survive a compaction
    // re-wrap, so honoring it would mint state that vanishes for every fresh
    // joiner at the next Refounding.
    const sealedWrong = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "cd".repeat(32)], ["ev", "1"]],
      pubkey: mallory.pubkey,
      ms: null,
    });
    await writeOpened(
      CID,
      [openWrap(wrapSeal(await sealRumor(sealedWrong, KIND_SEAL_ENCRYPTED, control, mallory), control), control)],
      "control",
    );

    const honest = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "dc".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    await writeOpened(
      CID,
      [openWrap(wrapSeal(await sealRumor(honest, KIND_SEAL_PLAINTEXT, control, alice), control), control)],
      "control",
    );

    const got = await eventually(
      () => queryPlane(CID, "control"),
      (r) => r.some((e) => e.rumorId === honest.id),
    );
    expect(got.some((e) => e.rumorId === sealedWrong.id)).toBe(false);
  });

  it("records which control stream an edition arrived on, so a re-wrap is attributable", async () => {
    const alice = signer();
    const oldEpoch = channelGroupKey(new Uint8Array(32).fill(13), new Uint8Array(32).fill(13), 0);
    const newEpoch = channelGroupKey(new Uint8Array(32).fill(13), new Uint8Array(32).fill(13), 1);

    // The SAME rumor, re-wrapped verbatim under the new epoch's address — the
    // one fact a stored rumor can never carry, because both wraps carry
    // identical bytes.
    const rumor = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "ef".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    const plainSeal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, oldEpoch, alice);
    await writeOpened(CID, [openWrap(wrapSeal(plainSeal, oldEpoch), oldEpoch)], "control");

    const beforeRewrap = await eventually(
      () => readControlSnapshot(CID, oldEpoch.pk),
      (s) => Boolean(s?.has(rumor.id)),
    );
    expect(beforeRewrap?.has(rumor.id)).toBe(true);
    expect(await readControlSnapshot(CID, newEpoch.pk)).toBeUndefined();

    await writeOpened(CID, [openWrap(rewrapSeal(plain(plainSeal), newEpoch), newEpoch)], "control");
    const afterRewrap = await eventually(
      () => readControlSnapshot(CID, newEpoch.pk),
      (s) => Boolean(s?.has(rumor.id)),
    );
    expect(afterRewrap?.has(rumor.id)).toBe(true);
  });

  it("keeps no snapshot for a community that has never rotated its root", async () => {
    // Nothing reads the set for such a community — there is no compaction to
    // tell from old-root fragments — so writing one was an id list growing per
    // edition, forever, for nobody.
    const alice = signer();
    const control = channelGroupKey(new Uint8Array(32).fill(14), new Uint8Array(32).fill(14), 0);
    const rumor = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "fe".repeat(32)], ["ev", "1"]],
      pubkey: alice.pubkey,
      ms: null,
    });
    const opened = openWrap(
      wrapSeal(await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, alice), control),
      control,
    );

    await writeOpened(CID, [opened], "control", { refounded: false });

    // The edition itself is stored exactly as before — only the bookkeeping is
    // skipped.
    const back = await eventually(
      () => queryPlane(CID, "control"),
      (r) => r.some((e) => e.rumorId === rumor.id),
    );
    expect(back.some((e) => e.rumorId === rumor.id)).toBe(true);
    expect(await readControlSnapshot(CID, control.pk)).toBeUndefined();
  });
});

describe("stream cursors", () => {
  it("merges concurrent updates instead of letting the last writer win", async () => {
    // The scheduler's `c2:` round and a `loadOlder` scroll-up write the same
    // channel's cursor from different call stacks. Unserialized, all three
    // read the same (absent) cursor and only the last write survives — losing
    // a deeper `oldest` or a sticky `exhausted` and costing a redundant round.
    const scope = "cursor-race";
    await Promise.all([
      updateStreamCursor(scope, { newest: 500, oldest: 100 }),
      updateStreamCursor(scope, { exhausted: true }),
      updateStreamCursor(scope, { oldest: 50 }),
    ]);

    expect(await readStreamCursor(scope)).toEqual({ newest: 500, oldest: 50, exhausted: true });
  });

  it("keeps the queue moving when one write fails", async () => {
    const scope = "cursor-throws";
    await updateStreamCursor(scope, { newest: 10 });
    // A rejected mutation must release the lock rather than wedge the scope.
    await expect(
      updateStreamCursor(scope, {
        get newest(): number {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    await updateStreamCursor(scope, { oldest: 7 });

    expect(await readStreamCursor(scope)).toEqual({ newest: 10, oldest: 7, exhausted: false });
  });
});

describe("disappearing messages (CORD-08 §3)", () => {
  it("refuses expired at ingest, hides at read, and physically sweeps", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const realNow = Date.now();
    const nowSecs = Math.floor(realNow / 1000);

    const dead = chatRumor(idHex, alice, KIND_MESSAGE, "dead on arrival", realNow, [["expiration", String(nowSecs - 10)]]);
    const live = chatRumor(idHex, alice, KIND_MESSAGE, "still here", realNow + 1, [["expiration", String(nowSecs + 30)]]);
    const forever = chatRumor(idHex, alice, KIND_MESSAGE, "forever", realNow + 2);

    const wraps = await Promise.all([
      wrapChat(dead, channel, alice),
      wrapChat(live, channel, alice),
      wrapChat(forever, channel, alice),
    ]);
    const opened = await openChatBatch(wraps.map(plain), channel);
    expect(opened).toHaveLength(3);
    await writeRumors(CID, opened);

    // The already-expired rumor never landed.
    let rows = await queryChannelRumors(CID, idHex, { limit: 10 });
    expect(rows.map((r) => r.content).sort()).toEqual(["forever", "still here"]);

    // Cross the live one's deadline: the read filter hides it…
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 60_000);
    try {
      rows = await queryChannelRumors(CID, idHex, { limit: 10 });
      expect(rows.map((r) => r.content)).toEqual(["forever"]);
      // …and the sweep removes the plaintext itself.
      expect(await sweepExpiredCommunityRumors(CID)).toBe(1);
    } finally {
      clock.mockRestore();
    }

    // Back at REAL time — before the deadline, when the read filter would NOT
    // hide a surviving row — the message is gone: deleted, not merely hidden.
    rows = await queryChannelRumors(CID, idHex, { limit: 10 });
    expect(rows.map((r) => r.content)).toEqual(["forever"]);
  });
});
