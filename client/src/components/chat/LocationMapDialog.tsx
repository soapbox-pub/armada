import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { fallbackMapStyle, loadStreetStyle } from "@/lib/map/dreamithStyle";

import type { GeoPoint } from "@/lib/location";

interface LocationMapDialogProps {
  point: GeoPoint;
  onClose: () => void;
}

/**
 * Fullscreen interactive map centered on a shared location, rendered over a
 * portal (like {@link Lightbox}). Uses MapLibre GL with Dreamith's OpenFreeMap
 * street tiles, falling back to a dark background if the style can't load
 * (offline). Escape or the X button exits.
 */
export function LocationMapDialog({ point, onClose }: LocationMapDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: fallbackMapStyle(),
      center: [point.lon, point.lat],
      zoom: 15,
      attributionControl: false,
      dragRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

    // The pin marker.
    new maplibregl.Marker({ color: "#3b82f6" })
      .setLngLat([point.lon, point.lat])
      .addTo(map);

    // The container is inside a freshly-portaled overlay, so its box may not be
    // laid out yet when the map is constructed — MapLibre then measures a 0×0
    // canvas and renders nothing (a black screen). Resize once the layout
    // settles and whenever the container's box changes.
    const resize = () => map.resize();
    map.once("load", resize);
    requestAnimationFrame(resize);
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Swap in the real street style once fetched; keep the fallback on failure.
    const controller = new AbortController();
    void (async () => {
      try {
        const style = await loadStreetStyle(controller.signal);
        if (!controller.signal.aborted) map.setStyle(style);
      } catch {
        // Offline / fetch failed: keep the dark fallback background + marker.
      }
    })();

    return () => {
      controller.abort();
      ro.disconnect();
      map.remove();
    };
  }, [point.lat, point.lon]);

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black" role="dialog" aria-modal="true">
      <div ref={containerRef} className="h-full w-full" />

      {/* Close button — top-right, clear of the zoom controls (top-left). */}
      <button
        type="button"
        aria-label="Close map"
        className="absolute top-safe-4 right-4 pointer-events-auto p-2 rounded-full bg-black/60 backdrop-blur text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        onClick={onClose}
      >
        <X className="size-6" />
      </button>
    </div>,
    document.body,
  );
}
