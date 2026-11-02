import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useDeferredFold } from "@/concord/hooks/useDeferredFold";
import {
  activePauseOf,
  controlFoldKey,
  currentControlGroup,
  currentControlWriteGroup,
  foldControlState,
  isCurrentFoldedControl,
  isDissolvedOpened,
  openControlEditions,
  pauseHeadOf,
  sealEdition,
  type ActivePause,
  type EntityHead,
  type FoldedControl,
  type FoldedSignal,
} from "@/concord/lib/control";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelsView, visibleChannels } from "@/concord/lib/community";
import { bytesToHex, dissolvedGroupKey, grantLocator, hex32 } from "@/concord/lib/derive";
import type { AuthorityCitation } from "@/concord/lib/edition";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { markControlPlaneStale, openPlaneWraps, mergeOpened, sweepControl } from "@/concord/lib/planeSync";
import { queryPlane, readControlSnapshot, writeOpened } from "@/concord/lib/rumorStore";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { STORE_READ } from "@/lib/storeQuery";
import { openWrap, type OpenedEvent, type StreamSigner } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Channel, Community } from "@/concord/lib/types";
import { logSync } from "@/lib/syncLog";
import { onWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { t } from "@/i18n";

/**
 * The community's Control Plane, read from the opened-event store (wraps are
 * decrypted once at ingest). Holds no sockets and runs no poll: live editions
 * arrive via the wire's `c2ctl` sub, which rings `c2ctl:<idHex>`; unopened
 * communities catch up via {@link syncControlPlane}. The only network here is a
 * single on-open catch-up sweep via {@link sweepControl}. `active` gates that
 * sweep, not the local read.
 */
interface ControlSeedEntry {
  refs: number;
  teardown: () => void;
}

/**
 * One refcounted store-seed per (queryClient, community, epochSig).
 * WeakMap-keyed so test clients never share runners.
 */
const controlSeedRegistries = new WeakMap<QueryClient, Map<string, ControlSeedEntry>>();

function acquireControlSeed(
  queryClient: QueryClient,
  community: Community,
  epochSig: string,
  queryKey: readonly unknown[],
): () => void {
  let registry = controlSeedRegistries.get(queryClient);
  if (!registry) {
    registry = new Map();
    controlSeedRegistries.set(queryClient, registry);
  }
  const key = `${community.idHex}|${epochSig}`;
  const existing = registry.get(key);
  if (existing) {
    existing.refs++;
    return () => releaseControlSeed(registry, key);
  }

  let cancelled = false;
  const seed = async (merge: boolean) => {
    if (!merge && (queryClient.getQueryData<OpenedEvent[]>(queryKey)?.length ?? 0) > 0) return;
    const cached = await queryPlane(community.idHex, "control");
    if (cancelled) return;
    logSync(
      "control",
      `${community.idHex.slice(0, 8)} store seed${merge ? " (bus re-seed)" : ""}: ${cached.length} opened edition(s)`,
    );
    if (cached.length === 0) return;
    queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) =>
      merge ? mergeOpened(old ?? [], cached) : old && old.length > 0 ? old : cached,
    );
  };
  void seed(false);
  const scope = `c2ctl:${community.idHex}`;
  const unsubscribe = onWireScopes((scopes) => {
    if (scopes.has(scope)) void seed(true);
  });
  registry.set(key, {
    refs: 1,
    teardown: () => {
      cancelled = true;
      unsubscribe();
    },
  });
  return () => releaseControlSeed(registry, key);
}

function releaseControlSeed(registry: Map<string, ControlSeedEntry>, key: string): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.teardown();
    registry.delete(key);
  }
}

