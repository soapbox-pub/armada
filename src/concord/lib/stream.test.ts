import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { verifyEventsOnce } from "@/lib/verifyCache";
import { ecVerifyBatch } from "@/lib/verifyPool";

import { channelGroupKey, guestbookGroupKey } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT, KIND_WRAP, KIND_WRAP_EPHEMERAL } from "@/concord/lib/kinds";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  openWrapsBatched,
  resolveMs,
  rewrapSeal,
  sealRumor,
  wrapSeal,
} from "@/concord/lib/stream";

const secret = new Uint8Array(32).fill(9);
const channelId = new Uint8Array(32).fill(4);
const channelIdHex = "04".repeat(32);

function testSigner(sk = generateSecretKey()) {
  return {
    sk,
    pubkey: getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  };
}

describe("stream envelope (CORD-01)", () => {
  it("round-trips a message through an encrypted seal", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const ms = 1719800000417;
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "Hey chat!",
      tags: channelBindingTags(channelIdHex, 0n),
      pubkey: alice.pubkey,
      ms,
    });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice);
    const wrap = await wrapSeal(seal, stream);

    expect(wrap.kind).toBe(KIND_WRAP);
    expect(wrap.pubkey).toBe(stream.pk); // fixed author (NIP-59 reversed)
    expect(wrap.tags.find((t) => t[0] === "p")?.[1]).toBeTruthy(); // ephemeral p

    const opened = openWrap(wrap, stream);
    expect(opened.author).toBe(alice.pubkey);
    expect(opened.content).toBe("Hey chat!");
    expect(opened.kind).toBe(KIND_MESSAGE);
    expect(opened.ms).toBe(ms);
    expect(opened.sealKind).toBe(KIND_SEAL_ENCRYPTED);
    expect(() => checkChannelBinding(opened, channelIdHex, 0n)).not.toThrow();
  });

  it("round-trips a plaintext seal (Control Plane form)", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: 3308, content: "{}", tags: [], pubkey: alice.pubkey, ms: null });
    const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, stream, alice);
    // The plaintext seal's content IS the rumor JSON, byte-verbatim.
    expect(JSON.parse(seal.content).id).toBe(rumor.id);
    const opened = openWrap(await wrapSeal(seal, stream), stream);
    expect(opened.rumorId).toBe(rumor.id);
    expect(opened.sealKind).toBe(KIND_SEAL_PLAINTEXT);
  });

  it("a plaintext seal survives a re-wrap into another epoch (compaction)", async () => {
    const alice = testSigner();
    const e0 = channelGroupKey(secret, channelId, 0);
    const e1 = channelGroupKey(secret, channelId, 1);
    const rumor = buildRumor({ kind: 3308, content: "{}", tags: [], pubkey: alice.pubkey, ms: null });
    const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, e0, alice);
    const opened0 = openWrap(await wrapSeal(seal, e0), e0);
    const rewrapped = await rewrapSeal(opened0.seal, e1);
    const opened1 = openWrap(rewrapped, e1);
    expect(opened1.rumorId).toBe(rumor.id);
    expect(opened1.author).toBe(alice.pubkey);
  });

  it("an ENCRYPTED seal cannot be re-encrypted into another stream (sig binds to ciphertext)", async () => {
    const alice = testSigner();
    const e0 = channelGroupKey(secret, channelId, 0);
    const e1 = channelGroupKey(secret, channelId, 1);
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "hi", tags: channelBindingTags(channelIdHex, 0n), pubkey: alice.pubkey, ms: Date.now() });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, e0, alice);
    // A keyholder re-wraps the SAME seal at epoch 1: the wrap opens, but the
    // seal's ciphertext was encrypted under e0's conv key → rumor recover fails.
    const spliced = await wrapSeal(seal, e1);
    expect(() => openWrap(spliced, e1)).toThrow();
  });

  it("rejects a foreign wrap (author is not the stream address)", async () => {
    const alice = testSigner();
    const s1 = channelGroupKey(secret, channelId, 0);
    const s2 = guestbookGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "x", tags: [], pubkey: alice.pubkey, ms: Date.now() });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, s1, alice), s1);
    expect(() => openWrap(wrap, s2)).toThrow(/stream's address/);
  });

  it("rejects a rumor whose author differs from the seal's signer", async () => {
    const alice = testSigner();
    const mallory = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    // Mallory (a keyholder) seals a rumor claiming Alice authored it.
    const forged = buildRumor({ kind: KIND_MESSAGE, content: "im alice", tags: [], pubkey: alice.pubkey, ms: Date.now() });
    const seal = await sealRumor(forged, KIND_SEAL_ENCRYPTED, stream, mallory);
    const wrap = await wrapSeal(seal, stream);
    expect(() => openWrap(wrap, stream)).toThrow(/does not match the seal/);
  });

  it("rejects a rumor whose id is not its hash (ground the ordering tiebreak)", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "x", tags: [], pubkey: alice.pubkey, ms: Date.now() });
    const lying = { ...rumor, id: "00".repeat(32) };
    const seal = await sealRumor(lying, KIND_SEAL_ENCRYPTED, stream, alice);
    const wrap = await wrapSeal(seal, stream);
    expect(() => openWrap(wrap, stream)).toThrow(/event hash/);
  });

  it("drops an event with a malformed ms tag rather than interpreting it", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "x", tags: [["ms", "5000"]], pubkey: alice.pubkey, ms: null });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice), stream);
    expect(() => openWrap(wrap, stream)).toThrow(/ms/);
    expect(resolveMs(100, [["ms", "999"]])).toBe(100999);
    expect(resolveMs(100, [])).toBe(100000);
    expect(() => resolveMs(100, [["ms", "-1"]])).toThrow();
  });

  it("parses the ms remainder as STRICT decimal only (ordering-basis convergence, CORD-02 §4/§5)", () => {
    // `Number()` is lenient — these must all be rejected as malformed, or two
    // clients would disagree on the ordering basis every comparison rides.
    expect(() => resolveMs(1000, [["ms", ""]])).toThrow(); // Number("") === 0
    expect(() => resolveMs(1000, [["ms", "0x1f"]])).toThrow();
    expect(() => resolveMs(1000, [["ms", "1e2"]])).toThrow();
    expect(() => resolveMs(1000, [["ms", " 5 "]])).toThrow();
    expect(() => resolveMs(1000, [["ms", "+5"]])).toThrow();
    expect(() => resolveMs(1000, [["ms", "05"]])).toThrow(); // no leading zeros (CORD-01)
    expect(() => resolveMs(1000, [["ms", "1000"]])).toThrow(); // out of 0..999
    // Well-formed remainders still parse.
    expect(resolveMs(1000, [["ms", "0"]])).toBe(1_000_000);
    expect(resolveMs(1000, [["ms", "417"]])).toBe(1_000_417);
  });

  it("buildRumor refuses a negative/non-finite send time rather than emitting a bad ms tag", () => {
    const alice = testSigner();
    // A glitched clock would otherwise mint `["ms","-234"]`, an un-decodable
    // event every reader drops (CORD-02 §5).
    expect(() => buildRumor({ kind: KIND_MESSAGE, content: "x", pubkey: alice.pubkey, ms: -1234 })).toThrow(/ms/);
    expect(() => buildRumor({ kind: KIND_MESSAGE, content: "x", pubkey: alice.pubkey, ms: NaN })).toThrow(/ms/);
    // A normal time still yields a valid 0..999 remainder.
    const ok = buildRumor({ kind: KIND_MESSAGE, content: "x", pubkey: alice.pubkey, ms: 1_719_800_000_417 });
    expect(ok.tags.find((t) => t[0] === "ms")?.[1]).toBe("417");
  });

  it("detects a cross-channel splice via the binding tags", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "x",
      tags: channelBindingTags("ff".repeat(32), 0n), // committed to another channel
      pubkey: alice.pubkey,
      ms: Date.now(),
    });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice), stream);
    const opened = openWrap(wrap, stream);
    expect(() => checkChannelBinding(opened, channelIdHex, 0n)).toThrow(/splice/);
  });

  it("ephemeral wraps carry the 21059 kind", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: 23311, content: "", tags: [], pubkey: alice.pubkey, ms: Date.now() });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice), stream, { ephemeral: true });
    expect(wrap.kind).toBe(KIND_WRAP_EPHEMERAL);
    expect(openWrap(wrap, stream).kind).toBe(23311);
  });
});

