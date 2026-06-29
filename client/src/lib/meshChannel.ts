/**
 * Private Bluetooth-mesh channels — a Concord-style encrypted envelope carried
 * over the bitchat broadcast mesh.
 *
 * # Concept
 *
 * The mesh already floods every broadcast packet to everyone in range, and
 * relays them by TTL/dedup WITHOUT inspecting the payload (see
 * `PacketRelayManager`). A private channel exploits exactly that: the message
 * body is sealed under a shared 32-byte channel key, so non-members in range
 * still relay the opaque blob but can't read it — the same "key IS membership,
 * everyone routes" model Concord uses on Nostr relays.
 *
 * # What's on the wire vs what's hidden
 *
 * A channel message rides as an ordinary signed broadcast `MESSAGE` packet so
 * that UNMODIFIED bitchat will route it (bitchat drops broadcasts from
 * unknown/unsigned senders, so we must keep our real, announced mesh peer id as
 * the packet sender — see AGENTS-level investigation). Therefore:
 *
 *   - HIDDEN from relayers: the message content, the author's in-channel
 *     identity, and the channel's human name (all sealed in the payload).
 *   - HIDDEN by routing: which channel a blob belongs to — the on-wire tag is an
 *     opaque, per-epoch ROTATING pseudonym (`channelTag`), not a `#name`. bitchat
 *     has no key for it, so it relays-but-never-displays it.
 *   - VISIBLE to a passive BLE sniffer: that a given mesh peer id emitted an
 *     encrypted broadcast (traffic pattern). Mesh peer ids are NOT Nostr pubkeys
 *     (they're a device Noise fingerprint), and with global mesh incognito ON the
 *     announced nickname is a content-free `anon<hex>`, so this leaks only "these
 *     opaque ids talk this much," never a Nostr identity — unless a member
 *     explicitly reveals themselves IN-CHANNEL (sealed, members-only).
 *   - READERS/lurkers are fully invisible: reading is passive key possession and
 *     emits nothing on the wire.
 *
 * # Identity model (mirrors the existing mesh incognito toggle, per-channel)
 *
 * In-channel identity lives INSIDE the sealed body, never on the packet. By
 * default a member posts incognito (an anon handle derived from their mesh peer
 * id, exactly like {@link meshAnonName}). A member may REVEAL themselves to the
 * channel by attaching a Nostr-pubkey-signed proof in the sealed envelope; this
 * is per-channel and forward-only by construction (each message self-describes
 * its identity at send time), and leaks nothing to relayers.
 *
 * # Crypto
 *
 * Symmetric: raw-key NIP-44 v2 (reusing {@link seal}/{@link open} from the
 * Concord cipher). Pseudonym derivation: HKDF-SHA256 in the frozen Concord
 * construction (reusing {@link channelPseudonym}). secp256k1 Schnorr for the
 * optional in-channel reveal proof. A wrong key fails the AEAD MAC on open.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { channelPseudonym } from "@/lib/concord/derive";

/** Nostr kind for an in-channel reveal attestation (parameterized-replaceable-free, ephemeral-ish). */
export const MESH_REVEAL_KIND = 27493;

/** Current sealed-envelope format version (bumped if the JSON shape changes). */
const ENVELOPE_VERSION = 1;

/**
 * Epoch granularity for channel-tag rotation, in milliseconds. The on-wire
 * `channelTag` is derived per-epoch so a passive observer can't track a single
 * channel's traffic across epochs; members compute the current + previous tag
 * so a message sent near a boundary still matches. 1 hour balances unlinkability
 * against the size of the "tags I currently accept" set.
 */
export const MESH_CHANNEL_EPOCH_MS = 60 * 60 * 1000;

/**
 * A private mesh channel held locally. The `key` is the membership: anyone with
 * it can read and post; anyone without it can only relay opaque blobs. `id` is
 * a stable random 32-byte channel id (used in the pseudonym derivation, like a
 * Concord channel id); `name`/`color` are local display only and never hit the
 * wire.
 */