export function useControlEvents(community: Community | undefined, active = true) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const cidHex = community?.idHex ?? null;
  const epochSig = community?.heldRoots.map((r) => r.epoch.toString()).join(",") ?? "";
  const queryKey = ["concord", "control", cidHex, epochSig] as const;

  // Seed from the opened-event cache and re-seed on the `c2ctl:<id>` bus (the only
  // wake-up for an inactive rail button). Refcounted to ONE runner per key, since
  // ~20 copies of this hook mount per open community.
  useEffect(() => {
    if (!community) return;
    return acquireControlSeed(queryClient, community, epochSig, queryKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cidHex, epochSig, queryClient]);

  // On-open catch-up: ONE shared, single-flight, cursor-gated sweep when the
  // community becomes active, so editions missed while the live sub was down
  // surface promptly. Results wake the seed effect via `c2ctl:<id>`.
  useEffect(() => {
    if (!community || !active) return;
    let cancelled = false;
    void sweepControl(nostr, community, {
      onFresh: (fresh) => {
        if (cancelled || fresh.length === 0) return;
        queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], fresh));
      },
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, cidHex, epochSig, active]);

  return useQuery<OpenedEvent[]>({
    queryKey,
    ...STORE_READ,
    enabled: Boolean(community) && active,
    // Push-updated, so staleness refetches would only re-read the same rows (and
    // schedule a timer per mounted observer).
    staleTime: Infinity,
    queryFn: async () => {
      const stored = await queryPlane(community!.idHex, "control");
      const prev = queryClient.getQueryData<OpenedEvent[]>(queryKey) ?? [];
      return mergeOpened(prev, stored);
    },
  });
}

/**
 * The rumor ids that arrived under the community's CURRENT control stream.
 * Compaction re-wraps editions verbatim under the new epoch (CORD-06 §3), so
 * only the wrap knows; `writeOpened` records it at ingest. Refounded
 * communities only; refetched on the `c2ctl:<id>` bus.
 */
function useControlSnapshot(community: Community | undefined, active: boolean) {
  const queryClient = useQueryClient();
  const cidHex = community?.idHex ?? null;
  const curPk = community ? currentControlGroup(community).pk : "";
  const refounded = Boolean(community && community.rootEpoch > 0n);
  const queryKey = useMemo(
    () => ["concord", "control-snapshot", cidHex, curPk] as const,
    [cidHex, curPk],
  );

  useEffect(() => {
    if (!cidHex || !refounded) return;
    const scope = `c2ctl:${cidHex}`;
    return onWireScopes((scopes) => {
      if (scopes.has(scope)) void queryClient.invalidateQueries({ queryKey });
    });
  }, [cidHex, refounded, queryClient, queryKey]);

  return useQuery<string[]>({
    queryKey,
    // Gates the fold for a Refounded community.
    ...STORE_READ,
    enabled: refounded && active && Boolean(cidHex),
    staleTime: Infinity,
    queryFn: async () => [...((await readControlSnapshot(cidHex!, curPk)) ?? [])],
  });
}

/**
 * Per-entity high-water floors (CORD-04 §1), one map per (community, epoch).
 * Shared across all fold instances so they agree on floors and hence on one
 * memoized fold. Keyed by epoch so a rekey re-baselines against the new
 * compacted snapshot.
 */
const foldFloors = new Map<string, Map<string, EntityHead>>();

/**
 * The floor map for the community's current epoch. Creating one drops the
 * community's older epochs: a rekey re-baselines, so their floors are dead.
 */
function floorsFor(community: Community): Map<string, EntityHead> {
  const floorKey = `${community.idHex}@${community.rootEpoch}`;
  let floorHeads = foldFloors.get(floorKey);
  if (floorHeads) return floorHeads;
  const prefix = `${community.idHex}@`;
  for (const k of foldFloors.keys()) {
    if (k.startsWith(prefix) && BigInt(k.slice(prefix.length)) < community.rootEpoch) foldFloors.delete(k);
  }
  floorHeads = new Map();
  foldFloors.set(floorKey, floorHeads);
  return floorHeads;
}

/** Forget every floor map and cached live pause (decrypted control state). Logout. */
export function clearControlPlaneMemory(): void {
  foldFloors.clear();
  livePauseCache.clear();
}

/** The last fold per shared opened-events array, so instances 2..N reuse it. */
const foldByInputs = new WeakMap<
  OpenedEvent[],
  { idHex: string; rootEpoch: bigint; snapIds: string[] | undefined; folded: FoldedControl }
