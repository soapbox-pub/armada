/**
 * Concord Control Plane — CORD-02 §5/§6/§9, CORD-04. One Private Stream per
 * Community of versioned, real-npub-signed editions in PLAINTEXT seals (kind
 * 20014, so compaction can re-wrap them). The stream key is SPLIT (CORD-01
 * Write-Restricted Streams): address + signer derive from the staff-held
 * `control_root`; content is encrypted under the community_root-derived read key
 * (a spam gate, never authority). Pre-split epochs used `concord/control` alone.
 *
 * `foldControlState` replays the plane in one pass: the owner-rooted roster first
 * (the owner's rank comes from the community_id), then every gated entity.
 */

import { parseStrictStringArray } from "@/concord/lib/strictJson";
import type { NostrEvent } from "nostr-tools/pure";
import { clockNowMs } from "@/lib/relayClock";

import {
  banlistLocator,
  bytesToHex,
  controlGroupKey,
  controlSignerGroupKey,
  dissolvedGroupKey,
  editionBinding,
  everyoneLocator,
  grantLocator,
  syncLocator,
  writersLocator,
  hex32,
  inviteLinksLocator,
  signalLocator,
  type GroupKey,
  type StreamKeyView,
} from "@/concord/lib/derive";
import {
  buildEditionRumor,
  parseEdition,
  toFoldEdition,
  type AuthorityCitation,
  type ParsedEdition,
} from "@/concord/lib/edition";
import {
  KIND_SEAL_PLAINTEXT,
  SIGNAL_PAUSE,
  VSK_BANLIST,
  VSK_CHANNEL,
  VSK_DISSOLVED,
  VSK_GRANT,
  VSK_INVITE_REGISTRY,
  VSK_METADATA,
  VSK_PINS,
  VSK_ROLE,
  VSK_SIGNALS,
} from "@/concord/lib/kinds";
import {
  canActOnMember,
  emptyRoles,
  grantFromJSON,
  grantToJSON,
  hasPermission,
  highestPosition,
  isAuthorized,
  MAX_ROLES_PER_COMMUNITY,
  Permissions,
  permissionsAbove,
  roleFromJSON,
  roleToJSON,
  BENEATH_EVERY_ROLE,
  type CommunityRoles,
  type MemberGrant,
  type Overwrite,
  type Role,
} from "@/concord/lib/roles";
import {
  ALWAYS_MARKED_VSKS,
  VSK_ACL,
  VSK_RANKED_ROLE,
  VSK_TENURE,
  VSK_CATEGORY,
  VSK_SYNC,
  VSK_WRITERS,
  cutName,
  foldRankedRoster,
  isListed,
  maySwapOverwrites,
  overwriteAuthorized,
  overwriteLocator,
  parseOverwrite,
  parseSync,
  permissionsAboveIn,
  rosterActivated,
  AUTHORITY_VSKS,
  sealOf,
  type RosterFloors,
  type SealedBy,
} from "@/concord/lib/roster";
import { isRankKey } from "@/concord/lib/rankKey";
import { ledgerExtends, parseLedger, type Ledger } from "@/concord/lib/writers";
import { buildRumor, openWrap, sealRumor, wrapSeal, type OpenedEvent, type StreamSigner } from "@/concord/lib/stream";
import { readFoldedShared } from "@/lib/foldedCache";
import type { NostrRumor } from "@/lib/nostrRumor";
import { openChannelSeal, sanitizeChannelFields } from "@/concord/lib/channelSeal";
import { perfCount } from "@/lib/perf";
import { t } from "@/i18n/intl";
import {
  utf8Len,
  DESCRIPTION_MAX_BYTES,
  NAME_MAX_BYTES,
  capRelays,
  isImagePointer,
  type ChannelMetadata,
  type CommunityMetadata,
  type Community,
  type PrivateChannelKey,
} from "@/concord/lib/types";
import { bootstrapHead, bytesEq, fold } from "@/concord/lib/version";

/**
 * One held root epoch's Control Plane read view (CORD-02 §5). SPLIT epoch: held
 * `control_pk` address + community_root-derived read key, `sk` only for staff
 * whose `control_root` derives to that address. LEGACY epoch: the
 * `concord/control` derivation whole, held by every member.
 */
function controlStreamOf(community: Community, rootKey: Uint8Array, epoch: bigint, controlPk?: string): StreamKeyView {
  const read = controlGroupKey(rootKey, community.id, epoch);
  if (!controlPk) return read;
  const signerSk =
    community.controlRoot !== undefined && epoch === community.rootEpoch
      ? controlSignerGroupKey(community.controlRoot, community.id, epoch)
      : undefined;
  return {
    pk: controlPk,
    get convKey() {
      return read.convKey;
    },
    // The reader's half of the write gate: openWrap verifies the wrap signature
    // (CORD-01; CORD-02 §5).
    restricted: true,
    // A secret not deriving to the held address is corrupt: fail closed to read-only.
    ...(signerSk && signerSk.pk === controlPk ? { sk: signerSk.sk } : {}),
  };
}

/** Every control-plane stream view across the community's held root epochs, newest first. */
export function controlGroups(community: Community): StreamKeyView[] {
  return community.heldRoots.map((r) => controlStreamOf(community, r.key, r.epoch, r.controlPk));
}

/** The CURRENT control-plane stream view (address + read key; `sk` when writable). */
export function currentControlGroup(community: Community): StreamKeyView {
  return controlStreamOf(community, community.root, community.rootEpoch, community.controlPk);
}

/** Whether this member can PUBLISH to the current Control Plane (CORD-02 §2). */
export function canWriteControl(community: Community): boolean {
  return currentControlGroup(community).sk !== undefined;
}

/**
 * The CURRENT control-plane WRITE key. Throws on a split epoch without a held
 * `control_root`, since such a wrap fails every reader's check (CORD-02 §2).
 */
export function currentControlWriteGroup(community: Community): GroupKey {
  const stream = currentControlGroup(community);
  const sk = stream.sk;
  if (sk === undefined) {
    throw new Error(
      t({
        id: "concordControl.noWriteKey",
        defaultMessage: "Only community staff hold this community's write key; ask a moderator to re-send it.",
      }),
    );
  }
  return {
    sk,
    pk: stream.pk,
    get convKey() {
      return stream.convKey;
    },
  };
}

/** Sign (plaintext seal) + wrap one edition rumor for the control stream. */
export async function sealEdition(rumor: NostrRumor, control: GroupKey, signer: StreamSigner): Promise<NostrEvent> {
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, signer);
  return wrapSeal(seal, control);
}

/**
 * Decode-once memo of opened+parsed control editions by wrap id; `null` remembers
 * a failure.
 */
const parsedEditionMemo = new Map<string, ParsedEdition | null>();

/** FIFO ceiling; a recompute cache, so eviction only re-pays a parse. */
const PARSED_EDITION_MEMO_CAP = 20_000;

/** Record a parsed edition, evicting oldest-first at the cap. All writes route here. */
function rememberEdition(id: string, parsed: ParsedEdition | null): void {
  if (!parsedEditionMemo.has(id) && parsedEditionMemo.size >= PARSED_EDITION_MEMO_CAP) {
    const oldest = parsedEditionMemo.keys().next();
    if (!oldest.done) parsedEditionMemo.delete(oldest.value);
  }
  parsedEditionMemo.set(id, parsed);
}

