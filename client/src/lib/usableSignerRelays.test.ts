import { describe, expect, it } from "vitest";

import { usableSignerRelays } from "@/lib/platform";

describe("usableSignerRelays", () => {
  const mixed = [
    "wss://relay.ditto.pub",
    "ws://localhost:5577",
    "wss://relay.dreamith.to",
    "ws://192.168.1.5:5577",
  ];

  it("drops ws:// relays on secure origins (https deployments, the APK WebView)", () => {
    expect(usableSignerRelays(mixed, false)).toEqual([
      "wss://relay.ditto.pub",
      "wss://relay.dreamith.to",
    ]);
  });

  it("keeps ws:// relays on insecure origins (plain-http local dev)", () => {
    expect(usableSignerRelays(mixed, true)).toEqual(mixed);
  });

  it("can return an empty list when nothing is usable — a dead pairing is not better", () => {
    expect(usableSignerRelays(["ws://localhost:5577"], false)).toEqual([]);
  });
});
