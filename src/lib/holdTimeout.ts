/** Lateness past which a hold timer is taken to have waited out a main-thread stall. */
const STALL_SLACK_MS = 50;
/** Wait after a stall, so input queued behind it dispatches before the hold is decided. */
const STALL_RECHECK_MS = 50;

/**
 * `setTimeout` for a press-and-hold. A tap's pointerup queued behind a long task can run after
 * the hold timer that expired during it, reading the tap as a hold; a timer that runs late
 * re-arms until one runs on time, which lets the queued release cancel it first.
 * Returns the cancel.
 */
export function holdTimeout(onHold: () => void, ms: number): () => void {
  let handle: ReturnType<typeof setTimeout>;
  const arm = (delay: number) => {
    const due = performance.now() + delay;
    handle = setTimeout(() => {
      if (performance.now() - due > STALL_SLACK_MS) arm(STALL_RECHECK_MS);
      else onHold();
    }, delay);
  };
  arm(ms);
  return () => clearTimeout(handle);
}
