/**
 * Read Message History (CORD-03 §5): a member delivered a Private Channel's key
 * while holding READ_MESSAGE_HISTORY there also receives every earlier epoch its
 * deliverer holds, read-only: the epoch's address and conversation key, never the
 * secret. One kind-3303 event per epoch on the access plane, tagged
 * `["delivery", "history"]` and scoped to the Channel's history scope; each blob's
 * plaintext is `history_scope ‖ epoch (u64 BE) ‖ address ‖ conversation key`.
 * Ported from Vector's `rekey.rs` (`HistoryView`, `build_history_rumor`,
 * `parse_history_delivery`) and `collect_history`.
 */

import { noteRefused, refusedBefore } from "@/concord/lib/blobOnce";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { bytesToHex, hex32, historyScope } from "@/concord/lib/derive";
import { KIND_REKEY, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { base64ToBytes, bytesToBase64, MAX_REKEY_BLOBS_RECEIVED, myLocator, parseRekeyBlobs, uniqueTag, type RekeyBlob } from "@/concord/lib/rekey";
import { buildRumor, type OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";

/** At most this many blobs in one history event (Vector `MAX_WIDE_BLOBS_PER_EVENT`). */
export const MAX_HISTORY_BLOBS_PER_EVENT = 60;

/** A past epoch's read view: where its messages are, and the key that opens them. */
export interface HistoryView {
  /** x-only hex of the epoch's Chat Plane address. */
  address: string;
  /** Its NIP-44 conversation key, hex. */
  convKey: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** The base64 plaintext of a history blob. */
export function encodeHistoryPlaintext(channelId: Uint8Array, epoch: bigint, view: HistoryView): string {
  const pt = new Uint8Array(104);
  pt.set(historyScope(channelId), 0);
  new DataView(pt.buffer).setBigUint64(32, epoch, false);
  pt.set(hex32(view.address), 40);
  pt.set(hex32(view.convKey), 72);
  return bytesToBase64(pt);
}

/** A history blob's plaintext, refused when its scope or epoch belong elsewhere. */
export function decodeHistoryPlaintext(b64: string, channelId: Uint8Array, epoch: bigint): HistoryView {
  const pt = base64ToBytes(b64);
  if (pt.length !== 104) throw new Error(`history blob is ${pt.length} bytes`);
  const scope = historyScope(channelId);
  if (scope.some((b, i) => pt[i] !== b)) throw new Error("history blob from another scope");
  if (new DataView(pt.buffer, pt.byteOffset).getBigUint64(32, false) !== epoch) throw new Error("history blob from another epoch");
  return { address: bytesToHex(pt.subarray(40, 72)), convKey: bytesToHex(pt.subarray(72, 104)) };
}

/** Where `recipient`'s history blob for `epoch` from `deliverer` sits. */
export function historyLocator(deliverer: string, recipient: string, channelIdHex: string, epoch: bigint): string {
  return myLocator(deliverer, recipient, bytesToHex(historyScope(hex32(channelIdHex))), epoch);
}

export interface HistoryDelivery {
  deliverer: string;
  epoch: bigint;
  blobs: RekeyBlob[];
}

/** An opened access-plane event as `channelIdHex`'s history, or undefined. */
export function parseHistoryDelivery(opened: OpenedEvent, channelIdHex: string): HistoryDelivery | undefined {
  if (opened.kind !== KIND_REKEY) return undefined;
  if (opened.sealKind !== undefined && opened.sealKind !== KIND_SEAL_ENCRYPTED) return undefined;
  if (uniqueTag(opened.tags, "delivery") !== "history") return undefined;
  if (uniqueTag(opened.tags, "scope")?.toLowerCase() !== bytesToHex(historyScope(hex32(channelIdHex)))) return undefined;
  const epoch = uniqueTag(opened.tags, "newepoch");
  if (!epoch || !DECIMAL.test(epoch)) return undefined;
  const blobs = parseRekeyBlobs(opened.content);
  if (!blobs || blobs.length > MAX_REKEY_BLOBS_RECEIVED) return undefined;
  return { deliverer: opened.author, epoch: BigInt(epoch), blobs };
}

/** One epoch's history event (Vector `build_history_rumor`). */
export function buildHistoryRumor(deliverer: string, channelIdHex: string, epoch: bigint, blobs: RekeyBlob[], atSecs: number): NostrRumor {
  if (blobs.length > MAX_HISTORY_BLOBS_PER_EVENT) throw new Error("too many history blobs for one event");
  return buildRumor({
    kind: KIND_REKEY,
    content: JSON.stringify(blobs),
    tags: [
      ["scope", bytesToHex(historyScope(hex32(channelIdHex)))],
      ["newepoch", epoch.toString()],
      ["delivery", "history"],
    ],
    pubkey: deliverer,
    createdAtSecs: atSecs,
  });
}

// ── The views this device holds ──────────────────────────────────────────────

const held = new KvPrefixCache<HistoryView>({ prefix: "c2hist:" });

const heldId = (communityIdHex: string, channelIdHex: string, epoch: bigint) => `${communityIdHex}:${channelIdHex}:${epoch}`;

export function historyViewsReady(): Promise<void> {
  return held.ready();
}

/** Drop the read-only history views this device holds in a Community, once it leaves it. */
export async function forgetHistoryViews(communityIdHex: string): Promise<void> {
  await held.ready();
  for (const id of held.ids()) if (id.startsWith(`${communityIdHex}:`)) held.delete(id);
}

let generation = 0;
held.subscribe(() => void generation++);

export function subscribeHistoryViews(listener: () => void): () => void {
  return held.subscribe(listener);
}

/** Moves whenever a view lands or the store warms, for `useSyncExternalStore`. */
export function historyViewsGeneration(): number {
  return generation;
}

/** A history view as a read-only stream: opens the epoch's messages, signs nothing. */
export function historyGroup(view: HistoryView): { pk: string; readonly convKey: Uint8Array; restricted: true } {
  let key: Uint8Array | undefined;
  return { pk: view.address, get convKey() { return (key ??= hex32(view.convKey)); }, restricted: true };
}

/** Every history view held for a Channel, by epoch. */
export function heldHistoryViews(communityIdHex: string, channelIdHex: string): Array<{ epoch: bigint; view: HistoryView }> {
  const prefix = `${communityIdHex}:${channelIdHex}:`;
  return held
    .ids()
    .filter((id) => id.startsWith(prefix))
    .flatMap((id) => {
      const e = id.slice(prefix.length);
      const view = held.get(id);
      return view && DECIMAL.test(e) ? [{ epoch: BigInt(e), view }] : [];
    })
    .sort((a, b) => (a.epoch < b.epoch ? 1 : a.epoch > b.epoch ? -1 : 0));
}

export function storeHistoryView(communityIdHex: string, channelIdHex: string, epoch: bigint, view: HistoryView): void {
  held.set(heldId(communityIdHex, channelIdHex, epoch), view);
}

/**
 * Take the history this member is owed (Vector `collect_history`): only from a
 * deliverer the fold lets into the Channel, only epochs below the current one this
 * device holds no key or view for. Returns how many epochs it took.
 */
export async function adoptHistoryDeliveries(
  deliveries: readonly HistoryDelivery[],
  o: {
    communityIdHex: string;
    channelIdHex: string;
    me: string;
    currentEpoch: bigint;
    heldEpochs: ReadonlySet<bigint>;
    trusted: (deliverer: string) => boolean;
    decrypt: (deliverer: string, wrapped: string) => Promise<string>;
  },
): Promise<number> {
  const have = new Set([...o.heldEpochs, o.currentEpoch, ...heldHistoryViews(o.communityIdHex, o.channelIdHex).map((v) => v.epoch)]);
  let taken = 0;
  for (const d of deliveries) {
    if (!o.trusted(d.deliverer) || d.epoch >= o.currentEpoch || have.has(d.epoch)) continue;
    const locator = historyLocator(d.deliverer, o.me, o.channelIdHex, d.epoch);
    const blob = d.blobs.find((b) => b.locator.toLowerCase() === locator);
    const purpose = `history:${o.channelIdHex}:${d.epoch}`;
    if (!blob || refusedBefore(purpose, d.deliverer, blob.wrapped)) continue;
    try {
      const view = decodeHistoryPlaintext(await o.decrypt(d.deliverer, blob.wrapped), hex32(o.channelIdHex), d.epoch);
      storeHistoryView(o.communityIdHex, o.channelIdHex, d.epoch, view);
      have.add(d.epoch);
      taken++;
    } catch {
      // a blob that won't open is never a verdict
      noteRefused(purpose, d.deliverer, blob.wrapped);
    }
  }
  return taken;
}
