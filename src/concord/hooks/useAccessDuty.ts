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
import { citationFor, publishEdition, useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { guestbookWalked, useGuestbook } from "@/concord/hooks/useGuestbook";
import { runWriterDuty } from "@/concord/hooks/writerDutyRun";
import { useChannelRekey } from "@/concord/hooks/useRekey";
import { onDutyNow } from "@/concord/lib/dutyNow";
import { sweepControl, sweepGuestbook } from "@/concord/lib/planeSync";
import { accessCandidates, mintingRotations, planChannelDuty, rotationRecipients, type MintingRotation } from "@/concord/lib/accessDuty";
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

/** Forget whom this session delivered to, so the next account starts afresh. */
export function clearAccessDutyMemory(): void {
  delivered.clear();
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
  return mintingRotations(groupRotations(parsed), bytesToHex(channelId), epoch);
}

/** What the access duty is judged on: the Roster, the Banlist and the live invite links. */
export function authoritySig(folded: FoldedControl): string {
  return JSON.stringify(
    [folded.roster, [...folded.banned].sort(), [...folded.liveInviteLinks].sort()],
    (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Set ? [...v].sort() : v),
  );
}

export function useAccessDuty(community: Community | undefined): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data: dissolved } = useDissolved(community);
  const { coalesced, history } = useGuestbook(folded?.rankedRoster ? community : undefined);
  const { rekeyChannel, canRekeyChannel } = useChannelRekey(community);
  const latest = useRef({ community, folded, coalesced, history, rekeyChannel, canRekeyChannel });
  latest.current = { community, folded, coalesced, history, rekeyChannel, canRekeyChannel };

  // Re-armed when the Roster, the Banlist or the live links move, not on every Control edition (Vector `authority_changed`).
  const foldSig = useMemo(() => (folded?.rankedRoster ? authoritySig(folded) : ""), [folded]);
  const keySig = (community?.privateChannels ?? []).map((c) => `${bytesToHex(c.id)}@${c.epoch}`).sort().join(",");

  useEffect(() => {
    if (!community || !user || !folded?.rankedRoster || dissolved || !user.signer.nip44) return;
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
        // A rotation from an epoch that moved since it was judged would fork the Channel (Vector `judged`).
        const epochNow = (id: string) => latest.current.community?.privateChannels.find((c) => bytesToHex(c.id) === id)?.epoch;
        // One half's failure never stops the other: the writer duty runs whatever the keys did.
        const judged = await runAccessDuty(nostr, now.community, now.folded, user, now.coalesced, now.canRekeyChannel ? now.rekeyChannel : undefined, epochNow, controller.signal, owed.from).catch(failed("access duty"));
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
    // Every holder sees the same gap: a random wait lets the first delivery serve them all.
    const first = setTimeout(() => void run(), 3_000 + Math.random() * 12_000);
    const again = setInterval(() => void run(), ACCESS_DUTY_PERIOD_MS);
    const offNow = onDutyNow(community.idHex, (before) => void run(true, before));
    return () => {
      offNow();
      controller.abort();
      clearTimeout(first);
      clearInterval(again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, user?.pubkey, foldSig, keySig, dissolved]);
}

type DutyUser = { pubkey: string; signer: Parameters<typeof sealRumor>[3] & { nip44?: { encrypt(pk: string, plain: string): Promise<string> } } };
type Rekey = (o: { channelIdHex: string; keepRecipients: string[]; removedTargets: string[] }) => Promise<void>;

async function runAccessDuty(
  nostr: NPool,
  community: Community,
  folded: FoldedControl,
  user: DutyUser,
  members: Parameters<typeof accessCandidates>[1],
  rekey: Rekey | undefined,
  epochNow: (channelIdHex: string) => bigint | undefined,
  signal: AbortSignal,
  settledFrom?: FoldedControl,
): Promise<boolean> {
  // Judged on a whole read: a stale entitlement would hand a new epoch's key to someone its rotation just cut.
  if (folded.incomplete.length > 0) return false;
  const nip44 = user.signer.nip44;
  if (!nip44) return false;
  await historyViewsReady();
  // Before's too: someone only a removed overwrite named still holds what it let them read.
  const candidates = [...new Set([...accessCandidates(folded, members), ...(settledFrom ? accessCandidates(settledFrom, members) : [])])].sort();
  const held: PrivateChannelKey[] = community.privateChannels.filter((c) => {
    const def = folded.channels.get(bytesToHex(c.id));
    return def?.isPrivate && !def.deleted;
  });
  for (const ch of held) {
    if (signal.aborted) return false;
    const idHex = bytesToHex(ch.id);
    const done = new Set(candidates.filter((pk) => delivered.has(`${community.idHex}:${idHex}:${ch.epoch}:${pk}`)));
    const planes = await readAccessPlanes(nostr, community, [idHex], signal);
    const deliveries = planes.flatMap((p) => parseDelivery(p.opened) ?? []);
    const [minted, prior] = await Promise.all([
      readMintingRotations(nostr, community, ch.id, ch.epoch, signal),
      readMintingRotations(nostr, community, ch.id, ch.epoch - 1n, signal),
    ]);
    const duty = planChannelDuty({ control: folded, me: user.pubkey, channelIdHex: idHex, epoch: ch.epoch, candidates, deliveries, minted, prior, handled: done, ...(settledFrom ? { settledFrom } : {}) });
    if (!duty) continue;
    if (duty.cut.length > 0) {
      if (!rekey || epochNow(idHex) !== duty.epoch) continue;
      logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: rotating out ${duty.cut.length} holder(s) the Channel no longer lets in`);
      await rekey({ channelIdHex: idHex, keepRecipients: rotationRecipients(folded, user.pubkey, idHex, candidates, duty.cut), removedTargets: duty.cut });
      continue;
    }
    if (duty.deliver.length > 0) {
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
        ...(await buildAccessDeliveries(user.pubkey, encrypt, { scopeIdHex: idHex, epoch: ch.epoch, key: ch.key, recipients: duty.deliver, atSecs })),
        ...(await buildHistoryDeliveries(user.pubkey, encrypt, { channelIdHex: idHex, views, recipients: duty.deliver, atSecs })),
      ];
      const plane = accessPlane(community, ch.id);
      for (const rumor of rumors) {
        const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, plane, user.signer), plane);
        const sent = await Promise.allSettled(community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })));
        if (!sent.some((r) => r.status === "fulfilled")) throw new Error("no relay took the delivery");
      }
      for (const pk of duty.deliver) delivered.add(`${community.idHex}:${idHex}:${ch.epoch}:${pk}`);
      logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: delivered the key to ${duty.deliver.length} member(s), with ${views.length} past epoch(s)`);
    }
    if (duty.fresh.length > 0 && rekey && epochNow(idHex) === duty.epoch) {
      logSync("access", `${community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: a fresh epoch for ${duty.fresh.length} member(s) denied history`);
      await rekey({ channelIdHex: idHex, keepRecipients: rotationRecipients(folded, user.pubkey, idHex, candidates, []), removedTargets: [] });
    }
  }
  return true;
}

/**
 * The reseal backstop (CORD-03 §2, Vector `reseal_backstop`): a manager holding a
 * Private Channel's key seals its details again under the current epoch when its
 * head is sealed at an earlier one, or still plain, after a rank-staggered wait,
 * and from the Control Plane as it stands then.
 */
async function resealBackstop(
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
  if (signal.aborted || !fresh.community || !fresh.folded) return;
  for (const { idHex, content, head } of needing(fresh.community, fresh.folded)) {
    const rumor = buildChannelContentEdition(hex32(idHex), content, {
      actorPubkey: user.pubkey,
      version: head.version + 1n,
      prevHash: head.hash,
      authority: citationFor(fresh.community, fresh.folded, user.pubkey),
    });
    await publishEdition(nostr, fresh.community, user.signer, rumor);
    logSync("access", `${fresh.community.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: sealed the details again under the current key`);
  }
}
