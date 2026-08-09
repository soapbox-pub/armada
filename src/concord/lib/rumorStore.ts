/**
 * Concord opened-event cache — the decrypted store for every plane.
 *
 * Concord traffic arrives as opaque kind-1059/21059 wraps (CORD-01). We never
 * persist those wraps anywhere: caching ciphertext is wasteful (every cold read
 * would re-run two NIP-44 opens and a Schnorr verify per event) and pollutes the
 * shared event cache. Instead we decrypt once on ingest and persist the
 * recovered rumor here — EXACTLY as its author wrote it — so the chat plane
 * reads back with an ordinary Nostr filter and no decrypt:
 *
 *   chat: store.query([{ kinds: [9], "#channel": [channelIdHex], limit }])
 *
 * Backed by ArmadaDB, ONE TENANT PER COMMUNITY (`c2:<communityIdHex>`) — a
 * separate physical database each, and separate from `armada-events`, so each
 * community's query engine, custom tag index, and NIP-09 deletion semantics stay
 * isolated.
 *
 * The per-community split is a SECURITY boundary, not a performance one. Every
 * read here is a tag query, and a tag is just data a keyholder wrote: the only
 * thing stopping a member of community A from publishing a rumor tagged with a
 * channel id belonging to community B — and having it served into B's timeline —
 * is application-level validation (`checkChannelBinding` on the chat path,
 * {@link writeOpened}'s refusal of any `channel` tag elsewhere). When every
 * community shared one store, a single bug in either check leaked across
 * communities. Now the tenant is chosen by the CALLER, from the community whose
 * keys it already holds, so a forged tag can at worst collide inside the
 * community that forged it. Defense in depth: the checks stay, and the storage
 * boundary means a lapse in them is contained.
 *
 * Community ids are stable — `sha256("concord/community" || owner_xonly ||
 * owner_salt)` (CORD-01 §A.4), with no epoch input — so a rekey or a Refounding
 * rotates stream keys WITHOUT moving the tenant. One database per joined
 * community, not one per epoch.
 *
 * The full signed SEAL is preserved too — the Control Plane re-wraps plaintext
 * seals verbatim across epochs during a compaction (CORD-02 §5 / `rewrapSeal`)
 * — but in ArmadaDB's KV, keyed by rumor id ({@link readStoredSeal}), NOT in
 * the stored rumor. A seal is not part of the rumor its author signed, and
 * serializing one into a tag value rewrites the very bytes the rumor id
 * commits to. It is also bulky and read by exactly one call site, so a
 * separate key is what it should have been: the row stays the rumor, and the
 * seal is fetched when a compaction actually needs it.
 *
 * Deletes ARE deletes: a kind-5 rumor written here triggers the store's NIP-09
 * pass, which physically removes the targeted event it authored. Moderator
 * deletes are authorized against the roster at the WRITE site (see `useChannel`)
 * before the kind-5 rumor reaches the store.
 *
 * Trust note: this persists DECRYPTED plane data at rest — the same device-trust
 * level as the folded cache and the signer's decrypt cache, which already do.
 * Anyone with local storage access already holds the keys. Wiped on logout (see
 * purgeClientStorage).
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import {
  KIND_COMMENT,
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
import type { NRumorStore } from "@/lib/db/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { OpenedChat } from "@/concord/lib/chat";

/** The chat plane's channel binding (CORD-03 §3) — the tag chat reads index. */
const TAG_CHANNEL = "channel";

/**
 * The opened-event store for one community.
 *
 * `defaultIndexTags` indexes every tag with a short name and a value under 200
 * chars, which covers the multi-letter `channel` the chat plane queries as well
 * as the single-letter ones (`e`, `p`, `i`, `k`, `q`).
 */
function rumorStore(communityIdHex: string): NRumorStore {
  return getArmadaDB().tenant(communityTenant(communityIdHex));
}

/** The ArmadaDB tenant id holding a community's opened events. */
export function communityTenant(communityIdHex: string): string {
  return `c2:${communityIdHex}`;
}

// ── Control snapshot membership ───────────────────────────────────────────────
//
// The wrap that carried a rumor is not stored. It does not have to be: the
// carrier wrap id is read by nothing that reads the store (every transport
// dedup set is built from wraps in hand), and the seal form is a function of
// the rumor's kind (PLANE_RULES), checked once at ingest.
//
// ONE envelope fact is genuinely not in the rumor: whether a control edition
// arrived under the CURRENT epoch's control stream. A Refounding's compaction
// re-wraps editions VERBATIM under the new epoch's address (CORD-06 §3), so the
// bytes — and therefore the rumor id — are identical either way, and the fold
// needs the distinction because a compaction snapshot outranks old-root
// fragments (`headCandidates`).
//
// So that, and only that, is kept — as what it actually is: a set of rumor ids
// per control stream address, in KV. Writers are dumb (a rumor's id joins the
// set for the address it arrived on) and the reader asks for the address it
// considers current, so nothing has to agree about which epoch is live at write
// time. Nothing here is shaped like an event, and the rumor tenant holds rumors
// and nothing else.

