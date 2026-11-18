import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { AvatarInitial } from "@/components/AvatarInitial";
import { markProfileSettled } from "@/lib/profileLoading";

async function settle(...pubkeys: string[]) {
  pubkeys.forEach(markProfileSettled);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("AvatarInitial", () => {
  it("is a skeleton while the profile is loading, then the fallback once it is missing", async () => {
    const pubkey = "77".repeat(32);
    const { container } = render(<AvatarInitial name="Anonymous" pubkey={pubkey} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    await settle(pubkey);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("is a skeleton under a known name too, while the picture could still be coming", async () => {
    const pubkey = "78".repeat(32);
    const { container } = render(<AvatarInitial name="Nick" pubkey={pubkey} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    await settle(pubkey);
    expect(container.textContent).toBe("N");
  });

  it("is not a skeleton for a profile already in the cache, before it has settled", () => {
    const pubkey = "79".repeat(32);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["author", pubkey], { event: { pubkey, kind: 0, content: "{}", tags: [], created_at: 1 } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <AvatarInitial name="Nick" pubkey={pubkey} />
      </QueryClientProvider>,
    );
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.textContent).toBe("N");
  });

  it("gives up on a profile that never answers, past a round's worst case", async () => {
    vi.useFakeTimers();
    try {
      const pubkey = "7a".repeat(32);
      const { container } = render(<AvatarInitial name="Anonymous" pubkey={pubkey} />);
      // A round can wait 5s to start and then take 15s.
      await act(async () => vi.advanceTimersByTime(20_001));
      expect(container.querySelector(".animate-pulse")).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(container.querySelector(".animate-pulse")).toBeNull();
      expect(container.querySelector("svg")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the anonymous figure for Anonymous", () => {
    const { container } = render(<AvatarInitial name="Anonymous" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("tints the anonymous figure by pubkey, so two nameless people differ", async () => {
    await settle("00aa".padEnd(64, "0"), "00aa".padEnd(64, "f"), "1234".padEnd(64, "0"));
    const color = (pubkey: string) =>
      (render(<AvatarInitial name="Anonymous" pubkey={pubkey} />).container.firstElementChild as HTMLElement).style.color;
    const a = color("00aa".padEnd(64, "0"));
    expect(a).toBe(color("00aa".padEnd(64, "f")));
    expect(a).not.toBe(color("1234".padEnd(64, "0")));
  });

  it("keeps the untinted figure without a hex pubkey", () => {
    const { container } = render(<AvatarInitial name="Anonymous" pubkey="anon-mesh-peer" />);
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("shows the initial otherwise", () => {
    const { container } = render(<AvatarInitial name="alice" />);
    expect(container.textContent).toBe("A");
  });
});
