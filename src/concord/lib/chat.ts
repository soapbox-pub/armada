/**
 * Concord Chat Plane — CORD-03. Messages, reactions, edits, and deletes are rumors
 * in encrypted seals at the Channel's stream address (one per held epoch). Each
 * rumor MUST commit `["channel", id]` + `["epoch", n]`, checked strict-equal
 * against the coordinate whose key decrypted it (CORD-03 §3). Decoding is
 * memoized per wrap id and time-sliced / partly off-thread.
 */

import { perfCount } from "@/lib/perf";
import { inlineReplyQuoteId } from "@/lib/quoteReply";
import { verifyEventsOnce } from "@/lib/verifyCache";
import { ecVerifyBatch } from "@/lib/verifyPool";

import type { NostrEvent } from "@nostrify/nostrify";
import { getEventHash } from "nostr-tools/pure";
import type { NostrRumor } from "@/lib/nostrRumor";

import { KIND_CALENDAR_DATE, KIND_CALENDAR_RSVP, KIND_CALENDAR_TIME, KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_ONCHAIN_ZAP, KIND_POLL, KIND_POLL_VOTE, KIND_REACTION, KIND_SEAL_ENCRYPTED, KIND_TIMER_NOTICE, KIND_ZAP } from "@/concord/lib/kinds";
import { dmTimerSeconds, isExpired } from "@/lib/nip17/protocol";
import { reactionContentKey } from "@/hooks/useReactions";
import type { RsvpVote } from "@/lib/calendar";
import type { PollVote } from "@/lib/polls";
import { verifyOnchainZapRumor, verifyZapRumor, type ZapEntry } from "@/lib/zaps";
import { citationFromTags, type AuthorityCitation } from "@/concord/lib/edition";
import { floodVerdict } from "@/concord/lib/floodCluster";
import { checkChannelBinding, FUTURE_HOLD_MS, openWrapToSeal, type OpenedEvent, type OpenedWireEvent } from "@/concord/lib/stream";
import type { Channel } from "@/concord/lib/types";

/** An opened chat event with its verified channel/epoch coordinate. */
export interface OpenedChat extends OpenedEvent {
  channelIdHex: string;
  epoch: bigint;
}

// Lives in stream.ts (a leaf the service worker bundles); re-exported here.
export { FUTURE_HOLD_MS };

/**
 * `wrapId|channelIdHex` → opened (null = remembered failure). Session-scoped; keyed
 * per channel so one channel's "not my key" can't poison another's.
 */
const decodeMemo = new Map<string, OpenedChat | null>();
/** Memo keys that failed as "no held stream key" — retryable after a rekey catch-up. */
const skippedNoKey = new Set<string>();

/** Working-set ceiling (~2KB/entry, so lower than verifyCache's id-only 20k). */
const DECODE_MEMO_CAP = 5_000;

/** Record a decode verdict, evicting oldest-first at the cap. All writes route here. */
function rememberDecode(memoKey: string, value: OpenedChat | null): void {
  if (!decodeMemo.has(memoKey) && decodeMemo.size >= DECODE_MEMO_CAP) {
    const oldest = decodeMemo.keys().next();
    if (!oldest.done) {
      decodeMemo.delete(oldest.value);
      skippedNoKey.delete(oldest.value);
    }
  }
  decodeMemo.set(memoKey, value);
}

/** Forget remembered no-key failures (a caught-up rekey may now decode them). */
export function forgetChatSkips(): void {
  for (const id of skippedNoKey) decodeMemo.delete(id);
  skippedNoKey.clear();
}

/** Empty the decode memo (decrypted messages), i.e. what a reload does to it. Logout. */
export function clearChatDecodeMemo(): void {
  decodeMemo.clear();
  skippedNoKey.clear();
}

/**
 * Drop a removed message's decrypted copy. Kept as a remembered failure, so its
 * wrap is not opened again this session.
 */
export function forgetChatRumor(rumorId: string): void {
  for (const [key, opened] of decodeMemo) {
    if (opened?.rumorId === rumorId) {
      decodeMemo.set(key, null);
      skippedNoKey.delete(key);
    }
  }
}

function wrapIdIsHash(wrap: NostrRumor): boolean {
  try {
    return getEventHash(wrap) === wrap.id;
  } catch {
    return false;
  }
}