/** Open every control wrap that decodes under one of `groups` into editions. */
export function openControlWraps(wraps: NostrEvent[], groups: StreamKeyView[]): ParsedEdition[] {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: ParsedEdition[] = [];
  for (const wrap of wraps) {
    const cached = parsedEditionMemo.get(wrap.id);
    if (cached !== undefined) {
      if (cached) out.push(cached);
      continue;
    }
    const group = byPk.get(wrap.pubkey);
    if (!group) continue; // an epoch we don't hold — leave uncached (a caught-up rekey may open it)
    let parsed: ParsedEdition | null = null;
    try {
      parsed = parseEdition(openWrap(wrap, group));
    } catch {
      parsed = null;
    }
    rememberEdition(wrap.id, parsed);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Parse already-OPENED control events into editions (memoized per rumor id). */
export function openControlEditions(opened: OpenedEvent[]): ParsedEdition[] {
  const start = performance.now();
  const out: ParsedEdition[] = [];
  for (const ev of opened) {
    const cached = parsedEditionMemo.get(ev.rumorId);
    if (cached !== undefined) {
      if (cached) out.push(cached);
      continue;
    }
    let parsed: ParsedEdition | null = null;
    try {
      parsed = parseEdition(ev);
    } catch {
      parsed = null;
    }
    rememberEdition(ev.rumorId, parsed);
    if (parsed) out.push(parsed);
  }
  perfCount("fold.openControlEditions", performance.now() - start, opened.length, "editions");
  return out;
}

/** Empty the parsed-edition and fold memos (decrypted state), i.e. what a reload does. Logout. */
export function clearControlMemos(): void {
  parsedEditionMemo.clear();
  foldMemo.clear();
}

/** Test seam. */
export const _resetControlMemosForTests = clearControlMemos;

/** Test seam: current parsed-edition memo entry count, for the unbounded-growth guard. */
export function _parsedEditionMemoSizeForTests(): number {
  return parsedEditionMemo.size;
}

interface BuildCommon {
  actorPubkey: string;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs?: number;
  authority?: AuthorityCitation;
}

/** Community metadata (vsk 0); eid = the community_id. Gated by MANAGE_METADATA. */
export function buildMetadataEdition(communityId: Uint8Array, metadata: CommunityMetadata, o: BuildCommon): NostrRumor {
  if (utf8Len(metadata.name) > NAME_MAX_BYTES) throw new Error(`community name exceeds ${NAME_MAX_BYTES} bytes`);
  if (metadata.description !== undefined && utf8Len(metadata.description) > DESCRIPTION_MAX_BYTES) {
    throw new Error(`description exceeds ${DESCRIPTION_MAX_BYTES} bytes`);
  }
  return buildEditionRumor({ vsk: VSK_METADATA, entityId: communityId, content: JSON.stringify(metadata), ...o });
}

/** Role (vsk 1); eid = the role_id. Gated by MANAGE_ROLES. */
export function buildRoleEdition(role: Role, o: BuildCommon): NostrRumor {
  if (utf8Len(role.name) > NAME_MAX_BYTES) throw new Error(`role name exceeds ${NAME_MAX_BYTES} bytes`);
  // CORD-04 §3: position 0 is the owner's alone; refuse at the author rather than
  // have every verifier drop it.
  if (!Number.isInteger(role.position) || role.position < 1) {
    throw new Error("role position must be an integer of 1 or greater (position 0 is the owner's)");
  }
  return buildEditionRumor({ vsk: VSK_ROLE, entityId: hex32(role.roleId), content: roleToJSON(role), ...o });
}

/** Channel metadata (vsk 2); eid = the channel_id. Gated by MANAGE_CHANNELS. */
export function buildChannelEdition(channelId: Uint8Array, metadata: ChannelMetadata, o: BuildCommon): NostrRumor {
  if (utf8Len(metadata.name) > NAME_MAX_BYTES) throw new Error(`channel name exceeds ${NAME_MAX_BYTES} bytes`);
  return buildEditionRumor({ vsk: VSK_CHANNEL, entityId: channelId, content: JSON.stringify(metadata), ...o });
}

/** Channel metadata (vsk 2) carrying already-built content: the sealed form (CORD-03 §2). */
export function buildChannelContentEdition(channelId: Uint8Array, content: string, o: BuildCommon): NostrRumor {
  return buildEditionRumor({ vsk: VSK_CHANNEL, entityId: channelId, content, ...o });
}

/** Grant (vsk 3); eid = grant_locator(cid, member). Empty role_ids = a revoke. */
export function buildGrantEdition(communityId: Uint8Array, grant: MemberGrant, o: BuildCommon): NostrRumor {
  const entityId = grantLocator(communityId, hex32(grant.member));
  return buildEditionRumor({ vsk: VSK_GRANT, entityId, content: grantToJSON(grant), ...o });
}

/** Banlist (vsk 4); eid = banlist_locator(cid). The whole list, replaced entire. */
export function buildBanlistEdition(communityId: Uint8Array, banned: string[], o: BuildCommon): NostrRumor {
  // Readers fold the first 500, so a longer list would silently leave the rest unbanned (CORD-04 §4).
  if (banned.length > MAX_BANLIST) {
    throw new Error(t({ id: "concordControl.banlistFull", defaultMessage: "The ban list holds at most {max} members. Unban someone first." }, { max: MAX_BANLIST }));
  }
  return buildEditionRumor({
    vsk: VSK_BANLIST,
    entityId: banlistLocator(communityId),
    content: JSON.stringify(banned),
    ...o,
  });
}

/** Invite Registry (vsk 8); eid = invite_links_locator(cid, creator). Locators only. */
export function buildRegistryEdition(communityId: Uint8Array, creatorHex: string, linkSigners: string[], o: BuildCommon): NostrRumor {
  return buildEditionRumor({
    vsk: VSK_INVITE_REGISTRY,
    entityId: inviteLinksLocator(communityId, hex32(creatorHex)),
    content: JSON.stringify(linkSigners),
    ...o,
  });
}

/**
 * Community Signal (vsk 12); eid = signal_locator(cid, signal_id) (CORD-04 §8). The
 * pause is `signal_id` "pause" with content `{ paused, until? }`, MANAGE_CHANNELS.
 */
export function buildSignalsEdition(
  communityId: Uint8Array,
  signalId: string,
  content: Record<string, unknown>,
  o: BuildCommon,
): NostrRumor {
  return buildEditionRumor({
    vsk: VSK_SIGNALS,
    entityId: signalLocator(communityId, signalId),
    content: JSON.stringify(content),
    ...o,
  });
}

export interface EntityHead {
  version: bigint;
  hash: Uint8Array;
  /** The head's rumor id, so a same-version rival is judged against it (CORD-04 §1). */
  rumorId?: string;
  /** The head's signer. */
  author?: string;
  /** The kind of entity it heads, so a floor of one family never floors another (Vector's floor families). */
  vsk?: string;
  /** Below the held head, because the held one was refused: a floor keeper LOWERS its floor to it (Vector `rebase`). */
  rebased?: boolean;
}

/** A deleted Channel's or Category's head is its newest deletion, lowest id at a tie (Vector `apply_control_fold`). */
function settleOnDeletion(eid: string, deletions: ParsedEdition[], heads: Map<string, EntityHead>, headEditions: Map<string, ParsedEdition>): void {
  const head = deletions.reduce<ParsedEdition | undefined>((best, p) => {
    if (!best || p.version > best.version) return p;
    if (p.version === best.version && bytesToHex(p.rumorId) < bytesToHex(best.rumorId)) return p;
    return best;
  }, undefined);
  if (!head) return;
  heads.set(eid, headOf(head));
  headEditions.set(eid, head);
}

/**
 * One head per coordinate, where the Roster's keeps its slot against another family's
 * (Vector's floor rows: an authority row is never replaced by another family's, and replaces one).
 */
export class HeadSlots<V extends { vsk?: string }> extends Map<string, V> {
  override set(key: string, value: V): this {
    const prev = this.get(key);
    if (prev?.vsk !== undefined && AUTHORITY_VSKS.has(prev.vsk) && !(value.vsk !== undefined && AUTHORITY_VSKS.has(value.vsk))) return this;
    return super.set(key, value);
  }
}

function headOf(p: ParsedEdition, rebased = false): EntityHead {
  return { version: p.version, hash: p.selfHash, rumorId: bytesToHex(p.rumorId), author: p.author, vsk: p.vsk, ...(rebased ? { rebased: true } : {}) };
}

/**
 * What a tracking reader settled on in its last fold, for what a withheld head
 * leaves unknown: `@everyone`'s bits and the legacy Channel list (CORD-04 §2), and
 * the Banlist (§4: a withheld head never un-bans).
 */
export interface StoredControl {
  everyone?: bigint;
  legacyChannels?: string[];
  banned?: Iterable<string>;
  /** Overwrites and syncs held, for a floored one a relay stops serving (Vector keeps them). */
  overwrites?: Overwrite[];
  syncs?: Record<string, string>;
  /**
   * Ban marks: per npub, the `created_at` (seconds) of the newest admissible Banlist
   * edition naming them, merged to the later time and never forgotten, since a fold sees
   * only the editions in its window (Vector `merge_community_ban_marks`).
   */
  banMarks?: Record<string, number>;
  /** The Channels and Categories folded, held for a floored one a relay stops serving (Vector keeps them). */
  channels?: FoldedChannel[];
  categories?: FoldedCategory[];
  /**
   * The Private Channel keys the reader holds, to open sealed heads for their
   * `creator` (CORD-04 §8): known only to key holders, as in Vector's fold.
   */
  heldChannels?: readonly PrivateChannelKey[];
  /** The Writers ledgers held, their head content by entity id, for one a relay stops serving (Vector's anchor). */
  writers?: Record<string, string>;
  /** The Roster entities the reader holds, which a fold tracks for being whole (see `StoredRoster`). */
  roleIds?: string[];
  grantees?: string[];
  roleManagers?: string[];
}

/** The {@link StoredControl} a fold leaves for the next one. */
export function storedControlOf(
  folded: FoldedControl | undefined,
  prior?: Pick<StoredControl, "banMarks">,
): Omit<StoredControl, "heldChannels"> | undefined {
  if (!folded) return undefined;
  const banMarks: Record<string, number> = { ...prior?.banMarks };
  // A fold restored from an older build, or a partial one, may carry no ban history.
  if (folded.bannedAt instanceof Map) for (const [pk, at] of folded.bannedAt) if (!(banMarks[pk] >= at)) banMarks[pk] = at;
  return {
    ...(Object.keys(banMarks).length > 0 ? { banMarks } : {}),
    ...(folded.channels instanceof Map && folded.channels.size > 0 ? { channels: [...folded.channels.values()] } : {}),
    ...(folded.categories instanceof Map && folded.categories.size > 0 ? { categories: [...folded.categories.values()] } : {}),
    ...(folded.roster.everyone !== undefined ? { everyone: folded.roster.everyone } : {}),
    ...(folded.roster.legacyChannels ? { legacyChannels: folded.roster.legacyChannels } : {}),
    banned: folded.banned,
    ...(folded.roster.overwrites ? { overwrites: folded.roster.overwrites } : {}),
    ...(folded.roster.syncs ? { syncs: folded.roster.syncs } : {}),
    ...(folded.ledgerContents instanceof Map && folded.ledgerContents.size > 0 ? { writers: Object.fromEntries(folded.ledgerContents) } : {}),
    ...rosterHeld(folded.roster),
  };
}

/** The Roles, Grantees and MANAGE_ROLES Grantees of a folded Roster, sorted (Vector's stored roster). */
function rosterHeld(roster: CommunityRoles): Pick<StoredControl, "roleIds" | "grantees" | "roleManagers"> {
  const grantees = [...new Set(roster.grants.map((g) => g.member))].sort();
  return {
    roleIds: [...new Set(roster.roles.map((r) => r.roleId))].sort(),
    grantees,
    roleManagers: grantees.filter((m) => hasPermission(roster, m, Permissions.MANAGE_ROLES)),
  };
}

function sameTarget(a: Overwrite["target"], b: Overwrite["target"]): boolean {
  return a.kind === b.kind && (a.kind === "everyone" || (a as { id: string }).id === (b as { id: string }).id);
}

export interface FoldedChannel {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  deleted: boolean;
  /** Full normalized metadata, retained so mutations can round-trip extensions. */
  metadata: ChannelMetadata;
  /**
   * A Private Channel's SEALED metadata (CORD-03 §2): readable only with the
   * Channel's key at `epoch`, so `name` and the rest stay empty until a holder opens it.
   */
  sealed?: SealedChannelMeta;
}

/** A Private Channel's sealed form as carried (CORD-03 §2). */
export interface SealedChannelMeta {
  epoch: bigint;
  /** NIP-44 v2 payload under the Channel's conversation key at `epoch`. */
  sealed: string;
  /** The carrying edition's predecessor hash, which the seal must name as `prev`. */
  prevHex?: string;
}

/** A Category (vsk 15, CORD-03 §4). */
export interface FoldedCategory {
  idHex: string;
  name: string;
  /** Rank key ordering Categories among themselves; absent sorts after every keyed one. */
  position?: string;
  deleted: boolean;
  /** Unknown fields, round-tripped by an editor. */
  extra: Record<string, unknown>;
}

/** Where a community's folded control snapshot is cached (`foldedCache`); here so non-React code can import it. */
export const controlFoldKey = (idHex: string) => `concord2-fold:${idHex}`;

/** One folded Community Signal head (vsk 12, CORD-04 §8). */
export interface FoldedSignal {
  /** The head's decoded content, validated for this signal_id. */
  content: Record<string, unknown>;
  /** The authorized author of the head edition. */
  author: string;
  /** The head edition's `created_at` in SECONDS — a pause's enactment time. */
  at: number;
}

/** The Control Plane replayed into current state. */
export interface FoldedControl {
  roster: CommunityRoles;
  /** The proven owner (from the community_id commitment) — position 0, supreme. */
  ownerHex: string;
  metadata?: CommunityMetadata;
  /** channelIdHex → folded definition (deleted channels included, flagged). */
  channels: Map<string, FoldedChannel>;
  banned: Set<string>;
  /** Aggregate live public-invite link signers (the Public/Private source of truth). */
  liveInviteLinks: Set<string>;
  /** creatorHex → that creator's own registry list (for maintaining one's registry). */
  registriesByCreator: Map<string, string[]>;
  /**
   * Pin Lists (vsk 11) by `pins_locator` eid → the head's RAW content (decoding
   * needs a Channel key). Unreadable or cap-violating lists read as EMPTY (CORD-04 §7).
   */
  pinLists: Map<string, { content: string; author: string }>;
  /**
   * Community Signals (vsk 12, CORD-04 §8) by signal_id; absent = inactive. Only
   * signal_ids this build implements can appear (unknown ones are never
   * coordinate-derived).
   */
  signals: Map<string, FoldedSignal>;
  /** Per-entity head version + hash, for chaining the next edition (key = eid hex). */
  heads: Map<string, EntityHead>;
  /** The chosen head EDITION per entity (eid hex), carrying the seal compaction republishes. */
  headEditions: Map<string, ParsedEdition>;
  /**
   * Floored entities the served set couldn't account for (gap-held, or zero served
   * editions) — data availability ONLY; authority-rejected entities are absent. A
   * Refounding MUST NOT compact while non-empty (CORD-06 §3).
   */
  incomplete: string[];
  /**
   * npub → created_at (SECONDS) of the newest AUTHORIZED banlist edition naming
   * them, so a Join predating their latest ban doesn't resurface as a phantom
   * member. Same authority gate as `banned`.
   */
  bannedAt: Map<string, number>;
  /**
   * On the vsk-13 Roster (CORD-04 §2): `roster.everyone` stands, and Categories,
   * overwrites and syncs fold. Absent on a snapshot from an earlier build.
   */
  rankedRoster?: boolean;
  /** Categories by id (CORD-03 §4), deleted ones included and flagged; empty off the vsk-13 Roster. */
  categories?: Map<string, FoldedCategory>;
  /** Each member's sealed standings (CORD-04 §9), from the Tenures the fold admits. */
  tenure?: SealedBy;
  /** Restricted Channels' Writers ledgers (CORD-03 §1), by Channel id. */
  writers?: Map<string, Ledger>;
  /** Each Writers ledger's head content, by entity id, for the next fold's anchor (see {@link StoredControl}). */
  ledgerContents?: Map<string, string>;
  /** On the vsk-13 Roster: whether every Roster entity it tracks served its held head (Vector's `complete`). */
  rosterComplete?: boolean;
  /** The `@everyone` head was served, not stood in for by the bits held before (Vector `everyone_served`). */
  everyoneServed?: boolean;
}

/**
 * Whether a snapshot decoded off disk still has the shape this build reads.
 * `readFolded` casts unchecked, so a stale shape must miss rather than crash a
 * reader; that costs one re-fold. Extend this when readers rely on a new field.
 */
export function isCurrentFoldedControl(value: unknown): value is FoldedControl {
  const fold = value as FoldedControl | undefined;
  if (!fold || !(fold.channels instanceof Map) || !(fold.heads instanceof Map)) return false;
  // Check every Map: a snapshot predating `pinLists` must MISS, not read as "nothing
  // pinned", or a write could replace entries it never saw (CORD-04 §7).
  if (!(fold.pinLists instanceof Map)) return false;
  // Likewise `signals`, or pause enforcement throws on boot.
  if (!(fold.signals instanceof Map)) return false;
  for (const def of fold.channels.values()) {
    if (!def || typeof def.metadata !== "object" || def.metadata === null) return false;
  }
  return true;
}

/** A community's cached control fold; undefined on a miss or an unreadable shape. */
export async function readControlFold(idHex: string): Promise<FoldedControl | undefined> {
  // Shared: folds are never mutated (see readFoldedShared).
  const folded = await readFoldedShared<FoldedControl>(controlFoldKey(idHex));
  return isCurrentFoldedControl(folded) ? folded : undefined;
}

function pushEdition(m: Map<string, ParsedEdition[]>, key: string, p: ParsedEdition) {
  const list = m.get(key);
  if (list) list.push(p);
  else m.set(key, [p]);
}

/** Which editions may decide an entity's chain (see headCandidates). */
interface HeadAdmit {
  admit: (p: ParsedEdition) => boolean;
  mode: "filter" | "retry";
  /** Authority order at a fork, for whether a rival beats a withheld held head. */
  rankOf?: (author: string) => number;
}

/**
 * The editions `admit` keeps, plus every edition a kept one builds on
 * (transitively): an author who has since lost the permission still wrote a real
 * link of the chain, and the authorized edition citing it as `prev` vouches for it.
 */
function admittedChain(editions: ParsedEdition[], admit: (p: ParsedEdition) => boolean): ParsedEdition[] {
  const kept = new Set(editions.filter(admit));
  let frontier = [...kept];
  while (frontier.length > 0) {
    const cited = new Set(frontier.flatMap((e) => (e.prevHash ? [bytesToHex(e.prevHash)] : [])));
    frontier = editions.filter((e) => !kept.has(e) && cited.has(bytesToHex(e.selfHash)));
    for (const e of frontier) kept.add(e);
  }
  return kept.size === editions.length ? editions : editions.filter((e) => kept.has(e));
}

/**
 * Fold one entity's editions into an ORDERED candidate list: the chain-verified
 * fold head first, then every other edition version-DESCENDING (tiebreak winner
 * first). The caller takes the first passing its authority gate, since
 * "the highest authority-verified head" (CORD-04 §1) needs gating before choosing.
 * Equal-version fork siblings are all kept: the rumor-id tiebreak is grindable.
 *
 * `floor` is a tracking client's last-accepted head: if the served chain doesn't
 * reach it (withheld middle), report a GAP and drop everything above the floor
 * (fail closed, CORD-04 §1). A fresh joiner (no floor) accepts a dangling `prev`
 * (compaction bootstrap).
 *
 * `snapshot` (post-Refounding): the entity folds by BOOTSTRAP (highest signed
 * version, floor as version-only refuse-downgrade), never the chain walk. A re-wrap
 * can't raise the signed version, so a re-served stale edition always loses.
 *
 * `admit` keeps junk out of gap detection: any keyholder can seal a skipped
 * version, and counting it would freeze the entity for tracking clients and
 * abort every rotation. With `filter`, editions it refuses never enter the walk
 * (Vector's authority pre-filter) unless an admitted one builds on them
 * ({@link admittedChain}); everything served at/above the floor being
 * refused is a rejection, not withholding. With `retry` (roles and grants,
 * whose authority isn't settled yet), the filtered walk is used only when it
 * closes a gap the full one hit.
 */
function headCandidates(
  editions: ParsedEdition[],
  floor?: EntityHead,
  snapshot?: ParsedEdition[],
  onGap?: () => void,
  admit?: HeadAdmit,
  ownerHex?: string,
): ParsedEdition[] {
  const ordered: ParsedEdition[] = [];
  const seenRumors = new Set<string>();
  let gapped = false;
  let prefix: Set<ParsedEdition> | undefined;
  let walked = admit?.mode === "filter" ? admittedChain(editions, admit.admit) : editions;
  // Junk above a SERVED floor head is a rejection; with the head itself missing it was withheld.
  const refusedAtFloor = (): boolean =>
    floor !== undefined &&
    walked.length < editions.length &&
    editions.some((e) => e.version === floor.version && bytesEq(e.selfHash, floor.hash)) &&
    !walked.some((e) => e.version >= floor.version) &&
    editions.some((e) => e.version >= floor.version);

  if (snapshot) {
    // Snapshot presence selects the arm; the head is chosen over ALL editions, so
    // relays serving only a stale re-wrap can't outrank a higher head in our store.
    const idx = bootstrapHead(walked.map(toFoldEdition), floor?.version ?? 0n);
    if (idx !== null) {
      ordered.push(walked[idx]);
      seenRumors.add(bytesToHex(walked[idx].rumorId));
    } else if (floor !== undefined && !refusedAtFloor()) {
      // Nothing at/above our floor served: the accepted head was withheld; fail closed.
      gapped = true;
      onGap?.();
    }
  } else {
    // While the held edition is served, every sibling at its version anchors and the tiebreak
    // decides; withheld, a rival anchors only by beating the key the floor recorded (Vector `HeldKey`).
    const heldServed = floor !== undefined && editions.some((e) => e.version === floor.version && bytesEq(e.selfHash, floor.hash));
    const rank = admit?.rankOf;
    const beatsHeld = (e: ParsedEdition): boolean => {
      // A Role's or Grant's rival is judged on the ranks its siblings claim, and the withheld
      // edition's claims are what is missing: only the owner's rival qualifies (CORD-04 §2).
      if ((e.vsk === VSK_ROLE || e.vsk === VSK_GRANT || e.vsk === VSK_RANKED_ROLE) && e.author !== ownerHex) return false;
      if (floor?.rumorId === undefined) return true;
      const id = bytesToHex(e.rumorId);
      if (floor.author === undefined || !rank) return id < floor.rumorId;
      const [r, held] = [rank(e.author), rank(floor.author)];
      return r < held || (r === held && id < floor.rumorId);
    };
    let result = fold(walked.map(toFoldEdition), floor?.version ?? 0n, floor?.hash, floor ? (i) => heldServed || beatsHeld(walked[i]) : undefined);

    // A gap, or a null head under a floor (everything served was below it — `fold`
    // doesn't report that as a gap): refuse anything above the floor.
    gapped = floor !== undefined && (result.gap || (result.head === null && !refusedAtFloor()));
    if (gapped && admit?.mode === "retry") {
      const kept = admittedChain(editions, admit.admit);
      if (kept.length < editions.length) {
        const retry = fold(kept.map(toFoldEdition), floor!.version, floor!.hash);
        if (!retry.gap && retry.head !== null) {
          walked = kept;
          result = retry;
          gapped = false;
        }
      }
    }
    if (gapped) onGap?.();

    // Under a gap from an anchored walk, the verified prefix still stands (Vector `fold_linked`).
    if (gapped && result.anchored && result.reached) prefix = new Set(result.reached.map((i) => walked[i]));
    if (result.head !== null && (!gapped || prefix)) {
      ordered.push(walked[result.head]);
      seenRumors.add(bytesToHex(walked[result.head].rumorId));
    }
  }
  const rest = walked
    .filter((e) => {
      const id = bytesToHex(e.rumorId);
      if (seenRumors.has(id)) return false;
      seenRumors.add(id);
      // Refuse-to-downgrade (CORD-04 §1): below-floor editions are never candidates,
      // not even the last one standing (that's exactly a replay).
      if (floor !== undefined && e.version < floor.version) return false;
      // Under an anchored gap, only the verified prefix...
      if (gapped && prefix) return prefix.has(e);
      // ...otherwise only the floor's own version remains admissible...
      if (gapped && e.version > floor!.version) return false;
      // ...and only if it IS our accepted head (hash match), not a grindable
      // equal-version fork.
      if (gapped && !bytesEq(e.selfHash, floor!.hash)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.version !== b.version) return a.version > b.version ? -1 : 1;
      return bytesToHex(a.rumorId) < bytesToHex(b.rumorId) ? -1 : 1;
    });
  ordered.push(...rest);
  return ordered;
}

/**
 * Pick the first candidate passing `gate`, recording it as the entity's head.
 * `rankOf` breaks equal-version ties by authority rather than the grindable rumor
 * id, so a lower-ranked bit-holder can't fork the owner's edition. Version order,
 * floor and gap rules are settled in `headCandidates`.
 */
function pickHead(
  candidates: ParsedEdition[],
  heads: Map<string, EntityHead>,
  headEditions: Map<string, ParsedEdition>,
  gate: (p: ParsedEdition) => boolean,
  rankOf: (author: string) => number,
): ParsedEdition | undefined {
  let head: ParsedEdition | undefined;
  for (const p of candidates) {
    if (!gate(p)) continue;
    if (head === undefined) {
      head = p;
      continue;
    }
    // Candidates are version-descending: nothing lower can outrank the first pass.
    if (p.version !== head.version) break;
    if (rankOf(p.author) < rankOf(head.author)) head = p;
  }
  if (head === undefined) return undefined;
  heads.set(bytesToHex(head.entityId), headOf(head));
  headEditions.set(bytesToHex(head.entityId), head);
  return head;
}

/** Order role/grant candidates oldest version first (the admissibility walk). */
function byVersionAsc(a: { parsed: ParsedEdition }, b: { parsed: ParsedEdition }): number {
  return a.parsed.version < b.parsed.version ? -1 : a.parsed.version > b.parsed.version ? 1 : 0;
}

/** Version-ascending groups; equal-version fork siblings share a group. */
function versionGroups<T extends { parsed: ParsedEdition }>(candidates: T[]): T[][] {
  const groups: T[][] = [];
  for (const c of [...candidates].sort(byVersionAsc)) {
    const last = groups[groups.length - 1];
    if (last && last[0].parsed.version === c.parsed.version) last.push(c);
    else groups.push([c]);
  }
  return groups;
}

/**
 * The delegation fixpoint (CORD-04 §2): starting from the owner, admit role/grant
 * entities whose signer is authorized, repeating until stable; the first authorized
 * candidate per entity settles it. Unreachable signers are dropped.
 *
 * Editing acts ON A TARGET (CORD-04 §5): a non-owner must also strictly outrank
 * what an edition REPLACES (the standing role position or the rank a grant's
 * predecessor conferred). Candidates are walked version-ascending; equal-version
 * forks settle highest-authority first.
 *
 * Order-independent: entities go in sorted-eid order and DEFER while their gate's
 * inputs are pending; freeze latches resolve stalls, so it always terminates.
 */
function authorizeDelegation(
  roleCandidates: Map<string, Array<{ role: Role; author: string; parsed: ParsedEdition }>>,
  grantCandidates: Map<string, Array<{ grant: MemberGrant; author: string; parsed: ParsedEdition }>>,
  communityId: Uint8Array,
  ownerHex: string,
  heads: Map<string, EntityHead>,
  headEditions: Map<string, ParsedEdition>,
  excluded: ReadonlySet<string> = new Set(),
): CommunityRoles {
  const roster = emptyRoles();
  const settledRoles = new Set<string>();
  const settledGrants = new Set<string>();
  const roleEids = [...roleCandidates.keys()].sort();
  const grantEids = [...grantCandidates.keys()].sort();
  // member → their grant entity: the rank source the author-deferral watches.
  const grantEidOfMember = new Map<string, string>();
  for (const [eid, cands] of grantCandidates) {
    if (cands.length > 0) grantEidOfMember.set(cands[0].grant.member, eid);
  }
  // CORD-04 §5 sync floor for the delegation chain itself: a non-owner must cite its
  // Grant, resolved against heads settled THIS pass (owner grants settle first, so
  // it bootstraps without circularity).
  // A citation is a sync floor, not the verdict: one that doesn't resolve refuses, while an
  // uncited edition declared no floor to wait for (Vector `judge`).
  const citedOk = (p: ParsedEdition): boolean =>
    p.authority === undefined || citationSatisfied({ heads, ownerHex }, communityId, p.author, p.authority);
  /** Manage Roles, and every bit an edition may carry, from the author's Roles strictly above `reach` (Vector `support_for`). */
  const supportFor = (author: string, reach: number) => permissionsAbove(roster, author, reach);

  let changed = true;
  // While false, grants handing out still-unsettled roles WAIT; once flipped,
  // unsettled roles are provably dead and those grants resolve (and drop).
  let rolesFrozen = false;
  // While false, entities whose candidate authors' grants are unsettled WAIT, so
  // the roster doesn't depend on arrival order. Flipped after a stall with roles
  // frozen; what remains is dead or cyclic, resolved in sorted-eid order.
  let ranksFrozen = false;

  const settle = (p: ParsedEdition) => {
    heads.set(bytesToHex(p.entityId), headOf(p));
    headEditions.set(bytesToHex(p.entityId), p);
  };

  /** Is a non-owner author's rank still undetermined (their grant entity pending)? */
  const rankPending = (author: string, selfEid?: string): boolean => {
    if (author === ownerHex) return false;
    const aeid = grantEidOfMember.get(author);
    // Never wait on itself: that would be the self-promotion the fixpoint drops.
    return aeid !== undefined && aeid !== selfEid && !settledGrants.has(aeid);
  };

  /**
   * Equal-version fork siblings, highest authority first (owner, then position, then
   * rumor id); the id is grindable, authority is not.
   */
  const authorityFirst = (a: { author: string; parsed: ParsedEdition }, b: { author: string; parsed: ParsedEdition }): number => {
    const rank = (author: string) => (author === ownerHex ? -1 : (highestPosition(roster, author) ?? Number.MAX_SAFE_INTEGER));
    const ra = rank(a.author);
    const rb = rank(b.author);
    if (ra !== rb) return ra - rb;
    const ia = bytesToHex(a.parsed.rumorId);
    const ib = bytesToHex(b.parsed.rumorId);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };

  while (changed) {
    changed = false;

    // Roles: owner defines any (position ≥ 1); a non-owner needs MANAGE_ROLES from Roles
    // above both the minted position and the standing one replaced, and may carry no bit
    // those Roles lack.
    for (const eid of roleEids) {
      if (settledRoles.has(eid)) continue;
      const candidates = roleCandidates.get(eid)!;
      if (!ranksFrozen && candidates.some((c) => rankPending(c.author))) continue;
      const admissible = new Set<ParsedEdition>();
      let standing: number | undefined; // the admissible predecessor's position
      for (const group of versionGroups(candidates)) {
        for (const { role, author, parsed } of [...group].sort(authorityFirst)) {
          const support = supportFor(author, Math.min(role.position, standing ?? Infinity));
          const ok =
            author === ownerHex ||
            (role.position !== 0 && (support & Permissions.MANAGE_ROLES) !== 0n && (role.permissions & ~support) === 0n);
          if (!ok || !citedOk(parsed)) continue;
          admissible.add(parsed);
          standing = role.position;
          break; // one winner per version — a fork sibling can't sidestep it
        }
      }
      const pick = candidates.find((c) => admissible.has(c.parsed));
      if (!pick) continue;
      roster.roles.push(pick.role);
      settledRoles.add(eid);
      settle(pick.parsed);
      changed = true;
    }

    // Grants: a non-owner needs MANAGE_ROLES and must strictly outrank every Role
    // handed out AND the target's standing rank (revokes act ON the member, CORD-04
    // §5/§6). A grant settles only once its roles and candidate authors' grants are no
    // longer PENDING, or fold order would reopen those holes.
    for (const eid of grantEids) {
      if (settledGrants.has(eid)) continue;
      const candidates = grantCandidates.get(eid)!;
      // Waits for unsettled roles until roles are frozen.
      const rolePending = (rid: string) => roleCandidates.has(rid) && !settledRoles.has(rid);
      if (!rolesFrozen && candidates.some((c) => c.grant.roleIds.some(rolePending))) continue;
      if (!ranksFrozen && candidates.some((c) => rankPending(c.author, eid))) continue;

      const admissible = new Set<ParsedEdition>();
      let standing: number | undefined; // the rank the admissible predecessor conferred
      for (const group of versionGroups(candidates)) {
        for (const { grant, author, parsed } of [...group].sort(authorityFirst)) {
          // Judged on the Roles it names that resolve, never on whether the rest do (Vector `claims`).
          const positions = grant.roleIds
            .map((rid) => roster.roles.find((r) => r.roleId === rid)?.position)
            .filter((p): p is number => p !== undefined);
          const reach = Math.min(...positions, standing ?? Infinity);
          // An uncited Grant naming no published Role is a strip, and a strip must cite.
          const strip = grant.roleIds.every((rid) => !roleCandidates.has(rid));
          const ok =
            author === ownerHex ||
            (grant.member !== ownerHex &&
              (supportFor(author, reach) & Permissions.MANAGE_ROLES) !== 0n &&
              !(parsed.authority === undefined && strip));
          if (!ok || !citedOk(parsed)) continue;
          admissible.add(parsed);
          standing = positions.length ? Math.min(...positions) : undefined;
          break; // one winner per version
        }
      }
      const pick = candidates.find((c) => admissible.has(c.parsed));
      if (!pick) continue;
      // A Grant to a banned member links its chain but confers nothing (Vector `select_authorized`, CORD-04 §4).
      if (!excluded.has(pick.grant.member)) roster.grants.push(pick.grant);
      settledGrants.add(eid);
      settle(pick.parsed);
      changed = true;
    }

    // Stalled with deferrals: flip one freeze latch (roles first) and go again; each
    // flips once, so this terminates.
    if (!changed && !rolesFrozen) {
      rolesFrozen = true;
      changed = true;
    } else if (!changed && !ranksFrozen) {
      ranksFrozen = true;
      changed = true;
    }
  }

  // CORD-04 §2: at most 100 Roles; fold the 100 lowest role_ids.
  if (roster.roles.length > MAX_ROLES_PER_COMMUNITY) {
    roster.roles.sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
    roster.roles = roster.roles.slice(0, MAX_ROLES_PER_COMMUNITY);
  }
  return roster;
}

/** Fold-once memo, keyed on the community + the exact edition set. */
const foldMemo = new Map<string, FoldedControl>();

/**
 * Replay opened control editions into current state (`ownerHex` is the proven
 * owner). Up to two passes: if the Banlist names authors of any editions, re-fold
 * without them (CORD-04 §4); pass 1's Banlist stays final (the owner is never
 * bannable).
 */
export function foldControlState(
  editions: ParsedEdition[],
  communityId: Uint8Array,
  ownerHex: string,
  priorHeads?: Map<string, EntityHead>,
  snapshotIds?: Set<string>,
  stored?: StoredControl,
): FoldedControl {
  const start = performance.now();
  const cidHex = bytesToHex(communityId);
  const floorSig = priorHeads
    ? [...priorHeads.entries()].map(([k, v]) => `${k}@${v.version}#${bytesToHex(v.hash)}/${v.rumorId ?? ""}/${v.author ?? ""}/${v.vsk ?? ""}`).sort().join(",")
    : "";
  // Attribution (a re-wrap arriving) can change without the edition set changing.
  const snapSig = snapshotIds ? [...snapshotIds].sort().join(",") : "";
  const storedSig = stored
    ? `${stored.everyone ?? ""}/${(stored.legacyChannels ?? []).join(",")}/${[...(stored.banned ?? [])].sort().join(",")}/${(stored.overwrites ?? []).map((o) => `${o.scope}${o.target.kind}${"id" in o.target ? o.target.id : ""}${o.allow}${o.deny}`).join(",")}/${JSON.stringify(stored.syncs ?? {})}/${(stored.heldChannels ?? []).map((c) => `${bytesToHex(c.id)}@${c.epoch}+${c.priors?.length ?? 0}`).sort().join(",")}/${JSON.stringify(stored.banMarks ?? {})}/${JSON.stringify(stored.writers ?? {})}/${JSON.stringify([stored.roleIds ?? [], stored.grantees ?? [], stored.roleManagers ?? []])}/${JSON.stringify([stored.channels ?? [], stored.categories ?? []], (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`
    : "";
  // By RUMOR id: `snapSig` already covers re-wrap attribution.
  const memoKey = `${cidHex}:${ownerHex}:${floorSig}:${snapSig}:${storedSig}:${editions.map((e) => e.opened.rumorId).sort().join(",")}`;
  const hit = foldMemo.get(memoKey);
  // A hit still costs O(n log n) key building; counted separately to stay visible.
  if (hit) {
    perfCount("fold.controlState (memo hit)", performance.now() - start, editions.length, "editions");
    return hit;
  }

  // CORD-04 §1: a marked edition bound to another Community is refused, and so is an
  // unmarked edition of a kind no older client wrote.
  const binding = bytesToHex(editionBinding(communityId));
  const refused = (e: ParsedEdition) =>
    e.binding ? bytesToHex(e.binding) !== binding : ALWAYS_MARKED_VSKS.has(e.vsk);
  if (editions.some(refused)) editions = editions.filter((e) => !refused(e));
  const first = foldOnce(editions, communityId, ownerHex, priorHeads, snapshotIds, new Set(), stored);
  // The owner is supreme (CORD-04 §2): strip them from `banned` HERE, on the set
  // every reader consumes, or a BAN holder could silence the owner everywhere.
  const banned = new Set([...first.banned].filter((pk) => pk !== ownerHex));
  let result: FoldedControl = banned.size === first.banned.size ? first : { ...first, banned };
  // Also when the banned authored nothing: a Grant to a banned member carries no rank (CORD-04 §4).
  if (banned.size > 0) {
    // Pass 1 stays authoritative for `incomplete`: pass 2's gaps are semantic drops,
    // not data loss, and must not block ban→refound. A ban takes what its target
    // wrote, except what a Tenure keeps (CORD-04 §4, §9). The Roster still links what
    // it refuses, so it folds every edition with the banned excluded (Vector).
    const sealed = first.tenure ?? new Map();
    const kept = editions.filter((e) => !banned.has(e.author) || isListed(sealed, e.author, bytesToHex(e.selfHash)));
    const second = foldOnce(kept, communityId, ownerHex, priorHeads, snapshotIds, banned, stored, editions);
    // The Banlist's head is the one judged before the ban took anyone's support (Vector `banlist_head`).
    const banlistEid = bytesToHex(banlistLocator(communityId));
    const heads = new Map(second.heads);
    const headEditions = new Map(second.headEditions);
    const firstHead = first.heads.get(banlistEid);
    const firstEdition = first.headEditions.get(banlistEid);
    if (firstHead) heads.set(banlistEid, firstHead);
    else heads.delete(banlistEid);
    if (firstEdition) headEditions.set(banlistEid, firstEdition);
    else headEditions.delete(banlistEid);
    result = { ...second, heads, headEditions, banned, bannedAt: first.bannedAt, incomplete: first.incomplete };
  }

  // One entry per community.
  for (const k of foldMemo.keys()) if (k.startsWith(`${cidHex}:`)) foldMemo.delete(k);
  foldMemo.set(memoKey, result);
  perfCount("fold.controlState", performance.now() - start, editions.length, "editions");
  return result;
}

/**
 * Public/Private mode (CORD-05 §5): any aggregate live link means Public. A Public
 * ban is the Banlist alone; only a Private ban Refounds (CORD-06 §3).
 * `excludingCreator` drops an in-flight ban target's registry first.
 */
export function isCommunityPublic(folded: FoldedControl, excludingCreator?: string): boolean {
  for (const [creator, signers] of folded.registriesByCreator) {
    if (creator === excludingCreator) continue;
    if (signers.length > 0) return true;
  }
  return false;
}

/**
 * Whether any live link belongs to someone other than `viewer` — links a rotation
 * by `viewer` would strand (a rotator refreshes their own). Rotate only when none
 * exist, even if the community reads Public. `excludingCreators` drops in-flight
 * ban targets' registries.
 */
export function hasForeignLiveLinks(
  folded: FoldedControl,
  viewer: string,
  excludingCreators?: string | string[],
): boolean {
  const excluded = new Set(
    typeof excludingCreators === "string" ? [excludingCreators] : excludingCreators ?? [],
  );
  for (const [creator, signers] of folded.registriesByCreator) {
    if (creator === viewer || excluded.has(creator)) continue;
    if (signers.length > 0) return true;
  }
  return false;
}

/**
 * Whether an actor's `vac` satisfies the CORD-04 §5 sync floor, for authority
 * actions OUTSIDE the roster fold (deletes, kicks). COMPLETENESS, not
 * authorization: callers still check rank against the current roster. Mirrors
 * Vector's `authority_citation_satisfied` case for case — must stay in sync. Not
 * usable inside the fold (see `citationOk` in {@link foldControlState}).
 */
export function citationSatisfied(
  folded: Pick<FoldedControl, "heads" | "ownerHex">,
  communityId: Uint8Array,
  actorHex: string,
  citation: AuthorityCitation | undefined,
): boolean {
  // The owner is proven by the community_id; nothing to cite.
  if (actorHex === folded.ownerHex) return true;
  if (!citation) return false;
  // Must name the actor's OWN Grant coordinate.
  const eid = bytesToHex(grantLocator(communityId, hex32(actorHex)));
  if (bytesToHex(citation.entityId) !== eid) return false;
  const head = folded.heads.get(eid);
  if (!head) return false;
  if (head.version > citation.version) return true;
  // At exactly it: the hash must match our fold's winner, not a fork.
  if (head.version === citation.version) return bytesToHex(head.hash) === bytesToHex(citation.editionHash);
  // Behind it: park until the Grant arrives (fail closed).
  return false;
}

/**
 * Whether banning `targets` should rotate keys, judged once for the group (one
 * Refounding, not one per target). Normally not while a foreign live link exists
 * ({@link hasForeignLiveLinks}; targets' registries excluded). `force` is for
 * control-plane abuse, where the rotation strands the flooder's root.
 */
export function banShouldRotateMany(
  folded: FoldedControl | undefined,
  viewer: string,
  targets: string[],
  force = false,
): boolean {
  if (!folded) return false;
  return force || !hasForeignLiveLinks(folded, viewer, targets);
}

/** Single-target {@link banShouldRotateMany}. */
export function banShouldRotate(
  folded: FoldedControl | undefined,
  viewer: string,
  target: string,
  force = false,
): boolean {
  return banShouldRotateMany(folded, viewer, [target], force);
}

/**
 * signal_id → permission authorizing it (CORD-04 §8). Also the set of implemented
 * signal_ids: unknown directives are invisible.
 */
const SIGNAL_GATES: Record<string, bigint> = {
  [SIGNAL_PAUSE]: Permissions.MANAGE_CHANNELS,
};

/**
 * Max pause `until`, measured from the edition's own `created_at` (CORD-04 §8) so
 * every reader agrees. Catches ms-for-seconds mistakes (a 50,000-year freeze).
 * Open-ended pauses omit `until`.
 */
const MAX_PAUSE_UNTIL_SECS = 30 * 24 * 60 * 60;

/**
 * Whether a signal head's content is well-formed for its signal_id (`createdAt`
 * anchors the pause bound). Failures fall through to the next candidate.
 */
function validateSignal(signalId: string, content: string, createdAt: number): boolean {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof v !== "object" || v === null) return false;
  if (signalId === SIGNAL_PAUSE) {
    const p = v as { paused?: unknown; until?: unknown };
    if (typeof p.paused !== "boolean") return false;
    if (p.until !== undefined) {
      if (typeof p.until !== "number" || !Number.isInteger(p.until) || p.until <= 0) return false;
      if (p.until > createdAt + MAX_PAUSE_UNTIL_SECS) return false;
    }
    return true;
  }
  return false;
}

/** A Community's active pause (CORD-04 §8), resolved for `nowSec`. */
export interface ActivePause {
  /** Enactment time in SECONDS — the floor from which non-staff messages fold. */
  since: number;
  until?: number;
  by: string;
}

/** The pause from its folded head alone, for callers caching just the head (the wire). */
export function activePauseOf(head: FoldedSignal | undefined, nowSec: number): ActivePause | undefined {
  if (!head) return undefined;
  const c = head.content as { paused?: unknown; until?: unknown };
  if (c.paused !== true) return undefined;
  const until = typeof c.until === "number" ? c.until : undefined;
  if (until !== undefined && nowSec >= until) return undefined;
  return { since: head.at, ...(until !== undefined ? { until } : {}), by: head.author };
}

/**
 * The active pause: `paused === true` and no `until` or `until` > `nowSec`.
 * `until` self-clears (CORD-04 §8), so renderers must SCHEDULE the expiry (see
 * `usePauseClock`).
 */
export function activePause(folded: FoldedControl | undefined, nowSec: number): ActivePause | undefined {
  return activePauseOf(folded?.signals.get(SIGNAL_PAUSE), nowSec);
}

/** The folded `pause` head, for a caller that wants to cache it (see `readLivePause`). */
export function pauseHeadOf(folded: FoldedControl | undefined): FoldedSignal | undefined {
  return folded?.signals.get(SIGNAL_PAUSE);
}

function foldOnce(
  editions: ParsedEdition[],
  communityId: Uint8Array,
  ownerHex: string,
  priorHeads?: Map<string, EntityHead>,
  snapshotIds?: Set<string>,
  excluded: ReadonlySet<string> = new Set(),
  stored?: StoredControl,
  /** The editions the Roster folds, when they differ from `editions` (the ban pass). */
  rosterEditions: ParsedEdition[] = editions,
): FoldedControl {
  const cidHex = bytesToHex(communityId);

  // 1. Group by (vsk, entity).
  const group = (list: ParsedEdition[]) => {
    const out = new Map<string, Map<string, ParsedEdition[]>>();
    for (const p of list) {
      let m = out.get(p.vsk);
      if (!m) out.set(p.vsk, (m = new Map()));
      pushEdition(m, bytesToHex(p.entityId), p);
    }
    return out;
  };
  const byVsk = group(editions);
  // The Banlist, overwrites and syncs still link a banned member's editions, refused (Vector).
  const byVskLinked = rosterEditions === editions ? byVsk : group(rosterEditions);

  const heads = new HeadSlots<EntityHead>();
  const headEditions = new HeadSlots<ParsedEdition>();
  const gapHeld = new Set<string>();
  /** The floor for `eid` as an entity of `vsk`: one another family recorded floors nothing here. */
  const floorOf = (eid: string, vsk: string): EntityHead | undefined => {
    const f = priorHeads?.get(eid);
    if (!f || f.vsk === undefined) return f;
    return AUTHORITY_VSKS.has(f.vsk) === AUTHORITY_VSKS.has(vsk) ? f : undefined;
  };
  /** Ordered head candidates per entity of one vsk (floored per prior head). */
  const candidatesOf = (vsk: string, admit?: HeadAdmit, source = byVsk): Map<string, ParsedEdition[]> => {
    const out = new Map<string, ParsedEdition[]>();
    for (const [eid, list] of source.get(vsk) ?? new Map<string, ParsedEdition[]>()) {
      // If any edition arrived under the current control group, anchor there (see
      // headCandidates).
      const snap = snapshotIds ? list.filter((p: ParsedEdition) => snapshotIds.has(bytesToHex(p.rumorId))) : [];
      out.set(
        eid,
        headCandidates(list, floorOf(eid, vsk), snap.length > 0 ? snap : undefined, () => gapHeld.add(eid), admit, ownerHex),
      );
    }
    return out;
  };

  // 2. Roster (owner-rooted fixpoint) — resolved before any gated entity.
  const resolveLegacyRoster = (admit?: HeadAdmit) => {
    const roleCandidates = new Map<string, Array<{ role: Role; author: string; parsed: ParsedEdition }>>();
    for (const [eid, candidates] of candidatesOf(VSK_ROLE, admit)) {
      const parsed = candidates
        .map((p) => ({ role: roleFromJSON(p.content), author: p.author, parsed: p }))
        // The entity coordinate must be the role's own id (anti-spoofing).
        .filter((c): c is { role: Role; author: string; parsed: ParsedEdition } =>
          Boolean(c.role && bytesToHex(hex32(c.role.roleId)) === eid),
        );
      if (parsed.length > 0) roleCandidates.set(eid, parsed);
    }
    const grantCandidates = new Map<string, Array<{ grant: MemberGrant; author: string; parsed: ParsedEdition }>>();
    for (const [eid, candidates] of candidatesOf(VSK_GRANT, admit)) {
      const parsed = candidates
        .map((p) => ({ grant: grantFromJSON(p.content), author: p.author, parsed: p }))
        // The coordinate must be the member's grant locator (anti-spoofing).
        .filter((c): c is { grant: MemberGrant; author: string; parsed: ParsedEdition } =>
          Boolean(c.grant && bytesToHex(grantLocator(communityId, hex32(c.grant.member))) === eid),
        );
      if (parsed.length > 0) grantCandidates.set(eid, parsed);
    }
    heads.clear();
    headEditions.clear();
    return authorizeDelegation(roleCandidates, grantCandidates, communityId, ownerHex, heads, headEditions, excluded);
  };
  // The vsk-13 Roster (CORD-04 §2) once an owner-rooted `@everyone` stands; the legacy fixpoint before.
  const rosterFloors: RosterFloors = new Map(
    [...(priorHeads ?? [])].map(([eid, h]) => [eid, { version: h.version, hash: h.hash, rumorId: h.rumorId, author: h.author, vsk: h.vsk }]),
  );
  const ranked = rosterActivated(rosterEditions, communityId, ownerHex, rosterFloors, stored);
  let sealed: SealedBy = new Map();
  let roster: CommunityRoles;
  let rosterComplete: boolean | undefined;
  let everyoneServed = false;
  if (ranked) {
    const folded = foldRankedRoster(rosterEditions, communityId, ownerHex, rosterFloors, excluded, stored);
    roster = folded.roles;
    sealed = folded.sealed;
    for (const h of folded.heads) {
      heads.set(h.eid, headOf(h.edition, h.rebased));
      headEditions.set(h.eid, h.edition);
    }
    for (const eid of folded.gapped) gapHeld.add(eid);
    rosterComplete = folded.complete;
    const everyoneHex = bytesToHex(everyoneLocator(communityId));
    everyoneServed = folded.heads.some((h) => h.eid === everyoneHex);
  } else {
    roster = resolveLegacyRoster();
  }
  // Who may edit a role or grant is only known once the roster is: re-walk each
  // gapped one over the MANAGE_ROLES holders the last pass settled, and re-resolve
  // until the roster's heads stop moving (a promotion one pass un-gaps admits that
  // admin's edits on the next). Not settling in the bound fails closed: every gap held.
  const rosterEids = new Set([...(byVsk.get(VSK_ROLE)?.keys() ?? []), ...(byVsk.get(VSK_GRANT)?.keys() ?? [])]);
  const rosterHeads = (): string =>
    [...rosterEids].sort().map((eid) => {
      const h = heads.get(eid);
      return h ? `${eid}:${h.version}:${bytesToHex(h.hash)}` : eid;
    }).join(",");
  const rewalked = new Set<string>();
  let lastHeads = rosterHeads();
  for (let pass = 0; !ranked; pass++) {
    const fresh = [...gapHeld].filter((eid) => rosterEids.has(eid) && !rewalked.has(eid));
    if (fresh.length === 0 && pass > 0) {
      const now = rosterHeads();
      if (now === lastHeads) break;
      lastHeads = now;
    }
    if (rewalked.size === 0 && fresh.length === 0) break;
    if (pass > rosterEids.size + 1) {
      gapHeld.clear();
      roster = resolveLegacyRoster();
      break;
    }
    for (const eid of fresh) rewalked.add(eid);
    for (const eid of rosterEids) gapHeld.delete(eid);
    const settled = roster;
    roster = resolveLegacyRoster({
      mode: "retry",
      admit: (p) =>
        !rewalked.has(bytesToHex(p.entityId)) || isAuthorized(settled, p.author, ownerHex, Permissions.MANAGE_ROLES),
    });
  }

  // The `vac` check (CORD-04 §5): a non-owner action MUST cite the exact Grant it
  // acts under (eid, version, hash), and is honored only once we hold that Grant at
  // ≥ the cited version with a matching hash; otherwise it parks. Uses the same
  // `citationSatisfied` as the delete/kick/rekey gates (mirrors Vector). A LATER head
  // passes, since compaction discards superseded versions.
  // A Tenure-listed edition stands without its citation (CORD-04 §9).
  const listed = (p: ParsedEdition): boolean => ranked && isListed(sealed, p.author, bytesToHex(p.selfHash));
  const citationOk = (p: ParsedEdition): boolean =>
    listed(p) || citationSatisfied({ heads, ownerHex }, communityId, p.author, p.authority);

  /**
   * Whether `p`'s signer may write it under `permission` judged on the bit alone:
   * the Roster as it stands, `@everyone`'s bits counted, or a sealed standing (CORD-04 §8, §9).
   */
  const may = (p: ParsedEdition, permission: bigint): boolean =>
    isAuthorized(roster, p.author, ownerHex, permission) ||
    (ranked && (sealOf(sealed, p.author, bytesToHex(p.selfHash), BENEATH_EVERY_ROLE) & permission) === permission);

  /** Editions by a holder of `permission` citing a Grant we hold: the authority pre-filter. */
  const holders = (...permissions: bigint[]): HeadAdmit => ({
    mode: "filter",
    admit: (p) => permissions.some((permission) => may(p, permission)) && citationOk(p),
    rankOf: (author) => rankOf(author),
  });

  /** Authority order for equal-version tiebreaks: owner first, then position. */
  const rankOf = (author: string): number =>
    author === ownerHex ? -1 : (highestPosition(roster, author) ?? Number.MAX_SAFE_INTEGER);

  // 3. Metadata (vsk 0): must be the community's own entity + an authorized actor.
  let metadata: CommunityMetadata | undefined;
  {
    const candidates = candidatesOf(VSK_METADATA, holders(Permissions.MANAGE_METADATA)).get(cidHex) ?? [];
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (!may(p, Permissions.MANAGE_METADATA)) return false;
      if (!citationOk(p)) return false;
      try {
        const parsed = JSON.parse(p.content) as CommunityMetadata;
        // Protocol caps are read-side rules too (CORD-02 §6).
        if (typeof parsed.name !== "string" || utf8Len(parsed.name) > NAME_MAX_BYTES) return false;
        if (parsed.description !== undefined && (typeof parsed.description !== "string" || utf8Len(parsed.description) > DESCRIPTION_MAX_BYTES)) return false;
        return true;
      } catch {
        return false;
      }
    }, rankOf);
    if (head) {
      const parsed = JSON.parse(head.content) as CommunityMetadata;
      metadata = {
        ...parsed,
        relays: capRelays(Array.isArray(parsed.relays) ? parsed.relays : []),
        icon: isImagePointer(parsed.icon) ? parsed.icon : undefined,
        banner: isImagePointer(parsed.banner) ? parsed.banner : undefined,
      };
    }
  }

  // 4. Channels (vsk 2), each gated by MANAGE_CHANNELS. On the vsk-13 Roster an
  // unmarked edition counts only for a Channel the switch listed, and a Private
  // Channel's metadata may be sealed under its key (CORD-03 §2, CORD-04 §2).
  const legacyChannels = ranked && roster.legacyChannels ? new Set(roster.legacyChannels) : undefined;
  // An edition aimed at another entity's coordinate is no Channel or Category (CORD-03
  // §2, §4): the Community's own, `@everyone`'s, the Banlist's, or one an edition of
  // another kind claims, signed by a holder of that kind's bit (Vector `taken_by`).
  const claimBit = (vsk: string): bigint | undefined =>
    ({
      [VSK_METADATA]: Permissions.MANAGE_METADATA,
      [VSK_CHANNEL]: Permissions.MANAGE_CHANNELS,
      [VSK_CATEGORY]: Permissions.MANAGE_CHANNELS,
      [VSK_WRITERS]: Permissions.MANAGE_CHANNELS,
      [VSK_ROLE]: Permissions.MANAGE_ROLES,
      [VSK_GRANT]: Permissions.MANAGE_ROLES,
      [VSK_RANKED_ROLE]: Permissions.MANAGE_ROLES,
      [VSK_ACL]: Permissions.MANAGE_ROLES,
      [VSK_TENURE]: Permissions.MANAGE_ROLES,
      [VSK_SYNC]: Permissions.MANAGE_ROLES,
      [VSK_BANLIST]: Permissions.BAN,
      [VSK_INVITE_REGISTRY]: Permissions.CREATE_INVITE,
      [VSK_PINS]: Permissions.PIN_MESSAGES,
    })[vsk];
  const takenBy = (kind: string): Set<string> => {
    const out = new Set([cidHex, bytesToHex(everyoneLocator(communityId)), bytesToHex(banlistLocator(communityId))]);
    for (const [vsk, byEid] of byVsk) {
      const bit = claimBit(vsk);
      if (vsk === kind || bit === undefined) continue;
      for (const [eid, list] of byEid) if (list.some((e) => isAuthorized(roster, e.author, ownerHex, bit))) out.add(eid);
    }
    return out;
  };
  const notChannels = takenBy(VSK_CHANNEL);
  /** Every served edition of an entity, below the floor included: a deletion counts over all of them (Vector). */
  const servedOf = (vsk: string, eid: string): ParsedEdition[] => byVsk.get(vsk)?.get(eid) ?? [];
  const channels = new Map<string, FoldedChannel>();
  for (const [eid, candidates] of candidatesOf(VSK_CHANNEL, holders(Permissions.MANAGE_CHANNELS))) {
    if (notChannels.has(eid)) continue;
    const channelGate = (p: ParsedEdition): boolean => {
      if (!may(p, Permissions.MANAGE_CHANNELS)) return false;
      if (!citationOk(p)) return false;
      return !(legacyChannels && !p.binding && !legacyChannels.has(eid));
    };
    // A malformed edition still links and stands as the head, applying nothing: the
    // Channel reads as the newest standing edition that has its form (CORD-03 §2).
    const head = pickHead(candidates, heads, headEditions, channelGate, rankOf);
    if (!head) continue;
    // The head itself when it reads; at a fork, a losing sibling's content must not stand in for it.
    const applied = readChannelContent(head.content) !== undefined
      ? head
      : candidates.find((p) => p.version <= head.version && channelGate(p) && readChannelContent(p.content) !== undefined);
    if (!applied) continue;
    const read = readChannelContent(applied.content)!;
    const meta = read.metadata;
    // CORD-03 §2: deletion is terminal — a later edition can't lift it. Decided over
    // the whole served chain, below the floor included (members may have discarded keys; a resurrection would
    // split them), gated by the same predicate as the head.
    const deletions = servedOf(VSK_CHANNEL, eid).filter((p) => channelGate(p) && readChannelContent(p.content)?.metadata.deleted === true);
    const everDeleted = deletions.length > 0;
    if (everDeleted) settleOnDeletion(eid, deletions, heads, headEditions);
    channels.set(eid, {
      channelIdHex: eid,
      name: meta.name,
      isPrivate: meta.private === true,
      deleted: meta.deleted === true || everDeleted,
      metadata: everDeleted ? { ...meta, deleted: true } : meta,
      ...(read.sealed ? { sealed: { ...read.sealed, ...(applied.prevHash ? { prevHex: bytesToHex(applied.prevHash) } : {}) } } : {}),
    });
  }
  // What the reader held for a floored Channel this fold settles nothing for stays (Vector
  // keeps it): a relay withholding its editions must not make it vanish.
  for (const ch of stored?.channels ?? []) {
    if (priorHeads?.has(ch.channelIdHex) && !channels.has(ch.channelIdHex) && !notChannels.has(ch.channelIdHex)) channels.set(ch.channelIdHex, ch);
  }

  // A Private Channel's sealed creator, opened with the reader's key (CORD-03 §2, CORD-04 §8).
  if (ranked && stored?.heldChannels?.length) {
    const keys = new Map(stored.heldChannels.map((k) => [bytesToHex(k.id), k]));
    const creators: Record<string, string> = {};
    for (const ch of channels.values()) {
      const key = keys.get(ch.channelIdHex);
      if (!ch.isPrivate || ch.deleted || !ch.sealed || !key) continue;
      const creator = openChannelSeal(ch.sealed, key)?.creator;
      if (creator) creators[ch.channelIdHex] = creator;
    }
    if (Object.keys(creators).length > 0) roster = { ...roster, creators };
  }

  // 5. Banlist (vsk 4): the one anti-roster; unauthorized head → empty (fail closed).
  const banned = new Set<string>();
  const bannedAt = new Map<string, number>(Object.entries(stored?.banMarks ?? {}));
  {
    const eid = bytesToHex(banlistLocator(communityId));
    const candidates = candidatesOf(VSK_BANLIST, holders(Permissions.BAN), byVskLinked).get(eid) ?? [];
    /** The entries an edition names, lowercased as Vector reads them; undefined if it is not a list (CORD-04 §4). */
    const parseList = (p: ParsedEdition): string[] | undefined => parseStrictStringArray(p.content)?.map((pk) => pk.toLowerCase());
    const isKey = (pk: string) => /^[0-9a-f]{64}$/.test(pk);

    /**
     * Banning acts on a member: BAN AND strict outrank (as kicks and grants), so a
     * Moderator can't ban Admins. `canActOnMember` also refuses the owner.
     */
    const entitled = (author: string, pk: string, p?: ParsedEdition): boolean =>
      canActOnMember(roster, author, ownerHex, pk, Permissions.BAN) ||
      // …or a sealed standing above the target covers it (CORD-04 §9).
      (ranked && p !== undefined && pk !== ownerHex &&
        (sealOf(sealed, author, bytesToHex(p.selfHash), highestPosition(roster, pk) ?? BENEATH_EVERY_ROLE) & Permissions.BAN) !== 0n);

    const sealedBan = (p: ParsedEdition): boolean => ranked && (sealOf(sealed, p.author, bytesToHex(p.selfHash), BENEATH_EVERY_ROLE) & Permissions.BAN) !== 0n;
    // On the vsk-13 Roster the bit must come from the author's Roles: `@everyone`'s bits author no Banlist (CORD-04 §2).
    const bans = (p: ParsedEdition): boolean =>
      ranked
        ? p.author === ownerHex || (permissionsAboveIn(roster, p.author, BENEATH_EVERY_ROLE) & Permissions.BAN) !== 0n || sealedBan(p)
        : isAuthorized(roster, p.author, ownerHex, Permissions.BAN);
    // A member this reader holds banned heads it only on a sealed standing (CORD-04 §4, Vector `persisted_banned`).
    const heldBanned = new Set(stored?.banned ?? []);
    const admissible = (p: ParsedEdition): boolean =>
      (!heldBanned.has(p.author) || sealedBan(p)) && bans(p) && (sealedBan(p) || citationOk(p)) && parseList(p) !== undefined;

    // The head's list alone, each entry its author may name, the first 500 of them: removals
    // aren't rank-checked (CORD-04 §2, §4). Entries that aren't keys count toward the cap.
    const head = pickHead(candidates, heads, headEditions, admissible, rankOf);
    if (head) {
      for (const pk of parseList(head)!.filter((pk) => entitled(head.author, pk, head)).slice(0, MAX_BANLIST)) if (isKey(pk)) banned.add(pk);
    }
    // A withheld head never un-bans: with none served, the held list stands (Vector `persisted_banned`).
    else for (const pk of stored?.banned ?? []) banned.add(pk);

    // Ban history (see FoldedControl.bannedAt): the newest admissible edition naming each
    // npub, the owner aside, since an un-ban replaces the head: over every served edition, not
    // only those above the floor (Vector `banned_at`). `createdAt` is seconds.
    for (const p of byVskLinked.get(VSK_BANLIST)?.get(eid) ?? []) {
      if (!admissible(p)) continue;
      for (const pk of parseList(p)!) {
        if (pk === ownerHex || !isKey(pk)) continue;
        const prev = bannedAt.get(pk);
        if (prev === undefined || p.createdAt > prev) bannedAt.set(pk, p.createdAt);
      }
    }
  }

  // 6. Invite registries (vsk 8): each creator's own list (coordinate binds to the
  // author), honored while they hold CREATE_INVITE. The aggregate is the
  // Public/Private source of truth (CORD-05 §5).
  const liveInviteLinks = new Set<string>();
  const registriesByCreator = new Map<string, string[]>();
  for (const [eid, candidates] of candidatesOf(VSK_INVITE_REGISTRY, {
    mode: "filter",
    // A registry is its creator's own list: another holder's edition of it is junk.
    admit: (p) => may(p, Permissions.CREATE_INVITE) && bytesToHex(inviteLinksLocator(communityId, hex32(p.author))) === bytesToHex(p.entityId),
  })) {
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (bytesToHex(inviteLinksLocator(communityId, hex32(p.author))) !== eid) return false;
      // The bit alone, no citation: Vector's `live_invite_link_sets` reads no floor here.
      if (!may(p, Permissions.CREATE_INVITE)) return false;
      try {
        return Array.isArray(JSON.parse(p.content));
      } catch {
        return false;
      }
    }, rankOf);
    if (!head) continue;
    const list = (JSON.parse(head.content) as unknown[]).filter(
      (s): s is string => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s),
    );
    registriesByCreator.set(head.author, list);
    for (const pk of list) liveInviteLinks.add(pk.toLowerCase());
  }

  // 7. Pin Lists (vsk 11), gated by PIN_MESSAGES (CORD-04 §7); content carried
  // verbatim (a violating list reads as empty).
  const pinLists = new Map<string, { content: string; author: string }>();
  for (const [eid, candidates] of candidatesOf(VSK_PINS, holders(Permissions.PIN_MESSAGES))) {
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (!may(p, Permissions.PIN_MESSAGES)) return false;
      return citationOk(p);
    }, rankOf);
    if (!head) continue;
    pinLists.set(eid, { content: head.content, author: head.author });
  }

  // 8. Community Signals (vsk 12), gated per signal_id (CORD-04 §8). Only
  // SIGNAL_GATES tokens have a coordinate (looked up exactly), so unknown ones stay
  // invisible — the forward-compat contract.
  const signals = new Map<string, FoldedSignal>();
  const signalCands = candidatesOf(VSK_SIGNALS, holders(...Object.values(SIGNAL_GATES)));
  for (const [signalId, gate] of Object.entries(SIGNAL_GATES)) {
    const candidates = signalCands.get(bytesToHex(signalLocator(communityId, signalId))) ?? [];
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (!may(p, gate)) return false;
      if (!citationOk(p)) return false;
      return validateSignal(signalId, p.content, p.createdAt);
    }, rankOf);
    if (!head) continue;
    signals.set(signalId, {
      content: JSON.parse(head.content) as Record<string, unknown>,
      author: head.author,
      at: head.createdAt,
    });
  }

  // 9. On the vsk-13 Roster: overwrites (vsk 14), syncs (vsk 17), Categories (vsk 15)
  // and Writers ledgers (vsk 18).
  const categories = new Map<string, FoldedCategory>();
  const writers = new Map<string, Ledger>();
  const ledgerContents = new Map<string, string>();
  if (ranked) {
    // Writers ledgers, under MANAGE_CHANNELS: each edition appends exactly one entry
    // to its predecessor's (CORD-03 §1), so a head that doesn't is refused.
    const ledgerCands = byVsk.get(VSK_WRITERS) ?? new Map<string, ParsedEdition[]>();
    const ledgerEids = new Set([...ledgerCands.keys(), ...Object.keys(stored?.writers ?? {})]);
    for (const eid of ledgerEids) {
      const candidates = ledgerCands.get(eid) ?? [];
      const ledgerOf = (p: { content: string }) => {
        const l = parseLedger(p.content);
        return l && bytesToHex(writersLocator(communityId, hex32(l.channel))) === eid ? l : undefined;
      };
      // The head this reader holds, while no relay serves it: what an edition built on it
      // must extend, and what stands when nothing served does (Vector's ledger anchor).
      const floor = floorOf(eid, VSK_WRITERS);
      const heldContent = stored?.writers?.[eid];
      const held = floor && heldContent !== undefined && !candidates.some((x) => bytesEq(x.selfHash, floor.hash)) ? ledgerOf({ content: heldContent }) : undefined;
      // Judged along the chain: an edition stands only on a predecessor that stands, its
      // new entry dated within ten minutes of its own time and at most an hour past the
      // reader's clock, a writer entry naming its signer as minter (CORD-03 §1).
      const judged = new Map<ParsedEdition, boolean>();
      const nowMs = clockNowMs();
      const gate = (p: ParsedEdition): boolean => {
        const memo = judged.get(p);
        if (memo !== undefined) return memo;
        judged.set(p, false);
        const ok = ((): boolean => {
          const l = ledgerOf(p);
          if (!l || !may(p, Permissions.MANAGE_CHANNELS) || !citationOk(p)) return false;
          const last = l.entries[l.entries.length - 1];
          if (!last || Math.abs(last.at - p.createdAt * 1000) > LEDGER_ENTRY_SKEW_MS || last.at > nowMs + LEDGER_HORIZON_MS) return false;
          if (last.spell.kind === "writer" && last.spell.by !== p.author) return false;
          if (!p.prevHash) return p.version === 1n && l.entries.length === 1 && l.retired.length === 0;
          const prev = candidates.find((x: ParsedEdition) => bytesEq(x.selfHash, p.prevHash));
          if (!prev) return !(held && floor && bytesEq(floor.hash, p.prevHash)) || ledgerExtends(l, held);
          const before = ledgerOf(prev);
          return before !== undefined && gate(prev) && ledgerExtends(l, before);
        })();
        judged.set(p, ok);
        return ok;
      };
      const ordered = headCandidates(candidates, floorOf(eid, VSK_WRITERS), undefined, () => gapHeld.add(eid), { mode: "filter", admit: gate });
      const head = pickHead(ordered, heads, headEditions, gate, () => 0);
      const l = head && ledgerOf(head);
      if (l) {
        writers.set(l.channel, l);
        ledgerContents.set(eid, head.content);
      } else if (held && heldContent !== undefined) {
        writers.set(held.channel, held);
        ledgerContents.set(eid, heldContent);
      }
    }

    /**
     * One overwrite's or sync's head, Vector's way: the newest admitted edition chained
     * from the floor; a held edition served but now refused falls back as a reader
     * holding no floor would (the floor moves down to it); one not served at all is withheld.
     */
    const foldAmong = (eid: string, vsk: string, list: ParsedEdition[], ok: (p: ParsedEdition) => boolean): { head?: ParsedEdition; withheld?: boolean } => {
      const floor = floorOf(eid, vsk);
      const head = pickHead(headCandidates(list, floor, undefined, () => gapHeld.add(eid), { mode: "filter", admit: ok }), heads, headEditions, ok, rankOf);
      if (head) return { head };
      if (!floor) return {};
      const heldServed = list.some((e) => e.version === floor.version && bytesEq(e.selfHash, floor.hash) && (floor.rumorId === undefined || floor.rumorId === bytesToHex(e.rumorId)));
      if (!heldServed) return { withheld: true };
      const below = pickHead(headCandidates(list, undefined, undefined, undefined, { mode: "filter", admit: ok }), heads, headEditions, ok, rankOf);
      if (below) heads.set(eid, headOf(below, true));
      return below ? { head: below } : {};
    };

    // Overwrites, each judged on itself by downward support (CORD-04 §8).
    const overwrites: Overwrite[] = [];
    const overwriteOf = (p: ParsedEdition): Overwrite | undefined => {
      const o = parseOverwrite(p.content);
      return o && bytesToHex(overwriteLocator(communityId, o)) === bytesToHex(p.entityId) ? o : undefined;
    };
    const overwriteOk = (p: ParsedEdition): boolean => {
      const o = overwriteOf(p);
      return o !== undefined && overwriteAuthorized(roster, ownerHex, banned, sealed, o, p.author, bytesToHex(p.selfHash));
    };
    const overwritesHeld = new Set<string>();
    for (const [eid, all] of byVskLinked.get(VSK_ACL) ?? new Map<string, ParsedEdition[]>()) {
      const list = all.filter((p) => overwriteOf(p) !== undefined);
      if (list.length === 0) continue;
      overwritesHeld.add(eid);
      if (!list.some(overwriteOk)) continue;
      const { head, withheld } = foldAmong(eid, VSK_ACL, list, overwriteOk);
      if (withheld) overwritesHeld.delete(eid);
      const o = head && overwriteOf(head);
      if (o && (o.allow !== 0n || o.deny !== 0n)) overwrites.push(o);
    }
    // What the reader held for a floored overwrite a relay isn't serving stays (Vector).
    for (const o of stored?.overwrites ?? []) {
      const eid = bytesToHex(overwriteLocator(communityId, o));
      if (!priorHeads?.has(eid) || overwritesHeld.has(eid)) continue;
      if (!overwrites.some((x) => x.scope === o.scope && sameTarget(x.target, o.target))) overwrites.push(o);
    }
    roster = { ...roster, overwrites };

    // Syncs: the signer must be able to write every overwrite the sync swaps, the
    // Category it leaves included (named by its predecessor, which must be served).
    const syncs: Record<string, string> = {};
    const syncsHeld = new Set<string>();
    for (const [eid, all] of byVskLinked.get(VSK_SYNC) ?? new Map<string, ParsedEdition[]>()) {
      const syncOf = (p: ParsedEdition) => {
        const sy = parseSync(p.content);
        return sy && bytesToHex(syncLocator(communityId, hex32(sy.channel))) === eid ? sy : undefined;
      };
      const candidates = all.filter((p) => syncOf(p) !== undefined);
      if (candidates.length === 0) continue;
      const syncOk = (p: ParsedEdition): boolean => {
        const sy = syncOf(p);
        if (!sy) return false;
        if (banned.has(p.author) && p.author !== ownerHex && !isListed(sealed, p.author, bytesToHex(p.selfHash))) return false;
        let left: string | undefined;
        if (p.prevHash) {
          const prev = candidates.find((x: ParsedEdition) => bytesEq(x.selfHash, p.prevHash));
          if (!prev) return false;
          left = syncOf(prev)?.category;
        }
        const scopes = [sy.channel, ...(sy.category ? [sy.category] : []), ...(left ? [left] : [])];
        return maySwapOverwrites(roster, ownerHex, p.author, scopes, (rank) => sealOf(sealed, p.author, bytesToHex(p.selfHash), rank));
      };
      syncsHeld.add(eid);
      if (!candidates.some(syncOk)) continue;
      const { head, withheld } = foldAmong(eid, VSK_SYNC, candidates, syncOk);
      if (withheld) syncsHeld.delete(eid);
      const sy = head && syncOf(head);
      if (sy?.category) syncs[sy.channel] = sy.category;
    }
    for (const [channel, category] of Object.entries(stored?.syncs ?? {})) {
      const eid = bytesToHex(syncLocator(communityId, hex32(channel)));
      if (priorHeads?.has(eid) && !syncsHeld.has(eid) && !(channel in syncs)) syncs[channel] = category;
    }
    roster = { ...roster, syncs };

  }

  // Categories, edited under MANAGE_CHANNELS like any Channel (CORD-03 §4), on either
  // Roster (Vector `apply_control_fold`).
  const notCategories = takenBy(VSK_CATEGORY);
  for (const [eid, candidates] of candidatesOf(VSK_CATEGORY, holders(Permissions.MANAGE_CHANNELS))) {
    if (notCategories.has(eid)) continue;
    const gate = (p: ParsedEdition) => may(p, Permissions.MANAGE_CHANNELS) && citationOk(p);
    // A malformed edition stands as the head and applies nothing (CORD-03 §4).
    const head = pickHead(candidates, heads, headEditions, gate, rankOf);
    if (!head) continue;
    const applied = readCategory(head.content) !== undefined
      ? head
      : candidates.find((p) => p.version <= head.version && gate(p) && readCategory(p.content) !== undefined);
    if (!applied) continue;
    const read = readCategory(applied.content)!;
    const deletions = servedOf(VSK_CATEGORY, eid).filter((p) => gate(p) && readCategory(p.content)?.deleted === true);
    const everDeleted = deletions.length > 0;
    if (everDeleted) settleOnDeletion(eid, deletions, heads, headEditions);
    categories.set(eid, { idHex: eid, ...read, deleted: read.deleted || everDeleted });
  }
  for (const k of stored?.categories ?? []) {
    if (priorHeads?.has(k.idHex) && !categories.has(k.idHex) && !notCategories.has(k.idHex)) categories.set(k.idHex, k);
  }
  // A reader folds at most 100 Categories, the lowest ids not deleted.
  const live = [...categories.values()].filter((c) => !c.deleted).map((c) => c.idHex).sort();
  for (const id of live.slice(MAX_CATEGORIES)) categories.delete(id);

  // Data availability: gap-held entities plus floored ones with ZERO served
  // editions. Authority-rejected ones aren't flagged, or ban→refound would abort.
  const servedEids = new Set<string>();
  for (const m of byVsk.values()) for (const eid of m.keys()) servedEids.add(eid);
  const incomplete = [...gapHeld];
  for (const eid of priorHeads?.keys() ?? []) {
    if (!servedEids.has(eid) && !gapHeld.has(eid)) incomplete.push(eid);
  }

  const result: FoldedControl = {
    roster, ownerHex, metadata, channels, banned, bannedAt, liveInviteLinks, registriesByCreator, pinLists, signals, heads, headEditions, incomplete,
    ...(!ranked && categories.size > 0 ? { categories } : {}),
    ...(ranked ? { rankedRoster: true, categories, tenure: sealed, writers, ledgerContents, everyoneServed, ...(rosterComplete !== undefined ? { rosterComplete } : {}) } : {}),
  };
  return result;
}

