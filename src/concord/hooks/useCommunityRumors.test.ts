import { describe, expect, it } from "vitest";

import { reuseRows } from "@/concord/hooks/useCommunityRumors";

import type { OpenedChat } from "@/concord/lib/chat";

const row = (rumorId: string): OpenedChat => ({
  rumorId, author: "a", kind: 9, content: rumorId, tags: [], ms: 0, createdAt: 0, channelIdHex: "c", epoch: 0n,
});

describe("reuseRows", () => {
  it("keeps the rows it already held and takes the read's order and new rows", () => {
    const held = [row("1"), row("2")];
    const read = [row("2"), row("1"), row("3")];
    const out = reuseRows(held, read);
    expect(out.map((r) => r.rumorId)).toEqual(["2", "1", "3"]);
    expect(out[0]).toBe(held[1]);
    expect(out[1]).toBe(held[0]);
    expect(out[2]).toBe(read[2]);
  });
});
