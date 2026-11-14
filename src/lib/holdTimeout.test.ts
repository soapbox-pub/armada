import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdTimeout } from "@/lib/holdTimeout";

describe("holdTimeout", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Advance both clocks, the way an idle main thread runs its timers on time. */
  const elapse = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  it("fires once the hold elapses on time", () => {
    const onHold = vi.fn();
    holdTimeout(onHold, 300);
    elapse(299);
    expect(onHold).not.toHaveBeenCalled();
    elapse(1);
    expect(onHold).toHaveBeenCalledOnce();
  });

  it("does not fire when cancelled", () => {
    const onHold = vi.fn();
    const cancel = holdTimeout(onHold, 300);
    elapse(100);
    cancel();
    elapse(1000);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("waits past a stall so the release queued behind it cancels first", () => {
    const onHold = vi.fn();
    const cancel = holdTimeout(onHold, 300);
    // A long task: the clock runs on while no timer can.
    now += 1200;
    vi.advanceTimersByTime(300);
    expect(onHold).not.toHaveBeenCalled();
    // The tap's pointerup, dispatched now that the thread is free.
    cancel();
    elapse(1000);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("still fires after a stall when the press is genuinely held", () => {
    const onHold = vi.fn();
    holdTimeout(onHold, 300);
    now += 1200;
    vi.advanceTimersByTime(300);
    expect(onHold).not.toHaveBeenCalled();
    elapse(50);
    expect(onHold).toHaveBeenCalledOnce();
  });
});
