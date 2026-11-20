import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { impactMock } = vi.hoisted(() => ({ impactMock: vi.fn((_opts: { style: string }) => Promise.resolve()) }));
let nativePlatform = false;

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => nativePlatform } }));
vi.mock("@capacitor/haptics", () => ({
  Haptics: { impact: impactMock, selectionChanged: vi.fn(() => Promise.resolve()), notification: vi.fn(() => Promise.resolve()) },
  ImpactStyle: { Light: "LIGHT", Medium: "MEDIUM", Heavy: "HEAVY" },
  NotificationType: { Success: "SUCCESS", Warning: "WARNING", Error: "ERROR" },
}));

import { impact, notify, selectionChanged, setHapticIntensity } from "./haptics";

describe("haptics intensity", () => {
  const vibrate = vi.fn();

  beforeEach(() => {
    nativePlatform = false;
    vibrate.mockReset();
    impactMock.mockClear();
    Object.defineProperty(globalThis, "navigator", { value: { vibrate }, configurable: true });
  });

  afterEach(() => setHapticIntensity("medium"));

  it("scales web pulses but not the gaps between them", () => {
    setHapticIntensity("high");
    impact("medium");
    notify("error");
    expect(vibrate.mock.calls).toEqual([[30], [[20, 40, 20]]]);

    setHapticIntensity("low");
    selectionChanged();
    expect(vibrate).toHaveBeenLastCalledWith(5);
  });

  it("is silent when off", () => {
    setHapticIntensity("off");
    selectionChanged();
    impact("heavy");
    notify();
    nativePlatform = true;
    impact("heavy");
    expect(vibrate).not.toHaveBeenCalled();
    expect(impactMock).not.toHaveBeenCalled();
  });

  it("shifts native impact styles one step, clamped", () => {
    nativePlatform = true;
    setHapticIntensity("low");
    impact("medium");
    impact("light");
    setHapticIntensity("high");
    impact("heavy");
    expect(impactMock.mock.calls.map(([arg]) => arg.style)).toEqual(["LIGHT", "LIGHT", "HEAVY"]);
  });
});
