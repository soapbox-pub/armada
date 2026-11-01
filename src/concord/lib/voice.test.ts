import { verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { voiceGroupKey } from "@/concord/lib/derive";
import { KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";
import { MAX_COMMUNITY_AV_BROKERS } from "@/concord/lib/types";
import {
  brokerRank,
  canonicalOrigin,
  communityAvBrokers,
  fetchAvToken,
  fetchAvTokenFromAny,
  foldVoicePresence,
  heartbeatDelayMs,
  KIND_HTTP_AUTH,
  isVerifiedScreenShareIdentity,
  orderBrokers,
  parsePresence,
  parseReaction,
  presenceTags,
  reactionTag,
  rendezvousCandidates,
  occupantsElsewhere,
  signAvGrant,
  verifiedAuthorOf,
  VOICE_HEARTBEAT_MS,
  VOICE_STALE_MS,
  type VoicePresenceEntry,
} from "@/concord/lib/voice";

const A = new Uint8Array(32).fill(1);
const B = new Uint8Array(32).fill(2);

describe("canonicalOrigin (RFC 6454, §5)", () => {
  it("lowercases, strips default port / path / trailing slash", () => {
    expect(canonicalOrigin("https://Broker.Example")).toBe("https://broker.example");
    expect(canonicalOrigin("https://broker.example/")).toBe("https://broker.example");
    expect(canonicalOrigin("https://broker.example:443/x/y?z")).toBe("https://broker.example");
    expect(canonicalOrigin("https://broker.example:8443")).toBe("https://broker.example:8443");
  });

  it("refuses non-https and malformed input", () => {
    expect(canonicalOrigin("http://broker.example")).toBeNull();
    expect(canonicalOrigin("wss://broker.example")).toBeNull();
    expect(canonicalOrigin("not a url")).toBeNull();
    expect(canonicalOrigin("https://user:pw@broker.example")).toBeNull();
  });
});

describe("broker tie-break (§5)", () => {
  const room = "ab".repeat(32);

  it("is deterministic and binds the room", () => {
    expect(brokerRank(room, "https://a.example")).toBe(brokerRank(room, "https://a.example"));
    expect(brokerRank("cd".repeat(32), "https://a.example")).not.toBe(brokerRank(room, "https://a.example"));
  });

  it("orders canonicalized, deduped origins by rank", () => {
    const ordered = orderBrokers(room, [
      "https://A.example/",
      "https://b.example",
      "https://a.example",
      "http://c.example", // refused: not https
    ]);
    expect(ordered).toHaveLength(2);
    expect([...ordered].sort((x, y) => (brokerRank(room, x) < brokerRank(room, y) ? -1 : 1))).toEqual(ordered);
  });
});

describe("token grant (§2)", () => {
  it("self-signs a kind-27235 event whose pubkey IS the room name", () => {
    const voice = voiceGroupKey(A, B, 0);
    const url = `https://broker.example/.well-known/concord/av/${voice.pk}`;
    const event = JSON.parse(atob(signAvGrant(voice, url)));
    expect(event.kind).toBe(KIND_HTTP_AUTH);
    expect(event.pubkey).toBe(voice.pk);
    expect(event.tags).toContainEqual(["u", url]);
    expect(event.tags).toContainEqual(["method", "GET"]);
    expect(verifyEvent(event)).toBe(true);
  });

  it("carries a fresh 32-byte nonce, so same-second grants never share an id", () => {
    const voice = voiceGroupKey(A, B, 0);
    const url = `https://broker.example/.well-known/concord/av/${voice.pk}`;
    const grant = () => JSON.parse(atob(signAvGrant(voice, url))) as { id: string; tags: string[][] };
    const a = grant();
    const b = grant();
    const nonceOf = (e: { tags: string[][] }) => e.tags.find((t) => t[0] === "nonce")?.[1];
    expect(nonceOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(nonceOf(b)).not.toBe(nonceOf(a));
    // The property that matters (§2): every member of a Channel signs with the
    // SAME voice_key.sk, so without the nonce two joiners in one second build
    // byte-identical events, and the broker's anti-replay set — which keys on
    // the id — drops the second one to arrive.
    expect(a.id).not.toBe(b.id);
  });
});

describe("token minting fall-through (§5)", () => {
  const voice = voiceGroupKey(A, B, 0);
  const body = (identity: string) =>
    new Response(JSON.stringify({ token: "jwt", url: "wss://sfu.example.com", identity }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the origin that actually minted the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => body("id-1")));
    const token = await fetchAvToken("https://a.example", voice);
    expect(token).toMatchObject({ identity: "id-1", origin: "https://a.example" });
  });

  it("falls through to the next candidate, and reports THAT origin", async () => {
    // The origin matters: it rides presence as the §5 hint, so announcing the
    // broker we failed to reach would steer everyone else away from the call.
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).startsWith("https://down.example")) throw new Error("connection refused");
      return body("id-2");
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await fetchAvTokenFromAny(["https://down.example", "https://up.example"], voice);
    expect(token.origin).toBe("https://up.example");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("moves past a broker that answers but refuses to mint", async () => {
    // A capability probe only proves the broker was reachable a moment ago; a
    // 503 here is how a loaded broker sheds a room it does not host.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).startsWith("https://full.example")
          ? new Response(null, { status: 503 })
          : body("id-3"),
      ),
    );
    const token = await fetchAvTokenFromAny(["https://full.example", "https://spare.example"], voice);
    expect(token.origin).toBe("https://spare.example");
  });

  it("dedupes candidates and skips empties", async () => {
    const fetchMock = vi.fn(async () => body("id-4"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAvTokenFromAny(["https://a.example", "https://a.example", ""], voice);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the last failure when every candidate is exhausted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 502 })),
    );
    await expect(fetchAvTokenFromAny(["https://a.example", "https://b.example"], voice)).rejects.toThrow(
      /HTTP 502/,
    );
    await expect(fetchAvTokenFromAny([], voice)).rejects.toThrow(/No voice server/);
  });
});

