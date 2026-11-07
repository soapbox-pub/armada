import { encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  baseRekeyGroupKey,
  bytesToHex,
  channelRekeyGroupKey,
  epochKeyCommitment,
  random32,
  recipientLocator,
  hex32,
} from "@/concord/lib/derive";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import {
  base64ToBytes,
  buildRekeyRumors,
  channelRekeyAddressWindow,
  highestRotatedEpoch,
  bytesToBase64,
  checkContinuity,
  decodeWrappedKey,
  encodeWrappedKey,
  findBlob,
  groupRotations,
  REKEY_BASE_BLOBS_PER_EVENT,
  REKEY_BLOBS_PER_EVENT,
  REKEY_RUMOR_MAX_BYTES,
  type ParsedRekey,
  type RekeyRotation,
  lowerKeyWins,
  mintOrReuseRotationKey,
  myLocator,
  parseRekey,
  rekeyScopeId,
  rotationExcludesMe,
  rotationPublishedAtMs,
  type RekeyBlob,
} from "@/concord/lib/rekey";
import { NIP44_MAX_PLAINTEXT, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

describe("wrapped keys (CORD-06 §1)", () => {
  it("round-trips the 72-byte plaintext and verifies scope+epoch from inside", () => {
    const scopeId = random32();
    const newKey = random32();
    const plain = encodeWrappedKey(scopeId, 3n, newKey);
    expect(plain.length).toBe(72);
    expect(bytesToHex(decodeWrappedKey(plain, scopeId, 3n))).toBe(bytesToHex(newKey));
    expect(() => decodeWrappedKey(plain, random32(), 3n)).toThrow(/scope/);
    expect(() => decodeWrappedKey(plain, scopeId, 4n)).toThrow(/epoch/);
    // base64 transport survives.
    expect(bytesToHex(base64ToBytes(bytesToBase64(plain)))).toBe(bytesToHex(plain));
  });
});

describe("rekey events (CORD-06 §1–2)", () => {
  it("builds, seals, opens, and parses a base rotation", async () => {
    const rotator = signer();
    const priorRoot = random32();
    const cid = random32();
    const address = baseRekeyGroupKey(priorRoot, cid, 1);
    const prevCommit = bytesToHex(epochKeyCommitment(0n, priorRoot));

    const blobs: RekeyBlob[] = [{ locator: bytesToHex(random32()), wrapped: "AAAA" }];
    const rumors = buildRekeyRumors(rotator.pubkey, { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit }, blobs, Date.now());
    expect(rumors.length).toBe(1);

    const wrap = await wrapSeal(await sealRumor(rumors[0], KIND_SEAL_ENCRYPTED, address, rotator), address);
    const parsed = parseRekey(openWrap(wrap, address));
    expect(parsed.rotator).toBe(rotator.pubkey);
    expect(parsed.scopeIdHex).toBe("0".repeat(64));
    expect(parsed.newEpoch).toBe(1n);
    expect(parsed.prevCommit).toBe(prevCommit);
    expect(parsed.blobs.length).toBe(1);
  });

  it("carries the rotator's authority citation across every chunk, and correlates it onto the set", async () => {
    // CORD-06 §Authority: a rotation cites the Grant it acts under, so a client
    // whose roster is one sweep stale never honors a just-demoted admin's
    // Refounding — and that one turns the WHOLE community's keys. The citation
    // rides every chunk (like the continuity fields), so a receiver holding only
    // some chunks can still judge the authority.
    const rotator = signer();
    const priorRoot = random32();
    const cid = random32();
    const address = baseRekeyGroupKey(priorRoot, cid, 1);
    const prevCommit = bytesToHex(epochKeyCommitment(0n, priorRoot));
    const vac = { entityId: random32(), version: 4n, editionHash: random32() };

    // Enough blobs to force more than one chunk.
    const blobs: RekeyBlob[] = Array.from({ length: REKEY_BLOBS_PER_EVENT + 1 }, () => ({
      locator: bytesToHex(random32()),
      wrapped: "AAAA",
    }));
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit },
      blobs,
      Date.now(),
      vac,
    );
    expect(rumors.length, "the fixture must actually span chunks").toBeGreaterThan(1);

    const parsed: ParsedRekey[] = [];
    for (const r of rumors) {
      const wrap = await wrapSeal(await sealRumor(r, KIND_SEAL_ENCRYPTED, address, rotator), address);
      parsed.push(parseRekey(openWrap(wrap, address)));
    }
    for (const p of parsed) {
      expect(bytesToHex(p.authority!.entityId), "every chunk carries it").toBe(bytesToHex(vac.entityId));
      expect(p.authority!.version).toBe(4n);
    }

    const [set] = groupRotations(parsed);
    expect(set.complete).toBe(true);
    expect(bytesToHex(set.authority!.editionHash), "and it reaches the adoption gate").toBe(
      bytesToHex(vac.editionHash),
    );
  });

  it("leaves the citation absent when the owner rotates", async () => {
    // The owner is proven by the community_id itself — there is no Grant to cite.
    const rotator = signer();
    const priorRoot = random32();
    const cid = random32();
    const address = baseRekeyGroupKey(priorRoot, cid, 1);
    const prevCommit = bytesToHex(epochKeyCommitment(0n, priorRoot));
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit },
      [{ locator: bytesToHex(random32()), wrapped: "AAAA" }],
      Date.now(),
      undefined,
    );
    const wrap = await wrapSeal(await sealRumor(rumors[0], KIND_SEAL_ENCRYPTED, address, rotator), address);
    expect(parseRekey(openWrap(wrap, address)).authority).toBeUndefined();
  });

  it("chunks a base rotation at 60 blobs and completes only with every chunk", () => {
    const rotator = signer();
    const prevCommit = bytesToHex(epochKeyCommitment(0n, random32()));
    const blobs: RekeyBlob[] = Array.from({ length: 150 }, () => ({
      locator: bytesToHex(random32()),
      wrapped: "AA",
    }));
    const rumors = buildRekeyRumors(rotator.pubkey, { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit }, blobs, 1000);
    expect(rumors.length).toBe(3);

    // Parse them structurally (skip the envelope for speed).
    const parsed = rumors.map((r) =>
      parseRekey({
        rumorId: r.id,
        author: rotator.pubkey,
        kind: r.kind,
        content: r.content,
        tags: r.tags,
        ms: 1000,
        createdAt: r.created_at,
        wrapId: r.id,
        streamPk: "",
        sealKind: 20013,
        seal: {} as never,
      }),
    );

    const partial = groupRotations(parsed.slice(0, 2));
    expect(partial[0].complete).toBe(false); // a missing chunk is never a removal

    const full = groupRotations(parsed);
    expect(full.length).toBe(1);
    expect(full[0].complete).toBe(true);
    expect([...full[0].chunks.values()].flat().reduce((n, c) => n + c.blobs.length, 0)).toBe(150);
  });

  it("continuity: match adopts, higher prevepoch is a gap, mismatch is a fork", () => {
    const key0 = random32();
    const commit0 = bytesToHex(epochKeyCommitment(0n, key0));
    expect(checkContinuity({ prevEpoch: 0n, prevCommit: commit0 }, 0n, key0)).toEqual({ ok: true });
    expect(checkContinuity({ prevEpoch: 2n, prevCommit: commit0 }, 0n, key0)).toEqual({ ok: false, reason: "gap" });
    expect(checkContinuity({ prevEpoch: 0n, prevCommit: "ff".repeat(32) }, 0n, key0)).toEqual({ ok: false, reason: "fork" });
  });

  it("locates my blob by the public-inputs locator", () => {
    const rotator = signer();
    const me = signer();
    const scopeId = rekeyScopeId({ kind: "root" });
    const locator = bytesToHex(recipientLocator(hex32(rotator.pubkey), hex32(me.pubkey), scopeId, 1n));
    expect(myLocator(rotator.pubkey, me.pubkey, bytesToHex(scopeId), 1n)).toBe(locator);

    const prevCommit = bytesToHex(epochKeyCommitment(0n, random32()));
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit },
      [{ locator, wrapped: "QQ" }],
      1000,
    );
    const parsed = parseRekey({
      rumorId: rumors[0].id,
      author: rotator.pubkey,
      kind: rumors[0].kind,
      content: rumors[0].content,
      tags: rumors[0].tags,
      ms: 1000,
      createdAt: rumors[0].created_at,
      wrapId: rumors[0].id,
      streamPk: "",
      sealKind: 20013,
      seal: {} as never,
    });
    const [set] = groupRotations([parsed]);
    expect(findBlob(set, locator)?.wrapped).toBe("QQ");
    expect(findBlob(set, bytesToHex(random32()))).toBeUndefined();
  });

  it("race convergence: the lexicographically lowest new key wins", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(lowerKeyWins(a, b)).toBe(a);
    expect(lowerKeyWins(b, a)).toBe(a);
  });
});