export interface MeshChannel {
  /** Stable random 32-byte channel id (hex). Pseudonym-derivation input. */
  id: string;
  /** Shared 32-byte channel key (hex). The actual membership secret. */
  key: string;
  /** Local display name (never transmitted). */
  name: string;
  /** Local accent color (never transmitted). */
  color: string;
  /** ms timestamp the channel was created/joined (for ordering the sidebar). */
  createdAt: number;
}

/** The plaintext payload sealed inside a channel message envelope. */
interface ChannelEnvelope {
  v: number;
  /** Stable message id (uppercase UUID) — display/dedup key. */
  id: string;
  /** The message text. */
  content: string;
  /** Sender's mesh peer id (binds the sealed body to the routable packet). */
  senderPeerID: string;
  /** Send-time epoch ms (ordering). */
  ts: number;
  /**
   * Optional in-channel reveal: a Nostr event ({@link MESH_REVEAL_KIND}) signed
   * by the member's real Nostr key, binding their pubkey to this channel id +
   * sender peer id. Every member re-verifies the Schnorr signature and the
   * bound tags, so reveal is cryptographically authentic (no impersonation) yet
   * leaks nothing to relayers (it's inside the sealed body).
   */
  reveal?: NostrEvent;
}

/** A decrypted, verified channel message ready to adapt into the chat UI. */
export interface OpenedChannelMessage {
  /** Display/dedup id (the inner envelope id). */
  id: string;
  /** Channel id (hex) this message belongs to. */
  channelId: string;
  /** Sender's mesh peer id. */
  senderPeerID: string;
  content: string;
  /** Send-time epoch ms. */
  timestamp: number;
  /**
   * Verified revealed Nostr identity, if the sender chose to reveal in-channel
   * AND the proof verified. Absent = the sender is posting incognito.
   */
  reveal?: { pubkey: string; name: string };
}

/** Generate a fresh private channel with random id + key. */
export function createMeshChannel(name: string, color: string): MeshChannel {
  return {
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    key: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    name,
    color,
    createdAt: Date.now(),
  };
}

/** The current rotation epoch (integer) for `now` (defaults to wall clock). */
function currentEpoch(now = Date.now()): bigint {
  return BigInt(Math.floor(now / MESH_CHANNEL_EPOCH_MS));
}

/**
 * The on-wire channel tag (hex) for a channel at a given epoch: an opaque,
 * rotating pseudonym derived from the channel key + id + epoch. Members compute
 * the same value; relayers see meaningless gibberish that changes each epoch.
 */
export function channelTag(channel: MeshChannel, epoch: bigint): string {
  return bytesToHex(
    channelPseudonym(hexToBytes(channel.key), hexToBytes(channel.id), epoch),
  );
}

/**
 * The set of channel tags we currently accept for a channel: the current epoch
 * plus the previous one, so a message sent just before an epoch boundary (and
 * received just after) still matches. Returns tag→channel.
 */
export function acceptedTags(channel: MeshChannel, now = Date.now()): string[] {
  const e = currentEpoch(now);
  return [channelTag(channel, e), channelTag(channel, e - 1n)];
}

/** Tag name binding a reveal event to its channel id. */
const REVEAL_TAG_CHANNEL = "mesh_channel";
/** Tag name binding a reveal event to the sender's mesh peer id. */
const REVEAL_TAG_PEER = "mesh_peer";

/**
 * Build the UNSIGNED Nostr event template a member signs to reveal themselves
 * in a channel. Signing it with the user's Nostr signer (extension/bunker/nsec)
 * yields a self-authenticating proof: the signature proves pubkey ownership and
 * the bound tags pin it to this exact channel + sender peer id, defeating
 * lifting the proof into another channel. The display name rides in `content`.
 */
export function buildRevealTemplate(
  channelId: string,
  senderPeerID: string,
  displayName: string,
): EventTemplate {
  return {
    kind: MESH_REVEAL_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      [REVEAL_TAG_CHANNEL, channelId],
      [REVEAL_TAG_PEER, senderPeerID],
    ],
    content: displayName,
  };
}