>();

/**
 * The Control Plane replayed into current state (roster, metadata, channels,
 * banlist, registries). Folded off the render path with a persisted snapshot.
 */
export function useControlFold(community: Community | undefined, active = true) {
  const control = useControlEvents(community, active);
  const events = control.data;
  const refounded = Boolean(community && community.rootEpoch > 0n);
  const snapIds = useControlSnapshot(community, active).data;

  const data = useDeferredFold<FoldedControl>(
    community ? controlFoldKey(community.idHex) : null,
    () => {
      if (!community || !events) return undefined;
      // A Refounded community anchors on its snapshot; wait for it rather than
      // folding twice with disagreeing outranking.
      if (refounded && !snapIds) return undefined;
      // Fold whatever has arrived: the plane is procedural, and waiting for "proven
      // complete" would be a lockup switch anyone could trigger by inflating it. The
      // defenses are monotonic per-entity floors and `incomplete` (which the
      // Refounding path aborts on).
      // Share another instance's fold of this exact events array.
      const shared = foldByInputs.get(events);
      if (
        shared &&
        shared.idHex === community.idHex &&
        shared.rootEpoch === community.rootEpoch &&
        shared.snapIds === snapIds
      ) {
        return shared.folded;
      }
      const floorHeads = floorsFor(community);
      const editions = openControlEditions(events);
      // After a Refounding, current-epoch editions fold by version-anchored bootstrap
      // (see headCandidates); never-rotated communities keep chain contiguity.
      const snapshotIds = refounded && snapIds ? new Set(snapIds) : undefined;
      const folded = foldControlState(editions, community.id, community.owner, floorHeads, snapshotIds);
      for (const [eid, head] of folded.heads) {
        const prior = floorHeads.get(eid);
        if (!prior || head.version > prior.version) floorHeads.set(eid, head);
      }
      foldByInputs.set(events, { idHex: community.idHex, rootEpoch: community.rootEpoch, snapIds, folded });
      // A floored entity the served editions can't account for means an edition below
      // the delta floor never arrived; drop floors so the next sweep re-asks in full.
      if (folded.incomplete.length > 0) markControlPlaneStale(community);
      logSync(
        "fold",
        `${community.idHex.slice(0, 8)}: ${events.length} opened → ${editions.length} edition(s); name=${folded.metadata?.name ?? "∅"} icon=${folded.metadata?.icon ? "yes" : "no"} channels=${folded.channels.size} banned=${folded.banned.size} heads=${folded.heads.size}`,
      );
      return folded;
    },
    [community, events, refounded, snapIds],
    isCurrentFoldedControl,
  );

  return { ...control, data } as typeof control & { data: FoldedControl | undefined };
}

/**
 * Per-community control-plane revision, bumped by the `c2ctl:<id>` bus, so
 * {@link readLivePause} re-folds only communities whose plane changed.
 */
const controlPlaneRev = new Map<string, number>();
/** The last pause head folded per community, with the revision it came from. */
const livePauseCache = new Map<string, { rev: number; epoch: bigint; head: FoldedSignal | undefined }>();
let pauseBusWired = false;

function wirePauseBus(): void {
  if (pauseBusWired) return;
  pauseBusWired = true;
  onWireScopes((scopes) => {
    for (const s of scopes) {
      if (!s.startsWith("c2ctl:")) continue;
      const idHex = s.slice("c2ctl:".length);
      controlPlaneRev.set(idHex, (controlPlaneRev.get(idHex) ?? 0) + 1);
    }
  });
}

/**
 * The CURRENT pause (CORD-04 §8) for a possibly-unopened community. The persisted
 * fold may be hours stale for a background community, so this folds the store's
 * editions directly — as {@link useControlFold} does, since this gates the chat
 * wire and push:
 *
 *   - anchored on the compaction snapshot for a Refounded community; without it,
 *     fail OPEN ("not paused") — a wrongly-frozen room costs more than bandwidth;
 *   - floored by (and RAISING) the shared per-entity high-water marks, so a stale
 *     `paused: true` can't re-freeze the room after a lift.
 *
 * Cached on the community's control-plane revision.
 */
