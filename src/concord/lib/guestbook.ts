/**
 * Concord Guestbook Plane — CORD-02 §5. One community_root-keyed stream carrying
 * membership motion: self-signed Joins/Leaves, authorized Kicks, refounder-signed
 * snapshots, Timeouts and Nicknames. Off-consensus, so it loads last and may lag. Folded by COALESCING
 * flat (latest ms per npub, ties to the lower rumor id), merged with observed
 * authors (forward of their latest departure), minus the Banlist.
 */

import type { NostrEvent } from "nostr-tools/pure";

import { guestbookGroupKey, type GroupKey } from "@/concord/lib/derive";
import { citationFromTags, citationToTag, type AuthorityCitation } from "@/concord/lib/edition";
import { KIND_JOIN_LEAVE, KIND_KICK, KIND_NICKNAME, KIND_SEAL_ENCRYPTED, KIND_SNAPSHOT, KIND_TIMEOUT } from "@/concord/lib/kinds";
import { buildRumor, openWrap, sealRumor, wrapSeal, type OpenedEvent, type StreamSigner } from "@/concord/lib/stream";
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
 * The npubs whose Refoundings minted the held epochs — snapshot authorities
 * (CORD-02 §5). Genesis and epochs with no recorded refounder contribute none:
 * accepting no snapshot is the safe miss (§5 heals by observation), whereas
 * falling back to the owner would let a non-minter seed members.
 */
export function snapshotAuthorities(community: Community): Set<string> {
  const out = new Set<string>();
  for (const r of community.heldRoots) {
    if (r.epoch > 0n && r.refounder) out.add(r.refounder);
  }
  if (community.rootEpoch > 0n && community.refounder) out.add(community.refounder);
  return out;
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

export type MemberState = "join" | "leave" | "kick";

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
 *   - a snapshot chunk counts only from a `snapshotAuthorities` npub and merely
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
     * The npubs whose Refoundings minted the held epochs (CORD-02 §5). A SET, since
     * the sweep spans every held epoch's guestbook; empty honors NO snapshot. Not
     * per-epoch exact (a rumor's epoch isn't persisted), but every member of the set
     * legitimately held that key, and snapshots only seed.
     */
    snapshotAuthorities?: ReadonlySet<string>;

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

  for (const ev of opened) {
    if (ev.ms > opts.nowMs + GUESTBOOK_MAX_FUTURE_MS) continue;
    // Encrypted seal (CORD-02 §5) when the form is known; stored rumors passed at ingest.
    if (ev.sealKind !== undefined && ev.sealKind !== KIND_SEAL_ENCRYPTED) continue;
    if (opts.banned?.has(ev.author)) continue;

    if (ev.kind === KIND_JOIN_LEAVE) {
      const verb = ev.content === "join" ? "join" : ev.content === "leave" ? "leave" : undefined;
      if (!verb) continue;
      const inviteTag = verb === "join" ? ev.tags.find((t) => t[0] === "invite") : undefined;
      apply({
        pubkey: ev.author,
        state: verb,
        ms: ev.ms,
        rumorId: ev.rumorId,
        fromSnapshot: false,
        invite: inviteTag?.[1] ? { creator: inviteTag[1], label: inviteTag[2] || undefined } : undefined,
      });
      continue;
    }

    if (ev.kind === KIND_KICK) {
      const target = ev.tags.find((t) => t[0] === "p")?.[1];
      if (!target || !opts.canKick(ev.author, target, citationFromTags(ev.tags), ev.ms)) continue;
      apply({ pubkey: target, state: "kick", ms: ev.ms, rumorId: ev.rumorId, fromSnapshot: false });
      continue;
    }

    if (ev.kind === KIND_SNAPSHOT) {
      if (!opts.snapshotAuthorities?.has(ev.author)) continue;
      let members: unknown;
      try {
        members = JSON.parse(ev.content);
      } catch {
        continue;
      }
      if (!Array.isArray(members)) continue;
      for (const pk of members) {
        if (typeof pk !== "string" || !/^[0-9a-f]{64}$/i.test(pk)) continue;
        apply({
          pubkey: pk.toLowerCase(),
          state: "join",
          ms: ev.ms,
          rumorId: ev.rumorId,
          fromSnapshot: true,
        });
      }
    }
  }

  return byMember;
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
): Set<string> {
  // A Join or activity predating the member's latest ban is STALE (bans aren't
  // recorded in the Guestbook), or an unban would resurrect a phantom. `bannedAt`
  // is in SECONDS. Activity after the ban is a genuine rejoin.
  const stalePreBan = (pk: string, ms: number): boolean => {
    const at = bannedAt?.get(pk);
    return at !== undefined && ms <= at * 1000;
  };
  const out = new Set<string>();
  for (const [pk, m] of coalesced) {
    if (m.state === "join" && !banned.has(pk) && !stalePreBan(pk, m.ms)) out.add(pk);
  }
  for (const [pk, seenMs] of observed) {
    if (banned.has(pk) || stalePreBan(pk, seenMs)) continue;
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
  const found = tags.filter((t) => t[0] === name);
  return found.length === 1 ? found[0][1] : undefined;
}

const U64_DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

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
    if (!target || !/^[0-9a-f]{64}$/.test(target) || !untilRaw || !U64_DECIMAL.test(untilRaw)) continue;
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
  const best = new Map<string, { nick: string; ms: number; rumorId: string }>();
  for (const ev of opened) {
    if (ev.kind !== KIND_NICKNAME) continue;
    if (ev.ms > opts.nowMs + GUESTBOOK_MAX_FUTURE_MS) continue;
    if (ev.sealKind !== undefined && ev.sealKind !== KIND_SEAL_ENCRYPTED) continue;
    if (opts.banned?.has(ev.author)) continue;
    const target = soleTag(ev.tags, "p")?.toLowerCase();
    if (!target || !/^[0-9a-f]{64}$/.test(target)) continue;
    const nick = readNickname(ev.content);
    if (nick === undefined) continue;
    if (target === ev.author && timeoutRunning(opts.timeouts?.get(target), opts.nowMs)) continue;
    if (!opts.mayName(ev.author, target, citationFromTags(ev.tags))) continue;
    const prev = best.get(target);
    if (prev && (ev.ms < prev.ms || (ev.ms === prev.ms && ev.rumorId >= prev.rumorId))) continue;
    best.set(target, { nick, ms: ev.ms, rumorId: ev.rumorId });
  }
  const out = new Map<string, string>();
  for (const [pk, v] of best) if (v.nick !== "") out.set(pk, v.nick);
  return out;
}

/** A Nickname rumor; another member's cites the Grant it acts under (CORD-04 §10). */
export function buildNicknameRumor(actorPubkey: string, targetHex: string, nick: string, ms: number, authority?: AuthorityCitation): NostrRumor {
  const tags: string[][] = [["p", targetHex]];
  if (authority && targetHex !== actorPubkey) tags.push(citationToTag(authority));
  return buildRumor({ kind: KIND_NICKNAME, content: nick, tags, pubkey: actorPubkey, ms });
}

