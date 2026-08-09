/**
 * Concord community assembly — genesis (CORD-02 §1), the runtime channel
 * view (CORD-03), and the classifier the Add wizard uses to tell a Concord invite
 * from everything else.
 */

import {
  bytesToHex,
  channelGroupKey,
  channelSignerGroupKey,
  communityIdOf,
  controlSignerGroupKey,
  hex32,
  random32,
  voiceGroupKey,
  voiceMediaKey,
  type GroupKey,
  type StreamKeyView,
} from "@/concord/lib/derive";
import { channelAnnouncePk } from "@/concord/lib/channelAnnounce";
import { channelCategory } from "@/concord/lib/channelCategory";
import { channelPosition, compareChannelOrder } from "@/concord/lib/channelOrder";
import { parseInviteLink, type ParsedInviteLink } from "@/concord/lib/invite";
import type { FoldedControl } from "@/concord/lib/control";
import { capRelays, type Channel, type Community, type VoiceKeys } from "@/concord/lib/types";

/**
 * Mint a brand-new community: a random `owner_salt` commits the owner into the
 * self-certifying `community_id`, an independent random `community_root` is
 * the access key (deliberately NOT derived from the id, so access can rotate
 * while identity stays fixed), and a random `control_root` — held by the
 * owner alone until staff are promoted — write-gates the Control Plane
 * (CORD-02 §2), every member reading it by the derived `control_pk`.
 *
 * Genesis publishes exactly two owner-signed editions — the metadata and one
 * public `#general` Channel — which the caller builds; this mints the secrets
 * and the runtime shape.
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
 * Assemble the channels the member can actually read from the Control fold +
 * held keys:
 *
 *   - a PUBLIC channel derives its stream from the community_root per held
 *     root epoch (readable by every member, rotates with the base for free);
 *   - a PRIVATE channel needs its independent key from the member's bundle —
 *     lacking it, the channel is omitted (its ciphertext is unreadable anyway);
 *   - deleted channels are dropped from display (history stays decryptable to
 *     anyone who held the keys, but that's a future "archive" view).
 *
 * Ordered by name for a stable sidebar.
 */
/**
 * Whether this member can PUBLISH to a Channel's current stream.
 *
 * False only for an announcement Channel this member holds no `control_root`
 * for — every ordinary Channel's stream key IS its write key, so a Channel the
 * member can see at all is one they can write to.
 */
export function canWriteChannel(channel: Channel): boolean {
  return channel.current.group.sk !== undefined;
}

/**
 * A Channel's current WRITE key. Throws when the Channel is write-restricted
 * and this member holds no `control_root` — publishing there would mint a wrap
 * that fails the signature check at every reader and every relay.
 *
 * The mirror of `currentControlWriteGroup`, and for the same reason: the read
 * view is what every caller gets, so the one place that needs a signing secret
 * is the one place that has to say so.
 */
export function channelWriteGroup(channel: Channel): GroupKey {
  const { group } = channel.current;
  const sk = group.sk;
  if (sk === undefined) {
    throw new Error("Only community staff can post in an announcement channel.");
  }
  return {
    sk,
    pk: group.pk,
    get convKey() {
      return group.convKey;
    },
  };
}