/** KV key prefix holding a community's per-stream control snapshot sets. */
const snapshotPrefix = (communityIdHex: string) => `c2snap:${communityIdHex}:`;

/** KV key holding the rumor ids seen under one control stream address. */
const snapshotKey = (communityIdHex: string, controlPk: string) =>
  `${snapshotPrefix(communityIdHex)}${controlPk}`;

/**
 * The rumor ids that arrived under `controlPk`, or undefined if none did.
 *
 * A SUPERSET of what the store still holds — a NIP-09 delete removes the rumor
 * without rewriting this — which is harmless: every caller uses it to filter
 * editions it has already read out of the store.
 */
export async function readControlSnapshot(
  communityIdHex: string,
  controlPk: string,
): Promise<Set<string> | undefined> {
  if (!communityIdHex || !controlPk) return undefined;
  try {
    const ids = await getArmadaDB().kv.get<string[]>(snapshotKey(communityIdHex, controlPk));
    return ids && ids.length > 0 ? new Set(ids) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record which control stream each fresh rumor arrived on.
 *
 * Read-modify-write per address, last-writer-wins under concurrency: a lost
 * update costs nothing, because the control plane is swept in COMPLETE mode and
 * the next sweep re-offers the whole plane.
 *
 * ONLY WORTH KEEPING FOR A REFOUNDED COMMUNITY. The set exists to tell a
 * compaction snapshot from old-root fragments, and a community that has never
 * rotated its root has no compaction to distinguish — `useControlSnapshot`
 * doesn't even ask. Writing it anyway meant one KV value per community growing
 * by an id per control edition forever, re-serialized on every sweep, read by
 * nothing. So {@link writeOpened} takes `refounded` and skips this when it is
 * false; a caller that can't tell still writes it (see there).
 *
 * Exported for the legacy drain, which recovers the same fact from the old
 * store's `stream` tag. It takes the two fields it actually reads rather than a
 * whole {@link OpenedEvent}, so a copied row need not be reconstituted into one.
 */
export async function noteControlSnapshot(
  communityIdHex: string,
  opened: Array<{ streamPk?: string; rumorId: string }>,
): Promise<void> {
  const byPk = new Map<string, string[]>();
  for (const o of opened) {
    if (!o.streamPk) continue;
    const list = byPk.get(o.streamPk);
    if (list) list.push(o.rumorId);
    else byPk.set(o.streamPk, [o.rumorId]);
  }
  const kv = getArmadaDB().kv;
  await Promise.all(
    [...byPk].map(async ([pk, ids]) => {
      const key = snapshotKey(communityIdHex, pk);
      const merged = new Set((await kv.get<string[]>(key)) ?? []);
      const before = merged.size;
      for (const id of ids) merged.add(id);
      if (merged.size !== before) await kv.set(key, [...merged]);
    }),
  );
}

/**
 * Forget the snapshot sets of every control address except `keepPks` (the ones
 * whose keys the community still holds), so retired epochs don't accumulate id
 * lists forever. Best-effort; called once per community per session.
 */
export async function pruneControlSnapshots(
  communityIdHex: string,
  keepPks: string[],
): Promise<void> {
  if (!communityIdHex) return;
  try {
    const kv = getArmadaDB().kv;
    const keep = new Set(keepPks.map((pk) => snapshotKey(communityIdHex, pk)));
    const stale = (await kv.list({ prefix: snapshotPrefix(communityIdHex) }))
      .map(({ key }) => key)
      .filter((key) => !keep.has(key));
    await Promise.all(stale.map((key) => kv.delete(key)));
  } catch {
    // best-effort
  }
}

// ── Codec: OpenedEvent ⇆ stored rumor ────────────────────────────────────────
//
// The stored row IS the recovered rumor: `id` the rumor id (the NIP-01 hash),
// `pubkey` the REAL author (so NIP-09 self-delete matches), `tags` the author's
// own, and no `sig`. Everything the store knows ABOUT it is held elsewhere,
// keyed by that id — the envelope facts above, and the signed seal in KV (see
// {@link readStoredSeal}).

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

/**
 * Reconstruct an OpenedEvent from a stored rumor.
 *
 * The envelope fields are absent, not blank: the wrap is gone, and every reader
 * of a stored event works from the rumor alone (see the section above).
 */
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

// ── Reads / writes ────────────────────────────────────────────────────────────

/**
 * The chat kinds that render as their OWN item — timeline rows (message, poll,
 * thread reply, timer notice) and events-bar entries (calendar).
 */
const CHAT_ROW_KINDS = [9, 1068, 1111, 1740, 31922, 31923];
/**
 * The chat kinds that only ever DECORATE a row: delete, reaction, vote, edit,
 * zaps, RSVP. Read under their OWN budget (see {@link queryChannelRumors}),
 * never the rows': a shared limit let a bot bury a flood's rows — the
 * detector's whole evidence, and the reader's timeline — under reactions to
 * its own spam, minted for free and rendering as nothing.
 */
const CHAT_SIDE_KINDS = [5, 7, 1018, 3302, 8333, 9735, 31925];
/** All chat-plane rumor kinds we persist and fold. */
const CHAT_KINDS = [...CHAT_ROW_KINDS, ...CHAT_SIDE_KINDS];
/**
 * Side-events fetched per row of `limit`. Generous enough that tallies stay
 * whole on any organic channel; when a reaction flood starves it anyway, what
 * is lost is decoration on old rows — never rows, and never evidence.
 */
const SIDE_EVENT_FACTOR = 4;

/**
 * The chat kinds a reader sees as a COMPOSED row: message, poll, thread reply.
 *
 * The flood detector's notion of presence ({@link queryChannelFirstSeen})
 * counts only these. "First heard" has to mean the author put a row in front
 * of readers — a reaction, vote, edit or delete renders nothing and is the
 * cheapest thing a key can emit, which makes it exactly what a warming bot
 * reaches for: reacting to its own messages dated a sybil set as
 * long-established without a reader ever seeing a thing.
 */
const SPEECH_KINDS = [9, 1068, 1111];

/**
 * Drop rows whose NIP-40 `expiration` has passed (CORD-08 §3). Every chat read
 * applies this: the sweep ({@link sweepExpiredCommunityRumors}) physically
 * removes expired rows eventually, but a read between expiry and the next
 * sweep must not display them.
 */
function notExpired(events: NostrRumor[]): NostrRumor[] {
  const now = Math.floor(Date.now() / 1000);
  return events.filter((ev) => !isExpired(ev.tags, now));
}

/**
 * Read a channel's cached chat rumors, newest-first. `limit` budgets the ROWS
 * ({@link CHAT_ROW_KINDS}); side-events ride along under their own budget
 * ({@link CHAT_SIDE_KINDS}, ×{@link SIDE_EVENT_FACTOR}) so they can never
 * displace the rows they decorate. A `channel` tag query hits the tag index
 * directly. `before` (a `created_at` upper bound, exclusive) pages older
 * history out of the store. Filters are independently limit-bounded in one
 * transaction, exactly as {@link queryRumorsByChannel} relies on.
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

/**
 * When each author was first heard in this channel — the flood detector's
 * notion of who was already here ({@link FloodOptions.firstSeen} in
 * `floodCluster.ts`).
 *
 * That question CANNOT be answered from the rendered window. `useChannel`
 * opens a channel holding its newest `WINDOW_SIZE` rumors, and a flood big
 * enough to matter fills that window completely: every author in it then
 * reads as new-together, the crowd has no one to be new RELATIVE to, and the
 * detector goes blind exactly when it is needed. Measured on a live
 * 370-message campaign, the cohort rule folded 99% given the channel's real
 * history and 0% given the newest hundred rows.
 *
 * A TIME window rather than a row count, because a flood is by nature recent
 * and what the rule needs is the quiet before it. The engine answers
 * newest-first, so when the row cap bites it is the OLDEST rows — the
 * precedent-bearing end — that fall off, and an author whose only old message
 * was cut is dated by a newer one or missing entirely. Both are safe: the
 * detector merges by minimum against its own batch, so a capped scan can only
 * lose a protection or a precedent, never grant a flood immunity. (The origin
 * design this replaced had the opposite failure — a flood at the edge of what
 * the scan could see READ AS the channel's founding and exempted itself.)
 *
 * SPEECH ONLY ({@link SPEECH_KINDS}). An author is dated by their first
 * visible row, never by side-events — otherwise presence is free to mint, and
 * a bot that reacts to its own spam walks every key past the arrival rules
 * before saying a word. Keeping side-events out of the FILTER also keeps them
 * from spending the row cap: a reaction flood must not be able to push the
 * precedent-bearing old rows out of the scan.
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

/**
 * Read cached rumors by id, whatever plane or channel they arrived on.
 *
 * For surfaces that hold a POINTER to a message rather than a position in a
 * timeline — a moderator's report queue, which knows only the `e` tag the
 * reporter sent. An id that isn't in this member's store yields nothing, which
 * is ordinary: it may be in a channel they don't hold, or older than what they
 * have synced. Expired rows are dropped like every other read.
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
 * Read a channel's cached WebXDC coordination rumors (kind {@link KIND_WEBXDC})
 * for one app session (`#i` = the webxdc uuid). Deliberately SEPARATE from
 * {@link queryChannelRumors}: 3310 is not in {@link CHAT_KINDS}, so these
 * durable in-chat-app state updates are stored (the wire decrypts every inner
 * kind) but never surface in the timeline. Both `channel` and the single-letter
 * `i` are index-backed, so this is a cheap indexed read. Durable state only —
 * realtime frames ride ephemeral 21059 wraps and are never stored.
 */
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
  communityIdHex: string,
  channelIdsHex: string[],
  opts: { perChannel: number; signal?: AbortSignal },
): Promise<Map<string, OpenedChat[]>> {
  const out = new Map<string, OpenedChat[]>();
  if (channelIdsHex.length === 0) return out;

  // Rows and side-events under separate budgets, like queryChannelRumors: a
  // reaction flood must not displace the messages the badges and threads (and
  // the badge path's flood detector) are derived from.
  const events = await rumorStore(communityIdHex).query(
    channelIdsHex.flatMap((idHex) => [
      { kinds: CHAT_ROW_KINDS, "#channel": [idHex], limit: opts.perChannel },
      { kinds: CHAT_SIDE_KINDS, "#channel": [idHex], limit: opts.perChannel },
    ]),
    { signal: opts.signal },
  );

  // One query() merges + de-dupes across filters, so recover each row's channel
  // from its own binding tag rather than trusting filter order.
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
  communityIdHex: string,
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
  const events = await rumorStore(communityIdHex).query([filter], { signal: opts.signal });
  return notExpired(events).map((ev) =>
    storedToOpenedChat(ev, ev.tags.find((t) => t[0] === "channel")?.[1] ?? ""),
  );
}

/** Message kinds whose content is user-searchable: chat + NIP-22 thread comments. */
const SEARCHABLE_KINDS = [9, 1068, 1111];

/**
 * Upper bound on rumors scanned per search. The store has NO content index
 * (only tags are indexed), so a content/media search is a scan of the cached
 * messages — this caps the newest-first scan so a very deep community can't
 * stall the search. `#channel` and `authors` ARE index-backed, so those
 * facets narrow the scan cheaply before the in-memory predicates run.
 */
const SEARCH_SCAN_LIMIT = 5000;

/**
 * Search cached message rumors across one or more channels, newest-first up to
 * `limit`. Purely local: Concord chat is end-to-end encrypted, so — unlike NIP-29's
 * relay NIP-50 search — the decrypted rumor store is the ONLY searchable
 * corpus. The `#channel` allow-list and `authors` are pushed into the indexed
 * store filter; the free-text `query` (case-insensitive substring) and `media`
 * facet are applied in memory over the scan. Each result recovers its own
 * channel id from its `channel` binding tag.
 */
export async function searchRumors(
  communityIdHex: string,
  channelIdsHex: string[],
  opts: {
    query: string;
    authors?: string[];
    media?: SearchMedia;
    limit: number;
    signal?: AbortSignal;
  },
): Promise<OpenedChat[]> {
  if (channelIdsHex.length === 0) return [];
  const filter: {
    kinds: number[];
    "#channel": string[];
    authors?: string[];
    limit: number;
  } = { kinds: SEARCHABLE_KINDS, "#channel": channelIdsHex, limit: SEARCH_SCAN_LIMIT };
  if (opts.authors && opts.authors.length > 0) filter.authors = opts.authors;

  const events = notExpired(await rumorStore(communityIdHex).query([filter], { signal: opts.signal }));
  const q = opts.query.trim().toLowerCase();
  const media = opts.media ?? "all";

  // `query` returns newest-first, so iterate and stop at `limit` for the newest
  // matches across the whole scanned window.
  const out: OpenedChat[] = [];
  for (const ev of events) {
    if (q && !ev.content.toLowerCase().includes(q)) continue;
    if (!messageMatchesMedia(ev.content, ev.tags, media)) continue;
    const idHex = ev.tags.find((t) => t[0] === "channel")?.[1] ?? "";
    out.push(storedToOpenedChat(ev, idHex));
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Read every cached opened event of one plane — ONE indexed `kinds` read.
 *
 * The plane's kinds ARE its identity in the store. {@link writeOpened} refused
 * anything else at ingest, checked against the stream keys that actually opened
 * the wrap, so a rumor of this plane's kind being here means it arrived on this
 * plane. That is what replaced a by-stream-address read: the addresses are
 * derived per epoch, so selecting on them meant storing an address per rumor,
 * and the kind does the same work with nothing stored.
 *
 * Rekey is not readable this way — its rounds are selected per (scope, epoch),
 * not per plane. See {@link queryRekeyRounds}.
 */
export async function queryPlane(
  communityIdHex: string,
  plane: Exclude<Plane, "rekey">,
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<OpenedEvent[]> {
  const filter: { kinds: number[]; limit?: number } = { kinds: PLANE_RULES[plane].kinds };
  if (opts?.limit !== undefined) filter.limit = opts.limit;
  const events = await rumorStore(communityIdHex).query([filter], { signal: opts?.signal });
  return events.map(storedToOpened);
}

/**
 * Read the cached rekey rounds for specific (scope, new-epoch) targets.
 *
 * A rekey address is `f(root, scope, epoch)`, so selecting rounds by address
 * meant storing the address. The rumor names the same two things ITSELF, in the
 * `scope` and `newepoch` tags `parseRekey` already reads and validates —
 * `scope` is indexed, so this stays one indexed read plus an in-memory epoch
 * match.
 *
 * Nothing is given up by not selecting on the address: every member derives
 * rekey addresses from the community root they all hold, so publishing to one
 * was never restricted either. A round's authority is its CORD-04 §5 citation,
 * checked against the roster by the caller.
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
    // Compare as numbers, so a round tagged "07" still matches epoch 7 rather
    // than being silently dropped by a string compare.
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

// ── Seals ─────────────────────────────────────────────────────────────────────
//
// A seal is the author-signed NIP-59 envelope the rumor arrived in — evidence
// ABOUT the rumor, not part of it. It is kept only so a Refounding's compaction
// can republish an entity's head under the new epoch verbatim (CORD-06 §3), and
// is read by exactly one call site, once per rotation.

/** Rumor kinds a Pin can prove, whose seals must therefore survive the store. */
const PIN_PROVABLE_KINDS: ReadonlySet<number> = new Set([KIND_MESSAGE, KIND_COMMENT, KIND_EDIT]);

/** KV key holding the signed seal a stored rumor arrived in. */
function sealKey(communityIdHex: string, rumorId: string): string {
  return `c2seal:${communityIdHex}:${rumorId}`;
}

/**
 * The seal a stored rumor arrived in, or undefined if none was kept.
 *
 * Only PLAINTEXT seals are kept: `rewrapSeal` refuses an encrypted one (its
 * ciphertext is bound to the old stream's conversation key, so it cannot
 * survive a re-wrap), which makes storing them pure cost — and encrypted is
 * what chat, guestbook and rekey all use, i.e. nearly every rumor in the store.
 *
 * Prefer a seal already on the {@link OpenedEvent}: an event opened this
 * session carries the real one, and a row predating the KV move carries it as a
 * tag. This is the fallback for everything else.
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
 * Keep the seal a stored rumor arrived in.
 *
 * Exported for the legacy drain: the old store folded the seal into a `seal`
 * tag, and moving it here is what lets the copied row be the bare rumor.
 */
export async function writeStoredSeal(
  communityIdHex: string,
  rumorId: string,
  seal: NostrEvent,
): Promise<void> {
  await getArmadaDB().kv.set(sealKey(communityIdHex, rumorId), seal);
}

/**
 * Store a batch verbatim in a community's tenant. `plane` is absent for chat
 * (see {@link writeRumors}).
 *
 * Resolves to whether the batch actually committed. It never REJECTS — most
 * callers fire and forget, and a rejection there would be an unhandled one —
 * but the outcome has to be legible to the callers that act on it: the sweep
 * memoises a wrap as processed once its rumor is stored, and a memo advanced
 * over a failed write would leave that rumor absent from the store and never
 * decrypted again.
 */
function writeStored(
  communityIdHex: string,
  opened: OpenedEvent[],
  plane?: Plane,
  snapshot = true,
): Promise<boolean> {
  if (opened.length === 0 || !communityIdHex) return Promise.resolve(true);
  const db = getArmadaDB();
  const s = db.tenant(communityTenant(communityIdHex));
  const writes: Promise<unknown>[] = [];
  for (const o of opened) {
    writes.push(s.event(openedToStored(o)));
    // Keep the seal for plaintext editions (compaction re-wraps them verbatim)
    // and for everything a Pin can prove (CORD-04 §7): the message itself, and
    // the Edit that revises it — a pin carries the Edit's own seal so keyless
    // readers verify the revision rather than trust a curator's retyping.
    // Without this a message stops being pinnable, and a revision stops being
    // provable, the moment it leaves memory.
    if (o.seal && (o.sealKind === KIND_SEAL_PLAINTEXT || PIN_PROVABLE_KINDS.has(o.kind))) {
      // Swallowed deliberately: the seal is optional evidence, the rumor is the
      // record. Letting a QuotaExceededError here fail the batch would report a
      // rumor that committed fine as uncommitted — the sweep would not memoise
      // its wrap, and the write would never be acked. A storage-pressure
      // problem must not become a sync problem.
      writes.push(db.kv.set(sealKey(communityIdHex, o.rumorId), o.seal).catch(() => undefined));
    }
  }
  if (plane === "control" && snapshot) {
    writes.push(noteControlSnapshot(communityIdHex, opened));
  }
  return Promise.all(writes)
    .then(() => true)
    .catch(() => false);
}

/**
 * Persist opened stream events for one plane (chat has its own door — see
 * {@link writeRumors}). Resolves once the batched write commits, to WHETHER it
 * committed — a caller that memoises these wraps as processed must not do so
 * over a failed write. Never rejects; most callers fire and forget.
 *
 * THIS IS THE PLANE BOUNDARY. `plane` is the plane whose stream keys actually
 * opened these wraps, and a rumor is stored only if it is one of that plane's
 * kinds, under that plane's seal form ({@link PLANE_RULES}), carrying no
 * `channel` tag. Rejecting rather than stripping keeps the stored row
 * byte-identical to the rumor its author signed.
 *
 * All three refusals guard a read that would otherwise trust data the wrapper
 * chose. The plane openers (`openPlaneWraps`) apply no kind filter and enforce
 * no channel binding, so a holder of ANY one plane's stream key could otherwise
 * wrap:
 *   - another plane's kind, and have {@link queryPlane} — a kind read — serve it
 *     as that plane's;
 *   - a control edition under an encrypted seal, which could never survive a
 *     compaction re-wrap, minting state that vanishes for the next joiner;
 *   - a chat-kind rumor tagged with ANY channel id, which would be indexed
 *     under `#channel` and served by {@link queryChannelRumors} into that
 *     channel's timeline — including a private channel, or one in another
 *     community, whose stream key they do not hold. Only
 *     `checkChannelBinding`, on the chat decode path, proves that binding.
 *
 * Note kind 5 is NOT among any plane's kinds: NIP-09 deletes are a chat-plane
 * affair (authorized against the roster in `useChannel`, stored through
 * {@link writeRumors}), and no non-chat plane publishes one.
 *
 * `refounded` says whether this community has ever rotated its root, i.e.
 * whether {@link readControlSnapshot} will ever be asked about it. It gates the
 * snapshot bookkeeping, which is otherwise a growing id list nothing reads —
 * see {@link noteControlSnapshot}. It DEFAULTS TO TRUE on purpose: a caller
 * that doesn't know gets today's behavior (a set that costs something and is
 * correct) rather than a missing one (a fold that anchors on nothing).
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
 *
 * Resolves to whether the batch committed, for the callers that ACKNOWLEDGE
 * something on the strength of it — the parked-wrap drains delete a wrap once
 * its rumor is stored, and a notified message must never be locally
 * destructible (issue #19). Never rejects; most callers fire and forget.
 */
export function writeRumors(communityIdHex: string, opened: OpenedChat[]): Promise<boolean> {
  // The `channel` binding rides through: the chat decode path already proved it
  // equals the coordinate whose key opened the wrap (`checkChannelBinding`).
  //
  // THIS IS THE OTHER HALF OF THE PLANE BOUNDARY. `writeOpened` refuses a plane
  // rumor carrying a channel tag; this refuses a chat rumor carrying a plane's
  // kind. The two fence each other because the planes share one tenant and a
  // plane is read back BY KIND: without this, a holder of any one channel's
  // stream key could wrap a kind-3308 rumor with a valid channel/epoch binding
  // and have {@link queryPlane} serve it as a control edition. Nothing
  // downstream would catch it — a stored rumor has no seal, so `parseEdition`
  // has no seal form left to reject.
  //
  // A denylist rather than an allowlist, deliberately: the chat plane carries
  // whatever inner kind its members send (see {@link CHAT_KINDS}, plus
  // {@link KIND_WEBXDC} and anything added later), so enumerating what may pass
  // would silently drop new kinds. What must NOT pass is exactly, and only, the
  // set another plane is read back by.
  // Already-expired rumors are refused at ingest (CORD-08 §3) — storing one
  // would only hand the read filter and the sweep something to hide/delete.
  const now = Math.floor(Date.now() / 1000);
  const chat = opened.filter((o) => !PLANE_KINDS.has(o.kind) && !isExpired(o.tags, now));
  if (chat.length === 0) return Promise.resolve(true);
  const channels = new Set(chat.map((o) => o.channelIdHex).filter(Boolean));
  return writeStored(communityIdHex, chat).then((stored) => {
    if (stored && channels.size > 0) emitWireScopes([...channels].map((id) => `c2:${id}`));
    return stored;
  });
}

// ── Expiry sweep (CORD-08 §3) ────────────────────────────────────────────────

/** Rumors scanned per sweep page. */
const SWEEP_PAGE = 1000;
/** Pages a single sweep will walk (bounds a huge history to a bounded cost). */
const SWEEP_MAX_PAGES = 20;
/** At most one sweep per community per interval, per session. */
const SWEEP_MIN_INTERVAL_MS = 6 * 3600 * 1000;
const lastSweepAt = new Map<string, number>();

/**
 * Physically remove every stored chat rumor whose NIP-40 `expiration` has
 * passed (CORD-08 §3). The read paths filter expired rows out too, but hiding
 * is not disappearing: the plaintext has to leave the store. `expiration` is a
 * multi-letter tag with no index (and no range query would exist for it), so
 * this walks the tenant newest-first in bounded pages and removes matches by
 * id — the same shape as the DM plane's `sweepExpiredDm17Rumors`. Self-gated
 * to one walk per community per {@link SWEEP_MIN_INTERVAL_MS}.
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

  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const filter: { kinds: number[]; limit: number; until?: number } = { kinds, limit: SWEEP_PAGE };
    if (until !== undefined) filter.until = until;
    const events = await s.query([filter], { signal: opts.signal });
    if (events.length === 0) break;

    const expired = events.filter((ev) => isExpired(ev.tags, now));
    if (expired.length > 0) {
      await s.remove([{ ids: expired.map((ev) => ev.id) }], { signal: opts.signal });
      removed += expired.length;
      for (const ev of expired) {
        const idHex = ev.tags.find((t) => t[0] === "channel")?.[1];
        if (idHex) channels.add(idHex);
      }
    }
    if (events.length < SWEEP_PAGE) break;
    // Page strictly older than this page's oldest row — ties on `created_at`
    // would otherwise loop forever on the same boundary second.
    const oldest = Math.min(...events.map((ev) => ev.created_at));
    if (until !== undefined && oldest - 1 >= until) break;
    until = oldest - 1;
  }

  if (channels.size > 0) emitWireScopes([...channels].map((id) => `c2:${id}`));
  return removed;
}

// ── Pending raw-wrap holding store ──────────────────────────────────────────
//
// The native background service (Android/iOS) receives Concord wraps but can't
// decrypt them — it has no stream keys. It parks the raw kind-1059/21059 wraps
// here (a SEPARATE tiny tenant) instead of the shared event cache; the
// WebView's plane hooks — which DO hold the keys — read them with
// {@link peekPendingWraps}, decrypt, and acknowledge ONLY the wraps that
// actually decoded with {@link ackPendingWraps}. A wrap is never deleted
// before its rumor is safely in the opened-event store: an aborted or failed
// decrypt round leaves it parked for the next read (a notified message must
// never be locally destructible — issue #19). Undecodable stragglers (e.g. a
// key never arrives) are pruned by age. So no 1059 ever lands in the `main`
// tenant, yet a notification's message survives a cold launch. Wraps
// are indexed only by their author (the stream address) so a plane can read
// exactly its own.
//
// Lives in its own ArmadaDB tenant, which — like every tenant — stores RUMORS:
// no adapter carries a `sig` (`db/types.ts`), so a parked wrap comes back
// unsigned however it was handed over. For an ordinary stream that costs
// nothing: its wrap is signed with a key every reader holds, `openWrap` never
// checks it, and everything authenticating the message is the seal inside.
//
// A WRITE-RESTRICTED stream (CORD-01) inverts that — the wrap signature IS the
// write gate, proving a narrower signer set published it, and `openWrap`
// refuses the wrap without it. Such a wrap parked and drained would therefore
// be unopenable FOREVER: it re-fails every peek until the age-prune deletes
// it, silently, with no relay refetch behind the chat plane to cover the loss.
// So the signature is kept beside the wrap in the KV, keyed by wrap id — the
// signature itself, not bookkeeping smuggled into the row's tags (which are
// the bytes its id commits to). Same shape, and the same reason, as the stored
// seal above and the control snapshot at the top of this file.

const PENDING_TENANT = ARMADA_TENANTS.c2Park;

/** Parked wraps older than this are pruned (key never arrived / dead plane). */
const PENDING_MAX_AGE_SECS = 14 * 24 * 3600;

function pendingStore(): NRumorStore {
  // Queried by `authors` (the wrap's stream pubkey) only, so no tag index
  // matters here.
  return getArmadaDB().tenant(PENDING_TENANT);
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

/** KV key holding a parked wrap's signature (the store itself holds no `sig`). */
const parkSigKey = (wrapId: string) => `c2parksig:${wrapId}`;

/** Park raw Concord wraps for later WebView-side decryption (native ingest path). */
export function parkPendingWraps(wraps: NostrEvent[]): void {
  if (wraps.length === 0) return;
  pendingKnownEmpty = false;
  const s = pendingStore();
  const kv = getArmadaDB().kv;
  void Promise.all(
    wraps.flatMap(({ sig, ...wrap }) => [
      s.event(wrap),
      // Best-effort and independent of the row: a lost signature costs only
      // the write-restricted case, and losing the ROW would lose the message.
      ...(typeof sig === "string" && sig.length > 0
        ? [kv.set(parkSigKey(wrap.id), sig).catch(() => undefined)]
        : []),
    ]),
  ).catch(() => undefined);
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
export async function peekPendingWraps(streamPks: string[]): Promise<NostrRumor[]> {
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
      // Read the doomed ids before removing them: their KV signatures are keyed
      // by wrap id, so this is the only moment they can still be named. A
      // leaked key is inert but unbounded, and nothing else ever collects it.
      void (async () => {
        const doomed = await s.query([{ kinds: [1059, 21059], until: cutoff }]);
        await s.remove([{ kinds: [1059, 21059], until: cutoff }]);
        await forgetParkedSigs(doomed.map((w) => w.id));
      })().catch(() => undefined);
    }
    const parked = await s.query([{ kinds: [1059, 21059], authors: streamPks, limit: 1000 }]);
    return await Promise.all(parked.map(withParkedSig));
  } catch {
    return [];
  }
}

/**
 * Re-attach the signature parked beside a wrap, when one was kept.
 *
 * Unsigned is not an error: only a write-restricted stream's `openWrap` needs
 * the signature, every other wrap opens exactly as before, and a wrap parked
 * by a build that predates this keeps working as the unsigned rumor it is.
 */
async function withParkedSig(wrap: NostrRumor): Promise<NostrRumor> {
  try {
    const sig = await getArmadaDB().kv.get<string>(parkSigKey(wrap.id));
    return sig ? { ...wrap, sig } as NostrRumor : wrap;
  } catch {
    return wrap;
  }
}

/** Drop the KV signatures of wraps that are leaving the park. */
async function forgetParkedSigs(wrapIds: string[]): Promise<void> {
  if (wrapIds.length === 0) return;
  const kv = getArmadaDB().kv;
  await Promise.all(wrapIds.map((id) => kv.delete(parkSigKey(id)).catch(() => undefined)));
}

/** Remove parked wraps whose rumors are now safely in the opened-event store. */
export function ackPendingWraps(wrapIds: string[]): void {
  if (wrapIds.length === 0) return;
  const s = pendingStore();
  void s.remove([{ ids: wrapIds }]).catch(() => undefined);
  void forgetParkedSigs(wrapIds);
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
 * Serializes the read-modify-writes below, per scope.
 *
 * The merge is monotonic per call, but the read and the write are two awaits:
 * two overlapping callers both read the old cursor and the second write wins,
 * losing the first's patch (a deeper `oldest`, a sticky `exhausted`). Two
 * callers now genuinely do overlap — the sync scheduler's `c2:` round and a
 * `loadOlder` scroll-up write the same channel's cursor from different call
 * stacks, where before they shared one hook's in-memory mirror and could not.
 * A lost update is self-healing (the next round re-pages the region) but it
 * costs a whole redundant round, so mutations of one scope run one at a time.
 *
 * The chain is dropped once it drains, so this holds only in-flight scopes.
 */
const cursorWrites = new Map<string, Promise<void>>();

function withCursorLock(scope: string, fn: () => Promise<void>): Promise<void> {
  const prev = cursorWrites.get(scope) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // The queued tail must never reject: a failed write releases the lock for
  // the next caller rather than poisoning the chain. The caller still sees
  // the rejection through `run`.
  const tail: Promise<void> = run.catch(() => undefined).then(() => {
    if (cursorWrites.get(scope) === tail) cursorWrites.delete(scope);
  });
  cursorWrites.set(scope, tail);
  return run;
}

/**
 * Merge new sync progress into a scope's cursor (best-effort). `newest` only
 * advances forward, `oldest` only recedes, `exhausted` is sticky until cleared.
 */
export function updateStreamCursor(scope: string, patch: Partial<StreamCursor>): Promise<void> {
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

// Back-compat aliases (chat call sites).
export const readChannelCursor = readStreamCursor;
export const updateChannelCursor = updateStreamCursor;
export const clearChannelExhausted = clearStreamExhausted;
