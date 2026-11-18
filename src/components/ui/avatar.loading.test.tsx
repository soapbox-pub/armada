import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppContext, type AppContextType } from "@/contexts/AppContext";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

vi.mock("@/hooks/useBlossomServers", () => ({ useBlossomServers: () => [] }));

const thumb = vi.hoisted(() => ({ current: { src: undefined as string | undefined, pending: true } }));
vi.mock("@/hooks/useImageThumb", () => ({ useImageThumb: () => thumb.current }));

const context = { config: { mediaProxies: [] }, updateConfig: vi.fn() } as unknown as AppContextType;

const tree = () => (
  <AppContext.Provider value={context}>
    <Avatar>
      <AvatarImage src="https://example.com/a.png" data-testid="img" />
      <AvatarFallback>A</AvatarFallback>
    </Avatar>
  </AppContext.Provider>
);

/** A picture still being fetched and downscaled reads as loading, then fades in over that placeholder. */
describe("AvatarImage while its thumbnail is made", () => {
  beforeEach(() => {
    thumb.current = { src: undefined, pending: true };
  });

  it("pulses in place of the picture, with the initial still hidden", () => {
    const { container } = render(tree());
    expect(container.textContent).toBe("");
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("fades the picture in once it is ready", () => {
    const { container, rerender } = render(tree());
    thumb.current = { src: "blob:thumb", pending: false };
    rerender(tree());
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.querySelector("img")?.className).toContain("fade-in-0");
  });

  it("shows a thumbnail that was already made at once, without a fade", () => {
    thumb.current = { src: "blob:thumb", pending: false };
    const { container } = render(tree());
    expect(container.querySelector("img")?.className).not.toContain("fade-in-0");
  });
});
