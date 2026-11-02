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

import type { NostrEvent } from "nostr-tools/pure";

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
  canActOnPosition,
  emptyRoles,
  grantFromJSON,
  grantToJSON,
  hasPermission,
  highestPosition,
  isAuthorized,
  MAX_ROLES_PER_COMMUNITY,
  outranks,
  Permissions,
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
  sealOf,
  type RosterFloors,
  type SealedBy,
} from "@/concord/lib/roster";
import { isRankKey } from "@/concord/lib/rankKey";
import { ledgerExtends, parseLedger, type Ledger } from "@/concord/lib/writers";
import { buildRumor, openWrap, sealRumor, wrapSeal, type OpenedEvent, type StreamSigner } from "@/concord/lib/stream";
import { readFoldedShared } from "@/lib/foldedCache";
import type { NostrRumor } from "@/lib/nostrRumor";
import { perfCount } from "@/lib/perf";
import { t } from "@/i18n/intl";
import {
  utf8Len,
  DESCRIPTION_MAX_BYTES,
  NAME_MAX_BYTES,
  capRelays,
  isImagePointer,
  normalizeChannelMetadata,
  type ChannelMetadata,
  type CommunityMetadata,
  type Community,
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

/** Grant (vsk 3); eid = grant_locator(cid, member). Empty role_ids = a revoke. */
export function buildGrantEdition(communityId: Uint8Array, grant: MemberGrant, o: BuildCommon): NostrRumor {
  const entityId = grantLocator(communityId, hex32(grant.member));
  return buildEditionRumor({ vsk: VSK_GRANT, entityId, content: grantToJSON(grant), ...o });
}

/** Banlist (vsk 4); eid = banlist_locator(cid). The whole list, replaced entire. */
export function buildBanlistEdition(communityId: Uint8Array, banned: string[], o: BuildCommon): NostrRumor {
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
}

function headOf(p: ParsedEdition): EntityHead {
  return { version: p.version, hash: p.selfHash, rumorId: bytesToHex(p.rumorId), author: p.author };
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
): ParsedEdition[] {
  const ordered: ParsedEdition[] = [];
  const seenRumors = new Set<string>();
  let gapped = false;
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
    let result = fold(walked.map(toFoldEdition), floor?.version ?? 0n, floor?.hash);

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

    if (result.head !== null && !gapped) {
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
      // Under a gap, only the floor's own version remains admissible...
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
  const citedOk = (p: ParsedEdition): boolean =>
    citationSatisfied({ heads, ownerHex }, communityId, p.author, p.authority);

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

    // Roles: owner defines any (position ≥ 1); a non-owner needs MANAGE_ROLES and must
    // strictly outrank both the minted position and the standing position replaced.
    for (const eid of roleEids) {
      if (settledRoles.has(eid)) continue;
      const candidates = roleCandidates.get(eid)!;
      if (!ranksFrozen && candidates.some((c) => rankPending(c.author))) continue;
      const admissible = new Set<ParsedEdition>();
      let standing: number | undefined; // the admissible predecessor's position
      for (const group of versionGroups(candidates)) {
        for (const { role, author, parsed } of [...group].sort(authorityFirst)) {
          const mintOk = author === ownerHex || canActOnPosition(roster, author, ownerHex, role.position, Permissions.MANAGE_ROLES);
          const replaceOk = author === ownerHex || standing === undefined || outranks(roster, author, ownerHex, standing);
          if (!mintOk || !replaceOk || !citedOk(parsed)) continue;
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
          const positions = grant.roleIds
            .map((rid) => roster.roles.find((r) => r.roleId === rid)?.position)
            .filter((p): p is number => p !== undefined);
          const allKnown = positions.length === grant.roleIds.length;
          const ok =
            author === ownerHex ||
            (allKnown &&
              hasPermission(roster, author, Permissions.MANAGE_ROLES) &&
              positions.every((pos) => outranks(roster, author, ownerHex, pos)) &&
              (standing === undefined || outranks(roster, author, ownerHex, standing)));
          if (!ok || !citedOk(parsed)) continue;
          admissible.add(parsed);
          standing = positions.length ? Math.min(...positions) : undefined;
          break; // one winner per version
        }
      }
      const pick = candidates.find((c) => admissible.has(c.parsed));
      if (!pick) continue;
      roster.grants.push(pick.grant);
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
): FoldedControl {
  const start = performance.now();
  const cidHex = bytesToHex(communityId);
  const floorSig = priorHeads
    ? [...priorHeads.entries()].map(([k, v]) => `${k}@${v.version}`).sort().join(",")
    : "";
  // Attribution (a re-wrap arriving) can change without the edition set changing.
  const snapSig = snapshotIds ? [...snapshotIds].sort().join(",") : "";
  // By RUMOR id: `snapSig` already covers re-wrap attribution.
  const memoKey = `${cidHex}:${ownerHex}:${floorSig}:${snapSig}:${editions.map((e) => e.opened.rumorId).sort().join(",")}`;
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
  const first = foldOnce(editions, communityId, ownerHex, priorHeads, snapshotIds);
  // The owner is supreme (CORD-04 §2): strip them from `banned` HERE, on the set
  // every reader consumes, or a BAN holder could silence the owner everywhere.
  const banned = new Set([...first.banned].filter((pk) => pk !== ownerHex));
  let result: FoldedControl = banned.size === first.banned.size ? first : { ...first, banned };
  if (banned.size > 0 && editions.some((e) => banned.has(e.author))) {
    // Pass 1 stays authoritative for `incomplete`: pass 2's gaps are semantic drops,
    // not data loss, and must not block ban→refound. A ban takes what its target
    // wrote, except what a Tenure keeps (CORD-04 §4, §9).
    const sealed = first.tenure ?? new Map();
    const kept = editions.filter((e) => !banned.has(e.author) || isListed(sealed, e.author, bytesToHex(e.selfHash)));
    result = {
      ...foldOnce(kept, communityId, ownerHex, priorHeads, snapshotIds, banned),
      banned,
      bannedAt: first.bannedAt,
      incomplete: first.incomplete,
    };
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
): FoldedControl {
  const cidHex = bytesToHex(communityId);

  // 1. Group by (vsk, entity).
  const byVsk = new Map<string, Map<string, ParsedEdition[]>>();
  for (const p of editions) {
    let m = byVsk.get(p.vsk);
    if (!m) byVsk.set(p.vsk, (m = new Map()));
    pushEdition(m, bytesToHex(p.entityId), p);
  }

  const heads = new Map<string, EntityHead>();
  const headEditions = new Map<string, ParsedEdition>();
  const gapHeld = new Set<string>();
  /** Ordered head candidates per entity of one vsk (floored per prior head). */
  const candidatesOf = (vsk: string, admit?: HeadAdmit): Map<string, ParsedEdition[]> => {
    const out = new Map<string, ParsedEdition[]>();
    for (const [eid, list] of byVsk.get(vsk) ?? new Map<string, ParsedEdition[]>()) {
      // If any edition arrived under the current control group, anchor there (see
      // headCandidates).
      const snap = snapshotIds ? list.filter((p: ParsedEdition) => snapshotIds.has(bytesToHex(p.rumorId))) : [];
      out.set(
        eid,
        headCandidates(list, priorHeads?.get(eid), snap.length > 0 ? snap : undefined, () => gapHeld.add(eid), admit),
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
    return authorizeDelegation(roleCandidates, grantCandidates, communityId, ownerHex, heads, headEditions);
  };
  // The vsk-13 Roster (CORD-04 §2) once an owner-rooted `@everyone` stands; the legacy fixpoint before.
  const rosterFloors: RosterFloors = new Map(
    [...(priorHeads ?? [])].map(([eid, h]) => [eid, { version: h.version, hash: h.hash, rumorId: h.rumorId, author: h.author }]),
  );
  const ranked = rosterActivated(editions, communityId, ownerHex, rosterFloors);
  let sealed: SealedBy = new Map();
  let roster: CommunityRoles;
  if (ranked) {
    const folded = foldRankedRoster(editions, communityId, ownerHex, rosterFloors, excluded);
    roster = folded.roles;
    sealed = folded.sealed;
    for (const h of folded.heads) {
      heads.set(h.eid, headOf(h.edition));
      headEditions.set(h.eid, h.edition);
    }
    for (const eid of folded.gapped) gapHeld.add(eid);
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
  // A Channel edition aimed at another entity's coordinate is no Channel (CORD-03 §2).
  const notChannels = new Set([cidHex, bytesToHex(everyoneLocator(communityId)), bytesToHex(banlistLocator(communityId))]);
  const channels = new Map<string, FoldedChannel>();
  for (const [eid, candidates] of candidatesOf(VSK_CHANNEL, holders(Permissions.MANAGE_CHANNELS))) {
    if (notChannels.has(eid)) continue;
    const channelGate = (p: ParsedEdition): boolean => {
      if (!may(p, Permissions.MANAGE_CHANNELS)) return false;
      if (!citationOk(p)) return false;
      if (legacyChannels && !p.binding && !legacyChannels.has(eid)) return false;
      return readChannelContent(p.content, ranked) !== undefined;
    };
    const head = pickHead(candidates, heads, headEditions, channelGate, rankOf);
    if (!head) continue;
    const read = readChannelContent(head.content, ranked)!;
    const meta = read.metadata;
    // CORD-03 §2: deletion is terminal — a later edition can't lift it. Decided over
    // the whole accepted chain (members may have discarded keys; a resurrection would
    // split them), gated by the same predicate as the head.
    const everDeleted = candidates.some((p) => channelGate(p) && readChannelContent(p.content, ranked)?.metadata.deleted === true);
    channels.set(eid, {
      channelIdHex: eid,
      name: meta.name,
      isPrivate: meta.private === true,
      deleted: meta.deleted === true || everDeleted,
      metadata: everDeleted ? { ...meta, deleted: true } : meta,
      ...(read.sealed ? { sealed: { ...read.sealed, ...(head.prevHash ? { prevHex: bytesToHex(head.prevHash) } : {}) } } : {}),
    });
  }

  // 5. Banlist (vsk 4): the one anti-roster; unauthorized head → empty (fail closed).
  const banned = new Set<string>();
  const bannedAt = new Map<string, number>();
  {
    const eid = bytesToHex(banlistLocator(communityId));
    const candidates = candidatesOf(VSK_BANLIST, holders(Permissions.BAN)).get(eid) ?? [];
    /** The npubs an edition names, normalized; undefined if it is not a list. */
    const parseList = (p: ParsedEdition): string[] | undefined => {
      let list: unknown;
      try {
        list = JSON.parse(p.content);
      } catch {
        return undefined;
      }
      if (!Array.isArray(list)) return undefined;
      return list
        .filter((pk): pk is string => typeof pk === "string" && /^[0-9a-f]{64}$/i.test(pk))
        .map((pk) => pk.toLowerCase());
    };

    /**
     * Banning acts on a member: BAN AND strict outrank (as kicks and grants), so a
     * Moderator can't ban Admins. `canActOnMember` also refuses the owner.
     */
    const entitled = (author: string, pk: string): boolean =>
      canActOnMember(roster, author, ownerHex, pk, Permissions.BAN);

    // On the vsk-13 Roster the bit must come from the author's Roles: `@everyone`'s bits author no Banlist (CORD-04 §2).
    const bans = (p: ParsedEdition): boolean =>
      ranked
        ? p.author === ownerHex ||
          (permissionsAboveIn(roster, p.author, BENEATH_EVERY_ROLE) & Permissions.BAN) !== 0n ||
          (sealOf(sealed, p.author, bytesToHex(p.selfHash), BENEATH_EVERY_ROLE) & Permissions.BAN) !== 0n
        : isAuthorized(roster, p.author, ownerHex, Permissions.BAN);
    const wellFormed = (p: ParsedEdition): boolean => bans(p) && citationOk(p) && parseList(p) !== undefined;

    /** Equal-version fork siblings, highest authority first (the id is grindable; rank is not). */
    const banlistAuthorityFirst = (a: ParsedEdition, b: ParsedEdition): number => {
      const ra = rankOf(a.author);
      const rb = rankOf(b.author);
      if (ra !== rb) return ra - rb;
      const ia = bytesToHex(a.rumorId);
      const ib = bytesToHex(b.rumorId);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    };

    /**
     * Walk versions ascending, carrying the standing list: an author the standing
     * list bans is inadmissible (a banned mod can't unban themselves), and an edition
     * rewrites only entries its author is entitled to (the rest carry over).
     */
    const standingAt = new Map<ParsedEdition, Set<string>>();
    const admissible = new Set<ParsedEdition>();
    let standing = new Set<string>();
    for (const group of versionGroups(candidates.map((parsed) => ({ parsed })))) {
      for (const { parsed: p } of [...group].sort((a, b) => banlistAuthorityFirst(a.parsed, b.parsed))) {
        if (!wellFormed(p) || standing.has(p.author)) continue;
        const named = new Set(parseList(p)!.filter((pk) => entitled(p.author, pk)));
        for (const pk of standing) if (!entitled(p.author, pk)) named.add(pk);
        standing = named;
        standingAt.set(p, named);
        admissible.add(p);
        break;
      }
    }

    // The chain picks the head; read the list as of that edition, not the walk's end.
    const head = pickHead(candidates, heads, headEditions, (p) => admissible.has(p), rankOf);
    if (head) for (const pk of standingAt.get(head) ?? []) banned.add(pk);

    // Ban history (see FoldedControl.bannedAt): the newest ADMISSIBLE edition naming
    // each npub, counting only names its author could name. `createdAt` is seconds.
    for (const p of candidates) {
      if (!admissible.has(p)) continue;
      for (const pk of parseList(p)!) {
        if (!entitled(p.author, pk)) continue;
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
    admit: (p) => holders(Permissions.CREATE_INVITE).admit(p) && bytesToHex(inviteLinksLocator(communityId, hex32(p.author))) === bytesToHex(p.entityId),
  })) {
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (bytesToHex(inviteLinksLocator(communityId, hex32(p.author))) !== eid) return false;
      if (!may(p, Permissions.CREATE_INVITE)) return false;
      if (!citationOk(p)) return false;
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
  if (ranked) {
    // Writers ledgers, under MANAGE_CHANNELS: each edition appends exactly one entry
    // to its predecessor's (CORD-03 §1), so a head that doesn't is refused.
    for (const [eid, candidates] of byVsk.get(VSK_WRITERS) ?? new Map<string, ParsedEdition[]>()) {
      const ledgerOf = (p: ParsedEdition) => {
        const l = parseLedger(p.content);
        return l && bytesToHex(writersLocator(communityId, hex32(l.channel))) === eid ? l : undefined;
      };
      const gate = (p: ParsedEdition): boolean => {
        const l = ledgerOf(p);
        if (!l || !may(p, Permissions.MANAGE_CHANNELS) || !citationOk(p)) return false;
        if (!p.prevHash) return l.entries.length === 1 && l.retired.length === 0;
        const prev = candidates.find((x: ParsedEdition) => bytesEq(x.selfHash, p.prevHash));
        const before = prev && ledgerOf(prev);
        return before === undefined || ledgerExtends(l, before);
      };
      const ordered = headCandidates(candidates, priorHeads?.get(eid), undefined, () => gapHeld.add(eid), { mode: "filter", admit: gate });
      const head = pickHead(ordered, heads, headEditions, gate, () => 0);
      const l = head && ledgerOf(head);
      if (l) writers.set(l.channel, l);
    }

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
    for (const [, candidates] of candidatesOf(VSK_ACL, { mode: "filter", admit: overwriteOk })) {
      const head = pickHead(candidates, heads, headEditions, overwriteOk, rankOf);
      const o = head && overwriteOf(head);
      if (o && (o.allow !== 0n || o.deny !== 0n)) overwrites.push(o);
    }
    roster = { ...roster, overwrites };

    // Syncs: the signer must be able to write every overwrite the sync swaps, the
    // Category it leaves included (named by its predecessor, which must be served).
    const syncs: Record<string, string> = {};
    for (const [eid, candidates] of byVsk.get(VSK_SYNC) ?? new Map<string, ParsedEdition[]>()) {
      const syncOf = (p: ParsedEdition) => {
        const sy = parseSync(p.content);
        return sy && bytesToHex(syncLocator(communityId, hex32(sy.channel))) === eid ? sy : undefined;
      };
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
      const ordered = headCandidates(candidates, priorHeads?.get(eid), undefined, () => gapHeld.add(eid), { mode: "filter", admit: syncOk });
      const head = pickHead(ordered, heads, headEditions, syncOk, rankOf);
      const sy = head && syncOf(head);
      if (sy?.category) syncs[sy.channel] = sy.category;
    }
    roster = { ...roster, syncs };

    // Categories, edited under MANAGE_CHANNELS like any Channel (CORD-03 §4).
    for (const [eid, candidates] of candidatesOf(VSK_CATEGORY, holders(Permissions.MANAGE_CHANNELS))) {
      if (notChannels.has(eid)) continue;
      const gate = (p: ParsedEdition) => may(p, Permissions.MANAGE_CHANNELS) && citationOk(p) && readCategory(p.content) !== undefined;
      const head = pickHead(candidates, heads, headEditions, gate, rankOf);
      if (!head) continue;
      const read = readCategory(head.content)!;
      const everDeleted = candidates.some((p) => gate(p) && readCategory(p.content)?.deleted === true);
      categories.set(eid, { idHex: eid, ...read, deleted: read.deleted || everDeleted });
    }
    // A reader folds at most 100 Categories, the lowest ids not deleted.
    const live = [...categories.values()].filter((c) => !c.deleted).map((c) => c.idHex).sort();
    for (const id of live.slice(MAX_CATEGORIES)) categories.delete(id);
  }

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
    ...(ranked ? { rankedRoster: true, categories, tenure: sealed, writers } : {}),
  };
  return result;
}

/** The most Categories a reader folds (CORD-03 §4). */
export const MAX_CATEGORIES = 100;

const CHANNEL_TOPIC_MAX_BYTES = 1024;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * A Channel edition's content (CORD-03 §2), or undefined when it breaks its form.
 * On the vsk-13 Roster a Private Channel may carry the SEALED form, whose details
 * only its key opens; `position`, `category` and `topic` outside their form read as absent.
 */
export function readChannelContent(
  content: string,
  sealedAllowed: boolean,
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
  if (sealedAllowed && c.private === true && typeof c.sealed === "string") {
    if (typeof c.epoch !== "string" || !DECIMAL.test(c.epoch)) return undefined;
    return {
      metadata: { name: "", private: true, ...(c.deleted === true ? { deleted: true } : {}) },
      sealed: { epoch: BigInt(c.epoch), sealed: c.sealed },
    };
  }
  if (typeof c.name !== "string" || typeof c.private !== "boolean") return undefined;
  if (c.custom !== undefined && (!c.custom || typeof c.custom !== "object" || Array.isArray(c.custom))) return undefined;
  const meta = { ...c } as ChannelMetadata;
  meta.name = cutName(meta.name);
  if (meta.name.length === 0) return undefined;
  if (meta.position !== undefined && !isRankKey(meta.position)) delete meta.position;
  if (meta.category !== undefined && (typeof meta.category !== "string" || !/^[0-9a-f]{64}$/i.test(meta.category))) delete meta.category;
  if (meta.topic !== undefined && (typeof meta.topic !== "string" || meta.topic.length === 0 || utf8Len(meta.topic) > CHANNEL_TOPIC_MAX_BYTES)) delete meta.topic;
  return { metadata: normalizeChannelMetadata(meta) };
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