describe("exclusion vs. history (join-onto-a-past-Refounding, liveness-only bug)", () => {
  function chunkedRotationAtMs(ms: number) {
    // A one-chunk root rotation whose only chunk was published at `ms`.
    const rotator = signer();
    const prevCommit = bytesToHex(epochKeyCommitment(0n, random32()));
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit },
      [{ locator: bytesToHex(random32()), wrapped: "AA" }],
      ms,
    );
    const parsed = parseRekey({
      rumorId: rumors[0].id,
      author: rotator.pubkey,
      kind: rumors[0].kind,
      content: rumors[0].content,
      tags: rumors[0].tags,
      ms,
      createdAt: rumors[0].created_at,
      wrapId: rumors[0].id,
      streamPk: "",
      sealKind: 20013,
      seal: {} as never,
    });
    return groupRotations([parsed])[0];
  }

  it("reports a rotation's publish time as its earliest chunk ms (Vector `at_ms`)", () => {
    // Two chunks of one rotation, published at different times → the earliest.

    const rotator = signer();
    const prevCommit = bytesToHex(epochKeyCommitment(0n, random32()));
    const blobs: RekeyBlob[] = Array.from({ length: 100 }, () => ({
      locator: bytesToHex(random32()),
      wrapped: "AA",
    }));
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit },
      blobs,
      5000,
    );
    const parsed = rumors.map((r, i) =>
      parseRekey({
        rumorId: r.id,
        author: rotator.pubkey,
        kind: r.kind,
        content: r.content,
        tags: r.tags,
        // Second chunk lands a beat later.
        ms: 5000 + i * 1000,
        createdAt: r.created_at,
        wrapId: r.id,
        streamPk: "",
        sealKind: 20013,
        seal: {} as never,
      }),
    );
    const [set] = groupRotations(parsed);
    expect(rotationPublishedAtMs(set)).toBe(5000);
  });

  it("a rotation entirely before my join is history, NOT an exclusion", () => {
    // The reported bug: a public invite hands me epoch N; the community already
    // ran an N→N+1 Refounding LONG before I joined. The rotation is complete and
    // has no blob for me, but it predates my join — so it must not tombstone me.
    const rotatedAt = 1_000_000; // the Refounding happened here
    const joinedAt = 9_000_000; // I joined much later, via the stale link
    const set = chunkedRotationAtMs(rotatedAt);
    expect(rotationPublishedAtMs(set)).toBe(rotatedAt);
    expect(rotationExcludesMe(rotationPublishedAtMs(set), joinedAt)).toBe(false);
  });

  it("a rotation at/after my join CAN exclude me", () => {
    const joinedAt = 1_000_000;
    // Exactly at join (boundary) and strictly after both count as an exclusion.
    expect(rotationExcludesMe(rotationPublishedAtMs(chunkedRotationAtMs(joinedAt)), joinedAt)).toBe(true);
    expect(rotationExcludesMe(rotationPublishedAtMs(chunkedRotationAtMs(joinedAt + 1)), joinedAt)).toBe(true);
  });
});


