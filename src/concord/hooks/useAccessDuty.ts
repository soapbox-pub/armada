/**
 * Run the access duty for every Private Channel this member holds the key of
 * (CORD-03 §5, Vector `access_duty`): see `lib/accessDuty.ts` for what is owed.
 * Rank-staggered after the Roster moves, so the first holder's delivery serves
 * the rest, and again every ten minutes; only off a whole read of the Roster.
 */

import type { NostrEvent, NPool } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { readAccessPlanes } from "@/concord/hooks/useChannelAccess";
import { citationFor, foldStoredControl, publishEdition, useControlFold, useDissolved, withControlWrite } from "@/concord/hooks/useControlPlane";
import { guestbookWalked, useGuestbook } from "@/concord/hooks/useGuestbook";
import { runWriterDuty } from "@/concord/hooks/writerDutyRun";
import { useChannelRekey } from "@/concord/hooks/useRekey";
import { onDutyNow } from "@/concord/lib/dutyNow";
import { sweepControl, sweepGuestbook } from "@/concord/lib/planeSync";
import { accessCandidates, authoritySig, dutyMayAct, mintingRotations, planChannelDuty, rotationRecipients, stillShutOut, type MintingRotation } from "@/concord/lib/accessDuty";
import { cachedCommunity } from "@/concord/hooks/useCommunityList";
import { isEntitled } from "@/concord/lib/channelAccess";
import { withKeySettle } from "@/concord/lib/keySettle";
import { majorityOf, publishDurable, quorum } from "@/concord/lib/quorum";
import { resealedChannelContent } from "@/concord/lib/channelSeal";
import { buildChannelContentEdition, type FoldedControl } from "@/concord/lib/control";
import { settleBook } from "@/concord/lib/owedSettle";
import { accessPlane, buildAccessDeliveries, buildHistoryDeliveries, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, channelGroupKey, channelRekeyGroupKey, hex32 } from "@/concord/lib/derive";
import { heldHistoryViews, historyViewsReady } from "@/concord/lib/history";
import { KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord/lib/kinds";
import { groupRotations, parseRekey } from "@/concord/lib/rekey";
import { hasPermission, highestPosition, Permissions } from "@/concord/lib/roles";
import { openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Community, PrivateChannelKey } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { clockNowMs } from "@/lib/relayClock";
import type { NostrRumor } from "@/lib/nostrRumor";
import { logSync } from "@/lib/syncLog";

/** How often a holder that can rotate reads the Control Plane again for a change it missed. */
const CONTROL_REREAD_MS = 5_000;

/** How recent a whole read a pass takes as its own. */
const WHOLE_FRESH_MS = 3_000;

/** How long a pass waits on its fresh read of the Control Plane and Guestbook. */
const SWEEP_BOUND_MS = 6_000;

/** How much longer each step down the Roles waits before acting on a Roster change. */
const DUTY_STAGGER_STEP_MS = 500;

/** How often a holder re-checks its Channels when nothing moved (Vector `ACCESS_DUTY_PERIOD_MS`). */
const ACCESS_DUTY_PERIOD_MS = 10 * 60_000;

/** Communities with a duty in flight: one at a time each. */
const running = new Set<string>();
/** Communities asked for a pass while one ran: one more runs after it. */
const rerun = new Set<string>();
/** Members delivered to this session, by `community:channel:epoch:member` (Vector `AccessLedger`). */
const delivered = new Set<string>();

/** Members this device rotated out, by `community:channel:epoch it minted:member`. */
const cutBySelf = new Set<string>();

/** Complete rotations by `community:channel:epoch`: a complete rotation never changes (Vector `MintedRotations`). */
const minted = new Map<string, MintingRotation[]>();
/** Past epochs handed out this session, by `community:channel:epoch:member`: a re-add needs only what's new. */
const historyDelivered = new Set<string>();
/** History deliveries still publishing, so a test or a logout can wait them out. */
const historyInFlight = new Set<Promise<void>>();
/** History events published at once: one per past epoch, so a long-rotated Channel has hundreds. */
const HISTORY_CONCURRENCY = 8;
/** Bumped on account exit, so a history run left over stops rather than signing on. */
let historyGeneration = 0;

/** Settles once every history delivery started so far has. */
export async function historyDeliveriesSettled(): Promise<void> {
  while (historyInFlight.size > 0) await Promise.allSettled([...historyInFlight]);
}

/** Forget whom this session delivered to, so the next account starts afresh. */
export function clearAccessDutyMemory(): void {
  delivered.clear();
  historyDelivered.clear();
  historyGeneration++;
  minted.clear();
  cutBySelf.clear();
}

/** Rekey wraps per page, and pages read, at most (Vector `REKEY_PAGE`, `REKEY_MAX_PAGES`). */
const REKEY_PAGE = 200;
const REKEY_MAX_PAGES = 6;

/**
 * Page one relay's wraps at rekey `authors` backwards: anyone holding the root can flood a
 * rekey address, and one fixed page would bury the rotation beneath it (Vector `fetch_rekey_chunks`).
 */
async function pageRekeyWraps(nostr: NPool, url: string, authors: string[], signal: AbortSignal): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | undefined;
  for (let page = 0; page < REKEY_MAX_PAGES && !signal.aborted; page++) {
    const filter = { kinds: [KIND_WRAP], authors, limit: REKEY_PAGE, ...(until !== undefined ? { until } : {}) };
    const got = await nostr.relay(url).query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }).catch(() => undefined);
    if (!got) break;
    let fresh = 0;
    for (const e of got) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      fresh++;
      until = until === undefined ? e.created_at : Math.min(until, e.created_at);
    }
    // `until` is inclusive, so a page of nothing new is the plane's end.
    if (got.length < REKEY_PAGE || fresh === 0) break;
  }
  return out;
}