describe("heartbeatDelayMs (§4)", () => {
  it("never exceeds the 30s heartbeat, so the 90s staleness margin only widens", () => {
    // Three heartbeats must still fit inside VOICE_STALE_MS. Jittering upward
    // would leave room for only two, and members would flicker out of rosters.
    expect(heartbeatDelayMs(() => 0)).toBe(24_000);
    expect(heartbeatDelayMs(() => 0.999999)).toBeLessThanOrEqual(VOICE_HEARTBEAT_MS);
    for (let i = 0; i < 200; i++) {
      const delay = heartbeatDelayMs();
      expect(delay).toBeLessThanOrEqual(VOICE_HEARTBEAT_MS);
      expect(delay * 3).toBeLessThanOrEqual(VOICE_STALE_MS);
    }
  });
});

// ── Presence (§4) ────────────────────────────────────────────────────────────

function openedPresence(overrides: Partial<OpenedEvent>): OpenedEvent {
  return {
    rumorId: "r".repeat(64),
    author: "a".repeat(64),
    kind: KIND_VOICE_PRESENCE,
    content: "joined",
    tags: [["identity", "id-1"], ["broker", "https://b.example"]],
    ms: 1_000_000,
    createdAt: 1000,
    wrapId: "w".repeat(64),
    streamPk: "s".repeat(64),
    sealKind: 20013,
    seal: {} as OpenedEvent["seal"],
    ...overrides,
  };
}

