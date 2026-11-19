import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type { NostrFilter } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

const opens = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/concord/lib/stream", async (orig) => {
  const real = await orig<typeof import("@/concord/lib/stream")>();
  return {
    ...real,
    openWrapsBatched: (...args: Parameters<typeof real.openWrapsBatched>) => ((opens.count += args[0].length), real.openWrapsBatched(...args)),
  };
});

import { clearAccessPlaneMemory, readAccessPlanes } from "@/concord/hooks/useChannelAccess";
import { accessPlane } from "@/concord/lib/delivery";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRumor, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";

const root = randomBytes(32);
const channel = bytesToHex(randomBytes(32));
const community = {
  id: randomBytes(32),
  idHex: "c0",
  owner: "00".repeat(32),
  root,
  rootEpoch: 0n,
  heldRoots: [{ epoch: 0n, key: root }],
  privateChannels: [],
  relays: ["wss://a.test", "wss://b.test", "wss://c.test"],
} as unknown as Community;
const plane = accessPlane(community, Buffer.from(channel, "hex"));
const sk = generateSecretKey();
const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };

/** `n` distinct-id copies of one real plane wrap, dated `at`. */
async function wraps(n: number, at: number, on = plane): Promise<NostrEvent[]> {
  const rumor = buildRumor({ kind: 3303, content: "x", tags: [], pubkey: getPublicKey(sk), createdAtSecs: at });
  const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, on, signer), on);
  return Array.from({ length: n }, () => ({ ...wrap, id: bytesToHex(randomBytes(32)), created_at: at }));
}

/** A relay answering like strfry: newest first, ties by id, `limit` honored up to `cap`. */
function relayOver(events: NostrEvent[], seen: NostrFilter[], cap = Infinity) {
  return {
    query: async ([f]: NostrFilter[]) => {
      seen.push(f);
      return events
        .filter((e) => (!f.authors || f.authors.includes(e.pubkey)) && (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, Math.min(f.limit ?? Infinity, cap));
    },
  };
}

const signal = new AbortController().signal;

describe("readAccessPlanes", () => {
  beforeEach(() => clearAccessPlaneMemory());

  it("reads past a same-second wall wider than a page", async () => {
    const plane = [...(await wraps(450, 1_000)), ...(await wraps(3, 900))];
    const filters: NostrFilter[] = [];
    const nostr = { relay: () => relayOver(plane, filters) };
    const got = await readAccessPlanes(nostr as never, community, [channel], signal);
    expect(new Set(got.map((g) => g.opened.wrapId)).size).toBe(453);
  });

  it("pages each plane on its own, so one plane's flood can't hide another's deliveries", async () => {
    const other = bytesToHex(randomBytes(32));
    const otherPlane = accessPlane(community, Buffer.from(other, "hex"));
    const events = [...(await wraps(1_300, 2_000)).map((w, i) => ({ ...w, created_at: 2_000 + i })), ...(await wraps(1, 1_000, otherPlane))];
    const nostr = { relay: () => relayOver(events, []) };
    const got = await readAccessPlanes(nostr as never, community, [channel, other], signal);
    expect(got.filter((g) => g.channelIdHex === other)).toHaveLength(1);
  });

  it("reopens only the wraps a re-read adds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const plane = await wraps(5, now - 600);
    const nostr = { relay: () => relayOver(plane, []) };
    await readAccessPlanes(nostr as never, community, [channel], signal);
    opens.count = 0;
    plane.push(...(await wraps(1, now)));
    expect(await readAccessPlanes(nostr as never, community, [channel], signal)).toHaveLength(6);
    expect(opens.count).toBe(1);
  });

  it("throws when no relay answered, rather than reading the planes as empty", async () => {
    const nostr = { relay: () => ({ query: async () => Promise.reject(new Error("CLOSED: auth-required")) }) };
    await expect(readAccessPlanes(nostr as never, community, [channel], signal)).rejects.toThrow();
  });

  it("answers from a majority of relays when another fails", async () => {
    const plane = await wraps(2, 1_000);
    const nostr = {
      relay: (url: string) => (url === "wss://c.test" ? { query: async () => Promise.reject(new Error("timeout")) } : relayOver(plane, [])),
    };
    const got = await readAccessPlanes(nostr as never, community, [channel], signal);
    expect(got).toHaveLength(2);
  });

  it("throws when only a minority answered, however quickly it answered empty", async () => {
    const nostr = {
      relay: (url: string) => (url === "wss://a.test" ? relayOver([], []) : { query: async () => Promise.reject(new Error("timeout")) }),
    };
    await expect(readAccessPlanes(nostr as never, community, [channel], signal)).rejects.toThrow(/1 of 3/);
  });

  it("reads again only what is new, and still answers with the whole plane", async () => {
    const now = Math.floor(Date.now() / 1000);
    const plane = await wraps(5, now - 86_400);
    const filters: NostrFilter[] = [];
    const nostr = { relay: () => relayOver(plane, filters) };
    expect(await readAccessPlanes(nostr as never, community, [channel], signal)).toHaveLength(5);
    filters.length = 0;
    plane.push(...(await wraps(1, now)));
    const again = await readAccessPlanes(nostr as never, community, [channel], signal);
    expect(again).toHaveLength(6);
    expect(filters.every((f) => f.since !== undefined && f.since > now - 2 * 3600)).toBe(true);
  });
});
