import { useCallback, useRef } from "react";

/**
 * A refetch that never cancels its own read: a wake during one asks for exactly one more
 * after it. A burst of landed wraps (hundreds of history deliveries) restarting the read on
 * each left it unfinished until the burst ended. Each read it starts still replaces one
 * already running from elsewhere (an interval), which began before the wrap landed.
 */
export function useCoalescedRefetch(refetch: (o: { cancelRefetch: boolean }) => Promise<unknown>): () => void {
  const latest = useRef(refetch);
  latest.current = refetch;
  const running = useRef(false);
  const again = useRef(false);
  return useCallback(() => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    void (async () => {
      try {
        do {
          again.current = false;
          await latest.current({ cancelRefetch: true }).catch(() => undefined);
        } while (again.current);
      } finally {
        running.current = false;
      }
    })();
  }, []);
}
