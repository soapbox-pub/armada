import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useDmRelaysFor } from "@/hooks/useDmRelayList";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { decryptCached, getRenderedPlaintext, hasRenderedPlaintext, setRenderedPlaintext, type DecryptFn } from "@/hooks/dmRenderCache";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { setDecryptConsent } from "@/lib/decryptConsent";
import { invalidateOnce } from "@/lib/invalidateOnce";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";
import { dmThreadScope } from "@/wire/bus";
import { dmThreadSnapshotScope, readTimelineSnapshot } from "@/lib/timelineSnapshot";
import { isDmSynced, markDmSynced, readDmPullFloor, writeDmPullFloor } from "@/lib/dmSynced";
import { markOwnWebPushEvent } from "@/lib/webPushState";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { shareById } from "@/lib/shareRows";

/** NIP-04 encrypted direct message kind. */
export const KIND_DM = 4;

/**
 * Minimum interval between relay top-up pulls. The wire delivers new DMs live;
 * pulls cover uncovered history and dead sockets, not every bus invalidation.
 */
const PULL_MIN_INTERVAL_MS = 30_000;
/** How far below the last completed pull a periodic top-up reaches back. */
const DM_TOPUP_SLACK_SECS = 10 * 60;

/**
 * `since` of a periodic kind-4 top-up: the last COMPLETED pull's start minus
 * clock-skew slack. Not the newest message held — often our own, sent over a
 * wedged socket, which would skip everything received meanwhile.
 */
export function dmTopUpSince(lastPullStartedAtSecs: number): number {
  return Math.max(0, lastPullStartedAtSecs - DM_TOPUP_SLACK_SECS);
}

/**
 * When each thread's pull last started, per query client and keyed by thread
 * (a per-mount ref would re-pull on every revisit). Aborted pulls clear their entry.
 */
const threadPullAt = new WeakMap<object, Map<string, number>>();
function threadPulls(client: object): Map<string, number> {
  let map = threadPullAt.get(client);
  if (!map) {
    map = new Map();
    threadPullAt.set(client, map);
  }
  return map;
}

/** How many kind-4 events to request per direction, per relay, per page. */
export const DM_PAGE_SIZE = 500;

/** The other participant of a DM event, from the viewer's perspective. */
export function dmCounterparty(event: NostrRumor, self: string): string | undefined {
  if (event.pubkey !== self) return event.pubkey; // received: peer is the sender
  return event.tags.find(([name]) => name === "p")?.[1];
}

/** Keep inbox previews across a preview-key change only within the same account and consent mode. */
export function keepPreviousDmPreviews(
  previous: Record<string, string> | undefined,
  previousKey: readonly unknown[] | undefined,
  self: string,
  consent: unknown,
): Record<string, string> | undefined {
  return previousKey?.[0] === "dm" &&
    previousKey[1] === "previews" &&
    previousKey[2] === self &&
    previousKey[4] === consent
    ? previous
    : undefined;
}

/**
 * Per-relay, per-direction DM cursor: `undefined` = from the top, number = next
 * `until`, `null` = EXHAUSTED. Failing relays stay `undefined` so they retry.
 */
export type DirectionCursor = number | null | undefined;

export interface RelayCursor {
  sent: DirectionCursor;
  received: DirectionCursor;
}

/** Keyed by relay URL. */
export type RelayCursors = Record<string, RelayCursor>;

/**
 * Next `until` from a relay's page: short or empty page → `null`, full page →
 * oldest minus 1s. Per-relay cursors avoid skipping ranges on dense relays.
 */
export function nextDirectionCursor(events: NostrRumor[]): DirectionCursor {
  if (events.length < DM_PAGE_SIZE) return null;
  const oldest = Math.min(...events.map((e) => e.created_at));
  return Number.isFinite(oldest) ? oldest - 1 : null;
}

/**
 * Load-older cursors when the first page was skipped: every relay pages back from
 * just below the oldest stored message (from the top when nothing is stored).
 */
export function seedDmCursors(relays: string[], stored: NostrRumor[]): RelayCursors {
  const oldest = stored.length > 0 ? Math.min(...stored.map((e) => e.created_at)) : undefined;
  const until: DirectionCursor = oldest !== undefined ? oldest - 1 : undefined;
  const out: RelayCursors = {};
  for (const url of relays) out[url] = { sent: until, received: until };
  return out;
}

/** True if any relay/direction still has older pages to fetch. */
/** A 1:1 thread's starting cursors: each direction from its own oldest loaded row. */
export function initialThreadCursors(
  rows: readonly { pubkey: string; created_at: number }[],
  self: string,
): { sent: number; received: number } {
  const top = rows.length > 0 ? rows[0].created_at - 1 : Math.floor(Date.now() / 1000);
  const oldestOf = (mine: boolean) => {
    const own = rows.filter((r) => (r.pubkey === self) === mine);
    return own.length > 0 ? Math.min(...own.map((r) => r.created_at)) - 1 : top;
  };
  return { sent: oldestOf(true), received: oldestOf(false) };
}

/** The thread page's filters, one per direction still paging. */
export function threadPageFilters(
  self: string,
  peer: string,
  cursor: { sent: DirectionCursor; received: DirectionCursor },
) {
  const filters: { kinds: number[]; authors: string[]; "#p": string[]; until?: number; limit: number }[] = [];
  if (cursor.sent !== null) {
    filters.push({ kinds: [KIND_DM], authors: [self], "#p": [peer], until: cursor.sent, limit: DM_PAGE_SIZE });
  }
  if (cursor.received !== null) {
    filters.push({ kinds: [KIND_DM], authors: [peer], "#p": [self], until: cursor.received, limit: DM_PAGE_SIZE });
  }
  return filters;
}

