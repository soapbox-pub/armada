/**
 * Collect Private Channel keys owed to this member on the Channels' access planes
 * (CORD-03 §5), on the vsk-13 Roster: a Role, overwrite or sync lets a member in,
 * and any key holder delivers the key. Only Channels the fold says this member is
 * entitled to and holds no key for are watched; later rotations are the rekey
 * watcher's.
 */

import type { NostrEvent } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { heldChannelKeys } from "@/concord/lib/communityList";
import { accessPlane, deliveryTrusted, MAX_DELIVERY_EPOCH_AHEAD, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, hex32 } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { base64ToBytes, decodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { channelPermissions, Permissions } from "@/concord/lib/roles";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export function useChannelAccess(community: Community | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const entry = useCommunityEntry(community?.idHex);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const handled = useRef(new Set<string>());

  const me = user?.pubkey;
  const held = new Set((community?.privateChannels ?? []).map((c) => bytesToHex(c.id)));
  // Private Channels the fold lets this member read whose key they don't hold.
  const owed = folded?.rankedRoster && me
    ? [...folded.channels.values()]
        .filter((c) => c.isPrivate && !c.deleted && !held.has(c.channelIdHex))
        .filter((c) => (channelPermissions(folded.roster, folded.ownerHex, me, c.channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n)
        .map((c) => c.channelIdHex)
        .sort()
    : [];
  const owedKey = owed.join(",");

  const query = useQuery({
    queryKey: ["concord", "channel-access", community?.idHex ?? null, community?.rootEpoch.toString() ?? null, owedKey],
    enabled: Boolean(community && owed.length > 0),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const planes = new Map(owed.map((id) => [accessPlane(community!, hex32(id)).pk, { id, plane: accessPlane(community!, hex32(id)) }]));
      const filter = { kinds: [KIND_WRAP], authors: [...planes.keys()], limit: 200 };
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr.relay(url).query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }).catch(() => [] as NostrEvent[]),
        ),
      );
      const out: Array<{ channelIdHex: string; opened: ReturnType<typeof openWrap> }> = [];
      const seen = new Set<string>();
      for (const wrap of results.flat()) {
        if (seen.has(wrap.id)) continue;
        seen.add(wrap.id);
        const at = planes.get(wrap.pubkey);
        if (!at) continue;
        try {
          out.push({ channelIdHex: at.id, opened: openWrap(wrap, at.plane) });
        } catch {
          // not ours / malformed
        }
      }
      return out;
    },
  });

  useEffect(() => {
    if (!community || !folded || !me || !entry || !query.data?.length) return;
    const nip44 = user?.signer.nip44;
    if (!nip44) return;
    let cancelled = false;
    void (async () => {
      const adopted = new Map<string, { key: Uint8Array; epoch: bigint }>();
      for (const { channelIdHex, opened } of query.data!) {
        const d = parseDelivery(opened);
        if (!d || d.form !== "access" || d.scopeIdHex !== channelIdHex) continue;
        if (d.newEpoch > MAX_DELIVERY_EPOCH_AHEAD) continue;
        if (!deliveryTrusted(folded.roster, folded.ownerHex, folded.banned, channelIdHex, me, d.deliverer)) continue;
        const locator = myLocator(d.deliverer, me, channelIdHex, d.newEpoch);
        const blob = d.blobs.find((b) => b.locator.toLowerCase() === locator);
        if (!blob) continue;
        try {
          const plain = await nip44.decrypt(d.deliverer, blob.wrapped);
          const key = decodeWrappedKey(base64ToBytes(plain), hex32(channelIdHex), d.newEpoch);
          const prev = adopted.get(channelIdHex);
          if (!prev || d.newEpoch > prev.epoch) adopted.set(channelIdHex, { key, epoch: d.newEpoch });
        } catch {
          // a blob that won't open is never a verdict
        }
      }
      if (cancelled || adopted.size === 0) return;
      const fresh = [...adopted].filter(([id, k]) => !handled.current.has(`${id}:${k.epoch}`));
      if (fresh.length === 0) return;
      for (const [id, k] of fresh) handled.current.add(`${id}:${k.epoch}`);
      const channels = heldChannelKeys(entry.current.channels).filter((c) => !adopted.has(c.id.toLowerCase()));
      for (const [id, k] of adopted) channels.push({ id, key: bytesToHex(k.key), epoch: Number(k.epoch), name: "" });
      await updateList({ type: "refresh-channels", communityId: community.idHex, channels }).catch(() => {
        for (const [id, k] of fresh) handled.current.delete(`${id}:${k.epoch}`);
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, folded, me, query.data, entry?.added_at]);
}
