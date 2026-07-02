import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Moon, Navigation, Sparkles, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useGeoWatch } from "@/hooks/useGeoWatch";
import { haversine } from "@/lib/location";
import { fallbackMapStyle, loadMapStyle, type MapTheme } from "@/lib/map/dreamithStyle";

import type { GeoPoint } from "@/lib/location";

interface LocationMapDialogProps {
  point: GeoPoint;
  onClose: () => void;
  /** Switch to the fullscreen compass navigating to this point. */
  onNavigate?: () => void;
}

const THEME_STORAGE_KEY = "armada:map-theme";
const THEME_ORDER: MapTheme[] = ["sparkle", "sun", "moon"];

/** Id of the you→target route source/layer (re-added after each setStyle). */
const ROUTE_SOURCE = "armada-route";
const ROUTE_LAYER = "armada-route-line";

/** Below this separation (m) the two points are ~coincident; center instead of fit. */
const CLOSE_ENOUGH_M = 30;

const THEME_META: Record<MapTheme, { icon: typeof Sun; label: string }> = {
  sparkle: { icon: Sparkles, label: "Match app theme" },
  sun: { icon: Sun, label: "Light streets" },
  moon: { icon: Moon, label: "Dark streets" },
};

function readMapTheme(): MapTheme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "sun" || v === "moon" || v === "sparkle") return v;
  } catch {
    // ignore
  }
  return "sparkle";
}

/** Read the app's --primary as a concrete hsl() string for the map layer. */
function primaryColor(): string {
  if (typeof document === "undefined") return "#3b82f6";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return v ? `hsl(${v})` : "#3b82f6";
}

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
  const mapRef = useRef<maplibregl.Map | null>(null);
  const youMarkerRef = useRef<maplibregl.Marker | null>(null);
  // Set true on a user gesture (pan/zoom/rotate). Once set, the auto-fit never
  // runs — the user's camera choice is final.
  const userInteractedRef = useRef(false);
  // Ensures the fit-to-both runs at most once.
  const hasFitRef = useRef(false);
  const [theme, setTheme] = useState<MapTheme>(readMapTheme);

  const { position } = useGeoWatch(true);
  const posRef = useRef<GeoPoint | null>(null);
  posRef.current = position;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Create the map once.
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
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

    new maplibregl.Marker({ color: "#3b82f6" }).setLngLat([point.lon, point.lat]).addTo(map);

    // A real user gesture (pan/zoom/rotate) carries an `originalEvent`;
    // programmatic camera moves (fitBounds/easeTo) don't. Only the former
    // should cancel the auto-fit, so the initial fit doesn't disable itself.
    const onUserMove = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) userInteractedRef.current = true;
    };
    map.on("dragstart", onUserMove);
    map.on("zoomstart", onUserMove);
    map.on("rotatestart", onUserMove);

    // The container is inside a freshly-portaled overlay, so its box may not be
    // laid out yet when the map is constructed — MapLibre then measures a 0×0
    // canvas and renders nothing (a black screen). Resize once the layout
    // settles and whenever the container's box changes.
    const resize = () => map.resize();
    map.once("load", resize);
    requestAnimationFrame(resize);
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      youMarkerRef.current = null;
    };
  }, [point.lat, point.lon]);

  // Apply the selected look (and re-apply if the app theme changes while in
  // "sparkle"). Runs on mount and whenever `theme` changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let cancelled = false;
    const controller = new AbortController();
    const apply = () => {
      void loadMapStyle(theme, controller.signal)
        .then((style) => {
          if (!cancelled) map.setStyle(style);
        })
        .catch(() => {
          // Offline / fetch failed: keep the current (or fallback) style.
        });
    };
    apply();

    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }

    // In sparkle mode, follow live app-theme changes: the theme system rewrites
    // the injected <style id="theme-vars"> (and toggles the root class), so
    // re-derive the palette when :root's attributes/children mutate.
    let observer: MutationObserver | undefined;
    if (theme === "sparkle" && typeof document !== "undefined") {
      observer = new MutationObserver(() => apply());
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      const styleTag = document.getElementById("theme-vars");
      if (styleTag) observer.observe(styleTag, { childList: true, characterData: true, subtree: true });
    }

    return () => {
      cancelled = true;
      controller.abort();
      observer?.disconnect();
    };
  }, [theme]);

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
      const existing = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(feature ?? { type: "FeatureCollection", features: [] });
        if (map.getLayer(ROUTE_LAYER)) map.setPaintProperty(ROUTE_LAYER, "line-color", primaryColor());
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
          "line-color": primaryColor(),
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
  }, [point.lat, point.lon, position, theme]);

  // The pulsing "you" beacon marker (a DOM Marker, so it survives setStyle).
  // Created on first fix, then just repositioned as the position updates.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    if (!youMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "map-beacon";
      youMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([position.lon, position.lat])
        .addTo(map);
    } else {
      youMarkerRef.current.setLngLat([position.lon, position.lat]);
    }
  }, [position]);

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
  }, [position, point.lat, point.lon]);

  const cycleTheme = () => {
    setTheme((t) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length]);
  };

  const ThemeIcon = THEME_META[theme].icon;

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

      {/* Look toggle — under the close button. Cycles sparkle → sun → moon. */}
      <button
        type="button"
        aria-label={`Map look: ${THEME_META[theme].label} (tap to change)`}
        title={THEME_META[theme].label}
        className="absolute top-safe-16 right-4 pointer-events-auto p-2 rounded-full bg-black/60 backdrop-blur text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        onClick={cycleTheme}
      >
        <ThemeIcon className="size-5" />
      </button>

      {/* Navigate — themed pill, bottom center, opens the compass. */}
      {onNavigate && (
        <button
          type="button"
          onClick={onNavigate}
          className="absolute bottom-safe-4 left-1/2 -translate-x-1/2 pointer-events-auto inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
        >
          <Navigation className="size-4" />
          Navigate
        </button>
      )}
    </div>,
    document.body,
  );
}
