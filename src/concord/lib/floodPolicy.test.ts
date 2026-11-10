import { describe, expect, it } from "vitest";

import { floodClusters, floodPolicy } from "@/concord/lib/floodCluster";
import { KIND_MESSAGE } from "@/concord/lib/kinds";

import type { OpenedChat } from "@/concord/lib/chat";

const T0 = 1_800_000_000_000;
let seq = 0;
function msg(author: string, content: string, ms: number, tags: string[][] = []): OpenedChat {
  seq++;
  return {
    rumorId: seq.toString(16).padStart(64, "0"),
    author,
    kind: KIND_MESSAGE,
    content,
    ms,
    tags,
    channelIdHex: "c".repeat(64),
  } as OpenedChat;
}
const key = (i: number) => i.toString(16).padStart(64, "a");
const PROXY = ["proxy", "https://discord.com/channels/1/2/3", "web"];

/** A bridge relinking: a dozen puppet keys, each new, posting its own line within a minute. */
function relink(tags: string[][] = [PROXY]): OpenedChat[] {
  const regular = msg(key(99), "anyone around tonight", T0 - 3_600_000);
  const lines = [
    "the mirroring bot spams the server every time i relink it up",
    "or no that's odd", "nvm i was just seeing the old message pop up",
    "patch notes are out for the new season", "who is up for raids later",
    "my cat knocked the router off the shelf again", "did anyone try the new map",
    "lunch was terrible today honestly", "the release fixed my audio problem",
    "anyone have a spare key for the beta", "ok heading out now see you all",
    "thanks for the help earlier everyone",
  ];
  return [regular, ...lines.map((line, i) => msg(key(i), line, T0 + i * 3000, tags))];
}

describe("flood policy", () => {
  it("standard folds a crowd of new keys arriving at once; relaxed judges content only", () => {
    const batch = relink();
    expect(floodClusters(batch).size).toBeGreaterThan(0);
    expect(floodClusters(batch, { policy: floodPolicy("relaxed") }).size).toBe(0);
  });

  it("leaves bridged messages out of judgement when the reader says so", () => {
    const batch = relink();
    expect(floodClusters(batch, { policy: floodPolicy("standard", true) }).size).toBe(0);
    // Untagged, the same crowd still folds under the same policy.
    expect(floodClusters(relink([]), { policy: floodPolicy("standard", true) }).size).toBeGreaterThan(0);
  });

  it("strict folds a shorter repeat run than standard", () => {
    const run = Array.from({ length: 6 }, (_, i) => msg(key(i % 2), "buy cheap followers here now", T0 + i * 1000));
    expect(floodClusters(run).size).toBe(0);
    expect(floodClusters(run, { policy: floodPolicy("strict") }).size).toBe(6);
  });

  it("interns policies so they are stable dependencies", () => {
    expect(floodPolicy("strict", true)).toBe(floodPolicy("strict", true));
    expect(floodPolicy()).not.toBe(floodPolicy("strict"));
  });
});