export async function readLivePause(community: Community, nowSec: number): Promise<ActivePause | undefined> {
  wirePauseBus();
  const rev = controlPlaneRev.get(community.idHex) ?? 0;
  const cached = livePauseCache.get(community.idHex);
  if (cached && cached.rev === rev && cached.epoch === community.rootEpoch) {
    return activePauseOf(cached.head, nowSec);
  }

  const refounded = community.rootEpoch > 0n;
  const snapIds = refounded
    ? await readControlSnapshot(community.idHex, currentControlGroup(community).pk)
    : undefined;
  if (refounded && !snapIds) return undefined; // fail open — see above
  const stored = await queryPlane(community.idHex, "control");

  const floorHeads = floorsFor(community);
  const folded = foldControlState(
    openControlEditions(stored),
    community.id,
    community.owner,
    floorHeads,
    snapIds ? new Set(snapIds) : undefined,
  );
  for (const [eid, head] of folded.heads) {
    const prior = floorHeads.get(eid);
    if (!prior || head.version > prior.version) floorHeads.set(eid, head);
  }

  const head = pauseHeadOf(folded);
  livePauseCache.set(community.idHex, { rev, epoch: community.rootEpoch, head });
  return activePauseOf(head, nowSec);
}

/** The channels the member can read, assembled from the fold + held keys. */
export function useChannels(community: Community | undefined, active = true): Channel[] {
  const { data: folded } = useControlFold(community, active);
  const { user } = useCurrentUser();
  const viewer = user?.pubkey;
  return useMemo(
    () => (community ? visibleChannels(channelsView(community, folded), folded, viewer) : []),
    [community, folded, viewer],
  );
}

/** Persisted-forever marker for a community we have seen a valid tombstone for. */
const dissolvedKey = (idHex: string) => `concord2-dissolved:${idHex}`;

/**
 * Session memo of known-dissolved communities (idHex → tombstone ms), so a
 * remount answers synchronously.
 */
const dissolvedMemo = new Map<string, number>();
/** Communities {@link dissolvedAt} found no tombstone for, this session. */
const aliveMemo = new Set<string>();

/** Record a community as dissolved. Terminal and one-way (CORD-02 §9): never cleared. */
async function rememberDissolved(idHex: string, atMs: number): Promise<void> {
  if (dissolvedMemo.get(idHex) === atMs) return;
  dissolvedMemo.set(idHex, atMs);
  await writeFolded(dissolvedKey(idHex), atMs);
}

/** Test seam: forget the session memo, leaving only the persisted verdict. */
export function _forgetDissolvedMemoForTests(): void {
  dissolvedMemo.clear();
  aliveMemo.clear();
  recentGraveProbes.clear();
}

/**
 * Mark a community dissolved locally, for the client that just PUBLISHED the
 * tombstone, so its page flips read-only at once (CORD-02 §9).
 */
export async function markDissolvedLocally(
  queryClient: QueryClient,
  idHex: string,
  atMs: number,
): Promise<void> {
  await rememberDissolved(idHex, atMs);
  queryClient.setQueryData<number | null>(["concord", "dissolved", idHex], atMs);
}

/** What the dissolved probe needs of the Nostr client. */
interface ProbeNostr {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/**
 * Pending dissolved-address probes per relay. Each community's address is a
 * distinct pubkey no batcher can merge, so a boot burst is collected into one
 * multi-filter REQ per relay (per-address `limit` isolation kept); results demux
 * by wrap author.
 */
const dissolvedProbes = new Map<string, Map<string, Array<ProbeWaiter>>>();
const dissolvedProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Filters per probe REQ; relays cap a REQ's filters, and closing one past it fails them all. */
const DISSOLVED_PROBE_FILTERS = 16;

interface ProbeWaiter {
  resolve: (events: NostrEvent[]) => void;
  reject: (error: unknown) => void;
}

/**
 * The wraps at `pk`'s dissolved address on `url`. Rejects when the relay didn't
 * answer ("no answer" ≠ "no grave").
 */
function probeDissolved(nostr: ProbeNostr, url: string, pk: string): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    let byPk = dissolvedProbes.get(url);
    if (!byPk) {
      byPk = new Map();
      dissolvedProbes.set(url, byPk);
    }
    const waiters = byPk.get(pk) ?? [];
    waiters.push({ resolve, reject });
    byPk.set(pk, waiters);
    if (!dissolvedProbeTimers.has(url)) {
      dissolvedProbeTimers.set(url, setTimeout(() => void flushDissolvedProbes(nostr, url), 50));
    }
  });
}

