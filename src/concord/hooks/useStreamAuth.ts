import { useEffect } from "react";

import {
  baseRekeyGroupKey,
  channelRekeyGroupKey,
  dissolvedGroupKey,
  guestbookGroupKey,
  type GroupKey,
  type StreamKeyView,
} from "@/concord/lib/derive";
import { CHANNEL_REKEY_LOOKAHEAD } from "@/concord/lib/rekey";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import type { Channel, Community } from "@/concord/lib/types";
import { useChannels } from "@/concord/hooks/useControlPlane";
import { useCommunity, useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import { channelsView, signingStreams } from "@/concord/lib/community";
import { controlGroups, readControlFold, controlFoldKey } from "@/concord/lib/control";
import { onFoldedWrite } from "@/lib/foldedCache";
import { logSync } from "@/lib/syncLog";

/**
 * Stream keys to NIP-42-authenticate as for READING a community's planes on an
 * auth-gating relay (see {@link streamAuth}), derivable without the Control fold:
 *
 *   - Control Plane, every held root epoch (for a split epoch, the held
 *     `control_pk` — address-only for non-staff, who hold no secret);
 *   - Guestbook Plane, every held epoch;
 *   - the dissolution tombstone address;
 *   - the NEXT base-rekey address.
 *
 * Channel keys are added once the fold names them.
 */
function communityCoreKeys(community: Community): StreamKeyView[] {
  const keys: StreamKeyView[] = [...controlGroups(community)];
  for (const r of community.heldRoots) {
    keys.push(guestbookGroupKey(r.key, community.id, r.epoch));
  }
  keys.push(dissolvedGroupKey(community.id));
  keys.push(baseRekeyGroupKey(community.root, community.id, community.rootEpoch + 1n));
  // Each held Private Channel's next-epoch rekey address under every held root
  // (a refound seals channel rekeys under the PRIOR root, CORD-06 §3), so
  // useChannelRekeyWatch can see a rotation on auth-gating relays.
  for (const r of community.heldRoots) {
    for (const ch of community.privateChannels) {
      // The same window useChannelRekeyWatch polls, for catching up missed rotations.
      for (let ahead = 1n; ahead <= BigInt(CHANNEL_REKEY_LOOKAHEAD); ahead++) {
        keys.push(channelRekeyGroupKey(r.key, ch.id, ch.epoch + ahead));
      }
    }
  }
  return keys;
}

/** Every per-channel stream key across held epochs (public + held private). */
function channelKeys(channels: Channel[]): GroupKey[] {
  return channels.flatMap((c) => signingStreams(c));
}

/**
 * Register core stream keys for EVERY live community; mounted in the app shell,
 * since the control fold can't read until these are registered.
 *
 * Also registers per-channel keys from each persisted fold — for COVERAGE, not
 * auth: WireSync's kind-1059 sub filters on `authors: [...streamPubkeys()]`, so
 * channels receive live wraps only once registered. Polls for folds landing later.
 */
export function useRegisterAllStreamKeys(): void {
  const communities = useLiveCommunities();

  useEffect(() => {
    if (communities.length === 0) return;
    let cancelled = false;

    const register = async () => {
      // Register in one burst: one AUTH wave per relay.
      const batches: Array<{ keys: StreamKeyView[]; relays: string[]; idHex: string }> = [];
      for (const entry of communities) {
        const community = rehydrateCommunity(entry);
        if (!community) continue;
        const keys: StreamKeyView[] = communityCoreKeys(community);
        // Absent on a never-synced community; core keys alone until it folds.
        try {
          const folded = await readControlFold(community.idHex);
          for (const channel of channelsView(community, folded)) {
            keys.push(...channel.streams.map((s) => s.group));
          }
        } catch {
          // No fold yet; a later poll picks up its channels.
        }
        batches.push({ keys, relays: community.relays, idHex: community.idHex });
      }
      if (cancelled) return;
      for (const batch of batches) {
        // Scoped to the community's relays, so each relay's challenge signs only its keys.
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
    // A fold write means channel keys just became derivable: re-register on it
    // (debounced) rather than waiting out the poll, which delayed auth-gated
    // catch-up by ~10s. The 20s tick remains a backstop.
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

/** Register the open community's per-channel stream keys as the fold names them. */
export function useRegisterChannelStreamKeys(communityId: string | undefined): void {
  const community = useCommunity(communityId);
  const channels = useChannels(community);

  useEffect(() => {
    if (channels.length === 0 || !community) return;
    registerStreamKeys(channelKeys(channels), community.relays);
  }, [channels, community]);
}
