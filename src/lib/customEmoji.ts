/** NIP-30 custom emoji helpers. */

import { parseAddr } from "@/lib/parseAddr";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

/** Checks if a string is a NIP-30 custom emoji shortcode (`:shortcode:` format). */
export function isCustomEmoji(content: string): boolean {
  return /^:[a-zA-Z0-9_-]+:$/.test(content);
}

/**
 * Whether a reaction key renders as a pill glyph: a resolved `:shortcode:`, or a
 * short unicode glyph (guards against junk like pasted URLs).
 */
export function isRenderableReactionKey(key: string, url?: string): boolean {
  if (isCustomEmoji(key)) return Boolean(url);
  if (!key) return false;
  if (/\s/.test(key) || /^\w+:\/\//.test(key) || /^(www\.|https?:)/i.test(key)) return false;
  // Real emoji (flags, ZWJ sequences) are at most a few code points.
  return [...key].length <= 8;
}

/** Custom emoji URL for a shortcode (with colons, e.g. `:soapbox:`) from an event's tags. */
export function getCustomEmojiUrl(shortcode: string, tags: string[][]): string | undefined {
  const name = shortcode.slice(1, -1);
  const emojiTag = tags.find(([tagName, tagShortcode]) => tagName === "emoji" && tagShortcode === name);
  return emojiTag?.[2];
}

/** NIP-30 `["emoji", shortcode, url]` tags for each unique known `:shortcode:` in `content`. */
export function collectEmojiTags(
  content: string,
  emojis: Array<{ shortcode: string; url: string }>,
): string[][] {
  if (emojis.length === 0) return [];
  const emojiMap = new Map(emojis.map((e) => [e.shortcode, e.url]));
  const shortcodeRegex = /:([a-zA-Z0-9_-]+):/g;
  const used = new Set<string>();
  const tags: string[][] = [];
  let match;
  while ((match = shortcodeRegex.exec(content)) !== null) {
    const shortcode = match[1];
    if (emojiMap.has(shortcode) && !used.has(shortcode)) {
      used.add(shortcode);
      tags.push(["emoji", shortcode, emojiMap.get(shortcode)!]);
    }
  }
  return tags;
}

export function buildEmojiMap(tags: string[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] === "emoji" && tag[1] && tag[2]) {
      map.set(tag[1], tag[2]);
    }
  }
  return map;
}

export interface CustomEmojiSection {
  /** `""` for list-inlined emojis, `"workspace"`, or the pack's coordinate. */
  key: string;
  source: "list" | "pack" | "workspace";
  /** Set for a pack section only. */
  name?: string;
  emojis: CustomEmoji[];
}

/**
 * A palette split into picker sections, in palette order. A workspace's sets are
 * one section: each member names their own, so a per-set header would be theirs.
 */
export function paletteSections(emojis: CustomEmoji[]): CustomEmojiSection[] {
  const sections = new Map<string, CustomEmojiSection>();
  for (const e of emojis) {
    const source = e.workspace ? "workspace" : e.packCoord ? "pack" : "list";
    const key = source === "workspace" ? "workspace" : (e.packCoord ?? "");
    let section = sections.get(key);
    if (!section) {
      const name = source === "pack" ? e.packName || parseAddr(key)?.identifier || undefined : undefined;
      sections.set(key, (section = { key, source, name, emojis: [] }));
    }
    section.emojis.push(e);
  }
  return [...sections.values()];
}
