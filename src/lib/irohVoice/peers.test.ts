import { describe, expect, it } from "vitest";

import type { VoicePresenceFold } from "@/concord/lib/voice";
import { peerViews, presenceFlags, wantedFrom } from "@/lib/irohVoice/peers";

const fold: VoicePresenceFold = {
  present: [{ author: "armada", identity: "id", screenShareIdentities: [], hand: false, recording: false, noRecord: false, alsoOn: "iroh", camera: true, ms: 1 }],
  claims: new Map(),
  otherTransport: [
    { author: "vector", transport: "iroh", screen: true, ms: 2 },
    { author: "hushed", transport: "iroh", muted: true, ms: 3 },
    { author: "silenced", transport: "iroh", serverMuted: true, camera: true, ms: 4 },
  ],
};

describe("the peer-to-peer members as the call shows them", () => {
  it("reads mute and what each sends off their presence, a moderator's mute included", () => {
    expect(presenceFlags(fold, "vector")).toEqual({ muted: false, sending: { camera: false, screen: true } });
    expect(presenceFlags(fold, "armada")).toEqual({ muted: false, sending: { camera: true, screen: false } });
    expect(presenceFlags(fold, "hushed").muted).toBe(true);
    expect(presenceFlags(fold, "silenced").muted).toBe(true);
    expect(presenceFlags(fold, "gone")).toEqual({ muted: false, sending: { camera: false, screen: false } });
  });

  it("asks only for the pictures a member sends and may show here", () => {
    expect(wantedFrom(fold, "vector", true)).toEqual({ camera: false, screen: true });
    expect(wantedFrom(fold, "silenced", false)).toEqual({ camera: false, screen: false });
  });

  it("shows who is talking, never a muted member, and the pictures that arrived", () => {
    const track = { id: "t" } as MediaStreamTrack;
    const views = peerViews(
      [{ author: "vector", endpoint: "e1" }, { author: "hushed", endpoint: "e2" }],
      fold,
      new Set(["e1", "e2"]),
      (endpoint, kind) => (endpoint === "e1" && kind === "screen" ? track : undefined),
    );
    expect(views).toEqual([
      { pubkey: "vector", endpoint: "e1", speaking: true, muted: false, sending: { camera: false, screen: true }, screen: track },
      { pubkey: "hushed", endpoint: "e2", speaking: false, muted: true, sending: { camera: false, screen: false } },
    ]);
  });
});
