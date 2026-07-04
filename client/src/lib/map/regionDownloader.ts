import { DREAMITH_STYLE_URL } from "@/lib/map/dreamithStyle";
import {
  deleteRegionRecord,
  getRegion,
  putRegion,
  putTileIndex,
  SHARED_REGION_ID,
} from "@/lib/map/offlineManifest";
import { getTileStore } from "@/lib/map/getTileStore";
import { assetKey, tileKey } from "@/lib/map/tileContainer";
import {
  GLYPH_FONTSTACKS,
  GLYPH_RANGES,
  MAX_TILE_ZOOM,
  SPRITE_FILES,
  tileUrl,
  tileVersionFromTemplate,
  urlToCacheKey,
} from "@/lib/map/providerUrls";
import { tilesForBBox } from "@/lib/map/tileMath";

import type { RegionRecord } from "@/lib/map/offlineManifest";
import type { BBox, TileCoord } from "@/lib/map/tileMath";

/**
 * Downloads a bbox region's tiles (+ shared assets) into the offline store.
 *
 * The size shown while framing an area is a fast *estimate* (see `tileMath`);
 * this engine reports the *exact* size as it goes, by summing the real byte
 * length of every tile it stores — so `onProgress.bytes` is truthful, not
 * projected. Tiles are fetched with bounded concurrency against the provider
 * (our own server), appended to the region's container in batches, and their
 * offsets recorded in the manifest. Cancelable via an AbortSignal; a canceled
 * or failed download rolls back its partial region record.
 */

/** How many tiles to fetch in parallel. Polite against our own tile server. */
const CONCURRENCY = 6;
/** Flush stored tiles to the manifest/container every N tiles. */
const FLUSH_EVERY = 64;

/** The provider origin, derived from the configured style URL. */
function providerBase(): string {
  return new URL(DREAMITH_STYLE_URL).origin;
}

export interface DownloadProgress {
  /** Tiles successfully stored so far. */
  done: number;
  /** Total tiles to fetch for this region. */
  total: number;
  /** Exact bytes stored so far (sum of real tile + asset sizes). */
  bytes: number;
}

export interface DownloadRegionParams {
  id: string;
  name: string;
  bbox: BBox;
  maxZoom?: number;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
}

/**
 * Discover the current tile-build version + sprite base URL from the live
 * TileJSON/style. Must run online; the version pins the region's tiles so a
 * later provider planet rebuild doesn't orphan them mid-download. Also returns
 * the raw style/tilejson document bytes so the download can cache them —
 * they're required for a freshly-downloaded region to render with zero prior
 * online map use.
 */
async function discoverProvider(signal?: AbortSignal): Promise<{
  version: string;
  spriteBase: string;
  docs: { key: string; bytes: Uint8Array }[];
}> {
  const styleRes = await fetch(DREAMITH_STYLE_URL, { signal });
  if (!styleRes.ok) throw new Error(`style ${styleRes.status}`);
  const styleBytes = new Uint8Array(await styleRes.arrayBuffer());
  const style = JSON.parse(new TextDecoder().decode(styleBytes)) as {
    sprite?: string;
    sources?: Record<string, { url?: string }>;
  };

  // Sprite base URL (e.g. "https://…/sprites/ofm_f384/ofm"), from the style.
  const spriteBase = style.sprite ?? `${providerBase()}/sprites/ofm_f384/ofm`;

  // Tile version: read the vector source's TileJSON and parse its tile template.
  const tjUrl = Object.values(style.sources ?? {}).find((s) => s.url)?.url;
  if (!tjUrl) throw new Error("no vector source in style");
  const tjRes = await fetch(tjUrl, { signal });
  if (!tjRes.ok) throw new Error(`tilejson ${tjRes.status}`);
  const tjBytes = new Uint8Array(await tjRes.arrayBuffer());
  const tj = JSON.parse(new TextDecoder().decode(tjBytes)) as { tiles?: string[] };
  const version = tj.tiles?.[0] ? tileVersionFromTemplate(tj.tiles[0]) : null;
  if (!version) throw new Error("could not determine tile version");

  const docs: { key: string; bytes: Uint8Array }[] = [];
  const styleClass = urlToCacheKey(DREAMITH_STYLE_URL);
  if (styleClass) docs.push({ key: styleClass.key, bytes: styleBytes });
  const tjClass = urlToCacheKey(tjUrl);
  if (tjClass) docs.push({ key: tjClass.key, bytes: tjBytes });

  return { version, spriteBase, docs };
}

