import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { useEventStore } from "@/hooks/useEventStore";
import { selfStateRelays } from "@/contexts/AppContext";
import { useIsBlocked } from "@/lib/blocklistStore";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import {
  addToList,
  communityListFoldKey,
  EMPTY_COMMUNITY_LIST,
  isExcluded,
  isLive,
  liveEntries,
  markExcluded,
  mergeCommunityLists,
  refreshChannels,
  refreshCurrent,
  refreshRelays,
  reviseSnapshots,
  rehydrateCommunity,
  removeFromList,
  replayedAddStanding,
  setControlRoot,
  type CommunityList,
  type PersistedCommunityList,
  type CommunityListEntry,
  type JoinMaterial,
} from "@/concord/lib/communityList";
import {
  defragment,
  emptyFragList,
  fragment,
  parseFragList,
  serializeFragList,
  type FragList,
} from "@/concord/lib/listFrag";
import { hydratePendingJoins, pendingJoinEntriesFor, subscribePendingJoins } from "@/concord/lib/pendingJoins";
import { KIND_COMMUNITY_LIST_FRAG, KIND_COMMUNITY_LIST_RETIRED } from "@/concord/lib/kinds";
import type { Community } from "@/concord/lib/types";
import { RESCUE_RELAYS } from "@/lib/platform";
import { logSync } from "@/lib/syncLog";
import { publishSignedEventToRelays, uniqueRelayUrls } from "@/lib/nip65";
import { queryRelayStrict, type ReqRelay } from "@/lib/strictRelayQuery";
import {
  queueSignedEvent,
  recordQueuedPublishAttempt,
} from "@/lib/publishOutbox";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import type { NostrRumor } from "@/lib/nostrRumor";
import { t } from "@/i18n";

/**
 * The user's Concord Community List — kind-33302 fragment events, NIP-44
 * encrypted to self (CORD-02 §8). The List IS the vault (community roots and
 * private-channel keys). One addressable event per fragment (`d` = index); a
 * reader holds the COMPLETE list when it has every index below the declared total.
 *
 * CORD-02 §8 disciplines:
 *  - Newest wins PER INDEX; an age tie falls to the lowest event id.
 *  - `frags` disagreement resolves to the newest fragment; a tie to the LARGER count.
 *  - A short read is read-only (a write would drop memberships in missing fragments).
 *  - Every write is read-modify-write; byte-identical fragments are skipped.
 *  - Seeding (first write, migrating off retired 13302) requires a CONFIRMED-empty
 *    read, relay by relay; any error means no seed. Latched once it lands.
 *  - Every write is logged.
 *
 * Locally: plaintext-first boot from the folded cache, decrypt-once memo, an
 * undecryptable read never clobbers a populated list, and mutations are
 * serialized with strictly-increasing per-fragment `created_at`.
 */

export type ListData = {
  event: NostrRumor | null;
  list: CommunityList;
  decryptFailed?: boolean;
  /** An explicit self-state relay missed the last safe read; poll until it can be repaired. */
  repairPending?: boolean;
};
export type PersistedList = PersistedCommunityList;

export const listQueryKey = (pubkey: string | undefined) => ["concord", "list", pubkey] as const;
const foldKeyOf = communityListFoldKey;

/** Latch: this account has written the fragmented list at least once. */
const seedKeyOf = (pubkey: string) => `concord2-list-seeded:${pubkey}`;
/** Legacy STOCK rescue is retried independently of whether 33302 was seeded. */
const retiredRescueKeyOf = (pubkey: string) => `concord2-retired-list-rescued:${pubkey}`;

/**
 * Junk ceiling on a wire-declared `frags` (~230MB of list); honoring more would
 * let one bad fragment drive an unbounded scan every sync.
 */
const MAX_DECLARED_FRAGS = 4096;
/** Per-coordinate relay divergence bound; four stock relays plus user relays stay far below it. */
const MAX_DIVERGENT_EDITIONS = 32;
const FRAGMENT_QUERY_CHUNK = 64;
const LIST_IO_TIMEOUT_MS = 8_000;
const LIST_REPAIR_REFETCH_MS = 60_000;
const LIST_REPAIR_MAX_MS = 60 * 60_000;

/**
 * Each account's last reconcile publish and how many have gone out in a row
 * without the wire reading back converged. The reconcile re-runs whenever its
 * own publish echoes back on the self-sync stream, so a relay that keeps reading
 * as stale would otherwise drive it at network speed; and a fixed minute still
 * re-sent the whole list to every self relay — and every device subscribed to
 * them — once a minute for as long as the app stayed open.
 */
const reconcilePublishes = new Map<string, { at: number; streak: number }>();

/** How long after its last publish an account's still-stale reconcile waits. */
function reconcileSpacingMs(pubkey: string | undefined): number {
  const streak = pubkey ? reconcilePublishes.get(pubkey)?.streak ?? 0 : 0;
  return Math.min(LIST_REPAIR_REFETCH_MS * 2 ** Math.max(0, streak - 1), LIST_REPAIR_MAX_MS);
}

/** Test seam. */
export function _resetReconcilePublishClock(): void {
  reconcilePublishes.clear();
}

/** Shared by the mutation and the reconcile's am-I-racing-a-mutation check. */
const LIST_MUTATION_KEY = ["concord-list"] as const;

type NostrLike = {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
  group?(relays: string[]): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> };
  relay?(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
    req?: ReqRelay["req"];
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown>;
  };
  event?(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown>;
};

/** A client proven able to reach a named relay. */
type PublishingNostr = NostrLike & { relay: NonNullable<NostrLike["relay"]> };

/**
 * Narrow to a client that can publish — the client ITSELF, never
 * `{ relay: nostr.relay }`: `relay()` reads `this.pool`, so a lifted method throws
 * (while test doubles wouldn't notice).
 */
function canPublish(client: NostrLike): client is PublishingNostr {
  return typeof client.relay === "function";
}

/**
 * Carry forward removals recorded locally while a network read was in flight,
 * so a sync that snapshotted the cache before a leave can't undo it. Tombstones
 * only: they're monotonic (newer `removed_at` wins).
 */
function withLocalTombstones(list: CommunityList, local: CommunityList | undefined): CommunityList {
  if (!local || local.tombstones.length === 0) return list;
  const held = new Map(list.tombstones.map((t) => [t.community_id, t.removed_at]));
  const newer = local.tombstones.filter((t) => t.removed_at > (held.get(t.community_id) ?? -Infinity));
  return newer.length === 0 ? list : mergeCommunityLists(list, { entries: [], tombstones: newer });
}

/**
 * Decode-once memo for fragment decrypts, keyed by event id. Capped (every
 * publish mints new ids): evicts the oldest half at the cap.
 */
const fragDecryptMemo = new Map<string, Promise<FragList | null>>();
const FRAG_MEMO_CAP = 1024;

