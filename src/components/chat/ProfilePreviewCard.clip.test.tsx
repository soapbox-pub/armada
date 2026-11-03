import { fireEvent, render, screen } from "@testing-library/react";
import { Ban, UserMinus } from "lucide-react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ProfilePreviewCard } from "./ProfilePreviewCard";

import { MemberActionsContext, type MemberActionItem } from "@/contexts/MemberActionsContext";

// jsdom has no layout: these assertions are STRUCTURAL. They check that a
// card whose height is capped to the space Radix reports as available has a
// scroll container between that cap and its rows, which is what keeps a
// tall card reachable on a short viewport
// (landscape phone, or an avatar low on a portrait screen).

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: () => ({
    data: {
      metadata: { name: "Mallory", about: "line\nline\nline\nline\nline", banner: "https://example.com/b.png" },
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "me" } }) }));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: { dmsDisabled: false } }) }));
vi.mock("@/hooks/useChatScope", () => ({ useChatScope: () => undefined }));
vi.mock("@/hooks/useMuteList", () => ({
  useMuteToggle: () => ({ canMute: true, muted: false, pending: false, label: "Mute", toggle: vi.fn() }),
}));
vi.mock("@/hooks/useNsite", () => ({ useNsite: () => ({ data: undefined }) }));
vi.mock("@/hooks/useOpenProfile", () => ({ useOpenProfile: () => vi.fn() }));
vi.mock("@/hooks/useUserBan", () => ({ useCheckUserBan: () => vi.fn() }));
vi.mock("@/hooks/usePrefetchProfile", () => ({ usePrefetchProfile: () => vi.fn() }));
vi.mock("@/hooks/useMemberRoles", () => ({ useMemberRoles: () => [{ id: "r", name: "Member" }] }));
vi.mock("@/hooks/useFollowToggle", () => ({
  useFollowToggle: () => ({ isFollowing: false, isPending: false, toggle: vi.fn() }),
}));
vi.mock("@/hooks/useMentionBus", () => ({ requestMention: () => true }));
vi.mock("@/hooks/useProfileTheme", () => ({
  useProfileTheme: () => ({ data: undefined }),
  usePrefetchProfileTheme: () => vi.fn(),
}));
vi.mock("@/hooks/useUserStatus", () => ({ useUserStatus: () => ({ data: undefined }), isStatusExpired: () => true }));
vi.mock("@/components/ReportDialog", () => ({ ReportDialog: () => null }));
vi.mock("@/components/ui/FallbackImage", () => ({ FallbackImage: () => null }));
vi.mock("@/components/chat/CustomEmoji", () => ({ EmojifiedText: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AvatarImage: () => null,
  AvatarFallback: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const actions: MemberActionItem[] = [
  { id: "kick", label: "Kick", icon: UserMinus, onSelect: vi.fn() },
  { id: "ban", label: "Ban & lock out", icon: Ban, destructive: true, onSelect: vi.fn() },
];

function openCard() {
  render(
    <MemoryRouter>
      <MemberActionsContext.Provider value={{ actionsFor: () => actions }}>
        <ProfilePreviewCard pubkey={"a".repeat(64)}>
          <button type="button">avatar</button>
        </ProfilePreviewCard>
      </MemberActionsContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "avatar" }));
  return screen.getByRole("button", { name: "View profile" });
}

function classesOf(el: Element) {
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

describe("ProfilePreviewCard on a short viewport", () => {
  it("caps the card to the available height", () => {
    const row = openCard();
    const content = row.closest("[data-radix-popper-content-wrapper] > *") as HTMLElement;
    expect(content).toBeTruthy();
    expect(classesOf(content)).toContain("max-h-[var(--radix-popover-content-available-height)]");
  });

  it("puts a scroll container between that cap and the card's rows", () => {
    const row = openCard();
    const content = row.closest("[data-radix-popper-content-wrapper] > *") as HTMLElement;

    const scrollers: string[] = [];
    for (let el: HTMLElement | null = row; el; el = el.parentElement) {
      const c = classesOf(el);
      if (c.some((k) => /^overflow(-y)?-(auto|scroll)$/.test(k))) scrollers.push(el.className);
      if (el === content) break;
    }
    // Without one, a max-h element whose overflow is hidden clips its last
    // rows with no way to reach them.
    expect(scrollers).not.toHaveLength(0);
  });
});

describe("ProfilePreviewCard moderation", () => {
  it("lists the scope's member actions in the overflow menu, not on the card", () => {
    openCard();
    expect(screen.queryByRole("button", { name: "Ban & lock out" })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });
});
