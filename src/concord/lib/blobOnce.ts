/**
 * The delivery blobs this session found won't open (Vector `OpenedHistory`,
 * `OpenedDeliveries`): anyone holding the root can put junk at a member's locator,
 * and every poll would otherwise spend a decrypt, a signer prompt for a bunker, on it.
 * A refusal is forgotten after an hour, so a signer that was only unreachable is asked again.
 */

const RETRY_MS = 60 * 60_000;
const CAP = 4096;
const refused = new Map<string, number>();

const keyOf = (purpose: string, deliverer: string, wrapped: string) => `${purpose}\u0000${deliverer}\u0000${wrapped}`;

/** Whether this blob refused to open for `purpose` within the hour. */
export function refusedBefore(purpose: string, deliverer: string, wrapped: string, nowMs = Date.now()): boolean {
  const at = refused.get(keyOf(purpose, deliverer, wrapped));
  return at !== undefined && nowMs - at < RETRY_MS;
}

export function noteRefused(purpose: string, deliverer: string, wrapped: string, nowMs = Date.now()): void {
  if (refused.size >= CAP) refused.delete(refused.keys().next().value as string);
  refused.set(keyOf(purpose, deliverer, wrapped), nowMs);
}

/** For logout and tests. */
export function clearRefusedBlobs(): void {
  refused.clear();
}