async function flushDissolvedProbes(nostr: ProbeNostr, url: string): Promise<void> {
  dissolvedProbeTimers.delete(url);
  const byPk = dissolvedProbes.get(url);
  dissolvedProbes.delete(url);
  if (!byPk) return;

  const pks = [...byPk.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < pks.length; i += DISSOLVED_PROBE_FILTERS) chunks.push(pks.slice(i, i + DISSOLVED_PROBE_FILTERS));
  await Promise.all(chunks.map(async (chunk) => {
    let events: NostrEvent[];
    try {
      events = await nostr.relay(url).query(
        chunk.map((pk) => ({ kinds: [KIND_WRAP], authors: [pk], limit: 10 })),
        { signal: AbortSignal.timeout(8000) },
      );
    } catch (error) {
      for (const pk of chunk) for (const { reject } of byPk.get(pk)!) reject(error);
      return;
    }
    for (const pk of chunk) {
      const mine = events.filter((event) => event.pubkey === pk);
      for (const { resolve } of byPk.get(pk)!) resolve(mine);
    }
  }));
}

/**
 * The tombstone ms for a community we have EVER seen dissolved. Local only; used
 * by the wire to drop dead subscriptions and by the send path to refuse writes.
 */
export async function dissolvedAt(idHex: string): Promise<number | undefined> {
  const memo = dissolvedMemo.get(idHex);
  if (memo !== undefined) return memo;
  // "Alive" is memoized too (~37 store round-trips per community switch on
  // Android otherwise); only the tombstone path writes, and it updates the memo.
  if (aliveMemo.has(idHex)) return undefined;
  const stored = await readFolded<number>(dissolvedKey(idHex));
  if (typeof stored === "number") {
    dissolvedMemo.set(idHex, stored);
    return stored;
  }
  aliveMemo.add(idHex);
  return undefined;
}

/**
 * The tombstone ms for a community known only by its public identity (id, owner,
 * relays — what an invite bundle gives a non-member): the dissolved address
 * derives from the id alone (CORD-02 §9); the owner's seal and `eid` binding
 * authenticate it. Used by Discover and the join chain; writes no plane tenant.
 *
 * Answers on the first valid grave, else within `budgetMs`. A late grave is
 * still remembered. A "not found" is reused for {@link GRAVE_PROBE_REUSE_MS},
 * only for the same owner + relay set and only if some relay answered.
 */
export async function probeCommunityDissolved(
  nostr: ProbeNostr,
  target: { communityId: string; owner: string; relays: string[] },
  opts?: { budgetMs?: number },
): Promise<number | undefined> {
  // Lowercased: the persisted marker is keyed by lowercase `idHex`.
  const communityId = target.communityId.toLowerCase();
  const owner = target.owner.toLowerCase();
  const known = await dissolvedAt(communityId);
  if (known !== undefined) return known;
  const probeKey = `${communityId}|${owner}|${[...new Set(target.relays)].sort().join(",")}`;
  const recent = recentGraveProbes.get(probeKey);
  if (recent && Date.now() - recent.at < GRAVE_PROBE_REUSE_MS) return recent.result;
  let id: Uint8Array;
  try {
    id = hex32(communityId);
  } catch {
    return undefined;
  }
  const entry = {
    at: Date.now(),
    result: raceForGrave(nostr, communityId, owner, id, target.relays, opts?.budgetMs ?? GRAVE_PROBE_BUDGET_MS).then(
      ({ at, answered }) => {
        // Kept past in-flight only as a verdict some relay gave.
        if (at === undefined && !answered && recentGraveProbes.get(probeKey) === entry) {
          recentGraveProbes.delete(probeKey);
        }
        return at;
      },
    ),
  };
  recentGraveProbes.set(probeKey, entry);
  return entry.result;
}

