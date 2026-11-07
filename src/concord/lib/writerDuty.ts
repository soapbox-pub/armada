/**
 * The writer duty (CORD-03 §1, Vector `service/writing.rs` `duty_for`): judged on a
 * whole read of the Roster, a manager brings a restricted Channel's Writers ledger in
 * line with its permissions, re-mints a writer epoch a Refounding retired or that
 * names no certifier, takes the certifier back from someone who no longer manages,
 * stops (or mints past) a writer the Channel no longer lets post, hands the certifier
 * to a manager promoted since, and mints for itself when it may post and nobody served
 * it; a holder of the live secret and certifier delivers them, certified, to each
 * writer nobody has served. Pure: the hook reads the planes and acts on the plan.
 */

import type { FoldedControl } from "@/concord/lib/control";
import { bytesToHex, certifierScope, hex32, writerScope } from "@/concord/lib/derive";
import type { ParsedDelivery } from "@/concord/lib/delivery";
import { kickedInto, type GuestbookHistory } from "@/concord/lib/guestbook";
import { myLocator } from "@/concord/lib/rekey";
import { canActOnMember, channelPermissions, everyoneSends, hasPermission, Permissions } from "@/concord/lib/roles";
import {
  certDigest,
  certifierOf,
  currentWriterOf,
  ledgerRestricted,
  liveWriterEntry,
  minterOf,
  previousWriterEpoch,
  stopped,
  verifyWriterCert,
  writerStart,
  writerWindows,
  type Ledger,
} from "@/concord/lib/writers";

/** How long a manager waits before cutting one writer, or minting for itself, again in a Channel. */
export const BACKSTOP_DAMP_MS = 6 * 3600_000;
/** How long before moving a Channel's ledger in line with its permissions again. */
export const BACKSTOP_MOVE_MS = 3600_000;
/** How long a backstop that read the Control Plane short waits before reading it again. */
export const BACKSTOP_RETRY_MS = 10 * 60_000;
/** How long a manager who may post goes unserved before it mints a key it can use. */
export const STARVED_MS = 10 * 60_000;
/** Each rank step down waits this much longer before a backstop mint, so one manager acts. */
export const RANK_STAGGER_MS = 2_000;

/** A backstop's lane in one Channel, each damped on its own once it tried. */
export type Lane = { kind: "cut"; member: string } | { kind: "starved" } | { kind: "move" } | { kind: "retry" } | { kind: "unserved" } | { kind: "certifier" };

export function laneKey(lane: Lane): string {
  return lane.kind === "cut" ? `cut:${lane.member}` : lane.kind;
}

export function lanePeriod(lane: Lane): number {
  switch (lane.kind) {
    case "cut":
    case "starved":
      return BACKSTOP_DAMP_MS;
    case "retry":
      return BACKSTOP_RETRY_MS;
    default:
      return BACKSTOP_MOVE_MS;
  }
}

/** What a backstop does to a restricted Channel's ledger. */
export type Act = { kind: "mint"; cut: string[] } | { kind: "stop"; writer: string } | { kind: "restart"; writer: string };

/** What one pass of the duty does for a Channel. */
export type WriterPlan = (
  | { kind: "backstop"; act: Act; lanes: Lane[] }
  | { kind: "deliver"; epoch: number; recipients: string[] }
  | { kind: "certifier"; epoch: number; recipients: string[] }
  | { kind: "none" }
) & {
  /** The certifier handed to managers who lack it, in the same pass as what follows (Vector `duty_for`). */
  handover?: { epoch: number; recipients: string[] };
};

/** Who may post, and who manages, in a Channel by a Roster (Vector `Posters`). */
export interface Posters {
  writes(p: string): boolean;
  manages(p: string): boolean;
  vouchesAsManager(p: string): boolean;
}

