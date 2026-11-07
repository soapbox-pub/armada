import { describe, expect, it } from "vitest";

import {
  addToList,
  canonicalJson,
  channelKeysToWire,
  EMPTY_COMMUNITY_LIST,
  isLive,
  liveEntries,
  mergeCommunityLists,
  nextChannelEpoch,
  refreshChannels,
  refreshCurrent,
  refreshRelays,
  rehydrateCommunity,
  removeFromList,
  removedCommunityIds,
  replayedAddStanding,
  reviseSnapshots,
  unionChannelKeys,
  toJoinMaterial,
  type CommunityListEntry,
  type JoinMaterial,
} from "@/concord/lib/communityList";
import { bytesToHex, communityIdOf, random32 } from "@/concord/lib/derive";

function makeJoinMaterial(overrides: Partial<JoinMaterial> = {}): JoinMaterial {
  const ownerSk = random32();
  const owner = bytesToHex(random32()); // placeholder; overridden below when consistency matters
  void ownerSk;
  return {
    community_id: bytesToHex(random32()),
    owner,
    owner_salt: bytesToHex(random32()),
    community_root: bytesToHex(random32()),
    root_epoch: 0,
    channels: [],
    relays: ["wss://a.example"],
    name: "Test",
    ...overrides,
  };
}

function entryOf(jm: JoinMaterial, addedAt = 1000): CommunityListEntry {
  return { community_id: jm.community_id, seed: jm, current: jm, added_at: addedAt };
}

describe("community list merge (CORD-02 §8)", () => {
  it("is commutative and idempotent", () => {
    const jm1 = makeJoinMaterial();
    const jm2 = makeJoinMaterial();
    const a = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm1));
    const b = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm2));
    const ab = canonicalJson(mergeCommunityLists(a, b));
    const ba = canonicalJson(mergeCommunityLists(b, a));
    expect(ab).toBe(ba);
    expect(canonicalJson(mergeCommunityLists(mergeCommunityLists(a, b), b))).toBe(ab);
  });

  it("current keeps the higher epoch, seed the lower", () => {
    const jm0 = makeJoinMaterial({ root_epoch: 0 });
    const jm2: JoinMaterial = { ...jm0, root_epoch: 2, community_root: bytesToHex(random32()) };
    const merged = mergeCommunityLists(
      { entries: [entryOf(jm0)], tombstones: [] },
      { entries: [entryOf(jm2)], tombstones: [] },
    );
    expect(merged.entries[0].current.root_epoch).toBe(2);
    expect(merged.entries[0].seed.root_epoch).toBe(0);
  });

  it("equal-epoch ties break on canonical bytes (a total order)", () => {
    const jmA = makeJoinMaterial({ name: "AAA" });
    const jmB: JoinMaterial = { ...jmA, name: "ZZZ" };
    const m1 = mergeCommunityLists(
      { entries: [entryOf(jmA)], tombstones: [] },
      { entries: [entryOf(jmB)], tombstones: [] },
    );
    const m2 = mergeCommunityLists(
      { entries: [entryOf(jmB)], tombstones: [] },
      { entries: [entryOf(jmA)], tombstones: [] },
    );
    expect(canonicalJson(m1)).toBe(canonicalJson(m2));
  });

  it("tombstones are permanent; liveness is derived, entries never deleted", () => {
    const jm = makeJoinMaterial();
    let list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 1000));
    list = removeFromList(list, jm.community_id, 2000);
    expect(list.entries.length).toBe(1); // the entry STAYS in the document
    expect(list.tombstones.length).toBe(1);
    expect(isLive(list, jm.community_id)).toBe(false);
    expect(liveEntries(list).length).toBe(0);
    expect(removedCommunityIds(list)).toEqual([jm.community_id]);

    // A re-join (newer add) resurrects; the tombstone stays.
    list = addToList(list, entryOf(jm, 3000));
    expect(isLive(list, jm.community_id)).toBe(true);
    expect(list.tombstones.length).toBe(1);
    expect(removedCommunityIds(list)).toEqual([]);

    // A backfill merging the OLD pre-leave state can't bury the re-join.
    const stale = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 1000));
    const merged = mergeCommunityLists(list, stale);
    expect(isLive(merged, jm.community_id)).toBe(true);
  });

  it("round-trips unknown fields (the round-trip discipline)", () => {
    const jm = makeJoinMaterial({ vector_custom: { theme: "dark" } } as Partial<JoinMaterial>);
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm));
    const merged = mergeCommunityLists(list, EMPTY_COMMUNITY_LIST);
    expect((merged.entries[0].current as Record<string, unknown>).vector_custom).toEqual({ theme: "dark" });
  });

  it("entry-level invite_ref survives merges and current refreshes (stranded self-heal anchor)", () => {
    const jm = makeJoinMaterial({ root_epoch: 1 });
    const ref = "naddr1example#BAACAwSramExdyfria50iKwvzRpK";
    const withRef: CommunityListEntry = { ...entryOf(jm, 1000), invite_ref: ref };

    // A device copy that predates the field must not strip it on merge.
    const merged = mergeCommunityLists(
      addToList(EMPTY_COMMUNITY_LIST, withRef),
      addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 900)),
    );
    expect(merged.entries[0].invite_ref).toBe(ref);

    // Adopting a fresh epoch (refresh-current) keeps the ref: the link is a
    // durable recovery anchor, not epoch-scoped state.
    const jm2: JoinMaterial = { ...jm, root_epoch: 2, community_root: bytesToHex(random32()) };
    const refreshed = refreshCurrent(merged, jm2);
    expect(refreshed.entries[0].invite_ref).toBe(ref);
    expect(refreshed.entries[0].current.root_epoch).toBe(2);
  });
});

