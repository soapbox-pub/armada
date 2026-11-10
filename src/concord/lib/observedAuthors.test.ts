import { describe, expect, it } from "vitest";

import { completeMemberlist } from "@/concord/lib/guestbook";
import { observedAuthors } from "./observedAuthors";

import type { OpenedChat } from "@/concord/lib/chat";

const rumor = (author: string, ms: number) => ({ author, ms }) as OpenedChat;

describe("observedAuthors", () => {
  it("counts a member who posted only in a channel that isn't open", () => {
    const byChannel = new Map([
      ["general", [rumor("alice", 5_000)]],
      ["off-topic", [rumor("bob", 9_000)]],
    ]);
    const observed = observedAuthors(byChannel, [{ pubkey: "alice", created_at: 3 }]);
    expect(observed).toEqual(new Map([["alice", 5_000], ["bob", 9_000]]));
    // …so the member list holds them whichever channel is open.
    expect(completeMemberlist(new Map(), observed, new Set())).toEqual(new Set(["alice", "bob"]));
  });

  it("keeps the newest sighting, from either source", () => {
    const byChannel = new Map([["general", [rumor("alice", 5_000)]]]);
    expect(observedAuthors(byChannel, [{ pubkey: "alice", created_at: 7 }]).get("alice")).toBe(7_000);
  });

  it("still lets a later Leave win over older activity", () => {
    const observed = observedAuthors(new Map([["general", [rumor("bob", 5_000)]]]), []);
    const left = new Map([["bob", { state: "leave", ms: 6_000 } as never]]);
    expect(completeMemberlist(left, observed, new Set())).toEqual(new Set());
  });
});
