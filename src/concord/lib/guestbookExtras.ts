import { communityNicknames, runningTimeouts } from "@/concord/lib/channelJudges";
import type { FoldedControl } from "@/concord/lib/control";
import { currentGuestbookGroup, GUESTBOOK_MAX_FUTURE_MS } from "@/concord/lib/guestbook";
import { planeRevision, queryPlane, withGuestbookStreams } from "@/concord/lib/rumorStore";
import type { Community } from "@/concord/lib/types";
import { clockNowMs } from "@/lib/relayClock";

export interface GuestbookExtras {
  timeouts: ReturnType<typeof runningTimeouts>;
  nicknames: Record<string, string>;
}

interface HeldExtras {
  rev: number;
  sig: string;
  control: FoldedControl | undefined;
  /** When a Timeout ends or a future-dated entry comes into range, changing the answer. */
  validUntil: number;
  extras: GuestbookExtras;
}

/**
 * The last answer per community, held until its stored planes, its Roster or the clock
 * moves it: the notifiers re-ask every minute for every joined community, and each
 * answer is a whole-plane fold.
 */
const held = new Map<string, HeldExtras>();

/** Forget the held answers on logout: they are decrypted community state. */
export function clearGuestbookExtrasMemory(): void {
  held.clear();
}

function communitySig(community: Community): string {
  return `${community.rootEpoch}:${community.heldRoots.map((r) => r.epoch).join(",")}`;
}

/**
 * A Community's running Timeouts and Nicknames (CORD-04 §8, §10) off its stored Guestbook,
 * for notifiers. Extras: a Guestbook that can't be read yields none, never an error.
 */
export async function storedGuestbookExtras(community: Community, control: FoldedControl | undefined): Promise<GuestbookExtras> {
  try {
    // Read before the plane: a write landing mid-fold leaves this answer under the old revision.
    const rev = planeRevision(community.idHex);
    const sig = communitySig(community);
    const hit = held.get(community.idHex);
    if (hit && hit.rev === rev && hit.sig === sig && hit.control === control && clockNowMs() < hit.validUntil) return hit.extras;
    const guestbook = await withGuestbookStreams(community, await queryPlane(community.idHex, "guestbook"));
    const nowMs = clockNowMs();
    const extras = {
      timeouts: runningTimeouts(guestbook, control, community.id, nowMs),
      nicknames: communityNicknames(guestbook, control, community.id, currentGuestbookGroup(community).pk, nowMs),
    };
    let validUntil = Infinity;
    for (const t of extras.timeouts) validUntil = Math.min(validUntil, t.until * 1000);
    for (const e of guestbook) if (e.ms > nowMs + GUESTBOOK_MAX_FUTURE_MS) validUntil = Math.min(validUntil, e.ms - GUESTBOOK_MAX_FUTURE_MS);
    held.set(community.idHex, { rev, sig, control, validUntil, extras });
    return extras;
  } catch {
    return { timeouts: [], nicknames: {} };
  }
}
