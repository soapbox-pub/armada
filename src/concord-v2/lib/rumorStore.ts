/**
 * Concord V2 opened-event cache — the decrypted store for every plane.
 *
 * V2 traffic arrives as opaque kind-1059/21059 wraps (CORD-01). We never
 * persist those wraps anywhere: caching ciphertext is wasteful (every cold read
 * would re-run two NIP-44 opens and a Schnorr verify per event) and pollutes the
 * shared `armada-events` store. Instead we decrypt once on ingest and persist
 * the recovered {@link OpenedEvent} here — a signature-less event (`sig: ""`)
 * carrying its real kind / author / content / tags plus the plane provenance
 * (stream address, seal) folded into tags — so every plane reads back with an
 * ordinary Nostr filter and no decrypt:
 *
 *   chat:     store.query([{ kinds: [9], "#channel": [channelIdHex], limit }])
 *   control:  store.query([{ "#stream": [controlPk1, controlPk2, …] }])
 *
 * Backed by `@nostrify/indexeddb` (the strfry-port NStore), a SEPARATE database
 * from `armada-events` so its query engine, its custom tag index, and its NIP-09
 * deletion semantics stay isolated.
 *
 * The full signed SEAL is preserved (tag `seal`) because the Control Plane
 * re-wraps plaintext seals verbatim across epochs during a compaction (CORD-02
 * §5 / `rewrapSeal`). Chat never re-wraps, but stores the seal uniformly.
 *
 * Deletes ARE deletes: a kind-5 rumor written here triggers the store's NIP-09
 * pass, which physically removes the targeted event it authored. Moderator
 * deletes are authorized against the roster at the WRITE site (see `useChannel2`)
 * before the kind-5 rumor reaches the store.
 *
 * Trust note: this persists DECRYPTED plane data at rest — the same device-trust
 * level as the folded cache and the signer's decrypt cache, which already do.
 * Anyone with local storage access already holds the keys. Wiped on logout (see
 * purgeClientStorage).
 */

import { NIndexedDB } from "@nostrify/indexeddb";
import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import { resolveMs, type OpenedEvent } from "@/concord-v2/lib/stream";
import { emitWireScopes } from "@/wire/bus";
import type { OpenedChat } from "@/concord-v2/lib/chat";

const DB_NAME = "armada-concord-rumors";

/** Provenance tags we inject onto the stored event (never part of the rumor). */
const TAG_STREAM = "stream";
const TAG_SEAL = "seal";
const TAG_WRAP = "wrap";
const TAG_SEALKIND = "sealkind";

/** Multi-letter tags chat/plane queries need indexed (beyond single-letter). */
const QUERYABLE_TAGS = new Set(["channel", TAG_STREAM, "e", "q", "p", "k"]);

/**
 * Index the tags our queries need. The default NIndexedDB policy only indexes
 * SINGLE-letter tags, but we query by `channel` and `stream` (multi-letter), so
 * a `{ "#channel": [...] }` / `{ "#stream": [...] }` filter would match nothing
 * without this. Never index the bulky `seal` blob.
 */
function indexTags(event: NostrEvent): string[][] {
  return event.tags.filter(
    ([name, value]) =>
      typeof name === "string" &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length < 200 &&
      name !== TAG_SEAL &&
      (name.length === 1 || QUERYABLE_TAGS.has(name)),
  );
}

let store: NIndexedDB | undefined;

/** The singleton opened-event store (opens the DB in the background on first use). */
export function rumorStore(): NIndexedDB {
  if (!store) store = new NIndexedDB(DB_NAME, { indexTags });
  return store;
}

/** Warm the IndexedDB connection so the first read hits a hot store. */
export function warmRumorStore(): void {
  try {
    void rumorStore()
      .query([{ kinds: [9], limit: 1 }])
      .catch(() => undefined);
  } catch {
    // IndexedDB unavailable — the store degrades to a no-op.
  }
}

