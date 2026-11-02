/**
 * Key deliveries (CORD-03 §5, CORD-06 §1): a kind-3303 rumor tagged
 * `["delivery", "<form>"]` handing keys to members who are owed them, on a
 * Channel's ACCESS PLANE. Never a rotation: it advances no epoch, and nothing it
 * omits removes anyone.
 */

import { channelAccessGroupKey, type GroupKey } from "@/concord/lib/derive";
import { KIND_REKEY, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { channelPermissions, hasPermission, Permissions, type CommunityRoles } from "@/concord/lib/roles";
import type { RekeyBlob } from "@/concord/lib/rekey";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";

/** How far past the held epoch a delivered key may be (CORD-03 §5). */
export const MAX_DELIVERY_EPOCH_AHEAD = 1024n;

const DECIMAL = /^(0|[1-9][0-9]*)$/;
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
  /** Writer certificates by recipient (CORD-03 §1). */
  certs: Map<string, string>;
  /** Part of a writer epoch's minting delivery, `[part, parts]`. */
  mint?: [number, number];
  blobs: RekeyBlob[];
}

/** A Channel's access plane at the Community's current root epoch (CORD-03 §5). */
export function accessPlane(community: Community, channelId: Uint8Array): GroupKey {
  return channelAccessGroupKey(community.root, channelId, community.rootEpoch);
}

/** Parse an opened 3303 as a delivery, or undefined when it isn't one. */
export function parseDelivery(opened: OpenedEvent): ParsedDelivery | undefined {
  if (opened.kind !== KIND_REKEY) return undefined;
  if (opened.sealKind !== undefined && opened.sealKind !== KIND_SEAL_ENCRYPTED) return undefined;
  const get = (name: string) => opened.tags.find((t) => t[0] === name);
  const form = get("delivery")?.[1];
  const scope = get("scope")?.[1];
  const epoch = get("newepoch")?.[1];
  if (!form || !scope || !HEX64.test(scope) || !epoch || !DECIMAL.test(epoch)) return undefined;
  const writer = get("writer")?.[1];
  const certs = new Map<string, string>();
  for (const t of opened.tags) {
    if (t[0] === "cert" && typeof t[1] === "string" && HEX64.test(t[1]) && typeof t[2] === "string" && /^[0-9a-f]{128}$/i.test(t[2])) {
      if (!certs.has(t[1].toLowerCase())) certs.set(t[1].toLowerCase(), t[2].toLowerCase());
    }
  }
  const mintTag = get("mint");
  let mint: [number, number] | undefined;
  if (mintTag && DECIMAL.test(mintTag[1] ?? "") && DECIMAL.test(mintTag[2] ?? "")) {
    const part = Number(mintTag[1]);
    const parts = Number(mintTag[2]);
    if (part >= 1 && part <= parts && parts <= 0xffffffff) mint = [part, parts];
  }
  let blobs: RekeyBlob[] = [];
  try {
    const parsed = JSON.parse(opened.content) as unknown;
    if (Array.isArray(parsed)) {
      blobs = parsed.filter(
        (b): b is RekeyBlob => Boolean(b) && typeof (b as RekeyBlob).locator === "string" && typeof (b as RekeyBlob).wrapped === "string",
      );
    }
  } catch {
    return undefined;
  }
  return {
    deliverer: opened.author,
    form,
    scopeIdHex: scope.toLowerCase(),
    newEpoch: BigInt(epoch),
    ...(writer && HEX64.test(writer) ? { writer: writer.toLowerCase() } : {}),
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
