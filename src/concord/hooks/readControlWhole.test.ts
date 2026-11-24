/**
 * A whole read of the Control Plane is one or nothing (Vector v0.5.2 `whole_wraps_held`):
 * a sweep cut short by more wraps than a pass reads, or one too few relays answered,
 * is no whole read, and what waits on one acts on none.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sweep: async (_n: unknown, _c: unknown, _o: { onReached?: () => void; onTruncated?: () => void }) => {} }));
vi.mock("@/concord/lib/planeSync", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/planeSync")>()),
  sweepControl: (n: unknown, c: unknown, o: { onReached?: () => void; onTruncated?: () => void }) => h.sweep(n, c, o),
}));

const { readControlWhole } = await import("@/concord/hooks/useControlPlane");
const { heldCommunity, TestCommunity } = await import("@/test/concordEditions");

const community = { ...heldCommunity(new TestCommunity()), relays: ["wss://a", "wss://b", "wss://c"] };

describe("a whole read of the Control Plane", () => {
  it("is none when the sweep held more wraps than a pass reads", async () => {
    h.sweep = async (_n, _c, o) => {
      for (let i = 0; i < 3; i++) o.onReached?.();
      o.onTruncated?.();
    };
    expect(await readControlWhole({} as never, community)).toBeUndefined();
  });

  it("is none when too few relays answered it to the end", async () => {
    h.sweep = async (_n, _c, o) => o.onReached?.();
    expect(await readControlWhole({} as never, community)).toBeUndefined();
    h.sweep = async () => Promise.reject(new Error("relay did not answer"));
    expect(await readControlWhole({} as never, community)).toBeUndefined();
  });
});
