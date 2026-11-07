/**
 * Concord Community List — CORD-02 §8: the merge algebra over the unioned
 * kind-33302 document (wire layer: `listFrag.ts`), hex-internal. Joined AND left
 * communities stay in the document; liveness is DERIVED, never deletion.
 *
 * Per entry, `seed` holds the EARLIEST epoch (history anchor, only moves backward)
 * and `current` the LATEST. Tombstones are permanent; the newer of
 * `added_at`/`removed_at` decides liveness.
 */

import { bytesToHex, controlSignerGroupKey, hex32, verifyCommunityId } from "@/concord/lib/derive";

import type { NostrRumor } from "@/lib/nostrRumor";
import {
  capRelays,
  type Community,
  type HeldRoot,
  type PrivateChannelKey,
} from "@/concord/lib/types";

/**
 * Join material — the invite bundle's MEMBERSHIP subset. Snake_case wire shape;
 * unknown fields are preserved (CORD-02 §6). `held_roots` is an Armada extension
 * keeping prior roots readable across Refoundings.
 */
export interface JoinMaterial {
  community_id: string;
  owner: string;
  owner_salt: string;
  community_root: string;
  root_epoch: number;
  /**
   * Current epoch's Control Plane signer pubkey (CORD-02 §2/§8) — read access only.
   * Absent = legacy pre-split epoch.
   */
  control_pk?: string;
  /**
   * Armada extension, STAFF ONLY: the current epoch's `control_root` (hex), so a
   * staffer's write key reaches their devices. Same trust class as `community_root`.
   * Delivered by `control_wrap` (CORD-04 §3) or a 136-byte blob (CORD-06 §1).
   */
  control_root?: string;
  /** The PRIVATE channels held (public ones derive from the root — CORD-03). */
  channels: Array<{ id: string; key: string; epoch: number; name: string; priors?: Array<{ key: string; epoch: number; retired_at?: number }> }>;
  relays: string[];
  name: string;
  /**
   * Armada extension: retained prior roots (current excluded). `retired_at`
   * (seconds) is the hard read cutoff; `refounder` is that epoch's snapshot
   * authority (CORD-02 §5); `control_pk` names a split epoch's address.
   */
  held_roots?: Array<{ epoch: number; key: string; retired_at?: number; refounder?: string; control_pk?: string }>;
  /** Armada extension: the npub whose Refounding minted `root_epoch`. */
  refounder?: string;
  /** The snapshot's revision within its epoch (CORD-02 §8); absent means 0, and 0 is never written. */
  rev?: number;
  [k: string]: unknown;
}

export interface CommunityListEntry {
  community_id: string;
  /** Earliest epoch held — only ever moves BACKWARD on merge. */
  seed: JoinMaterial;
  /** Freshest snapshot — replaced on every Refounding or rename. */
  current: JoinMaterial;
  /** ms; tiebreaks against a tombstone. */
  added_at: number;
  /**
   * The Refounding epoch that EXCLUDED me (no blob for me). Not leaving: the entry
   * stays live and read-only, auto-clearing once `current.root_epoch` passes it.
   */
  excluded_at_epoch?: number;
  /**
   * Armada extension: per Private Channel, the channel epoch whose rotation cut me
   * out (CORD-06 §2). A floor, since the union merge is additive and an old bundle
   * would otherwise restore the key. Max wins; never rolls back.
   */
  channel_cuts?: Array<{ id: string; epoch: number }>;
  /**
   * Armada extension: the invite link joined through, bare `<naddr>#<fragment>`
   * (CORD-05 §2/§3), so a STRANDED member can re-resolve its refreshed bundle.
   * Absent for direct-invite and creator entries.
   */
  invite_ref?: string;
  [k: string]: unknown;
}

export interface CommunityTombstone {
  community_id: string;
  /** ms. Permanent — pruning would let a long-offline device resurrect a leave. */
  removed_at: number;
  [k: string]: unknown;
}

export interface CommunityList {
  entries: CommunityListEntry[];
  tombstones: CommunityTombstone[];
  [k: string]: unknown;
}