export function postersOf(control: FoldedControl, members: ReadonlySet<string>, channelIdHex: string): Posters {
  const owner = control.ownerHex;
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  const inMembers = (p: string) => p === owner || members.has(p);
  const vouchesAsManager = (p: string) => p === owner || (!control.banned.has(p) && hasPermission(control.roster, p, Permissions.MANAGE_CHANNELS));
  return {
    writes: (p) => inMembers(p) && !control.banned.has(p) && (channelPermissions(control.roster, owner, p, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) !== 0n,
    manages: (p) => (inMembers(p) && vouchesAsManager(p)) || p === owner,
    vouchesAsManager,
  };
}

/** Whether a Roster restricts a Channel: `@everyone` may not post there (Vector `restricts`). */
export function restrictsChannel(control: FoldedControl, channelIdHex: string): boolean {
  return !everyoneSends(control.roster, channelIdHex);
}

/** Whether `p` may no longer post: the Roster takes SEND, or a ban (Vector `lost_send`). */
export function lostSend(control: FoldedControl, p: string, channelIdHex: string): boolean {
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  return control.banned.has(p) || (channelPermissions(control.roster, control.ownerHex, p, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) === 0n;
}

/** Everyone a writer secret could be owed to: the access candidates, the owner and this member (Vector `writer_candidates`). */
export function writerCandidates(accessCandidates: readonly string[], ownerHex: string, me: string): string[] {
  return [...new Set([...accessCandidates, ownerHex, me])].sort();
}

/** Deliveries at a Channel's writer scope naming the ledger's address for their epoch (Vector `named_deliveries`). */
export function namedDeliveries(deliveries: readonly ParsedDelivery[], ledger: Ledger, channelIdHex: string): ParsedDelivery[] {
  const scope = bytesToHex(writerScope(hex32(channelIdHex)));
  const names = new Map(writerWindows(ledger).map((w) => [w.epoch, w.pk]));
  return deliveries.filter((d) => d.form === "access" && d.scopeIdHex === scope && d.writer !== undefined && d.writer === names.get(Number(d.newEpoch)));
}

function certifies(communityId: Uint8Array, ledger: Ledger, epoch: number, writer: string, cert: string): boolean {
  const certifier = certifierOf(ledger, epoch);
  return certifier !== undefined && verifyWriterCert(certifier, certDigest(communityId, hex32(ledger.channel), epoch, hex32(writer)), cert);
}

function blobFor(d: ParsedDelivery, member: string, scopeHex: string, epoch: number): boolean {
  return d.blobs.some((b) => b.locator.toLowerCase() === myLocator(d.deliverer, member, scopeHex, BigInt(epoch)));
}

/** Who epoch `e` vouches for: its minter, and each writer a vouching delivery certified (Vector `vouched_at`). */
function vouchedAt(communityId: Uint8Array, ledger: Ledger, deliveries: readonly ParsedDelivery[], vouching: (d: string, e: number) => boolean, e: number): Set<string> {
  const out = new Set<string>();
  const minter = minterOf(ledger, e);
  if (minter) out.add(minter);
  for (const d of deliveries) {
    if (Number(d.newEpoch) !== e || !vouching(d.deliverer, e)) continue;
    for (const [w, c] of d.certs) if (certifies(communityId, ledger, e, w, c)) out.add(w);
  }
  return out;
}

/**
 * Whom the live epoch's minting delivery left out after the epoch before vouched for
 * them, once every part of it is in (Vector `left_out`).
 */
function leftOut(communityId: Uint8Array, ledger: Ledger, deliveries: readonly ParsedDelivery[], scopeHex: string, vouching: (d: string, e: number) => boolean): Set<string> {
  const live = currentWriterOf(ledger);
  if (!live) return new Set();
  const minter = minterOf(ledger, live.epoch);
  const minting = deliveries.filter((d) => d.deliverer === minter && Number(d.newEpoch) === live.epoch && d.mint);
  const parts = Math.max(0, ...minting.map((d) => d.mint![1]));
  if (parts === 0) return new Set();
  for (let i = 1; i <= parts; i++) if (!minting.some((d) => d.mint![0] === i)) return new Set();
  const prev = previousWriterEpoch(ledger);
  if (prev === undefined) return new Set();
  return new Set([...vouchedAt(communityId, ledger, deliveries, vouching, prev)].filter((p) => !minting.some((d) => blobFor(d, p, scopeHex, live.epoch))));
}

/** Who holds the live certifier: its minter, and whom a certifier-scope delivery from the minter or a manager served (Vector `certifier_holders`). */
export function certifierHolders(ledger: Ledger, epoch: number, certifierDeliveries: readonly ParsedDelivery[], channelIdHex: string, pool: readonly string[], manages: (p: string) => boolean): Set<string> {
  const minter = minterOf(ledger, epoch);
  const named = certifierOf(ledger, epoch);
  const cscope = bytesToHex(certifierScope(hex32(channelIdHex)));
  const offered = certifierDeliveries.filter((d) => d.form === "access" && d.scopeIdHex === cscope && Number(d.newEpoch) === epoch && d.writer === named && (d.deliverer === minter || manages(d.deliverer)));
  const out = new Set<string>(minter ? [minter] : []);
  for (const p of pool) if (offered.some((d) => blobFor(d, p, cscope, epoch))) out.add(p);
  return out;
}

export interface WriterDutyInput {
  control: FoldedControl;
  communityId: Uint8Array;
  rootEpoch: number;
  channelIdHex: string;
  me: string;
  /** The memberlist, read strictly. */
  members: ReadonlySet<string>;
  /** {@link writerCandidates}. */
  candidates: readonly string[];
  /** Every access delivery on the Channel's access plane. */
  deliveries: readonly ParsedDelivery[];
  /** Whether this device holds the live writer secret, and the live certifier. */
  holdsLive: boolean;
  holdsCertifier: boolean;
  /** Since when this device has been able to post here without a key (Vector `postable_since`). */
  postableSince: number;
  /** Whether this session read the Guestbook whole. */
  walked: boolean;
  history?: GuestbookHistory;
  nowMs: number;
  /** Whether a lane may act now. */
  due: (lane: Lane) => boolean;
  /** Members this session already handed the live secret, and the certifier. */
  sentWriter: ReadonlySet<string>;
  sentCertifier: ReadonlySet<string>;
}

/** One pass of the writer duty for one Channel (Vector `duty_for`). */
export function planWriterDuty(i: WriterDutyInput): WriterPlan {
  const { control, me, channelIdHex: ch, nowMs: now } = i;
  const owner = control.ownerHex;
  const none: WriterPlan = { kind: "none" };
  const posters = postersOf(control, i.members, ch);
  const manager = (h: string) => h === owner || (!control.banned.has(h) && hasPermission(control.roster, h, Permissions.MANAGE_CHANNELS));
  const mayManage = manager(me);
  const restrict = restrictsChannel(control, ch);
  const ledger = control.writers?.get(ch);
  const isRestricted = ledgerRestricted(ledger);
  const keyless = mayManage && restrict && isRestricted && posters.writes(me) && !i.holdsLive;
  const live = liveWriterEntry(ledger);
  const current = currentWriterOf(ledger);
  // A Refounding retires the live writer epoch; one naming no certifier predates certificates.
  const retired = (live !== undefined && live.root < i.rootEpoch) || (current !== undefined && ledger !== undefined && certifierOf(ledger, current.epoch) === undefined);
  if (mayManage && i.due({ kind: "move" }) && ((restrict && retired) || restrict !== isRestricted)) {
    return { kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "move" }] };
  }
  if (!ledger || !live || !current || !restrict || live.root < i.rootEpoch) return none;
  const { epoch } = current;
  const scope = bytesToHex(writerScope(hex32(ch)));
  const named = namedDeliveries(i.deliveries, ledger, ch);
  const minted = (d: string, e: number) => d === minterOf(ledger, e);
  const trusted = (d: string, e: number) => minted(d, e) || posters.manages(d);
  const vouching = (d: string, e: number) => minted(d, e) || posters.vouchesAsManager(d);
  const certified = (p: string, e: number) =>
    certifierOf(ledger, e) === undefined ||
    named.some((d) => Number(d.newEpoch) === e && trusted(d.deliverer, e) && [...d.certs].some(([w, c]) => w === p && certifies(i.communityId, ledger, e, w, c)));
  const served = (p: string, e: number) => named.some((d) => Number(d.newEpoch) === e && trusted(d.deliverer, e) && blobFor(d, p, scope, e)) && certified(p, e);
  let handover: { epoch: number; recipients: string[] } | undefined;
  const finish = (p: WriterPlan): WriterPlan => {
    if (!handover) return p;
    return p.kind === "none" ? { kind: "certifier", ...handover } : { ...p, handover };
  };

  if (mayManage) {
    const pool = [...new Set([...i.candidates, ...control.banned])];
    const holding = certifierHolders(ledger, epoch, i.deliveries, ch, pool, manager);
    if (i.walked && [...holding].some((p) => p !== me && !posters.manages(p)) && i.due({ kind: "certifier" })) {
      return { kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "certifier" }] };
    }
    const out = [...vouchedAt(i.communityId, ledger, named, vouching, epoch)]
      .filter((p) => i.walked && p !== me && !posters.manages(p) && !stopped(ledger, epoch, p, now))
      .filter((p) => lostSend(control, p, ch))
      .filter((p) => me === owner || canActOnMember(control.roster, me, owner, p, Permissions.MANAGE_CHANNELS))
      .filter((p) => i.due({ kind: "cut", member: p }))
      .sort();
    if (out.length > 0) {
      return { kind: "backstop", act: out.length === 1 ? { kind: "stop", writer: out[0] } : { kind: "mint", cut: out }, lanes: out.map((member) => ({ kind: "cut", member })) };
    }
    if (i.holdsCertifier) {
      const owed = i.candidates.filter((p) => p !== me && posters.manages(p) && !holding.has(p) && !i.sentCertifier.has(p));
      if (owed.length > 0) handover = { epoch, recipients: owed };
    }
    const starved = now - Math.max(live.at, i.postableSince) > STARVED_MS;
    if (keyless && starved && i.due({ kind: "starved" })) {
      return finish({ kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "starved" }] });
    }
  }
  if (!i.holdsCertifier && !mayManage) return finish(none);
  const left = leftOut(i.communityId, ledger, named, scope, vouching);
  const start = writerStart(ledger, epoch) ?? 0;
  const isStopped = (p: string) => stopped(ledger, epoch, p, now);
  const wasAway = (p: string) => i.history !== undefined && kickedInto(i.history, p, start);
  const owed = (p: string) =>
    (posters.writes(p) || posters.manages(p)) && !isStopped(p) && !wasAway(p) && !i.sentWriter.has(p) && !served(p, epoch) && !left.has(p);
  const unserved = i.candidates.filter((p) => p !== me && owed(p));
  const back = i.walked ? i.candidates.find((p) => posters.writes(p) && !posters.manages(p) && (isStopped(p) || left.has(p) || wasAway(p))) : undefined;
  if (back && mayManage && i.due({ kind: "unserved" })) {
    return finish({ kind: "backstop", act: { kind: "restart", writer: back }, lanes: [{ kind: "unserved" }] });
  }
  if (unserved.length === 0) return finish(none);
  if (i.holdsLive && i.holdsCertifier) return finish({ kind: "deliver", epoch, recipients: unserved });
  // A fresh epoch's own deliveries get a while to land before anyone mints over it.
  if (mayManage && now - live.at > STARVED_MS && unserved.some((p) => posters.writes(p)) && i.due({ kind: "unserved" })) {
    return finish({ kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "unserved" }] });
  }
  return finish(none);
}