describe("rotation key reservation (retry safety)", () => {
  const CID = "c1".repeat(32);
  const COMMIT = "ab".repeat(32);

  it("hands a retry the SAME key it minted for the first attempt", async () => {
    // groupRotations keys a set by (rotator, scope, newEpoch, prevCommit) —
    // every one of which a retry reproduces. A retry that re-minted would
    // merge into the first attempt's set chunk-for-chunk, and members would
    // adopt whichever key rode the chunk carrying their locator: the community
    // splits in half at one epoch, both halves continuity-valid.
    const first = await mintOrReuseRotationKey(CID, { kind: "root" }, 3n, COMMIT);
    const retry = await mintOrReuseRotationKey(CID, { kind: "root" }, 3n, COMMIT);
    expect(bytesToHex(retry)).toBe(bytesToHex(first));
  });

  it("mints a distinct key per epoch, scope and base", async () => {
    const chan = new Uint8Array(32).fill(0x5a);
    const base = await mintOrReuseRotationKey(CID, { kind: "root" }, 7n, COMMIT);
    const nextEpoch = await mintOrReuseRotationKey(CID, { kind: "root" }, 8n, COMMIT);
    const channel = await mintOrReuseRotationKey(CID, { kind: "channel", channelId: chan }, 7n, COMMIT);
    const forked = await mintOrReuseRotationKey(CID, { kind: "root" }, 7n, "cd".repeat(32));
    const hexes = [base, nextEpoch, channel, forked].map(bytesToHex);
    expect(new Set(hexes).size, "a reservation is only shared by genuine retries").toBe(4);
  });
});

