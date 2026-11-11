/**
 * Where one relay's copy of a paged plane (the Guestbook) has been read to, so a
 * sweep asks it only for what it hasn't given yet (Vector `guestbook_reads.rs`).
 *
 * A relay that runs out of plane has given everything dated up to when the read
 * began, which becomes its cursor. What no cursor's window can see (a restored
 * Join or a lifted ban's departure, dated in the past by design) a whole read of
 * each relay finds, once a day. A read that runs out of pages first keeps its
 * place and earns nothing until it finishes.
 */

/** How far behind its cursor a read reaches: relay retries and skewed clocks date an entry a little early. */
export const OVERLAP_SECS = 60 * 60;

/** How often each relay is read whole again. */
export const REREAD_SECS = 24 * 60 * 60;

/** A read longer than one sweep, still going. */
export interface ReadPass {
  /** Where its next page starts. */
  until: number;
  /** Its lower bound: 0 for a whole read. */
  since: number;
  /** When it began, the cursor it earns. */
  began: number;
}

/** One relay's read of one plane. Times are Unix seconds. */
export interface RelayRead {
  /** Everything this relay held dated up to here has been read. */
  cursor?: number;
  /** When it was last read whole. */
  wholeAt?: number;
  pass?: ReadPass;
}

/** The read a relay gets next. */
export interface ReadPlan {
  since: number;
  until?: number;
  began: number;
}

export function planRead(read: RelayRead | undefined, now: number): ReadPlan {
  const pass = read?.pass;
  if (pass) return { since: pass.since, until: pass.until, began: pass.began };
  const wholeAt = read?.wholeAt ?? 0;
  // A whole read stamped ahead of the clock would license cursor reads indefinitely.
  const recent = wholeAt <= now && now - wholeAt < REREAD_SECS;
  const since = read?.cursor !== undefined && recent ? Math.max(0, read.cursor - OVERLAP_SECS) : 0;
  return { since, began: now };
}

/** `read` after `plan` ran to the end of the plane, or ran out of pages at `stopped`. */
export function afterRead(read: RelayRead | undefined, plan: ReadPlan, stopped?: number): RelayRead {
  if (stopped !== undefined) return { ...read, pass: { until: stopped, since: plan.since, began: plan.began } };
  const wholeAt = plan.since === 0 ? Math.max(read?.wholeAt ?? 0, plan.began) : (read?.wholeAt ?? 0);
  return { cursor: Math.max(read?.cursor ?? 0, plan.began), wholeAt };
}
