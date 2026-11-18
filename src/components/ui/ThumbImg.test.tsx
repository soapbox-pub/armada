/**
 * While its thumbnail is being made a ThumbImg holds an empty placeholder, except
 * an image that is part of the text, which shows its original in the meantime.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThumbImg } from "@/components/ui/ThumbImg";

vi.mock("@/hooks/useImageThumb", () => ({
  useImageThumb: () => ({ src: undefined, pending: true }),
}));

const SRC = "https://x.test/emoji.png";

describe("ThumbImg while pending", () => {
  it("holds an empty placeholder by default", () => {
    const { container } = render(<ThumbImg src={SRC} alt=":e:" className="size-8" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("span.size-8")).not.toBeNull();
  });

  it("fills the placeholder with the original when asked", () => {
    const { container } = render(<ThumbImg src={SRC} alt=":e:" className="size-8" originalWhilePending />);
    const img = container.querySelector("span.size-8 > img");
    expect(img?.getAttribute("src")).toBe(SRC);
  });
});
