import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildDmEditRumors,
  buildDmRumor,
  dmChatTags,
  dmDeleteTags,
  dmExpiresAt,
  dmReactionTags,
  dmTimerSeconds,
  dmTimerTags,
  dmTypingTags,
  DM_RUMOR_KINDS,
  expirationOf,
  isExpired,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_REACTION,
  KIND_DM_TYPING,
  KIND_DM_WRAP,
  KIND_DM_WRAP_EPHEMERAL,
  MAX_WRAP_BACKDATE_SECS,
  openDmWrap,
  sealDmRumor,
  sortDmThread,
  wrapDmSeal,
  wrapDmSealEphemeral,
  type Dm17Signer,
} from "@/lib/nip17/protocol";
import { dmConvKey, dmConvPeers, dmPeersOf, isDmGroupKey } from "@/lib/nip17/conversation";

/** A raw-key signer exposing the abstract surface NIP-17 sends/opens need. */
function rawSigner(sk: Uint8Array): Dm17Signer {
  return {
    signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
    nip44: {
      encrypt: async (pubkey: string, plaintext: string) =>
        nip44Encrypt(plaintext, getConversationKey(sk, pubkey)),
      decrypt: async (pubkey: string, ciphertext: string) =>
        nip44Decrypt(ciphertext, getConversationKey(sk, pubkey)),
    },
  };
}

describe("NIP-17 seal + wrap round trip", () => {
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);

  it("round-trips a chat rumor through an ephemeral wrap (vanilla NIP-17)", async () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "hola, que tal?",
      tags: dmChatTags([recipientPk]),
      pubkey: senderPk,
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = await wrapDmSeal(seal, recipientPk);

    expect(wrap.kind).toBe(KIND_DM_WRAP);
    expect(wrap.tags).toContainEqual(["p", recipientPk]);
    // Ephemeral author: not the sender, not the conversation key.
    expect(wrap.pubkey).not.toBe(senderPk);

    const opened = await openDmWrap(wrap, rawSigner(recipientSk), recipientPk);
    expect(opened).toBeDefined();
    expect(opened!.rumorId).toBe(rumor.id);
    expect(opened!.author).toBe(senderPk);
    expect(opened!.content).toBe("hola, que tal?");
    expect(opened!.kind).toBe(KIND_DM_CHAT);
    expect(opened!.peers).toEqual([senderPk]); // received: the sender
    expect(opened!.wrapId).toBe(wrap.id);
  });

  it("attributes the SELF copy to the peer via the rumor's p tag", async () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "self copy",
      tags: dmChatTags([recipientPk]),
      pubkey: senderPk,
    });
    const selfSeal = await sealDmRumor(rumor, senderPk, rawSigner(senderSk));
    const selfWrap = await wrapDmSeal(selfSeal, senderPk);

    const opened = await openDmWrap(selfWrap, rawSigner(senderSk), senderPk);
    expect(opened?.author).toBe(senderPk);
    expect(opened?.peers).toEqual([recipientPk]);
  });

  it("backdates the wrap and seal within the NIP-59 window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "x", tags: dmChatTags([recipientPk]), pubkey: senderPk });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = await wrapDmSeal(seal, recipientPk);
    for (const ts of [seal.created_at, wrap.created_at]) {
      expect(ts).toBeLessThanOrEqual(now + 1);
      expect(ts).toBeGreaterThanOrEqual(now - MAX_WRAP_BACKDATE_SECS - 1);
    }
    // The rumor keeps its real time.
    expect(rumor.created_at).toBeGreaterThanOrEqual(now - 1);
  });

  it("adds the first-contact k hint only when asked", async () => {
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "hi", tags: dmChatTags([recipientPk]), pubkey: senderPk });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const first = await wrapDmSeal(seal, recipientPk, { firstContact: true });
    const later = await wrapDmSeal(seal, recipientPk);
    expect(first.tags).toContainEqual(["k", "14"]);
    expect(later.tags.some(([n]) => n === "k")).toBe(false);
  });

  it("rejects a rumor whose claimed pubkey differs from the seal author", async () => {
    const impostorPk = getPublicKey(generateSecretKey());
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "spoof",
      tags: dmChatTags([recipientPk]),
      pubkey: impostorPk, // claims someone else
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk)); // sealed by sender
    const wrap = await wrapDmSeal(seal, recipientPk);
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("rejects a rumor with a lying id", async () => {
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "real", tags: dmChatTags([recipientPk]), pubkey: senderPk });
    const tampered = { ...rumor, content: "tampered" }; // id no longer matches
    const signer = rawSigner(senderSk);
    const seal = await signer.signEvent({
      kind: 13,
      content: await signer.nip44!.encrypt(recipientPk, JSON.stringify(tampered)),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    const wrap = await wrapDmSeal(seal, recipientPk);
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("yields undefined for a wrap addressed to someone else", async () => {
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "not yours", tags: dmChatTags([recipientPk]), pubkey: senderPk });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = await wrapDmSeal(seal, recipientPk);
    const strangerSk = generateSecretKey();
    expect(await openDmWrap(wrap, rawSigner(strangerSk), getPublicKey(strangerSk))).toBeUndefined();
  });

  it("rejects a far-future rumor", async () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "from the future",
      tags: dmChatTags([recipientPk]),
      pubkey: senderPk,
      createdAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = await wrapDmSeal(seal, recipientPk);
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });
});