describe("parsePresence (§4)", () => {
  it("parses a joined with identity + canonicalized broker", () => {
    const p = parsePresence(openedPresence({}));
    expect(p).toEqual({
      author: "a".repeat(64),
      status: "joined",
      identity: "id-1",
      identities: ["id-1"],
      screenShareIdentities: [],
      broker: "https://b.example",
      hand: false,
      recording: false,
      noRecord: false,
      ms: 1_000_000,
      rumorId: "r".repeat(64),
    });
  });

  it("reads the recording and norecord tags (client extensions) only while joined", () => {
    const flagged = openedPresence({
      tags: [["identity", "id-1"], ["recording", "1"], ["norecord", "1"]],
    });
    expect(parsePresence(flagged)).toMatchObject({ recording: true, noRecord: true });
    expect(parsePresence(openedPresence({ tags: [["identity", "id-1"], ["recording", "yes"]] }))?.recording).toBe(false);
    expect(
      parsePresence(openedPresence({ content: "left", tags: [["recording", "1"], ["norecord", "1"]] })),
    ).toMatchObject({ recording: false, noRecord: false });
  });

  it("reads the raised-hand tag (client extension) only while joined", () => {
    const withHand = openedPresence({
      tags: [["identity", "id-1"], ["broker", "https://b.example"], ["hand", "1"]],
    });
    expect(parsePresence(withHand)?.hand).toBe(true);
    // Absent tag → hand down; a `left` never carries a raised hand.
    expect(parsePresence(openedPresence({}))?.hand).toBe(false);
    expect(parsePresence(openedPresence({ content: "left", tags: [["hand", "1"]] }))?.hand).toBe(false);
  });

  it("parses a left (identity and broker omitted)", () => {
    const p = parsePresence(openedPresence({ content: "left", tags: [] }));
    expect(p?.status).toBe("left");
    expect(p?.identity).toBeUndefined();
  });

  it("drops malformed entries: wrong kind, unknown verb, joined without identity", () => {
    expect(parsePresence(openedPresence({ kind: 23311 }))).toBeNull();
    expect(parsePresence(openedPresence({ content: "join" }))).toBeNull();
    expect(parsePresence(openedPresence({ tags: [] }))).toBeNull();
  });

  it("accepts bounded, deduplicated sidecar identities with the primary first", () => {
    const p = parsePresence(openedPresence({
      tags: [
        ["identity", "id-1"],
        ["identity", "hevc-1", "screen-share"],
        ["identity", "id-1"],
        ["identity", "hevc-2"],
        ["identity", "hevc-3"],
        ["identity", "ignored-fifth"],
      ],
    }));

    expect(p?.identity).toBe("id-1");
    expect(p?.identities).toEqual(["id-1", "hevc-1", "hevc-2", "hevc-3"]);
    expect(p?.screenShareIdentities).toEqual(["hevc-1"]);
  });

  it("keeps a peer-to-peer joined that names no identity (CORD-07 §4 Transports)", () => {
    const endpoint = "c".repeat(64);
    const p = parsePresence(openedPresence({
      tags: [["transport", "iroh"], ["endpoint", endpoint], ["relay", "https://relay.example/"]],
    }));
    expect(p?.status).toBe("joined");
    expect(p?.transport).toBe("iroh");
    expect(p?.identity).toBeUndefined();
  });

  it("drops an iroh joined whose endpoint isn't 64 hex digits", () => {
    expect(parsePresence(openedPresence({ tags: [["transport", "iroh"]] }))).toBeNull();
    expect(parsePresence(openedPresence({ tags: [["transport", "iroh"], ["endpoint", "xyz"]] }))).toBeNull();
  });

  it("keeps a joined on a transport it has never heard of", () => {
    expect(parsePresence(openedPresence({ tags: [["transport", "future"]] }))?.transport).toBe("future");
  });
});

describe("presence tags (client extensions)", () => {
  it("emits the hand tag only for a raised, joined member", () => {
    expect(presenceTags("joined", "id-1", "https://b.example", { hand: true })).toContainEqual(["hand", "1"]);
    expect(presenceTags("joined", "id-1", "https://b.example", { hand: false })).not.toContainEqual(["hand", "1"]);
    // A `left` never advertises a hand.
    expect(presenceTags("left", undefined, undefined, { hand: true })).not.toContainEqual(["hand", "1"]);
  });

  it("emits the recording and norecord tags only while joined", () => {
    const joined = presenceTags("joined", "id-1", "https://b.example", { recording: true, noRecord: true });
    expect(joined).toContainEqual(["recording", "1"]);
    expect(joined).toContainEqual(["norecord", "1"]);
    expect(presenceTags("joined", "id-1", "https://b.example", {})).not.toContainEqual(["recording", "1"]);
    expect(presenceTags("left", undefined, undefined, { recording: true, noRecord: true })).toEqual([]);
  });

  it("emits each additional sidecar identity once while joined", () => {
    expect(presenceTags("joined", "id-1", "https://b.example", {
      additionalIdentities: ["hevc-1", "id-1", "hevc-1", "hevc-2"],
    })).toEqual([
      ["identity", "id-1"],
      ["identity", "hevc-1", "screen-share"],
      ["identity", "hevc-2", "screen-share"],
      ["broker", "https://b.example"],
    ]);
    expect(presenceTags("left", undefined, undefined, {
      additionalIdentities: ["hevc-1"],
    })).toEqual([]);
  });

  it("builds a react tag as [react, emoji, nonce]", () => {
    expect(reactionTag("🎉", "n1")).toEqual(["react", "🎉", "n1"]);
  });
});

