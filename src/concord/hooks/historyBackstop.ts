/**
 * The history backstop (CORD-03 §2, Vector `history_backstop`): a manager publishes in a
 * Public Channel's metadata the earlier planes it holds that the Channel's `history`
 * lacks, while `@everyone` there reads history, so a member who joins after a
 * Refounding reads what was said before it.
 */
import type { NPool } from "@nostrify/nostrify";

import { queryRelayStrict } from "@/concord/hooks/useChannelAccess";
import { citationFor, foldStoredControl, publishEdition, withControlWrite } from "@/concord/hooks/useControlPlane";
import { pastRootPlanes, privatePlanes, publishedHistory, withHistory, type HistoryPlane } from "@/concord/lib/channelHistory";
import { buildChannelEdition, type FoldedControl } from "@/concord/lib/control";
import { hex32 } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { whenAuthSettled } from "@/concord/lib/planeSync";
import { everyoneReadsHistory, hasPermission, highestPosition, Permissions } from "@/concord/lib/roles";
import { sealRumor } from "@/concord/lib/stream";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import type { Community } from "@/concord/lib/types";
import { logSync } from "@/lib/syncLog";

/** How often one Channel's history is looked at again. */
const HISTORY_CHECK_PERIOD_MS = 60 * 60_000;

/** By `community:channel`: when it was last looked at, under which root epoch. */
const lastChecked = new Map<string, { at: number; rootEpoch: bigint }>();
/** By `community:channel`: the newest past root epoch looked at, so each is probed once. */
const scannedTo = new Map<string, bigint>();

type HistoryUser = { pubkey: string; signer: Parameters<typeof sealRumor>[3] };

/** Whether `pk` holds anything on any of `relays`; undefined when no relay answered. */
async function planeCarries(nostr: NPool, relays: readonly string[], plane: HistoryPlane, signal: AbortSignal): Promise<boolean | undefined> {
  // On an auth-gating relay a plane is read AS its key.
  registerStreamKeys([plane.group], [...relays]);
  const reads = await Promise.all(relays.map(async (url) => {
    try {
      await whenAuthSettled(url, () => [plane.group]);
      return (await queryRelayStrict(nostr, url, { kinds: [KIND_WRAP], authors: [plane.group.pk], limit: 1 }, signal)).length > 0;
    } catch {
      return undefined;
    }
  }));
  if (reads.some((r) => r === true)) return true;
  return reads.some((r) => r === false) ? false : undefined;
}

/**
 * What of a public Channel's history this device can hand every member that its metadata
 * doesn't yet: the private epochs it kept, and each past root epoch the Channel wrote under,
 * from the oldest not yet looked at. With it, the root epoch looked at up to.
 */
export async function owedHistory(
  nostr: NPool,
  community: Community,
  folded: FoldedControl,
  channelIdHex: string,
  signal: AbortSignal,
  from?: bigint,
): Promise<{ add: HistoryPlane[]; scanned?: bigint }> {
  const def = folded.channels.get(channelIdHex);
  const listed = new Set(publishedHistory(def?.metadata).map((p) => p.group.pk));
  const add = privatePlanes(community, channelIdHex).filter((p) => !listed.has(p.group.pk));
  const written = new Set((folded.writers?.get(channelIdHex)?.entries ?? []).flatMap((e) => (e.spell.kind === "writer" ? [BigInt(e.spell.root)] : [])));
  let scanned: bigint | undefined;
  for (const plane of pastRootPlanes(community, channelIdHex, from)) {
    if (!listed.has(plane.group.pk)) {
      const carries = written.has(plane.epoch) || (await planeCarries(nostr, community.relays, plane, signal));
      if (carries === undefined) break;
      if (carries) add.push(plane);
    }
    scanned = plane.epoch;
  }
  return { add, ...(scanned !== undefined ? { scanned } : {}) };
}

export async function historyBackstop(
  nostr: NPool,
  now: () => { community?: Community; folded?: FoldedControl },
  user: HistoryUser,
  signal: AbortSignal,
  freshen?: (guestbook: boolean) => Promise<boolean>,
): Promise<number> {
  const start = now();
  const community = start.community;
  const folded = start.folded;
  if (!community || !folded) return 0;
  const owner = folded.ownerHex;
  const manages = user.pubkey === owner || (!folded.banned.has(user.pubkey) && hasPermission(folded.roster, user.pubkey, Permissions.MANAGE_CHANNELS));
  if (!manages) return 0;

  const at = Date.now();
  const key = (idHex: string) => `${community.idHex}:${idHex}`;
  const due = [...folded.channels.values()].filter((def) => {
    if (def.deleted || def.isPrivate || !everyoneReadsHistory(folded.roster, def.channelIdHex)) return false;
    // A rotation closes an epoch to publish: due at once.
    const last = lastChecked.get(key(def.channelIdHex));
    return !last || last.rootEpoch !== community.rootEpoch || at - last.at > HISTORY_CHECK_PERIOD_MS;
  });
  for (const def of due) lastChecked.set(key(def.channelIdHex), { at, rootEpoch: community.rootEpoch });

  const owed: { idHex: string; add: HistoryPlane[]; scanned?: bigint }[] = [];
  for (const def of due) {
    if (signal.aborted) return 0;
    const prior = scannedTo.get(key(def.channelIdHex));
    const found = await owedHistory(nostr, community, folded, def.channelIdHex, signal, prior === undefined ? undefined : prior + 1n);
    if (found.add.length > 0) owed.push({ idHex: def.channelIdHex, ...found });
    else if (found.scanned !== undefined) scannedTo.set(key(def.channelIdHex), found.scanned);
  }
  if (owed.length === 0) return 0;

  const steps = user.pubkey === owner ? 0 : Math.min(10, (highestPosition(folded.roster, user.pubkey) ?? 9) + 1);
  await new Promise((r) => setTimeout(r, 2_000 * steps + Math.random() * 2_000));
  // Published against what the Control Plane says now: another manager may have done it.
  if (signal.aborted || (freshen && !(await freshen(false)))) return 0;
  const fresh = now().community;
  if (signal.aborted || !fresh) return 0;
  let published = 0;
  await withControlWrite(fresh.idHex, async () => {
    const stored = await foldStoredControl(fresh).catch(() => now().folded);
    if (!stored) return;
    for (const { idHex, add, scanned } of owed) {
      if (signal.aborted) return;
      const def = stored.channels.get(idHex);
      const head = stored.heads.get(idHex);
      if (!def || def.deleted || def.isPrivate || !everyoneReadsHistory(stored.roster, idHex)) continue;
      const next = withHistory(def.metadata, add);
      if (next) {
        const rumor = buildChannelEdition(hex32(idHex), next, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(fresh, stored, user.pubkey),
        });
        await publishEdition(nostr, fresh, user.signer, rumor);
        published++;
        logSync("access", `${fresh.idHex.slice(0, 8)} #${idHex.slice(0, 8)}: published ${add.length} earlier plane(s) of its history`);
      }
      if (scanned !== undefined) scannedTo.set(key(idHex), scanned);
    }
  });
  return published;
}

/** Forget what was looked at, on logout. */
export function resetHistoryBackstop(): void {
  lastChecked.clear();
  scannedTo.clear();
}
