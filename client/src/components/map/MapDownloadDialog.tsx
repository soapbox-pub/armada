import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Download, Loader2, Locate, X } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MapControlButton, MapThemeToggle } from "@/components/map/MapControls";
import { Button } from "@/components/ui/button";
import { useEscape } from "@/hooks/useEscape";
import { useMapTheme } from "@/hooks/useMapTheme";
import { useOfflineMap } from "@/hooks/useOfflineMap";
import { getCurrentLocation } from "@/lib/geolocation";
import { reverseGeocodeName } from "@/lib/map/reverseGeocode";
import { downloadRegion, type DownloadProgress } from "@/lib/map/regionDownloader";
import {
  countTilesForBBox,
  estimateBytesForBBox,
  formatBytes,
  MAX_TILE_ZOOM,
  type BBox,
} from "@/lib/map/tileMath";

interface MapDownloadDialogProps {
  /** Called after a region finishes downloading (to refresh the list). */
  onDownloaded: () => void;
  onClose: () => void;
}

/**
 * Hard cap on a single download's tile count. Framing a huge area (zoomed out)
 * would enqueue z0–14 for a continent — hundreds of thousands of tiles. Past
 * this the download button is disabled with a "zoom in" hint.
 */
const MAX_TILES = 20_000;

/** Convert MapLibre's LngLatBounds into our BBox. */
function boundsToBBox(b: maplibregl.LngLatBounds): BBox {
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
}

/**
 * Fullscreen picker for downloading an offline map region. Opens centered on
 * the user's current location; the user pans/zooms to frame an area and a live
 * "~N tiles · ~X MB" readout (exact tile count, estimated size) updates on every
 * move. Downloading fetches z0–14 for the framed viewport, showing an EXACT
 * running size (summed real bytes) with a cancelable progress bar.
 */
export function MapDownloadDialog({ onDownloaded, onClose }: MapDownloadDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Last known location (from the initial fix), for the locate button. */
  const locatedRef = useRef<{ lat: number; lon: number } | null>(null);

  const [bbox, setBBox] = useState<BBox | null>(null);
  const mapTheme = useMapTheme();
  const { theme } = mapTheme;
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tileCount = bbox ? countTilesForBBox(bbox, 0, MAX_TILE_ZOOM) : 0;
  const estBytes = bbox ? estimateBytesForBBox(bbox, 0, MAX_TILE_ZOOM) : 0;
  const tooLarge = tileCount > MAX_TILES;

  // Create the map (centered on a wide view; recentered on the fix below).
  const mapRef = useOfflineMap({
    containerRef,
    center: [0, 20],
    zoom: 2,
    theme,
    onCreate: (map) => {
      const syncBounds = () => setBBox(boundsToBBox(map.getBounds()));
      map.on("load", syncBounds);
      map.on("move", syncBounds);

      // Center on the user's location (one-shot; no watch).
      void getCurrentLocation()
        .then((p) => {
          locatedRef.current = { lat: p.lat, lon: p.lon };
          map.easeTo({ center: [p.lon, p.lat], zoom: 12, duration: 600 });
        })
        .catch(() => {
          /* keep default view; user can pan */
        });
    },
  });

  useEscape(onClose, !downloading);

  const start = async () => {
    if (!bbox || tooLarge || downloading) return;
    setDownloading(true);
    setError(null);
    setProgress({ done: 0, total: tileCount, bytes: 0 });
    const controller = new AbortController();
    abortRef.current = controller;

    const center = { lat: (bbox.north + bbox.south) / 2, lon: (bbox.east + bbox.west) / 2 };
    const name = await reverseGeocodeName(center).catch(() => null);

    try {
      await downloadRegion({
        id: crypto.randomUUID(),
        name: name ?? `${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}`,
        bbox,
        signal: controller.signal,
        onProgress: setProgress,
      });
      onDownloaded();
      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Canceled: silently return to the picker.
      } else {
        setError("Download failed. Check your connection and try again.");
      }
    } finally {
      setDownloading(false);
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  // Recenter on the user's location (from the initial fix).
  const locate = () => {
    const map = mapRef.current;
    const you = locatedRef.current;
    if (!map || !you) return;
    map.easeTo({ center: [you.lon, you.lat], zoom: Math.max(map.getZoom(), 12), duration: 500 });
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-background text-foreground" role="dialog" aria-modal="true">
      {/* NOTE: size with h-full/w-full, not `absolute inset-0` — MapLibre adds
          the `maplibregl-map` class whose stylesheet sets `position: relative`
          at equal specificity, which would override `absolute` and collapse the
          container to 0 height (blank map). */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Close */}
      <MapControlButton
        icon={X}
        label="Close"
        onClick={onClose}
        variant="panel"
        disabled={downloading}
        className="absolute right-4 top-safe-4 z-10"
      />

      {/* Look toggle — under the close button. Cycles sparkle → sun → moon. */}
      <MapThemeToggle
        mapTheme={mapTheme}
        variant="panel"
        disabled={downloading}
        className="absolute right-4 top-safe-16 z-10"
      />

      {/* Locate — recenter on the user's position. */}
      <MapControlButton
        icon={Locate}
        label="Center on my location"
        title="Center on my location"
        onClick={locate}
        variant="panel"
        disabled={downloading}
        className="absolute right-4 top-safe-28 z-10"
      />

      {/* Bottom control panel. */}
      <div className="absolute inset-x-0 bottom-0 z-10 space-y-3 border-t border-border bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
        {downloading && progress ? (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-semibold">Downloading…</span>
              <span className="tabular-nums text-muted-foreground">
                {formatBytes(progress.bytes)} · {progress.done}/{progress.total}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <Button variant="outline" className="w-full" onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">Download this area</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {tileCount.toLocaleString()} tiles · ~{formatBytes(estBytes)}
              </span>
            </div>
            {tooLarge ? (
              <p className="text-xs text-destructive">Area too large — zoom in to download.</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Pan and zoom to frame the area you want available offline.
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button className="w-full gap-2" disabled={!bbox || tooLarge} onClick={start}>
              <Download className="size-4" />
              Download
            </Button>
          </>
        )}
      </div>

      {downloading && !progress && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}
    </div>,
    document.body,
  );
}