export const EMPTY_COMMUNITY_LIST: CommunityList = { entries: [], tombstones: [] };

/**
 * The Private Channel keys a snapshot holds. `channels` may be absent on the wire
 * (a cross-client document; Private Channels are optional), so every reader
 * goes through here — a throw in the merge would break every list write.
 */
export function heldChannelKeys(
  channels: JoinMaterial["channels"] | undefined,
): JoinMaterial["channels"] {
  return Array.isArray(channels) ? channels : [];
}

/**
 * The locally cached, DECRYPTED community list for one viewer (in `foldedCache`).
 * Lives here so signer-less, React-free code (the rumor-store migration) can
 * enumerate an account's communities.
 */
export interface PersistedCommunityList {
  event: NostrRumor | null;
  list: CommunityList;
}

/** Where {@link PersistedCommunityList} is cached, per viewer pubkey. */
export const communityListFoldKey = (pubkey: string) => `concord2-list:${pubkey}`;

/** JSON with recursively-sorted object keys — a total order for equal-epoch merges. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    // fromEntries keeps a foreign "__proto__" key as a plain field (as serde does),
    // so canonical bytes don't fork across clients.
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * A snapshot's revision as merges read it (CORD-02 §8): absent, malformed or
 * past 2^53 − 1 reads as 0.
 */
export function snapshotRev(jm: JoinMaterial): number {
  const rev = jm.rev;
  return typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0;
}

/** Within one epoch: the higher revision, then the lowest canonical bytes (CORD-02 §8). */
function latestRevision(a: JoinMaterial, b: JoinMaterial): JoinMaterial {
  const ra = snapshotRev(a);
  const rb = snapshotRev(b);
  if (ra !== rb) return ra > rb ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}

/** Higher epoch wins; within one, {@link latestRevision}. */
function freshest(a: JoinMaterial, b: JoinMaterial): JoinMaterial {
  if (a.root_epoch !== b.root_epoch) return a.root_epoch > b.root_epoch ? a : b;
  return latestRevision(a, b);
}

/** Lower epoch wins; within one, {@link latestRevision}. */
function earliest(a: JoinMaterial, b: JoinMaterial): JoinMaterial {
  if (a.root_epoch !== b.root_epoch) return a.root_epoch < b.root_epoch ? a : b;
  return latestRevision(a, b);
}

/** The snapshot with its revision removed and channels in raw-id order, for change detection. */
function unrevised(jm: JoinMaterial): string {
  const { rev: _rev, ...rest } = jm;
  return canonicalJson({ ...rest, channels: sortChannelsById(heldChannelKeys(jm.channels)) });
}

