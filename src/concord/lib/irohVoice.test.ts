import { describe, expect, it } from "vitest";

import { KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";
import {
  acceptsInbound,
  allowedRelay,
  communityVoiceRelays,
  dials,
  FLAG_MUTED,
  MAX_PEERS,
  p2pTargets,
  packFrame,
  unpackFrame,
} from "@/concord/lib/irohVoice";
import {
  foldVoicePresence,
  notePresence,
  parsePresence,
  presenceTags,
  type VoicePresenceEntry,
  type VoicePresenceFold,
} from "@/concord/lib/voice";

const now = 10_000_000;
const pk = (c: string) => c.repeat(64);
const ep = (c: string) => c.repeat(64);
const RELAY = "https://euc1-1.relay.n0.iroh.link./";

function opened(tags: string[][], author = pk("a")): OpenedEvent {
  return {
    rumorId: "r".repeat(64),
    author,
    kind: KIND_VOICE_PRESENCE,
    content: "joined",
    tags,
    ms: now,
    createdAt: now / 1000,
    wrapId: "w".repeat(64),
    streamPk: "s".repeat(64),
    sealKind: 20013,
    seal: {} as OpenedEvent["seal"],
  };
}

describe("the datagram header (Vector `wire.rs`)", () => {
  it("packs seq, sender ms and flags big-endian ahead of the payload", () => {
    const b = packFrame(7, 1234, 1, new Uint8Array([9, 8, 7]));
    expect([...b]).toEqual([0, 7, 0, 0, 4, 210, 0, 1, 9, 8, 7]);
    const f = unpackFrame(b)!;
    expect([f.seq, f.tsMs, f.flags, [...f.payload]]).toEqual([7, 1234, FLAG_MUTED, [9, 8, 7]]);
    expect(unpackFrame(b.subarray(0, 5))).toBeNull();
  });

  it("wraps a sequence past 16 bits", () => {
    expect(unpackFrame(packFrame(0x1_0005, 0, 0, new Uint8Array()))!.seq).toBe(5);
  });
});

describe("who dials (Vector `dials`)", () => {
  it("is exactly one of a pair, never ourselves", () => {
    expect(dials(ep("1"), ep("2")) !== dials(ep("2"), ep("1"))).toBe(true);
    expect(dials(ep("1"), ep("1"))).toBe(false);
    expect(dials(ep("A"), ep("b"))).toBe(true);
  });
});

describe("relays a peer may be dialled through (Vector `allowed_relay`)", () => {
  it("allows iroh's defaults, with or without the trailing dot, and the Community's own", () => {
    expect(allowedRelay(RELAY, [])).toBe(true);
    expect(allowedRelay("https://USE1-1.relay.n0.iroh.link/", [])).toBe(true);
    expect(allowedRelay("https://relay.example/", [])).toBe(false);
    expect(allowedRelay("https://relay.example/", ["https://relay.example"])).toBe(true);
    expect(allowedRelay("not a url", [])).toBe(false);
  });

  it("reads the Community's voice relays as Vector does: https, bounded, at most eight", () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://r${i}.example`);
    expect(communityVoiceRelays({ name: "", relays: [], voice_relays: ["http://plain.example", 3, ...many] })).toEqual(many.slice(0, 8));
    expect(communityVoiceRelays(undefined)).toEqual([]);
  });
});

describe("iroh presence", () => {
  it("keeps the endpoint and relay an iroh joined names", () => {
    const p = parsePresence(opened([["transport", "iroh"], ["endpoint", ep("C")], ["relay", RELAY]]));
    expect(p?.iroh).toEqual({ endpoint: ep("c"), relay: RELAY });
    const bare = parsePresence(opened([["transport", "iroh"], ["endpoint", ep("c")], ["relay", "wss://x.example"]]));
    expect(bare?.iroh).toEqual({ endpoint: ep("c") });
  });

  it("names our SFU identity and our endpoint in one joined, which reads back as on both", () => {
    const tags = presenceTags("joined", "id-1", "https://av.example", { iroh: { endpoint: ep("d"), relay: RELAY } });
    expect(tags).toContainEqual(["transport", "iroh"]);
    expect(tags).toContainEqual(["endpoint", ep("d")]);
    expect(tags).toContainEqual(["relay", RELAY]);
    const latest = new Map<string, VoicePresenceEntry>();
    notePresence(latest, parsePresence(opened(tags))!, now);
    const fold = foldVoicePresence([...latest.values()], now);
    expect(fold.present).toHaveLength(1);
    expect(fold.present[0]).toMatchObject({ identity: "id-1", alsoOn: "iroh", iroh: { endpoint: ep("d"), relay: RELAY } });
    expect(fold.otherTransport).toEqual([]);
    expect(presenceTags("left", undefined, undefined, { iroh: { endpoint: ep("d") } })).toEqual([]);
  });

  it("names our endpoint alone when off the SFU, which reads back as on iroh only", () => {
    const tags = presenceTags("joined", undefined, undefined, { iroh: { endpoint: ep("d"), relay: RELAY }, muted: true });
    const fold = foldVoicePresence([parsePresence(opened(tags))!], now);
    expect(fold.present).toEqual([]);
    expect(fold.otherTransport).toEqual([{ author: pk("a"), transport: "iroh", iroh: { endpoint: ep("d"), relay: RELAY }, muted: true, ms: now }]);
  });
});

