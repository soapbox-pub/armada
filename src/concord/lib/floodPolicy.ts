/**
 * The reader's own tuning (Settings › Chat). `relaxed` judges content only (the
 * density and echo rules, at higher thresholds), so a crowd arriving at once —
 * a bridge relinking, a raid of real people — is never folded on arrival alone;
 * `strict` folds sooner. `exemptBridged` leaves NIP-48 `proxy`-tagged messages
 * out of judgement entirely: a bridge's puppets are new keys arriving together,
 * which is exactly the shape the arrival rules look for. The tag is the sender's
 * claim, so this is the reader's call, not a default.
 */
export type FloodSensitivity = "relaxed" | "standard" | "strict";
export interface FloodPolicy {
  readonly sensitivity: FloodSensitivity;
  readonly exemptBridged: boolean;
}

const policies = new Map<string, FloodPolicy>();
/** Interned, so a policy is a stable cache key and memo dependency. */
export function floodPolicy(sensitivity: FloodSensitivity = "standard", exemptBridged = false): FloodPolicy {
  const key = `${sensitivity}|${exemptBridged}`;
  let policy = policies.get(key);
  if (!policy) policies.set(key, (policy = Object.freeze({ sensitivity, exemptBridged })));
  return policy;
}
export const DEFAULT_FLOOD_POLICY = floodPolicy();

/** Whether a policy keeps this message out of flood judgement altogether. */
export function floodExempt(ev: { tags: readonly (readonly string[])[] }, policy: FloodPolicy | undefined): boolean {
  return policy?.exemptBridged === true && ev.tags.some((t) => t[0] === "proxy");
}

/**
 * The reader's flood tuning, for module-level readers that sit below any hook
 * (the remembered verdicts in `quarantineMemory.ts`). Set by `useFloodPolicy`.
 */
let active: FloodPolicy = DEFAULT_FLOOD_POLICY;
const listeners = new Set<() => void>();

export function activeFloodPolicy(): FloodPolicy {
  return active;
}

export function setActiveFloodPolicy(next: FloodPolicy): void {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

export function subscribeActiveFloodPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