/** Test seam. */
export const _resetChatMemoForTests = clearChatDecodeMemo;

/** Test seam: current decode-memo entry count, for the unbounded-growth guard. */
export function _chatDecodeMemoSizeForTests(): number {
  return decodeMemo.size;
}

/**
 * A wrap decoded up to its seal (phase 1), with what {@link finishChat} needs once
 * the seal's signature is verified (possibly off-thread) in between.
 */
interface PendingChat {
  memoKey: string;
  epoch: bigint;
  retiredAt?: number;
  seal: NostrEvent;
  finish: () => OpenedWireEvent;
}

/**
 * Phase 1: memo lookup, else decrypt up to the seal WITHOUT verifying it. Returns
 * `{ done }` for memo hits, no-key skips and failures, or `{ pending }` for a seal
 * to verify. The seal-form check (CORD-02 §5) runs first, skipping a wasted verify.
 */
function openChatToSeal(
  wrap: NostrRumor,
  channel: Channel,
): { done: OpenedChat | null } | { pending: PendingChat } {
  const memoKey = `${wrap.id}|${channel.idHex}`;
  const cached = decodeMemo.get(memoKey);
  if (cached !== undefined) return { done: cached };
  // Never memoize under an id the event doesn't commit to: a failure cached for
  // a squatted id would hide the real wrap carrying it.
  if (!wrapIdIsHash(wrap)) return { done: null };

  const stream = channel.streams.find((s) => s.group.pk === wrap.pubkey);
  if (!stream) {
    rememberDecode(memoKey, null);
    skippedNoKey.add(memoKey);
    return { done: null };
  }
  try {
    const { seal, finish } = openWrapToSeal(wrap, stream.group);
    // Chat seals MUST be encrypted (CORD-02 §5), or the message is a standalone
    // signed artifact any relay could display.
    if (seal.kind !== KIND_SEAL_ENCRYPTED) throw new Error("chat seal must be encrypted");
    return { pending: { memoKey, epoch: stream.epoch, retiredAt: stream.retiredAt, seal, finish } };
  } catch {
    rememberDecode(memoKey, null);
    return { done: null };
  }
}

/** Phase 3: recover and bind the rumor of a verified seal (channel/epoch binding, retirement cutoff) and memoize. */
function finishChat(pending: PendingChat, channel: Channel, remember: boolean): OpenedChat | null {
  let opened: OpenedChat | null = null;
  try {
    const ev = pending.finish();
    checkChannelBinding(ev, channel.idHex, pending.epoch);
    // A retired epoch's rotation time is a hard cutoff: key possession alone must
    // not let an ejected member keep writing into it.
    if (pending.retiredAt !== undefined && ev.createdAt > pending.retiredAt) {
      throw new Error("sealed under a retired epoch after its rotation");
    }
    opened = { ...ev, channelIdHex: channel.idHex, epoch: pending.epoch };
  } catch {
    opened = null;
  }
  // A failure is always remembered: it is small, and retrying it is the expensive part.
  if (remember || opened === null) rememberDecode(pending.memoKey, opened);
  return opened;
}

/**
 * Drop stored events violating their epoch's retirement cutoff — rows stored
 * before the rotation was adopted locally. A stored row names only its epoch
 * NUMBER, and root and channel-key epochs share one number space (a once-private
 * channel's key epoch 0 beside root epoch 0), so a number a live stream also
 * carries has no cutoff here: the open path already applied the opening
 * stream's own.
 */
export function filterEpochCutoff(events: OpenedChat[], channel: Channel): OpenedChat[] {
  let cutoffs: Map<string, number> | undefined;
  for (const s of channel.streams) {
    if (s.retiredAt === undefined) continue;
    const epoch = s.epoch.toString();
    const prev = cutoffs?.get(epoch);
    (cutoffs ??= new Map()).set(epoch, prev === undefined ? s.retiredAt : Math.max(prev, s.retiredAt));
  }
  if (!cutoffs) return events;
  for (const s of channel.streams) if (s.retiredAt === undefined) cutoffs.delete(s.epoch.toString());
  if (cutoffs.size === 0) return events;
  const caps = cutoffs;
  return events.filter((ev) => {
    const cap = caps.get(ev.epoch.toString());
    return cap === undefined || ev.createdAt <= cap;
  });
}

