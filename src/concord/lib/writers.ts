/**
 * A restricted Channel's Writers ledger (CORD-03 §1, vsk 18): which writer
 * address takes posts when, who certifies its writers, and which writers it no
 * longer vouches for. Ported from Vector's `community/v2/writers.rs` (MIT).
 */

import { parseStrictValue } from "@/concord/lib/strictJson";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getEventHash } from "nostr-tools/pure";

import { bytesToHex, hex32 } from "@/concord/lib/derive";
import { KIND_DELETE, KIND_REACTION, KIND_VOICE_DIRECTIVE, KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import { Permissions } from "@/concord/lib/roles";

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

/**
 * A Channel's sealed history (CORD-03 §1): what its read address held before `until`
 * (unix ms) is exactly the wrap ids its pages list, from the first, `page`, opened under
 * read epoch `read`. `run` is when the run of Locked windows it was made in began. It
 * rides the ledger's top level, where the cap never reaches.
 */
export interface SealRef {
  /** Absent for a seal of nothing. */
  page?: string;
  read: number;
  until: number;
  run: number;
  count: number;
  /** Fields this build doesn't know, carried through its own editions (CORD-02 §6). */
  extra: Record<string, unknown>;
}

export interface Ledger {
  channel: string;
  entries: LedgerEntry[];
  retired: RetiredWriter[];
  /** The newest seal of its history. */
  seal?: SealRef;
  extra: Record<string, unknown>;
}

/** How far past an entry a client that hadn't read it may still act on the ledger before it (CORD-03 §1). */
export const LEDGER_SKEW_MS = 10 * 60_000;

/** A seal as carried, or undefined for one that lacks a field or reaches past ten minutes into its run. */
function parseSealRef(v: unknown): SealRef | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const { page, read, until, run, count, ...extra } = v as Record<string, unknown>;
  if (page !== null && !(typeof page === "string" && HEX64.test(page))) return undefined;
  if (!u64(read) || !u64(until) || !u64(run) || !u64(count) || until > run + LEDGER_SKEW_MS) return undefined;
  return { ...(page ? { page: page.toLowerCase() } : {}), read, until, run, count, extra };
}

