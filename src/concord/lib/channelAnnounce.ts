/**
 * Announcement channels — an Armada client convention (see CORD.md).
 *
 * CORD-03 has no notion of a read-only Channel, so one MAY carry
 * `custom["armada.announce"] = { pk }` — a member of the same client-extensible
 * object as `armada.git` and `armada.category` (CORD-02 §6).
 *
 * UNLIKE those two, this one is NOT display-only, and the difference is the
 * whole point. A category that a client ignores costs a misfiled sidebar entry.
 * A "read-only" flag that a client ignores costs nothing at all — every member
 * holds `community_root`, from which an ordinary Channel's address derives, so
 * every member can sign wraps at it. Enforcement cannot live in a boolean.
 *
 * So `pk` is not a flag but a KEY: the Channel's Chat Plane address, derived by
 * {@link channelSignerGroupKey} from the community's staff-held `control_root`
 * rather than from `community_root`. That makes the Channel a Write-Restricted
 * Stream (CORD-01) — the readership is unchanged (wraps stay encrypted under
 * the community_root-derived conv_key every member holds), but only
 * `control_root` holders can produce a wrap the address will accept, and
 * `openWrap` verifies that signature rather than trusting the relays to.
 *
 * Three properties follow, and they are why the address rides in the metadata:
 *
 *   1. **Delivery is already authenticated.** Members holding no `control_root`
 *      cannot derive this address, exactly as they cannot derive `control_pk`.
 *      But where `control_pk` needs the invite bundle, the base rekey blobs and
 *      the Community List to all carry it, a Channel's address can simply live
 *      in the Channel's own metadata edition — which the Control Plane's
 *      MANAGE_CHANNELS gate authenticates on the way in.
 *
 *   2. **Posting rights need no distribution and no rotation of their own.**
 *      They are `control_root` possession, which CORD-06 already rotates: the
 *      address rolls with the root epoch, and a demoted staff member loses the
 *      ability to post exactly when they lose the root. There is no second
 *      access list to keep in step with the roster.
 *
 *   3. **A wrong or absent `pk` degrades to an ordinary Channel**, not to a
 *      broken one — the fold falls back to the community_root address, which is
 *      what every pre-existing Channel already uses.
 *
 * The honest bounds. Posting is scoped to STAFF, not to a per-channel poster
 * list: anyone holding `control_root` can post in any announcement Channel of
 * that community. A narrower writer set would need its own key and its own
 * distribution, which is the thing this design buys its way out of. And a
 * Channel that BECOMES an announcement Channel keeps its old community_root
 * address readable — see `channelsView`, which reads only the announce address
 * once one is set, for the same reason a privatised Channel stops folding in
 * its public-era stream.
 */

import type { ChannelMetadata } from "@/concord/lib/types";

export const ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY = "armada.announce";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The Channel's announce (write-restricted) stream address, or undefined when
 * it is an ordinary Channel.
 *
 * A malformed value reads as "ordinary" rather than invalidating the Channel:
 * the fold then addresses it by the community_root derivation, which every
 * member can read and write — the pre-announcement behavior — instead of
 * pointing the whole Channel at an address nobody can produce wraps for.
 */
export function channelAnnouncePk(metadata: ChannelMetadata): string | undefined {
  const extension = isRecord(metadata.custom) ? metadata.custom[ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY] : undefined;
  if (!isRecord(extension) || typeof extension.pk !== "string") return undefined;
  const pk = extension.pk.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(pk) ? pk : undefined;
}

/** Whether the Channel is an announcement Channel (staff-post-only). */
export function isAnnouncementChannel(metadata: ChannelMetadata): boolean {
  return channelAnnouncePk(metadata) !== undefined;
}

/** Metadata with the announce address set (or cleared), other extensions untouched. */
export function withChannelAnnouncePk(metadata: ChannelMetadata, pk: string | undefined): ChannelMetadata {
  const custom: Record<string, unknown> = isRecord(metadata.custom) ? { ...metadata.custom } : {};
  const trimmed = pk?.trim().toLowerCase();
  if (trimmed && /^[0-9a-f]{64}$/.test(trimmed)) custom[ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY] = { pk: trimmed };
  else delete custom[ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY];
  const next: ChannelMetadata = { ...metadata };
  if (Object.keys(custom).length > 0) next.custom = custom;
  else delete next.custom;
  return next;
}
