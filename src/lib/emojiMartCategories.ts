import { Data, SearchIndex } from "emoji-mart";

import { shortcodeOfPickerId } from "@/lib/customEmoji";

/** A custom (NIP-30 pack) category handed to emoji-mart's `custom` option. */
export interface EmojiMartCustomCategory {
  id: string;
  name: string;
  emojis: { id: string; name: string; keywords: string[]; skins: { src: string }[] }[];
}

const CATEGORY_PREFIX = "custom-";

/** The id of the picker's `index`th custom section. Positional, so two packs can never share one. */
export function customCategoryId(index: number): string {
  return `${CATEGORY_PREFIX}${index}`;
}

/**
 * Reconcile emoji-mart's module-global tables with the custom categories for a
 * new Picker. It fills `Data.originalCategories` only on the FIRST init, so packs
 * added mid-session would get no section; and it never forgets a custom emoji, so
 * a pack no longer in the palette (a workspace left, an account logged out) would
 * stay searchable. Guarded in case a future emoji-mart drops either field.
 */
export function syncEmojiMartCategories(categories: EmojiMartCustomCategory[]): void {
  const data = Data as { originalCategories?: unknown; emojis?: Record<string, unknown> } | undefined;
  if (!data || !Array.isArray(data.originalCategories)) return;

  const ids = new Set(categories.map((c) => c.id));
  const kept = (data.originalCategories as { id: string }[]).filter(
    (c) => !ids.has(c.id) && !c.id.startsWith(CATEGORY_PREFIX),
  );
  data.originalCategories = [...kept, ...categories];

  if (!data.emojis) return;
  const live = new Set(categories.flatMap((c) => c.emojis.map((e) => e.id)));
  let purged = false;
  for (const id of Object.keys(data.emojis)) {
    if (shortcodeOfPickerId(id) !== undefined && !live.has(id)) {
      delete data.emojis[id];
      purged = true;
    }
  }
  // The search pool is a snapshot of `Data.emojis`, rebuilt only when an emoji is new.
  if (purged) SearchIndex.reset();
}

const FREQUENTLY_KEY = "emoji-mart.frequently";

/**
 * Drop "Frequently used" ids that resolve to nothing: emoji-mart sorts them into
 * the row before discarding them, so each one costs a slot. A custom id is kept
 * even while its pack is absent from this palette (a workspace's, outside it).
 * Effective before the session's first Picker, which caches the table.
 */
export function pruneFrequentlyUsed(nativeEmojis: Record<string, unknown>): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FREQUENTLY_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return;
    const entries = Object.entries(raw);
    const kept = entries.filter(([id]) => Object.hasOwn(nativeEmojis, id) || shortcodeOfPickerId(id) !== undefined);
    if (kept.length < entries.length) localStorage.setItem(FREQUENTLY_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Unavailable or corrupt — emoji-mart copes with either.
  }
}
