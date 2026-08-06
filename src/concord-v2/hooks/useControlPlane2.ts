import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useDeferredFold } from "@/concord-v2/hooks/useDeferredFold2";
import {
  controlFoldKey,
  currentControlGroup,
  currentControlWriteGroup,
  foldControlState,
  isCurrentFoldedControl,
  isDissolvedOpened,
  openControlEditions,
  sealEdition,
  type EntityHead,
  type FoldedControl,
} from "@/concord-v2/lib/control";
import { channelsView } from "@/concord-v2/lib/community";
import { bytesToHex, dissolvedGroupKey, grantLocator, hex32 } from "@/concord-v2/lib/derive";
import type { AuthorityCitation } from "@/concord-v2/lib/edition";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { markControlPlaneStale, openPlaneWraps, mergeOpened, sweepControl } from "@/concord-v2/lib/planeSync";
import { queryPlane, readControlSnapshot, writeOpened } from "@/concord-v2/lib/rumorStore";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { STORE_READ } from "@/lib/storeQuery";
import { openWrap, type OpenedEvent, type StreamSigner } from "@/concord-v2/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { logSync } from "@/lib/syncLog";
import { onWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Re-exported for the many call sites that reach it through this module. */
export { controlFoldKey };

/**
 * Fetch the community's Control Plane. Wraps are decrypted once into the
 * opened-event store; this query reads back from it with no decrypt. A
 * persisted `since` cursor means editions already seen are never refetched.
 * `active` gates the network fetch, not the local read.
 *
 * NETWORK OWNERSHIP: this hook holds no standing sockets and runs no poll.
 * Live control editions arrive through the wire's standing `c2ctl`
 * subscription (see wire/spec.ts + wire/ingest.ts), which decrypts them into
 * the opened-event store and rings `c2ctl:<idHex>`; the seed effect below
 * re-reads on that bus. The slow catch-up for communities you haven't opened is
 * the global {@link syncControlPlane} sweep (ControlPlaneSync). The only
 * network this hook itself issues is a SINGLE on-open catch-up sweep (shared,
 * single-flight, cursor-gated via {@link sweepControl}) so navigating into a
 * community surfaces anything the live sub missed while offline. The query's
 * `queryFn` is a pure store read — it exists so react-query invalidation (e.g.
 * after publishing an edition) re-folds from the store.
 */
interface ControlSeedEntry {
  refs: number;
  teardown: () => void;
}

/**
 * One live store-seed per (queryClient, community, epochSig) — see the effect
 * in {@link useControlEvents2} for why. WeakMap-keyed by the QueryClient so a
 * test's throwaway client can never share (or leak) a real one's runners.
 */
const controlSeedRegistries = new WeakMap<QueryClient, Map<string, ControlSeedEntry>>();

function acquireControlSeed(
  queryClient: QueryClient,
  community: CommunityV2,
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

export function useControlEvents2(community: CommunityV2 | undefined, active = true) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const cidHex = community?.idHex ?? null;
  const epochSig = community?.heldRoots.map((r) => r.epoch.toString()).join(",") ?? "";
  const queryKey = ["concord2", "control", cidHex, epochSig] as const;

  // Seed from the opened-event cache (paints rail icons without network).
  // Re-seeds on the `c2ctl:<id>` wire bus when the wire's live subscription (or
  // the background sweep) stores new editions — a rail button with active=false
  // can't be reached by invalidation, so the bus is its only wake-up.
  //
  // Refcounted, ONE runner per (queryClient, community, epochSig): ~36 call
  // sites reach this hook through useControlFold2/useChannels2, so opening a
  // community mounts ~20 copies — and every copy used to run its own full
  // queryPlane("control") read on mount and again on every bus ring (a
  // measured boot ran the identical 86-edition read 22 times in 20ms). All
  // copies write the same react-query key, so the first mount does the work
  // and the rest share it; the last unmount tears the listener down.
  useEffect(() => {
    if (!community) return;
    return acquireControlSeed(queryClient, community, epochSig, queryKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cidHex, epochSig, queryClient]);

  // On-open catch-up: when the community becomes active (you navigate into it),
  // run ONE control sweep so an edition published while the live wire sub was
  // down — or since the last 5-min background sweep — surfaces promptly without
  // waiting for the next global tick. This is the shared, single-flight,
  // cursor-gated sweepControl (it coalesces with the background sweep and never
  // re-pays history), NOT a standing socket. Runs once per community-open;
  // liveness thereafter is the wire's `c2ctl` subscription. Freshly-opened
  // events land in the store and wake the seed effect via `c2ctl:<id>`.
  useEffect(() => {
    if (!community || !active) return;
    let cancelled = false;
    void sweepControl(nostr, community, {
      onFresh: (fresh) => {
        if (cancelled || fresh.length === 0) return;
        queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], fresh));
      },
    }).catch(() => {
      // Best-effort — the background sweep and live wire sub cover any miss.
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, cidHex, epochSig, active]);

  return useQuery<OpenedEvent[]>({
    queryKey,
    // A pure store read (the network is the sweep effect above, not this).
    ...STORE_READ,
    enabled: Boolean(community) && active,
    // Push-updated (the seed effect, the sweep's onFresh merge, and
    // invalidateControl2 after a publish): a staleness refetch only re-reads
    // the same rows, while a finite staleTime scheduled a stale timer per
    // mounted observer (~20 per open community, one more per rail button).
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
 *
 * The one thing about a control edition that is NOT in the edition: a
 * compaction re-wraps editions VERBATIM under the new epoch's address (CORD-06
 * §3), so the rumor — and its id — is byte-identical whether or not it is in
 * the snapshot, and only the wrap it arrived in ever knew. `writeOpened`
 * records it at ingest; this reads it back.
 *
 * Only a Refounded community has one. Refetched on the same `c2ctl:<id>` bus
 * that re-seeds the editions, so a re-wrap arriving live anchors the next fold.
 */
function useControlSnapshot2(community: CommunityV2 | undefined, active: boolean) {
  const queryClient = useQueryClient();
  const cidHex = community?.idHex ?? null;
  const curPk = community ? currentControlGroup(community).pk : "";
  const refounded = Boolean(community && community.rootEpoch > 0n);
  const queryKey = useMemo(
    () => ["concord2", "control-snapshot", cidHex, curPk] as const,
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
    // A KV read. It gates the fold for a Refounded community, so a paused or
    // backing-off one is an empty channel list.
    ...STORE_READ,
    enabled: refounded && active && Boolean(cidHex),
    // Push-invalidated on the `c2ctl:<id>` wire scope (effect above).
    staleTime: Infinity,
    queryFn: async () => [...((await readControlSnapshot(cidHex!, curPk)) ?? [])],
  });
}

/**
 * Per-entity high-water floors (CORD-04 §1), one map per (community, epoch).
 *
 * Module-level and SHARED by every mounted fold instance, deliberately. The
 * floor is "the highest version we've ever accepted", so a per-instance ref
 * was both weaker (a fresh mount started at zero and forgot the session's
 * floors) and wasteful: ~20 fold hooks mount per open community, and each
 * one's different floor produced a different `foldControlState` memo key —
 * the identical fold was recomputed and re-logged once per instance per wave.
 * One shared map gives every instance the same floors, the same memo key, and
 * therefore one fold. Keyed by epoch so adopting a rekey still re-baselines
 * (a floor from a superseded founding must not out-anchor the new epoch's
 * compacted snapshot); the within-epoch withholding defense is untouched.
 */
const foldFloors = new Map<string, Map<string, EntityHead>>();

/**
 * The last fold per opened-events array (the react-query data all instances
 * share), so instances 2..N — and re-runs over unchanged inputs — return the
 * shared result without re-deriving editions, re-building the memo key
 * (itself O(n log n) string work per call) or re-logging the fold line.
 */
const foldByInputs = new WeakMap<
  OpenedEvent[],
  { idHex: string; rootEpoch: bigint; snapIds: string[] | undefined; folded: FoldedControl }
>();

/**
 * The Control Plane replayed into current state (roster, metadata, channels,
 * banlist, registries). Folded off the render path with a persisted snapshot.
 */
export function useControlFold2(community: CommunityV2 | undefined, active = true) {
  const control = useControlEvents2(community, active);
  const events = control.data;
  const refounded = Boolean(community && community.rootEpoch > 0n);
  const snapIds = useControlSnapshot2(community, active).data;

  // The shared floor for this (community, epoch) — see `foldFloors`.
  const floorKey = community ? `${community.idHex}@${community.rootEpoch}` : "";
  let floorHeads = foldFloors.get(floorKey);
  if (!floorHeads) {
    floorHeads = new Map();
    foldFloors.set(floorKey, floorHeads);
  }

  const data = useDeferredFold<FoldedControl>(
    community ? controlFoldKey(community.idHex) : null,
    () => {
      if (!community || !events) return undefined;
      // A Refounded community anchors on its compaction snapshot, so wait for
      // it rather than folding once by old-root contiguity and again correctly
      // — the two disagree about which editions outrank which.
      if (refounded && !snapIds) return undefined;
      // Folds whatever has arrived, on purpose. The control plane is
      // procedural: members process editions as they come and converge, and a
      // member who is one sweep behind reads and writes fine — they just don't
      // have the newest metadata, roles and bans yet. Refusing to fold until
      // the plane is "proven complete" would hand any member a lockup switch,
      // since anyone can inflate the plane past any budget. The defenses that
      // matter are local and already here: monotonic per-entity floors (a
      // flood can't downgrade an entity we've advanced past) and `incomplete`
      // (floored entities the served set can't account for), which is what the
      // Refounding path aborts on.
      // Another instance (or a re-run over unchanged inputs) already folded
      // this exact events array: share its result, work and log line included.
      const shared = foldByInputs.get(events);
      if (
        shared &&
        shared.idHex === community.idHex &&
        shared.rootEpoch === community.rootEpoch &&
        shared.snapIds === snapIds
      ) {
        return shared.folded;
      }
      const editions = openControlEditions(events);
      // Once the community has Refounded, editions under the CURRENT epoch's
      // control group fold by version-anchored bootstrap (the compaction
      // snapshot outranks old-root fragments — see headCandidates). A
      // never-rotated community keeps full chain-contiguity semantics.
      const snapshotIds = refounded && snapIds ? new Set(snapIds) : undefined;
      const folded = foldControlState(editions, community.id, community.owner, floorHeads, snapshotIds);
      // Raise the high-water floor from this fold's accepted heads (upward only).
      for (const [eid, head] of folded.heads) {
        const prior = floorHeads.get(eid);
        if (!prior || head.version > prior.version) floorHeads.set(eid, head);
      }
      foldByInputs.set(events, { idHex: community.idHex, rootEpoch: community.rootEpoch, snapIds, folded });
      // A floored entity the served editions can't account for means an
      // edition BELOW the sweep's delta floor never arrived here — only a
      // whole-plane read can heal that, so drop the session floors and let
      // the next sweep (on-open, or the background tick) re-ask full.
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

/** The channels the member can read, assembled from the fold + held keys. */
export function useChannels2(community: CommunityV2 | undefined, active = true): ChannelV2[] {
  const { data: folded } = useControlFold2(community, active);
  return useMemo(() => (community ? channelsView(community, folded) : []), [community, folded]);
}

/**
 * Whether the community has been dissolved by its owner (terminal). Reads the
 * community-id-derived dissolved address — no key, no epoch — so every member
 * past or present resolves the same grave.
 *
 * `active` gates the network poll: the rail doesn't need each community's
 * dissolution status up-front, so it's only checked once you open the community.
 */
/** Persisted-forever marker for a community we have seen a valid tombstone for. */
const dissolvedKey = (idHex: string) => `concord2-dissolved:${idHex}`;

/**
 * Session memo of known-dissolved communities (idHex → tombstone ms), so a
 * remount answers SYNCHRONOUSLY instead of leaving a window where the community
 * reads as alive while IndexedDB is consulted.
 */
const dissolvedMemo = new Map<string, number>();

/**
 * Record a community as dissolved, permanently. Dissolution is terminal and
 * one-way (CORD-02 §9), so this is write-once and never cleared.
 */
async function rememberDissolved(idHex: string, atMs: number): Promise<void> {
  if (dissolvedMemo.get(idHex) === atMs) return;
  dissolvedMemo.set(idHex, atMs);
  await writeFolded(dissolvedKey(idHex), atMs);
}

/** Test seam: forget the session memo, leaving only the persisted verdict. */
export function _forgetDissolvedMemoForTests(): void {
  dissolvedMemo.clear();
}

/** What the dissolved probe needs of the Nostr client. */
interface ProbeNostr {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/**
 * Pending dissolved-address probes, per relay: every community's `useDissolved2`
 * fires its probe in the same boot burst, and each community's dissolved
 * address is a distinct derived pubkey no batcher can merge — so a measured
 * boot paid one `kinds[1059] authors×1 limit10` REQ per (community, relay).
 * Collecting for one window and sending one multi-filter REQ per relay keeps
 * the per-address `limit` isolation while paying one socket round; results
 * demux by wrap author (the dissolved address signs its own tombstone wrap).
 */
const dissolvedProbes = new Map<string, Map<string, Array<(events: NostrEvent[]) => void>>>();
const dissolvedProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function probeDissolved(nostr: ProbeNostr, url: string, pk: string): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    let byPk = dissolvedProbes.get(url);
    if (!byPk) {
      byPk = new Map();
      dissolvedProbes.set(url, byPk);
    }
    const waiters = byPk.get(pk) ?? [];
    waiters.push(resolve);
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

  let events: NostrEvent[] = [];
  try {
    events = await nostr.relay(url).query(
      [...byPk.keys()].map((pk) => ({ kinds: [KIND_WRAP], authors: [pk], limit: 10 })),
      { signal: AbortSignal.timeout(8000) },
    );
  } catch {
    // A failed round answers every waiter empty — the callers' own catch/poll
    // semantics, unchanged.
  }
  for (const [pk, waiters] of byPk) {
    const mine = events.filter((event) => event.pubkey === pk);
    for (const resolve of waiters) resolve(mine);
  }
}

/**
 * The tombstone ms for a community we have EVER seen dissolved, or undefined.
 * Local only — no network, no re-derivation. Used by the wire to drop a dead
 * community's subscriptions and by the send path to refuse a write.
 */
export async function dissolvedAt(idHex: string): Promise<number | undefined> {
  const memo = dissolvedMemo.get(idHex);
  if (memo !== undefined) return memo;
  const stored = await readFolded<number>(dissolvedKey(idHex));
  if (typeof stored === "number") {
    dissolvedMemo.set(idHex, stored);
    return stored;
  }
  return undefined;
}

/**
 * The tombstone's own ms, or `null` while the community lives.
 *
 * STICKY. Death is one-way (CORD-02 §9), so once a valid tombstone has been
 * seen it is persisted and answered from local state forever — a relay outage,
 * an evicted store, or a failed round MUST NOT resurrect a dead community.
 * Before this was persistent, the network branch's `.catch(() => [])` meant one
 * bad round answered "alive", which unfroze the composer.
 *
 * A timestamp rather than a boolean: both planes replay from history, so a
 * caller judging a past action needs to know whether it predates the grave
 * (honored) or follows it (refused). Truthiness still reads as "dissolved".
 */
export function useDissolved2(community: CommunityV2 | undefined, active = true) {
  const { nostr } = useNostr();
  const idHex = community?.idHex ?? null;

  return useQuery<number | null>({
    queryKey: ["concord2", "dissolved", idHex],
    enabled: Boolean(community) && active,
    staleTime: 30_000,
    // Synchronous for a community already known dead this session, so the
    // composer is never briefly live on a remount.
    initialData: idHex && dissolvedMemo.has(idHex) ? dissolvedMemo.get(idHex)! : undefined,
    // A dissolution is rare and terminal; once known this never touches the
    // network again. A slow, foreground-only poll is plenty to notice one.
    refetchInterval: active ? 5 * 60_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      // Known dead → done. Never re-derived, so nothing can undo it.
      const known = await dissolvedAt(community!.idHex);
      if (known !== undefined) return known;

      const group = dissolvedGroupKey(community!.id);
      // The grave marker is a control-kind rumor, so it reads back with the
      // rest of the plane; `isDissolvedOpened` is what identifies it, and it
      // authenticates on the SEAL SIGNER being the owner — which the address it
      // arrived at never established anyway.
      const cached = await queryPlane(community!.idHex, "control");
      const cachedGrave = cached.find((o) => isDissolvedOpened(o, community!.owner, community!.id));
      if (cachedGrave) {
        await rememberDissolved(community!.idHex, cachedGrave.ms);
        return cachedGrave.ms;
      }

      // Through the shared per-relay collector: one multi-filter REQ per relay
      // per burst instead of one REQ per community (see `probeDissolved`).
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

// ── Publishing ───────────────────────────────────────────────────────────────

/**
 * Sign (plaintext seal) + wrap + broadcast one edition to the community relays.
 * `opts.relays` overrides the fan-out set — a relay-list edition must reach
 * BOTH the old and the new relays (the fold that announces a move lives on the
 * relays being moved away from).
 */
/** Sentinel so the store-read try/catch can't swallow the gate's own refusal. */
class DissolvedError extends Error {}

export async function publishEdition2(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: CommunityV2,
  signer: StreamSigner,
  rumor: NostrRumor,
  opts?: { relays?: string[] },
): Promise<void> {
  // A dissolved community honors no new authority action (CORD-02 §9: the seal
  // is one-way and nothing new is honored). Gated HERE rather than at each of
  // the fifteen call sites — one place that cannot be forgotten when a new
  // edition kind is added. Reads the local store only, so it costs no network,
  // and fails OPEN on a store error: an unreadable cache must not block a
  // legitimate publish (matching Vector's `get_community_dissolved(…)
  // .unwrap_or(false)`).
  try {
    const cached = await queryPlane(community.idHex, "control");
    if (cached.some((o) => isDissolvedOpened(o, community.owner, community.id))) {
      throw new DissolvedError();
    }
  } catch (e) {
    if (e instanceof DissolvedError) throw new Error("This community has been dissolved; it accepts no changes.");
  }
  // The WRITE key: on a split epoch its signing secret is the staff-held
  // control_root (CORD-02 §2) — a member without it fails here with a
  // readable error instead of minting a wrap every reader and relay drops.
  const control = currentControlWriteGroup(community);
  const wrap = await sealEdition(rumor, control, signer);
  const urls = opts?.relays ?? community.relays;
  const attempt = () =>
    Promise.allSettled(urls.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })));
  let results = await attempt();
  // An auth-gating relay refuses a stream-authored wrap until the socket's
  // NIP-42 wave re-authenticates the control key ("restricted: you cannot
  // publish events on behalf of others") — a race every socket (re)open
  // invites. One paced retry outlives the wave; a genuine policy refusal
  // just fails again and surfaces below.
  if (
    !results.some((r) => r.status === "fulfilled") &&
    results.some((r) => r.status === "rejected" && /restricted|auth/i.test(String(r.reason instanceof Error ? r.reason.message : r.reason)))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    results = await attempt();
  }
  if (!results.some((r) => r.status === "fulfilled")) {
    if (urls.length === 0) throw new Error("No relay accepted the change: the community has no relays configured.");
    const reasons = [
      ...new Set(
        results
          .map((r) => (r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : ""))
          .filter(Boolean),
      ),
    ];
    throw new Error(`No relay accepted the change${reasons.length ? `: ${reasons.slice(0, 2).join("; ")}` : "."}`);
  }
  // Write our own edition to the local opened-event store immediately: the
  // refetch after invalidation unions the store, so the publisher's fold picks
  // the change up even if no relay echoes the wrap back (or the persisted
  // `since` cursor would skip it). Without this, a promote can "succeed" with
  // no visible effect until a full resync.
  try {
    writeOpened(community.idHex, [openWrap(wrap, control)], "control", {
      refounded: community.rootEpoch > 0n,
    });
  } catch {
    // best-effort — the relay echo remains the fallback
  }
}

/**
 * The authority citation an actor attaches to an action (CORD-04 §5): the
 * exact Grant edition they act under, pinned by coordinate + version + hash.
 * Absent when the owner acts — supreme needs no citation.
 */
export function citationFor(
  community: CommunityV2,
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
export function invalidateControl2(queryClient: ReturnType<typeof useQueryClient>, idHex: string): void {
  queryClient.invalidateQueries({ queryKey: ["concord2", "control", idHex] });
}
