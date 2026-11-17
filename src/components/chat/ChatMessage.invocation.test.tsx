import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsTouch: () => false,
  useIsMobile: () => false,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>(), ready: true }),
  useMuteToggle: () => ({
    muted: false,
    canMute: false,
    pending: false,
    label: "Mute",
    toggle: async () => {},
  }),
}));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/hooks/useCustomEmojis", () => ({ useCustomEmojis: () => ({ emojis: [], isLoading: false }) }));
vi.mock("@/hooks/useResolvedMediaSrc", () => ({ useResolvedMediaSrc: () => ({ src: undefined }) }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));

import { ChatMessage } from "@/components/chat/ChatMessage";

afterEach(cleanup);

const BOT = "b".repeat(64);
const invocation = (content: string) =>
  ({ id: "f".repeat(64), pubkey: "a".repeat(64), created_at: 1_700_000_000, kind: 9, content, tags: [["bot", BOT]] }) as ChatMsg;

function show(event: ChatMsg) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatMessage event={event} canWrite canModerate={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatMessage bot invocation", () => {
  it("shows what the command was run with", () => {
    const { container } = show(invocation("/verify gatebot-code 1234"));
    expect(screen.getByRole("button", { name: "/verify" })).toBeTruthy();
    expect(container.textContent).toContain("gatebot-code 1234");
  });

  it("shows a bare command alone", () => {
    const { container } = show(invocation("/ping"));
    expect(container.textContent).toMatch(/ran\s*\/ping\s*with/);
  });
});
