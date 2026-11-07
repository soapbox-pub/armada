/**
 * Writing a Tenure (CORD-04 §9): what a member's sealer publishes, in the same
 * action that reduces their authority, so the decisions they made keep standing.
 */

import { readCategory, readChannelContent, type FoldedControl } from "@/concord/lib/control";
import type { ParsedEdition } from "@/concord/lib/edition";
import { buildEditionRumor, type AuthorityCitation } from "@/concord/lib/edition";
import { bytesToHex, editionBinding, hex32, tenureLocator } from "@/concord/lib/derive";
import { Permissions, permissionsAbove, rolesOf } from "@/concord/lib/roles";
import { AUTHORITY_VSKS, MAX_TENURE_ENTRIES, MAX_TENURE_HEADS, VSK_CATEGORY, VSK_TENURE, parseTenure, tenureToJSON, type TenureEntry } from "@/concord/lib/roster";
import type { NostrRumor } from "@/lib/nostrRumor";
import { t } from "@/i18n/intl";

/** A Channel or Category deletion: terminal, so a budget cut must never take one. */
function deletes(e: ParsedEdition): boolean {
  if (e.vsk === VSK_CATEGORY) return readCategory(e.content)?.deleted === true;
  return e.vsk === "2" && readChannelContent(e.content)?.metadata.deleted === true;
}

/** Deletions first, then the Roster's own heads, then the rest (Vector `seal_order`). */
function sealRank(e: ParsedEdition): number {
  if (!AUTHORITY_VSKS.has(e.vsk) && deletes(e)) return 0;
  return AUTHORITY_VSKS.has(e.vsk) ? 1 : 2;
}

export type TenurePlan =
  /** Nothing to seal: the member authored no standing head, or holds no Role. */
  | { kind: "none" }
  /** The reduction must wait for a sealer who can seal it whole. */
  | { kind: "refuse"; reason: "incomplete" | "unsealable" | "unseen" }
  | { kind: "write"; rumor: NostrRumor };

/**
 * The Tenure `sealer` writes for `member` before reducing their authority. A
 * Role edit or a strip (`removal` false) is refused when the sealer can't seal
 * the member's whole standing; a Kick or a ban seals what the sealer holds above
 * them, or nothing. A Role edit is refused on a fold short of the plane, since a
 * head it missed would fall away silently; a removal never waits on it (Vector `Seal::BestEffort`).
 */
export function planTenure(
  folded: FoldedControl,
  communityId: Uint8Array,
  sealer: string,
  member: string,
  removal: boolean,
  authority?: AuthorityCitation,
  /** Hashes of every edition read, and of each decided head's predecessor: a Tenure of theirs sealing anything else is left out. */
  served?: ReadonlySet<string>,
): TenurePlan {
  if (!folded.rankedRoster || member === folded.ownerHex || member === sealer) return { kind: "none" };
  if (folded.incomplete.length > 0 && !removal) return { kind: "refuse", reason: "incomplete" };
  const roles = rolesOf(folded.roster, member);
  if (roles.length === 0) return { kind: "none" };
  const highest = roles.reduce((a, r) => (r.position < a.position ? r : a));
  if (!highest.rank) return { kind: "none" };
  // Sealing a Tenure that lists an edition nobody has seen would let its signer publish it later on this standing.
  const vouchesForServed = (e: ParsedEdition) =>
    !served || e.vsk !== VSK_TENURE || (parseTenure(e.content)?.sealed ?? []).every((x) => x.heads.every((h) => served.has(h)));
  // Every standing Control head the member authored, in the order a budget cut spares.
  const authored = [...folded.headEditions.values()].filter((e) => e.author === member && vouchesForServed(e));
  // Checked first: a member who decided nothing owes no Tenure, whatever they hold (Vector `seal_standing`).
  if (authored.length === 0) return { kind: "none" };
  const held = roles.reduce((acc, r) => acc | r.permissions, 0n);
  const support = sealer === folded.ownerHex ? held : permissionsAbove(folded.roster, sealer, highest.position);
  if (sealer !== folded.ownerHex && (support & Permissions.MANAGE_ROLES) === 0n) {
    return removal ? { kind: "none" } : { kind: "refuse", reason: "unsealable" };
  }
  if ((held & ~support) !== 0n && !removal) return { kind: "refuse", reason: "unsealable" };
  const permissions = held & support;

  authored.sort((a, b) => sealRank(a) - sealRank(b));
  if (authored.length > MAX_TENURE_HEADS && !removal) return { kind: "refuse", reason: "unsealable" };
  const heads = authored.slice(0, MAX_TENURE_HEADS).map((e) => bytesToHex(e.selfHash));
  const standing = new Set(authored.map((e) => bytesToHex(e.selfHash)));

  // Accumulate onto this sealer's own Tenure of the member, as the fold holds it.
  const eid = bytesToHex(tenureLocator(communityId, hex32(member), hex32(sealer)));
  const prior = folded.headEditions.get(eid);
  const priorHead = folded.heads.get(eid);
  if (priorHead && !prior) return removal ? { kind: "none" } : { kind: "refuse", reason: "unseen" };
  const earlier: TenureEntry[] = (prior ? parseTenure(prior.content)?.sealed ?? [] : [])
    .map((e) => ({ ...e, heads: e.heads.filter((h) => standing.has(h)) }))
    .filter((e) => e.heads.length > 0);
  const entry: TenureEntry = { rank: highest.rank, permissions, heads };
  const covered = earlier.some((e) => e.rank === entry.rank && (entry.permissions & ~e.permissions) === 0n && heads.every((h) => e.heads.includes(h)));
  if (covered && prior) return { kind: "none" };
  let sealed = [...earlier, entry];
  // At most 16 entries and 512 heads in all, the oldest dropped first.
  while (sealed.length > MAX_TENURE_ENTRIES || sealed.reduce((n, e) => n + e.heads.length, 0) > MAX_TENURE_HEADS) sealed = sealed.slice(1);
  return {
    kind: "write",
    rumor: buildEditionRumor({
      vsk: VSK_TENURE,
      entityId: hex32(eid),
      version: priorHead ? priorHead.version + 1n : 1n,
      ...(priorHead ? { prevHash: priorHead.hash } : {}),
      content: tenureToJSON(member, sealed),
      actorPubkey: sealer,
      ...(authority ? { authority } : {}),
      binding: editionBinding(communityId),
    }),
  };
}

/** Why a reduction waits: its Tenure can't be sealed whole, or the fold is short of the plane (CORD-04 §6, §9). */
export function tenureRefusal(): string {
  return t({
    id: "useModeration.tenureRefused",
    defaultMessage: "This would undo decisions this member made that you can't preserve. Try again once the community has fully synced, or ask someone ranked higher.",
  });
}