describe("channel-key union on merge (role-gate vends, CORD.md)", () => {
  const chan = (id: string, epoch: number, key = "1".repeat(64)) => ({ id, key, epoch, name: "c" });

  it("a partial vend unions into the held set instead of replacing it", () => {
    const base = makeJoinMaterial({ channels: [chan("aa", 0), chan("bb", 1)] });
    // Same community, same root epoch: a direct vend carrying ONE new channel.
    const vend: JoinMaterial = { ...base, channels: [chan("cc", 0, "2".repeat(64))] };
    const merged = mergeCommunityLists(
      { entries: [entryOf(base)], tombstones: [] },
      { entries: [entryOf(vend)], tombstones: [] },
    );
    expect(merged.entries[0].current.channels.map((c) => c.id).sort()).toEqual(["aa", "bb", "cc"]);
  });

  it("the higher channel epoch wins, and the superseded key is kept as a prior", () => {
    const old = makeJoinMaterial({ channels: [chan("aa", 1, "1".repeat(64))] });
    const fresh: JoinMaterial = { ...old, channels: [chan("aa", 2, "2".repeat(64))] };
    for (const [x, y] of [[old, fresh], [fresh, old]] as const) {
      const merged = mergeCommunityLists(
        { entries: [entryOf(x)], tombstones: [] },
        { entries: [entryOf(y)], tombstones: [] },
      );
      const [ch] = merged.entries[0].current.channels;
      expect(ch.epoch).toBe(2);
      expect(ch.key).toBe("2".repeat(64));
      // The rotated-off key survives — it reads everything written before it.
      expect(ch.priors).toEqual([{ key: "1".repeat(64), epoch: 1 }]);
    }
  });

  it("keeps BOTH keys when two rotations raced to the same channel epoch", () => {
    // CORD-06's same-epoch convergence: among authorized candidates at one
    // continuity point every client picks the same winner, and "both forks'
    // keys are retained, so messages sent into the losing fork stay readable".
    // The epochs are equal here, so the epoch-max branch never runs — dropping
    // the loser silently takes every message written into its branch dark.
    const forkA = makeJoinMaterial({ channels: [chan("aa", 3, "a".repeat(64))] });
    const forkB: JoinMaterial = { ...forkA, channels: [chan("aa", 3, "b".repeat(64))] };
    for (const [x, y] of [[forkA, forkB], [forkB, forkA]] as const) {
      const merged = mergeCommunityLists(
        { entries: [entryOf(x)], tombstones: [] },
        { entries: [entryOf(y)], tombstones: [] },
      );
      const [ch] = merged.entries[0].current.channels;
      // Deterministic winner (canonical bytes), same on both orderings…
      expect(ch.epoch).toBe(3);
      expect(ch.key).toBe("a".repeat(64));
      // …and the loser is retained rather than discarded.
      expect(ch.priors).toEqual([{ key: "b".repeat(64), epoch: 3 }]);
    }
  });

  it("merges an entry that carries no `channels` at all", () => {
    // The list is a cross-client document (CORD-02 §8) and Private Channels are
    // optional (CORD-03), so a client that vends no keys omits the field. The
    // merge is the read-modify-write step of EVERY list write, so a throw here
    // fails create, join and leave alike.
    const mine = makeJoinMaterial({ channels: [chan("aa", 0)] });
    const foreign = { ...mine } as JoinMaterial;
    delete (foreign as Partial<JoinMaterial>).channels;
    for (const [x, y] of [[mine, foreign], [foreign, mine]] as const) {
      const merged = mergeCommunityLists(
        { entries: [entryOf(x)], tombstones: [] },
        { entries: [entryOf(y)], tombstones: [] },
      );
      expect(merged.entries[0].current.channels.map((c) => c.id)).toEqual(["aa"]);
    }
    // Both sides bare: the union is empty, not a throw.
    const bare = mergeCommunityLists(
      { entries: [entryOf(foreign)], tombstones: [] },
      { entries: [entryOf({ ...foreign, name: "renamed" })], tombstones: [] },
    );
    expect(bare.entries[0].current.channels).toEqual([]);
  });
});

