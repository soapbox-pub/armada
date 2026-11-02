// @vitest-environment jsdom
/**
 * The desktop window going out of sight rests the app after a grace (a quick
 * minimize-and-back doesn't), marks `<html>` for the CSS, and coming back
 * wakes it at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let visibility: ((visible: boolean) => void) | undefined;
vi.mock("@/lib/desktop", () => ({
  onDesktopWindowVisibility: (handler: (visible: boolean) => void) => {
    visibility = handler;
    return () => {};
  },
}));

describe("trayRest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => vi.useRealTimers());

  it("rests only after the grace, and wakes at once", async () => {
    const m = await import("./trayRest");
    const heard = vi.fn();
    m.onTrayRest(heard);
    expect(m.isTrayResting()).toBe(false);

    visibility!(false);
    vi.advanceTimersByTime(5_000);
    visibility!(true);
    vi.advanceTimersByTime(20_000);
    expect(m.isTrayResting()).toBe(false);
    expect(heard).not.toHaveBeenCalled();

    visibility!(false);
    vi.advanceTimersByTime(10_000);
    expect(m.isTrayResting()).toBe(true);
    expect(document.documentElement.hasAttribute("data-resting")).toBe(true);

    visibility!(true);
    expect(m.isTrayResting()).toBe(false);
    expect(document.documentElement.hasAttribute("data-resting")).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
