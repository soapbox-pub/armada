import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  getQueuedPublishes,
  markQueuedPublishFailure,
  removeQueuedPublish,
} from "@/lib/publishOutbox";
import { publishTimeoutMs } from "@/lib/publishTimeout";

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Retries signed events that were queued while offline or during relay errors. */
export function PublishOutbox() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const flushingRef = useRef(false);
  const methodRef = useRef(user?.method);
  methodRef.current = user?.method;

  const flush = useCallback(async () => {
    if (flushingRef.current || isOffline()) return;
    flushingRef.current = true;
    try {
      const now = Date.now();
      const timeout = publishTimeoutMs(methodRef.current);
      const due = getQueuedPublishes().filter((item) => !item.nextAttemptAt || item.nextAttemptAt <= now);
      for (const item of due) {
        try {
          if (item.relay) {
            await nostr.relay(item.relay).event(item.event, { signal: AbortSignal.timeout(timeout) });
          } else {
            await nostr.event(item.event, { signal: AbortSignal.timeout(timeout) });
          }
          removeQueuedPublish(item.id);
        } catch (error) {
          markQueuedPublishFailure(item.id, error);
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [nostr]);

  useEffect(() => {
    void flush();
    const onOnline = () => void flush();
    const onFocus = () => void flush();
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void flush(), 60_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [flush]);

  return null;
}

export default PublishOutbox;
