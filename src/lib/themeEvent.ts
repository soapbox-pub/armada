import { hexToHslString, hslStringToHex, isValidHex } from "@/lib/colorUtils";
import { isNostrId } from "@/lib/nostrId";
import { sanitizeUrl } from "@/lib/sanitizeUrl";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { CoreThemeColors, ThemeBackground, ThemeConfig, ThemeFont, ThemeSource } from "@/themes";
import type { NostrRumor } from "@/lib/nostrRumor";

export type { ThemeBackground, ThemeFont, ThemeSource } from "@/themes";

/**
 * Ditto theme events (interop): core colors plus optional fonts and background
 * image. See ditto/src/lib/themeEvent.ts.
 */

/** Addressable: a named theme definition. Multiple per user (the library). */
export const THEME_DEFINITION_KIND = 36767;
/** Replaceable: the user's currently active profile theme. One per user. */
export const ACTIVE_THEME_KIND = 16767;

/** Parse the `c` color tags (hex, role-tagged) into CoreThemeColors. */
function parseColorTags(tags: string[][]): CoreThemeColors | null {
  const map = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] === "c" && tag[1] && tag[2]) map.set(tag[2], tag[1]);
  }
  const bg = map.get("background");
  const text = map.get("text");
  const primary = map.get("primary");
  if (!bg || !text || !primary) return null;
  if (!isValidHex(bg) || !isValidHex(text) || !isValidHex(primary)) return null;
  return {
    background: hexToHslString(bg),
    text: hexToHslString(text),
    primary: hexToHslString(primary),
  };
}

/** Build `c` tags from CoreThemeColors (HSL → hex). */
function buildColorTags(colors: CoreThemeColors): string[][] {
  return (["background", "text", "primary"] as const).map((role) => [
    "c",
    hslStringToHex(colors[role]),
    role,
  ]);
}

/**
 * Parse `f` tags into body and title fonts. Tag shape:
 * `["f", family, url, "body"|"title"]`; a tag without a role (legacy) is body.
 */
function parseFontTags(tags: string[][]): { font?: ThemeFont; titleFont?: ThemeFont } {
  let font: ThemeFont | undefined;
  let titleFont: ThemeFont | undefined;
  for (const tag of tags) {
    if (tag[0] !== "f" || !tag[1]) continue;
    const parsed: ThemeFont = { family: tag[1] };
    const url = sanitizeUrl(tag[2]);
    if (url) parsed.url = url;
    if (tag[3] === "title") {
      if (!titleFont) titleFont = parsed;
    } else if (!font) {
      font = parsed;
    }
  }
  return { font, titleFont };
}

/** Build `f` tags. Body before title, matching Ditto's emit order. */
function buildFontTags(font: ThemeFont | undefined, titleFont: ThemeFont | undefined): string[][] {
  const tags: string[][] = [];
  if (font?.family) tags.push(["f", font.family, font.url ?? "", "body"]);
  if (titleFont?.family) tags.push(["f", titleFont.family, titleFont.url ?? "", "title"]);
  return tags;
}

/** Parse the `bg` tag (imeta-style `key value` entries) into ThemeBackground. */
function parseBackgroundTag(tags: string[][]): ThemeBackground | undefined {
  const bgTag = tags.find(([n]) => n === "bg");
  if (!bgTag) return undefined;
  const kv = new Map<string, string>();
  for (let i = 1; i < bgTag.length; i++) {
    const entry = bgTag[i];
    const spaceIdx = entry.indexOf(" ");
    if (spaceIdx === -1) continue;
    kv.set(entry.slice(0, spaceIdx), entry.slice(spaceIdx + 1));
  }
  const url = sanitizeUrl(kv.get("url"));
  if (!url) return undefined;
  const bg: ThemeBackground = { url };
  const mode = kv.get("mode");
  if (mode === "cover" || mode === "tile") bg.mode = mode;
  bg.mimeType = kv.get("m");
  bg.dimensions = kv.get("dim");
  bg.blurhash = kv.get("blurhash");
  const surface = kv.get("surface") ? Number(kv.get("surface")) : NaN;
  if (surface >= 0 && surface <= 1) bg.surfaceOpacity = surface;
  return bg;
}

