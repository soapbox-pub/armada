import { describe, expect, it } from "vitest";

import { parseAuthorEvent } from "@/lib/authorCache";

const kind0 = (content: Record<string, unknown>) => ({
  id: "a".repeat(64), pubkey: "b".repeat(64), created_at: 1, kind: 0, tags: [], content: JSON.stringify(content),
});

describe("parseAuthorEvent", () => {
  it("keeps a bare-domain NIP-05 and a name@domain one, and drops one that is neither", () => {
    expect(parseAuthorEvent(kind0({ name: "a", nip05: "Example.com" })).metadata?.nip05).toBe("Example.com");
    expect(parseAuthorEvent(kind0({ nip05: "alice@example.com" })).metadata?.nip05).toBe("alice@example.com");
    const bad = parseAuthorEvent(kind0({ name: "a", nip05: "not an address" }));
    expect(bad.metadata?.name).toBe("a");
    expect(bad.metadata?.nip05).toBeUndefined();
  });
});
