import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { MutedPubkeysContext } from "@/contexts/MutedPubkeysContext";
import { authorQueryKey, type AuthorResult } from "@/lib/authorCache";

import type { ReactNode } from "react";

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useEventStore", () => ({ useEventStore: () => Promise.resolve({ query: async () => [] }) }));
vi.mock("@/sync/profileSync", () => ({ demandProfiles: () => () => {}, hasProfileStamp: async () => false }));

const { useAuthor } = await import("@/hooks/useAuthor");

const PK = "a".repeat(64);
const PROFILE: AuthorResult = {
  metadata: { name: "ana", picture: "https://x.example/p.jpg", banner: "https://x.example/b.jpg" },
  imeta: { picture: { url: "https://x.example/p.jpg" } } as AuthorResult["imeta"],
};

function renderAuthor(muted: string[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authorQueryKey(PK), PROFILE);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MutedPubkeysContext.Provider value={{ mutedPubkeys: new Set(muted), ready: true }}>
        {children}
      </MutedPubkeysContext.Provider>
    </QueryClientProvider>
  );
  return renderHook(() => useAuthor(PK), { wrapper });
}

describe("useAuthor", () => {
  it("keeps a blocked user's name but not their picture or banner", async () => {
    const { result } = renderAuthor([PK]);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.metadata).toEqual({ name: "ana" });
    expect(result.current.data?.imeta).toBeUndefined();
  });

  it("leaves everyone else's profile alone", async () => {
    const { result } = renderAuthor([]);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual(PROFILE);
  });
});
