import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeSelector } from "./ThemeSelector";

import type { ThemeConfig } from "@/themes";

const h = vi.hoisted(() => ({
  theme: "custom" as string,
  customTheme: undefined as ThemeConfig | undefined,
  userThemes: [] as unknown[],
  user: { pubkey: "a".repeat(64) } as { pubkey: string } | undefined,
  applyCustomTheme: vi.fn(),
  creator: vi.fn(),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    theme: h.theme,
    customTheme: h.customTheme,
    setTheme: vi.fn(),
    applyCustomTheme: h.applyCustomTheme,
  }),
}));
vi.mock("@/hooks/useUserThemes", () => ({
  useUserThemes: () => ({ data: h.userThemes, isLoading: false }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaSrc: () => undefined, useMediaPolicy: () => ({ proxy: "" }) }));
vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => ({ data: pubkey ? { metadata: { name: "Ana" } } : undefined }),
}));
vi.mock("@/components/discover/ThemeCreatorDialog", () => ({
  ThemeCreatorDialog: (props: { editing?: unknown; initial?: unknown }) => {
    h.creator(props);
    return <div>creator</div>;
  },
}));
vi.mock("@/components/ThemeBackgroundField", () => ({
  ThemeBackgroundField: ({ onChange }: { onChange: (bg: { url: string }) => void }) => (
    <button type="button" onClick={() => onChange({ url: "https://img.example/mine.png" })}>Change background</button>
  ),
}));
vi.mock("@/components/ThemeFontFields", () => ({ ThemeFontFields: () => null }));
// The color picker paints on a canvas, which jsdom does not implement.
vi.mock("@/components/ui/color-picker", () => ({
  ColorPicker: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));

const CREATOR = "c".repeat(64);
const ADOPTED: ThemeConfig = {
  title: "Dusk",
  colors: { background: "260 20% 8%", text: "40 30% 90%", primary: "330 80% 60%" },
  background: { url: "https://img.example/dusk.png" },
  source: { pubkey: CREATOR, identifier: "dusk" },
};

const SUNSET: ThemeConfig = {
  title: "Sunset",
  colors: { background: "20 40% 10%", text: "30 30% 90%", primary: "15 85% 55%" },
  font: { family: "Lora" },
};

describe("ThemeSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.theme = "custom";
    h.customTheme = SUNSET;
    h.userThemes = [];
    h.user = { pubkey: "a".repeat(64) };
  });

  it("opens the library creator from New theme", () => {
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: /New theme/ }));
    expect(h.creator).toHaveBeenCalledWith(expect.objectContaining({ editing: undefined, initial: undefined }));
  });

  it("offers to save a theme in use that isn't in the library", () => {
    render(<ThemeSelector />);
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to my themes" }));
    expect(h.creator).toHaveBeenCalledWith(expect.objectContaining({ initial: SUNSET }));
  });

  it("marks a library theme active and applies it with its font", () => {
    h.userThemes = [{ identifier: "sunset-x1", ...SUNSET, title: "Sunset", event: {} }];
    render(<ThemeSelector />);
    expect(screen.queryByText("Not saved")).toBeNull();
    const tile = screen.getAllByRole("button", { name: /Sunset/ }).find((b) => b.hasAttribute("aria-pressed"))!;
    expect(tile).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(tile);
    expect(h.applyCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ font: { family: "Lora" } }));
  });

  it("credits the creator of a saved copy", () => {
    h.userThemes = [{ identifier: "dusk-copy", ...ADOPTED, event: {} }];
    h.customTheme = ADOPTED;
    render(<ThemeSelector />);
    expect(screen.getByText("by Ana")).toBeInTheDocument();
    expect(screen.queryByText(/Not saved/)).toBeNull();
  });

  it("credits an adopted theme in use and saves it with the credit", () => {
    h.customTheme = ADOPTED;
    render(<ThemeSelector />);
    expect(screen.getByText("Not saved · by Ana")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to my themes" }));
    expect(h.creator).toHaveBeenCalledWith(expect.objectContaining({
      initial: expect.objectContaining({ source: { pubkey: CREATOR, identifier: "dusk" } }),
    }));
  });

  it("recognizes a saved copy whose background was rehosted on adoption", () => {
    h.userThemes = [{ identifier: "dusk-copy", ...ADOPTED, event: {} }];
    h.customTheme = { ...ADOPTED, background: { url: "https://my.blossom/dusk.png" } };
    render(<ThemeSelector />);
    expect(screen.queryByText(/Not saved/)).toBeNull();
    const tile = screen.getAllByRole("button", { name: /Dusk/ }).find((b) => b.hasAttribute("aria-pressed"))!;
    expect(tile).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the credit signed out when the theme is applied unchanged", () => {
    h.user = undefined;
    h.customTheme = ADOPTED;
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dusk" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply theme" }));
    expect(h.applyCustomTheme).toHaveBeenLastCalledWith(expect.objectContaining({ source: ADOPTED.source }));
  });

  it("drops the credit signed out once the theme is changed", () => {
    h.user = undefined;
    h.customTheme = ADOPTED;
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dusk" }));
    fireEvent.click(screen.getByRole("button", { name: "Change background" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply theme" }));
    expect(h.applyCustomTheme.mock.lastCall![0].source).toBeUndefined();
  });

  it("doesn't claim the creator's uploaded font once the credit is dropped", () => {
    const font = { family: "Their Font", url: "https://blossom.example/" + "f".repeat(64) + ".woff2" };
    h.user = undefined;
    h.customTheme = { ...ADOPTED, font, titleFont: font };
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dusk" }));
    fireEvent.click(screen.getByRole("button", { name: "Change background" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply theme" }));
    const applied = h.applyCustomTheme.mock.lastCall![0] as ThemeConfig;
    expect(applied.source).toBeUndefined();
    expect(applied.font).toBeUndefined();
    expect(applied.titleFont).toBeUndefined();
  });

  it("builds on this device when signed out", () => {
    h.user = undefined;
    h.customTheme = undefined;
    h.theme = "dark";
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: /New theme/ }));
    expect(h.creator).not.toHaveBeenCalled();
    expect(screen.getByText(/Kept on this device/)).toBeInTheDocument();
  });
});