function sortChannelsById<T extends { id: string }>(channels: T[]): T[] {
  return [...channels].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/**
 * Stamp each entry's `current` with its revision against the copy the write
 * read (CORD-02 §8): one past it when the content changed, the read one when
 * not. An entry the wire doesn't hold keeps what it carries. A seed at the
 * current epoch follows current, as every reader's merge settles it.
 */
export function reviseSnapshots(read: CommunityList, next: CommunityList): CommunityList {
  const readById = new Map(read.entries.map((e) => [e.community_id, e]));
  const entries = next.entries.map((e) => {
    const theirs = readById.get(e.community_id)?.current;
    let current = rebuildSnapshot(e, theirs);
    if (theirs) {
      const rev = unrevised(current) === unrevised(theirs) ? snapshotRev(theirs) : snapshotRev(theirs) + 1;
      current = withRev(current, rev);
    }
    const seed = e.seed && e.seed.root_epoch === current.root_epoch ? current : e.seed;
    return current === e.current && seed === e.seed ? e : { ...e, current, seed };
  });
  return { ...next, entries };
}

/**
 * This device's snapshot merged with the same epoch's copy it read, so a newer
 * revision never carries a smaller view (CORD-02 §8, Vector `rebuild_snapshot`):
 * every Channel key, the staff key and unknown fields the read copy holds are
 * kept, minus the keys a rotation cut. Channels in raw-id order. Across a
 * Refounding the read copy is another snapshot and nothing is merged.
 */
function rebuildSnapshot(e: CommunityListEntry, theirs: JoinMaterial | undefined): JoinMaterial {
  const ours = e.current;
  if (!theirs || theirs.root_epoch !== ours.root_epoch) {
    const channels = sortChannelsById(heldChannelKeys(ours.channels));
    return channels.every((c, i) => c === heldChannelKeys(ours.channels)[i]) ? ours : { ...ours, channels };
  }
  const merged: JoinMaterial = { ...ours };
  for (const [k, v] of Object.entries(theirs)) if (!(k in merged) && k !== "rev") merged[k] = v;
  if (ours.control_root === undefined && ours.control_pk === theirs.control_pk && theirs.control_root !== undefined) merged.control_root = theirs.control_root;
  merged.channels = applyChannelCuts(unionChannelKeys(ours.channels, theirs.channels), e.channel_cuts);
  return unrevised(merged) === unrevised(ours) && JSON.stringify(merged.channels) === JSON.stringify(heldChannelKeys(ours.channels)) ? ours : merged;
}

function withRev(jm: JoinMaterial, rev: number): JoinMaterial {
  if (snapshotRev(jm) === rev && (rev > 0 || jm.rev === undefined)) return jm;
  const { rev: _rev, ...rest } = jm;
  return rev > 0 ? { ...rest, rev } : rest;
}

/**
 * Union two private-channel key sets by id: higher channel epoch wins, tie by
 * canonical bytes, so a partial vend can never displace held keys. CRDT-safe.
 * Either side may be absent (see {@link heldChannelKeys}).
 */
export function unionChannelKeys(
  /** Listed first: its copy of a key both hold keeps its fields. */
  a: JoinMaterial["channels"] | undefined,
  b: JoinMaterial["channels"] | undefined,
): JoinMaterial["channels"] {
  const byId = new Map<string, JoinMaterial["channels"][number]>();
  for (const raw of [...heldChannelKeys(a), ...heldChannelKeys(b)]) {
    if (!raw || typeof raw.id !== "string") continue;
    // Normalize id case: foreign documents may not be lowercase, and two spellings
    // must fold to ONE entry.
    const ch = { ...raw, id: raw.id.toLowerCase() };
    const prev = byId.get(ch.id);
    if (!prev) {
      byId.set(ch.id, ch);
      continue;
    }
    if (ch.epoch !== prev.epoch) {
      // Keep the superseded key as a prior; it reads pre-rotation history.
      const [winner, loser] = ch.epoch > prev.epoch ? [ch, prev] : [prev, ch];
      byId.set(ch.id, withPriorKey(winner, loser));
      continue;
    }
    // One key in two copies: the first-listed copy (the fresher snapshot's) keeps its
    // fields and gains only those it lacks, as Vector's `rebuild_snapshot` does. A
    // tie-break here would let a stale name outvote a newer revision every write.
    if (ch.key === prev.key) {
      byId.set(ch.id, attachPriors({ ...ch, ...prev }, [...(prev.priors ?? []), ...(ch.priors ?? [])]));
      continue;
    }
    // Racing rotations at one epoch: deterministic winner, but the loser is kept as
    // a prior (CORD-06) so its branch stays readable.
    if (canonicalJson(ch) < canonicalJson(prev)) byId.set(ch.id, withPriorKey(ch, prev));
    else byId.set(ch.id, withPriorKey(prev, ch));
  }
  // Raw-id order (CORD-02 §8): for lowercase hex, code-unit order is byte order.
  return sortChannelsById([...byId.values()]);
}

type ChannelKeyEntry = JoinMaterial["channels"][number];
type PriorKey = { key: string; epoch: number; retired_at?: number };

/** Priors of both, plus the loser's own key, deduped by (epoch, key). */
function withPriorKey(winner: ChannelKeyEntry, loser: ChannelKeyEntry): ChannelKeyEntry {
  return attachPriors(winner, [...(loser.priors ?? []), { key: loser.key, epoch: loser.epoch }, ...(winner.priors ?? [])]);
}

function attachPriors(entry: ChannelKeyEntry, priors: PriorKey[]): ChannelKeyEntry {
  const byId = new Map<string, PriorKey>();
  const kept: PriorKey[] = [];
  for (const p of priors) {
    if (!p || typeof p.key !== "string" || typeof p.epoch !== "number") continue;
    if (p.epoch >= entry.epoch && p.key === entry.key) continue; // the current key is not a prior
    const id = `${p.epoch}:${p.key}`;
    const prev = byId.get(id);
    if (prev) {
      // Keep a recorded cutoff when only one copy has it.
      if (prev.retired_at === undefined && typeof p.retired_at === "number") prev.retired_at = p.retired_at;
      continue;
    }
    const copy = { ...p };
    byId.set(id, copy);
    kept.push(copy);
  }
  kept.sort((x, y) => y.epoch - x.epoch || x.key.localeCompare(y.key));
  return kept.length > 0 ? { ...entry, priors: kept } : entry;
}

/** Per-channel cut floors, max wins — a removal never rolls back. */
export function mergeChannelCuts(
  a: CommunityListEntry["channel_cuts"],
  b: CommunityListEntry["channel_cuts"],
): CommunityListEntry["channel_cuts"] {
  if (!a?.length && !b?.length) return undefined;
  const byId = new Map<string, number>();
  for (const cut of [...(a ?? []), ...(b ?? [])]) {
    if (!cut || typeof cut.id !== "string" || typeof cut.epoch !== "number") continue;
    const id = cut.id.toLowerCase(); // one spelling per channel (CORD-01)
    const prev = byId.get(id);
    if (prev === undefined || cut.epoch > prev) byId.set(id, cut.epoch);
  }
  if (byId.size === 0) return undefined;
  return [...byId.entries()].map(([id, epoch]) => ({ id, epoch })).sort((p, q) => p.id.localeCompare(q.id));
}

/** Drop channel keys a cut has floored out (epoch below the cut). */
export function applyChannelCuts(
  channels: JoinMaterial["channels"] | undefined,
  cuts: CommunityListEntry["channel_cuts"],
): JoinMaterial["channels"] {
  const held = heldChannelKeys(channels);
  if (!cuts?.length) return held;
  const floor = new Map(cuts.map((c) => [c.id.toLowerCase(), c.epoch]));
  return held.filter((ch) => {
    const cut = floor.get(ch.id.toLowerCase());
    return cut === undefined || ch.epoch >= cut;
  });
}

function mergeEntry(x: CommunityListEntry, y: CommunityListEntry): CommunityListEntry {
  const channelCuts = mergeChannelCuts(x.channel_cuts, y.channel_cuts);
  const fresh = freshest(x.current, y.current);
  const stale = fresh === x.current ? y.current : x.current;
  const current = {
    ...fresh,
    // Union first, then floor, so stale bundles can't restore cut keys. The fresher
    // snapshot is listed first, so its copy of a shared key keeps its fields.
    channels: applyChannelCuts(unionChannelKeys(fresh.channels, stale.channels), channelCuts),
  };
  // Higher exclusion wins, but only bites while beyond `current`'s epoch; holding
  // that epoch's root is re-inclusion.
  const excludedAt = maxDefined(x.excluded_at_epoch, y.excluded_at_epoch);
  const merged: CommunityListEntry = {
    ...x,
    ...y,
    community_id: x.community_id,
    current,
    seed: earliest(x.seed, y.seed),
    added_at: Math.max(x.added_at, y.added_at),
  };
  if (channelCuts) merged.channel_cuts = channelCuts;
  else delete merged.channel_cuts;
  if (excludedAt !== undefined && excludedAt > current.root_epoch) {
    merged.excluded_at_epoch = excludedAt;
  } else {
    delete merged.excluded_at_epoch;
  }
  return merged;
}

/** The larger of two optional numbers, or undefined if neither is set. */
function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Deterministically merge two Community Lists. Entries and tombstones both
 * stay in the document; nothing is deleted (liveness is derived).
 */
export function mergeCommunityLists(a: CommunityList, b: CommunityList): CommunityList {
  const entries = new Map<string, CommunityListEntry>();
  for (const e of [...a.entries, ...b.entries]) {
    if (!e || typeof e.community_id !== "string") continue;
    const prev = entries.get(e.community_id);
    entries.set(e.community_id, prev ? mergeEntry(prev, e) : e);
  }
  const tombstones = new Map<string, CommunityTombstone>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    if (!t || typeof t.community_id !== "string") continue;
    const prev = tombstones.get(t.community_id);
    if (!prev || t.removed_at > prev.removed_at) tombstones.set(t.community_id, t);
  }
  return {
    ...a,
    ...b,
    // Code-unit order, not localeCompare: must match the reference's BTreeMap order
    // so identical state yields identical fragments.
    entries: [...entries.values()].sort((x, y) => (x.community_id < y.community_id ? -1 : 1)),
    tombstones: [...tombstones.values()].sort((x, y) => (x.community_id < y.community_id ? -1 : 1)),
  };
}