/** The complete rotations minting a Channel's `epoch`, under every held root. */
export async function readMintingRotations(nostr: NPool, community: Community, channelId: Uint8Array, epoch: bigint, signal: AbortSignal): Promise<MintingRotation[]> {
  if (epoch <= 0n) return [];
  const cacheKey = `${community.idHex}:${bytesToHex(channelId)}:${epoch}`;
  const held = minted.get(cacheKey);
  if (held) return held;
  const roots = community.heldRoots.length > 0 ? community.heldRoots : [{ epoch: community.rootEpoch, key: community.root }];
  const addresses = new Map(roots.map((r) => {
    const a = channelRekeyGroupKey(r.key, channelId, epoch);
    return [a.pk, a] as const;
  }));
  const events = (await quorum(community.relays.map((url) => pageRekeyWraps(nostr, url, [...addresses.keys()], signal)))).flatMap((r) => r ?? []);
  const seen = new Set<string>();
  const parsed = events.flatMap((e) => {
    const a = addresses.get(e.pubkey);
    if (!a || seen.has(e.id)) return [];
    seen.add(e.id);
    try {
      return [parseRekey(openWrap(e, a))];
    } catch {
      return [];
    }
  });
  const found = mintingRotations(groupRotations(parsed), bytesToHex(channelId), epoch);
  if (found.length > 0) minted.set(cacheKey, found);
  return found;
}

export { authoritySig } from "@/concord/lib/accessDuty";

