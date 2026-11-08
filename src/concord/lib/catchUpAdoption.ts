/**
 * Whether a parked catch-up invite (a Direct Invite carrying a private-channel
 * key an existing member lacks — how a role grant's key arrives, CORD-05 §6) may
 * be adopted WITHOUT a click. Consent came from the Grant; each channel the
 * bundle newly contributes is judged on its own against the folded Control
 * Plane, as Vector's `judge_channel_key_vend` does:
 *
 *   - the channel exists in OUR fold and is private there: a vend may deliver a
 *     key, never define a channel;
 *   - its epoch is not implausibly far past the one held, since the head is
 *     monotonic and an over-advance could never be walked back;
 *   - the recipient is entitled to it (`channelAccess.isEntitled`) and not banned;
 *   - the vendor is not banned, and is the owner, a MANAGE_CHANNELS holder, or
 *     entitled to the channel themselves (CORD-03 §5);
 *   - the key is authenticated where it can be: one at the sealed head's epoch
 *     must open the seal, as on the access plane. Nothing authenticates one at
 *     another epoch, so only the owner or a manager, who could rotate to a key of
 *     their own anyway, is taken at its word; an entitled peer's waits for the seal.
 *
 * `"no-fold"` means wait (the Grant's fold lags). Other refusals still allow a
 * manual Accept.
 */

import { isEntitled } from "@/concord/lib/channelAccess";
import { catchUpChannelIds, type HeldMembership } from "@/concord/lib/directInvite";
import type { InviteBundle } from "@/concord/lib/invite";
import { openChannelSeal } from "@/concord/lib/channelSeal";
import type { SealedChannelMeta } from "@/concord/lib/control";
import { hex32 } from "@/concord/lib/derive";
import { isAuthorized, Permissions, type CommunityRoles } from "@/concord/lib/roles";

/** How far past the held epoch a vend may claim to be (Vector `MAX_VEND_EPOCH_LEAD`). */
export const MAX_VEND_EPOCH_LEAD = 1024;

/** The slice of a `FoldedControl` the decision reads. */
export interface CatchUpFold {
  roster: CommunityRoles;
  ownerHex: string;
  banned: ReadonlySet<string>;
  channels: ReadonlyMap<string, { isPrivate: boolean; deleted: boolean; sealed?: SealedChannelMeta }>;
}

export type CatchUpVerdict =
  | "adopt"
  | "no-fold"
  | "nothing-new"
  | "banned"
  | "sender-banned"
  | "implausible-epoch"
  | "key-mismatch"
  | "unverified"
  | "sender-unauthorized"
  | "not-entitled";

/** The overall verdict, and the channels (lowercase hex) to adopt now when it is `"adopt"`. */
export interface CatchUpJudgement {
  verdict: CatchUpVerdict;
  adopt: string[];
}

/** When nothing is adoptable, the verdict reported: a refusal before a wait. */
const PRECEDENCE: CatchUpVerdict[] = ["sender-banned", "implausible-epoch", "key-mismatch", "sender-unauthorized", "not-entitled", "unverified", "no-fold"];

type Bundle = Pick<InviteBundle, "root_epoch" | "channels" | "community_root" | "control_pk">;

export function judgeCatchUpChannels(
  fold: CatchUpFold | undefined,
  recipientHex: string,
  senderHex: string,
  bundle: Bundle,
  held: HeldMembership | undefined,
): CatchUpJudgement {
  const vended = catchUpChannelIds(held, bundle);
  if (vended.length === 0) return { verdict: "nothing-new", adopt: [] };
  if (!fold) return { verdict: "no-fold", adopt: [] };
  if (fold.banned.has(recipientHex)) return { verdict: "banned", adopt: [] };
  const vends = new Map(bundle.channels.map((c) => [c.id.toLowerCase(), c]));
  const adopt: string[] = [];
  const refusals = new Set<CatchUpVerdict>();
  for (const idHex of vended) {
    const vend = vends.get(idHex);
    const verdict = judgeOne(fold, recipientHex, senderHex, idHex, vend?.epoch ?? 0, vend?.key ?? "", held?.channelEpochs.get(idHex));
    if (verdict === "adopt") adopt.push(idHex);
    else if (verdict !== "nothing-new") refusals.add(verdict);
  }
  if (adopt.length > 0) return { verdict: "adopt", adopt };
  return { verdict: PRECEDENCE.find((v) => refusals.has(v)) ?? "nothing-new", adopt: [] };
}

function judgeOne(
  fold: CatchUpFold,
  recipientHex: string,
  senderHex: string,
  idHex: string,
  epoch: number,
  keyHex: string,
  heldEpoch: number | undefined,
): CatchUpVerdict {
  const ch = fold.channels.get(idHex);
  if (!ch || ch.deleted) return "no-fold";
  // Never heals: our owner-rooted fold says it is public, so this is no Private key.
  if (!ch.isPrivate) return "nothing-new";
  if (epoch > (heldEpoch ?? 0) + MAX_VEND_EPOCH_LEAD) return "implausible-epoch";
  if (!isEntitled(fold.roster, fold.ownerHex, recipientHex, idHex)) return "not-entitled";
  if (fold.banned.has(senderHex)) return "sender-banned";
  const manages = isAuthorized(fold.roster, senderHex, fold.ownerHex, Permissions.MANAGE_CHANNELS);
  if (!manages && !isEntitled(fold.roster, fold.ownerHex, senderHex, idHex)) return "sender-unauthorized";
  if (ch.sealed) {
    if (BigInt(epoch) === ch.sealed.epoch) {
      if (!/^[0-9a-f]{64}$/i.test(keyHex)) return "key-mismatch";
      if (!openChannelSeal(ch.sealed, { id: hex32(idHex), key: hex32(keyHex), epoch: BigInt(epoch), name: "" })) return "key-mismatch";
    } else if (!manages && senderHex !== fold.ownerHex) {
      return "unverified";
    }
  }
  return "adopt";
}

/** {@link judgeCatchUpChannels}' verdict alone. */
export function judgeCatchUp(
  fold: CatchUpFold | undefined,
  recipientHex: string,
  senderHex: string,
  bundle: Bundle,
  held: HeldMembership | undefined,
): CatchUpVerdict {
  return judgeCatchUpChannels(fold, recipientHex, senderHex, bundle, held).verdict;
}
