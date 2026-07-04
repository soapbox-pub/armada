import { describe, expect, it } from "vitest";

import {
  fromOfflineUrl,
  rewriteTileJsonForOffline,
  tileUrl,
  tileVersionFromTemplate,
  toOfflineUrl,
  urlToCacheKey,
} from "@/lib/map/providerUrls";

const BASE = "https://maps.dreamith.to";
const VERSION = "20260614_080001_pt";

describe("offline url wrapping", () => {
  it("round-trips an arbitrary https url", () => {
    const orig = `${BASE}/planet/${VERSION}/14/2620/6333.pbf`;
    expect(fromOfflineUrl(toOfflineUrl(orig))).toBe(orig);
  });

  it("keeps MapLibre template tokens literal (never percent-encoded)", () => {
    // MapLibre validates + substitutes {fontstack}/{range}/{z}/{x}/{y} by
    // literal string match; encoding the braces breaks glyphs and tiles.
    const glyphs = `${BASE}/fonts/{fontstack}/{range}.pbf`;
    expect(toOfflineUrl(glyphs)).toBe(`armada-offline://${glyphs}`);
    expect(fromOfflineUrl(toOfflineUrl(glyphs))).toBe(glyphs);
    const tiles = `${BASE}/planet/${VERSION}/{z}/{x}/{y}.pbf`;
    expect(toOfflineUrl(tiles)).toContain("{z}/{x}/{y}");
  });
});

describe("rewriteTileJsonForOffline", () => {
  it("rewrites tiles templates to the offline protocol", () => {
    const tj = { tilejson: "3.0.0", tiles: [`${BASE}/planet/${VERSION}/{z}/{x}/{y}.pbf`] };
    const out = rewriteTileJsonForOffline(tj);
    expect(out.tiles).toEqual([`armada-offline://${BASE}/planet/${VERSION}/{z}/{x}/{y}.pbf`]);
    expect(out.tilejson).toBe("3.0.0");
    // Original untouched.
    expect(tj.tiles[0]).toContain("https://");
  });

  it("passes through documents without a tiles array", () => {
    const tj = { tilejson: "3.0.0" };
    expect(rewriteTileJsonForOffline(tj)).toEqual(tj);
  });
});

describe("urlToCacheKey", () => {
  it("classifies a vector tile", () => {
    const r = urlToCacheKey(`${BASE}/planet/${VERSION}/14/2620/6333.pbf`);
    expect(r).toEqual({ key: "t/14/2620/6333", kind: "tile" });
  });

  it("classifies a hillshade raster", () => {
    const r = urlToCacheKey(`${BASE}/natural_earth/ne2sr/5/10/12.png`);
    expect(r).toEqual({ key: "a/raster/5/10/12", kind: "raster" });
  });

  it("classifies a glyph range with a spaced fontstack", () => {
    const r = urlToCacheKey(`${BASE}/fonts/${encodeURIComponent("Noto Sans Regular")}/0-255.pbf`);
    expect(r).toEqual({ key: "a/glyph/Noto Sans Regular/0-255", kind: "glyph" });
    // MapLibre substitutes the raw (unencoded) fontstack into the template;
    // both spellings must map to the same cache key.
    const raw = urlToCacheKey(`${BASE}/fonts/Noto Sans Regular/0-255.pbf`);
    expect(raw).toEqual(r);
  });

  it("classifies sprite files", () => {
    expect(urlToCacheKey(`${BASE}/sprites/ofm_f384/ofm.json`)).toEqual({
      key: "a/sprite/ofm.json",
      kind: "sprite",
    });
    expect(urlToCacheKey(`${BASE}/sprites/ofm_f384/ofm@2x.png`)).toEqual({
      key: "a/sprite/ofm@2x.png",
      kind: "sprite",
    });
  });

  it("classifies the style and tilejson docs", () => {
    expect(urlToCacheKey(`${BASE}/styles/liberty`)?.kind).toBe("style");
    expect(urlToCacheKey(`${BASE}/planet`)).toEqual({ key: "a/tilejson//planet", kind: "tilejson" });
  });

  it("returns null for unrecognized urls", () => {
    expect(urlToCacheKey("https://example.com/whatever")).toBeNull();
    expect(urlToCacheKey("not a url")).toBeNull();
  });
});

describe("tile version + url", () => {
  it("extracts the build version from a tilejson template", () => {
    const tpl = `${BASE}/planet/${VERSION}/{z}/{x}/{y}.pbf`;
    expect(tileVersionFromTemplate(tpl)).toBe(VERSION);
  });

  it("returns null for a non-matching template", () => {
    expect(tileVersionFromTemplate("https://x/y/{z}/{x}/{y}.pbf")).toBeNull();
  });

  it("builds a tile url for a version", () => {
    expect(tileUrl(BASE, VERSION, { z: 14, x: 1, y: 2 })).toBe(
      `${BASE}/planet/${VERSION}/14/1/2.pbf`,
    );
  });
});