/** Whether an entry is live: no tombstone, or the add is newer than the removal. */
export function isLive(list: CommunityList, communityId: string): boolean {
  const entry = list.entries.find((e) => e.community_id === communityId);
  if (!entry) return false;
  const tomb = list.tombstones.find((t) => t.community_id === communityId);
  return !tomb || entry.added_at > tomb.removed_at;
}

/** The live entries (memberships), derived. */
export function liveEntries(list: CommunityList): CommunityListEntry[] {
  return list.entries.filter((e) => isLive(list, e.community_id));
}

/**
 * Communities the list says the member LEFT (tombstoned, not re-added). Unlike
 * absence from {@link liveEntries}, a tombstone is positive, so background watches
 * may drop these without an authoritative list.
 */
export function removedCommunityIds(list: CommunityList): string[] {
  return list.tombstones
    .filter((t) => !isLive(list, t.community_id))
    .map((t) => t.community_id);
}

/**
 * EXCLUDED at the current epoch: live and on the rail but read-only. Holds only
 * while the marker is strictly beyond the held epoch; holding the marked epoch's
 * root (later Refounding, or unban + re-invite) is re-inclusion.
 */
export function isExcluded(entry: CommunityListEntry): boolean {
  return (
    typeof entry.excluded_at_epoch === "number" &&
    entry.excluded_at_epoch > entry.current.root_epoch
  );
}

