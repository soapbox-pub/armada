import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { nip19 } from "nostr-tools";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));
vi.mock("@/components/chat/GiftEmbed", () => ({
  GiftEmbed: ({ from }: { from: string }) => <div data-testid="gift-card" data-from={from} />,
}));
vi.mock("@/components/chat/LinkEmbed", () => ({
  LinkEmbed: ({ url }: { url: string }) => <div data-testid="link-card" data-url={url} />,
}));

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

const GIFTER = "b".repeat(64);
const GIFT = `https://armada.buzz/gift/${nip19.npubEncode(GIFTER)}`;

function renderContent(content: string) {
  const event: NostrEvent = {
    id: "0".repeat(64), pubkey: "a".repeat(64), created_at: 1700000000, kind: 9, tags: [], content, sig: "0".repeat(128),
  };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent event={event} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatContent gift links", () => {
  it("cards a gift link alone on its line, naming the gifter", () => {
    const { container } = renderContent(`I got you Armada Ultra! 🎁\n${GIFT}`);
    const card = container.querySelector("[data-testid=gift-card]");
    expect(card?.getAttribute("data-from")).toBe(GIFTER);
    expect(container.querySelector("[data-testid=link-card]")).toBeNull();
  });

  it("leaves a mid-sentence gift link inline", () => {
    const { container } = renderContent(`open ${GIFT} when you can`);
    expect(container.querySelector("[data-testid=gift-card]")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(GIFT);
  });
});
