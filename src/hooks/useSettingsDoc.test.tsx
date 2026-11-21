import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { NostrRumor } from "@/lib/nostrRumor";
import { settingsDTag, type SettingsDocName } from "@/lib/settingsDocs";
import * as publishOutbox from "@/lib/publishOutbox";

import { settingsKeyring } from "@/lib/settingsKeys";
import type { SettingsKeys } from "@/lib/settingsRootStore";

import { nextSettingsDoc, readSettingsDoc, useSettingsDoc } from "./useSettingsDoc";

const PUBKEY = "a".repeat(64);
const KEYRING = settingsKeyring("01".repeat(32));
const KEYS: SettingsKeys = { keyring: KEYRING, previous: [] };

vi.mock("@/hooks/useSettingsKeys", () => ({
  useSettingsKeys: () => ({ keys: KEYS, isFetched: true, ensure: async () => KEYS }),
}));

const ctx = () => ({ store: store as never, signer: signer as never, pubkey: PUBKEY, keys: KEYS });

/**
 * A store with the one behaviour these hooks lean on: NIP-01 addressable
 * supersession. Only a strictly newer version replaces the coordinate, which is
 * what makes "the document on disk" mean "the newest one seen from any source".
 */
class FakeStore {
  rumors: NostrRumor[] = [];

  async event(event: NostrEvent): Promise<void> {
    const { sig: _sig, ...rumor } = event;
    const coord = `${rumor.kind}:${rumor.pubkey}:${dTagOf(rumor) ?? ""}`;
    const index = this.rumors.findIndex(
      (held) => `${held.kind}:${held.pubkey}:${dTagOf(held) ?? ""}` === coord,
    );
    if (index === -1) {
      this.rumors.push(rumor);
      return;
    }
    if (rumor.created_at > this.rumors[index]!.created_at) this.rumors[index] = rumor;
  }

  async query([filter]: NostrFilter[]): Promise<NostrRumor[]> {
    return this.rumors.filter(
      (rumor) =>
        filter!.kinds!.includes(rumor.kind)
        && filter!.authors!.includes(rumor.pubkey)
        && filter!["#d"]!.includes(dTagOf(rumor) ?? ""),
    );
  }

  async count() {
    return { count: this.rumors.length };
  }
  async remove() {}
  async close() {}
}

function dTagOf(rumor: NostrRumor): string | undefined {
  return rumor.tags.find(([name]) => name === "d")?.[1];
}

let store: FakeStore;
let published: NostrEvent[];
let signed: number;

/** NIP-44 stand-in: reversible, and obviously not a real ciphertext. */
const signer = {
  nip44: {
    encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
    decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.replace(/^sealed:/, ""),
  },
  signEvent: async (template: Omit<NostrEvent, "id" | "pubkey" | "sig">) => ({
    ...template,
    id: `event-${++signed}`,
    pubkey: PUBKEY,
    sig: "sig",
  }),
};

const h = vi.hoisted(() => ({
  nostrEvent: vi.fn(),
  relay: vi.fn(),
  config: {
    useAppRelays: true,
    appRelays: ["wss://app.example"],
    useUserRelays: false,
    relayMetadata: {
      pubkey: "a".repeat(64),
      updatedAt: 1,
      relays: [{ url: "wss://home.example", read: true, write: true }],
    },
  },
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: h.relay,
    },
  }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: PUBKEY, signer } }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve(store),
}));

/** Put a settings document on disk the way the wire would. */
async function seedStore(
  name: SettingsDocName,
  doc: Record<string, unknown>,
  createdAt: number,
): Promise<void> {
  await store.event({
    id: `stored-${name}-${createdAt}`,
    pubkey: PUBKEY,
    kind: 30078,
    created_at: createdAt,
    content: `sealed:${JSON.stringify(doc)}`,
    tags: [["d", settingsDTag(name)]],
    sig: "sig",
  });
}

