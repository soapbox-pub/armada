/**
 * CORD-03 conformance ledger — same charter as `cord04.conformance.test.ts`.
 *
 * ONE `it` per normative obligation in CORD-03, in spec order, each named with
 * the clause it comes from: a verified rule is an `it` with real assertions, a
 * rule verified ELSEWHERE still gets an entry (pointing at where), and an
 * unverified one is an `it.todo` so vitest prints the outstanding count.
 *
 * Numbering (O-n) is stable and local to this file. The SPEC is the authority:
 * if an obligation here disagrees with `concord/03.md`, this file is the bug.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { channelsView } from "./community";
import { buildChannelEdition, foldControlState, openControlWraps, sealEdition } from "./control";
import { bytesToHex, channelGroupKey, communityIdOf, controlGroupKey, hex32, random32 } from "./derive";
import { channelEpochFloor, channelRekeyAddressWindow } from "./rekey";
import { NAME_MAX_BYTES } from "./roles";
import { channelBindingTags, checkChannelBinding, type OpenedEvent } from "./stream";
import type { ChannelMetadata, Community, PrivateChannelKey } from "./types";
import type { FoldedControl } from "./control";

// ── Harness ──────────────────────────────────────────────────────────────────

const keypair = (sk = generateSecretKey()) => ({
  sk,
  pubkey: getPublicKey(sk),
  signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
});

/** A community whose owner is proven by the community_id commitment (CORD-02). */
function makeCommunity(privateChannels: PrivateChannelKey[] = []) {
  const owner = keypair();
  const ownerSalt = random32();
  const id = communityIdOf(hex32(owner.pubkey), ownerSalt);
  const root = random32();
  const community = {
    id,
    idHex: bytesToHex(id),
    owner: owner.pubkey,
    ownerSalt,
    root,
    rootEpoch: 0n,
    heldRoots: [{ key: root, epoch: 0n }],
    privateChannels,
    relays: [],
    name: "fleet",
  } as unknown as Community;
  return { community, owner, control: controlGroupKey(root, id, 0) };
}

/** A folded control plane naming exactly these channels (no crypto needed). */
function foldWith(defs: Array<{ id: Uint8Array; metadata: ChannelMetadata }>): FoldedControl {
  return {
    channels: new Map(
      defs.map((d) => [
        bytesToHex(d.id),
        {
          channelIdHex: bytesToHex(d.id),
          name: d.metadata.name,
          isPrivate: d.metadata.private === true,
          deleted: d.metadata.deleted === true,
          metadata: d.metadata,
        },
      ]),
    ),
  } as unknown as FoldedControl;
}

const opened = (tags: string[][]): OpenedEvent => ({ tags }) as unknown as OpenedEvent;

// ── §1 Keying ────────────────────────────────────────────────────────────────

describe("CORD-03 §1 — Keying", () => {
  const channelId = random32();

  it("O-1: a Public Channel derives from (community_root, channel_id, root_epoch)", () => {
    const { community } = makeCommunity();
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "general", private: false } }]))[0];
    expect(view.current.group.pk).toBe(channelGroupKey(community.root, channelId, community.rootEpoch).pk);
  });

  it("O-2: a Private Channel derives from (channel_key, channel_id, channel_epoch)", () => {
    const key = random32();
    const { community } = makeCommunity([{ id: channelId, key, epoch: 3n, name: "secret" }]);
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "secret", private: true } }]))[0];
    expect(view.current.group.pk).toBe(channelGroupKey(key, channelId, 3n).pk);
  });

  it("O-3: channel_id is folded in, so every Channel gets a distinct address under one secret", () => {
    const secret = random32();
    expect(channelGroupKey(secret, random32(), 0n).pk).not.toBe(channelGroupKey(secret, random32(), 0n).pk);
  });

  it("O-4: a Private Channel's key is cryptographically unrelated to the community_root", () => {
    // "a leaked channel key exposes only that one Channel" — so the address it
    // writes to must not be derivable from the root every member already holds.
    const { community } = makeCommunity([{ id: channelId, key: random32(), epoch: 1n, name: "secret" }]);
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "secret", private: true } }]))[0];
    for (let e = 0n; e < 8n; e++) {
      expect(view.current.group.pk).not.toBe(channelGroupKey(community.root, channelId, e).pk);
    }
  });

  it.todo("O-5: a Public Channel rotates for free with the base (useRekey.test.tsx)");
});

