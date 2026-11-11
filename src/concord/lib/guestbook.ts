/**
 * Concord Guestbook Plane — CORD-02 §5. One community_root-keyed stream carrying
 * membership motion: self-signed Joins/Leaves, authorized Kicks, refounder-signed
 * snapshots, Timeouts and Nicknames. Off-consensus, so it loads last and may lag. Folded by COALESCING
 * flat (latest ms per npub, ties to the lower rumor id), merged with observed
 * authors (forward of their latest departure), minus the Banlist.
 */

import { schnorr } from "@noble/curves/secp256k1.js";

import { uniqueTag } from "@/concord/lib/strictJson";
import type { NostrEvent } from "nostr-tools/pure";

import { guestbookGroupKey, type GroupKey } from "@/concord/lib/derive";
import { citationFromTags, citationToTag, type AuthorityCitation } from "@/concord/lib/edition";
import { KIND_JOIN_LEAVE, KIND_KICK, KIND_NICKNAME, KIND_SEAL_ENCRYPTED, KIND_SNAPSHOT, KIND_TIMEOUT } from "@/concord/lib/kinds";
import { buildRumor, FUTURE_HORIZON_MS, openWrap, sealRumor, wrapSeal, type OpenedEvent, type StreamSigner } from "@/concord/lib/stream";
import { clockNowMs } from "@/lib/relayClock";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

/** Entries dated further than this ahead of the local clock are dropped outright. */
export const GUESTBOOK_MAX_FUTURE_MS = 60 * 60 * 1000;
/** Snapshot chunk size: 400 members per event (CORD-02 §5). */
export const SNAPSHOT_CHUNK = 400;

/** Every guestbook stream key across held root epochs, newest first. */
export function guestbookGroups(community: Community): GroupKey[] {
  return community.heldRoots.map((r) => guestbookGroupKey(r.key, community.id, r.epoch));
}

/** The CURRENT guestbook stream key (where new entries publish). */
export function currentGuestbookGroup(community: Community): GroupKey {
  return guestbookGroupKey(community.root, community.id, community.rootEpoch);
}

/**
 * Whose snapshot an epoch takes (CORD-02 §5, Vector `snapshot_authority_for`): the
 * npub recorded as its minter when its rotation was adopted, else the owner, since
 * a member who joined after the Refounding was never told who minted it. Nobody's
 * at genesis.
 */
function epochMinter(community: Community, epoch: bigint, refounder: string | undefined): string | undefined {
  return epoch > 0n ? refounder ?? community.owner : undefined;
}

/**
 * Each held epoch's Guestbook address → the npub whose Refounding minted it, and
 * the live epoch's: a snapshot counts only from its own epoch's minter (CORD-02 §5).
 */
export function snapshotEpochs(community: Community): { authorityOf: Map<string, string>; live: { pk: string; refounder?: string } } {
  const authorityOf = new Map<string, string>();
  for (const r of community.heldRoots) {
    const minter = epochMinter(community, r.epoch, r.refounder);
    if (minter) authorityOf.set(guestbookGroupKey(r.key, community.id, r.epoch).pk, minter);
  }
  const live = currentGuestbookGroup(community).pk;
  const recorded = community.refounder ?? community.heldRoots.find((r) => r.epoch === community.rootEpoch)?.refounder;
  const refounder = epochMinter(community, community.rootEpoch, recorded);
  if (refounder) authorityOf.set(live, refounder);
  return { authorityOf, live: { pk: live, ...(refounder ? { refounder } : {}) } };
}

/** Every {@link epochMinter} over the held epochs, for a snapshot whose own epoch isn't known. */
export function snapshotAuthorities(community: Community): Set<string> {
  return new Set(snapshotEpochs(community).authorityOf.values());
}

/** A self-signed Join, optionally attributing the invite link used (CORD-05 §1). */
export function buildJoinRumor(pubkey: string, ms: number, attribution?: { creator: string; label?: string }): NostrRumor {
  const tags: string[][] = [];
  if (attribution) tags.push(["invite", attribution.creator, attribution.label ?? ""]);
  return buildRumor({ kind: KIND_JOIN_LEAVE, content: "join", tags, pubkey, ms });
}

/** A self-signed Leave. */
export function buildLeaveRumor(pubkey: string, ms: number): NostrRumor {
  return buildRumor({ kind: KIND_JOIN_LEAVE, content: "leave", tags: [], pubkey, ms });
}

