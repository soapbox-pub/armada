import { afterEach, describe, expect, it, vi } from "vitest";

import { settleAccepted } from "./settleAccepted";

afterEach(() => {
  vi.useRealTimers();
});

const never = () => new Promise<string>(() => {});

describe("settleAccepted", () => {
  it("resolves after the grace once one relay accepted, without the hung one", async () => {
    vi.useFakeTimers();
    let settled: PromiseSettledResult<string>[] | undefined;
    void settleAccepted([Promise.resolve("ok"), never()], 1000).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([{ status: "fulfilled", value: "ok" }]);
  });

  it("waits for every relay while none has accepted", async () => {
    vi.useFakeTimers();
    let settled: PromiseSettledResult<string>[] | undefined;
    let fail: (e: Error) => void = () => {};
    const late = new Promise<string>((_, reject) => (fail = reject));
    void settleAccepted([Promise.reject(new Error("auth-required")), late], 1000).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBeUndefined();
    fail(new Error("timeout"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled?.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("resolves at once when every relay answered", async () => {
    expect(await settleAccepted([Promise.resolve(1), Promise.reject(new Error("no"))])).toHaveLength(2);
    expect(await settleAccepted([])).toEqual([]);
  });
});
