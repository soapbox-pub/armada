import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