function memoFragDecrypt(id: string, work: Promise<FragList | null>): void {
  if (fragDecryptMemo.size >= FRAG_MEMO_CAP) {
    let drop = fragDecryptMemo.size / 2;
    for (const key of fragDecryptMemo.keys()) {
      if (drop-- <= 0) break;
      fragDecryptMemo.delete(key);
    }
  }
  fragDecryptMemo.set(id, work);
}

/** Forget every decrypted fragment (the user's community list, with its secrets). Logout. */
export function clearCommunityListMemory(): void {
  fragDecryptMemo.clear();
}

function dTagOf(event: NostrRumor): string | undefined {
  return event.tags.find((t) => t[0] === "d")?.[1];
}

/** The fragment index off the `d` tag — a bare decimal, or the event is not a fragment. */
export function fragIndexOf(event: NostrRumor): number | undefined {
  const d = dTagOf(event);
  if (d === undefined || !/^\+?[0-9]+$/.test(d)) return undefined;
  const index = Number(d);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

async function decryptFragment(
  event: NostrRumor,
  signer: NUser["signer"],
  selfPubkey: string,
): Promise<FragList | null> {
  const nip44 = signer.nip44;
  if (!nip44) return null;
  const cached = fragDecryptMemo.get(event.id);
  if (cached) return cached;
  const work = (async () => {
    try {
      const plaintext = await nip44.decrypt(selfPubkey, event.content);
      return parseFragList(plaintext);
    } catch (err) {
      console.warn("Failed to decrypt Concord community list fragment:", err);
      fragDecryptMemo.delete(event.id); // let a later call retry a transient failure
      return null;
    }
  })();
  memoFragDecrypt(event.id, work);
  return work;
}

/** A fragment fetch: the unioned list plus each index's `created_at` so writes can exceed it. */
export interface FragSet {
  list: CommunityList;
  /** Per index, the newest known wire or authenticated local created_at floor. */
  createdAt: Map<number, number>;
  /** `frags` as declared by the newest fragment seen (age tie → larger). */
  declared: number;
  /** The winning parsed fragment per index, so rewrites can skip identical ones. */
  readFrags: Map<number, FragList>;
  /** The signed relay-read winner for each coordinate, used for exact mirroring. */
  winningEvents: Map<number, NostrRumor>;
  /** The newest known wire or authenticated local event (for cache identity / logging). */
  newestEvent: NostrRumor | null;
  /** Coverage, not agreement: an index at every slot below `declared`. */
  complete: boolean;
  /** The wire declared more fragments than this client will ever scan. */
  declaredOverflow: boolean;
}

/** The explicit rescue/write set for the encrypted Concord vault. */
export function communityListRelays(selfRelays: Iterable<string>): string[] {
  return uniqueRelayUrls([...selfRelays, ...RESCUE_RELAYS]);
}

function newestEventFirst(a: NostrRumor, b: NostrRumor): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id);
}

/** Decode and resolve a set of fragment events without doing network I/O. */
export async function decodeCommunityListFragments(
  sourceEvents: Iterable<NostrRumor>,
  user: NUser,
): Promise<{ set: FragSet | null; unreadable: boolean }> {
  const events = new Map<string, NostrRumor>();
  for (const event of sourceEvents) events.set(event.id, event);
  if (events.size === 0) return { set: null, unreadable: false };

  // Resolve each coordinate BEFORE decrypting: falling back to an older readable
  // copy when the head is unreadable would base writes on stale plaintext.
  const editions = new Map<number, NostrRumor[]>();
  for (const event of events.values()) {
    const index = fragIndexOf(event);
    if (index === undefined) continue;
    const held = editions.get(index) ?? [];
    held.push(event);
    editions.set(index, held);
  }
  const newest = new Map<number, { at: number; id: string; frag: FragList; event: NostrRumor }>();
  let unreadable = false;
  let list = EMPTY_COMMUNITY_LIST;
  let readableEditions = 0;
  for (const index of [...editions.keys()].sort((a, b) => a - b)) {
    const candidates = editions.get(index)!
      .sort(newestEventFirst)
      .slice(0, MAX_DIVERGENT_EDITIONS);
    const head = candidates[0]!;
    const headFrag = await decryptFragment(head, user.signer, user.pubkey);
    if (!headFrag) {
      unreadable = true;
    } else {
      newest.set(index, {
        at: head.created_at,
        id: head.id,
        frag: headFrag,
        event: head,
      });
    }

    // Older divergent relay editions are CRDT inputs, not fallbacks: fold every
    // readable one oldest → newest so facts held only by a lagging relay survive.
    // An unreadable head still blocks writes; losers never become authoritative.
    for (const event of [...candidates].reverse()) {
      const frag = event.id === head.id
        ? headFrag
        : await decryptFragment(event, user.signer, user.pubkey);
      if (!frag) continue;
      readableEditions += 1;
      list = mergeCommunityLists(list, defragment([frag]));
    }
  }
  if (readableEditions === 0) {
    logSync("list2", `${events.size} fragment event(s) fetched, none readable — treating as no news`);
    return { set: null, unreadable: editions.size > 0 };
  }

  let wireDeclared = 1;
  let best: { at: number; frags: number } | undefined;
  for (const { at, frag } of newest.values()) {
    if (!best || at > best.at || (at === best.at && frag.frags > best.frags)) {
      best = { at, frags: frag.frags };
    }
  }
  if (best) wireDeclared = Math.max(best.frags, 1);
  const declaredOverflow = wireDeclared > MAX_DECLARED_FRAGS;
  const declared = Math.min(wireDeclared, MAX_DECLARED_FRAGS);

  const indices = [...newest.keys()].sort((a, b) => a - b);
  const readFrags = new Map<number, FragList>(indices.map((i) => [i, newest.get(i)!.frag]));
  const winningEvents = new Map<number, NostrRumor>(indices.map((i) => [i, newest.get(i)!.event]));
  const createdAt = new Map<number, number>(indices.map((i) => [i, newest.get(i)!.at]));
  let complete = !declaredOverflow;
  for (let i = 0; complete && i < declared; i++) complete = createdAt.has(i);
  const newestEvent = [...winningEvents.values()].sort(newestEventFirst)[0] ?? null;
  if (!complete) {
    logSync("list2", `INCOMPLETE: hold ${createdAt.size} of ${declared} fragment(s) — reading, refusing to write`);
  }
  return {
    set: {
      list,
      createdAt,
      declared,
      readFrags,
      winningEvents,
      newestEvent,
      complete,
      declaredOverflow,
    },
    unreadable,
  };
}

