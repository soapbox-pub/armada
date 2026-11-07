/**
 * Pins (CORD-04 §7) against real crypto: every entry here is a genuinely
 * sealed chat message, and every attack is mounted for real rather than
 * simulated. The proof bundle's whole claim is that a reader holding NO
 * channel keys reaches the truth, so most of these verify with nothing but
 * the entry and the channel id.
 */

import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { channelGroupKey, bytesToHex, random32 } from "@/concord/lib/derive";
import { KIND_EDIT, KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import {
  PIN_MAX_CONTENT_BYTES,
  PIN_MAX_ENTRIES,
  buildPinEntry,
  buildPinEntryOrReason,
  isPlaceholderSeal,
  partitionDeletedPins,
  pinKilledBy,
  readPinList,
  unconfirmedWrite,
  serializePublicPinList,
  serializeSealedPinList,
  verifyPinEntry,
  withProvenEdit,
  type PinEntry,
} from "@/concord/lib/pins";
import { buildRumor, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import { discloseKeysFor, encodeMessageKeys } from "@/concord/lib/nip44keys";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/**
 * An entry as a verifier actually receives it: JSON off the wire. Also strips
 * nostr-tools' `verifiedSymbol`, which object spread copies — a live tampered
 * object would otherwise arrive pre-marked "already verified".
 */
const overWire = (e: PinEntry): PinEntry => JSON.parse(JSON.stringify(e)) as PinEntry;

const CHANNEL_A = random32();
const CHANNEL_B = random32();
const chanA = channelGroupKey(random32(), CHANNEL_A, 0);
const chanB = channelGroupKey(random32(), CHANNEL_B, 0);

/** A real sealed+wrapped chat message, opened the way the client opens it. */
async function pinnable(
  text: string,
  author = signer(),
  group = chanA,
  channelId = CHANNEL_A,
  epoch = "0",
) {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content: text,
    tags: [["channel", bytesToHex(channelId)], ["epoch", epoch]],
    pubkey: author.pubkey,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, author);
  const wrap = await wrapSeal(seal, group);
  return { opened: openWrap(wrap, group), author, group };
}

describe("the proof bundle", () => {
  it("verifies author, words, channel and time with NO channel key", async () => {
    const { opened, author } = await pinnable("Hey chat!");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    expect(entry).toBeDefined();

    // The verifier holds only the entry and the channel id — no group key.
    const pin = verifyPinEntry(entry, bytesToHex(CHANNEL_A))!;
    expect(pin).toBeDefined();
    expect(pin.author).toBe(author.pubkey);
    expect(pin.content).toBe("Hey chat!");
    expect(pin.rumorId).toBe(opened.rumorId);
    expect(pin.epoch).toBe("0");
    expect(pin.createdAt).toBe(opened.createdAt);
  });

  it("discloses ONE message: the entry's keys open nothing else in the channel", async () => {
    const a = await pinnable("pinned one");
    const b = await pinnable("still private");
    const entry = buildPinEntry(a.opened, chanA.convKey)!;

    // Swap in the OTHER message's seal, keep the disclosed keys.
    const crossed: PinEntry = { ...entry, seal: b.opened.seal! };
    expect(verifyPinEntry(crossed, bytesToHex(CHANNEL_A)), "a sibling stays sealed").toBeUndefined();
  });

  it("refuses a message from another channel — the cross-channel leak (B1)", async () => {
    // A private channel B message, pinned into channel A's list.
    const { opened } = await pinnable("private to B", signer(), chanB, CHANNEL_B);
    const entry = buildPinEntry(opened, chanB.convKey)!;
    expect(verifyPinEntry(entry, bytesToHex(CHANNEL_B)), "valid in its own list").toBeDefined();
    expect(verifyPinEntry(entry, bytesToHex(CHANNEL_A)), "refused in another channel's list").toBeUndefined();
  });

  it("refuses a rumor with no channel tag at all", async () => {
    const author = signer();
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "unbound", tags: [], pubkey: author.pubkey });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, chanA, author);
    const entry = buildPinEntry(openWrap(await wrapSeal(seal, chanA), chanA), chanA.convKey);
    expect(entry, "build refuses it").toBeUndefined();
  });

  it("refuses an impersonating rumor: seal honestly signed around another author's name", async () => {
    const mallory = signer();
    const alice = signer();
    // Mallory seals a rumor CLAIMING Alice wrote it. The seal signature is
    // genuine (Mallory's), so only the pubkey-equality check catches this.
    // `openWrap` already refuses it at ingest, so a hostile pinner would have
    // to hand-build the entry — which is exactly what this does.
    const forged = buildRumor({
      kind: KIND_MESSAGE,
      content: "Alice said this",
      tags: [["channel", bytesToHex(CHANNEL_A)]],
      pubkey: alice.pubkey,
    });
    const seal = await sealRumor(forged, KIND_SEAL_ENCRYPTED, chanA, mallory);
    const keys = discloseKeysFor(seal.content, chanA.convKey)!;
    const handBuilt = overWire({ seal, keys: encodeMessageKeys(keys) });
    expect(verifyPinEntry(handBuilt, bytesToHex(CHANNEL_A)), "author equality is the only guard here").toBeUndefined();
    // The ingest path refuses it too, from the other direction.
    const wrap = await wrapSeal(seal, chanA);
    expect(() => openWrap(wrap, chanA)).toThrow(/author/);
  });

  it("refuses a tampered seal signature and tampered ciphertext", async () => {
    const { opened } = await pinnable("original");
    const entry = buildPinEntry(opened, chanA.convKey)!;

    const badSig = overWire({ ...entry, seal: { ...entry.seal, sig: "0".repeat(128) } as NostrEvent });
    expect(verifyPinEntry(badSig, bytesToHex(CHANNEL_A))).toBeUndefined();

    // Swap the content for another message's ciphertext: the seal signature no
    // longer covers it, and the disclosed keys were derived from a different nonce.
    const other = await pinnable("different");
    const badContent = overWire({ ...entry, seal: { ...entry.seal, content: other.opened.seal!.content } as NostrEvent });
    expect(verifyPinEntry(badContent, bytesToHex(CHANNEL_A))).toBeUndefined();

    // The honest entry still verifies once it has crossed the wire.
    expect(verifyPinEntry(overWire(entry), bytesToHex(CHANNEL_A))).toBeDefined();
  });

  it("refuses a plaintext seal, a non-chat kind, and malformed keys", async () => {
    const { opened } = await pinnable("x");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    expect(verifyPinEntry({ ...entry, seal: { ...entry.seal, kind: 20014 } as NostrEvent }, bytesToHex(CHANNEL_A))).toBeUndefined();
    expect(verifyPinEntry({ ...entry, keys: "beef" }, bytesToHex(CHANNEL_A))).toBeUndefined();
    expect(verifyPinEntry({ ...entry, keys: entry.keys.toUpperCase() }, bytesToHex(CHANNEL_A))).toBeUndefined();
    expect(verifyPinEntry(entry, "not-a-channel-id")).toBeUndefined();

    // A reaction (kind 7) is verifier-valid nonsense: refused by kind.
    const author = signer();
    const reaction = buildRumor({ kind: 7, content: "+", tags: [["channel", bytesToHex(CHANNEL_A)]], pubkey: author.pubkey });
    const seal = await sealRumor(reaction, KIND_SEAL_ENCRYPTED, chanA, author);
    expect(buildPinEntry(openWrap(await wrapSeal(seal, chanA), chanA), chanA.convKey)).toBeUndefined();
  });

  it("names a still-sending message as PENDING, never as a key problem", async () => {
    // The optimistic send paints a message before its (possibly remote) signer
    // answers, carrying a placeholder seal: empty content, no signature. It is
    // truthy, so a plain presence check waves it into verification, where it
    // fails as unreadable — and told the user their keys were gone when the
    // real answer was "wait a second".
    const { opened } = await pinnable("just sent");
    const placeholder = {
      ...opened,
      seal: { ...opened.seal!, id: "", content: "", sig: "" },
    };
    const { entry, reason } = buildPinEntryOrReason(placeholder, chanA.convKey);
    expect(entry).toBeUndefined();
    expect(reason, "not bad-payload — that message blames the wrong thing").toBe("pending");
    expect(isPlaceholderSeal(placeholder.seal)).toBe(true);
    // A finished seal is not a placeholder, and still pins.
    expect(isPlaceholderSeal(opened.seal)).toBe(false);
    expect(buildPinEntryOrReason(opened, chanA.convKey).entry).toBeDefined();
  });

  it("never throws on hostile input", () => {
    // `null` is the one that used to THROW rather than return undefined — a
    // curator publishing {"entries":[null]} crashed every reader's channel view
    // from inside a render memo.
    for (const junk of [
      null, undefined, 0, "x", [],
      {}, { seal: null }, { seal: {}, keys: "" }, { seal: 5, keys: 5 },
    ] as unknown as PinEntry[]) {
      expect(() => verifyPinEntry(junk, bytesToHex(CHANNEL_A))).not.toThrow();
      expect(verifyPinEntry(junk, bytesToHex(CHANNEL_A))).toBeUndefined();
    }
  });
});