/** How far a Writers ledger entry may sit from its edition's own time (CORD-03 §1). */
const LEDGER_ENTRY_SKEW_MS = 10 * 60_000;
/** CORD-02 §5's horizon: an entry dated past it is refused. */
const LEDGER_HORIZON_MS = 60 * 60_000;

/** The most entries a Banlist stands for (CORD-04 §4). */
export const MAX_BANLIST = 500;

/** The most Categories a reader folds (CORD-03 §4). */
export const MAX_CATEGORIES = 100;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * A Channel edition's content (CORD-03 §2), or undefined when it breaks its form.
 * A Private Channel may carry the SEALED form, whose details only its key opens,
 * whichever Roster the Community folds; `position`, `category` and `topic` outside their form read as absent.
 */
export function readChannelContent(
  content: string,
): { metadata: ChannelMetadata; sealed?: Omit<SealedChannelMeta, "prevHex"> } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (c.deleted !== undefined && typeof c.deleted !== "boolean") return undefined;
  if (c.private === true && typeof c.sealed === "string") {
    if (typeof c.epoch !== "string" || !DECIMAL.test(c.epoch)) return undefined;
    return {
      metadata: { name: "", private: true, ...(c.deleted === true ? { deleted: true } : {}) },
      sealed: { epoch: BigInt(c.epoch), sealed: c.sealed },
    };
  }
  if (typeof c.private !== "boolean") return undefined;
  const metadata = sanitizeChannelFields(c);
  return metadata ? { metadata } : undefined;
}