/**
 * Where a REPLAYED add (a pending join settled later) stands against `list`:
 *
 *   - `"superseded"`: a removal at/after the click — replaying would undo it;
 *   - `"held"`: already live under this or a newer add — nothing to publish;
 *   - `undefined`: still to be written.
 *
 * Pure; `added_at` must be the click time.
 */
export function replayedAddStanding(
  list: CommunityList,
  entry: CommunityListEntry,
): "superseded" | "held" | undefined {
  const tomb = list.tombstones.find((t) => t.community_id === entry.community_id);
  if (tomb && tomb.removed_at >= entry.added_at) return "superseded";
  const held = list.entries.find((e) => e.community_id === entry.community_id);
  if (held && held.added_at >= entry.added_at && isLive(list, entry.community_id)) return "held";
  return undefined;
}

/** Add/refresh a membership. Pure. */
export function addToList(list: CommunityList, entry: CommunityListEntry): CommunityList {
  return mergeCommunityLists(list, { entries: [entry], tombstones: [] });
}

/** Tombstone a membership (leave/removed). Pure. */
export function removeFromList(list: CommunityList, communityId: string, removedAt: number): CommunityList {
  return mergeCommunityLists(list, { entries: [], tombstones: [{ community_id: communityId, removed_at: removedAt }] });
}

/**
 * Mark a membership EXCLUDED at `epoch`. Never hides the icon (kicked ≠ left);
 * cleared by re-inclusion. Never lowers the marker. Pure.
 */
