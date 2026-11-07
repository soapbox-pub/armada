import { describe, expect, it } from "vitest";
import { Permissions } from "@/concord/lib/roles";

import { mintCommunity } from "@/concord/lib/community";
import { buildConcordSubs } from "@/concord/lib/concordNotifications";
import type { FoldedChannel, FoldedControl } from "@/concord/lib/control";
import { bytesToHex, channelGroupKey, random32 } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";

const OWNER = bytesToHex(random32());

function foldedWith(channels: FoldedChannel[], name?: string): FoldedControl {
  return {
    roster: { roles: [], grants: [] },
    ownerHex: OWNER,
    metadata: name ? { name, relays: [] } : undefined,
    channels: new Map(channels.map((c) => [c.channelIdHex, {
      ...c,
      metadata: c.metadata ?? { name: c.name, private: c.isPrivate, ...(c.deleted ? { deleted: true } : {}) },
    }])),
    banned: new Set(),
    liveInviteLinks: new Set(),
    registriesByCreator: new Map(),
    heads: new Map(),
    headEditions: new Map(),
  } as unknown as FoldedControl;
}

function mint(): { community: Community; generalId: Uint8Array } {
  const { community, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://relay.example"]);
  return { community, generalId: generalChannelId };
}

describe("buildConcordSubs", () => {
  it("builds one sub per readable channel with per-epoch streams + conv keys", () => {
    const { community, generalId } = mint();
    const folded = foldedWith(
      [{ channelIdHex: bytesToHex(generalId), name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } }],
      "Fleet Renamed",
    );

    const { subs, streamKeys } = buildConcordSubs(community, folded);
    expect(subs).toHaveLength(1);
    const sub = subs[0];
    expect(sub.communityId).toBe(community.idHex);
    expect(sub.communityName).toBe("Fleet Renamed"); // fold metadata wins over join preview
    expect(sub.channelId).toBe(bytesToHex(generalId));
    expect(sub.channelName).toBe("general");
    expect(sub.relays).toEqual(["wss://relay.example"]);
    expect(sub.mentionEveryoneAuthors).toEqual([OWNER]);
    expect(sub.mentionEveryoneAnyone).toBeUndefined();
    const open = { ...folded, roster: { ...folded.roster, everyone: Permissions.MENTION_EVERYONE } };
    expect(buildConcordSubs(community, open).subs[0].mentionEveryoneAnyone).toBe(true);

    // The stream matches the on-wire derivation exactly.
    const expected = channelGroupKey(community.root, generalId, 0n);
    expect(sub.streams).toEqual([
      { pk: expected.pk, convKey: bytesToHex(expected.convKey), epoch: "0" },
    ]);
    // No secret key leaves the builder in the sub; the GroupKeys are returned
    // separately for WebView-side NIP-42 registration.
    expect(JSON.stringify(subs)).not.toContain(bytesToHex(expected.sk));
    expect(streamKeys.map((k) => k.pk)).toEqual([expected.pk]);
  });

  it("includes held private channels even before the fold names them", () => {
    const { community } = mint();
    const id = random32();
    const key = random32();
    community.privateChannels.push({ id, key, epoch: 3n, name: "secret" });

    const { subs } = buildConcordSubs(community, undefined);
    expect(subs).toHaveLength(1);
    expect(subs[0].channelName).toBe("secret");
    const expected = channelGroupKey(key, id, 3n);
    expect(subs[0].streams).toEqual([
      { pk: expected.pk, convKey: bytesToHex(expected.convKey), epoch: "3" },
    ]);
  });

  it("listens only on the current epoch, while every held epoch registers for stream auth", () => {
    const { community, generalId } = mint();
    // The community rotated 0 → 1: the retired root is held for history…
    const newRoot = random32();
    community.heldRoots = [{ epoch: 1n, key: newRoot }, { ...community.heldRoots[0], retiredAt: 5 }];
    community.root = newRoot;
    community.rootEpoch = 1n;
    const folded = foldedWith([
      { channelIdHex: bytesToHex(generalId), name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);

    const { subs, streamKeys } = buildConcordSubs(community, folded);
    const current = channelGroupKey(newRoot, generalId, 1n);
    // …but the native service must not hold the retired address open live: a
    // retired epoch is read-cutoff history and nothing on it may notify.
    expect(subs[0].streams).toEqual([
      { pk: current.pk, convKey: bytesToHex(current.convKey), epoch: "1" },
    ]);
    // Backfill still reads the retired epoch from auth-gating relays, so both
    // epochs' keys register for NIP-42.
    expect(streamKeys.map((k) => k.pk).sort()).toEqual(
      [current.pk, channelGroupKey(community.heldRoots[1].key, generalId, 0n).pk].sort(),
    );
  });

  it("carries the community's banned set on every channel's sub, sorted", () => {
    const { community, generalId } = mint();
    const banA = "b".repeat(64);
    const banB = "a".repeat(64);
    const folded = foldedWith([
      { channelIdHex: bytesToHex(generalId), name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);
    folded.banned = new Set([banA, banB]);

    const { subs } = buildConcordSubs(community, folded);
    // Sorted so the config signature is stable across refetches.
    expect(subs[0].banned).toEqual([banB, banA]);
  });

  it("gives an unfolded community an empty banned set rather than undefined", () => {
    const { community } = mint();
    community.privateChannels.push({ id: random32(), key: random32(), epoch: 0n, name: "secret" });
    const { subs } = buildConcordSubs(community, undefined);
    expect(subs[0].banned).toEqual([]);
  });

  it("skips deleted channels and communities without relays", () => {
    const { community, generalId } = mint();
    const folded = foldedWith([
      { channelIdHex: bytesToHex(generalId), name: "general", isPrivate: false, deleted: true, metadata: { name: "general", private: false, deleted: true } },
    ]);
    expect(buildConcordSubs(community, folded).subs).toHaveLength(0);

    const relayless = { ...community, relays: [] };
    expect(buildConcordSubs(relayless, undefined).subs).toHaveLength(0);
  });

  it("orders subs by community then channel id, not display name", () => {
    const { community } = mint();
    const a = { id: new Uint8Array(32).fill(1), key: random32(), epoch: 0n, name: "zzz" };
    const b = { id: new Uint8Array(32).fill(2), key: random32(), epoch: 0n, name: "aaa" };
    community.privateChannels.push(a, b);
    const { subs } = buildConcordSubs(community, undefined);
    expect(subs.map((s) => s.channelName)).toEqual(["zzz", "aaa"]);
  });
});
