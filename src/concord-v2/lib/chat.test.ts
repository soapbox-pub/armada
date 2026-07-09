import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as nobleBytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { buildV2CommentTags, foldTimeline, openChatBatch, replyTargetOf } from "@/concord-v2/lib/chat";
import { bytesToHex, channelGroupKey } from "@/concord-v2/lib/derive";
import { KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_REACTION, KIND_SEAL_ENCRYPTED, KIND_ZAP } from "@/concord-v2/lib/kinds";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, type Rumor } from "@/concord-v2/lib/stream";
import type { ChannelV2 } from "@/concord-v2/lib/types";

// Synthetic invoices ("lnmock<msats>") decode to controlled sections so the
// CORD.md fold can be tested without a bolt11 encoder (same scheme as
// zaps.test.ts).
const ZAP_PREIMAGE = "42".repeat(32);
const ZAP_PAYMENT_HASH = nobleBytesToHex(sha256(hexToBytes(ZAP_PREIMAGE)));
vi.mock("light-bolt11-decoder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("light-bolt11-decoder")>();
  return {
    ...actual,
    decode: (invoice: string) => {
      if (!invoice.startsWith("lnmock")) return actual.decode(invoice);
      return {
        sections: [
          { name: "amount", value: invoice.slice("lnmock".length) },
          { name: "payment_hash", value: ZAP_PAYMENT_HASH },
        ],
      };
    },
  };
});

const root = new Uint8Array(32).fill(3);
const channelId = new Uint8Array(32).fill(5);
const channelIdHex = bytesToHex(channelId);

function makeChannel(): ChannelV2 {
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  return { id: channelId, idHex: channelIdHex, name: "general", isPrivate: false, isVoice: false, streams: [stream], current: stream };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function wrapChat(rumor: Rumor, channel: ChannelV2, s: ReturnType<typeof signer>): Promise<NostrEvent> {
  return wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, s), channel.current.group);
}

function chatRumor(s: ReturnType<typeof signer>, kind: number, content: string, ms: number, extra: string[][] = []): Rumor {
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
    const commentTags = buildV2CommentTags({ id: rootMsg.id, kind: KIND_MESSAGE, pubkey: alice.pubkey, tags: rootMsg.tags });
    const reply = chatRumor(bob, KIND_COMMENT, "reply", 1500, commentTags);
    // A nested reply to the reply inherits the ROOT pointer (stable at depth).
    const nestedTags = buildV2CommentTags({ id: reply.id, kind: KIND_COMMENT, pubkey: bob.pubkey, tags: reply.tags });
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
    const zapTags = (preimage: string, msats: string) => [
      ["e", msg.id],
      ["p", alice.pubkey],
      ["k", "9"],
      ["amount", msats],
      ["bolt11", `lnmock${msats}`],
      ["preimage", preimage],
    ];
    // Bob's zap: valid preimage, matching amount.
    const goodZap = chatRumor(bob, KIND_ZAP, "gm ⚡", 2000, zapTags(ZAP_PREIMAGE, "21000"));
    // Carol's forgery: wrong preimage for the invoice's payment hash.
    const forgedZap = chatRumor(carol, KIND_ZAP, "", 3000, zapTags("99".repeat(32), "500000"));

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
});
