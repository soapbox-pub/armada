import { assetKey, tileKey } from "@/lib/map/tileContainer";
import { MAX_TILE_ZOOM } from "@/lib/map/tileMath";

import type { AssetKind } from "@/lib/map/tileContainer";
import type { TileCoord } from "@/lib/map/tileMath";

/**
 * Maps the Dreamith/OpenFreeMap provider's concrete resource URLs to and from
 * the stable cache **keys** used by the offline store, and derives the URL of
 * each resource a region download must fetch.
 *
 * Everything here is pure string work (no network, no storage) so it's fully
 * testable. The provider layout (discovered from the live style/tilejson):
 *
 *   style     https://maps.dreamith.to/styles/liberty
 *   tilejson  https://maps.dreamith.to/planet
 *   tiles     https://maps.dreamith.to/planet/<version>/{z}/{x}/{y}.pbf
 *   sprite    https://maps.dreamith.to/sprites/ofm_f384/ofm(.json|.png|@2x.*)
 *   glyphs    https://maps.dreamith.to/fonts/{fontstack}/{range}.pbf
 *   raster    https://maps.dreamith.to/natural_earth/ne2sr/{z}/{x}/{y}.png
 */

/** Custom MapLibre protocol scheme for offline-served resources. */
export const OFFLINE_SCHEME = "armada-offline";

/**
 * Wrap an absolute https URL into an offline-protocol URL MapLibre will route.
 *
 * The original URL is kept **verbatim** (no percent-encoding): MapLibre
 * validates and substitutes template tokens (`{fontstack}`, `{range}`, `{z}`,
 * `{x}`, `{y}`) with literal string matching, so encoding the braces breaks
 * glyph/tile loading entirely. This is the same `scheme://https://…` shape the
 * pmtiles protocol uses; MapLibre only looks at the text before the first
 * `://` to pick the handler.
 */
export function toOfflineUrl(originalUrl: string): string {
  return `${OFFLINE_SCHEME}://${originalUrl}`;
}

/** Recover the original https URL from an offline-protocol URL. */
export function fromOfflineUrl(offlineUrl: string): string {
  return offlineUrl.slice(`${OFFLINE_SCHEME}://`.length);
}

/**
 * Rewrite a TileJSON document's `tiles` templates to offline-protocol URLs, so
 * the tile requests MapLibre derives from it are routed back through the
 * offline store instead of straight to the network.
 */
export function rewriteTileJsonForOffline<T>(tilejson: T): T {
  const tj = tilejson as { tiles?: unknown };
  if (!Array.isArray(tj.tiles)) return tilejson;
  return {
    ...tilejson,
    tiles: tj.tiles.map((t) => (typeof t === "string" ? toOfflineUrl(t) : t)),
  };
}

/**
 * Classify a provider URL into a stable cache key (and asset kind). Returns null
 * for URLs we don't recognize (served straight from network, never cached).
 */
export function urlToCacheKey(
  url: string,
): { key: string; kind: AssetKind | "tile" } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const p = u.pathname;

  // Vector tile: /planet/<version>/<z>/<x>/<y>.pbf
  const tile = p.match(/\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (tile) {
    return { key: tileKey({ z: +tile[1], x: +tile[2], y: +tile[3] }), kind: "tile" };
  }
  // Hillshade raster: /natural_earth/ne2sr/<z>/<x>/<y>.png
  const raster = p.match(/\/natural_earth\/ne2sr\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (raster) {
    return { key: assetKey("raster", `${raster[1]}/${raster[2]}/${raster[3]}`), kind: "raster" };
  }
  // Glyphs: /fonts/<fontstack>/<range>.pbf
  const glyph = p.match(/\/fonts\/(.+)\/(\d+-\d+)\.pbf$/);
  if (glyph) {
    return { key: assetKey("glyph", `${decodeURIComponent(glyph[1])}/${glyph[2]}`), kind: "glyph" };
  }
  // Sprite: /sprites/<set>/<name>(.json|.png|@2x.png ...)
  const sprite = p.match(/\/sprites\/[^/]+\/(.+)$/);
  if (sprite) {
    return { key: assetKey("sprite", sprite[1]), kind: "sprite" };
  }
  // Style / tilejson JSON docs.
  if (p.endsWith("/styles/liberty") || /\/styles\//.test(p)) {
    return { key: assetKey("style", p), kind: "style" };
  }
  if (p === "/planet") {
    return { key: assetKey("tilejson", p), kind: "tilejson" };
  }
  return null;
}

/** Build a tile's provider URL for a given tile-version prefix. */
export function tileUrl(base: string, version: string, t: TileCoord): string {
  return `${base}/planet/${version}/${t.z}/${t.x}/${t.y}.pbf`;
}

/** Extract the `<version>` build prefix from a tilejson `tiles[0]` template. */
export function tileVersionFromTemplate(template: string): string | null {
  const m = template.match(/\/planet\/([^/]+)\/\{z\}\/\{x\}\/\{y\}\.pbf/);
  return m ? m[1] : null;
}

/**
 * The fixed set of glyph ranges + fontstacks the liberty style references, so a
 * region download can pre-fetch fonts without parsing every symbol layer. The
 * style uses Noto Sans {Regular, Italic, Bold}; Latin text lives in ranges
 * 0-255 and 256-511, which covers the labels the base map draws.
 */
export const GLYPH_FONTSTACKS = ["Noto Sans Regular", "Noto Sans Italic", "Noto Sans Bold"];
export const GLYPH_RANGES = ["0-255", "256-511"];

/** The sprite files (base name from the style's `sprite` URL) to cache. */
export const SPRITE_FILES = (spriteName: string): string[] => [
  `${spriteName}.json`,
  `${spriteName}.png`,
  `${spriteName}@2x.json`,
  `${spriteName}@2x.png`,
];

/** Provider vector tiles cap here; the downloader must not request deeper. */
export { MAX_TILE_ZOOM };
