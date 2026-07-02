import type { StyleSpecification } from "maplibre-gl";

/**
 * Map style source for the location viewer.
 *
 * Armada renders shared locations on a full OpenStreetMap street map served as
 * OpenMapTiles vector tiles by Dreamith's OpenFreeMap-hosted "liberty" style.
 * No API key is required. When the network style can't be fetched (offline, or
 * before tiles are cached) we fall back to a minimal dark background so the map
 * still renders the point marker rather than a blank/broken canvas.
 */

/** OpenFreeMap-hosted OpenMapTiles vector style (full OSM street data). */
export const DREAMITH_STYLE_URL = "https://maps.dreamith.to/styles/liberty";

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

/**
 * Fetch the Dreamith street style. Throws if the network style can't be
 * retrieved; callers should fall back to {@link fallbackMapStyle}.
 */
export async function loadStreetStyle(signal?: AbortSignal): Promise<StyleSpecification> {
  const res = await fetch(DREAMITH_STYLE_URL, { signal });
  if (!res.ok) throw new Error(`Failed to load map style: ${res.status}`);
  return (await res.json()) as StyleSpecification;
}
