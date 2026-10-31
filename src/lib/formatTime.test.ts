import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fullDateTime, isoDateTime, shortClockTime, shortTimeAgo } from "./formatTime";

const NOW = 1_700_000_000;
const ago = (seconds: number) => shortTimeAgo(NOW - seconds);

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("shortTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it("counts up through each unit", () => {
    expect(ago(0)).toBe("now");
    expect(ago(59)).toBe("now");
    expect(ago(MINUTE)).toBe("1m");
    expect(ago(59 * MINUTE)).toBe("59m");
    expect(ago(HOUR)).toBe("1h");
    expect(ago(23 * HOUR)).toBe("23h");
    expect(ago(DAY)).toBe("1d");
    expect(ago(6 * DAY)).toBe("6d");
    expect(ago(7 * DAY)).toBe("1w");
    expect(ago(30 * DAY)).toBe("4w");
    expect(ago(31 * DAY)).toBe("1mo");
    expect(ago(364 * DAY)).toBe("11mo");
    expect(ago(366 * DAY)).toBe("1y");
    expect(ago(626 * DAY)).toBe("1y");
    expect(ago(800 * DAY)).toBe("2y");
  });

  it("never exceeds two digits of magnitude within a unit", () => {
    for (let days = 0; days < 4000; days += 1) {
      expect(ago(days * DAY)).toMatch(/^(now|\d{1,2}(m|h|d|w|mo|y))$/);
    }
  });

  it("reads a clock skewed into the future as now", () => {
    expect(shortTimeAgo(NOW + DAY)).toBe("now");
  });
});

describe("a sender's created_at past the Date range", () => {
  // NIP-29 rows carry it unbounded; formatting an invalid Date throws RangeError.
  it("formats as blank instead of throwing", () => {
    const forged = 10_000_000_000_000;
    expect(isoDateTime(forged)).toBeUndefined();
    expect(fullDateTime(forged)).toBe("");
    expect(shortClockTime(forged)).toBe("");
    expect(isoDateTime(NOW)).toBe(new Date(NOW * 1000).toISOString());
  });
});