describe("the two content forms", () => {
  const key = (_e: bigint) => chanA.convKey;

  it("public form round-trips plaintext; sealed form round-trips under the channel key", async () => {
    const { opened } = await pinnable("hello");
    const entry = buildPinEntry(opened, chanA.convKey)!;

    const pub = readPinList(serializePublicPinList([entry]), key);
    expect(pub.entries).toHaveLength(1);
    expect(pub.sealed).toBe(false);

    const priv = readPinList(serializeSealedPinList([entry], chanA.convKey, 4n), key);
    expect(priv.entries).toHaveLength(1);
    expect(verifyPinEntry(priv.entries[0], bytesToHex(CHANNEL_A))?.content).toBe("hello");
  });

  it("a sealed list whose epoch key we lack reads as dark, not as a violation", async () => {
    const { opened } = await pinnable("secret");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const content = serializeSealedPinList([entry], chanA.convKey, 4n);
    const out = readPinList(content, () => undefined);
    expect(out).toEqual({ entries: [], sealed: true });
  });

  it("the sealed form declares its epoch as a decimal STRING", async () => {
    const { opened } = await pinnable("x");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const parsed = JSON.parse(serializeSealedPinList([entry], chanA.convKey, 12n));
    expect(parsed.epoch).toBe("12");
    expect(typeof parsed.epoch).toBe("string");
  });
});

