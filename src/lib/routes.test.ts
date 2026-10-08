import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { parseDmRouteParam } from "./dmConversation";
import {
  type ChatRoute,
  chatRoute,
  parseChatRoute,
  roomPath,
  withoutMessage,
} from "./routes";

/** The `:peer` param a path parses to, for feeding back to the DM parser. */
function dmPeerOf(path: string): string | undefined {
  const route = parseChatRoute(path);
  return route?.kind === "dm" ? route.peer : undefined;
}

/** Every legal shape, as the pair the builder and parser must agree on. */
const ROUNDTRIPS: Array<[ChatRoute, string]> = [
  // NIP-29 / Buzz.
  [{ kind: "nip29", relayUrl: "wss://relay.example" }, "/s/relay.example"],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", pane: "inbox" },
    "/s/relay.example/inbox",
  ],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc" },
    "/s/relay.example/abc",
  ],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc", messageId: "m1" },
    "/s/relay.example/abc/m/m1",
  ],
  [
    { kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc", threadRoot: "r1" },
    "/s/relay.example/abc/t/r1",
  ],
  [
    {
      kind: "nip29",
      relayUrl: "wss://relay.example",
      groupId: "abc",
      threadRoot: "r1",
      messageId: "m1",
    },
    "/s/relay.example/abc/t/r1/m/m1",
  ],
  // Concord.
  [{ kind: "concord", communityId: "c" }, "/c/c"],
  [
    { kind: "concord", communityId: "c", pane: "mentions" },
    "/c/c/mentions",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch" },
    "/c/c/ch",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch", messageId: "m1" },
    "/c/c/ch/m/m1",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch", threadRoot: "r1" },
    "/c/c/ch/t/r1",
  ],
  [
    { kind: "concord", communityId: "c", channelId: "ch", threadRoot: "r1", messageId: "m1" },
    "/c/c/ch/t/r1/m/m1",
  ],
  // DMs.
  [{ kind: "dm" }, "/dm"],
  [{ kind: "dm", peer: "npub1abc" }, "/dm/npub1abc"],
  [
    { kind: "dm", peer: "npub1abc", messageId: "m1" },
    "/dm/npub1abc/m/m1",
  ],
];