export function markExcluded(list: CommunityList, communityId: string, epoch: number): CommunityList {
  const idx = list.entries.findIndex((e) => e.community_id === communityId);
  if (idx === -1) return list;
  const entries = list.entries.map((e, i) => {
    if (i !== idx) return e;
    if (epoch < e.current.root_epoch) return e;
    const prior = typeof e.excluded_at_epoch === "number" ? e.excluded_at_epoch : -Infinity;
    return { ...e, excluded_at_epoch: Math.max(prior, epoch) };
  });
  return { ...list, entries };
}

/**
 * Replace a membership's `current` snapshot (e.g. an adopted Refounding),
 * bypassing `freshest` so a same-epoch update can't lose the tiebreak. Bumps
 * `added_at`: holding a fresh epoch key proves membership, so a re-included
 * member beats their old tombstone. Can't undo a leave: callers only run on a
 * mounted page, and `useCommunityEntry` resolves live entries only. Pure.
 */
export function refreshCurrent(list: CommunityList, current: JoinMaterial, addedAt = Date.now()): CommunityList {
  const idx = list.entries.findIndex((e) => e.community_id === current.community_id);
  if (idx === -1) return list;
  const entries = list.entries.map((e, i) => {
    if (i !== idx) return e;
    const next: CommunityListEntry = { ...e, current, added_at: Math.max(e.added_at, addedAt) };
    // Holding the marked epoch's key (or later) spends the exclusion marker.
    if (typeof next.excluded_at_epoch === "number" && next.excluded_at_epoch <= current.root_epoch) {
      delete next.excluded_at_epoch;
    }
    return next;
  });
  return { ...list, entries };
}

/**
 * Replace a membership's private-channel set inside `current` (a channel rekey
 * adoption or exclusion, CORD-06 §2). Never bumps `added_at`. Caveat (CORD-02 §8):
 * same-root-epoch snapshots tie-break on bytes, so a stale sibling can win until
 * the watcher re-adopts. Excluded keys survive in `seed`. Pure.
 */
export function refreshChannels(
  list: CommunityList,
  communityId: string,
  channels: JoinMaterial["channels"],
  /** Channels REMOVED by a rotation, with its channel epoch — recorded as `channel_cuts` floors. */
  cuts?: CommunityListEntry["channel_cuts"],
): CommunityList {
  const idx = list.entries.findIndex((e) => e.community_id === communityId);
  if (idx === -1) return list;
  const entries = list.entries.map((e, i) => {
    if (i !== idx) return e;
    const channelCuts = mergeChannelCuts(e.channel_cuts, cuts);
    const next: CommunityListEntry = {
      ...e,
      current: { ...e.current, channels: applyChannelCuts(channels, channelCuts) },
    };
    if (channelCuts) next.channel_cuts = channelCuts;
    return next;
  });
  return { ...list, entries };
}

/**
 * Replace a membership's relay set inside `current`, following the Metadata fold
 * (CORD-02 §6). Never bumps `added_at`; same merge caveat as
 * {@link refreshChannels}. `seed` untouched. Pure.
 */
export function refreshRelays(list: CommunityList, communityId: string, relays: string[]): CommunityList {
  const idx = list.entries.findIndex((e) => e.community_id === communityId);
  if (idx === -1) return list;
  const entries = list.entries.map((e, i) => (i === idx ? { ...e, current: { ...e.current, relays } } : e));
  return { ...list, entries };
}

/**
 * Record the staff write secret for the CURRENT epoch (a verified `control_wrap`
 * adoption, CORD-04 §3); a stale epoch is a no-op. Never bumps `added_at`; same
 * merge caveat as {@link refreshChannels}. Pure.
 */
export function setControlRoot(
  list: CommunityList,
  communityId: string,
  epoch: number,
  controlRootHex: string,
): CommunityList {
  const idx = list.entries.findIndex((e) => e.community_id === communityId);
  if (idx === -1) return list;
  const entries = list.entries.map((e, i) => {
    if (i !== idx) return e;
    if (e.current.root_epoch !== epoch || typeof e.current.control_pk !== "string") return e;
    return { ...e, current: { ...e.current, control_root: controlRootHex } };
  });
  return { ...list, entries };
}