describe("rumor tag builders + peer attribution", () => {
  const self = getPublicKey(generateSecretKey());
  const peer = getPublicKey(generateSecretKey());

  it("builds reaction and delete tags with the peer leading", () => {
    expect(dmReactionTags([peer], "eid", KIND_DM_CHAT)).toEqual([
      ["p", peer],
      ["e", "eid"],
      ["k", "14"],
    ]);
    expect(dmDeleteTags([peer], "rid", KIND_DM_REACTION)).toEqual([
      ["p", peer],
      ["e", "rid"],
      ["k", "7"],
    ]);
  });

  it("resolves the conversation partner for sent and received rumors", () => {
    expect(dmPeersOf({ pubkey: peer, tags: [["p", self]] }, self)).toEqual([peer]);
    expect(
      dmPeersOf({ pubkey: self, tags: dmReactionTags([peer], "eid", KIND_DM_CHAT) }, self),
    ).toEqual([peer]);
    expect(dmPeersOf({ pubkey: self, tags: [] }, self)).toBeUndefined();
  });

  it("keeps delete rumors attributable", () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([peer], "target", KIND_DM_CHAT),
      pubkey: self,
    });
    expect(dmPeersOf(rumor, self)).toEqual([peer]);
  });

  it("builds an edit as a same-time replacement plus a tombstone", () => {
    const original = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "before",
      tags: dmChatTags([peer], {
        replyTo: "parent",
        extraTags: [["q", "quoted"], ["edited", "100"]],
        expiresAt: 2_000_000_000,
      }),
      pubkey: self,
      createdAt: 1_700_000_000,
    });

    const { replacement, deletion } = buildDmEditRumors(
      original,
      [peer],
      "after",
      1_700_000_500,
    );

    expect(replacement).toMatchObject({
      kind: KIND_DM_CHAT,
      content: "after",
      pubkey: self,
      created_at: original.created_at,
    });
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.tags).toEqual([
      ["p", peer],
      ["e", "parent"],
      ["q", "quoted"],
      ["expiration", "2000000000"],
      ["edited", "1700000500"],
    ]);
    expect(deletion).toMatchObject({
      kind: KIND_DM_DELETE,
      content: "",
      pubkey: self,
      created_at: 1_700_000_500,
      tags: [["p", peer], ["e", original.id], ["k", "14"]],
    });
  });

  it("refuses to edit a non-chat rumor", () => {
    const reaction = buildDmRumor({
      kind: KIND_DM_REACTION,
      content: "+",
      tags: dmReactionTags([peer], "target", KIND_DM_CHAT),
      pubkey: self,
    });
    expect(() => buildDmEditRumors(reaction, [peer], "changed")).toThrow(
      "Only NIP-17 chat messages can be edited",
    );
  });
});

