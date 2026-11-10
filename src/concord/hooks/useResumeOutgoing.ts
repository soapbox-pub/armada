import { useNostr } from "@nostrify/react";
import { useEffect, useRef } from "react";

import { rebroadcastOutgoing } from "@/concord/hooks/useChannel";
import { discardOutgoing, isOutgoingLive, outgoingFor, outgoingReady } from "@/concord/lib/outgoing";
import { scheduleVerify } from "@/concord/lib/outgoingVerify";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isExpired } from "@/lib/nip17/protocol";
import { nowSecs } from "@/lib/relayClock";

/**
 * Re-broadcast this account's sealed sends that no relay was seen to take, once
 * the records load and when the browser comes back online. Sends a relay already
 * accepted resume their read-back (`outgoingVerify.ts`).
 */
export function useResumeOutgoing(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const viewer = user?.pubkey;
  // Read at run time: the pool and method must not restart the effect.
  const ctx = useRef({ nostr, method: user?.method });
  ctx.current = { nostr, method: user?.method };

  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const now = nowSecs();
      for (const rec of outgoingFor(viewer)) {
        // CORD-08: past its deadline it would be refused everywhere anyway.
        if (isExpired(rec.tags, now)) {
          discardOutgoing(rec.rumorId);
          continue;
        }
        if (!rec.wrap || isOutgoingLive(rec.rumorId)) continue;
        const { nostr: pool, method } = ctx.current;
        // Accepted before the page died: finish the read-back rather than re-send.
        if (rec.verifyAt !== undefined) continue;
        rebroadcastOutgoing(pool, rec, method);
      }
      const { nostr: pool, method } = ctx.current;
      scheduleVerify(pool, (rec) => rebroadcastOutgoing(pool, rec, method));
    };
    void outgoingReady().then(run);
    window.addEventListener("online", run);
    return () => {
      cancelled = true;
      window.removeEventListener("online", run);
    };
  }, [viewer]);
}
