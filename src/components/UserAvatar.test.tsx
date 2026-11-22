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

  describe("speaking", () => {
    const shaped = { ...ultra, shape: "⭐" };

    it("shows the full frame while speaking and a thin rim when quiet, without the green outline", () => {
      const quiet = root(render(<UserAvatar pubkey={PK} metadata={shaped} speaking={false} />).container).style.filter;
      const speaking = root(render(<UserAvatar pubkey={PK} metadata={shaped} speaking />).container).style.filter;
      expect(speaking).toContain("0 0 5px");
      expect(quiet).toContain("drop-shadow");
      expect(quiet).not.toContain("0 0 5px");
      for (const filter of [quiet, speaking]) expect(filter).not.toContain("drop-shadow(1px");
    });

    it("gives a round avatar the same rim and glow, and the full frame when not asked about speaking", () => {
      const round = { ...ultra };
      const quiet = root(render(<UserAvatar pubkey={PK} metadata={round} speaking={false} />).container).style.filter;
      const speaking = root(render(<UserAvatar pubkey={PK} metadata={round} speaking />).container).style.filter;
      const unasked = root(render(<UserAvatar pubkey={PK} metadata={round} />).container).style.filter;
      expect(quiet).not.toContain("0 0 5px");
      expect(speaking).toContain("0 0 5px");
      expect(unasked).toBe(speaking);
    });

    it("outlines a speaking avatar again when the viewer hides Ultra", () => {
      setUltraShown(false);
      try {
        expect(root(render(<UserAvatar pubkey={PK} metadata={shaped} speaking />).container).style.filter).toContain("drop-shadow(1px");
      } finally {
        setUltraShown(true);
      }
    });

    it("outlines a shaped avatar without a frame too, and not when it is quiet", () => {
      const plain = { name: "Bo", shape: "⭐" };
      const speaking = root(render(<UserAvatar pubkey={PK} metadata={plain} speaking />).container);
      expect(speaking.style.filter).toContain("drop-shadow(1px");
      const quiet = root(render(<UserAvatar pubkey={PK} metadata={plain} speaking={false} />).container);
      expect(quiet.style.filter).toBe("");
    });

    it("keeps the same avatar node when speech starts, so the picture doesn't remount", () => {
      const { container, rerender } = render(<UserAvatar pubkey={PK} metadata={shaped} speaking={false} />);
      const avatar = root(container).firstElementChild;
      rerender(<UserAvatar pubkey={PK} metadata={shaped} speaking />);
      expect(root(container).firstElementChild).toBe(avatar);
    });

    it("leaves a round avatar, and a shaped one that wasn't asked about speaking, unwrapped", () => {
      const round = render(<UserAvatar pubkey={PK} metadata={{ name: "Bo" }} speaking />).container;
      expect(root(round).tagName).toBe("DIV");
      expect(root(round).style.filter).toBe("");
      const unasked = render(<UserAvatar pubkey={PK} metadata={{ name: "Bo", shape: "⭐" }} />).container;
      expect(root(unasked).tagName).toBe("DIV");
    });
  });

  it("keeps shadows and rings on the masked avatar, where its mask clips them, and the layout on the wrapper", () => {
    const shaped = { ...ultra, shape: "⭐" };
    const { container } = render(
      <UserAvatar
        pubkey={PK}
        metadata={shaped}
        speaking
        className="size-28 mt-1 shadow-xl ring-2 ring-primary/20 hover:ring-4 ring-offset-2"
      />,
    );
    const wrapper = root(container);
    const inner = wrapper.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("size-28 mt-1");
    expect(wrapper.className).not.toMatch(/shadow|ring/);
    for (const token of ["shadow-xl", "ring-2", "ring-primary/20", "hover:ring-4", "ring-offset-2"]) {
      expect(inner.className).toContain(token);
    }

    const arbitrary = root(render(<UserAvatar pubkey={PK} metadata={shaped} speaking className="size-8 shadow-[0_0_4px_red]" />).container);
    expect(arbitrary.className).not.toContain("shadow");
    expect((arbitrary.firstElementChild as HTMLElement).className).toContain("shadow-[0_0_4px_red]");
  });

  it("shows the initial and never loads the picture for an anonymous request", () => {
    const { container } = render(
      <UserAvatar pubkey={PK} metadata={{ name: "Cy", picture: "https://example.com/c.png" }} anonymous />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