describe("channel cuts (a revoke is monotonic)", () => {
  const chan = (id: string, epoch: number, key = "1".repeat(64)) => ({ id, key, epoch, name: "c" });

  it("a stale bundle cannot restore a channel I was rotated out of", () => {
    // The field case: the channel was ungated and its key vended to everyone,
    // so an old invite still sits in the inbox. Re-gating rotated me out at
    // channel epoch 1. Merging that old bundle must NOT hand the key back.
    const before = makeJoinMaterial({ channels: [chan("aa", 0)] });
    const cutEntry: CommunityListEntry = {
      ...entryOf({ ...before, channels: [] }),
      channel_cuts: [{ id: "aa", epoch: 1 }],
    };
    const staleInvite = entryOf(before); // still carries the epoch-0 key

    for (const [x, y] of [[cutEntry, staleInvite], [staleInvite, cutEntry]] as const) {
      const merged = mergeCommunityLists(
        { entries: [x], tombstones: [] },
        { entries: [y], tombstones: [] },
      );
      expect(merged.entries[0].current.channels).toEqual([]);
      expect(merged.entries[0].channel_cuts).toEqual([{ id: "aa", epoch: 1 }]);
    }
  });

  it("a genuine re-admission (a key AT/ABOVE the cut epoch) is accepted", () => {
    const cutEntry: CommunityListEntry = {
      ...entryOf(makeJoinMaterial({ channels: [] })),
      channel_cuts: [{ id: "aa", epoch: 1 }],
    };
    const readmit = entryOf({ ...cutEntry.current, channels: [chan("aa", 1, "2".repeat(64))] });
    const merged = mergeCommunityLists(
      { entries: [cutEntry], tombstones: [] },
      { entries: [readmit], tombstones: [] },
    );
    expect(merged.entries[0].current.channels).toEqual([chan("aa", 1, "2".repeat(64))]);
  });

  it("refreshChannels records the cut and floors the update", () => {
    const jm = makeJoinMaterial({ channels: [chan("aa", 0), chan("bb", 0)] });
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm));
    // The watcher drops "aa" at epoch 1 and keeps "bb".
    const next = refreshChannels(list, jm.community_id, [chan("bb", 0)], [{ id: "aa", epoch: 1 }]);
    expect(next.entries[0].current.channels).toEqual([chan("bb", 0)]);
    expect(next.entries[0].channel_cuts).toEqual([{ id: "aa", epoch: 1 }]);
    // A later refresh that re-supplies the stale key is floored out.
    const relapse = refreshChannels(next, jm.community_id, [chan("aa", 0), chan("bb", 0)]);
    expect(relapse.entries[0].current.channels).toEqual([chan("bb", 0)]);
  });
});