/** How long a public-identity probe may hold its caller before answering "not found". */
const GRAVE_PROBE_BUDGET_MS = 4000;
/** How long a "not found" probe answers for the same community again. */
const GRAVE_PROBE_REUSE_MS = 60_000;
/** In-flight or recent public-identity probes, per `communityId|owner|sorted relays`. */
const recentGraveProbes = new Map<string, { at: number; result: Promise<number | undefined> }>();

function raceForGrave(
  nostr: ProbeNostr,
  communityId: string,
  owner: string,
  id: Uint8Array,
  relays: string[],
  budgetMs: number,
): Promise<{ at: number | undefined; answered: boolean }> {
  const group = dissolvedGroupKey(id);
  return new Promise((resolve) => {
    let settled = false;
    let pending = relays.length;
    /** Whether any relay answered (EOSE) before the verdict was given. */
    let answered = false;
    const finish = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ at: value, answered });
    };
    const timer = setTimeout(() => finish(undefined), budgetMs);
    if (pending === 0) finish(undefined);
    for (const url of relays) {
      void probeDissolved(nostr, url, group.pk)
        .then(
          (wraps) => {
            answered = true;
            return wraps;
          },
          () => [] as NostrEvent[],
        )
        .then(async (wraps) => {
          for (const wrap of wraps) {
            let opened: OpenedEvent;
            try {
              opened = openWrap(wrap, group);
            } catch {
              continue;
            }
            if (!isDissolvedOpened(opened, owner, id)) continue;
            // Remembered even past the budget: the grave is terminal.
            await rememberDissolved(communityId, opened.ms).catch(() => undefined);
            finish(opened.ms);
            return;
          }
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0) finish(undefined);
        });
    }
  });
}

/**
 * The tombstone's own ms, or `null` while the community lives. STICKY: death is
 * one-way (CORD-02 §9), so once seen it's persisted and a failed round can
 * never resurrect it. A timestamp so callers can judge whether a past action
 * predates the grave. `active` gates the network poll.
 */
export function useDissolved(community: Community | undefined, active = true) {
  const { nostr } = useNostr();
  const idHex = community?.idHex ?? null;

  return useQuery<number | null>({
    queryKey: ["concord", "dissolved", idHex],
    enabled: Boolean(community) && active,
    staleTime: 30_000,
    // Synchronous for a known-dead community, so the composer never flashes live.
    initialData: idHex && dissolvedMemo.has(idHex) ? dissolvedMemo.get(idHex)! : undefined,
    // Rare and terminal: a slow, foreground-only poll suffices.
    refetchInterval: active ? 5 * 60_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      // Known dead → done; never re-derived.
      const known = await dissolvedAt(community!.idHex);
      if (known !== undefined) return known;

      const group = dissolvedGroupKey(community!.id);
      // The grave is a control-kind rumor; `isDissolvedOpened` authenticates it by the
      // SEAL SIGNER being the owner.
      const cached = await queryPlane(community!.idHex, "control");
      const cachedGrave = cached.find((o) => isDissolvedOpened(o, community!.owner, community!.id));
      if (cachedGrave) {
        await rememberDissolved(community!.idHex, cachedGrave.ms);
        return cachedGrave.ms;
      }

      // Via the per-relay collector (see `probeDissolved`).
      const results = await Promise.all(
        community!.relays.map((url) =>
          probeDissolved(nostr, url, group.pk).catch(() => [] as NostrEvent[]),
        ),
      );
      const opened = openPlaneWraps(results.flat(), [group]);
      if (opened.length > 0) {
        writeOpened(community!.idHex, opened, "control", {
          refounded: community!.rootEpoch > 0n,
        });
      }
      const grave = opened.find((o) => isDissolvedOpened(o, community!.owner, community!.id));
      if (!grave) return null;
      await rememberDissolved(community!.idHex, grave.ms);
      return grave.ms;
    },
  });
}

