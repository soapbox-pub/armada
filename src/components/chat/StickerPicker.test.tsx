import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("shows the empty result when nothing matches", () => {
    render(<StickerPicker customEmojis={palette} onSelect={vi.fn()} autoFocus={false} />);

    search("zebra");

    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getByText("No stickers found")).toBeInTheDocument();
  });
});
