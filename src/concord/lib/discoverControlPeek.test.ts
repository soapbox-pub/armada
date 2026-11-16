import { describe, expect, it } from "vitest";

import {
  _resetDiscoverControlPeekQueueForTests,
  controlViewFromBundle,
  enqueueDiscoverControlPeek,
  peekDiscoverControl,
  summarizeDiscoverChannels,
  readCachedControlPeek,
} from "@/concord/lib/discoverControlPeek";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { buildChannelEdition, buildMetadataEdition, buildRegistryEdition, sealEdition } from "@/concord/lib/control";
import { buildRekeyRumors } from "@/concord/lib/rekey";
import { sealRumor, wrapSeal } from "@/concord/lib/stream";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { getArmadaDB } from "@/lib/db/armadaDB";
import {
  baseRekeyGroupKey,
  bytesToHex,
  communityIdOf,
  controlGroupKey,
  epochKeyCommitment,
  hex32,
  random32,
} from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

import type { NostrFilter } from "@nostrify/nostrify";
import type { EventTemplate, NostrEvent } from "nostr-tools";

function makeBundle(over: Partial<InviteBundle> = {}): InviteBundle {
  const owner = random32();
  const salt = random32();
  const root = random32();
  const id = communityIdOf(owner, salt);
  return {
    community_id: bytesToHex(id),
    owner: bytesToHex(owner),
    owner_salt: bytesToHex(salt),
    community_root: bytesToHex(root),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.example/"],
    name: "Test",
    ...over,
  };
}

describe("controlViewFromBundle", () => {
  it("uses control_pk as a restricted read address when present", () => {
    const controlPk = bytesToHex(random32());
    const view = controlViewFromBundle(makeBundle({ control_pk: controlPk }));
    expect(view?.pk).toBe(controlPk);
    expect(view?.restricted).toBe(true);
  });

  it("falls back to the legacy control group key address", () => {
    const bundle = makeBundle();
    const view = controlViewFromBundle(bundle);
    expect(view?.pk).toBe(
      controlGroupKey(hex32(bundle.community_root), hex32(bundle.community_id), 0).pk,
    );
    expect(view?.restricted).toBeFalsy();
  });
});

describe("summarizeDiscoverChannels", () => {
  it("counts live channels and lists public ids only", () => {
    const out = summarizeDiscoverChannels([
      { channelIdHex: "aa".repeat(32), isPrivate: false, deleted: false },
      { channelIdHex: "bb".repeat(32), isPrivate: true, deleted: false },
      { channelIdHex: "cc".repeat(32), isPrivate: false, deleted: true },
    ]);
    expect(out.channelCount).toBe(2);
    expect(out.publicChannelIdHexes).toEqual(["aa".repeat(32)]);
  });
});

describe("control peek KV cache", () => {
  it("reads a well-shaped row and rejects malformed ones", async () => {
    const id = "dd".repeat(32);
    const peek = { channelCount: 3, publicChannelIdHexes: ["ee".repeat(32)], epoch: 2 };
    await getArmadaDB().kv.set(`discover:control-peek:${id}`, peek);
    await expect(readCachedControlPeek(id, 2)).resolves.toEqual(peek);
    // A link on another epoch reads another plane.
    await expect(readCachedControlPeek(id, 3)).resolves.toBeUndefined();

    await getArmadaDB().kv.set(`discover:control-peek:${id}`, { channelCount: "nope", epoch: 2 });
    await expect(readCachedControlPeek(id, 2)).resolves.toBeUndefined();
  });
});

// ── Paging ───────────────────────────────────────────────────────────────────

/** Mirrors {@link PEEK_PAGE} — a full page is what makes the pager step. */
const PAGE = 500;

interface FakeRelay {
  events: NostrEvent[];
  calls: NostrFilter[];
  /** Throw on every call after this many (a relay that drops mid-walk). */
  failAfter?: number;
}