/**
 * Sign (plaintext seal) + wrap + broadcast one edition to the community relays.
 * `opts.relays` overrides the fan-out — a relay-list edition must reach BOTH
 * old and new relays.
 */
/** Sentinel so the store-read try/catch can't swallow the gate's own refusal. */
class DissolvedError extends Error {}

export async function publishEdition(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  signer: StreamSigner,
  rumor: NostrRumor,
  opts?: { relays?: string[] },
): Promise<void> {
  // A dissolved community honors no new authority action (CORD-02 §9); gated here,
  // once, for every edition kind. Local store only; fails OPEN on a store error
  // (matching Vector). Both the persisted marker (the dissolving owner's only
  // record) and the stored plane count.
  try {
    if ((await dissolvedAt(community.idHex)) !== undefined) throw new DissolvedError();
    const cached = await queryPlane(community.idHex, "control");
    if (cached.some((o) => isDissolvedOpened(o, community.owner, community.id))) {
      throw new DissolvedError();
    }
  } catch (e) {
    if (e instanceof DissolvedError) throw new Error(t({ id: "useControlPlane.dissolved", defaultMessage: "This community has been dissolved; it accepts no changes." }));
  }
  // The WRITE key: on a split epoch it's the staff-held control_root (CORD-02 §2);
  // non-staff fail here with a readable error.
  const control = currentControlWriteGroup(community);
  const wrap = await sealEdition(rumor, control, signer);
  const urls = opts?.relays ?? community.relays;
  const attempt = () =>
    Promise.allSettled(urls.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })));
  let results = await attempt();
  // Auth-gating relays refuse stream-authored wraps until the NIP-42 wave
  // re-authenticates the control key; one paced retry outlives it.
  if (
    !results.some((r) => r.status === "fulfilled") &&
    results.some((r) => r.status === "rejected" && /restricted|auth/i.test(String(r.reason instanceof Error ? r.reason.message : r.reason)))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    results = await attempt();
  }
  if (!results.some((r) => r.status === "fulfilled")) {
    if (urls.length === 0) throw new Error(t({ id: "useControlPlane.noRelaysConfigured", defaultMessage: "No relay accepted the change: the community has no relays configured." }));
    const reasons = [
      ...new Set(
        results
          .map((r) => (r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : ""))
          .filter(Boolean),
      ),
    ];
    throw new Error(
      reasons.length
        ? t(
            { id: "useControlPlane.noRelayAcceptedWithReasons", defaultMessage: "No relay accepted the change: {reasons}" },
            { reasons: reasons.slice(0, 2).join("; ") },
          )
        : t({ id: "useControlPlane.noRelayAccepted", defaultMessage: "No relay accepted the change." }),
    );
  }
  // Write our own edition to the store now, so the publisher's fold sees it even
  // if no relay echoes it back (or the `since` cursor skips it).
  try {
    writeOpened(community.idHex, [openWrap(wrap, control)], "control", {
      refounded: community.rootEpoch > 0n,
    });
  } catch {
    // best-effort — the relay echo remains the fallback
  }
}

/**
 * The authority citation for an action (CORD-04 §5): the Grant edition the actor
 * acts under, by coordinate + version + hash. Absent for the owner.
 */
export function citationFor(
  community: Community,
  folded: FoldedControl | undefined,
  actorHex: string,
): AuthorityCitation | undefined {
  if (!folded || actorHex === community.owner) return undefined;
  const eid = grantLocator(community.id, hex32(actorHex));
  const head = folded.heads.get(bytesToHex(eid));
  if (!head) return undefined;
  return { entityId: eid, version: head.version, editionHash: head.hash };
}

/** Invalidate every read that folds from the control plane. */
export function invalidateControl(queryClient: ReturnType<typeof useQueryClient>, idHex: string): void {
  queryClient.invalidateQueries({ queryKey: ["concord", "control", idHex] });
}
