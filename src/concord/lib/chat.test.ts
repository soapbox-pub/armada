import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { buildConcordCommentTags, filterEpochCutoff, foldTimeline, openChatBatch, replyTargetOf } from "@/concord/lib/chat";
import { bytesToHex, channelGroupKey, channelSignerGroupKey, random32, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_CALENDAR_RSVP, KIND_CALENDAR_TIME, KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_POLL, KIND_POLL_VOTE, KIND_REACTION, KIND_SEAL_ENCRYPTED, KIND_TIMER_NOTICE, KIND_ZAP } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import { parseCalendarEvents, tallyRsvps } from "@/lib/calendar";
import { parsePoll, tallyPollVotes } from "@/lib/polls";
import { MOCK_PREIMAGE as ZAP_PREIMAGE, paymentHashOf } from "@/test/bolt11Mock";
import type { Channel } from "@/concord/lib/types";
import type { OpenedChat } from "@/concord/lib/chat";
import { channelWriteGroup, channelsView, mintCommunity } from "@/concord/lib/community";
import { withChannelAnnouncePk } from "@/concord/lib/channelAnnounce";
import { emptyRoles } from "@/concord/lib/roles";
import type { ChannelMetadata } from "@/concord/lib/types";

// Synthetic "lnmock…" invoices decode to controlled sections so the CORD.md
// fold can be tested without a bolt11 encoder (shared with zaps.test.ts).
vi.mock("light-bolt11-decoder", async (importOriginal) => {
  const { mockBolt11Decoder } = await import("@/test/bolt11Mock");
  return mockBolt11Decoder(await importOriginal<typeof import("light-bolt11-decoder")>());
});

const root = new Uint8Array(32).fill(3);
const channelId = new Uint8Array(32).fill(5);
const channelIdHex = bytesToHex(channelId);

function makeChannel(): Channel {
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
  return { id: channelId, idHex: channelIdHex, name: "general", isPrivate: false, isAnnouncement: false, voice, streams: [stream], current: stream };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function wrapChat(rumor: NostrRumor, channel: Channel, s: ReturnType<typeof signer>): Promise<NostrEvent> {
  return wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channelWriteGroup(channel), s), channelWriteGroup(channel));
}

function chatRumor(s: ReturnType<typeof signer>, kind: number, content: string, ms: number, extra: string[][] = []): NostrRumor {
  return buildRumor({
    kind,
    content,
    tags: [...channelBindingTags(channelIdHex, 0n), ...extra],
    pubkey: s.pubkey,
    ms,
  });
}