/**
 * An admin-signed Kick citing its Grant (`vac`, CORD-04 §5); honored only if the
 * signer holds KICK and strictly outranks the target.
 */
export function buildKickRumor(
  adminPubkey: string,
  targetHex: string,
  ms: number,
  vac?: { eid: string; version: bigint; hash: string },
): NostrRumor {
  const tags: string[][] = [["p", targetHex]];
  if (vac) tags.push(["vac", vac.eid, vac.version.toString(), vac.hash]);
  return buildRumor({ kind: KIND_KICK, content: "", tags, pubkey: adminPubkey, ms });
}

/**
 * Refounder-signed snapshot rumors seeding a new epoch's Guestbook: present
 * members, chunked at {@link SNAPSHOT_CHUNK}, sharing one id and timestamp (CORD-02 §5).
 */
export function buildSnapshotRumors(refounderPubkey: string, members: string[], snapshotIdHex: string, ms: number): NostrRumor[] {
  const chunks: string[][] = [];
  for (let i = 0; i < members.length; i += SNAPSHOT_CHUNK) chunks.push(members.slice(i, i + SNAPSHOT_CHUNK));
  if (chunks.length === 0) chunks.push([]);
  const n = chunks.length;
  return chunks.map((chunk, i) =>
    buildRumor({
      kind: KIND_SNAPSHOT,
      content: JSON.stringify(chunk),
      tags: [["snap", snapshotIdHex, (i + 1).toString(), n.toString()]],
      pubkey: refounderPubkey,
      ms,
    }),
  );
}

/** Sign (encrypted seal) + wrap one guestbook rumor. */
export async function sealGuestbook(rumor: NostrRumor, guestbook: GroupKey, signer: StreamSigner): Promise<NostrEvent> {
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, guestbook, signer);
  return wrapSeal(seal, guestbook);
}

/** `refounded`: a Joined member the live epoch's complete snapshot omitted (CORD-02 §5). */
export type MemberState = "join" | "leave" | "kick" | "refounded";

export interface CoalescedMember {
  pubkey: string;
  state: MemberState;
  /** Millisecond time of the winning entry. */
  ms: number;
  /** Rumor id of the winning entry (the tiebreak). */
  rumorId: string;
  /** Whether the winning state came from a secondhand snapshot seed. */
  fromSnapshot: boolean;
  /** Invite attribution (Joins only): the link creator + label. */
  invite?: { creator: string; label?: string };
}

/** Open every guestbook wrap that decodes under one of `groups`. */
export function openGuestbookWraps(wraps: NostrEvent[], groups: GroupKey[]): OpenedEvent[] {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: OpenedEvent[] = [];
  for (const wrap of wraps) {
    const group = byPk.get(wrap.pubkey);
    if (!group) continue;
    try {
      out.push(openWrap(wrap, group));
    } catch {
      // Not openable under its claimed group: skipped.
    }
  }
  return out;
}

/** Guestbook fold input when events are already opened at ingest (mirrors `openControlEditions`). */
export function openGuestbookOpened(opened: OpenedEvent[]): OpenedEvent[] {
  return opened;
}

/**
 * Coalesce opened guestbook events flat: one final state per npub.
 *
 *   - entries > 1h in the future are dropped;
 *   - `banned` authors' entries, kicks included, are dropped (CORD-04 §4);
 *   - seals must be encrypted (CORD-02 §5);
 *   - latest ms wins; ties to the LOWER rumor id;
 *   - a Kick needs `canKick(actor, target)` (KICK bit + strict outrank);
 *   - a snapshot chunk counts only from its epoch's minter (`snapshotAuthorityOf`,
 *     else the `snapshotAuthorities` set where its address is unknown) and merely
 *     SEEDS state that any newer firsthand entry supersedes.
 */
