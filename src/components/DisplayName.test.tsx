import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DisplayName } from "@/components/DisplayName";

const PK = "ab".repeat(30) + "1a2b";

describe("DisplayName", () => {
  it("tags a nameless person with their pubkey's last four hex digits, in its own element", () => {
    const { container } = render(<DisplayName pubkey={PK} name="Anonymous" tags={[]} />);
    expect(container.textContent).toBe("Anonymous#1a2b");
    const tag = container.querySelector("span.font-mono") as HTMLElement;
    expect(tag.textContent).toBe("#1a2b");
    expect(tag.style.color).not.toBe("");
  });

  it("leaves a real name alone", () => {
    const { container } = render(<DisplayName pubkey={PK} name="Alice" tags={[]} />);
    expect(container.textContent).toBe("Alice");
  });

  it("adds nothing without a hex pubkey", () => {
    const { container } = render(<DisplayName pubkey={undefined} name="Anonymous" />);
    expect(container.textContent).toBe("Anonymous");
  });
});
