import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";

import { deleteBlobs } from "@/lib/blossomDelete";

const sk = generateSecretKey();
const signer = {
  getPublicKey: async () => getPublicKey(sk),
  signEvent: vi.fn(async (t: EventTemplate) => finalizeEvent(t, sk)),
};

describe("deleteBlobs (BUD-02)", () => {
  it("asks each blob's server to delete it under one token naming every hash, over https only", async () => {
    const [a, b] = ["a".repeat(64), "b".repeat(64)];
    const calls: { url: string; method?: string; auth?: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.authorization });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const done = await deleteBlobs(signer as never, [`https://one.test/${a}.png`, `https://two.test/${b}`, `http://plain.test/${a}`, "not a url"], fetcher);
    expect(done).toBe(2);
    expect(calls.map((c) => [c.method, c.url]).sort()).toEqual([["DELETE", `https://one.test/${a}`], ["DELETE", `https://two.test/${b}`]]);
    expect(signer.signEvent).toHaveBeenCalledTimes(1);
    const token = signer.signEvent.mock.calls[0][0];
    expect(token.kind).toBe(24242);
    expect(token.tags).toContainEqual(["t", "delete"]);
    expect(token.tags.filter((t: string[]) => t[0] === "x").map((t: string[]) => t[1]).sort()).toEqual([a, b]);
    expect(calls[0].auth).toMatch(/^Nostr /);
  });
});