// ── Codec: OpenedEvent ⇆ stored event ─────────────────────────────────────────
//
// The stored event IS the recovered rumor (its `id` is the rumor id, the NIP-01
// hash), `pubkey` the REAL author (so NIP-09 self-delete matches), `sig: ""`.
// Plane provenance rides synthetic tags: `stream` (the wrap author / stream
// address — how non-chat planes query), `wrap`, `sealkind`, and `seal` (the full
// signed seal JSON, so a control compaction can re-wrap it). These are stripped
// on read so the reconstructed OpenedEvent's `tags` are byte-identical to the
// rumor's.

/** Synthetic provenance tag names, stripped when reconstructing the rumor. */
const PROVENANCE = new Set([TAG_STREAM, TAG_SEAL, TAG_WRAP, TAG_SEALKIND]);

/** Build the stored event for an opened stream event (any plane). */
export function openedToStored(opened: OpenedEvent): NostrEvent {
  const tags: string[][] = [
    ...opened.tags,
    [TAG_STREAM, opened.streamPk],
    [TAG_WRAP, opened.wrapId],
    [TAG_SEALKIND, String(opened.sealKind)],
    [TAG_SEAL, JSON.stringify(opened.seal)],
  ];
  return {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags,
    created_at: opened.createdAt,
    pubkey: opened.author,
    sig: "",
  };
}

/** Reconstruct an OpenedEvent from a stored event. */
export function storedToOpened(ev: NostrEvent): OpenedEvent {
  const tags = ev.tags.filter((t) => !PROVENANCE.has(t[0]));
  const streamPk = ev.tags.find((t) => t[0] === TAG_STREAM)?.[1] ?? "";
  const wrapId = ev.tags.find((t) => t[0] === TAG_WRAP)?.[1] ?? "";
  const sealKind = Number(ev.tags.find((t) => t[0] === TAG_SEALKIND)?.[1] ?? "0");

  // The seal is the full signed NIP-59 seal JSON — bulky, and needed ONLY by
  // the control-plane rekey path (rewrapSeal), NEVER to render a chat message.
  // Parsing it eagerly here cost a JSON.parse of a large blob for every message
  // in the window on every channel read (a real switch-latency tax on Android).
  // Defer it behind a lazy, memoized getter so the parse happens only if a
  // consumer actually reads `.seal`.
  const sealRaw = ev.tags.find((t) => t[0] === TAG_SEAL)?.[1] ?? "{}";
  let sealParsed: NostrEvent | undefined;

  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags,
    ms: resolveMs(ev.created_at, tags),
    createdAt: ev.created_at,
    wrapId,
    streamPk,
    sealKind,
    get seal(): NostrEvent {
      if (sealParsed === undefined) {
        try {
          sealParsed = JSON.parse(sealRaw) as NostrEvent;
        } catch {
          sealParsed = {} as NostrEvent;
        }
      }
      return sealParsed;
    },
  };
}

/** Reconstruct an OpenedChat (adds channel/epoch from the rumor's binding tags). */
export function storedToOpenedChat(ev: NostrEvent, channelIdHex: string): OpenedChat {
  const opened = storedToOpened(ev);
  const epochTag = opened.tags.find((t) => t[0] === "epoch")?.[1];
  return { ...opened, channelIdHex, epoch: epochTag ? BigInt(epochTag) : 0n };
}

// ── Reads / writes ────────────────────────────────────────────────────────────

/** All chat-plane rumor kinds we persist and fold. */
const CHAT_KINDS = [5, 7, 9, 1111, 3302, 9735];

/**
 * Read a channel's cached chat rumors, newest-first up to `limit`. A `channel`
 * tag query hits the tag index directly. `before` (a `created_at` upper bound,
 * exclusive) pages older history out of the store.
 */