export function useAccessDuty(community: Community | undefined): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data: dissolved } = useDissolved(community);
  const { coalesced, history } = useGuestbook(folded?.rankedRoster ? community : undefined, { poll: false });
  const { rekeyChannel, canRekeyChannel } = useChannelRekey(community);
  const latest = useRef({ community, folded, coalesced, history, rekeyChannel, canRekeyChannel });
  latest.current = { community, folded, coalesced, history, rekeyChannel, canRekeyChannel };

  // Re-armed when the Roster, the Banlist or the live links move, not on every Control edition (Vector `authority_changed`).
  const foldSig = useMemo(() => (folded?.rankedRoster ? authoritySig(folded) : ""), [folded]);
  const keySig = (community?.privateChannels ?? []).map((c) => `${bytesToHex(c.id)}@${c.epoch}`).sort().join(",");

  const ready = Boolean(community && user && folded?.rankedRoster && !dissolved && user.signer.nip44);
  const runNow = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!ready || !community || !user) return;
    // Aborted only when the Community or account goes: a pass runs to its end, as
    // Vector's spawned duty does. Aborting on a key change cancelled the very pass whose
    // rotation changed the keys, so it never settled and ran again.
    const controller = new AbortController();
    /** Read the Control Plane, and the Guestbook if asked, from the relays again and let the fold catch up; false on a short read. */
    let lastWhole = 0;
    const freshen = async (guestbook: boolean): Promise<boolean> => {
      const c = latest.current.community;
      if (!c) return false;
      const before = latest.current.folded;
      let short = false;
      let fresh = false;
      const onFresh = (events: readonly unknown[]) => void (fresh ||= events.length > 0);
      // A quorum read: settled once a majority of relays read the Control Plane to the end,
      // and bounded outright, so a relay that never answers holds no pass for its timeout.
      // What the others served is in the store when this returns.
      let reached = 0;
      let majorityIn: () => void = () => undefined;
      const majority = new Promise<void>((resolve) => (majorityIn = resolve));
      const onReached = () => {
        if (++reached >= majorityOf(c.relays.length)) majorityIn();
      };
      await Promise.race([
        Promise.all([
          sweepControl(nostr, c, { onFresh, onReached, onTruncated: () => void (short = true) }).catch(() => void (short = true)),
          guestbook ? sweepGuestbook(nostr, c, { onFresh }).catch(() => void (short = true)) : undefined,
        ]),
        majority,
        new Promise((r) => setTimeout(r, SWEEP_BOUND_MS)),
      ]);
      if (guestbook && !short) lastWhole = Date.now();
      void queryClient.invalidateQueries({ queryKey: ["concord", "control", c.idHex] });
      // Only a read that brought something new has a fold to wait for.
      const until = Date.now() + 1_500;
      while (fresh && latest.current.folded === before && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      return !short;
    };
    /** Whether this member can rotate a Private Channel it holds (the owner, or MANAGE_CHANNELS). */
    const manages = () => {
      const f = latest.current.folded;
      return Boolean(f && (user.pubkey === f.ownerHex || hasPermission(f.roster, user.pubkey, Permissions.MANAGE_CHANNELS)) && latest.current.community?.privateChannels.length);
    };
    // The fold a change started from, kept until a pass settles it against a whole read.
    const book = settleBook(community.idHex);
    const run = async (settle = false, before?: FoldedControl) => {
      if (settle) await book.owe(before);
      const first = latest.current;
      if (!first.community) return;
      const idHex = first.community.idHex;
      // A change made mid-run is owed by the book and settled by a pass right after it, and
      // any other trigger mid-run (the keys this pass rotated, a Roster change) runs one
      // pass after it: dropped, it waited for the ten-minute period.
      if (running.has(idHex)) {
        rerun.add(idHex);
        return;
      }
      running.add(idHex);
      const owed = await book.begin();
      let settled = false;
      try {
        // A member who can rotate reads the access planes and rotations alongside the fresh
        // read, not after it: a cut or a re-grant waits on it. Others read only owed work.
        const reads = first.community.privateChannels.length > 0 && manages() ? prefetchDutyReads(nostr, first.community, controller.signal) : undefined;
        // Judged on a whole read, never only the stored Roster (Vector `fetch_authority`); one
        // just made (the re-read whose change started this pass) is that read.
        const whole = Date.now() - lastWhole < WHOLE_FRESH_MS || (await freshen(true));
        const now = latest.current;
        if (!whole || !now.community || !now.folded) return;
        let failedAny = false;
        const failed = (what: string) => (err: unknown) => {
          failedAny = true;
          logSync("access", `${now.community!.idHex.slice(0, 8)}: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
        };
        // A rotation from an epoch that moved since it was judged would fork the Channel (Vector `judged`),
        // so the epoch is read from the list as written, which a render lags.
        const dutyNow = {
          community: () => cachedCommunity(queryClient, user.pubkey, idHex) ?? latest.current.community,
          stored: async () => {
            const c = latest.current.community;
            return c ? foldStoredControl(c) : undefined;
          },
        };
        // One half's failure never stops the other: the writer duty runs whatever the keys did.
        const judged = await runAccessDuty(nostr, now.community, now.folded, user, now.coalesced, now.canRekeyChannel ? now.rekeyChannel : undefined, dutyNow, controller.signal, owed.from, reads).catch(failed("access duty"));
        await runWriterDuty({
          nostr,
          user,
          now: () => {
            const l = latest.current;
            return { community: l.community, folded: l.folded, members: l.coalesced, history: l.history, walked: l.community ? guestbookWalked(l.community) : false };
          },
          accessCandidates: (f) => accessCandidates(f, latest.current.coalesced),
          refresh: () => void queryClient.invalidateQueries({ queryKey: ["concord", "control", now.community!.idHex] }),
          freshen,
          stored: () => (latest.current.community ? foldStoredControl(latest.current.community) : Promise.resolve(undefined)),
          settle: owed.settle,
          ...(owed.from ? { settledFrom: owed.from } : {}),
          signal: controller.signal,
        }).catch(failed("writer duty"));
        settled = judged === true && !failedAny && !controller.signal.aborted;
        await resealBackstop(nostr, () => latest.current, user, controller.signal, freshen).catch(failed("reseal backstop"));
      } finally {
        const again = await book.end(settled);
        running.delete(idHex);
        const queued = rerun.delete(idHex);
        if (again || queued) void run();
      }
    };
    runNow.current = () => void run();
    const again = setInterval(() => void run(), ACCESS_DUTY_PERIOD_MS);
    // A holder that can rotate re-reads the Control Plane often: a Roster change its live
    // subscription lost and a withholding relay left out of a read reaches it within one
    // period, and the fold it moves runs the duty. A delta read from the cursor, so cheap.
    const reread = setInterval(() => {
      // With the Guestbook, so it is the whole read a pass it starts is judged on.
      if (manages() && !running.has(community.idHex)) void freshen(true);
    }, CONTROL_REREAD_MS);
    const offNow = onDutyNow(community.idHex, (before) => void run(true, before));
    return () => {
      runNow.current = undefined;
      offNow();
      controller.abort();
      clearInterval(again);
      clearInterval(reread);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, user?.pubkey, ready]);

  // Every holder sees the same gap, so they go in rank order: the owner at once, each Role
  // a step later, a roleless holder last. The first to act serves the gap and the rest find
  // nothing left to do (the reseal backstop's stagger); a random 3–15 s wait instead made a
  // re-grant wait that long for its keys and a revoke that long for its cut.
  const stagger = useMemo(() => {
    if (!folded || !user) return 0;
    if (user.pubkey === folded.ownerHex) return 0;
    return Math.min(10, (highestPosition(folded.roster, user.pubkey) ?? 9) + 1) * DUTY_STAGGER_STEP_MS;
  }, [folded, user]);
  useEffect(() => {
    if (!ready) return;
    const first = setTimeout(() => runNow.current?.(), stagger + Math.random() * 400);
    return () => clearTimeout(first);
  }, [ready, foldSig, keySig, stagger]);
}

type DutyUser = { pubkey: string; signer: Parameters<typeof sealRumor>[3] & { nip44?: { encrypt(pk: string, plain: string): Promise<string> } } };
type Rekey = (o: { channelIdHex: string; keepRecipients: string[]; removedTargets: string[]; community?: Community }) => Promise<void>;

/**
 * Deliver `ch`'s key on its access plane to `recipients`, with every earlier epoch this
 * device can read as read-only history (CORD-03 §5, Vector `deliver_access` + `deliver_history`).
 */
export async function deliverKeysOnPlane(nostr: NPool, community: Community, ch: PrivateChannelKey, recipients: readonly string[], user: DutyUser): Promise<number> {
  const nip44 = user.signer.nip44;
  if (!nip44) throw new Error("this signer can't encrypt a delivery");
  await historyViewsReady();
  const idHex = bytesToHex(ch.id);
  const atSecs = Math.floor(clockNowMs() / 1000);
  const views = [
    ...(ch.priors ?? []).filter((p) => p.epoch < ch.epoch).map((p) => {
      const g = channelGroupKey(p.key, ch.id, p.epoch);
      return { epoch: p.epoch, view: { address: g.pk, convKey: bytesToHex(g.convKey) } };
    }),
    ...heldHistoryViews(community.idHex, idHex).filter((v) => v.epoch < ch.epoch && !(ch.priors ?? []).some((p) => p.epoch === v.epoch)),
  ];
  const encrypt = (pk: string, plain: string) => nip44.encrypt(pk, plain);
  const plane = accessPlane(community, ch.id);
  const tag = `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}`;
  const publish = async (rumor: NostrRumor, what: string) => {
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, plane, user.signer), plane);
    // Each relay until it takes it (Vector `publish_durable`), so the member's relays have it.
    await publishDurable(nostr, community.relays, wrap, undefined, `${tag} ${what}`).catch(() => {
      throw new Error(`no relay took the ${what}`);
    });
  };
  // The current key is what lets them in, so it lands before any history does.
  const access = await buildAccessDeliveries(user.pubkey, encrypt, { scopeIdHex: idHex, epoch: ch.epoch, key: ch.key, recipients: [...recipients], atSecs });
  await Promise.all(access.map((r) => publish(r, "delivery")));
  for (const pk of recipients) delivered.add(`${community.idHex}:${idHex}:${ch.epoch}:${pk}`);

  // Past epochs read-only, one event each, behind the key rather than ahead of it.
  const historyKey = (epoch: bigint, pk: string) => `${community.idHex}:${idHex}:${epoch}:${pk}`;
  const byEpoch = views
    .map((v) => ({ ...v, to: recipients.filter((pk) => !historyDelivered.has(historyKey(v.epoch, pk))) }))
    .filter((v) => v.to.length > 0);
  if (byEpoch.length > 0) {
    const generation = historyGeneration;
    const run = (async () => {
      const queue = [...byEpoch].sort((a, b) => (a.epoch > b.epoch ? -1 : 1));
      let failed = 0;
      const worker = async () => {
        for (let next = queue.shift(); next && generation === historyGeneration; next = queue.shift()) {
          const { epoch, view, to } = next;
          try {
            for (const rumor of await buildHistoryDeliveries(user.pubkey, encrypt, { channelIdHex: idHex, views: [{ epoch, view }], recipients: to, atSecs })) {
              await publish(rumor, "history");
            }
            for (const pk of to) historyDelivered.add(historyKey(epoch, pk));
          } catch {
            failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(HISTORY_CONCURRENCY, queue.length) }, worker));
      logSync("access", `${tag}: history out for ${recipients.length} member(s): ${byEpoch.length - failed} past epoch(s)${failed ? `, ${failed} failed` : ""}`);
    })();
    historyInFlight.add(run);
    void run.finally(() => historyInFlight.delete(run));
  }
  return byEpoch.length;
}

/** A pass's relay reads, started before its fresh read of the Control Plane settles. */
interface DutyReads {
  planes: Promise<Awaited<ReturnType<typeof readAccessPlanes>> | undefined>;
  /** By `channel:epoch`. */
  rotations: Map<string, Promise<MintingRotation[] | undefined>>;
}

function prefetchDutyReads(nostr: NPool, community: Community, signal: AbortSignal): DutyReads {
  const ids = community.privateChannels.map((c) => bytesToHex(c.id));
  return {
    planes: readAccessPlanes(nostr, community, ids, signal).catch(() => undefined),
    rotations: new Map(
      community.privateChannels.flatMap((ch) =>
        [ch.epoch, ch.epoch - 1n].map((epoch) => [`${bytesToHex(ch.id)}:${epoch}`, readMintingRotations(nostr, community, ch.id, epoch, signal).catch(() => undefined)] as const),
      ),
    ),
  };
}

/** What a duty pass reads again before it rotates: the store's fold and the community as held now. */
interface DutyNow {
  stored: () => Promise<FoldedControl | undefined>;
  community: () => Community | undefined;
}

async function runAccessDuty(
  nostr: NPool,
  community: Community,
  folded: FoldedControl,
  user: DutyUser,
  members: Parameters<typeof accessCandidates>[1],
  rekey: Rekey | undefined,
  now: DutyNow,
  signal: AbortSignal,
  settledFrom?: FoldedControl,
  reads?: DutyReads,
): Promise<boolean> {
  // Judged on a whole read: a stale entitlement would hand a new epoch's key to someone its rotation just cut.
  if (folded.incomplete.length > 0) return false;
  if (!user.signer.nip44) return false;
  // Before's too: someone only a removed overwrite named still holds what it let them read.
  const candidates = [...new Set([...accessCandidates(folded, members), ...(settledFrom ? accessCandidates(settledFrom, members) : [])])].sort();
  const doneFor = (idHex: string, epoch: bigint) => new Set(candidates.filter((pk) => delivered.has(`${community.idHex}:${idHex}:${epoch}:${pk}`)));
  const held: PrivateChannelKey[] = community.privateChannels.filter((c) => {
    const idHex = bytesToHex(c.id);
    const def = folded.channels.get(idHex);
    return def?.isPrivate && !def.deleted && dutyMayAct(folded, user.pubkey, idHex, candidates, doneFor(idHex, c.epoch));
  });
  if (held.length === 0) return true;
  // One paged read covers every Channel's access plane.
  const planes = (await reads?.planes) ?? (await readAccessPlanes(nostr, community, held.map((c) => bytesToHex(c.id)), signal));
  const rotationsAt = async (ch: PrivateChannelKey, epoch: bigint) =>
    (await reads?.rotations.get(`${bytesToHex(ch.id)}:${epoch}`)) ?? readMintingRotations(nostr, community, ch.id, epoch, signal);
  const rotations = await Promise.all(held.map((ch) => Promise.all([rotationsAt(ch, ch.epoch), rotationsAt(ch, ch.epoch - 1n)])));

  /**
   * Rotate under the settle lock, judged again on the store's fold: a role change this
   * device made since the read may have let someone back in, and its key is already out.
   */
  const rotate = (jobs: { idHex: string; epoch: bigint; cut: string[]; fresh: string[] }[]) =>
    jobs.length === 0
      ? Promise.resolve([])
      : withKeySettle(community.idHex, async () => {
        const stored = (await now.stored().catch(() => undefined)) ?? folded;
        // Each Channel is its own rotation, so they go out together: one after another,
        // the last cut of four landed four rotations' time after the revoke.
        return Promise.allSettled(jobs.map(async ({ idHex, epoch, cut, fresh }) => {
          const c = now.community();
          const ch = c?.privateChannels.find((k) => bytesToHex(k.id) === idHex);
          if (!rekey || !c || ch?.epoch !== epoch || signal.aborted) return;
          const removed = stillShutOut(stored, idHex, cut);
          const letIn = fresh.filter((pk) => isEntitled(stored.roster, stored.ownerHex, pk, idHex) && !stored.banned.has(pk));
          if (removed.length === 0 && letIn.length === 0) return;
          logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: rotating out ${removed.length}, letting in ${letIn.length} by a fresh epoch`);
          await rekey({ channelIdHex: idHex, keepRecipients: rotationRecipients(stored, user.pubkey, idHex, [...new Set([...candidates, ...letIn])], removed), removedTargets: removed, community: c });
          const minted = now.community()?.privateChannels.find((k) => bytesToHex(k.id) === idHex)?.epoch;
          if (minted !== undefined) for (const pk of removed) cutBySelf.add(`${community.idHex}:${idHex}:${minted}:${pk}`);
        }));
      });

  const plans = held.flatMap((ch, i) => {
    const idHex = bytesToHex(ch.id);
    const deliveries = planes.filter((p) => p.channelIdHex === idHex).flatMap((p) => parseDelivery(p.opened) ?? []);
    const [mintedNow, prior] = rotations[i];
    const duty = planChannelDuty({ control: folded, me: user.pubkey, channelIdHex: idHex, epoch: ch.epoch, candidates, deliveries, minted: mintedNow, prior, handled: doneFor(idHex, ch.epoch), communityId: community.id,
      cutBySelf: new Set(candidates.filter((pk) => cutBySelf.has(`${community.idHex}:${idHex}:${ch.epoch}:${pk}`))),
      explain: (pk, why) => why.startsWith("cut") && logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)} e${ch.epoch}: not serving ${pk.slice(0, 8)}: ${why}`) });
    return duty ? [{ ch, idHex, duty }] : [];
  });
  // Cuts first, one at a time under the settle lock; then every key at once, since each
  // delivery is its own Channel's and waits only on its relays.
  const rotationFailed = (results: PromiseSettledResult<void>[]) => results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  // Cuts before any key goes out, so no fresh delivery rides an epoch about to be severed.
  const cutFailed = rotationFailed(await rotate(plans.filter(({ duty }) => duty.cut.length > 0).map(({ idHex, duty }) => ({ idHex, epoch: duty.epoch, cut: duty.cut, fresh: [] }))));
  if (signal.aborted) return false;
  const sent = await Promise.allSettled(
    plans
      .filter(({ duty }) => duty.cut.length === 0 && duty.deliver.length > 0)
      .map(async ({ ch, idHex, duty }) => {
        const past = await deliverKeysOnPlane(nostr, community, ch, duty.deliver, user);
        logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: delivered the key to ${duty.deliver.length} member(s); ${past} past epoch(s) following`);
      }),
  );
  if (signal.aborted) return false;
  const freshFailed = rotationFailed(await rotate(plans.filter(({ duty }) => duty.cut.length === 0 && duty.fresh.length > 0).map(({ idHex, duty }) => ({ idHex, epoch: duty.epoch, cut: [], fresh: duty.fresh }))));
  const failed = cutFailed ?? sent.find((r): r is PromiseRejectedResult => r.status === "rejected") ?? freshFailed;
  if (failed) throw failed.reason;
  return true;
}

