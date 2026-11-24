/**
 * Writing a restricted Channel's Writers ledger (CORD-03 §1), ported from Vector's
 * `service/writing.rs`: minting a writer epoch (`mint_over`), stopping a writer,
 * reopening the Channel, and the edition each goes out as (`publish_ledger`).
 */

import { schnorr } from "@noble/curves/secp256k1.js";

import type { FoldedControl } from "@/concord/lib/control";
import { buildAccessDeliveries } from "@/concord/lib/delivery";
import { bytesToHex, certifierScope, channelWriterGroupKey, hex32, writersLocator, writerScope } from "@/concord/lib/derive";
import type { AuthorityCitation } from "@/concord/lib/edition";
import { buildEditionRumor } from "@/concord/lib/edition";
import { VSK_WRITERS } from "@/concord/lib/roster";
import type { Posters } from "@/concord/lib/writerDuty";
import type { ScopedCert } from "@/concord/lib/writerKeys";
import { locksChannel, type Rights } from "@/concord/lib/writerRights";
import {
  certDigest,
  currentWriterOf,
  emptyLedger,
  ledgerAppended,
  ledgerAppendedSeal,
  ledgerNotAhead,
  ledgerTailFits,
  ledgerToJson,
  nextWriterEpoch,
  scopedCertDigest,
  signWriterCert,
  stopped,
  type Ledger,
  type SealRef,
  type Spell,
} from "@/concord/lib/writers";
import type { NostrRumor } from "@/lib/nostrRumor";

/** When a new entry starts: now, but never before the newest post this device holds there, unless that is dated past any edition's reach (Vector `entry_time`). */
export function entryTime(nowMs: number, newestPostMs: number | undefined): number {
  const newest = newestPostMs !== undefined && newestPostMs < nowMs + 10 * 60_000 ? newestPostMs : undefined;
  return Math.max(nowMs, newest === undefined ? 0 : newest + 1);
}

/**
 * The ledger edition appending `spell` to `base` (Vector `publish_ledger`), dated at
 * its entry or now if later, or undefined when a reader would refuse it.
 */
export function ledgerEdition(o: {
  communityId: Uint8Array;
  control: FoldedControl;
  channelIdHex: string;
  base: Ledger;
  spell?: Spell;
  /** Seal the Channel's history instead of appending a spell (CORD-03 §1). */
  seal?: SealRef;
  from?: number;
  /** A writer entry whose window is Locked (CORD-03 §1). */
  locked?: boolean;
  entryAtMs: number;
  nowMs: number;
  me: string;
  authority?: AuthorityCitation;
}): { rumor: NostrRumor; ledger: Ledger } | undefined {
  const next = o.seal ? ledgerAppendedSeal(o.base, o.entryAtMs, o.seal) : o.spell ? ledgerAppended(o.base, o.entryAtMs, o.spell, o.from, o.locked) : undefined;
  if (!next) return undefined;
  const eid = writersLocator(o.communityId, hex32(o.channelIdHex));
  const head = o.control.heads.get(bytesToHex(eid));
  // An edition that doesn't chain from the head this device holds would fork the ledger.
  const held = o.control.writers?.get(o.channelIdHex);
  if (head ? !held || ledgerToJson(held) !== ledgerToJson(o.base) : o.base.entries.length > 0 || o.base.retired.length > 0) return undefined;
  const last = next.entries[next.entries.length - 1];
  const atSecs = Math.floor(Math.max(o.nowMs, last.at) / 1000);
  if (!ledgerTailFits(next, atSecs, o.me) || !ledgerNotAhead(next, o.nowMs)) return undefined;
  const rumor = buildEditionRumor({
    vsk: VSK_WRITERS,
    entityId: eid,
    content: ledgerToJson(next),
    actorPubkey: o.me,
    version: head ? head.version + 1n : 1n,
    ...(head ? { prevHash: head.hash } : {}),
    createdAtSecs: atSecs,
    ...(o.authority ? { authority: o.authority } : {}),
  });
  return { rumor, ledger: next };
}

/** Whether a stop for `writer` fits the ledger and isn't one already standing (Vector `stop_fits`). */
export function stopFits(ledger: Ledger | undefined, writer: string, nowMs: number): boolean {
  const live = currentWriterOf(ledger);
  if (!ledger || !live) return false;
  return !stopped(ledger, live.epoch, writer, Number.MAX_SAFE_INTEGER) && ledgerAppended(ledger, nowMs, { kind: "stop", writer }) !== undefined;
}

