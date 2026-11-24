/**
 * Sealing a Locked Channel's history (CORD-03 §1, Vector `service/sealing.rs`): read what
 * its read address holds by date since the last seal, skipping every quiet span, judge each
 * wrap as on arrival, and publish the ids that stand as pages whose oldest names the last
 * seal's first. The ledger edition naming the newest goes out last, through `publish`.
 */
import type { NostrEvent, NPool } from "@nostrify/nostrify";

import { queryRelayStrict } from "@/concord/hooks/useChannelAccess";
import { reactionIgnored, writerJudge } from "@/concord/lib/channelJudges";
import type { FoldedControl } from "@/concord/lib/control";
import type { GuestbookHistory } from "@/concord/lib/guestbook";
import { KIND_REACTION, KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord/lib/kinds";
import { whenAuthSettled } from "@/concord/lib/planeSync";
import { publishDurable } from "@/concord/lib/quorum";
import { paginate, sealPageWrap } from "@/concord/lib/seal";
import { checkChannelBinding, openWrap } from "@/concord/lib/stream";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import type { Channel, Community } from "@/concord/lib/types";
import { readRange, sealRun, sealTarget, type SealRef } from "@/concord/lib/writers";
import type { GroupKey } from "@/concord/lib/derive";

/** How many wraps one read of a read address asks for while sealing. */
const SEAL_READ_PAGE = 200;
/** What one second is read with when a page of it shares that second. */
const SEAL_WALL_LIMIT = 5_000;

type ReadPlane = { epoch: bigint; group: GroupKey };

/** The read planes of `channel` this device holds the key to: a page rides its plane, so a view won't do. */
function keyedReadPlanes(channel: Channel): ReadPlane[] {
  const out: ReadPlane[] = [];
  for (const s of channel.streams) {
    const sk = s.group.sk;
    if (s.writer || !sk || out.some((p) => p.group.pk === s.group.pk)) continue;
    out.push({ epoch: s.epoch, group: { sk, pk: s.group.pk, get convKey() { return s.group.convKey; } } });
  }
  return out;
}

/**
 * Whether this device holds the key to every plane the Channel's history was written on
 * (Vector `reads_whole_history`): a seal it made would otherwise leave out what it couldn't
 * open, for every reader.
 */
export function readsWholeHistory(community: Community, channel: Channel, planes: readonly ReadPlane[] = keyedReadPlanes(channel)): boolean {
  const has = (e: bigint) => planes.some((p) => p.epoch === e);
  const all = (from: bigint, to: bigint) => {
    for (let e = from; e <= to; e++) if (!has(e)) return false;
    return true;
  };
  if (!channel.isPrivate) return all(0n, community.rootEpoch);
  return all(1n, channel.current.epoch) && (channel.publicUntil === undefined || all(0n, community.rootEpoch));
}

/**
 * Each wrap `plane` holds dated from `floorMs` to `topMs`, from every relay to the end, or
 * an error: a seal can't leave out what a slow relay held (Vector `read_whole_range`).
 */
async function readWholeRange(nostr: NPool, relays: readonly string[], plane: ReadPlane, floorMs: number, topMs: number, signal: AbortSignal, each: (wrap: NostrEvent) => void): Promise<void> {
  registerStreamKeys([plane.group], [...relays]);
  const seen = new Set<string>();
  const since = Math.floor(floorMs / 1000);
  const take = (evs: NostrEvent[]) => {
    let fresh = false;
    for (const e of evs) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      fresh = true;
      each(e);
    }
    return fresh;
  };
  for (const url of relays) {
    await whenAuthSettled(url, () => [plane.group]);
    let cursor = Math.floor(topMs / 1000);
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const filter = { kinds: [KIND_WRAP], authors: [plane.group.pk], since, until: cursor, limit: SEAL_READ_PAGE };
      const evs = await queryRelayStrict(nostr, url, filter, signal);
      const full = evs.length >= SEAL_READ_PAGE;
      const oldest = evs.length > 0 ? Math.min(...evs.map((e) => e.created_at)) : undefined;
      const fresh = take(evs);
      if (oldest === undefined) break;
      // Inclusive, so the next read starts at the page's oldest second. A page all in one second,
      // or one that brought nothing new from it, is that second read on its own, then stepped past.
      let next: number;
      if (oldest === cursor && (full || !fresh)) {
        take(await queryRelayStrict(nostr, url, { ...filter, since: oldest, limit: SEAL_WALL_LIMIT }, signal));
        next = oldest - 1;
      } else if (fresh) {
        next = oldest;
      } else break;
      if (next < since || oldest === 0) break;
      cursor = next;
    }
  }
}