export function coalesceGuestbook(
  opened: OpenedEvent[],
  opts: {
    nowMs: number;
    /**
     * KICK bit + strict outrank, plus the CORD-04 §5 sync floor via `citation` (the
     * kick's `vac`), so a stale roster doesn't honor a demoted admin.
     */
    canKick: (actorHex: string, targetHex: string, citation: AuthorityCitation | undefined, atMs: number) => boolean;
    /**
     * The npubs whose Refoundings minted the held epochs (CORD-02 §5), for a snapshot
     * whose Guestbook address isn't known; empty honors NO snapshot.
     */
    snapshotAuthorities?: ReadonlySet<string>;
    /** Guestbook address → its epoch's minter; where a snapshot's address is known, only that npub counts. */
    snapshotAuthorityOf?: ReadonlyMap<string, string>;
    /** The live epoch's Guestbook address and minter, for {@link liveRefound}. */
    live?: { pk: string; refounder?: string };

    /** Banned npubs; their entries are dropped entirely. */
    banned?: Set<string>;
  },
): Map<string, CoalescedMember> {
  const byMember = new Map<string, CoalescedMember>();

  /** Later ms wins; tie → lower rumor id; firsthand beats a snapshot at the same instant. */
  const supersedes = (prev: CoalescedMember | undefined, next: CoalescedMember): boolean => {
    if (!prev) return true;
    if (next.ms !== prev.ms) return next.ms > prev.ms;
    if (prev.fromSnapshot !== next.fromSnapshot) return prev.fromSnapshot;
    return next.rumorId < prev.rumorId;
  };

  const apply = (candidate: CoalescedMember) => {
    const prev = byMember.get(candidate.pubkey);
    if (supersedes(prev, candidate)) byMember.set(candidate.pubkey, candidate);
  };
  guestbookEntries(opened, opts, apply);
  supersedeByRefounding(byMember, opened, opts);
  return byMember;
}

/** The live epoch's Refounding: its complete snapshot's guest list and the moment it took effect. */
export interface Refound {
  cut: number;
  base: Set<string>;
  rumorId: string;
}

/**
 * The live epoch's Refounding (CORD-02 §5, Vector `live_refound`): the union of
 * every snapshot its minter put on the live epoch, cut at the earliest. Undefined
 * unless every snapshot is whole — a missing chunk is an absence, not a departure.
 */
export function liveRefound(opened: OpenedEvent[], opts: Parameters<typeof coalesceGuestbook>[1]): Refound | undefined {
  const authority = opts.live?.refounder;
  if (!authority || !opts.live) return undefined;
  const snapshots = new Map<string, { held: Set<number>; n: number; evs: OpenedEvent[] }>();
  for (const ev of opened) {
    if (ev.kind !== KIND_SNAPSHOT || ev.streamPk !== opts.live.pk || ev.author !== authority) continue;
    if (ev.ms > opts.nowMs + GUESTBOOK_MAX_FUTURE_MS || opts.banned?.has(ev.author)) continue;
    if (ev.sealKind !== undefined && ev.sealKind !== KIND_SEAL_ENCRYPTED) continue;
    const snap = snapTag(ev.tags);
    if (!snap) continue;
    const s = snapshots.get(snap.id) ?? { held: new Set<number>(), n: 0, evs: [] };
    s.held.add(snap.i);
    s.n = Math.max(s.n, snap.n);
    s.evs.push(ev);
    snapshots.set(snap.id, s);
  }
  if (snapshots.size === 0) return undefined;
  for (const { held, n } of snapshots.values()) {
    for (let i = 1; i <= n; i++) if (!held.has(i)) return undefined;
  }
  const base = new Set<string>();
  let cut: number | undefined;
  let rumorId: string | undefined;
  for (const { evs } of snapshots.values()) {
    for (const ev of evs) {
      for (const pk of snapshotMembers(ev.content)) base.add(pk);
      if (cut === undefined || ev.ms < cut) cut = ev.ms;
      if (rumorId === undefined || ev.rumorId < rumorId) rumorId = ev.rumorId;
    }
  }
  return cut === undefined || rumorId === undefined ? undefined : { cut, base, rumorId };
}

/**
 * A Joined member the Refounding omitted holds no state in the new epoch, when
 * their Join predates the cut or sits on an earlier epoch's plane (Vector
 * `supersede_by_refounding`); forward observation still re-admits them.
 */
function supersedeByRefounding(byMember: Map<string, CoalescedMember>, opened: OpenedEvent[], opts: Parameters<typeof coalesceGuestbook>[1]): void {
  const refound = liveRefound(opened, opts);
  if (!refound || !opts.live) return;
  const planeOf = new Map(opened.map((e) => [e.rumorId, e.streamPk]));
  for (const [pk, m] of byMember) {
    if (m.state !== "join" || refound.base.has(pk)) continue;
    const plane = planeOf.get(m.rumorId);
    if (m.ms < refound.cut || (plane !== undefined && plane !== opts.live.pk)) {
      byMember.set(pk, { pubkey: pk, state: "refounded", ms: refound.cut, rumorId: refound.rumorId, fromSnapshot: true });
    }
  }
}

