import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";

import { AppConfigSchema } from "@/lib/schemas";
import { AppContext, defaultConfig, type AppConfig } from "@/contexts/AppContext";
import {
  accountScopedKey,
  adoptLegacyConfig,
  getActivePubkey,
  subscribeActivePubkey,
} from "@/lib/activeAccount";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { appThemeFont } from "@/lib/fontLoader";
import { parseProxyList } from "@/lib/mediaPolicy";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { setPowDifficulty } from "@/lib/pow";
import { useThemePreview } from "@/lib/themePreview";
import { hslStringToHex, isDarkTheme } from "@/lib/colorUtils";
import { applyPaneWidth } from "@/lib/paneWidth";
import { isIosApp } from "@/lib/platform";
import { syncNativeStatusBar } from "@/lib/statusBar";
import {
  buildThemeCssFromCore,
  builtinThemes,
  resolveTheme,
  resolveThemeColors,
  type CoreThemeColors,
  type ThemeFont,
} from "@/themes";

/** Validate each key individually so one corrupt field doesn't reset everything. */
function deserializeConfig(raw: string): AppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConfig;
  }
  if (!parsed || typeof parsed !== "object") return defaultConfig;

  const source = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = { ...defaultConfig };

  for (const key of Object.keys(AppConfigSchema.shape) as Array<keyof typeof AppConfigSchema.shape>) {
    if (!(key in source)) continue;
    const fieldSchema = AppConfigSchema.shape[key];
    const outcome = fieldSchema.safeParse(source[key]);
    if (outcome.success && outcome.data !== undefined) {
      result[key] = outcome.data;
    }
  }

  return result as unknown as AppConfig;
}

function activeColors(config: AppConfig): CoreThemeColors {
  const resolved = resolveTheme(config.theme);
  if (resolved === "custom") {
    return config.customTheme?.colors ?? builtinThemes.dark;
  }
  return resolveThemeColors(resolved);
}

/**
 * Inject theme CSS variables and the `<html>` class before paint; re-runs on OS
 * scheme changes when theme is "system".
 */
function useApplyTheme(config: AppConfig) {
  useLayoutEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(config.theme);
      const colors = activeColors(config);
      const css = buildThemeCssFromCore(colors);

      let el = document.getElementById("theme-vars") as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement("style");
        el.id = "theme-vars";
        document.head.appendChild(el);
      }
      el.textContent = css;

      // "custom" themes pick the dark variant from background luminance.
      const root = document.documentElement;
      const isDark = resolved === "dark"
        || (resolved === "custom" && isDarkTheme(colors.background));
      root.classList.toggle("dark", isDark);
      root.classList.toggle("custom", resolved === "custom");

      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", hslStringToHex(colors.background));

      // No-op on web.
      syncNativeStatusBar(colors.background);
    };

    apply();

    if (config.theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [config]);
}

interface AppProviderProps {
  storageKey: string;
  children: React.ReactNode;
}

