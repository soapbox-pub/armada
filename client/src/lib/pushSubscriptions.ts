/**
 * Shared nostr-push subscription set.
 *
 * Both the native FCM path (useFcmNotifications) and the PWA Web Push path
 * (useConcordWebPush) register the SAME logical subscriptions with nostr-push —
 * only the transport (`push_subscription`) differs. This module is the single
 * source of truth for what those subscriptions are, so the two paths can never
 * drift.
 *
 * Coverage (given the server can't decrypt anything it matches):
 *   - Direct messages (kind 4, #p = you): NIP-04 encrypted → static body.
 *   - Concord channel messages (kind 3300, #z = channel pseudonym): sealed →
 *     generic body in the real channel. One subscription per channel carrying
 *     all its retained-epoch `#z` pseudonyms; re-register when epochs rotate.
 *
 * NIP-29 group messages (#h) are intentionally NOT here — the shared server
 * neither matches #h nor watches per-group relays. Groups notify via the relay's
 * own Web Push gateway (server/push.go) for PWAs, or the persistent foreground
 * service on native.
 */

import type { ConcordSub } from "@/concord-v1/lib/concordNotifications";
import type { PushFilter } from "@/lib/nostrPush";

/**
 * One nostr-push subscription this device should hold. The `idSuffix` is stable
 * per logical subscription so register/delete are idempotent (the server does a
 * create-or-replace on `subscription_id`).
 */
export interface DesiredPushSub {
  /** Suffix appended to the base subscription id (`${baseId}-${idSuffix}`). */
  idSuffix: string;
  filter: PushFilter;
  title: string;
  body: string;
}

/**
 * Build the DM + Concord subscription set for a user. Transport-agnostic: the
 * caller wraps each with an FCM or Web Push `push_subscription`.
 */
export function buildDesiredPushSubs(
  userPubkey: string,
  concordSubs: ConcordSub[],
): DesiredPushSub[] {
  const subs: DesiredPushSub[] = [];

  // Direct messages (kind 4) addressed to me. NIP-04 encrypted → static body.
  subs.push({
    idSuffix: "dm",
    filter: { kinds: [4], "#p": [userPubkey] },
    title: "New direct message",
    body: "You have a new message",
  });

  // Concord channels (kind 3300) by #z pseudonym. The server can't decrypt, so
  // a generic body in the real channel. `#z` rotates per epoch, so we register
  // one subscription per channel carrying all its retained-epoch pseudonyms;
  // the id suffix is keyed by community+channel so re-registration on rotation
  // replaces the same server record rather than accumulating stale ones.
  const seen = new Set<string>();
  for (const sub of concordSubs) {
    if (sub.zs.length === 0) continue;
    const idSuffix = `concord-${sub.communityId}-${sub.channelName}`.slice(0, 56);
    if (seen.has(idSuffix)) continue;
    seen.add(idSuffix);
    const channel = sub.channelName || "channel";
    subs.push({
      idSuffix,
      filter: { kinds: [3300], "#z": sub.zs },
      title: sub.communityName ? `${sub.communityName} · #${channel}` : `#${channel}`,
      body: "New message",
    });
  }

  return subs;
}

/** A stable signature of the subscription set, for change detection. */
export function pushSubsSignature(subs: DesiredPushSub[]): string {
  return JSON.stringify(subs.map((d) => [d.idSuffix, d.filter]));
}
