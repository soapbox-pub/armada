import { describe, expect, it } from "vitest";

import {
  assetKey,
  base64ToBytes,
  bytesToBase64,
  isTileKey,
  packChunk,
  sliceFromBuffer,
  tileKey,
} from "@/lib/map/tileContainer";

describe("keys", () => {
  it("builds stable tile keys", () => {
    expect(tileKey({ z: 14, x: 2620, y: 6333 })).toBe("t/14/2620/6333");
    expect(isTileKey(tileKey({ z: 1, x: 0, y: 0 }))).toBe(true);
  });

  it("builds asset keys distinguishable from tiles", () => {
    const k = assetKey("glyph", "Noto Sans Regular/0-255");
    expect(k).toBe("a/glyph/Noto Sans Regular/0-255");
    expect(isTileKey(k)).toBe(false);
  });
});

describe("packChunk", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([9, 8]);

  it("concatenates bytes and records offsets", () => {
    const { buffer, index } = packChunk([
      { key: "t/0/0/0", bytes: a },
      { key: "t/1/0/0", bytes: b },
    ]);
    expect(Array.from(buffer)).toEqual([1, 2, 3, 9, 8]);
    expect(index["t/0/0/0"]).toEqual({ offset: 0, length: 3 });
    expect(index["t/1/0/0"]).toEqual({ offset: 3, length: 2 });
  });

  it("honors a base offset for incremental appends", () => {
    const { buffer, index } = packChunk([{ key: "t/2/1/1", bytes: b }], 100);
    expect(buffer.length).toBe(2);
    expect(index["t/2/1/1"]).toEqual({ offset: 100, length: 2 });
  });

  it("round-trips through sliceFromBuffer", () => {
    const { buffer, index } = packChunk([
      { key: "x", bytes: a },
      { key: "y", bytes: b },
    ]);
    expect(Array.from(sliceFromBuffer(buffer, index["x"]))).toEqual([1, 2, 3]);
    expect(Array.from(sliceFromBuffer(buffer, index["y"]))).toEqual([9, 8]);
  });

  it("handles an empty batch", () => {
    const { buffer, index } = packChunk([]);
    expect(buffer.length).toBe(0);
    expect(index).toEqual({});
  });
});

describe("base64 round-trip", () => {
  it("survives arbitrary bytes including a large buffer", () => {
    const rnd = new Uint8Array(70_000);
    for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 31 + 7) & 0xff;
    expect(Array.from(base64ToBytes(bytesToBase64(rnd)))).toEqual(Array.from(rnd));
  });

  it("handles empty and all-byte-value inputs", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(base64ToBytes(bytesToBase64(all)))).toEqual(Array.from(all));
  });
});