function fold(present: Partial<VoicePresenceFold["present"][number]>[], other: Partial<VoicePresenceFold["otherTransport"][number]>[]): VoicePresenceFold {
  return {
    present: present.map((p) => ({ author: "", identity: "id", screenShareIdentities: [], hand: false, recording: false, noRecord: false, ms: 0, ...p })),
    claims: new Map(),
    otherTransport: other.map((o) => ({ author: "", transport: "iroh", ms: 0, ...o })),
  };
}

describe("the call's topology", () => {
  const me = pk("0");
  const mine = ep("5");
  const vector = { author: pk("v"), iroh: { endpoint: ep("9"), relay: RELAY } };
  const armadaOnSfu = { author: pk("b"), alsoOn: "iroh", iroh: { endpoint: ep("1"), relay: RELAY } };

  it("on the SFU: links to members on iroh alone, never to another member on the SFU", () => {
    const targets = p2pTargets(fold([armadaOnSfu], [vector]), me, { onSfu: true, endpoint: mine, communityRelays: [] });
    expect(targets.map((t) => t.author)).toEqual([pk("v")]);
    expect(targets[0].dial).toBe(true);
  });

  it("off the SFU: links to everyone with an endpoint, the SFU's members included", () => {
    const targets = p2pTargets(fold([armadaOnSfu], [vector]), me, { onSfu: false, endpoint: mine, communityRelays: [] });
    expect(targets.map((t) => [t.author, t.dial])).toEqual([[pk("v"), true], [pk("b"), false]]);
  });

  it("drops a peer's link once their SFU presence arrives", () => {
    const joined = { ...vector, alsoOn: "iroh" };
    expect(p2pTargets(fold([joined], []), me, { onSfu: true, endpoint: mine, communityRelays: [] })).toEqual([]);
  });

  it("dials only through a relay it may use, and leaves the lower endpoint to dial", () => {
    const stranger = { author: pk("s"), iroh: { endpoint: ep("8"), relay: "https://evil.example/" } };
    const noRelay = { author: pk("n"), iroh: { endpoint: ep("7") } };
    const lower = { author: pk("l"), iroh: { endpoint: ep("2"), relay: RELAY } };
    const targets = p2pTargets(fold([], [stranger, noRelay, lower]), me, { onSfu: true, endpoint: mine, communityRelays: [] });
    expect(targets.map((t) => [t.author, t.dial])).toEqual([[pk("s"), false], [pk("n"), false], [pk("l"), false]]);
    expect(acceptsInbound(targets, ep("2"), mine)?.author).toBe(pk("l"));
    expect(acceptsInbound(targets, ep("8"), mine), "they should have waited for us to dial").toBeUndefined();
    expect(acceptsInbound(targets, ep("3"), mine), "nobody's presence names it").toBeUndefined();
  });

  it("gives an endpoint two members claim to neither, and skips our own", () => {
    const a = { author: pk("c"), iroh: { endpoint: ep("9"), relay: RELAY } };
    const b = { author: pk("d"), iroh: { endpoint: ep("9"), relay: RELAY } };
    const self = { author: me, iroh: { endpoint: mine, relay: RELAY } };
    expect(p2pTargets(fold([], [a, b, self]), me, { onSfu: false, endpoint: mine, communityRelays: [] })).toEqual([]);
  });

  it("leaves iroh to a bridge while on the SFU, so no voice arrives twice", () => {
    const bridge = { author: pk("e"), alsoOn: "iroh", bridge: "iroh", iroh: { endpoint: ep("6"), relay: RELAY } };
    expect(p2pTargets(fold([bridge], [vector]), me, { onSfu: true, endpoint: mine, communityRelays: [] })).toEqual([]);
    expect(p2pTargets(fold([bridge], [vector]), me, { onSfu: false, endpoint: mine, communityRelays: [] })).toHaveLength(2);
  });

  it("holds the mesh to its cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ author: pk(i.toString(16).padStart(2, "0").slice(-1)) + i, iroh: { endpoint: (i + 100).toString(16).padStart(64, "f"), relay: RELAY } }));
    expect(p2pTargets(fold([], many), me, { onSfu: true, endpoint: mine, communityRelays: [] })).toHaveLength(MAX_PEERS);
  });
});

describe("a member's connection marker", () => {
  it("reads LiveKit for anyone on the SFU, peer to peer only for members off it", async () => {
    const { connectionOf, voiceRowTransports } = await import("@/concord/lib/voice");
    const sfuOnly = { author: pk("s") };
    const both = { author: pk("b"), alsoOn: "iroh" };
    const f = fold([sfuOnly, both], [{ author: pk("v") }, { author: pk("w") }]);
    const rows = voiceRowTransports(f, new Set([pk("v"), pk("b")]), [pk("late")]);
    expect(Object.fromEntries(rows)).toEqual({ [pk("s")]: "sfu", [pk("b")]: "sfu", [pk("v")]: "linked", [pk("w")]: "other", [pk("late")]: "sfu" });
    expect([...rows.values()].map(connectionOf)).toEqual(["p2p", "p2p", "sfu", "sfu", "sfu"]);
  });

  it("keeps the LiveKit marker for a member bridging iroh into the SFU", async () => {
    const { connectionOf, voiceRowTransports } = await import("@/concord/lib/voice");
    const rows = voiceRowTransports(fold([{ author: pk("e"), alsoOn: "iroh", bridge: "iroh" }], [{ author: pk("v") }]));
    expect([rows.get(pk("e")), rows.get(pk("v"))]).toEqual(["bridge", "bridged"]);
    expect(connectionOf("bridge")).toBe("sfu");
  });
});
