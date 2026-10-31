/**
 * Channel categories — an Armada client convention (see CORD.md): a Channel MAY
 * carry `custom["armada.category"] = { name }` (CORD-02 §6).
 *
 * A category is EMERGENT, not an entity: it exists while some visible Channel
 * names it. So there's no list to sync or clobber, a member sees a category only
 * when they can see one of its channels (`channelsView` omits unheld private
 * channels), and an empty heading can't leak hidden channels. Channel metadata is
 * still readable by every member on the Control Plane: this is display, not access
 * control.
 */

import { NAME_MAX_BYTES, utf8Len, type ChannelMetadata } from "@/concord/lib/types";

export const ARMADA_CHANNEL_CATEGORY_METADATA_KEY = "armada.category";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The channel's category name, or undefined. Bounded by the 64-byte name limit
 * (CORD-02 §6); over-long or blank reads as uncategorized.
 */
export function channelCategory(metadata: ChannelMetadata): string | undefined {
  const extension = isRecord(metadata.custom) ? metadata.custom[ARMADA_CHANNEL_CATEGORY_METADATA_KEY] : undefined;
  if (!isRecord(extension) || typeof extension.name !== "string") return undefined;
  const name = extension.name.trim();
  if (!name || utf8Len(name) > NAME_MAX_BYTES) return undefined;
  return name;
}

/** Metadata with the category set (or cleared), other extensions untouched. */
export function withChannelCategory(metadata: ChannelMetadata, name: string | undefined): ChannelMetadata {
  const custom: Record<string, unknown> = isRecord(metadata.custom) ? { ...metadata.custom } : {};
  const trimmed = name?.trim();
  if (trimmed) custom[ARMADA_CHANNEL_CATEGORY_METADATA_KEY] = { name: trimmed };
  else delete custom[ARMADA_CHANNEL_CATEGORY_METADATA_KEY];
  const next: ChannelMetadata = { ...metadata };
  if (Object.keys(custom).length > 0) next.custom = custom;
  else delete next.custom;
  return next;
}

/** Group identity: "Voice" and "voice" are one category, not two near-duplicates. */
export function categoryKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Category names in use, in display order, one per casefolded group — what a
 * "move to category" picker offers, to avoid near-duplicate spellings.
 */
export function categoryNames<T>(
  channels: readonly T[],
  categoryOf: (channel: T) => string | undefined,
): string[] {
  const byKey = new Map<string, string>();
  for (const channel of channels) {
    const name = categoryOf(channel)?.trim();
    if (name && !byKey.has(categoryKey(name))) byKey.set(categoryKey(name), name);
  }
  return [...byKey.values()];
}

/** One rendered group: a heading (or the uncategorized run) and its channels. */
export interface ChannelCategory<T> {
  key: string;
  /** Display spelling, from the group's first channel. */
  name: string;
  channels: T[];
}

/**
 * Partition channels (ALREADY in display order) into the uncategorized run, then
 * the categories. Categories appear in order of their first channel, so a
 * category's position is READ OFF its first member (no separate arrangement).
 * The displayed spelling comes from the first channel, deterministically.
 */
export function groupChannelsByCategory<T extends { name: string }>(
  channels: readonly T[],
  categoryOf: (channel: T) => string | undefined,
): { uncategorized: T[]; categories: ChannelCategory<T>[] } {
  const uncategorized: T[] = [];
  const categories: ChannelCategory<T>[] = [];
  const byKey = new Map<string, ChannelCategory<T>>();

  for (const channel of channels) {
    const raw = categoryOf(channel);
    const name = raw?.trim();
    if (!name) {
      uncategorized.push(channel);
      continue;
    }
    const key = categoryKey(name);
    let group = byKey.get(key);
    if (!group) {
      group = { key, name, channels: [] };
      byKey.set(key, group);
      categories.push(group);
    }
    group.channels.push(channel);
  }

  return { uncategorized, categories };
}

/** Muted channels it takes to fold them into the sidebar's "Muted" group. */
const MUTED_GROUP_MIN = 3;

/**
 * The channels the sidebar folds into its "Muted" group: none below
 * {@link MUTED_GROUP_MIN}, and none when every channel is muted (a muted
 * community), since then there is nothing to set them apart from.
 */
export function mutedGroupIds(channels: readonly { idHex: string }[], isMuted: (idHex: string) => boolean): Set<string> {
  const muted = channels.filter((c) => isMuted(c.idHex));
  return muted.length >= MUTED_GROUP_MIN && muted.length < channels.length
    ? new Set(muted.map((c) => c.idHex))
    : new Set();
}
