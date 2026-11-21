import { useCallback, useRef, useState } from "react";

/** Tiles are 16:9. */
const TILE_ASPECT = 16 / 9;

export type HeroSize = "xl" | "lg" | "md" | "sm" | "xs";

/**
 * Column count + tile size that fits `count` 16:9 tiles in the box with the
 * largest tiles (tiles shrink rather than scroll).
 */
export function fitGrid(
  count: number,
  width: number,
  height: number,
  gap: number,
): { cols: number; tileW: number; tileH: number } {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 1, tileW: 0, tileH: 0 };
  }
  let best = { cols: 1, tileW: 0, tileH: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    let tileW = cellW;
    let tileH = tileW / TILE_ASPECT;
    if (tileH > cellH) {
      tileH = cellH;
      tileW = tileH * TILE_ASPECT;
    }
    if (tileW > best.tileW) best = { cols, tileW, tileH };
  }
  return best;
}

/**
 * Element content-box size via ResizeObserver. A callback ref, since the grid
 * container remounts on focus/theater toggles.
 */
export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    if (!el) {
      observerRef.current = null;
      return;
    }
    // Seed synchronously; the ResizeObserver callback is async.
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  return [ref, size] as const;
}

/**
 * Avatars shrink as the room fills, so a group call stays one compact cluster.
 * A desktop chat pane is wide enough to keep a group large.
 */
export function heroSize(count: number, theater: boolean, wide: boolean): HeroSize {
  if (theater) return count <= 4 ? "xl" : count <= 9 ? "lg" : "md";
  if (wide) return count <= 6 ? "lg" : "md";
  return count <= 2 ? "md" : count <= 4 ? "sm" : "xs";
}
