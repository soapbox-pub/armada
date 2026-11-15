import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StickerPicker } from "@/components/chat/StickerPicker";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

vi.mock("@/components/chat/CustomEmoji", () => ({
  CustomEmojiImg: ({ name }: { name: string }) => <span>{name}</span>,
}));

const CATS = "30030:aa:cats";
const DOGS = "30030:bb:dogs";

// Palette order as useCustomEmojis builds it: stickers on the list first, then each pack.
const palette: CustomEmoji[] = [
  { shortcode: "wave", url: "https://example.com/wave.webp" },
  { shortcode: "cat_happy", url: "https://example.com/cat_happy.webp", packCoord: CATS, packName: "Cats" },
  { shortcode: "cat_sad", url: "https://example.com/cat_sad.webp", packCoord: CATS, packName: "Cats" },
  { shortcode: "dog_happy", url: "https://example.com/dog_happy.webp", packCoord: DOGS, packName: "Dogs" },
];

/** Each section's header and the stickers in it, top to bottom. */
function sections() {
  return screen.getAllByRole("group").map((group) => ({
    name: group.firstElementChild?.textContent,
    stickers: within(group).getAllByRole("button").map((button) => button.title),
  }));
}

function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search stickers"), { target: { value } });
}

describe("StickerPicker", () => {
  it("shows each pack in its own section under the pack's name", () => {
    render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

    expect(sections()).toEqual([
      { name: "Custom", stickers: ["wave"] },
      { name: "Cats", stickers: ["cat_happy", "cat_sad"] },
      { name: "Dogs", stickers: ["dog_happy"] },
    ]);
    expect(screen.getByRole("group", { name: "Cats" })).toBeInTheDocument();
  });

  it("sizes columns by sticker width, so a wide panel gets more of them and a small pack stays small", () => {
    render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

    for (const name of ["Custom", "Cats", "Dogs"]) {
      const grid = within(screen.getByRole("group", { name })).getAllByRole("button")[0].parentElement;
      expect(grid?.className).toContain("grid-cols-[repeat(auto-fill,minmax(80px,1fr))]");
      expect(grid?.className).not.toContain("grid-cols-4");
    }
  });

  it("sends the sticker that was clicked", () => {
    const onSelect = vi.fn();
    render(<StickerPicker customEmojis={palette} onSelect={onSelect} autoFocus={false} />);

    fireEvent.click(within(screen.getByRole("group", { name: "Cats" })).getByTitle("cat_sad"));

    expect(onSelect).toHaveBeenCalledWith(palette[2]);
  });

  it("keeps only packs with a match while searching", () => {
    render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

    search("HAPPY");

    expect(sections()).toEqual([
      { name: "Cats", stickers: ["cat_happy"] },
      { name: "Dogs", stickers: ["dog_happy"] },
    ]);
  });

  it("puts a workspace's sets in one section, without their members' names", () => {
    const workspace: CustomEmoji[] = [
      { shortcode: "ship", url: "https://example.com/ship.webp", packCoord: "30030:cc:buzz:custom-emoji", packName: "Cats", workspace: true },
      { shortcode: "anchor", url: "https://example.com/anchor.webp", packCoord: "30030:dd:buzz:custom-emoji", packName: "Official", workspace: true },
    ];
    render(<StickerPicker customEmojis={[...palette, ...workspace]} onSelect={vi.fn()} autoFocus={false} />);

    expect(sections()).toEqual([
      { name: "Custom", stickers: ["wave"] },
      { name: "Cats", stickers: ["cat_happy", "cat_sad"] },
      { name: "Dogs", stickers: ["dog_happy"] },
      { name: "Workspace", stickers: ["ship", "anchor"] },
    ]);
  });

  it("names a pack with no name by its identifier", () => {
    render(
      <StickerPicker
        customEmojis={[{ shortcode: "owl", url: "https://example.com/owl.webp", packCoord: `30030:${"a".repeat(64)}:birds` }]}
        onSelect={vi.fn()}
        autoFocus={false}
      />,
    );

    expect(sections()).toEqual([{ name: "birds", stickers: ["owl"] }]);
  });

  describe("pack bar", () => {
    const tabs = () => screen.getAllByRole("tab").map((tab) => ({ name: tab.getAttribute("aria-label"), selected: tab.getAttribute("aria-selected") }));
    const viewportOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;
    const placeAt = (el: Element, top: number) => {
      el.getBoundingClientRect = () => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) });
    };

    it("has one tab per pack, previewing the pack's first sticker", () => {
      render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

      expect(tabs()).toEqual([
        { name: "Custom", selected: "true" },
        { name: "Cats", selected: "false" },
        { name: "Dogs", selected: "false" },
      ]);
      expect(within(screen.getByRole("tab", { name: "Cats" })).getByText("cat_happy")).toBeInTheDocument();
    });

    it("is hidden when there is only one pack", () => {
      render(<StickerPicker customEmojis={palette.slice(1, 3)} onSelect={vi.fn()} autoFocus={false} />);

      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    });

    it("follows the search, listing only the packs that match", () => {
      render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

      search("HAPPY");

      expect(tabs().map((tab) => tab.name)).toEqual(["Cats", "Dogs"]);
    });

    it("scrolls to the pack that was clicked", () => {
      const { container } = render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);
      const viewport = viewportOf(container);
      viewport.scrollTo = vi.fn();
      placeAt(viewport, 100);
      placeAt(screen.getByRole("group", { name: "Cats" }), 400);

      fireEvent.click(screen.getByRole("tab", { name: "Cats" }));

      expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 300, behavior: "smooth" });
      expect(tabs().find((tab) => tab.selected === "true")?.name).toBe("Cats");
    });

    it("highlights the pack whose heading was last scrolled to the top", () => {
      const { container } = render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);
      const viewport = viewportOf(container);
      placeAt(viewport, 100);
      placeAt(screen.getByRole("group", { name: "Custom" }), -300);
      placeAt(screen.getByRole("group", { name: "Cats" }), 102);
      placeAt(screen.getByRole("group", { name: "Dogs" }), 500);

      fireEvent.scroll(viewport);

      expect(tabs().find((tab) => tab.selected === "true")?.name).toBe("Cats");
    });

    it("keeps a clicked pack highlighted while the list scrolls to it, even if that is the end of the list", () => {
      vi.useFakeTimers();
      try {
        const { container } = render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);
        const viewport = viewportOf(container);
        viewport.scrollTo = vi.fn();
        Object.defineProperties(viewport, {
          scrollTop: { value: 600, configurable: true },
          clientHeight: { value: 300, configurable: true },
          scrollHeight: { value: 900, configurable: true },
        });

        fireEvent.click(screen.getByRole("tab", { name: "Cats" }));
        fireEvent.scroll(viewport);
        expect(tabs().find((tab) => tab.selected === "true")?.name).toBe("Cats");

        act(() => vi.advanceTimersByTime(300));
        fireEvent.scroll(viewport);
        expect(tabs().find((tab) => tab.selected === "true")?.name).toBe("Dogs");
      } finally {
        vi.useRealTimers();
      }
    });

    it("highlights the last pack once the list is scrolled to its end", () => {
      const { container } = render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);
      const viewport = viewportOf(container);
      Object.defineProperties(viewport, {
        scrollTop: { value: 600, configurable: true },
        clientHeight: { value: 300, configurable: true },
        scrollHeight: { value: 900, configurable: true },
      });
      placeAt(viewport, 100);
      placeAt(screen.getByRole("group", { name: "Dogs" }), 400);

      fireEvent.scroll(viewport);

      expect(tabs().find((tab) => tab.selected === "true")?.name).toBe("Dogs");
    });
  });

  it("shows the empty result when nothing matches", () => {
    render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

    search("zebra");

    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getByText("No stickers found")).toBeInTheDocument();
  });
});