describe("channel epoch floor from the wire (CORD-03 §2 / CORD-06 §2)", () => {
  it("derives rotation addresses from the ROOT alone — no channel key needed", () => {
    // This is the whole reason the floor is discoverable. A member who never
    // held a single generation of a channel still holds the community root,
    // and CORD-06 §2 keys the rekey address on (root, channel_id, epoch).
    const root = random32();
    const channelId = random32();
    const window = channelRekeyAddressWindow([{ key: root }], channelId, 4);
    expect(window.size).toBe(4);
    expect([...window.values()]).toEqual([1n, 2n, 3n, 4n]);
    for (const [pk, epoch] of window) {
      expect(pk).toBe(channelRekeyGroupKey(root, channelId, epoch).pk);
    }
  });

  it("spans every held root, since a Refounding seals under the PRIOR one", () => {
    const a = random32();
    const b = random32();
    const channelId = random32();
    expect(channelRekeyAddressWindow([{ key: a }, { key: b }], channelId, 3).size).toBe(6);
  });

  it("reports the highest epoch any observed rotation accounts for", () => {
    const root = random32();
    const channelId = random32();
    const window = channelRekeyAddressWindow([{ key: root }], channelId, 8);
    const at = (e: bigint) => channelRekeyGroupKey(root, channelId, e).pk;
    expect(highestRotatedEpoch(window, [at(1n), at(5n), at(3n)])).toBe(5n);
  });

  it("is 0 for a channel that never rotated, so the first privatisation is epoch 1", () => {
    const window = channelRekeyAddressWindow([{ key: random32() }], random32(), 8);
    expect(highestRotatedEpoch(window, [])).toBe(0n);
    // An unrelated author proves nothing about this channel.
    expect(highestRotatedEpoch(window, ["ff".repeat(32)])).toBe(0n);
  });
});

// ── Chunking: a chunk is bounded by BYTES, not only by count ─────────────────