/**
 * The reseal backstop (CORD-03 §2, Vector `reseal_backstop`): a manager holding a
 * Private Channel's key seals its details again under the current epoch when its
 * head is sealed at an earlier one, or still plain, after a rank-staggered wait,
 * and from the Control Plane as it stands then.
 */
export async function resealBackstop(
  nostr: NPool,
  now: () => { community?: Community; folded?: FoldedControl },
  user: DutyUser,
  signal: AbortSignal,
  freshen?: (guestbook: boolean) => Promise<boolean>,
): Promise<void> {
  const needing = (c: Community, f: FoldedControl) =>
    c.privateChannels.flatMap((held) => {
      const idHex = bytesToHex(held.id);
      const def = f.channels.get(idHex);
      const head = f.heads.get(idHex);
      const content = def ? resealedChannelContent(def, held, head ? bytesToHex(head.hash) : undefined) : undefined;
      return content && head ? [{ idHex, content, head }] : [];
    });
  const start = now();
  if (!start.community || !start.folded?.rankedRoster) return;
  const owner = start.folded.ownerHex;
  if (user.pubkey !== owner && !hasPermission(start.folded.roster, user.pubkey, Permissions.MANAGE_CHANNELS)) return;
  if (needing(start.community, start.folded).length === 0) return;
  const steps = user.pubkey === owner ? 0 : Math.min(10, (highestPosition(start.folded.roster, user.pubkey) ?? 9) + 1);
  await new Promise((r) => setTimeout(r, 2_000 * steps + Math.random() * 2_000));
  // Sealed from what the Control Plane says now: another manager's reseal or rename may have landed (Vector `follow_fresh`).
  if (signal.aborted || (freshen && !(await freshen(false)))) return;
  const fresh = now();
  const community = fresh.community;
  if (signal.aborted || !community || !fresh.folded) return;
  // One write at a time, from the store's fold: the rendered one lags this device's last write.
  await withControlWrite(community.idHex, async () => {
    const folded = await foldStoredControl(community).catch(() => fresh.folded!);
    if (signal.aborted) return;
    for (const { idHex, content, head } of needing(community, folded)) {
      const rumor = buildChannelContentEdition(hex32(idHex), content, {
        actorPubkey: user.pubkey,
        version: head.version + 1n,
        prevHash: head.hash,
        authority: citationFor(community, folded, user.pubkey),
      });
      await publishEdition(nostr, community, user.signer, rumor);
      logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: sealed the details again under the current key`);
    }
  });
}
