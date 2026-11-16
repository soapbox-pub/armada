import { describe, expect, it, vi } from "vitest";

import { publishDurable, quorum } from "./quorum";

const never = () => new Promise<never>(() => undefined);
const after = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe("quorum (Vector QUORUM_GRACE_MS)", () => {
  it("settles on a majority, without waiting on a relay that never answers", async () => {
    const started = Date.now();
    const got = await quorum([after(10, "a"), never(), after(30, "b")], 5_000);
    expect(got).toEqual(["a", undefined, "b"]);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("waits the grace after the first answer when no majority answers", async () => {
    const started = Date.now();
    const got = await quorum([after(10, "a"), never(), never()], 100);
    expect(got).toEqual(["a", undefined, undefined]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("settles at once when every relay has answered, failures included", async () => {
    const started = Date.now();
    expect(await quorum([after(5, 1), Promise.reject(new Error("down"))], 5_000)).toEqual([1, undefined]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("publishDurable (Vector publish_durable)", () => {
  it("keeps a relay going until it takes the event, and resolves on the first that does", async () => {
    vi.useFakeTimers();
    try {
      const calls: Record<string, number> = { a: 0, b: 0 };
      const nostr = {
        relay: (url: string) => ({
          event: async () => {
            calls[url]++;
            if (url === "a" && calls.a < 3) throw new Error("rate-limited: slow down");
            if (url === "b") throw new Error("invalid: bad signature");
          },
        }),
      };
      const done = publishDurable(nostr, ["a", "b"], {});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await done).toEqual(["a"]);
      expect(calls.a).toBe(3);
      // A relay that calls the event invalid isn't asked again.
      expect(calls.b).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when no relay takes it", async () => {
    const nostr = { relay: () => ({ event: async () => Promise.reject(new Error("invalid: nope")) }) };
    await expect(publishDurable(nostr, ["a", "b"], {})).rejects.toThrow("invalid: nope");
  });
});
