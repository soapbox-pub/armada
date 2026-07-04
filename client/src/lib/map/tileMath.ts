/**
 * Slippy-map tile math for the offline-map downloader.
 *
 * Everything here is pure arithmetic on the Web Mercator tile grid (the "XYZ" /
 * slippy scheme MapLibre and OpenMapTiles use): the world at zoom `z` is a
 * 2^z × 2^z grid of square tiles, tile (0,0) at the top-left (north-west).
 *
 * The downloader frames an area as a lon/lat bounding box, then enumerates the
 * tiles covering it at every zoom `0..maxZoom`. The provider's vector tiles cap
 * at z14 (higher zooms are rendered by *overzooming* z14 client-side), so we
 * never fetch past {@link MAX_TILE_ZOOM} — this is what keeps a region download
 * to thousands, not millions, of tiles.
 */

/** Provider vector tiles top out here; z15+ is client-side overzoom of z14. */
export const MAX_TILE_ZOOM = 14;

/** A lon/lat bounding box (degrees). */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** An integer tile address on the slippy grid. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Web Mercator's usable latitude range; beyond this the projection diverges. */
const MAX_LAT = 85.05112878;

const clampLat = (lat: number): number => Math.min(MAX_LAT, Math.max(-MAX_LAT, lat));
const clampLon = (lon: number): number => Math.min(180, Math.max(-180, lon));

/** Longitude (deg) → fractional tile X at zoom `z`. */
export function lonToTileX(lon: number, z: number): number {
  return ((clampLon(lon) + 180) / 360) * 2 ** z;
}

/** Latitude (deg) → fractional tile Y at zoom `z` (Web Mercator). */
export function latToTileY(lat: number, z: number): number {
  const rad = (clampLat(lat) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Inclusive integer tile-X range [min,max] covering a lon span at zoom `z`. */
function tileXRange(west: number, east: number, z: number): [number, number] {
  const n = 2 ** z;
  const max = n - 1;
  const lo = Math.floor(lonToTileX(west, z));
  // A box touching the eastern tile edge shouldn't pull in the next tile, so
  // nudge an exact integer boundary back by one tile.
  const hiF = lonToTileX(east, z);
  let hi = Math.floor(hiF);
  if (hi === hiF && hi > lo) hi -= 1;
  return [Math.max(0, Math.min(max, lo)), Math.max(0, Math.min(max, hi))];
}

/** Inclusive integer tile-Y range [min,max] covering a lat span at zoom `z`. */
function tileYRange(south: number, north: number, z: number): [number, number] {
  const n = 2 ** z;
  const max = n - 1;
  // North is the *smaller* Y (grid origin is top-left / NW).
  const lo = Math.floor(latToTileY(north, z));
  const hiF = latToTileY(south, z);
  let hi = Math.floor(hiF);
  if (hi === hiF && hi > lo) hi -= 1;
  return [Math.max(0, Math.min(max, lo)), Math.max(0, Math.min(max, hi))];
}

/** Normalize a bbox so west<east and south<north (swaps flipped inputs). */
export function normalizeBBox(b: BBox): BBox {
  return {
    west: Math.min(b.west, b.east),
    east: Math.max(b.west, b.east),
    south: Math.min(b.south, b.north),
    north: Math.max(b.south, b.north),
  };
}

/**
 * Count the tiles covering `bbox` across zooms `minZoom..maxZoom` (inclusive),
 * without allocating them. Pure multiplication per zoom — cheap enough to run
 * on every map `move` for a live readout.
 */
export function countTilesForBBox(bbox: BBox, minZoom: number, maxZoom: number): number {
  const b = normalizeBBox(bbox);
  const top = Math.min(maxZoom, MAX_TILE_ZOOM);
  let total = 0;
  for (let z = Math.max(0, minZoom); z <= top; z++) {
    const [x0, x1] = tileXRange(b.west, b.east, z);
    const [y0, y1] = tileYRange(b.south, b.north, z);
    total += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return total;
}

/**
 * Enumerate every tile covering `bbox` across `minZoom..maxZoom`. Ordered by
 * ascending zoom (parents before children) so a partial/canceled download
 * still yields a usable coarse map.
 */
export function tilesForBBox(bbox: BBox, minZoom: number, maxZoom: number): TileCoord[] {
  const b = normalizeBBox(bbox);
  const top = Math.min(maxZoom, MAX_TILE_ZOOM);
  const tiles: TileCoord[] = [];
  for (let z = Math.max(0, minZoom); z <= top; z++) {
    const [x0, x1] = tileXRange(b.west, b.east, z);
    const [y0, y1] = tileYRange(b.south, b.north, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
    }
  }
  return tiles;
}

/**
 * Typical compressed byte size of one vector tile at a given zoom, used only
 * for the *live* pre-download estimate (the actual size is summed from real
 * bytes as tiles arrive). Low zooms carry little geometry; z12–14 over land are
 * the heavy ones. Deliberately rough — an honest ballpark, labeled "~" in UI.
 */
export function estimatedTileBytes(z: number): number {
  if (z <= 4) return 2_000;
  if (z <= 7) return 6_000;
  if (z <= 10) return 15_000;
  if (z <= 12) return 30_000;
  return 55_000; // z13–14
}

/** Estimated total download bytes for a bbox across `minZoom..maxZoom`. */
export function estimateBytesForBBox(bbox: BBox, minZoom: number, maxZoom: number): number {
  const b = normalizeBBox(bbox);
  const top = Math.min(maxZoom, MAX_TILE_ZOOM);
  let bytes = 0;
  for (let z = Math.max(0, minZoom); z <= top; z++) {
    const [x0, x1] = tileXRange(b.west, b.east, z);
    const [y0, y1] = tileYRange(b.south, b.north, z);
    bytes += (x1 - x0 + 1) * (y1 - y0 + 1) * estimatedTileBytes(z);
  }
  return bytes;
}

/** Human byte size, e.g. "820 KB" / "1.4 MB" / "2.3 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
