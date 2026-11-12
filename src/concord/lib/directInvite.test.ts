import { IDBFactory } from "fake-indexeddb";
import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { bytesToHex, communityIdOf, hex32, random32 } from "@/concord/lib/derive";
import {
  buildDirectInviteRumor,
  directInviteExpired,
  isCatchUpBundle,
  parseDirectInviteRumor,
  sealDirectInvite,
  unwrapDirectInvite,
  wrapDirectInvite,
  type DirectInviteSigner,
} from "@/concord/lib/directInvite";
import {
  advanceInviteInboxCursor,
  inviteInboxSince,
  queryStoredInvites,
  storedToInvite,
  unwrappedToStored,
  writeStoredInvites,
  WRAP_BACKDATE_SECS,
} from "@/concord/lib/inviteInbox";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord/lib/kinds";
import type { InviteBundle } from "@/concord/lib/invite";

// A clean IndexedDB for the suite (the store singleton opens against it lazily).
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

/** A raw-key signer exposing the abstract surface a direct invite needs. */
function rawSigner(sk: Uint8Array): DirectInviteSigner {
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

function makeBundle(overrides?: Partial<InviteBundle>): InviteBundle {
  const ownerHex = bytesToHex(random32());
  const salt = random32();
  return {
    community_id: bytesToHex(communityIdOf(hex32(ownerHex), salt)),
    owner: ownerHex,
    owner_salt: bytesToHex(salt),
    community_root: bytesToHex(random32()),
    root_epoch: 0,
    channels: [],
    relays: ["wss://a.example"],
    name: "Test community",
    ...overrides,
  };
}

async function eventually<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("direct invites (CORD-05 §6)", () => {
  it("round-trips build → seal → wrap → unwrap → parse", async () => {
    const inviterSk = generateSecretKey();
    const inviterPk = getPublicKey(inviterSk);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    const bundle = makeBundle();
    const rumor = buildDirectInviteRumor(bundle, inviterPk);
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    expect(seal.kind).toBe(13);
    expect(seal.pubkey).toBe(inviterPk);

    const wrap = await wrapDirectInvite(seal, recipientPk);
    expect(wrap.kind).toBe(KIND_WRAP);
    // Classic NIP-59: ephemeral author, fixed recipient — plus the k index hint.
    expect(wrap.pubkey).not.toBe(inviterPk);
    expect(wrap.tags).toContainEqual(["p", recipientPk]);
    expect(wrap.tags).toContainEqual(["k", String(KIND_DIRECT_INVITE)]);
    // NIP-59 backdating: never in the future.
    expect(wrap.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    const unwrapped = await unwrapDirectInvite(wrap, rawSigner(recipientSk));
    expect(unwrapped).toBeDefined();
    expect(unwrapped!.sender).toBe(inviterPk);

    const parsed = parseDirectInviteRumor(unwrapped!.rumor.kind, unwrapped!.rumor.content);
    expect(parsed).toBeDefined();
    expect(parsed!.community_id).toBe(bundle.community_id);
    expect(parsed!.name).toBe("Test community");
  });

  it("stamps a NIP-40 expiration on the wrap when the bundle expires", async () => {
    const inviterSk = generateSecretKey();
    const recipientPk = getPublicKey(generateSecretKey());
    const expiresAtMs = Date.now() + 86_400_000;
    const rumor = buildDirectInviteRumor(makeBundle({ expires_at: expiresAtMs }), getPublicKey(inviterSk));
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const wrap = await wrapDirectInvite(seal, recipientPk, { expiresAtMs });
    expect(wrap.tags).toContainEqual(["expiration", String(Math.floor(expiresAtMs / 1000))]);
  });

  it("rejects a rumor whose claimed author differs from the seal's signer", async () => {
    const inviterSk = generateSecretKey();
    const impostorPk = getPublicKey(generateSecretKey());
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    // The rumor claims someone else sent it; the seal is signed by the inviter.
    const rumor = buildDirectInviteRumor(makeBundle(), impostorPk);
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const wrap = await wrapDirectInvite(seal, recipientPk);
    expect(await unwrapDirectInvite(wrap, rawSigner(recipientSk))).toBeUndefined();
  });

  it("rejects a seal whose signature does not verify", async () => {
    const inviterSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    const rumor = buildDirectInviteRumor(makeBundle(), getPublicKey(inviterSk));
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const badSig = `${seal.sig.slice(0, -1)}${seal.sig.endsWith("0") ? "1" : "0"}`;
    const unsigned = { ...seal, sig: "" } as NostrEvent;
    for (const forged of [{ ...seal, sig: badSig }, unsigned]) {
      const wrap = await wrapDirectInvite(forged, recipientPk);
      expect(await unwrapDirectInvite(wrap, rawSigner(recipientSk))).toBeUndefined();
    }
  });

  it("refuses a bundle whose owner does not reproduce its community_id", () => {
    const forged = makeBundle({ owner: bytesToHex(random32()) });
    expect(parseDirectInviteRumor(KIND_DIRECT_INVITE, JSON.stringify(forged))).toBeUndefined();
  });

  it("gates on the rumor kind — the outer k tag was only ever a hint", () => {
    expect(parseDirectInviteRumor(9, JSON.stringify(makeBundle()))).toBeUndefined();
  });

  it("tracks expiry without refusing to parse (a parked invite still renders)", () => {
    const expired = makeBundle({ expires_at: Date.now() - 1000 });
    const parsed = parseDirectInviteRumor(KIND_DIRECT_INVITE, JSON.stringify(expired));
    expect(parsed).toBeDefined();
    expect(directInviteExpired(parsed!)).toBe(true);
    expect(directInviteExpired(makeBundle())).toBe(false);
  });
});

describe("direct-invite inbox store", () => {
  async function makeUnwrapped() {
    const inviterSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const bundle = makeBundle();
    const rumor = buildDirectInviteRumor(bundle, getPublicKey(inviterSk));
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const wrap = await wrapDirectInvite(seal, recipientPk);
    const unwrapped = (await unwrapDirectInvite(wrap, rawSigner(recipientSk)))!;
    return { wrap, unwrapped, bundle, recipientPk, inviterPk: getPublicKey(inviterSk) };
  }

  it("round-trips an unwrapped invite through the codec", async () => {
    const { wrap, unwrapped, inviterPk } = await makeUnwrapped();

    const stored = unwrappedToStored(wrap, unwrapped);
    expect(stored.id).toBe(wrap.id);
    expect(stored.kind).toBe(KIND_DIRECT_INVITE);
    expect(stored.pubkey).toBe(inviterPk);
    // The tenant names the account, so no recipient tag is written any more.
    expect(stored.tags.some((t) => t[0] === "p")).toBe(false);

    const back = storedToInvite(stored);
    expect(back.wrapId).toBe(wrap.id);
    expect(back.sender).toBe(inviterPk);
    expect(back.rumor.content).toBe(unwrapped.rumor.content);
    expect(
      back.rumor.tags.some((t) => t[0] === "wrap" || t[0] === "sender" || t[0] === "wrapts"),
    ).toBe(false);
  });

  it("persists and queries invites without re-decrypting", async () => {
    const { wrap, unwrapped, bundle, recipientPk } = await makeUnwrapped();
    writeStoredInvites(recipientPk, [{ wrap: wrap as NostrEvent, unwrapped }]);
    const got = await eventually(
      () => queryStoredInvites(recipientPk),
      (r) => r.some((i) => i.wrapId === wrap.id),
    );
    const mine = got.find((i) => i.wrapId === wrap.id)!;
    expect(JSON.parse(mine.rumor.content).community_id).toBe(bundle.community_id);
  });

  it("scopes reads to the recipient — another account never sees the invite", async () => {
    const { wrap, unwrapped, recipientPk } = await makeUnwrapped();
    const otherPk = getPublicKey(generateSecretKey());
    writeStoredInvites(recipientPk, [{ wrap: wrap as NostrEvent, unwrapped }]);
    // The recipient reads it back…
    await eventually(() => queryStoredInvites(recipientPk), (r) => r.some((i) => i.wrapId === wrap.id));
    // …but a different logged-in account never does (the leak this guards).
    const forOther = await queryStoredInvites(otherPk);
    expect(forOther.some((i) => i.wrapId === wrap.id)).toBe(false);
  });

  it("cursor resumes a backdate window behind the newest wrap scanned", async () => {
    const pubkey = "cursor-test-" + getPublicKey(generateSecretKey());
    expect(await inviteInboxSince(pubkey)).toBe(0); // cold cache → full scan

    const newest = 10_000_000;
    await advanceInviteInboxCursor(pubkey, newest);
    // Direct-invite wraps DO backdate (NIP-59), so the resume floor rewinds.
    expect(await inviteInboxSince(pubkey)).toBe(newest - WRAP_BACKDATE_SECS);

    // Monotonic: an older value never regresses the cursor.
    await advanceInviteInboxCursor(pubkey, newest - 500);
    expect(await inviteInboxSince(pubkey)).toBe(newest - WRAP_BACKDATE_SECS);
  });
});

describe("catch-up classification (isCatchUpBundle)", () => {
  const ROOT = "a".repeat(64);
  const OTHER_ROOT = "b".repeat(64);
  const held = { rootEpoch: 3, communityRoot: ROOT, channelEpochs: new Map([["aa", 2]]) };
  const ch = (id: string, epoch: number) => ({ id, key: "1".repeat(64), epoch, name: "c" });
  const b = (over: Partial<InviteBundle>) =>
    ({ root_epoch: 3, community_root: ROOT, channels: [], ...over }) as Pick<
      InviteBundle,
      "root_epoch" | "channels" | "community_root" | "control_pk"
    >;

  it("a vend carrying a channel key the member lacks is a catch-up", () => {
    // A role-gate key vend rides the SAME root epoch and was once skipped as
    // "already a member", so the key never arrived.
    expect(isCatchUpBundle(held, b({ channels: [ch("bb", 0)] }))).toBe(true);
    // A higher CHANNEL epoch for a held channel also qualifies (post-rotation vend).
    expect(isCatchUpBundle(held, b({ channels: [ch("aa", 3)] }))).toBe(true);
  });

  it("never treats a bundle proposing a DIFFERENT base as a catch-up", () => {
    // The relocation attack: nothing binds `community_root` to `community_id`
    // (CORD-02 §1 vs §2), so a stranger holding only the public triple can offer
    // a real community's id beside a root they chose. At a higher epoch it would
    // win the CORD-02 §8 merge outright and move every future message the member
    // writes onto streams the attacker reads.
    expect(isCatchUpBundle(held, b({ root_epoch: 4, community_root: OTHER_ROOT }))).toBe(false);
    expect(
      isCatchUpBundle(held, b({ root_epoch: 4, community_root: OTHER_ROOT, channels: [ch("bb", 0)] })),
    ).toBe(false);
    // ...and at the same epoch, where `freshest` falls through to a grindable
    // canonical-bytes tiebreak.
    expect(isCatchUpBundle(held, b({ community_root: OTHER_ROOT, channels: [ch("bb", 0)] }))).toBe(false);
  });

  it("never lets a catch-up swap the Control Plane signer", () => {
    const staffHeld = { ...held, controlPk: "c".repeat(64) };
    expect(
      isCatchUpBundle(staffHeld, b({ control_pk: "d".repeat(64), channels: [ch("bb", 0)] })),
    ).toBe(false);
    expect(
      isCatchUpBundle(staffHeld, b({ control_pk: "c".repeat(64), channels: [ch("bb", 0)] })),
    ).toBe(true);
  });

  it("advancing the root epoch is the rekey path's job, not an invite's", () => {
    // Even carrying the member's own current root, a bundle claiming a fresher
    // epoch is refused: CORD-06 §2 advances the base only on a blob whose
    // `prevcommit` proves it extends the key already held.
    expect(isCatchUpBundle(held, b({ root_epoch: 4 }))).toBe(false);
  });

  it("matches a base whose hex spelling differs in case", () => {
    expect(isCatchUpBundle(held, b({ community_root: ROOT.toUpperCase(), channels: [ch("bb", 0)] }))).toBe(true);
  });

  it("a bundle carrying a channel key I was CUT from is not a vend", () => {
    // Cut out of "bb" at channel epoch 2: an old bundle holding bb@0 is the
    // access that was revoked, so it must not park as a fresh key.
    const cut = {
      rootEpoch: 3,
      communityRoot: ROOT,
      channelEpochs: new Map<string, number>(),
      channelCuts: new Map([["bb", 2]]),
    };
    expect(isCatchUpBundle(cut, b({ channels: [ch("bb", 0)] }))).toBe(false);
    // A key at/above the cut epoch is a genuine re-admission.
    expect(isCatchUpBundle(cut, b({ channels: [ch("bb", 2)] }))).toBe(true);
  });

  it("a bundle whose fields have the wrong JSON types is refused at parse, not thrown on at classification", () => {
    // The sender chooses every byte of the content, and a parked record is read
    // back on every inbox query: a throw here would fail that read for good.
    const parsed = (over: Record<string, unknown>) =>
      parseDirectInviteRumor(KIND_DIRECT_INVITE, JSON.stringify({ ...makeBundle(), ...over }));
    const malformed: Record<string, unknown>[] = [
      { community_root: 5 },
      { community_root: null },
      { control_pk: 5 },
      { root_epoch: "3" },
      { channels: [null] },
      { channels: ["x"] },
      { channels: [{ id: 5, key: "1".repeat(64), epoch: 0, name: "c" }] },
      { channels: [{ id: "bb", key: null, epoch: 0, name: "c" }] },
      { channels: [{ id: "bb", key: "1".repeat(64), epoch: "0", name: "c" }] },
    ];
    for (const over of malformed) {
      const bundle = parsed(over);
      // Whatever parse lets through must classify without throwing against a
      // membership on the same base.
      const sameBase = {
        rootEpoch: 0,
        communityRoot: typeof bundle?.community_root === "string" ? bundle.community_root : ROOT,
        channelEpochs: new Map<string, number>(),
      };
      expect(() => bundle && isCatchUpBundle(sameBase, bundle), JSON.stringify(over)).not.toThrow();
      expect(bundle, JSON.stringify(over)).toBeUndefined();
    }
    // A well-formed bundle still parses.
    expect(parsed({ channels: [ch("bb", 0)], control_pk: "c".repeat(64) })).toBeDefined();
  });

  it("bundles with nothing new, stale roots, and non-members never park", () => {
    expect(isCatchUpBundle(held, b({ channels: [ch("aa", 2)] }))).toBe(false);
    expect(isCatchUpBundle(held, b({ root_epoch: 2, channels: [ch("bb", 0)] }))).toBe(false);
    expect(isCatchUpBundle(undefined, b({ root_epoch: 9, channels: [ch("bb", 0)] }))).toBe(false);
  });
});