/** Build the `bg` tag from ThemeBackground. Empty when there is no image. */
function buildBackgroundTag(bg: ThemeBackground | undefined): string[][] {
  if (!bg?.url) return [];
  const entries: string[] = ["bg", `url ${bg.url}`];
  if (bg.mode) entries.push(`mode ${bg.mode}`);
  if (bg.mimeType) entries.push(`m ${bg.mimeType}`);
  if (bg.dimensions) entries.push(`dim ${bg.dimensions}`);
  if (bg.blurhash) entries.push(`blurhash ${bg.blurhash}`);
  if (bg.surfaceOpacity !== undefined) entries.push(`surface ${bg.surfaceOpacity}`);
  return [entries];
}

/** A named Ditto theme reduced to what Armada uses. */
export interface DittoTheme {
  /** d-tag identifier (definitions only). */
  identifier: string;
  title: string;
  colors: CoreThemeColors;
  /** Optional body font. */
  font?: ThemeFont;
  /** Optional title/display-name font. Falls back to `font` when absent. */
  titleFont?: ThemeFont;
  /** Optional page background image. */
  background?: ThemeBackground;
  description?: string;
  /** `a`-tag coordinate of the source kind-36767 definition (16767 only). */
  sourceRef?: string;
  /** The original creator, when this event is someone wearing or keeping another user's theme. */
  source?: ThemeSource;
}

/**
 * The credited creator of an adopted theme: a well-formed 36767 `a` coordinate,
 * else a `p` tag. Undefined when the event's own author made it.
 */
function parseThemeSource(event: NostrRumor): ThemeSource | undefined {
  let source: ThemeSource | undefined;
  for (const [name, value] of event.tags) {
    if (name !== "a" || !value) continue;
    const [kind, pubkey, ...rest] = value.split(":");
    const identifier = rest.join(":");
    if (kind === String(THEME_DEFINITION_KIND) && isNostrId(pubkey) && identifier) {
      source = { pubkey, identifier };
      break;
    }
  }
  if (!source) {
    const pubkey = event.tags.find(([n]) => n === "p")?.[1];
    if (isNostrId(pubkey)) source = { pubkey };
  }
  return source && source.pubkey !== event.pubkey ? source : undefined;
}

function buildSourceTags(source: ThemeSource | undefined): string[][] {
  if (!source) return [];
  const tags: string[][] = [];
  if (source.identifier) tags.push(["a", `${THEME_DEFINITION_KIND}:${source.pubkey}:${source.identifier}`]);
  tags.push(["p", source.pubkey]);
  return tags;
}

export function isAdoptedTheme(event: NostrRumor): boolean {
  return (event.kind === THEME_DEFINITION_KIND || event.kind === ACTIVE_THEME_KIND)
    && !!parseThemeSource(event);
}

/**
 * The ThemeConfig a viewer adopts from a theme event, crediting its creator:
 * the event's own credit if it is itself a copy, else its author.
 */
export function themeEventToConfig(event: NostrRumor): ThemeConfig | null {
  const theme = parseDittoTheme(event);
  if (!theme) return null;
  const source: ThemeSource = theme.source ?? (
    event.kind === THEME_DEFINITION_KIND && theme.identifier
      ? { pubkey: event.pubkey, identifier: theme.identifier }
      : { pubkey: event.pubkey }
  );
  return themeToConfig(theme, source);
}

/** The ThemeConfig that wears a parsed theme, crediting `source` (default: the theme's own credit). */
export function themeToConfig(theme: DittoTheme, source: ThemeSource | undefined = theme.source): ThemeConfig {
  return {
    title: theme.title,
    colors: theme.colors,
    ...(theme.font && { font: theme.font }),
    ...(theme.titleFont && { titleFont: theme.titleFont }),
    ...(theme.background && { background: theme.background }),
    ...(source && { source }),
  };
}