async function queryCommunityRelays(
  nostr: NostrLike,
  relayUrls: string[],
  filters: NostrFilter[],
  signal?: AbortSignal,
): Promise<{
  events: NostrRumor[];
  /** Events retain their source so an aggregate winner cannot hide a stale relay. */
  eventsByRelay: Map<string, NostrRumor[]>;
  answered: string[];
  failed: string[];
}> {
  const timeout = () => AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(LIST_IO_TIMEOUT_MS),
  ]);
  if (relayUrls.length === 0 || !nostr.relay) {
    if (typeof nostr.query !== "function") {
      return { events: [], eventsByRelay: new Map(), answered: [], failed: relayUrls };
    }
    try {
      const events = await nostr.query(filters, { signal: timeout() });
      // A pool-wide result can't prove any relay reached EOSE: readable, never writable evidence.
      return { events, eventsByRelay: new Map(), answered: [], failed: relayUrls };
    } catch {
      return { events: [], eventsByRelay: new Map(), answered: [], failed: relayUrls };
    }
  }
  const settled = await Promise.allSettled(
    relayUrls.map((url) => nostr.relay!(url).query(filters, { signal: timeout() })),
  );
  const byId = new Map<string, NostrRumor>();
  const eventsByRelay = new Map<string, NostrRumor[]>();
  const answered: string[] = [];
  const failed: string[] = [];
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]!;
    const url = relayUrls[index]!;
    if (result.status !== "fulfilled") {
      failed.push(url);
      continue;
    }
    answered.push(url);
    eventsByRelay.set(url, result.value);
    for (const event of result.value) byId.set(event.id, event);
  }
  return { events: [...byId.values()], eventsByRelay, answered, failed };
}

export interface CommunityListFetchResult {
  set: FragSet | null;
  unreadable: boolean;
  /** Relay-local authoritative fragment heads, only for fully answered relays. */
  readFragsByRelay: Map<string, Map<number, FragList>>;
  /** Explicit destinations that completed every query needed for this read. */
  answered: string[];
  failed: string[];
  targets: string[];
}

/**
 * Fetch and union the account's 33302 fragments, reading each self-state/NIP-65
 * relay AND the stock CORD rescue set independently (a partial publish may leave
 * fragments on either side). `null` when none exist; all-unreadable is `unreadable`.
 */
export async function fetchCommunityListFragments(
  nostr: NostrLike,
  user: NUser,
  selfRelays: Iterable<string>,
  signal?: AbortSignal,
  localEvents: Iterable<NostrRumor> = [],
  wireSeedEvents: Iterable<NostrRumor> = [],
): Promise<CommunityListFetchResult> {
  const targets = communityListRelays(selfRelays);
  const listFilter: NostrFilter[] = [{
    kinds: [KIND_COMMUNITY_LIST_FRAG],
    authors: [user.pubkey],
    limit: MAX_DECLARED_FRAGS,
  }];
  // NPool.query can't signal failure (abort returns partial results), so writers
  // never trust an empty fetch at face value. Local editions are kept separate:
  // they're authenticated CRDT input and a created_at floor, but not evidence of
  // what relays hold — else the reconcile would skip needed repairs.
  const localById = new Map<string, NostrRumor>();
  for (const event of localEvents) {
    if (event.kind === KIND_COMMUNITY_LIST_FRAG && event.pubkey === user.pubkey) {
      localById.set(event.id, event);
    }
  }
  const wireById = new Map<string, NostrRumor>();
  // Caller-fetched signed events keep their wire provenance.
  for (const event of wireSeedEvents) {
    if (event.kind === KIND_COMMUNITY_LIST_FRAG && event.pubkey === user.pubkey) {
      wireById.set(event.id, event);
    }
  }
  const wireByRelay = new Map<string, Map<string, NostrRumor>>();
  const rememberRelayEvents = (byRelay: Map<string, NostrRumor[]>) => {
    for (const [url, events] of byRelay) {
      const held = wireByRelay.get(url) ?? new Map<string, NostrRumor>();
      for (const event of events) held.set(event.id, event);
      wireByRelay.set(url, held);
    }
  };
  const combinedEvents = () => new Map([
    ...wireById,
    ...localById,
  ]).values();
  const initial = await queryCommunityRelays(nostr, targets, listFilter, signal);
  const answered = new Set(initial.answered);
  const failed = new Set(initial.failed);
  rememberRelayEvents(initial.eventsByRelay);
  for (const event of initial.events) wireById.set(event.id, event);
  let decoded = await decodeCommunityListFragments(combinedEvents(), user);
  let wireDecoded = await decodeCommunityListFragments(wireById.values(), user);

  // Some relays cap responses at 64 regardless of limit; once the lattice width
  // is known, query missing coordinates explicitly in chunks. Also query ones a
  // local edition fills, since the relay may hold a divergent fact.
  if (decoded.set && !decoded.set.declaredOverflow) {
    const missing = new Set<string>();
    for (let i = 0; i < decoded.set.declared; i++) {
      if (!wireDecoded.set?.createdAt.has(i)) missing.add(String(i));
    }
    // Aggregate coverage isn't per-relay coverage: query each answered relay's
    // missing coordinates before it can be a write target (a wholly empty EOSE needs none).
    for (const url of answered) {
      const events = wireByRelay.get(url);
      if (!events || events.size === 0) continue;
      const indices = new Set(
        [...events.values()]
          .map(fragIndexOf)
          .filter((index): index is number => index !== undefined),
      );
      for (let i = 0; i < decoded.set.declared; i++) {
        if (!indices.has(i)) missing.add(String(i));
      }
    }
    const missingIndices = [...missing];
    for (let offset = 0; offset < missingIndices.length; offset += FRAGMENT_QUERY_CHUNK) {
      const chunk = missingIndices.slice(offset, offset + FRAGMENT_QUERY_CHUNK);
      const recovery = await queryCommunityRelays(nostr, targets, [{
        kinds: [KIND_COMMUNITY_LIST_FRAG],
        authors: [user.pubkey],
        "#d": chunk,
        limit: chunk.length,
      }], signal);
      for (const url of recovery.failed) {
        failed.add(url);
        answered.delete(url);
      }
      rememberRelayEvents(recovery.eventsByRelay);
      for (const event of recovery.events) wireById.set(event.id, event);
    }
    decoded = await decodeCommunityListFragments(combinedEvents(), user);
    wireDecoded = await decodeCommunityListFragments(wireById.values(), user);
  }

  // These fields include authenticated local editions; the skip/mirror fields
  // stay relay-only (what the reads proved is on the wire).
  const set = decoded.set
    ? {
      ...decoded.set,
      readFrags: wireDecoded.set?.readFrags ?? new Map<number, FragList>(),
      winningEvents: wireDecoded.set?.winningEvents ?? new Map<number, NostrRumor>(),
    }
    : null;
  const readFragsByRelay = new Map<string, Map<number, FragList>>();
  for (const url of answered) {
    const relayDecoded = await decodeCommunityListFragments(
      wireByRelay.get(url)?.values() ?? [],
      user,
    );
    // An absent relay map is unproven, and never written to.
    if (relayDecoded.unreadable) continue;
    readFragsByRelay.set(url, relayDecoded.set?.readFrags ?? new Map());
  }
  return {
    set,
    unreadable: decoded.unreadable || wireDecoded.unreadable,
    readFragsByRelay,
    answered: [...answered],
    failed: [...failed],
    targets,
  };
}

