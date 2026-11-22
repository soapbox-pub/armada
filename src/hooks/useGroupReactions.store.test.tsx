import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { ReactNode } from "react";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

/**
 * Against the real store: a NIP-29 reaction carries `h`, so it is filed under `nip29:<relay>`,
 * and a refetch triggered by an older page must find it there rather than wait on the relay.
 */

const RELAY = "wss://group.example";
const GROUP = "g";
const NOW = Math.floor(Date.now() / 1000);

const h = vi.hoisted(() => ({
  relayEvents: [] as NostrEvent[],
  queries: [] as NostrFilter[][],
  /** Answer only the first relay query; later ones hang until aborted (a slow relay / timeout). */
  answerOnce: true,
}));

function ev(id: string, kind: number, tags: string[][], createdAt = NOW - 86_400): NostrEvent {
  return { id, kind, tags, pubkey: "b".repeat(64), content: "😂", created_at: createdAt, sig: "0".repeat(128) };
}

vi.mock("@nostrify/react", () => {
  const relay = {
    query: async (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => {
      h.queries.push(filters);
      if (h.answerOnce && h.queries.length > 1) {
        await new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return h.relayEvents.filter((e) => matchFilters(filters as Filter[], e));
    },
    async *req(_filters: NostrFilter[], opts: { signal: AbortSignal }) {
      yield ["EOSE", "sub"];
      await new Promise((resolve) => opts.signal.addEventListener("abort", resolve));
    },
  };
  return { useNostr: () => ({ nostr: { relay: () => relay } }) };
});

vi.mock("@/hooks/useEventStore", async () => {
  const { appEventStore } = await import("@/lib/db/mainEventStore");
  return { useEventStore: () => appEventStore() };
});
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set() }) }));
vi.mock("@/hooks/useNostrPublish", () => ({ useNostrPublish: () => ({ mutateAsync: async () => undefined }) }));

const { useGroupReactions } = await import("./useReactions");
const { appEventStore } = await import("@/lib/db/mainEventStore");

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.relayEvents = [];
  h.queries = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
});

describe("useGroupReactions after an older page loads", () => {
  it("keeps a day-old reaction the store already holds", async () => {
    const reaction = ev("r1".padEnd(64, "0"), 7, [["e", "m1"], ["k", "9"], ["h", GROUP]]);
    h.relayEvents = [reaction];
    // As the relay mirror (`cacheEvents(events, sourceUrl)`) files it.
    const store = await appEventStore();
    await store.event(reaction, { relay: RELAY });
    expect(await store.query([{ kinds: [7], "#e": ["m1"] }], { relay: RELAY })).toHaveLength(1);

    const view = renderHook(({ ids }) => useGroupReactions(RELAY, GROUP, ids), {
      wrapper,
      initialProps: { ids: ["m1", "m2", "m3"] },
    });
    await waitFor(() => expect(view.result.current.reactionsFor("m1").tallies).toHaveLength(1));

    // Scrolling up: `loadOlder` prepends a page, `useRefetchOnNewIds` reruns the query.
    view.rerender({ ids: ["m0a", "m0b", "m1", "m2", "m3"] });
    await waitFor(() => expect(h.queries).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(view.result.current.reactionsFor("m1").tallies).toHaveLength(1);
  });
});
