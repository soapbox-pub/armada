/**
 * Discovery hook tests: the most network-facing unit, and the one that holds the
 * relay-hardening guarantees. A relay can return anything; these pin that the
 * hook only ever trusts the right kind from the right author, newest wins, and
 * an invalid manifest never partially renders.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearBotFlagMemory, useBotManifests } from "./useBotManifests";

import type { NostrEvent } from "@nostrify/nostrify";

const BOT_A = "a".repeat(64);
const BOT_B = "b".repeat(64);
const HUMAN = "c".repeat(64);
const STRANGER = "d".repeat(64);
const COMMUNITY_RELAY = "wss://community.example";

// Two event pools the mocked relay serves: kind-0 profiles for `nostr.query`,
// kind-10304 manifests for `nostr.group(relays).query`. A test seeds them and
// the hook reads them back, exactly as it would from a real relay.
const h = vi.hoisted(() => ({
  pool: [] as NostrEvent[], // what the network relays serve
  cache: [] as NostrEvent[], // what the local event store holds
  capturedManifestRelays: [] as string[],
  storeAsked: [] as string[][], // the authors each local-store read named
}));

// A deliberately sloppy relay: it honours the AUTHOR filter but returns every
// kind it holds for those authors, ignoring the `kinds` filter — which real
// relays are supposed to respect but a hostile or buggy one need not. That is
// exactly the condition the hook's own kind filtering defends against, so the
// mock must not do the filtering for it.
function match(filters: { kinds?: number[]; authors?: string[] }[]): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const f of filters) {
    for (const ev of h.pool) {
      if (f.authors && !f.authors.includes(ev.pubkey)) continue;
      out.push(ev);
    }
  }
  return out;
}

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      // Both sweeps go through an explicit relay set — capture it.
      group: (relays: string[]) => {
        h.capturedManifestRelays = relays;
        return { query: async (filters: { kinds?: number[]; authors?: string[] }[]) => match(filters) };
      },
    },
  }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://app.example"] } }),
}));

// The local event store: filters by author, ignores kind (same dumb-store shape).
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () =>
    Promise.resolve({
      query: async (filters: { authors?: string[] }[]) => {
        for (const f of filters) if (f.authors) h.storeAsked.push(f.authors);
        const out: NostrEvent[] = [];
        for (const f of filters) for (const ev of h.cache) {
          if (f.authors && !f.authors.includes(ev.pubkey)) continue;
          out.push(ev);
        }
        return out;
      },
    }),
}));

let seq = 1000;
function ev(pubkey: string, kind: number, content: string, createdAt?: number): NostrEvent {
  const created_at = createdAt ?? ++seq;
  return { id: `${pubkey}-${kind}-${created_at}`, pubkey, kind, content, created_at, tags: [], sig: "" };
}
const kind0 = (pubkey: string, meta: Record<string, unknown>, at?: number) =>
  ev(pubkey, 0, JSON.stringify(meta), at);
const manifest = (pubkey: string, commands: unknown[], at?: number) =>
  ev(pubkey, 10304, JSON.stringify({ v: 1, commands }), at);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return createElement(QueryClientProvider, { client }, children);
}

function render(members: string[] | undefined, relays?: string[]) {
  return renderHook(() => useBotManifests(members, relays), { wrapper });
}

beforeEach(() => {
  clearBotFlagMemory();
  h.pool = [];
  h.cache = [];
  h.capturedManifestRelays = [];
  h.storeAsked = [];
});

describe("useBotManifests", () => {
  it("discovers the bots among the members and reads their commands", async () => {
    h.pool = [
      kind0(BOT_A, { bot: true, name: "Alice" }),
      kind0(HUMAN, { name: "Carol" }), // no bot flag
      manifest(BOT_A, [{ name: "ping" }, { name: "roll", args: [{ name: "sides", type: "int" }] }]),
    ];
    const { result } = render([BOT_A, HUMAN]);

    await waitFor(() => expect(result.current.entries.length).toBe(2));
    expect(result.current.bots).toEqual([BOT_A]); // the human is not a bot
    expect(result.current.entries.map((e) => e.command.name)).toEqual(["ping", "roll"]);
    expect(result.current.entries.every((e) => e.bot === BOT_A)).toBe(true);
  });

  it("detects a bot the network won't serve but the local cache holds", async () => {
    // The real regression: a member's Bot pill renders from the cached kind-0,
    // but a fresh relay query returns nothing (slow, auth-gated, or the profile
    // only ever lived on a relay the pool doesn't cover). Detection must agree
    // with the pill, so the cache is read too. The manifest still comes over the
    // network here, proving the two sources compose.
    h.cache = [kind0(BOT_A, { bot: true, name: "Alice" })];
    h.pool = [manifest(BOT_A, [{ name: "ping" }])];
    const { result } = render([BOT_A]);
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.bots).toEqual([BOT_A]);
    expect(result.current.entries[0].command.name).toBe("ping");
  });

  it("surfaces member profiles as a by-product, for the user-arg picker", async () => {
    h.pool = [kind0(BOT_A, { bot: true, name: "Alice", picture: "http://a/x.png" })];
    const { result } = render([BOT_A]);
    await waitFor(() => expect(result.current.profiles[BOT_A]).toBeDefined());
    expect(result.current.profiles[BOT_A]).toEqual({ name: "Alice", picture: "http://a/x.png" });
  });

  it("does not let a relay un-discover a bot by answering the kind-0 query with a manifest", async () => {
    // The security fix: a bot's manifest is newer than its profile, so a relay
    // returning the kind-10304 to a kind-0 REQ would win newest-per-author and
    // the `bot: true` would be lost. The kind filter must ignore the wrong kind.
    h.pool = [
      kind0(BOT_A, { bot: true, name: "Alice" }, 100), // older
      manifest(BOT_A, [{ name: "ping" }], 200), // newer, but wrong kind for the kind-0 sweep
    ];
    const { result } = render([BOT_A]);
    await waitFor(() => expect(result.current.bots).toEqual([BOT_A]));
    expect(result.current.entries.map((e) => e.command.name)).toEqual(["ping"]);
  });

  it("discards events from authors it never asked about", async () => {
    h.pool = [
      kind0(BOT_A, { bot: true, name: "Alice" }),
      kind0(STRANGER, { bot: true, name: "Nobody" }), // not a member
      manifest(BOT_A, [{ name: "ping" }]),
      manifest(STRANGER, [{ name: "evil" }]),
    ];
    const { result } = render([BOT_A]);
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.bots).toEqual([BOT_A]);
    expect(result.current.entries[0].command.name).toBe("ping");
  });

  it("takes the newest event per author, so a demoted bot stops being one", async () => {
    h.pool = [
      kind0(BOT_A, { bot: true, name: "Alice" }, 100),
      kind0(BOT_A, { bot: false, name: "Alice" }, 200), // newer: no longer a bot
    ];
    const { result } = render([BOT_A]);
    // Nothing to wait on becoming truthy, so let the query settle then assert.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bots).toEqual([]);
    expect(result.current.entries).toEqual([]);
  });

  it("keeps a bot with an invalid manifest in the roster but gives it no commands", async () => {
    h.pool = [
      kind0(BOT_A, { bot: true, name: "Alice" }),
      manifest(BOT_A, [{ name: "OK", args: [] }]), // uppercase name: invalid → whole manifest ignored
    ];
    const { result } = render([BOT_A]);
    await waitFor(() => expect(result.current.bots).toEqual([BOT_A]));
    expect(result.current.entries).toEqual([]);
  });

  it("takes the newest manifest per author", async () => {
    h.pool = [
      kind0(BOT_A, { bot: true, name: "Alice" }),
      manifest(BOT_A, [{ name: "old" }], 100),
      manifest(BOT_A, [{ name: "new" }], 200),
    ];
    const { result } = render([BOT_A, BOT_B]);
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.entries[0].command.name).toBe("new");
  });

  it("searches the conversation's own relays alongside the app relays, and nothing else", async () => {
    h.pool = [kind0(BOT_A, { bot: true, name: "Alice" }), manifest(BOT_A, [{ name: "ping" }])];
    const { result } = render([BOT_A], [COMMUNITY_RELAY]);
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    // A bot may publish its manifest ONLY to its community relay — it must be
    // queried. Exact equality: discovery must never connect to a relay the user
    // has not configured and the conversation does not use.
    expect(h.capturedManifestRelays).toEqual(["wss://app.example", COMMUNITY_RELAY]);
  });

  it("reads only the members it hasn't read when the roster grows", async () => {
    h.cache = [kind0(BOT_A, { bot: true, name: "Alice" }), kind0(HUMAN, { name: "Carol" })];
    const first = render([BOT_A]);
    await waitFor(() => expect(first.result.current.bots).toEqual([BOT_A]));
    h.storeAsked = [];
    const second = render([BOT_A, HUMAN]);
    await waitFor(() => expect(second.result.current.profiles[HUMAN]?.name).toBe("Carol"));
    expect(h.storeAsked).toEqual([[HUMAN]]);
    expect(second.result.current.bots).toEqual([BOT_A]);
    expect(second.result.current.profiles[BOT_A]?.name).toBe("Alice");
  });

  it("does nothing without a roster (a plain DM)", async () => {
    h.pool = [kind0(BOT_A, { bot: true, name: "Alice" }), manifest(BOT_A, [{ name: "ping" }])];
    const { result } = render(undefined);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bots).toEqual([]);
    expect(result.current.entries).toEqual([]);
    expect(h.capturedManifestRelays).toEqual([]); // never queried
  });
});