/** A pool whose relays each answer `until`/`limit` on their OWN copy. */
function fakeNostr(relays: Record<string, FakeRelay>) {
  return {
    relay(url: string) {
      return {
        query(filters: NostrFilter[]): Promise<NostrEvent[]> {
          const r = relays[url];
          if (!r) return Promise.reject(new Error(`no such relay ${url}`));
          const f = filters[0];
          r.calls.push(f);
          if (r.failAfter !== undefined && r.calls.length > r.failAfter) {
            return Promise.reject(new Error("relay dropped"));
          }
          return Promise.resolve(
            r.events
              .filter((e) => f.until === undefined || e.created_at <= f.until)
              .slice(0, f.limit ?? PAGE),
          );
        },
      };
    },
  };
}

/** The pages asked of the Control address, leaving out the rekey probe. */
function controlCalls(relay: FakeRelay, author: string): NostrFilter[] {
  return relay.calls.filter((f) => f.authors?.[0] === author);
}

let wrapSeq = 0;
/** A junk wrap: right author and kind, content that will never open. */
function junkWrap(author: string, createdAt: number): NostrEvent {
  wrapSeq += 1;
  return {
    id: `wrap-${wrapSeq}`,
    pubkey: author,
    created_at: createdAt,
    kind: KIND_WRAP,
    tags: [],
    content: "not openable",
    sig: "",
  };
}

/** Descending timestamps, newest first — the order a relay serves. */
function descendingWraps(author: string, count: number, newest: number): NostrEvent[] {
  return Array.from({ length: count }, (_, i) => junkWrap(author, newest - i));
}

function signer(sk = generateSecretKey()) {
  return {
    sk,
    pubkey: getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  };
}

/**
 * A real community whose LEGACY control address the bundle alone can derive —
 * so the peek's own `controlViewFromBundle` both opens the wraps below and is
 * the thing under test.
 */
async function realCommunity(channels: Array<{ name: string; private: boolean }>) {
  const owner = signer();
  const ownerSalt = random32();
  const communityId = communityIdOf(hex32(owner.pubkey), ownerSalt);
  const root = random32();
  const control = controlGroupKey(root, communityId, 0);
  const bundle: InviteBundle = {
    community_id: bytesToHex(communityId),
    owner: owner.pubkey,
    owner_salt: bytesToHex(ownerSalt),
    community_root: bytesToHex(root),
    root_epoch: 0,
    channels: [],
    relays: ["wss://one"],
    name: "Test",
  };
  const channelIds = channels.map(() => random32());
  return {
    bundle,
    control,
    owner,
    communityId,
    channelIds,
    /** The metadata head every community has — absent only mid-compaction. */
    metadataWrap: () =>
      sealEdition(
        buildMetadataEdition(communityId, { name: "Test", relays: [] }, {
          actorPubkey: owner.pubkey,
          version: 1n,
        }),
        control,
        owner,
      ),
    channelWraps: () =>
      Promise.all(
        channels.map((c, i) =>
          sealEdition(
            buildChannelEdition(
              channelIds[i],
              { name: c.name, private: c.private, deleted: false },
              { actorPubkey: owner.pubkey, version: 1n },
            ),
            control,
            owner,
          ),
        ),
      ),
  };
}

