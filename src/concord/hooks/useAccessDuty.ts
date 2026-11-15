/**
 * Run the access duty for every Private Channel this member holds the key of
 * (CORD-03 §5, Vector `access_duty`): see `lib/accessDuty.ts` for what is owed.
 * A random 3–15 s after the Roster moves, so the first holder's delivery serves
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
import { logSync } from "@/lib/syncLog";

/** How often a holder re-checks its Channels when nothing moved (Vector `ACCESS_DUTY_PERIOD_MS`). */
const ACCESS_DUTY_PERIOD_MS = 10 * 60_000;

/** Communities with a duty in flight: one at a time each. */
const running = new Set<string>();
/** Members delivered to this session, by `community:channel:epoch:member` (Vector `AccessLedger`). */
const delivered = new Set<string>();

/** Complete rotations by `community:channel:epoch`: a complete rotation never changes (Vector `MintedRotations`). */
const minted = new Map<string, MintingRotation[]>();

/** Forget whom this session delivered to, so the next account starts afresh. */
export function clearAccessDutyMemory(): void {
  delivered.clear();
  minted.clear();
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
  const events = (await Promise.all(community.relays.map((url) => pageRekeyWraps(nostr, url, [...addresses.keys()], signal)))).flat();
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
    const freshen = async (guestbook: boolean): Promise<boolean> => {
      const c = latest.current.community;
      if (!c) return false;
      const before = latest.current.folded;
      let short = false;
      await sweepControl(nostr, c, { onTruncated: () => void (short = true) }).catch(() => void (short = true));
      if (guestbook) await sweepGuestbook(nostr, c).catch(() => void (short = true));
      void queryClient.invalidateQueries({ queryKey: ["concord", "control", c.idHex] });
      const until = Date.now() + 1_500;
      while (latest.current.folded === before && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      return !short;
    };
    // The fold a change started from, kept until a pass settles it against a whole read.
    const book = settleBook(community.idHex);
    const run = async (settle = false, before?: FoldedControl) => {
      if (settle) await book.owe(before);
      const first = latest.current;
      if (!first.community) return;
      const idHex = first.community.idHex;
      // A change made mid-run is owed by the book and settled by a pass right after it.
      if (running.has(idHex)) return;
      running.add(idHex);
      const owed = await book.begin();
      let settled = false;
      try {
        // Judged on a whole read, never only the stored Roster (Vector `fetch_authority`).
        const whole = await freshen(true);
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
        const judged = await runAccessDuty(nostr, now.community, now.folded, user, now.coalesced, now.canRekeyChannel ? now.rekeyChannel : undefined, dutyNow, controller.signal, owed.from).catch(failed("access duty"));
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
        if (again) void run();
      }
    };
    runNow.current = () => void run();
    const again = setInterval(() => void run(), ACCESS_DUTY_PERIOD_MS);
    const offNow = onDutyNow(community.idHex, (before) => void run(true, before));
    return () => {
      runNow.current = undefined;
      offNow();
      controller.abort();
      clearInterval(again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, user?.pubkey, ready]);

  // Every holder sees the same gap: a random wait after the Roster or the keys move lets
  // the first delivery serve them all (Vector `authority_changed`).
  useEffect(() => {
    if (!ready) return;
    const first = setTimeout(() => runNow.current?.(), 3_000 + Math.random() * 12_000);
    return () => clearTimeout(first);
  }, [ready, foldSig, keySig]);
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
  const rumors = [
    ...(await buildAccessDeliveries(user.pubkey, encrypt, { scopeIdHex: idHex, epoch: ch.epoch, key: ch.key, recipients: [...recipients], atSecs })),
    ...(await buildHistoryDeliveries(user.pubkey, encrypt, { channelIdHex: idHex, views, recipients: [...recipients], atSecs })),
  ];
  const plane = accessPlane(community, ch.id);
  for (const rumor of rumors) {
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, plane, user.signer), plane);
    const sent = await Promise.allSettled(community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })));
    if (!sent.some((r) => r.status === "fulfilled")) throw new Error("no relay took the delivery");
  }
  for (const pk of recipients) delivered.add(`${community.idHex}:${idHex}:${ch.epoch}:${pk}`);
  return views.length;
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
  const planes = await readAccessPlanes(nostr, community, held.map((c) => bytesToHex(c.id)), signal);
  const rotations = await Promise.all(held.map((ch) => Promise.all([
    readMintingRotations(nostr, community, ch.id, ch.epoch, signal),
    readMintingRotations(nostr, community, ch.id, ch.epoch - 1n, signal),
  ])));

  /**
   * Rotate under the settle lock, judged again on the store's fold: a role change this
   * device made since the read may have let someone back in, and its key is already out.
   */
  const rotate = (idHex: string, epoch: bigint, cut: string[], fresh: string[]) =>
    withKeySettle(community.idHex, async () => {
      const c = now.community();
      const ch = c?.privateChannels.find((k) => bytesToHex(k.id) === idHex);
      if (!rekey || !c || ch?.epoch !== epoch || signal.aborted) return;
      const stored = (await now.stored().catch(() => undefined)) ?? folded;
      const removed = stillShutOut(stored, idHex, cut);
      const letIn = fresh.filter((pk) => isEntitled(stored.roster, stored.ownerHex, pk, idHex) && !stored.banned.has(pk));
      if (removed.length === 0 && letIn.length === 0) return;
      logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: rotating out ${removed.length}, letting in ${letIn.length} by a fresh epoch`);
      await rekey({ channelIdHex: idHex, keepRecipients: rotationRecipients(stored, user.pubkey, idHex, [...new Set([...candidates, ...letIn])], removed), removedTargets: removed, community: c });
    });

  for (const [i, ch] of held.entries()) {
    if (signal.aborted) return false;
    const idHex = bytesToHex(ch.id);
    const deliveries = planes.filter((p) => p.channelIdHex === idHex).flatMap((p) => parseDelivery(p.opened) ?? []);
    const [mintedNow, prior] = rotations[i];
    const duty = planChannelDuty({ control: folded, me: user.pubkey, channelIdHex: idHex, epoch: ch.epoch, candidates, deliveries, minted: mintedNow, prior, handled: doneFor(idHex, ch.epoch) });
    if (!duty) continue;
    if (duty.cut.length > 0) {
      await rotate(idHex, duty.epoch, duty.cut, []);
      continue;
    }
    if (duty.deliver.length > 0) {
      const past = await deliverKeysOnPlane(nostr, community, ch, duty.deliver, user);
      logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: delivered the key to ${duty.deliver.length} member(s), with ${past} past epoch(s)`);
    }
    if (duty.fresh.length > 0) await rotate(idHex, duty.epoch, [], duty.fresh);
  }
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