/**
 * Publish a list as fragments. Each fragment's `created_at` must exceed its
 * previous value (relays break ties by lowest id, so a same-second rewrite can
 * be lost). Fragments matching the read bytes are skipped; a shrunk set empties
 * the fragments above it. Returns the newest signed fragment event.
 */
async function publishFragments(
  nostr: NostrLike,
  user: NUser,
  list: CommunityList,
  prevCreatedAt: Map<number, number>,
  readFrags: Map<number, FragList>,
  targetRelays: Iterable<string>,
  readFragsByRelay?: ReadonlyMap<string, ReadonlyMap<number, FragList>>,
): Promise<NostrRumor | null> {
  if (!user.signer.nip44) throw new Error(t({ id: "useCommunityList.nip44Unsupported", defaultMessage: "NIP-44 encryption not supported by this signer" }));
  // Exact read cohort only: an unanswered relay may hold an unseen newer fact.
  const targets = uniqueRelayUrls(targetRelays);
  if (targets.length === 0 || !canPublish(nostr)) {
    throw new Error(t({ id: "useCommunityList.noRelayAvailable", defaultMessage: "No relay is available for your community list update" }));
  }
  const publishNostr: PublishingNostr = nostr;
  const frags = fragment(list);
  const now = Math.floor(Date.now() / 1000);
  const unchanged = (index: number, frag: FragList): boolean => {
    const old = readFrags.get(index);
    return old !== undefined && serializeFragList(old) === serializeFragList(frag);
  };
  const targetsNeeding = (index: number, frag: FragList): string[] => {
    if (!readFragsByRelay) return unchanged(index, frag) ? [] : targets;
    const serialized = serializeFragList(frag);
    return targets.filter((target) => {
      const relayRead = readFragsByRelay.get(target);
      // No completed, decryptable relay-local read ⇒ no authority to write there (fail closed).
      if (!relayRead) return false;
      const old = relayRead.get(index);
      return old === undefined || serializeFragList(old) !== serialized;
    });
  };
  // Persisted, not level-gated: silent non-landing writes are diagnosed after the fact.
  logSync(
    "list2",
    `publishing ${frags.length} fragment(s): ${frags.reduce((n, f) => n + f.entries.length, 0)} live entries (${list.entries.length - frags.reduce((n, f) => n + f.entries.length, 0)} retired), ${frags.reduce((n, f) => n + f.tombstones.length, 0)} tombstones`,
  );

  let skipped = 0;
  let newest: NostrRumor | null = null;
  const publishOne = async (frag: FragList, index: number, fragmentTargets: string[]) => {
    const createdAt = Math.max(now, (prevCreatedAt.get(index) ?? 0) + 1);
    const plaintext = serializeFragList(frag);
    const content = await user.signer.nip44!.encrypt(user.pubkey, plaintext);
    const event = await user.signer.signEvent({
      kind: KIND_COMMUNITY_LIST_FRAG,
      content,
      tags: [["d", String(index)]],
      created_at: createdAt,
    });
    // Queue the exact signed bytes and explicit targets BEFORE the network; if the
    // enqueue fails, don't publish (no retry record for a partial fan-out).
    await queueSignedEvent(event, undefined, fragmentTargets, { inheritPendingTargets: false });
    const result = await publishSignedEventToRelays(
      publishNostr,
      event,
      fragmentTargets,
      LIST_IO_TIMEOUT_MS,
    );
    await recordQueuedPublishAttempt(event.id, fragmentTargets, result.rejected).catch(() => undefined);
    if (result.accepted.length === 0) {
      // Already durably queued: treat as pending delivery rather than rolling back,
      // and continue queueing the other changed fragments.
      logSync("list2", `fragment ${index} accepted by no relay — durably queued for retry`);
    }
    if (result.rejected.length > 0) {
      logSync(
        "list2",
        `fragment ${index} accepted by ${result.accepted.length} relay(s); ${result.rejected.length} queued for retry`,
      );
    }
    if (!newest || event.created_at >= newest.created_at) newest = event;
  };

  // DESCENDING: publishing fragment 0 (declaring a larger total) before a new top
  // index could leave the wire permanently incomplete, which blocks the repairing
  // write. Top-first, any prefix of failures leaves a complete wire.
  for (let index = frags.length - 1; index >= 0; index--) {
    const fragmentTargets = targetsNeeding(index, frags[index]);
    if (fragmentTargets.length === 0) {
      skipped++;
      continue;
    }
    await publishOne(frags[index], index, fragmentTargets);
  }
  // Empty every READ index at or above the new count (actual keys, not a range),
  // so a sparse stale fossil is cleared now.
  for (const index of [...prevCreatedAt.keys()].sort((a, b) => a - b)) {
    if (index < frags.length) continue;
    const empty = emptyFragList(frags.length);
    const fragmentTargets = targetsNeeding(index, empty);
    if (fragmentTargets.length === 0) {
      skipped++;
      continue;
    }
    await publishOne(empty, index, fragmentTargets);
  }
  if (skipped > 0) {
    logSync("list2", `${skipped} fragment(s) skipped — byte-identical to the relay copy`);
  }
  return newest;
}

/**
 * Whether publishing `frags` would change what relays hold. Must stay in
 * lockstep with {@link publishFragments}' skip logic, or the reconcile
 * publishes forever (or never).
 */
function wireDiffers(frags: FragList[], read: Map<number, FragList>): boolean {
  for (let i = 0; i < frags.length; i++) {
    const old = read.get(i);
    if (!old || serializeFragList(old) !== serializeFragList(frags[i])) return true;
  }
  const empty = serializeFragList(emptyFragList(frags.length));
  for (const [i, old] of read) {
    if (i >= frags.length && serializeFragList(old) !== empty) return true;
  }
  return false;
}

/** Whether any safely answered relay is stale or missing at least one coordinate. */
function relayWireDiffers(
  frags: FragList[],
  reads: ReadonlyMap<string, Map<number, FragList>>,
  relays: Iterable<string>,
): boolean {
  for (const relay of relays) {
    const read = reads.get(relay);
    // Missing provenance isn't an empty read; fail closed.
    if (read && wireDiffers(frags, read)) return true;
  }
  return false;
}

/** Whether a complete wire fragment set already represents this merged list. */
export function communityListWireDiffers(list: CommunityList, set: FragSet): boolean {
  return wireDiffers(fragment(list), set.readFrags);
}

/**
 * Sign a complete consolidated vault snapshot (every live and retired
 * coordinate) without publishing, so relay rotation can collapse divergent
 * editions and fan out one exact head per d-tag.
 */
