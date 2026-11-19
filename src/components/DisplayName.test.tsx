import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DisplayName } from "@/components/DisplayName";
import { markProfileSettled } from "@/lib/profileLoading";
import { setUltraShown } from "@/lib/ultra";

const PK = "ab".repeat(30) + "1a2b";

async function settle(pubkey: string) {
  markProfileSettled(pubkey);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("DisplayName", () => {
  it("is a skeleton, not Anonymous, while the profile is loading", async () => {
    const pubkey = "cd".repeat(32);
    const { container } = render(<DisplayName pubkey={pubkey} name="Anonymous" tags={[]} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    await settle(pubkey);
    expect(container.textContent).toBe("Anonymous#" + pubkey.slice(-4));
  });

  it("tags a nameless person with their pubkey's last four hex digits, in its own element", async () => {
    await settle(PK);
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

  describe("Ultra name style", () => {
    const ultra = { name: "Ana", armada_ultra: { since: 1, name: "aurora" } };

    it("draws a member's name style in a list by default", () => {
      const { container } = render(<DisplayName pubkey={PK} name="Ana" tags={[]} metadata={ultra} />);
      const span = container.querySelector("span[style]") as HTMLElement;
      expect(span.textContent).toBe("Ana");
      expect(span.style.backgroundImage).toContain("linear-gradient");
      expect(span.className).toContain("animate-ultra-shimmer-twice");
    });

    it("loops for a hero name and is plain when turned off", () => {
      const hero = render(<DisplayName pubkey={PK} name="Ana" tags={[]} metadata={ultra} ultra="hero" />);
      expect(hero.container.querySelector("span[style]")?.className).toMatch(/animate-ultra-shimmer(?!-)/);
      const plain = render(<DisplayName pubkey={PK} name="Ana" tags={[]} metadata={ultra} ultra={false} />);
      expect(plain.container.querySelector("span[style]")).toBeNull();
    });

    it("is plain for someone without Ultra, or when the viewer hides it", () => {
      const none = render(<DisplayName pubkey={PK} name="Bo" tags={[]} metadata={{ name: "Bo" }} />);
      expect(none.container.querySelector("span[style]")).toBeNull();
      setUltraShown(false);
      try {
        const hidden = render(<DisplayName pubkey={PK} name="Ana" tags={[]} metadata={ultra} />);
        expect(hidden.container.querySelector("span[style]")).toBeNull();
      } finally {
        setUltraShown(true);
      }
    });
  });
});
