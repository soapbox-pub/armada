import { emojiData, loadEmojiData } from "@/lib/emojiData";

/**
 * Index of the `:` opening an in-progress `:shortcode` ending at `cursor`, or
 * -1. The colon must start the text or follow a non-`[A-Za-z0-9_]` char (so
 * `http://`, `3:30` don't match, but `👍:smile` does).
 */
export function findEmojiShortcodeColon(value: string, cursor: number): number {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === " " || ch === "\n" || ch === "\t") break;
    if (ch === ":" && i < cursor - 1) {
      if (i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]!)) return i;
      break;
    }
  }
  return -1;
}

/**
 * The native emoji an emoji-mart id or alias names (case-insensitive), or
 * undefined — also while the dataset is still loading (this starts it).
 */
export function nativeEmojiForShortcode(name: string): string | undefined {
  const data = emojiData();
  if (!data) {
    void loadEmojiData();
    return undefined;
  }
  const { emojis, aliases } = data;
  const key = name.toLowerCase();
  if (!Object.hasOwn(emojis, key) && !Object.hasOwn(aliases, key)) return undefined;
  const id = Object.hasOwn(emojis, key) ? key : aliases[key]!;
  return emojis[id]?.skins?.[0]?.native;
}

/**
 * Replacement for a `:shortcode:` just completed before `cursor` (so `:v:`
 * becomes ✌️ as typed), or null. Names in `customShortcodes` are skipped (NIP-30
 * custom emoji).
 */
export function completedShortcodeAt(
  value: string,
  cursor: number,
  customShortcodes: ReadonlySet<string> = new Set(),
): { start: number; end: number; replacement: string } | null {
  // A `:` that could open a shortcode loads the dataset, so it is in hand by the closing one.
  if (!emojiData() && cursor > 0 && value[cursor - 1] === ":") void loadEmojiData();
  if (cursor < 3 || value[cursor - 1] !== ":") return null;
  const start = findEmojiShortcodeColon(value, cursor - 1);
  if (start < 0) return null;
  const name = value.slice(start + 1, cursor - 1);
  if (!/^[A-Za-z0-9_+-]+$/.test(name)) return null;
  if (customShortcodes.has(name)) return null;
  const native = nativeEmojiForShortcode(name);
  return native ? { start, end: cursor, replacement: native } : null;
}
