/**
 * Reading a Locked Channel's sealed history as a reader scrolls back (CORD-03 §1, Vector
 * `SealWalk`): its pages fetched by event id only as far as they reach, and the wrap ids
 * they list fetched by id. Below the seal nothing at the read address is read by date.
 */
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { openSealPage, type SealPage } from "@/concord/lib/seal";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import type { Channel } from "@/concord/lib/types";
import type { SealRef } from "@/concord/lib/writers";

interface RelayClient {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Most ids one fetch names: well inside what relays take in an `ids` filter. */
const IDS_PER_FETCH = 200;
/** Pages a session keeps opened; past it they are read again. */
const PAGE_CACHE_MAX = 4096;
/** Sealed wrap ids a session remembers per Channel. */
const SEALED_IDS_MAX = 20_000;

/** Opened pages by event id, with the address of the plane each rides. */
const pages = new Map<string, { page: SealPage; plane: string }>();
/** Per Channel, the wrap ids a seal names that this session handed out: only these stand below it. */
const sealed = new Map<string, Set<string>>();
/**
 * Pages a walk left part-read, by Channel and page id, with the second it handed the reader on
 * from: page ids carry no dates, so a read resuming from that cursor goes on from here.
 */
const parked = new Map<string, { at: number; given: number }>();

/** Whether a seal of `channelIdHex` names `wrapId`, as this session has walked it. */
export function isSealedWrap(channelIdHex: string, wrapId: string | undefined): boolean {
  return wrapId !== undefined && (sealed.get(channelIdHex)?.has(wrapId) ?? false);
}

function noteSealed(channelIdHex: string, ids: readonly string[]): void {
  let set = sealed.get(channelIdHex);
  if (!set) sealed.set(channelIdHex, (set = new Set()));
  for (const id of ids) set.add(id);
  if (set.size > SEALED_IDS_MAX) sealed.set(channelIdHex, new Set([...set].slice(-SEALED_IDS_MAX / 2)));
}

/** Forget opened pages and sealed ids, on logout. */
export function clearSealWalkMemory(): void {
  pages.clear();
  sealed.clear();
  parked.clear();
}

/** One query across `relays`, the union by id; undefined when no relay answered. */
async function queryAll(nostr: RelayClient, relays: readonly string[], filter: NostrFilter, signal: AbortSignal): Promise<NostrEvent[] | undefined> {
  const reads = await Promise.all(relays.map((url) => nostr.relay(url).query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }).catch(() => undefined)));
  if (reads.every((r) => r === undefined)) return undefined;
  const byId = new Map<string, NostrEvent>();
  for (const e of reads.flat()) if (e) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * The page `link` names, from this session's cache or the relays; undefined when none
 * serves it or this device holds no read plane of the epoch it opens under. A Channel
 * made private has root planes and its own that can share an epoch number, so each is tried.
 */
async function loadPage(nostr: RelayClient, relays: readonly string[], channel: Channel, link: { id: string; read: number }, signal: AbortSignal): Promise<{ page: SealPage; plane: string } | undefined> {
  const hit = pages.get(link.id);
  if (hit) return hit;
  const planes = channel.streams.filter((s) => !s.writer && s.epoch === BigInt(link.read));
  // A gating relay serves a plane only to a connection authenticated as its key.
  registerStreamKeys(planes.map((s) => s.group), [...relays]);
  const fetched = await queryAll(nostr, relays, { ids: [link.id] }, signal);
  if (!fetched) throw new Error("no relay answered a seal page read");
  for (const plane of planes) {
    for (const wrap of fetched) {
      const page = openSealPage(wrap, link.id, channel.idHex, BigInt(link.read), plane.group);
      if (!page) continue;
      if (pages.size >= PAGE_CACHE_MAX) pages.clear();
      const out = { page, plane: plane.group.pk };
      pages.set(link.id, out);
      return out;
    }
  }
  return undefined;
}

/** What one step handed out: wraps by id, and the oldest date its pages reach, where a read goes on from. */
export interface SealStep {
  wraps: NostrEvent[];
  bottomMs?: number;
}

/** A reader's place in a seal, newest first. */
export class SealWalk {
  private next: { id: string; read: number } | undefined;
  private page: { page: SealPage; plane: string } | undefined;
  private pageId: string | undefined;
  private given = 0;
  /** A page it was owed that no relay served or that wouldn't open: what lies past it is unread, not absent. */
  broken = false;

  constructor(seal: SealRef, private readonly untilMs: number) {
    this.next = seal.page ? { id: seal.page, read: seal.read } : undefined;
  }

  done(): boolean {
    return this.next === undefined && (this.page === undefined || this.given >= this.page.page.ids.length);
  }

  /** The next `n` sealed wraps, newest first, opening pages only as far as they reach. */
  async step(nostr: RelayClient, relays: readonly string[], channel: Channel, n: number, signal: AbortSignal): Promise<SealStep> {
    const ids: string[] = [];
    let bottomMs: number | undefined;
    while (ids.length < n) {
      if (this.page && this.given < this.page.page.ids.length) {
        const take = Math.min(n - ids.length, this.page.page.ids.length - this.given);
        ids.push(...this.page.page.ids.slice(this.given, this.given + take));
        this.given += take;
        bottomMs = this.page.page.oldest;
        continue;
      }
      if (!this.next) break;
      const link = this.next;
      const loaded = await loadPage(nostr, relays, channel, link, signal);
      if (!loaded) {
        this.next = undefined;
        this.broken = true;
        break;
      }
      this.next = loaded.page.next;
      const left = parked.get(`${channel.idHex}:${link.id}`);
      // A page wholly newer than where the walk starts holds nothing it needs.
      if (loaded.page.oldest > this.untilMs) this.given = loaded.page.ids.length;
      else this.given = left && Math.floor(this.untilMs / 1000) <= left.at + 1 ? left.given : 0;
      this.page = loaded;
      this.pageId = link.id;
    }
    if (this.page && this.pageId && this.given > 0 && this.given < this.page.page.ids.length) {
      if (parked.size >= PAGE_CACHE_MAX) parked.clear();
      parked.set(`${channel.idHex}:${this.pageId}`, { at: Math.floor(this.page.page.oldest / 1000), given: this.given });
    }
    if (ids.length === 0) return { wraps: [], ...(bottomMs !== undefined ? { bottomMs } : {}) };
    noteSealed(channel.idHex, ids);
    const wraps: NostrEvent[] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_FETCH) {
      const got = await queryAll(nostr, relays, { ids: ids.slice(i, i + IDS_PER_FETCH) }, signal);
      if (!got) throw new Error("no relay answered a sealed history read");
      wraps.push(...got);
    }
    return { wraps, ...(bottomMs !== undefined ? { bottomMs } : {}) };
  }
}
