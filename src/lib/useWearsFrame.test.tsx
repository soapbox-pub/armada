import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { setUltraShown, useWearsFrame } from "@/lib/ultra";

const framed = { name: "Ana", armada_ultra: { since: 1, frame: "gold" } };

describe("useWearsFrame", () => {
  it("is true only for a profile with a frame that the viewer shows", () => {
    expect(renderHook(() => useWearsFrame(framed)).result.current).toBe(true);
    expect(renderHook(() => useWearsFrame({ name: "Bo" })).result.current).toBe(false);
    expect(renderHook(() => useWearsFrame(undefined)).result.current).toBe(false);
    setUltraShown(false);
    try {
      expect(renderHook(() => useWearsFrame(framed)).result.current).toBe(false);
    } finally {
      setUltraShown(true);
    }
  });
});