describe("wrap expiration (CORD-08 §2)", () => {
  it("stamps the wrap with a NIP-40 tag on request, and opens unchanged", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "fleeting",
      tags: [...channelBindingTags(channelIdHex, 0n), ["expiration", "1735689600"]],
      pubkey: alice.pubkey,
      ms: Date.now(),
    });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice);

    const wrap = await wrapSeal(seal, stream, { expiration: 1735689600.7 });
    // Floored to whole seconds — a fractional deadline is not a NIP-40 value.
    expect(wrap.tags).toContainEqual(["expiration", "1735689600"]);
    // The ephemeral `p` camouflage stays alongside it.
    expect(wrap.tags.some((t) => t[0] === "p")).toBe(true);

    const opened = openWrap(wrap, stream);
    expect(opened.content).toBe("fleeting");
  });

  it("stamps nothing by default", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "x", tags: channelBindingTags(channelIdHex, 0n), pubkey: alice.pubkey, ms: Date.now() });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice), stream);
    expect(wrap.tags.some((t) => t[0] === "expiration")).toBe(false);
  });
});

describe("openWrap memo", () => {
  it("opens a wrap seen before by id, but only a copy that is the same wrap", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "once", tags: channelBindingTags(channelIdHex, 0n), pubkey: alice.pubkey });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, stream, alice), stream);

    const first = openWrap(wrap, stream);
    first.content = "mutated by a caller";
    expect(openWrap({ ...wrap }, stream).content).toBe("once");

    // Same id over other ciphertext: not the remembered wrap, so it is opened in full (and fails).
    const other = await wrapSeal(await sealRumor({ ...rumor, content: "x" }, KIND_SEAL_ENCRYPTED, stream, alice), stream);
    expect(() => openWrap({ ...other, id: wrap.id, content: "garbage" }, stream)).toThrow();
    // Under another stream it isn't the remembered opening either.
    expect(() => openWrap(wrap, channelGroupKey(secret, channelId, 1))).toThrow();
  });
});