describe("chatRoute / parseChatRoute", () => {
  it.each(ROUNDTRIPS)("builds and parses %o", (route, path) => {
    expect(chatRoute(route)).toBe(path);
    expect(parseChatRoute(path)).toEqual(route);
  });

  it("round-trips a relay URL through the server param", () => {
    for (const relayUrl of ["wss://relay.example", "ws://localhost:4036"]) {
      const path = chatRoute({ kind: "nip29", relayUrl, groupId: "g" });
      expect(parseChatRoute(path)).toEqual({ kind: "nip29", relayUrl, groupId: "g" });
    }
  });

  it("percent-encodes ids that would otherwise break out of their segment", () => {
    const path = chatRoute({ kind: "nip29", relayUrl: "wss://relay.example", groupId: "a/b" });
    expect(path).toBe("/s/relay.example/a%2Fb");
    expect(parseChatRoute(path)).toEqual({
      kind: "nip29",
      relayUrl: "wss://relay.example",
      groupId: "a/b",
    });
  });

  it("resolves a pane word ahead of a room id, as the router does", () => {
    // A NIP-29 group may legitimately be named `inbox`; the static route wins,
    // so the parser must agree with what actually renders rather than with
    // what was intended.
    expect(parseChatRoute("/s/relay.example/inbox")).toEqual({
      kind: "nip29",
      relayUrl: "wss://relay.example",
      pane: "inbox",
    });
    // Concord channel ids are hex, so no such collision exists there.
    expect(parseChatRoute("/c/c/members")).toEqual({
      kind: "concord",
      communityId: "c",
      pane: "members",
    });
  });

  it("parses the pre-rename /dms path so a stale link still reports as a DM", () => {
    expect(parseChatRoute("/dms/npub1abc")).toEqual({ kind: "dm", peer: "npub1abc" });
  });

  /**
   * A DM route has ONE spelling, whichever form the caller happens to hold.
   *
   * Callers hold the conversation key in whatever their layer speaks — the
   * store and the wire folds carry hex, the DM page carries `dmRouteParam`'s
   * npubs — and a route string is used as an identity elsewhere (the share
   * stash is keyed by the destination path, a Direct Share shortcut is
   * published under one, the sent-rooms ledger records one). Two spellings
   * meant a share routed to `/dm/<hex>` was never claimed by the composer
   * declaring itself at `/dm/<npub>`.
   */
  it("spells a DM peer as an npub whichever form it is given", () => {
    const hex = "a1".repeat(32);
    const npub = nip19.npubEncode(hex);

    expect(chatRoute({ kind: "dm", peer: hex })).toBe(`/dm/${npub}`);
    expect(chatRoute({ kind: "dm", peer: npub })).toBe(`/dm/${npub}`);
    // Idempotent, so a path may be re-emitted through the builder safely.
    expect(chatRoute({ kind: "dm", peer: hex, messageId: "m1" })).toBe(`/dm/${npub}/m/m1`);
    // Both forms still parse, so links already in the wild keep resolving.
    expect(parseDmRouteParam(dmPeerOf(`/dm/${hex}`))).toBe(hex);
    expect(parseDmRouteParam(dmPeerOf(`/dm/${npub}`))).toBe(hex);
  });

  it("encodes each participant of a group DM, keeping the separator literal", () => {
    const a = "a1".repeat(32);
    const b = "b2".repeat(32);
    const path = chatRoute({ kind: "dm", peer: `${a},${b}` });

    expect(path).toBe(`/dm/${nip19.npubEncode(a)},${nip19.npubEncode(b)}`);
    expect(path).not.toContain("%2C");
    expect(parseDmRouteParam(dmPeerOf(path))).toBe(`${a},${b}`);
  });

  it("passes a segment that is not a pubkey through unchanged", () => {
    // A malformed key must still produce a path that round-trips, rather than
    // being dropped or mangled into something that names a different room.
    for (const peer of ["npub1abc", "not a pubkey", "zz".repeat(32)]) {
      const path = chatRoute({ kind: "dm", peer });
      expect(parseChatRoute(path)).toEqual({ kind: "dm", peer });
    }
  });

  it("rejects shapes that name no location", () => {
    for (const path of [
      "/",
      "/settings",
      "/invite/naddr1xyz",
      "/s",
      "/c",
      "/c1",
      // A marker that isn't `t` or `m`.
      "/c/c/ch/x/1",
      // `/m` before `/t`: a message is focused *within* a thread, not before it.
      "/c/c/ch/m/m1/t/r1",
      // Odd trailing segment.
      "/c/c/ch/t",
      // DMs have no thread panel.
      "/dm/npub1abc/t/r1",
    ]) {
      expect(parseChatRoute(path), path).toBeNull();
    }
  });
});

describe("roomPath", () => {
  it("drops thread and message focus, keeping the room", () => {
    expect(
      roomPath({
        kind: "concord",
        communityId: "c",
        channelId: "ch",
        threadRoot: "r1",
        messageId: "m1",
      }),
    ).toBe("/c/c/ch");
    expect(
      roomPath({ kind: "nip29", relayUrl: "wss://relay.example", groupId: "g", messageId: "m1" }),
    ).toBe("/s/relay.example/g");
    expect(roomPath({ kind: "dm", peer: "npub1abc", messageId: "m1" })).toBe("/dm/npub1abc");
  });
});

describe("withoutMessage", () => {
  it("drops the message focus but keeps an open thread", () => {
    // Giving up on an unresolvable reply must not close the panel the reader
    // is looking at.
    expect(
      chatRoute(
        withoutMessage({
          kind: "concord",
          communityId: "c",
          channelId: "ch",
          threadRoot: "r1",
          messageId: "m1",
        }),
      ),
    ).toBe("/c/c/ch/t/r1");
    expect(
      chatRoute(
        withoutMessage({
          kind: "nip29",
          relayUrl: "wss://relay.example",
          groupId: "g",
          messageId: "m1",
        }),
      ),
    ).toBe("/s/relay.example/g");
    expect(chatRoute(withoutMessage({ kind: "dm", peer: "npub1abc", messageId: "m1" }))).toBe(
      "/dm/npub1abc",
    );
  });

  it("leaves a location with no message focus alone", () => {
    const route: ChatRoute = { kind: "concord", communityId: "c", channelId: "ch" };
    expect(chatRoute(withoutMessage(route))).toBe(chatRoute(route));
  });
});
