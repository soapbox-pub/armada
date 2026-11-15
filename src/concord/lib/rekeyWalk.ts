/**
 * Which Private Channels a member's rekey walk follows, and from which epoch
 * (CORD-06 §2, Vector `follow_rekeys`). A held Channel is walked from the epoch
 * after its key. One the fold lets this member read but no key reached yet is
 * walked from its sealed head's epoch (CORD-03 §2): the rotation that minted it
 * carries every reader it let in, and Vector's walk from epoch 0 reaches the same
 * rotation one hop at a time.
 */

import type { FoldedControl, SealedChannelMeta } from "@/concord/lib/control";
import { bytesToHex, hex32 } from "@/concord/lib/derive";
import { channelPermissions, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

export interface WalkTarget {
  id: Uint8Array;
  idHex: string;
  /** The key held; absent while keyless. */
  key?: Uint8Array;
  /** The epoch held, or the one before the walk's first while keyless. */
  epoch: bigint;
  /** The first epoch the walk reads. */
  from: bigint;
  sealed?: SealedChannelMeta;
}

export function walkTargets(
  community: Community | undefined,
  folded: FoldedControl | undefined,
  me: string | undefined,
  cuts: ReadonlyArray<{ id: string; epoch: number }> | undefined,
): WalkTarget[] {
  if (!community) return [];
  const out: WalkTarget[] = [];
  const held = new Set<string>();
  for (const ch of community.privateChannels) {
    const idHex = bytesToHex(ch.id);
    held.add(idHex);
    out.push({ id: ch.id, idHex, key: ch.key, epoch: ch.epoch, from: ch.epoch + 1n, ...(folded?.channels?.get(idHex)?.sealed ? { sealed: folded.channels.get(idHex)!.sealed } : {}) });
  }
  if (!folded?.rankedRoster || !folded.channels || !me || folded.banned.has(me)) return out;
  for (const def of folded.channels.values()) {
    if (!def.isPrivate || def.deleted || held.has(def.channelIdHex) || !def.sealed) continue;
    const reads = me === folded.ownerHex || (channelPermissions(folded.roster, folded.ownerHex, me, def.channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n;
    if (!reads) continue;
    // A rotation that cut this member is never walked back below.
    const cut = cuts?.find((c) => c.id.toLowerCase() === def.channelIdHex)?.epoch;
    let from = def.sealed.epoch > 0n ? def.sealed.epoch : 1n;
    if (cut !== undefined && BigInt(cut) > from) from = BigInt(cut);
    out.push({ id: hex32(def.channelIdHex), idHex: def.channelIdHex, epoch: from - 1n, from, sealed: def.sealed });
  }
  return out;
}