/**
 * Verify a reveal event against the channel it arrived in and the sender's peer
 * id. Returns the revealed identity only if the Schnorr signature is valid AND
 * the bound tags match — otherwise `undefined` (the message is shown incognito).
 */
function verifyReveal(
  channelId: string,
  senderPeerID: string,
  reveal: NostrEvent | undefined,
): { pubkey: string; name: string } | undefined {
  if (!reveal) return undefined;
  try {
    if (reveal.kind !== MESH_REVEAL_KIND) return undefined;
    const boundChannel = reveal.tags.find((t) => t[0] === REVEAL_TAG_CHANNEL)?.[1];
    const boundPeer = reveal.tags.find((t) => t[0] === REVEAL_TAG_PEER)?.[1];
    if (boundChannel !== channelId) return undefined;
    // Bind to the sender peer id when present (defends against splicing a
    // member's reveal onto a different peer's messages).
    if (senderPeerID && boundPeer && boundPeer !== senderPeerID) return undefined;
    if (!verifyEvent(reveal)) return undefined;
    return { pubkey: reveal.pubkey, name: reveal.content || reveal.pubkey.slice(0, 8) };
  } catch {
    return undefined;
  }
}

/** Input identity for a send: incognito (default) or a signed reveal event. */
export type ChannelSendIdentity =
  | { kind: "incognito" }
  | { kind: "reveal"; reveal: NostrEvent };

/**
 * Seal a channel message into the wire form carried in the packet payload:
 * `{ tag, ciphertext }`. `tag` is the opaque rotating channel pseudonym placed
 * in the (cleartext) packet channel field for routing/recognition; `ciphertext`
 * is the NIP-44-sealed envelope placed in the encrypted payload.
 */
export function sealChannelMessage(
  channel: MeshChannel,
  params: {
    id: string;
    content: string;
    senderPeerID: string;
    timestamp?: number;
    identity?: ChannelSendIdentity;
  },
): { tag: string; ciphertext: string } {
  const ts = params.timestamp ?? Date.now();
  const identity = params.identity ?? { kind: "incognito" };
  const envelope: ChannelEnvelope = {
    v: ENVELOPE_VERSION,
    id: params.id,
    content: params.content,
    senderPeerID: params.senderPeerID,
    ts,
  };
  if (identity.kind === "reveal") {
    envelope.reveal = identity.reveal;
  }
  const ciphertext = cipherSeal(hexToBytes(channel.key), JSON.stringify(envelope));
  return { tag: channelTag(channel, currentEpoch(ts)), ciphertext };
}

/**
 * Try to open a sealed channel message against a single held channel key.
 * Returns the verified message, or `null` if this key doesn't open it (wrong
 * key → AEAD MAC failure) or the envelope is malformed. A present-but-invalid
 * reveal proof is dropped to incognito rather than rejecting the message.
 */
export function openChannelMessage(
  channel: MeshChannel,
  ciphertext: string,
): OpenedChannelMessage | null {
  let json: string;
  try {
    json = cipherOpen(hexToBytes(channel.key), ciphertext);
  } catch {
    return null; // not our channel, or tampered
  }
  let env: ChannelEnvelope;
  try {
    env = JSON.parse(json) as ChannelEnvelope;
  } catch {
    return null;
  }
  if (typeof env?.content !== "string" || typeof env?.id !== "string") return null;

  const reveal = verifyReveal(channel.id, env.senderPeerID ?? "", env.reveal);

  return {
    id: env.id,
    channelId: channel.id,
    senderPeerID: env.senderPeerID ?? "",
    content: env.content,
    timestamp: typeof env.ts === "number" ? env.ts : Date.now(),
    reveal,
  };
}

/**
 * Open an incoming sealed blob against ALL held channels, matching first by the
 * on-wire `tag` (cheap) and then verifying via decryption. Returns the opened
 * message + the matching channel, or `null` when no held key opens it (in which
 * case the caller relays it silently and never displays it).
 */
