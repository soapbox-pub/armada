import { afterEach, describe, expect, it, vi } from "vitest";

import { ignoreEcho, subscribeEphemeral } from "@/concord/lib/ephemeralSub";

import type { NostrEvent } from "@nostrify/nostrify";

/** A relay whose live tail yields what the test pushes into it. */
function fakeRelay() {
  const queue: unknown[][] = [];
  let wake: (() => void) | undefined;
  const nostr = {
    relay: () => ({
      async *req(_filters: unknown, opts?: { signal?: AbortSignal }) {
        while (!opts?.signal?.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          while (queue.length > 0) yield queue.shift()!;
        }
      },
    }),
  };
  return {
    nostr,
    push(event: Partial<NostrEvent>) {
      queue.push(["EVENT", "sub", event]);
      wake?.();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("subscribeEphemeral", () => {
  afterEach(() => vi.useRealTimers());

  it("drops the echo of a wrap this client published, delivering the rest", async () => {
    vi.useFakeTimers();
    const relay = fakeRelay();
    const handler = vi.fn();
    const unsub = subscribeEphemeral(relay.nostr, "wss://echo.test", "stream", handler);
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();

    ignoreEcho("mine");
    relay.push({ id: "mine", pubkey: "stream" });
    relay.push({ id: "theirs", pubkey: "stream" });
    await settle();

    expect(handler.mock.calls.map(([event]) => event.id)).toEqual(["theirs"]);
    unsub();
  });
});
