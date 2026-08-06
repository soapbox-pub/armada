import { useEffect } from "react";

import {
  baseRekeyGroupKey,
  channelRekeyGroupKey,
  dissolvedGroupKey,
  guestbookGroupKey,
  type GroupKey,
  type StreamKeyView,
} from "@/concord-v2/lib/derive";
import { CHANNEL_REKEY_LOOKAHEAD } from "@/concord-v2/lib/rekey";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { useChannels2, controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { useCommunity2, useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { rehydrateCommunity } from "@/concord-v2/lib/communityList";
import { channelsView } from "@/concord-v2/lib/community";
import { controlGroups, readControlFold } from "@/concord-v2/lib/control";
import { onFoldedWrite } from "@/lib/foldedCache";
import { logSync } from "@/lib/syncLog";

/**
 * The stream keys the client must NIP-42-authenticate as to READ a community's
 * planes on an auth-gating relay (see {@link streamAuth}). These are derivable
 * without the Control fold — enough to unblock the very first control REQ:
 *
 *   - the Control Plane, every held root epoch (channels fold from here) —
 *     for a split epoch this is the held `control_pk`, an ADDRESS-ONLY
 *     registration for a non-staff member (there is no secret to sign a
 *     NIP-42 challenge with, and the relay must not gate reads on it);
 *   - the Guestbook Plane, every held epoch (the member list);
 *   - the dissolution tombstone address (id-derived);
 *   - the NEXT base-rekey address (the rekey watcher polls it).
 *
 * Channel stream keys are added separately once the fold names them.
 */
function communityCoreKeys(community: CommunityV2): StreamKeyView[] {
  const keys: StreamKeyView[] = [...controlGroups(community)];
  for (const r of community.heldRoots) {
    keys.push(guestbookGroupKey(r.key, community.id, r.epoch));
  }
  keys.push(dissolvedGroupKey(community.id));
  keys.push(baseRekeyGroupKey(community.root, community.id, community.rootEpoch + 1n));
  // Each held Private Channel's NEXT-epoch rekey address, under every held
  // root (a refound seals channel rekeys under the PRIOR root, CORD-06 §3).
  // Without these, an auth-gating relay answers useChannelRekeyWatch2's REQ
  // with nothing — a member rotated AWAY from a channel would never see the
  // rotation, so the removal (or a rekey adoption) never lands.
  for (const r of community.heldRoots) {
    for (const ch of community.privateChannels) {
      // The same WINDOW useChannelRekeyWatch2 polls: a member who missed a
      // rotation must be able to authenticate for the later epochs too, or
      // an auth-gating relay answers their catch-up with nothing.
      for (let ahead = 1n; ahead <= BigInt(CHANNEL_REKEY_LOOKAHEAD); ahead++) {
        keys.push(channelRekeyGroupKey(r.key, ch.id, ch.epoch + ahead));
      }
    }
  }
  return keys;
}

/** Every per-channel stream key across held epochs (public + held private). */
function channelKeys(channels: ChannelV2[]): GroupKey[] {
  return channels.flatMap((c) => c.streams.map((s) => s.group));
}

/**
 * Register the core stream keys for EVERY live community, so the connection
 * authenticates as their control/guestbook/dissolved/rekey addresses. Mounted
 * once high in the tree (the app shell): the control fold that drives the
 * sidebar can't even read until these are registered.
 *
 * Also registers EVERY community's per-channel stream keys derivable from its
 * persisted control-fold snapshot (a local IndexedDB read, no relay fan-out).
 * This isn't for NIP-42 (a late key authenticates fine on a live socket —
 * NostrProvider sends its AUTH on the stored challenge and the relay acks it);
 * it's for COVERAGE: WireSync's standing kind-1059 subscription filters on
 * `authors: [...streamPubkeys()]`, so a community's channels only receive live
 * wraps (messages, notifications) once their keys are in the registry. Re-runs
 * on a short poll so folds that land after launch (a community synced for the
 * first time) get their channel keys registered too.
 */
export function useRegisterAllStreamKeys2(): void {
  const communities = useLiveCommunities2();

  useEffect(() => {
    if (communities.length === 0) return;
    let cancelled = false;

    const register = async () => {
      // Gather all keys first, then register in one burst — one AUTH wave per relay.
      const batches: Array<{ keys: StreamKeyView[]; relays: string[]; idHex: string }> = [];
      for (const entry of communities) {
        const community = rehydrateCommunity(entry);
        if (!community) continue;
        const keys: StreamKeyView[] = communityCoreKeys(community);
        // Per-channel keys from the persisted fold (may be absent on a
        // never-synced community — then only core keys register until it folds).
        try {
          const folded = await readControlFold(community.idHex);
          for (const channel of channelsView(community, folded)) {
            keys.push(...channel.streams.map((s) => s.group));
          }
        } catch {
          // No fold yet; core keys above still cover the control plane so the
          // fold can be fetched, after which a later poll picks up its channels.
        }
        batches.push({ keys, relays: community.relays, idHex: community.idHex });
      }
      if (cancelled) return;
      for (const batch of batches) {
        // Scoped to the community's relays: a relay's NIP-42 challenge then
        // signs only the keys it hosts (see streamAuth.ts).
        const changed = registerStreamKeys(batch.keys, batch.relays);
        if (changed.length > 0) {
          logSync(
            "auth",
            `registered ${changed.length} new stream key(s) for ${batch.idHex.slice(0, 8)} (${batch.keys.length} derivable, ${batch.relays.length} relay(s))`,
          );
        }
      }
    };

    void register();
    // Folds arrive out-of-band (control-plane sync), and a fold WRITE is the
    // exact signal that a community's channel keys just became derivable — so
    // re-register on it (debounced: a sweep writes several folds in a burst)
    // instead of leaving a fresh fold to wait out the poll. Measured on a real
    // boot the fold landed at +5s and the next poll tick registered its
    // channel keys at +15s; every auth-gated catch-up page on the community's
    // relays was held for that gap. The 20s tick stays as the backstop for
    // key material that changes without a fold write.
    const foldKeys = new Set(communities.map((c) => controlFoldKey(c.community_id)));
    let foldDebounce: ReturnType<typeof setTimeout> | undefined;
    const offFoldedWrite = onFoldedWrite((key) => {
      if (!foldKeys.has(key)) return;
      clearTimeout(foldDebounce);
      foldDebounce = setTimeout(() => void register(), 250);
    });
    const timer = setInterval(() => void register(), 20_000);
    return () => {
      cancelled = true;
      offFoldedWrite();
      clearTimeout(foldDebounce);
      clearInterval(timer);
    };
  }, [communities]);
}

/**
 * Register the currently-open community's per-channel stream keys as the fold
 * names them (public channels + any held private ones). Mounted on the
 * community page so reading a channel's timeline passes the relay auth gate.
 */
export function useRegisterChannelStreamKeys2(communityId: string | undefined): void {
  const community = useCommunity2(communityId);
  const channels = useChannels2(community);

  useEffect(() => {
    if (channels.length === 0 || !community) return;
    registerStreamKeys(channelKeys(channels), community.relays);
  }, [channels, community]);
}
