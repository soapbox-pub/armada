/**
 * NIP-17 opened-DM cache. Wraps are never persisted (re-opening costs two
 * NIP-44 decrypts); opened rumors are stored unsigned, one ArmadaDB tenant per
 * viewer (`dm17:<self>`) for account isolation.
 *
 * Kind-5 rumors physically remove their author's targets (NIP-09, self-only).
 * Expired NIP-40 rumors are refused on write, filtered on read, and removed by
 * {@link sweepExpiredDm17Rumors} — "disappeared" must mean gone from disk.
 *
 * Stores DECRYPTED messages at rest; wiped on logout (purgeClientStorage).
 */

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { getArmadaDB } from "@/lib/db/armadaDB";
import { literalSearch } from "@/lib/db/ParsedFilter";
import { tenantOptsFor } from "@/lib/db/termPolicies";
import type { NRumorStore } from "@/lib/db/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { isUserBannedNow, tombstoned } from "@/lib/bannedUsers";
import { isRemovedMessageId } from "@/lib/removedMessages";
import type { NostrRumor } from "@/lib/nostrRumor";
import {
  DM_MESSAGE_KINDS,
  DM_MINE_TERM,
  DM_MSG_TERM,
  dmConvKey,
  dmConvKeyOf,
  dmConvTerm,
  dmPeersOf,
} from "@/lib/nip17/conversation";
import {
  dmAt,
  DM_RUMOR_KINDS,
  DM_THREAD_KINDS,
  isExpired,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_FILE,
  KIND_DM_TIMER,
  KIND_DM_WEBXDC,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { dmThreadScope, emitWireScopes, onWireScopes } from "@/wire/bus";
import { nowSecs } from "@/lib/relayClock";

/**
 * The opened-DM store for one account, bound to its conversation term policy
 * (also declared natively by the Android service and iOS extension).
 */
export function dm17Store(self: string): NRumorStore {
  const id = `dm17:${self}`;
  return getArmadaDB().tenant(id, tenantOptsFor(id));
}

/** The tags a banned user's message keeps, placing it in its conversation. */
export const DM_TOMBSTONE_TAGS: ReadonlySet<string> = new Set(["p", "e", "ms"]);

/** Kinds kept as a tombstone, rather than dropped, when their author is banned. */
const DM_ROW_KINDS = new Set([KIND_DM_CHAT, KIND_DM_FILE]);

/** DMs as stored when their author is banned: a message stays as a tombstone, anything else isn't kept. */
export function withoutBannedDms<T extends Pick<OpenedDm, "author" | "kind" | "content" | "tags">>(opened: T[]): T[] {
  if (!opened.some((o) => isUserBannedNow(o.author))) return opened;
  return opened.flatMap((o) => {
    if (!isUserBannedNow(o.author)) return [o];
    return DM_ROW_KINDS.has(o.kind) ? [tombstoned(o, DM_TOMBSTONE_TAGS)] : [];
  });
}

/**
 * Purge a banned user's DMs from an account's tenant: each message becomes a
 * tombstone in its place, and the rest of theirs goes. Resolves to the rows as
 * they were, for their media and copies.
 */
export async function purgeAuthorDms(self: string, pubkey: string): Promise<NostrRumor[]> {
  const store = dm17Store(self);
  const rows = await store.query([{ authors: [pubkey] }]);
  const doomed = rows.filter((row) => row.content !== "" || row.tags.some((tag) => !DM_TOMBSTONE_TAGS.has(tag[0])));
  if (doomed.length === 0) return [];
  await store.remove([{ ids: doomed.map((row) => row.id) }]);
  await Promise.all(doomed
    .filter((row) => DM_ROW_KINDS.has(row.kind))
    .map((row) => store.event(tombstoned(row, DM_TOMBSTONE_TAGS)).catch(() => undefined)));
  retireConversationReads();
  emitWireScopes(["dm"]);
  return doomed;
}

/** Build the stored rumor for an opened DM: the rumor itself, unaltered. */
export function dm17ToStored(opened: OpenedDm): NostrRumor {
  return {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags: opened.tags,
    created_at: opened.createdAt,
    pubkey: opened.author,
  };
}

/** Reconstruct an OpenedDm as seen by `self`; the conversation is derived ({@link dmPeersOf}). `wrapId` is not recoverable. */
export function storedToDm17(ev: NostrRumor, self: string): OpenedDm {
  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags: ev.tags,
    createdAt: ev.created_at,
    peers: dmPeersOf(ev, self) ?? [],
    wrapId: "",
  };
}

/**
 * Persist opened rumors and ring the conversation-list scope plus one per
 * affected peer. Best-effort; resolves once committed.
 */
export async function writeDm17Rumors(self: string, opened: OpenedDm[]): Promise<void> {
  // Single choke point for every writer: already-expired rumors are never stored,
  // and a banned user's only as a tombstone in place of a message.
  const fresh = withoutBannedDms(opened.filter((o) => !isExpired(o.tags)));
  if (fresh.length === 0) return;
  const pending = holdPendingDms(self, fresh);
  const s = dm17Store(self);
  try {
    await Promise.all([
      ...fresh.map((o) =>
        s.event(dm17ToStored(o)).catch(() => {
        }),
      ),
      noteArrivals(self, fresh).catch(() => undefined),
    ]);
  } finally {
    retireConversationReads();
    // Held until a list read begun after this commit lands; that read holds them, or they failed.
    for (const p of pending) p.clearAt = conversationGeneration;
  }
  const scopes = new Set<string>(["dm"]);
  for (const rumor of fresh) {
    if (rumor.peers.length > 0) scopes.add(dmThreadScope(dmConvKey(rumor.peers)));
  }
  emitWireScopes(scopes);
}