/**
 * When to date this member's Join if the Guestbook, read whole, holds no state of
 * theirs (CORD-02 §5, Vector `heal_my_join`): at the live epoch's Refounding cut, else
 * its oldest entry, so two devices restoring it at once write one rumor. Undefined
 * when any state of theirs stands, for the owner, or with nothing to date it by.
 */
export function joinToRestore(
  opened: OpenedEvent[],
  opts: Parameters<typeof coalesceGuestbook>[1],
  self: string,
  ownerHex: string,
): number | undefined {
  if (self === ownerHex || opts.banned?.has(self) || !opts.live) return undefined;
  const state = coalesceGuestbook(opened, opts).get(self);
  if (state && state.state !== "refounded") return undefined;
  const cut = liveRefound(opened, opts)?.cut;
  if (cut !== undefined) return cut;
  let oldest: number | undefined;
  for (const e of opened) if (e.streamPk === opts.live.pk && (oldest === undefined || e.ms < oldest)) oldest = e.ms;
  return oldest;
}

/** A Snapshot's `["snap", id, i, n]`: exactly one, 1 ≤ i ≤ n (Vector). */
function snapTag(tags: string[][]): { id: string; i: number; n: number } | undefined {
  const snaps = tags.filter((t) => t.length >= 2 && t[0] === "snap");
  if (snaps.length !== 1 || snaps[0].length < 4 || !/^[0-9a-f]{64}$/i.test(snaps[0][1])) return undefined;
  if (!/^\d+$/.test(snaps[0][2]) || !/^\d+$/.test(snaps[0][3])) return undefined;
  const [i, n] = [Number(snaps[0][2]), Number(snaps[0][3])];
  if (i < 1 || i > n || n > 0xffffffff) return undefined;
  return { id: snaps[0][1].toLowerCase(), i, n };
}

/** A Snapshot's members, each a public key; malformed entries are dropped alone. */
function snapshotMembers(content: string): string[] {
  let members: unknown;
  try {
    members = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(members)) return [];
  return members.filter((pk): pk is string => typeof pk === "string" && isPubkey(pk.toLowerCase())).map((pk) => pk.toLowerCase());
}

/** Every member's Guestbook entries in order of time (`ms`, then rumor id): what a departure window reads. */
export type GuestbookHistory = ReadonlyMap<string, readonly CoalescedMember[]>;

/** The {@link GuestbookHistory} of `opened`, entries judged as {@link coalesceGuestbook} judges them. */
export function guestbookHistory(opened: OpenedEvent[], opts: Parameters<typeof coalesceGuestbook>[1]): GuestbookHistory {
  const out = new Map<string, CoalescedMember[]>();
  guestbookEntries(opened, opts, (e) => {
    const list = out.get(e.pubkey);
    if (list) list.push(e);
    else out.set(e.pubkey, [e]);
  });
  // Winner last, as `supersedes` picks it: time, a snapshot seed before a firsthand
  // entry, then the higher rumor id first (Vector `supersede_order`).
  for (const list of out.values()) {
    list.sort((a, b) => a.ms - b.ms || Number(!a.fromSnapshot) - Number(!b.fromSnapshot) || (a.rumorId > b.rumorId ? -1 : a.rumorId < b.rumorId ? 1 : 0));
  }
  return out;
}

/** Whether `member` was away from the Community at `atMs`: a Leave or Kick not yet followed by a Join (CORD-03 §1). */
export function awayAt(history: GuestbookHistory, member: string, atMs: number): boolean {
  let away = false;
  for (const e of history.get(member) ?? []) {
    if (e.ms > atMs) break;
    away = e.state !== "join";
  }
  return away;
}

/**
 * Whether a span `member` spent away holding a Kick reaches into a window that
 * opened at `startMs` (Vector `kicked_in`): a span runs from the first Leave or
 * Kick after a Join to the next Join or snapshot seed; a Refounding's omission opens none.
 */
export function kickedInto(history: GuestbookHistory, member: string, startMs: number): boolean {
  let from: number | undefined;
  let kicked = false;
  for (const e of history.get(member) ?? []) {
    if (e.state === "refounded") continue;
    if (e.state === "join") {
      if (from !== undefined && kicked && e.ms > startMs) return true;
      from = undefined;
      kicked = false;
      continue;
    }
    from ??= e.ms;
    kicked ||= e.state === "kick";
  }
  return from !== undefined && kicked;
}