export async function queryChannelRumors(
  channelIdHex: string,
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const filter: { kinds: number[]; "#channel": string[]; limit: number; until?: number } = {
    kinds: CHAT_KINDS,
    "#channel": [channelIdHex],
    limit: opts.limit,
  };
  if (opts.before !== undefined) filter.until = opts.before - 1;
  const events = await rumorStore().query([filter], { signal: opts.signal });
  return events.map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * Read the newest `perChannel` chat rumors for EACH of several channels in a
 * SINGLE store transaction, returned grouped by channel id.
 *
 * The store's `query([...])` runs every filter concurrently inside one
 * readonly transaction, so passing one `#channel` filter per channel collapses
 * what used to be N independent `queryChannelRumors` calls (N transactions, N
 * connection acquisitions — the source of the channel-switch contention) into a
 * single transaction. Each filter is independently `limit`-bounded, so a busy
 * channel can't starve a quiet one (unlike a single multi-value `#channel`
 * filter, whose global limit is shared across channels).
 *
 * Channels with no cached rumors are omitted from the result map.
 */
export async function queryRumorsByChannel(
  channelIdsHex: string[],
  opts: { perChannel: number; signal?: AbortSignal },
): Promise<Map<string, OpenedChat[]>> {
  const out = new Map<string, OpenedChat[]>();
  if (channelIdsHex.length === 0) return out;

  const events = await rumorStore().query(
    channelIdsHex.map((idHex) => ({
      kinds: CHAT_KINDS,
      "#channel": [idHex],
      limit: opts.perChannel,
    })),
    { signal: opts.signal },
  );

  // One query() merges + de-dupes across filters, so recover each row's channel
  // from its own binding tag rather than trusting filter order.
  for (const ev of events) {
    const idHex = ev.tags.find((t) => t[0] === "channel")?.[1];
    if (!idHex) continue;
    let list = out.get(idHex);
    if (!list) out.set(idHex, (list = []));
    list.push(storedToOpenedChat(ev, idHex));
  }
  return out;
}

/**
 * Read cached messages across a community's channels that p-tag `pubkey` — the
 * "@ Mentions" view, purely local (no relay, no decrypt). Both `p` and
 * `channel` are in {@link QUERYABLE_TAGS}, so the filter is index-backed. Each
 * message's own `channel` binding tag recovers its channel id for the row.
 * Covers kind-9 messages and kind-1111 thread replies (a reply p-tags the
 * message author, so "replied to you" surfaces here too).
 *
 * Deliberately NOT derived from {@link queryRumorsByChannel}: that scan reads
 * only the newest window of each channel, so a mention older than a busy
 * channel's window would silently vanish from the tab. This single indexed
 * filter reaches the newest `limit` mentions across the WHOLE store, however
 * deep, in one cheap transaction.
 */
export async function queryMentionRumors(
  channelIdsHex: string[],
  pubkey: string,
  opts: { limit: number; signal?: AbortSignal },
): Promise<OpenedChat[]> {
  if (channelIdsHex.length === 0 || !pubkey) return [];
  const filter = {
    kinds: [9, 1111],
    "#p": [pubkey],
    "#channel": channelIdsHex,
    limit: opts.limit,
  };
  const events = await rumorStore().query([filter], { signal: opts.signal });
  return events.map((ev) =>
    storedToOpenedChat(ev, ev.tags.find((t) => t[0] === "channel")?.[1] ?? ""),
  );
}

/** How many chat rumors are cached for a channel. */
export async function countChannelRumors(channelIdHex: string): Promise<number> {
  const { count } = await rumorStore().count([{ kinds: CHAT_KINDS, "#channel": [channelIdHex] }]);
  return count;
}

/**
 * Read every cached opened event published to one of `streamPks` (a plane's
 * stream addresses across held epochs). Used by the control / guestbook / rekey
 * planes, which query by stream address rather than by channel tag.
 */
