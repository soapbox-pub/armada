/**
 * A Public Channel's published history (CORD-03 §2 `history`): the earlier planes its
 * history was written on that members may not hold, each by its own secret, so a member
 * who joined after a Refounding, or after a Private Channel was made public, reads what
 * was said before.
 */
import { bytesToHex, channelGroupKey, groupKeyFromSecret, hex32, type GroupKey } from "@/concord/lib/derive";
import type { Community, ChannelMetadata } from "@/concord/lib/types";

/** The ChannelMetadata field that publishes a Channel's earlier planes. */
export const HISTORY_FIELD = "history";

/** At most this many earlier planes, so the edition stays well under a relay's 64 KB. */
export const MAX_HISTORY = 128;

export interface HistoryPlane {
  /** The epoch its messages commit. */
  epoch: bigint;
  group: GroupKey;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The planes `meta` publishes; an entry that isn't `[epoch < 2^53, "<64 hex secret>"]` names nothing. */
export function publishedHistory(meta: ChannelMetadata | undefined): HistoryPlane[] {
  const entries = meta?.[HISTORY_FIELD];
  if (!Array.isArray(entries)) return [];
  const out: HistoryPlane[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_HISTORY) break;
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [epoch, secret] = entry as unknown[];
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) continue;
    if (typeof secret !== "string" || !HEX64.test(secret)) continue;
    const group = groupKeyFromSecret(hex32(secret));
    if (group) out.push({ epoch: BigInt(epoch), group });
  }
  return out;
}

/**
 * `held` with `add` merged in, each address once, oldest epochs dropped past the cap,
 * as the field's JSON; undefined when `add` brings nothing new.
 */
export function mergedHistory(held: readonly HistoryPlane[], add: readonly HistoryPlane[]): [number, string][] | undefined {
  const all = [...held];
  for (const plane of add) if (!all.some((p) => p.group.pk === plane.group.pk)) all.push(plane);
  if (all.length === held.length) return undefined;
  all.sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0));
  return all.slice(Math.max(0, all.length - MAX_HISTORY)).map((p) => [Number(p.epoch), bytesToHex(p.group.sk)]);
}

/** `meta` publishing `add` too, or undefined when it already does. */
export function withHistory(meta: ChannelMetadata, add: readonly HistoryPlane[]): ChannelMetadata | undefined {
  const history = mergedHistory(publishedHistory(meta), add);
  return history ? { ...meta, [HISTORY_FIELD]: history } : undefined;
}

/** The planes of a Private Channel's own epochs this device holds, never one keyed by the root. */
export function privatePlanes(community: Community, channelIdHex: string): HistoryPlane[] {
  const held = community.privateChannels.find((c) => bytesToHex(c.id) === channelIdHex);
  if (!held) return [];
  const root = bytesToHex(community.root);
  return [{ key: held.key, epoch: held.epoch }, ...(held.priors ?? [])]
    .filter((k) => bytesToHex(k.key) !== root)
    .map((k) => ({ epoch: k.epoch, group: channelGroupKey(k.key, held.id, k.epoch) }));
}

/** Each past root epoch this device holds, oldest first, at or past `from`, with the Channel's plane there. */
export function pastRootPlanes(community: Community, channelIdHex: string, from = 0n): HistoryPlane[] {
  const id = hex32(channelIdHex);
  return community.heldRoots
    .filter((r) => r.epoch >= from && r.epoch < community.rootEpoch)
    .sort((a, b) => (a.epoch < b.epoch ? -1 : 1))
    .map((r) => ({ epoch: r.epoch, group: channelGroupKey(r.key, id, r.epoch) }));
}
