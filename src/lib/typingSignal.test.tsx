import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isTypingInput, useTypersStillTyping, useTypingResetOnPost, type Typer } from "@/lib/typingSignal";

describe("isTypingInput", () => {
  it("announces text going in, not deletions, empty drafts or slash commands", () => {
    expect(isTypingInput("hi", "insertText")).toBe(true);
    expect(isTypingInput("hi", undefined)).toBe(true);
    expect(isTypingInput("h", "deleteContentBackward")).toBe(false);
    expect(isTypingInput("", "insertText")).toBe(false);
    expect(isTypingInput("/giphy", "insertText")).toBe(false);
  });
});

describe("useTypersStillTyping", () => {
  const typers: Typer[] = [
    { pubkey: "a", date: 100_500 },
    { pubkey: "b", date: 100_500 },
  ];

  it("drops a typer once a post of theirs is dated at or after their signal", () => {
    const { result } = renderHook(() => useTypersStillTyping(typers, [{ pubkey: "a", created_at: 100 }, { pubkey: "b", created_at: 99 }]));
    expect(result.current).toEqual(["b"]);
  });

  it("keeps everyone without posts", () => {
    const { result } = renderHook(() => useTypersStillTyping(typers, undefined));
    expect(result.current).toEqual(["a", "b"]);
  });
});

describe("useTypingResetOnPost", () => {
  it("clears the throttle when the member posts after their last signal, not before", () => {
    const lastSent = { current: 200_000 };
    const { rerender } = renderHook(({ messages }) => useTypingResetOnPost(lastSent, messages, "me"), {
      initialProps: { messages: [{ pubkey: "me", created_at: 150 }] },
    });
    expect(lastSent.current).toBe(200_000);
    rerender({ messages: [{ pubkey: "other", created_at: 300 }] });
    expect(lastSent.current).toBe(200_000);
    rerender({ messages: [{ pubkey: "me", created_at: 201 }] });
    expect(lastSent.current).toBe(0);
  });
});