describe("peekDiscoverControl paging", () => {
  it("pages each relay on its own cursor", async () => {
    const bundle = makeBundle({ relays: ["wss://deep", "wss://shallow"] });
    const author = controlViewFromBundle(bundle)!.pk;
    const relays: Record<string, FakeRelay> = {
      "wss://deep": { events: descendingWraps(author, PAGE + 100, 9_000), calls: [] },
      "wss://shallow": { events: descendingWraps(author, 3, 9_000), calls: [] },
    };

    await peekDiscoverControl(fakeNostr(relays), bundle);

    // The shallow relay answered short and is done in one REQ. A single shared
    // cursor would instead have dragged it down to the deep relay's floor,
    // skipping the window it was never asked for.
    expect(controlCalls(relays["wss://shallow"], author)).toHaveLength(1);
    expect(controlCalls(relays["wss://deep"], author).length).toBeGreaterThan(1);
  });

  it("steps with an INCLUSIVE until so a same-second burst is not skipped", async () => {
    const bundle = makeBundle({ relays: ["wss://one"] });
    const author = controlViewFromBundle(bundle)!.pk;
    // 497 distinct seconds, then a burst of 7 sharing one second — the shape a
    // community founding writes (metadata plus every channel at once). The
    // page boundary lands inside the burst.
    const events = [
      ...descendingWraps(author, PAGE - 3, 9_000),
      ...Array.from({ length: 7 }, () => junkWrap(author, 8_000)),
      ...descendingWraps(author, 5, 7_000),
    ];
    const relays: Record<string, FakeRelay> = { "wss://one": { events, calls: [] } };

    await peekDiscoverControl(fakeNostr(relays), bundle);

    const calls = controlCalls(relays["wss://one"], author);
    expect(calls.length).toBeGreaterThan(1);
    // `until: 8_000`, not `7_999`: an exclusive step would drop the four burst
    // members that did not fit in page one.
    expect(calls[1].until).toBe(8_000);
  });
});

