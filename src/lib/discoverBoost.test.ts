import { describe, expect, it } from "vitest";

import {
  BOOST_POW_BITS,
  BOOST_WINDOW_SECONDS,
  DISCOVER_LABEL_NAMESPACE,
  LABEL_KIND,
  boostLevel,
  boostsFor,
  buildBoostLabel,
  buildBoostWithdrawal,
  foldBoosts,
} from "./discoverBoost";

import type { NostrRumor } from "@/lib/nostrRumor";

const NOW = 2_000_000_000;
const ALICE = "2".repeat(64);
const BOB = "3".repeat(64);
const LISTING = "e".repeat(64);
const OTHER_LISTING = "f".repeat(64);

let seq = 0;
/** An id with `bits` leading zero bits, unique per call. */
function idWith(bits: number): string {
  const n = (seq++).toString(16).padStart(8, "0");
  const zeros = "0".repeat(Math.floor(bits / 4));
  return (zeros + "f" + n).padEnd(64, "a").slice(0, 64);
}
function boost(pubkey: string, listings = [LISTING], createdAt = NOW - 60, bits = BOOST_POW_BITS + 2): NostrRumor {
  const t = buildBoostLabel(listings);
  return { id: idWith(bits), pubkey, created_at: createdAt, kind: t.kind, tags: t.tags, content: "" };
}
function withdraw(pubkey: string, labels: NostrRumor[]): NostrRumor {
  const t = buildBoostWithdrawal(labels.map((l) => l.id));
  return { id: idWith(0), pubkey, created_at: NOW, kind: t.kind, tags: t.tags, content: "" };
}

describe("boost labels", () => {
  it("label the listings and ask the signer for the work", () => {
    const t = buildBoostLabel([LISTING, LISTING]);
    expect(t.kind).toBe(LABEL_KIND);
    expect(t.tags).toContainEqual(["L", DISCOVER_LABEL_NAMESPACE]);
    expect(t.tags.filter(([n]) => n === "e")).toEqual([["e", LISTING]]);
    expect(t.tags).toContainEqual(["nonce", "", String(BOOST_POW_BITS)]);
  });
});

describe("foldBoosts", () => {
  it("keeps one boost per booster per listing, the newest", () => {
    const folded = foldBoosts([boost(ALICE, [LISTING], NOW - 100), boost(ALICE, [LISTING], NOW - 50), boost(BOB)], NOW);
    const boosts = folded.get(LISTING)!;
    expect(boosts.map((b) => b.pubkey).sort()).toEqual([ALICE, BOB].sort());
    expect(boosts.find((b) => b.pubkey === ALICE)!.event.created_at).toBe(NOW - 50);
  });

  it("drops a boost without the work, or past the window", () => {
    const folded = foldBoosts([boost(ALICE, [LISTING], NOW - 60, BOOST_POW_BITS - 4), boost(BOB, [LISTING], NOW - BOOST_WINDOW_SECONDS - 1)], NOW);
    expect(folded.size).toBe(0);
  });

  it("honours a withdrawal only from the boost's own author", () => {
    const mine = boost(ALICE);
    const theirs = boost(BOB);
    const folded = foldBoosts([mine, theirs, withdraw(ALICE, [mine]), withdraw(ALICE, [theirs])], NOW);
    expect(folded.get(LISTING)!.map((b) => b.pubkey)).toEqual([BOB]);
  });

  it("ignores labels outside the namespace", () => {
    const stray = { ...boost(ALICE), tags: [["L", "other"], ["l", "boost", "other"], ["e", LISTING]] };
    expect(foldBoosts([stray], NOW).size).toBe(0);
  });

  it("counts a booster once across a community's listings", () => {
    const folded = foldBoosts([boost(ALICE, [LISTING, OTHER_LISTING]), boost(BOB, [OTHER_LISTING])], NOW);
    expect(boostsFor(folded, [LISTING, OTHER_LISTING]).map((b) => b.pubkey).sort()).toEqual([ALICE, BOB].sort());
  });
});

describe("boostLevel", () => {
  it("follows Discord's thresholds", () => {
    expect(boostLevel(0)).toEqual({ level: 0, next: 2 });
    expect(boostLevel(2)).toEqual({ level: 1, next: 7 });
    expect(boostLevel(13)).toEqual({ level: 2, next: 14 });
    expect(boostLevel(20)).toEqual({ level: 3, next: undefined });
  });
});
