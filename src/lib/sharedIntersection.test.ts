import { afterEach, describe, expect, it, vi } from "vitest";

class FakeObserver {
  static made: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback, readonly init?: IntersectionObserverInit) {
    FakeObserver.made.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  fire(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

vi.stubGlobal("IntersectionObserver", FakeObserver);
const { observeIntersection } = await import("./sharedIntersection");

const el = () => ({}) as Element;

describe("observeIntersection", () => {
  afterEach(() => {
    FakeObserver.made.length = 0;
  });

  it("shares one observer per root margin and tells each element's listeners only", () => {
    const a = el();
    const b = el();
    const heardA: boolean[] = [];
    const heardB: boolean[] = [];
    const stopA = observeIntersection(a, (e) => heardA.push(e.isIntersecting), "100px");
    const stopB = observeIntersection(b, (e) => heardB.push(e.isIntersecting), "100px");
    observeIntersection(el(), () => undefined, "5px");
    const shared = FakeObserver.made.find((o) => o.init?.rootMargin === "100px")!;
    expect(FakeObserver.made.filter((o) => o.init?.rootMargin === "100px")).toHaveLength(1);
    shared.fire(a, true);
    expect(heardA).toEqual([true]);
    expect(heardB).toEqual([]);
    stopA();
    expect(shared.targets.has(a)).toBe(false);
    expect(shared.targets.has(b)).toBe(true);
    stopB();
    stopB();
    expect(shared.targets.size).toBe(0);
  });

  it("keeps watching an element until its last listener leaves", () => {
    const a = el();
    const one = observeIntersection(a, () => undefined, "7px");
    const two = observeIntersection(a, () => undefined, "7px");
    const shared = FakeObserver.made.find((o) => o.init?.rootMargin === "7px")!;
    one();
    expect(shared.targets.has(a)).toBe(true);
    two();
    expect(shared.targets.has(a)).toBe(false);
  });
});