describe("entries that don't parse (CORD-04 §7, Vector serde `PinEntry`)", () => {
  it("drops an entry whose `wrap` or `edit` has the wrong type, alone", async () => {
    const { opened } = await pinnable("hello");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const ch = bytesToHex(CHANNEL_A);
    expect(verifyPinEntry({ ...entry, wrap: 5 } as unknown as PinEntry, ch)).toBeUndefined();
    expect(verifyPinEntry({ ...entry, edit: "x" } as unknown as PinEntry, ch)).toBeUndefined();
    expect(verifyPinEntry({ ...entry, wrap: null } as unknown as PinEntry, ch)).toBeDefined();
  });

  it("reads a list carrying an `entries` key as the public form, whatever else it carries", async () => {
    const { opened } = await pinnable("secret");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const sealed = JSON.parse(serializeSealedPinList([entry], chanA.convKey, 4n));
    expect(readPinList(JSON.stringify({ ...sealed, entries: 7 }), () => chanA.convKey)).toEqual({ entries: [], sealed: false });
  });
});

describe("a pinned rumor's shape (Vector `RumorFields`)", () => {
  async function pinOf(mutate: (r: Record<string, unknown>) => void): Promise<PinEntry> {
    const author = signer();
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "x", tags: [["channel", bytesToHex(CHANNEL_A)], ["epoch", "0"]], pubkey: author.pubkey }) as unknown as Record<string, unknown>;
    mutate(rumor);
    const seal = await sealRumor(rumor as never, KIND_SEAL_ENCRYPTED, chanA, author);
    return overWire({ seal, keys: encodeMessageKeys(discloseKeysFor(seal.content, chanA.convKey)!) });
  }

  it("drops an entry whose rumor has a tag that isn't all strings, an empty tag, or a negative time", async () => {
    const ch = bytesToHex(CHANNEL_A);
    expect(verifyPinEntry(await pinOf(() => undefined), ch), "the well-formed baseline verifies").toBeDefined();
    expect(verifyPinEntry(await pinOf((r) => (r.tags as unknown[]).push(["x", 5])), ch)).toBeUndefined();
    expect(verifyPinEntry(await pinOf((r) => (r.tags as unknown[]).push([])), ch)).toBeUndefined();
    expect(verifyPinEntry(await pinOf((r) => { r.created_at = -1; }), ch)).toBeUndefined();
  });

  it("reads a sealed list at an epoch past u64 as empty, not dark", () => {
    const content = JSON.stringify({ epoch: "18446744073709551616", sealed: "AAAA" });
    expect(readPinList(content, () => undefined)).toEqual({ entries: [], sealed: false });
  });
});

