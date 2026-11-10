import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  ARMADA_DEVELOPERS,
  ARMADA_DEVELOPERS_ENTRY,
  BUILD_DISCOVER_CURATION,
  curatedPubkeys,
  curationFilter,
  curationKey,
  isCurationEvent,
  storeCurationEntries,
  parseDiscoverCuration,
  parseDiscoverCurations,
  resolveDiscoverCurations,
  resolveDiscoverRelays,
  type DiscoverCuration,
} from "./discoverSource";

import type { NostrRumor } from "@/lib/nostrRumor";

const PK = "a".repeat(64);
const OTHER = "b".repeat(64);
const MK = "932614571afcbad4d17a191ee281e39eebbb41b93fac8fd87829622aeb112f4d";
const SOAPBOX = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";
/** A kind-39089 follow pack. */
const TEAM_PACK =
  "naddr1qvzqqqyckypzpyexz3t34l966ngh5xg7u2q788hthdqmj0av3lv8s2tz9t43zt6dqqxxkdrsx4mnqm3jxfeh2ess5pyrw";

function rumor(partial: Partial<NostrRumor>): NostrRumor {
  return { id: "0".repeat(64), pubkey: PK, created_at: 1, kind: 1, tags: [], content: "", ...partial };
}

function ok(input: string): DiscoverCuration {
  const parsed = parseDiscoverCuration(input);
  if (!parsed.ok) throw new Error(`expected ${input} to parse: ${parsed.error}`);
  return parsed.curation;
}

describe("parseDiscoverCuration", () => {
  it("defaults to the Armada Developers, as seeds", () => {
    expect(BUILD_DISCOVER_CURATION).toBe(ARMADA_DEVELOPERS_ENTRY);
    expect(ARMADA_DEVELOPERS).toEqual([
      SOAPBOX,
      "0ddf6c35f61eb040316d01f68ded4d38b579c17423d26715fd489105a981910a",
      "0461fcbecc4c3374439932d6b8f11269ccdb7cc973ad7a50ae362db135a474dd",
      "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47",
    ]);
    const parsed = parseDiscoverCurations(ARMADA_DEVELOPERS_ENTRY);
    expect(parsed.ok && parsed.sources).toEqual(ARMADA_DEVELOPERS.map((pubkey) => ({ type: "follows", pubkey, relays: [] })));
  });

  it("reads a follow pack naddr as a kind-39089 list", () => {
    expect(ok(TEAM_PACK)).toEqual({
      type: "list",
      kind: 39089,
      pubkey: MK,
      identifier: "k4p5w0n22suf",
      relays: [],
    });
  });

  it("keeps an naddr's relay hints, normalized, and drops unusable ones", () => {
    const naddr = nip19.naddrEncode({
      kind: 30000,
      pubkey: PK,
      identifier: "friends",
      relays: ["wss://relay.example.com/", "https://not-a-relay.example", "ws://relay.example.org", "wss://192.168.1.4", "wss://localhost:7777"],
    });
    expect(ok(naddr)).toEqual({
      type: "list",
      kind: 30000,
      pubkey: PK,
      identifier: "friends",
      relays: ["wss://relay.example.com"],
    });
  });

  it("accepts a nostr: prefix and surrounding whitespace", () => {
    expect(ok(`  nostr:${TEAM_PACK}\n`)).toMatchObject({ type: "list", kind: 39089 });
  });

  it("reads an npub, an nprofile and a hex pubkey as that person's follow list", () => {
    expect(ok(nip19.npubEncode(PK))).toEqual({ type: "follows", pubkey: PK, relays: [] });
    expect(ok(PK.toUpperCase())).toEqual({ type: "follows", pubkey: PK, relays: [] });
    expect(ok(nip19.nprofileEncode({ pubkey: OTHER, relays: ["relay.example.com"] }))).toEqual({
      type: "follows",
      pubkey: OTHER,
      relays: ["wss://relay.example.com"],
    });
  });

  it("reads none, in any case, as no curated list", () => {
    expect(ok("none")).toEqual({ type: "none" });
    expect(ok(" NONE ")).toEqual({ type: "none" });
  });

  it("rejects an empty value, garbage, short hex and the wrong NIP-19 types", () => {
    for (const input of [
      "",
      "   ",
      "hello",
      "a".repeat(63),
      "wss://relay.example.com",
      nip19.noteEncode(PK),
      nip19.neventEncode({ id: PK }),
    ]) {
      expect(parseDiscoverCuration(input).ok, input).toBe(false);
    }
  });

  it("rejects an naddr of a non-addressable kind", () => {
    const naddr = nip19.naddrEncode({ kind: 10000, pubkey: PK, identifier: "" });
    const parsed = parseDiscoverCuration(naddr);
    expect(parsed.ok).toBe(false);
  });
});

