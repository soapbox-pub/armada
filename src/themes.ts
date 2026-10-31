import { deriveTokensFromCore } from "@/lib/colorUtils";

/** The 3 core colors defining a theme; all other tokens derive via `deriveTokensFromCore`. */
export interface CoreThemeColors {
  /** HSL string, e.g. "222 18% 9%" */
  background: string;
  text: string;
  /** Primary accent color (buttons, links, focus rings) */
  primary: string;
}

/** A theme background image (`bg` tag, imeta-style key-value entries). */
export interface ThemeBackground {
  url: string;
  /** How the image fills the page. Default: cover. */
  mode?: "cover" | "tile";
  mimeType?: string;
  /** `<width>x<height>` as published. */
  dimensions?: string;
  blurhash?: string;
}

/** The original creator of a theme adopted from someone else. */
export interface ThemeSource {
  pubkey: string;
  /** d-tag of the author's kind-36767 definition, when the theme came from one. */
  identifier?: string;
}

/** A theme font: a CSS family name plus an optional remote .woff2/.css URL. */
export interface ThemeFont {
  family: string;
  url?: string;
}

/** A theme as stored in `AppConfig.customTheme`. */
export interface ThemeConfig {
  title?: string;
  colors: CoreThemeColors;
  /** Body font, app-wide. Catalog families, or the user's own uploaded one (see `appThemeFont`). */
  font?: ThemeFont;
  /** Heading font; falls back to `font`. */
  titleFont?: ThemeFont;
  background?: ThemeBackground;
  /** Who made this theme, when it was adopted from another user. Dropped on edit. */
  source?: ThemeSource;
}

/** Full CSS token set, derived via `deriveTokensFromCore`. */
export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  /** Second neon — phosphor-cyan counter-accent (the virtual "wake"). */
  accent2: string;
  destructive: string;
  destructiveForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  border: string;
  input: string;
  ring: string;
  /** Recessed chrome surface (bars, rails, sidebars): the background darkened, same hue. */
  chrome: string;
  /** The deepest chrome plane (server rail, call bar) — a bit more recessed. */
  chromeDeep: string;
  /** Hairline divider inside chrome (replaces hardcoded `bg-white/10`). */
  chromeDivider: string;
}

/** Build-time builtin themes; self-hosters can customize before building. */
export const builtinThemes: Record<"light" | "dark", CoreThemeColors> = {
  light: {
    // Light Corsair: violet parchment and ink, same rose-magenta primary as dark.
    background: "260 30% 97%",
    text: "260 30% 14%",
    primary: "330 80% 52%",
  },
  dark: {
    // Armada "Corsair": near-black violet sea, rose-magenta primary, cyan
    // accent-2 wake, gilt-cream text.
    background: "260 22% 9%",
    text: "42 38% 90%",
    primary: "330 90% 62%",
  },
};

/** The colors a fresh custom theme starts from in the builder. */
export const builderStarterColors: CoreThemeColors = {
  background: "222 18% 9%",
  text: "220 14% 92%",
  primary: "235 80% 68%",
};

export interface ThemePreset {
  label: string;
  /** Emoji shown in compact theme pickers. */
  emoji: string;
  /** Whether to surface in compact pickers. All presets appear in settings. */
  featured?: boolean;
  colors: CoreThemeColors;
}

