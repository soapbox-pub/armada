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
    expect(appThemeFont(UPLOADED, { ownFont: true })).toBe('"My Font"');
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
    expect(loadThemeFont({ family: "Stranger", url }, proxy)).toContain("Stranger");
    expect(faces()).toContain(`https://proxy.example/?url=${encodeURIComponent(url)}`);
    expect(faces()).not.toContain(`url("${url}")`);
  });

  it("loads the user's own uploaded app font through the proxy too", () => {
    const url = "https://blossom.example/" + "c".repeat(64) + ".woff2";
    expect(appThemeFont({ family: "Own", url }, { ownFont: true, policy: proxy })).toBe('"Own"');
    expect(faces()).toContain(`https://proxy.example/?url=${encodeURIComponent(url)}`);
  });

  it("loads a font directly with proxying off", () => {
    const url = "https://blossom.example/" + "d".repeat(64) + ".woff2";
    loadThemeFont({ family: "Direct", url }, { proxy: "" });
    expect(faces()).toContain(`url("${url}")`);
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
