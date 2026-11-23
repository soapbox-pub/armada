import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMsg } from "@/components/chat/transport";

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
vi.mock("@/hooks/useSearchProfiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSearchProfiles")>()),
  useSearchProfiles: () => ({ data: [] }),
}));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name ?? "Alice"}</span>,
}));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));

import { MentionRosterContext } from "@/components/chat/mentionRoster";
import { ThreadMessage } from "@/components/chat/ThreadPanel";

const alice = "a".repeat(64);
const aliceRef = `nostr:${nip19.npubEncode(alice)}`;

const event = {
  id: "f".repeat(64),
  pubkey: alice,
  created_at: 1_700_000_000,
  kind: 1111,
  content: `thanks ${aliceRef}`,
  tags: [["p", alice]],
} as ChatMsg;

afterEach(cleanup);

describe("ThreadMessage editing", () => {
  it("edits through the mention-aware box and saves canonical mentions", () => {
    const client = new QueryClient();
    client.setQueryData(["author", alice], { metadata: { name: "Alice" } });
    const onEditSubmit = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MentionRosterContext.Provider value={[alice]}>
            <ThreadMessage event={event} canReact={false} isEditing onEditSubmit={onEditSubmit} onEditCancel={() => {}} />
          </MentionRosterContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(field.value).toBe("thanks @Alice");

    const value = `${field.value} @al`;
    act(() => {
      fireEvent.change(field, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
      fireEvent.input(field);
    });
    expect(document.querySelector("[data-autocomplete-dropdown]")?.textContent).toContain("Alice");

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onEditSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onEditSubmit).toHaveBeenCalledWith(event, `thanks ${aliceRef} ${aliceRef} `);
  });
});