describe("structural caps", () => {
  it("a writer refuses to publish past either cap", async () => {
    const { opened } = await pinnable("x");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const tooMany = Array.from({ length: PIN_MAX_ENTRIES + 1 }, () => entry);
    expect(() => serializePublicPinList(tooMany)).toThrow(/25 entries/);
    expect(() => serializeSealedPinList(tooMany, chanA.convKey, 0n)).toThrow(/25 entries/);

    const huge = await pinnable("y".repeat(40_000));
    const bigEntry = buildPinEntry(huge.opened, chanA.convKey)!;
    expect(() => serializePublicPinList([bigEntry])).toThrow(/cap 32768/);
  });

  it("a reader treats a cap-violating edition as an EMPTY list, never a refusal (B2)", async () => {
    const { opened } = await pinnable("x");
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const key = () => chanA.convKey;

    // Hand-built over-length list (a hostile publisher bypassing our writer).
    const overCount = JSON.stringify({ entries: Array.from({ length: PIN_MAX_ENTRIES + 1 }, () => entry) });
    expect(readPinList(overCount, key)).toEqual({ entries: [], sealed: false });

    const overBytes = JSON.stringify({ entries: [entry], pad: "z".repeat(PIN_MAX_CONTENT_BYTES) });
    expect(readPinList(overBytes, key)).toEqual({ entries: [], sealed: false });

    // Junk and unknown shapes read empty too — never an exception.
    for (const junk of ["", "{", "null", "[]", '{"nope":1}']) {
      expect(() => readPinList(junk, key)).not.toThrow();
      expect(readPinList(junk, key).entries).toEqual([]);
    }
  });

  it("the entry cap governs the public form; the byte cap governs the sealed one", async () => {
    // Measured, not assumed: an entry's floor is ~1.1 KB (seal id + pubkey +
    // sig + the NIP-44 payload + the 76-byte disclosure), so a typical ~135
    // character pin runs ~1.3 KB. 25 of those fill the public form almost
    // exactly, while the sealed form's base64 + padding live INSIDE the same
    // cap and bind far sooner.
    const entries: PinEntry[] = [];
    for (let i = 0; i < PIN_MAX_ENTRIES; i++) {
      const { opened } = await pinnable(`Announcement ${i}: ${"x".repeat(120)}`);
      entries.push(buildPinEntry(opened, chanA.convKey)!);
    }
    const publicBytes = new TextEncoder().encode(serializePublicPinList(entries)).length;
    expect(publicBytes, "a full 25 fits the public form").toBeLessThanOrEqual(PIN_MAX_CONTENT_BYTES);
    expect(publicBytes).toBeGreaterThan(PIN_MAX_CONTENT_BYTES * 0.9); // and only just

    // The sealed form refuses the same 25 — the byte cap is the real ceiling.
    expect(() => serializeSealedPinList(entries, chanA.convKey, 0n)).toThrow(/cap 32768/);
    // …and accepts a smaller list.
    const fifteen = entries.slice(0, 15);
    expect(() => serializeSealedPinList(fifteen, chanA.convKey, 0n)).not.toThrow();
    const sealedBytes = new TextEncoder().encode(serializeSealedPinList(fifteen, chanA.convKey, 0n)).length;
    const publicFifteen = new TextEncoder().encode(serializePublicPinList(fifteen)).length;
    expect(sealedBytes, "sealing inflates ~1.4x inside the cap").toBeGreaterThan(publicFifteen);
  });
});

describe("deletion (§7)", () => {
  it("an author's own delete kills their pin; a stranger's does not", async () => {
    const alice = signer();
    const { opened } = await pinnable("delete me", alice);
    const pin = verifyPinEntry(buildPinEntry(opened, chanA.convKey)!, bytesToHex(CHANNEL_A))!;

    const selfDelete = { author: alice.pubkey, tags: [["e", pin.rumorId]] };
    const strangerDelete = { author: signer().pubkey, tags: [["e", pin.rumorId]] };
    const wrongTarget = { author: alice.pubkey, tags: [["e", "f".repeat(64)]] };

    expect(pinKilledBy(pin, selfDelete)).toBe(true);
    expect(pinKilledBy(pin, strangerDelete), "only the proven author may erase").toBe(false);
    expect(pinKilledBy(pin, wrongTarget)).toBe(false);
  });

  it("matching uses the RECOMPUTED id, so a lying embedded id cannot dodge a delete", async () => {
    const alice = signer();
    const { opened } = await pinnable("delete me", alice);
    const entry = buildPinEntry(opened, chanA.convKey)!;
    const pin = verifyPinEntry(entry, bytesToHex(CHANNEL_A))!;
    // The true id is the hash of the decrypted rumor, not anything self-declared.
    expect(pin.rumorId).toBe(
      getEventHash({
        kind: pin.kind,
        content: pin.content,
        tags: pin.tags,
        created_at: pin.createdAt,
        pubkey: alice.pubkey,
      }),
    );
    expect(pin.rumorId).toBe(opened.rumorId);
  });

  it("partitions a list into living and killed pins", async () => {
    const alice = signer();
    const a = await pinnable("gone", alice);
    const b = await pinnable("stays", signer());
    const pins = [
      verifyPinEntry(buildPinEntry(a.opened, chanA.convKey)!, bytesToHex(CHANNEL_A))!,
      verifyPinEntry(buildPinEntry(b.opened, chanA.convKey)!, bytesToHex(CHANNEL_A))!,
    ];
    const { alive, killed } = partitionDeletedPins(pins, [{ author: alice.pubkey, tags: [["e", pins[0].rumorId]] }]);
    expect(killed.map((p) => p.content)).toEqual(["gone"]);
    expect(alive.map((p) => p.content)).toEqual(["stays"]);
  });
});