function render<N extends SettingsDocName>(name: N) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(() => useSettingsDoc(name), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** The plaintext of the settings event published by the n-th write. */
async function publishedDoc(index = 0): Promise<Record<string, unknown>> {
  const event = published[index]!;
  const doc = KEYRING.byPubkey.get(event.pubkey)!;
  return JSON.parse(await doc.signer.nip44!.decrypt(doc.pubkey, event.content));
}

beforeEach(() => {
  store = new FakeStore();
  published = [];
  signed = 0;
  h.config.useAppRelays = true;
  h.config.appRelays = ["wss://app.example"];
  h.config.useUserRelays = false;
  h.config.relayMetadata = {
    pubkey: PUBKEY,
    updatedAt: 1,
    relays: [{ url: "wss://home.example", read: true, write: true }],
  };
  h.nostrEvent.mockReset().mockImplementation((event: NostrEvent) => {
    if (!published.some((held) => held.id === event.id)) published.push(event);
    return Promise.resolve();
  });
  h.relay.mockReset().mockImplementation(() => ({ event: h.nostrEvent }));
});

describe("readSettingsDoc", () => {
  it("returns the newest document on disk", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    await seedStore("metadata", { theme: "dark" }, 200);

    const read = await readSettingsDoc(ctx(), "metadata");
    expect(read?.doc).toEqual({ theme: "dark" });
    expect(read?.event.created_at).toBe(200);
  });

  it("returns null when the store holds nothing", async () => {
    expect(
      await readSettingsDoc(ctx(), "metadata"),
    ).toBeNull();
  });

  it("returns null rather than a partial document when the payload is unreadable", async () => {
    await store.event({
      id: "garbage",
      pubkey: PUBKEY,
      kind: 30078,
      created_at: 100,
      content: "not even sealed",
      tags: [["d", settingsDTag("metadata")]],
      sig: "sig",
    });

    expect(
      await readSettingsDoc(ctx(), "metadata"),
    ).toBeNull();
  });

  /**
   * The whole point of the split: the documents are separate NIP-01
   * coordinates, so a read of one can neither see nor disturb another.
   */
  it("reads only its own document", async () => {
    await seedStore("metadata", { theme: "dark" }, 100);
    await seedStore("rail", { railLayout: [{ type: "item", key: "wss://a" }] }, 100);

    const rail = await readSettingsDoc(ctx(), "rail");
    expect(rail?.doc).toEqual({ railLayout: [{ type: "item", key: "wss://a" }] });

    const readState = await readSettingsDoc(ctx(), "read-state");
    expect(readState).toBeNull();
  });
});

describe("readSettingsDoc sources", () => {
  async function seedDerived(name: SettingsDocName, doc: Record<string, unknown>, createdAt: number) {
    const derived = KEYRING.settings[name];
    await store.event({
      id: `derived-${name}-${createdAt}`,
      pubkey: derived.pubkey,
      kind: 30078,
      created_at: createdAt,
      content: await derived.signer.nip44!.encrypt(derived.pubkey, JSON.stringify(doc)),
      tags: [["d", derived.d]],
      sig: "sig",
    });
  }

  it("prefers the derived document over an older legacy one", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    await seedDerived("metadata", { theme: "dark" }, 200);
    expect((await readSettingsDoc(ctx(), "metadata"))?.doc).toEqual({ theme: "dark" });
  });

  it("lets a newer legacy document win: only an older build writes one", async () => {
    await seedDerived("metadata", { theme: "dark" }, 100);
    await seedStore("metadata", { theme: "light" }, 200);
    expect((await readSettingsDoc(ctx(), "metadata"))?.doc).toEqual({ theme: "light" });
  });

  it("reads a superseded root's document as one more source", async () => {
    const previous = settingsKeyring("02".repeat(32));
    const doc = previous.settings.rail;
    await store.event({
      id: "previous-rail",
      pubkey: doc.pubkey,
      kind: 30078,
      created_at: 100,
      content: await doc.signer.nip44!.encrypt(doc.pubkey, JSON.stringify({ railLayout: [] })),
      tags: [["d", doc.d]],
      sig: "sig",
    });
    const read = await readSettingsDoc({ ...ctx(), keys: { keyring: KEYRING, previous: [previous] } }, "rail");
    expect(read?.event.id).toBe("previous-rail");
  });
});

