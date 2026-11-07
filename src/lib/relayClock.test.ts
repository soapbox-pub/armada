/** Keeping the clock by the relays (CORD-03 §3, Vector `clock.rs`). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { agreedOffset, clockNowMs, clockOffsetMs, parseHttpDate, resetClockOffset, syncClockWithRelays } from "@/lib/relayClock";

afterEach(() => {
  resetClockOffset();
  vi.useRealTimers();
});

const httpDate = (ms: number) => new Date(ms).toUTCString();

describe("relayClock", () => {
  it("parses an IMF-fixdate", () => {
    expect(parseHttpDate("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(784111777);
    expect(parseHttpDate("Sunday, 06-Nov-94 08:49:37 GMT")).toBeUndefined();
  });

  it("takes the median when at least three relays agree within 5 s", () => {
    expect(agreedOffset([30_000])).toBeUndefined();
    expect(agreedOffset([30_000, 31_000])).toBeUndefined();
    expect(agreedOffset([30_000, 31_000, 32_000])).toBe(31_000);
    expect(agreedOffset([30_000, 31_000, -900_000])).toBeUndefined();
    expect(agreedOffset([30_000, 31_000, 32_000, -900_000])).toBe(31_000);
    expect(agreedOffset([30_000, 60_000, 90_000])).toBeUndefined();
  });

  it("corrects a clock the relays agree runs 30 s slow, and ignores a gap under 2 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const ahead = (ms: number) => async () => ({ date: httpDate(Date.now() + ms) });
    await syncClockWithRelays(["wss://a.test", "wss://b.test", "wss://c.test"], ahead(30_000));
    expect(Math.abs(clockOffsetMs() - 30_500)).toBeLessThan(1_001);
    expect(clockNowMs() - Date.now()).toBe(clockOffsetMs());
    await syncClockWithRelays(["wss://a.test", "wss://b.test", "wss://c.test"], ahead(0));
    expect(clockOffsetMs()).toBe(0);
  });

  it("goes back to the device's clock when the relays stop agreeing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const ahead = (ms: number) => async () => ({ date: httpDate(Date.now() + ms) });
    await syncClockWithRelays(["wss://a.test", "wss://b.test", "wss://c.test"], ahead(30_000));
    expect(clockOffsetMs()).not.toBe(0);
    await syncClockWithRelays(["wss://a.test", "wss://b.test"], ahead(30_000));
    expect(clockOffsetMs()).toBe(0);
  });

  it("leaves the clock alone when a relay alone, or none, tells the time", async () => {
    await syncClockWithRelays(["wss://a.test"], async () => ({ date: httpDate(Date.now() + 60_000) }));
    expect(clockOffsetMs()).toBe(0);
    await syncClockWithRelays(["wss://a.test", "wss://b.test"], async () => ({ date: null }));
    expect(clockOffsetMs()).toBe(0);
  });
});
