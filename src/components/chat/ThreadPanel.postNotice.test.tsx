import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: {} }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsTouch: () => false, useIsMobile: () => false }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>(), ready: true }),
  useMuteToggle: () => ({ muted: false, canMute: false, pending: false, label: "Mute", toggle: async () => {} }),
}));
vi.mock("@/hooks/useMutedPubkeys", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set() }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({ useMentionNameMap: () => ({ byName: new Map(), regex: null }) }));
vi.mock("@/hooks/useMentionLabels", () => ({ useMentionLabels: () => () => "@Alice" }));
vi.mock("@/hooks/useCustomEmojis", () => ({ useCustomEmojis: () => ({ emojis: [], isLoading: false }) }));
vi.mock("@/hooks/useResolvedMediaSrc", () => ({ useResolvedMediaSrc: () => ({ src: undefined }) }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: () => <span>Alice</span> }));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));
vi.mock("@/components/chat/mentionRoster", async (orig) => ({
  ...(await orig<typeof import("@/components/chat/mentionRoster")>()),
  useMentionRoster: () => [],
}));
vi.mock("@/components/chat/ChatComposer", () => ({ ChatComposer: () => <div data-testid="composer" /> }));

import { ThreadPanel } from "@/components/chat/ThreadPanel";

const root = {
  id: "f".repeat(64),
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 9,
  content: "the thread's root",
  tags: [],
} as ChatMsg;

const transport = { messages: [root], canWrite: true, threadRepliesFor: () => [] } as unknown as ChatTransport;

function panel(props: { canWrite: boolean; postNotice?: string }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadPanel root={root} transport={transport} relayUrl="dm" groupId={"c".repeat(64)} onClose={() => {}} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// jsdom has no layout, so no scrolling either.
Element.prototype.scrollTo = () => {};

afterEach(cleanup);

describe("ThreadPanel's composer", () => {
  it("is there for a member who can post", () => {
    panel({ canWrite: true });
    expect(screen.getByTestId("composer")).toBeInTheDocument();
  });

  it("gives way to the reason a member who reads here can't post", () => {
    panel({ canWrite: true, postNotice: "You can't send messages in this channel." });
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.getByText("You can't send messages in this channel.")).toBeInTheDocument();
  });

  it("says to join when the thread isn't writable at all", () => {
    panel({ canWrite: false });
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.getByText("Join this channel to reply.")).toBeInTheDocument();
  });
});
