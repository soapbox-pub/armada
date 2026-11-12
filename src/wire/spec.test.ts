import { describe, expect, it } from "vitest";

import { MAX_WRAP_BACKDATE_SECS } from "@/lib/nip17/protocol";

import { GIT_ROOT_FILTER_CHUNK_SIZE, buildWireSpec, stampRoundSince } from "./spec";

import type { GroupKey } from "@/concord/lib/derive";
import type { Channel } from "@/concord/lib/types";

const PUBKEY = "f".repeat(64);

function concordChannel(idByte: number, pks: string[]): Channel {
  const id = new Uint8Array(32).fill(idByte);
  const idHex = Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    id,
    idHex,
    name: "general",
    isPrivate: false,
    streams: pks.map((pk, i) => ({
      epoch: BigInt(i),
      group: { pk } as unknown as Channel["streams"][number]["group"],
    })),
    current: { epoch: 0n, group: { pk: pks[0] } as unknown as Channel["streams"][number]["group"] },
  } as Channel;
}

describe("buildWireSpec", () => {
  it("builds one #h filter per NIP-29 host relay (relay = community)", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [
        { id: "g1", relay: "wss://a.relay" },
        { id: "g2", relay: "wss://a.relay/" }, // same relay, unnormalized
        { id: "g3", relay: "wss://b.relay" },
      ],
      dmRelays: [],
      dmFollows: [],
      concord: [],
    });

    expect(spec.subs).toHaveLength(2);
    const a = spec.subs.find((s) => s.relay.startsWith("wss://a.relay"));
    const b = spec.subs.find((s) => s.relay.startsWith("wss://b.relay"));
    expect(a?.filters).toEqual([{ kinds: [9, 1068, 5], "#h": ["g1", "g2"] }]);
    expect(b?.filters).toEqual([{ kinds: [9, 1068, 5], "#h": ["g3"] }]);
  });

  it("adds sent + friends-only received DM filters plus the NIP-17 gift-wrap inbox on the DM relays", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: ["wss://dm.relay"],
      dmFollows: ["b".repeat(64), "a".repeat(64)],
      concord: [],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([
      { kinds: [4], authors: [PUBKEY] },
      { kinds: [4], authors: ["a".repeat(64), "b".repeat(64)], "#p": [PUBKEY] },
      { kinds: [1059], "#p": [PUBKEY] },
    ]);
  });

  it("omits DM filters entirely when logged out", () => {
    const spec = buildWireSpec({
      pubkey: undefined,
      groups: [],
      dmRelays: ["wss://dm.relay"],
      dmFollows: ["a".repeat(64)],
      concord: [],
    });
    expect(spec.subs).toHaveLength(0);
  });

  it("subscribes only the CURRENT epoch's stream live, but maps every held epoch's pk → channel", () => {
    const chanA = concordChannel(1, ["pkA1", "pkA2"]);
    const chanB = concordChannel(2, ["pkB1"]);

    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord: [
        { relays: ["wss://c.relay"], channel: chanA, communityIdHex: "commA" },
        { relays: ["wss://c.relay"], channel: chanB, communityIdHex: "commB" },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    // A retired epoch ("pkA2") is read-cutoff history: nothing legitimate ever
    // arrives there live, so it must not stay open as a standing filter.
    expect(spec.subs[0].filters).toEqual([
      { kinds: [1059], authors: ["pkA1", "pkB1"] },
    ]);
    // …but its wraps still decode if one arrives (in-flight straggler / park).
    expect(spec.concordByPk.get("pkA2")).toBe(chanA);
    expect(spec.concordByPk.get("pkB1")).toBe(chanB);
  });

  it("subscribes a restricted Channel's live writer address beside its read address, not a closed one (CORD-03 §1)", () => {
    const chan = concordChannel(1, ["read"]);
    const group = (pk: string) => ({ pk }) as unknown as Channel["streams"][number]["group"];
    chan.streams.push(
      { epoch: 0n, group: group("closed"), writer: { epoch: 1n, from: 0, to: 10 } },
      { epoch: 0n, group: group("live"), writer: { epoch: 2n, from: 10 } },
    );
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord: [{ relays: ["wss://c.relay"], channel: chan, communityIdHex: "comm" }],
    });
    expect(spec.subs[0].filters).toEqual([{ kinds: [1059], authors: ["live", "read"] }]);
    expect(spec.concordByPk.get("closed")).toBe(chan);
  });

  it("subscribes to Concord control authors and maps control pk → community", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord: [],
      concordControl: [
        {
          relays: ["wss://c.relay"],
          idHex: "a".repeat(64),
          groups: [{ pk: "ctlA1" } as unknown as GroupKey, { pk: "ctlA2" } as unknown as GroupKey],
          refounded: false,
        },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([{ kinds: [1059], authors: ["ctlA1", "ctlA2"] }]);
    expect(spec.concordCtlByPk.get("ctlA1")?.idHex).toBe("a".repeat(64));
    expect(spec.concordCtlByPk.get("ctlA2")?.idHex).toBe("a".repeat(64));
  });

  it("subscribes to Concord guestbook authors and maps guestbook pk → community", () => {
    // A Kick lands nowhere else: it publishes no control edition and rolls no
    // epoch, so without this author set the plane is only ever polled.
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord: [],
      concordGuestbook: [
        {
          relays: ["wss://c.relay"],
          idHex: "a".repeat(64),
          groups: [{ pk: "gbA1" } as unknown as GroupKey, { pk: "gbA2" } as unknown as GroupKey],
        },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([{ kinds: [1059], authors: ["gbA1", "gbA2"] }]);
    expect(spec.concordGbByPk.get("gbA1")?.idHex).toBe("a".repeat(64));
    expect(spec.concordGbByPk.get("gbA2")?.idHex).toBe("a".repeat(64));
  });

  it("keeps chat-, control- and guestbook-wrap filters separate on the same relay", () => {
    const chanA = concordChannel(1, ["pkA1"]);
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord: [{ relays: ["wss://c.relay"], channel: chanA, communityIdHex: "commA" }],
      concordControl: [
        {
          relays: ["wss://c.relay"],
          idHex: "a".repeat(64),
          groups: [{ pk: "ctlA1" } as unknown as GroupKey],
          refounded: false,
        },
      ],
      concordGuestbook: [
        {
          relays: ["wss://c.relay"],
          idHex: "a".repeat(64),
          groups: [{ pk: "gbA1" } as unknown as GroupKey],
        },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    // Three author sets, three filters — the planes decode with different keys
    // and wake different readers, so they must not be merged into one.
    expect(spec.subs[0].filters).toEqual([
      { kinds: [1059], authors: ["pkA1"] },
      { kinds: [1059], authors: ["ctlA1"] },
      { kinds: [1059], authors: ["gbA1"] },
    ]);
  });

  it("keeps the sig stable across input reordering (no needless resubscribes)", () => {
    const base = {
      pubkey: PUBKEY,
      dmRelays: [],
      dmFollows: [],
      concord: [],
    };
    const a = buildWireSpec({ ...base, groups: [{ id: "g1", relay: "wss://a" }, { id: "g2", relay: "wss://a" }] });
    const b = buildWireSpec({ ...base, groups: [{ id: "g2", relay: "wss://a" }, { id: "g1", relay: "wss://a" }] });
    expect(a.sig).toBe(b.sig);
  });

  it("groups active attached repositories deterministically while detached history stays mapped but unsubscribed", () => {
    const address = `30617:${"a".repeat(64)}:armada`;
    const attachment = (attachedAt: number, detachedAt?: number) => ({
      address: { kind: 30617 as const, owner: "a".repeat(64), identifier: "armada", coordinate: address }, relayHints: [], attachedAt, detachedAt,
    });
    const spec = buildWireSpec({
      pubkey: PUBKEY, groups: [], dmRelays: [], dmFollows: [], concord: [],
      gitRepositories: [{
        address,
        relays: ["wss://b.relay/", "wss://a.relay"],
        attachments: [
          { channelId: "channel-b", attachment: attachment(20) },
          { channelId: "channel-a", attachment: attachment(10, 15) },
        ],
      }],
    });
    expect(spec.subs.map((sub) => sub.relay)).toEqual(["wss://a.relay", "wss://b.relay"]);
    // Roots and CI runs share the repository's coordinate filter: both address
    // the repository directly, unlike comments and statuses. The CI filter
    // carries the live attachment time so the bootstrap round can reach runs
    // published before this client started.
    expect(spec.subs[0].filters).toEqual([
      { kinds: [1618, 1621], "#a": [address] },
      { kinds: [9841, 9842, 39842], "#a": [address], since: 20 },
    ]);
    // A relay cursor far ahead of the attachment must not win the first round,
    // or a channel never sees the runs it is entitled to show.
    const bootstrapped = stampRoundSince(spec.subs[0].filters, 9_000, 9_100, true);
    expect(bootstrapped[1].since).toBe(20);
    expect(stampRoundSince(spec.subs[0].filters, 9_000, 9_100)[1].since).toBe(9_000);
    expect(spec.gitByRepository.get(address)?.map((entry) => entry.channelId)).toEqual(["channel-a", "channel-b"]);

    const detached = buildWireSpec({
      pubkey: PUBKEY, groups: [], dmRelays: [], dmFollows: [], concord: [],
      gitRepositories: [{ address, relays: ["wss://a.relay"], attachments: [{ channelId: "channel-a", attachment: attachment(10, 15) }] }],
    });
    expect(detached.subs).toEqual([]);
    expect(detached.gitByRepository.get(address)).toHaveLength(1);
  });

  it("adds deterministic chunked uppercase comment and lowercase status root filters", () => {
    const address = `30617:${"a".repeat(64)}:armada`;
    const attachment = { address: { kind: 30617 as const, owner: "a".repeat(64), identifier: "armada", coordinate: address }, relayHints: [], attachedAt: 10 };
    const roots = Array.from({ length: GIT_ROOT_FILTER_CHUNK_SIZE + 1 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"), kind: index % 2 ? 1618 : 1621, pubkey: "b".repeat(64), created_at: index, content: "", tags: [["a", address]], sig: "",
    }));
    const spec = buildWireSpec({ pubkey: PUBKEY, groups: [], dmRelays: [], dmFollows: [], concord: [], gitRepositories: [{ address, relays: ["wss://repo.relay", "wss://index.ngit.dev"], attachments: [{ channelId: "channel", attachment }] }], gitTicketRoots: [...roots].reverse() });
    const filters = spec.subs.find((sub) => sub.relay === "wss://repo.relay")!.filters;
    expect(filters.filter((filter) => filter.kinds?.[0] === 1111).map((filter) => filter["#E"]?.length)).toEqual([GIT_ROOT_FILTER_CHUNK_SIZE, 1]);
    expect(filters.filter((filter) => filter.kinds?.[0] === 1630).map((filter) => filter["#e"]?.length)).toEqual([GIT_ROOT_FILTER_CHUNK_SIZE, 1]);
    expect(filters.find((filter) => filter.kinds?.[0] === 1111)?.["#E"]?.[0]).toBe(roots[0].id);
    expect(spec.subs.find((sub) => sub.relay === "wss://index.ngit.dev")?.filters).toEqual([{ kinds: [1618, 1621], "#a": [address] }]);
  });

  it("changes the subscription signature when a root arrives after wire startup", () => {
    const address = `30617:${"a".repeat(64)}:armada`;
    const attachment = { address: { kind: 30617 as const, owner: "a".repeat(64), identifier: "armada", coordinate: address }, relayHints: [], attachedAt: 10 };
    const input = { pubkey: PUBKEY, groups: [], dmRelays: [], dmFollows: [], concord: [], gitRepositories: [{ address, relays: ["wss://repo.relay"], attachments: [{ channelId: "channel", attachment }] }] };
    const before = buildWireSpec(input);
    const root = { id: "1".repeat(64), kind: 1621, pubkey: "b".repeat(64), created_at: 20, content: "", tags: [["a", address]], sig: "" };
    const after = buildWireSpec({ ...input, gitTicketRoots: [root] });
    expect(after.sig).not.toBe(before.sig);
    expect(after.subs[0].filters).toContainEqual({ kinds: [1111], "#E": [root.id], since: root.created_at, limit: 4_000 });
    expect(after.gitRootById.get(root.id)).toBe(address);
  });
});

