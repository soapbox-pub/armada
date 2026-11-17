// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let wake: ((scopes: ReadonlySet<string>) => void) | undefined;
vi.mock("@/wire/useWireScopes", () => ({
  useWireScopes: (h: (scopes: ReadonlySet<string>) => void) => void (wake = h),
}));
const watched = new Map<string, string[]>();
vi.mock("@/wire/watched", () => ({
  setWatched: (owner: string, _relays: readonly string[], pks: readonly string[]) => {
    if (pks.length === 0) watched.delete(owner);
    else watched.set(owner, [...pks]);
  },
}));

import { OWED_RECHECK_MS, OWED_WINDOW_MS, useOwedReread } from "./useOwedReread";

const props = () => ({ owner: "writer:c", relays: ["wss://r"], pks: ["plane"], pending: true, sig: "a", refetch: vi.fn() });
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useOwedReread", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watched.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("reads at once, on a backoff, then every 10 s until the window closes", () => {
    const p = props();
    renderHook(() => useOwedReread(p));
    expect(p.refetch).toHaveBeenCalledTimes(1);
    advance(20_000);
    const afterBackoff = p.refetch.mock.calls.length;
    advance(OWED_RECHECK_MS);
    expect(p.refetch).toHaveBeenCalledTimes(afterBackoff + 1);
    advance(OWED_WINDOW_MS);
    const closed = p.refetch.mock.calls.length;
    advance(OWED_WINDOW_MS);
    expect(p.refetch).toHaveBeenCalledTimes(closed);
    // The live watch outlasts the window: a wrap landing later still reads at once.
    expect(watched.get("writer:c")).toEqual(["plane"]);
    wake?.(new Set(["c2park:plane"]));
    expect(p.refetch).toHaveBeenCalledTimes(closed + 1);
  });

  it("doesn't run a window again for a sig whose window has run", () => {
    const p = props();
    const { rerender } = renderHook((q) => useOwedReread(q), { initialProps: p });
    advance(OWED_WINDOW_MS + 1);
    p.refetch.mockClear();
    rerender({ ...p, pending: false });
    rerender({ ...p, pending: true });
    advance(OWED_WINDOW_MS + 1);
    expect(p.refetch).not.toHaveBeenCalled();
  });

  it("without onMount, takes the first loaded sig as a baseline and runs only on a change", () => {
    const p = { ...props(), sig: undefined as string | undefined, onMount: false };
    const { rerender } = renderHook((q) => useOwedReread(q), { initialProps: p });
    rerender({ ...p, sig: "a" });
    advance(OWED_WINDOW_MS + 1);
    expect(p.refetch).not.toHaveBeenCalled();
    // Still watched, so a delivery heard live is read.
    expect(watched.get("writer:c")).toEqual(["plane"]);
    rerender({ ...p, sig: "b" });
    expect(p.refetch).toHaveBeenCalledTimes(1);
    advance(20_000);
    expect(p.refetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("reads the moment a wrap lands on a watched plane, and only while owed", () => {
    const p = props();
    const { rerender } = renderHook((q) => useOwedReread(q), { initialProps: p });
    expect(watched.get("writer:c")).toEqual(["plane"]);
    p.refetch.mockClear();
    wake?.(new Set(["c2park:other"]));
    expect(p.refetch).not.toHaveBeenCalled();
    wake?.(new Set(["c2park:plane"]));
    expect(p.refetch).toHaveBeenCalledTimes(1);

    rerender({ ...p, pending: false });
    expect(watched.has("writer:c")).toBe(false);
    p.refetch.mockClear();
    wake?.(new Set(["c2park:plane"]));
    advance(OWED_WINDOW_MS);
    expect(p.refetch).not.toHaveBeenCalled();
  });

  it("opens the window again when what is owed moves", () => {
    const p = props();
    const { rerender } = renderHook((q) => useOwedReread(q), { initialProps: p });
    advance(OWED_WINDOW_MS + 1);
    p.refetch.mockClear();
    rerender({ ...p, sig: "b" });
    expect(p.refetch).toHaveBeenCalledTimes(1);
    advance(20_000);
    expect(p.refetch.mock.calls.length).toBeGreaterThan(1);
  });
});
