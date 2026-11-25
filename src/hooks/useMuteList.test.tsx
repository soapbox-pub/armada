/**
 * Regression tests for the kind-10000 mute-list wipe hazard.
 *
 * useMuteUser is an explicit action, but it is a read-modify-write against a
 * replaceable event: if the read comes back empty while the user HAS a mute
 * list (cold pool, AUTH, wrong relay set), appending to "nothing" publishes a
 * list containing only the new mute — wiping the real one everywhere. The
 * locally-persisted mute cache is the safety net: refuse instead. See
 * AGENTS.md "Never publish a user's Nostr lists without an explicit user
 * action" (the refuse-on-empty-read clause).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useMutedPubkeysSource,
  useMuteUser,
  useUnmuteUser,
} from "@/hooks/useMuteList";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const TARGET = "b".repeat(64);
const EXISTING_PUBLIC = "c".repeat(64);
const EXISTING_PRIVATE = "d".repeat(64);

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readFolded: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  writeFolded: vi.fn<(...args: unknown[]) => Promise<void>>(),
  user: undefined as { pubkey: string; signer: { nip44: typeof nip44 } } | undefined,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      group: () => ({ query: h.query }),
      relay: () => ({ query: h.query }),
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: true,
      appRelays: ["wss://app.example/"],
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    },
  }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));
vi.mock("@/lib/nip65", () => ({
  uniqueRelayUrls: (values: Iterable<string>) => [...new Set(values)],
  queryExplicitRelaysWithStatus: async (
    _nostr: unknown,
    relays: string[],
  ) => {
    try {
      return { events: await h.query(), answered: [...relays], failed: [] };
    } catch {
      return { events: [], answered: [], failed: [...relays] };
    }
  },
}));

/** Reversible fake NIP-44: ciphertext is `enc:` + plaintext. */
const nip44 = {
  encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
  decrypt: async (_pk: string, ciphertext: string) => {
    if (!ciphertext.startsWith("enc:")) throw new Error("bad ciphertext");
    return ciphertext.slice(4);
  },
};

let evCounter = 0;
function muteEvent(opts: { tags?: string[][]; privateTags?: string[][] }): NostrEvent {
  return {
    id: `mute${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: SELF,
    created_at: 1000,
    kind: 10000,
    tags: opts.tags ?? [],
    content: opts.privateTags ? `enc:${JSON.stringify(opts.privateTags)}` : "",
    sig: "f".repeat(128),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.query.mockReset();
  h.publish.mockReset().mockImplementation(async (value: unknown) => ({
    ...(value as NostrEvent),
    id: `published${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: SELF,
    sig: "e".repeat(128),
  }));
  h.readFolded.mockReset().mockResolvedValue(undefined);
  h.writeFolded.mockReset().mockResolvedValue(undefined);
  h.user = { pubkey: SELF, signer: { nip44 } };
});

