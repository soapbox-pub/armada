import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { closeDmEphemeralSubs, LINGER_MS, subscribeDmEphemeral } from "./ephemeralInbox";

/** A fake pool: records every REQ and lets a test push EVENTs into it. */
function fakeNostr() {
  const reqs: { relay: string; filters: NostrFilter[]; signal?: AbortSignal; push: (e: NostrEvent) => void }[] = [];
  const nostr = {
    relay(relay: string) {
      return {
        req(filters: NostrFilter[], opts?: { signal?: AbortSignal }): AsyncIterable<unknown[]> {
          const queue: unknown[][] = [];
          let wake: (() => void) | undefined;
          const entry = {
            relay,
            filters,
            signal: opts?.signal,
            push: (e: NostrEvent) => {
              queue.push(["EVENT", "sub", e]);
              wake?.();
            },
          };
          reqs.push(entry);
          return {
            async *[Symbol.asyncIterator]() {
              while (!opts?.signal?.aborted) {
                if (queue.length) {
                  yield queue.shift()!;
                  continue;
                }
                await new Promise<void>((r) => {
                  wake = r;
                  opts?.signal?.addEventListener("abort", () => r(), { once: true });
                });
              }
            },
          };
        },
      };
    },
  };
  return { nostr, reqs };
}

const wrap = (id: string) => ({ id, kind: 21059 }) as NostrEvent;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("subscribeDmEphemeral", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    closeDmEphemeralSubs();
    vi.useRealTimers();
  });

  it("keeps one REQ per relay across a consumer switch", () => {
    const { nostr, reqs } = fakeNostr();
    const first = subscribeDmEphemeral(nostr, "wss://a", "me", () => {});
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.filters[0]).toMatchObject({ kinds: [21059], "#p": ["me"] });

    // Unmount the old conversation, mount the next: no new REQ, no abort.
    first();
    subscribeDmEphemeral(nostr, "wss://a", "me", () => {});
    vi.advanceTimersByTime(LINGER_MS * 2);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.signal?.aborted).toBe(false);
  });

  it("closes the REQ once the last consumer has been gone for the linger", () => {
    const { nostr, reqs } = fakeNostr();
    const unsub = subscribeDmEphemeral(nostr, "wss://a", "me", () => {});
    unsub();
    vi.advanceTimersByTime(LINGER_MS - 1);
    expect(reqs[0]!.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reqs[0]!.signal?.aborted).toBe(true);

    subscribeDmEphemeral(nostr, "wss://a", "me", () => {});
    expect(reqs).toHaveLength(2);
  });

  it("delivers a wrap carried by several relays once", async () => {
    vi.useRealTimers();
    const { nostr, reqs } = fakeNostr();
    const seen: string[] = [];
    const handler = (e: NostrEvent) => seen.push(e.id);
    subscribeDmEphemeral(nostr, "wss://a", "me", handler);
    subscribeDmEphemeral(nostr, "wss://b", "me", handler);
    reqs[0]!.push(wrap("w1"));
    reqs[1]!.push(wrap("w1"));
    reqs[1]!.push(wrap("w2"));
    await flush();
    expect(seen).toEqual(["w1", "w2"]);
  });

  it("keys lines by recipient", () => {
    const { nostr, reqs } = fakeNostr();
    subscribeDmEphemeral(nostr, "wss://a", "me", () => {});
    subscribeDmEphemeral(nostr, "wss://a", "other", () => {});
    expect(reqs.map((r) => r.filters[0]!["#p"])).toEqual([["me"], ["other"]]);
  });

  it("closeDmEphemeralSubs aborts every line immediately", () => {
    const { nostr, reqs } = fakeNostr();
    subscribeDmEphemeral(nostr, "wss://a", "me", () => {});
    closeDmEphemeralSubs();
    expect(reqs[0]!.signal?.aborted).toBe(true);
  });
});

describe("openDmEphemeral", () => {
  afterEach(() => closeDmEphemeralSubs());

  it("asks the signer once per wrap, whoever asks and however often", async () => {
    const { openDmEphemeral } = await import("./ephemeralInbox");
    const decrypt = vi.fn(async () => {
      throw new Error("declined");
    });
    const signer = { nip44: { encrypt: vi.fn(), decrypt } } as never;
    const wrap = { id: "w1", kind: 21059, pubkey: "p".repeat(64), content: "x", tags: [], created_at: Math.floor(Date.now() / 1000), sig: "" } as NostrEvent;
    await Promise.all([openDmEphemeral(wrap, signer, "me"), openDmEphemeral(wrap, signer, "me")]);
    await openDmEphemeral(wrap, signer, "me");
    expect(decrypt).toHaveBeenCalledTimes(1);
    closeDmEphemeralSubs();
    await openDmEphemeral(wrap, signer, "me");
    expect(decrypt).toHaveBeenCalledTimes(2);
  });
});
