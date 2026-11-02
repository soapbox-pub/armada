// @vitest-environment jsdom
/**
 * Motion is the app switch OR the OS setting and marks `<html>`; animated media
 * and blur follow it until chosen, and a choice equal to what they'd follow is
 * forgotten; Ultra flair is its own switch. All persist device-wide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Module = typeof import("./reducedMotion");

function mockSystem(matches: boolean): { change: (next: boolean) => void } {
  let listener: ((e: { matches: boolean }) => void) | undefined;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => {
      listener = l;
    },
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return { change: (next) => listener?.({ matches: next }) };
}

async function fresh(): Promise<Module> {
  vi.resetModules();
  return await import("./reducedMotion");
}

const marked = (attr: string) => document.documentElement.hasAttribute(attr);

describe("reducedMotion", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-reduce-motion");
    document.documentElement.removeAttribute("data-reduce-blur");
  });

  it("is off by default, and the switch turns it on, marks <html> and persists", async () => {
    mockSystem(false);
    const m = await fresh();
    expect(m.reducedMotion()).toBe(false);
    expect(marked("data-reduce-motion")).toBe(false);

    const heard = vi.fn();
    m.onReducedMotionChange(heard);
    m.setReduceMotionSetting(true);
    expect(m.reducedMotion()).toBe(true);
    expect(marked("data-reduce-motion")).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(m.REDUCE_MOTION_KEY)).toBe("1");

    // A reload reads it back.
    const again = await fresh();
    expect(again.reducedMotion()).toBe(true);
    expect(marked("data-reduce-motion")).toBe(true);

    again.setReduceMotionSetting(false);
    expect(localStorage.getItem(m.REDUCE_MOTION_KEY)).toBeNull();
    expect(marked("data-reduce-motion")).toBe(false);
  });

  it("follows the OS setting with the switch off, live", async () => {
    const system = mockSystem(true);
    const m = await fresh();
    expect(m.systemReducesMotion()).toBe(true);
    expect(m.reducedMotion()).toBe(true);
    expect(marked("data-reduce-motion")).toBe(true);
    expect(m.scrollBehavior()).toBe("auto");

    system.change(false);
    expect(m.reducedMotion()).toBe(false);
    expect(marked("data-reduce-motion")).toBe(false);
    expect(m.scrollBehavior()).toBe("smooth");
  });

  it("media and blur follow motion until chosen, and stay chosen", async () => {
    mockSystem(false);
    const m = await fresh();
    m.setReduceMotionSetting(true);
    expect(m.stillMedia()).toBe(true);
    expect(m.reducedBlur()).toBe(true);
    expect(marked("data-reduce-blur")).toBe(true);

    // Keep GIFs and blur while reducing motion.
    m.setStillMediaSetting(false);
    m.setReduceBlurSetting(false);
    expect(m.stillMedia()).toBe(false);
    expect(marked("data-reduce-blur")).toBe(false);
    expect(localStorage.getItem(m.STILL_MEDIA_KEY)).toBe("0");

    // A choice outlives motion going off and on again, and a reload.
    m.setReduceMotionSetting(false);
    m.setReduceMotionSetting(true);
    const again = await fresh();
    expect(again.stillMedia()).toBe(false);
    expect(again.reducedBlur()).toBe(false);

    // Choosing what it would follow anyway goes back to following.
    again.setStillMediaSetting(true);
    expect(localStorage.getItem(m.STILL_MEDIA_KEY)).toBeNull();
    again.setReduceMotionSetting(false);
    expect(again.stillMedia()).toBe(false);
  });

  it("can pause media and drop blur without reducing motion", async () => {
    mockSystem(false);
    const m = await fresh();
    m.setStillMediaSetting(true);
    m.setReduceBlurSetting(true);
    expect(m.reducedMotion()).toBe(false);
    expect(m.stillMedia()).toBe(true);
    expect(marked("data-reduce-blur")).toBe(true);
    expect(marked("data-reduce-motion")).toBe(false);
  });

  it("Ultra flair is its own switch", async () => {
    mockSystem(true);
    const m = await fresh();
    expect(m.hiddenFlair()).toBe(false);
    m.setHideFlairSetting(true);
    expect(m.hiddenFlair()).toBe(true);
    expect((await fresh()).hiddenFlair()).toBe(true);
  });
});