describe("refreshChannels (channel-scope rekey adoption/exclusion, CORD-06 §2)", () => {
  const chan = (id: string, epoch: number) => ({ id, key: bytesToHex(random32()), epoch, name: "sec" });

  it("replaces current's channel set WITHOUT bumping added_at (a channel rotation is not re-inclusion proof)", () => {
    const a = chan("11".repeat(32), 0);
    const jm = makeJoinMaterial({ channels: [a] });
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 1234));

    const rotated = { ...a, key: bytesToHex(random32()), epoch: 1 };
    const next = refreshChannels(list, jm.community_id, [rotated]);

    expect(next.entries[0].current.channels).toEqual([rotated]);
    expect(next.entries[0].added_at).toBe(1234); // untouched — feeds the exclusion-vs-history decision
    expect(next.entries[0].seed.channels).toEqual([a]); // seed keeps the original key for history
  });

  it("an excluded channel is dropped from current (visible removal) while seed retains it", () => {
    const a = chan("11".repeat(32), 0);
    const b = chan("22".repeat(32), 0);
    const jm = makeJoinMaterial({ channels: [a, b] });
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm));

    const next = refreshChannels(list, jm.community_id, [a]); // b removed
    expect(next.entries[0].current.channels).toEqual([a]);
    expect(next.entries[0].seed.channels).toEqual([a, b]);
  });

  it("an unknown community is a no-op", () => {
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(makeJoinMaterial()));
    expect(refreshChannels(list, "ff".repeat(32), [])).toEqual(list);
  });
});

describe("refreshRelays (follow the fold's relay list, CORD-02 §6)", () => {
  it("replaces current's relays WITHOUT bumping added_at (a relay move is not re-inclusion proof)", () => {
    const jm = makeJoinMaterial({ relays: ["wss://old.example"] });
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 1234));

    const next = refreshRelays(list, jm.community_id, ["wss://new.example", "wss://old.example"]);

    expect(next.entries[0].current.relays).toEqual(["wss://new.example", "wss://old.example"]);
    expect(next.entries[0].added_at).toBe(1234);
    expect(next.entries[0].seed.relays).toEqual(["wss://old.example"]); // seed only ever moves backward
  });

  it("preserves the rest of the join material (keys, epoch, unknown fields)", () => {
    const jm = makeJoinMaterial({ vendor_ext: "keep-me" } as Partial<JoinMaterial>);
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm));

    const next = refreshRelays(list, jm.community_id, ["wss://new.example"]);
    expect(next.entries[0].current.community_root).toBe(jm.community_root);
    expect(next.entries[0].current.root_epoch).toBe(jm.root_epoch);
    expect(next.entries[0].current.vendor_ext).toBe("keep-me");
  });

  it("an unknown community is a no-op", () => {
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(makeJoinMaterial()));
    expect(refreshRelays(list, "ff".repeat(32), ["wss://x.example"])).toEqual(list);
  });
});

