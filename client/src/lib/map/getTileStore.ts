import { Capacitor } from "@capacitor/core";

import { nativeTileStore } from "@/lib/map/nativeTileStore";
import { webTileStore } from "@/lib/map/webTileStore";

import type { TileStore } from "@/lib/map/tileStore";

/**
 * The active {@link TileStore} for this runtime: the native Filesystem-backed
 * store on Capacitor (Android/iOS), else the IndexedDB store (web/Electron).
 * Native is preferred because its files aren't subject to WebView storage
 * eviction, which downloaded maps must survive.
 */
export function getTileStore(): TileStore {
  return Capacitor.isNativePlatform() ? nativeTileStore : webTileStore;
}
