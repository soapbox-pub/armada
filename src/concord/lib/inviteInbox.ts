/**
 * Concord direct-invite inbox — the decrypted giftwrap-invite cache.
 *
 * CORD-05 §6 lookup `{ kinds: [1059], "#p": [me], "#k": ["3313"] }`. Unwrapping
 * is two NIP-44 decrypts, so the decrypted rumor is persisted in one ArmadaDB
 * tenant PER RECIPIENT (`invites:<pubkey>`), keyed by wrap id. Per-account
 * tenants keep one account's invites from surfacing for another. Wiped on logout.
 *
 * The `since` cursor rewinds NIP-59's two-day backdate window on each resume.
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { getArmadaDB } from "@/lib/db/armadaDB";
import type { NRumorStore } from "@/lib/db/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { UnwrappedInvite } from "@/concord/lib/directInvite";
import { KIND_DIRECT_INVITE } from "@/concord/lib/kinds";
import { nowSecs } from "@/lib/relayClock";

/** NIP-59's outer-timestamp backdate window (the cursor rewinds this much). */
export const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

export function inviteInbox(recipient: string): NRumorStore {
  return getArmadaDB().tenant(`invites:${recipient}`);
}

/** A decrypted invite record read back from the store. */
export interface StoredDirectInvite {
  wrapId: string;
  /** The seal author — the verified sender of the gift wrap. */
  sender: string;
  rumor: UnwrappedInvite["rumor"];
}

/**
 * Build the stored record: keyed by wrap id, `pubkey` = verified sender (the
 * seal signer is the rumor author). Kind/content/tags stay untouched, since the
 * rumor id commits to them.
 */
export function unwrappedToStored(wrap: NostrEvent, unwrapped: UnwrappedInvite): NostrRumor {
  return {
    id: wrap.id,
    kind: unwrapped.rumor.kind,
    content: unwrapped.rumor.content,
    tags: unwrapped.rumor.tags,
    created_at: unwrapped.rumor.created_at,
    pubkey: unwrapped.sender,
  };
}

export function storedToInvite(ev: NostrRumor): StoredDirectInvite {
  return {
    wrapId: ev.id,
    sender: ev.pubkey,
    rumor: {
      kind: ev.kind,
      content: ev.content,
      tags: ev.tags,
      created_at: ev.created_at,
      pubkey: ev.pubkey,
    },
  };
}

/** Cached direct-invite rumors (kind 3313) for `recipient`, newest first, from its own tenant. */
export async function queryStoredInvites(
  recipient: string,
  opts?: { signal?: AbortSignal },
): Promise<StoredDirectInvite[]> {
  const rumors = await inviteInbox(recipient).query([{ kinds: [KIND_DIRECT_INVITE] }], {
    signal: opts?.signal,
  });
  return rumors.map(storedToInvite);
}

/**
 * Persist decrypted invites for `recipient`; failures are swallowed. Returns the
 * promise so the live wake can await its own write before re-reading.
 */
export function writeStoredInvites(
  recipient: string,
  records: { wrap: NostrEvent; unwrapped: UnwrappedInvite }[],
): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  const s = inviteInbox(recipient);
  return Promise.all(
    records.map(({ wrap, unwrapped }) => s.event(unwrappedToStored(wrap, unwrapped))),
  )
    .then(() => undefined)
    .catch(() => undefined);
}

const cursorKey = (pubkey: string) => `concord2-invites-cursor:${pubkey}`;

/** The `since` floor to fetch invite wraps from (0 on a cold cache). */
export async function inviteInboxSince(pubkey: string): Promise<number> {
  const newest = (await readFolded<number>(cursorKey(pubkey))) ?? 0;
  return newest > WRAP_BACKDATE_SECS ? newest - WRAP_BACKDATE_SECS : 0;
}

/** Advance the cursor to the newest wrap `created_at` seen (monotonic). */
export async function advanceInviteInboxCursor(pubkey: string, newestWrapCreatedAt: number): Promise<void> {
  const prev = (await readFolded<number>(cursorKey(pubkey))) ?? 0;
  if (newestWrapCreatedAt > prev) await writeFolded(cursorKey(pubkey), newestWrapCreatedAt);
}

// Live invite-wrap buffer: the wire's DM subscription also delivers invite wraps
// (`#k`=3313) but can't decrypt them, so it buffers them here and rings
// `c2inv:wrap` for the invite hook to drain without a relay re-fetch. Ciphertext
// only, never persisted. The seen-set dedupes wraps replayed by the backdate rewind.
/** Cap on buffered live invite wraps (a burst past this falls back to the poll). */
const LIVE_INVITE_CAP = 256;
/** Cap on remembered wrap ids (oldest halves are shed — the poll dedupes deeper). */
const LIVE_INVITE_SEEN_CAP = 4096;
const liveInviteWraps = new Map<string, NostrEvent>();
/** Ids ever accepted into the buffer this session (replay dedupe). */
const liveInviteSeen = new Set<string>();

function rememberLiveInvite(id: string): void {
  if (liveInviteSeen.size >= LIVE_INVITE_SEEN_CAP) {
    let drop = LIVE_INVITE_SEEN_CAP >> 1;
    for (const old of liveInviteSeen) {
      liveInviteSeen.delete(old);
      if (--drop <= 0) break;
    }
  }
  liveInviteSeen.add(id);
}

/** True when a wrap's NIP-40 `expiration` tag has already passed. */
function wrapExpired(tags: readonly string[][], nowSecs: number): boolean {
  for (const [name, value] of tags) {
    if (name !== "expiration") continue;
    const at = Number(value);
    if (Number.isFinite(at) && at <= nowSecs) return true;
  }
  return false;
}

/**
 * Stash raw invite gift wraps the wire received live. Returns the wraps actually
 * accepted — ids already seen this session (a replayed round) are skipped, so
 * the caller can gate the `c2inv:wrap` doorbell on genuinely new arrivals.
 */
export function bufferLiveInviteWraps(wraps: NostrEvent[]): NostrEvent[] {
  const fresh: NostrEvent[] = [];
  const now = nowSecs();
  for (const w of wraps) {
    // An expired handoff is never buffered or decrypted.
    if (wrapExpired(w.tags, now)) continue;
    if (liveInviteSeen.has(w.id)) continue;
    if (liveInviteWraps.size >= LIVE_INVITE_CAP) continue;
    rememberLiveInvite(w.id);
    liveInviteWraps.set(w.id, w);
    fresh.push(w);
  }
  return fresh;
}

/**
 * Put drained wraps back after a consent-gate decline, bypassing the seen-skip
 * so a later allow or the poll can drain them.
 */
export function rebufferLiveInviteWraps(wraps: NostrEvent[]): void {
  for (const w of wraps) {
    if (liveInviteWraps.size >= LIVE_INVITE_CAP && !liveInviteWraps.has(w.id)) continue;
    liveInviteWraps.set(w.id, w);
  }
}

export function hasBufferedLiveInviteWraps(): boolean {
  return liveInviteWraps.size > 0;
}

export function drainLiveInviteWraps(): NostrEvent[] {
  if (liveInviteWraps.size === 0) return [];
  const out = [...liveInviteWraps.values()];
  liveInviteWraps.clear();
  return out;
}

/** Reset the buffer AND the session-seen ids (tests only). */
export function resetLiveInviteWraps(): void {
  liveInviteWraps.clear();
  liveInviteSeen.clear();
}