/**
 * One conversation's rumors, newest-first up to `limit`; `before` is an
 * exclusive `created_at` bound. The conversation is re-checked per row: the
 * index is maintained by several engines, and a mismatch should cost a missing
 * message, never someone else's message in this thread.
 */
export async function queryDm17Thread(
  self: string,
  peers: readonly string[],
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedDm[]> {
  const key = dmConvKey(peers);
  const store = dm17Store(self);
  const events = await store.query(
    conversationFilters(self, peers, { limit: opts.limit, before: opts.before }),
    { signal: opts.signal },
  );
  // A full newest window can miss a message that arrived inside it dated below it (a slow clock).
  if (opts.before === undefined && events.length >= opts.limit) {
    const floor = Math.min(...events.map((ev) => ev.created_at));
    const held = new Set(events.map((ev) => ev.id));
    const late = [...(await readDm17Arrivals(self))]
      .filter(([id, fact]) => fact.conv === key && fact.at >= floor && fact.sent < floor && !held.has(id))
      .map(([id]) => id);
    if (late.length > 0) events.push(...await store.query([{ ids: late, kinds: DM_THREAD_KINDS }], { signal: opts.signal }));
  }
  return withDm17Arrivals(self, events
    .filter((ev) => !isExpired(ev.tags) && dmConvKeyOf(ev, self) === key)
    .map((ev) => storedToDm17(ev, self)));
}

/**
 * Count incoming chat/file rumors after the read stamp (`dmAt > lastRead`).
 * Note to Self never has unread.
 */
export async function countUnreadDm17Messages(
  self: string,
  peers: readonly string[],
  lastRead: number,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  const incomingAuthors = peers.filter((peer) => peer !== self);
  if (incomingAuthors.length === 0) return 0;
  const filters = conversationFilters(self, peers).map((filter) => ({
    ...filter,
    kinds: [...DM_MESSAGE_KINDS],
    authors: incomingAuthors,
    since: Math.max(0, Math.floor(lastRead) + 1),
  }));
  const store = dm17Store(self);
  const { count } = await store.count(filters, opts);
  // The index counts by `created_at`; a recorded arrival on the other side of the stamp moves it.
  const key = dmConvKey(peers);
  const moved = [...(await readDm17Arrivals(self))].filter(([, f]) => f.in && f.conv === key && (f.sent > lastRead) !== (f.at > lastRead));
  if (moved.length === 0) return count;
  const stored = new Set((await store.query([{ ids: moved.map(([id]) => id), kinds: [...DM_MESSAGE_KINDS] }], opts)).map((ev) => ev.id));
  let adjusted = count;
  for (const [id, f] of moved) if (stored.has(id)) adjusted += f.at > lastRead ? 1 : -1;
  return Math.max(0, adjusted);
}

/**
 * One rumor by id (e.g. a search hit beyond the loaded window). The
 * participant-set check is essential: ids are tenant-scoped, not conversation-scoped.
 */
export async function queryDm17Rumor(
  self: string,
  peers: readonly string[],
  rumorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<OpenedDm | undefined> {
  const events = await dm17Store(self).query(
    [{ ids: [rumorId], kinds: DM_RUMOR_KINDS, limit: 1 }],
    { signal: opts.signal },
  );
  const event = events.find((ev) => ev.id === rumorId);
  if (!event || isExpired(event.tags)) return undefined;
  const opened = storedToDm17(event, self);
  if (dmConvKey(opened.peers) !== dmConvKey(peers)) return undefined;
  return (await withDm17Arrivals(self, [opened]))[0];
}

/**
 * Chat/file rumors by id within one conversation, for inline-reply parents older
 * than the loaded window. Author deletes are re-checked like the thread fold
 * does: backfill runs newest-first, so a delete can be stored before its target.
 */
export async function queryDm17Messages(
  self: string,
  peers: readonly string[],
  ids: readonly string[],
  opts: { signal?: AbortSignal } = {},
): Promise<OpenedDm[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const store = dm17Store(self);
  const key = dmConvKey(peers);
  const rows = (await store.query([{ ids: unique, kinds: [...DM_MESSAGE_KINDS] }], { signal: opts.signal }))
    .filter((ev) => !isExpired(ev.tags))
    .map((ev) => storedToDm17(ev, self))
    .filter((opened) => dmConvKey(opened.peers) === key);
  if (rows.length === 0) return [];
  const deleted = await authorDeleted(store, rows, opts.signal);
  return withDm17Arrivals(self, rows.filter((r) => !deleted.has(r.rumorId)));
}

/**
 * The ids among `rows` deleted by their own author. Kind 5 removes only targets
 * already stored, and wraps arrive out of order, so a target can outlive its delete.
 * Only the target's author may delete it, so the delete needs no conversation scope.
 */
async function authorDeleted(
  store: NRumorStore,
  rows: readonly OpenedDm[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const deleted = new Set<string>();
  if (rows.length === 0) return deleted;
  const deletes = await store.query(
    [{ kinds: [KIND_DM_DELETE], "#e": rows.map((r) => r.rumorId) }],
    { signal },
  );
  const authorOf = new Map(rows.map((r) => [r.rumorId, r.author]));
  for (const d of deletes) {
    for (const [name, value] of d.tags) {
      if (name === "e" && value && authorOf.get(value) === d.pubkey) deleted.add(value);
    }
  }
  return deleted;
}

/**
 * The filter selecting one conversation from `self`'s side, via the derived
 * index term (`nip17/conversation.ts`) as a NIP-50 extension. NIP-01 filters
 * can't express a participant set: tag values are alternatives.
 */
export function conversationFilters(
  self: string,
  peers: readonly string[],
  opts: { limit?: number; before?: number } = {},
): NostrFilter[] {
  // Canonicalize like `dmPeersOf`, in case the caller included the viewer.
  const others = peers.filter((peer) => peer !== self);
  const filter: NostrFilter = {
    // App state (3310) has its own query; each kind here spends the thread's `limit` (see DM_THREAD_KINDS).
    kinds: DM_THREAD_KINDS,
    search: dmConvTerm(others.length > 0 ? others : [self]),
  };
  if (opts.limit !== undefined) filter.limit = opts.limit;
  if (opts.before !== undefined) filter.until = opts.before - 1;
  return [filter];
}

/**
 * The conversation's disappearing timer in seconds (0 = off), or undefined if
 * never set. Separate query: a timer set long ago outlives the thread window.
 * Timer rumors never expire, so the newest is live.
 */
export async function queryDm17Timer(
  self: string,
  peers: readonly string[],
  opts: { signal?: AbortSignal } = {},
): Promise<number | undefined> {
  const key = dmConvKey(peers);
  const events = await dm17Store(self).query(
    conversationFilters(self, peers, { limit: 1 }).map((f) => ({
      ...f,
      kinds: [KIND_DM_TIMER],
    })),
    { signal: opts.signal },
  );
  const newest = events.filter((ev) => dmConvKeyOf(ev, self) === key)[0];
  const raw = newest?.tags.find((t) => t[0] === "timer")?.[1];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : undefined;
}

/** App-state rumors per session read; matches Concord. */
const WEBXDC_PAGE = 1000;

/**
 * One app session's durable state, oldest first (DM twin of Concord's
 * `queryWebxdcRumors`). Separate query so a chatty app can't evict messages
 * from the thread's `limit`. Ascending: apps replay updates in order.
 */
export async function queryDm17Webxdc(
  self: string,
  peers: readonly string[],
  uuid: string,
  opts: { signal?: AbortSignal } = {},
): Promise<OpenedDm[]> {
  if (!uuid) return [];
  const key = dmConvKey(peers);
  const events = await dm17Store(self).query(
    conversationFilters(self, peers, { limit: WEBXDC_PAGE }).map((f) => ({
      ...f,
      kinds: [KIND_DM_WEBXDC],
      "#i": [uuid],
    })),
    { signal: opts.signal },
  );
  return events
    .filter((ev) => !isExpired(ev.tags) && dmConvKeyOf(ev, self) === key)
    .map((ev) => storedToDm17(ev, self))
    .sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
}

export interface Dm17ConversationRow {
  key: string;
  /** The participants, everyone but the viewer (`[self]` for Note to Self). */
  peers: string[];
  latest: OpenedDm;
  mine: boolean;
  /**
   * When the viewer last sent here (unix seconds). Free from the `convmine`
   * collapse; used by Android Direct Share ranking (`useShareShortcuts`).
   */
  mineAt?: number;
}

/**
 * The newest chat/file rumor per conversation, via two collapsed reads
 * (`distinct:convmsg`, `distinct:convmine`) — complete, costing per conversation
 * rather than per message. `mine` must be complete or push gateways treat
 * known peers as strangers (see `useNostrPush`). Keys are re-derived per row.
 */
export function queryDm17Conversations(
  self: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<Dm17ConversationRow[]> {
  // Concurrent callers share one read: the rail, the page and the notifiers all ask at once.
  const key = `${self}:${opts.limit ?? ""}`;
  let shared = conversationReads.get(key);
  if (!shared) {
    const startedAt = conversationGeneration;
    const read = readDm17Conversations(self, { limit: opts.limit }).then((rows) => withPendingDms(self, rows, startedAt));
    shared = read;
    conversationReads.set(key, read);
    void read.finally(() => {
      if (conversationReads.get(key) === read) conversationReads.delete(key);
    }).catch(() => undefined);
  }
  const signal = opts.signal;
  // Each caller gets its own rows, and leaves on its own abort without cancelling the rest.
  const mine = shared.then((rows) => rows.map((row) => ({ ...row })));
  if (!signal) return mine;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    mine.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Conversation-list reads in flight, by account and limit. */
const conversationReads = new Map<string, Promise<Dm17ConversationRow[]>>();
/** Bumped as each write lands, so a read can tell which writes began before it. */
let conversationGeneration = 0;

/** A write landed: later callers start a read that sees it rather than join one that may not. */
function retireConversationReads(): void {
  conversationGeneration += 1;
  conversationReads.clear();
}

/**
 * Messages handed to the list ahead of their commit, per account, by rumor id. Under a
 * busy boot a commit, and the read after it, can trail the decrypt by seconds; and a read
 * begun before the commit would otherwise drop them again.
 */
interface PendingDm {
  row: OpenedDm;
  /** The generation whose reads hold it (or never will: a failed write); until then, Infinity. */
  clearAt: number;
}
const pendingDms = new Map<string, Map<string, PendingDm>>();
const freshDmListeners = new Map<string, Set<(fresh: OpenedDm[]) => void>>();

/** Hear the messages each write is about to store for `self`, ahead of its commit. Returns an unsubscribe. */
export function onFreshDm17(self: string, listener: (fresh: OpenedDm[]) => void): () => void {
  let set = freshDmListeners.get(self);
  if (!set) freshDmListeners.set(self, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && freshDmListeners.get(self) === set) freshDmListeners.delete(self);
  };
}

/** Forget the messages held for the list: decrypted plaintext. Logout's purge. */
export function clearPendingDm17(): void {
  pendingDms.clear();
  conversationReads.clear();
  forgetDm17Arrivals();
  liveWrapArrivals.clear();
}

function holdPendingDms(self: string, fresh: OpenedDm[]): PendingDm[] {
  // Removed from this device: the store refuses it, so the early path must too.
  const rows = fresh.filter((o) => !isRemovedMessageId(o.rumorId));
  if (rows.length === 0) return [];
  let held = pendingDms.get(self);
  if (!held) pendingDms.set(self, (held = new Map()));
  const out = rows.map((row) => ({ row, clearAt: Infinity }));
  for (const p of out) held.set(p.row.rumorId, p);
  for (const listener of freshDmListeners.get(self) ?? []) {
    try {
      listener(rows);
    } catch {
      // A listener's failure never costs the write.
    }
  }
  return out;
}

/** `rows` from a read begun at generation `startedAt`, with what it can't hold yet merged in. */
function withPendingDms(self: string, rows: Dm17ConversationRow[], startedAt: number): Dm17ConversationRow[] {
  const held = pendingDms.get(self);
  if (!held) return rows;
  for (const [id, p] of held) if (p.clearAt <= startedAt) held.delete(id);
  if (held.size === 0) {
    pendingDms.delete(self);
    return rows;
  }
  return mergeFreshDm17(rows, [...held.values()].map((p) => p.row), self);
}

/**
 * The list with `fresh` messages folded in as its read would fold them: each a
 * conversation's newest when it is newer, the viewer's own marking it theirs.
 * `rows` itself when nothing changes.
 */
export function mergeFreshDm17(rows: Dm17ConversationRow[], fresh: readonly OpenedDm[], self: string): Dm17ConversationRow[] {
  let byKey: Map<string, Dm17ConversationRow> | undefined;
  for (const o of fresh) {
    if (o.peers.length === 0 || !DM_MESSAGE_KINDS.includes(o.kind) || o.kind === KIND_DM_WEBXDC || isExpired(o.tags)) continue;
    byKey ??= new Map(rows.map((r) => [r.key, r]));
    const key = dmConvKey(o.peers);
    const cur = byKey.get(key);
    const mineAt = o.author === self ? Math.max(o.createdAt, cur?.mineAt ?? 0) : cur?.mineAt;
    const newer = !cur || dmAt(o) > dmAt(cur.latest);
    if (!newer && mineAt === cur.mineAt) continue;
    byKey.set(key, {
      key,
      peers: newer ? o.peers : cur.peers,
      latest: newer ? o : cur.latest,
      mine: mineAt !== undefined,
      ...(mineAt !== undefined ? { mineAt } : {}),
    });
  }
  if (!byKey || byKey.size === rows.length && [...byKey.values()].every((r, i) => r === rows[i])) return rows;
  return [...byKey.values()].sort((a, b) => dmAt(b.latest) - dmAt(a.latest));
}

// Writes from another context (the service worker, another tab) arrive as a `dm` ring.
onWireScopes((scopes) => {
  if (scopes.has("dm")) retireConversationReads();
});

async function readDm17Conversations(
  self: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<Dm17ConversationRow[]> {
  const collapse = (namespace: string): NostrFilter => {
    const filter: NostrFilter = { search: `distinct:${namespace}` };
    // No `kinds`: the namespace already implies chat-or-file, and a kind test inside
    // the grouping costs a row read per index entry. The loop asserts kinds.
    if (opts.limit !== undefined) filter.limit = opts.limit;
    return filter;
  };
  const store = dm17Store(self);
  const events = await store.query(
    [collapse(DM_MSG_TERM), collapse(DM_MINE_TERM)],
    { signal: opts.signal },
  );

  const byConversation = new Map<string, OpenedDm>();
  /** Conversation → when the viewer last sent there. Keys are the `mine` set. */
  const mine = new Map<string, number>();
  /**
   * Per conversation, the newest message ruled out (expired but not yet swept,
   * or deleted by its author). Everything newer has been ruled out too.
   */
  const ruledOut = new Map<string, OpenedDm>();
  const ruleOut = (key: string, opened: OpenedDm): void => {
    const prev = ruledOut.get(key);
    if (!prev || opened.createdAt > prev.createdAt) ruledOut.set(key, opened);
  };

  const fold = (ev: NostrRumor): void => {
    const opened = storedToDm17(ev, self);
    if (opened.peers.length === 0) return;
    if (!DM_MESSAGE_KINDS.includes(ev.kind)) return;
    if (ev.kind === KIND_DM_WEBXDC) return;
    const key = dmConvKey(opened.peers);
    // Before the expiry check: expiry affects display, not whether the viewer wrote
    // here. `convmine` yields one row per conversation, so dropping the flag for an
    // expired row would demote a long-standing thread to a request. Take the MAX
    // since both collapses can return the viewer's rumors.
    if (opened.author === self) {
      const prev = mine.get(key);
      if (prev === undefined || opened.createdAt > prev) mine.set(key, opened.createdAt);
    }
    if (isExpired(ev.tags)) {
      ruleOut(key, opened);
      return;
    }
    const cur = byConversation.get(key);
    if (!cur || opened.createdAt > cur.createdAt) byConversation.set(key, opened);
  };

  for (const ev of events) fold(ev);

  // A conversation whose newest message is expired or author-deleted falls back
  // to an older live one, paged by term; one with none left is not listed, as
  // its thread would be empty.
  const checked = new Set<string>();
  for (let round = 0; ; round++) {
    const unchecked = [...byConversation].filter(([key]) => !checked.has(key));
    const deleted = await authorDeleted(store, unchecked.map(([, latest]) => latest), opts.signal);
    for (const [key, latest] of unchecked) {
      if (deleted.has(latest.rumorId)) {
        byConversation.delete(key);
        ruleOut(key, latest);
      } else {
        checked.add(key);
      }
    }
    const missing = [...ruledOut].filter(([key]) => !byConversation.has(key));
    if (missing.length === 0 || round === RETRY_ROUNDS) break;
    ruledOut.clear();
    const retry = await store.query(
      missing.map(([, newest]) => ({
        kinds: [KIND_DM_CHAT, KIND_DM_FILE],
        search: dmConvTerm(newest.peers),
        until: newest.createdAt - 1,
        limit: RETRY_PAGE,
      })),
      { signal: opts.signal },
    );
    for (const ev of retry) fold(ev);
  }

  // The collapse picks each head by `created_at`; one that arrived later than that, dated
  // below it by a slow clock, is the newest message all the same.
  const known = await readDm17Arrivals(self);
  if (known.size > 0) {
    for (const [key, latest] of byConversation) byConversation.set(key, withArrival(latest, known.get(latest.rumorId)?.at));
    const later = [...known].filter(([id, f]) => {
      const head = byConversation.get(f.conv);
      return head !== undefined && head.rumorId !== id && f.at > dmAt(head);
    });
    if (later.length > 0) {
      const rows = (await store.query([{ ids: later.map(([id]) => id), kinds: [KIND_DM_CHAT, KIND_DM_FILE] }], { signal: opts.signal }))
        .filter((ev) => !isExpired(ev.tags))
        .map((ev) => withArrival(storedToDm17(ev, self), known.get(ev.id)?.at));
      const deleted = await authorDeleted(store, rows, opts.signal);
      for (const row of rows) {
        if (deleted.has(row.rumorId) || row.peers.length === 0) continue;
        const key = dmConvKey(row.peers);
        const head = byConversation.get(key);
        if (head && dmAt(row) > dmAt(head)) byConversation.set(key, row);
      }
    }
  }

  return [...byConversation.entries()]
    .map(([key, latest]) => ({
      key,
      peers: latest.peers,
      latest,
      mine: mine.has(key),
      mineAt: mine.get(key),
    }))
    .sort((a, b) => dmAt(b.latest) - dmAt(a.latest));
}

/**
 * How far back the list looks past an expired or deleted head: RETRY_ROUNDS
 * pages of RETRY_PAGE, bounding what a burst of deleted messages costs a refresh.
 */
const RETRY_PAGE = 8;
const RETRY_ROUNDS = 4;

/**
 * Local search over decrypted chat/file rumors (never prompts the signer):
 * every typed word must appear, case- and accent-insensitively as a word prefix
 * where the store has a content index, as a substring where it doesn't. Covers
 * the whole history; `scan` caps the matches read. Newest-first, capped at `limit`.
 */
export async function searchDm17Rumors(
  self: string,
  query: string,
  opts: {
    limit?: number;
    scan?: number;
    signal?: AbortSignal;
    /** Restrict matches to these canonical participant-set keys before limiting. */
    allowedConversationKeys?: ReadonlySet<string>;
  } = {},
): Promise<OpenedDm[]> {
  const search = literalSearch(query);
  if (!search) return [];
  const events = await dm17Store(self).query(
    [{ kinds: [KIND_DM_CHAT, KIND_DM_FILE], search, limit: opts.scan ?? 2000 }],
    { signal: opts.signal },
  );
  const matches = events
    .filter((ev) => !isExpired(ev.tags))
    .map((ev) => storedToDm17(ev, self))
    .filter(
      (o) =>
        o.peers.length > 0 &&
        (!opts.allowedConversationKeys ||
          opts.allowedConversationKeys.has(dmConvKey(o.peers))),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches.slice(0, opts.limit ?? 200);
}

/** Rumors scanned per sweep page. */
const SWEEP_PAGE = 1000;
/** Pages a single sweep will walk (bounds a huge history to a bounded cost). */
const SWEEP_MAX_PAGES = 20;

/**
 * Physically remove rumors whose NIP-40 `expiration` passed (hiding isn't
 * disappearing). `expiration` isn't indexed, so walk newest-first in bounded
 * pages. Returns the count removed.
 */
export async function sweepExpiredDm17Rumors(
  self: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  const s = dm17Store(self);
  const now = nowSecs();
  let until: number | undefined;
  let removed = 0;
  const conversations = new Set<string>();

  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const filter: { kinds: number[]; limit: number; until?: number } = {
      kinds: DM_RUMOR_KINDS,
      limit: SWEEP_PAGE,
    };
    if (until !== undefined) filter.until = until;
    const events = await s.query([filter], { signal: opts.signal });
    if (events.length === 0) break;

    const expired = events.filter((ev) => isExpired(ev.tags, now));
    const ids = expired.map((ev) => ev.id);
    if (ids.length > 0) {
      await s.remove([{ ids }], { signal: opts.signal });
      removed += ids.length;
      for (const ev of expired) {
        const key = dmConvKeyOf(ev, self);
        if (key) conversations.add(key);
      }
    }
    if (events.length < SWEEP_PAGE) break;
    // Page strictly older; `created_at` ties would otherwise loop forever.
    const oldest = Math.min(...events.map((ev) => ev.created_at));
    if (until !== undefined && oldest - 1 >= until) break;
    until = oldest - 1;
  }

  if (removed > 0) {
    retireConversationReads();
    emitWireScopes(["dm", ...[...conversations].map(dmThreadScope)]);
  }
  return removed;
}

// Sync cursor: the inbox scan's persisted resume position. Wraps are backdated
// ≤ 2 days (NIP-59), so consumers rescan a slack window (see useDm17's
// RESYNC_SLACK and relayScanWatermarks).

export interface Dm17Cursor {
  /** Newest wrap ingested, account-wide. Unused by current scans; kept for older builds. */
  newest: number;
  /** `created_at` of the oldest wrap paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop older-backfills. */
  exhausted: boolean;
  /**
   * Per-relay watermark at or below which that relay is proven scanned. Missing
   * means "never completed a scan", so a legacy upgrade rescans every relay.
   */
  relayNewest?: Record<string, number>;
  /**
   * Per relay, when (ms) its last full backdate-window scan completed. Persisted so a
   * cold start doesn't re-read two days of wraps from every relay.
   */
  relayFullScanAt?: Record<string, number>;
  /**
   * Per relay, the `until` the background history walk resumes from: everything
   * newer has been read from that relay. Only recedes.
   */
  relayOldest?: Record<string, number>;
  /** Per relay, when (ms) the history walk reached an empty page below `relayOldest`. */
  relayExhaustedAt?: Record<string, number>;
}

/** Monotonic per-relay merge; `keep` (when given) drops relays outside it. */
function mergeRelayStamps(
  prev: Record<string, number> | undefined,
  patch: Record<string, number> | undefined,
  keep: Set<string> | undefined,
): Record<string, number> {
  const out = { ...(prev ?? {}) };
  for (const [relay, value] of Object.entries(patch ?? {})) {
    if (!Number.isFinite(value) || value <= 0) continue;
    out[relay] = Math.max(out[relay] ?? 0, value);
  }
  if (keep) {
    for (const relay of Object.keys(out)) {
      if (!keep.has(relay)) delete out[relay];
    }
  }
  return out;
}

/** Per-relay merge that only recedes; `keep` (when given) drops relays outside it. */
function mergeRelayFloors(
  prev: Record<string, number> | undefined,
  patch: Record<string, number> | undefined,
  keep: Set<string> | undefined,
): Record<string, number> {
  const out = { ...(prev ?? {}) };
  for (const [relay, value] of Object.entries(patch ?? {})) {
    if (!Number.isFinite(value) || value <= 0) continue;
    out[relay] = Math.min(out[relay] ?? Infinity, value);
  }
  if (keep) {
    for (const relay of Object.keys(out)) {
      if (!keep.has(relay)) delete out[relay];
    }
  }
  return out;
}

const cursorKey = (self: string) => `dm17-cursor:${self}`;

/** Read the viewer's inbox cursor, or undefined if none has been saved. */
export function readDm17Cursor(self: string): Promise<Dm17Cursor | undefined> {
  return readFolded<Dm17Cursor>(cursorKey(self));
}

/**
 * Merge sync progress (best-effort): every field merges monotonically, so a
 * race can only cost a re-scan, never a skip. `pruneRelaysTo` drops watermarks
 * for relays no longer in the set.
 */
export function updateDm17Cursor(
  self: string,
  patch: Partial<Dm17Cursor>,
  opts?: { pruneRelaysTo?: readonly string[] },
): Promise<void> {
  // Serialized per viewer: the inbox scan and the history walk patch different fields.
  const run = (cursorWrites.get(self) ?? Promise.resolve()).then(() => writeDm17Cursor(self, patch, opts));
  const tail = run.catch(() => undefined);
  cursorWrites.set(self, tail);
  void tail.then(() => {
    if (cursorWrites.get(self) === tail) cursorWrites.delete(self);
  });
  return run;
}

const cursorWrites = new Map<string, Promise<void>>();

async function writeDm17Cursor(
  self: string,
  patch: Partial<Dm17Cursor>,
  opts?: { pruneRelaysTo?: readonly string[] },
): Promise<void> {
  const prev = await readDm17Cursor(self);
  const keep = opts?.pruneRelaysTo ? new Set(opts.pruneRelaysTo) : undefined;
  const relayNewest = mergeRelayStamps(prev?.relayNewest, patch.relayNewest, keep);
  const relayFullScanAt = mergeRelayStamps(prev?.relayFullScanAt, patch.relayFullScanAt, keep);
  const relayOldest = mergeRelayFloors(prev?.relayOldest, patch.relayOldest, keep);
  const relayExhaustedAt = mergeRelayStamps(prev?.relayExhaustedAt, patch.relayExhaustedAt, keep);
  const next: Dm17Cursor = {
    newest: Math.max(prev?.newest ?? 0, patch.newest ?? 0),
    oldest:
      patch.oldest !== undefined
        ? prev?.oldest
          ? Math.min(prev.oldest, patch.oldest)
          : patch.oldest
        : (prev?.oldest ?? 0),
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
    ...(Object.keys(relayNewest).length > 0 ? { relayNewest } : {}),
    ...(Object.keys(relayFullScanAt).length > 0 ? { relayFullScanAt } : {}),
    ...(Object.keys(relayOldest).length > 0 ? { relayOldest } : {}),
    ...(Object.keys(relayExhaustedAt).length > 0 ? { relayExhaustedAt } : {}),
  };
  await writeFolded(cursorKey(self), next);
}

// Opened-wrap memo: wrap ids already opened, persisted per viewer so the 2-day
// NIP-59 rescan doesn't re-decrypt a full page on every cold start (Android kills
// the WebView often). Wiped on logout; a lost id just re-decrypts once.

const seenWrapsKey = (self: string) => `dm17-seen:${self}`;

/** Cap on persisted opened-wrap ids (callers half-evict at this bound). */
export const DM17_SEEN_CAP = 4096;

export function readDm17SeenWrapIds(self: string): Promise<string[] | undefined> {
  return readFolded<string[]>(seenWrapsKey(self));
}

export async function writeDm17SeenWrapIds(self: string, ids: Iterable<string>): Promise<void> {
  await writeFolded(seenWrapsKey(self), [...ids]);
}

// Live inbound-wrap buffer: the wire receives DM wraps live but can't decrypt
// them (signer + consent gate live in useDm17), so it stashes raw wraps here
// and rings `dm:wrap` — avoiding a refetch and its NIP-42 latency. Replayed
// wraps (the wire rewinds `since` by the NIP-59 window) are deduped by a
// session-seen set. Bounded; ciphertext only, never persisted.

/** Cap on buffered live wraps (a burst past this falls back to the poll). */
const LIVE_WRAP_CAP = 256;
/** Cap on remembered wrap ids (oldest halves are shed — the poll dedupes deeper). */
const LIVE_SEEN_CAP = 4096;
const liveWraps = new Map<string, NostrEvent>();
const liveWrapSeen = new Set<string>();

function rememberLiveWrap(id: string): void {
  if (liveWrapSeen.size >= LIVE_SEEN_CAP) {
    let drop = LIVE_SEEN_CAP >> 1;
    for (const old of liveWrapSeen) {
      liveWrapSeen.delete(old);
      if (--drop <= 0) break;
    }
  }
  liveWrapSeen.add(id);
}

/**
 * Stash live DM wraps; returns only those not seen this session (gate doorbell/notifications
 * on these). `live` (delivered as it was published, not replayed) also notes when each arrived.
 */
export function bufferLiveDmWraps(wraps: NostrEvent[], opts?: { live?: boolean }): NostrEvent[] {
  const fresh: NostrEvent[] = [];
  const now = nowSecs();
  for (const w of wraps) {
    // Drop expired wraps on arrival so they can't notify for a message that no longer exists.
    if (isExpired(w.tags, now)) continue;
    if (liveWrapSeen.has(w.id)) continue;
    if (liveWraps.size >= LIVE_WRAP_CAP) continue;
    rememberLiveWrap(w.id);
    liveWraps.set(w.id, w);
    if (opts?.live) noteLiveWrapArrival(w.id, now);
    fresh.push(w);
  }
  return fresh;
}

/** Re-buffer wraps after a deferred decrypt, bypassing the session-seen skip. */
export function rebufferLiveDmWraps(wraps: NostrEvent[]): void {
  for (const w of wraps) {
    if (liveWraps.size >= LIVE_WRAP_CAP && !liveWraps.has(w.id)) continue;
    liveWraps.set(w.id, w);
  }
}

export function hasBufferedLiveDmWraps(): boolean {
  return liveWraps.size > 0;
}

/** Take (and clear) the buffered live wraps for decryption by useDm17. */
export function drainLiveDmWraps(): NostrEvent[] {
  if (liveWraps.size === 0) return [];
  const out = [...liveWraps.values()];
  liveWraps.clear();
  return out;
}

/** Reset the buffer AND the session-seen ids (tests only). */
export function resetLiveDmWraps(): void {
  liveWraps.clear();
  liveWrapSeen.clear();
  liveWrapArrivals.clear();
}

// Arrival times. A rumor is dated by its sender's clock, and a clock minutes slow
// files a reply above the message it answers and under the reader's read stamp, so
// it is never counted unread or notified. A message that arrived LIVE is therefore
// ordered, counted and notified by when it arrived here, where that differs from its
// own date by more than ARRIVAL_SKEW_SECS. That is a fact about this device, not the
// rumor, so it is kept beside it: one KV key per rumor, written by every writer of
// this tenant (the Android service, the iOS extension and the service worker too).

/** KV prefix of the arrival facts; `dm17at:<self>:<rumorId>`. */
export const DM_ARRIVAL_PREFIX = "dm17at:";
/** A gap within this is latency, not a clock: such a message keeps its own date. */
export const ARRIVAL_SKEW_SECS = 2;

/** One arrival fact. `sent` and `conv` let the unread count and the list use it without reading the rumor. */
export interface Dm17Arrival {
  /** Unix seconds by this device's (corrected) clock. */
  at: number;
  /** The rumor's own `created_at`. */
  sent: number;
  /** Its conversation key (`dmConvKey`). */
  conv: string;
  /** Written by someone other than the viewer. */
  in: boolean;
}

const arrivalKey = (self: string, rumorId: string) => `${DM_ARRIVAL_PREFIX}${self}:${rumorId}`;

/** Whether a message that arrived at `at` keeps that as its time. */
export function arrivalCounts(kind: number, createdAt: number, at: number): boolean {
  return DM_MESSAGE_KINDS.includes(kind) && Math.abs(at - createdAt) > ARRIVAL_SKEW_SECS;
}

/** `opened`, stamped with when it arrived where that counts (see {@link arrivalCounts}). */
export function withArrival(opened: OpenedDm, at: number | undefined): OpenedDm {
  if (at === undefined || opened.arrivedAt !== undefined || !arrivalCounts(opened.kind, opened.createdAt, at)) return opened;
  return { ...opened, arrivedAt: at };
}

/** When each live wrap arrived, until it is opened. Session-only, bounded like the buffer. */
const liveWrapArrivals = new Map<string, number>();

function noteLiveWrapArrival(wrapId: string, at: number): void {
  if (liveWrapArrivals.size >= LIVE_SEEN_CAP) liveWrapArrivals.delete(liveWrapArrivals.keys().next().value!);
  liveWrapArrivals.set(wrapId, at);
}

/** When a live wrap arrived, once: the caller is opening it. */
export function takeLiveWrapArrival(wrapId: string): number | undefined {
  const at = liveWrapArrivals.get(wrapId);
  liveWrapArrivals.delete(wrapId);
  return at;
}

/** Per account, every recorded arrival by rumor id: read from KV once, then kept current by every write. */
const arrivals = new Map<string, Promise<Map<string, Dm17Arrival>>>();

/** The arrivals recorded for `self`'s messages. */
export function readDm17Arrivals(self: string): Promise<Map<string, Dm17Arrival>> {
  let loaded = arrivals.get(self);
  if (!loaded) {
    const prefix = `${DM_ARRIVAL_PREFIX}${self}:`;
    const load = getArmadaDB().kv.list<Dm17Arrival>({ prefix }).then((entries) => {
      const map = new Map<string, Dm17Arrival>();
      for (const { key, value } of entries) {
        if (value && typeof value.at === "number" && typeof value.sent === "number" && typeof value.conv === "string") {
          map.set(key.slice(prefix.length), value);
        }
      }
      return map;
    });
    // A failed read is retried by the next caller rather than remembered as empty.
    load.catch(() => {
      if (arrivals.get(self) === load) arrivals.delete(self);
    });
    arrivals.set(self, load);
    loaded = load;
  }
  return loaded.catch(() => new Map());
}

/** Drop the memo, for a writer elsewhere (the Android service while the WebView slept) and logout. */
export function forgetDm17Arrivals(): void {
  arrivals.clear();
}

async function noteArrivals(self: string, opened: readonly OpenedDm[]): Promise<void> {
  const arrived = opened.filter((o) => o.arrivedAt !== undefined && o.peers.length > 0);
  if (arrived.length === 0) return;
  const known = await readDm17Arrivals(self);
  const fresh = arrived.filter((o) => !known.has(o.rumorId));
  if (fresh.length === 0) return;
  const kv = getArmadaDB().kv;
  await Promise.all(fresh.map((o) => {
    const fact: Dm17Arrival = { at: o.arrivedAt!, sent: o.createdAt, conv: dmConvKey(o.peers), in: o.author !== self };
    known.set(o.rumorId, fact);
    return kv.set(arrivalKey(self, o.rumorId), fact).catch(() => undefined);
  }));
}

/** `rows` with the arrivals recorded for them. */
export async function withDm17Arrivals(self: string, rows: OpenedDm[]): Promise<OpenedDm[]> {
  if (rows.length === 0) return rows;
  const known = await readDm17Arrivals(self);
  if (known.size === 0) return rows;
  return rows.map((row) => {
    const fact = known.get(row.rumorId);
    return fact && row.arrivedAt === undefined ? { ...row, arrivedAt: fact.at } : row;
  });
}