/** Named presets; selecting one sets `theme` to "custom" with the preset's colors. */
export const themePresets: Record<string, ThemePreset> = {
  armada: {
    label: "Armada",
    emoji: "⚔️",
    featured: true,
    // The default. Hacker-privateer on the virtual sea — cold violet-black water, electric rose blade, phosphor-cyan wake.
    colors: { background: "260 22% 9%", text: "42 38% 90%", primary: "330 90% 62%" },
  },
  lantern: {
    label: "Lantern",
    emoji: "🏮",
    featured: true,
    // Deep-sea hull, sailcloth text, brass lantern glow. A ship at night.
    colors: { background: "205 38% 8%", text: "38 18% 88%", primary: "38 85% 58%" },
  },
  midnight: {
    label: "Midnight",
    emoji: "🌃",
    featured: true,
    colors: { background: "222 47% 8%", text: "213 31% 91%", primary: "217 91% 60%" },
  },
  ocean: {
    label: "Ocean",
    emoji: "🌊",
    featured: true,
    colors: { background: "202 60% 9%", text: "190 30% 92%", primary: "190 90% 50%" },
  },
  forest: {
    label: "Forest",
    emoji: "🌲",
    featured: true,
    colors: { background: "150 25% 8%", text: "140 20% 92%", primary: "142 70% 45%" },
  },
  ember: {
    label: "Ember",
    emoji: "🔥",
    featured: true,
    colors: { background: "20 30% 8%", text: "30 25% 92%", primary: "18 90% 55%" },
  },
  grape: {
    label: "Grape",
    emoji: "🍇",
    featured: true,
    colors: { background: "270 30% 9%", text: "270 20% 93%", primary: "270 80% 65%" },
  },
  rose: {
    label: "Rose",
    emoji: "🌹",
    featured: true,
    colors: { background: "340 25% 9%", text: "340 20% 93%", primary: "340 85% 62%" },
  },
  slate: {
    label: "Slate",
    emoji: "🪨",
    colors: { background: "215 16% 12%", text: "210 16% 90%", primary: "210 16% 70%" },
  },
  gold: {
    label: "Gold",
    emoji: "🪙",
    colors: { background: "40 25% 8%", text: "45 30% 92%", primary: "43 90% 55%" },
  },
  mint: {
    label: "Mint",
    emoji: "🌿",
    colors: { background: "160 30% 96%", text: "165 30% 14%", primary: "165 70% 38%" },
  },
  sky: {
    label: "Sky",
    emoji: "☁️",
    colors: { background: "205 60% 97%", text: "210 35% 16%", primary: "205 85% 50%" },
  },
  sand: {
    label: "Sand",
    emoji: "🏜️",
    colors: { background: "40 40% 96%", text: "30 30% 16%", primary: "28 75% 50%" },
  },
  bubblegum: {
    label: "Bubblegum",
    emoji: "🍬",
    colors: { background: "320 70% 97%", text: "325 35% 18%", primary: "325 80% 58%" },
  },
};

/** Map a ThemeTokens key to its CSS custom-property name (camelCase → kebab). */
export function toThemeVar(key: keyof ThemeTokens): string {
  return "--" + key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/** Build a `:root { --token: value; }` CSS string from a full token set. */
export function buildThemeCss(tokens: ThemeTokens): string {
  const decls = (Object.keys(tokens) as Array<keyof ThemeTokens>)
    .map((key) => `  ${toThemeVar(key)}: ${tokens[key]};`)
    .join("\n");
  return `:root {\n${decls}\n}`;
}

/** Derive the full token set from 3 core colors. */
export function coreToTokens(colors: CoreThemeColors): ThemeTokens {
  return deriveTokensFromCore(colors.background, colors.text, colors.primary);
}

/** Build the injected `<style id="theme-vars">` CSS from 3 core colors. */
export function buildThemeCssFromCore(colors: CoreThemeColors): string {
  return buildThemeCss(coreToTokens(colors));
}

/** Theme CSS variables as an inline style, to scope a theme to one element (e.g. a profile card). */
export function buildThemeVarStyle(colors: CoreThemeColors): Record<string, string> {
  const tokens = coreToTokens(colors);
  const style: Record<string, string> = {};
  for (const key of Object.keys(tokens) as Array<keyof ThemeTokens>) {
    style[toThemeVar(key)] = tokens[key];
  }
  return style;
}

/** Resolve a theme mode to a concrete light/dark/custom value. */
export function resolveTheme(theme: "light" | "dark" | "system" | "custom"): "light" | "dark" | "custom" {
  if (theme === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

/** Resolve a light/dark mode to its core colors. */
export function resolveThemeColors(mode: "light" | "dark"): CoreThemeColors {
  return builtinThemes[mode];
}
