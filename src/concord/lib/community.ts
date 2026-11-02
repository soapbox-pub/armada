/**
 * Concord community assembly — genesis (CORD-02 §1), the runtime channel
 * view (CORD-03), and the classifier the Add wizard uses to tell a Concord invite
 * from everything else.
 */

import {
  bytesToHex,
  channelGroupKey,
  communityIdOf,
  controlSignerGroupKey,
  hex32,
  random32,
  voiceGroupKey,
  voiceMediaKey,
} from "@/concord/lib/derive";
import { channelCategory } from "@/concord/lib/channelCategory";
import { channelPosition, compareChannelOrder } from "@/concord/lib/channelOrder";
import { channelView } from "@/concord/lib/channelView";
import { openChannelSeal } from "@/concord/lib/channelSeal";
import type { FoldedControl } from "@/concord/lib/control";
import { isRankKey } from "@/concord/lib/rankKey";
import { channelPermissions, Permissions } from "@/concord/lib/roles";
import { capRelays, type Channel, type ChannelMetadata, type Community, type VoiceKeys } from "@/concord/lib/types";

/**
 * Mint a new community: a random `owner_salt` commits the owner into the
 * self-certifying `community_id`; an independent random `community_root` is the
 * access key (so access can rotate while identity stays fixed); a random
 * `control_root` write-gates the Control Plane (CORD-02 §2), read via the
 * derived `control_pk`. The caller builds the genesis editions.
 */
export function mintCommunity(name: string, ownerPubkeyHex: string, relays: string[]): {
  community: Community;
  generalChannelId: Uint8Array;
} {
  const ownerSalt = random32();
  const owner = ownerPubkeyHex.toLowerCase();
  const id = communityIdOf(hex32(owner), ownerSalt);
  const root = random32();
  const controlRoot = random32();
  const controlPk = controlSignerGroupKey(controlRoot, id, 0n).pk;
  const generalChannelId = random32();
  return {
    community: {
      id,
      idHex: bytesToHex(id),
      owner,
      ownerSalt,
      root,
      rootEpoch: 0n,
      controlPk,
      controlRoot,
      heldRoots: [{ epoch: 0n, key: root, controlPk }],
      privateChannels: [],
      relays: capRelays(relays),
      name,
    },
    generalChannelId,
  };
}

/**
 * The channels the member can read, from the Control fold + held keys:
 *
 *   - PUBLIC: streams derive from the community_root per held root epoch;
 *   - PRIVATE: needs its independent key from the bundle, else omitted;
 *   - deleted channels are dropped.
 */
