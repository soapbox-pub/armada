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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { accessDeliveryAdmits, accessKeyRefuted, accessPlane, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, hex32 } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { base64ToBytes, decodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { channelPermissions, Permissions } from "@/concord/lib/roles";
import { adoptHistoryDeliveries, heldHistoryViews, historyViewsGeneration, historyViewsReady, parseHistoryDelivery, subscribeHistoryViews } from "@/concord/lib/history";
import { sweepControl } from "@/concord/lib/planeSync";
import { peekPendingWraps } from "@/concord/lib/rumorStore";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { logSync } from "@/lib/syncLog";
import { quorum, rereadOnBackoff } from "@/concord/lib/quorum";
import { useWireScopes } from "@/wire/useWireScopes";
import { setWatched } from "@/wire/watched";
import { authoritySig } from "@/concord/lib/accessDuty";
import { useCoalescedRefetch } from "@/concord/hooks/useCoalescedRefetch";
import { useNewlyOwed, useOwedReread } from "@/concord/hooks/useOwedReread";

/** The least time between two Control Plane reads a stray delivery asks for. */
const FRESHEN_GAP_MS = 3_000;

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
  const results = await quorum(
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
  for (const wrap of results.flatMap((r) => r ?? [])) {
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
  const queryClient = useQueryClient();
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
    // Not paused in the background: Vector's member reads every 60 s whatever has focus.
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    queryFn: ({ signal }) => readAccessPlanes(nostr, community!, owed, signal),
  });
  const refetch = useCoalescedRefetch(query.refetch);

  // Every unheld Private Channel's plane, heard live. A delivery on an owed one wakes the
  // read the moment it lands; one on a plane the fold doesn't owe means a holder saw a
  // Grant this fold hasn't (its live event lost), so the Control Plane is read again and
  // the fold it moves makes the Channel owed.
  const unheld = folded?.rankedRoster
    ? [...folded.channels.values()].filter((c) => c.isPrivate && !c.deleted && !held.has(c.channelIdHex)).map((c) => c.channelIdHex).sort()
    : [];
  const unheldKey = unheld.join(",");
  const planePks = useMemo(
    () => (community ? unheld.map((id) => ({ id, pk: accessPlane(community, hex32(id)).pk, owed: owed.includes(id) })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [community?.idHex, community?.rootEpoch, unheldKey, owedKey],
  );
  useEffect(() => {
    if (!community) return;
    const owner = `access:${community.idHex}`;
    setWatched(owner, community.relays, planePks.map((p) => p.pk));
    return () => setWatched(owner, [], []);
  }, [community, planePks]);
  const lastFreshen = useRef(0);
  const strayHeard = useRef(new Set<string>());
  useWireScopes((scopes) => {
    const landed = planePks.filter((p) => scopes.has(`c2park:${p.pk}`));
    if (landed.some((p) => p.owed)) refetch();
    const stray = landed.filter((p) => !p.owed);
    if (!community || !me || stray.length === 0) return;
    void (async () => {
      // Only a delivery that names me: one to anyone else says nothing about my fold.
      const parked = await peekPendingWraps(stray.map((p) => p.pk)).catch((): NostrEvent[] => []);
      // Once per wrap, and never one older than the Channel's sealed epoch: a relay serving
      // the deliveries of a past entitlement again says nothing new.
      const mine = parked.filter((wrap) => !strayHeard.current.has(wrap.id)).some((wrap) => {
        strayHeard.current.add(wrap.id);
        const at = stray.find((p) => p.pk === wrap.pubkey);
        if (!at) return false;
        try {
          const d = parseDelivery(openWrap(wrap, accessPlane(community, hex32(at.id))));
          const sealed = folded?.channels.get(at.id)?.sealed?.epoch ?? 0n;
          return d?.form === "access" && d.scopeIdHex === at.id && d.newEpoch >= sealed && d.blobs.some((b) => b.locator.toLowerCase() === myLocator(d.deliverer, me, at.id, d.newEpoch));
        } catch {
          return false;
        }
      });
      if (!mine || Date.now() - lastFreshen.current < FRESHEN_GAP_MS) return;
      lastFreshen.current = Date.now();
      logSync("access", `${community.idHex.slice(0, 8)}: a key was delivered to me for a Channel this fold doesn't let me read; reading the Control Plane again`);
      await sweepControl(nostr, community).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ["concord", "control", community.idHex] });
    })();
  });

  // Holders deliver a few seconds after the change that entitled this member: read again
  // on a backoff, as relays drop the live event, and every 10 s for a while after it when
  // a Channel is newly owed. One owed since before mount may never be delivered.
  const authority = folded?.rankedRoster ? authoritySig(folded) : "";
  const owedSig = useNewlyOwed(folded && me ? owed : undefined);
  const lastOwedSig = useRef<string | undefined>(undefined);
  useEffect(() => {
    const newly = lastOwedSig.current !== undefined && owedSig !== lastOwedSig.current;
    if (owedSig !== undefined) lastOwedSig.current = owedSig;
    // A newly owed Channel is the window's below, which starts with the same backoff.
    if (newly || !authority || owed.length === 0) return;
    refetch();
    return rereadOnBackoff(refetch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authority, owedKey, owedSig]);
  // Live wraps on these planes are already watched above.
  useOwedReread({ owner: undefined, relays: [], pks: [], pending: Boolean(authority) && owed.length > 0, sig: owedSig, refetch, onMount: false });

  useEffect(() => {
    if (!community || !folded || !me || !entry || !query.data?.length) return;
    const nip44 = user?.signer.nip44;
    if (!nip44) return;
    let cancelled = false;
    void (async () => {
      const adopted = new Map<string, { key: Uint8Array; epoch: bigint }>();
      const seen: string[] = [];
      for (const { channelIdHex, opened } of query.data!) {
        const d = parseDelivery(opened);
        if (!d || d.form !== "access" || d.scopeIdHex !== channelIdHex) continue;
        // For a Channel this member holds nothing of, the walk starts at the sealed head.
        const sealed = folded.channels.get(channelIdHex)?.sealed;
        const locator = myLocator(d.deliverer, me, channelIdHex, d.newEpoch);
        const blob = d.blobs.find((b) => b.locator.toLowerCase() === locator);
        if (!blob) continue;
        const admits = accessDeliveryAdmits(folded, sealed, channelIdHex, me, d.deliverer, d.newEpoch);
        seen.push(`#${channelIdHex.slice(0, 8)} e${d.newEpoch} (sealed e${sealed?.epoch ?? "-"})${admits ? "" : " not admitted"}`);
        if (!admits) continue;
        const purpose = `access:${channelIdHex}:${d.newEpoch}`;
        if (refusedBefore(purpose, d.deliverer, blob.wrapped)) continue;
        try {
          const plain = await nip44.decrypt(d.deliverer, blob.wrapped);
          const key = decodeWrappedKey(base64ToBytes(plain), hex32(channelIdHex), d.newEpoch);
          if (accessKeyRefuted(sealed, channelIdHex, d.newEpoch, key)) {
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
      if (seen.length > 0) logSync("access", `${community.idHex.slice(0, 8)}: owed ${owed.length}; my blobs: ${seen.join(", ")}`);
      if (cancelled || adopted.size === 0) return;
      const fresh = [...adopted].filter(([id, k]) => !handled.current.has(`${id}:${k.epoch}`));
      if (fresh.length === 0) return;
      logSync("access", `${community.idHex.slice(0, 8)}: adopting ${fresh.map(([id, k]) => `#${id.slice(0, 8)} e${k.epoch}`).join(", ")}`);
      for (const [id, k] of fresh) handled.current.add(`${id}:${k.epoch}`);
      const channels = [...adopted].map(([id, k]) => ({ id, key: bytesToHex(k.key), epoch: Number(k.epoch), name: "" }));
      // Merged at write time, so a key the list gained since `entry` was read survives, and
      // the key a newer epoch replaces stays as a prior.
      await updateList({ type: "refresh-channels", communityId: community.idHex, channels, upsert: true }).catch(() => {
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

  // Holders send history behind the key, so it lands after the read the key started:
  // once a past epoch (they start at 1) goes missing that wasn't before, read just the
  // Channels lacking one again until it arrives.
  const views = useSyncExternalStore(subscribeHistoryViews, historyViewsGeneration);
  const missing = useMemo(() => {
    if (!community) return [];
    return reads.flatMap((id) => {
      const k = heldKeys.find((c) => bytesToHex(c.id) === id);
      if (!k || k.epoch <= 1n) return [];
      const have = new Set([...(k.priors ?? []).map((p) => p.epoch), ...heldHistoryViews(community.idHex, id).map((v) => v.epoch)]);
      const lacks: bigint[] = [];
      for (let e = 1n; e < k.epoch; e++) if (!have.has(e)) lacks.push(e);
      return lacks.length > 0 ? [{ id, lacks }] : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community, readsKey, views]);
  const gaps = missing.map((m) => m.id);
  // An epoch goes missing for the first time on a key landing or a re-add past epochs this
  // member was out for; a rotation moves the old key into the priors and owes nothing new.
  // Kept across root epochs: the main read already follows the planes a rekey moves.
  const historySig = useNewlyOwed(
    community && folded && me ? missing.flatMap(({ id, lacks }) => lacks.map((e) => `${id}:${e}`)) : undefined,
  );
  const gapPks = useMemo(
    () => (community ? gaps.map((id) => accessPlane(community, hex32(id)).pk) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [community?.idHex, community?.rootEpoch, gaps.join(",")],
  );
  const gapsKey = gaps.join(",");
  const gapQuery = useQuery({
    queryKey: ["concord", "history-gaps", community?.idHex ?? null, community?.rootEpoch.toString() ?? null, gapsKey],
    // Read only when the owed reread asks.
    enabled: false,
    queryFn: ({ signal }) => readAccessPlanes(nostr, community!, gaps, signal),
  });
  const refetchGaps = useCoalescedRefetch(gapQuery.refetch);
  useOwedReread({
    owner: community && `history:${community.idHex}`,
    relays: community?.relays ?? [],
    pks: gapPks,
    pending: gaps.length > 0,
    sig: historySig,
    refetch: refetchGaps,
    onMount: false,
  });

  useEffect(() => {
    const nip44 = user?.signer.nip44;
    const data = [...(query.data ?? []), ...(gapQuery.data ?? [])];
    if (!community || !folded || !me || !nip44 || !data.length) return;
    void (async () => {
      await historyViewsReady();
      for (const idHex of reads) {
        const held = heldKeys.find((c) => bytesToHex(c.id) === idHex);
        if (!held) continue;
        const deliveries = data.filter((d) => d.channelIdHex === idHex).flatMap((d) => parseHistoryDelivery(d.opened, idHex) ?? []);
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
  }, [community?.idHex, folded, me, query.data, gapQuery.data]);
}
