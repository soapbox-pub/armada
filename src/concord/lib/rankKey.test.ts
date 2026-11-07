import { describe, expect, it } from "vitest";

import { denseRanks, isRankKey, rankBetween } from "@/concord/lib/rankKey";

describe("rank keys (CORD-04 §3)", () => {
  it("are bounded and never end in zero", () => {
    expect(isRankKey("V") && isRankKey("0A") && isRankKey("z".repeat(32))).toBe(true);
    expect(isRankKey("") || isRankKey("A0") || isRankKey("0") || isRankKey("z".repeat(33))).toBe(false);
    expect(isRankKey("a-b") || isRankKey("é")).toBe(false);
  });

  it("land strictly inside every gap", () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined], [undefined, "V"], ["V", undefined], ["A", "B"], ["A", "A1"], ["A1", "A2"], ["z", undefined], [undefined, "01"],
    ];
    for (const [lo, hi] of cases) {
      const k = rankBetween(lo, hi)!;
      expect(isRankKey(k), k).toBe(true);
      if (lo) expect(lo < k).toBe(true);
      if (hi) expect(k < hi).toBe(true);
    }
  });

  it("matches Vector's keys for the common moves", () => {
    // Vector's first Category and Role land at "V", the next at "W" (the fixtures show it).
    expect(rankBetween(undefined, undefined)).toBe("V");
    expect(rankBetween("V", undefined)).toBe("W");
  });

  it("refuses what has no inside", () => {
    expect(rankBetween("B", "A")).toBeUndefined();
    expect(rankBetween("A", "A")).toBeUndefined();
    expect(rankBetween("A0", undefined)).toBeUndefined();
    expect(rankBetween(undefined, "")).toBeUndefined();
  });

  it("dense ranks preserve order and make equal keys peers", () => {
    const r = denseRanks(["b", "A", "b", "Az", "0V"]);
    expect([r.get("0V"), r.get("A"), r.get("Az"), r.get("b")]).toEqual([1, 2, 3, 4]);
    expect(r.size).toBe(4);
  });
});