describe("useMutedPubkeysSource authority", () => {
  it("keeps an absent cache additive-only until an explicit empty wire result succeeds", async () => {
    h.user = { pubkey: "9".repeat(64), signer: { nip44 } };
    let finish!: (events: NostrEvent[]) => void;
    h.query.mockImplementation(() => new Promise<NostrEvent[]>((resolve) => { finish = resolve; }));

    const view = renderHook(() => useMutedPubkeysSource(), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.wireReady).toBe(false);
    expect(view.result.current.configReady).toBe(false);

    await act(async () => { finish([]); });
    await waitFor(() => expect(view.result.current.wireReady).toBe(true));
    expect([...view.result.current.mutedPubkeys]).toEqual([]);
    expect(view.result.current.configReady).toBe(true);
  });

  it("does not turn a failed cold wire read into prune authority", async () => {
    h.user = { pubkey: "8".repeat(64), signer: { nip44 } };
    h.query.mockRejectedValue(new Error("offline"));

    const view = renderHook(() => useMutedPubkeysSource(), { wrapper });
    await waitFor(() => expect(h.query).toHaveBeenCalled());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.wireReady).toBe(false);
  });

  it("keeps a local mute seed additive when every wire relay fails", async () => {
    h.user = { pubkey: "6".repeat(64), signer: { nip44 } };
    h.readFolded.mockResolvedValue([EXISTING_PRIVATE]);
    h.query.mockRejectedValue(new Error("offline"));

    const view = renderHook(() => useMutedPubkeysSource(), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.mutedPubkeys.has(EXISTING_PRIVATE)).toBe(true);
    expect(view.result.current.wireReady).toBe(false);
    expect(h.writeFolded).not.toHaveBeenCalled();
  });

  it("trusts a versioned last-good mute seed for config but not pruning", async () => {
    h.user = { pubkey: "5".repeat(64), signer: { nip44 } };
    h.readFolded.mockResolvedValue({
      pubkeys: [EXISTING_PRIVATE],
      version: { id: "1".repeat(64), created_at: 10 },
    });
    h.query.mockRejectedValue(new Error("offline"));

    const view = renderHook(() => useMutedPubkeysSource(), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.configReady).toBe(true);
    expect(view.result.current.wireReady).toBe(false);
  });

  it("does not permanently withhold config authority from a legacy superset seed", async () => {
    // A pre-versioning folded seed that is a strict superset of the complete
    // relay winner (e.g. the peer was unmuted in another client) takes the
    // union as its conservative floor — correct. But nothing ever stamps a
    // version onto that seed, so `configReady: false` is STICKY: it survives
    // every refetch and every reload until the user happens to mute or unmute
    // someone. It propagates as mutesConfigReady → useKnownDmPeers'
    // `configurationReady` → `dmConfigReady` → `readyPlanePushSpecs`, which
    // drops every `armada-dm*` spec, so the install silently stops receiving
    // DM push. The union is at least as safe as either input, so it is
    // trusted last-good data for sealing config; only PRUNE authority
    // (`wireReady`) has to keep waiting.
    h.user = { pubkey: "4".repeat(64), signer: { nip44 } };
    h.readFolded.mockResolvedValue([EXISTING_PRIVATE]);
    h.query.mockResolvedValue([{
      ...muteEvent({ tags: [["p", EXISTING_PUBLIC]] }),
      pubkey: h.user.pubkey,
    }]);

    const view = renderHook(() => useMutedPubkeysSource(), { wrapper });
    await waitFor(() => expect(view.result.current.mutedPubkeys.has(EXISTING_PUBLIC)).toBe(true));
    // The conservative floor is retained either way.
    expect(view.result.current.mutedPubkeys.has(EXISTING_PRIVATE)).toBe(true);
    // A complete cohort still cannot prune, because the extra local mute is
    // not attributable to any relay version.
    expect(view.result.current.wireReady).toBe(false);
    // …but it is enough to seal a device notification config.
    expect(view.result.current.configReady).toBe(true);
  });

  it("keeps and does not overwrite last-good private mutes after decrypt failure", async () => {
    h.user = { pubkey: "7".repeat(64), signer: { nip44 } };
    h.readFolded.mockResolvedValue([EXISTING_PRIVATE]);
    h.query.mockResolvedValue([{
      ...muteEvent({ tags: [["p", EXISTING_PUBLIC]] }),
      pubkey: h.user.pubkey,
      content: "not-decryptable",
    }]);

    const view = renderHook(() => useMutedPubkeysSource(), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    await waitFor(() => expect(view.result.current.mutedPubkeys.has(EXISTING_PUBLIC)).toBe(true));
    expect(view.result.current.mutedPubkeys.has(EXISTING_PRIVATE)).toBe(true);
    expect(view.result.current.wireReady).toBe(false);
    expect(h.writeFolded).not.toHaveBeenCalled();
  });
});

