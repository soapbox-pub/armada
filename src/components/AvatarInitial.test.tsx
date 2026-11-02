import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AvatarInitial } from "@/components/AvatarInitial";

describe("AvatarInitial", () => {
  it("draws the anonymous figure for Anonymous", () => {
    const { container } = render(<AvatarInitial name="Anonymous" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("tints the anonymous figure by pubkey, so two nameless people differ", () => {
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
