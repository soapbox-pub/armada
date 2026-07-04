import maplibregl from "maplibre-gl";

import { applyMapTheme, DREAMITH_STYLE_URL, type MapTheme } from "@/lib/map/dreamithStyle";
import { getTileStore } from "@/lib/map/getTileStore";
import {
  getRegion,
  getTileIndexEntry,
  putRegion,
  putTileIndex,
  regionsContainingKey,
  SHARED_REGION_ID,
} from "@/lib/map/offlineManifest";
import {
  fromOfflineUrl,
  OFFLINE_SCHEME,
  rewriteTileJsonForOffline,
  toOfflineUrl,
  urlToCacheKey,
} from "@/lib/map/providerUrls";

import type { GetResourceResponse, RequestParameters, StyleSpecification } from "maplibre-gl";
import type { AssetKind } from "@/lib/map/tileContainer";

type Payload = GetResourceResponse<unknown>;

/**
 * Offline serving glue for MapLibre.
 *
 * We register a custom `armada-offline://` protocol and rewrite every provider
 * URL in the style to it. When MapLibre requests a resource, the handler:
 *   1. classifies the underlying URL to a stable cache key,
 *   2. serves it cache-first (tiles/glyphs/sprites/hillshade — immutable per
 *      tile version) or network-first (style/tilejson docs, which go stale as
 *      the provider rebuilds its planet),
 *   3. self-seeds shared assets (style/tilejson/sprite/glyphs/hillshade) into
 *      the shared cache on network fetches, so the map works offline after one
 *      online view.
 *
 * Tiles are NOT auto-cached here (explicit region downloads only, per design);
 * only the small shared assets self-seed, since they're required for *any*
 * offline region to render and are trivially small.
 *
 * Payload shape matters: MapLibre hands custom-protocol results straight to
 * callers, so `data` must match the requested `type` — a parsed object for
 * `json` (TileJSON, sprite index), a string for `string`, else an ArrayBuffer.
 */

let registered = false;

/** Register the offline protocol handler exactly once (idempotent). */
export function ensureOfflineProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(OFFLINE_SCHEME, offlineProtocolHandler);
}

/** Shared (non-tile) asset kinds that self-seed the cache when fetched online. */
const SELF_SEED: ReadonlySet<AssetKind> = new Set<AssetKind>([
  "style",
  "tilejson",
  "sprite",
  "glyph",
  "raster",
]);

function offlineProtocolHandler(
  params: RequestParameters,
  abortController: AbortController,
): Promise<Payload> {
  return serve(fromOfflineUrl(params.url), params, abortController);
}

async function serve(
  url: string,
  params: RequestParameters,
  abort: AbortController,
): Promise<Payload> {
  const classified = urlToCacheKey(url);

  // Unrecognized resource: pass through to the network unchanged.
  if (!classified) return present(await networkFetch(url, params, abort), params, null);

  const { key, kind } = classified;

  const readCache = async (): Promise<Uint8Array | null> => {
    const store = getTileStore();
    if (kind === "tile") {
      // Probe any region that catalogued this tile key (newest first).
      for (const { regionId, entry } of await regionsContainingKey(key)) {
        const cached = await store.readKey(regionId, key, entry);
        if (cached) return cached;
      }
      return null;
    }
    // Shared assets live under the shared pseudo-region.
    const entry = await getTileIndexEntry(SHARED_REGION_ID, key);
    return store.readKey(SHARED_REGION_ID, key, entry);
  };

  const fromNetwork = async (): Promise<Uint8Array> => {
    const bytes = await networkFetch(url, params, abort);
    if (kind !== "tile" && SELF_SEED.has(kind) && bytes.byteLength > 0) {
      void seedShared(key, bytes);
    }
    return bytes;
  };

  // Style/tilejson docs go stale (provider planet rebuilds), so prefer the
  // network and fall back to cache offline. Everything else is cache-first.
  let bytes: Uint8Array | null;
  if (kind === "style" || kind === "tilejson") {
    try {
      bytes = await fromNetwork();
    } catch (err) {
      bytes = await readCache();
      if (!bytes) throw err;
    }
  } else {
    bytes = (await readCache()) ?? (await fromNetwork());
  }
  return present(bytes, params, kind);
}