/** A Category edition's content (CORD-03 §4), or undefined when it breaks its form. */
export function readCategory(content: string): Omit<FoldedCategory, "idHex"> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { name, position, deleted, ...extra } = raw as Record<string, unknown>;
  if (deleted === true) return { name: "", deleted: true, extra: {} };
  return {
    name: typeof name === "string" ? cutName(name) : "",
    ...(isRankKey(position) ? { position } : {}),
    deleted: false,
    extra,
  };
}

// ── Dissolution (CORD-02 §9) ─────────────────────────────────────────────────


/**
 * The owner-dissolution tombstone rumor: chainless, empty content, `eid` = the
 * community_id, published at `dissolved_pk` (derived from the id alone).
 *
 * The `eid` binding is MANDATORY: anyone can sign at the public dissolved address,
 * and with the frozen §9 all-zero `eid` an owner's tombstone for X could be
 * re-wrapped to permanently kill any other community they own.
 */
export function buildDissolvedRumor(
  ownerPubkey: string,
  communityId: Uint8Array,
  createdAtSecs?: number,
): NostrRumor {
  return buildRumor({
    kind: 3308,
    content: "",
    tags: [
      ["vsk", VSK_DISSOLVED],
      ["eid", bytesToHex(communityId)],
    ],
    pubkey: ownerPubkey,
    ms: null,
    createdAtSecs,
  });
}

