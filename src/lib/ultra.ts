import type { CSSProperties } from "react";

import type { ThemePreset } from "@/themes";

export const DONATION_BITCOIN = "bc1q9cx35adpm73aq2fw40ye6ts8hfxqzjr5unwg0n";
export const DONATION_MONERO = "45JDCLrjJ4bgVUSbbs2yjy9m5Mf4VLPW8fG7jw9sq5u69rXZZopQogZNeyYkMBnXpkaip4p4QwaaJNhdTotPa9g44DBCzdK";

/** The kind-0 field that carries Armada Ultra, so every client can draw it. */
export const ULTRA_FIELD = "armada_ultra";

export const NAME_STYLES = {
  aurora: ["#22d3ee", "#a855f7", "#ec4899"],
  sunset: ["#fb923c", "#f43f5e", "#a855f7"],
  gold: ["#fde68a", "#f59e0b", "#fef3c7"],
  toxic: ["#a3e635", "#22c55e", "#2dd4bf"],
  candy: ["#f9a8d4", "#c4b5fd", "#93c5fd"],
} as const satisfies Record<string, readonly string[]>;

export const AVATAR_FRAMES = {
  glow: "#ec4899",
  gold: "#f59e0b",
  ice: "#67e8f9",
  toxic: "#4ade80",
  void: "#8b5cf6",
} as const satisfies Record<string, string>;

export const PROFILE_EFFECTS = {
  sparkles: "✨",
  hearts: "💖",
  stars: "⭐",
  bubbles: "🫧",
} as const satisfies Record<string, string>;

export type NameStyleId = keyof typeof NAME_STYLES;
export type AvatarFrameId = keyof typeof AVATAR_FRAMES;
export type ProfileEffectId = keyof typeof PROFILE_EFFECTS;

export interface UltraProfile {
  /** Unix seconds. */
  since: number;
  name?: NameStyleId;
  frame?: AvatarFrameId;
  effect?: ProfileEffectId;
}

/** What a fresh member starts with, so the perks show the moment they pay. */
export const ULTRA_DEFAULTS: Omit<UltraProfile, "since"> = { name: "aurora", frame: "glow", effect: "sparkles" };

function pick<T extends string>(table: Record<T, unknown>, value: unknown): T | undefined {
  return typeof value === "string" && Object.hasOwn(table, value) ? (value as T) : undefined;
}

/** The profile's Ultra membership, or undefined. Unknown presets are dropped, not guessed. */
export function readUltra(metadata: { [key: string]: unknown } | undefined): UltraProfile | undefined {
  const raw = metadata?.[ULTRA_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const since = typeof record.since === "number" && Number.isFinite(record.since) ? record.since : 0;
  return {
    since,
    name: pick(NAME_STYLES, record.name),
    frame: pick(AVATAR_FRAMES, record.frame),
    effect: pick(PROFILE_EFFECTS, record.effect),
  };
}

/** Kind-0 content with Ultra set or removed; every other field is kept as-is. */
export function withUltra(content: Record<string, unknown>, ultra: UltraProfile | undefined): Record<string, unknown> {
  const next = { ...content };
  if (!ultra) {
    delete next[ULTRA_FIELD];
    return next;
  }
  const field: Record<string, unknown> = { since: ultra.since };
  if (ultra.name) field.name = ultra.name;
  if (ultra.frame) field.frame = ultra.frame;
  if (ultra.effect) field.effect = ultra.effect;
  next[ULTRA_FIELD] = field;
  return next;
}

// Built once per preset so memoized rows get the same object every render.
const NAME_STYLE_CSS = Object.fromEntries(
  Object.entries(NAME_STYLES).map(([id, stops]) => [id, {
    backgroundImage: `linear-gradient(90deg, ${[...stops, stops[0]].join(", ")})`,
    backgroundSize: "200% auto",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  } satisfies CSSProperties]),
) as Record<NameStyleId, CSSProperties>;

const FRAME_CSS = Object.fromEntries(
  Object.entries(AVATAR_FRAMES).map(([id, color]) => [id, {
    // drop-shadow follows a shaped avatar's mask, where a ring would be clipped away.
    filter: `drop-shadow(0 0 1.5px ${color}) drop-shadow(0 0 1.5px ${color}) drop-shadow(0 0 5px ${color})`,
  } satisfies CSSProperties]),
) as Record<AvatarFrameId, CSSProperties>;

/** Class for a styled name shown on its own; pair with {@link nameStyleCss}. */
export const ULTRA_NAME_CLASS = "motion-safe:animate-ultra-shimmer";

/**
 * The same for names in a list (timeline rows, the member list): drifts twice,
 * then holds still. The gradient's position can't be composited, so every
 * looping name is repainted each frame, and a busy room shows dozens.
 */
export const ULTRA_LIST_NAME_CLASS = "motion-safe:animate-ultra-shimmer-twice";

export function nameStyleCss(id: NameStyleId | undefined): CSSProperties | undefined {
  return id ? NAME_STYLE_CSS[id] : undefined;
}

export function frameCss(id: AvatarFrameId | undefined): CSSProperties | undefined {
  return id ? FRAME_CSS[id] : undefined;
}

/** Themes only the Ultra page offers. Applied locally, like any preset. */
export const ULTRA_THEMES: Record<string, ThemePreset> = {
  vaporwave: {
    label: "Vaporwave",
    emoji: "🌴",
    colors: { background: "268 45% 12%", text: "185 80% 88%", primary: "315 95% 65%" },
  },
  gilded: {
    label: "Gilded",
    emoji: "👑",
    colors: { background: "30 20% 7%", text: "45 60% 88%", primary: "43 95% 55%" },
  },
  abyss: {
    label: "Abyss",
    emoji: "🐙",
    colors: { background: "190 60% 6%", text: "175 40% 86%", primary: "165 85% 48%" },
  },
};
