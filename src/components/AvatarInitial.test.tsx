import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AvatarInitial } from "@/components/AvatarInitial";

describe("AvatarInitial", () => {
  it("draws the anonymous figure for Anonymous", () => {
    const { container } = render(<AvatarInitial name="Anonymous" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows the initial otherwise", () => {
    const { container } = render(<AvatarInitial name="alice" />);
    expect(container.textContent).toBe("A");
  });
});