/**
 * Seal `channel` as far as its live run of Locked windows is owed at `nowMs`. Returns how
 * many ids it added, undefined when nothing is owed or this device can't read all of it.
 * `publish` re-reads the ledger and sends the edition naming `seal`, false when it moved.
 */
export async function sealHistory(o: {
  nostr: NPool;
  community: Community;
  folded: FoldedControl;
  channel: Channel;
  /** The Guestbook, read whole: who may post decides what stands. */
  history: GuestbookHistory;
  nowMs: number;
  signal: AbortSignal;
  publish: (seal: SealRef, until: number) => Promise<boolean>;
}): Promise<number | undefined> {
  const { community, folded, channel } = o;
  const ledger = folded.writers?.get(channel.idHex);
  const until = sealTarget(ledger, o.nowMs);
  const run = sealRun(ledger);
  if (!ledger || until === undefined || run === undefined) return undefined;
  const planes = keyedReadPlanes(channel);
  // Another manager holding every key seals it instead.
  if (!readsWholeHistory(community, channel, planes)) return undefined;
  const judge = writerJudge(folded, channel.idHex, community.id, o.history);
  const ignored = reactionIgnored(folded, channel.idHex);

  const ids: Array<{ id: string; at: number; plane: number }> = [];
  // Each stretch the read address took things in, newest first, down to the last seal.
  let top = until - 1;
  for (let range = readRange(ledger, top); range; range = readRange(ledger, top)) {
    const [floor, rangeTop] = range;
    for (const [i, plane] of planes.entries()) {
      await readWholeRange(o.nostr, community.relays, plane, floor, rangeTop, o.signal, (wrap) => {
        try {
          const opened = openWrap(wrap, plane.group);
          if (opened.sealKind !== KIND_SEAL_ENCRYPTED || opened.tags.some((t) => t[0] === "wepoch")) return;
          checkChannelBinding(opened, channel.idHex, plane.epoch);
          if (opened.ms < floor || opened.ms > rangeTop) return;
          // A reaction its author couldn't make no reader counts, so none is kept.
          if (opened.kind === KIND_REACTION && ignored?.(opened.author)) return;
          if (judge && !judge.stands(opened)) return;
          ids.push({ id: wrap.id, at: opened.ms, plane: i });
        } catch {
          // not this plane's, or not a chat event
        }
      });
    }
    if (floor === 0) break;
    top = floor - 1;
  }

  const pages = paginate(ids);
  const added = pages.reduce((n, p) => n + p.page.ids.length, 0);
  const prev = ledger.seal;
  // Dated inside what the seal covers, so no read by date ever meets them.
  const dated = until - 1;
  // Built oldest first, so each names the one after it; the oldest names the last seal's first.
  let next = prev?.page ? { id: prev.page, read: prev.read } : undefined;
  const wraps: NostrEvent[] = [];
  for (const { page, plane } of [...pages].reverse()) {
    const { epoch, group } = planes[plane];
    if (next) page.next = next;
    const wrap = await sealPageWrap(page, channel.idHex, epoch, group, dated);
    next = { id: wrap.id, read: Number(epoch) };
    wraps.push(wrap);
  }
  for (const wrap of wraps) {
    if (o.signal.aborted) throw new Error("aborted");
    await publishDurable(o.nostr, community.relays, wrap, undefined, `#${channel.idHex.slice(0, 8)} seal page`);
  }
  const seal: SealRef = { ...(next ? { page: next.id } : {}), read: next?.read ?? 0, until, run, count: (prev?.count ?? 0) + added, extra: {} };
  if (!(await o.publish(seal, until))) throw new Error("this channel's writer ledger moved; nothing sealed");
  return added;
}