describe("parseReaction (client extension)", () => {
  it("extracts a valid reaction, ignoring plain heartbeats", () => {
    const r = parseReaction(openedPresence({ tags: [["identity", "id-1"], ["react", "🎉", "n1"]] }));
    expect(r).toEqual({ author: "a".repeat(64), emoji: "🎉", nonce: "n1", ms: 1_000_000 });
    // No react tag → not a reaction.
    expect(parseReaction(openedPresence({}))).toBeNull();
  });

  it("rejects malformed reactions: wrong kind, missing nonce, oversize emoji", () => {
    expect(parseReaction(openedPresence({ kind: 23311, tags: [["react", "🎉", "n1"]] }))).toBeNull();
    expect(parseReaction(openedPresence({ tags: [["react", "🎉"]] }))).toBeNull();
    expect(parseReaction(openedPresence({ tags: [["react", "x".repeat(65), "n1"]] }))).toBeNull();
  });
});

describe("foldVoicePresence (§4)", () => {
  const now = 10_000_000;
  const entry = (o: Partial<VoicePresenceEntry>): VoicePresenceEntry => ({
    author: "a".repeat(64),
    status: "joined",
    identity: "id-1",
    broker: "https://b.example",
    ms: now - 1000,
    rumorId: "r1",
    ...o,
  });

  it("per author the latest wins; a left clears presence", () => {
    const fold = foldVoicePresence(
      [entry({ ms: now - 5000 }), entry({ status: "left", identity: undefined, ms: now - 1000 })],
      now,
    );
    expect(fold.present).toHaveLength(0);
  });

  it("a stale joined (three missed heartbeats) counts as absent", () => {
    const fold = foldVoicePresence([entry({ ms: now - VOICE_STALE_MS - 1 })], now);
    expect(fold.present).toHaveLength(0);
    expect(foldVoicePresence([entry({ ms: now - VOICE_STALE_MS + 1000 })], now).present).toHaveLength(1);
  });

  it("verifies an identity only when exactly one author claims it", () => {
    const contested = foldVoicePresence(
      [entry({}), entry({ author: "b".repeat(64), rumorId: "r2" })],
      now,
    );
    expect(verifiedAuthorOf(contested, "id-1")).toBeUndefined();

    const sole = foldVoicePresence([entry({})], now);
    expect(verifiedAuthorOf(sole, "id-1")).toBe("a".repeat(64));
    expect(verifiedAuthorOf(sole, "unclaimed")).toBeUndefined();
  });

  it("maps a sidecar SFU identity to the same verified author", () => {
    const fold = foldVoicePresence([entry({
      identities: ["id-1", "hevc-1"],
      screenShareIdentities: ["hevc-1"],
    })], now);

    expect(verifiedAuthorOf(fold, "id-1")).toBe("a".repeat(64));
    expect(verifiedAuthorOf(fold, "hevc-1")).toBe("a".repeat(64));
    expect(isVerifiedScreenShareIdentity(fold, "hevc-1")).toBe(true);
    expect(isVerifiedScreenShareIdentity(fold, "id-1")).toBe(false);
    expect(fold.present).toHaveLength(1);
  });

  it("lists a member on another transport apart, claiming no identity", () => {
    const fold = foldVoicePresence(
      [entry({}), entry({ author: "b".repeat(64), identity: undefined, broker: undefined, transport: "iroh", rumorId: "r2" })],
      now,
    );
    expect(fold.present.map((p) => p.author)).toEqual(["a".repeat(64)]);
    expect(fold.otherTransport).toEqual([{ author: "b".repeat(64), transport: "iroh", ms: now - 1000 }]);
    expect([...fold.claims.keys()]).toEqual(["id-1"]);
    expect(foldVoicePresence([entry({ transport: "iroh", ms: now - VOICE_STALE_MS - 1 })], now).otherTransport).toEqual([]);
  });
});

