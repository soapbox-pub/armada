import { describe, expect, it } from "vitest";

import { routeOpensBootGate } from "@/lib/bootGateRoute";

describe("routeOpensBootGate", () => {
  it("leaves the gate to pages with a timeline, the DM list and the redirect at /", () => {
    for (const path of ["/", "/c/ab/cd", "/c/ab", "/c/ab/cd/m/ef", "/c/ab/all", "/dm", "/dm/npub1x", "/s/relay.example/group"]) {
      expect(routeOpensBootGate(path), path).toBe(true);
    }
  });

  it("opens it on first paint everywhere else", () => {
    for (const path of ["/notifications", "/settings", "/discover", "/invites", "/npub1someone", "/c/ab/settings"]) {
      expect(routeOpensBootGate(path), path).toBe(false);
    }
  });
});
