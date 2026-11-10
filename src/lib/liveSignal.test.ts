import { describe, expect, it } from "vitest";

import { isPlausiblyLive, liveSignalSince, SIGNAL_AHEAD_MS, SIGNAL_BEHIND_MS } from "@/lib/liveSignal";

describe("isPlausiblyLive", () => {
  const now = 1_800_000_000_000;

  it("admits a signal from a clock minutes slow or a minute fast", () => {
    expect(isPlausiblyLive(now - 2 * 60_000, now)).toBe(true);
    expect(isPlausiblyLive(now + SIGNAL_AHEAD_MS, now)).toBe(true);
    expect(isPlausiblyLive(now - SIGNAL_BEHIND_MS, now)).toBe(true);
  });

  it("refuses a replay and a squat on the future", () => {
    expect(isPlausiblyLive(now - SIGNAL_BEHIND_MS - 1, now)).toBe(false);
    expect(isPlausiblyLive(now + SIGNAL_AHEAD_MS + 1, now)).toBe(false);
  });

  it("subscribes back far enough for the slowest sender it admits", () => {
    expect(liveSignalSince(now)).toBe((now - SIGNAL_BEHIND_MS) / 1000);
  });
});