export async function queryByStreams(
  streamPks: string[],
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<OpenedEvent[]> {
  if (streamPks.length === 0) return [];
  const filter: { "#stream": string[]; limit?: number } = { "#stream": streamPks };
  if (opts?.limit !== undefined) filter.limit = opts.limit;
  const events = await rumorStore().query([filter], { signal: opts?.signal });
  return events.map(storedToOpened);
}

/**
 * Persist opened stream events (any plane). Kind-5 deletes trigger the store's
 * self-only NIP-09 removal of their targets. Best-effort: failures are
 * swallowed. Resolves once the batched write commits, so callers that need to
 * act on the durable result (e.g. ring the bus) can await it; most fire and
 * forget.
 */
export function writeOpened(opened: OpenedEvent[]): Promise<void> {
  if (opened.length === 0) return Promise.resolve();
  const s = rumorStore();
  return Promise.all(opened.map((o) => s.event(openedToStored(o))))
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Persist opened chat rumors, then ring the wire bus for each channel written
 * so every live timeline (and the community scan) re-reads — regardless of
 * which query kicked off the write. This is what makes the write→paint path
 * event-driven: a backfill that decrypted a cold channel's history announces
 * `c2:<channel>` once its rumors are durably stored, so the timeline paints
 * even if the query that started the backfill was superseded or aborted first.
 *
 * The emit is deferred until the write commits, so the re-read it triggers sees
 * the just-written rows.
 */
export function writeRumors(opened: OpenedChat[]): void {
  if (opened.length === 0) return;
  const channels = new Set(opened.map((o) => o.channelIdHex).filter(Boolean));
  void writeOpened(opened).then(() => {
    if (channels.size > 0) emitWireScopes([...channels].map((id) => `c2:${id}`));
  });
}

// ── Pending raw-wrap holding store ──────────────────────────────────────────
//
// The native background service (Android/iOS) receives V2 wraps but can't
// decrypt them — it has no stream keys. It parks the raw kind-1059/21059 wraps
// here (a SEPARATE tiny NIndexedDB) instead of the shared `armada-events` store;
// the WebView's plane hooks — which DO hold the keys — read them with
// {@link peekPendingWraps}, decrypt, and acknowledge ONLY the wraps that
// actually decoded with {@link ackPendingWraps}. A wrap is never deleted
// before its rumor is safely in the opened-event store: an aborted or failed
// decrypt round leaves it parked for the next read (a notified message must
// never be locally destructible — issue #19). Undecodable stragglers (e.g. a
// key never arrives) are pruned by age. So no 1059 ever lands in
// `armada-events`, yet a notification's message survives a cold launch. Wraps
// are indexed only by their author (the stream address) so a plane can read
// exactly its own.

const PENDING_DB_NAME = "armada-concord-pending";

/** Parked wraps older than this are pruned (key never arrived / dead plane). */
const PENDING_MAX_AGE_SECS = 14 * 24 * 3600;

let pending: NIndexedDB | undefined;

function pendingStore(): NIndexedDB {
  // Default indexTags already covers single-letter `p`; we query by `authors`
  // (the wrap's stream pubkey), which needs no tag index.
  if (!pending) pending = new NIndexedDB(PENDING_DB_NAME);
  return pending;
}

/**
 * Whether the pending store is known to hold nothing peek-worthy:
 *   - `true`      — provably empty; peeks return without touching IndexedDB.
 *   - `false`     — something is (or may be) parked; peeks do the real read.
 *   - `undefined` — unknown (fresh session); the FIRST peek probes the durable
 *                   store once and caches the answer.
 *
 * The probe is what keeps this correct across restarts: wraps parked in a
 * PREVIOUS session (key never arrived before the app was killed) are durable,
 * so a session-scoped "was anything parked?" flag alone would hide them from
 * the drain forever — the native service's buffer was already drained, so
 * nothing re-parks them. One cheap `limit: 1` probe on the first peek finds
 * them; after that, the common web/desktop case (nothing ever parked) skips
 * IndexedDB on every subsequent peek, keeping the parked-wrap drain off the
 * channel-read hot path.
 */
let pendingKnownEmpty: boolean | undefined;

/** How often (ms) to run the age-prune of undecodable stragglers. */
const PENDING_PRUNE_INTERVAL_MS = 5 * 60_000;
let lastPendingPruneAt = 0;

/** Park raw V2 wraps for later WebView-side decryption (native ingest path). */
export function parkPendingWraps(wraps: NostrEvent[]): void {
  if (wraps.length === 0) return;
  pendingKnownEmpty = false;
  const s = pendingStore();
  void Promise.all(wraps.map((w) => s.event(w))).catch(() => undefined);
}

/**
 * Read (WITHOUT removing) the raw wraps parked for a plane's stream addresses.
 * The caller decrypts them, writes the recovered rumors to the opened-event
 * store, and then acknowledges the decoded ones via {@link ackPendingWraps}.
 *
 * Returns immediately when the pending store is known empty (see {@link
 * pendingKnownEmpty}). Otherwise reads the parked wraps, and — at most once
 * every {@link PENDING_PRUNE_INTERVAL_MS} — age-prunes permanently-undecodable
 * stragglers (a readwrite scan kept off the per-peek path).
 */
export async function peekPendingWraps(streamPks: string[]): Promise<NostrEvent[]> {
  if (streamPks.length === 0) return [];
  if (pendingKnownEmpty === true) return [];
  const s = pendingStore();
  try {
    if (pendingKnownEmpty === undefined) {
      // First peek this session: one cheap probe of the durable store, so
      // wraps parked in a previous session are still found (see above).
      const any = await s.query([{ kinds: [1059, 21059], limit: 1 }]);
      // A concurrent park may have flipped this to `false` mid-probe; an empty
      // probe result must not clobber that.
      if (pendingKnownEmpty === undefined) pendingKnownEmpty = any.length === 0;
      if (pendingKnownEmpty === true) return [];
    }
    const now = Date.now();
    if (now - lastPendingPruneAt >= PENDING_PRUNE_INTERVAL_MS) {
      lastPendingPruneAt = now;
      const cutoff = Math.floor(now / 1000) - PENDING_MAX_AGE_SECS;
      void s.remove([{ kinds: [1059, 21059], until: cutoff }]).catch(() => undefined);
    }
    return await s.query([{ kinds: [1059, 21059], authors: streamPks, limit: 1000 }]);
  } catch {
    return [];
  }
}

/** Remove parked wraps whose rumors are now safely in the opened-event store. */
export function ackPendingWraps(wrapIds: string[]): void {
  if (wrapIds.length === 0) return;
  const s = pendingStore();
  void s.remove([{ ids: wrapIds }]).catch(() => undefined);
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// Per-stream resume state, persisted in the folded IndexedDB cache so a cold
// launch resumes sync instead of refetching everything it has already seen. Kept
// tiny (three numbers per key). Keyed by an opaque scope string: a channel id
// (chat) or a community id + plane name (control/guestbook/rekey).

/** A stream's persisted sync position. */
export interface StreamCursor {
  /** `created_at` of the newest wrap ingested (the live-sub / refetch `since` floor). */
  newest: number;
  /** `created_at` of the oldest wrap paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop issuing older-backfills. */
  exhausted: boolean;
}

const cursorKey = (scope: string) => `concord2-cursor:${scope}`;

/** Read a scope's sync cursor, or undefined if none has been saved yet. */
export function readStreamCursor(scope: string): Promise<StreamCursor | undefined> {
  return readFolded<StreamCursor>(cursorKey(scope));
}

/**
 * Merge new sync progress into a scope's cursor (best-effort). `newest` only
 * advances forward, `oldest` only recedes, `exhausted` is sticky until cleared.
 */
export async function updateStreamCursor(scope: string, patch: Partial<StreamCursor>): Promise<void> {
  const prev = await readStreamCursor(scope);
  const next: StreamCursor = {
    newest: Math.max(prev?.newest ?? 0, patch.newest ?? 0),
    oldest:
      patch.oldest !== undefined
        ? prev?.oldest
          ? Math.min(prev.oldest, patch.oldest)
          : patch.oldest
        : (prev?.oldest ?? 0),
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
  };
  await writeFolded(cursorKey(scope), next);
}

/** Clear the exhausted flag (e.g. after a rekey catch-up unlocks older history). */
export async function clearStreamExhausted(scope: string): Promise<void> {
  const prev = await readStreamCursor(scope);
  if (prev?.exhausted) await writeFolded(cursorKey(scope), { ...prev, exhausted: false });
}

// Back-compat aliases (chat call sites).
export const readChannelCursor = readStreamCursor;
export const updateChannelCursor = updateStreamCursor;
export const clearChannelExhausted = clearStreamExhausted;
