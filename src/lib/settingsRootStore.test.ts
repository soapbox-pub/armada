import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { NSecSigner } from "@nostrify/nostrify";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { copyLegacySettingsDocs, serializeSettingsWrite } from "@/hooks/useSettingsDoc";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { encodeSettingsRoot, ROOT_PLAINTEXT_BYTES } from "@/lib/settingsRoot";
import { settingsKeyring } from "@/lib/settingsKeys";
import {
  clearSettingsRootMemory,
  ensureSettingsKeys,
  heldSettingsRoot,
  resolveSettingsKeys,
} from "@/lib/settingsRootStore";

const SK = new Uint8Array(32).fill(11);
const PUBKEY = getPublicKey(SK);
const RELAY = "wss://home.example";
const signer = new NSecSigner(SK);

function matches(filter: NostrFilter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    if (!event.tags.some(([name, value]) => name === key.slice(1) && values.includes(value!))) return false;
  }
  return true;
}

class MemoryStore {
  events: NostrEvent[] = [];
  async event(event: NostrEvent) {
    if (!this.events.some((held) => held.id === event.id)) this.events.push(event);
  }
  async query(filters: NostrFilter[]) {
    return this.events.filter((event) => filters.some((filter) => matches(filter, event)));
  }
  async count() { return { count: this.events.length }; }
  async remove() {}
  async close() {}
}

let store: MemoryStore;
let wire: NostrEvent[];
let answers: boolean;
const published: NostrEvent[] = [];

const nostr = {
  relay: () => ({
    query: async (filters: NostrFilter[]) => {
      if (!answers) throw new Error("offline");
      return wire.filter((event) => filters.some((filter) => matches(filter, event)));
    },
    event: async (event: NostrEvent) => {
      published.push(event);
      wire.push(event);
    },
  }),
};

async function rootEvent(root: string, createdAt: number): Promise<NostrEvent> {
  return finalizeEvent({
    kind: 30078,
    content: await signer.nip44.encrypt(PUBKEY, encodeSettingsRoot({ v: 1, root })),
    tags: [["d", "armada"]],
    created_at: createdAt,
  }, SK);
}

function legacyMetadata(): NostrEvent {
  return finalizeEvent({ kind: 30078, content: "x", tags: [["d", "armada/metadata"]], created_at: 1 }, SK);
}

function ensure(opts: { explicit?: boolean; onCreated?: () => Promise<void> } = {}) {
  return ensureSettingsKeys({
    nostr: nostr as never,
    store: store as never,
    signer,
    pubkey: PUBKEY,
    relays: [RELAY],
    ...opts,
  });
}

beforeEach(async () => {
  clearSettingsRootMemory();
  await getArmadaDB().kv.delete(`nip78root:${PUBKEY}`);
  await getArmadaDB().kv.delete(`nip78root-prev:${PUBKEY}`);
  store = new MemoryStore();
  wire = [];
  answers = true;
  published.length = 0;
});

describe("settings root lifecycle", () => {
  it("refuses to create a root for an account that never set up sync", async () => {
    await expect(ensure()).rejects.toThrow(/not been set up/);
    expect(published).toEqual([]);
  });

  it("refuses to create a root without a relay confirming there is none", async () => {
    await store.event(legacyMetadata());
    answers = false;
    await expect(ensure()).rejects.toThrow(/No account relay answered/);
    expect(published).toEqual([]);
  });

  it("adopts the root a relay already holds instead of minting a second", async () => {
    await store.event(legacyMetadata());
    wire.push(await rootEvent("aa".repeat(32), 100));
    const keys = await ensure();
    expect(keys.keyring?.id).toBe(settingsKeyring("aa".repeat(32)).id);
    expect(published).toEqual([]);
  });

  it("mints a fixed-shape root once, then reuses it without the signer", async () => {
    await store.event(legacyMetadata());
    const onCreated = vi.fn(async () => undefined);
    const keys = await ensure({ onCreated });
    expect(onCreated).toHaveBeenCalledOnce();
    expect(published).toHaveLength(1);
    const [root] = published;
    expect(root!.tags).toEqual([["d", "armada"]]);
    expect((await signer.nip44.decrypt(PUBKEY, root!.content)).length).toBe(ROOT_PLAINTEXT_BYTES);

    const decrypt = vi.spyOn(signer.nip44, "decrypt");
    clearSettingsRootMemory();
    expect((await resolveSettingsKeys(store as never, signer, PUBKEY)).keyring?.id).toBe(keys.keyring?.id);
    expect(decrypt).not.toHaveBeenCalled();
    expect(await ensure()).toMatchObject({ keyring: { id: keys.keyring?.id } });
    expect(published).toHaveLength(1);
    decrypt.mockRestore();
  });

  it("an explicit Sync now may create the first root", async () => {
    const keys = await ensure({ explicit: true });
    expect(keys.keyring).not.toBeNull();
  });

  it("Sync now returns only after the legacy copy has landed", async () => {
    let copied = false;
    await ensure({
      explicit: true,
      onCreated: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        copied = true;
      },
    });
    expect(copied).toBe(true);
  });

  it("a settings write that mints the root finishes", async () => {
    await store.event(legacyMetadata());
    // useSettingsDoc's mutation: serialized per document, ensuring the keys inside.
    const write = serializeSettingsWrite("read-state-recent", () => ensureSettingsKeys({
      nostr: nostr as never,
      store: store as never,
      signer,
      pubkey: PUBKEY,
      relays: [RELAY],
      onCreated: (keys) => copyLegacySettingsDocs({
        nostr: nostr as never,
        store: store as never,
        signer,
        pubkey: PUBKEY,
        keys,
        relays: [RELAY],
      }),
    }));
    const outcome = await Promise.race([
      write.then(() => "finished"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("finished");
  });

  it("keeps a root that lost a creation race as a previous root", async () => {
    const mine = await ensure({ explicit: true });
    const theirs = "bb".repeat(32);
    await store.event(await rootEvent(theirs, Math.floor(Date.now() / 1000) + 60));

    const keys = await resolveSettingsKeys(store as never, signer, PUBKEY);
    expect(await heldSettingsRoot(PUBKEY)).toBe(theirs);
    expect(keys.previous.map((keyring) => keyring.id)).toEqual([mine.keyring!.id]);
  });
});
