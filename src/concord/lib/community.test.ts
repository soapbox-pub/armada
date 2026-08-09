import { describe, expect, it } from "vitest";

import { canWriteChannel, channelWriteGroup, channelsView, mintCommunity } from "./community";
import { withChannelAnnouncePk } from "./channelAnnounce";
import { bytesToHex, channelGroupKey, channelSignerGroupKey, random32 } from "./derive";
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
    deleted: false,
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
});

/**
 * An announcement channel narrows the WRITER set without touching the reader
 * set — CORD-01's Write-Restricted Stream applied to a Channel. The whole test
 * of the design is that a non-staff member ends up with a channel they can
 * fully read and provably cannot post to, with no extra key handed to them.
 */
describe("channelsView (announcement channels)", () => {
  const announce = (id: Uint8Array, controlRoot: Uint8Array, epoch: bigint): ChannelMetadata =>
    withChannelAnnouncePk({ name: "news", private: false }, channelSignerGroupKey(controlRoot, id, epoch).pk);

  it("addresses the channel by the control_root signer while keeping the member read key", () => {
    const { community } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const metadata = announce(id, community.controlRoot!, community.rootEpoch);
    const view = channelsView(community, foldWith([channelDef(id, metadata)]))[0];

    expect(view.isAnnouncement).toBe(true);
    // The ADDRESS is the staff-only derivation…
    expect(view.current.group.pk).toBe(channelSignerGroupKey(community.controlRoot!, id, community.rootEpoch).pk);
    // …while the CONTENT key is the same community_root one every member holds,
    // so making a channel announcement-only takes nothing away from readers.
    expect(view.current.group.convKey).toEqual(channelGroupKey(community.root, id, community.rootEpoch).convKey);
    // And readers are told to check the wrap signature rather than trust relays.
    expect(view.current.group.restricted).toBe(true);
  });

  it("does not fold in the community_root address every member can write to", () => {
    // The hole this closes: that address is derivable by the whole membership,
    // so folding it in would let a demoted moderator — or any member with a
    // patched client — keep "announcing" at the channel's ordinary address.
    const { community } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const view = channelsView(community, foldWith([channelDef(id, announce(id, community.controlRoot!, community.rootEpoch))]))[0];
    const ordinary = channelGroupKey(community.root, id, community.rootEpoch).pk;
    expect(view.streams.some((s) => s.group.pk === ordinary)).toBe(false);
  });

  it("gives staff a write key and everyone else a read-only view", () => {
    const { community } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const folded = foldWith([channelDef(id, announce(id, community.controlRoot!, community.rootEpoch))]);

    const asStaff = channelsView(community, folded)[0];
    expect(canWriteChannel(asStaff)).toBe(true);
    expect(channelWriteGroup(asStaff).pk).toBe(asStaff.current.group.pk);

    // A rank-and-file member holds the same community_root but no control_root:
    // same channel, same reads, no signing secret anywhere in the view.
    const member: Community = { ...community, controlRoot: undefined };
    const asMember = channelsView(member, folded)[0];
    expect(asMember.current.group.pk).toBe(asStaff.current.group.pk);
    expect(asMember.current.group.convKey).toEqual(asStaff.current.group.convKey);
    expect(canWriteChannel(asMember)).toBe(false);
    expect(() => channelWriteGroup(asMember)).toThrow(/staff/i);
  });

  it("falls back to read-only when the published address no longer derives", () => {
    // What a Refounding leaves behind: `control_root` has rolled, so the
    // address in the channel's metadata is last epoch's. Staff must NOT publish
    // under the current root to an address no member subscribes to — better a
    // channel that refuses writes until it is re-announced.
    const { community } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const stale = announce(id, random32(), community.rootEpoch);
    const view = channelsView(community, foldWith([channelDef(id, stale)]))[0];
    expect(view.isAnnouncement).toBe(true);
    expect(canWriteChannel(view)).toBe(false);
  });

  it("reads as an ordinary channel when the announce address is malformed", () => {
    // Degrade toward the pre-announcement behavior, not toward a channel
    // pointed at an address nobody can produce wraps for.
    const { community } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const metadata: ChannelMetadata = { name: "news", private: false, custom: { "armada.announce": { pk: "nope" } } };
    const view = channelsView(community, foldWith([channelDef(id, metadata)]))[0];
    expect(view.isAnnouncement).toBe(false);
    expect(view.current.group.pk).toBe(channelGroupKey(community.root, id, community.rootEpoch).pk);
    expect(canWriteChannel(view)).toBe(true);
  });
});