/**
 * Rehydrate a {@link Community} from an entry, verifying the owner commitment
 * (fails closed). `extraRelays` must NOT be app/platform relays: a relay with no
 * Concord wraps answers instantly empty and starves the real ones.
 */
export function rehydrateCommunity(entry: CommunityListEntry, extraRelays: string[] = []): Community | undefined {
  const jm = entry.current;
  try {
    if (!verifyCommunityId(jm.community_id, jm.owner, jm.owner_salt)) return undefined;
    const id = hex32(jm.community_id);
    const root = hex32(jm.community_root);
    const rootEpoch = BigInt(jm.root_epoch);

    const asRefounder = (v: unknown): string | undefined =>
      typeof v === "string" && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : undefined;
    const asHex32 = asRefounder; // same shape: 64 lowercase-hex chars
    // Retained roots carry their own refounder, so snapshot authority survives.
    const currentRefounder = asRefounder(jm.refounder);
    const controlPk = asHex32(jm.control_pk);
    const heldRoots: HeldRoot[] = [
      {
        epoch: rootEpoch,
        key: root,
        ...(currentRefounder ? { refounder: currentRefounder } : {}),
        ...(controlPk ? { controlPk } : {}),
      },
    ];
    for (const hr of jm.held_roots ?? []) {
      try {
        const epoch = BigInt(hr.epoch);
        if (epoch === rootEpoch) continue;
        const retiredAt =
          typeof hr.retired_at === "number" && Number.isFinite(hr.retired_at) && hr.retired_at > 0
            ? Math.floor(hr.retired_at)
            : undefined;
        const refounder = asRefounder(hr.refounder);
        const hrControlPk = asHex32(hr.control_pk);
        heldRoots.push({
          epoch,
          key: hex32(hr.key),
          ...(retiredAt !== undefined ? { retiredAt } : {}),
          ...(refounder ? { refounder } : {}),
          ...(hrControlPk ? { controlPk: hrControlPk } : {}),
        });
      } catch { /* ignore */ }
    }
    // Keep the write secret only if it derives to this epoch's address; otherwise
    // fail closed to read-only (CORD-02 §5).
    let controlRoot: Uint8Array | undefined;
    if (controlPk && asHex32(jm.control_root)) {
      const candidate = hex32(jm.control_root as string);
      if (controlSignerGroupKey(candidate, id, rootEpoch).pk === controlPk) controlRoot = candidate;
    }
    // Also anchor the seed's root when it's an epoch we don't otherwise hold.
    if (entry.seed && entry.seed.community_root && entry.seed.root_epoch !== jm.root_epoch) {
      try {
        const seedEpoch = BigInt(entry.seed.root_epoch);
        if (!heldRoots.some((r) => r.epoch === seedEpoch)) {
          heldRoots.push({ epoch: seedEpoch, key: hex32(entry.seed.community_root) });
        }
      } catch { /* ignore */ }
    }
    heldRoots.sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));

    const privateChannels: PrivateChannelKey[] = [];
    for (const ch of heldChannelKeys(jm.channels)) {
      try {
        const priors: PrivateChannelKey["priors"] = [];
        for (const prior of Array.isArray(ch.priors) ? ch.priors : []) {
          try {
            const retiredAt =
              typeof prior.retired_at === "number" && Number.isFinite(prior.retired_at) && prior.retired_at > 0
                ? Math.floor(prior.retired_at)
                : undefined;
            priors.push({
              key: hex32(prior.key),
              epoch: BigInt(prior.epoch),
              ...(retiredAt !== undefined ? { retiredAt } : {}),
            });
          } catch {
            // skip a malformed prior; the current key still stands
          }
        }
        privateChannels.push({
          id: hex32(ch.id),
          key: hex32(ch.key),
          epoch: BigInt(ch.epoch),
          name: typeof ch.name === "string" ? ch.name : "",
          ...(priors.length > 0 ? { priors } : {}),
        });
      } catch { /* ignore */ }
    }

    return {
      id,
      idHex: jm.community_id.toLowerCase(),
      owner: jm.owner.toLowerCase(),
      ownerSalt: hex32(jm.owner_salt),
      root,
      rootEpoch,
      ...(controlPk ? { controlPk } : {}),
      ...(controlRoot ? { controlRoot } : {}),
      heldRoots,
      privateChannels,
      relays: capRelays([...(Array.isArray(jm.relays) ? jm.relays : []), ...extraRelays]),
      name: typeof jm.name === "string" ? jm.name : "",
      refounder: typeof jm.refounder === "string" && /^[0-9a-f]{64}$/i.test(jm.refounder) ? jm.refounder.toLowerCase() : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Serialize held private-channel keys for a `refresh-channels` write. `priors`
 * must ride along (CORD-03 §3), since `refreshChannels` REPLACES the array.
 */
export function channelKeysToWire(chs: PrivateChannelKey[]): JoinMaterial["channels"] {
  return chs.map((c) => ({
    id: bytesToHex(c.id),
    key: bytesToHex(c.key),
    epoch: Number(c.epoch),
    name: c.name,
    ...(c.priors?.length
      ? {
          priors: c.priors.map((p) => ({
            key: bytesToHex(p.key),
            epoch: Number(p.epoch),
            ...(p.retiredAt !== undefined ? { retired_at: p.retiredAt } : {}),
          })),
        }
      : {}),
  }));
}

/**
 * The channel epoch a privatisation must mint at (CORD-03 §2): one past the
 * highest generation EVER used (1 if never private). Monotonic, so stale keys are
 * always lower and merges/`channel_cuts` can tell generations apart.
 * `observedFloor` (`highestRotatedEpoch`, from CORD-06 §2 rekey addresses) covers
 * a privatiser who never held earlier generations.
 */
export function nextChannelEpoch(
  held: PrivateChannelKey[],
  channelIdHex: string,
  observedFloor = 0n,
): bigint {
  const wanted = channelIdHex.toLowerCase();
  let highest = observedFloor;
  const mine = held.find((c) => bytesToHex(c.id) === wanted);
  if (mine) {
    if (mine.epoch > highest) highest = mine.epoch;
    for (const p of mine.priors ?? []) if (p.epoch > highest) highest = p.epoch;
  }
  return highest + 1n;
}

/** Snapshot a runtime community back into join material (for `current`). */
export function toJoinMaterial(c: Community, opts?: { relays?: string[]; prior?: JoinMaterial }): JoinMaterial {
  const heldRoots = c.heldRoots
    .filter((r) => r.epoch !== c.rootEpoch)
    .map((r) => ({
      epoch: Number(r.epoch),
      key: bytesToHex(r.key),
      ...(r.retiredAt !== undefined ? { retired_at: r.retiredAt } : {}),
      ...(r.refounder ? { refounder: r.refounder } : {}),
      ...(r.controlPk ? { control_pk: r.controlPk } : {}),
    }));
  const jm: JoinMaterial = {
    // Round-trip unknown fields from the prior snapshot (CORD-02 §6/§8).
    ...(opts?.prior ?? {}),
    community_id: c.idHex,
    owner: c.owner,
    owner_salt: bytesToHex(c.ownerSalt),
    community_root: bytesToHex(c.root),
    root_epoch: Number(c.rootEpoch),
    channels: channelKeysToWire(c.privateChannels),
    relays: opts?.relays ?? (opts?.prior?.relays as string[] | undefined) ?? [],
    name: c.name,
    ...(heldRoots.length > 0 ? { held_roots: heldRoots } : {}),
    ...(c.refounder ? { refounder: c.refounder } : {}),
  };
  // Written or deleted, never inherited from `prior` across epochs.
  if (c.controlPk) jm.control_pk = c.controlPk;
  else delete jm.control_pk;
  if (c.controlPk && c.controlRoot) jm.control_root = bytesToHex(c.controlRoot);
  else delete jm.control_root;
  return jm;
}
