import { describe, expect, it, vi } from "vitest";

import { activateScope, activeScopeId, isScopeActivated, onActivation } from "@/wire/activation";

describe("activateScope", () => {
  it("notifies a first activation only, while still tracking the active scope", () => {
    const listener = vi.fn();
    const off = onActivation(listener);
    activateScope("c2:aa");
    activateScope("c2:bb");
    expect(listener).toHaveBeenCalledTimes(2);
    // Back and forth between scopes already live: the wire has nothing to rebuild.
    activateScope("c2:aa");
    activateScope("c2:bb");
    activateScope("c2:aa");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(activeScopeId("c2:")).toBe("aa");
    expect(isScopeActivated("c2:bb")).toBe(true);
    off();
  });
});