/**
 * A writer certificate for each of `writers` at `epoch`, for the rights `owed` gives them
 * (Vector `certify`): whole, or in a Locked Channel scoped to the bits they may write.
 */
export function certify(
  communityId: Uint8Array,
  channelIdHex: string,
  epoch: number,
  certifying: Uint8Array,
  writers: readonly string[],
  owed: (p: string) => Rights = () => "full",
): { certs: Map<string, string>; scoped: Map<string, ScopedCert> } {
  const certs = new Map<string, string>();
  const scoped = new Map<string, ScopedCert>();
  const channel = hex32(channelIdHex);
  for (const w of writers) {
    const rights = owed(w);
    if (rights === "full") certs.set(w, signWriterCert(certifying, certDigest(communityId, channel, epoch, hex32(w))));
    else scoped.set(w, { cert: signWriterCert(certifying, scopedCertDigest(communityId, channel, epoch, hex32(w), rights)), rights });
  }
  return { certs, scoped };
}

export interface Mint {
  epoch: number;
  /** The ledger edition announcing it, sent first. */
  edition: NostrRumor;
  /** The writer secret's deliveries, certified and tagged as its mint, then the certifier's to the other managers. */
  deliveries: NostrRumor[];
  /** What this device keeps of it, when it is among the writers. */
  own?: { secret: Uint8Array; cert?: string; scoped?: ScopedCert };
}

/**
 * Mint writer epoch `next_epoch` for a Channel (Vector `mint_over`): deliver its
 * secret, certified, to every member who manages it or may post there but `cut`,
 * the certifier to every other manager, and append it to the ledger.
 */
export async function buildMint(o: {
  communityId: Uint8Array;
  control: FoldedControl;
  rootEpoch: number;
  channelIdHex: string;
  me: string;
  posters: Posters;
  candidates: readonly string[];
  cut: readonly string[];
  secrets: (epoch: number) => { secret: Uint8Array; certifier: Uint8Array };
  entryAtMs: number;
  nowMs: number;
  authority?: AuthorityCitation;
  encrypt: (recipient: string, plaintext: string) => Promise<string>;
}): Promise<Mint | undefined> {
  const base = o.control.writers?.get(o.channelIdHex) ?? emptyLedger(o.channelIdHex);
  const epoch = nextWriterEpoch(base);
  if (epoch === undefined) return undefined;
  const { secret, certifier: certifying } = o.secrets(epoch);
  const pk = channelWriterGroupKey(secret, hex32(o.channelIdHex), epoch).pk;
  const certifier = bytesToHex(schnorr.getPublicKey(certifying));
  const spell: Spell = { kind: "writer", epoch, pk, root: o.rootEpoch, by: o.me, certifier };
  const built = ledgerEdition({ ...o, base, spell, locked: locksChannel(o.control, o.channelIdHex) });
  if (!built) return undefined;
  // Managers hold the key and its certifier too, so any of them can let a writer in.
  const recipients = o.candidates.filter((p) => o.posters.manages(p) || (!o.cut.includes(p) && o.posters.writes(p)));
  const managers = recipients.filter((p) => p !== o.me && o.posters.manages(p));
  const { certs, scoped } = certify(o.communityId, o.channelIdHex, epoch, certifying, recipients, o.posters.owed);
  const atSecs = Math.floor(o.nowMs / 1000);
  const deliveries = [
    ...(await buildAccessDeliveries(o.me, o.encrypt, {
      scopeIdHex: bytesToHex(writerScope(hex32(o.channelIdHex))),
      epoch: BigInt(epoch),
      key: secret,
      recipients,
      atSecs,
      writer: pk,
      certs,
      scoped,
      mint: true,
    })),
    ...(managers.length > 0
      ? await buildAccessDeliveries(o.me, o.encrypt, {
          scopeIdHex: bytesToHex(certifierScope(hex32(o.channelIdHex))),
          epoch: BigInt(epoch),
          key: certifying,
          recipients: managers,
          atSecs,
          writer: certifier,
        })
      : []),
  ];
  return {
    epoch,
    edition: built.rumor,
    deliveries,
    ...(recipients.includes(o.me) ? { own: { secret, cert: certs.get(o.me), scoped: scoped.get(o.me) } } : {}),
  };
}
