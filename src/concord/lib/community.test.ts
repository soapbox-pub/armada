import { describe, expect, it } from "vitest";

import { channelsView, deletedChannels, mintCommunity } from "./community";
import { bytesToHex, channelGroupKey, random32 } from "./derive";
import { emptyRoles } from "./roles";

import type { FoldedControl, FoldedChannel } from "./control";
import type { ChannelMetadata, Community, PrivateChannelKey } from "./types";

const OWNER = "f".repeat(64);

function foldWith(channels: FoldedChannel[]): FoldedControl {
  return {
    roster: emptyRoles(),
    ownerHex: OWNER,
    channels: new Map(channels.map((c) => [c.channelIdHex, c])),
    banned: new Set(),
    liveInviteLinks: new Set(),
    registriesByCreator: new Map(),
    heads: new Map(),
    headEditions: new Map(),
    incomplete: [],
    bannedAt: new Map(),
  } as unknown as FoldedControl;
}

function channelDef(id: Uint8Array, metadata: ChannelMetadata): FoldedChannel {
  return {
    channelIdHex: bytesToHex(id),
    name: metadata.name,
    isPrivate: metadata.private,
    deleted: metadata.deleted === true,
    metadata,
  };
}

/**
 * The lock is `isPrivate`, full stop. CORD-03 splits channels by who may read
 * them: a Public one derives its key from the `community_root` every member
 * holds, a Private one has an independent key delivered only to the holders of
 * a Role scoped to it. There is no third state and nothing else to consult.
 */
describe("channelsView (CORD-03 channel kinds)", () => {
  const held = (id: Uint8Array, name: string): PrivateChannelKey => ({ id, key: random32(), epoch: 0n, name });

  it("a private channel is private whether or not a role is scoped to it", () => {
    // A private channel nobody is scoped to is a room only its key holders can
    // read — degenerate, but not open, and never renders as a normal channel.
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const scopedId = random32();
    const orphanId = random32();
    const community: Community = {
      ...base,
      privateChannels: [held(scopedId, "scoped"), held(orphanId, "orphan")],
    };
    const folded = foldWith([
      channelDef(scopedId, { name: "scoped", private: true }),
      channelDef(orphanId, { name: "orphan", private: true }),
    ]);

    const byName = new Map(channelsView(community, folded).map((c) => [c.name, c]));
    expect(byName.get("scoped")?.isPrivate).toBe(true);
    expect(byName.get("orphan")?.isPrivate).toBe(true);
  });

  it("carries a channel's topic on the legacy Roster too (CORD-03 §2)", () => {
    const { community, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const folded = foldWith([channelDef(generalChannelId, { name: "general", private: false, topic: "Say hi" })]);
    expect(channelsView(community, folded)[0]?.topic).toBe("Say hi");
  });

  it("public channels are never private", () => {
    const { community, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const folded = foldWith([channelDef(generalChannelId, { name: "general", private: false })]);
    expect(channelsView(community, folded)[0]?.isPrivate).toBe(false);
  });

  it("a private channel reads only its private-era keys; the public root era is not folded in", () => {
    // A channel with private-era history across a rekey (current key epoch 2, a
    // held prior at epoch 1) plus a root/public era at epoch 0.
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const community: Community = {
      ...base,
      privateChannels: [{ id, key: random32(), epoch: 2n, name: "c", priors: [{ key: random32(), epoch: 1n }] }],
    };

    // PUBLIC: the root era leads and every held channel key (the private era)
    // stays queried, so publicising never appears to erase the conversation.
    const asPublic = channelsView(community, foldWith([channelDef(id, { name: "c", private: false })]))[0];
    expect(asPublic.current.epoch).toBe(community.rootEpoch);
    expect(asPublic.streams.map((s) => s.epoch).sort()).toEqual([0n, 1n, 2n]);

    // PRIVATE: only the channel-key streams (current + prior). The root-derived
    // (community_root) era is world-readable, so it is NOT surfaced inside the
    // private channel — its address never enters the read set.
    const asPrivate = channelsView(community, foldWith([channelDef(id, { name: "c", private: true })]))[0];
    expect(asPrivate.current.epoch).toBe(2n);
    expect(asPrivate.streams.map((s) => s.epoch).sort()).toEqual([1n, 2n]);
    const rootPk = channelGroupKey(community.heldRoots[0].key, id, community.heldRoots[0].epoch).pk;
    expect(asPrivate.streams.some((s) => s.group.pk === rootPk)).toBe(false);
  });

  it("a born-private channel does NOT read the community_root stream", () => {
    // The leak class: a channel private from its first edition has no legitimate
    // public era, yet its channel key epoch (0) collides with the root epoch (0),
    // so identity is by ADDRESS. channelsView must read the independent channel
    // key only — never the community_root address every public channel shares,
    // where a non-conformant client's public writes would otherwise surface as
    // private-channel content.
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const key = random32();
    const community: Community = { ...base, privateChannels: [{ id, key, epoch: 0n, name: "secret" }] };
    const view = channelsView(community, foldWith([channelDef(id, { name: "secret", private: true })]))[0];
    expect(view.streams).toHaveLength(1);
    expect(view.streams[0].group.pk).toBe(channelGroupKey(key, id, 0n).pk);
    const rootPk = channelGroupKey(community.heldRoots[0].key, id, community.heldRoots[0].epoch).pk;
    expect(view.streams.some((s) => s.group.pk === rootPk)).toBe(false);
  });

  it("a held-but-unfolded private channel still reads as private", () => {
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const community: Community = { ...base, privateChannels: [held(id, "pending")] };
    // Holding an independent channel key is itself proof the channel is
    // private: a public one would derive from the root and need no key.
    expect(channelsView(community, foldWith([]))[0]?.isPrivate).toBe(true);
  });

  it("a deleted private channel is not resurrected by its retained key", () => {
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const community: Community = { ...base, privateChannels: [held(id, "gone")] };
    const deleted = channelDef(id, { name: "gone", private: true, deleted: true });

    // The key stays in the member bundle so history remains decryptable, but a
    // control-plane tombstone is authoritative and must keep it out of the
    // live channel list.
    expect(channelsView(community, foldWith([deleted]))).toEqual([]);
  });
});

describe("deletedChannels", () => {
  it("names only the Channels the fold deleted, never a live one whose key is held", () => {
    // A purge drops every row of what this returns and deletes the member's own wraps there.
    const { community: base, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const goneId = random32();
    const liveId = random32();
    const community: Community = {
      ...base,
      privateChannels: [
        { id: liveId, key: random32(), epoch: 0n, name: "live" },
        { id: generalChannelId, key: base.root, epoch: 0n, name: "general" },
      ],
    };
    const folded = foldWith([
      channelDef(generalChannelId, { name: "general", private: false }),
      channelDef(liveId, { name: "live", private: true }),
      channelDef(goneId, { name: "gone", private: false, deleted: true }),
    ]);

    expect(deletedChannels(community, folded).map((c) => c.idHex)).toEqual([bytesToHex(goneId)]);
  });
});
