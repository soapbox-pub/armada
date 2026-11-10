/**
 * Concord reports — a NIP-56 report giftwrapped to the Control Plane address.
 *
 * Every member holds `control_pk`, but only staff can derive its secret from
 * `control_root` (CORD-02 §2), so members can address staff privately — not even
 * the reported person can read it.
 *
 *   wrap(1059, ephemeral author, ["p", control_pk], ["k", "1984"])
 *     └ seal(13, signed by the reporter's REAL key)
 *         └ rumor(1984, NIP-56 tags + the reporter's words)
 *
 * A STANDARD NIP-59 giftwrap (addressed to a party, like CORD-05 §6 Direct
 * Invites), not stream traffic; never stored as a rumor. It mirrors Control Plane
 * wraps (those are authored BY `control_pk`), so the two can't be confused.
 * Unavailable on legacy pre-split epochs (no `control_pk`; see `reportDestination`).
 */

import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { controlSignerGroupKey } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { KIND_NIP59_SEAL } from "@/concord/lib/directInvite";
import type { Community } from "@/concord/lib/types";
import { finalizePowEvent } from "@/lib/pow";
import { buildReportTags, KIND_REPORT, type ReportReason, type ReportTarget } from "@/lib/report";
import { t } from "@/i18n/intl";
import { nowSecs } from "@/lib/relayClock";

/** NIP-59: outer timestamps are tweaked into the past, up to two days. */
const MAX_BACKDATE_SECS = 2 * 24 * 60 * 60;

function tweakedPast(): number {
  return nowSecs() - Math.floor(Math.random() * MAX_BACKDATE_SECS);
}

/** The signer surface a report send needs (every Concord-capable login). */
export interface ReportSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
  };
}

/** The unsigned kind-1984 rumor: the report, claimed by the reporter. */
export interface ReportRumor {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
}

/** Build the kind-1984 rumor: NIP-56 tags plus whatever the reporter wrote. */
export function buildReportRumor(
  target: ReportTarget,
  reason: ReportReason,
  comment: string,
  reporterPubkey: string,
): ReportRumor {
  return {
    kind: KIND_REPORT,
    content: comment,
    tags: buildReportTags(target, reason),
    created_at: nowSecs(),
    pubkey: reporterPubkey,
  };
}

/**
 * Seal with the reporter's REAL identity — tells moderators who reported, and
 * stops flooding under invented names.
 */
export async function sealReport(
  rumor: ReportRumor,
  controlPk: string,
  signer: ReportSigner,
): Promise<NostrEvent> {
  if (!signer.nip44) throw new Error(t({ id: "concordReport.noNip44", defaultMessage: "This signer can't send reports (NIP-44 unsupported)." }));
  return signer.signEvent({
    kind: KIND_NIP59_SEAL,
    content: await signer.nip44.encrypt(controlPk, JSON.stringify(rumor)),
    tags: [],
    created_at: tweakedPast(),
  });
}

/**
 * Wrap a signed seal for the Control Plane under a single-use ephemeral key. The
 * outer `k` tag is an index hint, never authority.
 */
export function wrapReport(seal: NostrEvent, controlPk: string): Promise<NostrEvent> {
  const ephemeralSk = generateSecretKey();
  return finalizePowEvent(
    {
      kind: KIND_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(ephemeralSk, controlPk)),
      tags: [
        ["p", controlPk],
        ["k", String(KIND_REPORT)],
      ],
      created_at: tweakedPast(),
    },
    ephemeralSk,
  );
}

// Receiving (staff only)
/**
 * The current epoch's Control Plane secret, or undefined for non-staff. Holding
 * it IS the permission. A `control_root` that doesn't derive to `control_pk`
 * yields undefined (fail closed, like `controlStreamOf`).
 */
export function reportInboxSecret(community: Community): Uint8Array | undefined {
  if (!community.controlPk || !community.controlRoot) return undefined;
  const signer = controlSignerGroupKey(community.controlRoot, community.id, community.rootEpoch);
  return signer.pk === community.controlPk ? signer.sk : undefined;
}

/** An unwrapped report: the inner rumor plus its seal-verified reporter. */
export interface UnwrappedReport {
  /** Gift-wrap event id — the stable key and dedup handle. */
  wrapId: string;
  /** The seal's author — the verified reporter. */
  reporter: string;
  rumor: ReportRumor;
}

/**
 * Unwrap a report with the staff secret; undefined (never throws) for anything
 * that isn't a well-formed report this key opens. Uses RAW keys (no signer holds
 * a group key). Rumor author must equal seal author.
 */
export function unwrapReport(wrap: NostrEvent, controlSk: Uint8Array): UnwrappedReport | undefined {
  if (wrap.kind !== KIND_WRAP) return undefined;
  try {
    const seal = JSON.parse(
      nip44Decrypt(wrap.content, getConversationKey(controlSk, wrap.pubkey)),
    ) as NostrEvent;
    if (seal.kind !== KIND_NIP59_SEAL) return undefined;

    const rumor = JSON.parse(
      nip44Decrypt(seal.content, getConversationKey(controlSk, seal.pubkey)),
    ) as ReportRumor;
    if (rumor.kind !== KIND_REPORT) return undefined;
    if (rumor.pubkey !== seal.pubkey) return undefined;

    return { wrapId: wrap.id, reporter: seal.pubkey, rumor };
  } catch {
    return undefined;
  }
}

/** What a report points at: the accused, the message (if any), and the reason. */
export interface ReportSubject {
  pubkey?: string;
  eventId?: string;
  reason?: string;
}

/** Read a report rumor's NIP-56 tags back into its subject. */
export function reportSubject(rumor: ReportRumor): ReportSubject {
  const e = rumor.tags.find(([name]) => name === "e");
  const p = rumor.tags.find(([name]) => name === "p");
  return {
    pubkey: p?.[1],
    eventId: e?.[1],
    // The reason rides whichever tag names the thing being judged (NIP-56).
    reason: e?.[2] ?? p?.[2],
  };
}