/**
 * The members whose lifted Ban still owes its departure (Vector `heal_ban_departures`):
 * no longer banned, still standing on a Join from before the Ban, and silent since,
 * judged by every post this device holds (`postedAfter`), not only those loaded. A Ban
 * dated past the horizon owes nothing: no post can follow it, and the owner's Kick would
 * hold the member out until then.
 */
export async function banDeparturesOwed(
  control: { bannedAt: ReadonlyMap<string, number>; banned: ReadonlySet<string> },
  coalesced: ReadonlyMap<string, CoalescedMember>,
  observed: ReadonlyMap<string, number>,
  postedAfter: (pk: string, afterMs: number) => Promise<boolean>,
  nowMs: number = clockNowMs(),
): Promise<Array<{ pk: string; ms: number }>> {
  const out: Array<{ pk: string; ms: number }> = [];
  for (const [pk, at] of control.bannedAt) {
    if (control.banned.has(pk)) continue;
    const atMs = at * 1000;
    if (atMs > nowMs + FUTURE_HORIZON_MS) continue;
    const standing = coalesced.get(pk);
    if (standing?.state !== "join" || standing.ms > atMs) continue;
    if ((observed.get(pk) ?? 0) > atMs || (await postedAfter(pk, atMs).catch(() => true))) continue;
    out.push({ pk, ms: atMs });
  }
  return out;
}

/**
 * Whether a span `member` spent away holding a Kick began by `atMs` and reaches a
 * window opened at `startMs` (Vector `kicked_in`), as a post's judge reads it.
 */
export function kickedAwayIn(history: GuestbookHistory, member: string, startMs: number, atMs: number): boolean {
  let from: number | undefined;
  let kicked = false;
  for (const e of history.get(member) ?? []) {
    if (e.state === "refounded") continue;
    if (e.state === "join") {
      if (from !== undefined && kicked && from <= atMs && e.ms > startMs) return true;
      from = undefined;
      kicked = false;
      continue;
    }
    from ??= e.ms;
    kicked ||= e.state === "kick";
  }
  return from !== undefined && kicked && from <= atMs;
}

/**
 * When the earliest span `member` spent away holding a Kick that reaches a window
 * opened at `startMs` began, no earlier than `startMs` (Vector `carry_departures`).
 */
export function kickedSpanFrom(history: GuestbookHistory, member: string, startMs: number): number | undefined {
  let from: number | undefined;
  let kicked = false;
  let earliest: number | undefined;
  const close = (until: number | undefined) => {
    if (from !== undefined && kicked && (until === undefined || until > startMs)) {
      const at = Math.max(from, startMs);
      earliest = earliest === undefined ? at : Math.min(earliest, at);
    }
  };
  for (const e of history.get(member) ?? []) {
    if (e.state === "refounded") continue;
    if (e.state === "join") {
      close(e.ms);
      from = undefined;
      kicked = false;
      continue;
    }
    from ??= e.ms;
    kicked ||= e.state === "kick";
  }
  close(undefined);
  return earliest;
}

/** Whether the Guestbook's latest word on `member` is a Join. */
export function isMemberIn(history: GuestbookHistory, member: string): boolean {
  const list = history.get(member);
  return list !== undefined && list.length > 0 && list[list.length - 1].state === "join";
}

function guestbookEntries(
  opened: OpenedEvent[],
  opts: Parameters<typeof coalesceGuestbook>[1],
  apply: (candidate: CoalescedMember) => void,
): void {

  for (const ev of opened) {
    if (ev.ms > opts.nowMs + GUESTBOOK_MAX_FUTURE_MS) continue;
    // Encrypted seal (CORD-02 §5) when the form is known; stored rumors passed at ingest.
    if (ev.sealKind !== undefined && ev.sealKind !== KIND_SEAL_ENCRYPTED) continue;
    if (opts.banned?.has(ev.author)) continue;

    if (ev.kind === KIND_JOIN_LEAVE) {
      const verb = ev.content === "join" ? "join" : ev.content === "leave" ? "leave" : undefined;
      if (!verb) continue;
      // The first `["invite", creator, label]` carrying all three (Vector `invited_by`).
      const inviteTag = verb === "join" ? ev.tags.find((t) => t[0] === "invite" && t.length >= 3) : undefined;
      apply({
        pubkey: ev.author,
        state: verb,
        ms: ev.ms,
        rumorId: ev.rumorId,
        fromSnapshot: false,
        invite: inviteTag ? { creator: inviteTag[1], label: inviteTag[2] || undefined } : undefined,
      });
      continue;
    }

    if (ev.kind === KIND_KICK) {
      // Exactly one `p`, a public key (Vector).
      const target = uniqueTag(ev.tags, "p")?.toLowerCase();
      if (!target || !isPubkey(target) || !opts.canKick(ev.author, target, citationFromTags(ev.tags), ev.ms)) continue;
      apply({ pubkey: target, state: "kick", ms: ev.ms, rumorId: ev.rumorId, fromSnapshot: false });
      continue;
    }

    if (ev.kind === KIND_SNAPSHOT) {
      // Only from the npub whose Refounding minted the snapshot's own epoch, where its address is known.
      const minter = ev.streamPk !== undefined && opts.snapshotAuthorityOf ? opts.snapshotAuthorityOf.get(ev.streamPk) : undefined;
      if (ev.streamPk !== undefined && opts.snapshotAuthorityOf ? minter !== ev.author : !opts.snapshotAuthorities?.has(ev.author)) continue;
      // The `snap` tag is load-bearing: exactly one, `[snap, id, i, n]`, 1 ≤ i ≤ n.
      if (!snapTag(ev.tags)) continue;
      for (const pk of snapshotMembers(ev.content)) {
        apply({
          pubkey: pk,
          state: "join",
          ms: ev.ms,
          rumorId: ev.rumorId,
          fromSnapshot: true,
        });
      }
    }
  }

}

