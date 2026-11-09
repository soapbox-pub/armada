import { describe, expect, it } from "vitest";

import type { VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";

import { recordableSources, type PolicyParticipant } from "./policy";

const track = (id: string, readyState: MediaStreamTrackState = "live") =>
  ({ id, readyState }) as MediaStreamTrack;

// Concord-shaped: identities resolve only through a (fake) presence fold.
const claims: Record<string, { pubkey: string; role?: "member" | "screen-share" }> = {
  "id-me": { pubkey: "me" },
  "id-ana": { pubkey: "ana" },
  "id-ben": { pubkey: "ben" },
  "id-ben-2": { pubkey: "ben" },
  "id-hevc": { pubkey: "ana", role: "screen-share" },
};
const resolve: VoiceIdentityResolver = (identity) => {
  const claim = claims[identity];
  return claim
    ? { pubkey: claim.pubkey, verified: true, role: claim.role ?? "member" }
    : { pubkey: identity, verified: false, role: "member" };
};
const titleOf = (pubkey: string) => pubkey.toUpperCase();

const p = (identity: string, micTrack?: MediaStreamTrack, isLocal = false): PolicyParticipant => ({
  identity,
  isLocal,
  micTrack,
});

describe("recordableSources", () => {
  it("records verified members with a microphone, keyed by pubkey", () => {
    const sources = recordableSources(
      [p("id-me", track("t-me"), true), p("id-ana", track("t-ana"))],
      resolve,
      new Set(),
      titleOf,
    );
    expect(sources.map((s) => [s.key, s.title, s.track.id])).toEqual([
      ["me", "ME", "t-me"],
      ["ana", "ANA", "t-ana"],
    ]);
  });

  it("never records anyone who refuses, including ourselves", () => {
    const sources = recordableSources(
      [p("id-me", track("t-me"), true), p("id-ana", track("t-ana")), p("id-ben", track("t-ben"))],
      resolve,
      new Set(["ana", "me"]),
      titleOf,
    );
    expect(sources.map((s) => s.key)).toEqual(["ben"]);
  });

  it("never records an unverified participant (no presence yet, so no way to know if they refuse)", () => {
    expect(recordableSources([p("id-stranger", track("t-x"))], resolve, new Set(), titleOf)).toEqual([]);
  });

  it("skips screen-share sidecars, missing or ended tracks, and empty identities", () => {
    const sources = recordableSources(
      [
        p("id-hevc", track("t-h")),
        p("id-ana"),
        p("id-ben", track("t-b", "ended")),
        p("", track("t-empty")),
      ],
      resolve,
      new Set(),
      titleOf,
    );
    expect(sources).toEqual([]);
  });

  it("takes one track per person", () => {
    const sources = recordableSources(
      [p("id-ben", track("t-1")), p("id-ben-2", track("t-2"))],
      resolve,
      new Set(),
      titleOf,
    );
    expect(sources.map((s) => s.track.id)).toEqual(["t-1"]);
  });

  it("records nobody the call doesn't hear, whatever their client keeps sending", () => {
    const sources = recordableSources(
      [p("id-me", track("t-me"), true), p("id-ana", track("t-ana")), p("id-ben", track("t-ben"))],
      resolve,
      new Set(),
      titleOf,
      (pubkey) => pubkey !== "ana",
    );
    expect(sources.map((s) => s.key)).toEqual(["me", "ben"]);
  });
});
