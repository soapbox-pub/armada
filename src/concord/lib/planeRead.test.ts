/** The per-relay read plan, against Vector's `guestbook_reads.rs` tests. */
import { describe, expect, it } from "vitest";

import { afterRead, OVERLAP_SECS, planRead, type RelayRead } from "@/concord/lib/planeRead";

const DAY = 86_400;

describe("planRead / afterRead", () => {
  it("reads whole a relay never read, or read whole a day ago", () => {
    expect(planRead(undefined, 10 * DAY).since).toBe(0);
    const read: RelayRead = { cursor: 9 * DAY, wholeAt: 9 * DAY - 10 };
    expect(planRead(read, 10 * DAY).since, "a day since its last whole read").toBe(0);
    expect(planRead(read, 9 * DAY + 600).since, "otherwise from its cursor, an hour back").toBe(9 * DAY - OVERLAP_SECS);
  });

  it("moves the cursor to when a read to the end began, and keeps a short one's place", () => {
    const read: RelayRead = { cursor: 10_000, wholeAt: 9_000 };
    const plan = planRead(read, 10_500);
    expect(afterRead(read, plan)).toEqual({ cursor: 10_500, wholeAt: 9_000 });
    const short = afterRead(read, plan, 10_200);
    expect(short.cursor, "a read that stopped short earns nothing yet").toBe(10_000);
    expect(planRead(short, 99_999), "and goes on from where it stopped").toEqual({ since: plan.since, until: 10_200, began: 10_500 });
    expect(afterRead(short, planRead(short, 99_999)).cursor, "finishing earns the cursor of when it began").toBe(10_500);
  });

  it("marks when a whole read finished", () => {
    const plan = planRead(undefined, 5_000);
    expect(afterRead(undefined, plan)).toEqual({ cursor: 5_000, wholeAt: 5_000 });
  });

  it("reads whole when the last whole read is stamped ahead of the clock", () => {
    expect(planRead({ cursor: 9 * DAY, wholeAt: 11 * DAY }, 10 * DAY).since).toBe(0);
  });
});
