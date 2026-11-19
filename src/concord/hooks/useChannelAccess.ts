/**
 * Collect Private Channel keys owed to this member on the Channels' access planes
 * (CORD-03 §5), on the vsk-13 Roster: a Role, overwrite or sync lets a member in,
 * and any key holder delivers the key. Only Channels the fold says this member is
 * entitled to and holds no key for are watched; later rotations are the rekey
 * watcher's.
 */

import { noteRefused, refusedBefore } from "@/concord/lib/blobOnce";
import type { NostrEvent, NostrFilter, NPool } from "@nostrify/nostrify";
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
import { sweepControl, whenAuthSettled } from "@/concord/lib/planeSync";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import { peekPendingWraps } from "@/concord/lib/rumorStore";
import { openWrap, openWrapsBatched } from "@/concord/lib/stream";
import { verifyEventsOnce } from "@/lib/verifyCache";
import { ecVerifyBatch } from "@/lib/verifyPool";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { nowSecs } from "@/lib/relayClock";
import { logSync } from "@/lib/syncLog";
import { majorityOf, quorum, rereadOnBackoff } from "@/concord/lib/quorum";
import { useWireScopes } from "@/wire/useWireScopes";
import { setWatched } from "@/wire/watched";
import { authoritySig } from "@/concord/lib/accessDuty";
import { useCoalescedRefetch } from "@/concord/hooks/useCoalescedRefetch";
import { useNewlyOwed, useOwedReread } from "@/concord/hooks/useOwedReread";

/** The least time between two Control Plane reads a stray delivery asks for. */
const FRESHEN_GAP_MS = 3_000;

/** Pages of one access plane read per relay, and their size (Vector `plane_wraps_paged`: 6×200). */
const ACCESS_PAGES = 6;
const ACCESS_PAGE = 200;
/** Limit for the one wide ask that drains a same-second wall (as the plane sweeps' `wallPage`). */
const ACCESS_WALL = 10_000;
/**
 * Per-page deadline, as generous as the plane sweeps' (Tor, a busy phone: the page's
 * EOSE queues behind every event the socket delivered before it).
 */
const PLANE_PAGE_TIMEOUT_MS = 25_000;
/** How long a read waits for a majority once one relay has answered: past a page's timeout. */
export const ACCESS_QUORUM_GRACE_MS = PLANE_PAGE_TIMEOUT_MS + 5_000;

/**
 * A relay's plane wraps already read this session. Planes are re-read on a minute's
 * timer by several hooks and a wrap never changes, so a plane read whole in the last
 * {@link ACCESS_FULL_READ_MS} is read again only from {@link ACCESS_OVERLAP_SECS}
 * before the last read began (publisher clock skew; CORD-01 forbids backdating).
 */
const ACCESS_FULL_READ_MS = 6 * 60 * 60_000;
const ACCESS_OVERLAP_SECS = 3600;
const planeReads = new Map<string, { fullAt: number; readAt: number; wraps: Map<string, NostrEvent> }>();

/**
 * Each held wrap's opening, keyed by the wrap OBJECT `planeReads` holds, so a re-read
 * reopens only what's new; `null` for one that doesn't open. Lives as long as the wrap.
 */
const openedPlaneWraps = new WeakMap<NostrEvent, ReturnType<typeof openWrap> | null>();
/** Max unbroken decrypt time before yielding (as `openPlaneWrapsChunked`). */
const OPEN_SLICE_MS = 5;

/** Forget the access-plane wraps read this session. Logout. */
export function clearAccessPlaneMemory(): void {
  planeReads.clear();
  planeReadsInFlight.clear();
}

/**
 * One page off one relay that THROWS on a CLOSED (auth-required, rate-limited) or a
 * timeout, where `query` would answer an empty page.
 */
export function queryRelayStrict(nostr: NPool, url: string, filter: NostrFilter, signal: AbortSignal): Promise<NostrEvent[]> {
  const relay = nostr.relay(url) as ReturnType<NPool["relay"]> & {
    queryStrict?: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  };
  const opts = { signal: AbortSignal.any([signal, AbortSignal.timeout(PLANE_PAGE_TIMEOUT_MS)]) };
  return relay.queryStrict ? relay.queryStrict([filter], opts) : relay.query([filter], opts);
}

/** Plane reads in flight, by `url|pk`: every hook re-reading a plane shares one. */
const planeReadsInFlight = new Map<string, Promise<NostrEvent[]>>();
/** Planes read at once off one relay. */
const PLANES_AT_ONCE = 4;

function readPlaneFrom(nostr: NPool, url: string, pk: string): Promise<NostrEvent[]> {
  const key = `${url}|${pk}`;
  let read = planeReadsInFlight.get(key);
  if (!read) {
    // No caller's signal: one caller leaving must not fail the read for the rest.
    read = readPlaneNow(nostr, url, pk).finally(() => planeReadsInFlight.delete(key));
    planeReadsInFlight.set(key, read);
  }
  return read;
}

/**
 * One access plane off one relay, newest first (Vector `plane_wraps_paged`), each plane
 * on its own so one plane's flood can't hide another's deliveries. `until` is inclusive
 * and a page with nothing new is a same-second wall, drained in one wide ask, so a burst
 * sharing a second (a delivery and its history do) can't push the rest of that second
 * past the next page. A page the relay didn't answer (an error, a CLOSED) throws: it
 * must not read as the plane's end.
 */