/** Fetch one URL to bytes, or null on any failure (missing tiles are skipped). */
async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Download `bbox` z0..maxZoom into region `id`. Resolves to the final
 * {@link RegionRecord}. Throws `DOMException('AbortError')` if canceled.
 */
export async function downloadRegion(params: DownloadRegionParams): Promise<RegionRecord> {
  const { id, name, bbox, signal, onProgress } = params;
  const maxZoom = Math.min(params.maxZoom ?? MAX_TILE_ZOOM, MAX_TILE_ZOOM);
  const store = getTileStore();

  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Download canceled", "AbortError");
  };

  throwIfAborted();
  const { version, spriteBase, docs } = await discoverProvider(signal);
  const base = providerBase();

  const tiles = tilesForBBox(bbox, 0, maxZoom);
  const total = tiles.length;
  let done = 0;
  let bytes = 0;

  // Pending (key,bytes) to flush to the region container in a batch.
  let pending: { key: string; bytes: Uint8Array }[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const index = await store.appendRegion(id, batch);
    await putTileIndex(id, index);
  };

  // Seed a provisional region record so the UI can show it immediately and a
  // crash leaves a deletable (not phantom) entry.
  await putRegion({
    id,
    name,
    bbox,
    minZoom: 0,
    maxZoom,
    tileVersion: version,
    tileCount: 0,
    bytes: 0,
    createdAt: Date.now(),
  });

  try {
    // Fetch tiles with a bounded worker pool over the tile list.
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        throwIfAborted();
        const i = cursor++;
        if (i >= tiles.length) return;
        const t: TileCoord = tiles[i];
        const data = await fetchBytes(tileUrl(base, version, t), signal);
        if (data && data.length > 0) {
          pending.push({ key: tileKey(t), bytes: data });
          bytes += data.length;
        }
        done++;
        if (pending.length >= FLUSH_EVERY) await flush();
        onProgress?.({ done, total, bytes });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flush();

    // Fetch shared assets (style/tilejson docs + sprite + glyphs) so the
    // region renders offline with zero prior online map use.
    await downloadSharedAssets(base, spriteBase, docs, signal);

    const record: RegionRecord = {
      id,
      name,
      bbox,
      minZoom: 0,
      maxZoom,
      tileVersion: version,
      tileCount: done,
      bytes,
      createdAt: Date.now(),
    };
    await putRegion(record);
    onProgress?.({ done, total, bytes });
    return record;
  } catch (err) {
    // Roll back partial state on cancel/failure.
    await store.deleteRegion(id).catch(() => {});
    await deleteRegionRecord(id).catch(() => {});
    throw err;
  }
}

/**
 * Store the style/tilejson docs and fetch + store the sprite files and Latin
 * glyph ranges into the shared pseudo-region, so any downloaded region can
 * render labels/icons offline. Best-effort per asset (a missing @2x variant
 * shouldn't fail the region).
 */
async function downloadSharedAssets(
  base: string,
  spriteBase: string,
  docs: { key: string; bytes: Uint8Array }[],
  signal?: AbortSignal,
): Promise<void> {
  const store = getTileStore();
  const batch: { key: string; bytes: Uint8Array }[] = [...docs];

  const spriteDir = spriteBase.slice(0, spriteBase.lastIndexOf("/"));
  const spriteName = spriteBase.slice(spriteBase.lastIndexOf("/") + 1);
  for (const file of SPRITE_FILES(spriteName)) {
    const data = await fetchBytes(`${spriteDir}/${file}`, signal);
    if (data) batch.push({ key: assetKey("sprite", file), bytes: data });
  }
  for (const stack of GLYPH_FONTSTACKS) {
    for (const range of GLYPH_RANGES) {
      const url = `${base}/fonts/${encodeURIComponent(stack)}/${range}.pbf`;
      const data = await fetchBytes(url, signal);
      if (data) batch.push({ key: assetKey("glyph", `${stack}/${range}`), bytes: data });
    }
  }

  if (batch.length === 0) return;
  const index = await store.appendRegion(SHARED_REGION_ID, batch);
  await putTileIndex(SHARED_REGION_ID, index);
  if (!(await getRegion(SHARED_REGION_ID))) {
    await putRegion({
      id: SHARED_REGION_ID,
      name: "Shared map assets",
      bbox: { west: 0, south: 0, east: 0, north: 0 },
      minZoom: 0,
      maxZoom: 0,
      tileVersion: "",
      tileCount: 0,
      bytes: 0,
      createdAt: Date.now(),
    });
  }
}