describe("edits (§7)", () => {
  /** A real kind-3302 Edit rumor targeting `targetId`, sealed for chanA. */
  async function editOf(targetId: string, text: string, author: ReturnType<typeof signer>, group = chanA, channelId = CHANNEL_A) {
    const rumor = buildRumor({
      kind: KIND_EDIT,
      content: text,
      tags: [["channel", bytesToHex(channelId)], ["epoch", "0"], ["e", targetId]],
      pubkey: author.pubkey,
    });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, author);
    return openWrap(await wrapSeal(seal, group), group);
  }

  it("a proven edit supersedes the original's words, for a reader with no keys", async () => {
    const alice = signer();
    const { opened } = await pinnable("frist post", alice);
    const base = buildPinEntry(opened, chanA.convKey)!;
    const edit = await editOf(opened.rumorId, "first post", alice);

    const entry = overWire(withProvenEdit(base, edit, chanA.convKey));
    expect(entry.edit, "the bundle rode along").toBeDefined();

    const pin = verifyPinEntry(entry, bytesToHex(CHANNEL_A))!;
    expect(pin.content, "renders the revision").toBe("first post");
    expect(pin.edited?.content).toBe("first post");
    expect(pin.rumorId, "identity stays the ORIGINAL — deletes still match").toBe(opened.rumorId);
    expect(pin.author).toBe(alice.pubkey);
  });

  it("refuses an edit from anyone but the original's author", async () => {
    const alice = signer();
    const mallory = signer();
    const { opened } = await pinnable("alice's words", alice);
    const base = buildPinEntry(opened, chanA.convKey)!;
    const forged = await editOf(opened.rumorId, "mallory's rewrite", mallory);

    // The builder refuses to attach it…
    expect(withProvenEdit(base, forged, chanA.convKey).edit).toBeUndefined();
    // …and a reader handed one anyway drops the EDIT, never the pin.
    const seal = forged.seal!;
    const keys = encodeMessageKeys(discloseKeysFor(seal.content, chanA.convKey)!);
    const smuggled = overWire({ ...base, edit: { seal, keys } });
    const pin = verifyPinEntry(smuggled, bytesToHex(CHANNEL_A))!;
    expect(pin, "the pin survives").toBeDefined();
    expect(pin.content, "the forgery does not").toBe("alice's words");
    expect(pin.edited).toBeUndefined();
  });

  it("refuses an edit sealed in another channel (step 4 applies to the bundle too)", async () => {
    const alice = signer();
    const { opened } = await pinnable("in channel A", alice);
    const base = buildPinEntry(opened, chanA.convKey)!;
    // A genuine Edit by the same author, targeting the same rumor — but sealed
    // in channel B and naming B's id. A reader must be no weaker than the
    // writer, which already refuses this.
    const foreign = await editOf(opened.rumorId, "revised elsewhere", alice, chanB, CHANNEL_B);
    const seal = foreign.seal!;
    const keys = encodeMessageKeys(discloseKeysFor(seal.content, chanB.convKey)!);
    const smuggled = overWire({ ...base, edit: { seal, keys } });
    const pin = verifyPinEntry(smuggled, bytesToHex(CHANNEL_A))!;
    expect(pin, "the pin survives").toBeDefined();
    expect(pin.content, "the foreign edit does not apply").toBe("in channel A");
    expect(pin.edited).toBeUndefined();
  });

  it("refuses an edit aimed at a different message", async () => {
    const alice = signer();
    const a = await pinnable("message A", alice);
    const b = await pinnable("message B", alice);
    const base = buildPinEntry(a.opened, chanA.convKey)!;
    const wrongTarget = await editOf(b.opened.rumorId, "edit of B", alice);
    expect(withProvenEdit(base, wrongTarget, chanA.convKey).edit).toBeUndefined();
  });

  it("refuses a non-edit kind smuggled into the edit slot", async () => {
    const alice = signer();
    const { opened } = await pinnable("original", alice);
    const base = buildPinEntry(opened, chanA.convKey)!;
    // A plain chat message, not a kind-3302 edit.
    const notAnEdit = await pinnable("pretending to be an edit", alice);
    const seal = notAnEdit.opened.seal!;
    const keys = encodeMessageKeys(discloseKeysFor(seal.content, chanA.convKey)!);
    const pin = verifyPinEntry(overWire({ ...base, edit: { seal, keys } }), bytesToHex(CHANNEL_A))!;
    expect(pin.content).toBe("original");
    expect(pin.edited).toBeUndefined();
  });

  it("a later edit REPLACES rather than appends, so cost stays flat", async () => {
    const alice = signer();
    const { opened } = await pinnable("v1", alice);
    let entry = buildPinEntry(opened, chanA.convKey)!;
    const sizes: number[] = [];
    for (const [i, text] of ["v2", "v3", "v4"].entries()) {
      const edit = await editOf(opened.rumorId, text, alice);
      entry = withProvenEdit(entry, edit, chanA.convKey);
      sizes.push(new TextEncoder().encode(JSON.stringify(entry)).length);
      expect(verifyPinEntry(overWire(entry), bytesToHex(CHANNEL_A))?.content).toBe(text);
      expect(Object.keys(entry.edit ?? {}), `edit ${i} is a single bundle`).toEqual(["seal", "keys"]);
    }
    // Three edits, one bundle: the entry never grows.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(20);
  });

  it("a bad edit bundle never costs the pin its proof", () => {
    // Garbage in the edit slot is dropped alone.
    const junk = { seal: null, keys: "zz" } as unknown as PinEntry["edit"];
    expect(() => verifyPinEntry({ seal: {} as never, keys: "", edit: junk }, bytesToHex(CHANNEL_A))).not.toThrow();
  });
});

