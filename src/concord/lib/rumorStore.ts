/**
 * Concord opened-event cache — the decrypted store for every plane.
 *
 * Wraps (CORD-01) are never persisted; each is decrypted once on ingest and the
 * rumor stored EXACTLY as its author wrote it, so reads are plain filters:
 *
 *   chat: store.query([{ kinds: [9], "#channel": [channelIdHex], limit }])
 *
 * One ArmadaDB tenant PER COMMUNITY (`c2:<communityIdHex>`). This is a SECURITY
 * boundary: tags are keyholder-written data, so with a shared store one bug in
 * `checkChannelBinding` / {@link writeOpened} could serve a forged tag into
 * another community. The caller picks the tenant from keys it holds. Community
 * ids have no epoch input (CORD-01 §A.4), so rekeys don't move the tenant.
 *
 * Signed seals (needed for compaction re-wraps, CORD-02 §5) live in KV keyed by
 * rumor id ({@link readStoredSeal}), not in the row — a tag would change the
 * bytes the rumor id commits to.
 *
 * Kind-5 rumors trigger a real NIP-09 delete; moderator deletes are authorized
 * at the write site (`useChannel`). Decrypted data at rest, same trust level as
 * the folded cache; wiped on logout (purgeClientStorage).
 */

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { readFoldedShared, writeFolded } from "@/lib/foldedCache";
import {
  KIND_COMMENT,
  KIND_DELETE,
  KIND_EDIT,
  KIND_MESSAGE,
  KIND_SEAL_PLAINTEXT,
  KIND_WEBXDC,
  PLANE_KINDS,
  PLANE_RULES,
  type Plane,
} from "@/concord/lib/kinds";
import { isExpired } from "@/lib/nip17/protocol";
import { resolveMs, type OpenedEvent, type OpenedWireEvent } from "@/concord/lib/stream";
import { messageMatchesMedia, type SearchMedia } from "@/concord/lib/search";
import { emitWireScopes } from "@/wire/bus";
import { ARMADA_TENANTS, getArmadaDB } from "@/lib/db/armadaDB";
import { isRemovedMessageId } from "@/lib/removedMessages";
import { isUserBannedNow, tombstoned } from "@/lib/bannedUsers";
import { literalSearch } from "@/lib/db/ParsedFilter";
import type { NRumorStore } from "@/lib/db/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { OpenedChat } from "@/concord/lib/chat";
import { currentGuestbookGroup, guestbookGroups } from "@/concord/lib/guestbook";
import type { Community } from "@/concord/lib/types";
import { confirmOutgoing } from "@/concord/lib/outgoing";

/** The chat plane's channel binding (CORD-03 §3) — the tag chat reads index. */
const TAG_CHANNEL = "channel";

/**
 * The opened-event store for one community. `defaultIndexTags` covers the
 * multi-letter `channel` plus single-letter tags.
 */
function rumorStore(communityIdHex: string): NRumorStore {
  return getArmadaDB().tenant(communityTenant(communityIdHex));
}

/**
 * Each community's stored Control and Guestbook planes, shared by every reader until
 * the next write that can change them. Boot folds, gates, seeds and the notifiers'
 * Timeouts and Nicknames all read whole planes, and on Android each read
 * re-serialized it across the bridge (measured: 91 reads, 4.4 MB, for 40
 * communities). Bumped on every plane write, delete and removal here, which every
 * row reaches through, including the service's (via the drain's ingest).
 */
const planeMemo = new Map<string, { rev: number; rows: Promise<NostrRumor[]> }>();
const tenantRev = new Map<string, number>();
const MEMO_PLANES: ReadonlySet<Plane> = new Set(["control", "guestbook"]);
const planeMemoKey = (communityIdHex: string, plane: Plane) => `${plane}:${communityIdHex}`;

function touchTenant(communityIdHex: string): void {
  tenantRev.set(communityIdHex, (tenantRev.get(communityIdHex) ?? 0) + 1);
  for (const plane of MEMO_PLANES) planeMemo.delete(planeMemoKey(communityIdHex, plane));
}

/** Forget the shared plane reads on logout: they are decrypted community state. */
export function clearRumorStoreMemory(): void {
  planeMemo.clear();
  tenantRev.clear();
  guestbookAddrs.clear();
  guestbookAddrsReady.clear();
  guestbookAddrsPending.clear();
  snapshotsNoted.clear();
  pendingChat.clear();
}

/** The ArmadaDB tenant id holding a community's opened events. */
export function communityTenant(communityIdHex: string): string {
  return `c2:${communityIdHex}`;
}

// Control snapshot membership. Wraps aren't stored; the one envelope fact not in
// the rumor is whether a control edition arrived under the CURRENT epoch's
// control stream (compaction re-wraps verbatim, CORD-06 §3, so ids match, but a
// snapshot outranks old-root fragments — `headCandidates`). Kept as one KV key per
// (control stream address, rumor), so recording one never reads and two writes
// can't lose each other: a wrap already seen is never offered again to put one back.

/** KV key prefix holding a community's control snapshot entries. */
export const SNAPSHOT_PREFIX = "c2snap:";
const snapshotPrefix = (communityIdHex: string) => `${SNAPSHOT_PREFIX}${communityIdHex}:`;

/** KV key recording that `rumorId` arrived under control stream address `controlPk`. */
export const snapshotKey = (communityIdHex: string, controlPk: string, rumorId: string) =>
  `${snapshotPrefix(communityIdHex)}${controlPk}:${rumorId}`;

/**
 * The rumor ids that arrived under `controlPk`, or undefined. May be a superset
 * of what's stored (deletes don't rewrite it); callers only use it as a filter.
 */
