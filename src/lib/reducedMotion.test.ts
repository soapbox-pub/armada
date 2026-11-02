// @vitest-environment jsdom
/**
 * One master switch turns every part on; each part can then be left out. The
 * OS's reduced-motion setting turns the master on and always stops motion.
 * Everything persists device-wide and marks `<html>` for the CSS.
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

const all = (m: Module) => [m.reducedMotion(), m.stillMedia(), m.reducedBlur(), m.hiddenFlair()];

describe("reducedMotion", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-reduce-motion");
    document.documentElement.removeAttribute("data-reduce-blur");
  });

  it("is off by default, and the master turns every part on, marks <html> and persists", async () => {
    mockSystem(false);
    const m = await fresh();
    expect(all(m)).toEqual([false, false, false, false]);
    expect(marked("data-reduce-motion")).toBe(false);

    const heard = vi.fn();
    m.onReducedMotionChange(heard);
    m.setReduceEffects(true);
    expect(all(m)).toEqual([true, true, true, true]);
    expect(marked("data-reduce-motion")).toBe(true);
    expect(marked("data-reduce-blur")).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(m.REDUCE_EFFECTS_KEY)).toBe("1");

    const again = await fresh();
    expect(all(again)).toEqual([true, true, true, true]);

    again.setReduceEffects(false);
    expect(all(again)).toEqual([false, false, false, false]);
    expect(localStorage.getItem(m.REDUCE_EFFECTS_KEY)).toBeNull();
    expect(marked("data-reduce-motion")).toBe(false);
  });

  it("a part left out stays out across the master and a reload, and nothing applies with the master off", async () => {
    mockSystem(false);
    const m = await fresh();
    m.setEffectPart("blur", false);
    m.setEffectPart("media", false);
    expect(all(m)).toEqual([false, false, false, false]);

    m.setReduceEffects(true);
    expect(all(m)).toEqual([true, false, false, true]);
    expect(marked("data-reduce-blur")).toBe(false);

    const again = await fresh();
    expect(all(again)).toEqual([true, false, false, true]);
    again.setEffectPart("blur", true);
    expect(again.reducedBlur()).toBe(true);
    expect(marked("data-reduce-blur")).toBe(true);
  });

  it("the OS setting turns the master on and always stops motion, live", async () => {
    const system = mockSystem(true);
    const m = await fresh();
    m.setEffectPart("motion", false);
    m.setEffectPart("flair", false);
    expect(m.systemReducesMotion()).toBe(true);
    expect(all(m)).toEqual([true, true, true, false]);
    expect(marked("data-reduce-motion")).toBe(true);
    expect(m.scrollBehavior()).toBe("auto");

    system.change(false);
    expect(all(m)).toEqual([false, false, false, false]);
    expect(marked("data-reduce-motion")).toBe(false);
    expect(m.scrollBehavior()).toBe("smooth");
  });
});