/** Parse a kind 36767 / 16767 event into a DittoTheme. Returns null if invalid. */
export function parseDittoTheme(event: NostrRumor): DittoTheme | null {
  if (event.kind !== THEME_DEFINITION_KIND && event.kind !== ACTIVE_THEME_KIND) return null;

  // Colors only from hex-validated `c` tags: the legacy JSON-content format
  // would reach the injected <style> unchecked (Ditto ignores it too).
  const colors = parseColorTags(event.tags);
  if (!colors) return null;

  const identifier = event.tags.find(([n]) => n === "d")?.[1] ?? "";
  const title =
    event.tags.find(([n]) => n === "title")?.[1] || identifier || "Untitled theme";
  const description = event.tags.find(([n]) => n === "description")?.[1];
  const { font, titleFont } = parseFontTags(event.tags);
  const background = parseBackgroundTag(event.tags);
  const sourceRef =
    event.kind === ACTIVE_THEME_KIND ? event.tags.find(([n]) => n === "a")?.[1] : undefined;
  const source = parseThemeSource(event);

  return { identifier, title, colors, font, titleFont, background, description, sourceRef, source };
}

/** The optional non-color parts of a theme, shared by both builders. */
export interface ThemeExtras {
  font?: ThemeFont;
  titleFont?: ThemeFont;
  background?: ThemeBackground;
  description?: string;
  source?: ThemeSource;
}

/** A short, stable-ish slug for a theme's `d` identifier. */
function slugify(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "theme";
}

/**
 * Build a kind-36767 theme definition (Ditto-compatible) for "Share to
 * Discover". Only published on explicit user action.
 */
export function buildThemeDefinitionEvent(
  title: string,
  colors: CoreThemeColors,
  identifier?: string,
  extras?: ThemeExtras,
): EventTemplate {
  const name = title.trim() || "My theme";
  const d = identifier?.trim() || `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
  const tags: string[][] = [
    ["d", d],
    ["title", name],
    ...buildColorTags(colors),
    ...buildFontTags(extras?.font, extras?.titleFont),
    ...buildBackgroundTag(extras?.background),
    // NIP-31 alt + topic tag, matching Ditto's emit.
    ["alt", `Custom theme: ${name}`],
    ["t", "theme"],
    ...buildSourceTags(extras?.source),
  ];
  if (extras?.description) tags.push(["description", extras.description]);
  return { kind: THEME_DEFINITION_KIND, content: "", tags };
}

/**
 * Build the kind-16767 active profile theme (Ditto-compatible). `source` credits
 * the theme's creator (`a` + `p`); a bare `sourceRef` is the older `a`-only form.
 * Only published on explicit user action.
 */
export function buildActiveThemeEvent(
  colors: CoreThemeColors,
  opts?: ThemeExtras & { title?: string; sourceRef?: string },
): EventTemplate {
  const tags: string[][] = [
    ...buildColorTags(colors),
    ...buildFontTags(opts?.font, opts?.titleFont),
    ...buildBackgroundTag(opts?.background),
    ["alt", "Active profile theme"],
  ];
  if (opts?.title) tags.push(["title", opts.title]);
  if (opts?.description) tags.push(["description", opts.description]);
  if (opts?.source) tags.push(...buildSourceTags(opts.source));
  else if (opts?.sourceRef) tags.push(["a", opts.sourceRef]);
  return { kind: ACTIVE_THEME_KIND, content: "", tags };
}

/** Kind-16767 with no colors: removes the profile theme (as Ditto's clearActiveTheme). */
export function buildClearActiveThemeEvent(): EventTemplate {
  return { kind: ACTIVE_THEME_KIND, content: "", tags: [] };
}

/** NIP-09 deletion of one of the user's kind-36767 definitions, by address (and id when known). */
export function buildThemeDeletionEvent(pubkey: string, identifier: string, eventId?: string): EventTemplate {
  const tags: string[][] = [
    ["a", `${THEME_DEFINITION_KIND}:${pubkey}:${identifier}`],
    ["k", String(THEME_DEFINITION_KIND)],
  ];
  if (eventId) tags.unshift(["e", eventId]);
  return { kind: 5, content: "", tags };
}
