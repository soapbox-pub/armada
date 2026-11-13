import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmbeddedEventCard } from "@/components/chat/EmbeddedNote";

import type { NostrRumor } from "@/lib/nostrRumor";

const OWNER = "a".repeat(64);

function event(kind: number, tags: string[][], id = "b"): NostrRumor {
  return { id: id.repeat(64), pubkey: OWNER, kind, tags, content: "", created_at: 1 };
}

const ISSUES = [
  event(39731, [["d", "i2"], ["title", "Spring"], ["issue", "2"], ["image", "https://example.com/2.png"]], "c"),
  event(39731, [["d", "i1"], ["title", "Winter"], ["issue", "1"], ["image", "https://example.com/1.png"], ["content-warning", ""]], "d"),
];

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useMagazineIssues", () => ({ useMagazineIssues: () => ({ data: ISSUES }) }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("EmbeddedEventCard for a PressStr magazine", () => {
  it("draws a magazine as a still pulp cover counting its issues, fanning out only unwarned ones", () => {
    const { container } = render(
      <EmbeddedEventCard event={event(34609, [["d", "mag"], ["title", "Freedom Tech"], ["summary", "Tools for the free"]])} />,
    );

    expect(screen.getByText("Magazine")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Freedom Tech" })).toBeInTheDocument();
    expect(screen.getByText("FREEDOM TECH")).toBeInTheDocument();
    expect(screen.getByText("2 issues")).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual(["https://example.com/2.png"]);
    // Reading is Ditto's: the cover is not a control.
    expect(screen.queryByRole("button", { name: /freedom tech/i })).toBeNull();
  });

  it("shows an issue's own cover art, number and title", () => {
    const { container } = render(<EmbeddedEventCard event={ISSUES[0]} />);

    expect(screen.getByText("Magazine issue")).toBeInTheDocument();
    expect(screen.getByText("No. 2")).toBeInTheDocument();
    expect(screen.getByText("Spring")).toBeInTheDocument();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/2.png");
  });

  it("keeps a content-warned issue's art off screen", () => {
    const { container } = render(<EmbeddedEventCard event={ISSUES[1]} />);

    expect(screen.getByText("Sensitive")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