describe("pin failure reasons", () => {
  it("separates a key we do not hold from a proof that does not hold up", async () => {
    const { opened } = await pinnable("gm");
    // The key expansion succeeds under ANY conversation key, so holding the
    // wrong epoch's key yields a well-formed disclosure that opens nothing.
    // The pinner must be told that, not told their proof is broken.
    expect(buildPinEntryOrReason(opened, chanB.convKey).reason, "wrong epoch").toBe("bad-payload");
    expect(buildPinEntryOrReason(opened, chanA.convKey).entry, "our own epoch").toBeDefined();
    expect(buildPinEntryOrReason({ ...opened, seal: undefined }, chanA.convKey).reason).toBe("no-seal");
  });
});

describe("unconfirmed writes", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const mine = { eid: A, version: 5n, held: "ours" };

  it("keeps our own list until the fold reaches that version", () => {
    expect(unconfirmedWrite(mine, undefined, A), "fold has nothing yet").toBe("ours");
    expect(unconfirmedWrite(mine, { version: 4n }, A), "fold is behind").toBe("ours");
    expect(unconfirmedWrite(mine, { version: 5n }, A), "fold caught up").toBeUndefined();
  });

  it("yields to a version beyond ours, which is someone else's write", () => {
    // Ours is no longer the list that exists, so building on it would erase
    // whatever they just published.
    expect(unconfirmedWrite(mine, { version: 6n }, A)).toBeUndefined();
  });

  it("never lends one channel's list to another", () => {
    // The hazard this guards: pinning in a private channel, switching to a
    // public one, and publishing the private list — and the per-message keys
    // that open it — into the public channel's entity, forever.
    expect(unconfirmedWrite(mine, undefined, B), "another channel").toBeUndefined();
    expect(unconfirmedWrite(mine, { version: 1n }, B)).toBeUndefined();
    expect(unconfirmedWrite(mine, undefined, undefined), "no channel at all").toBeUndefined();
  });

  it("holds nothing when this client has not written", () => {
    expect(unconfirmedWrite(undefined, { version: 3n }, A)).toBeUndefined();
    expect(unconfirmedWrite(undefined, undefined, A)).toBeUndefined();
  });
});
