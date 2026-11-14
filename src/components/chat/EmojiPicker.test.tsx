import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { EmojiPicker } from "./EmojiPicker";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

const picker = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

// emoji-mart is a custom element this suite never needs to draw.
vi.mock("emoji-mart", () => ({
  Picker: class {
    constructor(options: Record<string, unknown>) {
      picker.options = options;
      return document.createElement("div");
    }
  },
  Data: undefined,
}));
vi.mock("@emoji-mart/data", () => ({ default: {} }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));

const custom = [{ shortcode: "wave", url: "https://cdn.example/wave.png" }] as CustomEmoji[];

function renderPicker(props: Partial<Parameters<typeof EmojiPicker>[0]>) {
  return render(
    <MemoryRouter>
      <EmojiPicker onSelect={() => {}} onBrowsePacks={() => {}} {...props} />
    </MemoryRouter>,
  );
}

describe("EmojiPicker packs footer", () => {
  it("invites a user with no custom emoji to add packs", () => {
    renderPicker({});
    expect(screen.getByText("Add custom emoji packs")).toBeInTheDocument();
  });

  it("still links a user with custom emoji to more packs where the host has no link of its own", () => {
    renderPicker({ customEmojis: custom });
    expect(screen.getByText("Find more emoji packs")).toBeInTheDocument();
  });

  it("leaves the link to a host that carries its own once the user has custom emoji", () => {
    renderPicker({ customEmojis: custom, packsLinkInHost: true });
    expect(screen.queryByText(/emoji packs/)).not.toBeInTheDocument();
  });
});

describe("EmojiPicker custom emoji", () => {
  type Category = { id: string; name: string; emojis: { id: string }[] };
  const customCategories = () => picker.options?.custom as Category[];

  it("keeps a pack's emoji out of the native ids it would otherwise replace", () => {
    renderPicker({ customEmojis: [{ shortcode: "heart", url: "https://cdn.example/heart.png" }] });
    expect(customCategories()[0].emojis.map((e) => e.id)).toEqual(["custom:heart"]);
  });

  it("sends the shortcode of a picked custom emoji, and a native one as itself", () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect, customEmojis: [{ shortcode: "heart", url: "https://cdn.example/heart.png" }] });
    const pick = picker.options?.onEmojiSelect as (emoji: Record<string, string>) => void;

    act(() => pick({ id: "custom:heart", src: "https://cdn.example/heart.png" }));
    act(() => pick({ id: "heart", native: "❤️" }));

    expect(onSelect.mock.calls).toEqual([
      [{ type: "custom", shortcode: "heart", url: "https://cdn.example/heart.png" }],
      [{ type: "native", emoji: "❤️" }],
    ]);
  });

  it("gives two packs whose coordinates differ only in punctuation a section each", () => {
    const pk = "a".repeat(64);
    renderPicker({
      customEmojis: [
        { shortcode: "one", url: "https://cdn.example/1.png", packCoord: `30030:${pk}:my.pack`, packName: "Dots" },
        { shortcode: "two", url: "https://cdn.example/2.png", packCoord: `30030:${pk}:my-pack`, packName: "Dashes" },
      ],
    });
    const ids = customCategories().map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(customCategories().map((c) => c.name)).toEqual(["Dots", "Dashes"]);
  });
});