/** Each direction moves by its own events only; an empty direction is exhausted. */
export function nextThreadCursors(
  cursor: { sent: DirectionCursor; received: DirectionCursor },
  events: readonly { pubkey: string; created_at: number }[],
  self: string,
): { sent: DirectionCursor; received: DirectionCursor } {
  const step = (prev: DirectionCursor, own: readonly { created_at: number }[]): DirectionCursor => {
    if (prev === null) return null;
    if (own.length === 0) return null;
    return Math.min(...own.map((e) => e.created_at)) - 1;
  };
  return {
    sent: step(cursor.sent, events.filter((e) => e.pubkey === self)),
    received: step(cursor.received, events.filter((e) => e.pubkey !== self)),
  };
}

export function hasMoreCursor(cursors: RelayCursors): boolean {
  return Object.values(cursors).some((c) => c.sent !== null || c.received !== null);
}

/**
 * Self-scoped kind-4 filters for one relay: sent = `authors:[self]`, received =
 * `#p:[self]` limited to `knownPeers` (strangers are never fetched; omitted when
 * empty). Exhausted directions are omitted.
 */
export function buildDmFilters(self: string, cursor: RelayCursor | undefined, knownPeers: string[]) {
  const filters: { kinds: number[]; authors?: string[]; "#p"?: string[]; limit: number; until?: number }[] = [];
  const sent = cursor?.sent;
  const received = cursor?.received;
  if (sent !== null) {
    filters.push({ kinds: [KIND_DM], authors: [self], limit: DM_PAGE_SIZE, ...(typeof sent === "number" ? { until: sent } : {}) });
  }
  if (received !== null && knownPeers.length > 0) {
    filters.push({ kinds: [KIND_DM], authors: knownPeers, "#p": [self], limit: DM_PAGE_SIZE, ...(typeof received === "number" ? { until: received } : {}) });
  }
  return filters;
}

/** A decrypted DM ready for rendering. */
export interface DecryptedDM {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  /** Delivery state for our sends: `"sending"` in flight, `"failed"` if rejected/timed out; absent once confirmed. */
  status?: "sending" | "failed";
  /**
   * Not yet decrypted — a viewport placeholder. Only the newest screenful decrypts
   * eagerly; others decrypt on scroll (`decryptVisible`). `content` is empty until then.
   */
  encrypted?: boolean;
  /** Stable render key carried across an optimistic send's id swap, so the row doesn't remount. */
  renderKey?: string;
}

/**
 * Whether an empty kind-4 thread is still waiting on its first relay pull. A
 * SYNC signal, not loading: NIP-17-only threads have no kind-4 rows, so folding
 * it into `isLoading` would hold skeletons over read rumors. See
 * `shouldShowDmTimelineLoading`.
 */
export function isEmptyThreadAwaitingPull(
  messageCount: number,
  waitingForInitialPull: boolean,
): boolean {
  return messageCount === 0 && waitingForInitialPull;
}

/** Newest messages decrypted eagerly (about a screenful); older ones decrypt lazily on scroll. */
const EAGER_DECRYPT_COUNT = 40;

/** Whether the current signer can do NIP-04 (required for DMs). */
export function useDMSupport(): boolean {
  const { user } = useCurrentUser();
  return !!user?.signer.nip04;
}

/**
 * Union raw kind-4 events with the cached set by id — a sparse relay read must
 * never SHRINK the list.
 */
