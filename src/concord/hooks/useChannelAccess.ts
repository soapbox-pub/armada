/**
 * Collect Private Channel keys owed to this member on the Channels' access planes
 * (CORD-03 §5), on the vsk-13 Roster: a Role, overwrite or sync lets a member in,
 * and any key holder delivers the key. Only Channels the fold says this member is
 * entitled to and holds no key for are watched; later rotations are the rekey
 * watcher's.
 */

import { noteRefused, refusedBefore } from "@/concord/lib/blobOnce";
import type { NostrEvent, NPool } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { heldChannelKeys } from "@/concord/lib/communityList";
import { openChannelSeal } from "@/concord/lib/channelSeal";
import { accessPlane, deliveryTrusted, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, hex32 } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { base64ToBytes, decodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { channelPermissions, isAuthorized, Permissions } from "@/concord/lib/roles";
import { adoptHistoryDeliveries, historyViewsReady, parseHistoryDelivery } from "@/concord/lib/history";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/** Pages of the access plane read per relay, and their size (Vector reads 6×200). */
const ACCESS_PAGES = 6;
const ACCESS_PAGE = 200;

/**
 * Every delivery wrap on the access planes of `channelIds`, opened, paged per relay
 * since any root holder can write a plane and bury one page (Vector `fetch_plane_deliveries`).
 */
export async function readAccessPlanes(
  nostr: NPool,
  community: Community,
  channelIds: readonly string[],
  signal: AbortSignal,
): Promise<Array<{ channelIdHex: string; opened: ReturnType<typeof openWrap> }>> {
  const planes = new Map(channelIds.map((id) => [accessPlane(community, hex32(id)).pk, { id, plane: accessPlane(community, hex32(id)) }]));
  const results = await Promise.all(
    community.relays.map(async (url) => {
      const out: NostrEvent[] = [];
      let until: number | undefined;
      for (let page = 0; page < ACCESS_PAGES; page++) {
        const filter = { kinds: [KIND_WRAP], authors: [...planes.keys()], limit: ACCESS_PAGE, ...(until !== undefined ? { until } : {}) };
        const got = await nostr
          .relay(url)
          .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
          .catch(() => [] as NostrEvent[]);
        out.push(...got);
        if (got.length < ACCESS_PAGE) break;
        const oldest = Math.min(...got.map((e) => e.created_at));
        if (until !== undefined && oldest >= until) break;
        until = oldest - 1;
      }
      return out;
    }),
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
}

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
    queryFn: ({ signal }) => readAccessPlanes(nostr, community!, owed, signal),
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
        // Only the epoch the walk has reached or the one after (CORD-03 §5): for a
        // Channel this member holds nothing of, the sealed head's.
        const sealed = folded.channels.get(channelIdHex)?.sealed;
        const walk = sealed?.epoch ?? 0n;
        if (d.newEpoch < walk || d.newEpoch > walk + 1n) continue;
        if (!deliveryTrusted(folded.roster, folded.ownerHex, folded.banned, channelIdHex, me, d.deliverer)) continue;
        // Nothing authenticates a key past the seal, so only the owner or a manager, who
        // could rotate to a key of their own, is taken at its word; a peer's waits for it.
        if (sealed && d.newEpoch > sealed.epoch && d.deliverer !== folded.ownerHex &&
          !isAuthorized(folded.roster, d.deliverer, folded.ownerHex, Permissions.MANAGE_CHANNELS)) continue;
        const locator = myLocator(d.deliverer, me, channelIdHex, d.newEpoch);
        const blob = d.blobs.find((b) => b.locator.toLowerCase() === locator);
        const purpose = `access:${channelIdHex}:${d.newEpoch}`;
        if (!blob || refusedBefore(purpose, d.deliverer, blob.wrapped)) continue;
        try {
          const plain = await nip44.decrypt(d.deliverer, blob.wrapped);
          const key = decodeWrappedKey(base64ToBytes(plain), hex32(channelIdHex), d.newEpoch);
          // A key at the sealed head's epoch must open it: what authenticates the key.
          const sealed = folded.channels.get(channelIdHex)?.sealed;
          if (sealed && sealed.epoch === d.newEpoch && !openChannelSeal(sealed, { id: hex32(channelIdHex), key, epoch: d.newEpoch, name: "" })) {
            noteRefused(purpose, d.deliverer, blob.wrapped);
            continue;
          }
          const prev = adopted.get(channelIdHex);
          if (!prev || d.newEpoch > prev.epoch) adopted.set(channelIdHex, { key, epoch: d.newEpoch });
        } catch {
          // a blob that won't open is never a verdict
          noteRefused(purpose, d.deliverer, blob.wrapped);
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

/** How often a member re-reads history deliveries when nothing moved (Vector `HISTORY_COLLECT_PERIOD_MS`). */
const HISTORY_COLLECT_MS = 10 * 60_000;

/**
 * Collect the earlier epochs delivered read-only to this member on each Private
 * Channel they hold READ_MESSAGE_HISTORY in (CORD-03 §5, Vector `collect_history`):
 * only from a deliverer the fold lets in, only epochs this device can't read already.
 */
export function useHistoryAccess(community: Community | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const me = user?.pubkey;
  const heldKeys = community?.privateChannels ?? [];
  const reads = folded?.rankedRoster && me
    ? heldKeys
        .map((c) => bytesToHex(c.id))
        .filter((id) => folded.channels.get(id)?.isPrivate && (channelPermissions(folded.roster, folded.ownerHex, me, id, true) & Permissions.READ_MESSAGE_HISTORY) !== 0n)
        .sort()
    : [];
  const readsKey = reads.join(",");

  useEffect(() => void historyViewsReady(), []);
  const query = useQuery({
    queryKey: ["concord", "history-access", community?.idHex ?? null, community?.rootEpoch.toString() ?? null, readsKey],
    enabled: Boolean(community && reads.length > 0),
    staleTime: HISTORY_COLLECT_MS,
    refetchInterval: HISTORY_COLLECT_MS,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => readAccessPlanes(nostr, community!, reads, signal),
  });

  useEffect(() => {
    const nip44 = user?.signer.nip44;
    if (!community || !folded || !me || !nip44 || !query.data?.length) return;
    void (async () => {
      await historyViewsReady();
      for (const idHex of reads) {
        const held = heldKeys.find((c) => bytesToHex(c.id) === idHex);
        if (!held) continue;
        const deliveries = query.data!.filter((d) => d.channelIdHex === idHex).flatMap((d) => parseHistoryDelivery(d.opened, idHex) ?? []);
        if (deliveries.length === 0) continue;
        await adoptHistoryDeliveries(deliveries, {
          communityIdHex: community.idHex,
          channelIdHex: idHex,
          me,
          currentEpoch: held.epoch,
          heldEpochs: new Set((held.priors ?? []).map((p) => p.epoch)),
          trusted: (pk) => pk === folded.ownerHex || (!folded.banned.has(pk) && (channelPermissions(folded.roster, folded.ownerHex, pk, idHex, true) & Permissions.VIEW_CHANNEL) !== 0n),
          decrypt: (pk, wrapped) => nip44.decrypt(pk, wrapped),
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, folded, me, query.data]);
}
