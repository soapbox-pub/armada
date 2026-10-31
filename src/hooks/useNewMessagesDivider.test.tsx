import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useReadState", () => ({ useReadState: () => ({ getLastRead: () => 100 }) }));

import { useNewMessagesDivider } from "./useNewMessagesDivider";

const msg = (id: string, createdAt: number) => ({ id, createdAt, author: "a" });

describe("useNewMessagesDivider", () => {
  it("moves back to the real first unread as older history loads, then freezes", () => {
    const { result, rerender } = renderHook(
      ({ messages, hasOlder }) => useNewMessagesDivider("k", messages, undefined, hasOlder),
      { initialProps: { messages: [msg("c", 300), msg("d", 400)], hasOlder: true } },
    );
    expect(result.current).toBe("c");
    rerender({ messages: [msg("a", 50), msg("b", 200), msg("c", 300), msg("d", 400)], hasOlder: true });
    expect(result.current).toBe("b");
    rerender({ messages: [msg("b", 200), msg("c", 300), msg("d", 400), msg("e", 500)], hasOlder: true });
    expect(result.current).toBe("b");
  });

  it("settles at once when nothing older exists", () => {
    const { result, rerender } = renderHook(
      ({ messages }) => useNewMessagesDivider("k", messages),
      { initialProps: { messages: [msg("c", 300)] } },
    );
    expect(result.current).toBe("c");
    rerender({ messages: [msg("b", 200), msg("c", 300)] });
    expect(result.current).toBe("c");
  });
});