export function mergeDmEvents(prev: NostrRumor[], incoming: NostrRumor[]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * Union a freshly-decrypted thread with the cached one by id, oldest-first. Never
 * drops shown messages on sparse reads or decrypt failures; cached `status` is
 * kept when the echo lacks one.
 */
export function mergeDmThread(prev: DecryptedDM[], incoming: DecryptedDM[]): DecryptedDM[] {
  const merged = new Map<string, DecryptedDM>();
  for (const m of prev) merged.set(m.id, m);
  for (const m of incoming) {
    const existing = merged.get(m.id);
    // Never downgrade decrypted rows to placeholders (but take fresh status).
    if (existing && !existing.encrypted && m.encrypted) {
      merged.set(m.id, { ...existing, status: m.status ?? existing.status });
    } else {
      merged.set(m.id, { ...existing, ...m });
    }
  }
  return [...merged.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Placeholder rows for a conversation, synchronously: memoized plaintext filled
 * in, the rest `encrypted: true`, so structure and scroll length are right on the
 * first frame. Oldest-first.
 */
export function buildThreadPlaceholders(events: NostrRumor[]): DecryptedDM[] {
  const rows: DecryptedDM[] = [];
  for (const event of events) {
    const base = { id: event.id, pubkey: event.pubkey, created_at: event.created_at };
    const cached = getRenderedPlaintext(event.id);
    rows.push(cached !== undefined ? { ...base, content: cached } : { ...base, content: "", encrypted: true });
  }
  return rows.sort((a, b) => a.created_at - b.created_at);
}

/** Patch one decrypted message into the thread cache (never downgrading; keeps `status`). */
function patchRow(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  row: DecryptedDM,
): void {
  queryClient.setQueryData<DecryptedDM[]>([...queryKey], (old = []) => {
    let found = false;
    const next = old.map((m) => {
      if (m.id !== row.id) return m;
      found = true;
      return { ...m, content: row.content, encrypted: undefined };
    });
    if (!found) next.push(row);
    return next.sort((a, b) => a.created_at - b.created_at);
  });
}

/**
 * Decrypt the newest `eager` placeholders, streaming each via `onRow` as it
 * resolves. Failures stay placeholders (retried lazily); cache hits are skipped.
 */
export async function decryptThreadRows(
  events: NostrRumor[],
  self: string,
  peer: string,
  decrypt: DecryptFn,
  eager: number,
  onRow: (row: DecryptedDM) => void,
  preflight?: (targets: { id: string; counterparty: string; ciphertext: string }[]) => Promise<boolean>,
  onAllFailed?: () => void,
): Promise<void> {
  // Newest-first; decrypts fire concurrently, each row streaming in as it resolves.
  const ordered = [...events].sort((a, b) => b.created_at - a.created_at);
  const window = ordered.slice(0, eager);

  // Consent gate: if declined, rows stay placeholders with manual Decrypt controls.
  if (preflight) {
    const pending = window
      .filter((event) => getRenderedPlaintext(event.id) === undefined)
      .map((event) => ({
        id: event.id,
        counterparty: event.pubkey === self ? peer : event.pubkey,
        ciphertext: event.content,
      }));
    if (pending.length > 0 && !(await preflight(pending))) return;
  }

  let attempted = 0;
  let failed = 0;
  await Promise.all(
    window.map(async (event) => {
      if (getRenderedPlaintext(event.id) !== undefined) return; // already shown
      const counterparty = event.pubkey === self ? peer : event.pubkey;
      attempted++;
      try {
        const content = await decryptCached(counterparty, event, decrypt);
        onRow({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, content });
      } catch {
        // Stays a placeholder; retried lazily.
        failed++;
      }
    }),
  );

  // A wholesale failure is treated as the signer declining, flipping to manual
  // controls instead of re-poking on every scroll.
  if (attempted > 0 && failed === attempted) onAllFailed?.();
}

/** Placeholders plus the resolved eager window as one array (IDB seed, tests). Oldest-first. */
export async function buildThreadRows(
  events: NostrRumor[],
  self: string,
  peer: string,
  decrypt: DecryptFn,
  eager: number,
): Promise<DecryptedDM[]> {
  const byId = new Map<string, DecryptedDM>();
  for (const row of buildThreadPlaceholders(events)) byId.set(row.id, row);
  await decryptThreadRows(events, self, peer, decrypt, eager, (row) => {
    byId.set(row.id, row);
  });
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

type NostrPool = ReturnType<typeof useNostr>["nostr"];

/**
 * Query ONE relay for the viewer's DMs at its cursor. Errors throw so the caller
 * leaves the cursor retryable.
 */
async function queryRelayDmPage(
  nostr: NostrPool,
  url: string,
  self: string,
  cursor: RelayCursor | undefined,
  knownPeers: string[],
  signal: AbortSignal,
): Promise<{ url: string; events: NostrRumor[]; cursor: RelayCursor }> {
  const filters = buildDmFilters(self, cursor, knownPeers);
  if (filters.length === 0) {
    return { url, events: [], cursor: { sent: null, received: null } };
  }
  const events = await nostr.relay(url).query(filters, { signal });
  const sentEvents = events.filter((e) => e.pubkey === self);
  const receivedEvents = events.filter((e) => e.pubkey !== self);
  return {
    url,
    events,
    cursor: {
      sent: cursor?.sent === null ? null : nextDirectionCursor(sentEvents),
      received: cursor?.received === null ? null : nextDirectionCursor(receivedEvents),
    },
  };
}

/**
 * Query each relay individually (so each keeps its own cursor) in parallel and
 * merge by id. Failed relays keep their previous cursor.
 */
export async function queryRelaysDmPage(
  nostr: NostrPool,
  relays: string[],
  self: string,
  cursors: RelayCursors,
  knownPeers: string[],
  signal: AbortSignal,
  /** Each relay's events as that relay answers, ahead of the merged page. */
  onRelayEvents?: (events: NostrRumor[]) => void,
): Promise<{ events: NostrRumor[]; cursors: RelayCursors }> {
  const byId = new Map<string, NostrRumor>();
  const nextCursors: RelayCursors = {};

  const results = await Promise.allSettled(
    relays.map(async (url) => {
      const page = await queryRelayDmPage(nostr, url, self, cursors[url], knownPeers, signal);
      onRelayEvents?.(page.events);
      return page;
    }),
  );
  let successfulRelays = 0;

  results.forEach((result, i) => {
    const url = relays[i];
    if (!url) return;
    if (result.status === "fulfilled") {
      successfulRelays += 1;
      for (const e of result.value.events) byId.set(e.id, e);
      nextCursors[url] = result.value.cursor;
    } else {
      // Failed: keep the prior cursor so the next pass retries.
      nextCursors[url] = cursors[url] ?? { sent: undefined, received: undefined };
    }
  });

  // An all-relays failure is not an empty page: blessing it would latch the
  // first-sync watermark and keep a fresh device's DM list blank.
  if (relays.length > 0 && successfulRelays === 0) {
    throw new Error("Every DM relay query failed");
  }

  return { events: [...byId.values()], cursors: nextCursors };
}

/**
 * Query each relay individually for fixed filters and merge by id. A pooled
 * query aborts all relays 300ms after the first EOSE, cutting off auth-gated
 * relays mid NIP-42. Best-effort per relay.
 */
async function queryRelaysMerged(
  nostr: NostrPool,
  relays: string[],
  filters: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrRumor[]> {
  const byId = new Map<string, NostrRumor>();
  const results = await Promise.allSettled(
    relays.map((url) => nostr.relay(url).query(filters, { signal })),
  );
  for (const r of results) {
    if (r.status === "fulfilled") for (const e of r.value) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/** DM conversations: each counterparty with its latest kind-4 message, built client-side. */
export function useDMConversations(options?: { decryptPreviews?: boolean }) {
  // Previews cost a signer round-trip each (and may open the consent prompt), so
  // they're opt-in for the opened DMs list only.
  const decryptPreviews = options?.decryptPreviews ?? false;
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { mutedPubkeys, ready: muteReady } = useMutedPubkeys();
  // Filters widen when the contact list lands (the roster effect re-runs the query).
  const { knownPeers, displayLoading: knownPeersLoading } = useKnownDmPeers();
  const { consent } = useDecryptConsent();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  // Established peers: follows, accepts/1:1 pins, and participants of synced
  // conversations this account wrote in. Relay queries stay author-scoped.
  const knownPeerKey = knownPeers.join(",");
  const knownPeersRef = useRef(knownPeers);
  knownPeersRef.current = knownPeers;

  // `knownPeerKey` is NOT in the query key: it resolves async on cold load, and a
  // key change would drop to a fresh cache entry (visible list collapse). Read from a
  // ref and re-run this entry's queryFn on change instead.
  const queryKey = ["dm", "conversations", user?.pubkey, relayKey];

  // Per-relay pagination cursors for "load older" (a ref; reset on user/relay change).
  const cursorsRef = useRef<RelayCursors>({});
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const lastPullRef = useRef(0);
  // Start time of the last COMPLETED pull; once set, periodic pulls are `since` top-ups.
  const pullFloorRef = useRef<number | undefined>(undefined);
  // Established-peer set last fetched with; `undefined` = not yet observed (don't invalidate on mount).
  const fetchedKnownPeersRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    cursorsRef.current = {};
    lastPullRef.current = 0;
    pullFloorRef.current = undefined;
    setHasMore(true);
    // Roster changes re-run the queryFn so received filters widen and merge in.
    const previous = fetchedKnownPeersRef.current;
    fetchedKnownPeersRef.current = knownPeerKey;
    if (previous !== undefined && previous !== knownPeerKey && user?.pubkey) {
      invalidateOnce(queryClient, queryKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, relayKey, knownPeerKey, queryClient]);

  const query = useQuery<NostrRumor[]>({
    queryKey,
    // Keyed: older pages shift every index (see shareRows).
    structuralSharing: shareById,
    enabled: !!user?.pubkey && !knownPeersLoading,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const firstSync = !isDmSynced("nip04", pubkey);
      const store = await eventStore;
      // Newest established-peer set at execution time (not fetch scheduling).
      const scopedKnownPeers = knownPeersRef.current;
      const peerKey = [...scopedKnownPeers].sort().join(",");

      // 1. LOCAL-FIRST: paint from the store (fed by the wire), scoped to
      //    established authors like the relay queries.
      const cachedEvents = await store.query([
        { kinds: [KIND_DM], authors: [pubkey], limit: DM_PAGE_SIZE },
        ...(scopedKnownPeers.length > 0
          ? [{ kinds: [KIND_DM], authors: scopedKnownPeers, "#p": [pubkey], limit: DM_PAGE_SIZE }]
          : []),
      ]);
      const prev = queryClient.getQueryData<NostrRumor[]>(queryKey) ?? [];
      const local = mergeDmEvents(prev, cachedEvents);

      // A first sync paints once the first relay answers, not the slowest: legacy DMs are a
      // sideline beside NIP-17's, and most accounts have none anywhere. Each relay's events
      // merge in as it answers.
      let relayAnswered!: () => void;
      const firstAnswer = new Promise<void>((resolve) => (relayAnswered = resolve));
      const mergeRelayEvents = (events: NostrRumor[]) => {
        if (signal.aborted) return;
        if (events.length > 0) queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => mergeDmEvents(old, events));
        relayAnswered();
      };

      // 2. THROTTLED, un-awaited per-relay refresh that seeds the cursors.
      const pullDue = Date.now() - lastPullRef.current >= PULL_MIN_INTERVAL_MS;
      if (pullDue) lastPullRef.current = Date.now();
      const pull = (async () => {
        if (!pullDue || signal.aborted || relays.length === 0) return;
        const startedAt = Math.floor(Date.now() / 1000);
        // After the first full page, top up with `since` (NIP-04 timestamps are
        // real) instead of re-downloading the first page every minute.
        // Stored, so a cold start and the hook's other mount (same query key)
        // top up too instead of re-reading the first page.
        const floor = pullFloorRef.current ?? readDmPullFloor(pubkey, relayKey, peerKey);
        if (floor !== undefined) {
          // A floor restored from a previous launch skipped the first page, so
          // "load older" pages back from the oldest stored message instead.
          if (Object.keys(cursorsRef.current).length === 0) {
            cursorsRef.current = seedDmCursors(relays, local);
          }
          const since = dmTopUpSince(floor);
          try {
            const events = await queryRelaysMerged(
              nostr,
              relays,
              [
                { kinds: [KIND_DM], authors: [pubkey], since, limit: DM_PAGE_SIZE },
                ...(scopedKnownPeers.length > 0
                  ? [{ kinds: [KIND_DM], authors: scopedKnownPeers, "#p": [pubkey], since, limit: DM_PAGE_SIZE }]
                  : []),
              ],
              AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            );
            if (signal.aborted) return;
            // Only an answered top-up moves the floor.
            pullFloorRef.current = startedAt;
            writeDmPullFloor(pubkey, relayKey, peerKey, startedAt);
            if (events.length === 0) return;
            queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => mergeDmEvents(old, events));
          } catch {
            // Best-effort backstop; the live socket is the primary path.
          }
          return;
        }
        try {
          const { events, cursors } = await queryRelaysDmPage(
            nostr,
            relays,
            pubkey,
            {}, // first page per relay (no `until`)
            scopedKnownPeers,
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            mergeRelayEvents,
          );
          if (signal.aborted) return;
          cursorsRef.current = cursors;
          pullFloorRef.current = startedAt;
          writeDmPullFloor(pubkey, relayKey, peerKey, startedAt);
          setHasMore(hasMoreCursor(cursors));
          // Completed: later loads may trust the store.
          markDmSynced("nip04", pubkey);
          if (events.length === 0) return;
          queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => mergeDmEvents(old, events));
        } catch {
          // NOT marked synced on failure, or the next load paints a false empty list.
        }
      })();

      // First sync: nothing local, so await the network. Re-read the cache (the
      // pull merges via `setQueryData`) rather than returning pre-pull `local`.
      if (firstSync) {
        await Promise.race([pull, firstAnswer]);
        return mergeDmEvents(local, queryClient.getQueryData<NostrRumor[]>(queryKey) ?? []);
      }

      return local;
    },
    staleTime: 15_000,
    // No `initialData`: the store read is fast enough to block on, so the list
    // paints once in final order. Periodic local re-reads heal a wedged mobile
    // WebSocket; focus/reconnect catch up immediately.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // Load older conversations: each non-exhausted relay advances its own cursor.
  const loadMore = useCallback(async (): Promise<number> => {
    if (!user?.pubkey || loadingMoreRef.current || !hasMore || relays.length === 0) return 0;
    if (!hasMoreCursor(cursorsRef.current)) {
      setHasMore(false);
      return 0;
    }
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const { events, cursors } = await queryRelaysDmPage(
        nostr,
        relays,
        user.pubkey,
        cursorsRef.current,
        knownPeers,
        AbortSignal.timeout(8000),
      );
      cursorsRef.current = cursors;
      const more = hasMoreCursor(cursors);
      setHasMore(more);
      if (events.length === 0) return 0;
      let added = 0;
      queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => {
        const merged = mergeDmEvents(old, events);
        added = merged.length - old.length;
        return merged;
      });
      return added;
    } catch {
      return 0;
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, relayKey, knownPeerKey, hasMore, queryClient]);

  // Re-read when the wire announces a kind-4 change (the relay pull is throttled separately).
  useWireScopes((scopes) => {
    if (user?.pubkey && scopes.has("dm")) invalidateOnce(queryClient, queryKey);
  });

  const self = user?.pubkey ?? "";

  // One entry per counterparty (latest wins), minus muted peers (NIP-51). Nothing
  // until the mute set is `ready`, so muted rows never flash.
  const conversations = useMemo(() => {
    if (!muteReady) return [];
    const byPeer = new Map<string, { peer: string; latest: NostrRumor; mine: boolean }>();
    for (const event of query.data ?? []) {
      const peer = dmCounterparty(event, self);
      if (!peer || mutedPubkeys.has(peer)) continue;
      const sent = event.pubkey === self;
      const existing = byPeer.get(peer);
      if (!existing) {
        byPeer.set(peer, { peer, latest: event, mine: sent });
      } else {
        if (event.created_at > existing.latest.created_at) existing.latest = event;
        if (sent) existing.mine = true;
      }
    }
    return [...byPeer.values()].sort((a, b) => b.latest.created_at - a.latest.created_at);
  }, [query.data, self, mutedPubkeys, muteReady]);

  // Decrypt each conversation's latest message for the preview.
  const previewKey = conversations
    .map((c) => `${c.peer}:${c.latest.id}`)
    .join(",");

  const previews = useQuery<Record<string, string>>({
    queryKey: ["dm", "previews", self, previewKey, consent],
    enabled: decryptPreviews && !!self && !!user?.signer.nip04 && conversations.length > 0,
    staleTime: 60_000,
    // Keep the previous map while a new latest row decrypts (no inbox-wide blank).
    placeholderData: (previous, previousQuery) =>
      keepPreviousDmPreviews(previous, previousQuery?.queryKey, self, consent),
    queryFn: async () => {
      const nip04 = user!.signer.nip04!;
      const out: Record<string, string> = {};

      // Consent gate on uncached previews; a decline shows "Encrypted message".
      const targets = conversations.map(({ peer, latest }) => ({
        counterparty: peer,
        ciphertext: latest.content,
      }));
      if (!(await mayBulkDecrypt(user!.signer, "nip04", targets, signerNeedsApproval(user!.method)))) return out;

      await Promise.all(
        conversations.map(async ({ peer, latest }) => {
          try {
            out[peer] = await decryptCached(peer, latest, (cp, ct) => nip04.decrypt(cp, ct));
          } catch (err) {
            console.warn("DM preview decrypt failed", { peer, id: latest.id, err });
          }
        }),
      );
      return out;
    },
  });

  return {
    conversations,
    previews: previews.data ?? {},
    /** All fetched kind-4 events, newest-first (for searching locally-decrypted history). */
    events: query.data ?? [],
    // Loading until events and the mute set are settled (no unfiltered flash).
    isLoading: query.isLoading || knownPeersLoading || !muteReady,
    error: query.error,
    /** Fetch an older page of conversations (per-relay cursor pagination). */
    loadMore,
    /** Whether any relay still has older conversation history to page. */
    hasMore,
    isLoadingMore,
  };
}

/** The least a kind-4 conversation row must expose to be judged unread. */
export interface UnreadLegacyDmSource {
  peer: string;
  latest: { pubkey: string; created_at: number };
  mine: boolean;
}

/** The same for NIP-17, whose conversation key is a participant SET. */
export interface UnreadDm17Source {
  key: string;
  peers: string[];
  latest: { author: string; createdAt: number };
  mine: boolean;
}

/**
 * Whether either plane holds an unread conversation the INBOX would show (peer
 * sent the latest, newer than last-read). Both planes are narrowed to known peers
 * by `isKnown` here — kind-4 relay author-scoping is only a request — so strangers
 * never light the rail dot. Pure, for testing.
 */
export function hasUnreadDmConversations(
  legacy: readonly UnreadLegacyDmSource[],
  nip17: readonly UnreadDm17Source[],
  opts: {
    self: string;
    isKnown: (peer: string, mine: boolean) => boolean;
    getLastRead: (key: string) => number;
  },
): boolean {
  const { self, isKnown, getLastRead } = opts;
  if (
    legacy.some(
      (c) =>
        isKnown(c.peer, c.mine) &&
        c.latest.pubkey !== self &&
        c.latest.created_at > getLastRead(dmReadKey(c.peer)),
    )
  ) {
    return true;
  }
  return nip17.some(
    (c) =>
      // A group is in the inbox only when EVERY participant is known.
      c.peers.every((peer) => isKnown(peer, c.mine)) &&
      c.latest.author !== self &&
      c.latest.createdAt > getLastRead(dmReadKey(c.key)),
  );
}

export function useHasUnreadDMs(): boolean {
  const { user } = useCurrentUser();
  const { conversations } = useDMConversations();
  const { conversations: dm17Conversations } = useDm17Conversations();
  const { isKnown } = useKnownDmPeers();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    if (!user) return false;
    return hasUnreadDmConversations(conversations, dm17Conversations, {
      self: user.pubkey,
      isKnown,
      getLastRead,
    });
  }, [user, conversations, dm17Conversations, isKnown, getLastRead]);
}

/**
 * Whether ONE conversation is unread (peer sent the latest, newer than last-read),
 * for a DM pinned to the rail. No request-tier narrowing: pinning it is explicit.
 * Queries are shared with the rail's DMs button.
 */
export function useDmPeerUnread(peer: string | undefined): boolean {
  const { user } = useCurrentUser();
  const { conversations } = useDMConversations();
  const { conversations: dm17Conversations } = useDm17Conversations();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    if (!user || !peer) return false;
    const lastRead = getLastRead(dmReadKey(peer));
    const kind4 = conversations.find((c) => c.peer === peer);
    if (kind4 && kind4.latest.pubkey !== user.pubkey && kind4.latest.created_at > lastRead) {
      return true;
    }
    const dm17 = dm17Conversations.find((c) => c.key === peer);
    return Boolean(
      dm17 && dm17.latest.author !== user.pubkey && dm17.latest.createdAt > lastRead,
    );
  }, [user, peer, conversations, dm17Conversations, getLastRead]);
}

