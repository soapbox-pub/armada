import type { StyleSpecification, LayerSpecification } from "maplibre-gl";

import { parseHsl, isDarkTheme } from "@/lib/colorUtils";

/**
 * Map style source + theming for the location viewer.
 *
 * The base map is Dreamith's OpenFreeMap-hosted OpenMapTiles vector style
 * ("liberty", full OSM street data — no API key). On top of that the viewer
 * offers three looks, toggled in the UI:
 *
 *  - "sun"     — the raw liberty street style (bright, default OSM look).
 *  - "moon"    — a fixed dark recolor (dark streets, independent of the app).
 *  - "sparkle" — a recolor derived from Armada's *live* theme (the CSS custom
 *                properties set by the theme system, which includes Nostr theme
 *                events). This is the default so the map matches the app.
 *
 * The recolor technique mirrors yonder's `sheikahStyle`: fetch the vector
 * style, then rewrite each layer's paint colors from a small role palette.
 */

/** OpenFreeMap-hosted OpenMapTiles vector style (full OSM street data). */
export const DREAMITH_STYLE_URL = "https://maps.dreamith.to/styles/liberty";

/** The three selectable map looks. */
export type MapTheme = "sun" | "moon" | "sparkle";

/** Role palette a recolor paints the vector layers with. */
export interface MapPalette {
  /** Deepest background (behind everything). */
  void: string;
  /** Landmass / parks / landuse. */
  land: string;
  /** Water bodies + waterways. */
  water: string;
  /** Major roads (motorway/trunk/primary). */
  road: string;
  /** Minor roads + building fill. */
  roadMinor: string;
  /** Building fill. */
  building: string;
  /** Admin boundaries + subtle glow. */
  glow: string;
  /** Label text. */
  label: string;
  /** Label halo. */
  labelHalo: string;
}

// ─── Reading Armada's live theme from CSS ─────────────────────────────

/** Wrap a raw CSS `H S% L%` triplet as an `hsl(...)` color string. */
function hsl(triplet: string): string {
  return `hsl(${triplet.trim()})`;
}

/** Read a `--token` custom property off :root (raw `H S% L%`), or "" if absent. */
function readVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Build a map palette from Armada's live theme CSS variables. The theme system
 * (presets, light/dark, and imported Nostr/Ditto theme events) all resolve into
 * these `--*` custom properties, so reading them here makes the map adopt any
 * active theme — including a Nostr theme event — for free.
 *
 * The role→token mapping keeps the theme's hue while pulling water/land toward
 * distinct planes derived from the surface tokens, and uses the accent (primary)
 * for roads + label glow so streets pick up the theme's neon.
 */
export function themePalette(): MapPalette {
  const background = readVar("--background") || "260 22% 9%";
  const secondary = readVar("--secondary") || background;
  const muted = readVar("--muted") || secondary;
  const border = readVar("--border") || muted;
  const primary = readVar("--primary") || "330 90% 62%";
  const foreground = readVar("--foreground") || "0 0% 100%";
  const chrome = readVar("--chrome") || background;
  const dark = isDarkTheme(background);

  // Water: nudge the theme's background toward its own hue at a distinct
  // lightness so it reads as a separate plane on both light and dark themes.
  const bg = parseHsl(background);
  const waterTriplet = `${bg.h} ${Math.min(bg.s + 12, 100)}% ${
    dark ? Math.min(bg.l + 6, 100) : Math.max(bg.l - 10, 0)
  }%`;

  return {
    void: hsl(background),
    land: hsl(chrome),
    water: hsl(waterTriplet),
    road: hsl(primary),
    roadMinor: hsl(border),
    building: hsl(secondary),
    glow: hsl(primary),
    label: hsl(foreground),
    labelHalo: hsl(background),
  };
}

/** A fixed dark palette (the "moon" look), independent of the app theme. */
export function moonPalette(): MapPalette {
  return {
    void: "#0b1220",
    land: "#111a2b",
    water: "#0d2036",
    road: "#5b7bb4",
    roadMinor: "#26334d",
    building: "#17223a",
    glow: "#3b82f6",
    label: "#c7d3e8",
    labelHalo: "#0b1220",
  };
}

/**
 * The accent color for overlay chrome (the "you" beacon, the route line, and the
 * map's own buttons) *for the current map look* — so these track the map, not
 * the app. "sparkle" uses the app's live `--primary` (the map matches the app,
 * so the accent should too); "sun"/"moon" use a fixed accent that reads on that
 * look's streets. Returns a concrete color string usable by CSS and MapLibre.
 */