describe("rendezvous (config, not the §5 hint)", () => {
  const room = "ab".repeat(32);
  const now = 10_000_000;

  const joinedOn = (broker: string, n: number) => ({
    author: String(n).repeat(64).slice(0, 64),
    status: "joined" as const,
    identity: `id-${n}`,
    broker,
    ms: now - 1000,
    rumorId: `r${n}`,
  });

  it("with no community list, the client's own defaults in their stated order", () => {
    expect(rendezvousCandidates(room, ["https://one.example", "https://two.example"])).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  it("a community's brokers are the whole set — the client's own are not consulted", () => {
    const candidates = rendezvousCandidates(room, ["https://own.example"], [
      "https://c1.example",
      "https://c2.example",
    ]);
    expect(candidates).toEqual(orderBrokers(room, ["https://c1.example", "https://c2.example"]));
    expect(candidates).not.toContain("https://own.example");
  });

  it("orders a community's brokers by the room-keyed tie-break, so members converge unprompted", () => {
    const listed = ["https://c1.example", "https://c2.example", "https://c3.example"];
    // Two members, different personal servers, one list, nobody in the room:
    // the pick must not depend on whose client is asking.
    const ana = rendezvousCandidates(room, ["https://ana.example"], listed);
    const ben = rendezvousCandidates(room, ["https://ben.example"], [...listed].reverse());
    expect(ana).toEqual(ben);
    // ...and another room leads with another broker, spreading a community's
    // channels across the list rather than piling them onto its first.
    const other = rendezvousCandidates("cd".repeat(32), [], listed);
    expect(listed.map((b) => canonicalOrigin(b))).toContain(other[0]);
  });

  it("ignores the presence broker tag entirely — a call elsewhere does not move the answer", () => {
    // The signature takes no fold at all; this is the behavioral statement of
    // that. A member announcing a broker cannot steer anyone, listed or not.
    const listed = ["https://listed.example"];
    expect(rendezvousCandidates(room, ["https://own.example"], listed)).toEqual([
      "https://listed.example",
    ]);
    expect(rendezvousCandidates(room, ["https://own.example"])).toEqual(["https://own.example"]);
  });

  it("reports members on another broker than the one we joined, for the UI to offer", () => {
    const fold = foldVoicePresence(
      [joinedOn("https://ours.example", 1), joinedOn("https://elsewhere.example", 2)],
      now,
    );
    expect(occupantsElsewhere(fold, "https://ours.example").map((p) => p.identity)).toEqual(["id-2"]);
    // Canonicalized on both sides, so a spelling difference isn't a split...
    expect(occupantsElsewhere(fold, "https://Ours.Example:443/")).toHaveLength(1);
    // ...and nobody is "elsewhere" when everyone is where we are.
    expect(occupantsElsewhere(foldVoicePresence([joinedOn("https://ours.example", 1)], now), "https://ours.example")).toEqual([]);
  });
});

describe("communityAvBrokers (CORD-02 §6)", () => {
  it("canonicalizes, dedupes and caps; ignores unreadable entries", () => {
    expect(
      communityAvBrokers({
        name: "c",
        relays: [],
        av_brokers: [
          "https://A.Example:443/",
          "https://a.example",
          "http://insecure.example",
          "not a url",
          42 as unknown as string,
          "https://b.example",
        ],
      }),
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("reads absent, empty and malformed lists as no brokers", () => {
    expect(communityAvBrokers(undefined)).toEqual([]);
    expect(communityAvBrokers({ name: "c", relays: [] })).toEqual([]);
    expect(communityAvBrokers({ name: "c", relays: [], av_brokers: "https://x.example" as unknown as string[] })).toEqual([]);
  });

  it("caps at the protocol recommendation", () => {
    const many = Array.from({ length: MAX_COMMUNITY_AV_BROKERS + 3 }, (_, i) => `https://b${i}.example`);
    expect(communityAvBrokers({ name: "c", relays: [], av_brokers: many })).toHaveLength(
      MAX_COMMUNITY_AV_BROKERS,
    );
  });
});
