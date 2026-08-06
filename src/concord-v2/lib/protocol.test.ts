/**
 * End-to-end protocol exercise: create → invite → join → chat → rekey/ban —
 * three members, pure lib level (no relays; "the wire" is an event array).
 */

import { getConversationKey } from "nostr-tools/nip44";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { foldTimeline, openChatBatch } from "@/concord-v2/lib/chat";
import { channelsView, mintCommunity } from "@/concord-v2/lib/community";
import { rehydrateCommunity, toJoinMaterial } from "@/concord-v2/lib/communityList";
import { bundleToEntry } from "@/concord-v2/hooks/useCommunityActions2";
import {
  buildBanlistEdition,
  buildChannelEdition,
  buildMetadataEdition,
  controlGroups,
  currentControlWriteGroup,
  foldControlState,
  openControlWraps,
  sealEdition,
} from "@/concord-v2/lib/control";
import { baseRekeyGroupKey, bytesToHex, controlSignerGroupKey, epochKeyCommitment, hex32, random32 } from "@/concord-v2/lib/derive";
import { buildInviteUrl, buildBundleEvent, buildRefreshedBundleEvents, mintLinkSigner, mintToken, parseBundleEvent, parseInviteLink, type InviteBundle } from "@/concord-v2/lib/invite";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import {
  base64ToBytes,
  buildRekeyRumors,
  bytesToBase64,
  checkContinuity,
  decodeWrappedBaseKey,
  encodeWrappedBaseKey,
  findBlob,
  groupRotations,
  myLocator,
  parseRekey,
  type RekeyBlob,
} from "@/concord-v2/lib/rekey";
import { buildRumor, channelBindingTags, openWrap, rewrapSeal, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";

function member(sk = generateSecretKey()) {
  return {
    sk,
    pubkey: getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    /** signer.nip44-equivalent pairwise encrypt/decrypt. */
    nip44encrypt: (counterparty: string, plaintext: string) =>
      nip44Encrypt(plaintext, getConversationKey(sk, counterparty)),
    nip44decrypt: (counterparty: string, ciphertext: string) =>
      nip44Decrypt(ciphertext, getConversationKey(sk, counterparty)),
  };
}

describe("Concord V2 end to end", () => {
  it("runs the full lifecycle: create → invite → join → chat → ban+refound", async () => {
    const owner = member();
    const alice = member();
    const mallory = member();
    const wire: NostrEvent[] = []; // "the relays"

    // ── 1. The owner creates the community (genesis: exactly two editions).
    // The owner holds the minted control_root, so the write group resolves.
    const { community: ownerCommunity, generalChannelId } = mintCommunity("Test Fleet", owner.pubkey, [
      "wss://relay.example",
    ]);
    const control0 = currentControlWriteGroup(ownerCommunity);
    expect(control0.pk).toBe(ownerCommunity.controlPk);
    wire.push(
      await sealEdition(
        buildMetadataEdition(ownerCommunity.id, { name: "Test Fleet", relays: ownerCommunity.relays }, { actorPubkey: owner.pubkey, version: 1n }),
        control0,
        owner,
      ),
      await sealEdition(
        buildChannelEdition(generalChannelId, { name: "general", private: false }, { actorPubkey: owner.pubkey, version: 1n }),
        control0,
        owner,
      ),
    );

    // ── 2. The owner mints a public invite link.
    const token = mintToken();
    const link = mintLinkSigner();
    const bundle: InviteBundle = {
      community_id: ownerCommunity.idHex,
      owner: owner.pubkey,
      owner_salt: bytesToHex(ownerCommunity.ownerSalt),
      community_root: bytesToHex(ownerCommunity.root),
      root_epoch: 0,
      control_pk: ownerCommunity.controlPk,
      channels: [],
      relays: ownerCommunity.relays,
      name: "Test Fleet",
      creator_npub: owner.pubkey,
    };
    const bundleEvent = buildBundleEvent(bundle, token, link.sk);
    const url = buildInviteUrl("https://armada.example.com", link.pk, token, ownerCommunity.relays);

    // ── 3. Alice + Mallory follow the link and join.
    const parsedLink = parseInviteLink(url)!;
    expect(parsedLink.linkSigner).toBe(link.pk);
    const fetched = parseBundleEvent(bundleEvent, parsedLink.linkSigner, parsedLink.token, Date.now());
    const jm = {
      community_id: fetched.community_id,
      owner: fetched.owner,
      owner_salt: fetched.owner_salt,
      community_root: fetched.community_root,
      root_epoch: fetched.root_epoch,
      control_pk: fetched.control_pk,
      channels: [],
      relays: fetched.relays,
      name: fetched.name,
    };
    const aliceCommunity = rehydrateCommunity({ community_id: jm.community_id, seed: jm, current: jm, added_at: 1 })!;
    expect(aliceCommunity.idHex).toBe(ownerCommunity.idHex);
    expect(bytesToHex(aliceCommunity.root)).toBe(bytesToHex(ownerCommunity.root));
    // Alice holds the ADDRESS (read/verify), never the write secret.
    expect(aliceCommunity.controlPk).toBe(ownerCommunity.controlPk);
    expect(aliceCommunity.controlRoot).toBeUndefined();
    expect(() => currentControlWriteGroup(aliceCommunity)).toThrow();

    // ── 4. Alice folds the control plane and finds #general.
    const aliceFold = foldControlState(
      openControlWraps(wire, controlGroups(aliceCommunity)),
      aliceCommunity.id,
      aliceCommunity.owner,
    );
    expect(aliceFold.metadata?.name).toBe("Test Fleet");
    const channels = channelsView(aliceCommunity, aliceFold);
    expect(channels.length).toBe(1);
    const general = channels[0];
    expect(general.name).toBe("general");
    expect(general.isPrivate).toBe(false);

    // ── 5. Chat: Alice and Mallory post; the owner reads both.
    for (const [who, text] of [
      [alice, "hello fleet"],
      [mallory, "soon to be banned"],
    ] as const) {
      const rumor = buildRumor({
        kind: KIND_MESSAGE,
        content: text,
        tags: channelBindingTags(general.idHex, general.current.epoch),
        pubkey: who.pubkey,
        ms: Date.now(),
      });
      wire.push(wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, general.current.group, who), general.current.group));
    }
    const ownerChannels = channelsView(ownerCommunity, aliceFold);
    const chatWraps = wire.filter((e) => e.pubkey === general.current.group.pk);
    const ownerTimeline = foldTimeline(await openChatBatch(chatWraps, ownerChannels[0]));
    expect(ownerTimeline.messages.map((m) => m.content)).toEqual(["hello fleet", "soon to be banned"]);

    // ── 6. Ban Mallory: banlist edition + Refounding to epoch 1.
    wire.push(
      await sealEdition(
        buildBanlistEdition(ownerCommunity.id, [mallory.pubkey], { actorPubkey: owner.pubkey, version: 1n }),
        control0,
        owner,
      ),
    );

    const newEpoch = 1n;
    const newRoot = random32();
    // Every base rotation mints the split's pair beside the root (CORD-06 §3).
    const newControlRoot = random32();
    const newControlPk = controlSignerGroupKey(newControlRoot, ownerCommunity.id, newEpoch).pk;
    const prevCommit = bytesToHex(epochKeyCommitment(0n, ownerCommunity.root));
    const rekeyAddress = baseRekeyGroupKey(ownerCommunity.root, ownerCommunity.id, newEpoch);
    // Alice is a plain member: her blob is the 104-byte form (pk, no secret).
    // The owner's own would be 136; the rotator already holds the pair.
    const plain = bytesToBase64(encodeWrappedBaseKey(newEpoch, newRoot, hex32(newControlPk)));
    const survivors = [owner.pubkey, alice.pubkey];
    const blobs: RekeyBlob[] = survivors.map((pk) => ({
      locator: myLocator(owner.pubkey, pk, "0".repeat(64), newEpoch),
      wrapped: owner.nip44encrypt(pk, plain),
    }));
    for (const rumor of buildRekeyRumors(
      owner.pubkey,
      { scope: { kind: "root" }, newEpoch, prevEpoch: 0n, prevCommit },
      blobs,
      Date.now(),
    )) {
      wire.push(wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, rekeyAddress, owner), rekeyAddress));
    }

    // Compaction: re-wrap the control heads (fresh fold first) into epoch 1.
    const ownerFold = foldControlState(
      openControlWraps(wire, controlGroups(ownerCommunity)),
      ownerCommunity.id,
      ownerCommunity.owner,
    );
    const rotatedOwner: CommunityV2 = {
      ...ownerCommunity,
      root: newRoot,
      rootEpoch: newEpoch,
      controlPk: newControlPk,
      controlRoot: newControlRoot,
      heldRoots: [{ epoch: newEpoch, key: newRoot, controlPk: newControlPk }, ...ownerCommunity.heldRoots],
      refounder: owner.pubkey,
    };
    // The compaction republishes at the NEW epoch's split address: signed by
    // the fresh control_root's signer, readable under the new root (CORD-06 §3).
    const control1 = currentControlWriteGroup(rotatedOwner);
    expect(control1.pk).toBe(newControlPk);
    for (const head of ownerFold.headEditions.values()) {
      wire.push(rewrapSeal(head.opened.seal!, control1));
    }

    // ── 7. Alice receives the rotation: authorized, continuous, carries her blob.
    const rekeyWraps = wire.filter((e) => e.pubkey === rekeyAddress.pk);
    const parsedRekeys = rekeyWraps.map((w) => parseRekey(openWrap(w, rekeyAddress)));
    const [rotation] = groupRotations(parsedRekeys);
    expect(rotation.complete).toBe(true);
    expect(rotation.rotator).toBe(owner.pubkey);
    expect(checkContinuity(rotation, aliceCommunity.rootEpoch, aliceCommunity.root)).toEqual({ ok: true });

    const aliceBlob = findBlob(rotation, myLocator(owner.pubkey, alice.pubkey, rotation.scopeIdHex, newEpoch));
    expect(aliceBlob).toBeDefined();
    const aliceWrapped = decodeWrappedBaseKey(
      base64ToBytes(alice.nip44decrypt(owner.pubkey, aliceBlob!.wrapped)),
      aliceCommunity.id,
      newEpoch,
    );
    expect(bytesToHex(aliceWrapped.newRoot)).toBe(bytesToHex(newRoot));
    // The 104-byte member blob hands Alice the new Control address, no secret.
    expect(aliceWrapped.controlPk).toBe(newControlPk);
    expect(aliceWrapped.controlRoot).toBeUndefined();
    const aliceNewRoot = aliceWrapped.newRoot;

    // Mallory finds no blob across the COMPLETE rotation → removed.
    const malloryBlob = findBlob(rotation, myLocator(owner.pubkey, mallory.pubkey, rotation.scopeIdHex, newEpoch));
    expect(malloryBlob).toBeUndefined();

    // ── 8. Alice follows forward: her fresh fold at epoch 1 sees the compacted
    // heads (dangling prev accepted for the re-anchored joiner path) + banlist.
    const rotatedAlice = rehydrateCommunity(
      {
        community_id: aliceCommunity.idHex,
        seed: jm,
        current: toJoinMaterial(
          {
            ...aliceCommunity,
            root: aliceNewRoot,
            rootEpoch: newEpoch,
            controlPk: aliceWrapped.controlPk,
            controlRoot: undefined,
            heldRoots: [
              { epoch: newEpoch, key: aliceNewRoot, controlPk: aliceWrapped.controlPk },
              ...aliceCommunity.heldRoots,
            ],
            refounder: owner.pubkey,
          },
          { relays: jm.relays },
        ),
        added_at: 1,
      },
    )!;
    expect(rotatedAlice.rootEpoch).toBe(1n);
    expect(rotatedAlice.refounder).toBe(owner.pubkey);
    expect(rotatedAlice.controlPk).toBe(newControlPk);
    const aliceFold1 = foldControlState(
      openControlWraps(wire, controlGroups(rotatedAlice)),
      rotatedAlice.id,
      rotatedAlice.owner,
    );
    expect(aliceFold1.metadata?.name).toBe("Test Fleet");
    expect(aliceFold1.banned.has(mallory.pubkey)).toBe(true);

    // The banned author's messages disappear from Alice's folded timeline.
    const aliceChannels = channelsView(rotatedAlice, aliceFold1);
    expect(aliceChannels.length).toBe(1);
    // History spans both epochs (held roots), and the new epoch's address differs.
    expect(aliceChannels[0].streams.length).toBe(2);
    const allChat = wire.filter((e) => aliceChannels[0].streams.some((s) => s.group.pk === e.pubkey));
    const aliceTimeline = foldTimeline(await openChatBatch(allChat, aliceChannels[0]), {
      banned: aliceFold1.banned,
      canDelete: () => false,
    });
    expect(aliceTimeline.messages.map((m) => m.content)).toEqual(["hello fleet"]);

    // Mallory cannot even derive the new epoch's addresses (no key), and the
    // old key fails on new-epoch traffic.
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "epoch 1 message",
      tags: channelBindingTags(aliceChannels[0].idHex, 1n),
      pubkey: alice.pubkey,
      ms: Date.now(),
    });
    const e1group = aliceChannels[0].streams.find((s) => s.epoch === 1n)!.group;
    const e1wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, e1group, alice), e1group);
    const malloryChannels = channelsView(
      { ...aliceCommunity, privateChannels: [] }, // Mallory still holds only epoch 0
      foldControlState(
        openControlWraps(wire, controlGroups(aliceCommunity)),
        aliceCommunity.id,
        aliceCommunity.owner,
      ),
    );
    const malloryRead = await openChatBatch([e1wrap], malloryChannels[0]);
    expect(malloryRead.length).toBe(0);
  });

  // Regression: a still-live public invite link MUST hand a fresh joiner the
  // CURRENT epoch after a Refounding, never a superseded one. CORD-05 §2: "the
  // creator re-posting under it refreshes the bundle (fresh keys behind the same
  // URL, e.g. after a Rekey), so a link shared once survives every rotation."
  // CORD-06 §3: after a Refounding "only a fresh joiner waits on the re-anchor"
  // — they land on the current epoch. The bug: the Refounding never re-posted
  // the bundle, so the link kept vending root_epoch 0; the joiner rehydrated at
  // epoch 0 and every message they sent bound to the stale epoch (the reported
  // "new user on epoch 0 instead of 1"). The fix re-posts each live bundle with
  // the current keys (useRefound2 → refreshInviteBundlesFor → buildRefreshedBundleEvents).
  it("a live invite link vends the CURRENT epoch to a late joiner after a Refounding", async () => {
    const owner = member();

    // ── 1. Create the community (epoch 0) and mint a public invite link. The
    // creator records the link's token + signer secret in their Invite List
    // (CORD-05 §4) — exactly what a refresh later needs to re-author the
    // coordinate.
    const { community: e0 } = mintCommunity("Test Fleet", owner.pubkey, ["wss://relay.example"]);
    const token = mintToken();
    const link = mintLinkSigner();
    const inviteEntry = { token: bytesToHex(token), signer_sk: bytesToHex(link.sk) };

    // The bundle a mint posts is a snapshot of the community's CURRENT keys —
    // exactly what useInviteActions2.buildBundle() reads (community.root /
    // community.rootEpoch), here at epoch 0.
    const bundleAtEpoch = (c: CommunityV2): InviteBundle => ({
      community_id: c.idHex,
      owner: owner.pubkey,
      owner_salt: bytesToHex(c.ownerSalt),
      community_root: bytesToHex(c.root),
      root_epoch: Number(c.rootEpoch),
      ...(c.controlPk ? { control_pk: c.controlPk } : {}),
      channels: [],
      relays: c.relays,
      name: "Test Fleet",
      creator_npub: owner.pubkey,
    });
    // The addressable coordinate (33301, link_signer, d=""); the newest event at
    // it wins. A refresh replaces it (CORD-05 §2).
    const coordinate: NostrEvent[] = [buildBundleEvent(bundleAtEpoch(e0), token, link.sk)];
    const url = buildInviteUrl("https://armada.example.com", link.pk, token, e0.relays);

    // ── 2. The owner Refounds to epoch 1 (ban/convert): newEpoch = rootEpoch+1,
    // a fresh root + a fresh control pair (CORD-06 §3). The link is NOT
    // revoked — it stays live and shareable.
    const e1Root = random32();
    const e1ControlRoot = random32();
    const e1ControlPk = controlSignerGroupKey(e1ControlRoot, e0.id, 1n).pk;
    const rotatedOwner: CommunityV2 = {
      ...e0,
      root: e1Root,
      rootEpoch: 1n,
      controlPk: e1ControlPk,
      controlRoot: e1ControlRoot,
      heldRoots: [{ epoch: 1n, key: e1Root, controlPk: e1ControlPk }, ...e0.heldRoots],
      refounder: owner.pubkey,
    };

    // A helper for "who does the live link produce a joiner at, right now?" —
    // the production join path: fetch newest at the coordinate, decrypt,
    // entry-ify, rehydrate.
    const joinNow = (): CommunityV2 => {
      const parsedLink = parseInviteLink(url)!;
      const newest = [...coordinate].sort((a, b) => b.created_at - a.created_at)[0];
      const fetched = parseBundleEvent(newest, parsedLink.linkSigner, parsedLink.token, Date.now());
      return rehydrateCommunity(bundleToEntry(fetched))!;
    };

    // ── 3a. WITHOUT the CORD-05 §2 refresh, the still-live link keeps vending
    // epoch 0 — the bug, reproduced.
    expect(joinNow().rootEpoch).toBe(0n);

    // ── 3b. THE FIX: the Refounding re-posts every live bundle at the current
    // keys via the production helper. `created_at` must exceed the stale event so
    // the newest-wins coordinate serves it.
    const refreshed = buildRefreshedBundleEvents(bundleAtEpoch(rotatedOwner), [inviteEntry]).map((e) => ({
      ...e,
      created_at: e.created_at + 10,
    }));
    coordinate.push(...refreshed);

    // ── 4. Now a fresh joiner following the same link lands on epoch 1, and
    // their #general channel binds to the current epoch.
    const joiner = joinNow();
    const fold = foldControlState(openControlWraps([], controlGroups(joiner)), joiner.id, joiner.owner);
    const [general] = channelsView(joiner, {
      ...fold,
      channels: new Map([[e0.idHex, { channelIdHex: e0.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } }]]),
    });
    expect(joiner.rootEpoch).toBe(1n);
    expect(general.current.epoch).toBe(1n);
  });

  it("hex32 round-trips through the whole flow (sanity)", () => {
    const b = random32();
    expect(bytesToHex(hex32(bytesToHex(b)))).toBe(bytesToHex(b));
  });
});
