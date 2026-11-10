/**
 * The Mentions list reads its own `#p` index, not the channel timeline, so it
 * does not inherit the fold's Banlist drop (CORD-04 §4); the hook repeats it
 * for the Mentions tab, the Notification Center and the @ dot on the rail.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE } from "@/concord/lib/kinds";
import type { OpenedChat } from "@/concord/lib/chat";
import { emptyRoles } from "@/concord/lib/roles";

const ME = "a".repeat(64);
const X = "b".repeat(64);
const Y = "c".repeat(64);
const OWNER = "d".repeat(64);
const CH = "e".repeat(64);
const COMMUNITY = "f".repeat(64);

const h = vi.hoisted(() => ({
  rumors: [] as OpenedChat[],
  readState: {} as Record<string, number>,
  folded: undefined as { banned: Set<string>; roster: unknown; ownerHex: string } | undefined,
  queryMentionRumors: vi.fn(),
  held: new Set<string>(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>() }) }));
vi.mock("@/concord/lib/rumorStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/rumorStore")>()),
  queryMentionRumors: h.queryMentionRumors,
}));
vi.mock("@/concord/hooks/useControlPlane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: h.folded }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunityEntry: () => undefined }));
vi.mock("@/concord/lib/quarantineMemory", () => ({
  quarantineMemoryRevision: () => 0,
  recallQuarantined: () => undefined,
  subscribeQuarantineMemory: () => () => undefined,
}));
vi.mock("@/hooks/useReadState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useReadState")>()),
  useReadState: () => ({ readState: h.readState, markRead: vi.fn() }),
}));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => undefined }));
vi.mock("@/concord/hooks/useChannelRules", () => ({
  useChannelRules: () => () => ({ hold: (m: OpenedChat) => h.held.has(m.author) }),
}));

const { useConcordMentions } = await import("@/concord/hooks/useConcordMentions");

/** A direct mention of ME (only the fields the hook reads). */
function mention(rumorId: string, author: string, createdAt: number): OpenedChat {
  return {
    rumorId,
    author,
    kind: KIND_MESSAGE,
    createdAt,
    ms: createdAt * 1000,
    content: "hi",
    tags: [["p", ME]],
    channelIdHex: CH,
  } as OpenedChat;
}

function fold(banned: string[]) {
  return { banned: new Set(banned), roster: emptyRoles(), ownerHex: OWNER };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    () => useConcordMentions({ idHex: COMMUNITY, owner: OWNER } as never, [{ idHex: CH } as never]),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

const ids = (r: ReturnType<typeof render>) => r.result.current.mentions.map((m) => m.id);

beforeEach(() => {
  h.rumors = [];
  h.readState = {};
  h.folded = undefined;
  h.held = new Set();
  h.queryMentionRumors.mockReset();
  h.queryMentionRumors.mockImplementation(async () => h.rumors);
});

describe("useConcordMentions — the Banlist folds into the list", () => {
  it("drops a banned author's mention and does not light the @ dot", async () => {
    h.rumors = [mention("B", X, 300), mention("A", Y, 200)];
    h.readState[`c2m:${COMMUNITY}`] = 200;
    h.folded = fold([X]);
    const r = render();
    await waitFor(() => expect(r.result.current.isLoading).toBe(false));
    expect(ids(r)).toEqual(["A"]);
    expect(r.result.current.hasNew).toBe(false);
  });

  it("keeps an unbanned author's mention (the drop is not blanket)", async () => {
    h.rumors = [mention("B", X, 300)];
    h.readState[`c2m:${COMMUNITY}`] = 200;
    h.folded = fold([Y]);
    const r = render();
    await waitFor(() => expect(ids(r)).toEqual(["B"]));
    expect(r.result.current.hasNew).toBe(true);
  });

  it("applies a ban that lands after the scan without a re-scan", async () => {
    h.rumors = [mention("B", X, 300)];
    const r = render();
    await waitFor(() => expect(ids(r)).toEqual(["B"]));
    h.folded = fold([X]);
    r.rerender();
    expect(ids(r)).toEqual([]);
    expect(r.result.current.hasNew).toBe(false);
    expect(h.queryMentionRumors).toHaveBeenCalledTimes(1);
  });
});

describe("useConcordMentions — a channel's own rules", () => {
  it("drops a mention its channel holds back, and does not light the @ dot", async () => {
    h.rumors = [mention("B", X, 300), mention("A", Y, 200)];
    h.readState[`c2m:${COMMUNITY}`] = 200;
    h.held = new Set([X]);
    const r = render();
    await waitFor(() => expect(r.result.current.isLoading).toBe(false));
    expect(ids(r)).toEqual(["A"]);
    expect(r.result.current.hasNew).toBe(false);
  });
});
