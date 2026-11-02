/**
 * A Private Channel's sealed metadata (CORD-03 §2): everything but what every
 * member needs to resolve access, NIP-44 under the Channel's conversation key at
 * the sealed epoch, naming its predecessor so it can't be replayed as a newer one.
 */

import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";

import type { SealedChannelMeta } from "@/concord/lib/control";
import { channelGroupKey } from "@/concord/lib/derive";
import { cutName } from "@/concord/lib/roster";
import type { ChannelMetadata, PrivateChannelKey } from "@/concord/lib/types";

/** What a seal opens to: the Channel's details, its creator, and when it went private. */
export interface OpenedChannelSeal {
  metadata: ChannelMetadata;
  creator?: string;
  publicUntil?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Seals already opened, by ciphertext: a seal is immutable, and the sidebar re-renders often. */
const opened = new Map<string, OpenedChannelSeal | null>();
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

/**
 * Open a sealed head with the member's keys, or undefined when they hold none for
 * its epoch or it doesn't open as a seal naming the edition's own predecessor.
 */
export function openChannelSeal(sealed: SealedChannelMeta, held: PrivateChannelKey): OpenedChannelSeal | undefined {
  const key = keyAt(held, sealed.epoch);
  if (!key) return undefined;
  const memoKey = `${sealed.prevHex ?? ""}|${sealed.sealed}`;
  const hit = opened.get(memoKey);
  if (hit !== undefined) return hit ?? undefined;
  let result: OpenedChannelSeal | null = null;
  try {
    const plain = JSON.parse(nip44Decrypt(sealed.sealed, channelGroupKey(key, held.id, sealed.epoch).convKey)) as Record<string, unknown>;
    const prev = typeof plain.prev === "string" && HEX64.test(plain.prev) ? plain.prev : undefined;
    if (typeof plain.name === "string" && prev === sealed.prevHex) {
      const { prev: _prev, creator, public_until: publicUntil, private: _private, deleted: _deleted, ...rest } = plain;
      const name = cutName(plain.name);
      if (name.length > 0) {
        result = {
          metadata: { ...rest, name, private: true } as ChannelMetadata,
          ...(typeof creator === "string" && HEX64.test(creator) ? { creator } : {}),
          ...(typeof publicUntil === "number" && Number.isSafeInteger(publicUntil) ? { publicUntil } : {}),
        };
      }
    }
  } catch {
    result = null;
  }
  if (opened.size >= OPENED_CAP) opened.delete(opened.keys().next().value as string);
  opened.set(memoKey, result);
  return result ?? undefined;
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