describe("openWrapsBatched", () => {
  it("opens in order, verifying the seals in one batch, and drops a forged seal", async () => {
    const alice = testSigner();
    const stream = channelGroupKey(secret, channelId, 0);
    const wrapOf = async (content: string) =>
      wrapSeal(await sealRumor(buildRumor({ kind: KIND_MESSAGE, content, tags: channelBindingTags(channelIdHex, 0n), pubkey: alice.pubkey }), KIND_SEAL_ENCRYPTED, stream, alice), stream);
    const good = [await wrapOf("one"), await wrapOf("two")];
    // A seal whose signature doesn't verify, wrapped like any other.
    const seal = await sealRumor(buildRumor({ kind: KIND_MESSAGE, content: "forged", tags: channelBindingTags(channelIdHex, 0n), pubkey: alice.pubkey }), KIND_SEAL_ENCRYPTED, stream, alice);
    const forged = await wrapSeal({ ...seal, sig: "00".repeat(64) }, stream);
    let batches = 0;
    const verify = (seals: Parameters<typeof verifyEventsOnce>[0]) => (batches++, verifyEventsOnce(seals, ecVerifyBatch));
    const out = await openWrapsBatched([good[0], forged, good[1]].map((wrap) => ({ wrap, stream })), verify);
    expect(out.map((o) => o?.content)).toEqual(["one", undefined, "two"]);
    expect(batches).toBe(1);
    // Opened before: served from the memo, nothing left to verify.
    const again = await openWrapsBatched(good.map((wrap) => ({ wrap, stream })), verify);
    expect(again.map((o) => o?.content)).toEqual(["one", "two"]);
    expect(batches).toBe(1);
  });
});