export function AppProvider({ storageKey, children }: AppProviderProps) {
  // The config blob is PER ACCOUNT (it holds DM peer lists), and the key must be
  // picked on first render above `NostrLoginProvider`, so read the synchronous
  // marker (see `lib/activeAccount.ts`).
  const pubkey = useSyncExternalStore(subscribeActivePubkey, getActivePubkey);

  // Must run before the scoped key is read: hands the pre-scoping blob to the
  // first active account only.
  const scopedKey = useMemo(() => {
    if (pubkey) adoptLegacyConfig(storageKey, pubkey);
    return accountScopedKey(storageKey, pubkey);
  }, [storageKey, pubkey]);

  const [config, setConfig] = useLocalStorage<AppConfig>(scopedKey, defaultConfig, {
    serialize: JSON.stringify,
    deserialize: deserializeConfig,
  });

  // A theme preview paints over the user's own theme without touching the stored config.
  const preview = useThemePreview();
  const paintedConfig = useMemo<AppConfig>(
    () => (preview ? { ...config, theme: "custom", customTheme: preview.config } : config),
    [config, preview],
  );
  useApplyTheme(paintedConfig);

  // A layout effect runs ahead of every passive one, where publishes start.
  useLayoutEffect(() => {
    setPowDifficulty(config.powDifficulty);
  }, [config.powDifficulty]);

  // public/theme.js handles the very first paint.
  useEffect(() => {
    document.documentElement.dataset.themeReady = "true";
  }, []);

  // Memoized: dozens of files (and NostrProvider) read this context.
  // `setConfig` is reference-stable.
  // Read-side only, so the stored choice survives for other platforms' builds.
  const value = useMemo(
    () => ({ config: isIosApp() && config.zapsEnabled ? { ...config, zapsEnabled: false } : config, updateConfig: setConfig }),
    [config, setConfig],
  );

  return (
    <AppContext.Provider value={value}>
      <ThemeBackgroundSync config={paintedConfig} />
      <ThemeFontSync config={paintedConfig} />
      <PaneWidthSync config={config} />
      {children}
    </AppContext.Provider>
  );
}

/** CSS `url()` value for a resolved src; quotes, backslashes and newlines can't break out of the string. */
function cssUrl(src: string): string {
  return `url("${src.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;
}

/**
 * Publish the active theme's background to CSS (`html.theme-bg` + `--theme-bg-*`,
 * consumed in index.css). Inside the provider so the image loads under the media policy.
 */
function ThemeBackgroundSync({ config }: { config: AppConfig }) {
  const background = resolveTheme(config.theme) === "custom" ? config.customTheme?.background : undefined;
  const src = useMediaSrc(background?.url);
  const tile = background?.mode === "tile";

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!src) {
      root.classList.remove("theme-bg");
      return;
    }
    root.style.setProperty("--theme-bg-image", cssUrl(src));
    root.style.setProperty("--theme-bg-size", tile ? "auto" : "cover");
    root.style.setProperty("--theme-bg-repeat", tile ? "repeat" : "no-repeat");
    root.classList.add("theme-bg");
    return () => {
      root.classList.remove("theme-bg");
    };
  }, [src, tile]);

  return null;
}

/** Publish the dragged desktop pane widths (see PaneResizeHandle) as CSS variables. */
function PaneWidthSync({ config }: { config: AppConfig }) {
  useLayoutEffect(() => applyPaneWidth("channel", config.channelListWidth), [config.channelListWidth]);
  useLayoutEffect(() => applyPaneWidth("member", config.memberListWidth), [config.memberListWidth]);
  return null;
}

/**
 * Publish the active theme's body font as `--theme-font` (read by Tailwind's
 * `font-sans`) and its name font as `--theme-name-font` (read by `font-name`).
 */
function ThemeFontSync({ config }: { config: AppConfig }) {
  const custom = resolveTheme(config.theme) === "custom" ? config.customTheme : undefined;
  // An adopted theme's uploaded font is someone else's URL; see appThemeFont.
  const own = !custom?.source;
  // The provider's own config, since this renders where useMediaPolicy can't read it yet.
  const proxy = parseProxyList((config.mediaProxies ?? []).join("\n"))[0] ?? "";

  useThemeFontProperty("--theme-font", custom?.font, own, proxy);
  useThemeFontProperty("--theme-name-font", custom?.titleFont, own, proxy);

  return null;
}

function useThemeFontProperty(property: string, font: ThemeFont | undefined, ownFont: boolean, proxy: string) {
  const family = font?.family;
  const url = font?.url;
  useLayoutEffect(() => {
    const value = appThemeFont(family ? { family, url } : undefined, { ownFont, policy: { proxy } });
    if (!value) return;
    const root = document.documentElement;
    root.style.setProperty(property, value);
    return () => {
      root.style.removeProperty(property);
    };
  }, [property, family, url, ownFont, proxy]);
}