describe("disappearing messages (NIP-40)", () => {
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);

  const now = () => Math.floor(Date.now() / 1000);

  /** A chat rumor expiring `inSecs` from now (negative = already expired). */
  function expiringRumor(inSecs: number) {
    return buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "this will vanish",
      tags: dmChatTags([recipientPk], { expiresAt: now() + inSecs }),
      pubkey: senderPk,
    });
  }

  it("stamps the deadline on the rumor, the seal AND the wrap", async () => {
    const rumor = expiringRumor(600);
    const deadline = expirationOf(rumor.tags);
    // Tolerant: `expiringRumor` read the clock a moment ago, and re-reading it
    // here races the wall-clock second ticking over mid-test.
    expect(deadline).toBeGreaterThanOrEqual(now() + 599);
    expect(deadline).toBeLessThanOrEqual(now() + 600);

    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = await wrapDmSeal(seal, recipientPk);

    // The outer tag is the only one a relay can act on; the inner two are what
    // this client enforces after decryption.
    expect(expirationOf(seal.tags)).toBe(deadline);
    expect(expirationOf(wrap.tags)).toBe(deadline);
  });

  it("round-trips an unexpired disappearing message", async () => {
    const rumor = expiringRumor(600);
    const wrap = await wrapDmSeal(await sealDmRumor(rumor, recipientPk, rawSigner(senderSk)), recipientPk);

    const opened = await openDmWrap(wrap, rawSigner(recipientSk), recipientPk);
    expect(opened).toBeDefined();
    // Against the deadline the rumor actually carries — recomputing it from a
    // fresh `now()` races the second ticking over between build and assertion.
    expect(dmExpiresAt(opened!)).toBe(expirationOf(rumor.tags));
  });

  it("rejects an envelope whose deadline has passed", async () => {
    const rumor = expiringRumor(-1);
    const wrap = await wrapDmSeal(await sealDmRumor(rumor, recipientPk, rawSigner(senderSk)), recipientPk);

    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("rejects an expired rumor even when the wrap and seal were left unstamped", async () => {
    // A sender (or a relay-friendly repacker) that strips the outer tags must
    // not be able to smuggle an expired message past us.
    const rumor = expiringRumor(-1);
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const bare = { ...seal, tags: [] };
    const wrap = await wrapDmSeal(bare, recipientPk);
    expect(wrap.tags.some(([n]) => n === "expiration")).toBe(false);

    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("keeps a disappearing message's plaintext out of the signer's decrypt cache", async () => {
    const seen: Array<boolean | undefined> = [];
    const base = rawSigner(recipientSk);
    const spy: Dm17Signer = {
      ...base,
      nip44: {
        encrypt: base.nip44!.encrypt,
        decrypt: (pk, ct, opts) => {
          seen.push(opts?.cache);
          return base.nip44!.decrypt(pk, ct);
        },
      },
    };

    const expiring = await wrapDmSeal(
      await sealDmRumor(expiringRumor(600), recipientPk, rawSigner(senderSk)),
      recipientPk,
    );
    expect(await openDmWrap(expiring, spy, recipientPk)).toBeDefined();
    // Both the wrap→seal and seal→rumor decrypts opt out.
    expect(seen).toEqual([false, false]);

    // An ordinary DM still gets cached.
    seen.length = 0;
    const plain = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "ordinary",
      tags: dmChatTags([recipientPk]),
      pubkey: senderPk,
    });
    const ordinary = await wrapDmSeal(await sealDmRumor(plain, recipientPk, rawSigner(senderSk)), recipientPk);
    expect(await openDmWrap(ordinary, spy, recipientPk)).toBeDefined();
    expect(seen).toEqual([true, true]);
  });

  it("never stamps a delete or a timer change", () => {
    expect(dmDeleteTags([recipientPk], "rid", KIND_DM_CHAT).some(([n]) => n === "expiration")).toBe(false);
    expect(dmTimerTags([recipientPk], 86400).some(([n]) => n === "expiration")).toBe(false);
  });

  it("round-trips the timer value and refuses to guess at a malformed one", () => {
    expect(dmTimerTags([recipientPk], 86400)).toEqual([["p", recipientPk], ["timer", "86400"]]);
    expect(dmTimerSeconds({ tags: dmTimerTags([recipientPk], 0) })).toBe(0);
    expect(dmTimerSeconds({ tags: dmTimerTags([recipientPk], 86400) })).toBe(86400);
    // Missing / unparseable / negative are "unknown", never "off".
    expect(dmTimerSeconds({ tags: [["p", recipientPk]] })).toBeUndefined();
    expect(dmTimerSeconds({ tags: [["timer", "soon"]] })).toBeUndefined();
    expect(dmTimerSeconds({ tags: [["timer", "-5"]] })).toBeUndefined();
  });

  it("treats a malformed expiration as absent rather than as expired", () => {
    expect(expirationOf([["expiration", "nonsense"]])).toBeUndefined();
    expect(isExpired([["expiration", "nonsense"]])).toBe(false);
    expect(isExpired([["expiration", String(now() - 1)]])).toBe(true);
    expect(isExpired([["expiration", String(now() + 60)]])).toBe(false);
  });
});

