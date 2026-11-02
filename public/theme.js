/*
 * Anti-flash theme bootstrap. Runs before the React bundle so the very first
 * paint matches the persisted theme. Mirrors src/themes.ts (builtinThemes,
 * presets) and src/lib/colorUtils.ts (deriveTokensFromCore). Keep in sync.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "armada:app-config";

  var builtins = {
    // Light "Corsair": violet parchment + violet ink + rose-magenta blade.
    light: { background: "260 30% 97%", text: "260 30% 14%", primary: "330 80% 52%" },
    // Armada "Corsair": cold violet-black sea, gilt-cream text, rose-magenta blade.
    dark: { background: "260 22% 9%", text: "42 38% 90%", primary: "330 90% 62%" },
  };

  function parseHsl(hsl) {
    var p = String(hsl).trim().replace(/%/g, "").split(/\s+/).map(Number);
    return { h: p[0], s: p[1], l: p[2] };
  }
  function fmt(h, s, l) {
    return (Math.round(h * 10) / 10) + " " + (Math.round(s * 10) / 10) + "% " + (Math.round(l * 10) / 10) + "%";
  }
  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  function lum(r, g, b) {
    var s = [r, g, b].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  }
  function isDark(bg) {
    var c = parseHsl(bg);
    var rgb = hslToRgb(c.h, c.s, c.l);
    return lum(rgb[0], rgb[1], rgb[2]) < 0.2;
  }
  function lighten(hsl, a) { var c = parseHsl(hsl); return fmt(c.h, c.s, Math.min(100, c.l + a)); }
  function darken(hsl, a) { var c = parseHsl(hsl); return fmt(c.h, c.s, Math.max(0, c.l - a)); }
  function contrastFg(bg) { return isDark(bg) ? "0 0% 100%" : "222.2 84% 4.9%"; }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s: s * 100, l: l * 100 };
  }
  // Composite a translucent overlay color over an opaque base (matches the
  // old chrome overlays: black/30, black/40, white/10).
  function overlay(base, ov, a) {
    var b = parseHsl(base), o = parseHsl(ov);
    var br = hslToRgb(b.h, b.s, b.l), or = hslToRgb(o.h, o.s, o.l);
    var r = Math.round(br[0] * (1 - a) + or[0] * a);
    var g = Math.round(br[1] * (1 - a) + or[1] * a);
    var bl = Math.round(br[2] * (1 - a) + or[2] * a);
    var c = rgbToHsl(r, g, bl);
    return fmt(c.h, c.s, c.l);
  }

  function derive(bg, text, primary) {
    var dark = isDark(bg);
    var p = parseHsl(primary);
    var fg = parseHsl(text);
    var card = dark ? lighten(bg, 2) : bg;
    var sec = dark ? lighten(bg, 8) : darken(bg, 4);
    var border = dark ? fmt(p.h, p.s * 0.4, 30) : fmt(p.h, p.s * 0.5, 82);
    var mutedFg = dark
      ? fmt(fg.h, Math.max(fg.s * 0.7, 12), Math.max(fg.l - 30, 40))
      : fmt(fg.h, Math.max(fg.s * 0.7, 18), Math.min(fg.l + 35, 55));
    var pFg = contrastFg(primary);
    var b = parseHsl(bg);
    var chrome, chromeDeep, chromeDivider;
    if (dark) {
      chrome = overlay(bg, "0 0% 0%", 0.3);
      chromeDeep = overlay(bg, "0 0% 0%", 0.4);
      chromeDivider = overlay(bg, "0 0% 100%", 0.1);
    } else {
      var s = Math.min(b.s + 8, 100);
      chrome = fmt(b.h, s, Math.max(b.l - 6, 0));
      chromeDeep = fmt(b.h, s, Math.max(b.l - 9, 0));
      chromeDivider = fmt(b.h, s, Math.max(b.l - 13, 0));
    }
    return {
      "--background": bg,
      "--foreground": text,
      "--card": card,
      "--card-foreground": text,
      "--popover": card,
      "--popover-foreground": text,
      "--primary": primary,
      "--primary-foreground": pFg,
      "--secondary": sec,
      "--secondary-foreground": text,
      "--muted": sec,
      "--muted-foreground": mutedFg,
      "--accent": sec,
      "--accent-foreground": text,
      "--accent2": dark ? "180 90% 55%" : "190 85% 40%",
      "--destructive": dark ? "0 72% 51%" : "0 84.2% 60.2%",
      "--destructive-foreground": dark ? "0 0% 95%" : "210 40% 98%",
      "--success": dark ? "142 60% 35%" : "142 72% 29%",
      "--success-foreground": "138 60% 94%",
      "--warning": dark ? "43 96% 56%" : "32 95% 36%",
      "--warning-foreground": dark ? "26 83% 14%" : "48 100% 96%",
      "--border": border,
      "--input": border,
      "--ring": primary,
      "--chrome": chrome,
      "--chrome-deep": chromeDeep,
      "--chrome-divider": chromeDivider,
    };
  }

  function read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  var config = read() || {};
  var theme = config.theme || "dark";

  var resolved = theme;
  if (theme === "system") {
    resolved = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }

  var colors;
  if (resolved === "custom") {
    colors = (config.customTheme && config.customTheme.colors) || builtins.dark;
  } else if (config.themes && config.themes[resolved] && config.themes[resolved].colors) {
    colors = config.themes[resolved].colors;
  } else {
    colors = builtins[resolved] || builtins.dark;
  }

  var tokens = derive(colors.background, colors.text, colors.primary);
  var css = ":root {";
  for (var key in tokens) {
    if (Object.prototype.hasOwnProperty.call(tokens, key)) {
      css += key + ":" + tokens[key] + ";";
    }
  }
  css += "--radius:0.75rem;--top-bar-height:3rem;--bottom-nav-height:3.25rem;}";

  var el = document.getElementById("theme-vars");
  if (!el) {
    el = document.createElement("style");
    el.id = "theme-vars";
    document.head.appendChild(el);
  }
  el.textContent = css;

  var root = document.documentElement;
  var dark = resolved === "dark" || (resolved === "custom" && isDark(colors.background));
  root.classList.toggle("dark", dark);
  root.classList.toggle("custom", resolved === "custom");

  // Body background for the pre-React paint.
  var rgb = hslToRgb(parseHsl(colors.background).h, parseHsl(colors.background).s, parseHsl(colors.background).l);
  document.documentElement.style.backgroundColor = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")");

  // Text size; see src/lib/fontScale.ts, the key's only writer.
  try {
    var scale = Number(localStorage.getItem("armada:font-scale"));
    if (scale) root.style.setProperty("--font-scale", String(scale / 100));
  } catch (e) { /* storage blocked */ }

  // Reduce motion; see src/lib/reducedMotion.ts, the key's only writer.
  try {
    var reduce = localStorage.getItem("armada:reduce-motion") === "1";
    if (!reduce && window.matchMedia) reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) root.setAttribute("data-reduce-motion", "");
  } catch (e) { /* storage blocked */ }
})();
