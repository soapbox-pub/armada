/**
 * Concord core types — the runtime model the hooks and UI operate on.
 *
 * Ids and keys are raw 32-byte values in memory (lowercase hex on the wire).
 * A Community's identity (`community_id`) is a self-certifying commitment to
 * its owner; its access (`community_root`) is a separate 32-byte secret so
 * access can rotate while identity stays fixed (CORD-02 §1–2).
 */

import type { GroupKey, StreamKeyView } from "@/concord/lib/derive";
import {
  normalizeGitRepositoryAttachments,
  parseGitRepositoryAddress,
  type GitRepositoryAttachment,
} from "@/lib/gitActivity";

/** Protocol recommendation for a community's relay set (CORD-02 §6). */
export const MAX_COMMUNITY_RELAYS = 5;
/** Same recommendation, same reasons, for the community's AV brokers (CORD-02 §6). */
export const MAX_COMMUNITY_AV_BROKERS = 5;

/** Community/channel/role name cap: 64 bytes of UTF-8 (CORD-02 §6). */
export const NAME_MAX_BYTES = 64;
/** Community description cap: 10,000 bytes of UTF-8 (CORD-02 §6). */
export const DESCRIPTION_MAX_BYTES = 10_000;
/** Hostile-bundle bound: reject an invite carrying more channels than this (CORD-05 §1). */
export const MAX_BUNDLE_CHANNELS = 256;
/** Bound hostile channel metadata while retaining a useful attachment history. */
export const MAX_CHANNEL_GIT_ATTACHMENTS = 128;
/** Relay hints are hints, not an unbounded metadata transport. */
export const MAX_CHANNEL_GIT_RELAY_HINTS = 8;

/** Armada's namespaced channel-custom member for Git repository attachments. */
export const ARMADA_GIT_CHANNEL_METADATA_KEY = "armada.git";

/** The wire form deliberately stores the canonical address rather than a parsed object. */
export interface ChannelGitRepositoryAttachment {
  address: string;
  relayHints: string[];
  attachedAt: number;
  detachedAt?: number;
}

