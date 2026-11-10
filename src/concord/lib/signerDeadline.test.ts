import { afterEach, describe, expect, it, vi } from "vitest";

import { SignerTimeoutError, withSignerDeadline, LOCKED_SIGN_DEADLINE_MS } from "./signerDeadline";
import { withControlWrite } from "@/concord/hooks/useControlPlane";

afterEach(() => {
  vi.useRealTimers();
});

describe("withSignerDeadline", () => {
  it("gives up on a signer that never answers, and frees the community's write lock with it", async () => {
    vi.useFakeTimers();
    const silent = new Promise<never>(() => {});
    const first = withControlWrite("c".repeat(64), () => withSignerDeadline(silent, "no answer"));
    const second = withControlWrite("c".repeat(64), async () => "ran");
    const failed = expect(first).rejects.toBeInstanceOf(SignerTimeoutError);
    await vi.advanceTimersByTimeAsync(LOCKED_SIGN_DEADLINE_MS);
    await failed;
    await expect(second).resolves.toBe("ran");
  });

  it("passes an answer through untouched", async () => {
    await expect(withSignerDeadline(Promise.resolve(7), "no answer")).resolves.toBe(7);
  });
});
