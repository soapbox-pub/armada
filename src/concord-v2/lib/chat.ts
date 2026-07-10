/**
 * Concord V2 Chat Plane — CORD-03.
 *
 * A Channel's messages, reactions, edits, and deletes are ordinary rumors
 * inside encrypted seals at the Channel's stream address (one per held epoch,
 * so history spanning a rekey stays continuous). Each rumor MUST commit
 * `["channel", id]` + `["epoch", n]`, checked strict-equal against the
 * coordinate whose key decrypted the wrap (CORD-03 §3).
 *
 * Decoding (two NIP-44 opens + a Schnorr verify per wrap) is memoized per wrap
 * id and chunked off the main thread, so re-reading the append-only local
 * store costs near-nothing after the first pass.
 */

import type { NostrEvent } from "nostr-tools/pure";

import { KIND_COMMENT, KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_REACTION, KIND_ZAP } from "@/concord-v2/lib/kinds";
import { verifyZapRumor, type ZapEntry } from "@/lib/zaps";
import { checkChannelBinding, openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { ChannelV2 } from "@/concord-v2/lib/types";

/** An opened chat event with its verified channel/epoch coordinate. */
export interface OpenedChat extends OpenedEvent {
  channelIdHex: string;
  epoch: bigint;
}

// ── Decode-once cache ────────────────────────────────────────────────────────

/** `wrapId|channelIdHex` → opened (or null = remembered failure). Session-scoped.
 *  Keyed per channel so one channel's "not my key" can't poison another's decode. */
const decodeMemo = new Map<string, OpenedChat | null>();
/** Memo keys that failed as "no held stream key" — retryable after a rekey catch-up. */
const skippedNoKey = new Set<string>();

/** Forget remembered no-key failures (a caught-up rekey may now decode them). */
export function forgetChatSkips(): void {
  for (const id of skippedNoKey) decodeMemo.delete(id);
  skippedNoKey.clear();
}

function openOne(wrap: NostrEvent, channel: ChannelV2): OpenedChat | null {
  const memoKey = `${wrap.id}|${channel.idHex}`;
  const cached = decodeMemo.get(memoKey);
  if (cached !== undefined) return cached;

  const stream = channel.streams.find((s) => s.group.pk === wrap.pubkey);
  if (!stream) {
    decodeMemo.set(memoKey, null);
    skippedNoKey.add(memoKey);
    return null;
  }
  let opened: OpenedChat | null = null;
  try {
    const ev = openWrap(wrap, stream.group);
    checkChannelBinding(ev, channel.idHex, stream.epoch);
    opened = { ...ev, channelIdHex: channel.idHex, epoch: stream.epoch };
  } catch {
    opened = null;
  }
  decodeMemo.set(memoKey, opened);
  return opened;
}

/** How many wraps to decode per main-thread slice. */
const DECODE_CHUNK = 25;

/**
 * Open a batch of sealed wraps for one channel, memoized and chunked off the
 * main thread so a large first decode never freezes the UI. Skips (foreign
 * epochs, malformed, spliced) are silent, as in Vector's read path.
 */
export async function openChatBatch(
  wraps: NostrEvent[],
  channel: ChannelV2,
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const out: OpenedChat[] = [];
  for (let i = 0; i < wraps.length; i += DECODE_CHUNK) {
    if (opts?.signal?.aborted) break;
    for (const wrap of wraps.slice(i, i + DECODE_CHUNK)) {
      const opened = openOne(wrap, channel);
      if (opened) out.push(opened);
    }
    // Yield between chunks (only when more work remains).
    if (i + DECODE_CHUNK < wraps.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

/**
 * Build the NIP-22 tags for a kind-1111 threaded reply to `parent`. The
 * uppercase `K`/`E`/`P` tags pin the immutable *thread root*; the lowercase
 * `k`/`e`/`p` tags point at the *immediate parent*. When the parent is itself a
 * comment, its uppercase root tags are inherited so the root is stable at any
 * nesting depth (matching the NIP-29 side, `buildCommentTags`). All ids are
 * RUMOR ids (the NIP-01 hash of the inner unsigned event), so a reply cites
 * exactly the decrypted message the user replied to.
 *
 * This is deliberately distinct from a kind-9 `q` tag: NIP-C7 reserves `q` for
 * inline quote-replies, while threads are NIP-22 comments.
 *
 * https://github.com/nostr-protocol/nips/blob/master/22.md
 */
export function buildV2CommentTags(parent: { id: string; kind: number; pubkey: string; tags: string[][] }): string[][] {
  const tags: string[][] = [];

  const rootTags = parent.tags.filter(([n]) => n === "K" || n === "E" || n === "P");
  if (rootTags.length > 0) {
    // Parent is itself a comment: inherit its root pointer verbatim.
    for (const t of rootTags) tags.push([...t]);
  } else {
    // Parent is the root of this thread.
    tags.push(["K", String(parent.kind)]);
    tags.push(["E", parent.id, "", parent.pubkey]);
    tags.push(["P", parent.pubkey]);
  }

  // Immediate-parent pointer (always the event being replied to).
  tags.push(["k", String(parent.kind)]);
  tags.push(["e", parent.id, "", parent.pubkey]);
  tags.push(["p", parent.pubkey]);

  return tags;
}

/**
 * The thread-root rumor id a message belongs to, or undefined for a top-level
 * message. Threaded replies are NIP-22 kind-1111 comments carrying the root in
 * their uppercase `E` tag. A kind-9 `q` tag is an INLINE reply (timeline, not a
 * thread), so it is deliberately NOT treated as a thread root.
 */
export function replyTargetOf(ev: { kind: number; tags: string[][] }): string | undefined {
  return ev.kind === KIND_COMMENT ? ev.tags.find((t) => t[0] === "E")?.[1] : undefined;
}

/** Reactions / edits / deletes name their target rumor with an `e` tag. */
export function eTargetOf(ev: { tags: string[][] }): string | undefined {
  return ev.tags.find((t) => t[0] === "e")?.[1];
}

// ── Timeline fold ────────────────────────────────────────────────────────────

/** Moderation context the read path applies while folding. */
export interface ChatModeration {
  /** Banned author pubkeys — every event from them is dropped (CORD-04 §4). */
  banned: Set<string>;
  /** Whether `deleter` may delete a message by `author` (MANAGE_MESSAGES). */
  canDelete: (deleter: string, author: string) => boolean;
}

/** A tallied reaction: reactors plus the NIP-30 custom-emoji URL (if any). */
export interface ReactionEntry {
  reactors: Set<string>;
  url?: string;
}

export interface FoldedTimeline {
  /** Surviving messages, sorted by ms ascending. */
  messages: OpenedChat[];
  /** target rumor id → emoji → tally. */
  reactions: Map<string, Map<string, ReactionEntry>>;
  /** target rumor id → VERIFIED zaps (CORD.md §4; unverified never enter). */
  zaps: Map<string, ZapEntry[]>;
}

/**
 * Per-rumor CORD.md verdict cache (payment hash when valid, null when not).
 * A rumor's tags never change, so each zap is hashed/decoded once per session
 * no matter how many folds re-run over it. Capped to bound memory.
 */
const zapVerdicts = new Map<string, string | null>();
const ZAP_VERDICT_CAP = 8192;

/**
 * Fold a batch of opened chat events into the channel timeline: drop banned
 * authors, apply edits (author-only, latest by ms), and tally reactions per
 * target.
 *
 * Deletes are DELETES, not hides: a kind-5 rumor physically removes its target
 * from the rumor cache on write (self-delete via the store's NIP-09; a
 * moderator delete is authorized against the roster at the write site before it
 * reaches the store). So a folded set read back from the cache never contains a
 * deleted message. The delete pass here is only a belt-and-suspenders for
 * IN-BATCH deletes — an optimistic or just-arrived kind-5 folded alongside its
 * target before the store's async removal has committed — and applies the same
 * authorization (self, or a `canDelete` moderator) so the two paths agree.
 */
export function foldTimeline(opened: OpenedChat[], moderation?: ChatModeration): FoldedTimeline {
  const byId = new Map<string, OpenedChat>();
  const deletes = new Map<string, Set<string>>();
  // ALL edits per target (author validity is judged against the message in the
  // apply phase — otherwise a non-author's later "edit" would suppress the
  // author's legitimate one).
  const edits = new Map<string, Array<{ author: string; content: string; ms: number }>>();
  const reactions = new Map<string, Map<string, ReactionEntry>>();
  // Verified zap candidates, deduped by payment hash after the loop: an
  // announced preimage is visible to every member, so without this anyone
  // could replay someone else's proof and inflate tallies (CORD.md §4).
  const zapCandidates: Array<{ target: string; hash: string; ms: number; entry: ZapEntry }> = [];

  for (const ev of opened) {
    if (moderation?.banned.has(ev.author)) continue;

    if (ev.kind === KIND_DELETE) {
      // NIP-09 shape: possibly several `e` targets.
      for (const t of ev.tags) {
        if (t[0] !== "e" || !t[1]) continue;
        let authors = deletes.get(t[1]);
        if (!authors) deletes.set(t[1], (authors = new Set()));
        authors.add(ev.author);
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
      const url = ev.tags.find((t) => t[0] === "emoji")?.[2];
      let byEmoji = reactions.get(target);
      if (!byEmoji) reactions.set(target, (byEmoji = new Map()));
      let entry = byEmoji.get(ev.content);
      if (!entry) byEmoji.set(ev.content, (entry = { reactors: new Set() }));
      entry.reactors.add(ev.author);
      if (url && !entry.url) entry.url = url;
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
        },
      });
      continue;
    }
    if (ev.kind === KIND_MESSAGE || ev.kind === KIND_COMMENT) {
      // kind-9 top-level messages and kind-1111 threaded replies both land in
      // the timeline pool; the reader splits them by their NIP-22 root pointer.
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
    if (best) byId.set(id, { ...msg, content: best.content });
  }

  // In-batch deletes: self-delete, or an authorized moderator delete.
  for (const [id, msg] of byId) {
    const deleters = deletes.get(id);
    if (!deleters) continue;
    const deleted =
      deleters.has(msg.author) ||
      (moderation && [...deleters].some((d) => moderation.canDelete(d, msg.author)));
    if (deleted) byId.delete(id);
  }

  // Zaps: one payment counts once, earliest rumor (ms, then id) winning
  // deterministically so every member folds the same tally.
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

  return {
    messages: [...byId.values()].sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.rumorId < b.rumorId ? -1 : 1)),
    reactions,
    zaps,
  };
}
