import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Locate, Navigation, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { MapControlButton, MapThemeToggle } from "@/components/map/MapControls";
import { useEscape } from "@/hooks/useEscape";
import { useGeoWatch } from "@/hooks/useGeoWatch";
import { useMapTheme } from "@/hooks/useMapTheme";
import { useOfflineMap } from "@/hooks/useOfflineMap";
import { haversine } from "@/lib/location";
import { mapAccentColor, mapAccentForeground } from "@/lib/map/dreamithStyle";

import type { GeoPoint } from "@/lib/location";

interface LocationMapDialogProps {
  point: GeoPoint;
  onClose: () => void;
  /** Switch to the fullscreen compass navigating to this point. */
  onNavigate?: () => void;
}

/** Id of the you→target route source/layer (re-added after each setStyle). */
const ROUTE_SOURCE = "armada-route";
const ROUTE_LAYER = "armada-route-line";

/** Below this separation (m) the two points are ~coincident; center instead of fit. */
const CLOSE_ENOUGH_M = 30;

/**
 * Fullscreen interactive map centered on a shared location, rendered over a
 * portal (like {@link Lightbox}). Uses MapLibre GL with Dreamith's OpenFreeMap
 * street tiles, falling back to a dark background if the style can't load
 * (offline). Escape or the X button exits.
 *
 * Once a live GPS fix lands, a pulsing "you" beacon and a dashed line to the
 * target appear, and the camera fits both points *once* (unless you've already
 * panned/zoomed — a user gesture always wins, and the camera never re-fits
 * after). With no fix it simply stays centered on the target.
 *
 * A look toggle (top-right, under the close button) cycles three styles:
 * sparkle (matches the app's live theme — including Nostr theme events), sun
 * (light OSM streets), and moon (dark streets). The choice is remembered.
 */
export function LocationMapDialog({ point, onClose, onNavigate }: LocationMapDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const youMarkerRef = useRef<maplibregl.Marker | null>(null);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  // Set true on a user gesture (pan/zoom/rotate). Once set, the auto-fit never
  // runs — the user's camera choice is final.
  const userInteractedRef = useRef(false);
  // Ensures the fit-to-both runs at most once.
  const hasFitRef = useRef(false);
  const mapTheme = useMapTheme();
  const { theme } = mapTheme;

  const { position } = useGeoWatch(true);
  const posRef = useRef<GeoPoint | null>(null);
  posRef.current = position;

  useEscape(onClose);

  // A real user gesture (pan/zoom/rotate) carries an `originalEvent`;
  // programmatic camera moves (fitBounds/easeTo) don't. Only the former should
  // cancel the auto-fit, so the initial fit doesn't disable itself.
  const mapRef = useOfflineMap({
    containerRef,
    center: [point.lon, point.lat],
    zoom: 15,
    theme,
    followAppTheme: true,
    onCreate: (map) => {
      const onUserMove = (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) userInteractedRef.current = true;
      };
      map.on("dragstart", onUserMove);
      map.on("zoomstart", onUserMove);
      map.on("rotatestart", onUserMove);
    },
  });

  // The dashed you→target line. A `setStyle` (theme swap) wipes custom
  // sources/layers, so (re)install it whenever the style (re)loads, and refresh
  // its geometry/color when the position or theme changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const routeGeoJSON = (): GeoJSON.Feature<GeoJSON.LineString> | null => {
      const you = posRef.current;
      if (!you) return null;
      return {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[you.lon, you.lat], [point.lon, point.lat]] },
      };
    };

    const install = () => {
      const feature = routeGeoJSON();
      const accent = mapAccentColor(theme);
      const existing = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(feature ?? { type: "FeatureCollection", features: [] });
        if (map.getLayer(ROUTE_LAYER)) map.setPaintProperty(ROUTE_LAYER, "line-color", accent);
        return;
      }
      if (!feature) return; // no fix yet — nothing to draw until one arrives
      map.addSource(ROUTE_SOURCE, { type: "geojson", data: feature });
      map.addLayer({
        id: ROUTE_LAYER,
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": accent,
          "line-width": 3,
          "line-dasharray": [1.5, 1.5],
          "line-opacity": 0.9,
        },
      });
    };

    // Re-install after every style (re)load (setStyle drops custom layers).
    map.on("styledata", install);
    if (map.isStyleLoaded()) install();

    return () => {
      map.off("styledata", install);
    };
  }, [mapRef, point.lat, point.lon, position, theme]);

  // The target (destination) pin. Recreated when the look changes so its color
  // tracks the map accent (MapLibre's default Marker color is fixed at build).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    targetMarkerRef.current?.remove();
    targetMarkerRef.current = new maplibregl.Marker({ color: mapAccentColor(theme) })
      .setLngLat([point.lon, point.lat])
      .addTo(map);
  }, [mapRef, point.lat, point.lon, theme]);

  // The pulsing "you" beacon marker (a DOM Marker, so it survives setStyle).
  // Created on first fix, then just repositioned as the position updates. Its
  // color tracks the current map look via the --beacon-color custom property.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    const accent = mapAccentColor(theme);
    if (!youMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "map-beacon";
      el.style.setProperty("--beacon-color", accent);
      youMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([position.lon, position.lat])
        .addTo(map);
    } else {
      youMarkerRef.current.setLngLat([position.lon, position.lat]);
      youMarkerRef.current.getElement().style.setProperty("--beacon-color", accent);
    }
  }, [mapRef, position, theme]);

  // Fit both points into view exactly once, on the first fix — unless the user
  // has already grabbed the camera. Never re-fits after (the beacon/line keep
  // updating, but the camera stays put).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position || hasFitRef.current || userInteractedRef.current) return;
    hasFitRef.current = true;

    const target: GeoPoint = { lat: point.lat, lon: point.lon };
    if (haversine(position, target) < CLOSE_ENOUGH_M) {
      map.easeTo({
        center: [(position.lon + target.lon) / 2, (position.lat + target.lat) / 2],
        zoom: 17,
        duration: 600,
      });
      return;
    }
    const bounds = new maplibregl.LngLatBounds()
      .extend([position.lon, position.lat])
      .extend([target.lon, target.lat]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 600 });
  }, [mapRef, position, point.lat, point.lon]);

  // Recenter on the user's current position (if we have a fix).
  const locate = () => {
    const map = mapRef.current;
    const you = posRef.current;
    if (!map || !you) return;
    map.easeTo({ center: [you.lon, you.lat], zoom: Math.max(map.getZoom(), 16), duration: 500 });
  };

  const accent = mapAccentColor(theme);
  const accentFg = mapAccentForeground(theme);

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

      {/* Locate — recenter on the user's current position. Only when we have a
          fix. */}
      {position && (
        <MapControlButton
          icon={Locate}
          label="Center on my location"
          title="Center on my location"
          onClick={locate}
          className="absolute top-safe-28 right-4"
        />
      )}

      {/* Navigate — pill in the map's accent, bottom center, opens the compass. */}
      {onNavigate && (
        <button
          type="button"
          onClick={onNavigate}
          style={{ backgroundColor: accent, color: accentFg }}
          className="absolute bottom-safe-4 left-1/2 -translate-x-1/2 pointer-events-auto inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold shadow-lg hover:opacity-90 transition-opacity"
        >
          <Navigation className="size-4" />
          Navigate
        </button>
      )}
    </div>,
    document.body,
  );
}
