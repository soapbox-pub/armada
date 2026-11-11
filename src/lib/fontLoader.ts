/**
 * Theme fonts are loaded by URL via injected `@font-face` rules. A profile's
 * font is applied scoped (inline on the themed container); the app's own goes
 * through `--theme-font`, read by Tailwind's `font-sans`.
 */

import { defaultMediaPolicy, mediaSrc, type MediaPolicy } from "@/lib/mediaPolicy";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { findThemeFont } from "@/lib/themeFonts";

import type { ThemeFont } from "@/themes";

/**
 * Sanitize an event-sourced string for a double-quoted CSS context (prevents
 * CSS-string breakout). Allowlist: letters, numbers, space, `-`, `_`, `'`, `.`.
 */
export function sanitizeCssString(value: string): string {
  return value.replace(/[^\p{L}\p{N} _\-'.]/gu, "");
}

const FONT_FACE_STYLE_ID = "theme-font-faces";

const injectedUrls = new Set<string>();

/** Inject a `@font-face` rule (idempotent per URL). Inputs are event-sourced, so both are sanitized. */
function injectFontFace(family: string, url: string): void {
  if (injectedUrls.has(url)) return;
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return;

  let style = document.getElementById(FONT_FACE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = FONT_FACE_STYLE_ID;
    document.head.appendChild(style);
  }

  const safeFamily = sanitizeCssString(family);
  style.textContent += `
@font-face {
  font-family: "${safeFamily}";
  src: url("${safeUrl}");
  font-display: swap;
}`;
  injectedUrls.add(url);
}

const uploadedFamilies = new Map<string, string>();

/**
 * The family a font file loaded by URL is registered under: one of its own.
 * `@font-face` is document-wide, so under the name its theme gives it the file
 * would be drawn wherever the app or another theme uses that family.
 */
function uploadedFamily(src: string): string {
  let family = uploadedFamilies.get(src);
  if (!family) {
    family = `armada-uploaded-font-${uploadedFamilies.size + 1}`;
    uploadedFamilies.set(src, family);
  }
  return family;
}

/**
 * Where a theme's own font URL loads from: through the media proxy when one is
 * set, like any image a theme or event names. Catalog fonts are Armada's pinned
 * CDN, not a sender's choice, and load directly.
 */
function uploadedFontSrc(url: string, policy: MediaPolicy): string | undefined {
  const src = mediaSrc(url, policy);
  return src && sanitizeUrl(src) ? src : undefined;
}

/**
 * `--theme-font` value for the app-wide theme font. A catalog family always
 * loads; a family the user uploaded (any other URL) only with `ownFont`: a
 * theme adopted from someone else may name any URL, and the app font loads on
 * every launch.
 */
export function appThemeFont(
  font: ThemeFont | undefined,
  { ownFont = false, policy = defaultMediaPolicy() }: { ownFont?: boolean; policy?: MediaPolicy } = {},
): string | undefined {
  if (!font?.family) return undefined;
  const option = findThemeFont(font.family);
  if (option) {
    injectFontFace(option.family, option.cdnUrl);
    return `"${sanitizeCssString(option.family)}"`;
  }
  if (!ownFont || !font.url || !sanitizeUrl(font.url)) return undefined;
  const src = uploadedFontSrc(font.url, policy);
  if (!src) return undefined;
  injectFontFace(uploadedFamily(src), src);
  return `"${uploadedFamily(src)}"`;
}

/**
 * `font` as an edit that drops `from`'s credit may keep it: an uploaded file
 * inherited from the credited theme is left out, since an uncredited theme
 * counts as the user's own and {@link appThemeFont} would load its URL.
 */
export function claimedThemeFont(
  font: ThemeFont | undefined,
  from: { source?: unknown; font?: ThemeFont; titleFont?: ThemeFont } | undefined,
): ThemeFont | undefined {
  if (!font?.url || !from?.source || findThemeFont(font.family)) return font;
  return font.url === from.font?.url || font.url === from.titleFont?.url ? undefined : font;
}

/** CSS `font-family` value for a theme font, or undefined when it can't resolve to a loadable URL. */
export function loadThemeFont(font: ThemeFont | undefined, policy: MediaPolicy = defaultMediaPolicy()): string | undefined {
  if (!font?.family) return undefined;
  if (font.url) {
    const src = uploadedFontSrc(font.url, policy);
    if (!src) return undefined;
    injectFontFace(uploadedFamily(src), src);
    return `"${uploadedFamily(src)}", system-ui, sans-serif`;
  }
  const option = findThemeFont(font.family);
  if (!option) return undefined;
  injectFontFace(option.family, option.cdnUrl);
  return `"${sanitizeCssString(option.family)}", system-ui, sans-serif`;
}