export function channelsView(community: Community, folded: FoldedControl | undefined): Channel[] {
  const out: Channel[] = [];
  const seen = new Set<string>();

  const privateKeysById = new Map(community.privateChannels.map((ch) => [bytesToHex(ch.id), ch]));

  // Every Channel is callable: its call coordinates derive from the same
  // (secret, epoch) that addresses its CURRENT Chat Plane (CORD-07 §1), so the
  // room name and media root roll with the Channel's key on a rekey. Each
  // channel's `voice` property is a LAZY memoized getter over this: the room
  // keypair costs a secp256k1 point multiplication, and nothing reads voice
  // keys until a call is joined or resolved for that channel — deriving them
  // eagerly here priced every channelsView at a point-mul per channel.
  const voiceKeys = (secret: Uint8Array, id: Uint8Array, epoch: bigint): VoiceKeys => ({
    room: voiceGroupKey(secret, id, epoch),
    mediaKey: voiceMediaKey(secret, id, epoch),
  });

  for (const def of folded?.channels.values() ?? []) {
    if (def.deleted) continue;
    seen.add(def.channelIdHex);
    const id = hex32(def.channelIdHex);

    // History is not one key. A channel accumulates streams: one per held
    // ROOT epoch (what it wrote while public) and one per held CHANNEL key,
    // current and retained priors (what it wrote under each private epoch).
    // Rendering only the current one is why converting a channel — or simply
    // rotating its key — appeared to erase the conversation before it.
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
      // An ANNOUNCEMENT channel is the same Chat Plane addressed by a
      // write-restricted stream: the wraps stay encrypted under the SAME
      // community_root-derived conv_key (so the readership is untouched), but
      // the address is `control_root`-derived, so only staff can produce a
      // wrap it will accept. See `channelAnnounce.ts`.
      const announcePk = channelAnnouncePk(def.metadata);
      const announceStreams = announcePk
        ? community.heldRoots.map((r) => {
            const read = channelGroupKey(r.key, id, r.epoch);
            const signer =
              community.controlRoot !== undefined && r.epoch === community.rootEpoch
                ? channelSignerGroupKey(community.controlRoot, id, r.epoch)
                : undefined;
            const group: StreamKeyView = {
              pk: announcePk,
              get convKey() {
                return read.convKey;
              },
              // The reader's half of the write gate: the wrap signature proves
              // a control_root holder published it, so openWrap verifies it
              // (CORD-01 Write-Restricted Streams).
              restricted: true,
              // A held secret that does not derive to the published address is
              // corrupt state, not a signer: leave `sk` absent (fail closed to
              // read-only) rather than mint wraps nobody subscribes to. This is
              // also what makes a STALE address safe — after a Refounding rolls
              // `control_root`, the metadata's pk no longer derives, so staff
              // drop to read-only until the channel is re-announced instead of
              // publishing into a stream no member reads.
              ...(signer && signer.pk === announcePk ? { sk: signer.sk } : {}),
            };
            return {
              epoch: r.epoch,
              group,
              ...(r.retiredAt !== undefined ? { retiredAt: r.retiredAt } : {}),
            };
          })
        : [];
      let voiceMemo: VoiceKeys | undefined;
      out.push({
        id,
        idHex: def.channelIdHex,
        name: def.name,
        isPrivate: false,
        isAnnouncement: announcePk !== undefined,
        category: channelCategory(def.metadata),
        position: channelPosition(def.metadata),
        get voice() {
          return (voiceMemo ??= voiceKeys(community.root, id, community.rootEpoch));
        },
        // An announcement channel reads ONLY its restricted address, and
        // deliberately not the community_root-derived one every ordinary
        // channel shares — for the same reason a private channel drops its
        // public-era stream. That address is writable by every member, so
        // folding it in would present un-gated posts inside a channel whose
        // whole claim is that only staff can post: a demoted moderator, or any
        // member with a patched client, could keep "announcing" by writing to
        // the address the channel used to have.
        streams: announcePk ? [...announceStreams, ...channelStreams] : [...rootStreams, ...channelStreams],
        current: announcePk ? announceStreams[0] : rootStreams[0],
      });
      continue;
    }

    if (!held) continue; // no key → cannot read; omit rather than tease
    let voiceMemo: VoiceKeys | undefined;
    out.push({
      id,
      idHex: def.channelIdHex,
      name: def.name,
      isPrivate: true,
      // Announcement mode is a PUBLIC-channel shape: it narrows the writer set
      // below a readership that is already the whole membership. A private
      // channel's readership is its keyholders, and that key is its wrap
      // signer — so the two would have to be split by a second, separately
      // distributed key rather than by `control_root`, which is what this
      // design buys its way out of.
      isAnnouncement: false,
      category: channelCategory(def.metadata),
      position: channelPosition(def.metadata),
      get voice() {
        return (voiceMemo ??= voiceKeys(held.key, id, held.epoch));
      },
      // A Private Channel reads ONLY its channel-key streams — the current key
      // and every retained prior (a CORD-06 rekey's private-era history), so a
      // rotation never erases the conversation. It deliberately does NOT fold
      // in the root-derived (community_root) stream every public channel
      // shares: those messages are world-readable to the whole membership, so
      // surfacing them inside a private channel would present public content as
      // private — whether they are a converted channel's genuine pre-privatise
      // history (CORD-03 §2 keeps that readable to all, but it is not private)
      // or, for a born-private channel, whatever a non-conformant client wrote
      // to that shared address. Publicising re-folds the root stream via the
      // public branch above; the pre-conversion history is never lost, only
      // absent from the private view.
      streams: channelStreams,
      current: channelStreams[0],
    });
  }

  // Private channels held in the bundle but not (yet) folded from the Control
  // Plane still render (the fold may lag a fresh join); the fold's name wins
  // once it lands.
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
      isAnnouncement: false,
      get voice() {
        return (voiceMemo ??= voiceKeys(held.key, held.id, held.epoch));
      },
      streams: [stream, ...priorStreams],
      current: stream,
    });
  }

  // Position first, then name: one order on every client (channelOrder.ts).
  out.sort(compareChannelOrder);
  return out;
}

// ── Add-wizard classification ────────────────────────────────────────────────

/** What a pasted "add" input classifies to, Concord-aware. */
export type AddInput = { kind: "concord"; invite: ParsedInviteLink } | { kind: "other" };

/** Classify a pasted string as a Concord invite, or leave it for other classifiers. */
export function classifyInvite(input: string): AddInput {
  const invite = parseInviteLink(input);
  return invite ? { kind: "concord", invite } : { kind: "other" };
}