export async function signCommunityListSnapshot(
  user: NUser,
  list: CommunityList,
  previous: FragSet | null,
): Promise<NostrEvent[]> {
  if (!user.signer.nip44) throw new Error(t({ id: "useCommunityList.nip44Unsupported", defaultMessage: "NIP-44 encryption not supported by this signer" }));
  const frags = fragment(list);
  const indices = new Set<number>([
    ...frags.map((_, index) => index),
    ...(previous ? previous.createdAt.keys() : []),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const events: NostrEvent[] = [];
  for (const index of [...indices].sort((a, b) => b - a)) {
    const frag = frags[index] ?? emptyFragList(frags.length);
    const event = await user.signer.signEvent({
      kind: KIND_COMMUNITY_LIST_FRAG,
      content: await user.signer.nip44.encrypt(user.pubkey, serializeFragList(frag)),
      tags: [["d", String(index)]],
      created_at: Math.max(now, (previous?.createdAt.get(index) ?? 0) + 1),
    });
    if (event.pubkey !== user.pubkey) throw new Error(t({ id: "useCommunityList.signerMismatch", defaultMessage: "The signer returned a different account" }));
    events.push(event);
  }
  return events;
}

/**
 * Every relay answered EOSE with zero fragments — the only "empty" strong enough
 * to seed over. Asked one at a time; any error is a FAILED read and never seeds.
 */
async function confirmedEmptyFragmentRelays(
  nostr: NostrLike,
  pubkey: string,
  relays: string[],
): Promise<{ answered: string[]; sawFragments: boolean }> {
  if (relays.length === 0 || !nostr.relay) return { answered: [], sawFragments: false };
  const filter: NostrFilter[] = [{ kinds: [KIND_COMMUNITY_LIST_FRAG], authors: [pubkey], limit: 1 }];
  const answered: string[] = [];
  let sawFragments = false;
  for (const url of relays) {
    try {
      // Strict: a CLOSED read (auth-required, rate-limited) resolves empty via `query()`.
      const relay = nostr.relay(url);
      const signal = AbortSignal.timeout(8000);
      const events = relay.req
        ? await queryRelayStrict({ req: relay.req.bind(relay) }, filter, { signal })
        : await relay.query(filter, { signal });
      answered.push(url);
      if (events.length > 0) sawFragments = true;
    } catch {
      // Unanswered relays are excluded from this write cohort (they may hold richer editions).
    }
  }
  return { answered, sawFragments };
}

/**
 * First write of the §8 List for an account with none (e.g. upgrading from the
 * retired single-event list, whose memberships exist only locally). Latched
 * once it lands; requires per-relay confirmed emptiness so a merely FAILED read
 * can't overwrite a sibling device's tombstones.
 */
async function seedCommunityList(
  nostr: NostrLike,
  user: NUser,
  queryClient: QueryClient,
  selfRelays: string[],
): Promise<void> {
  const alreadySeeded = await readFolded<boolean>(seedKeyOf(user.pubkey));
  const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
  const local = cached?.list ?? (await readFolded<PersistedList>(foldKeyOf(user.pubkey)))?.list;

  // The retired 13302 list is read exactly ONCE, here, as a rescue source: local
  // state is evictable, and a fresh device would otherwise lose the vault. A
  // rescue failure DEFERS the seed rather than latching away the only retry.
  let rescued: CommunityList | undefined;
  if (!(await readFolded<boolean>(retiredRescueKeyOf(user.pubkey)))) {
    try {
      const rescue = await fetchRetiredList(nostr, user, selfRelays);
      rescued = rescue.list;
      if (rescue.complete) await writeFolded(retiredRescueKeyOf(user.pubkey), true);
    } catch (err) {
      logSync(
        "list2",
        `retired-list rescue failed (${err instanceof Error ? err.message : String(err)}); retrying on a later sync`,
      );
    }
  }
  const source = local && rescued ? mergeCommunityLists(local, rescued) : (local ?? rescued);
  if (!source || (source.entries.length === 0 && source.tombstones.length === 0)) return;
  if (alreadySeeded) {
    // A prior seed may still be propagating; keep rescued facts durable and let
    // the reconcile republish the union.
    if (rescued) {
      const event = cached?.event ?? null;
      await writeFolded(foldKeyOf(user.pubkey), { event, list: source } satisfies PersistedList);
      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event, list: source });
    }
    return;
  }

  const confirm = communityListRelays(selfRelays);
  const empty = await confirmedEmptyFragmentRelays(nostr, user.pubkey, confirm);
  const canonical = uniqueRelayUrls(selfRelays);
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(RESCUE_RELAYS);
  if (empty.sawFragments || !empty.answered.some((url) => requiredFloor.includes(url))) {
    logSync("list2", "seed DEFERRED — the empty read is unconfirmed; retrying on a later sync");
    return;
  }
  logSync(
    "list2",
    `no fragments held anywhere (confirmed per relay) — seeding from ${rescued ? "local state + the retired 13302" : "local state"}`,
  );
  try {
    const newest = await publishFragments(nostr, user, source, new Map(), new Map(), empty.answered);
    await writeFolded(seedKeyOf(user.pubkey), true);
    void writeFolded(foldKeyOf(user.pubkey), { event: newest, list: source } satisfies PersistedList);
    if (newest) {
      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event: newest, list: source });
    }
  } catch (err) {
    logSync("list2", `seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Best-effort read of the retired kind-13302 list. `complete` means every
 * historical STOCK rescue source answered at least once; until then, retry.
 */
async function fetchRetiredList(
  nostr: NostrLike,
  user: NUser,
  selfRelays: Iterable<string>,
): Promise<{ list?: CommunityList; complete: boolean }> {
  if (!user.signer.nip44) return { complete: false };
  const filter: NostrFilter[] = [
    { kinds: [KIND_COMMUNITY_LIST_RETIRED], authors: [user.pubkey], limit: 1 },
  ];
  const latest = (await queryCommunityRelays(
    nostr,
    communityListRelays(selfRelays),
    filter,
  ));
  const answered = new Set(latest.answered);
  const complete = uniqueRelayUrls(RESCUE_RELAYS).every((url) => answered.has(url));
  const event = latest.events.sort(newestEventFirst)[0];
  if (!event?.content) return { complete };
  const plaintext = await user.signer.nip44.decrypt(user.pubkey, event.content);
  const parsed = JSON.parse(plaintext) as Partial<CommunityList>;
  return {
    complete,
    list: {
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
    } as CommunityList,
  };
}

/**
 * Fetch, union, and merge the 33302 fragments into the cached list (shared by
 * the queryFn and the post-login gate). Merge-never-replace; persists to the
 * folded cache. `selfRelays` enables confirmed-empty seeding.
 */
export async function syncCommunityList(
  nostr: NostrLike,
  user: NUser,
  queryClient: QueryClient,
  signal?: AbortSignal,
  selfRelays?: string[],
  seedEvents: Iterable<NostrRumor> = [],
): Promise<ListData> {
  const queryKey = listQueryKey(user.pubkey);
  const prev = queryClient.getQueryData<ListData>(queryKey);
  const read = await fetchCommunityListFragments(
    nostr,
    user,
    selfRelays ?? [],
    signal,
    seedEvents,
  );
  const { set, unreadable } = read;
  const explicit = uniqueRelayUrls(selfRelays ?? []);
  const repairFloor = explicit.length > 0 ? explicit : uniqueRelayUrls(RESCUE_RELAYS);
  const repairPending = selfRelays !== undefined && (
    unreadable
    || Boolean(set && !set.complete)
    || read.failed.some((url) => repairFloor.includes(url))
  );

  if (!set) {
    if (unreadable) {
      // Never let an undecryptable read clobber a populated list.
      return {
        ...(prev ?? { event: null, list: EMPTY_COMMUNITY_LIST, decryptFailed: true }),
        repairPending,
      };
    }
    logSync("list2", "relay fetch: no fragments");
    if (selfRelays) await seedCommunityList(nostr, user, queryClient, selfRelays);
    // The cache may not be primed on the first sync of a boot.
    const held = queryClient.getQueryData<ListData>(queryKey) ?? prev;
    const persisted = held ? undefined : await readFolded<PersistedList>(foldKeyOf(user.pubkey));
    const next = held
      ?? queryClient.getQueryData<ListData>(queryKey)
      ?? (persisted ? { event: persisted.event ?? null, list: persisted.list } : { event: null, list: EMPTY_COMMUNITY_LIST });
    return { ...next, repairPending };
  }

  logSync(
    "list2",
    `relay fetch: ${set.createdAt.size} of ${set.declared} fragment(s), ${set.list.entries.length} entries, ${set.list.tombstones.length} tombstones`,
  );

  // Merge, never replace, so a short read can't drop rooms. Fall back to the
  // folded plaintext when the cache isn't primed (it holds the retired list's memberships).
  const local =
    queryClient.getQueryData<ListData>(queryKey)?.list
    ?? prev?.list
    ?? (await readFolded<PersistedList>(foldKeyOf(user.pubkey)))?.list;
  let retired: CommunityList | undefined;
  if (!(await readFolded<boolean>(retiredRescueKeyOf(user.pubkey)))) {
    try {
      const rescue = await fetchRetiredList(nostr, user, selfRelays ?? []);
      retired = rescue.list;
      if (rescue.complete) await writeFolded(retiredRescueKeyOf(user.pubkey), true);
    } catch (error) {
      logSync(
        "list2",
        `retired-list rescue failed (${error instanceof Error ? error.message : String(error)}); retrying on a later sync`,
      );
    }
  }
  const liveAndLocal = local ? mergeCommunityLists(local, set.list) : set.list;
  // Fold in leaves taken during the rescue round, or this write restores them on disk.
  // Revised against the wire (CORD-02 §8), so a union the reconcile publishes outranks the copy it read.
  const merged = reviseSnapshots(
    set.list,
    withLocalTombstones(
      retired ? mergeCommunityLists(liveAndLocal, retired) : liveAndLocal,
      queryClient.getQueryData<ListData>(queryKey)?.list,
    ),
  );
  const next: ListData = {
    event: set.newestEvent,
    list: merged,
    decryptFailed: false,
    repairPending,
  };
  void writeFolded(foldKeyOf(user.pubkey), { event: set.newestEvent, list: merged } satisfies PersistedList);

  // Reconcile — the migration write. An account whose other client already seeded
  // §8 may have a wire lacking this device's retired-13302 memberships with no
  // edit left to trigger a write (CORD-02 §8's stranding trap), so publish when
  // the union differs after a COMPLETE read; the no-op skip makes it free once
  // converged. Skipped while a list mutation is in flight (a same-second
  // lowest-id race it could lose); the next sync re-arms it.
  const canonical = uniqueRelayUrls(selfRelays ?? []);
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(RESCUE_RELAYS);
  const hasCanonicalAnswer = read.answered.some((url) => requiredFloor.includes(url));
  if (selfRelays && set.complete && !unreadable && hasCanonicalAnswer && user.signer.nip44
    && queryClient.isMutating({ mutationKey: LIST_MUTATION_KEY }) === 0) {
    try {
      const rebuilt = fragment(merged);
      const nowSec = Math.floor(Date.now() / 1000);
      const newestEdition = Math.max(0, ...set.createdAt.values());
      const lastPublish = reconcilePublishes.get(user.pubkey)?.at ?? 0;
      const stale = relayWireDiffers(rebuilt, read.readFragsByRelay, read.answered);
      if (!stale) reconcilePublishes.delete(user.pubkey);
      if (stale && newestEdition >= nowSec) {
        // An edition dated now or later is already out. Ditto-family relays hide
        // future-dated events from queries, so one reads as missing there, and
        // each republish (created_at = previous + 1) would date the next further
        // ahead: a loop that feeds itself. Wait for the clock instead.
        next.repairPending = true;
        logSync("list2", `reconcile: newest edition is ${newestEdition - nowSec}s ahead of the clock — not republishing yet`);
      } else if (stale && Date.now() - lastPublish < reconcileSpacingMs(user.pubkey)) {
        next.repairPending = true;
        logSync("list2", "reconcile: published recently — waiting for the next repair poll");
      } else if (stale) {
        // EVENT acceptance doesn't prove the head is query-visible yet; keep polling.
        next.repairPending = true;
        const streak = (reconcilePublishes.get(user.pubkey)?.streak ?? 0) + 1;
        reconcilePublishes.set(user.pubkey, { at: Date.now(), streak });
        logSync("list2", "reconcile: the union or a relay-local copy is stale — publishing it");
        const newest = await publishFragments(
          nostr,
          user,
          merged,
          set.createdAt,
          set.readFrags,
          read.answered,
          read.readFragsByRelay,
        );
        void writeFolded(seedKeyOf(user.pubkey), true);
        if (newest) next.event = newest;
      }
    } catch (err) {
      // Non-fatal; the reconcile re-arms every sync until it lands.
      next.repairPending = true;
      logSync(
        "list2",
        `reconcile publish failed (${err instanceof Error ? err.message : String(err)}) — retrying on a later sync`,
      );
    }
  }
  next.list = withLocalTombstones(next.list, queryClient.getQueryData<ListData>(queryKey)?.list);
  return next;
}

/** Query the latest Concord Community List, plaintext-cache-first. */
export function useCommunityList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = listQueryKey(user?.pubkey);
  const foldKey = user ? foldKeyOf(user.pubkey) : null;

  // Plaintext-first boot without a signer (a remote signer can take seconds on
  // reopen); falls back to decrypting locally-mirrored fragments once ready.
  useEffect(() => {
    if (!user || !foldKey) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const persisted = await readFolded<PersistedList>(foldKey);
      if (cancelled) return;
      if (persisted) {
        logSync("list2", `boot from folded cache: ${persisted.list.entries.length} entry(ies)`);
        queryClient.setQueryData<ListData>(queryKey, { event: persisted.event ?? null, list: persisted.list });
        return;
      }
      if (!user.signer.nip44) return;
      const store = await eventStore;
      const cached = await store.query([{ kinds: [KIND_COMMUNITY_LIST_FRAG], authors: [user.pubkey] }]);
      if (cancelled || cached.length === 0) return;
      // Newest per index, then union — the wire's read discipline.
      const newest = new Map<number, { at: number; id: string; frag: FragList; event: NostrRumor }>();
      for (const event of cached) {
        const index = fragIndexOf(event);
        if (index === undefined) continue;
        const frag = await decryptFragment(event, user.signer, user.pubkey);
        if (!frag) continue;
        const prev = newest.get(index);
        const wins = !prev || event.created_at > prev.at || (event.created_at === prev.at && event.id < prev.id);
        if (wins) newest.set(index, { at: event.created_at, id: event.id, frag, event });
      }
      if (cancelled || newest.size === 0) return;
      const indices = [...newest.keys()].sort((a, b) => a - b);
      const list = defragment(indices.map((i) => newest.get(i)!.frag));
      const newestEvent = [...newest.values()].reduce<NostrRumor | null>(
        (a, b) => (a && a.created_at >= b.event.created_at ? a : b.event),
        null,
      );
      if (!queryClient.getQueryData(queryKey)) {
        queryClient.setQueryData<ListData>(queryKey, { event: newestEvent, list });
        // Same guard as setQueryData: a live sync's fresher folded write must win.
        void writeFolded(foldKey, { event: newestEvent, list } satisfies PersistedList);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, user?.signer.nip44, eventStore, queryClient]);

  return useQuery<ListData>({
    queryKey,
    enabled: Boolean(user?.signer.nip44),
    // A new fragment from any device reaches NostrSync's self-state stream,
    // which invalidates this key; a mount-driven re-read of every fragment on
    // every relay finds nothing that stream missed. Writes read first anyway.
    staleTime: 10 * 60_000,
    // Keep retrying while a relay that missed the source read is outstanding (the
    // subscription can't detect an EMPTY returning relay).
    refetchInterval: (query) => query.state.data?.repairPending
      ? reconcileSpacingMs(user?.pubkey)
      : false,
    queryFn: async ({ signal }) => {
      let cached: NostrRumor[] = [];
      try {
        cached = await (await eventStore).query([{
          kinds: [KIND_COMMUNITY_LIST_FRAG],
          authors: [user!.pubkey],
        }]);
      } catch {
        // Wire + folded plaintext remain available when ArmadaDB is not.
      }
      return syncCommunityList(
        nostr,
        user!,
        queryClient,
        signal,
        selfStateRelays(config, user!.pubkey),
        cached,
      );
    },
  });
}

/** A mutation against the list (read-modify-write, deterministic, serialized). */
export type CommunityListAction =
  | {
      type: "add";
      entry: CommunityListEntry;
      /**
       * Settles a pending join (see {@link replayedAddStanding}): nothing is published
       * when a later removal supersedes it or the wire already holds it.
       */
      replay?: boolean;
    }
  | { type: "remove"; communityId: string; removedAt?: number }
  | { type: "exclude"; communityId: string; epoch: number }
  | { type: "refresh-current"; current: JoinMaterial }
  | {
      type: "refresh-channels";
      communityId: string;
      channels: JoinMaterial["channels"];
      /** Channels a rotation cut me out of, with the epoch that did it. */
      cuts?: CommunityListEntry["channel_cuts"];
    }
  | { type: "refresh-relays"; communityId: string; relays: string[] }
  | {
      /** A verified `control_wrap` adoption (CORD-04 §3) — see {@link setControlRoot}. */
      type: "set-control-root";
      communityId: string;
      epoch: number;
      controlRootHex: string;
    };

function applyAction(list: CommunityList, action: CommunityListAction): CommunityList {
  switch (action.type) {
    case "add":
      return addToList(list, action.entry);
    case "remove":
      return removeFromList(list, action.communityId, action.removedAt ?? Date.now());
    case "exclude":
      return markExcluded(list, action.communityId, action.epoch);
    case "refresh-current":
      return refreshCurrent(list, action.current);
    case "refresh-channels":
      return refreshChannels(list, action.communityId, action.channels, action.cuts);
    case "refresh-relays":
      return refreshRelays(list, action.communityId, action.relays);
    case "set-control-root":
      return setControlRoot(list, action.communityId, action.epoch, action.controlRootHex);
  }
}

/** The serialized read/modify/write core (exported for testing the all-sources-failed guard). */
export async function updateCommunityList(
  nostr: NostrLike,
  user: NUser,
  queryClient: QueryClient,
  relays: string[],
  action: CommunityListAction,
  seedEvents: Iterable<NostrRumor> = [],
): Promise<CommunityList> {
  const read = await fetchCommunityListFragments(
    nostr,
    user,
    relays,
    undefined,
    seedEvents,
  );
  const { set, unreadable } = read;
  if (unreadable) {
    throw new Error(
      t({ id: "useCommunityList.undecryptable", defaultMessage: "Couldn't read your existing communities (decryption failed); not saving to avoid losing room keys." }),
    );
  }
  // Require a canonical account-state answer (stock only for legacy accounts
  // without one); unanswered rescue relays are left out of the write cohort.
  const canonical = uniqueRelayUrls(relays);
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(RESCUE_RELAYS);
  if (!read.answered.some((url) => requiredFloor.includes(url))) {
    throw new Error(
      t({ id: "useCommunityList.unconfirmed", defaultMessage: "Couldn't confirm your community list on an account-state relay; not saving to avoid overwriting it." }),
    );
  }
  if (set && !set.complete) {
    throw new Error(
      t(
        {
          id: "useCommunityList.incomplete",
          defaultMessage: "Holding {held} of {declared} community-list fragments; try again once the missing ones sync.",
        },
        { held: set.createdAt.size, declared: set.declared },
      ),
    );
  }
  if (!set) {
    // Confirmed empty wire, but local records show prior fragments: relay data loss
    // isn't authority to mint a new fragment 0.
    const persisted = await readFolded<PersistedList>(foldKeyOf(user.pubkey));
    const seeded = await readFolded<boolean>(seedKeyOf(user.pubkey));
    if (persisted?.event || seeded) {
      throw new Error(
        t({ id: "useCommunityList.unreachable", defaultMessage: "Couldn't reach your community list on any relay; not saving to avoid overwriting it." }),
      );
    }
  }
  const relayList = set?.list ?? EMPTY_COMMUNITY_LIST;

  // Fold in the local optimistic cache (addressable propagation lags).
  const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
  const current = cached ? mergeCommunityLists(cached.list, relayList) : relayList;
  if (action.type === "add" && action.replay) {
    // A removal counts wherever held, but "already written" only counts on the wire.
    const standing = replayedAddStanding(current, action.entry) === "superseded"
      ? "superseded"
      : replayedAddStanding(relayList, action.entry);
    if (standing) {
      logSync("list2", `replayed add ${action.entry.community_id.slice(0, 8)} ${standing} — not publishing`);
      return current;
    }
  }
  // Revisions count against what the wire holds (CORD-02 §8).
  const next = reviseSnapshots(relayList, applyAction(current, action));

  const newest = await publishFragments(
    nostr,
    user,
    next,
    set?.createdAt ?? new Map(),
    set?.readFrags ?? new Map(),
    read.answered,
    read.readFragsByRelay,
  );

  const event = newest ?? set?.newestEvent ?? cached?.event ?? null;
  // Leaves recorded during this write are published by the next sync's reconcile.
  const stored = withLocalTombstones(next, queryClient.getQueryData<ListData>(listQueryKey(user.pubkey))?.list);
  queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), {
    event,
    list: stored,
    repairPending: read.failed.some((url) => requiredFloor.includes(url)),
  });
  void writeFolded(foldKeyOf(user.pubkey), { event, list: stored } satisfies PersistedList);
  void writeFolded(seedKeyOf(user.pubkey), true);
  return stored;
}

/**
 * Leave a community LOCALLY, now: tombstone it in the cached list and folded
 * plaintext. The vault write runs behind it; if it never lands, the next sync's
 * reconcile publishes the tombstone.
 */
export async function removeCommunityLocally(
  queryClient: QueryClient,
  pubkey: string,
  communityId: string,
  removedAt: number,
): Promise<void> {
  const queryKey = listQueryKey(pubkey);
  const persisted = queryClient.getQueryData<ListData>(queryKey)
    ? undefined
    : await readFolded<PersistedList>(foldKeyOf(pubkey));
  const base = queryClient.getQueryData<ListData>(queryKey)
    ?? (persisted ? { event: persisted.event ?? null, list: persisted.list } : undefined);
  if (!base) return;
  const next: ListData = { ...base, list: removeFromList(base.list, communityId, removedAt) };
  queryClient.setQueryData<ListData>(queryKey, next);
  await writeFolded(foldKeyOf(pubkey), { event: next.event, list: next.list } satisfies PersistedList);
}

export function useUpdateCommunityList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    // One queue so back-to-back joins can't interleave RMWs; the key lets the sync
    // reconcile detect a mutation in flight.
    mutationKey: [...LIST_MUTATION_KEY],
    scope: { id: "concord-list" },
    mutationFn: async (action: CommunityListAction) => {
      if (!user) throw new Error(t({ id: "useCommunityList.notLoggedIn", defaultMessage: "User is not logged in" }));
      if (!user.signer.nip44) throw new Error(t({ id: "useCommunityList.nip44Unsupported", defaultMessage: "NIP-44 encryption not supported by this signer" }));

      // Includes the stock rescue relays, where a partial fan-out may have put the newest copy.
      const relays = selfStateRelays(config, user.pubkey);
      let cached: NostrRumor[] = [];
      try {
        cached = await (await eventStore).query([{
          kinds: [KIND_COMMUNITY_LIST_FRAG],
          authors: [user.pubkey],
        }]);
      } catch {
        // A wire-confirmed RMW can still proceed when local storage is down.
      }
      return updateCommunityList(nostr, user, queryClient, relays, action, cached);
    },
    onSuccess: (_next, action) => {
      // So a later rejoin doesn't reappear inside its old folder.
      if (action.type === "remove") removeRailKey(`c2:${action.communityId}`);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });
}

/** Optimistic pending-join overlays (see pendingJoins.ts), including ones from a previous launch. */
function usePendingJoins(): CommunityListEntry[] {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  useEffect(() => {
    if (pubkey) void hydratePendingJoins(pubkey);
  }, [pubkey]);
  const snapshot = useCallback(() => pendingJoinEntriesFor(pubkey), [pubkey]);
  return useSyncExternalStore(subscribePendingJoins, snapshot, snapshot);
}

/**
 * The LIVE joined entries less any on the blocklist, without pending joins: what
 * background sync (wire, sweeps, history walk) may touch. A blocked community
 * must not be fetched onto the device at all, not merely hidden.
 */
export function useJoinedCommunities(): CommunityListEntry[] {
  const { data } = useCommunityList();
  const isBlocked = useIsBlocked();
  return useMemo(
    () => (data ? liveEntries(data.list).filter((e) => !isBlocked(e.community_id)) : []),
    [data, isBlocked],
  );
}

/**
 * The LIVE Concord membership entries (tombstoned ones stay in the doc but not
 * here), less any on the blocklist. A blocked membership stays in the doc too,
 * so lifting the block brings it back.
 */
export function useLiveCommunities(): CommunityListEntry[] {
  const { data } = useCommunityList();
  const pending = usePendingJoins();
  const isBlocked = useIsBlocked();
  return useMemo(() => {
    const live = data ? liveEntries(data.list) : [];
    const held = new Set(live.map((e) => e.community_id));
    return [...live, ...pending.filter((e) => !held.has(e.community_id))]
      .filter((e) => !isBlocked(e.community_id));
  }, [data, pending, isBlocked]);
}

/**
 * Rehydrate a {@link Community} for `idHex`, verified against the owner
 * commitment, with app relays unioned in. Stable identity across renders.
 */
export function useCommunity(idHex: string | undefined): Community | undefined {
  const entry = useCommunityEntry(idHex);
  return useMemo(() => (entry ? rehydrateCommunity(entry) : undefined), [entry]);
}

/**
 * The raw list entry for a community (to round-trip unknown fields). LIVE
 * memberships only: a tombstoned entry must not mount the page, whose watchers
 * (`useRekeyWatch`, `useStrandedRecovery`) would bump `added_at` and undo the leave.
 */
export function useCommunityEntry(idHex: string | undefined): CommunityListEntry | undefined {
  const { data } = useCommunityList();
  const pending = usePendingJoins();
  return useMemo(() => {
    if (!idHex) return undefined;
    if (data && isLive(data.list, idHex)) {
      return data.list.entries.find((e) => e.community_id === idHex);
    }
    // A pending join resolves like a live entry, checked AFTER the live one; it only
    // exists between a Join click and its chain settling.
    return pending.find((e) => e.community_id === idHex);
  }, [data, pending, idHex]);
}

/**
 * EXCLUDED (kicked/banned) at the current epoch: the icon stays, read-only
 * until a Refounding re-includes me or I leave.
 */
export function useIsExcluded(idHex: string | undefined): boolean {
  const entry = useCommunityEntry(idHex);
  return useMemo(() => (entry ? isExcluded(entry) : false), [entry]);
}