describe("chat plane (CORD-03)", () => {
  it("decodes, folds, and orders by ms", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const m1 = chatRumor(alice, KIND_MESSAGE, "first", 1000);
    const m2 = chatRumor(bob, KIND_MESSAGE, "second", 1500, [["q", m1.id, "", alice.pubkey]]);
    const wraps = [await wrapChat(m2, channel, bob), await wrapChat(m1, channel, alice)];

    const opened = await openChatBatch(wraps, channel);
    const folded = foldTimeline(opened);
    expect(folded.messages.map((m) => m.content)).toEqual(["first", "second"]);
    // A kind-9 `q` is an INLINE reply (stays in the timeline), not a thread.
    expect(replyTargetOf(folded.messages[1])).toBeUndefined();
  });

  it("threads NIP-22 kind-1111 replies: folds into the timeline, root resolves via the E tag", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();
    const carol = signer();

    const rootMsg = chatRumor(alice, KIND_MESSAGE, "root", 1000);
    // A NIP-22 comment replying to the root message.
    const commentTags = buildConcordCommentTags({ id: rootMsg.id, kind: KIND_MESSAGE, pubkey: alice.pubkey, tags: rootMsg.tags });
    const reply = chatRumor(bob, KIND_COMMENT, "reply", 1500, commentTags);
    // A nested reply to the reply inherits the ROOT pointer (stable at depth).
    const nestedTags = buildConcordCommentTags({ id: reply.id, kind: KIND_COMMENT, pubkey: bob.pubkey, tags: reply.tags });
    const nested = chatRumor(carol, KIND_COMMENT, "nested", 1800, nestedTags);

    const wraps = await Promise.all([
      wrapChat(rootMsg, channel, alice),
      wrapChat(reply, channel, bob),
      wrapChat(nested, channel, carol),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    // All three survive the fold (kind-1111 is not dropped).
    expect(folded.messages.map((m) => m.content)).toEqual(["root", "reply", "nested"]);
    // Both replies point at the SAME thread root (the original message).
    expect(replyTargetOf(folded.messages[1])).toBe(rootMsg.id);
    expect(replyTargetOf(folded.messages[2])).toBe(rootMsg.id);
    // The immediate parent is preserved distinctly from the root.
    expect(nested.tags.find((t) => t[0] === "e")?.[1]).toBe(reply.id);
    expect(nested.tags.find((t) => t[0] === "E")?.[1]).toBe(rootMsg.id);
  });

  it("treats a kind-9 `q` as an inline reply, not a thread (stays top-level)", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const rootMsg = chatRumor(alice, KIND_MESSAGE, "root", 1000);
    const inline = chatRumor(bob, KIND_MESSAGE, "inline reply", 1500, [["q", rootMsg.id, "", alice.pubkey]]);
    const folded = foldTimeline(
      await openChatBatch(await Promise.all([wrapChat(rootMsg, channel, alice), wrapChat(inline, channel, bob)]), channel),
    );
    // Not a thread root — the inline reply belongs in the timeline, so
    // `replyTargetOf` returns undefined and the reader keeps it top-level.
    expect(replyTargetOf(folded.messages[1])).toBeUndefined();
  });

  it("applies author-only edits (latest wins) and self-deletes", async () => {
    const channel = makeChannel();
    const alice = signer();
    const mallory = signer();

    const msg = chatRumor(alice, KIND_MESSAGE, "original", 1000);
    const edit = chatRumor(alice, KIND_EDIT, "fixed", 2000, [["e", msg.id]]);
    const forgedEdit = chatRumor(mallory, KIND_EDIT, "hacked", 3000, [["e", msg.id]]);
    const other = chatRumor(alice, KIND_MESSAGE, "gone soon", 1200);
    const del = chatRumor(alice, KIND_DELETE, "", 4000, [["e", other.id], ["k", "9"]]);

    const wraps = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(edit, channel, alice),
      wrapChat(forgedEdit, channel, mallory),
      wrapChat(other, channel, alice),
      wrapChat(del, channel, alice),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));
    expect(folded.messages.length).toBe(1);
    expect(folded.messages[0].content).toBe("fixed"); // Mallory's edit ignored
    // The edit stamps an ["edited", <unix>] tag so the UI shows "(edited)".
    expect(folded.messages[0].tags).toContainEqual(["edited", "2"]);
  });

  it("honors moderation: banned authors dropped, authorized in-batch deletes applied", async () => {
    const channel = makeChannel();
    const alice = signer();
    const banned = signer();
    const mod = signer();

    const spam = chatRumor(banned, KIND_MESSAGE, "spam", 1000);
    const msg = chatRumor(alice, KIND_MESSAGE, "rule-breaking", 1100);
    const del = chatRumor(mod, KIND_DELETE, "", 2000, [["e", msg.id]]);

    const wraps = await Promise.all([
      wrapChat(spam, channel, banned),
      wrapChat(msg, channel, alice),
      wrapChat(del, channel, mod),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel), {
      banned: new Set([banned.pubkey]),
      canDelete: (deleter) => deleter === mod.pubkey,
    });
    expect(folded.messages.length).toBe(0);
  });

  it("carries a moderation delete's citation through the fold, and parks an uncited one", async () => {
    // CORD-04 §5: a delete of someone else's message is an authority action and
    // cites the Grant it acts under. The fold used to collapse deletes to a bare
    // author set, which threw the citation away before anything could check it —
    // so a moderator whose demotion this client had not synced was honored.
    const channel = makeChannel();
    const alice = signer();
    const mod = signer();
    const eid = "ab".repeat(32);
    const hash = "cd".repeat(32);

    const msg = chatRumor(alice, KIND_MESSAGE, "rule-breaking", 1000);
    const cited = chatRumor(mod, KIND_DELETE, "", 2000, [["e", msg.id], ["vac", eid, "3", hash]]);
    const wraps = await Promise.all([wrapChat(msg, channel, alice), wrapChat(cited, channel, mod)]);
    const opened = await openChatBatch(wraps, channel);

    // The citation reaches the authority check intact.
    let seen: { eid?: string; version?: string } = {};
    const folded = foldTimeline(opened, {
      banned: new Set<string>(),
      canDelete: (_d, _a, action) => {
        seen = action?.citation
          ? { eid: bytesToHex(action.citation.entityId), version: action.citation.version.toString() }
          : {};
        return Boolean(action?.citation);
      },
    });
    expect(seen.eid, "the fold must hand the parsed vac to the authority check").toBe(eid);
    expect(seen.version).toBe("3");
    expect(folded.messages.length).toBe(0);

    // An UNCITED delete from the same moderator parks: the checker sees no
    // citation, so it refuses, and the message survives.
    const uncited = chatRumor(mod, KIND_DELETE, "", 2000, [["e", msg.id]]);
    const wraps2 = await Promise.all([wrapChat(msg, channel, alice), wrapChat(uncited, channel, mod)]);
    const parked = foldTimeline(await openChatBatch(wraps2, channel), {
      banned: new Set<string>(),
      canDelete: (_d, _a, action) => Boolean(action?.citation),
    });
    expect(parked.messages.length, "an uncited moderation delete must not be honored").toBe(1);
  });

  it("prefers a cited delete when the same actor also published an uncited one", async () => {
    // Otherwise a duplicate — a relay echo, or a client that retried before the
    // fold gained citations — masks the delete that actually carries authority.
    const channel = makeChannel();
    const alice = signer();
    const mod = signer();
    const msg = chatRumor(alice, KIND_MESSAGE, "target", 1000);
    const uncited = chatRumor(mod, KIND_DELETE, "", 2000, [["e", msg.id]]);
    const cited = chatRumor(mod, KIND_DELETE, "", 2100, [["e", msg.id], ["vac", "ab".repeat(32), "1", "cd".repeat(32)]]);

    const wraps = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(uncited, channel, mod),
      wrapChat(cited, channel, mod),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel), {
      banned: new Set<string>(),
      canDelete: (_d, _a, action) => Boolean(action?.citation),
    });
    expect(folded.messages.length, "the cited duplicate must win").toBe(0);
  });

  it("still honors a self-delete, which is not an authority action", async () => {
    const channel = makeChannel();
    const alice = signer();
    const msg = chatRumor(alice, KIND_MESSAGE, "mine", 1000);
    const del = chatRumor(alice, KIND_DELETE, "", 2000, [["e", msg.id]]);
    const wraps = await Promise.all([wrapChat(msg, channel, alice), wrapChat(del, channel, alice)]);
    const folded = foldTimeline(await openChatBatch(wraps, channel), {
      banned: new Set<string>(),
      canDelete: () => false, // no moderation authority at all
    });
    expect(folded.messages.length, "authors always delete their own").toBe(0);
  });

  it("tallies reactions per target with custom-emoji URLs", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const msg = chatRumor(alice, KIND_MESSAGE, "react to me", 1000);
    const r1 = chatRumor(bob, KIND_REACTION, "🔥", 1100, [["e", msg.id], ["p", alice.pubkey], ["k", "9"]]);
    const r2 = chatRumor(alice, KIND_REACTION, ":pepe:", 1200, [["e", msg.id], ["emoji", "pepe", "https://x/pepe.png"]]);

    const wraps = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(r1, channel, bob),
      wrapChat(r2, channel, alice),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));
    const tally = folded.reactions.get(msg.id)!;
    expect(tally.get("🔥")?.reactors.has(bob.pubkey)).toBe(true);
    expect(tally.get(":pepe:")?.url).toBe("https://x/pepe.png");
  });

  it("removes a reaction when its rumor is deleted in-batch (kind-5 self-delete)", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const msg = chatRumor(alice, KIND_MESSAGE, "react to me", 1000);
    const r1 = chatRumor(bob, KIND_REACTION, "🔥", 1100, [["e", msg.id], ["p", alice.pubkey], ["k", "9"]]);
    // Bob deletes his own reaction rumor.
    const del = chatRumor(bob, KIND_DELETE, "", 1200, [["e", r1.id], ["k", "7"]]);

    const wraps = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(r1, channel, bob),
      wrapChat(del, channel, bob),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));
    expect(folded.reactions.get(msg.id)).toBeUndefined();
  });

  it("normalizes + and 👍 to the same reaction key", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const msg = chatRumor(alice, KIND_MESSAGE, "react to me", 1000);
    const r1 = chatRumor(alice, KIND_REACTION, "+", 1100, [["e", msg.id]]);
    const r2 = chatRumor(bob, KIND_REACTION, "👍", 1200, [["e", msg.id]]);

    const wraps = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(r1, channel, alice),
      wrapChat(r2, channel, bob),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));
    const tally = folded.reactions.get(msg.id)!;
    expect(tally.size).toBe(1);
    expect(tally.get("👍")?.reactors.size).toBe(2);
  });

  it("keeps a reaction removed across fold invocations (relay echo)", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const msg = chatRumor(alice, KIND_MESSAGE, "react to me", 1000);
    const r1 = chatRumor(bob, KIND_REACTION, "🔥", 1100, [["e", msg.id]]);
    const del = chatRumor(bob, KIND_DELETE, "", 1200, [["e", r1.id], ["k", "7"]]);

    // First fold: reaction + delete in the same batch.
    const wraps1 = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(r1, channel, bob),
      wrapChat(del, channel, bob),
    ]);
    foldTimeline(await openChatBatch(wraps1, channel));

    // Second fold: only the reaction (simulating a relay echo re-adding it
    // after the store's NIP-09 removed it in a prior write batch).
    const wraps2 = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(r1, channel, bob),
    ]);
    const folded2 = foldTimeline(await openChatBatch(wraps2, channel));
    expect(folded2.reactions.get(msg.id)).toBeUndefined();
  });

  it("refuses a message sealed under a retired epoch but dated after its rotation", async () => {
    // The community rotated 0 → 1 at t=5s. Epoch 0's key still opens its
    // wraps (history), but an ejected keyholder can mint valid wraps under it
    // forever — so anything dated after the rotation is refused, everywhere.
    const alice = signer();
    const oldGroup = channelGroupKey(root, channelId, 0);
    const newGroup = channelGroupKey(root, channelId, 1);
    const newStream = { epoch: 1n, group: newGroup };
    const channel: Channel = {
      id: channelId,
      idHex: channelIdHex,
      name: "general",
      isPrivate: false,
      isAnnouncement: false,
      voice: { room: voiceGroupKey(root, channelId, 1), mediaKey: voiceMediaKey(root, channelId, 1) },
      streams: [newStream, { epoch: 0n, group: oldGroup, retiredAt: 5 }],
      current: newStream,
    };

    const mk = (content: string, ms: number) =>
      buildRumor({ kind: KIND_MESSAGE, content, tags: channelBindingTags(channelIdHex, 0n), pubkey: alice.pubkey, ms });
    // created_at 3 ≤ 5: legitimate pre-rotation history.
    const before = mk("history", 3_000);
    // created_at 10 > 5: minted after the community moved on — refused.
    const after = mk("injected", 10_000);
    const wraps = await Promise.all([
      wrapSeal(await sealRumor(before, KIND_SEAL_ENCRYPTED, oldGroup, alice), oldGroup),
      wrapSeal(await sealRumor(after, KIND_SEAL_ENCRYPTED, oldGroup, alice), oldGroup),
    ]);

    const opened = await openChatBatch(wraps, channel);
    expect(opened.map((m) => m.content)).toEqual(["history"]);
  });

  it("filterEpochCutoff re-applies the cutoff to stored rows (and is a no-op without one)", () => {
    const group = channelGroupKey(root, channelId, 0);
    const mkStored = (content: string, epoch: bigint, createdAt: number) => ({
      rumorId: content,
      author: "a".repeat(64),
      kind: KIND_MESSAGE,
      content,
      tags: [],
      ms: createdAt * 1000,
      createdAt,
      channelIdHex,
      epoch,
    });
    const rows = [
      mkStored("old-ok", 0n, 4),
      mkStored("old-injected", 0n, 9),
      mkStored("current", 1n, 9),
    ];
    const newStream = { epoch: 1n, group: channelGroupKey(root, channelId, 1) };
    const channel: Channel = {
      id: channelId,
      idHex: channelIdHex,
      name: "general",
      isPrivate: false,
      isAnnouncement: false,
      voice: { room: voiceGroupKey(root, channelId, 1), mediaKey: voiceMediaKey(root, channelId, 1) },
      streams: [newStream, { epoch: 0n, group, retiredAt: 5 }],
      current: newStream,
    };
    expect(filterEpochCutoff(rows, channel).map((m) => m.content)).toEqual(["old-ok", "current"]);

    // No cutoffs recorded → the SAME array back (no per-read copy).
    const uncapped: Channel = { ...channel, streams: [newStream, { epoch: 0n, group }] };
    expect(filterEpochCutoff(rows, uncapped)).toBe(rows);
  });

  it("drops only banned authors — a retired epoch is not an author filter (CORD-02 §5)", () => {
    const member = "aa".repeat(32);
    const banned = "bb".repeat(32);
    const mk = (content: string, author: string, epoch: bigint, ms: number) => ({
      rumorId: content,
      author,
      kind: KIND_MESSAGE,
      content,
      tags: [],
      ms,
      createdAt: Math.floor(ms / 1000),
      channelIdHex,
      epoch,
    });
    const rows = [
      mk("old", member, 0n, 1000),
      mk("old-banned", banned, 0n, 1100),
      mk("live", member, 1n, 1200),
    ];

    // The Banlist is the one author drop, and it is epoch-blind: it silences
    // the banned in retired AND live history alike (CORD-04 §4).
    const folded = foldTimeline(rows, { banned: new Set([banned]), canDelete: () => false });
    expect(folded.messages.map((m) => m.content)).toEqual(["old", "live"]);

    // An unbanned author's retired-epoch history is never hidden: CORD-02 §5
    // makes an author seen publishing observably present, and a self-signed
    // Join unsuppressable. Nothing folds on the epoch being retired.
    const open = foldTimeline(rows, { banned: new Set(), canDelete: () => false });
    expect(open.messages).toHaveLength(3);
  });

  it("silently skips wraps from epochs we don't hold", async () => {
    const channel = makeChannel();
    const alice = signer();
    const otherEpoch = channelGroupKey(root, channelId, 7);
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "future epoch",
      tags: channelBindingTags(channelIdHex, 7n),
      pubkey: alice.pubkey,
      ms: 1000,
    });
    const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, otherEpoch, alice), otherEpoch);
    const opened = await openChatBatch([wrap], channel);
    expect(opened.length).toBe(0);
  });

  it("folds verified CORD.md zaps and drops forged ones", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();
    const carol = signer();

    const msg = chatRumor(alice, KIND_MESSAGE, "zap me", 1000);
    const zapTags = (preimage: string, msats: string, bolt11 = `lnmock${msats}`) => [
      ["e", msg.id],
      ["p", alice.pubkey],
      ["k", "9"],
      ["amount", msats],
      ["bolt11", bolt11],
      ["preimage", preimage],
    ];
    // Bob's zap: valid preimage, matching amount.
    const goodZap = chatRumor(bob, KIND_ZAP, "gm ⚡", 2000, zapTags(ZAP_PREIMAGE, "21000"));
    // Carol's forgery: wrong preimage for the invoice's payment hash.
    const forgedZap = chatRumor(
      carol,
      KIND_ZAP,
      "",
      3000,
      zapTags("99".repeat(32), "500000", `lnmock500000:h${paymentHashOf("88".repeat(32))}`),
    );

    const wraps = await Promise.all([
      wrapChat(msg, channel, alice),
      wrapChat(goodZap, channel, bob),
      wrapChat(forgedZap, channel, carol),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    const zaps = folded.zaps.get(msg.id);
    expect(zaps?.length).toBe(1);
    expect(zaps?.[0]).toMatchObject({ pubkey: bob.pubkey, sats: 21, comment: "gm ⚡" });
    // The zap rumor is not a timeline message.
    expect(folded.messages.map((m) => m.content)).toEqual(["zap me"]);
  });

  it("folds a poll as a timeline message and tallies its votes (latest per voter wins)", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();
    const carol = signer();

    const poll = chatRumor(alice, KIND_POLL, "Lunch?", 1000, [
      ["option", "a1", "Tacos"],
      ["option", "b2", "Sushi"],
      ["polltype", "singlechoice"],
    ]);
    const bobVote = chatRumor(bob, KIND_POLL_VOTE, "", 1100, [["e", poll.id], ["response", "a1"]]);
    // Carol changes her mind: her later vote supersedes the earlier one.
    const carolFirst = chatRumor(carol, KIND_POLL_VOTE, "", 1200, [["e", poll.id], ["response", "a1"]]);
    const carolFinal = chatRumor(carol, KIND_POLL_VOTE, "", 1300, [["e", poll.id], ["response", "b2"]]);

    const wraps = await Promise.all([
      wrapChat(poll, channel, alice),
      wrapChat(bobVote, channel, bob),
      wrapChat(carolFirst, channel, carol),
      wrapChat(carolFinal, channel, carol),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    // The poll is a visible timeline message; votes are not.
    expect(folded.messages.map((m) => m.content)).toEqual(["Lunch?"]);

    const pollMsg = folded.messages[0];
    const { options, endsAt } = parsePoll(pollMsg);
    const tally = tallyPollVotes(folded.pollVotes.get(poll.id) ?? [], options, endsAt, carol.pubkey);
    expect(tally.counts.get("a1")).toBe(1); // Bob
    expect(tally.counts.get("b2")).toBe(1); // Carol's final (her earlier a1 superseded)
    expect(tally.totalVoters).toBe(2);
    expect([...(tally.myVote ?? [])]).toEqual(["b2"]); // Carol's own latest choice
  });

  it("ignores poll votes cast after endsAt", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();

    const endsAt = 2; // unix seconds
    const poll = chatRumor(alice, KIND_POLL, "Closed?", 1000, [
      ["option", "a1", "Yes"],
      ["option", "b2", "No"],
      ["polltype", "singlechoice"],
      ["endsAt", String(endsAt)],
    ]);
    // ms = 3000 → 3s > endsAt (2s): ignored.
    const lateVote = chatRumor(bob, KIND_POLL_VOTE, "", 3000, [["e", poll.id], ["response", "a1"]]);

    const wraps = await Promise.all([wrapChat(poll, channel, alice), wrapChat(lateVote, channel, bob)]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));
    const { options } = parsePoll(folded.messages[0]);
    const tally = tallyPollVotes(folded.pollVotes.get(poll.id) ?? [], options, endsAt, bob.pubkey);
    expect(tally.totalVoters).toBe(0);
  });

  it("folds calendar events (not into the timeline) and tallies their RSVPs by rumor id", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();
    const carol = signer();

    const event = chatRumor(alice, KIND_CALENDAR_TIME, "Community call", 1000, [
      ["d", "cal1"],
      ["title", "Community call"],
      ["start", "5000"],
    ]);
    // RSVPs `e`-reference the event's rumor id (Concord has no `a`-coordinate).
    const bobGoing = chatRumor(bob, KIND_CALENDAR_RSVP, "", 1100, [["e", event.id], ["status", "accepted"]]);
    const carolMaybe = chatRumor(carol, KIND_CALENDAR_RSVP, "", 1200, [["e", event.id], ["status", "tentative"]]);
    const carolFinal = chatRumor(carol, KIND_CALENDAR_RSVP, "", 1300, [["e", event.id], ["status", "accepted"]]);
    // A regular message shares the channel to prove calendar events stay out of it.
    const msg = chatRumor(alice, KIND_MESSAGE, "hi", 1400);

    const wraps = await Promise.all([
      wrapChat(event, channel, alice),
      wrapChat(bobGoing, channel, bob),
      wrapChat(carolMaybe, channel, carol),
      wrapChat(carolFinal, channel, carol),
      wrapChat(msg, channel, alice),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    // The calendar event is NOT a timeline message.
    expect(folded.messages.map((m) => m.content)).toEqual(["hi"]);

    const parsed = parseCalendarEvents(
      folded.calendarEvents.map((m) => ({
        id: m.rumorId, pubkey: m.author, created_at: Math.floor(m.ms / 1000),
        kind: m.kind, tags: m.tags, content: m.content, sig: "",
      })),
    );
    expect(parsed.map((e) => e.title)).toEqual(["Community call"]);

    const tally = tallyRsvps(folded.rsvps.get(event.id) ?? [], carol.pubkey);
    // Carol's later "accepted" supersedes her "tentative".
    expect(tally.accepted.sort()).toEqual([bob.pubkey, carol.pubkey].sort());
    expect(tally.tentative).toEqual([]);
    expect(tally.mine).toBe("accepted");
  });

  it("removes a calendar event when its author deletes it in-batch", async () => {
    const channel = makeChannel();
    const alice = signer();

    const event = chatRumor(alice, KIND_CALENDAR_TIME, "Gone", 1000, [
      ["d", "cal2"],
      ["title", "Gone"],
      ["start", "5000"],
    ]);
    const del = chatRumor(alice, KIND_DELETE, "", 2000, [["e", event.id], ["k", String(KIND_CALENDAR_TIME)]]);

    const wraps = await Promise.all([wrapChat(event, channel, alice), wrapChat(del, channel, alice)]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));
    expect(folded.calendarEvents.length).toBe(0);
  });

  it("counts a payment once: a replayed proof never re-enters the tally", async () => {
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();
    const mallory = signer();

    const m1 = chatRumor(alice, KIND_MESSAGE, "zap me", 1000);
    const m2 = chatRumor(alice, KIND_MESSAGE, "me too", 1100);
    const zapTags = (targetId: string) => [
      ["e", targetId],
      ["p", alice.pubkey],
      ["k", "9"],
      ["amount", "21000"],
      ["bolt11", "lnmock21000"],
      ["preimage", ZAP_PREIMAGE],
    ];
    // Bob pays once and announces (earliest ms — the deterministic winner).
    const paid = chatRumor(bob, KIND_ZAP, "", 2000, zapTags(m1.id));
    // Mallory saw bob's preimage in the plane and replays the same proof as
    // her own zap — on the same message and on a different one.
    const replaySame = chatRumor(mallory, KIND_ZAP, "", 3000, zapTags(m1.id));
    const replayOther = chatRumor(mallory, KIND_ZAP, "", 4000, zapTags(m2.id));

    const wraps = await Promise.all([
      wrapChat(m1, channel, alice),
      wrapChat(m2, channel, alice),
      wrapChat(paid, channel, bob),
      wrapChat(replaySame, channel, mallory),
      wrapChat(replayOther, channel, mallory),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    expect(folded.zaps.get(m1.id)?.length).toBe(1);
    expect(folded.zaps.get(m1.id)?.[0].pubkey).toBe(bob.pubkey);
    expect(folded.zaps.get(m2.id)).toBeUndefined();
  });
});

