import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useOrderHeldOffTop } from "@/hooks/useOrderHeldOffTop";

function setup(initial: string[]) {
  const el = document.createElement("div");
  const ref = { current: el };
  const hook = renderHook(({ order }) => useOrderHeldOffTop(order, ref), { initialProps: { order: initial } });
  const scrollTo = (top: number) =>
    act(() => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  return { ...hook, scrollTo };
}

describe("useOrderHeldOffTop", () => {
  it("follows the order at the top", () => {
    const { result, rerender } = setup(["a", "b", "c"]);
    rerender({ order: ["c", "a", "b"] });
    expect(result.current).toEqual(["c", "a", "b"]);
  });

  it("holds the order while scrolled, appending arrivals and dropping departures", () => {
    const { result, rerender, scrollTo } = setup(["a", "b", "c"]);
    scrollTo(200);
    rerender({ order: ["c", "d", "a"] });
    expect(result.current).toEqual(["a", "c", "d"]);
  });

  it("keeps the held array's identity when nothing was added or removed", () => {
    const { result, rerender, scrollTo } = setup(["a", "b"]);
    scrollTo(50);
    const before = result.current;
    rerender({ order: ["b", "a"] });
    expect(result.current).toBe(before);
  });

  it("re-sorts once back at the top", () => {
    const { result, rerender, scrollTo } = setup(["a", "b", "c"]);
    scrollTo(200);
    rerender({ order: ["c", "b", "a"] });
    expect(result.current).toEqual(["a", "b", "c"]);
    scrollTo(0);
    expect(result.current).toEqual(["c", "b", "a"]);
  });
});