/** Dedupe (order-preserving) + truncate a relay set to the recommended cap. */
export function capRelays(relays: string[], cap = MAX_COMMUNITY_RELAYS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of relays) {
    if (out.length >= cap) break;
    if (typeof r === "string" && r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

export function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * An encrypted-blob pointer (icon / banner): the media host stores ciphertext,
 * the per-image key + nonce ride inside member-sealed metadata, and `hash` is
 * the SHA-256 of the plaintext so a swapped blob fails closed (CORD-02 §6).
 */
export interface ImagePointer {
  url: string;
  /** Hex AES-256-GCM key. */
  key: string;
  /** Hex AES-GCM nonce/IV. */
  nonce: string;
  /** Hex SHA-256 of the plaintext. */
  hash: string;
}

/** Runtime check that a value is a plausible {@link ImagePointer}. */
export function isImagePointer(v: unknown): v is ImagePointer {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.url === "string" &&
    typeof o.key === "string" &&
    typeof o.nonce === "string" &&
    typeof o.hash === "string"
  );
}

/** Community metadata — the vsk=0 Control Plane entity's content (CORD-02 §6). */
export interface CommunityMetadata {
  name: string;
  description?: string;
  /** The Community's evolving relay set (the fold is the authority). */
  relays: string[];
  /**
   * The Community's AV brokers (CORD-02 §6) as https origins, where calls
   * rendezvous in an empty room (CORD-07 §5). Empty = members' own brokers. Read
   * via `communityAvBrokers` (canonical origin form).
   */
  av_brokers?: string[];
  icon?: ImagePointer;
  banner?: ImagePointer;
  /**
   * Disappearing-messages timer in seconds (CORD-08): durable chat rumors (except
   * deletes and timer notices) get a NIP-40 `expiration`. Absent/0/malformed =
   * off; read via `messageExpirationOf`.
   */
  message_expiration?: number;
  /** Client-extensible opaque fields; editors MUST round-trip what they don't understand. */
  custom?: Record<string, unknown>;
  /** Unknown top-level fields, preserved for round-tripping. */
  [k: string]: unknown;
}

/**
 * How to OPEN a Channel (CORD-03 §2 `view`): `chat` timeline or thread-first
 * `forum`. Presentation only.
 */
export type ChannelView = "chat" | "forum" | "voice";

/** Channel metadata — the vsk=2 Control Plane entity's content (CORD-03 §2). */
export interface ChannelMetadata {
  name: string;
  private: boolean;
  /** Terminal: the id is never reused; clients drop the Channel from display. */
  deleted?: boolean;
  /** Presentation (CORD-03 §2). Loosely typed: unknown values read as `"chat"` and round-trip; use `channelView()`. */
  view?: unknown;
  custom?: Record<string, unknown>;
  [k: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read valid, bounded Git attachment intervals from a channel's opaque custom
 * metadata. Bad extension data is ignored rather than invalidating the channel.
 */
export function channelGitRepositoryAttachments(metadata: ChannelMetadata): GitRepositoryAttachment[] {
  const extension = isRecord(metadata.custom) ? metadata.custom[ARMADA_GIT_CHANNEL_METADATA_KEY] : undefined;
  if (!isRecord(extension) || !Array.isArray(extension.repositories)) return [];

  const attachments: GitRepositoryAttachment[] = [];
  for (const value of extension.repositories) {
    if (!isRecord(value) || typeof value.address !== "string" || !Array.isArray(value.relayHints)) continue;
    const address = parseGitRepositoryAddress(value.address);
    const attachedAt = value.attachedAt;
    const detachedAt = value.detachedAt;
    if (!address || typeof attachedAt !== "number" || !Number.isSafeInteger(attachedAt) || attachedAt < 0) continue;
    if (detachedAt !== undefined && (typeof detachedAt !== "number" || !Number.isSafeInteger(detachedAt) || detachedAt < attachedAt)) continue;
    attachments.push({
      address,
      relayHints: value.relayHints.filter((relay): relay is string => typeof relay === "string").slice(0, MAX_CHANNEL_GIT_RELAY_HINTS),
      attachedAt,
      ...(detachedAt === undefined ? {} : { detachedAt }),
    });
  }
  return normalizeGitRepositoryAttachments(attachments)
    .map((attachment) => ({ ...attachment, relayHints: attachment.relayHints.slice(0, MAX_CHANNEL_GIT_RELAY_HINTS) }))
    .slice(0, MAX_CHANNEL_GIT_ATTACHMENTS);
}

/**
 * Normalize known Git fields while preserving every unknown channel/custom/Git
 * extension member for forward-compatible metadata round trips.
 */
export function normalizeChannelMetadata(metadata: ChannelMetadata): ChannelMetadata {
  if (!isRecord(metadata.custom)) return metadata;
  const extension = metadata.custom[ARMADA_GIT_CHANNEL_METADATA_KEY];
  if (!isRecord(extension)) {
    const { [ARMADA_GIT_CHANNEL_METADATA_KEY]: _ignored, ...custom } = metadata.custom;
    const { custom: _oldCustom, ...rest } = metadata;
    return { ...rest, ...(Object.keys(custom).length ? { custom } : {}) };
  }
  const attachments = channelGitRepositoryAttachments(metadata);
  return {
    ...metadata,
    custom: {
      ...metadata.custom,
      [ARMADA_GIT_CHANNEL_METADATA_KEY]: {
        ...extension,
        repositories: attachments.map((attachment): ChannelGitRepositoryAttachment => ({
          address: attachment.address.coordinate,
          relayHints: attachment.relayHints,
          attachedAt: attachment.attachedAt,
          ...(attachment.detachedAt === undefined ? {} : { detachedAt: attachment.detachedAt }),
        })),
      },
    },
  };
}

/** Replace attachment intervals without disturbing ordinary or opaque channel metadata. */
export function withChannelGitRepositoryAttachments(
  metadata: ChannelMetadata,
  attachments: readonly GitRepositoryAttachment[],
): ChannelMetadata {
  const custom = isRecord(metadata.custom) ? metadata.custom : {};
  const extension = isRecord(custom[ARMADA_GIT_CHANNEL_METADATA_KEY]) ? custom[ARMADA_GIT_CHANNEL_METADATA_KEY] : {};
  const bounded = normalizeGitRepositoryAttachments(attachments)
    .map((attachment) => ({ ...attachment, relayHints: attachment.relayHints.slice(0, MAX_CHANNEL_GIT_RELAY_HINTS) }))
    .slice(0, MAX_CHANNEL_GIT_ATTACHMENTS);
  return {
    ...metadata,
    custom: {
      ...custom,
      [ARMADA_GIT_CHANNEL_METADATA_KEY]: {
        ...extension,
        repositories: bounded.map((attachment): ChannelGitRepositoryAttachment => ({
          address: attachment.address.coordinate,
          relayHints: attachment.relayHints,
          attachedAt: attachment.attachedAt,
          ...(attachment.detachedAt === undefined ? {} : { detachedAt: attachment.detachedAt }),
        })),
      },
    },
  };
}

/** A private Channel's independent key material, as delivered by an invite. */
export interface PrivateChannelKey {
  /** Channel id (32 bytes). */
  id: Uint8Array;
  /** Independent random key (32 bytes) — cryptographically unrelated to the root. */
  key: Uint8Array;
  epoch: bigint;
  /** Join-time preview name; the ChannelMetadata fold is the authority. */
  name: string;
  /**
   * Superseded keys, kept so HISTORY stays readable across rotations. Read-only.
   * `retiredAt` (epoch-s of the superseding rotation) is a hard read cutoff:
   * anything later under a retired key is refused. Absent on old records (uncapped).
   */
  priors?: Array<{ key: Uint8Array; epoch: bigint; retiredAt?: number }>;
}

/** A held root-key epoch (the current one plus retained priors for history). */
export interface HeldRoot {
  epoch: bigint;
  key: Uint8Array;
  /**
   * The epoch's Control Plane signer pubkey (`control_pk`, x-only hex) — HELD,
   * never derived (its `control_root` is staff-only, CORD-02 §2). Absent = LEGACY
   * pre-split epoch, folded at the member-derivable `concord/control` address.
   */
  controlPk?: string;
  /** Epoch-seconds of the superseding rotation — the hard read cutoff. Absent on the current root. */
  retiredAt?: number;
  /**
   * The npub whose Refounding minted this epoch — the snapshot authority for its
   * Guestbook (CORD-02 §5), recorded so historical snapshots stay verifiable.
   * Absent at genesis.
   */
  refounder?: string;
}

/**
 * A Concord community as the client holds it: rehydrated from the Community List
 * entry plus app relays. Channel definitions live on the Control Plane.
 */
export interface Community {
  id: Uint8Array;
  idHex: string;
  /** The proven owner (x-only hex) — verified against the id commitment. */
  owner: string;
  ownerSalt: Uint8Array;
  /** The current community_root at `rootEpoch`. */
  root: Uint8Array;
  rootEpoch: bigint;
  /** The CURRENT epoch's `control_pk` (see {@link HeldRoot.controlPk}); absent on legacy epochs. */
  controlPk?: string;
  /**
   * The CURRENT epoch's staff write secret (`control_root`, CORD-02 §2), delivered
   * via the staff Grant (CORD-04 §3) or a 136-byte rekey blob (CORD-06 §1). Gates
   * publishing, never authority.
   */
  controlRoot?: Uint8Array;
  /** Every held root epoch (current + retained priors), newest first. */
  heldRoots: HeldRoot[];
  /** Private-channel keys held (public channels derive from the root). */
  privateChannels: PrivateChannelKey[];
  relays: string[];
  /** Join-time preview name; the metadata fold is the authority. */
  name: string;
  /** The npub whose Refounding minted the current epoch (snapshot authority). */
  refounder?: string;
}

/**
 * A Channel's call coordinates (CORD-07 §1), derived from the same (secret, epoch)
 * as its Chat Plane, so they rotate with it.
 */
export interface VoiceKeys {
  /** The SFU room keypair: `pk` IS the room name, `sk` signs token grants. */
  room: GroupKey;
  /** The raw 32-byte media root; every per-sender frame key derives from it. */
  mediaKey: Uint8Array;
}

/**
 * A writer address's place in a restricted Channel's Writers ledger (CORD-03 §1):
 * its writer epoch, the window posts there stand in, and whom the epoch vouches for.
 */
export interface WriterWindow {
  epoch: bigint;
  /** Unix ms the window opened, inclusive. */
  from: number;
  /** Unix ms it closed, exclusive; absent while it still holds. */
  to?: number;
  /** The epoch's certifier (x-only hex); absent for one that named none. */
  certifier?: string;
}

/** One channel as the UI consumes it: folded definition + derived stream keys. */
export interface Channel {
  id: Uint8Array;
  idHex: string;
  name: string;
  isPrivate: boolean;
  /** Sidebar grouping (channelCategory.ts); undefined renders ungrouped. */
  category?: string;
  /** Sidebar position (channelOrder.ts); undefined sorts last, by name. */
  position?: number;
  /** The spec's rank-key position (CORD-03 §2), on the vsk-13 Roster; byte order, lower first. */
  positionKey?: string;
  /** The Category it files under (CORD-03 §4), by id, on the vsk-13 Roster. */
  categoryId?: string;
  /** Its topic (CORD-03 §2), at most 1024 bytes. */
  topic?: string;
  /** The presentation the channel opens to (channelView.ts); undefined reads as `chat`. */
  view?: ChannelView;
  /** When a converted Private Channel went private (`public_until`, unix ms; CORD-03 §2). */
  publicUntil?: number;
  /** Current-epoch call coordinates (CORD-07 §1), lazily derived (costs a point multiplication). */
  readonly voice: VoiceKeys;
  /**
   * Stream keys across held epochs, newest first. `retiredAt` = the rotation's
   * publish time; later rumors under that key are refused. A restricted Channel's
   * WRITER addresses (CORD-03 §1) ride here too, read-only and write-restricted.
   */
  streams: Array<{ epoch: bigint; group: StreamKeyView; retiredAt?: number; writer?: WriterWindow }>;
  /** The current write coordinate. */
  current: { epoch: bigint; group: GroupKey };
}
