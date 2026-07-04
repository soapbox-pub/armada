import { describe, expect, it } from "vitest";

import {
  countTilesForBBox,
  estimateBytesForBBox,
  formatBytes,
  latToTileY,
  lonToTileX,
  MAX_TILE_ZOOM,
  normalizeBBox,
  tilesForBBox,
  type BBox,
} from "@/lib/map/tileMath";

/** San Francisco-ish small box. */
const SF: BBox = { west: -122.52, south: 37.7, east: -122.35, north: 37.82 };

describe("tile projection", () => {
  it("maps lon/lat to the known tile at zoom 0 (whole world is one tile)", () => {
    expect(Math.floor(lonToTileX(-180, 0))).toBe(0);
    expect(Math.floor(lonToTileX(179.9, 0))).toBe(0);
    expect(Math.floor(latToTileY(85, 0))).toBe(0);
    expect(Math.floor(latToTileY(-85, 0))).toBe(0);
  });

  it("places (0,0) lon/lat at the grid centre", () => {
    const z = 2;
    expect(lonToTileX(0, z)).toBeCloseTo(2, 6); // 2^2 / 2
    expect(latToTileY(0, z)).toBeCloseTo(2, 6);
  });

  it("clamps beyond the Mercator latitude limit instead of diverging", () => {
    expect(Number.isFinite(latToTileY(89.9, 10))).toBe(true);
    expect(Number.isFinite(latToTileY(-89.9, 10))).toBe(true);
  });
});

describe("bbox normalization", () => {
  it("swaps flipped west/east and south/north", () => {
    const n = normalizeBBox({ west: 10, south: 20, east: -10, north: -20 });
    expect(n).toEqual({ west: -10, south: -20, east: 10, north: 20 });
  });
});

describe("tile counting", () => {
  it("counts one tile at zoom 0 for any box", () => {
    expect(countTilesForBBox(SF, 0, 0)).toBe(1);
  });

  it("count matches the enumerated tile list", () => {
    for (let z = 0; z <= 8; z++) {
      expect(countTilesForBBox(SF, 0, z)).toBe(tilesForBBox(SF, 0, z).length);
    }
  });

  it("is monotonic in max zoom (more zoom = at least as many tiles)", () => {
    let prev = 0;
    for (let z = 0; z <= 12; z++) {
      const n = countTilesForBBox(SF, 0, z);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it("never fetches past the provider max zoom", () => {
    const capped = countTilesForBBox(SF, 0, MAX_TILE_ZOOM);
    const over = countTilesForBBox(SF, 0, MAX_TILE_ZOOM + 5);
    expect(over).toBe(capped);
    expect(tilesForBBox(SF, 0, 99).every((t) => t.z <= MAX_TILE_ZOOM)).toBe(true);
  });

  it("does not pull in an extra tile when the box ends exactly on a tile edge", () => {
    // At z1 the antimeridian-to-prime-meridian western hemisphere is exactly
    // tiles x=0 (lon -180..0). A box of lon [-180,0] must be 1 tile wide, not 2.
    const box: BBox = { west: -180, south: 0.1, east: 0, north: 66 };
    const [x0, x1] = [
      Math.floor(lonToTileX(box.west, 1)),
      Math.floor(lonToTileX(box.east, 1)),
    ];
    // Raw floor would give x0=0, x1=1 (2 wide); the range logic trims the edge.
    expect(x0).toBe(0);
    expect(x1).toBe(1);
    const tiles = tilesForBBox(box, 1, 1);
    expect(tiles.map((t) => t.x)).toEqual([0]);
  });

  it("orders tiles by ascending zoom (parents first)", () => {
    const tiles = tilesForBBox(SF, 0, 6);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i].z).toBeGreaterThanOrEqual(tiles[i - 1].z);
    }
  });

  it("produces in-range integer tile coordinates", () => {
    for (const t of tilesForBBox(SF, 0, 10)) {
      const n = 2 ** t.z;
      expect(Number.isInteger(t.x)).toBe(true);
      expect(Number.isInteger(t.y)).toBe(true);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(n);
      expect(t.y).toBeLessThan(n);
    }
  });
});

describe("size estimate", () => {
  it("grows with area and zoom", () => {
    const small = estimateBytesForBBox(SF, 0, 10);
    const deeper = estimateBytesForBBox(SF, 0, 14);
    expect(deeper).toBeGreaterThan(small);
  });

  it("is proportional to tile count via per-zoom weights", () => {
    // Empty-ish deep-zoom box still costs something per tile.
    expect(estimateBytesForBBox(SF, 14, 14)).toBeGreaterThan(0);
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
  });
});