async function readPlaneNow(nostr: NPool, url: string, pk: string): Promise<NostrEvent[]> {
  const key = `${url}|${pk}`;
  const held = planeReads.get(key);
  const now = Date.now();
  const delta = held && now - held.fullAt < ACCESS_FULL_READ_MS ? held : undefined;
  const since = delta ? delta.readAt - ACCESS_OVERLAP_SECS : undefined;
  const readAt = nowSecs();
  const never = new AbortController().signal;
  const ask = (bounds: { limit: number; until?: number; since?: number }) =>
    queryRelayStrict(nostr, url, { kinds: [KIND_WRAP], authors: [pk], ...(since !== undefined ? { since } : {}), ...bounds }, never);
  const fresh = new Map<string, NostrEvent>();
  const take = (got: NostrEvent[]) => {
    let added = 0;
    for (const e of got) {
      if (fresh.has(e.id)) continue;
      fresh.set(e.id, e);
      added++;
    }
    return added;
  };

  let until: number | undefined;
  for (let page = 0; page < ACCESS_PAGES; page++) {
    const got = await ask({ limit: ACCESS_PAGE, ...(until !== undefined ? { until } : {}) });
    const added = take(got);
    if (got.length < ACCESS_PAGE) break;
    if (added === 0 && until !== undefined) {
      take(await ask({ limit: ACCESS_WALL, since: Math.max(until, since ?? 0), until }));
      until -= 1;
      continue;
    }
    until = Math.min(...got.map((e) => e.created_at));
  }

  const wraps = delta?.wraps ?? new Map<string, NostrEvent>();
  // A wrap already held keeps its object, and so its opening.
  for (const [id, e] of fresh) if (!wraps.has(id)) wraps.set(id, e);
  planeReads.set(key, { fullAt: delta?.fullAt ?? now, readAt, wraps });
  return [...wraps.values()];
}

/** `pks` off one relay, a few at a time; throws if any plane went unread. */
async function readPlanesFrom(nostr: NPool, url: string, pks: string[], signal: AbortSignal): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  const queue = [...pks];
  const worker = async () => {
    for (let pk = queue.shift(); pk !== undefined; pk = queue.shift()) {
      if (signal.aborted) throw signal.reason;
      out.push(...(await readPlaneFrom(nostr, url, pk)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLANES_AT_ONCE, queue.length) }, worker));
  return out;
}

/**
 * Every delivery wrap on the access planes of `channelIds`, opened, each plane paged per
 * relay since any root holder can write a plane and bury one page (Vector
 * `fetch_plane_deliveries`). Throws when no relay read the planes: an unread plane is
 * not an empty one, and the duties deliver to whoever a read finds unserved.
 */
export async function readAccessPlanes(
  nostr: NPool,
  community: Community,
  channelIds: readonly string[],
  signal: AbortSignal,
): Promise<Array<{ channelIdHex: string; opened: ReturnType<typeof openWrap> }>> {
  const planes = new Map(channelIds.map((id) => [accessPlane(community, hex32(id)).pk, { id, plane: accessPlane(community, hex32(id)) }]));
  const groups = [...planes.values()].map((p) => p.plane);
  // On an auth-gating relay a plane is read AS the plane key (Vector `fetch_plane`).
  registerStreamKeys(groups, community.relays);
  const results = await quorum(
    community.relays.map(async (url) => {
      await whenAuthSettled(url, () => groups);
      return readPlanesFrom(nostr, url, [...planes.keys()], signal);
    }),
    ACCESS_QUORUM_GRACE_MS,
  );
  // The relay that answers first is often the one holding nothing: absence is only
  // evidence once a majority has read the planes to their end.
  const answered = results.filter((r) => r !== undefined).length;
  if (planes.size > 0 && answered < majorityOf(community.relays.length)) {
    throw new Error(`access planes read on ${answered} of ${community.relays.length} relay(s)`);
  }
  const out: Array<{ channelIdHex: string; opened: ReturnType<typeof openWrap> }> = [];
  const seen = new Set<string>();
  const listed: Array<{ wrap: NostrEvent; at: { id: string; plane: ReturnType<typeof accessPlane> } }> = [];
  for (const wrap of results.flatMap((r) => r ?? [])) {
    if (seen.has(wrap.id)) continue;
    seen.add(wrap.id);
    const at = planes.get(wrap.pubkey);
    if (at) listed.push({ wrap, at });
  }
  // Only wraps not opened before; a flooded plane is thousands, and their seals verify in one batch.
  const fresh = listed.filter(({ wrap }) => !openedPlaneWraps.has(wrap));
  const opened = await openWrapsBatched(fresh.map(({ wrap, at }) => ({ wrap, stream: at.plane })), (seals) => verifyEventsOnce(seals, ecVerifyBatch), OPEN_SLICE_MS);
  fresh.forEach(({ wrap }, i) => openedPlaneWraps.set(wrap, opened[i] ?? null));
  for (const { wrap, at } of listed) {
    const o = openedPlaneWraps.get(wrap);
    if (o) out.push({ channelIdHex: at.id, opened: { ...o } });
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
