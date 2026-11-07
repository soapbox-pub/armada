/**
 * Behavioral parity with Vector v0.5.0-3 (`rekey.rs`, `chat.rs`, `list.rs`,
 * `invite.rs`, `rebuild_snapshot`) and CORD-02/05/06/07 at concord#25 for rekey
 * chunks, call presence, the Community List and the Invite List. `it.fails` marks
 * what Armada still gets wrong.
 */
import { describe, expect, it } from "vitest";

import { reviseSnapshots, type CommunityList, type JoinMaterial } from "@/concord/lib/communityList";
import { buildInviteUrl, liveRegistrySigners, mintLinkSigner, mintToken, pruneExpiredInvites, type InviteList } from "@/concord/lib/invite";
import { KIND_REKEY, KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import { findBlob, groupRotations, parseRekey, rotationPublishedAtMs } from "@/concord/lib/rekey";
import type { OpenedEvent } from "@/concord/lib/stream";
import { parsePresence } from "@/concord/lib/voice";
import { clockOffsetMs, resetClockOffset, syncClockWithRelays } from "@/lib/relayClock";
import { hexKey } from "@/test/concordEditions";

const opened = (kind: number, tags: string[][], content: string): OpenedEvent =>
  ({ kind, tags, content, author: hexKey(), rumorId: hexKey(), createdAt: 1, ms: 1000 }) as OpenedEvent;

describe("rekey chunks (CORD-06 §1, §3; Vector `parse_rekey_chunk`)", () => {
  const rootScope = "0".repeat(64);
  const base = (extra: string[][] = []) => [["scope", rootScope], ["newepoch", "2"], ["prevepoch", "1"], ["prevcommit", hexKey()], ["chunk", "1", "1"], ...extra];
  const parse = (tags: string[][], content = "[]") => {
    try {
      return parseRekey(opened(KIND_REKEY, tags, content));
    } catch {
      return undefined;
    }
  };

  it("reads a Severing Refounding's `sever` mark (CORD-06 §3: an adopter MUST NOT refresh condemned links)", () => {
    const r = parse(base([["sever", "1"]])) as (ReturnType<typeof parseRekey> & { severed?: boolean }) | undefined;
    expect(r?.severed).toBe(true);
  });

  it("refuses a chunk whose `sever` isn't \"1\", or that carries it twice", () => {
    expect(parse(base([["sever", "yes"]]))).toBeUndefined();
    expect(parse(base([["sever", "1"], ["sever", "1"]]))).toBeUndefined();
  });

  it("refuses a chunk with more than 120 blobs (Vector `MAX_REKEY_BLOBS_RECEIVED`)", () => {
    const blobs = Array.from({ length: 121 }, () => ({ locator: hexKey(), wrapped: "x" }));
    expect(parse(base(), JSON.stringify(blobs))).toBeUndefined();
  });

  it("refuses a repeated machinery tag (Vector `unique_tag`)", () => {
    expect(parse([...base(), ["newepoch", "3"]])).toBeUndefined();
    expect(parse([...base(), ["scope", hexKey()]])).toBeUndefined();
  });

  it("refuses a chunk whose newepoch doesn't exceed its prevepoch (Vector `NonMonotonicEpoch`)", () => {
    expect(parse([["scope", rootScope], ["newepoch", "1"], ["prevepoch", "1"], ["prevcommit", hexKey()], ["chunk", "1", "1"]])).toBeUndefined();
  });

  it("refuses content that isn't an array of blobs (serde `Vec<RekeyBlob>`)", () => {
    expect(parse(base(), "{}")).toBeUndefined();
    expect(parse(base(), JSON.stringify([{ locator: 5, wrapped: "x" }]))).toBeUndefined();
  });
});

describe("rekey rotations (CORD-06 §1; Vector `collect_rotations`)", () => {
  const prevCommit = hexKey();
  const chunk = (i: number, n: number, locators: string[], ms: number) =>
    parseRekey({
      ...opened(KIND_REKEY, [["scope", "0".repeat(64)], ["newepoch", "2"], ["prevepoch", "1"], ["prevcommit", prevCommit], ["chunk", String(i), String(n)]], JSON.stringify(locators.map((locator) => ({ locator, wrapped: "x" })))),
      author: "ab".repeat(32),
      ms,
    });

  it("completes an extended rotation once every index up to the largest declared total is held, unioning its blobs", () => {
    const a = hexKey();
    const b = hexKey();
    const c = hexKey();
    const sets = groupRotations([chunk(1, 1, [a], 2000), chunk(2, 2, [b], 1000), chunk(1, 2, [c], 3000)]);
    expect(sets).toHaveLength(1);
    expect(sets[0].complete).toBe(true);
    for (const l of [a, b, c]) expect(findBlob(sets[0], l)).toBeDefined();
    expect(rotationPublishedAtMs(sets[0])).toBe(1000);
  });

  it("holds an extension short of a declared index incomplete", () => {
    expect(groupRotations([chunk(1, 1, [hexKey()], 1000), chunk(3, 3, [hexKey()], 1000)])[0].complete).toBe(false);
  });
});

describe("call presence on another transport (CORD-07 §4)", () => {
  const joined = (tags: string[][]) => parsePresence(opened(KIND_VOICE_PRESENCE, tags, "joined"));

  it("keeps presence naming a transport longer than 32 characters ('MUST NOT drop presence for a transport it doesn't speak')", () => {
    expect(joined([["transport", "x".repeat(33)]])).not.toBeNull();
  });

  it("refuses presence that names its transport twice (Vector `unique_tag`)", () => {
    expect(joined([["transport", "webrtc"], ["transport", "iroh"]])).toBeNull();
  });
});

describe("the Community List (CORD-02 §8; Vector `rebuild_snapshot`)", () => {
  const id = "11".repeat(32);
  const snapshot = (channels: JoinMaterial["channels"], extra: Partial<JoinMaterial> = {}): JoinMaterial => ({
    community_id: id,
    owner: "22".repeat(32),
    owner_salt: "33".repeat(32),
    community_root: "44".repeat(32),
    root_epoch: 3,
    channels,
    relays: ["wss://relay.test"],
    name: "c",
    ...extra,
  });
  const listOf = (current: JoinMaterial): CommunityList => ({ entries: [{ community_id: id, seed: current, current, added_at: 1 }], tombstones: [] });
  const ch = (b: string, epoch = 1) => ({ id: b.repeat(32), key: "55".repeat(32), epoch, name: "" });

  it("writes `channels` in raw-id order however this device holds them", () => {
    const read = listOf(snapshot([ch("aa")], { rev: 2 }));
    const next = listOf(snapshot([ch("cc"), ch("aa"), ch("bb")]));
    const written = reviseSnapshots(read, next).entries[0].current.channels.map((c) => c.id.slice(0, 2));
    expect(written).toEqual(["aa", "bb", "cc"]);
  });

  it("carries forward a Channel key the read copy holds at the same epoch (CORD-02 §8 MUST)", () => {
    const read = listOf(snapshot([ch("aa"), ch("bb")], { rev: 2 }));
    // This device hasn't received bb's key yet.
    const next = listOf(snapshot([ch("aa"), ch("cc")]));
    const written = reviseSnapshots(read, next).entries[0].current;
    expect(written.channels.map((c) => c.id.slice(0, 2))).toEqual(["aa", "bb", "cc"]);
    expect(written.rev).toBe(3);
  });

  it("carries forward the read copy's control_root and unknown fields at the same epoch", () => {
    const read = listOf(snapshot([ch("aa")], { rev: 2, control_pk: "66".repeat(32), control_root: "77".repeat(32), peer_field: 1 }));
    const next = listOf(snapshot([ch("aa")], { control_pk: "66".repeat(32), name: "renamed" }));
    const written = reviseSnapshots(read, next).entries[0].current;
    expect(written.control_root).toBe("77".repeat(32));
    expect(written.peer_field).toBe(1);
  });
});

describe("the Invite List (CORD-05 §4; Vector `list_expiry_ms`)", () => {
  it("prunes an entry whose expires_at an older Vector wrote in milliseconds", () => {
    const nowSec = 1_800_000_000;
    const list: InviteList = {
      entries: [{ token: hexKey(), signer_sk: hexKey(), community_id: hexKey(), url: "", created_at: 1, expires_at: (nowSec - 60) * 1000 }],
      tombstones: [],
    };
    expect(pruneExpiredInvites(list, nowSec).entries).toHaveLength(0);
  });

  it("keeps an expired link's signer out of the registry after the Invite List has pruned its entry (CORD-05 §5)", () => {
    const nowSec = 1_800_000_000;
    const communityId = hexKey();
    const signer = mintLinkSigner();
    const url = buildInviteUrl("https://armada.buzz", signer.pk, mintToken(), ["wss://relay.test"]);
    const list: InviteList = {
      entries: [{ token: hexKey(), signer_sk: hexKey(), community_id: communityId, url, created_at: 1, expires_at: nowSec - 60 }],
      tombstones: [],
    };
    // Before pruning, publishRegistry drops the expired signer…
    expect(liveRegistrySigners([signer.pk], list.entries, communityId, nowSec)).toEqual([]);
    // …and once the list prunes the entry, nothing left says it expired.
    expect(liveRegistrySigners([signer.pk], pruneExpiredInvites(list, nowSec).entries, communityId, nowSec)).toEqual([]);
  });
});

describe("keeping the clock by the relays (CORD-03 §3; Vector `clock.rs`)", () => {
  it("reads an `Age` that isn't all digits as none (Vector `trim().parse::<u64>()`)", async () => {
    const date = new Date(Date.now()).toUTCString();
    try {
      await syncClockWithRelays(["wss://a.test", "wss://b.test", "wss://c.test"], async () => ({ date, age: "7200abc" }));
      expect(Math.abs(clockOffsetMs())).toBeLessThan(5_000);
    } finally {
      resetClockOffset();
    }
  });
});
