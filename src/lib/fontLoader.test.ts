// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { appThemeFont, claimedThemeFont, loadThemeFont } from "./fontLoader";

const UPLOADED = { family: "My Font", url: "https://blossom.example/" + "a".repeat(64) + ".woff2" };

describe("appThemeFont", () => {
  it("loads a catalog family regardless of who made the theme", () => {
    expect(appThemeFont({ family: "Comfortaa" })).toBe('"Comfortaa"');
  });

  it("loads an uploaded font only from the user's own theme", () => {
    expect(appThemeFont(UPLOADED)).toBeUndefined();
    expect(appThemeFont(UPLOADED, { ownFont: true })).toMatch(/^"armada-uploaded-font-\d+"$/);
    expect(document.getElementById("theme-font-faces")?.textContent).toContain(UPLOADED.url);
  });

  it("refuses a non-http URL even from the user's own theme", () => {
    expect(appThemeFont({ family: "X", url: "javascript:alert(1)" }, { ownFont: true })).toBeUndefined();
  });
});

describe("theme fonts under the media proxy", () => {
  const proxy = { proxy: "https://proxy.example/?url={href}" };
  const faces = () => document.getElementById("theme-font-faces")?.textContent ?? "";

  it("loads a stranger's uploaded font through the proxy, never from its host", () => {
    const url = "https://fonts.stranger.example/" + "b".repeat(64) + ".woff2";
    expect(loadThemeFont({ family: "Stranger", url }, proxy)).toBeDefined();
    expect(faces()).toContain(`https://proxy.example/?url=${encodeURIComponent(url)}`);
    expect(faces()).not.toContain(`url("${url}")`);
  });

  it("loads the user's own uploaded app font through the proxy too", () => {
    const url = "https://blossom.example/" + "c".repeat(64) + ".woff2";
    expect(appThemeFont({ family: "Own", url }, { ownFont: true, policy: proxy })).toMatch(/^"armada-uploaded-font-\d+"$/);
    expect(faces()).toContain(`https://proxy.example/?url=${encodeURIComponent(url)}`);
  });

  it("loads a font directly with proxying off", () => {
    const url = "https://blossom.example/" + "d".repeat(64) + ".woff2";
    loadThemeFont({ family: "Direct", url }, { proxy: "" });
    expect(faces()).toContain(`url("${url}")`);
  });
});

// `@font-face` is document-wide: a file registered under a family the app
// already uses would be drawn everywhere that family is, not just in the theme.
describe("a theme font loaded by URL", () => {
  const faces = () => document.getElementById("theme-font-faces")?.textContent ?? "";
  const families = () => [...faces().matchAll(/font-family: "([^"]*)"/g)].map((m) => m[1]);

  it.each(["Inter Variable", "Inter", "Armada Twemoji", "Comfortaa", "comfortaa"])(
    "is not registered under the family it names (%s)",
    (family) => {
      const url = `https://fonts.stranger.example/${encodeURIComponent(family)}.woff2`;
      const value = loadThemeFont({ family, url }, { proxy: "" });
      const registered = faces().match(new RegExp(`font-family: "([^"]*)";\\s*src: url\\("${url.replace(/[.?]/g, "\\$&")}"\\)`))?.[1];
      expect(registered).toBeTruthy();
      expect(registered?.toLowerCase()).not.toBe(family.toLowerCase());
      // The value it is applied with names the family the file was registered under.
      expect(value).toContain(`"${registered}"`);
    },
  );

  it("registers two files a theme gives one name under two families", () => {
    const a = loadThemeFont({ family: "Shared", url: "https://fonts.stranger.example/one.woff2" }, { proxy: "" });
    const b = loadThemeFont({ family: "Shared", url: "https://fonts.stranger.example/two.woff2" }, { proxy: "" });
    expect(a).not.toBe(b);
  });

  it("still registers a catalog family under the catalog's name", () => {
    expect(loadThemeFont({ family: "Comfortaa" })).toContain('"Comfortaa"');
    expect(families()).toContain("Comfortaa");
  });
});

describe("claimedThemeFont", () => {
  const credited = { source: { pubkey: "c".repeat(64) }, font: UPLOADED };

  it("leaves out the credited creator's uploaded font", () => {
    expect(claimedThemeFont(UPLOADED, credited)).toBeUndefined();
  });

  it("keeps a catalog family, a font uploaded in the edit, and an uncredited theme's own", () => {
    const mine = { family: "Mine", url: "https://blossom.example/" + "b".repeat(64) + ".woff2" };
    expect(claimedThemeFont({ family: "Comfortaa" }, credited)).toEqual({ family: "Comfortaa" });
    expect(claimedThemeFont(mine, credited)).toBe(mine);
    expect(claimedThemeFont(UPLOADED, { font: UPLOADED })).toBe(UPLOADED);
  });
});