export function openAgainstChannels(
  channels: MeshChannel[],
  wireTag: string | null,
  ciphertext: string,
  now = Date.now(),
): { channel: MeshChannel; message: OpenedChannelMessage } | null {
  // Fast path: a wire tag we recognize pins the channel without trial decryption.
  if (wireTag) {
    for (const channel of channels) {
      if (acceptedTags(channel, now).includes(wireTag)) {
        const message = openChannelMessage(channel, ciphertext);
        if (message) return { channel, message };
      }
    }
  }
  // Fallback: trial-decrypt (handles wide epoch skew or a missing/garbled tag).
  for (const channel of channels) {
    const message = openChannelMessage(channel, ciphertext);
    if (message) return { channel, message };
  }
  return null;
}

// ── Wire framing ─────────────────────────────────────────────────────────────
//
// A private-channel message rides as the TEXT `content` of an ordinary bitchat
// broadcast MESSAGE (so unmodified bitchat routes it as opaque text). We frame
// `{ tag, ciphertext }` into a single self-describing string with control-char
// separators that won't occur in normal chat text. bitchat clients will render
// this as gibberish text in their own UI (unavoidable — they relay it either
// way); the Armada client detects the marker and never shows the raw frame.

/** Marker that identifies an Armada mesh-channel frame. `\x01` = SOH. */
const FRAME_MARKER = "\x01mc1\x01";
const FRAME_SEP = "\x01";

/** Pack a sealed `{ tag, ciphertext }` into the wire text payload. */
export function encodeChannelFrame(tag: string, ciphertext: string): string {
  return `${FRAME_MARKER}${tag}${FRAME_SEP}${ciphertext}`;
}

/**
 * Detect + parse an Armada mesh-channel frame from a received broadcast's text
 * content. Returns `{ tag, ciphertext }` or `null` for ordinary public messages.
 */
export function decodeChannelFrame(content: string): { tag: string; ciphertext: string } | null {
  if (!content.startsWith(FRAME_MARKER)) return null;
  const rest = content.slice(FRAME_MARKER.length);
  const sep = rest.indexOf(FRAME_SEP);
  if (sep < 0) return null;
  return { tag: rest.slice(0, sep), ciphertext: rest.slice(sep + 1) };
}

/** Whether a received broadcast content is an Armada channel frame (any channel). */
export function isChannelFrame(content: string): boolean {
  return content.startsWith(FRAME_MARKER);
}

// ── Key handoff over DM ──────────────────────────────────────────────────────
//
// To add a specific nearby peer to a channel, a member hands over the channel
// (id + key + display name) via the EXISTING Noise-XX-encrypted mesh DM. The
// bundle is framed so the recipient's client installs the channel instead of
// rendering the raw text as a chat message.

const INVITE_MARKER = "\x01mci1\x01";

/** Pack a channel into a DM-carried invite bundle (sent over the Noise DM). */
export function encodeChannelInvite(channel: MeshChannel): string {
  return `${INVITE_MARKER}${JSON.stringify({
    id: channel.id,
    key: channel.key,
    name: channel.name,
    color: channel.color,
  })}`;
}

/** Whether a received DM body is a channel-invite bundle. */
export function isChannelInvite(content: string): boolean {
  return content.startsWith(INVITE_MARKER);
}

/**
 * Parse a channel-invite bundle from a DM body. Returns a fresh {@link MeshChannel}
 * (with a local `createdAt`) or `null` if malformed. The recipient should add it
 * to their held channels (de-duping by id).
 */
export function decodeChannelInvite(content: string): MeshChannel | null {
  if (!content.startsWith(INVITE_MARKER)) return null;
  try {
    const o = JSON.parse(content.slice(INVITE_MARKER.length)) as Partial<MeshChannel>;
    if (
      typeof o.id !== "string" ||
      typeof o.key !== "string" ||
      o.id.length !== 64 ||
      o.key.length !== 64
    ) {
      return null;
    }
    return {
      id: o.id,
      key: o.key,
      name: typeof o.name === "string" && o.name ? o.name : "shared channel",
      color: typeof o.color === "string" && o.color ? o.color : "#6e7681",
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}