describe("useSettingsDoc", () => {
  it("reads the document out of the store", async () => {
    await seedStore("metadata", { theme: "light", zapsEnabled: false }, 100);

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).not.toBeNull());
    expect(result.current.doc).toEqual({ theme: "light", zapsEnabled: false });
  });

  it("merges a patch over the document ON DISK, not over the one it last read", async () => {
    await seedStore("metadata", { theme: "light" }, 100);

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    // Another device publishes; the standing REQ (or, on Android, the
    // notification service) files it while this query still holds the old one.
    await seedStore("metadata", { theme: "light", currencyDisplay: "sats" }, 200);

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    expect(await publishedDoc()).toMatchObject({ theme: "dark", currencyDisplay: "sats" });
  });

  it("publishes to NIP-65 write relays even when general user-relay routing is off", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    expect(h.relay).toHaveBeenCalledWith("wss://app.example");
    expect(h.relay).toHaveBeenCalledWith("wss://home.example");
  });

  it("publishes a version the store will accept over the one it merged over", async () => {
    // A document stamped in the future: `Date.now()` alone would be older, and
    // the store would silently refuse the write.
    const ahead = Math.floor(Date.now() / 1000) + 3600;
    await seedStore("metadata", { theme: "light" }, ahead);

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    expect(published[0]!.created_at).toBe(ahead + 1);
    const onDisk = await readSettingsDoc(ctx(), "metadata");
    expect(onDisk?.doc).toMatchObject({ theme: "dark" });
  });

  it("stores the new document before publishing it", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    h.nostrEvent.mockImplementation(async (event: NostrEvent) => {
      // Whatever a relay does with it, it is already durable here.
      const onDisk = await readSettingsDoc(ctx(), "metadata");
      expect(onDisk?.event.id).toBe(event.id);
      if (!published.some((held) => held.id === event.id)) published.push(event);
      throw new Error("relay unreachable");
    });

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await expect(result.current.update({ theme: "dark" })).rejects.toThrow(/queued for retry/i);
    });

    expect(published).toHaveLength(1);
  });

  it("does not claim a failed delivery was queued when durable storage failed", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    const queue = vi.spyOn(publishOutbox, "queueSignedEvent")
      .mockRejectedValue(new Error("outbox unavailable"));
    h.nostrEvent.mockRejectedValue(new Error("relay unreachable"));

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await expect(result.current.update({ theme: "dark" }))
        .rejects.toThrow(/No account relay accepted/);
    });
    queue.mockRestore();
  });

  it("refuses to spill private settings into generic routing with no account relay", async () => {
    h.config.useAppRelays = false;
    h.config.relayMetadata = { pubkey: PUBKEY, updatedAt: 1, relays: [] };
    const { result } = render("metadata");
    await waitFor(() => expect(result.current.isFetched).toBe(true));

    await act(async () => {
      await expect(result.current.update({ theme: "dark" })).rejects.toThrow(/account write relay/);
    });
    expect(h.nostrEvent).not.toHaveBeenCalled();
  });

  it("merges over nothing when the store is empty — callers must gate on that", async () => {
    const { result } = render("metadata");
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.doc).toBeNull();

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    const { lastSync: _lastSync, ...rest } = await publishedDoc();
    expect(rest).toEqual({ theme: "dark" });
  });

  it("writes each document under its own `d` tag", async () => {
    const { result } = render("rail");
    await waitFor(() => expect(result.current.isFetched).toBe(true));

    await act(async () => {
      await result.current.update({ railLayout: [{ type: "item", key: "wss://a" }] });
    });

    // The derived key and opaque `d`, and nothing else that would name the document.
    expect(published[0]!.pubkey).toBe(KEYRING.settings.rail.pubkey);
    expect(published[0]!.tags).toEqual([["d", KEYRING.settings.rail.d]]);
    expect(await publishedDoc()).toEqual({ railLayout: [{ type: "item", key: "wss://a" }] });
  });

  /**
   * `lastSync` is written only for older builds, which order metadata versions
   * by it rather than by `created_at`. Every split document postdates those
   * builds, so emitting it there would be cargo cult.
   */
  it("stamps lastSync on metadata only", async () => {
    const metadata = render("metadata");
    await waitFor(() => expect(metadata.result.current.isFetched).toBe(true));
    await act(async () => {
      await metadata.result.current.update({ theme: "dark" });
    });
    expect(await publishedDoc()).toHaveProperty("lastSync");

    const rail = render("rail");
    await waitFor(() => expect(rail.result.current.isFetched).toBe(true));
    await act(async () => {
      await rail.result.current.update({ railLayout: [] });
    });
    expect(await publishedDoc(1)).not.toHaveProperty("lastSync");
  });

  /**
   * The half of the migration that makes the other half sound: a legacy field
   * left in metadata is only evidence that an OLD build wrote it if this build
   * never carries one forward. See `resolveLegacy` in `lib/settingsDocs.ts`.
   */
  it("strips migrated fields from every metadata write", async () => {
    await seedStore(
      "metadata",
      {
        theme: "light",
        railLayout: [{ type: "item", key: "wss://a" }],
        readState: { "wss://a::g": 5 },
        notifLevels: { "wss://a": "nothing" },
        pinnedDms: ["b".repeat(64)],
        frequentReactions: [{ key: "+", count: 3, usedAt: 1 }],
      },
      100,
    );

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).not.toBeNull());
    // It is still READ — that is what the migration window depends on.
    expect(result.current.doc?.railLayout).toHaveLength(1);

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    const out = await publishedDoc();
    expect(out).toMatchObject({ theme: "dark" });
    for (const key of [
      "railLayout",
      "railOrder",
      "readState",
      "notifLevels",
      "pinnedDms",
      "frequentReactions",
    ]) {
      expect(out).not.toHaveProperty(key);
    }
  });
});

describe("nextSettingsDoc for notifications", () => {
  it("folds a stored version this device hasn't applied in per scope, not wholesale", () => {
    const stored = {
      notifLevelRecords: { "c2:other": { v: "mentions" as const, at: 2_000, op: "b" } },
      notifMuteRecords: {},
      notifLevels: { "c2:other": "mentions" as const },
      mutedCommunities: [],
      mutedChannels: [],
    };
    const patch = {
      notifLevelRecords: {},
      notifMuteRecords: { "dm:peer": { until: -1, at: 1_000, op: "a" } },
      notifLevels: { "dm:peer": "nothing" as const },
      mutedCommunities: [],
      mutedChannels: [],
    };
    const next = nextSettingsDoc("notifications", stored, patch, { id: "v1", created_at: 2 });
    expect(next.notifLevelRecords).toEqual(stored.notifLevelRecords);
    expect(next.notifMuteRecords).toEqual(patch.notifMuteRecords);
    expect(next.notifLevels).toEqual({ "c2:other": "mentions", "dm:peer": "nothing" });
  });
});
