import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ProfilePreviewCard } from "./ProfilePreviewCard";

import type { LightboxItem } from "@/components/chat/Lightbox";

const PK = "c".repeat(64);
const PICTURE = "https://example.com/face.png";

const h = vi.hoisted(() => ({ picture: undefined as string | undefined }));

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: () => ({ data: { metadata: { name: "Carol", picture: h.picture } } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: {} }) }));
vi.mock("@/hooks/useNsite", () => ({ useNsite: () => ({ data: undefined }) }));
vi.mock("@/hooks/useOpenProfile", () => ({ useOpenProfile: () => vi.fn() }));
vi.mock("@/hooks/useUserBan", () => ({ useCheckUserBan: () => vi.fn() }));
vi.mock("@/hooks/usePrefetchProfile", () => ({ usePrefetchProfile: () => vi.fn() }));
vi.mock("@/hooks/useMemberRoles", () => ({ useMemberRoles: () => [] }));
vi.mock("@/hooks/useFollowToggle", () => ({
  useFollowToggle: () => ({ isFollowing: false, isPending: false, toggle: vi.fn() }),
}));
vi.mock("@/hooks/useProfileTheme", () => ({
  useProfileTheme: () => ({ data: undefined }),
  usePrefetchProfileTheme: () => vi.fn(),
}));
vi.mock("@/hooks/useUserStatus", () => ({
  useUserStatus: () => ({ data: undefined }),
  isStatusExpired: () => false,
}));
vi.mock("@/hooks/useUserModeration", () => ({
  useUserModeration: () => ({ actions: [], rolePicker: undefined, dialogs: null }),
}));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AvatarImage: () => null,
  AvatarFallback: () => null,
}));
vi.mock("@/components/ui/FallbackImage", () => ({ FallbackImage: () => null }));
vi.mock("@/components/chat/Lightbox", () => ({
  Lightbox: ({ media }: { media: LightboxItem[] }) => <div data-testid="lightbox">{media[0].url}</div>,
}));

function openCard() {
  render(
    <MemoryRouter>
      <ProfilePreviewCard pubkey={PK}>
        <button type="button">Carol</button>
      </ProfilePreviewCard>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Carol" }));
}

describe("ProfilePreviewCard avatar", () => {
  it("opens the picture in a lightbox and closes the card", () => {
    h.picture = PICTURE;
    openCard();
    fireEvent.click(screen.getByRole("button", { name: "View profile picture" }));

    expect(screen.getByTestId("lightbox")).toHaveTextContent(PICTURE);
    expect(screen.queryByRole("button", { name: "View profile picture" })).not.toBeInTheDocument();
  });

  it("is disabled without a picture", () => {
    h.picture = undefined;
    openCard();

    expect(screen.getByRole("button", { name: "View profile picture" })).toBeDisabled();
  });
});

describe("ProfilePreviewCard stacking", () => {
  it("dismisses the open card on a tap on another trigger rather than opening a second", () => {
    h.picture = PICTURE;
    render(
      <MemoryRouter>
        <ProfilePreviewCard pubkey={PK}>
          <button type="button">Carol</button>
        </ProfilePreviewCard>
        <ProfilePreviewCard pubkey={"d".repeat(64)}>
          <button type="button">Dave</button>
        </ProfilePreviewCard>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Carol" }));
    expect(screen.getAllByRole("button", { name: "View profile picture" })).toHaveLength(1);

    // The modal card hides the rest of the page from the accessibility tree.
    fireEvent.click(screen.getByRole("button", { name: "Dave", hidden: true }));
    expect(screen.queryAllByRole("button", { name: "View profile picture" })).toHaveLength(0);
  });
});