describe("stampRoundSince", () => {
  const NOW = 1_800_000_000;
  const SINCE = NOW - 60; // a cursor-derived resume point

  it("stamps the cursor since onto every filter EXCEPT the NIP-17 wrap inbox", () => {
    const dm17 = buildWireSpec({
      pubkey: PUBKEY,
      groups: [{ id: "g1", relay: "wss://dm.relay" }],
      dmRelays: ["wss://dm.relay"],
      dmFollows: ["a".repeat(64)],
      concord: [],
    });
    const stamped = stampRoundSince(dm17.subs[0].filters, SINCE, NOW);

    for (const f of stamped) {
      if (f.kinds?.length === 1 && f.kinds[0] === 1059 && !f.authors) {
        // A gift wrap's created_at is NIP-59-backdated up to 2 days, and relays
        // apply `since` to live events too — a cursor-derived since would filter
        // out virtually every LIVE wrap (the "DMs only arrive on the poll" lag).
        expect(f.since).toBeLessThanOrEqual(NOW - MAX_WRAP_BACKDATE_SECS);
        // The rewind replays stored wraps each round; the limit bounds it.
        expect(f.limit).toBeGreaterThan(0);
      } else {
        expect(f.since).toBe(SINCE);
        expect(f.limit).toBeUndefined();
      }
    }
    // Sanity: the set really contained both shapes.
    expect(stamped.some((f) => f.kinds?.[0] === 1059)).toBe(true);
    expect(stamped.some((f) => f.kinds?.[0] === 9)).toBe(true);
  });

  it("keeps the cursor since on a Concord wrap filter (authors-scoped, real timestamps)", () => {
    const stamped = stampRoundSince([{ kinds: [1059], authors: ["pkA1"] }], SINCE, NOW);
    expect(stamped[0].since).toBe(SINCE);
    expect(stamped[0].limit).toBeUndefined();
  });

  it("uses a Git child filter's root timestamp only for its bootstrap round", () => {
    const child = { kinds: [1111], "#E": ["1".repeat(64)], since: 100, limit: 4_000 };
    expect(stampRoundSince([child], 500, NOW, true)[0].since).toBe(100);
    expect(stampRoundSince([child], 500, NOW)[0].since).toBe(500);
  });

  it("takes the deeper of cursor since and the backdate rewind for the wrap filter", () => {
    const deepCursor = NOW - 6 * 24 * 60 * 60; // device off for days
    const stamped = stampRoundSince([{ kinds: [1059], "#p": [PUBKEY] }], deepCursor, NOW);
    expect(stamped[0].since).toBe(deepCursor);
  });
});