function sealToJson(s: SealRef): Record<string, unknown> {
  return { ...s.extra, page: s.page ?? null, read: s.read, until: s.until, run: s.run, count: s.count };
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

function isCurvePoint(hex: unknown): hex is string {
  if (typeof hex !== "string" || !HEX64.test(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

/** A u64 as serde's `as_u64` reads it: an integer literal, never a float form, below 2^64. */
const u64 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 64;
const epochOf = (v: unknown): number | undefined => (u64(v) && v > 0 && v < MAX_EPOCH ? v : undefined);

const moves = (s: Spell) => s.kind === "writer" || s.kind === "open";

/** When an entry takes effect: its own date, or for a stop the departure it records if earlier. */
export function effectiveAt(e: LedgerEntry): number {
  if (e.spell.kind !== "stop") return e.at;
  const from = e.extra.from;
  return u64(from) ? Math.min(from, e.at) : e.at;
}

/** Parse a ledger, or undefined when it is malformed (CORD-03 §1). */
/**
 * Which keys a run of parses found to be x-only public keys, each checked once: a ledger names
 * the same writers in every version, and each check is a point decompression (Vector `KeyCheck`).
 */
export type KeyCheck = Map<string, boolean>;

/** `keys` shares the point checks across a run of parses, such as one fold's ledger chain. */
export function parseLedger(content: string, keys: KeyCheck = new Map()): Ledger | undefined {
  const isPoint = (hex: unknown): hex is string => {
    if (typeof hex !== "string") return false;
    const known = keys.get(hex);
    if (known !== undefined) return known;
    const ok = isCurvePoint(hex);
    keys.set(hex, ok);
    return ok;
  };
  const top = parseStrictValue(content);
  if (!top || typeof top !== "object" || Array.isArray(top)) return undefined;
  const { channel, ledger, retired: rawRetired, ...extra } = top as Record<string, unknown>;
  // A seal this reader can't read is carried as it came.
  const seal = parseSealRef(extra.seal);
  if (seal) delete extra.seal;
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
  const out: Ledger = { channel: channel.toLowerCase(), entries, retired, ...(seal ? { seal } : {}), extra };
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
  return JSON.stringify(sortKeys([l.channel, l.entries.map((e) => [e.at, e.spell, e.extra]), l.retired]));
}

/** Unknown fields compare by value, whatever order an editor wrote their keys in. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * `l` with `entry` appended verbatim; at the cap the oldest entry goes, a writer one
 * into `retired` (CORD-03 §1, Vector `Ledger::with`). Undefined when that leaves it malformed.
 */
function ledgerWith(l: Ledger, entry: LedgerEntry): Ledger | undefined {
  const grown: Ledger = { ...l, entries: [...l.entries, entry], retired: [...l.retired] };
  if (grown.entries.length > MAX_LEDGER) {
    const gone = grown.entries.shift()!;
    if (gone.spell.kind === "writer") {
      // Its window runs to the next entry that moves posts; the live one never retires.
      const to = grown.entries.find((e) => moves(e.spell))?.at;
      if (to === undefined) return undefined;
      grown.retired.push({ epoch: gone.spell.epoch, pk: gone.spell.pk, from: gone.at, to, ...(gone.spell.certifier ? { certifier: gone.spell.certifier } : {}) });
      if (grown.retired.length > MAX_RETIRED) grown.retired.shift();
    }
  }
  return wellFormed(grown) && grown.entries.length <= MAX_LEDGER && grown.retired.length <= MAX_RETIRED ? grown : undefined;
}

/**
 * Whether `next` is `prev` with exactly one entry appended verbatim, the oldest
 * moving to `retired` at the cap (CORD-03 §1).
 */
export function ledgerExtends(next: Ledger, prev: Ledger): boolean {
  const last = next.entries[next.entries.length - 1];
  if (!last) return false;
  const grown = ledgerWith(prev, last);
  return grown !== undefined && shape(grown) === shape(next);
}

/** An empty ledger for a Channel (Vector `Ledger::new`). */
export function emptyLedger(channelIdHex: string): Ledger {
  return { channel: channelIdHex.toLowerCase(), entries: [], retired: [], extra: {} };
}

/**
 * `l` with `spell` appended at `at`, never before the last entry, a stop recording a
 * departure from `from` when that came first (Vector `appended_from`).
 */
export function ledgerAppended(l: Ledger, at: number, spell: Spell, from?: number, locked = false): Ledger | undefined {
  const last = l.entries[l.entries.length - 1];
  const when = last ? Math.max(at, last.at) : at;
  const extra: Record<string, unknown> = spell.kind === "stop" && from !== undefined && from < when ? { from } : {};
  if (locked && spell.kind === "writer") extra.locked = true;
  return ledgerWith(l, { at: when, spell, extra });
}

/**
 * `l` sealed by `seal` (Vector `appended_seal`): the edition appends an entry of no known
 * kind, which the cap may drop, and the seal itself rides the top level.
 */
export function ledgerAppendedSeal(l: Ledger, at: number, seal: SealRef): Ledger | undefined {
  const last = l.entries[l.entries.length - 1];
  const next = ledgerWith(l, { at: last ? Math.max(at, last.at) : at, spell: { kind: "other" }, extra: { sealed: seal.count } });
  return next ? { ...next, seal } : undefined;
}

/** Whether `e` is a writer entry whose window is Locked: only `"locked": true` is. */
export function entryLocked(e: LedgerEntry): boolean {
  return e.spell.kind === "writer" && e.extra.locked === true;
}

/** Whether every write lands at a writer address now (CORD-03 §1). */
export function ledgerLocked(l: Ledger | undefined): boolean {
  const last = l ? [...l.entries].reverse().find((e) => moves(e.spell)) : undefined;
  return last !== undefined && entryLocked(last);
}

/** Whether `atMs` falls in a Locked window the ledger still holds whole; a retired window keeps no flag. */
export function lockedAt(l: Ledger, atMs: number): boolean {
  const e = [...l.entries].reverse().find((x) => x.at <= atMs && moves(x.spell));
  return e !== undefined && entryLocked(e);
}

/**
 * The dates the read address holds nothing a reader needs (Vector `quiet_spans`): each run
 * of Locked windows from ten minutes past its start, and the seal's run likewise, which
 * holds even once its early entries retire. Sorted and disjoint; `to` absent while running.
 */
export function quietSpans(l: Ledger): Array<{ from: number; to?: number }> {
  const moving = l.entries.filter((e) => moves(e.spell));
  const endAfter = (at: number) => moving.find((e) => e.at > at && !entryLocked(e))?.at;
  const spans: Array<{ from: number; to?: number }> = [];
  moving.forEach((e, i) => {
    if (entryLocked(e) && (i === 0 || !entryLocked(moving[i - 1]))) spans.push({ from: e.at + LEDGER_SKEW_MS, to: endAfter(e.at) });
  });
  if (l.seal) spans.push({ from: l.seal.run + LEDGER_SKEW_MS, to: endAfter(l.seal.run) });
  const kept = spans.filter((s) => s.to === undefined || s.to > s.from).sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to?: number }> = [];
  for (const s of kept) {
    const last = out[out.length - 1];
    if (last && (last.to === undefined || last.to >= s.from)) {
      last.to = last.to === undefined || s.to === undefined ? undefined : Math.max(last.to, s.to);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Whether nothing a reader needs sits at the read address at `atMs`. */
export function readAddressQuiet(l: Ledger | undefined, atMs: number): boolean {
  return l !== undefined && quietSpans(l).some((s) => s.from <= atMs && (s.to === undefined || atMs < s.to));
}

/**
 * The dates at or below `topMs` the read address is read by, as `[floor, top]` (Vector
 * `read_range`): the top lowered out of any quiet span, the floor the nearest quiet span
 * below it or the seal's end. Undefined when nothing above the seal is left.
 */
export function readRange(l: Ledger | undefined, topMs: number): [number, number] | undefined {
  if (!l) return [0, topMs];
  const spans = quietSpans(l);
  let top = topMs;
  const inside = spans.find((s) => s.from <= top && (s.to === undefined || top < s.to));
  if (inside) {
    if (inside.from === 0) return undefined;
    top = inside.from - 1;
  }
  const below = Math.max(0, ...spans.flatMap((s) => (s.to !== undefined && s.to <= top ? [s.to] : [])));
  const floor = Math.max(below, l.seal?.until ?? 0);
  return floor <= top ? [floor, top] : undefined;
}

/** When the live run of Locked windows began, while the live window is Locked. */
export function runStart(l: Ledger | undefined): number | undefined {
  if (!l) return undefined;
  const moving = l.entries.filter((e) => moves(e.spell));
  let start: number | undefined;
  for (let i = moving.length - 1; i >= 0 && entryLocked(moving[i]); i--) start = moving[i].at;
  return start;
}

/** The live seal, while it still holds the live run: no window that isn't Locked followed it. */
function sealInRun(l: Ledger): SealRef | undefined {
  const s = l.seal;
  return s && !l.entries.some((e) => moves(e.spell) && e.at > s.run && !entryLocked(e)) ? s : undefined;
}

/**
 * Where the live run of Locked windows is owed a seal to at `nowMs` (Vector `seal_target`):
 * up to its start once it begins, then across its first ten minutes once they pass.
 */
export function sealTarget(l: Ledger | undefined, nowMs: number): number | undefined {
  const start = runStart(l);
  if (!l || start === undefined) return undefined;
  const s = sealInRun(l);
  if (!s) return start;
  return s.until < s.run + LEDGER_SKEW_MS && nowMs >= s.run + LEDGER_SKEW_MS ? s.run + LEDGER_SKEW_MS : undefined;
}

/** When the run the next seal belongs to began: the live seal's own while it holds the run, else the live run's start. */
export function sealRun(l: Ledger | undefined): number | undefined {
  const start = runStart(l);
  if (!l || start === undefined) return undefined;
  return sealInRun(l)?.run ?? start;
}

/** The writer epoch taking posts now, and its address. */
export function currentWriterOf(l: Ledger | undefined): { epoch: number; pk: string } | undefined {
  const last = l ? [...l.entries].reverse().find((e) => moves(e.spell)) : undefined;
  return last?.spell.kind === "writer" ? { epoch: last.spell.epoch, pk: last.spell.pk } : undefined;
}

/** The live writer entry: the root epoch it was minted under, its minter, when it began. */
export function liveWriterEntry(l: Ledger | undefined): { root: number; by: string; at: number } | undefined {
  const last = l ? [...l.entries].reverse().find((e) => moves(e.spell)) : undefined;
  return last?.spell.kind === "writer" ? { root: last.spell.root, by: last.spell.by, at: last.at } : undefined;
}

/** Who minted writer `epoch`, while the ledger still holds its entry. */
export function minterOf(l: Ledger, epoch: number): string | undefined {
  for (const e of l.entries) if (e.spell.kind === "writer" && e.spell.epoch === epoch) return e.spell.by;
  return undefined;
}

/** The writer epoch before the live one, if the ledger still names it. */
export function previousWriterEpoch(l: Ledger): number | undefined {
  const epochs = writerWindows(l).map((w) => w.epoch);
  return epochs.length >= 2 ? epochs[epochs.length - 2] : undefined;
}

/** The epoch a newly minted writer secret takes, undefined once the range is spent. */
export function nextWriterEpoch(l: Ledger): number | undefined {
  const next = Math.max(0, ...writerWindows(l).map((w) => w.epoch)) + 1;
  return next < MAX_EPOCH ? next : undefined;
}

/** When writer `epoch`'s window opened. */
export function writerStart(l: Ledger, epoch: number): number | undefined {
  return writerWindows(l).find((w) => w.epoch === epoch)?.from;
}

/** Whether the newest entry sits within ten minutes of the edition's time and, as a writer entry, names its signer (Vector `tail_fits`). */
export function ledgerTailFits(l: Ledger, editionSecs: number, author: string): boolean {
  const last = l.entries[l.entries.length - 1];
  if (!last) return false;
  return Math.abs(last.at - editionSecs * 1000) <= 10 * 60_000 && !(last.spell.kind === "writer" && last.spell.by !== author);
}

/** Whether the newest entry is dated within an hour of `nowMs` (Vector `not_ahead`). */
export function ledgerNotAhead(l: Ledger, nowMs: number): boolean {
  const last = l.entries[l.entries.length - 1];
  return last !== undefined && last.at <= nowMs + 60 * 60_000;
}

/** A ledger's content as Vector writes it: every object's keys sorted, unknown fields carried (Vector `to_json`). */
export function ledgerToJson(l: Ledger): string {
  const entries = l.entries.map((e) => {
    const o: Record<string, unknown> = { ...e.extra, at: e.at };
    if (e.spell.kind === "writer") {
      Object.assign(o, { epoch: e.spell.epoch, writer: e.spell.pk, root: e.spell.root, by: e.spell.by });
      if (e.spell.certifier) o.certifier = e.spell.certifier;
    } else if (e.spell.kind === "open") o.open = true;
    else if (e.spell.kind === "stop") o.stop = e.spell.writer;
    return o;
  });
  const top: Record<string, unknown> = { ...l.extra, channel: l.channel, ledger: entries };
  if (l.seal) top.seal = sealToJson(l.seal);
  if (l.retired.length > 0) top.retired = l.retired.map((r) => (r.certifier ? [r.epoch, r.pk, r.from, r.to, r.certifier] : [r.epoch, r.pk, r.from, r.to]));
  return JSON.stringify(sortKeys(top));
}

/**
 * Whether a kind moves to the writer address with posting; the rest stay at the read
 * address, except in a Locked window, where everything moves (Vector `rides_writer_address`).
 */
export function ridesWriterAddress(kind: number, locked = false): boolean {
  return locked || (kind !== KIND_REACTION && kind !== KIND_DELETE && kind !== KIND_VOICE_PRESENCE && kind !== KIND_VOICE_DIRECTIVE);
}

/** The CORD-04 bit a write of `kind` needs at a writer address; undefined for a deletion, judged by its signer's authority. */
export function writerBit(kind: number): bigint | undefined {
  if (kind === KIND_REACTION) return Permissions.ADD_REACTIONS;
  if (kind === KIND_VOICE_PRESENCE || kind === KIND_VOICE_DIRECTIVE) return Permissions.CONNECT;
  if (kind === KIND_DELETE) return undefined;
  return Permissions.SEND_MESSAGES;
}

/** The bits a scoped certificate may carry (CORD-03 §1). */
export const SCOPED_BITS = Permissions.ADD_REACTIONS | Permissions.CONNECT;

/** Whether a scoped certificate for `rights` covers a write of `kind`: never a post. */
export function scopeCovers(rights: bigint, kind: number): boolean {
  const bit = writerBit(kind);
  return bit === undefined || (bit !== Permissions.SEND_MESSAGES && (rights & bit) !== 0n);
}

const U64_TEXT = /^(0|[1-9][0-9]*)$/;

/** The scoped certificate a write carries, `["rcert", <sig hex>, <rights decimal>]`, if its first one is well-formed. */
export function scopedCertOf(tags: string[][]): { sig: string; rights: bigint } | undefined {
  const t = tags.find((x) => x[0] === "rcert");
  if (!t || !/^[0-9a-fA-F]{128}$/.test(t[1] ?? "") || !U64_TEXT.test(t[2] ?? "")) return undefined;
  const rights = BigInt(t[2]);
  return rights < 1n << 64n ? { sig: t[1].toLowerCase(), rights } : undefined;
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

const SCOPED_CERT_LABEL = new TextEncoder().encode("concord/writer-cert-scoped");

/** What a scoped writer certificate signs: one member's place at one epoch, for only the writes `rights` names (CORD-03 §1). */
export function scopedCertDigest(communityId: Uint8Array, channelId: Uint8Array, epoch: number, writer: Uint8Array, rights: bigint): Uint8Array {
  const n = SCOPED_CERT_LABEL.length;
  const out = new Uint8Array(n + 32 + 32 + 8 + 32 + 8);
  out.set(SCOPED_CERT_LABEL, 0);
  out.set(communityId, n);
  out.set(channelId, n + 32);
  const view = new DataView(out.buffer);
  view.setBigUint64(n + 64, BigInt(epoch), false);
  out.set(writer, n + 72);
  view.setBigUint64(n + 104, rights, false);
  return sha256(out);
}

/** The id of the never-published kind-3320 event a certificate signs. */
export function certEventId(certifier: string, digest: Uint8Array): string {
  return getEventHash({ pubkey: certifier, created_at: 0, kind: 3320, tags: [["digest", bytesToHex(digest)]], content: "" });
}

/**
 * Verdicts by `certifier:digest:cert`. A verdict is a pure function of those three, and
 * render paths (`useWriterAccess`) check every restricted Channel's certificate per render.
 */
const certVerdicts = new Map<string, boolean>();
// Every duty pass re-checks each restricted Channel's certificates across every community.
const CERT_VERDICTS_MAX = 8192;

export function verifyWriterCert(certifier: string, digest: Uint8Array, certHex: string): boolean {
  if (!/^[0-9a-fA-F]{128}$/.test(certHex)) return false;
  const key = `${certifier}:${bytesToHex(digest)}:${certHex.toLowerCase()}`;
  const known = certVerdicts.get(key);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    ok = schnorr.verify(hex32Sig(certHex), hex32(certEventId(certifier, digest)), hex32(certifier));
  } catch {
    ok = false;
  }
  if (certVerdicts.size >= CERT_VERDICTS_MAX) certVerdicts.delete(certVerdicts.keys().next().value!);
  certVerdicts.set(key, ok);
  return ok;
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
 * Whether a write at writer `epoch`'s address stands by the ledger (CORD-03 §1): within
 * the window, not stopped, and, where the epoch names a certifier, carrying a certificate
 * that covers it, whole or scoped to the bit its kind needs. At the read address (no
 * `wepoch`), outside any writer window. The owner's and a manager's stand regardless (the caller's).
 */
export function postStands(
  l: Ledger,
  communityId: Uint8Array,
  post: { author: string; ms: number; tags: string[][]; kind: number },
): boolean {
  const wepoch = post.tags.find((t) => t[0] === "wepoch")?.[1];
  if (wepoch === undefined) return readAddressTakes(l, post.ms);
  const epoch = Number(wepoch);
  if (!writerAddressTakes(l, epoch, post.ms)) return false;
  if (stopped(l, epoch, post.author, post.ms)) return false;
  return certifiedFor(l, communityId, epoch, post);
}

/** Whether a write at writer `epoch` carries a certificate the epoch's certifier signed that covers it; true where it names none. */
export function certifiedFor(l: Ledger, communityId: Uint8Array, epoch: number, post: { author: string; tags: string[][]; kind: number }): boolean {
  const certifier = certifierOf(l, epoch);
  if (!certifier) return true;
  const [channel, writer] = [hex32(l.channel), hex32(post.author)];
  const whole = post.tags.find((t) => t[0] === "wcert")?.[1];
  if (whole && verifyWriterCert(certifier, certDigest(communityId, channel, epoch, writer), whole)) return true;
  const scoped = scopedCertOf(post.tags);
  return scoped !== undefined && scopeCovers(scoped.rights, post.kind) && verifyWriterCert(certifier, scopedCertDigest(communityId, channel, epoch, writer, scoped.rights), scoped.sig);
}