export function channelsView(community: Community, folded: FoldedControl | undefined): Channel[] {
  const out: Channel[] = [];
  const seen = new Set<string>();

  const privateKeysById = new Map(community.privateChannels.map((ch) => [bytesToHex(ch.id), ch]));

  // Call coordinates derive from the same (secret, epoch) as the CURRENT Chat
  // Plane (CORD-07 §1), so they roll on rekey. Lazy: the room keypair costs a
  // point multiplication per channel.
  const voiceKeys = (secret: Uint8Array, id: Uint8Array, epoch: bigint): VoiceKeys => ({
    room: voiceGroupKey(secret, id, epoch),
    mediaKey: voiceMediaKey(secret, id, epoch),
  });

  const v2 = folded?.rosterV2 === true;
  /** Where a Channel files and sorts: the vsk-13 Category and rank key (CORD-03 §2, §4), else Armada's conventions. */
  const placement = (meta: ChannelMetadata) => {
    if (!v2) return { category: channelCategory(meta), position: channelPosition(meta) };
    const cat = typeof meta.category === "string" ? folded?.categories?.get(meta.category) : undefined;
    const live = cat && !cat.deleted ? cat : undefined;
    return {
      ...(live ? { category: live.name || live.idHex.slice(0, 8), categoryId: live.idHex } : {}),
      ...(isRankKey(meta.position) ? { positionKey: meta.position } : {}),
      ...(typeof meta.topic === "string" ? { topic: meta.topic } : {}),
    };
  };

  for (const def of folded?.channels.values() ?? []) {
    // Mark tombstones seen too, so the held-key fallback can't resurrect a deleted
    // Private Channel.
    seen.add(def.channelIdHex);
    if (def.deleted) continue;
    const id = hex32(def.channelIdHex);

    // History spans streams: one per held ROOT epoch (public era) and one per held
    // CHANNEL key (private eras), so conversions and rotations don't hide history.
    const rootStreams = community.heldRoots.map((r) => ({
      epoch: r.epoch,
      group: channelGroupKey(r.key, id, r.epoch),
      ...(r.retiredAt !== undefined ? { retiredAt: r.retiredAt } : {}),
    }));
    const held = privateKeysById.get(def.channelIdHex);
    const channelStreams = held
      ? [
          { epoch: held.epoch, group: channelGroupKey(held.key, id, held.epoch) },
          ...(held.priors ?? []).map((p) => ({
            epoch: p.epoch,
            group: channelGroupKey(p.key, id, p.epoch),
            ...(p.retiredAt !== undefined ? { retiredAt: p.retiredAt } : {}),
          })),
        ]
      : [];

    if (!def.isPrivate) {
      let voiceMemo: VoiceKeys | undefined;
      out.push({
        id,
        idHex: def.channelIdHex,
        name: def.name,
        isPrivate: false,
        ...placement(def.metadata),
        view: channelView(def.metadata),
        get voice() {
          return (voiceMemo ??= voiceKeys(community.root, id, community.rootEpoch));
        },
        // Writes go to the root stream; private-era streams stay readable.
        streams: [...rootStreams, ...channelStreams],
        current: rootStreams[0],
      });
      continue;
    }

    if (!held) continue; // no key → cannot read; omit rather than tease
    // A sealed head opens with the Channel's key (CORD-03 §2); one that won't keeps the join-time name.
    const meta = def.sealed ? openChannelSeal(def.sealed, held)?.metadata : def.metadata;
    let voiceMemo: VoiceKeys | undefined;
    out.push({
      id,
      idHex: def.channelIdHex,
      name: meta?.name || held.name || def.channelIdHex.slice(0, 8),
      isPrivate: true,
      ...(meta ? placement(meta) : {}),
      view: meta ? channelView(meta) : "chat",
      get voice() {
        return (voiceMemo ??= voiceKeys(held.key, id, held.epoch));
      },
      // A Private Channel reads ONLY its channel-key streams (current + priors). The
      // shared root stream is world-readable to members, so showing it here would
      // present public content as private; publicising re-folds it via the public branch.
      streams: channelStreams,
      current: channelStreams[0],
    });
  }

  // Held-but-not-yet-folded private channels still render (the fold may lag a join).
  for (const held of community.privateChannels) {
    const idHex = bytesToHex(held.id);
    if (seen.has(idHex)) continue;
    const stream = { epoch: held.epoch, group: channelGroupKey(held.key, held.id, held.epoch) };
    const priorStreams = (held.priors ?? []).map((p) => ({
      epoch: p.epoch,
      group: channelGroupKey(p.key, held.id, p.epoch),
      ...(p.retiredAt !== undefined ? { retiredAt: p.retiredAt } : {}),
    }));
    let voiceMemo: VoiceKeys | undefined;
    out.push({
      id: held.id,
      idHex,
      name: held.name || idHex.slice(0, 8),
      isPrivate: true,
      // No fold yet: opens as chat until the fold lands.
      get voice() {
        return (voiceMemo ??= voiceKeys(held.key, held.id, held.epoch));
      },
      streams: [stream, ...priorStreams],
      current: stream,
    });
  }

  out.sort(v2 ? compareV2Placement(folded) : compareChannelOrder);
  return out;
}

const UNKEYED = "\u{10FFFF}";

/**
 * vsk-13 sidebar order (CORD-03 §2, §4): uncategorized Channels first, then each
 * Category by its rank key, name and id; within a group by rank key, name and id,
 * an entry without a key after every keyed one.
 */
function compareV2Placement(folded: FoldedControl | undefined) {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return (a: Channel, b: Channel): number => {
    if (a.categoryId !== b.categoryId) {
      if (!a.categoryId) return -1;
      if (!b.categoryId) return 1;
      const ca = folded?.categories?.get(a.categoryId);
      const cb = folded?.categories?.get(b.categoryId);
      return cmp(ca?.position ?? UNKEYED, cb?.position ?? UNKEYED) || cmp(ca?.name ?? "", cb?.name ?? "") || cmp(a.categoryId, b.categoryId);
    }
    return cmp(a.positionKey ?? UNKEYED, b.positionKey ?? UNKEYED) || cmp(a.name, b.name) || cmp(a.idHex, b.idHex);
  };
}

/**
 * The Channels `viewer` may see (CORD-04 §8): on the vsk-13 Roster an honest client
 * hides one the viewer lacks VIEW_CHANNEL in. A legacy Roster hides nothing.
 */
export function visibleChannels(channels: Channel[], folded: FoldedControl | undefined, viewer: string | undefined): Channel[] {
  if (!folded?.rosterV2 || !viewer) return channels;
  const visible = channels.filter(
    (c) => (channelPermissions(folded.roster, folded.ownerHex, viewer, c.idHex, c.isPrivate) & Permissions.VIEW_CHANNEL) !== 0n,
  );
  return visible.length === channels.length ? channels : visible;
}