describe("rehydration", () => {
  it("verifies the owner commitment and rebuilds the runtime community", () => {
    const ownerPk = bytesToHex(random32());
    const salt = random32();
    const cid = communityIdOf(
      Uint8Array.from(ownerPk.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      salt,
    );
    const jm = makeJoinMaterial({
      community_id: bytesToHex(cid),
      owner: ownerPk,
      owner_salt: bytesToHex(salt),
      root_epoch: 3,
      held_roots: [{ epoch: 1, key: bytesToHex(random32()) }],
      channels: [{ id: bytesToHex(random32()), key: bytesToHex(random32()), epoch: 1, name: "secret" }],
    });
    const community = rehydrateCommunity(entryOf(jm), ["wss://app.example"]);
    expect(community).toBeDefined();
    expect(community!.rootEpoch).toBe(3n);
    expect(community!.heldRoots.map((r) => Number(r.epoch))).toEqual([3, 1]);
    expect(community!.privateChannels.length).toBe(1);
    expect(community!.relays).toContain("wss://app.example");

    // A corrupted owner fails closed.
    const corrupt = { ...jm, owner: bytesToHex(random32()) };
    expect(rehydrateCommunity(entryOf(corrupt))).toBeUndefined();
  });

  it("round-trips epoch retirement cutoffs on held roots and channel priors", () => {
    const ownerPk = bytesToHex(random32());
    const salt = random32();
    const cid = communityIdOf(
      Uint8Array.from(ownerPk.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      salt,
    );
    const jm = makeJoinMaterial({
      community_id: bytesToHex(cid),
      owner: ownerPk,
      owner_salt: bytesToHex(salt),
      root_epoch: 2,
      held_roots: [
        { epoch: 1, key: bytesToHex(random32()), retired_at: 1_700_000_000 },
        { epoch: 0, key: bytesToHex(random32()) }, // pre-cutoff data: stays uncapped
      ],
      channels: [
        {
          id: bytesToHex(random32()),
          key: bytesToHex(random32()),
          epoch: 2,
          name: "secret",
          priors: [{ key: bytesToHex(random32()), epoch: 1, retired_at: 1_700_000_100 }],
        },
      ],
    });
    const community = rehydrateCommunity(entryOf(jm))!;
    expect(community.heldRoots.find((r) => r.epoch === 1n)?.retiredAt).toBe(1_700_000_000);
    expect(community.heldRoots.find((r) => r.epoch === 0n)?.retiredAt).toBeUndefined();
    expect(community.privateChannels[0].priors?.[0].retiredAt).toBe(1_700_000_100);

    const back = toJoinMaterial(community, { prior: jm, relays: jm.relays });
    expect(back.held_roots?.find((r) => r.epoch === 1)?.retired_at).toBe(1_700_000_000);
    expect(back.held_roots?.find((r) => r.epoch === 0)?.retired_at).toBeUndefined();
    expect(back.channels[0].priors?.[0].retired_at).toBe(1_700_000_100);
  });

  it("snapshots back to join material, preserving unknown fields", () => {
    const ownerPk = bytesToHex(random32());
    const salt = random32();
    const cid = communityIdOf(
      Uint8Array.from(ownerPk.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      salt,
    );
    const jm = makeJoinMaterial({
      community_id: bytesToHex(cid),
      owner: ownerPk,
      owner_salt: bytesToHex(salt),
      root_epoch: 1,
      vendor_field: 42,
    } as Partial<JoinMaterial>);
    const community = rehydrateCommunity(entryOf(jm))!;
    const back = toJoinMaterial(community, { prior: jm, relays: jm.relays });
    expect(back.community_id).toBe(jm.community_id);
    expect(back.root_epoch).toBe(1);
    expect((back as Record<string, unknown>).vendor_field).toBe(42);
  });
});

describe("nextChannelEpoch (CORD-03 §2: monotonic, never resetting)", () => {
  const id = random32();
  const idHex = bytesToHex(id);

  it("a channel that was never private privatises at epoch 1, not 0", () => {
    // CORD-03 §2 names it outright: "the first privatisation is epoch 1".
    expect(nextChannelEpoch([], idHex)).toBe(1n);
  });

  it("a re-privatisation climbs past every generation this client has seen", () => {
    // privatise → publish → privatise. Restarting at 0 would put two different
    // keys at one epoch, and neither the merge (epoch-max) nor a channel_cuts
    // floor (epoch-min) could tell the generations apart.
    const held = [{ id, key: random32(), epoch: 2n, name: "c", priors: [{ key: random32(), epoch: 1n }] }];
    expect(nextChannelEpoch(held, idHex)).toBe(3n);
  });

  it("a prior above the current key still raises the floor", () => {
    const held = [{ id, key: random32(), epoch: 1n, name: "c", priors: [{ key: random32(), epoch: 4n }] }];
    expect(nextChannelEpoch(held, idHex)).toBe(5n);
  });

  it("is case-insensitive on the channel id and ignores other channels", () => {
    const held = [{ id, key: random32(), epoch: 7n, name: "c" }];
    expect(nextChannelEpoch(held, idHex.toUpperCase())).toBe(8n);
    expect(nextChannelEpoch(held, bytesToHex(random32()))).toBe(1n);
  });

  it("climbs past a generation this client never held a key for", () => {
    // The spec property is about the CHANNEL's whole life, not one client's
    // keyring. Whoever privatises a public channel need never have held its
    // earlier private generations — they joined afterwards, were never granted
    // its Role, or a rotation cut them out and the cut floor dropped the key.
    // The observed floor comes off the rekey addresses (CORD-06 §2), which
    // derive from the community root every member holds.
    expect(nextChannelEpoch([], idHex, 6n)).toBe(7n);
  });

  it("takes the highest of the observed floor and its own keys, either way round", () => {
    // Both are lower bounds on the truth and neither dominates: the wire can
    // have been pruned, and a keyring lags every generation its owner sat out.
    const held = [{ id, key: random32(), epoch: 9n, name: "c" }];
    expect(nextChannelEpoch(held, idHex, 3n)).toBe(10n);
    expect(nextChannelEpoch(held, idHex, 20n)).toBe(21n);
  });
});

describe("channelKeysToWire (history survives a list write)", () => {
  it("carries priors through, so touching one channel can't blank another's history", () => {
    // `refreshChannels` REPLACES the stored array, so a serializer that drops
    // priors takes every OTHER channel's pre-rotation history dark as a side
    // effect — the streams CORD-03 §3 requires a reader to query.
    const a = random32();
    const b = random32();
    const priorKey = random32();
    const wire = channelKeysToWire([
      { id: a, key: random32(), epoch: 3n, name: "one", priors: [{ key: priorKey, epoch: 2n }] },
      { id: b, key: random32(), epoch: 0n, name: "two" },
    ]);
    expect(wire[0].priors).toEqual([{ key: bytesToHex(priorKey), epoch: 2 }]);
    // No empty `priors` key when there are none — the wire stays as it was.
    expect("priors" in wire[1]).toBe(false);
  });

  it("round-trips through rehydrateCommunity", () => {
    // `rehydrateCommunity` re-derives the community_id, so the material has to
    // be self-consistent (same shape as the round-trip test above).
    const ownerPk = bytesToHex(random32());
    const salt = random32();
    const cid = communityIdOf(
      Uint8Array.from(ownerPk.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      salt,
    );
    const id = random32();
    const priorKey = random32();
    const jm = makeJoinMaterial({
      community_id: bytesToHex(cid),
      owner: ownerPk,
      owner_salt: bytesToHex(salt),
      channels: channelKeysToWire([{ id, key: random32(), epoch: 2n, name: "c", priors: [{ key: priorKey, epoch: 1n }] }]),
    });
    const community = rehydrateCommunity(entryOf(jm))!;
    expect(community.privateChannels[0].priors).toEqual([{ key: priorKey, epoch: 1n }]);
  });
});

describe("replayedAddStanding (a pending join settled after its click)", () => {
  const jm = makeJoinMaterial();
  const clicked = entryOf(jm, 5000);

  it("is superseded by a removal at or after the click", () => {
    expect(replayedAddStanding(removeFromList(EMPTY_COMMUNITY_LIST, jm.community_id, 5000), clicked)).toBe("superseded");
    expect(replayedAddStanding(removeFromList(EMPTY_COMMUNITY_LIST, jm.community_id, 9000), clicked)).toBe("superseded");
  });

  it("is still to be written over a removal that predates the click", () => {
    expect(replayedAddStanding(removeFromList(EMPTY_COMMUNITY_LIST, jm.community_id, 4999), clicked)).toBeUndefined();
  });

  it("is held when the list is live under this add or a newer one", () => {
    expect(replayedAddStanding(addToList(EMPTY_COMMUNITY_LIST, clicked), clicked)).toBe("held");
    expect(replayedAddStanding(addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 6000)), clicked)).toBe("held");
  });

  it("is still to be written when only an older add is held", () => {
    expect(replayedAddStanding(addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 4000)), clicked)).toBeUndefined();
    expect(replayedAddStanding(EMPTY_COMMUNITY_LIST, clicked)).toBeUndefined();
  });
});

