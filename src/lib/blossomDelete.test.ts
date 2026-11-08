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
  it("asks each blob's server to delete it under a token scoped to that server and its hashes, over https only", async () => {
    const [a, b, c] = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    const calls: { url: string; method?: string; auth?: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.authorization });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const urls = [`https://One.test/${a}.png`, `https://one.test/${c}`, `https://two.test:8443/${b}`, `http://plain.test/${a}`, "not a url"];
    const done = await deleteBlobs(signer as never, urls, fetcher);
    expect(done).toBe(3);
    expect(calls.map((x) => [x.method, x.url]).sort()).toEqual([
      ["DELETE", `https://one.test/${a}`],
      ["DELETE", `https://one.test/${c}`],
      ["DELETE", `https://two.test:8443/${b}`],
    ]);
    // One signature per server, so a remote signer is asked once per server, not per blob.
    expect(signer.signEvent).toHaveBeenCalledTimes(2);
    const tokens = signer.signEvent.mock.calls.map((call) => call[0]);
    const scope = (t: EventTemplate) => ({
      server: t.tags.filter((x) => x[0] === "server").map((x) => x[1]),
      x: t.tags.filter((x) => x[0] === "x").map((x) => x[1]).sort(),
    });
    expect(tokens.map(scope).sort((p, q) => (p.server[0] < q.server[0] ? -1 : 1))).toEqual([
      { server: ["one.test"], x: [a, c] },
      { server: ["two.test"], x: [b] },
    ]);
    for (const t of tokens) {
      expect(t.kind).toBe(24242);
      expect(t.tags).toContainEqual(["t", "delete"]);
    }
    // No server is handed the token meant for another.
    const authOf = (host: string) => new Set(calls.filter((x) => x.url.includes(host)).map((x) => x.auth));
    expect(authOf("one.test").size).toBe(1);
    expect([...authOf("one.test")][0]).not.toBe([...authOf("two.test")][0]);
    expect(calls[0].auth).toMatch(/^Nostr /);
  });
});
