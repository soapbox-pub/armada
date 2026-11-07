/**
 * Key deliveries (CORD-03 §5, CORD-06 §1): a kind-3303 rumor tagged
 * `["delivery", "<form>"]` handing keys to members who are owed them, on a
 * Channel's ACCESS PLANE. Never a rotation: it advances no epoch, and nothing it
 * omits removes anyone.
 */

import { channelAccessGroupKey, hex32, type GroupKey } from "@/concord/lib/derive";
import { buildHistoryRumor, encodeHistoryPlaintext, historyLocator, MAX_HISTORY_BLOBS_PER_EVENT, type HistoryView } from "@/concord/lib/history";
import { KIND_REKEY, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { channelPermissions, hasPermission, Permissions, type CommunityRoles } from "@/concord/lib/roles";
import { bytesToBase64, encodeWrappedKey, MAX_REKEY_BLOBS_RECEIVED, myLocator, parseRekeyBlobs, REKEY_BLOBS_PER_EVENT, uniqueTag, type RekeyBlob } from "@/concord/lib/rekey";
import { buildRumor, type OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const U32_TEXT = /^\+?[0-9]+$/;
const HEX64 = /^[0-9a-f]{64}$/i;

export interface ParsedDelivery {
  /** The deliverer's real pubkey (the seal's signer). */
  deliverer: string;
  form: string;
  /** The Channel's id, or its writer, certifier or history scope. */
  scopeIdHex: string;
  newEpoch: bigint;
  /** Writer and certifier scopes: the pubkey the delivered secret derives to. */
  writer?: string;
  /** Writer certificates as carried, `[recipient, cert]`, repeats kept (CORD-03 §1, Vector `certs`). */
  certs: Array<[string, string]>;
  /** Part of a writer epoch's minting delivery, `[part, parts]`. */
  mint?: [number, number];
  blobs: RekeyBlob[];
}

/** A Channel's access plane at the Community's current root epoch (CORD-03 §5). */
export function accessPlane(community: Community, channelId: Uint8Array): GroupKey {
  return channelAccessGroupKey(community.root, channelId, community.rootEpoch);
}

/** Parse an opened 3303 as a delivery, or undefined when it isn't one (Vector's `parse_access_delivery`). */
export function parseDelivery(opened: OpenedEvent): ParsedDelivery | undefined {
  if (opened.kind !== KIND_REKEY) return undefined;
  if (opened.sealKind !== undefined && opened.sealKind !== KIND_SEAL_ENCRYPTED) return undefined;
  const form = uniqueTag(opened.tags, "delivery");
  const scope = uniqueTag(opened.tags, "scope");
  const epoch = uniqueTag(opened.tags, "newepoch");
  const writer = uniqueTag(opened.tags, "writer");
  if (!form || !scope || !HEX64.test(scope) || !epoch || !DECIMAL.test(epoch) || BigInt(epoch) >= 1n << 64n) return undefined;
  if (writer === null || (writer !== undefined && !HEX64.test(writer))) return undefined;
  // A malformed certificate is no certificate; it never refuses the delivery it rides.
  const certs: Array<[string, string]> = [];
  for (const t of opened.tags) {
    if (certs.length >= MAX_REKEY_BLOBS_RECEIVED) break;
    if (t.length === 3 && t[0] === "cert" && HEX64.test(t[1]) && /^[0-9a-f]{128}$/i.test(t[2])) certs.push([t[1].toLowerCase(), t[2].toLowerCase()]);
  }
  const mintTag = opened.tags.find((t) => t[0] === "mint");
  let mint: [number, number] | undefined;
  // As Rust's `u32::from_str` reads them: a leading `+` or zeros allowed.
  if (mintTag && U32_TEXT.test(mintTag[1] ?? "") && U32_TEXT.test(mintTag[2] ?? "")) {
    const part = Number(mintTag[1]);
    const parts = Number(mintTag[2]);
    if (part >= 1 && part <= parts && parts <= 0xffffffff && Number.isSafeInteger(part)) mint = [part, parts];
  }
  const blobs = parseRekeyBlobs(opened.content);
  if (!blobs) return undefined;
  return {
    deliverer: opened.author,
    form,
    scopeIdHex: scope.toLowerCase(),
    newEpoch: BigInt(epoch),
    ...(writer ? { writer: writer.toLowerCase() } : {}),
    certs,
    ...(mint ? { mint } : {}),
    blobs,
  };
}

/**
 * Whether a reader adopts a Channel key `deliverer` handed over (CORD-03 §5): the
 * reader's fold entitles them, the deliverer holds the Channel (entitled, or
 * MANAGE_CHANNELS, or the owner) and isn't banned.
 */
export function deliveryTrusted(
  roster: CommunityRoles,
  ownerHex: string,
  banned: ReadonlySet<string>,
  channelIdHex: string,
  me: string,
  deliverer: string,
): boolean {
  if (banned.has(deliverer)) return false;
  const view = (who: string) => (channelPermissions(roster, ownerHex, who, channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n;
  if (!view(me)) return false;
  if (deliverer === ownerHex) return true;
  return view(deliverer) || hasPermission(roster, deliverer, Permissions.MANAGE_CHANNELS);
}

/** At most this many blobs in an event that hands its recipients writer certificates (Vector `MAX_CERTIFIED_BLOBS_PER_EVENT`). */
export const MAX_CERTIFIED_BLOBS_PER_EVENT = 48;

/**
 * A key delivery's rumors (Vector `build_deliveries`): the key of `scopeIdHex`'s
 * `epoch`, one blob per recipient, at most {@link REKEY_BLOBS_PER_EVENT} an event, or
 * {@link MAX_CERTIFIED_BLOBS_PER_EVENT} when each recipient's writer certificate rides
 * the event carrying its blob. A writer key names the address it derives to; `mint`
 * marks each event a part of a writer epoch's minting delivery.
 */
export async function buildAccessDeliveries(
  deliverer: string,
  encrypt: (recipient: string, plaintext: string) => Promise<string>,
  o: {
    scopeIdHex: string;
    epoch: bigint;
    key: Uint8Array;
    recipients: readonly string[];
    atSecs: number;
    writer?: string;
    certs?: ReadonlyMap<string, string>;
    mint?: boolean;
  },
): Promise<NostrRumor[]> {
  const plain = bytesToBase64(encodeWrappedKey(hex32(o.scopeIdHex), o.epoch, o.key));
  const blobs: RekeyBlob[] = [];
  for (const r of o.recipients) blobs.push({ locator: myLocator(deliverer, r, o.scopeIdHex, o.epoch), wrapped: await encrypt(r, plain) });
  const perEvent = o.certs && o.certs.size > 0 ? MAX_CERTIFIED_BLOBS_PER_EVENT : REKEY_BLOBS_PER_EVENT;
  const parts = Math.max(1, Math.ceil(blobs.length / perEvent));
  const out: NostrRumor[] = [];
  for (let i = 0; i < parts; i++) {
    const who = o.recipients.slice(i * perEvent, (i + 1) * perEvent);
    const tags: string[][] = [["scope", o.scopeIdHex], ["newepoch", o.epoch.toString()], ["delivery", "access"]];
    if (o.writer) tags.push(["writer", o.writer]);
    for (const r of who) {
      const cert = o.certs?.get(r);
      if (cert) tags.push(["cert", r, cert]);
    }
    if (o.mint) tags.push(["mint", String(i + 1), String(parts)]);
    out.push(buildRumor({ kind: KIND_REKEY, content: JSON.stringify(blobs.slice(i * perEvent, (i + 1) * perEvent)), tags, pubkey: deliverer, createdAtSecs: o.atSecs }));
  }
  return out;
}

/**
 * Every past epoch of a Channel this device can read, read-only, for `recipients`
 * (Vector `deliver_history`): one event per epoch, at most 60 blobs each.
 */
export async function buildHistoryDeliveries(
  deliverer: string,
  encrypt: (recipient: string, plaintext: string) => Promise<string>,
  o: { channelIdHex: string; views: ReadonlyArray<{ epoch: bigint; view: HistoryView }>; recipients: readonly string[]; atSecs: number },
): Promise<NostrRumor[]> {
  if (o.recipients.length === 0) return [];
  const out: NostrRumor[] = [];
  for (const { epoch, view } of [...o.views].sort((a, b) => (a.epoch < b.epoch ? -1 : 1))) {
    const plain = encodeHistoryPlaintext(hex32(o.channelIdHex), epoch, view);
    const blobs: RekeyBlob[] = [];
    for (const r of o.recipients) blobs.push({ locator: historyLocator(deliverer, r, o.channelIdHex, epoch), wrapped: await encrypt(r, plain) });
    for (let i = 0; i < blobs.length; i += MAX_HISTORY_BLOBS_PER_EVENT) {
      out.push(buildHistoryRumor(deliverer, o.channelIdHex, epoch, blobs.slice(i, i + MAX_HISTORY_BLOBS_PER_EVENT), o.atSecs));
    }
  }
  return out;
}