/**
 * The Complete Memberlist: coalesced Guestbook ∪ observed authors (forward of
 * their latest departure) − Banlist. `observed` maps author → newest ms seen.
 */
export function completeMemberlist(
  coalesced: Map<string, CoalescedMember>,
  observed: Map<string, number>,
  banned: Set<string>,
  bannedAt?: Map<string, number>,
  refound?: Refound,
): Set<string> {
  // Activity predating the member's latest ban is STALE: observation counts only
  // forward of a Ban (CORD-02 §5). `bannedAt` is in SECONDS.
  const stalePreBan = (pk: string, ms: number): boolean => {
    const at = bannedAt?.get(pk);
    return at !== undefined && ms <= at * 1000;
  };
  // Activity no newer than a Refounding that omitted them is stale too (Vector
  // `stale_pre_refound`); `0` is a grantee's sentinel, which a snapshot doesn't override.
  const stalePreRefound = (pk: string, ms: number): boolean =>
    ms !== 0 && refound !== undefined && !refound.base.has(pk) && ms <= refound.cut;
  const out = new Set<string>();
  for (const [pk, m] of coalesced) {
    // A Join doesn't consult the ban time: a lifted Ban's departure is the Kick its lift writes (Vector).
    if (m.state === "join" && !banned.has(pk)) out.add(pk);
  }
  for (const [pk, seenMs] of observed) {
    if (banned.has(pk) || stalePreBan(pk, seenMs) || stalePreRefound(pk, seenMs)) continue;
    const m = coalesced.get(pk);
    // Observation only counts FORWARD of the latest Leave/Kick.
    if (!m || m.state === "join" || seenMs > m.ms) out.add(pk);
  }
  return out;
}

/** The longest a Timeout runs past its own time (CORD-04 §8): 28 days. */
export const TIMEOUT_MAX_SECS = 28 * 24 * 60 * 60;
/** A Nickname's cap in Unicode scalar values (CORD-04 §10). */
export const NICKNAME_MAX_CHARS = 32;

/** A running or lifted Timeout, as the newest authorized one decides it (CORD-04 §8). */
export interface FoldedTimeout {
  by: string;
  /** Its window: from its own time in whole seconds, inclusive, to `until`, exclusive. */
  fromSecs: number;
  until: number;
  ms: number;
  rumorId: string;
}

/** The sole value of a tag that must appear exactly once, or undefined when it doesn't. */
function soleTag(tags: string[][], name: string): string | undefined {
  return uniqueTag(tags, name) ?? undefined;
}

/** Digits fitting a u64; leading zeros allowed, as Vector parses them. */
// All digits, any length: leading zeros parse (Vector `u64::parse`), and the bound is checked as a number.
const U64_DECIMAL = /^[0-9]+$/;