describe("parseDiscoverCurations", () => {
  const npub = nip19.npubEncode(PK);
  const other = nip19.npubEncode(OTHER);

  it("takes several sources separated by commas or spaces, deduped", () => {
    const parsed = parseDiscoverCurations(`${npub}, ${other}\n${TEAM_PACK} ${npub}`);
    expect(parsed.ok && parsed.sources.map((s) => s.type)).toEqual(["follows", "follows", "list"]);
    expect(parsed.ok && parsed.none).toBe(false);
  });

  it("takes none only on its own", () => {
    expect(parseDiscoverCurations(" None ")).toEqual({ ok: true, sources: [], none: true });
    expect(parseDiscoverCurations(`none, ${npub}`).ok).toBe(false);
  });

  it("takes as many curators as given, the developers among them", () => {
    const many = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, "0"));
    const parsed = parseDiscoverCurations([ARMADA_DEVELOPERS_ENTRY, ...many].join(", "));
    expect(parsed.ok && parsed.sources).toHaveLength(44);
  });

  it("stores no curators as none", () => {
    expect(storeCurationEntries([])).toBe("none");
    expect(storeCurationEntries([ARMADA_DEVELOPERS_ENTRY, npub])).toBe(`${ARMADA_DEVELOPERS_ENTRY}, ${npub}`);
  });

  it("refuses an empty field or a bad entry", () => {
    expect(parseDiscoverCurations(" , ").ok).toBe(false);
    expect(parseDiscoverCurations(`${npub}, garbage`).ok).toBe(false);
  });
});

describe("resolveDiscoverCurations", () => {
  it("uses the build default when there is no override", () => {
    const set = resolveDiscoverCurations("   ", false, TEAM_PACK);
    expect(set.everyone).toBe(false);
    expect(set.sources).toEqual([expect.objectContaining({ type: "list", pubkey: MK })]);
  });

  it("uses the override over the build default", () => {
    expect(resolveDiscoverCurations(nip19.npubEncode(PK), false, TEAM_PACK)).toEqual({
      sources: [{ type: "follows", pubkey: PK, relays: [] }],
      everyone: false,
    });
  });

  it("reads none as only the network, never as everyone", () => {
    expect(resolveDiscoverCurations("none", false, TEAM_PACK)).toEqual({ sources: [], everyone: false });
    expect(resolveDiscoverCurations("", false, "none")).toEqual({ sources: [], everyone: false });
  });

  it("reads everyone only below no curators, with the device's switch on", () => {
    expect(resolveDiscoverCurations("none", true, TEAM_PACK)).toEqual({ sources: [], everyone: true });
    expect(resolveDiscoverCurations("", true, TEAM_PACK).everyone).toBe(false);
    expect(resolveDiscoverCurations("", true, "none").everyone).toBe(false);
    expect(resolveDiscoverCurations(nip19.npubEncode(PK), true, TEAM_PACK).everyone).toBe(false);
  });

  it("resolves an unparseable override to no list, never back to the build default", () => {
    expect(resolveDiscoverCurations("garbage", false, TEAM_PACK)).toEqual({ sources: [], everyone: false });
  });
});

describe("resolveDiscoverRelays", () => {
  it("uses the app relays when the user has none of their own", () => {
    expect(resolveDiscoverRelays(["wss://app.example/", "wss://app.example"])).toEqual(["wss://app.example"]);
  });

  it("adds the user's own relays after the app relays, normalized and de-duplicated", () => {
    expect(
      resolveDiscoverRelays(["wss://app.example"], ["mine.example", "wss://mine.example/", "wss://app.example/"]),
    ).toEqual(["wss://app.example", "wss://mine.example"]);
  });

  it("drops relays that aren't relay URLs", () => {
    expect(resolveDiscoverRelays(["wss://app.example"], ["https://nope.example"])).toEqual(["wss://app.example"]);
  });
});

describe("reading a source's list", () => {
  const pack = ok(TEAM_PACK);
  const follows = ok(PK);

  it("builds a filter per source type", () => {
    expect(curationFilter(pack)).toEqual({
      kinds: [39089],
      authors: [MK],
      "#d": ["k4p5w0n22suf"],
      limit: 1,
    });
    expect(curationFilter(follows)).toEqual({ kinds: [3], authors: [PK], limit: 1 });
    expect(curationFilter({ type: "none" })).toBeNull();
  });

  it("keys sources distinctly", () => {
    expect(new Set([curationKey(pack), curationKey(follows), curationKey({ type: "none" })]).size).toBe(3);
  });

  it("matches only the source's own list event", () => {
    const packEvent = rumor({ kind: 39089, pubkey: MK, tags: [["d", "k4p5w0n22suf"]] });
    expect(isCurationEvent(pack, packEvent)).toBe(true);
    expect(isCurationEvent(pack, { ...packEvent, tags: [["d", "other"]] })).toBe(false);
    expect(isCurationEvent(pack, { ...packEvent, pubkey: PK })).toBe(false);
    expect(isCurationEvent(follows, rumor({ kind: 3 }))).toBe(true);
    expect(isCurationEvent(follows, rumor({ kind: 3, pubkey: OTHER }))).toBe(false);
  });

  it("takes only valid hex p tags as members", () => {
    const event = rumor({ tags: [["p", PK], ["p", "nope"], ["e", OTHER], ["p", OTHER]] });
    expect(curatedPubkeys(event)).toEqual([PK, OTHER]);
    expect(curatedPubkeys(undefined)).toEqual([]);
  });
});
