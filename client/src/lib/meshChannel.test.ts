import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  acceptedTags,
  buildRevealTemplate,
  channelTag,
  createMeshChannel,
  decodeChannelFrame,
  decodeChannelInvite,
  encodeChannelFrame,
  encodeChannelInvite,
  isChannelFrame,
  isChannelInvite,
  MESH_CHANNEL_EPOCH_MS,
  openAgainstChannels,
  openChannelMessage,
  sealChannelMessage,
} from "@/lib/meshChannel";

const PEER = "a3f9c2d1b0e4f567";

describe("meshChannel envelope", () => {
  it("seals and opens a roundtrip with the same key", () => {
    const ch = createMeshChannel("trip", "#ff0000");
    const { tag, ciphertext } = sealChannelMessage(ch, {
      id: "MSG1",
      content: "hello channel",
      senderPeerID: PEER,
    });
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    const opened = openChannelMessage(ch, ciphertext);
    expect(opened).not.toBeNull();
    expect(opened!.content).toBe("hello channel");
    expect(opened!.senderPeerID).toBe(PEER);
    expect(opened!.channelId).toBe(ch.id);
    expect(opened!.reveal).toBeUndefined();
  });

  it("rejects a message under the wrong key (AEAD MAC failure)", () => {
    const a = createMeshChannel("a", "#111");
    const b = createMeshChannel("b", "#222");
    const { ciphertext } = sealChannelMessage(a, { id: "X", content: "secret", senderPeerID: PEER });
    expect(openChannelMessage(b, ciphertext)).toBeNull();
  });

  it("rotates the on-wire tag per epoch but stays stable within one", () => {
    const ch = createMeshChannel("c", "#333");
    const now = 1_000 * MESH_CHANNEL_EPOCH_MS + 5; // mid-epoch
    const sameEpoch = now + 10;
    const nextEpoch = now + MESH_CHANNEL_EPOCH_MS;
    const e = BigInt(Math.floor(now / MESH_CHANNEL_EPOCH_MS));
    expect(channelTag(ch, e)).toBe(channelTag(ch, e));
    // The accepted set covers current + previous epoch.
    expect(acceptedTags(ch, now)).toContain(channelTag(ch, e));
    expect(acceptedTags(ch, now)).toContain(channelTag(ch, e - 1n));
    // Different epochs differ.
    expect(channelTag(ch, e)).not.toBe(channelTag(ch, e + 1n));
    // Stable within epoch.
    const eSame = BigInt(Math.floor(sameEpoch / MESH_CHANNEL_EPOCH_MS));
    expect(eSame).toBe(e);
    const eNext = BigInt(Math.floor(nextEpoch / MESH_CHANNEL_EPOCH_MS));
    expect(eNext).not.toBe(e);
  });

  it("openAgainstChannels picks the right channel and ignores foreign blobs", () => {
    const mine = createMeshChannel("mine", "#444");
    const other = createMeshChannel("other", "#555");
    const { tag, ciphertext } = sealChannelMessage(mine, {
      id: "M",
      content: "routed but mine",
      senderPeerID: PEER,
    });
    const hit = openAgainstChannels([other, mine], tag, ciphertext);
    expect(hit?.channel.id).toBe(mine.id);
    expect(hit?.message.content).toBe("routed but mine");
    // A blob for a channel we don't hold returns null (relay-but-don't-display).
    const foreign = sealChannelMessage(other, { id: "F", content: "x", senderPeerID: PEER });
    expect(openAgainstChannels([mine], foreign.tag, foreign.ciphertext)).toBeNull();
  });

  it("verifies a signed in-channel reveal and binds it to the channel", () => {
    const ch = createMeshChannel("reveal", "#666");
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const reveal = finalizeEvent(buildRevealTemplate(ch.id, PEER, "Alice"), sk);

    const { ciphertext } = sealChannelMessage(ch, {
      id: "R",
      content: "it's me",
      senderPeerID: PEER,
      identity: { kind: "reveal", reveal },
    });
    const opened = openChannelMessage(ch, ciphertext);
    expect(opened!.reveal).toEqual({ pubkey: pk, name: "Alice" });
  });

  it("drops a reveal bound to a different channel (anti-splice) to incognito", () => {
    const ch = createMeshChannel("real", "#777");
    const otherCh = createMeshChannel("decoy", "#888");
    const sk = generateSecretKey();
    // Reveal signed for a DIFFERENT channel id.
    const reveal = finalizeEvent(buildRevealTemplate(otherCh.id, PEER, "Mallory"), sk);
    const { ciphertext } = sealChannelMessage(ch, {
      id: "R2",
      content: "spoof",
      senderPeerID: PEER,
      identity: { kind: "reveal", reveal },
    });
    const opened = openChannelMessage(ch, ciphertext);
    expect(opened).not.toBeNull();
    expect(opened!.reveal).toBeUndefined();
  });
});

describe("meshChannel wire framing + invites", () => {
  it("frames and detects a channel blob, leaving normal text alone", () => {
    const ch = createMeshChannel("f", "#abc");
    const { tag, ciphertext } = sealChannelMessage(ch, { id: "A", content: "hi", senderPeerID: PEER });
    const wire = encodeChannelFrame(tag, ciphertext);
    expect(isChannelFrame(wire)).toBe(true);
    expect(isChannelFrame("just a normal message")).toBe(false);
    const decoded = decodeChannelFrame(wire);
    expect(decoded).toEqual({ tag, ciphertext });
    // End-to-end: frame → decode → openAgainstChannels.
    const hit = openAgainstChannels([ch], decoded!.tag, decoded!.ciphertext);
    expect(hit?.message.content).toBe("hi");
  });

  it("decodeChannelFrame returns null for non-frames", () => {
    expect(decodeChannelFrame("hello")).toBeNull();
  });

  it("encodes and decodes a channel-key invite bundle", () => {
    const ch = createMeshChannel("private trip", "#ff8800");
    const bundle = encodeChannelInvite(ch);
    expect(isChannelInvite(bundle)).toBe(true);
    expect(isChannelInvite("hi there")).toBe(false);
    const received = decodeChannelInvite(bundle)!;
    expect(received.id).toBe(ch.id);
    expect(received.key).toBe(ch.key);
    expect(received.name).toBe(ch.name);
    expect(received.color).toBe(ch.color);
    // A recipient who installs the bundle can open the sender's messages.
    const { tag, ciphertext } = sealChannelMessage(ch, { id: "Z", content: "members only", senderPeerID: PEER });
    expect(openAgainstChannels([received], tag, ciphertext)?.message.content).toBe("members only");
  });

  it("rejects malformed invite bundles", () => {
    expect(decodeChannelInvite("\x01mci1\x01{not json")).toBeNull();
    expect(decodeChannelInvite("\x01mci1\x01{\"id\":\"short\",\"key\":\"x\"}")).toBeNull();
  });
});
