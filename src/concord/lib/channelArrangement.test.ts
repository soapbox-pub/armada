import { describe, expect, it } from "vitest";

import {
  applyArrangement,
  arrangedBefore,
  arrangementChanges,
  dropChanges,
  arrangementSettled,
  pendingFromPlan,
  planChannelDrop,
  type ArrangedChannel,
} from "@/concord/lib/channelArrangement";

/** A rendered sidebar: three loose channels, then a "Voice" category. */
const rendered: ArrangedChannel[] = [
  { idHex: "a", position: 0 },
  { idHex: "b", position: 1 },
  { idHex: "c", position: 2 },
  { idHex: "d", position: 3, category: "Voice" },
  { idHex: "e", position: 4, category: "Voice" },
];

const ids = (list: readonly ArrangedChannel[]) => list.map((c) => c.idHex);

describe("planChannelDrop", () => {
  it("moves a channel down, indexing the list without it", () => {
    expect(ids(planChannelDrop(rendered, "a", 2, undefined))).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("moves a channel up", () => {
    expect(ids(planChannelDrop(rendered, "c", 0, undefined))).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("carries the channel into the category it was dropped in", () => {
    const next = planChannelDrop(rendered, "a", 3, "Voice");
    expect(ids(next)).toEqual(["b", "c", "d", "a", "e"]);
    expect(next.find((c) => c.idHex === "a")?.category).toBe("Voice");
  });

  it("drops a channel out of its category", () => {
    const next = planChannelDrop(rendered, "d", 0, undefined);
    expect(next[0]).toMatchObject({ idHex: "d", category: undefined });
  });

  it("clamps an index past either end", () => {
    expect(ids(planChannelDrop(rendered, "a", 99, undefined))).toEqual(["b", "c", "d", "e", "a"]);
    expect(ids(planChannelDrop(rendered, "e", -5, undefined))).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("leaves an unknown channel alone", () => {
    expect(ids(planChannelDrop(rendered, "zz", 0, undefined))).toEqual(ids(rendered));
  });
});

describe("arrangementChanges", () => {
  it("republishes only the run a move disturbed", () => {
    // c jumps to the top: a and b shift down one, d and e never move.
    const next = planChannelDrop(rendered, "c", 0, undefined);
    expect(arrangementChanges(rendered, next)).toEqual([
      { idHex: "c", position: 0, category: undefined },
      { idHex: "a", position: 1, category: undefined },
      { idHex: "b", position: 2, category: undefined },
    ]);
  });

  it("emits the filing even when the slot is unchanged", () => {
    // The regression this exists for: dropping a channel into the category
    // that already sits at its index changes the category and nothing else.
    const before: ArrangedChannel[] = [{ idHex: "a", position: 0 }, { idHex: "b", position: 1, category: "Voice" }];
    const next = planChannelDrop(before, "a", 0, "Voice");
    expect(arrangementChanges(before, next)).toEqual([{ idHex: "a", position: 0, category: "Voice" }]);
  });

  it("stamps every channel the first time a never-arranged community is dragged", () => {
    const unarranged: ArrangedChannel[] = [{ idHex: "a" }, { idHex: "b" }, { idHex: "c" }];
    expect(arrangementChanges(unarranged, planChannelDrop(unarranged, "c", 0, undefined))).toHaveLength(3);
  });

  it("is a no-op when nothing moved", () => {
    expect(arrangementChanges(rendered, planChannelDrop(rendered, "b", 1, undefined))).toEqual([]);
  });

  it("treats a case-only category respelling as no change", () => {
    const next = planChannelDrop(rendered, "d", 3, "voice");
    expect(arrangementChanges(rendered, next)).toEqual([]);
  });

  it("normalizes a blank category to uncategorized", () => {
    const before: ArrangedChannel[] = [{ idHex: "a", position: 0, category: "Voice" }];
    expect(arrangementChanges(before, planChannelDrop(before, "a", 0, "   "))).toEqual([
      { idHex: "a", position: 0, category: undefined },
    ]);
  });
});

describe("the optimistic overlay", () => {
  /** A fold that still says the pre-drop arrangement. */
  const folded = [
    { idHex: "a", name: "alpha", position: 0, category: undefined },
    { idHex: "b", name: "bravo", position: 1, category: undefined },
    { idHex: "c", name: "charlie", position: 2, category: "Voice" },
  ];

  it("reads as the drop will read, before any edition lands", () => {
    const plan = planChannelDrop(folded, "c", 0, undefined);
    const shown = applyArrangement(folded, pendingFromPlan(plan));
    expect(shown.map((c) => c.idHex)).toEqual(["c", "a", "b"]);
    expect(shown[0]).toMatchObject({ position: 0, category: undefined });
  });

  it("passes through a channel the plan never named", () => {
    const plan = planChannelDrop(folded, "c", 0, undefined);
    const withNew = [...folded, { idHex: "d", name: "delta", position: 9, category: undefined }];
    const shown = applyArrangement(withNew, pendingFromPlan(plan));
    expect(shown.map((c) => c.idHex)).toEqual(["c", "a", "b", "d"]);
  });

  it("is unsettled until the fold carries the planned position AND category", () => {
    const pending = pendingFromPlan(planChannelDrop(folded, "c", 0, undefined));
    expect(arrangementSettled(folded, pending)).toBe(false);

    const positioned = [
      { idHex: "c", name: "charlie", position: 0, category: "Voice" },
      { idHex: "a", name: "alpha", position: 1, category: undefined },
      { idHex: "b", name: "bravo", position: 2, category: undefined },
    ];
    // Position landed, the un-filing did not: still ours to hold.
    expect(arrangementSettled(positioned, pending)).toBe(false);

    const landed = positioned.map((c) => (c.idHex === "c" ? { ...c, category: undefined } : c));
    expect(arrangementSettled(landed, pending)).toBe(true);
  });

  it("settles on a case-only respelling of the same category", () => {
    const pending = pendingFromPlan(planChannelDrop(folded, "a", 2, "Voice"));
    const landed = [
      { idHex: "b", name: "bravo", position: 0, category: undefined },
      { idHex: "c", name: "charlie", position: 1, category: "Voice" },
      { idHex: "a", name: "alpha", position: 2, category: "VOICE" },
    ];
    expect(arrangementSettled(landed, pending)).toBe(true);
  });
});

describe("a drop on the vsk-13 Roster (CORD-03 §2, §4)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const rendered = [
    { idHex: "1", name: "one" },
    { idHex: "2", name: "two", category: "Text", categoryId: A },
    { idHex: "3", name: "three", category: "Text", categoryId: A },
    { idHex: "4", name: "four", category: "Text", categoryId: B },
  ];

  it("publishes the dropped Channel alone, at its index, under the Category's id", () => {
    const before = arrangedBefore(rendered, true);
    expect(before.map((c) => c.category)).toEqual([undefined, A, A, B]);
    const plan = planChannelDrop(before, "1", 2, B);
    expect(dropChanges(before, plan, "1", true)).toEqual([{ idHex: "1", position: 2, category: B }]);
  });

  it("publishes nothing for a drop back where it was", () => {
    const before = arrangedBefore(rendered, true);
    expect(dropChanges(before, planChannelDrop(before, "2", 1, A), "2", true)).toEqual([]);
  });

  it("overlays the plan by Category id, and settles once the fold sorts the same", () => {
    const before = arrangedBefore(rendered, true);
    const plan = planChannelDrop(before, "1", 3, B);
    const pending = pendingFromPlan(plan);
    const names = new Map([[A, "Text"], [B, "Text"]]);
    const shown = applyArrangement(rendered, pending, (id) => names.get(id));
    expect(shown.map((c) => [c.idHex, c.categoryId])).toEqual([["2", A], ["3", A], ["4", B], ["1", B]]);
    expect(arrangementSettled(rendered, pending, true)).toBe(false);
    const landed = [rendered[1], rendered[2], rendered[3], { ...rendered[0], category: "Text", categoryId: B }];
    expect(arrangementSettled(landed, pending, true)).toBe(true);
  });
});
