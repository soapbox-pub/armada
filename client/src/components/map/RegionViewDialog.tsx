import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { MapControlButton, MapThemeToggle } from "@/components/map/MapControls";
import { useEscape } from "@/hooks/useEscape";
import { useMapTheme } from "@/hooks/useMapTheme";
import { useOfflineMap } from "@/hooks/useOfflineMap";
import type { RegionRecord } from "@/lib/map/offlineManifest";
import { setTilesCacheOnly } from "@/lib/map/tileProtocol";

interface RegionViewDialogProps {
  region: RegionRecord;
  onClose: () => void;
}

/**
 * Fullscreen viewer for a *downloaded* offline region. Opens fit to the region's
 * bounding box and renders strictly from the cached tiles — tiles outside the
 * saved extent are dropped (see {@link setTilesCacheOnly}), so only the
 * downloaded section is shown, even when the device is online. Pan/zoom is free
 * but the world outside the region stays blank; a look toggle cycles
 * sparkle/sun/moon like the other map surfaces. No GPS, route, or navigate.
 */
export function RegionViewDialog({ region, onClose }: RegionViewDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapTheme = useMapTheme();
  const { theme } = mapTheme;

  useEscape(onClose);

  // Serve tiles cache-only while this viewer is mounted, so the map can't pull
  // in tiles beyond the downloaded region. A layout effect sets the flag before
  // useOfflineMap's (passive) effect constructs the map and requests tiles.
  useLayoutEffect(() => {
    setTilesCacheOnly(true);
    return () => setTilesCacheOnly(false);
  }, []);

  const { bbox } = region;
  const center: [number, number] = [
    (bbox.east + bbox.west) / 2,
    (bbox.north + bbox.south) / 2,
  ];

  const mapRef = useOfflineMap({
    containerRef,
    center,
    zoom: 12,
    theme,
    followAppTheme: true,
  });

  // Fit the saved region's bbox once the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const fit = () => {
      const bounds = new maplibregl.LngLatBounds(
        [bbox.west, bbox.south],
        [bbox.east, bbox.north],
      );
      map.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 16 });
    };
    if (map.loaded()) fit();
    else map.once("load", fit);
  }, [mapRef, bbox.west, bbox.south, bbox.east, bbox.north]);

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black" role="dialog" aria-modal="true">
      <div ref={containerRef} className="h-full w-full" />

      {/* Close button — top-right, clear of the zoom controls (top-left). */}
      <MapControlButton
        icon={X}
        label="Close map"
        onClick={onClose}
        className="absolute top-safe-4 right-4"
      />

      {/* Look toggle — under the close button. Cycles sparkle → sun → moon. */}
      <MapThemeToggle mapTheme={mapTheme} className="absolute top-safe-16 right-4" />

      {/* Region name — bottom center. */}
      <div className="absolute bottom-safe-4 left-1/2 -translate-x-1/2 pointer-events-none max-w-[80vw] truncate rounded-full bg-black/60 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur">
        {region.name}
      </div>
    </div>,
    document.body,
  );
}