describe("disappearing messages (CORD-08)", () => {
  it("filters an expired rumor out of the fold", async () => {
    const channel = makeChannel();
    const alice = signer();
    const nowMs = Date.now();
    const nowSecs = Math.floor(nowMs / 1000);
    const gone = chatRumor(alice, KIND_MESSAGE, "gone", nowMs, [["expiration", String(nowSecs - 10)]]);
    const kept = chatRumor(alice, KIND_MESSAGE, "kept", nowMs + 1, [["expiration", String(nowSecs + 3600)]]);
    const bare = chatRumor(alice, KIND_MESSAGE, "bare", nowMs + 2);

    const wraps = await Promise.all([
      wrapChat(gone, channel, alice),
      wrapChat(kept, channel, alice),
      wrapChat(bare, channel, alice),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    expect(folded.messages.map((m) => m.content)).toEqual(["kept", "bare"]);
  });

  it("surfaces timer notices only from authors the roster trusts, never as messages", async () => {
    const channel = makeChannel();
    const staff = signer();
    const rando = signer();
    const notice = chatRumor(staff, KIND_TIMER_NOTICE, "", 1000, [["timer", "86400"]]);
    const forged = chatRumor(rando, KIND_TIMER_NOTICE, "", 1500, [["timer", "0"]]);
    const malformed = chatRumor(staff, KIND_TIMER_NOTICE, "", 2000);

    const wraps = await Promise.all([
      wrapChat(notice, channel, staff),
      wrapChat(forged, channel, rando),
      wrapChat(malformed, channel, staff),
    ]);
    const folded = foldTimeline(await openChatBatch(wraps, channel), {
      banned: new Set(),
      canDelete: () => false,
      canSetTimer: (author) => author === staff.pubkey,
    });

    expect(folded.timerNotices.map((n) => n.rumorId)).toEqual([notice.id]);
    expect(folded.messages).toHaveLength(0);
  });

  it("keeps every well-formed notice when no roster gate is supplied", async () => {
    // The threads view folds without moderation; an ungated fold must not
    // silently drop conversation rows it merely can't yet judge.
    const channel = makeChannel();
    const alice = signer();
    const bob = signer();
    const n1 = chatRumor(alice, KIND_TIMER_NOTICE, "", 1000, [["timer", "86400"]]);
    const n2 = chatRumor(bob, KIND_TIMER_NOTICE, "", 1500, [["timer", "0"]]);

    const wraps = await Promise.all([wrapChat(n1, channel, alice), wrapChat(n2, channel, bob)]);
    const folded = foldTimeline(await openChatBatch(wraps, channel));

    expect(folded.timerNotices.map((n) => n.rumorId)).toEqual([n1.id, n2.id]);
  });
});

describe("foldTimeline — community pause (CORD-04 §8)", () => {
  let pseq = 0;
  const plainMsg = (author: string, ms: number): OpenedChat => {
    pseq += 1;
    return { rumorId: `p${pseq}`, author, kind: KIND_MESSAGE, content: "hi", tags: [], ms, createdAt: Math.floor(ms / 1000), channelIdHex, epoch: 0n };
  };

  it("collapses non-staff messages posted at/after the pause, sparing staff and history", () => {
    const before = plainMsg("member", 900_000); // pre-pause: untouched
    const during = plainMsg("member", 1_200_000); // during pause: folded
    const mod = plainMsg("mod", 1_300_000); // staff: exempt even during

    const folded = foldTimeline([before, during, mod], undefined, {
      pauseSince: 1000, // seconds → floor 1_000_000 ms
      staff: (a) => a === "mod",
    });

    expect(folded.quarantined.has(during.rumorId)).toBe(true);
    expect(folded.quarantined.has(before.rumorId)).toBe(false);
    expect(folded.quarantined.has(mod.rumorId)).toBe(false);
    // A fold, never a drop: every message still folds (cf. the Banlist).
    expect(folded.messages).toHaveLength(3);
    // Reported separately from the flood verdict, so the row can say why and
    // the durable quarantine memory can refuse to keep it (useChannel).
    expect([...folded.paused]).toEqual([during.rumorId]);
  });

  it("spares the reader's own messages", () => {
    // Sent moments before the pause edition landed, or still in flight when it
    // did. Collapsing it reads as the client having eaten the reader's message.
    const mine = plainMsg("me", 1_200_000);
    const theirs = plainMsg("member", 1_200_001);

    const folded = foldTimeline([mine, theirs], undefined, {
      pauseSince: 1000,
      self: "me",
      staff: () => false,
    });

    expect(folded.paused.has(mine.rumorId)).toBe(false);
    expect(folded.quarantined.has(mine.rumorId)).toBe(false);
    expect(folded.paused.has(theirs.rumorId)).toBe(true);
  });

  it("keeps `paused` empty when the collapse came from the flood rules alone", () => {
    const folded = foldTimeline([plainMsg("a", 1_200_000)], undefined, { staff: () => false });
    expect(folded.paused.size).toBe(0);
  });

  it("does nothing without an active pause", () => {
    const m = plainMsg("member", 1_200_000);
    const folded = foldTimeline([m], undefined, { staff: () => false });
    expect(folded.quarantined.has(m.rumorId)).toBe(false);
  });
});

/**
 * The end-to-end claim an announcement channel makes: every member reads it,
 * and a member who is not staff cannot put anything in it — enforced by the
 * keys, not by the client agreeing to hide a composer.
 */
describe("chat plane (announcement channels)", () => {
  const OWNER = "f".repeat(64);

  function announcementCommunity() {
    const { community } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const metadata: ChannelMetadata = withChannelAnnouncePk(
      { name: "news", private: false },
      channelSignerGroupKey(community.controlRoot!, id, community.rootEpoch).pk,
    );
    const folded = {
      roster: emptyRoles(),
      ownerHex: OWNER,
      channels: new Map([[bytesToHex(id), { channelIdHex: bytesToHex(id), name: "news", isPrivate: false, deleted: false, metadata }]]),
      banned: new Set(),
      liveInviteLinks: new Set(),
      registriesByCreator: new Map(),
      heads: new Map(),
      headEditions: new Map(),
      incomplete: [],
      bannedAt: new Map(),
    } as unknown as Parameters<typeof channelsView>[1];
    return {
      staff: channelsView(community, folded)[0],
      member: channelsView({ ...community, controlRoot: undefined }, folded)[0],
      community,
      id,
    };
  }

  it("a member decodes what staff published, and cannot publish there itself", async () => {
    const { staff, member } = announcementCommunity();
    const mod = signer();

    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "maintenance at 9",
      tags: channelBindingTags(staff.idHex, 0n),
      pubkey: mod.pubkey,
      ms: 1000,
    });
    const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channelWriteGroup(staff), mod), channelWriteGroup(staff));

    // The reader holds no control_root, yet the message opens: the write gate
    // narrowed the signer set without narrowing the readership.
    const opened = await openChatBatch([wrap], member);
    expect(opened.map((o) => o.content)).toEqual(["maintenance at 9"]);

    // …and the same member has no key to answer with.
    expect(() => channelWriteGroup(member)).toThrow(/staff/i);
  });

  it("refuses a wrap published at the announce address by a forged signer", async () => {
    const { staff, member, id, community } = announcementCommunity();
    const impostor = signer();

    // A member who knows the address and holds the community_root read key can
    // build a perfectly-formed wrap — the ONLY thing they cannot do is sign it
    // as the stream. Forge exactly that: right pubkey field, wrong signature.
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "everyone is fired",
      tags: channelBindingTags(staff.idHex, 0n),
      pubkey: impostor.pubkey,
      ms: 2000,
    });
    const read = channelGroupKey(community.root, id, community.rootEpoch);
    const honest = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, read, impostor), read);
    // Through JSON, as it would arrive from a relay: nostr-tools stamps a
    // `verified` symbol on anything it finalized, and a spread would carry it
    // over and short-circuit the very check under test.
    const forged = JSON.parse(JSON.stringify({ ...honest, pubkey: staff.current.group.pk })) as NostrEvent;

    expect(await openChatBatch([forged], member)).toEqual([]);
  });
});