describe("rekey chunking (CORD-06 §1)", () => {
  const utf8Len = (s: string) => new TextEncoder().encode(s).length;

  /**
   * Blobs as they actually ride the wire: the fixed-width plaintext base64'd
   * for string-only signers, then NIP-44'd under the rotator↔recipient
   * pairwise key. Their width is what a count-based chunker cannot see.
   */
  function blobsOf(width: number, count: number): RekeyBlob[] {
    const wrapped = nip44Encrypt(bytesToBase64(new Uint8Array(width)), random32());
    return Array.from({ length: count }, () => ({ locator: bytesToHex(random32()), wrapped }));
  }

  const rotation = (prevCommit: string) =>
    ({ scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit }) as const;

  /** The widest citation, since it rides every chunk and eats into the budget. */
  const wideVac = () => ({ entityId: random32(), version: 2n ** 64n - 1n, editionHash: random32() });

  const largestChunk = (rumors: { content: string }[]) =>
    Math.max(...rumors.map((r) => (JSON.parse(r.content) as RekeyBlob[]).length));

  it.each([
    { form: "channel", width: 72 },
    { form: "base member", width: 104 },
    { form: "base staff", width: 136 },
  ])("a 500-recipient $form rotation seals and wraps inside the NIP-44 cap", async ({ width }) => {
    // The bug this pins: chunking on CORD-06 §1's count alone sized an event
    // by WHO was in it, and 120 base blobs put the wrap layer's plaintext over
    // the 65,535-byte cap — so `wrapSeal` threw and the Refounding failed at
    // publish, above roughly 100 recipients. Channel blobs are narrow enough
    // that they never hit it, which is why only bans and key rotations did.
    const rotator = signer();
    const address = baseRekeyGroupKey(random32(), random32(), 1);
    const blobs = blobsOf(width, 500);
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      rotation(bytesToHex(random32())),
      blobs,
      Date.now(),
      wideVac(),
    );

    // The split moves blobs between events; it must not lose or duplicate one.
    expect(rumors.flatMap((r) => JSON.parse(r.content) as RekeyBlob[]).map((b) => b.locator)).toEqual(
      blobs.map((b) => b.locator),
    );

    for (const [i, rumor] of rumors.entries()) {
      // A size-driven split still numbers itself ["chunk", i, n], 1-indexed —
      // a receiver correlates by holding all n (see groupRotations).
      expect(rumor.tags.find((t) => t[0] === "chunk")?.slice(1)).toEqual([
        String(i + 1),
        String(rumors.length),
      ]);
      expect(utf8Len(JSON.stringify(rumor)), "the seal layer's plaintext").toBeLessThanOrEqual(
        REKEY_RUMOR_MAX_BYTES,
      );
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, rotator);
      // The layer that overflowed: the wrap NIP-44s the whole seal, which
      // already carries the seal layer's base64 ciphertext.
      expect(utf8Len(JSON.stringify(seal)), "the wrap layer's plaintext").toBeLessThanOrEqual(
        NIP44_MAX_PLAINTEXT,
      );
      // Throws StreamError("oversize") rather than publishing, if it doesn't.
      const wrap = await wrapSeal(seal, address);
      // CORD-02 Appendix B: the outer event fits a 64 KB relay event.
      expect(utf8Len(JSON.stringify(wrap)), "the published event").toBeLessThanOrEqual(65_536);
      expect(openWrap(wrap, address).rumorId).toBe(rumor.id);
    }
  });

  it("lets CORD-06 §1's count caps bind for every blob width", () => {
    const rotator = signer();
    const largest = (width: number, scope: RekeyRotation["scope"]) =>
      largestChunk(
        buildRekeyRumors(
          rotator.pubkey,
          { ...rotation(bytesToHex(random32())), scope },
          blobsOf(width, 500),
          Date.now(),
          wideVac(),
        ),
      );
    const channel = { kind: "channel", channelId: random32() } as const;
    expect(largest(72, channel)).toBe(REKEY_BLOBS_PER_EVENT);
    expect(largest(104, { kind: "root" })).toBe(REKEY_BASE_BLOBS_PER_EVENT);
    expect(largest(136, { kind: "root" })).toBe(REKEY_BASE_BLOBS_PER_EVENT);
  });

  it("still emits one empty chunk for a rotation with no recipients", () => {
    const rumors = buildRekeyRumors(signer().pubkey, rotation(bytesToHex(random32())), [], Date.now());
    expect(rumors).toHaveLength(1);
    expect(JSON.parse(rumors[0].content)).toEqual([]);
    expect(rumors[0].tags.find((t) => t[0] === "chunk")?.slice(1)).toEqual(["1", "1"]);
  });

  it("keeps a lone over-budget blob rather than dropping it", () => {
    // A blob is indivisible, so there is no chunking left to do — emitting it
    // and letting the wrap refuse it beats silently severing its recipient.
    const huge = { locator: bytesToHex(random32()), wrapped: "x".repeat(REKEY_RUMOR_MAX_BYTES * 2) };
    const rumors = buildRekeyRumors(signer().pubkey, rotation(bytesToHex(random32())), [huge], Date.now());
    expect(rumors).toHaveLength(1);
    expect((JSON.parse(rumors[0].content) as RekeyBlob[])[0].locator).toBe(huge.locator);
  });
});