describe("typing indicators (ephemeral plane)", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);

  function typingWrap() {
    const rumor = buildDmRumor({
      kind: KIND_DM_TYPING,
      content: "",
      tags: dmTypingTags([recipientPk]),
      pubkey: senderPk,
    });
    return { rumor, seal: sealDmRumor(rumor, recipientPk, rawSigner(senderSk)) };
  }

  it("wraps a typing rumor in a kind-21059 ephemeral wrap and round-trips it", async () => {
    const { rumor, seal } = typingWrap();
    const wrap = await wrapDmSealEphemeral(await seal, recipientPk);

    expect(wrap.kind).toBe(KIND_DM_WRAP_EPHEMERAL);
    expect(wrap.tags).toEqual([["p", recipientPk]]);
    // Same NIP-59 anonymity as a durable wrap: a throwaway author.
    expect(wrap.pubkey).not.toBe(senderPk);

    const opened = await openDmWrap(wrap, rawSigner(recipientSk), recipientPk, {
      wrapKind: KIND_DM_WRAP_EPHEMERAL,
    });
    expect(opened).toBeDefined();
    expect(opened!.kind).toBe(KIND_DM_TYPING);
    expect(opened!.author).toBe(senderPk);
    expect(opened!.peers).toEqual([senderPk]);
    expect(opened!.content).toBe("");
    expect(opened!.rumorId).toBe(rumor.id);
  });

  it("is NOT backdated — a stale signal must be detectable as stale", async () => {
    const { seal } = typingWrap();
    const wrap = await wrapDmSealEphemeral(await seal, recipientPk);
    // wrapDmSeal randomizes up to 2 days into the past; this one is now.
    expect(Math.abs(wrap.created_at - now())).toBeLessThanOrEqual(2);
  });

  it("carries no expiration tag on any layer", async () => {
    const { seal } = typingWrap();
    const resolved = await seal;
    const wrap = await wrapDmSealEphemeral(resolved, recipientPk);
    expect(dmTypingTags([recipientPk]).some(([n]) => n === "expiration")).toBe(false);
    expect(expirationOf(resolved.tags)).toBeUndefined();
    expect(expirationOf(wrap.tags)).toBeUndefined();
  });

  it("does not open an ephemeral wrap through the durable (default) path", async () => {
    const { seal } = typingWrap();
    const wrap = await wrapDmSealEphemeral(await seal, recipientPk);
    // The inbox sync opens with the default wrapKind, so a typing signal can
    // never be mistaken for a message and land in the rumor store.
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("does not open a durable wrap through the ephemeral path", async () => {
    const { seal } = typingWrap();
    const wrap = await wrapDmSeal(await seal, recipientPk);
    expect(
      await openDmWrap(wrap, rawSigner(recipientSk), recipientPk, {
        wrapKind: KIND_DM_WRAP_EPHEMERAL,
      }),
    ).toBeUndefined();
  });

  it("keeps the typing kind out of the stored/folded rumor set", () => {
    expect(DM_RUMOR_KINDS).not.toContain(KIND_DM_TYPING);
  });
});

