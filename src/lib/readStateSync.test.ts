import { describe, expect, it } from "vitest";

import { capReadStamp, capReadStamps, planReadStatePublish, READ_AHEAD_SECS, READ_STATE_ROLLOVER_BYTES, readStateDelta } from "@/lib/readStateSync";

describe("read-state publish plan", () => {
  it("the delta is only what the base doesn't already cover", () => {
    expect(readStateDelta({ a: 5, b: 3, c: 9 }, { a: 5, b: 4, c: 1 })).toEqual({ c: 9 });
  });

  it("a read publishes only the delta, not the whole map", () => {
    const base = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`c2:${i}`, 100]));
    const plan = planReadStatePublish({ ...base, "c2:7": 200 }, base, {});
    expect(plan).toEqual({ kind: "recent", readState: { "c2:7": 200 } });
  });

  it("keeps entries another device put in recent, since they are in the local map too", () => {
    const plan = planReadStatePublish({ a: 1, b: 7, c: 8 }, { a: 1 }, { b: 7 });
    expect(plan).toEqual({ kind: "recent", readState: { b: 7, c: 8 } });
  });

  it("publishes nothing when the documents already say everything", () => {
    expect(planReadStatePublish({ a: 1, b: 7 }, { a: 1 }, { b: 7 })).toEqual({ kind: "none" });
    expect(planReadStatePublish({ a: 1 }, { a: 3 }, {})).toEqual({ kind: "none" });
  });

  it("folds into the base once the delta outgrows the rollover size", () => {
    const local = Object.fromEntries(
      Array.from({ length: READ_STATE_ROLLOVER_BYTES / 20 }, (_, i) => [`c2t:${"f".repeat(12)}${i}`, 1_790_000_000]),
    );
    expect(planReadStatePublish(local, {}, {})).toEqual({ kind: "rollover" });
  });
});

describe("read stamps past now", () => {
  const now = 1_800_000_000;

  it("a stamp from a fast clock is held to a minute past now", () => {
    expect(capReadStamp(now + 1800, now)).toBe(now + READ_AHEAD_SECS);
    expect(capReadStamp(now - 5, now)).toBe(now - 5);
  });

  it("caps a stored or synced map, returning it untouched when nothing runs ahead", () => {
    const ok = { a: now, b: now - 10 };
    expect(capReadStamps(ok, now)).toBe(ok);
    expect(capReadStamps({ a: now + 1800, b: now - 10 }, now)).toEqual({ a: now + READ_AHEAD_SECS, b: now - 10 });
  });
});
