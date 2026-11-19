import { afterEach, describe, expect, it, vi } from "vitest";

import { setActivePubkey } from "@/lib/activeAccount";
import { _resetLastChannelsForTests, getLastChannels, rememberLastChannel } from "@/lib/lastChannel";

describe("lastChannel", () => {
  afterEach(() => {
    _resetLastChannelsForTests();
    setActivePubkey(null);
    localStorage.clear();
  });

  it("remembers per account, keeps the map's identity until it changes, and persists", () => {
    setActivePubkey("a".repeat(64));
    rememberLastChannel("c:one", "ch1");
    const first = getLastChannels();
    rememberLastChannel("c:one", "ch1");
    expect(getLastChannels()).toBe(first);
    rememberLastChannel("wss://relay.test", "group");
    expect(getLastChannels()).toEqual({ "c:one": "ch1", "wss://relay.test": "group" });

    setActivePubkey("b".repeat(64));
    expect(getLastChannels()).toEqual({});

    _resetLastChannelsForTests();
    setActivePubkey("a".repeat(64));
    expect(getLastChannels()).toEqual({ "c:one": "ch1", "wss://relay.test": "group" });
  });

  it("reads an unreadable entry as nothing remembered", () => {
    setActivePubkey("c".repeat(64));
    localStorage.setItem(`armada:last-channel:${"c".repeat(64)}`, "{not json");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(getLastChannels()).toEqual({});
  });
});
