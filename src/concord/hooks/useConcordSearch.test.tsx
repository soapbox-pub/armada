/**
 * Search reads the store directly, so every drop the channel timeline makes is
 * repeated here; this file pins the Channel's own rules (CORD-03 §1, CORD-04 §8).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE } from "@/concord/lib/kinds";
import type { OpenedChat } from "@/concord/lib/chat";
import { EMPTY_SEARCH_FILTERS } from "@/concord/lib/search";

const CH = "e".repeat(64);
const COMMUNITY = "f".repeat(64);
const STRAY = "9".repeat(64);
const MEMBER = "b".repeat(64);

const h = vi.hoisted(() => ({ rows: [] as OpenedChat[] }));

vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>() }) }));
vi.mock("@/hooks/useDebounce", () => ({ useDebounce: (v: unknown) => v }));
vi.mock("@/concord/hooks/useChannel", () => ({
  useChatModeration: () => ({ ready: true, banned: new Set<string>() }),
}));
vi.mock("@/concord/hooks/useChannelRules", () => ({
  useChannelRules: () => () => ({ hold: (m: OpenedChat) => m.author === STRAY }),
}));
vi.mock("@/concord/lib/quarantineMemory", () => ({
  quarantineMemoryRevision: () => 0,
  recallQuarantined: () => undefined,
  subscribeQuarantineMemory: () => () => undefined,
}));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => undefined }));
vi.mock("@/concord/lib/rumorStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/rumorStore")>()),
  searchRumors: async () => h.rows,
  readStreamCursor: async () => ({ exhausted: true }),
}));

const { useConcordSearch } = await import("@/concord/hooks/useConcordSearch");

function row(id: string, author: string, at: number): OpenedChat {
  return { rumorId: id, author, kind: KIND_MESSAGE, createdAt: at, ms: at * 1000, content: "hello", tags: [["channel", CH]], channelIdHex: CH } as OpenedChat;
}

describe("useConcordSearch", () => {
  it("leaves out a post its channel holds back", async () => {
    h.rows = [row("stray", STRAY, 300), row("kept", MEMBER, 200)];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () =>
        useConcordSearch({ idHex: COMMUNITY } as never, [{ idHex: CH, streams: [] }] as never, { ...EMPTY_SEARCH_FILTERS, query: "hello" }),
      { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> },
    );
    await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0));
    expect(result.current.results.map((m) => m.id)).toEqual(["kept"]);
  });
});