describe("useMuteUser (kind 10000 read-modify-write)", () => {
  it("hides the peer optimistically before relay and signer work finishes", async () => {
    let resolveQuery!: (events: NostrEvent[]) => void;
    h.query.mockImplementation(
      () => new Promise<NostrEvent[]>((resolve) => { resolveQuery = resolve; }),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const queryKey = ["mute-list", SELF, "wss://app.example"];
    client.setQueryData(queryKey, {
      pubkeys: [EXISTING_PUBLIC],
      wireReady: true,
      configReady: true,
    });
    const testWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMuteUser(), { wrapper: testWrapper });
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.mutateAsync(TARGET);
      await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
    });

    const optimistic = client.getQueryData(queryKey);

    // Release the global write queue before asserting so a regression here
    // cannot leave every subsequent mutation test waiting on this promise.
    resolveQuery([
      muteEvent({ tags: [["p", EXISTING_PUBLIC]], privateTags: [] }),
    ]);

    expect(optimistic).toEqual({
      pubkeys: [EXISTING_PUBLIC, TARGET],
      wireReady: true,
      configReady: true,
    });
    await act(async () => {
      await pending!;
    });

    expect(client.getQueryData(queryKey)).toEqual({
      pubkeys: [EXISTING_PUBLIC, TARGET],
      wireReady: false,
      configReady: true,
    });
    expect(h.writeFolded).toHaveBeenCalledWith(
      `mute-pubkeys:${SELF}`,
      {
        pubkeys: [EXISTING_PUBLIC, TARGET],
        version: expect.objectContaining({ id: expect.any(String) }),
      },
    );
  });

  it("restores the previous visible list when muting fails", async () => {
    h.query.mockRejectedValue(new Error("relay unavailable"));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const queryKey = ["mute-list", SELF, "wss://app.example"];
    client.setQueryData(queryKey, {
      pubkeys: [EXISTING_PUBLIC],
      wireReady: true,
      configReady: true,
    });
    const testWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMuteUser(), { wrapper: testWrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow("relay unavailable");
    });

    expect(client.getQueryData(queryKey)).toEqual({
      pubkeys: [EXISTING_PUBLIC],
      wireReady: true,
      configReady: true,
    });
  });

  it("REFUSES to mute on an empty read when a cached mute list exists (the wipe)", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue([EXISTING_PRIVATE]); // this device knows a list existed

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow(/avoid losing/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("REFUSES to start a fresh list when the read came back empty without every relay answering", async () => {
    // No local cache (a new device, or after logout) and a pooled read that
    // timed out empty: the relays may well hold a list, so don't replace it.
    h.query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("timed out"));
    h.readFolded.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow(/avoid losing/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("builds on a list the confirming read finds after the pooled read came back empty", async () => {
    h.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([muteEvent({ privateTags: [["p", EXISTING_PRIVATE], ["word", "spam.example"]] })]);
    h.readFolded.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    const arg = h.publish.mock.calls[0][0] as { content: string };
    const privateTags = JSON.parse(arg.content.slice(4)) as string[][];
    expect(privateTags).toEqual([["p", EXISTING_PRIVATE], ["word", "spam.example"], ["p", TARGET]]);
  });

  it("starts a fresh list when no mute list has ever existed", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const arg = h.publish.mock.calls[0][0] as { content: string };
    const privateTags = JSON.parse(arg.content.slice(4)) as string[][];
    expect(privateTags).toContainEqual(["p", TARGET]);
  });

  it("appends to the existing list, preserving public and private items", async () => {
    h.query.mockResolvedValue([
      muteEvent({ tags: [["p", EXISTING_PUBLIC]], privateTags: [["p", EXISTING_PRIVATE]] }),
    ]);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    const arg = h.publish.mock.calls[0][0] as { content: string; tags: string[][] };
    // Public portion untouched (format preserved), private portion appended.
    expect(arg.tags).toContainEqual(["p", EXISTING_PUBLIC]);
    const privateTags = JSON.parse(arg.content.slice(4)) as string[][];
    expect(privateTags).toContainEqual(["p", EXISTING_PRIVATE]);
    expect(privateTags).toContainEqual(["p", TARGET]);
  });

  it("refuses when the existing private items cannot be decrypted", async () => {
    h.query.mockResolvedValue([
      { ...muteEvent({}), content: "garbage-not-ours" },
    ]);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow(/avoid losing/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("publishes strictly after the previous version's created_at", async () => {
    // Wall-clock seconds are the same for two clicks in a row, and NIP-01
    // breaks a created_at tie by lowest id — so a same-second edit can lose.
    const prev = muteEvent({ privateTags: [["p", EXISTING_PRIVATE]] });
    prev.created_at = Math.floor(Date.now() / 1000) + 60; // clock skew / recent write
    h.query.mockResolvedValue([prev]);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    const arg = h.publish.mock.calls[0][0] as { created_at: number };
    expect(arg.created_at).toBeGreaterThan(prev.created_at);
  });

  it("serializes concurrent mutes so neither overwrites the other", async () => {
    const OTHER = "e".repeat(64);
    // Every read returns the list as of the last publish, so a second write
    // that read before the first one landed would drop the first's pubkey.
    let current = muteEvent({ privateTags: [] });
    h.query.mockImplementation(async () => [current]);
    h.publish.mockImplementation(async (arg: unknown) => {
      const { content } = arg as { content: string };
      current = { ...muteEvent({}), content };
      return undefined;
    });

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await Promise.all([
        result.current.mutateAsync(TARGET),
        result.current.mutateAsync(OTHER),
      ]);
    });

    const last = h.publish.mock.calls.at(-1)![0] as { content: string };
    const privateTags = JSON.parse(last.content.slice(4)) as string[][];
    expect(privateTags).toContainEqual(["p", TARGET]);
    expect(privateTags).toContainEqual(["p", OTHER]);
  });
});

describe("useUnmuteUser (kind 10000 read-modify-write)", () => {
  it("removes a private mute and keeps every other item", async () => {
    h.query.mockResolvedValue([
      muteEvent({
        tags: [["p", EXISTING_PUBLIC], ["t", "spoilers"]],
        privateTags: [["p", EXISTING_PRIVATE], ["p", TARGET], ["word", "crypto"]],
      }),
    ]);

    const { result } = renderHook(() => useUnmuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    const arg = h.publish.mock.calls[0][0] as { content: string; tags: string[][] };
    expect(arg.tags).toEqual([["p", EXISTING_PUBLIC], ["t", "spoilers"]]);
    const privateTags = JSON.parse(arg.content.slice(4)) as string[][];
    expect(privateTags).toEqual([["p", EXISTING_PRIVATE], ["word", "crypto"]]);
  });

  it("removes a mute another client published as a public tag", async () => {
    h.query.mockResolvedValue([
      muteEvent({ tags: [["p", TARGET], ["p", EXISTING_PUBLIC]] }),
    ]);

    const { result } = renderHook(() => useUnmuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    const arg = h.publish.mock.calls[0][0] as { content: string; tags: string[][] };
    expect(arg.tags).toEqual([["p", EXISTING_PUBLIC]]);
    // The list never had encrypted content; don't invent an empty ciphertext.
    expect(arg.content).toBe("");
  });

  it("REFUSES to unmute on an empty read when a cached mute list exists", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue([EXISTING_PRIVATE, TARGET]);

    const { result } = renderHook(() => useUnmuteUser(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow(/avoid losing/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("publishes nothing when the pubkey isn't muted", async () => {
    h.query.mockResolvedValue([
      muteEvent({ privateTags: [["p", EXISTING_PRIVATE]] }),
    ]);

    const { result } = renderHook(() => useUnmuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });
});