// ── §2 Metadata ──────────────────────────────────────────────────────────────

describe("CORD-03 §2 — Metadata", () => {
  const channelId = random32();
  const o = { actorPubkey: "f".repeat(64), version: 1n };

  it.todo("O-6: a Channel is a ChannelMetadata entity whose eid is the channel_id (cord04 O-11)");

  it("O-7: a channel name caps at 64 bytes of UTF-8", () => {
    expect(() => buildChannelEdition(channelId, { name: "x".repeat(NAME_MAX_BYTES + 1), private: false }, o)).toThrow();
    expect(() => buildChannelEdition(channelId, { name: "x".repeat(NAME_MAX_BYTES), private: false }, o)).not.toThrow();
  });

  it("O-8: every Channel is callable — there is no per-Channel voice flag", () => {
    const { community } = makeCommunity();
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "general", private: false } }]))[0];
    expect(view.voice).toBeTruthy();
  });

  it.todo("O-9: edits fold as versioned editions like any control state (cord04 O-12)");
  it.todo("O-10: creating a Channel needs MANAGE_CHANNELS, the owner at genesis (cord04 O-44)");

  it("O-11: a Channel is deleted by an edition setting deleted: true, and drops from display", () => {
    const { community } = makeCommunity();
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "gone", private: false, deleted: true } }]));
    expect(view).toEqual([]);
  });

  it("O-12: deletion is TERMINAL — a later edition must not resurrect the id", async () => {
    // "Deletion is terminal: the id is never reused, clients drop the Channel
    // from display and may discard its keys." The key-discard permission is
    // what makes terminality load-bearing: members who honored it can never
    // read a resurrected private channel while members who ignored it can, and
    // no rotation heals that split, because every fold sees one live channel.
    const { community, owner, control } = makeCommunity();
    const wraps = [
      await sealEdition(buildChannelEdition(channelId, { name: "gone", private: false }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildChannelEdition(channelId, { name: "gone", private: false, deleted: true }, { actorPubkey: owner.pubkey, version: 2n }),
        control,
        owner,
      ),
      // The resurrection: authorized, correctly chained, higher version.
      await sealEdition(
        buildChannelEdition(channelId, { name: "back", private: false, deleted: false }, { actorPubkey: owner.pubkey, version: 3n }),
        control,
        owner,
      ),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), community.id, owner.pubkey);
    expect(folded.channels.get(bytesToHex(channelId))?.deleted).toBe(true);
  });

  it.todo("O-13: a deleted Channel's history stays decryptable to whoever already held its keys");
  it.todo("O-14: public→private mints at the NEXT channel_epoch (communityList.test.ts)");
  it.todo("O-15: the first privatisation is epoch 1 (communityList.test.ts)");
  it.todo("O-16: the channel_id never changes across any conversion");

  it("O-17: the epoch floor must never SILENTLY under-read the channel's history", () => {
    // §2's counter is "monotonic, never resetting", and that is what lets the
    // list merge (epoch-max) and a channel_cuts floor (epoch-min) tell two
    // generations apart. The floor is read by probing a BOUNDED window of
    // rekey addresses, so a channel that has rotated past the window is
    // unaccounted for — and minting at an already-used epoch is silent and
    // unrecoverable. A saturated probe must refuse, not return its ceiling.
    const roots = [{ key: random32() }];
    const id = random32();
    const window = channelRekeyAddressWindow(roots, id, 4);
    const byEpoch = [...window.entries()];

    // Conclusive: the highest rotation seen sits below the ceiling.
    const upToTwo = byEpoch.filter(([, e]) => e <= 2n).map(([pk]) => pk);
    expect(channelEpochFloor(window, upToTwo, 4)).toBe(2n);
    // Never private at all — also conclusive, and the floor is 0.
    expect(channelEpochFloor(window, [], 4)).toBe(0n);
    // Saturated: a rotation AT the ceiling means there may be more above it.
    expect(() => channelEpochFloor(window, byEpoch.map(([pk]) => pk), 4)).toThrow(/rotated/i);
  });

  it("O-18: privatising protects the FUTURE only — the world-readable public era is not surfaced as private", () => {
    // "Protects the future only": privatising moves WRITES to the independent
    // key but cannot un-publish the pre-conversion messages — those stay on the
    // community_root-derived address, decryptable by every member forever.
    // Because that era is world-readable, the private channel does NOT fold it
    // into its read set: surfacing it there would present public content as
    // private (and a born-private channel's root address holds only what a
    // non-conformant client wrote). Publicising re-adds it — O-20.
    const key = random32();
    const { community } = makeCommunity([{ id: channelId, key, epoch: 1n, name: "secret" }]);
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "secret", private: true } }]))[0];
    // Future writes go to the independent channel key.
    expect(view.current.group.pk).toBe(channelGroupKey(key, channelId, 1n).pk);
    // The public era's address stays derivable and readable to every member…
    const publicEra = channelGroupKey(community.root, channelId, community.rootEpoch).pk;
    // …but it is not surfaced inside the private channel.
    expect(view.streams.map((s) => s.group.pk)).not.toContain(publicEra);
  });

  it.todo("O-19: converting Private→Public is possible (useCommunityActions.test.tsx publiciseChannel)");
  it.todo("O-19b: a conversion is a single AUTHORIZED action (useCommunityActions.test.tsx channel writes are a channel manager's)");

  it("O-20: after Private→Public the Channel derives from the root, priors still readable", () => {
    const key = random32();
    const { community } = makeCommunity([{ id: channelId, key, epoch: 1n, name: "was-secret" }]);
    // Folded as PUBLIC while this member still holds the private-era key.
    const view = channelsView(community, foldWith([{ id: channelId, metadata: { name: "was-secret", private: false } }]))[0];
    expect(view.current.group.pk).toBe(channelGroupKey(community.root, channelId, community.rootEpoch).pk);
    expect(view.streams.map((s) => s.group.pk)).toContain(channelGroupKey(key, channelId, 1n).pk);
  });
});

