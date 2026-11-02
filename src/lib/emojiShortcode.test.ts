import { beforeAll, describe, expect, it, vi } from "vitest";

import { completedShortcodeAt, findEmojiShortcodeColon, nativeEmojiForShortcode } from "@/lib/emojiShortcode";

describe("before the emoji dataset has loaded", () => {
  it("converts nothing, and an opening colon starts the load", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/emojiShortcode");
    const data = await import("@/lib/emojiData");
    expect(data.emojiData()).toBeUndefined();
    expect(fresh.completedShortcodeAt(":v:", 3)).toBeNull();
    await vi.waitFor(() => expect(data.emojiData()).toBeDefined());
    expect(fresh.completedShortcodeAt(":v:", 3)?.replacement).toBe("✌️");
  });
});

beforeAll(async () => {
  await (await import("@/lib/emojiData")).loadEmojiData();
});

describe("findEmojiShortcodeColon", () => {
  it("finds a shortcode after whitespace or at the start", () => {
    expect(findEmojiShortcodeColon(":sm", 3)).toBe(0);
    expect(findEmojiShortcodeColon("hi :sm", 6)).toBe(3);
  });

  it("finds a shortcode immediately after a native emoji (no space)", () => {
    const text = "👍:sm";
    expect(findEmojiShortcodeColon(text, text.length)).toBe(text.indexOf(":"));
  });

  it("finds a shortcode after punctuation", () => {
    expect(findEmojiShortcodeColon("ok.:sm", 6)).toBe(3);
  });

  it("rejects colons mid-word (http, times, identifiers)", () => {
    expect(findEmojiShortcodeColon("http://x", 8)).toBe(-1);
    expect(findEmojiShortcodeColon("3:30", 4)).toBe(-1);
    expect(findEmojiShortcodeColon("word:foo", 8)).toBe(-1);
  });

  it("rejects a lone colon with no query yet", () => {
    const text = "👍:";
    expect(findEmojiShortcodeColon(text, text.length)).toBe(-1);
  });
});

describe("nativeEmojiForShortcode", () => {
  it("resolves ids, including one-letter and symbol ones", () => {
    expect(nativeEmojiForShortcode("v")).toBe("✌️");
    expect(nativeEmojiForShortcode("tm")).toBe("™️");
    expect(nativeEmojiForShortcode("+1")).toBe("👍");
  });

  it("resolves aliases and ignores case", () => {
    expect(nativeEmojiForShortcode("thumbsup")).toBe("👍");
    expect(nativeEmojiForShortcode("SMILE")).toBe("😄");
  });

  it("returns undefined for an unknown name or an inherited property", () => {
    expect(nativeEmojiForShortcode("definitely_not_an_emoji")).toBeUndefined();
    expect(nativeEmojiForShortcode("constructor")).toBeUndefined();
  });
});

describe("completedShortcodeAt", () => {
  const at = (text: string, custom?: Set<string>) => completedShortcodeAt(text, text.length, custom);

  it("converts a shortcode whose closing colon was just typed", () => {
    expect(at(":v:")).toEqual({ start: 0, end: 3, replacement: "✌️" });
    expect(at("Armada :tm:")).toEqual({ start: 7, end: 11, replacement: "™️" });
    expect(at("nice :thumbsup:")).toEqual({ start: 5, end: 15, replacement: "👍" });
  });

  it("converts back-to-back shortcodes", () => {
    expect(at("✌️:v:")).toEqual({ start: 2, end: 5, replacement: "✌️" });
  });

  it("leaves the text alone when the cursor is not after a closing colon", () => {
    expect(at(":v")).toBeNull();
    expect(completedShortcodeAt(":v: x", 5)).toBeNull();
  });

  it("does not convert colons that belong to times, URLs or words", () => {
    expect(at("at 10:30:")).toBeNull();
    expect(at("note:v:")).toBeNull();
    expect(at("::")).toBeNull();
    expect(at(": v:")).toBeNull();
  });

  it("does not convert an unknown name", () => {
    expect(at(":notanemoji:")).toBeNull();
  });

  it("leaves a custom emoji's shortcode as text", () => {
    expect(at(":smile:", new Set(["smile"]))).toBeNull();
  });
});