/** A target that is a public key: 64 hex digits naming a point on the curve (Vector `PublicKey::from_hex`). */
export function isPubkey(hex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold Timeouts (kind 3314, CORD-04 §8): per target, the newest by its time to the
 * millisecond among those `mayTimeout` lets time the target out, the lower rumor id
 * breaking a tie. `until` is capped at 28 days past the rumor's own time; a past
 * `until` lifts. Exactly one `p` and one `until`, and never the owner.
 */
export function foldTimeouts(
  opened: OpenedEvent[],
  opts: {
    nowMs: number;
    ownerHex: string;
    mayTimeout: (actorHex: string, targetHex: string, citation: AuthorityCitation | undefined) => boolean;
    banned?: ReadonlySet<string>;
  },
): Map<string, FoldedTimeout> {
  const out = new Map<string, FoldedTimeout>();
  for (const ev of opened) {
    if (ev.kind !== KIND_TIMEOUT) continue;
    if (ev.ms > opts.nowMs + GUESTBOOK_MAX_FUTURE_MS) continue;
    if (ev.sealKind !== undefined && ev.sealKind !== KIND_SEAL_ENCRYPTED) continue;
    if (opts.banned?.has(ev.author)) continue;
    const target = soleTag(ev.tags, "p")?.toLowerCase();
    const untilRaw = soleTag(ev.tags, "until");
    if (!target || !isPubkey(target) || !untilRaw || !U64_DECIMAL.test(untilRaw)) continue;
    if (BigInt(untilRaw) >= 1n << 64n || target === opts.ownerHex) continue;
    if (!opts.mayTimeout(ev.author, target, citationFromTags(ev.tags))) continue;
    const fromSecs = Math.floor(ev.ms / 1000);
    const until = Math.min(Number(untilRaw), fromSecs + TIMEOUT_MAX_SECS);
    const prev = out.get(target);
    if (prev && (ev.ms < prev.ms || (ev.ms === prev.ms && ev.rumorId >= prev.rumorId))) continue;
    out.set(target, { by: ev.author, fromSecs, until, ms: ev.ms, rumorId: ev.rumorId });
  }
  return out;
}

/** Whether a folded Timeout is running at `nowMs` (CORD-04 §8). */
export function timeoutRunning(t: FoldedTimeout | undefined, nowMs: number): boolean {
  return t !== undefined && t.until * 1000 > nowMs;
}

/** Whether a post at `atMs` falls inside a Timeout's window, so readers collapse it (CORD-04 §8). */
export function inTimeoutWindow(t: FoldedTimeout | undefined, atMs: number, nowMs: number): boolean {
  return timeoutRunning(t, nowMs) && atMs >= t!.fromSecs * 1000 && atMs < t!.until * 1000;
}

/** A Timeout rumor; `untilSecs` 0 lifts (CORD-04 §8). */
export function buildTimeoutRumor(actorPubkey: string, targetHex: string, untilSecs: number, ms: number, authority?: AuthorityCitation): NostrRumor {
  const tags: string[][] = [["p", targetHex], ["until", String(untilSecs)]];
  if (authority) tags.push(citationToTag(authority));
  return buildRumor({ kind: KIND_TIMEOUT, content: "", tags, pubkey: actorPubkey, ms });
}

/**
 * When to date a Timeout or Nickname of `target` (Vector `timeout_member`, `set_nickname`):
 * now, but strictly after every one of that kind that counts for them, so it outranks what
 * it replaces even when a co-moderator's clock runs ahead, and never past the horizon.
 */
export function nextGuestbookMs(
  opened: OpenedEvent[],
  kind: number,
  target: string,
  counts: (actor: string, citation: AuthorityCitation | undefined) => boolean,
  nowMs: number,
): number {
  let newest = 0;
  for (const ev of opened) {
    if (ev.kind !== kind || soleTag(ev.tags, "p")?.toLowerCase() !== target || !counts(ev.author, citationFromTags(ev.tags))) continue;
    newest = Math.max(newest, ev.ms);
  }
  return Math.max(nowMs, Math.min(newest + 1, nowMs + GUESTBOOK_MAX_FUTURE_MS));
}

/** Unicode `Cc`: C0, DEL and C1 controls. */
const CONTROL_CHAR = /\p{Cc}/u;

/** A Nickname as a reader takes it: none with a control character, the rest cut to 32 scalar values (CORD-04 §10). */
export function readNickname(content: string): string | undefined {
  if (CONTROL_CHAR.test(content)) return undefined;
  return [...content].slice(0, NICKNAME_MAX_CHARS).join("");
}

/** A writer's Nickname, trimmed, or undefined past 32 characters or with a control character. */
export function cleanNickname(nick: string): string | undefined {
  const trimmed = nick.trim();
  if (CONTROL_CHAR.test(trimmed) || [...trimmed].length > NICKNAME_MAX_CHARS) return undefined;
  return trimmed;
}

/**
 * Fold Nicknames (kind 3315, CORD-04 §10): per target, the newest by its time
 * among those `mayName` lets name the target, the lower rumor id breaking a tie.
 * `""` clears. While a member's Timeout runs their own Nicknames name nobody.
 */
export function foldNicknames(
  opened: OpenedEvent[],
  opts: {
    nowMs: number;
    mayName: (actorHex: string, targetHex: string, citation: AuthorityCitation | undefined) => boolean;
    banned?: ReadonlySet<string>;
    timeouts?: ReadonlyMap<string, FoldedTimeout>;
  },
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [pk, v] of foldNicknameWinners(opened, opts)) {
    const shown = displayNickname(v.nick);
    if (shown) out.set(pk, shown);
  }
  return out;
}

