import { describe, expect, it } from "vitest";

import { filtersWiden, roundWatch, settleDue, SPEC_SETTLE_MAX_MS, SPEC_SETTLE_MS, SPEC_WIDEN_SETTLE_MS } from "@/wire/roundWatch";

const T = 10_000_000;

describe("roundWatch()", () => {
  it("re-issues a round that never answered", () => {
    expect(roundWatch(T, T - 31_000, T - 31_000, false, false)).toBe("reissue");
    expect(roundWatch(T, T - 10_000, T - 10_000, false, false)).toBe("none");
  });

  it("probes a quiet established round instead of re-sending its filters", () => {
    expect(roundWatch(T, T - 120_000, T - 91_000, true, false)).toBe("probe");
    expect(roundWatch(T, T - 120_000, T - 91_000, true, true), "one probe at a time").toBe("none");
    expect(roundWatch(T, T - 120_000, T - 30_000, true, false)).toBe("none");
  });

  it("rotates a quiet round only after the long backstop", () => {
    expect(roundWatch(T, T - 15 * 60_000, T - 91_000, true, false)).toBe("rotate");
    expect(roundWatch(T, T - 15 * 60_000, T - 30_000, true, false), "never while traffic flows").toBe("none");
  });
});

describe("settleDue()", () => {
  it("defers a running loop's restart until the spec has been quiet", () => {
    expect(settleDue(T, undefined, T)).toBe(T + SPEC_SETTLE_MS);
    // Another change inside the window pushes it out again.
    expect(settleDue(T, T + SPEC_SETTLE_MS, T + 1_000)).toBe(T + 1_000 + SPEC_SETTLE_MS);
    // The timer firing at the due time restarts.
    expect(settleDue(T, T + SPEC_SETTLE_MS, T + SPEC_SETTLE_MS)).toBe(true);
  });

  it("never waits past the cap from the first change", () => {
    expect(settleDue(T, T + 4_800, T + 4_000)).toBe(T + SPEC_SETTLE_MAX_MS);
    expect(settleDue(T, T + 6_000, T + SPEC_SETTLE_MAX_MS)).toBe(true);
  });
});

describe("widening changes", () => {
  it("restart after a short coalescing window, under the same cap", () => {
    expect(settleDue(T, undefined, T, true)).toBe(T + SPEC_WIDEN_SETTLE_MS);
    // A long wait already set is shortened by a widening re-run.
    expect(settleDue(T, T + SPEC_SETTLE_MS, T + 100, true)).toBe(T + 100 + SPEC_WIDEN_SETTLE_MS);
    expect(settleDue(T, T + 4_990, T + 4_900, true)).toBe(T + SPEC_SETTLE_MAX_MS);
  });

  it("are filters that keep every old one, arrays grown", () => {
    const chat = { kinds: [1059], authors: ["a", "b"] };
    expect(filtersWiden([{ kinds: [1059], authors: ["a", "b", "c"] }], [chat])).toBe(true);
    expect(filtersWiden([chat, { kinds: [1], authors: ["x"] }], [chat])).toBe(true);
    expect(filtersWiden([{ kinds: [1059], authors: ["a"] }], [chat]), "an author dropped").toBe(false);
    expect(filtersWiden([{ ...chat, limit: 10 }], [chat]), "a field added").toBe(false);
    expect(filtersWiden([{ ...chat, since: 2 }], [{ ...chat, since: 1 }]), "a scalar changed").toBe(false);
    expect(filtersWiden([], [chat])).toBe(false);
  });
});