/** The decrypted kind-4 (NIP-04) thread with one peer, plus a `send` mutation. */
export function useDirectMessages(peer: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { consent, declined } = useDecryptConsent();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  // The peer's kind-10050 inbox. We READ from our relays (they serve our kind-4s)
  // but WRITE to ours ∪ theirs so the message reaches them; ours if they have none.
  const peerDmRelays = useDmRelaysFor(peer);
  const writeRelays = useMemo(() => {
    const merged = [...relays, ...peerDmRelays];
    return [...new Set(merged)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayKey, peerDmRelays.join(",")]);

  const self = user?.pubkey;
  const queryKey = useMemo(
    () => ["dm", "thread", self, peer, relayKey, consent] as const,
    [self, peer, relayKey, consent],
  );
  // localStorage snapshot of the newest decrypted rows (plaintext at rest; see timelineSnapshot.ts).
  const threadSnapshotScope = self && peer ? dmThreadSnapshotScope(self, peer) : undefined;
  // An empty first store read isn't authoritative until the initial pull settles.
  // Track the pull itself: a fresh cached result runs no queryFn.
  const [waitingForInitialPull, setWaitingForInitialPull] = useState(false);
  useEffect(() => {
    setWaitingForInitialPull(false);
  }, [self, peer, relayKey]);

  const query = useQuery<DecryptedDM[]>({
    queryKey,
    // Keyed: older pages shift every index (see shareRows).
    structuralSharing: shareById,
    // Resolves on the store read, so use the store-read policy (no retry ladder; see storeQuery).
    ...STORE_READ,
    enabled: !!self && !!peer && !!user?.signer.nip04,
    queryFn: async ({ signal }) => {
      const nip04 = user!.signer.nip04!;
      const store = await eventStore;

      // 1. LOCAL-FIRST: this thread's kind-4s from the store, as placeholders on
      //    the first frame. Both directions are `authors`-scoped (no strangers).
      const localEvents = await store.query([
        { kinds: [KIND_DM], authors: [self!], "#p": [peer!], limit: 1000 },
        { kinds: [KIND_DM], authors: [peer!], "#p": [self!], limit: 1000 },
      ]);
      const localThread = localEvents.filter((e) => dmCounterparty(e, self!) === peer);
      const prevLocal = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const localPlaceholders = mergeDmThread(prevLocal, buildThreadPlaceholders(localThread));
      if (localThread.length > 0) {
        void decryptThreadRows(
          localThread,
          self!,
          peer!,
          (cp, ct) => nip04.decrypt(cp, ct),
          EAGER_DECRYPT_COUNT,
          (row) => patchRow(queryClient, queryKey, row),
          (targets) => mayBulkDecrypt(user!.signer, "nip04", targets, signerNeedsApproval(user!.method)),
          () => { if (signerNeedsApproval(user!.method)) setDecryptConsent("declined"); },
        );
      }

      // 2. THROTTLED, un-awaited relay refresh. The waiting flag is raised only
      //    for a cold empty read with a pull actually in flight.
      const pulls = threadPulls(queryClient);
      const pullKey = `${self}|${peer}|${relayKey}`;
      const pullDue = Date.now() - (pulls.get(pullKey) ?? 0) >= PULL_MIN_INTERVAL_MS;
      if (pullDue) pulls.set(pullKey, Date.now());
      if (pullDue && localPlaceholders.length === 0 && !signal.aborted) {
        setWaitingForInitialPull(true);
      }
      void (async () => {
        if (!pullDue) return;
        if (signal.aborted) {
          pulls.delete(pullKey);
          return;
        }
        try {
          // sent = `authors:[self] #p:[peer]`, received = `authors:[peer] #p:[self]`.
          const events = await queryRelaysMerged(
            nostr,
            relays,
            [
              { kinds: [KIND_DM], authors: [self!], "#p": [peer!], limit: 1000 },
              { kinds: [KIND_DM], authors: [peer!], "#p": [self!], limit: 1000 },
            ],
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          );
          if (signal.aborted) {
            pulls.delete(pullKey);
            return;
          }
          const inThread = events.filter((e) => dmCounterparty(e, self!) === peer);
          if (inThread.length === 0) return;
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            mergeDmThread(old, buildThreadPlaceholders(inThread)),
          );
          void decryptThreadRows(
            inThread,
            self!,
            peer!,
            (cp, ct) => nip04.decrypt(cp, ct),
            EAGER_DECRYPT_COUNT,
            (row) => patchRow(queryClient, queryKey, row),
            (targets) => mayBulkDecrypt(user!.signer, "nip04", targets, signerNeedsApproval(user!.method)),
            () => { if (signerNeedsApproval(user!.method)) setDecryptConsent("declined"); },
          );
        } catch {
          // Best-effort; the next visit retries.
          pulls.delete(pullKey);
        } finally {
          setWaitingForInitialPull(false);
        }
      })();

      return localPlaceholders;
    },
    staleTime: 10_000,
    // Seed from the snapshot, which also primes the plaintext memo so these rows
    // stay decrypted and `decryptVisible` short-circuits.
    initialData: () => {
      const rows = readTimelineSnapshot<DecryptedDM>(threadSnapshotScope);
      if (rows) for (const r of rows) setRenderedPlaintext(r.id, r.content);
      return rows;
    },
    initialDataUpdatedAt: 0,
    // Periodic local re-read heals a wedged socket; catch up on focus/reconnect.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // Snapshot only DECRYPTED rows, without transient sending/failed status.
  const threadSnapshotItems = useMemo(() => {
    if (!query.data) return undefined;
    const rows = query.data
      .filter((m) => !m.encrypted && !m.status)
      .map(({ id, pubkey, created_at, content }) => ({ id, pubkey, created_at, content }));
    return rows.length > 0 ? rows : undefined;
  }, [query.data]);
  useTimelineSnapshotWriter(threadSnapshotScope, threadSnapshotItems);

  useWireScopes((scopes) => {
    if (self && peer && scopes.has(dmThreadScope(peer))) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  // Older history: one cursor per direction, since `limit` binds each filter
  // separately and a busy side would carry a shared cursor past the quiet side's
  // unread range. A direction ends only on an EMPTY page: relays cap `limit` below
  // ours, so a short page proves nothing.
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const cursorRef = useRef<{ sent: DirectionCursor; received: DirectionCursor } | undefined>(undefined);
  const loadingRef = useRef(false);

  useEffect(() => {
    cursorRef.current = undefined;
    setHasMore(true);
  }, [self, peer, relayKey]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!self || !peer || !user?.signer.nip04) return 0;
    if (loadingRef.current || !hasMore) return 0;

    const nip04 = user.signer.nip04;
    const current = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
    const cursor = (cursorRef.current ??= initialThreadCursors(current, self));

    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const filters = threadPageFilters(self, peer, cursor);
      if (filters.length === 0) {
        setHasMore(false);
        return 0;
      }
      const events = await queryRelaysMerged(nostr, relays, filters, AbortSignal.timeout(8000));

      const next = nextThreadCursors(cursor, events, self);
      cursorRef.current = next;
      if (next.sent === null && next.received === null) setHasMore(false);

      const inThread = events.filter((e) => dmCounterparty(e, self) === peer);
      const existing = new Set(current.map((m) => m.id));
      const fresh = inThread.filter((e) => !existing.has(e.id));

      // Backfilled rows are lazy placeholders (eager = 0); memoized ones still come back decrypted.
      const rows = await buildThreadRows(
        fresh,
        self,
        peer,
        (cp, ct) => nip04.decrypt(cp, ct),
        0,
      );

      if (rows.length === 0) return 0;

      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) => {
        const byId = new Map<string, DecryptedDM>();
        for (const m of [...rows, ...old]) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
      });
      return rows.length;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [self, peer, user?.signer.nip04, hasMore, queryClient, queryKey, nostr, relays]);

  const setMessageStatus = useCallback(
    (id: string, status: DecryptedDM["status"]) => {
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        old.map((m) => (m.id === id ? { ...m, status } : m)),
      );
    },
    [queryClient, queryKey],
  );

  // Publish a signed, already-rendered DM in the background and reconcile its status.
  const publish = useCallback(
    async (event: NostrEvent) => {
      try {
        // Mark our own echo before publish so push never shows it as incoming.
        await markOwnWebPushEvent(event.id);
        // Write to our DM relays ∪ the peer's 10050 inbox.
        await nostr.group(writeRelays).event(event, { signal: AbortSignal.timeout(8000) });
        // Confirmed; a live echo dedups by id.
        setMessageStatus(event.id, undefined);
        queryClient.invalidateQueries({ queryKey: ["dm", "conversations", user?.pubkey] });
      } catch (err) {
        setMessageStatus(event.id, "failed");
        throw err;
      }
    },
    [nostr, writeRelays, setMessageStatus, queryClient, user?.pubkey],
  );

  const send = useMutation({
    // Encrypt + sign, render immediately, publish in the background; `status`
    // reflects delivery. Signing is serialized via `signChainRef` (NIP-07
    // extensions reject concurrent calls); each queued message renders as a
    // "sending" placeholder under a temp id, swapped for the real id once signed.
    mutationFn: async (text: string) => {
      if (!user?.signer.nip04) throw new Error("NIP-04 encryption not supported by signer");
      if (!peer) throw new Error("No recipient");
      const trimmed = text.trim();
      if (!trimmed) return;

      const signer = user.signer;
      const self = user.pubkey;
      const tempId = `pending:${crypto.randomUUID()}`;
      const createdAt = Math.floor(Date.now() / 1000);

      // Render queued messages immediately, in order.
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        [
          ...old,
          {
            id: tempId,
            // Pinned across the id swap so the row doesn't remount.
            renderKey: tempId,
            pubkey: self,
            created_at: createdAt,
            content: trimmed,
            status: "sending" as const,
          },
        ].sort((a, b) => a.created_at - b.created_at),
      );
      // Deliberately no conversation-list invalidation (would re-decrypt every preview).

      try {
        const content = await signer.nip04!.encrypt(peer, trimmed);
        const event = await signer.signEvent({
          kind: KIND_DM,
          content,
          tags: [["p", peer]],
          created_at: createdAt,
        });

        queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
          old.map((m) =>
            m.id === tempId
              ? { ...m, id: event.id, created_at: event.created_at }
              : m,
          ),
        );

        // Seed the plaintext memo so the relay echo is a cache hit.
        setRenderedPlaintext(event.id, trimmed);

        void publish(event).catch(() => {
        });
      } catch {
        // Encrypt/sign failed: mark failed for retry; don't throw (fire-and-forget).
        setMessageStatus(tempId, "failed");
      }
    },
  });

  /** Re-publish a message that previously failed to send. */
  const retry = useCallback(
    (id: string) => {
      const messages = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const failed = messages.find((m) => m.id === id && m.status === "failed");
      if (!failed || !user || !peer) return;
      const signer = user.signer;
      setMessageStatus(id, "sending");

      void (async () => {
        try {
          const content = await signer.nip04!.encrypt(peer, failed.content);
          const event = await signer.signEvent({
            kind: KIND_DM,
            content,
            tags: [["p", peer]],
            created_at: failed.created_at,
          });
          // Reconcile the signed id with the placeholder id.
          if (event.id !== id) {
            queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
              old.map((m) => (m.id === id ? { ...m, id: event.id } : m)),
            );
          }
          await publish(event);
        } catch {
          setMessageStatus(id, "failed");
        }
      })();
    },
    [queryClient, queryKey, user, peer, setMessageStatus, publish],
  );

  /**
   * Decrypt a placeholder scrolled into view (IntersectionObserver), reading its
   * ciphertext from the event store. Idempotent; concurrent calls share one decrypt.
   */
  const decryptVisible = useCallback(
    (id: string) => {
      if (!self || !peer || !user?.signer.nip04) return;
      if (hasRenderedPlaintext(id)) {
        const content = getRenderedPlaintext(id)!;
        queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
          old.map((m) => (m.id === id && m.encrypted ? { ...m, content, encrypted: false } : m)),
        );
        return;
      }
      // Consent declined: never auto-decrypt on scroll; use the row's "Decrypt" button.
      if (declined) return;
      const nip04 = user.signer.nip04;
      void (async () => {
        const store = await eventStore;
        const [event] = await store.query([{ ids: [id] }]);
        if (!event) return;
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await decryptCached(counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.map((m) => (m.id === id ? { ...m, content, encrypted: false } : m)),
          );
        } catch {
          // Stays a placeholder; retried next time it enters view.
        }
      })();
    },
    [self, peer, user?.signer.nip04, eventStore, queryClient, queryKey, declined],
  );

  /** Decrypt ONE message on explicit request (bypasses the consent gate). */
  const decryptOne = useCallback(
    (id: string) => {
      if (!self || !peer || !user?.signer.nip04) return;
      const nip04 = user.signer.nip04;
      void (async () => {
        const store = await eventStore;
        const [event] = await store.query([{ ids: [id] }]);
        if (!event) return;
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await decryptCached(counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.map((m) => (m.id === id ? { ...m, content, encrypted: false } : m)),
          );
        } catch { /* ignore */ }
      })();
    },
    [self, peer, user?.signer.nip04, eventStore, queryClient, queryKey],
  );

  /** "Decrypt all": decrypt every encrypted row and flip global consent to allowed. */
  const decryptAll = useCallback(() => {
    if (!self || !peer || !user?.signer.nip04) return;
    const nip04 = user.signer.nip04;
    setDecryptConsent("allowed");
    void (async () => {
      const store = await eventStore;
      const rows = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const encryptedIds = rows.filter((m) => m.encrypted).map((m) => m.id);
      if (encryptedIds.length === 0) return;
      const events = await store.query([{ ids: encryptedIds }]);
      let ok = 0;
      await Promise.all(
        events.map(async (event) => {
          const counterparty = event.pubkey === self ? peer : event.pubkey;
          try {
            const content = await decryptCached(counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
            patchRow(queryClient, queryKey, {
              id: event.id,
              pubkey: event.pubkey,
              created_at: event.created_at,
              content,
            });
            ok++;
          } catch { /* ignore */ }
        }),
      );
      // The signer refused everything: undo the optimistic "allowed" so manual controls return.
      if (events.length > 0 && ok === 0 && signerNeedsApproval(user!.method)) setDecryptConsent("declined");
    })();
  }, [self, peer, user, eventStore, queryClient, queryKey]);

  return {
    messages: query.data ?? [],
    // The skeleton covers only the LOCAL read; the queryFn resolves before the relay pull.
    isLoading: query.isLoading,
    // The pending pull is reported separately ("Catching up…" vs "No messages yet").
    syncing: isEmptyThreadAwaitingPull(query.data?.length ?? 0, waitingForInitialPull),
    error: query.error,
    send: send.mutateAsync,
    isSending: send.isPending,
    retry,
    loadOlder,
    hasMore,
    isLoadingOlder,
    decryptVisible,
    /** Explicitly decrypt one message (the per-message "Decrypt" button). */
    decryptOne,
    /** Explicitly decrypt every encrypted row + grant consent ("Decrypt all"). */
    decryptAll,
    /** Whether the user declined bulk decryption (drives the manual controls). */
    decryptDeclined: declined,
    /** Whether any rendered row is still an encrypted placeholder. */
    hasEncrypted: (query.data ?? []).some((m) => m.encrypted),
  };
}
