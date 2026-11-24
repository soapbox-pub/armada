/**
 * A Locked Channel's sealed history (CORD-03 §1, Vector `seal.rs`): the wrap ids of what
 * stood at its read address before the lock, which is all a reader fetches from there.
 * Anyone holding the read key can date a wrap into the past; a list fetched by id leaves
 * nothing they add in reach.
 *
 * Each page lists the ids one read plane carried and rides that plane, signed and encrypted
 * by its key and dated inside what the seal covers so nobody reads it by date. Pages run
 * newest first, each naming the next by event id, which commits to its content; a later
 * seal's oldest page names an earlier seal's first, so one chain holds every lock.
 */
import { finalizeEvent, getEventHash, type NostrEvent } from "nostr-tools/pure";

import type { GroupKey, StreamKeyView } from "@/concord/lib/derive";
import { KIND_SEAL_ENCRYPTED, KIND_SEAL_PAGE } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, checkChannelBinding, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";

/** The most ids one page names: its wrap, double-encrypted and padded, stays well under a relay's 64 KB. */
export const MAX_SEAL_IDS = 300;

export interface SealPage {
  /** Wrap ids, newest first. */
  ids: string[];
  /** The dates (unix ms) of the oldest and newest event it names. */
  oldest: number;
  newest: number;
  /** The next, older page: its event id and the read epoch it opens under. */
  next?: { id: string; read: number };
}

const HEX64 = /^[0-9a-f]{64}$/;
const u64 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function sealPageContent(p: SealPage): string {
  return JSON.stringify({ ids: p.ids.join(""), range: [p.oldest, p.newest], next: p.next ? [p.next.id, p.next.read] : null });
}

/** A whole page, or undefined: ids in 64-hex runs, at most {@link MAX_SEAL_IDS}, a range whose ends are in order. */
export function parseSealPage(content: string): SealPage | undefined {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const { ids: raw, range, next } = v as Record<string, unknown>;
  if (typeof raw !== "string" || raw.length % 64 !== 0 || raw.length / 64 > MAX_SEAL_IDS) return undefined;
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i += 64) {
    const id = raw.slice(i, i + 64).toLowerCase();
    if (!HEX64.test(id)) return undefined;
    ids.push(id);
  }
  if (!Array.isArray(range) || range.length !== 2 || !u64(range[0]) || !u64(range[1]) || range[0] > range[1]) return undefined;
  let link: SealPage["next"];
  if (next === null) link = undefined;
  else if (Array.isArray(next) && next.length === 2 && typeof next[0] === "string" && HEX64.test(next[0].toLowerCase()) && u64(next[1])) {
    link = { id: next[0].toLowerCase(), read: next[1] };
  } else return undefined;
  return { ids, oldest: range[0], newest: range[1], ...(link ? { next: link } : {}) };
}

/** `ids`, each with its date and the read plane that carried it, as pages newest first, not yet linked: a page holds one plane's ids. */
export function paginate<P>(entries: ReadonlyArray<{ id: string; at: number; plane: P }>): Array<{ page: SealPage; plane: P }> {
  const sorted = [...entries].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Array<{ page: SealPage; plane: P }> = [];
  let last: string | undefined;
  for (const { id, at, plane } of sorted) {
    if (id === last) continue;
    last = id;
    const tail = out[out.length - 1];
    if (tail && tail.plane === plane && tail.page.ids.length < MAX_SEAL_IDS) {
      tail.page.ids.push(id);
      tail.page.oldest = at;
    } else {
      out.push({ page: { ids: [id], oldest: at, newest: at }, plane });
    }
  }
  return out;
}

/**
 * `page` as a wrap on read plane `group` of epoch `read`, bound to the Channel, dated
 * `atMs`. Its `p` is a key nobody keeps, so a relay judging deletion by owner deletes it
 * for nobody. Its event id is what names it.
 */
export async function sealPageWrap(page: SealPage, channelIdHex: string, read: bigint, group: GroupKey, atMs: number): Promise<NostrEvent> {
  const rumor = buildRumor({ kind: KIND_SEAL_PAGE, content: sealPageContent(page), tags: channelBindingTags(channelIdHex, read), pubkey: group.pk, ms: atMs });
  const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, group.sk) };
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, signer);
  return wrapSeal(seal, group, { createdAt: Math.floor(atMs / 1000) });
}

/** The page `id` names, when `wrap` is it: that id, on read plane `plane` of epoch `read`, opened under its key and bound to the Channel. */
export function openSealPage(wrap: NostrEvent, id: string, channelIdHex: string, read: bigint, plane: StreamKeyView): SealPage | undefined {
  if (wrap.id !== id || wrap.pubkey !== plane.pk) return undefined;
  try {
    // The id its predecessor names commits to this content, and only if it is the wrap's hash.
    if (getEventHash(wrap) !== id) return undefined;
    const opened = openWrap(wrap, plane);
    if (opened.sealKind !== KIND_SEAL_ENCRYPTED || opened.kind !== KIND_SEAL_PAGE || opened.author !== plane.pk) return undefined;
    checkChannelBinding(opened, channelIdHex, read);
    return parseSealPage(opened.content);
  } catch {
    return undefined;
  }
}