describe("snapshot revisions (CORD-02 §8)", () => {
  const listOf = (seed: JoinMaterial, current: JoinMaterial) =>
    addToList(EMPTY_COMMUNITY_LIST, { community_id: current.community_id, seed, current, added_at: 1000 });

  it("at an epoch tie the higher rev wins, even when it sorts later", () => {
    const base = makeJoinMaterial({ root_epoch: 5 });
    const old = { ...base, name: "aaa", rev: 1 };
    const fresh = { ...base, name: "zzz", rev: 2 };
    for (const [a, b] of [[old, fresh], [fresh, old]]) {
      const merged = mergeCommunityLists(listOf(a, a), listOf(b, b));
      expect(merged.entries[0].current.name).toBe("zzz");
      expect(merged.entries[0].seed.name, "an equal-epoch seed follows the same revision").toBe("zzz");
    }
  });

  it("the epoch outranks the revision", () => {
    const base = makeJoinMaterial();
    const low = { ...base, root_epoch: 2, rev: 9 };
    const high = { ...base, root_epoch: 6, community_root: bytesToHex(random32()) };
    const merged = mergeCommunityLists(listOf(low, low), listOf(high, high));
    expect(merged.entries[0].current.root_epoch).toBe(6);
    expect(merged.entries[0].seed.root_epoch).toBe(2);
  });

  it("a revision past the safe integer range counts as zero", () => {
    const base = makeJoinMaterial({ root_epoch: 5 });
    const honest = { ...base, name: "zzz", rev: 1 };
    const wild = { ...base, name: "aaa", rev: 2 ** 60 };
    expect(mergeCommunityLists(listOf(honest, honest), listOf(wild, wild)).entries[0].current.name).toBe("zzz");
  });

  it("a write revises a changed snapshot one past what it read, and keeps an unchanged one", () => {
    const base = makeJoinMaterial({ root_epoch: 3, rev: 4 });
    const read = listOf(base, base);
    const renamed = refreshRelays(read, base.community_id, ["wss://new.example"]);
    const revised = reviseSnapshots(read, renamed);
    expect(revised.entries[0].current.rev).toBe(5);
    expect(revised.entries[0].seed, "a seed at the current epoch follows it").toBe(revised.entries[0].current);
    expect(reviseSnapshots(read, read).entries[0].current.rev).toBe(4);
  });

  it("an unrevised list stays byte-identical: 0 is never written", () => {
    const base = makeJoinMaterial({ root_epoch: 3 });
    const read = listOf(base, base);
    const revised = reviseSnapshots(read, read);
    expect("rev" in revised.entries[0].current).toBe(false);
  });

  /**
   * Vector's `rebuild_snapshot`, transcribed: the device's own snapshot wins its names,
   * keys go by epoch, a same-epoch copy fills in only the fields ours lacks, and the
   * revision moves one past the read copy only when the content changed.
   */
  function vectorRebuild(ours: JoinMaterial, theirs: JoinMaterial): JoinMaterial {
    const out = structuredClone(ours);
    for (const t of theirs.channels) {
      const c = out.channels.find((x) => x.id === t.id);
      if (!c) {
        out.channels.push(structuredClone(t));
        continue;
      }
      if (t.epoch > c.epoch) Object.assign(c, { epoch: t.epoch, key: t.key });
      if (t.epoch === c.epoch) for (const [k, v] of Object.entries(t)) if (!(k in c)) (c as Record<string, unknown>)[k] = v;
    }
    out.channels.sort((x, y) => (x.id < y.id ? -1 : 1));
    const bare = (j: JoinMaterial) => canonicalJson({ ...j, rev: 0, channels: [...j.channels].sort((x, y) => (x.id < y.id ? -1 : 1)) });
    const read = theirs.rev ?? 0;
    return { ...out, rev: bare(out) === bare(theirs) ? read : read + 1 };
  }

  it("settles with Vector when both hold the same Channel key under different names", () => {
    const base = makeJoinMaterial({ root_epoch: 0 });
    const key = { id: "aa".repeat(32), key: "11".repeat(32), epoch: 1 };
    const vectorHeld = { ...base, channels: [{ ...key, name: "general" }] };
    let wire: JoinMaterial = { ...vectorHeld, rev: 3 };
    let armada = listOf({ ...base, channels: [{ ...key, name: "" }], rev: 2 }, { ...base, channels: [{ ...key, name: "" }], rev: 2 });
    const writes: string[] = [];
    for (let round = 0; round < 4; round++) {
      // Armada's sync: its copy unioned with the wire, revised against the wire.
      armada = reviseSnapshots(listOf(wire, wire), mergeCommunityLists(armada, listOf(wire, wire)));
      const ours = armada.entries[0].current;
      if (canonicalJson(ours) !== canonicalJson(wire)) {
        writes.push(`armada@${round}`);
        wire = ours;
      }
      const theirs = vectorRebuild(vectorHeld, wire);
      if (canonicalJson(theirs) !== canonicalJson(wire)) {
        writes.push(`vector@${round}`);
        wire = theirs;
      }
    }
    expect(writes.filter((w) => !w.endsWith("@0")), "nobody writes past the first round").toEqual([]);
    expect(wire.channels[0].name).toBe("general");
  });

  it("orders channels by raw id bytes", () => {
    const chans = unionChannelKeys(
      [{ id: "b0".repeat(32), key: "11".repeat(32), epoch: 1, name: "b" }],
      [{ id: "0a".repeat(32), key: "22".repeat(32), epoch: 1, name: "a" }],
    );
    expect(chans.map((c) => c.id.slice(0, 2))).toEqual(["0a", "b0"]);
  });
});
