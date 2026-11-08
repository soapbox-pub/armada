/**
 * The writer duty's executor over the Vector fixture: judged on what Vector published
 * before its mint, the owner mints writer epoch 1, publishes the ledger edition first
 * and then the mint's deliveries, and holds its own key after.
 */
import { IDBFactory } from "fake-indexeddb";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({ editions: [] as NostrRumor[], halted: false, rows: [] as unknown[], order: [] as string[] }));
vi.mock("@/concord/lib/rumorStore", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rumorStore")>()),
  queryChannelRumors: async () => h.rows,
}));
vi.mock("@/sync/syncManager", async (orig) => ({
  ...(await orig<typeof import("@/sync/syncManager")>()),
  syncHalted: () => h.halted,
}));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => {
    h.editions.push(rumor);
    h.order.push("ledger");
  },
  citationFor: () => undefined,
}));

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const { clearWriterDutyMemory, runWriterDuty } = await import("@/concord/hooks/writerDutyRun");
const { accessCandidates } = await import("@/concord/lib/accessDuty");
const { foldControlState, openControlWraps } = await import("@/concord/lib/control");
const { accessPlane, parseDelivery } = await import("@/concord/lib/delivery");
const { controlGroupKey, hex32 } = await import("@/concord/lib/derive");
const { openWrap } = await import("@/concord/lib/stream");
const { heldLiveSecret, writerKeysReady } = await import("@/concord/lib/writerKeys");
const { parseLedger } = await import("@/concord/lib/writers");
const actors = (await import("@/concord/lib/fixtures/cord25/writer_duty.actors.json")).default;
const fixture = (await import("@/concord/lib/fixtures/cord25/writer_duty.json")).default;

function setup() {
  const c = fixture.community;
  const community = { id: hex32(c.id), idHex: c.id, owner: c.owner, root: hex32(c.root), rootEpoch: BigInt(c.root_epoch), heldRoots: [{ epoch: 0n, key: hex32(c.root) }], privateChannels: [], relays: ["wss://r.test"], name: "", ownerSalt: new Uint8Array(32) };
  const events = (fixture.events as unknown as NostrEvent[]).filter((e) => actors.before_grant.includes(e.id));
  const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
  const folded = foldControlState(
    openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]).filter((e) => e.vsk !== "18"),
    hex32(c.id),
    c.owner,
  );
  const ownerSk = hex32(actors.owner_secret);
  const published: NostrEvent[] = [];
  const nostr = { relay: () => ({ query: async () => [], event: async (e: NostrEvent) => void published.push(e) }) };
  const members = new Map([actors.owner, actors.member].map((pk) => [pk, { pubkey: pk, state: "join" as const, ms: 0, rumorId: "", fromSnapshot: false }]));
  const fold = { current: folded };
  const run = (encrypted: () => void = () => undefined, controller = new AbortController(), freshen?: () => Promise<boolean>, settledFrom?: typeof folded, stored?: () => Promise<typeof folded>) =>
    runWriterDuty({
      nostr: nostr as never,
      user: {
        pubkey: actors.owner,
        signer: {
          signEvent: async (t: EventTemplate) => finalizeEvent(t, ownerSk),
          nip44: {
            encrypt: async (pk: string, plain: string) => {
              encrypted();
              return nip44Encrypt(plain, getConversationKey(ownerSk, pk));
            },
          },
        },
      },
      now: () => ({ community: community as never, folded: fold.current, members, walked: true }),
      accessCandidates: (f) => accessCandidates(f, members),
      signal: controller.signal,
      ...(freshen ? { freshen } : {}),
      ...(stored ? { stored } : {}),
      ...(settledFrom ? { settle: true, settledFrom } : {}),
    });
  return { c, community, published, run, fold, events, read };
}

beforeEach(() => clearWriterDutyMemory());

