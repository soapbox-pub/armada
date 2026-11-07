/**
 * A Channel rotation published on its own: what a Private Channel's birth and a
 * Public Channel's conversion deliver before their first sealed edition (CORD-03 §2).
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { bytesToHex, channelRekeyGroupKey } from "@/concord/lib/derive";
import type { AuthorityCitation } from "@/concord/lib/edition";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRekeyRumors, bytesToBase64, encodeWrappedKey, myLocator, type RekeyBlob } from "@/concord/lib/rekey";
import { sealRumor, wrapSeal, type StreamSigner } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { t } from "@/i18n/intl";

interface RelayPool {
  relay(url: string): { event(e: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown> };
}

/** Publish one Channel rotation (CORD-06 §1) handing `key` at `epoch` to `recipients`, the rotator always among them. */
export async function publishChannelRotation(
  nostr: RelayPool,
  community: Community,
  user: { pubkey: string; signer: StreamSigner & { nip44?: { encrypt(pubkey: string, plaintext: string): Promise<string> } } },
  o: { channelId: Uint8Array; epoch: bigint; key: Uint8Array; prevEpoch: bigint; prevCommit: string; recipients: string[]; authority?: AuthorityCitation },
): Promise<void> {
  const nip44 = user.signer.nip44;
  if (!nip44) throw new Error(t({ id: "useRekey.signerCantRotate", defaultMessage: "This signer can't rotate keys (NIP-44 unsupported)." }));
  const idHex = bytesToHex(o.channelId);
  const plain = bytesToBase64(encodeWrappedKey(o.channelId, o.epoch, o.key));
  const blobs: RekeyBlob[] = [];
  for (const pk of new Set([user.pubkey, ...o.recipients])) {
    blobs.push({ locator: myLocator(user.pubkey, pk, idHex, o.epoch), wrapped: await nip44.encrypt(pk, plain) });
  }
  const address = channelRekeyGroupKey(community.root, o.channelId, o.epoch);
  const rumors = buildRekeyRumors(
    user.pubkey,
    { scope: { kind: "channel", channelId: o.channelId }, newEpoch: o.epoch, prevEpoch: o.prevEpoch, prevCommit: o.prevCommit },
    blobs,
    Date.now(),
    o.authority,
  );
  for (const rumor of rumors) {
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, user.signer), address);
    const results = await Promise.allSettled(
      community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
    );
    if (!results.some((r) => r.status === "fulfilled")) {
      throw new Error(t({ id: "useRekey.noRelayAcceptedKeyDelivery", defaultMessage: "No relay accepted the channel's key." }));
    }
  }
}

