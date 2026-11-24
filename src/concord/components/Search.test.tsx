import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRef, useState, type ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";
import type { Channel } from "@/concord/lib/types";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsTouch: () => false,
  useIsMobile: () => false,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { query: async () => [] } }) }));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [], event: async () => {} }),
}));
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
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: () => Promise.resolve() }));

import { SearchResultsView, SearchTokenSuggest } from "@/concord/components/Search";
import { EMPTY_SEARCH_FILTERS, type SearchFilters } from "@/concord/lib/search";

const CHANNEL = "c".repeat(64);

const message = {
  id: "f".repeat(64),
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 9,
  content: "hello there",
  tags: [["channel", CHANNEL]],
} as ChatMsg;

const channels = [{ idHex: CHANNEL, name: "general", isPrivate: false }] as unknown as Channel[];

afterEach(cleanup);

function renderResults(onJump: (channelIdHex: string, message: ChatMsg) => void, list = channels) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SearchResultsView channels={list} results={[message]} isLoading={false} query="" onJump={onJump} filters={EMPTY_SEARCH_FILTERS} onFiltersChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMenu() {
  fireEvent.contextMenu(screen.getByText("hello there"));
  return screen.findByRole("menu");
}

describe("SearchResultsView", () => {
  it("jumps once from the context menu's Jump to message", async () => {
    const onJump = vi.fn();
    renderResults(onJump);

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /jump to message/i }));
    await act(() => new Promise((r) => setTimeout(r, 0)));

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(CHANNEL, message);
  });

  it("does not jump when another menu action is chosen", async () => {
    const onJump = vi.fn();
    renderResults(onJump);

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /copy text/i }));
    await act(() => new Promise((r) => setTimeout(r, 0)));

    expect(onJump).not.toHaveBeenCalled();
  });

  it("still jumps on a plain click of the row", () => {
    const onJump = vi.fn();
    renderResults(onJump);

    fireEvent.click(screen.getByText("hello there"));

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("offers no jump when the channel is unknown", async () => {
    renderResults(vi.fn(), []);

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /jump to message/i })).toBeNull();
  });

  it("shows active facets as removable chips", () => {
    const onFiltersChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SearchResultsView
            channels={channels}
            results={[]}
            isLoading={false}
            query=""
            onJump={vi.fn()}
            filters={{ ...EMPTY_SEARCH_FILTERS, media: "images", channelIds: [CHANNEL] }}
            onFiltersChange={onFiltersChange}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("#general")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Images" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ media: "all", channelIds: [CHANNEL] }));
  });

  it("offers more results only when the page is full", () => {
    const onLoadMore = vi.fn();
    const view = (hasMore: boolean) => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SearchResultsView
            channels={channels}
            results={[message]}
            isLoading={false}
            query=""
            onJump={vi.fn()}
            filters={EMPTY_SEARCH_FILTERS}
            onFiltersChange={() => {}}
            hasMore={hasMore}
            onLoadMore={onLoadMore}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(view(false));
    expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();

    rerender(view(true));
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

function SuggestHarness({ initial = EMPTY_SEARCH_FILTERS }: { initial?: SearchFilters }) {
  const [filters, setFilters] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <input
        ref={ref}
        aria-label="search"
        value={filters.query}
        onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
      />
      <SearchTokenSuggest inputRef={ref} filters={filters} onChange={setFilters} members={[]} channels={channels} />
      <output data-testid="state">{JSON.stringify(filters)}</output>
    </QueryClientProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent!) as SearchFilters;

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
  fireEvent.input(input);
}

describe("SearchTokenSuggest", () => {
  it("offers filter keys and completes one", () => {
    render(<SuggestHarness />);
    const input = screen.getByLabelText("search") as HTMLInputElement;
    input.focus();
    type(input, "h");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state().query).toBe("has:");
  });

  it("turns a picked in: channel into a facet", () => {
    render(<SuggestHarness />);
    const input = screen.getByLabelText("search") as HTMLInputElement;
    input.focus();
    type(input, "cats in:gen");
    fireEvent.pointerDown(screen.getByText("general"));
    expect(state()).toMatchObject({ query: "cats ", channelIds: [CHANNEL] });
  });

  it("keeps Escape from reaching the bar while open", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <SuggestHarness />
      </div>,
    );
    const input = screen.getByLabelText("search") as HTMLInputElement;
    input.focus();
    type(input, "has:");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByText("link")).toBeNull();
  });
});