describe("running the writer duty", () => {
  it("mints writer epoch 1 for a Channel a Roster restricts, ledger first, then the mint", async () => {
    await writerKeysReady();
    h.editions = [];
    const c = fixture.community;
    const community = { id: hex32(c.id), idHex: c.id, owner: c.owner, root: hex32(c.root), rootEpoch: BigInt(c.root_epoch), heldRoots: [{ epoch: 0n, key: hex32(c.root) }], privateChannels: [], relays: ["wss://r.test"], name: "", ownerSalt: new Uint8Array(32) };
    const events = (fixture.events as unknown as NostrEvent[]).filter((e) => actors.before_grant.includes(e.id));
    const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
    const folded = foldControlState(
      openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]).filter((e) => e.vsk !== "18"),
      hex32(c.id),
      c.owner,
    );
    const ownerSk = hex32(actors.owner_secret);
    const published: NostrEvent[] = [];
    const nostr = { relay: () => ({ query: async () => [], event: async (e: NostrEvent) => void published.push(e) }) };
    const members = new Map([actors.owner, actors.member].map((pk) => [pk, { pubkey: pk, state: "join" as const, ms: 0, rumorId: "", fromSnapshot: false }]));
    await runWriterDuty({
      nostr: nostr as never,
      user: {
        pubkey: actors.owner,
        signer: {
          signEvent: async (t: EventTemplate) => finalizeEvent(t, ownerSk),
          nip44: { encrypt: async (pk: string, plain: string) => nip44Encrypt(plain, getConversationKey(ownerSk, pk)) },
        },
      },
      now: () => ({ community: community as never, folded, members, walked: true }),
      accessCandidates: (f) => accessCandidates(f, members),
      signal: new AbortController().signal,
    });
    expect(h.editions).toHaveLength(1);
    const ledger = parseLedger(h.editions[0].content)!;
    expect(ledger.entries[0].spell).toEqual(expect.objectContaining({ kind: "writer", epoch: 1, by: actors.owner, root: 0 }));
    const plane = accessPlane(community as never, hex32(actors.general));
    const mint = published.filter((e) => e.pubkey === plane.pk).map((e) => parseDelivery(openWrap(e, plane))!);
    expect(mint.length).toBeGreaterThan(0);
    expect(mint.every((d) => d.mint !== undefined)).toBe(true);
    // The minter is among its writers: it holds the key it minted.
    expect(heldLiveSecret(c.id, ledger)?.pk).toBe((ledger.entries[0].spell as { pk: string }).pk);
  });
});

describe("running the writer duty, cut short", () => {
  it("publishes nothing and keeps no key once logout halts it mid-mint", async () => {
    await writerKeysReady();
    h.editions = [];
    const { published, run } = setup();
    await run(() => void (h.halted = true));
    h.halted = false;
    expect(h.editions).toEqual([]);
    expect(published).toEqual([]);
  });

  it("stands down when the ledger moved on the relays while its deliveries were built (Vector `ledger_moved_since`)", async () => {
    await writerKeysReady();
    h.editions = [];
    const { c, published, run, fold, events, read } = setup();
    // Another manager's ledger lands while this one builds: the backstop's read found none,
    // the read after building holds it.
    void events;
    const theirs = foldControlState(
      openControlWraps(fixture.events as unknown as NostrEvent[], [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]),
      hex32(c.id),
      c.owner,
    );
    let freshened = 0;
    await run(undefined, undefined, async () => {
      if (++freshened > 1) fold.current = theirs;
      return true;
    });
    expect(theirs.writers?.size).toBeGreaterThan(0);
    expect(h.editions).toEqual([]);
    expect(published).toEqual([]);
  });

  it("dates a mint's entry by the newest post, never a reaction (Vector `entry_time` reads messages)", async () => {
    await writerKeysReady();
    h.editions = [];
    const ahead = Date.now() + 5 * 60_000;
    const row = (kind: number, author: string) => ({ rumorId: "ab".repeat(32), author, kind, content: "x", tags: [], ms: ahead, createdAt: Math.floor(ahead / 1000), channelIdHex: actors.general, epoch: 0n });
    // A reaction dated ahead is no post made.
    h.rows = [row(7, actors.member)];
    const { run } = setup();
    await run();
    h.rows = [];
    const ledger = parseLedger(h.editions[0].content)!;
    expect(ledger.entries[0].at).toBeLessThan(ahead);
  });

  it("settling a change acts only on the Channels it moved (Vector `settle_writers`)", async () => {
    await writerKeysReady();
    h.editions = [];
    const { published, run, fold } = setup();
    // The member's change left this Channel's restriction and its writers as they were.
    await run(undefined, undefined, undefined, fold.current);
    expect(h.editions).toEqual([]);
    expect(published).toEqual([]);
  });

  it("publishes nothing when the pass is aborted before its ledger edition goes out", async () => {
    await writerKeysReady();
    h.editions = [];
    const { published, run } = setup();
    const controller = new AbortController();
    await run(() => controller.abort(), controller);
    expect(h.editions).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe("the writer duty and this device's other Control writes (Vector `follow_lock`)", () => {
  it("publishes its ledger edition only once a Control write already in flight has finished", async () => {
    await writerKeysReady();
    h.editions = [];
    h.order = [];
    const { withControlWrite } = await import("@/concord/hooks/useControlPlane");
    const { c, run } = setup();
    const held = withControlWrite(c.id, async () => {
      await new Promise((r) => setTimeout(r, 300));
      h.order.push("other write");
    });
    await run();
    await held;
    expect(h.order).toEqual(["other write", "ledger"]);
  });

  it("stands down when the store holds a ledger the rendered fold doesn't yet", async () => {
    await writerKeysReady();
    h.editions = [];
    const { c, published, run, read } = setup();
    const ahead = foldControlState(
      openControlWraps(fixture.events as unknown as NostrEvent[], [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]),
      hex32(c.id),
      c.owner,
    );
    expect(ahead.writers?.size).toBeGreaterThan(0);
    await run(undefined, undefined, undefined, undefined, async () => ahead);
    expect(h.editions).toEqual([]);
    expect(published).toEqual([]);
  });
});
