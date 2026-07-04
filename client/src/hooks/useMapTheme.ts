import { Moon, Sparkles, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  MAP_THEME_ORDER,
  MAP_THEME_STORAGE_KEY,
  readMapTheme,
  type MapTheme,
} from "@/lib/map/dreamithStyle";

/** Icon + human label for each map look, for the look-toggle button. */
export const MAP_THEME_META: Record<MapTheme, { icon: typeof Sun; label: string }> = {
  sparkle: { icon: Sparkles, label: "Match app theme" },
  sun: { icon: Sun, label: "Light streets" },
  moon: { icon: Moon, label: "Dark streets" },
};

export interface UseMapTheme {
  /** The current map look. */
  theme: MapTheme;
  /** Advance to the next look in the cycle (sparkle → sun → moon → …). */
  cycleTheme: () => void;
  /** The icon component for the current look. */
  Icon: typeof Sun;
  /** The human label for the current look. */
  label: string;
}

/**
 * The shared map-look state used by every map surface (viewer + downloader):
 * reads the remembered look on mount, persists changes, and exposes a cycler
 * plus the icon/label for the current look. Keeps the theme vocabulary in one
 * place so the persisted key and cycle order can't drift between dialogs.
 */
export function useMapTheme(): UseMapTheme {
  const [theme, setTheme] = useState<MapTheme>(readMapTheme);

  useEffect(() => {
    try {
      localStorage.setItem(MAP_THEME_STORAGE_KEY, theme);
    } catch {
      // ignore (private mode / no storage)
    }
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme((t) => MAP_THEME_ORDER[(MAP_THEME_ORDER.indexOf(t) + 1) % MAP_THEME_ORDER.length]);
  }, []);

  return { theme, cycleTheme, Icon: MAP_THEME_META[theme].icon, label: MAP_THEME_META[theme].label };
}
