/**
 * Each parked catch-up's verdict this session, shared between the adopter that
 * judges it and the inbox that lists it: a catch-up is shown only once it's
 * judged a manual Accept, so one adopted without a click never flashes as an invite.
 */
import type { CatchUpVerdict } from "@/concord/lib/catchUpAdoption";

const verdicts = new Map<string, CatchUpVerdict>();
const listeners = new Set<() => void>();
let version = 0;

export function setCatchUpVerdict(wrapId: string, verdict: CatchUpVerdict): void {
  if (verdicts.get(wrapId) === verdict) return;
  verdicts.set(wrapId, verdict);
  version++;
  for (const l of listeners) l();
}

/**
 * Verdicts no click may override: a banned vendor, an epoch the head could never walk
 * back from, a key the seal refutes, or a banned recipient (CORD-04 §4, CORD-03 §5).
 */
const REFUSED = new Set<CatchUpVerdict>(["sender-banned", "implausible-epoch", "key-mismatch", "banned"]);

/** Verdicts that wait for the fold: re-judged as it moves, never offered. */
const WAITING = new Set<CatchUpVerdict>(["no-fold", "unverified"]);

/** Whether a verdict leaves the catch-up to the member's click: not adopted, waiting, done or refused. */
export function verdictIsManual(v: CatchUpVerdict | undefined): boolean {
  return v !== undefined && v !== "adopt" && v !== "nothing-new" && !WAITING.has(v) && !REFUSED.has(v);
}

/** Whether the catch-up waits on the member's click. */
export function catchUpIsManual(wrapId: string): boolean {
  return verdictIsManual(verdicts.get(wrapId));
}

/** Whether the catch-up was judged one no click may accept. */
export function catchUpIsRefused(wrapId: string): boolean {
  const v = verdicts.get(wrapId);
  return v !== undefined && REFUSED.has(v);
}

export function catchUpVerdictsVersion(): number {
  return version;
}

export function subscribeCatchUpVerdicts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
