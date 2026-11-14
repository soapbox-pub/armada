// @vitest-environment jsdom
/**
 * Tests for the quick-reaction frequency table.
 *
 * This backs the one-click row on a message's action toolbar, so the ordering
 * rules matter: the row should converge on what the user actually reacts with,
 * stay full-width for a brand-new account, and never grow without bound.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getFrequentReactions,
  hydrateFrequentReactions,
  quickReactionRow,
  recordReaction,
  resetFrequentReactionsCache,
  subscribeFrequentReactions,
  useFrequentReactions,
} from "@/hooks/useFrequentReactions";

const SELF = "a".repeat(64);
const KEY = `armada:frequent-reactions:${SELF}`;

function keys(limit = 3): string[] {
  const { result } = renderHook(() => useFrequentReactions(SELF, limit));
  return result.current.map((e) => e.key);
}

beforeEach(() => {
  localStorage.clear();
  resetFrequentReactionsCache();
});

describe("useFrequentReactions", () => {
  it("fills the row with defaults for an account that has never reacted", () => {
    expect(keys()).toEqual(["👍", "❤️", "😂"]);
  });

  it("ranks by use count, most-used first", () => {
    act(() => {
      recordReaction(SELF, "🎉");
      recordReaction(SELF, "🚀");
      recordReaction(SELF, "🚀");
    });
    expect(keys().slice(0, 2)).toEqual(["🚀", "🎉"]);
  });

  it("pads with defaults it hasn't already listed, without duplicating them", () => {
    act(() => recordReaction(SELF, "❤️"));
    // ❤️ is both earned and a default: it must appear once, at the top.
    expect(keys()).toEqual(["❤️", "👍", "😂"]);
  });

  it("keeps custom emoji with their image URL", () => {
    act(() => recordReaction(SELF, ":cat:", "https://e/cat.png"));
    const { result } = renderHook(() => useFrequentReactions(SELF, 3));
    expect(result.current[0]).toMatchObject({ key: ":cat:", url: "https://e/cat.png" });
  });

  it("keeps the emoji-mart id for composer picker favorites", () => {
    act(() => recordReaction(SELF, "🔥", undefined, "fire"));
    expect(getFrequentReactions(SELF)[0]).toMatchObject({ key: "🔥", pickerId: "fire" });
    expect(JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "{}")).toEqual({ fire: 1 });
  });

  it("keeps a custom favorite's shortcode, and hands emoji-mart its prefixed id", () => {
    act(() => recordReaction(SELF, ":heart:", "https://e/heart.png", "heart"));
    expect(getFrequentReactions(SELF)[0]).toMatchObject({ key: ":heart:", pickerId: "heart" });
    expect(JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "{}")).toEqual({ "custom:heart": 1 });
  });

  it("re-renders subscribers when a reaction is recorded", () => {
    const { result } = renderHook(() => useFrequentReactions(SELF, 3));
    expect(result.current[0].key).toBe("👍");
    act(() => {
      recordReaction(SELF, "🔥");
      recordReaction(SELF, "🔥");
    });
    expect(result.current[0].key).toBe("🔥");
  });

  it("persists across a reload", () => {
    act(() => recordReaction(SELF, "🔥"));
    resetFrequentReactionsCache(); // simulate a fresh page load
    expect(keys()[0]).toBe("🔥");
  });

  it("caps what it stores so the table can't grow without bound", () => {
    act(() => {
      for (let i = 0; i < 40; i++) recordReaction(SELF, `e${i}`);
    });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    expect(stored.length).toBeLessThanOrEqual(32);
  });

  it("ignores a signed-out user rather than writing a stray table", () => {
    act(() => recordReaction(undefined, "🔥"));
    expect(localStorage.length).toBe(0);
  });
});

describe("useFrequentReactions — cross-device merge", () => {
  it("takes the higher count per emoji rather than the remote's", () => {
    act(() => {
      recordReaction(SELF, "🔥");
      recordReaction(SELF, "🔥");
      recordReaction(SELF, "🔥");
    });
    // A device that has been offline since the first use must not reset it.
    act(() => hydrateFrequentReactions(SELF, [{ key: "🔥", count: 1, usedAt: 1 }]));
    const stored = getFrequentReactions(SELF);
    expect(stored.find((e) => e.key === "🔥")?.count).toBe(3);
  });

  it("adopts emoji only the other device has used", () => {
    act(() => recordReaction(SELF, "🔥"));
    act(() =>
      hydrateFrequentReactions(SELF, [
        { key: ":cat:", url: "https://e/cat.png", count: 9, usedAt: 500 },
      ]),
    );
    expect(keys()[0]).toBe(":cat:");
    expect(getFrequentReactions(SELF).find((e) => e.key === ":cat:")?.url).toBe(
      "https://e/cat.png",
    );
  });

  it("hydrates composer emoji favorites into emoji-mart's picker store", () => {
    act(() =>
      hydrateFrequentReactions(SELF, [
        { key: "🚀", pickerId: "rocket", count: 7, usedAt: 500 },
      ]),
    );
    expect(JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "{}")).toEqual({ rocket: 7 });
  });

  it("does not report a hydrate as a local change", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeFrequentReactions((pubkey) => seen.push(pubkey));
    act(() => hydrateFrequentReactions(SELF, [{ key: "🔥", count: 4, usedAt: 9 }]));
    expect(seen).toEqual([]);
    // …but a real reaction is reported, so the sync knows to publish.
    act(() => recordReaction(SELF, "🔥"));
    expect(seen).toEqual([SELF]);
    unsubscribe();
  });

  it("stays capped after merging a large remote table", () => {
    act(() => {
      for (let i = 0; i < 20; i++) recordReaction(SELF, `local${i}`);
    });
    act(() =>
      hydrateFrequentReactions(
        SELF,
        Array.from({ length: 40 }, (_, i) => ({ key: `remote${i}`, count: 5, usedAt: i })),
      ),
    );
    expect(getFrequentReactions(SELF).length).toBeLessThanOrEqual(32);
  });
});

describe("quickReactionRow", () => {
  const used = (key: string, count: number, url?: string) => ({ key, url, count, usedAt: 0 });

  it("puts pinned reactions first, in their order, then the most-used", () => {
    const row = quickReactionRow([used("🔥", 9), used("🚀", 5)], [{ key: "🐸" }, { key: "🙏" }], 4);
    expect(row).toEqual([
      { key: "🐸", pinned: true },
      { key: "🙏", pinned: true },
      { key: "🔥", pinned: false },
      { key: "🚀", pinned: false },
    ]);
  });

  it("lists a pinned reaction that is also most-used once, as pinned", () => {
    const row = quickReactionRow([used("🔥", 9)], [{ key: "🐸" }, { key: "🔥" }], 3);
    expect(row.map((s) => [s.key, s.pinned])).toEqual([["🐸", true], ["🔥", true], ["👍", false]]);
  });

  it("cuts the pins to the row length", () => {
    const row = quickReactionRow([], [{ key: "a" }, { key: "b" }, { key: "c" }], 2);
    expect(row.map((s) => s.key)).toEqual(["a", "b"]);
  });

  it("keeps a pinned custom emoji's image", () => {
    const [slot] = quickReactionRow([], [{ key: ":cat:", url: "https://e/cat.png" }], 1);
    expect(slot).toEqual({ key: ":cat:", url: "https://e/cat.png", pinned: true });
  });
});
