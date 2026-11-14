import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { ReactNode } from "react";

/**
 * A timeline paints what the store already had, and the messages that arrived while the
 * device slept land a moment later through the sync. Reactions and replies made in the
 * meantime on those late messages are older than the live subscription's `since`, so the
 * batched query has to run again for the ids it has not asked about.
 */

const RELAY = "wss://group.example";
const GROUP = "g";
const NOW = Math.floor(Date.now() / 1000);

const h = vi.hoisted(() => ({
  relayEvents: [] as NostrEvent[],
  queries: [] as NostrFilter[][],
}));

function ev(id: string, kind: number, tags: string[][], createdAt = NOW - 600): NostrEvent {
  return { id, kind, tags, pubkey: "b".repeat(64), content: "+", created_at: createdAt, sig: "" };
}

vi.mock("@nostrify/react", () => {
  const relay = {
    query: async (filters: NostrFilter[]) => {
      h.queries.push(filters);
      // A network round trip: the store-first answer has settled by the time this lands.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return h.relayEvents.filter((e) => matchFilters(filters as Filter[], e));
    },
    async *req(filters: NostrFilter[], opts: { signal: AbortSignal }) {
      for (const e of h.relayEvents) {
        if (matchFilters(filters as Filter[], e)) yield ["EVENT", "sub", e];
      }
      yield ["EOSE", "sub"];
      await new Promise((resolve) => opts.signal.addEventListener("abort", resolve));
    },
  };
  return { useNostr: () => ({ nostr: { relay: () => relay } }) };
});

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [] }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set() }) }));
vi.mock("@/hooks/useNostrPublish", () => ({ useNostrPublish: () => ({ mutateAsync: async () => undefined }) }));

const { useGroupReactions } = await import("./useReactions");
const { useGroupThreads } = await import("./useThread");

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.relayEvents = [];
  h.queries = [];
  // App.tsx's defaults: no refetch on focus, so nothing else re-runs the query.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
});

describe("useGroupReactions", () => {
  it("fetches reactions for messages that join the timeline after the first paint", async () => {
    h.relayEvents = [ev("r1", 7, [["e", "m1"]]), ev("r4", 7, [["e", "m4"]])];

    const view = renderHook(({ ids }) => useGroupReactions(RELAY, GROUP, ids), {
      wrapper,
      initialProps: { ids: ["m1", "m2", "m3"] },
    });
    await waitFor(() => expect(view.result.current.reactionsFor("m1").tallies).toHaveLength(1));

    view.rerender({ ids: ["m1", "m2", "m3", "m4", "m5"] });
    await waitFor(() => expect(view.result.current.reactionsFor("m4").tallies).toHaveLength(1));
    // What was already shown stays shown.
    expect(view.result.current.reactionsFor("m1").tallies).toHaveLength(1);
  });

  it("does not re-query when the visible set only shrinks", async () => {
    const view = renderHook(({ ids }) => useGroupReactions(RELAY, GROUP, ids), {
      wrapper,
      initialProps: { ids: ["m1", "m2", "m3"] },
    });
    await waitFor(() => expect(h.queries).toHaveLength(1));

    view.rerender({ ids: ["m2", "m3"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.queries).toHaveLength(1);
  });
});

describe("useGroupThreads", () => {
  it("counts replies on messages that join the timeline after the first paint", async () => {
    h.relayEvents = [ev("c4", 1111, [["E", "m4"], ["h", GROUP]])];

    const view = renderHook(({ ids }) => useGroupThreads(RELAY, GROUP, ids), {
      wrapper,
      initialProps: { ids: ["m1", "m2", "m3"] },
    });
    await waitFor(() => expect(h.queries.length).toBeGreaterThan(0));

    view.rerender({ ids: ["m1", "m2", "m3", "m4"] });
    await waitFor(() => expect(view.result.current.replyCountFor("m4")).toBe(1));
  });
});
