import { communityNicknames, runningTimeouts } from "@/concord/lib/channelJudges";
import type { FoldedControl } from "@/concord/lib/control";
import { currentGuestbookGroup } from "@/concord/lib/guestbook";
import { queryPlane, withGuestbookStreams } from "@/concord/lib/rumorStore";
import type { Community } from "@/concord/lib/types";
import { clockNowMs } from "@/lib/relayClock";

export interface GuestbookExtras {
  timeouts: ReturnType<typeof runningTimeouts>;
  nicknames: Record<string, string>;
}

/**
 * A Community's running Timeouts and Nicknames (CORD-04 §8, §10) off its stored Guestbook,
 * for notifiers. Extras: a Guestbook that can't be read yields none, never an error.
 */
export async function storedGuestbookExtras(community: Community, control: FoldedControl | undefined): Promise<GuestbookExtras> {
  try {
    const guestbook = await withGuestbookStreams(community, await queryPlane(community.idHex, "guestbook"));
    const nowMs = clockNowMs();
    return {
      timeouts: runningTimeouts(guestbook, control, community.id, nowMs),
      nicknames: communityNicknames(guestbook, control, community.id, currentGuestbookGroup(community).pk, nowMs),
    };
  } catch {
    return { timeouts: [], nicknames: {} };
  }
}
