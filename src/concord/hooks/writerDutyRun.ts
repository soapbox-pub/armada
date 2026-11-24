/**
 * Acting on the writer duty's plan (`lib/writerDuty.ts`), as Vector's `duty_for`,
 * `backstop` and `mint` do: deliver the live secret or certifier, or, as a backstop,
 * wait by rank, read the Control Plane again, and mint, stop or reopen only if the
 * ledger is where the pass saw it and the Roster, read whole again, agrees with it.
 */

import type { NPool } from "@nostrify/nostrify";

import { readAccessPlanes } from "@/concord/hooks/useChannelAccess";
import { citationFor, publishEdition, withControlWrite } from "@/concord/hooks/useControlPlane";
import type { OpenedChat } from "@/concord/lib/chat";
import type { FoldedControl } from "@/concord/lib/control";
import { accessPlane, buildAccessDeliveries, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, certifierScope, hex32, writerScope } from "@/concord/lib/derive";
import { kickedSpanFrom, type GuestbookHistory } from "@/concord/lib/guestbook";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { highestPosition } from "@/concord/lib/roles";
import { CHAT_ROW_KINDS, heldWriterPostSince, queryChannelRumors } from "@/concord/lib/rumorStore";
import { writerJudge } from "@/concord/lib/channelJudges";
import { sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { heldCertifier, heldLiveSecret, mintedSecrets, postableSince, storeOwnWriter } from "@/concord/lib/writerKeys";
import {
  laneKey,
  lanePeriod,
  lostRights,
  planWriterDuty,
  postersOf,
  RANK_STAGGER_MS,
  remodes,
  restrictsChannel,
  writerCandidates,
  type Act,
  type Lane,
} from "@/concord/lib/writerDuty";
import { locksChannel, rightsCover, rightsOf, type Rights } from "@/concord/lib/writerRights";
import { buildMint, certify, entryTime, ledgerEdition, stopFits } from "@/concord/lib/writerMint";
import { certifierOf, currentWriterOf, ledgerRestricted, ledgerToJson, sealTarget, stopped, writerStart, type Ledger } from "@/concord/lib/writers";
import { channelsView } from "@/concord/lib/community";
import { sealHistory } from "@/concord/hooks/sealHistory";
import type { NostrRumor } from "@/lib/nostrRumor";
import { clockNowMs } from "@/lib/relayClock";
import { logSync } from "@/lib/syncLog";
import { syncHalted } from "@/sync/syncManager";

type DutyUser = { pubkey: string; signer: Parameters<typeof sealRumor>[3] & { nip44?: { encrypt(pk: string, plain: string): Promise<string> } } };

export interface WriterDutyEnv {
  nostr: NPool;
  user: DutyUser;
  /** The Community, its fold and its Guestbook as they stand now: a backstop reads them again after its wait. */
  now: () => { community?: Community; folded?: FoldedControl; members: ReadonlyMap<string, { state: string }>; history?: GuestbookHistory; walked: boolean };
  accessCandidates: (folded: FoldedControl) => string[];
  /** Ask for the Control Plane to be folded again, after this device published to it. */
  refresh?: () => void;
  /**
   * Read the Control Plane, and the Guestbook if asked, from the relays again and let
   * the fold catch up (Vector `follow_fresh`, `sync_guestbook`); false on a short read.
   */
  freshen?: (guestbook: boolean) => Promise<boolean>;
  /** The Control Plane as this device stores it, folded: a ledger edition is planned on it, under the write lock. */
  stored?: () => Promise<FoldedControl | undefined>;
  /** Settling this member's own change: acted on at once, neither rank-staggered nor damped (Vector `settle_writers`). */
  settle?: boolean;
  /** The fold before that change: settling touches only the Channels it moved. */
  settledFrom?: FoldedControl;
  signal: AbortSignal;
}

/**
 * Whether the pass must stop before its next write: aborted, or logout halted sync.
 * Past a ledger edition only logout stops it, so a mint never goes out half delivered.
 */
const mustStop = (env: WriterDutyEnv, committed = false) => syncHalted() || (!committed && env.signal.aborted);

/** Wait until this device's fold holds a ledger for `ch` other than `before`, or give up. */
async function ledgerMoved(env: WriterDutyEnv, ch: string, before: string, timeoutMs = 15_000): Promise<boolean> {
  env.refresh?.();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !env.signal.aborted) {
    const l = env.now().folded?.writers?.get(ch);
    if ((l ? ledgerToJson(l) : "") !== before) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Lanes tried this session, by `community:channel:lane` (Vector `BackstopClock`). */
const tried = new Map<string, number>();
/** Members handed the live secret, and the certifier, this session (Vector `WriterSent`, `CertifierSent`). */
const sentWriter = new Set<string>();
const sentCertifier = new Set<string>();

/** Forget this session's damping and hand-offs, so the next account starts afresh. */
export function clearWriterDutyMemory(): void {
  tried.clear();
  sentWriter.clear();
  sentCertifier.clear();
}

async function publishOnPlane(env: WriterDutyEnv, community: Community, channelId: Uint8Array, rumors: NostrRumor[]): Promise<void> {
  const plane = accessPlane(community, channelId);
  for (const rumor of rumors) {
    if (syncHalted()) throw new Error("sync halted");
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, plane, env.user.signer), plane);
    for (let tries = 0; ; tries++) {
      const sent = await Promise.allSettled(community.relays.map((url) => env.nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })));
      if (sent.some((r) => r.status === "fulfilled")) break;
      if (tries >= 2) throw new Error("no relay took the writer delivery");
      await new Promise((r) => setTimeout(r, 500 * (tries + 1)));
    }
  }
}

