import maplibregl from "maplibre-gl";
import { useEffect, useRef, type RefObject } from "react";

import { fallbackMapStyle, type MapTheme } from "@/lib/map/dreamithStyle";
import { ensureOfflineProtocol, loadOfflineAwareStyle } from "@/lib/map/tileProtocol";

export interface UseOfflineMapOptions {
  /** The container element the map renders into. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Initial camera center, `[lon, lat]`. */
  center: [number, number];
  /** Initial zoom. */
  zoom: number;
  /** The current map look; the style re-applies whenever this changes. */
  theme: MapTheme;
  /**
   * When true, in "sparkle" mode the map follows *live* app-theme changes (the
   * theme system rewrites `<style id="theme-vars">` and toggles the root class),
   * re-deriving the palette on each mutation. The viewer wants this; the
   * downloader can opt out.
   */
  followAppTheme?: boolean;
  /**
   * Called once, synchronously, right after the map is constructed (before its
   * first `load`) so callers can attach their own listeners (e.g. bbox sync).
   */
  onCreate?: (map: maplibregl.Map) => void;
}

/**
 * Shared MapLibre plumbing for Armada's fullscreen map surfaces (the shared-
 * location viewer and the offline-region downloader). Owns the parts that were
 * copy-pasted between them:
 *
 *  - construction with the shared options (offline fallback style, no
 *    attribution control, no drag-rotate);
 *  - the resize dance — the container lives inside a freshly-portaled overlay
 *    whose box may not be laid out when the map is built, so MapLibre would
 *    otherwise measure a 0×0 canvas and render nothing; we resize on load, on
 *    the next frame, and whenever the container's box changes;
 *  - routing provider resources through the offline protocol and (re)applying
 *    the offline-aware style whenever the look changes;
 *  - optionally following live app-theme changes in "sparkle" mode.
 *
 * Returns a ref to the map (null until constructed / after teardown).
 */
export function useOfflineMap({
  containerRef,
  center,
  zoom,
  theme,
  followAppTheme = false,
  onCreate,
}: UseOfflineMapOptions): RefObject<maplibregl.Map | null> {
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Keep the latest onCreate without forcing a map rebuild when it changes.
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;

  // Create the map once. Center/zoom are read at construction only (changing
  // them later moves the camera imperatively, not by rebuilding the map).
  const [lon, lat] = center;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureOfflineProtocol();

    const map = new maplibregl.Map({
      container,
      style: fallbackMapStyle(),
      center: [lon, lat],
      zoom,
      attributionControl: false,
      dragRotate: false,
    });
    mapRef.current = map;
    onCreateRef.current?.(map);

    const resize = () => map.resize();
    map.once("load", resize);
    requestAnimationFrame(resize);
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; camera/theme are handled elsewhere
  }, [containerRef]);

  // Apply the selected look on mount and whenever it changes; in sparkle mode
  // (with followAppTheme) also re-apply when the live app theme mutates.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let cancelled = false;
    const controller = new AbortController();
    ensureOfflineProtocol();
    const apply = () => {
      void loadOfflineAwareStyle(theme, controller.signal)
        .then((style) => {
          if (!cancelled) map.setStyle(style);
        })
        .catch(() => {
          // Offline with no cached style: keep the current (or fallback) style.
        });
    };
    apply();

    let observer: MutationObserver | undefined;
    if (followAppTheme && theme === "sparkle" && typeof document !== "undefined") {
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
  }, [theme, followAppTheme]);

  return mapRef;
}
