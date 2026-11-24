import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMemberProfiles, useRosterProfiles } from "@/hooks/useSearchProfiles";

import type { ReactNode } from "react";
import type { NostrRumor } from "@/lib/nostrRumor";

const pk = (n: number) => n.toString(16).padStart(64, "0");
const kind0 = (pubkey: string, name: string): NostrRumor => ({
  id: `id-${pubkey}`, pubkey, kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name }),
});

const fixture = vi.hoisted(() => ({
  stored: [] as NostrRumor[],
  relayQuery: vi.fn(async () => [] as NostrRumor[]),
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { query: fixture.relayQuery } }) }));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({
    query: async ([f]: [{ authors: string[] }]) => fixture.stored.filter((e) => f.authors.includes(e.pubkey)),
    event: async () => {},
  }),
}));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>() }) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useMemberProfiles", () => {
  const members = Array.from({ length: 30 }, (_, i) => pk(i + 1));

  it("keeps the default of 10 and honours a larger limit", () => {
    const { result: short } = renderHook(() => useMemberProfiles(members, ""), { wrapper });
    expect(short.current).toHaveLength(10);
    const { result: long } = renderHook(() => useMemberProfiles(members, "", { limit: 50 }), { wrapper });
    expect(long.current).toHaveLength(30);
  });

  it("matches by name a member whose profile is only in the store once the roster is loaded", async () => {
    fixture.stored = [kind0(members[17], "Zelda")];
    const { result: unloaded } = renderHook(() => useMemberProfiles(members, "zel"), { wrapper });
    expect(unloaded.current).toEqual([]);

    const { result } = renderHook(
      () => useMemberProfiles(members, "zel", { loaded: useRosterProfiles(members, true) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.map((p) => p.pubkey)).toEqual([members[17]]));
    // Every member missing from the store is asked of the relays.
    expect(fixture.relayQuery).toHaveBeenCalledWith(
      [{ kinds: [0], authors: members.filter((m) => m !== members[17]) }],
      expect.anything(),
    );
  });

  it("lists named members before bare keys", async () => {
    fixture.stored = [kind0(members[29], "Yuri")];
    const { result } = renderHook(
      () => useMemberProfiles(members, "", { loaded: useRosterProfiles(members, true), limit: 50 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current[0].pubkey).toBe(members[29]));
  });
});