export function mapAccentColor(theme: MapTheme): string {
  if (theme === "moon") return moonPalette().glow;
  if (theme === "sun") return "#e11d48"; // rose — pops on light OSM streets
  // sparkle: the app's --primary.
  if (typeof document === "undefined") return "#3b82f6";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return v ? `hsl(${v})` : "#3b82f6";
}

/** A readable foreground (text) color to place *on* {@link mapAccentColor}. */
export function mapAccentForeground(theme: MapTheme): string {
  if (theme === "sparkle") {
    if (typeof document === "undefined") return "#ffffff";
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--primary-foreground")
      .trim();
    return v ? `hsl(${v})` : "#ffffff";
  }
  return "#ffffff"; // sun rose + moon blue both take white text
}

// ─── Recolor ──────────────────────────────────────────────────────────

/** Rewrite one layer's paint colors from the palette (mirrors yonder). */
function recolorLayer(layer: LayerSpecification, palette: MapPalette): void {
  const id = layer.id.toLowerCase();
  const paint = ((layer as { paint?: Record<string, unknown> }).paint ??= {});
  const set = (k: string, v: string | number) => {
    paint[k] = v;
  };

  if (layer.type === "background") {
    set("background-color", palette.void);
    return;
  }
  if (layer.type === "fill") {
    if (id.includes("water")) set("fill-color", palette.water);
    else if (id.includes("building")) {
      set("fill-color", palette.building);
      set("fill-opacity", 0.85);
    } else if (id.includes("wood") || id.includes("park") || id.includes("grass") || id.includes("forest")) {
      set("fill-color", palette.land);
    } else if (id.includes("landcover") || id.includes("landuse")) {
      set("fill-color", palette.land);
      set("fill-opacity", 0.4);
    } else {
      set("fill-color", palette.land);
    }
    return;
  }
  if (layer.type === "fill-extrusion") {
    set("fill-extrusion-color", palette.building);
    set("fill-extrusion-opacity", 0.6);
    return;
  }
  if (layer.type === "line") {
    if (id.includes("water") || id.includes("waterway")) {
      set("line-color", palette.water);
    } else if (id.includes("boundary") || id.includes("admin")) {
      set("line-color", palette.glow);
      set("line-opacity", 0.25);
    } else if (
      id.includes("motorway") ||
      id.includes("trunk") ||
      id.includes("primary") ||
      id.includes("transportation")
    ) {
      set("line-color", palette.road);
    } else {
      set("line-color", palette.roadMinor);
    }
    return;
  }
  if (layer.type === "symbol") {
    set("text-color", palette.label);
    set("text-halo-color", palette.labelHalo);
    set("text-halo-width", 1.4);
    set("icon-opacity", 0.6);
  }
}

/** Recolor a full style in place from a palette, ensuring a void background. */
export function recolorStyle(style: StyleSpecification, palette: MapPalette): StyleSpecification {
  for (const layer of style.layers) {
    try {
      recolorLayer(layer, palette);
    } catch {
      // Leave any layer we can't recolor untouched.
    }
  }
  if (!style.layers.some((l) => l.type === "background")) {
    style.layers.unshift({
      id: "armada-void",
      type: "background",
      paint: { "background-color": palette.void },
    });
  }
  return style;
}

// ─── Fetch + apply ────────────────────────────────────────────────────

/**
 * Fetch the Dreamith street style and apply the given look. "sun" returns the
 * raw style; "moon"/"sparkle" recolor it. Throws if the network style can't be
 * retrieved; callers should fall back to {@link fallbackMapStyle}.
 */
export async function loadMapStyle(theme: MapTheme, signal?: AbortSignal): Promise<StyleSpecification> {
  const res = await fetch(DREAMITH_STYLE_URL, { signal });
  if (!res.ok) throw new Error(`Failed to load map style: ${res.status}`);
  const style = (await res.json()) as StyleSpecification;
  if (theme === "sun") return style;
  return recolorStyle(style, theme === "moon" ? moonPalette() : themePalette());
}

/**
 * Minimal offline fallback style: just a dark "void" background (no tiles), so
 * the map canvas + the location marker still render when the street style is
 * unreachable.
 */
export function fallbackMapStyle(): StyleSpecification {
  return {
    version: 8,
    name: "Armada (offline)",
    sources: {},
    layers: [
      { id: "void", type: "background", paint: { "background-color": "#0b1220" } },
    ],
  };
}