describe("peekDiscoverControl caching", () => {
  it("folds real editions and caches a complete read", async () => {
    const c = await realCommunity([
      { name: "general", private: false },
      { name: "staff", private: true },
    ]);
    const events = [await c.metadataWrap(), ...(await c.channelWraps())].sort(
      (a, b) => b.created_at - a.created_at,
    );
    const relays: Record<string, FakeRelay> = { "wss://one": { events, calls: [] } };

    const peek = await peekDiscoverControl(fakeNostr(relays), c.bundle);
    // A non-member counts both channels but can name only the public one —
    // the private id is what a last-active probe has no key for.
    expect(peek).toEqual({
      channelCount: 2,
      publicChannelIdHexes: [bytesToHex(c.channelIds[0])],
      epoch: 0,
      staff: [c.owner.pubkey],
      rotated: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    await expect(readCachedControlPeek(c.bundle.community_id, 0)).resolves.toEqual(peek);
  });

  it("does NOT cache a read that a relay dropped mid-walk", async () => {
    const c = await realCommunity([{ name: "general", private: false }]);
    // Real heads at the top so the fold IS complete-looking (metadata present);
    // truncation is then the only reason the result must not be cached.
    const events = [
      await c.metadataWrap(),
      ...(await c.channelWraps()),
      ...descendingWraps(c.control.pk, PAGE + 100, 8_000),
    ].sort((a, b) => b.created_at - a.created_at);
    const relays: Record<string, FakeRelay> = {
      "wss://one": { events, calls: [], failAfter: 1 },
    };

    // The card still gets a number to paint from the editions that did arrive…
    await expect(peekDiscoverControl(fakeNostr(relays), c.bundle)).resolves.toMatchObject({
      channelCount: 1,
      publicChannelIdHexes: [bytesToHex(c.channelIds[0])],
    });
    // …but an under-count must not outlive the outage that produced it.
    await new Promise((r) => setTimeout(r, 10));
    await expect(readCachedControlPeek(c.bundle.community_id, 0)).resolves.toBeUndefined();
  });

  it("does NOT cache an epoch caught mid-compaction (no metadata head)", async () => {
    // A Refounding re-wraps each head under the new address one at a time, so
    // an epoch can answer completely while carrying only some of its state.
    const c = await realCommunity([{ name: "general", private: false }]);
    const relays: Record<string, FakeRelay> = {
      "wss://one": { events: await c.channelWraps(), calls: [] },
    };

    await expect(peekDiscoverControl(fakeNostr(relays), c.bundle)).resolves.toMatchObject({
      channelCount: 1,
      publicChannelIdHexes: [bytesToHex(c.channelIds[0])],
    });
    await new Promise((r) => setTimeout(r, 10));
    await expect(readCachedControlPeek(c.bundle.community_id, 0)).resolves.toBeUndefined();
  });

  it("does not cache when no relay answered at all", async () => {
    const bundle = makeBundle({ relays: ["wss://one"] });
    const relays: Record<string, FakeRelay> = {
      "wss://one": { events: [], calls: [], failAfter: 0 },
    };

    await peekDiscoverControl(fakeNostr(relays), bundle);
    await new Promise((r) => setTimeout(r, 10));
    await expect(readCachedControlPeek(bundle.community_id, 0)).resolves.toBeUndefined();
  });
});

describe("peekDiscoverControl refounding probe", () => {
  const LINK_A = "a1".repeat(32);

  async function registry(c: Awaited<ReturnType<typeof realCommunity>>, links: string[]) {
    return sealEdition(
      buildRegistryEdition(c.communityId, c.owner.pubkey, links, { actorPubkey: c.owner.pubkey, version: 1n }),
      c.control,
      c.owner,
    );
  }

  /** A complete base rotation off epoch 0, signed by `rotator`. */
  async function rotation(c: Awaited<ReturnType<typeof realCommunity>>, rotator: ReturnType<typeof signer>) {
    const root = hex32(c.bundle.community_root);
    const address = baseRekeyGroupKey(root, c.communityId, 1n);
    const rumors = buildRekeyRumors(
      rotator.pubkey,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit: bytesToHex(epochKeyCommitment(0n, root)) },
      [{ locator: "cc".repeat(32), wrapped: "opaque" }],
      Date.now(),
    );
    return Promise.all(rumors.map(async (r) => wrapSeal(await sealRumor(r, KIND_SEAL_ENCRYPTED, address, rotator), address)));
  }

  const sorted = (events: NostrEvent[]) => events.sort((a, b) => b.created_at - a.created_at);

  it("retires every link on an epoch the owner refounded past", async () => {
    const c = await realCommunity([]);
    const events = sorted([await c.metadataWrap(), ...(await rotation(c, c.owner))]);
    const peek = await peekDiscoverControl(fakeNostr({ "wss://one": { events, calls: [] } }), c.bundle);
    expect(peek?.rotated).toBe(true);
  });

  it("does not retire a link the invite registries leave out", async () => {
    // Published registries omit links that work (a mint once raced its own list write).
    const c = await realCommunity([]);
    const events = sorted([await c.metadataWrap(), await registry(c, [LINK_A])]);
    const peek = await peekDiscoverControl(fakeNostr({ "wss://one": { events, calls: [] } }), c.bundle);
    expect(peek?.rotated).toBe(false);
  });

  it("ignores a rotation by someone who merely holds the link", async () => {
    // Every holder of the link holds the root and can write the rekey address.
    const c = await realCommunity([]);
    const events = sorted([await c.metadataWrap(), ...(await rotation(c, signer()))]);
    const peek = await peekDiscoverControl(fakeNostr({ "wss://one": { events, calls: [] } }), c.bundle);
    expect(peek?.rotated).toBe(false);
  });
});

describe("enqueueDiscoverControlPeek", () => {
  it("runs one peek at a time, and a rejection does not stall the queue", async () => {
    _resetDiscoverControlPeekQueueForTests();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const a = enqueueDiscoverControlPeek(async () => {
      order.push("a:start");
      await gate;
      order.push("a:end");
      return "a";
    });
    const b = enqueueDiscoverControlPeek(async () => {
      order.push("b:start");
      throw new Error("b failed");
    });
    const c = enqueueDiscoverControlPeek(async () => {
      order.push("c:start");
      return "c";
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["a:start"]);

    release();
    await expect(a).resolves.toBe("a");
    await expect(b).rejects.toThrow("b failed");
    await expect(c).resolves.toBe("c");
    expect(order).toEqual(["a:start", "a:end", "b:start", "c:start"]);
  });
});
