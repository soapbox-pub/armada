import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const boxes = vi.hoisted(() => [] as number[]);
vi.mock("@/hooks/useImageThumb", () => ({
  useImageThumb: (src: string | undefined, box: number) => (boxes.push(box), { src, pending: false }),
}));

import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { setFontScale } from "@/lib/fontScale";

describe("AvatarImage", () => {
  it("asks for a thumbnail the size of its avatar, scaled with the text size", () => {
    render(<Avatar className="size-4"><AvatarImage src="https://x.test/a.png" /></Avatar>);
    expect(boxes.at(-1)).toBe(16);
    setFontScale(125);
    try {
      render(<Avatar className="size-10"><AvatarImage src="https://x.test/b.png" /></Avatar>);
      expect(boxes.at(-1)).toBe(50);
    } finally {
      setFontScale(100);
    }
  });
});