/** Direction controls and invisible spacers, which let a Nickname pass for another; ZWJ/ZWNJ stay for emoji and scripts. */
const SPOOFING_FORMAT = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * A Nickname as shown: without {@link SPOOFING_FORMAT}, trimmed, or `""` when nothing is
 * left. Display only; the fold and a carried Nickname keep what was signed (CORD-04 §10).
 */
export function displayNickname(nick: string): string {
  return nick.replace(SPOOFING_FORMAT, "").trim();
}

/** The rumor each target's Nickname stands on, as {@link foldNicknames} decides it; a cleared one is absent. */
export function foldNicknameWinners(
  opened: OpenedEvent[],
  opts: Parameters<typeof foldNicknames>[1],
): Map<string, { nick: string; ms: number; rumorId: string; author: string }> {
  const best = new Map<string, { nick: string; ms: number; rumorId: string; author: string }>();
  for (const ev of opened) {
    if (ev.kind !== KIND_NICKNAME) continue;
    if (ev.ms > opts.nowMs + GUESTBOOK_MAX_FUTURE_MS) continue;
    if (ev.sealKind !== undefined && ev.sealKind !== KIND_SEAL_ENCRYPTED) continue;
    if (opts.banned?.has(ev.author)) continue;
    const target = soleTag(ev.tags, "p")?.toLowerCase();
    if (!target || !isPubkey(target)) continue;
    const nick = readNickname(ev.content);
    if (nick === undefined) continue;
    if (target === ev.author && timeoutRunning(opts.timeouts?.get(target), opts.nowMs)) continue;
    if (!opts.mayName(ev.author, target, citationFromTags(ev.tags))) continue;
    const prev = best.get(target);
    if (prev && (ev.ms < prev.ms || (ev.ms === prev.ms && ev.rumorId >= prev.rumorId))) continue;
    best.set(target, { nick, ms: ev.ms, rumorId: ev.rumorId, author: ev.author });
  }
  for (const [pk, v] of best) if (v.nick === "") best.delete(pk);
  return best;
}

/**
 * The Nickname this member re-issues into the live epoch (CORD-04 §10, Vector `carry_my_nickname`):
 * the one it goes by over every epoch it holds, when the live epoch holds neither it nor a newer
 * one, dated as first set, and only while it may name itself.
 */
export function nicknameToCarry(
  opened: OpenedEvent[],
  o: { me: string; livePk: string; nowMs: number } & Omit<Parameters<typeof foldNicknames>[1], "nowMs">,
): { nick: string; ms: number } | undefined {
  const opts = { nowMs: o.nowMs, mayName: o.mayName, ...(o.banned ? { banned: o.banned } : {}), ...(o.timeouts ? { timeouts: o.timeouts } : {}) };
  const mine = foldNicknameWinners(opened, opts).get(o.me);
  if (!mine) return undefined;
  const carried = foldNicknameWinners(opened.filter((e) => e.streamPk === o.livePk), opts).get(o.me);
  if (carried && (carried.nick === mine.nick || carried.ms > mine.ms)) return undefined;
  if (!o.mayName(o.me, o.me, undefined)) return undefined;
  return { nick: mine.nick, ms: mine.ms };
}

/** A Nickname rumor; another member's cites the Grant it acts under (CORD-04 §10). */
export function buildNicknameRumor(actorPubkey: string, targetHex: string, nick: string, ms: number, authority?: AuthorityCitation): NostrRumor {
  const tags: string[][] = [["p", targetHex]];
  if (authority && targetHex !== actorPubkey) tags.push(citationToTag(authority));
  return buildRumor({ kind: KIND_NICKNAME, content: nick, tags, pubkey: actorPubkey, ms });
}

