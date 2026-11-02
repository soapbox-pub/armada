/**
 * A restricted Channel's Writers ledger (CORD-03 §1, vsk 18): which writer
 * address takes posts when, who certifies its writers, and which writers it no
 * longer vouches for. Ported from Vector's `community/v2/writers.rs` (MIT).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getEventHash } from "nostr-tools/pure";

import { bytesToHex, hex32 } from "@/concord/lib/derive";

/** At most this many entries, and retired windows (CORD-03 §1). */
export const MAX_LEDGER = 64;
export const MAX_RETIRED = 64;
const MAX_EPOCH = 2 ** 53;

export type Spell =
  | { kind: "writer"; epoch: number; pk: string; root: number; by: string; certifier?: string }
  | { kind: "open" }
  | { kind: "stop"; writer: string }
  | { kind: "other" };

export interface LedgerEntry {
  at: number;
  spell: Spell;
  /** Unknown fields, carried through an editor's editions (CORD-02 §6). `from` on a stop. */
  extra: Record<string, unknown>;
}

export interface RetiredWriter {
  epoch: number;
  pk: string;
  from: number;
  to: number;
  certifier?: string;
}

export interface Ledger {
  channel: string;
  entries: LedgerEntry[];
  retired: RetiredWriter[];
  extra: Record<string, unknown>;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

function isPoint(hex: unknown): hex is string {
  if (typeof hex !== "string" || !HEX64.test(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

const u64 = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const epochOf = (v: unknown): number | undefined => (u64(v) && v > 0 && v < MAX_EPOCH ? v : undefined);

const moves = (s: Spell) => s.kind === "writer" || s.kind === "open";

/** When an entry takes effect: its own date, or for a stop the departure it records if earlier. */
export function effectiveAt(e: LedgerEntry): number {
  if (e.spell.kind !== "stop") return e.at;
  const from = e.extra.from;
  return u64(from) ? Math.min(from, e.at) : e.at;
}

/** Parse a ledger, or undefined when it is malformed (CORD-03 §1). */
export function parseLedger(content: string): Ledger | undefined {
  let top: unknown;
  try {
    top = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!top || typeof top !== "object" || Array.isArray(top)) return undefined;
  const { channel, ledger, retired: rawRetired, ...extra } = top as Record<string, unknown>;
  if (typeof channel !== "string" || !HEX64.test(channel) || !Array.isArray(ledger)) return undefined;
  const retired: RetiredWriter[] = [];
  if (rawRetired !== undefined) {
    if (!Array.isArray(rawRetired)) return undefined;
    for (const r of rawRetired) {
      if (!Array.isArray(r) || (r.length !== 4 && r.length !== 5)) return undefined;
      const epoch = epochOf(r[0]);
      if (epoch === undefined || !isPoint(r[1]) || !u64(r[2]) || !u64(r[3])) return undefined;
      if (r.length === 5 && !isPoint(r[4])) return undefined;
      retired.push({ epoch, pk: r[1].toLowerCase(), from: r[2], to: r[3], ...(r.length === 5 ? { certifier: (r[4] as string).toLowerCase() } : {}) });
    }
  }
  if (ledger.length > MAX_LEDGER || retired.length > MAX_RETIRED) return undefined;
  const entries: LedgerEntry[] = [];
  for (const raw of ledger) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { at, stop, open, epoch, writer, root, by, certifier, ...rest } = raw as Record<string, unknown>;
    if (!u64(at)) return undefined;
    const none = (...xs: unknown[]) => xs.every((x) => x === undefined);
    let spell: Spell;
    if (none(open, epoch, writer, root, by) && stop !== undefined) {
      if (!isPoint(stop)) return undefined;
      spell = { kind: "stop", writer: stop.toLowerCase() };
      if (certifier !== undefined) rest.certifier = certifier;
    } else if (none(open, epoch, writer, root, by, stop)) {
      spell = { kind: "other" };
      if (certifier !== undefined) rest.certifier = certifier;
    } else if (open === true && none(epoch, writer, root, by, stop)) {
      spell = { kind: "open" };
      if (certifier !== undefined) rest.certifier = certifier;
    } else if (open === undefined && stop === undefined && epoch !== undefined && writer !== undefined && root !== undefined && by !== undefined) {
      const e = epochOf(epoch);
      if (e === undefined || !isPoint(writer) || !u64(root) || typeof by !== "string" || !HEX64.test(by)) return undefined;
      if (certifier !== undefined && !isPoint(certifier)) return undefined;
      spell = { kind: "writer", epoch: e, pk: writer.toLowerCase(), root, by: by.toLowerCase(), ...(certifier !== undefined ? { certifier: (certifier as string).toLowerCase() } : {}) };
    } else return undefined;
    entries.push({ at, spell, extra: rest });
  }
  const out: Ledger = { channel: channel.toLowerCase(), entries, retired, extra };
  return wellFormed(out) ? out : undefined;
}

function wellFormed(l: Ledger): boolean {
  for (let i = 1; i < l.entries.length; i++) if (l.entries[i - 1].at > l.entries[i].at) return false;
  for (let i = 0; i < l.entries.length; i++) {
    if (l.entries[i].spell.kind !== "stop") continue;
    const last = [...l.entries.slice(0, i)].reverse().find((e) => moves(e.spell));
    if (last?.spell.kind === "open") return false;
  }
  if (l.retired.some((r) => r.from > r.to)) return false;
  const epochs = writerWindows(l).map((w) => w.epoch);
  for (let i = 1; i < epochs.length; i++) if (epochs[i - 1] >= epochs[i]) return false;
  return true;
}

/** Every writer address, retired then live, with when its window opened and closed (absent while it holds). */
export function writerWindows(l: Ledger): Array<{ epoch: number; pk: string; from: number; to?: number; certifier?: string }> {
  const out: Array<{ epoch: number; pk: string; from: number; to?: number; certifier?: string }> = l.retired.map((r) => ({ ...r }));
  l.entries.forEach((e, i) => {
    if (e.spell.kind !== "writer") return;
    const next = l.entries.slice(i + 1).find((n) => moves(n.spell));
    out.push({ epoch: e.spell.epoch, pk: e.spell.pk, from: e.at, ...(next ? { to: next.at } : {}), ...(e.spell.certifier ? { certifier: e.spell.certifier } : {}) });
  });
  return out;
}

/** The JSON-comparable identity of a ledger's entries and retired windows. */
function shape(l: Ledger): string {
  return JSON.stringify([l.channel, l.entries.map((e) => [e.at, e.spell, e.extra]), l.retired]);
}

/**
 * Whether `next` is `prev` with exactly one entry appended verbatim, the oldest
 * moving to `retired` at the cap (CORD-03 §1).
 */
export function ledgerExtends(next: Ledger, prev: Ledger): boolean {
  const last = next.entries[next.entries.length - 1];
  if (!last) return false;
  const grown: Ledger = { ...prev, entries: [...prev.entries, last], retired: [...prev.retired] };
  if (grown.entries.length > MAX_LEDGER) {
    const gone = grown.entries.shift()!;
    if (gone.spell.kind === "writer") {
      const to = grown.entries.find((e) => moves(e.spell))?.at;
      if (to === undefined) return false;
      grown.retired.push({ epoch: gone.spell.epoch, pk: gone.spell.pk, from: gone.at, to, ...(gone.spell.certifier ? { certifier: gone.spell.certifier } : {}) });
      if (grown.retired.length > MAX_RETIRED) grown.retired.shift();
    }
  }
  return wellFormed(grown) && shape(grown) === shape(next);
}

/** Whether posts land at a writer address now. */
export function ledgerRestricted(l: Ledger | undefined): boolean {
  if (!l) return false;
  return [...l.entries].reverse().find((e) => moves(e.spell))?.spell.kind === "writer";
}

/** Whether `writer` was stopped at writer `epoch` by `atMs` (CORD-03 §1). */
export function stopped(l: Ledger, epoch: number, writer: string, atMs: number): boolean {
  const names = (e: LedgerEntry) => effectiveAt(e) <= atMs && e.spell.kind === "stop" && e.spell.writer === writer;
  const start = l.entries.findIndex((e) => e.spell.kind === "writer" && e.spell.epoch === epoch);
  if (start >= 0) {
    for (const e of l.entries.slice(start + 1)) {
      if (moves(e.spell)) break;
      if (names(e)) return true;
    }
    return false;
  }
  const r = l.retired.find((x) => x.epoch === epoch);
  if (!r) return false;
  for (const e of l.entries) {
    if (moves(e.spell)) break;
    if (e.at >= r.from && e.at <= r.to && names(e)) return true;
  }
  return false;
}

/** Whether a post at the read address dated `atMs` stands: inside no writer window, live or retired. */
export function readAddressTakes(l: Ledger, atMs: number): boolean {
  if (l.retired.some((r) => atMs >= r.from && atMs < r.to)) return false;
  return [...l.entries].reverse().find((e) => e.at <= atMs && moves(e.spell))?.spell.kind !== "writer";
}

/** Whether a post at writer `epoch`'s address dated `atMs` stands by the window: before its entry ends. */
export function writerAddressTakes(l: Ledger, epoch: number, atMs: number): boolean {
  return writerWindows(l).some((w) => w.epoch === epoch && (w.to === undefined || atMs < w.to));
}

/** The certifier of writer `epoch`, live or retired. */
export function certifierOf(l: Ledger, epoch: number): string | undefined {
  return writerWindows(l).find((w) => w.epoch === epoch)?.certifier;
}

const CERT_LABEL = new TextEncoder().encode("concord/writer-cert");

/** What a writer certificate signs (CORD-03 §1, A.7). */
export function certDigest(communityId: Uint8Array, channelId: Uint8Array, epoch: number, writer: Uint8Array): Uint8Array {
  const out = new Uint8Array(CERT_LABEL.length + 32 + 32 + 8 + 32);
  out.set(CERT_LABEL, 0);
  out.set(communityId, CERT_LABEL.length);
  out.set(channelId, CERT_LABEL.length + 32);
  new DataView(out.buffer).setBigUint64(CERT_LABEL.length + 64, BigInt(epoch), false);
  out.set(writer, CERT_LABEL.length + 72);
  return sha256(out);
}

/** The id of the never-published kind-3320 event a certificate signs. */
export function certEventId(certifier: string, digest: Uint8Array): string {
  return getEventHash({ pubkey: certifier, created_at: 0, kind: 3320, tags: [["digest", bytesToHex(digest)]], content: "" });
}

export function verifyWriterCert(certifier: string, digest: Uint8Array, certHex: string): boolean {
  if (!/^[0-9a-fA-F]{128}$/.test(certHex)) return false;
  try {
    return schnorr.verify(hex32Sig(certHex), hex32(certEventId(certifier, digest)), hex32(certifier));
  } catch {
    return false;
  }
}

export function signWriterCert(certifierSecret: Uint8Array, digest: Uint8Array): string {
  const pk = bytesToHex(schnorr.getPublicKey(certifierSecret));
  return bytesToHex(schnorr.sign(hex32(certEventId(pk, digest)), certifierSecret));
}

function hex32Sig(hex: string): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether a restricted Channel's post stands by the ledger (CORD-03 §1): at a
 * writer address (its `wepoch`), within the window, certified for its author if
 * the epoch names a certifier, and not stopped; at the read address, outside any
 * writer window. The owner's and a manager's posts stand regardless (the caller's).
 */
export function postStands(
  l: Ledger,
  communityId: Uint8Array,
  post: { author: string; ms: number; tags: string[][] },
): boolean {
  const wepoch = post.tags.find((t) => t[0] === "wepoch")?.[1];
  if (wepoch === undefined) return readAddressTakes(l, post.ms);
  const epoch = Number(wepoch);
  if (!writerAddressTakes(l, epoch, post.ms)) return false;
  if (stopped(l, epoch, post.author, post.ms)) return false;
  const certifier = certifierOf(l, epoch);
  if (!certifier) return true;
  const cert = post.tags.find((t) => t[0] === "wcert")?.[1];
  if (!cert) return false;
  return verifyWriterCert(certifier, certDigest(communityId, hex32(l.channel), epoch, hex32(post.author)), cert);
}