export async function readControlSnapshot(
  communityIdHex: string,
  controlPk: string,
): Promise<Set<string> | undefined> {
  if (!communityIdHex || !controlPk) return undefined;
  try {
    const prefix = `${snapshotPrefix(communityIdHex)}${controlPk}:`;
    const entries = await getArmadaDB().kv.list({ prefix });
    return entries.length > 0 ? new Set(entries.map(({ key }) => key.slice(prefix.length))) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record which control stream each fresh rumor arrived on. Only needed for Refounded
 * communities, so {@link writeOpened} skips it when `refounded` is false.
 */
export async function noteControlSnapshot(
  communityIdHex: string,
  opened: Array<{ streamPk?: string; rumorId: string }>,
): Promise<void> {
  const kv = getArmadaDB().kv;
  // Sweeps re-offer what they read: a key recorded this session isn't written again.
  const keys = opened.flatMap((o) => (o.streamPk ? [snapshotKey(communityIdHex, o.streamPk, o.rumorId)] : []));
  await Promise.all(
    keys.filter((key) => !snapshotsNoted.has(key)).map(async (key) => {
      await kv.set(key, 1);
      snapshotsNoted.add(key);
    }),
  );
}

/** Snapshot keys written this session. */
const snapshotsNoted = new Set<string>();

// The Guestbook epoch a rumor arrived at, by the same arrangement: only the live
// epoch's Nicknames count (CORD-04 §10), and nothing in the rumor says which it was.
// One key per (rumor, address), so two writes can't lose each other; the session's map of
// what is recorded keeps a re-offered rumor from being written again.
export const GUESTBOOK_ADDR_PREFIX = "c2gbaddr:";
const guestbookAddrPrefix = (communityIdHex: string) => `${GUESTBOOK_ADDR_PREFIX}${communityIdHex}:`;
export const guestbookAddrKey = (communityIdHex: string, rumorId: string, pk: string) =>
  `${guestbookAddrPrefix(communityIdHex)}${rumorId}:${pk}`;

/** Per community, each rumor's addresses: read from KV once a session, then kept current by every write. */
const guestbookAddrs = new Map<string, Promise<Map<string, Set<string>>>>();
/** The loaded maps, so a write lands in one synchronously; and writes made while one loads. */
const guestbookAddrsReady = new Map<string, Map<string, Set<string>>>();
const guestbookAddrsPending = new Map<string, Array<{ rumorId: string; pk: string }>>();

function addAddr(map: Map<string, Set<string>>, rumorId: string, pk: string): void {
  const held = map.get(rumorId);
  if (held) held.add(pk);
  else map.set(rumorId, new Set([pk]));
}

/** Every address each Guestbook rumor of a community was recorded arriving at. */
export function readGuestbookAddresses(communityIdHex: string): Promise<Map<string, Set<string>>> {
  let loaded = guestbookAddrs.get(communityIdHex);
  if (!loaded) {
    const prefix = guestbookAddrPrefix(communityIdHex);
    const pending: Array<{ rumorId: string; pk: string }> = [];
    guestbookAddrsPending.set(communityIdHex, pending);
    const load: Promise<Map<string, Set<string>>> = getArmadaDB().kv.list({ prefix }).then((entries) => {
      const map = new Map<string, Set<string>>();
      for (const { key } of entries) {
        const [rumorId, pk] = key.slice(prefix.length).split(":");
        if (rumorId && pk) addAddr(map, rumorId, pk);
      }
      for (const a of pending) addAddr(map, a.rumorId, a.pk);
      // A load a session clear superseded publishes nothing: its map is the old session's.
      if (guestbookAddrs.get(communityIdHex) === load) {
        guestbookAddrsPending.delete(communityIdHex);
        guestbookAddrsReady.set(communityIdHex, map);
      }
      return map;
    });
    // A failed read is retried by the next caller rather than remembered as empty.
    load.catch(() => {
      if (guestbookAddrs.get(communityIdHex) !== load) return;
      guestbookAddrs.delete(communityIdHex);
      guestbookAddrsPending.delete(communityIdHex);
    });
    guestbookAddrs.set(communityIdHex, load);
    loaded = load;
  }
  return loaded.catch(() => new Map());
}

/** Each stored Guestbook rumor tagged with the address it was recorded arriving at: the live epoch's where it was one. */
export async function withGuestbookStreams(community: Community, stored: OpenedEvent[]): Promise<OpenedEvent[]> {
  const live = currentGuestbookGroup(community).pk;
  const held = guestbookGroups(community).map((g) => g.pk);
  const addrs = await readGuestbookAddresses(community.idHex);
  if (addrs.size === 0) return stored;
  return stored.map((e) => {
    if (e.streamPk !== undefined) return e;
    const at = addrs.get(e.rumorId);
    const pk = at && (at.has(live) ? live : held.find((h) => at.has(h)));
    return pk ? { ...e, streamPk: pk } : e;
  });
}

async function noteGuestbookStreams(communityIdHex: string, opened: Array<{ streamPk?: string; rumorId: string }>): Promise<void> {
  const offered = opened.filter((o): o is { streamPk: string; rumorId: string } => Boolean(o.streamPk));
  if (offered.length === 0) return;
  // Every sweep re-offers the wraps it reads; only an address not yet recorded is written.
  const known = await readGuestbookAddresses(communityIdHex);
  const fresh = offered.filter((o) => !known.get(o.rumorId)?.has(o.streamPk));
  if (fresh.length === 0) return;
  const ready = guestbookAddrsReady.get(communityIdHex);
  const pending = guestbookAddrsPending.get(communityIdHex);
  for (const o of fresh) {
    if (ready) addAddr(ready, o.rumorId, o.streamPk);
    else pending?.push({ rumorId: o.rumorId, pk: o.streamPk });
  }
  const kv = getArmadaDB().kv;
  await Promise.all(fresh.map((o) => kv.set(guestbookAddrKey(communityIdHex, o.rumorId, o.streamPk), 1)));
}

/**
 * Forget snapshot sets of control addresses outside `keepPks`, so retired epochs
 * don't accumulate. Best-effort; once per community per session.
 */
export async function pruneControlSnapshots(
  communityIdHex: string,
  keepPks: string[],
): Promise<void> {
  if (!communityIdHex) return;
  try {
    const kv = getArmadaDB().kv;
    const prefix = snapshotPrefix(communityIdHex);
    const keep = new Set(keepPks);
    const stale = (await kv.list({ prefix }))
      .map(({ key }) => key)
      .filter((key) => !keep.has(key.slice(prefix.length).split(":")[0]));
    await Promise.all(stale.map(async (key) => {
      await kv.delete(key);
      snapshotsNoted.delete(key);
    }));
  } catch {
    // best-effort
  }
}

// Codec: the stored row IS the recovered rumor (`id` = rumor id, `pubkey` = real
// author so NIP-09 self-delete matches, author's own `tags`, no `sig`). Envelope
// facts and seals live elsewhere, keyed by id.

/** Build the stored rumor for an opened stream event (any plane). */
export function openedToStored(opened: OpenedEvent): NostrRumor {
  return {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags: opened.tags,
    created_at: opened.createdAt,
    pubkey: opened.author,
  };
}

/** Reconstruct an OpenedEvent from a stored rumor; envelope fields are absent (the wrap is gone). */
export function storedToOpened(ev: NostrRumor): OpenedEvent {
  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags: ev.tags,
    ms: resolveMs(ev.created_at, ev.tags),
    createdAt: ev.created_at,
  };
}

/** Reconstruct an OpenedChat (adds channel/epoch from the rumor's binding tags). */
export function storedToOpenedChat(ev: NostrRumor, channelIdHex: string): OpenedChat {
  const opened = storedToOpened(ev);
  const epochTag = opened.tags.find((t) => t[0] === "epoch")?.[1];
  return {
    ...opened,
    channelIdHex,
    epoch: epochTag ? BigInt(epochTag) : 0n,
  };
}

/** Chat kinds that render as their OWN item (timeline rows and events-bar entries). */
export const CHAT_ROW_KINDS = [9, 1068, 1111, 1740, 31922, 31923];
/** The tags a banned user's row keeps, placing it in its channel and thread ({@link tombstoned}). */
export const TOMBSTONE_TAGS: ReadonlySet<string> = new Set([TAG_CHANNEL, "epoch", "ms", "d", "e", "E", "k", "K", "p", "P"]);

/**
 * Chat as stored when its author is banned: a row stays as a tombstone in its
 * place, and what only decorates one (a reaction, an edit) isn't kept.
 */
export function withoutBannedChat<T extends Pick<OpenedEvent, "author" | "kind" | "content" | "tags">>(opened: T[]): T[] {
  if (!opened.some((o) => isUserBannedNow(o.author))) return opened;
  return opened.flatMap((o) => {
    if (!isUserBannedNow(o.author)) return [o];
    return CHAT_ROW_KINDS.includes(o.kind) ? [tombstoned(o, TOMBSTONE_TAGS)] : [];
  });
}
/**
 * Chat kinds that only DECORATE a row. Read under their OWN budget (see
 * {@link queryChannelRumors}) so a flood of reactions can't bury the rows.
 */
const CHAT_SIDE_KINDS = [5, 7, 1018, 3302, 8333, 9735, 31925];
/** All chat-plane rumor kinds we persist and fold. */
const CHAT_KINDS = [...CHAT_ROW_KINDS, ...CHAT_SIDE_KINDS];
/** Side-events fetched per row of `limit`; starvation only loses decoration on old rows. */
const SIDE_EVENT_FACTOR = 4;

/**
 * Chat kinds that are a COMPOSED row. {@link queryChannelFirstSeen} counts only
 * these, since reactions etc. are free to mint and would let a bot pre-date
 * sybils without readers seeing anything.
 */
const SPEECH_KINDS = [9, 1068, 1111];

/**
 * Drop rows past their NIP-40 `expiration` (CORD-08 §3). Every chat read applies
 * this, since {@link sweepExpiredCommunityRumors} only removes them eventually.
 */
function notExpired(events: NostrRumor[]): NostrRumor[] {
  const now = Math.floor(Date.now() / 1000);
  return events.filter((ev) => !isExpired(ev.tags, now));
}

/**
 * Read a channel's cached chat rumors, newest-first. `limit` budgets ROWS;
 * side-events ride under their own budget so they can't displace rows. `before`
 * (exclusive `created_at`) pages older history.
 */
export async function queryChannelRumors(
  communityIdHex: string,
  channelIdHex: string,
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const bound = (kinds: number[], limit: number) => {
    const f: { kinds: number[]; "#channel": string[]; limit: number; until?: number } = {
      kinds,
      "#channel": [channelIdHex],
      limit,
    };
    if (opts.before !== undefined) f.until = opts.before - 1;
    return f;
  };
  const events = await rumorStore(communityIdHex).query(
    [bound(CHAT_ROW_KINDS, opts.limit), bound(CHAT_SIDE_KINDS, opts.limit * SIDE_EVENT_FACTOR)],
    { signal: opts.signal },
  );
  return notExpired(events).map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/** Whether this device holds a post `author` sent in any Channel after `afterMs` (Vector `community_member_activity`). */
export async function heldPostAfter(communityIdHex: string, author: string, afterMs: number): Promise<boolean> {
  const events = await rumorStore(communityIdHex).query([
    { kinds: CHAT_ROW_KINDS, authors: [author], since: Math.floor(afterMs / 1000), limit: 20 },
  ]);
  return notExpired(events).some((ev) => ev.tags.some((t) => t[0] === "channel") && resolveMs(ev.created_at, ev.tags) > afterMs);
}

/**
 * Whether this device holds a post `author` sent at a Channel's writer address since `sinceMs`
 * (Vector `posts_since_by`): every row since then, since any number of ordinary posts can follow it.
 */
export async function heldWriterPostSince(communityIdHex: string, channelIdHex: string, author: string, sinceMs: number): Promise<boolean> {
  const events = await rumorStore(communityIdHex).query([
    { kinds: CHAT_ROW_KINDS, "#channel": [channelIdHex], authors: [author], since: Math.floor(sinceMs / 1000) },
  ]);
  return events.some((ev) => resolveMs(ev.created_at, ev.tags) >= sinceMs && ev.tags.some((t) => t[0] === "wepoch"));
}

/**
 * Read the page of chat rows OLDER than a cursor, plus their side-events, so each
 * scroll-back page costs the same. `until` is inclusive and `skip` names rows at
 * `until` already loaded; `since` keeps the read inside the region the store is
 * known to hold whole. `full` = the store may hold more.
 */
export async function queryChannelPageBefore(
  communityIdHex: string,
  channelIdHex: string,
  opts: { until: number; skip: ReadonlySet<string>; limit: number; since?: number; signal?: AbortSignal },
): Promise<{ events: OpenedChat[]; full: boolean }> {
  const store = rumorStore(communityIdHex);
  const want = opts.limit + opts.skip.size;
  const filter: NostrFilter = { kinds: CHAT_ROW_KINDS, "#channel": [channelIdHex], until: opts.until, limit: want };
  if (opts.since !== undefined) filter.since = opts.since;
  const fetched = await store.query([filter], { signal: opts.signal });
  const rows = fetched.filter((ev) => !opts.skip.has(ev.id));
  const events = await withSideEvents(store, channelIdHex, rows, opts.signal);
  return { events, full: fetched.length >= want };
}

/**
 * Every chat row in `[since, until]` plus their side-events, or `complete: false`
 * when the window holds more than `limit` rows — a limited read is newest-first,
 * so a truncated one says nothing about the window's oldest rows. A single
 * second cannot be split further, so it is read whole whatever its size.
 */
export async function queryChannelWindow(
  communityIdHex: string,
  channelIdHex: string,
  opts: { since: number; until: number; limit: number; signal?: AbortSignal },
): Promise<{ events: OpenedChat[]; complete: boolean }> {
  const store = rumorStore(communityIdHex);
  const filter: NostrFilter = { kinds: CHAT_ROW_KINDS, "#channel": [channelIdHex], since: opts.since, until: opts.until };
  if (opts.since < opts.until) filter.limit = opts.limit + 1;
  const fetched = await store.query([filter], { signal: opts.signal });
  if (filter.limit !== undefined && fetched.length > opts.limit) return { events: [], complete: false };
  return { events: await withSideEvents(store, channelIdHex, fetched, opts.signal), complete: true };
}

/**
 * A page of rows with their side-events, selected by `e`-reference (not time)
 * under the per-row budget, plus one hop of deletes that retract them.
 */
async function withSideEvents(
  store: NRumorStore,
  channelIdHex: string,
  rows: NostrRumor[],
  signal: AbortSignal | undefined,
): Promise<OpenedChat[]> {
  const rowIds = rows.map((ev) => ev.id);
  // Keyed by `#e` alone, channel checked here: with `#channel` beside it the
  // IndexedDB planner walks the one-value tag, i.e. the whole channel, per page.
  const inChannel = (ev: { tags: string[][] }) => ev.tags.some(([n, v]) => n === "channel" && v === channelIdHex);
  const side = rowIds.length
    ? (await store.query(
        [{ kinds: CHAT_SIDE_KINDS, "#e": rowIds, limit: rowIds.length * SIDE_EVENT_FACTOR }],
        { signal },
      )).filter(inChannel)
    : [];
  const retractable = side.filter((ev) => ev.kind !== KIND_DELETE).map((ev) => ev.id);
  const retractions = retractable.length
    ? (await store.query(
        [{ kinds: [KIND_DELETE], "#e": retractable, limit: retractable.length }],
        { signal },
      )).filter(inChannel)
    : [];
  return notExpired([...rows, ...side, ...retractions]).map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * Read exact cached chat rows for a channel. The channel selector stays alongside
 * `ids` so a route-supplied id can't pull a row from another channel. Rows only.
 */
export async function queryChannelRumorsByIds(
  communityIdHex: string,
  channelIdHex: string,
  ids: string[],
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const events = await rumorStore(communityIdHex).query(
    [{ ids: unique, kinds: CHAT_ROW_KINDS, "#channel": [channelIdHex] }],
    { signal: opts?.signal },
  );
  return notExpired(events).map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * Inline-reply parents older than the loaded window, plus the edits and deletes
 * that name them, so a {@link foldTimeline} over the result renders each parent
 * as the timeline would. Channel-scoped like {@link queryChannelRumorsByIds}.
 */
export async function queryReplyParents(
  communityIdHex: string,
  channelIdHex: string,
  ids: string[],
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const store = rumorStore(communityIdHex);
  const rows = await store.query(
    [{ ids: unique, kinds: CHAT_ROW_KINDS, "#channel": [channelIdHex] }],
    { signal: opts?.signal },
  );
  const found = rows.map((ev) => ev.id);
  const amendments = found.length
    ? await store.query(
        // Newest-first under the side-event budget; a delete also removed its target at write time.
        [{ kinds: [KIND_EDIT, KIND_DELETE], "#channel": [channelIdHex], "#e": found, limit: found.length * SIDE_EVENT_FACTOR }],
        { signal: opts?.signal },
      )
    : [];
  return notExpired([...rows, ...amendments]).map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * When each author was first heard in this channel — the flood detector's
 * {@link FloodOptions.firstSeen}. Can't come from the rendered window: a big
 * flood fills it and nobody reads as established (measured: 99% vs 0% folded).
 *
 * A TIME window; if the row cap bites, the OLDEST rows drop, which can only lose
 * a precedent, never grant a flood immunity (the detector merges by minimum).
 * SPEECH ONLY ({@link SPEECH_KINDS}), so side-events can neither mint presence
 * nor spend the row cap.
 */
export async function queryChannelFirstSeen(
  communityIdHex: string,
  channelIdHex: string,
  opts: { sinceMs: number; limit: number; signal?: AbortSignal },
): Promise<Map<string, number>> {
  const events = await rumorStore(communityIdHex).query(
    [
      {
        kinds: SPEECH_KINDS,
        "#channel": [channelIdHex],
        since: Math.floor(opts.sinceMs / 1000),
        limit: opts.limit,
      },
    ],
    { signal: opts.signal },
  );
  const firstSeen = new Map<string, number>();
  for (const ev of notExpired(events)) {
    const chat = storedToOpenedChat(ev, channelIdHex);
    const seen = firstSeen.get(chat.author);
    if (seen === undefined || chat.ms < seen) firstSeen.set(chat.author, chat.ms);
  }
  return firstSeen;
}

// First-seen snapshot
const firstSeenKey = (communityIdHex: string, channelIdHex: string) => `c2fs:${communityIdHex}:${channelIdHex}`;
/** Re-read this much below the watermark, for rows written late with an older created_at. */
const FIRST_SEEN_OVERLAP_MS = 10 * 60_000;
const FIRST_SEEN_MAX_AUTHORS = 4000;
interface FirstSeenSnapshot {
  v: 1;
  /** Upper bound (ms) of what `entries` has been scanned up to. */
  scannedToMs: number;
  entries: Array<[author: string, firstMs: number]>;
}
/**
 * Speech rows written since the snapshot's last merge (author → earliest ms), so
 * backfilled history below the watermark still lands. Session-scoped.
 */
const firstSeenPending = new Map<string, Map<string, number>>();

/**
 * {@link queryChannelFirstSeen} behind a persisted, merge-only snapshot: later reads
 * scan only past the watermark plus `firstSeenPending`. First-seen only moves earlier.
 */
export async function queryChannelFirstSeenCached(
  communityIdHex: string,
  channelIdHex: string,
  opts: { sinceMs: number; limit: number; signal?: AbortSignal },
): Promise<Map<string, number>> {
  const key = firstSeenKey(communityIdHex, channelIdHex);
  const kv = getArmadaDB().kv;
  let snap: FirstSeenSnapshot | undefined;
  try {
    const raw = await kv.get<FirstSeenSnapshot>(key);
    if (raw && raw.v === 1 && Array.isArray(raw.entries) && typeof raw.scannedToMs === "number") snap = raw;
  } catch {
    // unreadable snapshot: full scan
  }
  const merged = new Map<string, number>(snap?.entries ?? []);
  const sinceMs = snap ? Math.max(opts.sinceMs, snap.scannedToMs - FIRST_SEEN_OVERLAP_MS) : opts.sinceMs;
  const scannedToMs = Date.now();
  const fresh = await queryChannelFirstSeen(communityIdHex, channelIdHex, { sinceMs, limit: opts.limit, signal: opts.signal });

  let changed = snap === undefined;
  const fold = (author: string, ms: number) => {
    const seen = merged.get(author);
    if (seen === undefined || ms < seen) {
      merged.set(author, ms);
      changed = true;
    }
  };
  for (const [author, ms] of fresh) fold(author, ms);
  const pending = firstSeenPending.get(key);
  if (pending) {
    firstSeenPending.delete(key);
    for (const [author, ms] of pending) fold(author, ms);
  }

  // Also persist an unchanged map once the watermark has moved past the overlap.
  if (changed || (snap && scannedToMs - snap.scannedToMs > FIRST_SEEN_OVERLAP_MS)) {
    let entries = [...merged];
    if (entries.length > FIRST_SEEN_MAX_AUTHORS) {
      entries.sort((a, b) => a[1] - b[1]);
      entries = entries.slice(0, FIRST_SEEN_MAX_AUTHORS);
    }
    kv.set<FirstSeenSnapshot>(key, { v: 1, scannedToMs, entries }).catch(() => undefined);
  }
  return merged;
}

function notePresence(communityIdHex: string, rows: OpenedChat[]): void {
  for (const o of rows) {
    if (!SPEECH_KINDS.includes(o.kind) || !o.channelIdHex) continue;
    const key = firstSeenKey(communityIdHex, o.channelIdHex);
    let pending = firstSeenPending.get(key);
    if (!pending) {
      pending = new Map();
      firstSeenPending.set(key, pending);
    }
    const seen = pending.get(o.author);
    if (seen === undefined || o.ms < seen) pending.set(o.author, o.ms);
  }
}

/**
 * Read cached rumors by id, any plane or channel (e.g. the report queue's `e`
 * tag). Missing ids are ordinary; expired rows are dropped.
 */
export async function queryRumorsByIds(
  communityIdHex: string,
  ids: string[],
  opts?: { signal?: AbortSignal },
): Promise<OpenedEvent[]> {
  if (ids.length === 0) return [];
  const events = await rumorStore(communityIdHex).query([{ ids }], { signal: opts?.signal });
  return notExpired(events).map(storedToOpened);
}

/**
 * Recent 3310 rows a peer-signal read scans. Generous: app state shares the kind
 * and channel (Vector's signals carry no session tag), and a peer whose signal
 * falls off the end is undiscoverable.
 */
const PEER_SIGNAL_SCAN = 2000;

/**
 * Every webxdc peer signal on a channel. Not filtered by session: Vector's
 * `send_webxdc_signal` sends no `#i` tag; the content's topic separates apps.
 */
export async function queryWebxdcPeerSignals(
  communityIdHex: string,
  channelIdHex: string,
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  if (!channelIdHex) return [];
  const events = await rumorStore(communityIdHex).query(
    [{ kinds: [KIND_WEBXDC], "#channel": [channelIdHex], limit: PEER_SIGNAL_SCAN }],
    { signal: opts?.signal },
  );
  return notExpired(events).map((ev) => storedToOpenedChat(ev, channelIdHex));
}

export async function queryWebxdcRumors(
  communityIdHex: string,
  channelIdHex: string,
  uuid: string,
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  if (!channelIdHex || !uuid) return [];
  const events = await rumorStore(communityIdHex).query(
    [{ kinds: [KIND_WEBXDC], "#channel": [channelIdHex], "#i": [uuid], limit: 1000 }],
    { signal: opts?.signal },
  );
  return notExpired(events).map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * Newest `perChannel` chat rumors for EACH channel in ONE store transaction,
 * grouped by channel id. One `#channel` filter per channel so each is
 * independently limited (a busy channel can't starve a quiet one). Channels with
 * nothing cached are omitted.
 */
export async function queryRumorsByChannel(
  communityIdHex: string,
  channelIdsHex: string[],
  opts: { perChannel: number; signal?: AbortSignal },
): Promise<Map<string, OpenedChat[]>> {
  const out = new Map<string, OpenedChat[]>();
  if (channelIdsHex.length === 0) return out;

  // Rows and side-events under separate budgets, like queryChannelRumors.
  const events = await rumorStore(communityIdHex).query(
    channelIdsHex.flatMap((idHex) => [
      { kinds: CHAT_ROW_KINDS, "#channel": [idHex], limit: opts.perChannel },
      { kinds: CHAT_SIDE_KINDS, "#channel": [idHex], limit: opts.perChannel },
    ]),
    { signal: opts.signal },
  );

  // query() merges across filters, so recover each row's channel from its binding tag.
  for (const ev of notExpired(events)) {
    const idHex = ev.tags.find((t) => t[0] === "channel")?.[1];
    if (!idHex) continue;
    let list = out.get(idHex);
    if (!list) out.set(idHex, (list = []));
    list.push(storedToOpenedChat(ev, idHex));
  }
  return out;
}

/**
 * Cached messages that may mention `pubkey` — the local "@ Mentions" view. An
 * indexed `#p` + `#channel` filter across the WHOLE store (not the per-channel
 * newest window, which would drop older mentions). Kinds 9 and 1111. Messages by
 * authorized mass-mention authors are also returned for the caller to
 * content-match and re-authorize.
 */
export async function queryMentionRumors(
  communityIdHex: string,
  channelIdsHex: string[],
  pubkey: string,
  opts: { limit: number; signal?: AbortSignal; everyoneAuthors?: string[]; everyoneAnyone?: boolean; roleIds?: string[] },
): Promise<OpenedChat[]> {
  if (channelIdsHex.length === 0 || !pubkey) return [];
  const filters: Array<{
    kinds: number[];
    "#channel": string[];
    limit: number;
    "#p"?: string[];
    "#role"?: string[];
    authors?: string[];
    search?: string;
  }> = [{
    kinds: [9, 1111],
    "#p": [pubkey],
    "#channel": channelIdsHex,
    limit: opts.limit,
  }];
  if (opts.everyoneAnyone) {
    // Any member's mass mention counts: matched by word, the literal re-checked by the caller.
    const search = literalSearch("everyone");
    if (search) filters.push({ kinds: [9, 1111], "#channel": channelIdsHex, search, limit: Math.max(opts.limit * 5, 1_000) });
  } else if (opts.everyoneAuthors && opts.everyoneAuthors.length > 0) {
    filters.push({
      kinds: [9, 1111],
      authors: opts.everyoneAuthors,
      "#channel": channelIdsHex,
      // No content index: cap the scan so a prolific owner can't stall the
      // Notification Center (direct `#p` mentions stay depth-exact).
      limit: Math.max(opts.limit * 5, 1_000),
    });
  }
  // Candidates naming a Role the reader holds; the caller judges whether they ping (CORD-04 §8).
  if (opts.roleIds && opts.roleIds.length > 0) {
    filters.push({ kinds: [9, 1111], "#role": opts.roleIds, "#channel": channelIdsHex, limit: opts.limit });
  }
  const events = await rumorStore(communityIdHex).query(filters, { signal: opts.signal });
  const unique = new Map(notExpired(events).map((event) => [event.id, event]));
  return [...unique.values()].map((ev) =>
    storedToOpenedChat(ev, ev.tags.find((t) => t[0] === "channel")?.[1] ?? ""),
  );
}

/** Message kinds whose content is user-searchable: chat + NIP-22 thread comments. */
const SEARCHABLE_KINDS = [9, 1068, 1111];

/**
 * Max matches read per search. Text is matched by the store, so this bounds
 * matches, not history; a media-only search still scans newest-first.
 */
export const SEARCH_SCAN_LIMIT = 5000;

/**
 * Search cached message rumors, newest-first up to `limit`. Purely local (E2EE,
 * so the store is the only corpus). `#channel`, `authors`, the date bounds and
 * the typed words go to the store (see `searchDm17Rumors` for how words match);
 * `media` is applied in memory.
 */
export async function searchRumors(
  communityIdHex: string,
  channelIdsHex: string[],
  opts: {
    query: string;
    authors?: string[];
    media?: SearchMedia;
    since?: number;
    until?: number;
    limit: number;
    signal?: AbortSignal;
  },
): Promise<OpenedChat[]> {
  if (channelIdsHex.length === 0) return [];
  const search = literalSearch(opts.query);
  if (opts.query.trim() && !search) return [];
  const filter: {
    kinds: number[];
    "#channel": string[];
    authors?: string[];
    search?: string;
    since?: number;
    until?: number;
    limit: number;
  } = { kinds: SEARCHABLE_KINDS, "#channel": channelIdsHex, limit: SEARCH_SCAN_LIMIT };
  if (opts.authors && opts.authors.length > 0) filter.authors = opts.authors;
  if (search) filter.search = search;
  if (opts.since !== undefined) filter.since = opts.since;
  if (opts.until !== undefined) filter.until = opts.until;

  const events = notExpired(await rumorStore(communityIdHex).query([filter], { signal: opts.signal }));
  const media = opts.media ?? "all";

  const out: OpenedChat[] = [];
  for (const ev of events) {
    if (!messageMatchesMedia(ev.content, ev.tags, media)) continue;
    const idHex = ev.tags.find((t) => t[0] === "channel")?.[1] ?? "";
    out.push(storedToOpenedChat(ev, idHex));
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Every cached opened event of one plane — one indexed `kinds` read. Sound because
 * {@link writeOpened} admitted only this plane's kinds from this plane's keys.
 * Rekey is read per (scope, epoch) instead: {@link queryRekeyRounds}.
 */
export async function queryPlane(
  communityIdHex: string,
  plane: Exclude<Plane, "rekey">,
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<OpenedEvent[]> {
  const filter: { kinds: number[]; limit?: number } = { kinds: PLANE_RULES[plane].kinds };
  if (MEMO_PLANES.has(plane) && opts?.limit === undefined) {
    const rev = tenantRev.get(communityIdHex) ?? 0;
    const key = planeMemoKey(communityIdHex, plane);
    let memo = planeMemo.get(key);
    if (!memo || memo.rev !== rev) {
      // Never handed a signal: one reader's abort must not fail the others.
      const rows = rumorStore(communityIdHex).query([filter]);
      memo = { rev, rows };
      planeMemo.set(key, memo);
      const held = memo;
      rows.catch(() => {
        if (planeMemo.get(key) === held) planeMemo.delete(key);
      });
    }
    const events = await memo.rows;
    opts?.signal?.throwIfAborted();
    // Fresh objects per reader; the shared rows themselves are never handed out.
    return events.map(storedToOpened);
  }
  if (opts?.limit !== undefined) filter.limit = opts.limit;
  const events = await rumorStore(communityIdHex).query([filter], { signal: opts?.signal });
  return events.map(storedToOpened);
}

/**
 * Cached rekey rounds for specific (scope, new-epoch) targets, via the rumor's
 * own indexed `scope` tag plus an in-memory `newepoch` match. Authority is the
 * CORD-04 §5 citation, checked by the caller.
 */
export async function queryRekeyRounds(
  communityIdHex: string,
  targets: Array<{ scopeIdHex: string; newEpoch: bigint }>,
  opts?: { signal?: AbortSignal },
): Promise<OpenedEvent[]> {
  if (targets.length === 0) return [];
  const scopes = [...new Set(targets.map((t) => t.scopeIdHex.toLowerCase()))];
  const want = new Set(targets.map((t) => `${t.scopeIdHex.toLowerCase()}:${t.newEpoch}`));
  const events = await rumorStore(communityIdHex).query(
    [{ kinds: PLANE_RULES.rekey.kinds, "#scope": scopes }],
    { signal: opts?.signal },
  );
  const out: OpenedEvent[] = [];
  for (const ev of events) {
    const scope = ev.tags.find((t) => t[0] === "scope")?.[1]?.toLowerCase();
    const epoch = ev.tags.find((t) => t[0] === "newepoch")?.[1];
    if (!scope || !epoch) continue;
    // Compare as numbers so "07" still matches epoch 7.
    let normalized: bigint;
    try {
      normalized = BigInt(epoch);
    } catch {
      continue;
    }
    if (want.has(`${scope}:${normalized}`)) out.push(storedToOpened(ev));
  }
  return out;
}

// Seals: the author-signed NIP-59 envelope, kept only so a Refounding's compaction
// can republish heads verbatim (CORD-06 §3) and so Pins can prove messages.

/** Rumor kinds a Pin can prove, whose seals must therefore survive the store. */
const PIN_PROVABLE_KINDS: ReadonlySet<number> = new Set([KIND_MESSAGE, KIND_COMMENT, KIND_EDIT]);

/** Seal keys written this session (bounded; oldest forgotten first). */
const sealsWritten = new Set<string>();
const MAX_SEALS_REMEMBERED = 20_000;

function rememberSealWritten(key: string): void {
  sealsWritten.add(key);
  if (sealsWritten.size > MAX_SEALS_REMEMBERED) {
    const oldest = sealsWritten.values().next().value;
    if (oldest !== undefined) sealsWritten.delete(oldest);
  }
}

/** KV key holding the signed seal a stored rumor arrived in. */
function sealKey(communityIdHex: string, rumorId: string): string {
  return `c2seal:${communityIdHex}:${rumorId}`;
}

/**
 * Delete the seal a removed rumor arrived in, in every community given: it opens
 * back to the message under a channel key this device still holds.
 */
export async function forgetStoredSeals(communityIds: Iterable<string>, rumorId: string): Promise<void> {
  const kv = getArmadaDB().kv;
  await Promise.all([...communityIds].map((cid) => kv.delete(sealKey(cid, rumorId)).catch(() => undefined)));
}

/**
 * The seal a stored rumor arrived in, or undefined. Prefer one already on the
 * {@link OpenedEvent} (this session, or a legacy `seal` tag); this is the fallback.
 */
export async function readStoredSeal(
  communityIdHex: string,
  rumorId: string,
): Promise<NostrEvent | undefined> {
  if (!communityIdHex || !rumorId) return undefined;
  try {
    return await getArmadaDB().kv.get<NostrEvent>(sealKey(communityIdHex, rumorId));
  } catch {
    return undefined;
  }
}

/**
 * Store a batch in a community's tenant (`plane` absent for chat). Resolves to
 * whether it committed and never rejects — the sweep must not memo a wrap over a
 * failed write.
 */
function writeStored(
  communityIdHex: string,
  opened: OpenedEvent[],
  plane?: Plane,
  snapshot = true,
): Promise<boolean> {
  if (opened.length === 0 || !communityIdHex) return Promise.resolve(true);
  // Chat leaves the plane memos standing, but a delete can reach any of its author's kinds (NIP-09).
  const touches = plane !== undefined || opened.some((o) => o.kind === KIND_DELETE);
  if (touches) touchTenant(communityIdHex);
  const db = getArmadaDB();
  const s = db.tenant(communityTenant(communityIdHex));
  const writes: Promise<unknown>[] = [];
  for (const o of opened) {
    writes.push(s.event(openedToStored(o)));
    // Keep seals for plaintext editions (compaction) and Pin-provable kinds
    // (CORD-04 §7), else those stop being pinnable once out of memory.
    // A removed rumor is refused by the store, but its seal is a KV value it never sees.
    if (o.seal && (o.sealKind === KIND_SEAL_PLAINTEXT || PIN_PROVABLE_KINDS.has(o.kind)) && !isRemovedMessageId(o.rumorId)) {
      // Seal write failures are swallowed: the rumor is the record, and quota
      // errors mustn't mark a committed batch as failed. Once per rumor per
      // session (channel syncs re-fetch the newest page).
      const key = sealKey(communityIdHex, o.rumorId);
      if (sealsWritten.has(key)) continue;
      rememberSealWritten(key);
      writes.push(db.kv.set(key, o.seal).catch(() => {
        sealsWritten.delete(key);
      }));
    }
  }
  if (plane === "control" && snapshot) {
    writes.push(noteControlSnapshot(communityIdHex, opened));
  }
  if (plane === "guestbook") writes.push(noteGuestbookStreams(communityIdHex, opened).catch(() => undefined));
  // Again once settled: a read issued during the write memoized the rows before it.
  return Promise.all(writes)
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      if (touches) touchTenant(communityIdHex);
    });
}

/**
 * Persist opened events for one plane (chat uses {@link writeRumors}). Resolves
 * to whether it committed; never rejects.
 *
 * THIS IS THE PLANE BOUNDARY: `plane` is whose keys opened the wraps; a rumor is
 * stored only if its kind is that plane's, under that plane's seal form
 * ({@link PLANE_RULES}), with no `channel` tag (rejected, not stripped). Otherwise
 * any plane's key-holder could have {@link queryPlane} serve forged kinds, mint
 * encrypted control editions that die on compaction, or inject rows into any
 * channel's timeline. Kind 5 belongs to no plane (chat-only).
 *
 * `refounded` gates snapshot bookkeeping ({@link noteControlSnapshot}); it
 * DEFAULTS TO TRUE so an unsure caller stays correct.
 */
export function writeOpened(
  communityIdHex: string,
  opened: OpenedWireEvent[],
  plane: Plane,
  opts: { refounded?: boolean } = {},
): Promise<boolean> {
  const rule = PLANE_RULES[plane];
  return writeStored(
    communityIdHex,
    opened.filter(
      (o) =>
        rule.kinds.includes(o.kind) &&
        o.sealKind === rule.sealKind &&
        !o.tags.some((t) => t[0] === TAG_CHANNEL),
    ),
    plane,
    opts.refounded ?? true,
  );
}

/** The open timelines, by channel: handed each write's rows before its commit (see {@link writeRumors}). */
const freshChatListeners = new Map<string, Set<(rows: OpenedChat[]) => void>>();

/**
 * Hear the rows each write is about to store in `channelIdHex`, ahead of its commit:
 * under a busy boot a commit can trail the decrypt by seconds, and what was received
 * has already passed every refusal the write applies. Returns an unsubscribe.
 */
export function onFreshChat(channelIdHex: string, listener: (rows: OpenedChat[]) => void): () => void {
  let set = freshChatListeners.get(channelIdHex);
  if (!set) freshChatListeners.set(channelIdHex, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && freshChatListeners.get(channelIdHex) === set) freshChatListeners.delete(channelIdHex);
  };
}

/**
 * Rows handed to an open timeline whose write hasn't settled, by channel: a store read
 * in that window would otherwise drop them from a view that replaces what it held.
 */
const pendingChat = new Map<string, Map<string, OpenedChat>>();

/** The rows announced in `channelIdHex` that the store may not hold yet. */
export function pendingChatRows(channelIdHex: string): OpenedChat[] {
  const rows = pendingChat.get(channelIdHex);
  return rows ? [...rows.values()] : [];
}

function settlePendingChat(rows: OpenedChat[]): void {
  for (const o of rows) {
    const held = o.channelIdHex ? pendingChat.get(o.channelIdHex) : undefined;
    if (held?.get(o.rumorId) !== o) continue;
    held.delete(o.rumorId);
    if (held.size === 0) pendingChat.delete(o.channelIdHex!);
  }
}

/** Whether a timeline is open on `channelIdHex`, so what arrives for it is wanted first. */
export function hasFreshChatListener(channelIdHex: string): boolean {
  return freshChatListeners.has(channelIdHex);
}

function announceFreshChat(chat: OpenedChat[]): OpenedChat[] {
  if (freshChatListeners.size === 0) return [];
  const byChannel = new Map<string, OpenedChat[]>();
  for (const o of chat) {
    // Removed from this device: the store refuses it, so the early path must too.
    if (!o.channelIdHex || !freshChatListeners.has(o.channelIdHex) || isRemovedMessageId(o.rumorId)) continue;
    const rows = byChannel.get(o.channelIdHex);
    if (rows) rows.push(o);
    else byChannel.set(o.channelIdHex, [o]);
  }
  for (const [channelIdHex, rows] of byChannel) {
    let held = pendingChat.get(channelIdHex);
    if (!held) pendingChat.set(channelIdHex, (held = new Map()));
    for (const o of rows) held.set(o.rumorId, o);
    for (const listener of freshChatListeners.get(channelIdHex) ?? []) {
      try {
        listener(rows);
      } catch {
        // A listener's failure never costs the write.
      }
    }
  }
  return [...byChannel.values()].flat();
}

/**
 * Persist opened chat rumors, handing them to any open timeline first, then (after
 * commit) ring `c2:<channel>` on the wire bus so every live timeline re-reads, even
 * if the triggering query was aborted. Resolves to whether it committed — parked-wrap
 * drains only delete a wrap once stored. Never rejects.
 */
export function writeRumors(
  communityIdHex: string,
  opened: OpenedChat[],
  {
    ring = true,
    local = false,
  }: {
    /** `false` leaves announcing the write to the caller (a throttled backfill). */
    ring?: boolean;
    /**
     * Our own send, stored before any relay has it. Every other write was READ
     * from a relay, which is proof the rumor landed (see `outgoing.ts`).
     */
    local?: boolean;
  } = {},
): Promise<boolean> {
  if (!local) confirmOutgoing(opened.map((o) => o.rumorId));
  // The `channel` binding was already proven by `checkChannelBinding`.
  // THE OTHER HALF OF THE PLANE BOUNDARY: refuse plane kinds ({@link PLANE_KINDS}),
  // or a channel key-holder could inject a kind-3308 that {@link queryPlane} serves
  // as a control edition. A denylist, so new chat kinds aren't silently dropped.
  // Already-expired rumors are refused at ingest (CORD-08 §3).
  const now = Math.floor(Date.now() / 1000);
  const chat = withoutBannedChat(opened.filter((o) => !PLANE_KINDS.has(o.kind) && !isExpired(o.tags, now)));
  if (chat.length === 0) return Promise.resolve(true);
  const channels = new Set(chat.map((o) => o.channelIdHex).filter(Boolean));
  notePresence(communityIdHex, chat);
  const announced = announceFreshChat(chat);
  return writeStored(communityIdHex, chat).then((stored) => {
    // Before the ring: the read it prompts finds them stored (or, failed, not at all).
    settlePendingChat(announced);
    if (ring && stored && channels.size > 0) emitWireScopes([...channels].map((id) => `c2:${id}`));
    return stored;
  });
}

/**
 * Purge a banned user's chat from a community's tenant: each row they wrote
 * becomes a tombstone in its place, and the rest of their chat goes. Their
 * plane rows (control editions, joins) stay, or the community's history would
 * change. Resolves to the rows as they were, for their media and copies.
 */
export async function purgeAuthorChat(communityIdHex: string, pubkey: string): Promise<NostrRumor[]> {
  const store = rumorStore(communityIdHex);
  try {
    const rows = (await store.query([{ authors: [pubkey] }])).filter((row) => !PLANE_KINDS.has(row.kind));
    if (rows.length === 0) return [];
    const doomed = rows.filter((row) => row.content !== "" || row.tags.some((tag) => !TOMBSTONE_TAGS.has(tag[0])));
    if (doomed.length === 0) return [];
    await store.remove([{ ids: doomed.map((row) => row.id) }]);
    await Promise.all(doomed
      .filter((row) => CHAT_ROW_KINDS.includes(row.kind))
      .map((row) => store.event(tombstoned(row, TOMBSTONE_TAGS)).catch(() => undefined)));
    return doomed;
  } finally {
    touchTenant(communityIdHex);
  }
}

/** Delete our own rows by rumor id (a discarded send that never reached a relay). */
export async function removeRumors(communityIdHex: string, rumorIds: string[]): Promise<void> {
  if (rumorIds.length === 0) return;
  try {
    await rumorStore(communityIdHex).remove([{ ids: rumorIds }]);
  } finally {
    touchTenant(communityIdHex);
  }
}

// Expiry sweep (CORD-08 §3)
/** Rumors scanned per sweep page. */
const SWEEP_PAGE = 1000;
/** Pages a single sweep will walk (bounds a huge history to a bounded cost). */
const SWEEP_MAX_PAGES = 20;
/** At most one sweep per community per interval, per session. */
const SWEEP_MIN_INTERVAL_MS = 6 * 3600 * 1000;
const lastSweepAt = new Map<string, number>();
/** How long a sweep waits after a community opens: its pages would queue ahead of the timeline's first read. */
const SWEEP_DELAY_MS = 10_000;

/**
 * {@link sweepExpiredCommunityRumors} once the page has settled: after {@link SWEEP_DELAY_MS},
 * then when the browser is idle. Reads already hide expired rows. Returns a cancel.
 */
export function scheduleExpiredSweep(communityIdHex: string): () => void {
  const controller = new AbortController();
  let idle: number | undefined;
  const timer = setTimeout(() => {
    const run = () => void sweepExpiredCommunityRumors(communityIdHex, { signal: controller.signal }).catch(() => undefined);
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(run, { timeout: 5_000 });
    else run();
  }, SWEEP_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined) cancelIdleCallback(idle);
    controller.abort();
  };
}

/**
 * Physically remove stored chat rumors past their NIP-40 `expiration` (CORD-08
 * §3) — reads hide them, but plaintext must leave the store. No index on
 * `expiration`, so walk newest-first in bounded pages (like `sweepExpiredDm17Rumors`).
 * At most once per community per {@link SWEEP_MIN_INTERVAL_MS}.
 */
export async function sweepExpiredCommunityRumors(
  communityIdHex: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  if (!communityIdHex) return 0;
  const last = lastSweepAt.get(communityIdHex);
  if (last !== undefined && Date.now() - last < SWEEP_MIN_INTERVAL_MS) return 0;
  lastSweepAt.set(communityIdHex, Date.now());

  const s = rumorStore(communityIdHex);
  const now = Math.floor(Date.now() / 1000);
  // WebXDC state rides outside CHAT_KINDS but expires with the plane.
  const kinds = [...CHAT_KINDS, KIND_WEBXDC];
  let until: number | undefined;
  let removed = 0;
  const channels = new Set<string>();

  try {
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      if (opts.signal?.aborted) break;
      const filter: { kinds: number[]; limit: number; until?: number } = { kinds, limit: SWEEP_PAGE };
      if (until !== undefined) filter.until = until;
      const events = await s.query([filter], { signal: opts.signal });
      if (events.length === 0) break;

      const expired = events.filter((ev) => isExpired(ev.tags, now));
      if (expired.length > 0) {
        try {
          await s.remove([{ ids: expired.map((ev) => ev.id) }], { signal: opts.signal });
        } finally {
          touchTenant(communityIdHex);
        }
        removed += expired.length;
        for (const ev of expired) {
          const idHex = ev.tags.find((t) => t[0] === "channel")?.[1];
          if (idHex) channels.add(idHex);
        }
      }
      if (events.length < SWEEP_PAGE) break;
      // Strictly older than this page's oldest, or a boundary second loops forever.
      const oldest = Math.min(...events.map((ev) => ev.created_at));
      if (until !== undefined && oldest - 1 >= until) break;
      until = oldest - 1;
    }
  } finally {
    // A cancelled sweep didn't finish: the next open may run it again.
    if (opts.signal?.aborted) lastSweepAt.delete(communityIdHex);
  }

  if (channels.size > 0) emitWireScopes([...channels].map((id) => `c2:${id}`));
  return removed;
}

// Pending raw-wrap holding store. The native background service can't decrypt
// Concord wraps, so it parks them in a separate tenant; WebView plane hooks
// {@link peekPendingWraps}, decrypt, and {@link ackPendingWraps} only what decoded.
// A wrap is never deleted before its rumor is stored; stragglers are
// age-pruned. Indexed by author (stream address).
//
// The tenant stores rumors (no `sig`), so signatures are kept in KV and reattached
// on peek. They matter: write-restricted streams like the Control Plane (CORD-01,
// CORD-02 §5) are signature-checked by `openWrap`, so without them parked control
// editions fail `bad-wrap-signature` forever.

const PENDING_TENANT = ARMADA_TENANTS.c2Park;

/** KV prefix holding parked wraps' signatures, keyed by wrap id. */
const PARK_SIG_PREFIX = "c2parksig:";

const parkSigKey = (wrapId: string) => `${PARK_SIG_PREFIX}${wrapId}`;

/**
 * Reunite parked wraps with their signatures via one KV `list` (each read is a
 * bridge round trip on Android). A missing signature comes back as `""`.
 */
async function attachParkedSigs(wraps: NostrRumor[]): Promise<NostrEvent[]> {
  if (wraps.length === 0) return [];
  let byId = new Map<string, string>();
  try {
    const entries = await getArmadaDB().kv.list<string>({ prefix: PARK_SIG_PREFIX });
    byId = new Map(entries.map((e) => [e.key.slice(PARK_SIG_PREFIX.length), e.value]));
  } catch {
    // A KV failure costs the restricted planes this round, not the others.
  }
  return wraps.map((w) => ({ ...w, sig: byId.get(w.id) ?? "" }) as NostrEvent);
}

/** Forget the signatures of wraps that are no longer parked. */
function forgetParkedSigs(wrapIds: string[]): void {
  if (wrapIds.length === 0) return;
  const kv = getArmadaDB().kv;
  void Promise.all(wrapIds.map((id) => kv.delete(parkSigKey(id)))).catch(() => undefined);
}

/** Parked wraps older than this are pruned (key never arrived / dead plane). */
const PENDING_MAX_AGE_SECS = 14 * 24 * 3600;

function pendingStore(): NRumorStore {
  // Queried by `authors` only; no tag index matters.
  return getArmadaDB().tenant(PENDING_TENANT);
}

/**
 * Whether the pending store is known empty: `true` skips IndexedDB, `false`
 * reads, `undefined` (fresh session) probes once — wraps parked in a previous
 * session are durable and nothing would re-park them.
 */
let pendingKnownEmpty: boolean | undefined;

/** How often (ms) to run the age-prune of undecodable stragglers. */
const PENDING_PRUNE_INTERVAL_MS = 5 * 60_000;
let lastPendingPruneAt = 0;

/** Park raw Concord wraps for later WebView-side decryption (native ingest path). */
export function parkPendingWraps(wraps: NostrEvent[]): void {
  if (wraps.length === 0) return;
  pendingKnownEmpty = false;
  const s = pendingStore();
  const kv = getArmadaDB().kv;
  void Promise.all(
    wraps.flatMap(({ sig, ...wrap }) => [
      s.event(wrap),
      ...(typeof sig === "string" && sig.length > 0 ? [kv.set(parkSigKey(wrap.id), sig)] : []),
    ]),
  ).catch(() => undefined);
}

/**
 * Read (WITHOUT removing) wraps parked for these stream addresses; the caller
 * acks decoded ones via {@link ackPendingWraps}. Short-circuits when known empty,
 * and age-prunes stragglers at most every {@link PENDING_PRUNE_INTERVAL_MS}.
 */
export async function peekPendingWraps(streamPks: string[]): Promise<NostrEvent[]> {
  if (streamPks.length === 0) return [];
  if (pendingKnownEmpty === true) return [];
  const s = pendingStore();
  try {
    if (pendingKnownEmpty === undefined) {
      // First peek this session: probe the durable store once.
      const any = await s.query([{ kinds: [1059, 21059], limit: 1 }]);
      // Don't clobber a concurrent park's `false`.
      if (pendingKnownEmpty === undefined) pendingKnownEmpty = any.length === 0;
      if (pendingKnownEmpty === true) return [];
    }
    const now = Date.now();
    if (now - lastPendingPruneAt >= PENDING_PRUNE_INTERVAL_MS) {
      lastPendingPruneAt = now;
      const cutoff = Math.floor(now / 1000) - PENDING_MAX_AGE_SECS;
      // Read the doomed ids first so their KV signatures are removed too.
      void (async () => {
        const stale = { kinds: [1059, 21059], until: cutoff };
        const doomed = await s.query([stale]);
        await s.remove([stale]);
        forgetParkedSigs(doomed.map((w) => w.id));
      })().catch(() => undefined);
    }
    return await attachParkedSigs(
      await s.query([{ kinds: [1059, 21059], authors: streamPks, limit: 1000 }]),
    );
  } catch {
    return [];
  }
}

/** Remove parked wraps whose rumors are now safely in the opened-event store. */
export function ackPendingWraps(wrapIds: string[]): void {
  if (wrapIds.length === 0) return;
  const s = pendingStore();
  void s.remove([{ ids: wrapIds }]).catch(() => undefined);
  forgetParkedSigs(wrapIds);
}

// Sync cursor: per-stream resume state in the folded cache, keyed by scope
// (channel id, or community id + plane name).

/** A stream's persisted sync position. */
export interface StreamCursor {
  /** `created_at` of the newest wrap ingested (the live-sub / refetch `since` floor). */
  newest: number;
  /** `created_at` of the oldest wrap paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop issuing older-backfills. */
  exhausted: boolean;
  /**
   * A bridge left unfinished: `[until, top]` is read, `(newest, until)` is still
   * owed. Lets a gap too big for one round be filled across rounds instead of
   * re-reading its top every time.
   */
  bridge?: StreamBridge;
}

export interface StreamBridge {
  top: number;
  until: number;
}

const cursorKey = (scope: string) => `concord2-cursor:${scope}`;

/**
 * Read a scope's sync cursor, or undefined. Shared ({@link readFoldedShared})
 * since cursors are immutable and read on every channel open.
 */
export function readStreamCursor(scope: string): Promise<StreamCursor | undefined> {
  return readFoldedShared<StreamCursor>(cursorKey(scope));
}

/**
 * Per-scope serialization of the read-modify-writes below: overlapping callers
 * (the `c2:` sync round and `loadOlder`) would otherwise lose a patch. Holds only
 * in-flight scopes.
 */
const cursorWrites = new Map<string, Promise<void>>();

function withCursorLock(scope: string, fn: () => Promise<void>): Promise<void> {
  const prev = cursorWrites.get(scope) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // The tail never rejects, so a failed write doesn't poison the chain (the caller still sees it via `run`).
  const tail: Promise<void> = run.catch(() => undefined).then(() => {
    if (cursorWrites.get(scope) === tail) cursorWrites.delete(scope);
  });
  cursorWrites.set(scope, tail);
  return run;
}

/**
 * Merge new sync progress into a scope's cursor (best-effort). `newest` only
 * advances forward, `oldest` only recedes, `exhausted` is sticky until cleared.
 * A `bridge` replaces the held one (`null` clears it), and is dropped once
 * `newest` reaches its `until` (nothing is owed below it any more).
 */
export function updateStreamCursor(
  scope: string,
  patch: Partial<Omit<StreamCursor, "bridge">> & { bridge?: StreamBridge | null },
): Promise<void> {
  return withCursorLock(scope, async () => {
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
    const bridge = patch.bridge === null ? undefined : (patch.bridge ?? prev?.bridge);
    if (bridge && next.newest > 0 && bridge.until > next.newest) next.bridge = bridge;
    await writeFolded(cursorKey(scope), next);
  });
}

/** Clear the exhausted flag (e.g. after a rekey catch-up unlocks older history). */
export function clearStreamExhausted(scope: string): Promise<void> {
  return withCursorLock(scope, async () => {
    const prev = await readStreamCursor(scope);
    if (prev?.exhausted) await writeFolded(cursorKey(scope), { ...prev, exhausted: false });
  });
}
