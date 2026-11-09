import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

const fixture = vi.hoisted(() => {
  const self = "f".repeat(64);
  const alice = "a".repeat(64);
  const aliceConversation = {
    key: alice,
    peers: [alice],
    latest: {
      rumorId: "alice-latest",
      author: alice,
      createdAt: 1_700_000_000,
      kind: 14,
      content: "A message that does not contain her username",
      tags: [],
    },
    mine: true,
  };
  const dm17Conversations = [aliceConversation];
  return {
    self,
    alice,
    aliceConversation,
    dmName: "alice",
    dmSearchText: "alice",
    app: {
      config: { railLayout: [], pinnedDms: [], startedDms: [] },
    },
    currentUser: { user: { pubkey: self } },
    liveServers: [] as string[],
    communities: [],
    legacyDmResult: { conversations: [], isLoading: false },
    dm17Result: { conversations: dm17Conversations, isLoading: false },
    knownDmResult: { isKnown: () => true, isLoading: false, displayLoading: false },
    closedDmResult: { isClosed: () => false, reopen: vi.fn() },
    searchMessages: vi.fn(async (..._args: unknown[]) => []),
    buildEntries: vi.fn(async () => ({
      spaces: [],
      channels: [
        {
          key: "c2:community::town-square",
          id: "town-square",
          name: "Town Square",
          spaceName: "Armada Test",
          route: "/c/community/town-square",
          communityIdHex: "community",
        },
      ],
    })),
    queryClient: {},
    eventStore: Promise.resolve({ query: vi.fn(async () => []) }),
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => fixture.queryClient,
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => fixture.app,
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => fixture.currentUser,
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => fixture.eventStore,
}));

vi.mock("@/hooks/useNip29Servers", () => ({
  useNip29Servers: () => fixture.liveServers,
}));

vi.mock("@/concord/hooks/useCommunityList", () => ({
  useLiveCommunities: () => fixture.communities,
}));

vi.mock("@/hooks/useDirectMessages", () => ({
  useDMConversations: () => fixture.legacyDmResult,
}));

vi.mock("@/hooks/useDm17", () => ({
  useDm17Conversations: () => fixture.dm17Result,
}));

vi.mock("@/hooks/useKnownDmPeers", () => ({
  useKnownDmPeers: () => fixture.knownDmResult,
}));

vi.mock("@/hooks/useClosedDms", () => ({
  useClosedDms: () => fixture.closedDmResult,
}));

vi.mock("@/hooks/useDmConversationName", () => ({
  useDmConversationName: (peers: readonly string[]) => {
    const isAlice = peers.includes(fixture.alice);
    const name = isAlice ? fixture.dmName : "Anonymous";
    return {
      name,
      searchText: isAlice ? fixture.dmSearchText : name,
      names: [name],
      metadata: { name },
      emojiTags: [],
    };
  },
}));

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => ({
    data: pubkey === fixture.alice ? { metadata: { name: "alice" } } : undefined,
  }),
}));

vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (_pubkey: string | undefined, metadata?: { name?: string }) =>
    metadata?.name ?? "Anonymous",
}));

vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name, pubkey }: { name?: string; pubkey?: string }) => (
    <>{name ?? (pubkey === fixture.alice ? "alice" : "Anonymous")}</>
  ),
}));

vi.mock("@/lib/switcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/switcher")>()),
  buildSwitcherEntries: fixture.buildEntries,
  nextChannelRoute: vi.fn(async () => null),
  searchSwitcherMessages: fixture.searchMessages,
  switcherLiveKeys: () => [],
}));

import { QuickSwitcher } from "./QuickSwitcher";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderSwitcher() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <QuickSwitcher />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function openSwitcher() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  return screen.getByPlaceholderText("Where would you like to go?");
}

beforeAll(() => {
  // cmdk scrolls its selected option into view; jsdom has no implementation.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  cleanup();
  fixture.dm17Result.conversations = [fixture.aliceConversation];
  fixture.legacyDmResult.isLoading = false;
  fixture.dm17Result.isLoading = false;
  fixture.knownDmResult.isLoading = false;
  fixture.knownDmResult.displayLoading = false;
  fixture.dmName = "alice";
  fixture.dmSearchText = "alice";
  vi.clearAllMocks();
});

describe("QuickSwitcher direct-message destinations", () => {
  it("finds a DM by username and opens its canonical conversation route", async () => {
    renderSwitcher();
    const input = openSwitcher();

    fireEvent.change(input, { target: { value: "alice" } });

    // Message-content search deliberately contributes no result: this option
    // exists because the conversation participant's profile name matched.
    await waitFor(() => expect(fixture.searchMessages).toHaveBeenCalled());
    expect(fixture.searchMessages).toHaveBeenCalledWith(
      "alice",
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({
        scope: "all",
        allowedDmConversationKeys: expect.any(Set),
      }),
    );
    const searchOpts = fixture.searchMessages.mock.calls.at(-1)?.[3] as
      | { allowedDmConversationKeys?: ReadonlySet<string> }
      | undefined;
    expect(searchOpts?.allowedDmConversationKeys?.has(fixture.alice)).toBe(true);
    const destination = await screen.findByRole("option", { name: /alice/i });
    fireEvent.click(destination);

    expect(fixture.closedDmResult.reopen).toHaveBeenCalledWith(fixture.alice);
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/dm/${nip19.npubEncode(fixture.alice)}`,
    );
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Where would you like to go?"),
      ).not.toBeInTheDocument();
    });
  });

  it.each(["legacy", "nip17", "trust"] as const)(
    "waits for %s DM state before publishing destinations",
    (loading) => {
      if (loading === "legacy") fixture.legacyDmResult.isLoading = true;
      if (loading === "nip17") fixture.dm17Result.isLoading = true;
      if (loading === "trust") fixture.knownDmResult.displayLoading = true;
      renderSwitcher();
      openSwitcher();

      expect(screen.getByText("Loading direct messages…")).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /alice/i })).not.toBeInTheDocument();
    },
  );

  it("searches hidden aliases beyond the blank launcher's eager rows", async () => {
    fixture.dmName = "Alice Cooper";
    fixture.dmSearchText = "Alice Cooper secret-handle";
    const decoys = Array.from({ length: 12 }, (_, i) => {
      const peer = (i + 1).toString(16).padStart(64, "0");
      return {
        key: peer,
        peers: [peer],
        latest: {
          rumorId: `decoy-${i}`,
          author: peer,
          createdAt: 1_800_000_000 - i,
          kind: 14,
          content: "No matching profile name",
          tags: [],
        },
        mine: true,
      };
    });
    fixture.dm17Result.conversations = [...decoys, fixture.aliceConversation];

    renderSwitcher();
    const input = openSwitcher();
    expect(screen.queryByRole("option", { name: /Alice Cooper/i })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "secret-handle" } });

    expect(await screen.findByRole("option", { name: /Alice Cooper/i })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /Alice Cooper/i })).not.toBeInTheDocument();
    });
  });

  it("shows DM destinations only in the All and DMs scopes", async () => {
    renderSwitcher();
    openSwitcher();

    expect(await screen.findByRole("option", { name: /alice/i })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Town Square/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "DMs" }));
    expect(screen.getByRole("option", { name: /alice/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Town Square/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Channels" }));
    expect(screen.queryByRole("option", { name: /alice/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Town Square/i })).toBeInTheDocument();
  });
});