/** Convert raw cached/network bytes into the payload shape MapLibre asked for. */
function present(
  bytes: Uint8Array,
  params: RequestParameters,
  kind: AssetKind | "tile" | null,
): Payload {
  if (params.type === "json") {
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    // TileJSON: route its tile templates back through this protocol, so tile
    // requests can be served from downloaded regions too.
    return { data: kind === "tilejson" ? rewriteTileJsonForOffline(obj) : obj };
  }
  if (params.type === "string") return { data: new TextDecoder().decode(bytes) };
  return { data: toArrayBuffer(bytes) };
}

/**
 * Store one shared-asset key under the shared pseudo-region (best-effort).
 * Skips the append when identical bytes are already cached, so network-first
 * assets (style/tilejson) don't grow the native container file on every load.
 */
async function seedShared(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const store = getTileStore();
    const existingEntry = await getTileIndexEntry(SHARED_REGION_ID, key);
    const existing = await store.readKey(SHARED_REGION_ID, key, existingEntry);
    if (existing && sameBytes(existing, bytes)) return;
    const index = await store.appendRegion(SHARED_REGION_ID, [{ key, bytes }]);
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
  } catch {
    // best-effort seeding
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A standalone ArrayBuffer copy of a (possibly view-backed) Uint8Array. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Fetch from the network to raw bytes. */
async function networkFetch(
  url: string,
  params: RequestParameters,
  abort: AbortController,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal: abort.signal, headers: params.headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Load the recolored map style, cache-aware: fetch the raw style from the
 * network (seeding the shared cache so it survives offline), and if that fails
 * fall back to the style JSON cached from a prior online view or region
 * download. Always returns a style already rewritten for offline serving, or
 * throws if neither source is available (caller falls back to a tiles-free
 * style).
 */
export async function loadOfflineAwareStyle(
  theme: MapTheme,
  signal?: AbortSignal,
): Promise<StyleSpecification> {
  let raw: StyleSpecification;
  try {
    const res = await fetch(DREAMITH_STYLE_URL, { signal });
    if (!res.ok) throw new Error(`Failed to load map style: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    raw = JSON.parse(new TextDecoder().decode(bytes)) as StyleSpecification;
    const styleClass = urlToCacheKey(DREAMITH_STYLE_URL);
    if (styleClass) void seedShared(styleClass.key, bytes);
  } catch (networkErr) {
    const cached = await readCachedStyle();
    if (!cached) throw networkErr;
    raw = cached;
  }
  return rewriteStyleForOffline(applyMapTheme(raw, theme));
}

/** Read the cached raw style JSON from the shared region, if present. */
async function readCachedStyle(): Promise<StyleSpecification | null> {
  const store = getTileStore();
  // The style key is derived from its URL path (see urlToCacheKey).
  const styleClass = urlToCacheKey(DREAMITH_STYLE_URL);
  if (!styleClass) return null;
  const entry = await getTileIndexEntry(SHARED_REGION_ID, styleClass.key);
  const bytes = await store.readKey(SHARED_REGION_ID, styleClass.key, entry);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as StyleSpecification;
  } catch {
    return null;
  }
}

/**
 * Point every provider resource in a style at the offline protocol: glyphs,
 * sprite, and each source's TileJSON `url` / `tiles` templates. Template
 * tokens survive verbatim (see {@link toOfflineUrl}).
 */
export function rewriteStyleForOffline(style: StyleSpecification): StyleSpecification {
  const next: StyleSpecification = structuredClone(style);
  if (typeof next.glyphs === "string") next.glyphs = toOfflineUrl(next.glyphs);
  if (typeof next.sprite === "string") next.sprite = toOfflineUrl(next.sprite);
  for (const src of Object.values(next.sources ?? {})) {
    const s = src as { url?: string; tiles?: string[] };
    if (typeof s.url === "string") s.url = toOfflineUrl(s.url);
    if (Array.isArray(s.tiles)) s.tiles = s.tiles.map((t) => toOfflineUrl(t));
  }
  return next;
}
