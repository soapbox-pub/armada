// @vitest-environment jsdom
/**
 * Reduce motion is the app switch OR the OS setting: either one marks `<html>`
 * (which index.css reads) and answers `reducedMotion()`, the switch persists
 * device-wide, and the OS setting can't be switched off from inside the app.
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

const marked = () => document.documentElement.hasAttribute("data-reduce-motion");

describe("reducedMotion", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-reduce-motion");
  });

  it("is off by default, and the switch turns it on, marks <html> and persists", async () => {
    mockSystem(false);
    const m = await fresh();
    expect(m.reducedMotion()).toBe(false);
    expect(marked()).toBe(false);

    const heard = vi.fn();
    m.onReducedMotionChange(heard);
    m.setReduceMotionSetting(true);
    expect(m.reducedMotion()).toBe(true);
    expect(marked()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(m.REDUCE_MOTION_KEY)).toBe("1");

    // A reload reads it back.
    const again = await fresh();
    expect(again.getReduceMotionSetting()).toBe(true);
    expect(marked()).toBe(true);

    again.setReduceMotionSetting(false);
    expect(localStorage.getItem(m.REDUCE_MOTION_KEY)).toBeNull();
    expect(marked()).toBe(false);
  });

  it("follows the OS setting with the switch off, live", async () => {
    const system = mockSystem(true);
    const m = await fresh();
    expect(m.getReduceMotionSetting()).toBe(false);
    expect(m.systemReducesMotion()).toBe(true);
    expect(m.reducedMotion()).toBe(true);
    expect(marked()).toBe(true);
    expect(m.scrollBehavior()).toBe("auto");

    system.change(false);
    expect(m.reducedMotion()).toBe(false);
    expect(marked()).toBe(false);
    expect(m.scrollBehavior()).toBe("smooth");
  });
});
