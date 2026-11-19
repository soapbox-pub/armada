import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserAvatar } from "@/components/UserAvatar";
import { setUltraShown } from "@/lib/ultra";

// Only the profile read matters here; the picture pipeline has its own suites.
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));

const PK = "ab".repeat(32);
const ultra = { name: "Ana", armada_ultra: { since: 1, frame: "gold" } };

function root(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

describe("UserAvatar", () => {
  it("wears a member's Ultra frame on the avatar itself", () => {
    const { container } = render(<UserAvatar pubkey={PK} metadata={ultra} className="size-10" />);
    expect(root(container).className).toContain("size-10");
    expect(root(container).style.filter).toContain("drop-shadow");
  });

  it("draws no frame without Ultra, when asked not to, or when the viewer hides Ultra", () => {
    expect(root(render(<UserAvatar pubkey={PK} metadata={{ name: "Bo" }} />).container).style.filter).toBe("");
    expect(root(render(<UserAvatar pubkey={PK} metadata={ultra} frame={false} />).container).style.filter).toBe("");
    setUltraShown(false);
    try {
      expect(root(render(<UserAvatar pubkey={PK} metadata={ultra} />).container).style.filter).toBe("");
    } finally {
      setUltraShown(true);
    }
  });

  it("moves the frame and the layout to a wrapper for an emoji-shaped avatar, whose mask would cut the glow", () => {
    const shaped = { ...ultra, shape: "⭐" };
    const { container } = render(<UserAvatar pubkey={PK} metadata={shaped} className="size-12 mt-1" />);
    const wrapper = root(container);
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper.className).toContain("size-12 mt-1");
    expect(wrapper.style.filter).toContain("drop-shadow");
    expect((wrapper.firstElementChild as HTMLElement).className).toContain("size-full");
  });

  it("shows the initial and never loads the picture for an anonymous request", () => {
    const { container } = render(
      <UserAvatar pubkey={PK} metadata={{ name: "Cy", picture: "https://example.com/c.png" }} anonymous />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