/** Sign + wrap the dissolution tombstone at the community's dissolved address. */
export async function sealDissolved(communityId: Uint8Array, ownerPubkey: string, signer: StreamSigner): Promise<NostrEvent> {
  const group = dissolvedGroupKey(communityId);
  const rumor = buildDissolvedRumor(ownerPubkey, communityId);
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, group, signer);
  return wrapSeal(seal, group);
}

/**
 * Whether any wrap is a valid owner-signed tombstone for this community (others
 * are noise). Terminal: the community goes read-only.
 */
export function isDissolved(wraps: NostrEvent[], communityId: Uint8Array, ownerHex: string): boolean {
  const group = dissolvedGroupKey(communityId);
  for (const wrap of wraps) {
    let opened: OpenedEvent;
    try {
      opened = openWrap(wrap, group);
    } catch {
      continue;
    }
    if (isDissolvedOpened(opened, ownerHex, communityId)) return true;
  }
  return false;
}

/**
 * Whether an opened dissolved-address event is a valid owner tombstone FOR THIS
 * COMMUNITY. The `eid` is the replay binding (see {@link buildDissolvedRumor});
 * an all-zero `eid` is REFUSED — accepting it is the vulnerability.
 */
export function isDissolvedOpened(opened: OpenedEvent, ownerHex: string, communityId: Uint8Array): boolean {
  // Authenticated by the SEAL SIGNER, not the arrival address. The seal form
  // (plaintext, CORD-02 §5) is checked while known (see parseEdition).
  if (opened.author !== ownerHex) return false;
  if (opened.sealKind !== undefined && opened.sealKind !== KIND_SEAL_PLAINTEXT) return false;
  const vsk = opened.tags.find((t) => t[0] === "vsk")?.[1];
  const eid = opened.tags.find((t) => t[0] === "eid")?.[1];
  return opened.kind === 3308 && vsk === VSK_DISSOLVED && eid === bytesToHex(communityId);
}