/**
 * Max unbroken main-thread decode time (ms) before yielding. Time-based so slow
 * phones yield sooner; kept well under 16ms so Android WebView input can run.
 */
const DECODE_SLICE_MS = 5;

/**
 * Open a batch of sealed wraps for one channel, memoized and time-sliced:
 *
 *   1. decrypt each wrap to its seal (sync NIP-44). Time-sliced.
 *   2. verify all pending seal signatures in ONE batch, off-thread when large
 *      (`verifyPool`); hash-bind + memo stay main-thread (`verifyCache`).
 *   3. recover + bind the verified rumors. Time-sliced.
 *
 * `cryptoMs` counts only the synchronous decrypt work (phases 1 + 3), excluding
 * yields. Skips (foreign epochs, malformed, bad signature) are silent.
 */
export async function openChatBatch(
  wraps: NostrRumor[],
  channel: Channel,
  /**
   * `remember: false` keeps successes out of the decode memo: a history walk's
   * wraps are never asked for again, and would evict the working set.
   */
  opts?: { signal?: AbortSignal; remember?: boolean },
): Promise<OpenedChat[]> {
  const remember = opts?.remember ?? true;
  let cryptoMs = 0;
  let sliceStart = performance.now();

  // One decode per wrap id: every relay serves largely the same page, and the memo
  // only learns a wrap once it finishes.
  if (wraps.length > 1) {
    const at = new Map<string, number>();
    const unique: NostrRumor[] = [];
    for (const w of wraps) {
      const i = at.get(w.id);
      if (i === undefined) {
        at.set(w.id, unique.length);
        unique.push(w);
      } else if (!wrapIdIsHash(unique[i]) && wrapIdIsHash(w)) {
        // Hashed only on a collision: the copy that commits to the id wins.
        unique[i] = w;
      }
    }
    wraps = unique;
  }

  // Phase 1. `resolved` keeps input order across the async verify.
  const resolved: Array<OpenedChat | null> = new Array(wraps.length).fill(null);
  const pending: Array<{ slot: number; chat: PendingChat }> = [];
  for (let i = 0; i < wraps.length; i++) {
    if (opts?.signal?.aborted) break;
    const openStart = performance.now();
    const step = openChatToSeal(wraps[i], channel);
    cryptoMs += performance.now() - openStart;
    if ("done" in step) resolved[i] = step.done;
    else pending.push({ slot: i, chat: step.pending });
    if (i + 1 < wraps.length && performance.now() - sliceStart >= DECODE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }

  // Skip the verify if aborted during phase 1.
  if (pending.length > 0 && !opts?.signal?.aborted) {
    // Phase 2: batch-verify every pending seal (off-thread when it pays).
    const oks = await verifyEventsOnce(pending.map((p) => p.chat.seal), ecVerifyBatch);

    // Phase 3: finish verified seals; memoize the rest as failures. Sound only
    // because `ecVerifyBatch` reports "unverified" solely for a bad signature
    // (worker failures are re-verified inline; see verifyPool.ts).
    sliceStart = performance.now();
    for (let j = 0; j < pending.length; j++) {
      if (opts?.signal?.aborted) break;
      const { slot, chat } = pending[j];
      const finishStart = performance.now();
      if (oks[j]) {
        resolved[slot] = finishChat(chat, channel, remember);
      } else {
        rememberDecode(chat.memoKey, null);
      }
      cryptoMs += performance.now() - finishStart;
      if (j + 1 < pending.length && performance.now() - sliceStart >= DECODE_SLICE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
  }

  perfCount("crypto.openChatBatch", cryptoMs, wraps.length, "wraps");
  const out: OpenedChat[] = [];
  for (const r of resolved) if (r) out.push(r);
  return out;
}

/**
 * NIP-22 tags for a kind-1111 threaded reply to `parent`: uppercase `K`/`E`/`P`
 * pin the thread root (inherited when the parent is itself a comment), lowercase
 * point at the immediate parent. All ids are RUMOR ids. Distinct from the kind-9
 * `q` tag (NIP-C7 inline quote-replies).
 *
 * https://github.com/nostr-protocol/nips/blob/master/22.md
 */
export function buildConcordCommentTags(parent: { id: string; kind: number; pubkey: string; tags: string[][] }): string[][] {
  const tags: string[][] = [];

  const rootTags = parent.tags.filter(([n]) => n === "K" || n === "E" || n === "P");
  if (rootTags.length > 0) {
    for (const t of rootTags) tags.push([...t]);
  } else {
    tags.push(["K", String(parent.kind)]);
    tags.push(["E", parent.id, "", parent.pubkey]);
    tags.push(["P", parent.pubkey]);
  }

  tags.push(["k", String(parent.kind)]);
  tags.push(["e", parent.id, "", parent.pubkey]);
  tags.push(["p", parent.pubkey]);

  return tags;
}

/**
 * The thread-root rumor id (NIP-22 kind-1111 uppercase `E`), or undefined. A
 * kind-9 `q` is an INLINE reply, not a thread root.
 */
export function replyTargetOf(ev: { kind: number; tags: string[][] }): string | undefined {
  return ev.kind === KIND_COMMENT ? ev.tags.find((t) => t[0] === "E")?.[1] : undefined;
}

/** Reactions / edits / deletes name their target rumor with an `e` tag. */
export function eTargetOf(ev: { tags: string[][] }): string | undefined {
  return ev.tags.find((t) => t[0] === "e")?.[1];
}

/**
 * The rumor a kind-9 message inline-replies to via its NIP-C7 `q` tag (not the
 * thread root; see `replyTargetOf`). Only kind-9 has a timeline-level parent.
 */
function inlineReplyParentOf(ev: { kind: number; content: string; tags: string[][] }): string | undefined {
  return ev.kind === KIND_MESSAGE ? inlineReplyQuoteId(ev) : undefined;
}

/**
 * Reorder an (ms,id)-sorted timeline so an inline reply never precedes its parent
 * (a sender clock running behind can stamp it earlier). Each reply takes a
 * position strictly after its in-set parent's effective one; resolved over chains,
 * memoized, cycle-safe (a forged `q` loop falls back to the row's own key). In
 * place; a single pass when nothing moves.
 */
function orderRepliesAfterParents(messages: OpenedChat[]): void {
  const byId = new Map<string, OpenedChat>();
  for (const m of messages) byId.set(m.rumorId, m);

  // [effMs, depth, rumorId]: `depth` keeps a child after its parent when their
  // effective ms tie.
  type Key = { ms: number; depth: number; id: string };
  const keys = new Map<string, Key>();

  const keyOf = (m: OpenedChat): Key => {
    const cached = keys.get(m.rumorId);
    if (cached) return cached;
    // Seed the row's own key before recursing, so a `q` cycle stops on re-entry.
    const own: Key = { ms: m.ms, depth: 0, id: m.rumorId };
    keys.set(m.rumorId, own);
    const parentId = inlineReplyParentOf(m);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parent) return own;
    const pk = keyOf(parent);
    // Strictly after the parent (one deeper on an ms tie).
    const key: Key = { ms: Math.max(m.ms, pk.ms), depth: pk.depth + 1, id: m.rumorId };
    keys.set(m.rumorId, key);
    return key;
  };

  for (const m of messages) keyOf(m);

  messages.sort((a, b) => {
    const ka = keys.get(a.rumorId)!;
    const kb = keys.get(b.rumorId)!;
    if (ka.ms !== kb.ms) return ka.ms - kb.ms;
    if (ka.depth !== kb.depth) return ka.depth - kb.depth;
    return ka.id < kb.id ? -1 : ka.id > kb.id ? 1 : 0;
  });
}

/** Moderation context the read path applies while folding. */
export interface ChatModeration {
  /**
   * Banned author pubkeys — every event from them is dropped (CORD-04 §4). The ONLY
   * author-identity drop; nothing filters on epoch (CORD-02 §5, CORD-04 §6).
   */
  banned: Set<string>;
  /**
   * Whether `deleter` may delete `author`'s message (MANAGE_MESSAGES). `citation` is
   * the delete's `vac` (CORD-04 §5); a non-owner moderation delete without a
   * resolvable one PARKS. Self-deletes carry none.
   */
  canDelete: (deleter: string, author: string, action?: { citation?: AuthorityCitation; ms: number }) => boolean;
  /**
   * Whether `author` holds MANAGE_METADATA, gating display of timer notices
   * (CORD-08 §4). Optional so bare lib folds keep notices.
   */
  canSetTimer?: (author: string) => boolean;
  /**
   * Whether `author` is staff; the flood heuristic never folds staff. Optional for
   * bare lib folds.
   */
  isStaff?: (author: string) => boolean;
  /** Whether an author holds MENTION_EVERYONE in a target channel. */
  canMentionEveryone?: (author: string, channelIdHex: string) => boolean;
}

/** A tallied reaction: reactors (pubkey→rumorId) plus the NIP-30 custom-emoji URL (if any). */
export interface ReactionEntry {
  reactors: Map<string, string>;
  url?: string;
  /** reactor → the emoji image THEIR reaction named, so a held reactor's can be skipped. */
  urls?: Map<string, string>;
}

export interface FoldedTimeline {
  /** Surviving messages, sorted by ms ascending. */
  messages: OpenedChat[];
  /**
   * Earliest `ms` of a message HELD for being > {@link FUTURE_HOLD_MS} ahead of the
   * fold's clock; the app schedules a re-fold then so it reappears on time.
   */
  nextRevealMs?: number;
  /**
   * Rumor ids in a visual flood (`floodCluster.ts`) — a DISPLAY hint, not applied to
   * {@link messages}. Rendered as one expandable row, so the heuristic never becomes
   * a second author drop.
   */
  quarantined: Set<string>;
  /**
   * Authors with earned trust in this batch (`floodVerdict`): the reader, speaking
   * staff, and whoever the reader's reply/quote/mention graph reaches. Read by the
   * media hold (`mediaTrust.ts`).
   */
  trusted: Set<string>;
  /**
   * The subset of {@link quarantined} collapsed by a community PAUSE (CORD-04 §8),
   * so the row doesn't wrongly call paused traffic spam.
   */
  paused: Set<string>;
  /** target rumor id → emoji → tally. */
  reactions: Map<string, Map<string, ReactionEntry>>;
  /** target rumor id → VERIFIED zaps (CORD.md §4; unverified never enter). */
  zaps: Map<string, ZapEntry[]>;
  /** poll rumor id → its raw votes (tallied per poll by the transport). */
  pollVotes: Map<string, PollVote[]>;
  /** Surviving calendar events (kinds 31922/31923); NOT timeline messages. */
  calendarEvents: OpenedChat[];
  /** event rumor id → its raw RSVPs (tallied per event by the transport). */
  rsvps: Map<string, RsvpVote[]>;
  /**
   * Authorized timer notices (kind 1740, CORD-08 §4), ms ascending; interleaved as
   * notice rows by the transport.
   */
  timerNotices: OpenedChat[];
  /** Messages an authorized delete removed in this fold, so their cached media can go. */
  removed: OpenedChat[];
}

/** Per-rumor CORD.md zap verdict cache (payment hash when valid, else null). Capped. */
const zapVerdicts = new Map<string, string | null>();
const ZAP_VERDICT_CAP = 8192;

/**
 * Reaction rumor ids deleted by a kind-5, session-scoped. The store's NIP-09 only
 * applies within one write batch, so a relay-echoed reaction can come back; this
 * keeps it removed. Capped.
 */
const deletedReactionIds = new Set<string>();
const DELETED_REACTION_CAP = 8192;

/** Mark a reaction deleted NOW (optimistic), before the kind-5 is even sealed. */
export function markReactionDeleted(rumorId: string): void {
  if (deletedReactionIds.size >= DELETED_REACTION_CAP) {
    deletedReactionIds.delete(deletedReactionIds.values().next().value as string);
  }
  deletedReactionIds.add(rumorId);
}

/**
 * Fold opened chat events into the channel timeline: drop banned authors, apply
 * edits (author-only, latest by ms), tally reactions per target.
 *
 * Deletes physically remove targets from the store at write time, so the delete
 * pass here only covers IN-BATCH deletes (folded alongside the target before the
 * store commits), with the same authorization (self, or `canDelete`).
 */
export function foldTimeline(
  opened: OpenedChat[],
  moderation?: ChatModeration,
  opts?: {
    /** The reader's pubkey, so the flood heuristic spares their own messages. Optional. */
    self?: string;
    /** The channel's author history (`queryChannelFirstSeen`); see `FloodOptions.firstSeen`. */
    firstSeen?: ReadonlyMap<string, number>;
    /** Staff predicate, so floods never fold a moderator (`FloodOptions.staff`). Optional. */
    staff?: (author: string) => boolean;
    /** Unforgeable lower bound (ms) on the room's age (`FloodOptions.establishedSinceMs`). Optional. */
    establishedSinceMs?: number;
    /**
     * Active pause enactment time in SECONDS (CORD-04 §8): non-staff messages at or
     * after it fold into the flood row (never dropped).
     */
    pauseSince?: number;
    /**
     * Reader-side collapses the vsk-13 Roster asks for (CORD-04 §8): a post inside
     * its author's running Timeout, or one whose author can't send in an open
     * Channel. Folded into the flood row, never dropped.
     */
    collapse?: (message: OpenedChat) => boolean;
  },
): FoldedTimeline {
  const byId = new Map<string, OpenedChat>();
  // target → (deleter → citation + the delete's ms): both are needed for the
  // authority check (flag-day and tombstone timing).
  const deletes = new Map<string, Map<string, { citation?: AuthorityCitation; ms: number }>>();
  // ALL edits per target; authorship is judged at apply time so a non-author's
  // later "edit" can't suppress the author's.
  const edits = new Map<string, Array<{ author: string; content: string; ms: number }>>();
  const reactions = new Map<string, Map<string, ReactionEntry>>();
  // Raw votes per poll id, tallied downstream; orphans resolve once the poll decodes.
  const pollVotes = new Map<string, PollVote[]>();
  const calendarById = new Map<string, OpenedChat>();
  const rsvps = new Map<string, RsvpVote[]>();
  // Deduped by payment hash / txid after the loop, since any member could replay a
  // visible proof (CORD.md §4).
  const zapCandidates: Array<{ target: string; hash: string; ms: number; entry: ZapEntry }> = [];
  const timerNotices: OpenedChat[] = [];
  // One clock per fold: a rumor expiring mid-loop must not split the batch.
  const nowSecs = Math.floor(Date.now() / 1000);

  for (const ev of opened) {
    if (moderation?.banned.has(ev.author)) continue;
    // Expired rumors (CORD-08 §3) may still reach here from pre-deadline rows or
    // fresh decrypts.
    if (isExpired(ev.tags, nowSecs)) continue;

    if (ev.kind === KIND_TIMER_NOTICE) {
      // Malformed timer is not "off"; only MANAGE_METADATA holders are believed (CORD-08 §4).
      if (dmTimerSeconds(ev) === undefined) continue;
      if (moderation?.canSetTimer && !moderation.canSetTimer(ev.author)) continue;
      timerNotices.push(ev);
      continue;
    }
    if (ev.kind === KIND_DELETE) {
      for (const t of ev.tags) {
        if (t[0] !== "e" || !t[1]) continue;
        const target = t[1];
        let authors = deletes.get(target);
        if (!authors) deletes.set(target, (authors = new Map()));
        // Prefer a cited delete over an uncited duplicate from the same actor.
        const cite = citationFromTags(ev.tags);
        if (cite || !authors.has(ev.author)) authors.set(ev.author, { citation: cite, ms: ev.ms });
        // Remember deleted reaction ids across folds (see deletedReactionIds).
        const kTag = ev.tags.find(([n]) => n === "k")?.[1];
        if (kTag === String(KIND_REACTION)) {
          if (deletedReactionIds.size >= DELETED_REACTION_CAP) {
            deletedReactionIds.delete(deletedReactionIds.values().next().value as string);
          }
          deletedReactionIds.add(target);
        }
      }
      continue;
    }
    if (ev.kind === KIND_EDIT) {
      const target = eTargetOf(ev);
      if (!target) continue;
      let list = edits.get(target);
      if (!list) edits.set(target, (list = []));
      list.push({ author: ev.author, content: ev.content, ms: ev.ms });
      continue;
    }
    if (ev.kind === KIND_REACTION) {
      const target = eTargetOf(ev);
      if (!target || !ev.content) continue;
      if (deletedReactionIds.has(ev.rumorId)) continue;
      const key = reactionContentKey(ev.content);
      const url = ev.tags.find((t) => t[0] === "emoji")?.[2];
      let byEmoji = reactions.get(target);
      if (!byEmoji) reactions.set(target, (byEmoji = new Map()));
      let entry = byEmoji.get(key);
      if (!entry) byEmoji.set(key, (entry = { reactors: new Map() }));
      entry.reactors.set(ev.author, ev.rumorId);
      if (url) {
        if (!entry.url) entry.url = url;
        (entry.urls ??= new Map()).set(ev.author, url);
      }
      continue;
    }
    if (ev.kind === KIND_ZAP) {
      const target = eTargetOf(ev);
      if (!target) continue;
      let verdict = zapVerdicts.get(ev.rumorId);
      if (verdict === undefined) {
        if (zapVerdicts.size >= ZAP_VERDICT_CAP) {
          zapVerdicts.delete(zapVerdicts.keys().next().value as string);
        }
        verdict = verifyZapRumor({ kind: ev.kind, tags: ev.tags });
        zapVerdicts.set(ev.rumorId, verdict);
      }
      if (!verdict) continue;
      const msats = Number(ev.tags.find((t) => t[0] === "amount")?.[1]);
      zapCandidates.push({
        target,
        hash: verdict,
        ms: ev.ms,
        entry: {
          id: ev.rumorId,
          pubkey: ev.author,
          sats: Math.floor(msats / 1000),
          comment: ev.content,
          rail: "lightning",
        },
      });
      continue;
    }
    if (ev.kind === KIND_ONCHAIN_ZAP) {
      const target = eTargetOf(ev);
      if (!target) continue;
      // On-chain: the txid is the proof; dedup so one tx counts once.
      const txid = verifyOnchainZapRumor({ kind: ev.kind, tags: ev.tags });
      if (!txid) continue;
      const sats = Number(ev.tags.find((t) => t[0] === "amount")?.[1]);
      zapCandidates.push({
        target,
        hash: txid,
        ms: ev.ms,
        entry: {
          id: ev.rumorId,
          pubkey: ev.author,
          sats,
          comment: ev.content,
          rail: "onchain",
        },
      });
      continue;
    }
    if (ev.kind === KIND_POLL_VOTE) {
      // Bucket under its poll; latest per pubkey resolved downstream.
      const target = eTargetOf(ev);
      if (!target) continue;
      const optionIds = ev.tags.filter(([n, v]) => n === "response" && v).map(([, v]) => v);
      if (optionIds.length === 0) continue;
      let list = pollVotes.get(target);
      if (!list) pollVotes.set(target, (list = []));
      list.push({ pubkey: ev.author, optionIds, ms: ev.ms });
      continue;
    }
    if (ev.kind === KIND_CALENDAR_RSVP) {
      // RSVPs `e`-reference the event's rumor id (no `a`-coordinate in Concord).
      const target = eTargetOf(ev);
      if (!target) continue;
      const status = ev.tags.find((t) => t[0] === "status")?.[1];
      if (status !== "accepted" && status !== "declined" && status !== "tentative") continue;
      let list = rsvps.get(target);
      if (!list) rsvps.set(target, (list = []));
      list.push({ pubkey: ev.author, status, ms: ev.ms });
      continue;
    }
    if (ev.kind === KIND_CALENDAR_DATE || ev.kind === KIND_CALENDAR_TIME) {
      // Calendar events surface in the events bar, not the timeline; parsing and
      // addressable dedup happen in the transport.
      calendarById.set(ev.rumorId, ev);
      continue;
    }
    if (ev.kind === KIND_MESSAGE || ev.kind === KIND_COMMENT || ev.kind === KIND_POLL) {
      // Kind 9, 1111 and 1068 share the pool; the reader splits by NIP-22 root.
      byId.set(ev.rumorId, ev);
    }
  }

  // Edits: only the original author may edit; their latest (by ms) wins.
  for (const [id, list] of edits) {
    const msg = byId.get(id);
    if (!msg) continue;
    let best: { content: string; ms: number } | undefined;
    for (const e of list) {
      if (e.author !== msg.author) continue;
      if (!best || e.ms > best.ms) best = e;
    }
    if (best) {
      const tags = msg.tags.filter(([name]) => name !== "edited");
      tags.push(["edited", String(Math.floor(best.ms / 1000))]);
      byId.set(id, { ...msg, content: best.content, tags });
    }
  }

  // In-batch deletes: self-delete, or an authorized moderator delete.
  const removed: OpenedChat[] = [];
  for (const [id, msg] of byId) {
    const deleters = deletes.get(id);
    if (!deleters) continue;
    const deleted =
      deleters.has(msg.author) ||
      (moderation && [...deleters].some(([d, act]) => moderation.canDelete(d, msg.author, act)));
    if (deleted) {
      byId.delete(id);
      removed.push(msg);
    }
  }

  // Calendar deletes: same authorization as messages.
  for (const [id, ev] of calendarById) {
    const deleters = deletes.get(id);
    if (!deleters) continue;
    const deleted =
      deleters.has(ev.author) ||
      (moderation && [...deleters].some(([d, act]) => moderation.canDelete(d, ev.author, act)));
    if (deleted) calendarById.delete(id);
  }

  // In-batch reaction deletes remove the reactor from the tally.
  for (const [targetId, byEmoji] of reactions) {
    for (const [emoji, entry] of byEmoji) {
      for (const [pubkey, rumorId] of entry.reactors) {
        const deleters = deletes.get(rumorId);
        if (deleters && deleters.has(pubkey)) {
          entry.reactors.delete(pubkey);
        }
      }
      if (entry.reactors.size === 0) byEmoji.delete(emoji);
    }
    if (byEmoji.size === 0) reactions.delete(targetId);
  }

  // One payment counts once; earliest (ms, then id) wins deterministically.
  const zaps = new Map<string, ZapEntry[]>();
  const claimedHashes = new Set<string>();
  zapCandidates.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.entry.id < b.entry.id ? -1 : 1));
  for (const { target, hash, entry } of zapCandidates) {
    if (claimedHashes.has(hash)) continue;
    claimedHashes.add(hash);
    let list = zaps.get(target);
    if (!list) zaps.set(target, (list = []));
    list.push(entry);
  }

  // Hold future-dated messages (FUTURE_HOLD_MS) using the same clock as the expiry
  // gate; `nextRevealMs` lets the app re-fold on time.
  const holdCeilingMs = nowSecs * 1000 + 999 + FUTURE_HOLD_MS;
  let nextRevealMs: number | undefined;
  const visible: OpenedChat[] = [];
  for (const ev of byId.values()) {
    if (ev.ms > holdCeilingMs) {
      if (nextRevealMs === undefined || ev.ms < nextRevealMs) nextRevealMs = ev.ms;
      continue;
    }
    visible.push(ev);
  }
  const messages = visible.sort((a, b) =>
    a.ms !== b.ms ? a.ms - b.ms : a.rumorId < b.rumorId ? -1 : 1,
  );

  const isStaff = opts?.staff ?? moderation?.isStaff;
  const { flagged: quarantined, trusted } = floodVerdict(messages, {
    ...(opts?.self !== undefined ? { self: opts.self } : {}),
    ...(opts?.firstSeen !== undefined ? { firstSeen: opts.firstSeen } : {}),
    ...(isStaff !== undefined ? { staff: isStaff } : {}),
    ...(opts?.establishedSinceMs !== undefined ? { establishedSinceMs: opts.establishedSinceMs } : {}),
  });
  // A community pause (CORD-04 §8) collapses non-staff messages at/after it into the
  // flood row — reader-side, never a drop, gated on (forgeable) created_at. The
  // reader's own messages are exempt, as with floods.
  const paused = new Set<string>();
  if (opts?.pauseSince !== undefined) {
    const floorMs = opts.pauseSince * 1000;
    for (const m of messages) {
      if (m.ms < floorMs) continue;
      if (m.author === opts.self) continue;
      if (isStaff?.(m.author) ?? false) continue;
      paused.add(m.rumorId);
      quarantined.add(m.rumorId);
    }
  }

  if (opts?.collapse) {
    for (const m of messages) if (m.author !== opts.self && opts.collapse(m)) quarantined.add(m.rumorId);
  }

  // Last, so the rules above see strict ms order: nudge inline replies after their parents.
  orderRepliesAfterParents(messages);

  return {
    messages,
    ...(nextRevealMs !== undefined ? { nextRevealMs } : {}),
    quarantined,
    trusted,
    paused,
    reactions,
    zaps,
    pollVotes,
    calendarEvents: [...calendarById.values()],
    rsvps,
    timerNotices: timerNotices.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.rumorId < b.rumorId ? -1 : 1)),
    removed,
  };
}
