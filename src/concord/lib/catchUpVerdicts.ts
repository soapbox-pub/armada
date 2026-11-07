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

/** Whether the catch-up waits on the member's click: refused automatic adoption, not waiting or done. */
export function catchUpIsManual(wrapId: string): boolean {
  const v = verdicts.get(wrapId);
  return v !== undefined && v !== "adopt" && v !== "no-fold" && v !== "nothing-new";
}

export function catchUpVerdictsVersion(): number {
  return version;
}

export function subscribeCatchUpVerdicts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
