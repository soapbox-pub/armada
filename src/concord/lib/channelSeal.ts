/**
 * A Private Channel's sealed metadata (CORD-03 §2): everything but what every
 * member needs to resolve access, NIP-44 under the Channel's conversation key at
 * the sealed epoch, naming its predecessor so it can't be replayed as a newer one.
 */

import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";

import type { SealedChannelMeta } from "@/concord/lib/control";
import { bytesToHex, channelGroupKey } from "@/concord/lib/derive";
import { isRankKey } from "@/concord/lib/rankKey";
import { cutName } from "@/concord/lib/roles";
import { normalizeChannelMetadata, type ChannelMetadata, type PrivateChannelKey } from "@/concord/lib/types";

/** What a seal opens to: the Channel's details, its creator, and when it went private. */
export interface OpenedChannelSeal {
  metadata: ChannelMetadata;
  creator?: string;
  publicUntil?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Seals already opened, by the conversation key, predecessor and ciphertext: an
 * opened seal is bound to the Channel and key that opened it, so another Channel
 * carrying the same ciphertext never reads as this one. Only successes are kept;
 * a seal that won't open is tried again on every fold (CORD-03 §2).
 */
const opened = new Map<string, OpenedChannelSeal>();
const OPENED_CAP = 2048;

/** Forget opened seals: they hold decrypted Channel details (cleared on logout). */
export function clearChannelSealMemo(): void {
  opened.clear();
}

/** The key the member holds for `epoch`, current or prior. */
function keyAt(held: PrivateChannelKey, epoch: bigint): Uint8Array | undefined {
  if (held.epoch === epoch) return held.key;
  return held.priors?.find((p) => p.epoch === epoch)?.key;
}

const CHANNEL_TOPIC_MAX_BYTES = 1024;
const UTF8 = new TextEncoder();

/**
 * A Channel's details normalized as a reader takes them (CORD-03 §2), plain or
 * opened from a seal: `name` cut and required, `custom` an object, and `position`,
 * `category` and `topic` outside their form read as absent. Undefined when it breaks its form.
 */
export function sanitizeChannelFields(c: Record<string, unknown>): ChannelMetadata | undefined {
  if (typeof c.name !== "string") return undefined;
  if (c.custom !== undefined && (!c.custom || typeof c.custom !== "object" || Array.isArray(c.custom))) return undefined;
  const meta = { ...c } as ChannelMetadata;
  meta.name = cutName(meta.name);
  if (meta.name.length === 0) return undefined;
  if (meta.position !== undefined && !isRankKey(meta.position)) delete meta.position;
  if (meta.category !== undefined && (typeof meta.category !== "string" || !/^[0-9a-f]{64}$/i.test(meta.category))) delete meta.category;
  if (meta.topic !== undefined && (typeof meta.topic !== "string" || meta.topic.length === 0 || UTF8.encode(meta.topic).length > CHANNEL_TOPIC_MAX_BYTES)) delete meta.topic;
  return normalizeChannelMetadata(meta);
}

/**
 * Open a sealed head with the member's keys, or undefined when they hold none for
 * its epoch or it doesn't open as a seal naming the edition's own predecessor.
 */
export function openChannelSeal(sealed: SealedChannelMeta, held: PrivateChannelKey): OpenedChannelSeal | undefined {
  const key = keyAt(held, sealed.epoch);
  if (!key) return undefined;
  const convKey = channelGroupKey(key, held.id, sealed.epoch).convKey;
  const memoKey = `${bytesToHex(convKey)}|${sealed.prevHex ?? ""}|${sealed.sealed}`;
  const hit = opened.get(memoKey);
  if (hit) return hit;
  let result: OpenedChannelSeal | undefined;
  try {
    const plain = JSON.parse(nip44Decrypt(sealed.sealed, convKey)) as Record<string, unknown>;
    const prev = typeof plain.prev === "string" && HEX64.test(plain.prev) ? plain.prev : undefined;
    if (plain && typeof plain === "object" && prev === sealed.prevHex) {
      const { prev: _prev, creator, public_until: publicUntil, private: _private, deleted: _deleted, ...rest } = plain;
      const metadata = sanitizeChannelFields(rest);
      if (metadata) {
        result = {
          metadata: { ...metadata, private: true },
          ...(typeof creator === "string" && HEX64.test(creator) ? { creator } : {}),
          ...(typeof publicUntil === "number" && Number.isSafeInteger(publicUntil) ? { publicUntil } : {}),
        };
      }
    }
  } catch {
    return undefined;
  }
  if (!result) return undefined;
  if (opened.size >= OPENED_CAP) opened.delete(opened.keys().next().value as string);
  opened.set(memoKey, result);
  return result;
}

/** Seal a Private Channel's details under its key at `epoch`, naming the predecessor (CORD-03 §2). */
export function sealChannelMetadata(
  metadata: ChannelMetadata,
  key: Uint8Array,
  channelId: Uint8Array,
  epoch: bigint,
  prevHex: string | undefined,
  extra?: { creator?: string; publicUntil?: number },
): string {
  const { private: _private, deleted: _deleted, ...rest } = metadata;
  const plain = {
    ...rest,
    ...(extra?.creator ? { creator: extra.creator } : {}),
    ...(extra?.publicUntil !== undefined ? { public_until: extra.publicUntil } : {}),
    prev: prevHex ?? null,
  };
  const sealed = nip44Encrypt(JSON.stringify(plain), channelGroupKey(key, channelId, epoch).convKey);
  return JSON.stringify({ private: true, epoch: epoch.toString(), sealed });
}

/**
 * A Private Channel's details sealed again under the key held now (CORD-03 §2,
 * Vector `needs_reseal`): when its head is sealed at an earlier epoch this member
 * can open, or is still plain. Undefined when nothing needs it, or when the details
 * can't be read, since a writer MUST NOT seal what it couldn't read.
 */
export function resealedChannelContent(
  def: { isPrivate: boolean; deleted?: boolean; metadata: ChannelMetadata; sealed?: SealedChannelMeta },
  held: PrivateChannelKey,
  headHex: string | undefined,
): string | undefined {
  if (!def.isPrivate || def.deleted) return undefined;
  if (def.sealed) {
    // A seal this device holds the key of its epoch for that won't open is junk: sealed again from the name it held (Vector `needs_reseal`).
    if (def.sealed.epoch === held.epoch) {
      if (openChannelSeal(def.sealed, held) || !held.name) return undefined;
      return sealChannelMetadata({ name: held.name, private: true }, held.key, held.id, held.epoch, headHex);
    }
    if (def.sealed.epoch > held.epoch) return undefined;
    const opened = openChannelSeal(def.sealed, held);
    // Junk under a key this device holds for its epoch is sealed again from the name held too.
    if (!opened && keyAt(held, def.sealed.epoch) && held.name) return sealChannelMetadata({ name: held.name, private: true }, held.key, held.id, held.epoch, headHex);
    if (!opened || !opened.metadata.name) return undefined;
    return sealChannelMetadata(opened.metadata, held.key, held.id, held.epoch, headHex, {
      ...(opened.creator ? { creator: opened.creator } : {}),
      ...(opened.publicUntil !== undefined ? { publicUntil: opened.publicUntil } : {}),
    });
  }
  if (!def.metadata.name) return undefined;
  return sealChannelMetadata(def.metadata, held.key, held.id, held.epoch, headHex);
}