/**
 * The newest post this device holds in a Channel, for {@link entryTime}: a message, never a
 * reaction or an edit, and none the rules hold (Vector `entry_time`).
 */
async function newestPost(env: WriterDutyEnv, communityIdHex: string, channelIdHex: string): Promise<number | undefined> {
  const { community, folded, history } = env.now();
  const judge = community ? writerJudge(folded, channelIdHex, community.id, history) : undefined;
  const rows: OpenedChat[] = await queryChannelRumors(communityIdHex, channelIdHex, { limit: 50 }).catch(() => []);
  let newest: number | undefined;
  for (const r of rows) {
    if (!CHAT_ROW_KINDS.includes(r.kind) || (judge && !judge.stands(r))) continue;
    if (newest === undefined || r.ms > newest) newest = r.ms;
  }
  return newest;
}

/** Run the writer duty for every Channel a Roster restricts or a ledger does. */
export async function runWriterDuty(env: WriterDutyEnv): Promise<void> {
  const start = env.now();
  const { community, folded } = start;
  const nip44 = env.user.signer.nip44;
  if (!community || !folded?.rankedRoster || folded.incomplete.length > 0 || !nip44) return;
  const me = env.user.pubkey;
  const members = new Set([...start.members].filter(([, m]) => m.state === "join").map(([pk]) => pk));
  const candidates = writerCandidates(env.accessCandidates(folded), folded.ownerHex, me);
  for (const def of folded.channels.values()) {
    if (env.signal.aborted) return;
    if (def.deleted) continue;
    const ch = def.channelIdHex;
    const ledger = folded.writers?.get(ch);
    if (!restrictsChannel(folded, ch) && !ledgerRestricted(ledger)) continue;
    if (env.settle && env.settledFrom && !settleMoves(env.settledFrom, folded, ch, members, candidates)) continue;
    try {
      await dutyFor(env, community, folded, ch, ledger, members, candidates, start.history, start.walked);
    } catch (err) {
      logSync("writers", `${community.idHex.slice(0, 8)} #${ch.slice(0, 8)}: writer duty failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Whether a change from `before` to `after` moved a Channel's writers (Vector `settle_one`):
 * the Roster restricts it now and didn't, or the other way, or someone lost or gained posting
 * there, or stopped managing Channels.
 */
function settleMoves(before: FoldedControl, after: FoldedControl, ch: string, members: ReadonlySet<string>, candidates: readonly string[]): boolean {
  if (restrictsChannel(before, ch) !== restrictsChannel(after, ch) || locksChannel(before, ch) !== locksChannel(after, ch)) return true;
  const [was, now] = [postersOf(before, members, ch), postersOf(after, members, ch)];
  const same = (a: Rights | undefined, b: Rights | undefined) => (a === undefined ? b === undefined : b !== undefined && rightsCover(a, b) && rightsCover(b, a));
  return candidates.some((p) => !same(was.rights(p), now.rights(p)) || (was.manages(p) && !now.manages(p)));
}

async function dutyFor(
  env: WriterDutyEnv,
  community: Community,
  folded: FoldedControl,
  ch: string,
  ledger: Ledger | undefined,
  members: ReadonlySet<string>,
  candidates: string[],
  history: GuestbookHistory | undefined,
  walked: boolean,
): Promise<void> {
  const me = env.user.pubkey;
  const nowMs = clockNowMs();
  const planes = await readAccessPlanes(env.nostr, community, [ch], env.signal);
  const deliveries = planes.flatMap((p) => parseDelivery(p.opened) ?? []);
  const live = heldLiveSecret(community.idHex, ledger);
  const current = currentWriterOf(ledger);
  const certifying = ledger && current ? heldCertifier(community.idHex, ledger, current.epoch) : undefined;
  const posters = postersOf(folded, members, ch);
  const mayManage = me === folded.ownerHex || posters.vouchesAsManager(me);
  const keyless = mayManage && restrictsChannel(folded, ch) && ledgerRestricted(ledger) && posters.writes(me) && !live;
  const laneId = (lane: Lane) => `${community.idHex}:${ch}:${laneKey(lane)}`;
  const due = (lane: Lane) => {
    if (env.settle) return true;
    const last = tried.get(laneId(lane));
    return last === undefined || nowMs - last > lanePeriod(lane);
  };
  const sentKey = (set: Set<string>, epoch: number) => (p: string) => set.has(`${community.idHex}:${ch}:${epoch}:${p}`);
  const epoch = current?.epoch ?? 0;
  const plan = planWriterDuty({
    control: folded,
    communityId: community.id,
    rootEpoch: Number(community.rootEpoch),
    channelIdHex: ch,
    me,
    members,
    candidates,
    deliveries,
    holdsLive: live !== undefined,
    holdsCertifier: certifying !== undefined,
    postableSince: postableSince(community.idHex, ch, keyless, nowMs),
    walked,
    history,
    nowMs,
    due,
    sentWriter: new Set(candidates.filter(sentKey(sentWriter, epoch))),
    sentCertifier: new Set(candidates.filter(sentKey(sentCertifier, epoch))),
  });
  const encrypt = (pk: string, plain: string) => env.user.signer.nip44!.encrypt(pk, plain);
  const handOver = async (h: { epoch: number; recipients: string[] }) => {
    if (!certifying || !ledger) return;
    const rumors = await buildAccessDeliveries(me, encrypt, {
      scopeIdHex: bytesToHex(certifierScope(hex32(ch))),
      epoch: BigInt(h.epoch),
      key: certifying,
      recipients: h.recipients,
      atSecs: Math.floor(nowMs / 1000),
      writer: certifierOf(ledger, h.epoch),
    });
    if (mustStop(env)) return;
    await publishOnPlane(env, community, hex32(ch), rumors);
    for (const p of h.recipients) sentCertifier.add(`${community.idHex}:${ch}:${h.epoch}:${p}`);
  };
  if (plan.handover) await handOver(plan.handover);
  if (plan.kind === "deliver" && live && certifying && ledger) {
    const { certs, scoped } = certify(community.id, ch, plan.epoch, certifying, plan.recipients, posters.owed);
    const rumors = await buildAccessDeliveries(me, encrypt, {
      scopeIdHex: bytesToHex(writerScope(hex32(ch))),
      epoch: BigInt(plan.epoch),
      key: live.secret,
      recipients: plan.recipients,
      atSecs: Math.floor(nowMs / 1000),
      writer: live.pk,
      certs,
      scoped,
    });
    if (mustStop(env)) return;
    await publishOnPlane(env, community, hex32(ch), rumors);
    for (const p of plan.recipients) sentWriter.add(`${community.idHex}:${ch}:${plan.epoch}:${p}`);
    logSync("writers", `${community.idHex.slice(0, 8)} #${ch.slice(0, 8)}: handed the writer key to ${plan.recipients.length} writer(s)`);
  } else if (plan.kind === "certifier") {
    await handOver(plan);
  } else if (plan.kind === "seal") {
    tried.set(laneId({ kind: "seal" }), nowMs);
    if (!plan.mine && !env.settle) await rankWait(me, folded);
    const result = await seal(env, ch).catch((err: unknown) => `failed (retried later): ${err instanceof Error ? err.message : String(err)}`);
    if (result !== undefined) logSync("writers", `${community.idHex.slice(0, 8)} #${ch.slice(0, 8)}: ${typeof result === "number" ? `sealed ${result} post(s) before the lock` : `sealing ${result}`}`);
  } else if (plan.kind === "backstop") {
    if (!due({ kind: "retry" })) return;
    const result = await backstop(env, ch, ledger, folded, plan.act);
    logSync("writers", `${community.idHex.slice(0, 8)} #${ch.slice(0, 8)}: backstop ${plan.act.kind}: ${result}`);
    const at = clockNowMs();
    if (result === "short") tried.set(laneId({ kind: "retry" }), at);
    else if (result !== "moved") for (const lane of plan.lanes) tried.set(laneId(lane), at);
  }
}

type BackstopResult = "acted" | "moved" | "short" | "stood-down" | "failed";

/** Wait by this device's rank, so the highest manager acts first; managers of one rank spread out too. */
async function rankWait(me: string, judgedOn: FoldedControl): Promise<void> {
  const steps = me === judgedOn.ownerHex ? 0 : Math.min(10, (highestPosition(judgedOn.roster, me) ?? 9) + 1);
  if (steps > 0) await new Promise((r) => setTimeout(r, RANK_STAGGER_MS * steps + Math.random() * RANK_STAGGER_MS));
}

/**
 * Seal a Locked run's history as far as it is owed (CORD-03 §1, Vector `seal_history`): on a
 * Guestbook read whole, by a device holding every read plane's key, the ledger edition going
 * out only if no other seal or move came first.
 */
async function seal(env: WriterDutyEnv, ch: string): Promise<number | undefined> {
  if (env.freshen && !(await env.freshen(true))) throw new Error("the Control Plane or Guestbook read short");
  const { community, folded, history, walked } = env.now();
  if (!community || !folded || !history || !walked || mustStop(env)) return undefined;
  const channel = channelsView(community, folded).find((c) => c.idHex === ch);
  if (!channel) return undefined;
  const nowMs = clockNowMs();
  return sealHistory({
    nostr: env.nostr,
    community,
    folded,
    channel,
    history,
    nowMs,
    signal: env.signal,
    publish: async (sealed, until) => {
      if (env.freshen && !(await env.freshen(false))) return false;
      const seen = env.now().folded;
      if (!seen || mustStop(env)) return false;
      return withControlWrite(community.idHex, async () => {
        const held = await heldFold(env, seen);
        const base = held.writers?.get(ch);
        // Another manager, or a lock moving under the read, makes this seal no longer the one owed.
        if (!base || sealTarget(base, nowMs) !== until || mustStop(env)) return false;
        const at = clockNowMs();
        const built = ledgerEdition({
          communityId: community.id,
          control: held,
          channelIdHex: ch,
          base,
          seal: sealed,
          entryAtMs: at,
          nowMs: at,
          me: env.user.pubkey,
          authority: citationFor(community, held, env.user.pubkey),
        });
        if (!built) return false;
        await publishEdition(env.nostr, community, env.user.signer, built.rumor);
        return true;
      });
    },
  });
}

async function backstop(env: WriterDutyEnv, ch: string, seen: Ledger | undefined, judgedOn: FoldedControl, act: Act): Promise<BackstopResult> {
  const me = env.user.pubkey;
  if (!env.settle) await rankWait(me, judgedOn);
  if (env.signal.aborted) return "moved";
  // Acting on one writer is judged on the Guestbook caught up too.
  const judgesWriter = act.kind === "stop" || act.kind === "restart" || (act.kind === "mint" && act.cut.length > 0);
  if (env.freshen && !(await env.freshen(judgesWriter))) return "short";
  const fresh = env.now();
  if (!fresh.community || !fresh.folded) return "moved";
  const ledger = fresh.folded.writers?.get(ch);
  if ((ledger ? ledgerToJson(ledger) : "") !== (seen ? ledgerToJson(seen) : "")) return "moved";
  // The Roster the pass read may predate the change that moved the ledger.
  if (fresh.folded.incomplete.length > 0) return "short";
  const now = fresh.folded;
  if (restrictsChannel(now, ch) !== restrictsChannel(judgedOn, ch) || locksChannel(now, ch) !== locksChannel(judgedOn, ch)) return "stood-down";
  // What justified acting on one writer must hold on what was just read too.
  const lost = (p: string, had: Rights) => lostRights(now, p, ch, had);
  let keptOut: Array<[string, Rights]> = [];
  if (act.kind === "stop" && !lost(act.writer, act.had)) return "stood-down";
  if (act.kind === "restart" && (now.banned.has(act.writer) || rightsOf(now, act.writer, ch, locksChannel(now, ch)) === undefined)) return "stood-down";
  if (act.kind === "mint" && act.cut.length > 0) {
    keptOut = act.cut.filter(([p, had]) => lost(p, had));
    if (keptOut.length === 0) return "stood-down";
    if (keptOut.length === 1) act = { kind: "stop", writer: keptOut[0][0], had: keptOut[0][1] };
    else act = { kind: "mint", cut: [] };
  }
  // A fresh epoch leaves out only who may write nothing now; the narrowed it certifies anew.
  const gone = (list: ReadonlyArray<[string, Rights]>) =>
    list.map(([p]) => p).filter((p) => now.banned.has(p) || rightsOf(now, p, ch, locksChannel(now, ch)) === undefined);
  const restrict = restrictsChannel(judgedOn, ch);
  const isRestricted = ledgerRestricted(ledger);
  try {
    if (!restrict && isRestricted) return (await reopen(env, ch)) ? "acted" : "moved";
    if (!restrict) return "moved";
    if (isRestricted && remodes(judgedOn, ledger, ch)) return (await mint(env, ch, gone(keptOut))) ? "acted" : "moved";
    if (isRestricted && act.kind === "stop") {
      if (stopFits(ledger, act.writer, clockNowMs())) return (await stopWriter(env, ch, act.writer)) ? "acted" : "moved";
      return (await mint(env, ch, gone([[act.writer, act.had]]))) ? "acted" : "moved";
    }
    if (isRestricted && act.kind === "mint") return (await mint(env, ch, gone(keptOut.length > 0 ? keptOut : act.cut))) ? "acted" : "moved";
    return (await mint(env, ch, [])) ? "acted" : "moved";
  } catch (err) {
    logSync("writers", `#${ch.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** Publish one ledger edition appending `spell`, from the ledger as it stands now. */
async function appendToLedger(env: WriterDutyEnv, ch: string, spell: Parameters<typeof ledgerEdition>[0]["spell"], from?: number): Promise<boolean> {
  const { community, folded: seen } = env.now();
  if (!community || !seen) return false;
  const newest = await newestPost(env, community.idHex, ch);
  if (mustStop(env)) return false;
  return withControlWrite(community.idHex, async () => {
    const folded = await heldFold(env, seen);
    // This device's own last write may have moved the ledger since the pass saw it.
    if (!sameLedger(folded, seen, ch) || mustStop(env)) return false;
    const nowMs = clockNowMs();
    const built = ledgerEdition({
      communityId: community.id,
      control: folded,
      channelIdHex: ch,
      base: folded.writers?.get(ch) ?? { channel: ch, entries: [], retired: [], extra: {} },
      spell,
      ...(from !== undefined ? { from } : {}),
      entryAtMs: entryTime(nowMs, newest),
      nowMs,
      me: env.user.pubkey,
      authority: citationFor(community, folded, env.user.pubkey),
    });
    if (!built) return false;
    await publishEdition(env.nostr, community, env.user.signer, built.rumor);
    return true;
  });
}

/** The fold this device stores, which holds its own last write before the rendered one does; `fallback` without one. */
async function heldFold(env: WriterDutyEnv, fallback: FoldedControl): Promise<FoldedControl> {
  return (await env.stored?.().catch(() => undefined)) ?? fallback;
}

function sameLedger(a: FoldedControl, b: FoldedControl, ch: string): boolean {
  const [x, y] = [a.writers?.get(ch), b.writers?.get(ch)];
  return (x ? ledgerToJson(x) : "") === (y ? ledgerToJson(y) : "");
}

async function stopWriter(env: WriterDutyEnv, ch: string, writer: string): Promise<boolean> {
  return appendToLedger(env, ch, { kind: "stop", writer });
}

/**
 * Stop in the live epoch, from when they left, each member a Kick kept away while it
 * held who posted at its address (Vector `carry_departures`), each stop folded before
 * the next. Returns false when one went out and didn't fold back in time, so the
 * caller stands down for the next pass rather than minting over a stale head.
 */
async function carryDepartures(env: WriterDutyEnv, ch: string): Promise<boolean> {
  for (;;) {
    const { community, folded, history } = env.now();
    const ledger = folded?.writers?.get(ch);
    const current = currentWriterOf(ledger);
    if (!community || !folded || !ledger || !current || !history) return true;
    const start = writerStart(ledger, current.epoch) ?? 0;
    let carried: string | undefined;
    for (const writer of history.keys()) {
      const from = kickedSpanFrom(history, writer, start);
      if (from === undefined || stopped(ledger, current.epoch, writer, from)) continue;
      // Their writer posts this device stored since they left: anyone else has nothing a later reader could show.
      if (!(await heldWriterPostSince(community.idHex, ch, writer, from).catch(() => false))) continue;
      // At the cap a stop would retire the live entry: the epoch's window is what holds then.
      if (!stopFits(ledger, writer, clockNowMs())) return true;
      const before = ledgerToJson(ledger);
      if (!(await appendToLedger(env, ch, { kind: "stop", writer }, from))) return false;
      if (!(await ledgerMoved(env, ch, before))) return false;
      carried = writer;
      break;
    }
    if (!carried) return true;
  }
}

async function reopen(env: WriterDutyEnv, ch: string): Promise<boolean> {
  if (!(await carryDepartures(env, ch))) return false;
  return appendToLedger(env, ch, { kind: "open" });
}

/** Mint a writer epoch (Vector `mint`): only on a Guestbook read whole, first carrying who left. */
async function mint(env: WriterDutyEnv, ch: string, cut: readonly string[]): Promise<boolean> {
  const at = env.now();
  if (!at.walked) throw new Error("this community's memberlist isn't read whole yet; nothing minted");
  if (!(await carryDepartures(env, ch))) return false;
  const { community, folded, members } = env.now();
  if (!community || !folded) return false;
  const joined = new Set([...members].filter(([, m]) => m.state === "join").map(([pk]) => pk));
  const nowMs = clockNowMs();
  const newest = await newestPost(env, community.idHex, ch);
  if (mustStop(env)) return false;
  const built = await buildMint({
    communityId: community.id,
    control: folded,
    rootEpoch: Number(community.rootEpoch),
    channelIdHex: ch,
    me: env.user.pubkey,
    posters: postersOf(folded, joined, ch),
    candidates: writerCandidates(env.accessCandidates(folded), folded.ownerHex, env.user.pubkey),
    cut,
    secrets: (epoch) => mintedSecrets(community.idHex, ch, epoch),
    entryAtMs: entryTime(nowMs, newest),
    nowMs,
    authority: citationFor(community, folded, env.user.pubkey),
    encrypt: (pk, plain) => env.user.signer.nip44!.encrypt(pk, plain),
  });
  if (!built || mustStop(env)) return false;
  // Building took a signer round trip per writer: another manager may have moved the ledger (Vector `ledger_moved_since`).
  if (env.freshen) {
    if (!(await env.freshen(false)) || mustStop(env)) return false;
    const now = env.now().folded;
    if (!now || !sameLedger(now, folded, ch)) return false;
  }
  const published = await withControlWrite(community.idHex, async () => {
    // …or this device's own last write did.
    if (!sameLedger(await heldFold(env, folded), folded, ch) || mustStop(env)) return false;
    if (built.own) storeOwnWriter(community.idHex, ch, built.epoch, built.own.secret, built.own.cert, built.own.scoped);
    // The ledger goes first, so a manager that sees it moved stands down; then every part of the mint.
    await publishEdition(env.nostr, community, env.user.signer, built.edition);
    return true;
  });
  if (!published || mustStop(env, true)) return false;
  await publishOnPlane(env, community, hex32(ch), built.deliveries);
  logSync("writers", `${community.idHex.slice(0, 8)} #${ch.slice(0, 8)}: minted writer epoch ${built.epoch}`);
  return true;
}