// ── §3 Messages ──────────────────────────────────────────────────────────────

describe("CORD-03 §3 — Messages", () => {
  const channelIdHex = "cd".repeat(32);

  it("O-21: a Chat rumor MUST commit ['channel', channel_id] and ['epoch', n]", () => {
    expect(channelBindingTags(channelIdHex, 7n)).toEqual([
      ["channel", channelIdHex],
      ["epoch", "7"],
    ]);
  });

  it("O-22: a receiver MUST check both strict-equal and drop a mismatch", () => {
    expect(() => checkChannelBinding(opened(channelBindingTags(channelIdHex, 7n)), channelIdHex, 7n)).not.toThrow();
    // Spliced into another Channel…
    expect(() => checkChannelBinding(opened(channelBindingTags("ff".repeat(32), 7n)), channelIdHex, 7n)).toThrow(/channel/i);
    // …or replayed across an epoch.
    expect(() => checkChannelBinding(opened(channelBindingTags(channelIdHex, 6n)), channelIdHex, 7n)).toThrow(/epoch/i);
  });

  it("O-23: an ambiguous binding (a duplicate tag) is a mismatch, not a pick-one", () => {
    expect(() =>
      checkChannelBinding(
        opened([["channel", channelIdHex], ["channel", "ff".repeat(32)], ["epoch", "7"]]),
        channelIdHex,
        7n,
      ),
    ).toThrow();
  });

  it.todo("O-24: clients query every epoch pubkey they hold, so history spans a rekey (community.test.ts)");
  it.todo("O-25: an inline quote is a kind 9 carrying a q tag, NIP-C7 (chat.test.ts)");
  it.todo("O-26: a threaded reply is a kind 1111 with K/E/P and k/e/p, NIP-22 (chat.test.ts)");
  it.todo("O-27: a reply inherits its parent's uppercase root tags verbatim (chat.test.ts)");
});
