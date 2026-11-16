// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCoalescedRefetch } from "./useCoalescedRefetch";

describe("useCoalescedRefetch", () => {
  it("lets a read finish through a burst of wakes, then reads exactly once more", async () => {
    const reads: Array<() => void> = [];
    const refetch = vi.fn(() => new Promise<void>((done) => reads.push(done)));
    const { result } = renderHook(() => useCoalescedRefetch(refetch));

    act(() => result.current());
    for (let i = 0; i < 50; i++) act(() => result.current());
    expect(refetch).toHaveBeenCalledTimes(1);

    await act(async () => reads[0]());
    expect(refetch).toHaveBeenCalledTimes(2);
    await act(async () => reads[1]());
    expect(refetch).toHaveBeenCalledTimes(2);

    act(() => result.current());
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("keeps going after a failed read", async () => {
    const refetch = vi.fn().mockRejectedValueOnce(new Error("relay gone")).mockResolvedValue(undefined);
    const { result } = renderHook(() => useCoalescedRefetch(refetch));
    act(() => result.current());
    act(() => result.current());
    await act(async () => {});
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