describe("group conversations", () => {
  const self = "1".repeat(64);
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  const carol = "c".repeat(64);

  // The whole design rests on this: the group rule must reduce to EXACTLY the
  // old single-peer rule for one participant, or changing the derivation
  // re-files every 1:1 already on disk (the peer is never stored — it is
  // re-derived on every read).
  it("reduces to the old single-peer key for a 1:1", () => {
    expect(dmConvKey(dmPeersOf({ pubkey: alice, tags: [["p", self]] }, self)!)).toBe(alice);
    expect(dmConvKey(dmPeersOf({ pubkey: self, tags: [["p", alice]] }, self)!)).toBe(alice);
    // Note to Self keeps its own key too.
    expect(dmConvKey(dmPeersOf({ pubkey: self, tags: [["p", self]] }, self)!)).toBe(self);
  });

  it("agrees on the conversation from either side", () => {
    // Alice writes to the room {self, bob}; we reply to {alice, bob}. Both are
    // the same conversation and must key the same.
    const received = dmPeersOf({ pubkey: alice, tags: [["p", self], ["p", bob]] }, self);
    const sent = dmPeersOf({ pubkey: self, tags: dmChatTags([alice, bob]) }, self);
    expect(received).toEqual([alice, bob].sort());
    expect(sent).toEqual([alice, bob].sort());
    expect(dmConvKey(received!)).toBe(dmConvKey(sent!));
  });

  it("canonicalizes order and de-duplicates, so one room has one key", () => {
    const a = dmPeersOf({ pubkey: self, tags: dmChatTags([carol, alice, bob]) }, self);
    const b = dmPeersOf({ pubkey: self, tags: dmChatTags([bob, carol, alice, bob]) }, self);
    expect(a).toEqual(b);
    expect(dmConvKey(a!)).toBe([alice, bob, carol].sort().join(","));
  });

  it("never counts the viewer among their own peers", () => {
    // A sender that p-tags the whole room, us included.
    expect(dmPeersOf({ pubkey: alice, tags: [["p", self], ["p", alice], ["p", bob]] }, self))
      .toEqual([alice, bob].sort());
  });

  it("still refuses an own copy that names no room", () => {
    // Unattributable: unchanged from the single-peer rule, and openDmWrap drops
    // it rather than filing it under a guess.
    expect(dmPeersOf({ pubkey: self, tags: [] }, self)).toBeUndefined();
    expect(dmPeersOf({ pubkey: self, tags: [["e", "x"]] }, self)).toBeUndefined();
  });

  // A `p` value is whatever the sender typed. Everything downstream assumes a
  // pubkey: the terms concatenate participants with nothing, the key joins them
  // with `,`, and the key becomes a URL path — on Android the deep link a
  // notification tap follows, where a `?` in a participant hands the router a
  // query string of the sender's choosing.
  it("ignores a `p` value that is not a pubkey", () => {
    const evil = "z?call=" + "f".repeat(57);
    expect(evil).toHaveLength(64); // right length, wrong alphabet
    expect(dmPeersOf({ pubkey: alice, tags: [["p", self], ["p", evil]] }, self)).toEqual([alice]);
    // Uppercase hex is a different spelling of the same key and would fork the
    // conversation in two; the wire form is lowercase.
    expect(dmPeersOf({ pubkey: alice, tags: [["p", bob.toUpperCase()]] }, self)).toEqual([alice]);
    // Too short, too long, and an npub.
    for (const bad of ["ab", "a".repeat(63), "a".repeat(65), `npub1${"q".repeat(58)}`]) {
      expect(dmPeersOf({ pubkey: alice, tags: [["p", self], ["p", bad]] }, self)).toEqual([alice]);
    }
  });

  it("cannot be made to name a room whose key is not a list of pubkeys", () => {
    const evil = "z?call=" + "f".repeat(57);
    const peers = dmPeersOf({ pubkey: alice, tags: [["p", self], ["p", evil]] }, self)!;
    const key = dmConvKey(peers);
    expect(key).toBe(alice);
    expect(dmConvPeers(key).every((p) => /^[0-9a-f]{64}$/.test(p))).toBe(true);
    // A crafted value sorts after every real pubkey (`z` > `f`), so unfiltered
    // it would sit LAST and leave a genuine pubkey where a route's first
    // segment is read — the injection is invisible to anything checking only
    // the leading participant.
    expect(key).not.toContain("?");
  });

  it("drops an own copy whose only `p` values are malformed", () => {
    expect(dmPeersOf({ pubkey: self, tags: [["p", "nonsense"]] }, self)).toBeUndefined();
  });

  it("round-trips a key through its participants", () => {
    const key = dmConvKey([alice, bob]);
    expect(dmConvPeers(key)).toEqual([alice, bob]);
    expect(isDmGroupKey(key)).toBe(true);
    expect(isDmGroupKey(alice)).toBe(false);
  });

  it("puts one `p` per recipient on every rumor shape", () => {
    expect(dmChatTags([alice, bob]).filter(([n]) => n === "p")).toEqual([
      ["p", alice],
      ["p", bob],
    ]);
    expect(dmReactionTags([alice, bob], "eid", KIND_DM_CHAT).filter(([n]) => n === "p")).toEqual([
      ["p", alice],
      ["p", bob],
    ]);
    expect(dmDeleteTags([alice, bob], "eid", KIND_DM_CHAT).filter(([n]) => n === "p")).toEqual([
      ["p", alice],
      ["p", bob],
    ]);
    expect(dmTimerTags([alice, bob], 60).filter(([n]) => n === "p")).toEqual([
      ["p", alice],
      ["p", bob],
    ]);
  });

  it("keeps a reaction and a delete in the same conversation as their target", () => {
    const room = [alice, bob];
    const chat = { pubkey: self, tags: dmChatTags(room) };
    const reaction = { pubkey: self, tags: dmReactionTags(room, "eid", KIND_DM_CHAT) };
    const del = { pubkey: self, tags: dmDeleteTags(room, "eid", KIND_DM_CHAT) };
    const key = dmConvKey(dmPeersOf(chat, self)!);
    expect(dmConvKey(dmPeersOf(reaction, self)!)).toBe(key);
    expect(dmConvKey(dmPeersOf(del, self)!)).toBe(key);
  });
});

describe("thread order (sortDmThread)", () => {
  const row = (rumorId: string, author: string, createdAt: number, arrivedAt?: number) => ({ rumorId, author, createdAt, arrivedAt });

  it("never puts a sender's later message above their earlier one when only one was timed by arrival", () => {
    // A took 4 s to arrive (past the skew threshold); B, written after it, arrived quickly.
    const rows = [row("b", "peer", 102), row("a", "peer", 100, 104)];
    expect(sortDmThread(rows).map((r) => r.rumorId)).toEqual(["a", "b"]);
  });

  it("still lifts a slow clock's message above a reply it arrived before", () => {
    const rows = [row("mine", "self", 200), row("theirs", "peer", 100, 199)];
    expect(sortDmThread(rows).map((r) => r.rumorId)).toEqual(["theirs", "mine"]);
  });

  it("places other authors by the raised time", () => {
    const rows = [row("b", "peer", 102), row("a", "peer", 100, 106), row("mine", "self", 105)];
    expect(sortDmThread(rows).map((r) => r.rumorId)).toEqual(["mine", "a", "b"]);
  });
});
